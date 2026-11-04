package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/cwmpcontrol"
	"github.com/matrix8412/acs/internal/models"
)

type controlTestStore struct{ state cwmpcontrol.State }

func (s *controlTestStore) Load(context.Context) (cwmpcontrol.State, error) { return s.state, nil }
func (s *controlTestStore) Save(_ context.Context, state cwmpcontrol.State) error {
	s.state = state
	return nil
}

func TestCWMPControlCannotBeChangedThroughGenericSettings(t *testing.T) {
	w := httptest.NewRecorder()
	(&Router{}).handleUpdateSettings(w, httptest.NewRequest(http.MethodPut, "/settings", strings.NewReader(`{"cwmp_communication_state":"{\"enabled\":true}"}`)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("generic settings bypass accepted: %d", w.Code)
	}
}

func TestCWMPControlPermissionAndState(t *testing.T) {
	control, _ := cwmpcontrol.New(context.Background(), &controlTestStore{state: cwmpcontrol.State{Enabled: true}})
	router := &Router{cwmpControl: control}
	handler := auth.RequireFullAccess(auth.RequirePermission(models.PermCWMPControl)(router.handleCWMPControl))
	for _, perms := range [][]string{{models.PermProvisioningWrite}, {models.PermSettingsWrite}, {models.PermCWMPControl}} {
		req := httptest.NewRequest(http.MethodPut, "/cwmp-control/off", nil)
		req.SetPathValue("state", "off")
		ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.Claims{Username: "operator", Role: models.RoleFull})
		ctx = context.WithValue(ctx, auth.PermissionsContextKey, perms)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req.WithContext(ctx))
		if perms[0] == models.PermCWMPControl {
			if w.Code != 200 || control.Enabled() || control.Snapshot().UpdatedBy != "operator" {
				t.Fatalf("authorized pause failed: %d", w.Code)
			}
		} else if w.Code != 403 || !control.Enabled() {
			t.Fatalf("unrelated permission controlled CWMP: %d", w.Code)
		}
	}
	w := httptest.NewRecorder()
	router.handleCWMPControl(w, httptest.NewRequest(http.MethodGet, "/cwmp-control", nil))
	if w.Code != 200 {
		t.Fatal("status unavailable while paused")
	}
	readOnly := httptest.NewRequest(http.MethodPut, "/cwmp-control/on", nil)
	readOnly.SetPathValue("state", "on")
	ctx := context.WithValue(readOnly.Context(), auth.UserContextKey, &auth.Claims{Username: "viewer", Role: models.RoleRead})
	ctx = context.WithValue(ctx, auth.PermissionsContextKey, []string{models.PermCWMPControl})
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, readOnly.WithContext(ctx))
	if w.Code != http.StatusForbidden || control.Enabled() {
		t.Fatal("read-only account resumed CWMP")
	}
	req := httptest.NewRequest(http.MethodPut, "/cwmp-control/invalid", nil)
	req.SetPathValue("state", "invalid")
	w = httptest.NewRecorder()
	router.handleCWMPControl(w, req)
	if w.Code != 400 {
		t.Fatal("invalid state accepted")
	}
}
