package cwmp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matrix8412/acs/internal/cwmpcontrol"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type pausedTestStore struct{ state cwmpcontrol.State }

func (s *pausedTestStore) Load(context.Context) (cwmpcontrol.State, error) { return s.state, nil }
func (s *pausedTestStore) Save(_ context.Context, state cwmpcontrol.State) error {
	s.state = state
	return nil
}

func TestPauseDuringConnectionRequestSettingsLoadRemainsRetryable(t *testing.T) {
	control, _ := cwmpcontrol.New(context.Background(), &pausedTestStore{state: cwmpcontrol.State{Enabled: true}})
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
		control.Set(context.Background(), false, "operator")
		tx.AddError(context.Canceled)
	}); err != nil {
		t.Fatal(err)
	}
	url := "http://192.0.2.1/connection-request"
	_, err = SendConnectionRequest(context.Background(), &models.Device{ConnectionRequestURL: &url}, database.NewSettingsRepository(db), control)
	var response *ConnectionRequestError
	if !errors.Is(err, cwmpcontrol.ErrPaused) || !errors.As(err, &response) || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("interrupted settings read became a task failure: %v", err)
	}
}

func TestCommunicationPauseGuardsEveryCWMPEntryPoint(t *testing.T) {
	control, _ := cwmpcontrol.New(context.Background(), &pausedTestStore{state: cwmpcontrol.State{Enabled: true}})
	h := NewHandler(nil, control)
	control.OnPause(h.ClearSessions)
	h.sessions.GetOrCreate("old-session", "SERIAL")
	control.Set(context.Background(), false, "operator")
	if h.sessions.Get("old-session") != nil {
		t.Fatal("pause retained in-flight session state")
	}
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/", nil))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s accepted while paused: %d", method, w.Code)
		}
	}
	// Nil repositories and an empty device would fail if any URL/DB work ran.
	_, err := SendConnectionRequest(context.Background(), &models.Device{}, nil, control)
	if !errors.Is(err, cwmpcontrol.ErrPaused) {
		t.Fatalf("connection request not guarded: %v", err)
	}
	watchdog := NewDeviceWatchdog(nil, control)
	watchdog.VerifyRecoveredDevice("SERIAL")
	watchdog.checkStaleDevices(context.Background())
	if err := watchdog.summonDevice(context.Background(), &models.Device{}, "", "", false); !errors.Is(err, cwmpcontrol.ErrPaused) {
		t.Fatalf("watchdog bypassed pause: %v", err)
	}
	worker := NewSystemTaskWorker(nil, control)
	worker.dispatchSingle(context.Background())
	if err := worker.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
}
