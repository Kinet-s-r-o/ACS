package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Keep explicit repository transactions in dry-run mode without a live database.
type sessionSettingsTestTransaction struct{ gorm.ConnPool }

func (sessionSettingsTestTransaction) Commit() error   { return nil }
func (sessionSettingsTestTransaction) Rollback() error { return nil }

func sessionSettingsRouter(t *testing.T, values map[string]string, loadError error) *Router {
	t.Helper()
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{
		DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true, DisableNestedTransaction: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	db.Statement.ConnPool = sessionSettingsTestTransaction{db.Statement.ConnPool}
	if err := db.Callback().Query().After("gorm:query").Register("test:session-settings", func(tx *gorm.DB) {
		if tx.Statement.Table != "settings" {
			return
		}
		if loadError != nil {
			tx.AddError(loadError)
			return
		}
		settings := tx.Statement.Dest.(*[]database.Setting)
		for key, value := range values {
			*settings = append(*settings, database.Setting{Key: key, Value: value})
		}
	}); err != nil {
		t.Fatal(err)
	}
	return &Router{db: db, settingsRepo: database.NewSettingsRepository(db), userRepo: database.NewUserRepository(db), auditRepo: database.NewAuditRepository(db), loginLimiter: newLoginLimiter(100, time.Minute), twoFactorLimiter: newLoginLimiter(100, time.Minute)}
}

func TestLoadSessionSettingsDefaultsAndValidation(t *testing.T) {
	for _, tc := range []struct {
		name      string
		values    map[string]string
		loadError error
		want      auth.SessionSettings
		wantError bool
	}{
		{"existing installation", nil, nil, auth.DefaultSessionSettings(), false},
		{"configured", map[string]string{auth.LocalSessionMinutesSetting: "30", auth.ExternalSessionMinutesSetting: "120"}, nil, auth.SessionSettings{LocalMinutes: 30, ExternalMinutes: 120}, false},
		{"partially configured", map[string]string{auth.LocalSessionMinutesSetting: "15"}, nil, auth.SessionSettings{LocalMinutes: 15, ExternalMinutes: 60}, false},
		{"invalid stored number", map[string]string{auth.LocalSessionMinutesSetting: "invalid"}, nil, auth.SessionSettings{}, true},
		{"unsafe stored value", map[string]string{auth.ExternalSessionMinutesSetting: "0"}, nil, auth.SessionSettings{}, true},
		{"storage failure", nil, errors.New("storage unavailable"), auth.SessionSettings{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := sessionSettingsRouter(t, tc.values, tc.loadError)
			got, err := r.loadSessionSettings(context.Background())
			if (err != nil) != tc.wantError || (!tc.wantError && got != tc.want) {
				t.Fatalf("settings=%+v err=%v", got, err)
			}
		})
	}
}

func TestSessionSettingsRoutesPermissionsAndValidation(t *testing.T) {
	for _, tc := range []struct {
		method, section, action, body string
		want                          int
	}{
		{"GET", "settings.users", "read", "", 200},
		{"GET", "settings.general", "read", "", 403},
		{"PUT", "settings.users", "read", `{"local_minutes":30,"external_minutes":60}`, 403},
		{"PUT", "settings.users", "write", `{"local_minutes":0,"external_minutes":60}`, 400},
		{"PUT", "settings.users", "write", `{"local_minutes":30.5,"external_minutes":60}`, 400},
		{"PUT", "settings.users", "write", `{"local_minutes":30}`, 400},
		{"PUT", "settings.users", "write", `{"local_minutes":30,"external_minutes":60,"extra":true}`, 400},
		{"PUT", "settings.users", "write", `{"local_minutes":30,"external_minutes":60}{}`, 400},
		{"PUT", "settings.users", "write", `{"local_minutes":30,"external_minutes":60}`, 200},
	} {
		t.Run(tc.method+tc.action+tc.body, func(t *testing.T) {
			r := sessionSettingsRouter(t, nil, nil)
			stored := map[string]string{}
			if err := r.db.Callback().Create().Before("gorm:create").Register("test:session-save", func(tx *gorm.DB) {
				setting := tx.Statement.Dest.(*database.Setting)
				stored[setting.Key] = setting.Value
			}); err != nil {
				t.Fatal(err)
			}
			mux := newPermissionMux()
			mux.HandleFunc("GET /users/session-settings", r.handleGetSessionSettings)
			mux.HandleFunc("PUT /users/session-settings", r.handleUpdateSessionSettings)
			permissions := []string{models.PermissionKey(tc.section, "read"), models.PermissionKey(tc.section, tc.action)}
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, scopedRequest(tc.method, "/users/session-settings", permissions, tc.body))
			if response.Code != tc.want {
				t.Fatalf("status=%d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			if tc.method == "PUT" && tc.want == 200 {
				if len(stored) != 2 || stored[auth.LocalSessionMinutesSetting] != "30" || stored[auth.ExternalSessionMinutesSetting] != "60" {
					t.Fatalf("incorrect stored settings: %#v", stored)
				}
			} else if len(stored) != 0 {
				t.Fatal("rejected request wrote session settings")
			}
		})
	}
}

func TestFinishLoginUsesSavedSessionLifetime(t *testing.T) {
	if err := auth.ConfigureJWT(strings.Repeat("session-test-", 4)); err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"local", "radius"} {
		r := sessionSettingsRouter(t, map[string]string{auth.LocalSessionMinutesSetting: "30", auth.ExternalSessionMinutesSetting: "120"}, nil)
		response := httptest.NewRecorder()
		r.finishLogin(response, httptest.NewRequest("POST", "/auth/login", nil), &models.User{ID: 1, Username: "operator", Active: true, AuthProvider: provider})
		if response.Code != http.StatusOK {
			t.Fatalf("login status=%d: %s", response.Code, response.Body.String())
		}
		found := false
		for _, cookie := range response.Result().Cookies() {
			if cookie.Name != auth.SessionCookieName {
				continue
			}
			found = true
			claims, err := auth.ValidateToken(cookie.Value)
			if err != nil {
				t.Fatal(err)
			}
			want := 30 * time.Minute
			if provider == "radius" {
				want = 120 * time.Minute
			}
			if claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time) != want {
				t.Fatal("login ignored configured lifetime for " + provider)
			}
		}
		if !found {
			t.Fatal("successful login did not issue a session")
		}
	}
}

func TestFinishLoginDoesNotIssueSessionWhenSettingsCannotLoad(t *testing.T) {
	r := sessionSettingsRouter(t, nil, errors.New("storage unavailable"))
	response := httptest.NewRecorder()
	r.finishLogin(response, httptest.NewRequest("POST", "/auth/login", nil), &models.User{ID: 1, Active: true})
	if response.Code != 503 || len(response.Result().Cookies()) != 0 {
		t.Fatal("failed settings load issued a session: " + strconv.Itoa(response.Code))
	}
}
