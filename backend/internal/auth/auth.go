package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/skydashnet/skyacs/internal/models"
)

var (
	ErrInvalidToken = errors.New("invalid or expired token")
)

const SessionCookieName = "acs_session"
const TwoFactorCookieName = "acs_2fa"

type contextKey string

const UserContextKey contextKey = "user"

const (
	jwtIssuer         = "skyacs"
	jwtAudience       = "skyacs-web"
	minSecretLength   = 32
	minPasswordLength = 12
	maxPasswordLength = 72
)

var jwtSecret []byte

type Claims struct {
	UserID       int64           `json:"user_id"`
	Username     string          `json:"username"`
	Role         models.UserRole `json:"role"`
	RoleID       int64           `json:"role_id"`
	TokenVersion uint64          `json:"token_version"`
	Purpose      string          `json:"purpose,omitempty"`
	jwt.RegisteredClaims
}

func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	return string(bytes), err
}

func CheckPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

func GenerateToken(user *models.User) (string, error) {
	return generateToken(user, "", 24*time.Hour)
}

func GenerateTwoFactorChallengeToken(user *models.User) (string, error) {
	return generateToken(user, "two_factor", 5*time.Minute)
}

func generateToken(user *models.User, purpose string, duration time.Duration) (string, error) {
	var roleID int64
	if user.RoleID != nil {
		roleID = *user.RoleID
	}
	claims := &Claims{
		UserID:       user.ID,
		Username:     user.Username,
		Role:         user.Role,
		RoleID:       roleID,
		TokenVersion: user.TokenVersion,
		Purpose:      purpose,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now().Add(-30 * time.Second)),
			Subject:   user.Username,
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
		},
	}

	if len(jwtSecret) < minSecretLength {
		return "", errors.New("JWT secret is not configured")
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret)
}

func ValidateToken(tokenString string) (*Claims, error) {
	if len(jwtSecret) < minSecretLength {
		return nil, ErrInvalidToken
	}

	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return jwtSecret, nil
	}, jwt.WithIssuer(jwtIssuer), jwt.WithAudience(jwtAudience), jwt.WithLeeway(30*time.Second), jwt.WithValidMethods([]string{"HS256"}))

	if err != nil {
		return nil, ErrInvalidToken
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, ErrInvalidToken
}

type UserLookup interface {
	GetByID(context.Context, int64) (*models.User, error)
}

// PermissionLookup resolves the permission keys for a role ID.
type PermissionLookup interface {
	GetPermissions(context.Context, int64) ([]string, error)
}

const PermissionsContextKey contextKey = "permissions"

func AuthMiddleware(users UserLookup, perms PermissionLookup, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil || cookie.Value == "" {
			writeAuthError(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		claims, err := ValidateToken(cookie.Value)
		if err != nil || claims.Purpose != "" {
			writeAuthError(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}
		user, err := users.GetByID(r.Context(), claims.UserID)
		if err != nil || user == nil || user.Username != claims.Username || user.Role != claims.Role || user.TokenVersion != claims.TokenVersion {
			writeAuthError(w, `{"error":"session has been revoked"}`, http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), UserContextKey, claims)

		// Resolve permissions from the role.
		if perms != nil && claims.RoleID != 0 {
			permissionList, permErr := perms.GetPermissions(r.Context(), claims.RoleID)
			if permErr == nil && permissionList != nil {
				ctx = context.WithValue(ctx, PermissionsContextKey, permissionList)
			}
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func writeAuthError(w http.ResponseWriter, body string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func GetUserFromContext(ctx context.Context) *Claims {
	claims, ok := ctx.Value(UserContextKey).(*Claims)
	if !ok {
		return nil
	}
	return claims
}

// GetPermissionsFromContext returns the permission keys stored in the request context.
func GetPermissionsFromContext(ctx context.Context) []string {
	perms, ok := ctx.Value(PermissionsContextKey).([]string)
	if !ok {
		return nil
	}
	return perms
}

// RequirePermission returns a middleware that checks whether the authenticated user
// has the given permission key. Falls back to the legacy RoleFull check for tokens
// that predate the RoleID field.
func RequirePermission(perm string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			claims := GetUserFromContext(r.Context())
			if claims == nil {
				writeAuthError(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}

			perms := GetPermissionsFromContext(r.Context())
			if perms != nil {
				for _, p := range perms {
					if p == perm {
						next(w, r)
						return
					}
				}
				writeAuthError(w, `{"error":"forbidden - insufficient permissions"}`, http.StatusForbidden)
				return
			}

			// Fallback for legacy tokens without RoleID.
			if claims.Role == models.RoleFull {
				next(w, r)
				return
			}

			writeAuthError(w, `{"error":"forbidden - insufficient permissions"}`, http.StatusForbidden)
		}
	}
}

// RequireAnyPermission allows access when a caller has at least one permission from the supplied set.
func RequireAnyPermission(perms ...string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			claims := GetUserFromContext(r.Context())
			if claims == nil {
				writeAuthError(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			userPermissions := GetPermissionsFromContext(r.Context())
			if userPermissions != nil {
				for _, required := range perms {
					for _, actual := range userPermissions {
						if actual == required {
							next(w, r)
							return
						}
					}
				}
				writeAuthError(w, `{"error":"forbidden - insufficient permissions"}`, http.StatusForbidden)
				return
			}
			if claims.Role == models.RoleFull {
				next(w, r)
				return
			}
			writeAuthError(w, `{"error":"forbidden - insufficient permissions"}`, http.StatusForbidden)
		}
	}
}

func RequireFullAccess(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := GetUserFromContext(r.Context())
		if claims == nil {
			writeAuthError(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		if claims.Role != models.RoleFull {
			writeAuthError(w, `{"error":"forbidden - full access required"}`, http.StatusForbidden)
			return
		}

		next(w, r)
	}
}

func ConfigureJWT(secret string) error {
	if len(secret) < minSecretLength {
		return fmt.Errorf("JWT_SECRET must contain at least %d characters", minSecretLength)
	}
	jwtSecret = []byte(secret)
	return nil
}

func ValidatePassword(password string) error {
	if len(password) < minPasswordLength {
		return fmt.Errorf("password must be at least %d characters", minPasswordLength)
	}
	if len(password) > maxPasswordLength {
		return fmt.Errorf("password must not exceed %d bytes", maxPasswordLength)
	}

	var hasUpper, hasLower, hasNumber bool
	for _, char := range password {
		switch {
		case char >= 'A' && char <= 'Z':
			hasUpper = true
		case char >= 'a' && char <= 'z':
			hasLower = true
		case char >= '0' && char <= '9':
			hasNumber = true
		}
	}
	if !hasUpper || !hasLower || !hasNumber {
		return errors.New("password must include uppercase, lowercase, and numeric characters")
	}
	return nil
}
