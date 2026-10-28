package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

type userLookupStub struct {
	user *models.User
}

func (lookup userLookupStub) GetByID(context.Context, int64) (*models.User, error) {
	return lookup.user, nil
}

func TestTokenRoundTrip(t *testing.T) {
	if err := ConfigureJWT("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	token, err := GenerateToken(&models.User{ID: 42, Username: "operator", Role: models.RoleRead})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ValidateToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != 42 || claims.Username != "operator" || claims.Role != models.RoleRead {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if _, err := ValidateToken(token + "tampered"); err == nil {
		t.Fatal("tampered token was accepted")
	}
}

func TestConfigureJWTRejectsWeakSecret(t *testing.T) {
	if err := ConfigureJWT("too-short"); err == nil {
		t.Fatal("weak secret was accepted")
	}
}

func TestPasswordPolicy(t *testing.T) {
	for _, password := range []string{"short", "alllowercase123", "ALLUPPERCASE123", "NoNumbersHere"} {
		if err := ValidatePassword(password); err == nil {
			t.Fatalf("weak password %q was accepted", password)
		}
	}
	if err := ValidatePassword("ControlPlane2026"); err != nil {
		t.Fatalf("strong password rejected: %v", err)
	}
	if err := ValidatePassword("Uppercase123" + string(make([]byte, 72))); err == nil {
		t.Fatal("password exceeding bcrypt's input limit was accepted")
	}
}

func TestAuthMiddlewareRejectsRevokedToken(t *testing.T) {
	if err := ConfigureJWT("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	issued := &models.User{ID: 7, Username: "admin", Role: models.RoleFull, TokenVersion: 1}
	token, err := GenerateToken(issued)
	if err != nil {
		t.Fatal(err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	recorder := httptest.NewRecorder()
	AuthMiddleware(userLookupStub{user: &models.User{ID: 7, Username: "admin", Role: models.RoleFull, TokenVersion: 2}}, nil, next).ServeHTTP(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token returned status %d", recorder.Code)
	}
}

func TestRequireAnyPermissionAcceptsFocusedGrantAndRejectsMissingGrant(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	protected := RequireAnyPermission(models.PermDevicesReset, models.PermDevicesWrite)(next)

	for _, tc := range []struct {
		name        string
		permissions []string
		wantStatus  int
	}{
		{name: "focused permission", permissions: []string{models.PermDevicesReset}, wantStatus: http.StatusNoContent},
		{name: "legacy bundle", permissions: []string{models.PermDevicesWrite}, wantStatus: http.StatusNoContent},
		{name: "unrelated permission", permissions: []string{models.PermDevicesRead}, wantStatus: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/", nil)
			ctx := context.WithValue(req.Context(), UserContextKey, &Claims{Role: models.RoleFull})
			ctx = context.WithValue(ctx, PermissionsContextKey, tc.permissions)
			recorder := httptest.NewRecorder()
			protected.ServeHTTP(recorder, req.WithContext(ctx))
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}
		})
	}
}
