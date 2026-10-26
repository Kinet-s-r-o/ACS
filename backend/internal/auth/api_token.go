package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/models"
)

const apiTokenContextKey contextKey = "api_token"

type APITokenLookup interface {
	GetByDigest(context.Context, string) (*models.APIToken, error)
	Touch(context.Context, int64, time.Time) error
}

type APIRoleLookup interface {
	GetByID(context.Context, int64) (*models.Role, error)
}

func NewAPIToken() (secret, digest, prefix string, err error) {
	var random [32]byte
	if _, err = rand.Read(random[:]); err != nil {
		return
	}
	secret = "acs_" + base64.RawURLEncoding.EncodeToString(random[:])
	return secret, APITokenDigest(secret), secret[:15], nil
}

func APITokenDigest(secret string) string {
	digest := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(digest[:])
}

func GetAPITokenFromContext(ctx context.Context) *models.APIToken {
	token, _ := ctx.Value(apiTokenContextKey).(*models.APIToken)
	return token
}

// API tokens never accept session cookies and resolve current permissions on every request.
func APITokenMiddleware(tokens APITokenLookup, users UserLookup, roles APIRoleLookup, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		unauthorized := func() {
			w.Header().Set("WWW-Authenticate", `Bearer realm="ACS integration API"`)
			writeAuthError(w, `{"error":"Invalid, expired or revoked API token"}`, http.StatusUnauthorized)
		}
		header := strings.Fields(req.Header.Get("Authorization"))
		validPrefix := len(header) == 2 && (strings.HasPrefix(header[1], "acs_") || strings.HasPrefix(header[1], "skyacs_"))
		validLength := len(header) == 2 && ((strings.HasPrefix(header[1], "acs_") && len(header[1]) == 47) || (strings.HasPrefix(header[1], "skyacs_") && len(header[1]) == 50))
		if len(req.Header.Values("Authorization")) != 1 || len(header) != 2 || !strings.EqualFold(header[0], "Bearer") || !validPrefix || !validLength {
			unauthorized()
			return
		}
		token, err := tokens.GetByDigest(req.Context(), APITokenDigest(header[1]))
		if err != nil {
			writeAuthError(w, `{"error":"Authentication service unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		now := time.Now().UTC()
		if token == nil || token.RevokedAt != nil || !now.Before(token.ExpiresAt) {
			unauthorized()
			return
		}
		user, err := users.GetByID(req.Context(), token.UserID)
		if err != nil {
			writeAuthError(w, `{"error":"Authentication service unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		if user == nil {
			unauthorized()
			return
		}
		permissions := make([]string, 0)
		var roleID int64
		if user.RoleID != nil && *user.RoleID != 0 {
			roleID = *user.RoleID
			role, err := roles.GetByID(req.Context(), roleID)
			if err != nil || role == nil {
				writeAuthError(w, `{"error":"User role unavailable"}`, http.StatusServiceUnavailable)
				return
			}
			permissions = append(permissions, role.Permissions...)
		} else if user.Role == models.RoleFull {
			permissions = append(permissions, models.AllPermissions...)
		}
		claims := &Claims{UserID: user.ID, Username: user.Username, Role: user.Role, RoleID: roleID}
		ctx := context.WithValue(req.Context(), UserContextKey, claims)
		ctx = context.WithValue(ctx, PermissionsContextKey, permissions)
		ctx = context.WithValue(ctx, apiTokenContextKey, token)
		if token.LastUsedAt == nil || now.Sub(*token.LastUsedAt) >= time.Minute {
			if err := tokens.Touch(ctx, token.ID, now); err != nil {
				writeAuthError(w, `{"error":"Authentication service unavailable"}`, http.StatusServiceUnavailable)
				return
			}
		}
		next.ServeHTTP(w, req.WithContext(ctx))
	})
}
