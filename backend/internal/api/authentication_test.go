package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/authn"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"golang.org/x/crypto/bcrypt"
)

type apiTestAuthModule struct {
	result error
	calls  *int
}

func (apiTestAuthModule) Name() string { return "radius" }
func (p apiTestAuthModule) Authenticate(context.Context, authn.Identity, string) error {
	*p.calls++
	return p.result
}

func TestAuthenticationSettingsRequiresExplicitPermission(t *testing.T) {
	called := false
	handler := requireAuthSettingsPermission(models.PermAuthSettingsRead, func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) })
	for _, grants := range [][]string{nil, {models.PermSettingsRead, models.PermSettingsWrite}, {models.PermAuthSettingsWrite}} {
		req := httptest.NewRequest("GET", "/settings/authentication/radius", nil)
		ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.Claims{Role: models.RoleFull})
		ctx = context.WithValue(ctx, auth.PermissionsContextKey, grants)
		w := httptest.NewRecorder()
		handler(w, req.WithContext(ctx))
		if w.Code != http.StatusForbidden || called {
			t.Fatal("authentication settings used a legacy permission fallback")
		}
	}
	req := httptest.NewRequest("GET", "/settings/authentication/radius", nil)
	ctx := context.WithValue(req.Context(), auth.PermissionsContextKey, []string{models.PermAuthSettingsRead})
	w := httptest.NewRecorder()
	handler(w, req.WithContext(ctx))
	if w.Code != http.StatusNoContent || !called {
		t.Fatal("explicit read permission denied")
	}
}

func TestAuthenticationModulesPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&database.Setting{}); err != nil {
		t.Fatal(err)
	}
	if err := auth.ConfigureJWT(strings.Repeat("test-jwt-", 8)); err != nil {
		t.Fatal(err)
	}
	if err := database.ConfigureParameterEncryption(strings.Repeat("test-encryption-", 4)); err != nil {
		t.Fatal(err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("Local-password-123"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	local := &models.User{Username: "local-admin", AuthProvider: "local", PasswordHash: string(hash), Role: models.RoleFull, Active: true}
	external := &models.User{Username: "radius-user", AuthProvider: "radius", PasswordHash: string(hash), Role: models.RoleFull, Active: true}
	for _, user := range []*models.User{local, external} {
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	r := &Router{db: db, settingsRepo: database.NewSettingsRepository(db), userRepo: database.NewUserRepository(db), roleRepo: database.NewRoleRepository(db), auditRepo: database.NewAuditRepository(db), loginLimiter: newLoginLimiter(100, time.Minute), twoFactorLimiter: newLoginLimiter(100, time.Minute)}
	calls := 0
	for _, tc := range []struct {
		result error
		status int
	}{{nil, 200}, {authn.ErrDenied, 401}, {authn.ErrUnavailable, 503}} {
		r.authModules = authn.NewRegistry(apiTestAuthModule{result: tc.result, calls: &calls})
		w := httptest.NewRecorder()
		r.handleLogin(w, httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"username":"radius-user","password":"Local-password-123"}`)))
		if w.Code != tc.status {
			t.Fatalf("login returned %d; want %d", w.Code, tc.status)
		}
		var hasSession bool
		for _, cookie := range w.Result().Cookies() {
			if cookie.Name == auth.SessionCookieName {
				hasSession = true
				claims, err := auth.ValidateToken(cookie.Value)
				if err != nil || time.Until(claims.ExpiresAt.Time) > time.Hour+time.Second {
					t.Fatal("external session expiry is invalid")
				}
			}
		}
		if hasSession != (tc.status == 200) {
			t.Fatal("failed external authentication created a session")
		}
	}
	if calls != 3 {
		t.Fatal("login did not use the assigned module")
	}
	r.authModules = authn.NewRegistry(apiTestAuthModule{calls: &calls})
	if err := db.Model(external).Update("required_2fa", true).Error; err != nil {
		t.Fatal(err)
	}
	challenge := httptest.NewRecorder()
	r.handleLogin(challenge, httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"username":"radius-user","password":"external-password"}`)))
	var result models.LoginResponse
	if challenge.Code != 200 || json.Unmarshal(challenge.Body.Bytes(), &result) != nil || !result.TwoFactorSetupRequired {
		t.Fatal("external authentication skipped required ACS TOTP enrollment")
	}
	for _, cookie := range challenge.Result().Cookies() {
		if cookie.Name == auth.SessionCookieName && cookie.Value != "" {
			t.Fatal("session issued before required TOTP")
		}
	}
	if err := db.Model(external).Update("active", false).Error; err != nil {
		t.Fatal(err)
	}
	before := calls
	denied := httptest.NewRecorder()
	r.handleLogin(denied, httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"username":"radius-user","password":"external-password"}`)))
	if denied.Code != 401 || calls != before {
		t.Fatal("inactive account reached the external module")
	}
	if err := db.Model(external).Update("active", true).Error; err != nil {
		t.Fatal(err)
	}
	var event models.AuditLog
	if err := db.Where("username = ?", external.Username).First(&event).Error; err != nil || event.AuthProvider != "radius" {
		t.Fatal("login audit omitted the module")
	}

	// Password step-up uses the same provider and never its stale local hash.
	r.authModules = authn.NewRegistry(apiTestAuthModule{result: authn.ErrDenied, calls: &calls})
	req := httptest.NewRequest("POST", "/devices", nil)
	ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.Claims{UserID: external.ID, Role: models.RoleFull})
	w := httptest.NewRecorder()
	if r.verifyCurrentPassword(w, req.WithContext(ctx), "Local-password-123") || w.Code != http.StatusForbidden {
		t.Fatal("step-up fell back to local password")
	}

	update := func(provider, password string) error {
		return r.userRepo.UpdateAccount(t.Context(), local.ID, local.Username, "", "", "", false, false, models.RoleFull, nil, password, provider)
	}
	if err := update("radius", ""); !errors.Is(err, database.ErrLastLocalAdmin) {
		t.Fatal("last local administrator was converted")
	}
	if err := r.userRepo.SetActive(t.Context(), local.ID, false); !errors.Is(err, database.ErrLastLocalAdmin) {
		t.Fatal("last local administrator was deactivated")
	}
	second := &models.User{Username: "second-local-admin", PasswordHash: string(hash), Role: models.RoleFull, Active: true}
	if err := db.Create(second).Error; err != nil {
		t.Fatal(err)
	}
	if err := update("radius", ""); err != nil {
		t.Fatal(err)
	}
	changed, err := r.userRepo.GetByID(t.Context(), local.ID)
	if err != nil || changed.AuthProvider != "radius" || changed.PasswordHash != "" || changed.TokenVersion != local.TokenVersion+1 {
		t.Fatal("source change retained a password or session")
	}
}

func TestRadiusSettingsProtectionPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&database.Setting{}); err != nil {
		t.Fatal(err)
	}
	if err := database.ConfigureParameterEncryption(strings.Repeat("test-encryption-", 4)); err != nil {
		t.Fatal(err)
	}
	r := &Router{settingsRepo: database.NewSettingsRepository(db)}
	const secret = "test-only-radius-shared-secret"
	body := `{"enabled":true,"nas_identifier":"ACS","servers":[{"id":"primary","address":"127.0.0.1:1812","transport":"udp","timeout_seconds":2,"attempts":1,"secret":"` + secret + `"}]}`
	w := httptest.NewRecorder()
	r.handleRadiusSettings(w, httptest.NewRequest("PUT", "/settings/authentication/radius", strings.NewReader(body)))
	if w.Code != 200 || strings.Contains(w.Body.String(), secret) {
		t.Fatal("settings save failed or exposed the shared secret")
	}
	var raw database.Setting
	if err := db.Where("key = ?", radiusConfigKey).First(&raw).Error; err != nil || strings.Contains(raw.Value, secret) {
		t.Fatal("RADIUS settings were not encrypted")
	}
	w = httptest.NewRecorder()
	r.handleGetSettings(w, httptest.NewRequest("GET", "/settings", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), radiusConfigKey) || strings.Contains(w.Body.String(), secret) {
		t.Fatal("generic settings endpoint exposed authentication configuration")
	}

	var redacted authn.RadiusConfig
	w = httptest.NewRecorder()
	r.handleRadiusSettings(w, httptest.NewRequest("GET", "/settings/authentication/radius", nil))
	if json.Unmarshal(w.Body.Bytes(), &redacted) != nil || len(redacted.Servers) != 1 || !redacted.Servers[0].SecretSet {
		t.Fatal("missing redacted configuration")
	}
	encoded, _ := json.Marshal(redacted)
	w = httptest.NewRecorder()
	r.handleRadiusSettings(w, httptest.NewRequest("PUT", "/settings/authentication/radius", strings.NewReader(string(encoded))))
	if w.Code != 200 {
		t.Fatal("saving a redacted configuration lost its secret")
	}
	loaded, err := r.loadRadiusConfig(t.Context())
	if err != nil || loaded.Servers[0].Secret != secret {
		t.Fatal("stored secret was not preserved")
	}
}
