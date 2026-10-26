package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/skydashnet/skyacs/internal/models"
)

type apiTokenStub struct {
	token  *models.APIToken
	err    error
	digest string
}

func (s *apiTokenStub) GetByDigest(_ context.Context, digest string) (*models.APIToken, error) {
	if digest != s.digest {
		return nil, nil
	}
	return s.token, s.err
}
func (s *apiTokenStub) Touch(context.Context, int64, time.Time) error { return nil }

type apiRoleStub struct {
	role *models.Role
	err  error
}

func (s *apiRoleStub) GetByID(context.Context, int64) (*models.Role, error) { return s.role, s.err }

func TestAPITokenAuthenticationAndLivePermissions(t *testing.T) {
	secret, digest, prefix, err := NewAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(secret) != 47 || len(digest) != 64 || !strings.HasPrefix(secret, "acs_") || prefix != secret[:15] || digest == secret {
		t.Fatal("invalid generated token metadata")
	}
	roleID := int64(8)
	user := &models.User{ID: 4, Username: "billing", Role: models.RoleFull, RoleID: &roleID}
	tokens := &apiTokenStub{token: &models.APIToken{ID: 5, UserID: user.ID, ExpiresAt: time.Now().Add(time.Hour)}, digest: digest}
	roles := &apiRoleStub{role: &models.Role{ID: roleID, Permissions: []string{models.PermDevicesWrite}}}
	next := RequirePermission(models.PermDevicesWrite)(func(w http.ResponseWriter, r *http.Request) {
		if GetUserFromContext(r.Context()).Username != user.Username || GetAPITokenFromContext(r.Context()).ID != 5 {
			t.Error("missing owner/token context")
		}
		w.WriteHeader(204)
	})
	call := func(header string, lookup UserLookup) int {
		req := httptest.NewRequest("POST", "/v1/devices/example/write", nil)
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "not-an-api-token"})
		w := httptest.NewRecorder()
		APITokenMiddleware(tokens, lookup, roles, next).ServeHTTP(w, req)
		return w.Code
	}
	lookup := userLookupStub{user: user}
	if code := call("Bearer "+secret, lookup); code != 204 {
		t.Fatalf("valid token: %d", code)
	}
	legacySecret := "skyacs_" + strings.Repeat("A", 43)
	tokens.digest = APITokenDigest(legacySecret)
	if code := call("Bearer "+legacySecret, lookup); code != 204 {
		t.Fatalf("existing token remains valid during prefix migration: %d", code)
	}
	tokens.digest = digest
	roles.role.Permissions = nil
	if code := call("Bearer "+secret, lookup); code != 403 {
		t.Fatalf("empty role must not fall back to legacy full access: %d", code)
	}
	roles.err = errors.New("lookup unavailable")
	if code := call("Bearer "+secret, lookup); code != 503 {
		t.Fatalf("role lookup must fail closed: %d", code)
	}
	roles.err = nil
	for _, header := range []string{"", "Basic " + secret, "Bearer bad", "Bearer " + secret + " extra", "Bearer " + secret[:46] + "!"} {
		if code := call(header, lookup); code != 401 {
			t.Errorf("malformed/unknown token accepted: %d", code)
		}
	}
	tokens.token.ExpiresAt = time.Now().Add(-time.Second)
	if code := call("Bearer "+secret, lookup); code != 401 {
		t.Fatalf("expired token: %d", code)
	}
	tokens.token.ExpiresAt = time.Now().Add(time.Hour)
	now := time.Now()
	tokens.token.RevokedAt = &now
	if code := call("Bearer "+secret, lookup); code != 401 {
		t.Fatalf("revoked token: %d", code)
	}
	tokens.token.RevokedAt = nil
	if code := call("Bearer "+secret, userLookupStub{}); code != 401 {
		t.Fatalf("deleted user: %d", code)
	}
	tokens.err = errors.New("storage unavailable")
	if code := call("Bearer "+secret, lookup); code != 503 {
		t.Fatalf("token lookup must fail closed: %d", code)
	}
}
