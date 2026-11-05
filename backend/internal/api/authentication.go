package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/authn"
	"github.com/matrix8412/acs/internal/models"
)

const radiusConfigKey = "auth_radius_config"

func (r *Router) authenticationModules() *authn.Registry {
	if r.authModules != nil {
		return r.authModules
	}
	return authn.NewRegistry(authn.Radius{Load: r.loadRadiusConfig})
}

func (r *Router) authenticateUser(ctx context.Context, user *models.User, password string) error {
	if user == nil || !user.Active {
		return authn.ErrDenied
	}
	return r.authenticationModules().Authenticate(ctx, user.AuthProvider, authn.Identity{Username: user.Username, PasswordHash: user.PasswordHash}, password)
}

func (r *Router) loadRadiusConfig(ctx context.Context) (authn.RadiusConfig, error) {
	config := authn.RadiusConfig{NASIdentifier: "ACS", Servers: []authn.RadiusServer{}}
	setting, err := r.settingsRepo.GetSensitive(ctx, radiusConfigKey)
	if err != nil {
		return config, err
	}
	if setting != nil {
		if err := json.Unmarshal([]byte(setting.Value), &config); err != nil {
			return config, err
		}
		if err := config.Validate(); err != nil {
			return config, err
		}
	}
	return config, nil
}

func (r *Router) handleAuthProviders(w http.ResponseWriter, req *http.Request) {
	respondJSON(w, http.StatusOK, r.authenticationModules().Names())
}

func (r *Router) handleRadiusSettings(w http.ResponseWriter, req *http.Request) {
	previous, err := r.loadRadiusConfig(req.Context())
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "Authentication settings are unavailable")
		return
	}
	if req.Method == http.MethodGet {
		respondJSON(w, http.StatusOK, previous.Redacted())
		return
	}
	var config authn.RadiusConfig
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 512<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid authentication settings")
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		respondError(w, http.StatusBadRequest, "Expected one settings object")
		return
	}
	config.PreserveSecrets(previous)
	if err := config.Validate(); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	encoded, err := json.Marshal(config)
	if err != nil || r.settingsRepo.SetMultiple(req.Context(), map[string]string{radiusConfigKey: string(encoded)}) != nil {
		respondError(w, http.StatusInternalServerError, "Could not save authentication settings")
		return
	}
	respondJSON(w, http.StatusOK, config.Redacted())
}

func (r *Router) handleTestRadius(w http.ResponseWriter, req *http.Request) {
	key := "radius-test:" + clientIP(req)
	if !r.loginLimiter.Allow(key) {
		respondError(w, http.StatusTooManyRequests, "Too many authentication tests; try again later")
		return
	}
	var body models.LoginRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || body.Username == "" || body.Password == "" || decoder.Decode(&struct{}{}) != io.EOF {
		respondError(w, http.StatusBadRequest, "Username and password are required")
		return
	}
	err := r.authenticationModules().Authenticate(req.Context(), "radius", authn.Identity{Username: body.Username}, body.Password)
	if err != nil {
		status, message := authenticationError(err)
		if errors.Is(err, authn.ErrDenied) {
			// A rejected diagnostic credential is not an invalid ACS session.
			status, message = http.StatusForbidden, "RADIUS rejected the test credentials"
		}
		respondError(w, status, message)
		return
	}
	// A connectivity test never creates an ACS session or assigns a role.
	respondJSON(w, http.StatusOK, map[string]string{"status": "RADIUS accepted the credentials"})
}

func authenticationError(err error) (int, string) {
	if errors.Is(err, authn.ErrDenied) {
		return http.StatusUnauthorized, "Invalid username or password"
	}
	if errors.Is(err, authn.ErrChallengeUnsupported) {
		return http.StatusServiceUnavailable, "RADIUS challenge is not supported; configure ACS TOTP or a password-only RADIUS policy"
	}
	return http.StatusServiceUnavailable, "Authentication service is unavailable; try again later"
}

// These grants also bypass the legacy full-role fallback when permission lookup fails.
func requireAuthSettingsPermission(permission string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if auth.OperationAuthorized(req.Context()) {
			next(w, req)
			return
		}
		for _, grant := range auth.GetPermissionsFromContext(req.Context()) {
			if grant == permission {
				next(w, req)
				return
			}
		}
		respondError(w, http.StatusForbidden, "Authentication settings permission required")
	}
}
