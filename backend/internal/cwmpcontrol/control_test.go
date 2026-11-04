package cwmpcontrol

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type memoryStore struct {
	state State
	fail  bool
}

func (s *memoryStore) Load(context.Context) (State, error) {
	if s.fail {
		return State{}, errors.New("store unavailable")
	}
	return s.state, nil
}
func (s *memoryStore) Save(_ context.Context, state State) error {
	if s.fail {
		return errors.New("store unavailable")
	}
	s.state = state
	return nil
}

func TestPersistentPauseCancellationAndResume(t *testing.T) {
	store := &memoryStore{state: State{Enabled: true}}
	c, err := New(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	ctx, release, err := c.Bind(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	cleared := false
	c.OnPause(func() { cleared = true })
	state, err := c.Set(context.Background(), false, "operator")
	if err != nil {
		t.Fatal(err)
	}
	if state.Enabled || state.UpdatedBy != "operator" || state.UpdatedAt == nil || !cleared {
		t.Fatalf("bad pause state: %#v", state)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("in-flight work was not canceled")
	}
	if !errors.Is(context.Cause(ctx), ErrPaused) {
		t.Fatalf("unexpected cancellation: %v", context.Cause(ctx))
	}
	if _, _, err := c.Bind(context.Background()); !errors.Is(err, ErrPaused) {
		t.Fatalf("paused work admitted: %v", err)
	}
	restarted, err := New(context.Background(), store)
	if err != nil || restarted.Enabled() {
		t.Fatalf("pause lost on restart: %v", err)
	}
	if _, err := c.Set(context.Background(), true, "admin"); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(c.Check(ctx), ErrPaused) {
		t.Fatal("old work accepted after resume")
	}
	fresh, done, err := c.Bind(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	if err := c.Check(fresh); err != nil {
		t.Fatal(err)
	}
}

func TestPersistenceFailureDoesNotChangeRunningState(t *testing.T) {
	store := &memoryStore{state: State{Enabled: true}}
	c, _ := New(context.Background(), store)
	ctx, release, _ := c.Bind(context.Background())
	defer release()
	store.fail = true
	if _, err := c.Set(context.Background(), false, "operator"); err == nil || !c.Enabled() || c.Check(ctx) != nil {
		t.Fatal("failed write changed live state")
	}
	if _, err := New(context.Background(), store); err == nil {
		t.Fatal("startup ignored storage failure")
	}
	store.fail = false
	c.Set(context.Background(), false, "operator")
	store.fail = true
	if _, err := c.Set(context.Background(), true, "operator"); err == nil || c.Enabled() {
		t.Fatal("failed resume enabled communications")
	}
}

func TestPausedHTTPRejectsBeforeApplicationAndResumes(t *testing.T) {
	c, _ := New(context.Background(), &memoryStore{state: State{Enabled: false}})
	called := false
	h := c.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) }))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/", nil))
	if called || w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") == "" {
		t.Fatalf("paused HTTP admitted: %d", w.Code)
	}
	c.Set(context.Background(), true, "admin")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/", nil))
	if !called || w.Code != http.StatusNoContent {
		t.Fatal("resume did not restore processing")
	}
}

func TestPauseDuringHTTPPreventsSOAPResponseEvenAfterRapidResume(t *testing.T) {
	c, _ := New(context.Background(), &memoryStore{state: State{Enabled: true}})
	h := c.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.Set(context.Background(), false, "operator")
		c.Set(context.Background(), true, "operator")
		w.Write([]byte("SetParameterValues must not escape"))
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/", nil))
	if w.Code != http.StatusServiceUnavailable || w.Body.String() != "CWMP communication is paused\n" {
		t.Fatalf("stale SOAP escaped: %d %s", w.Code, w.Body.String())
	}
}

func TestConcurrentBindingsAndPause(t *testing.T) {
	c, _ := New(context.Background(), &memoryStore{state: State{Enabled: true}})
	var group sync.WaitGroup
	for range 20 {
		group.Go(func() {
			for range 100 {
				ctx, done, err := c.Bind(context.Background())
				if err == nil {
					_ = c.Check(ctx)
					done()
				}
			}
		})
	}
	for range 10 {
		c.Set(context.Background(), false, "operator")
		c.Set(context.Background(), true, "operator")
	}
	group.Wait()
}
