package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/matrix8412/acs/internal/auth"
)

func (r *Router) loadSessionSettings(ctx context.Context) (auth.SessionSettings, error) {
	settings := auth.DefaultSessionSettings()
	if r.settingsRepo == nil {
		return settings, nil
	}
	values, err := r.settingsRepo.GetValues(ctx, auth.LocalSessionMinutesSetting, auth.ExternalSessionMinutesSetting)
	if err != nil {
		return settings, err
	}
	for key, destination := range map[string]*int{
		auth.LocalSessionMinutesSetting:    &settings.LocalMinutes,
		auth.ExternalSessionMinutesSetting: &settings.ExternalMinutes,
	} {
		if value, exists := values[key]; exists {
			minutes, err := strconv.Atoi(value)
			if err != nil {
				return settings, fmt.Errorf("invalid session duration setting: %s", key)
			}
			*destination = minutes
		}
	}
	return settings, settings.Validate()
}

func (r *Router) handleGetSessionSettings(w http.ResponseWriter, req *http.Request) {
	settings, err := r.loadSessionSettings(req.Context())
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "Session settings are unavailable")
		return
	}
	respondJSON(w, http.StatusOK, settings)
}

func (r *Router) handleUpdateSessionSettings(w http.ResponseWriter, req *http.Request) {
	var settings auth.SessionSettings
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid session settings")
		return
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		respondError(w, http.StatusBadRequest, "Invalid session settings")
		return
	}
	if err := settings.Validate(); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.settingsRepo == nil {
		respondError(w, http.StatusServiceUnavailable, "Session settings are unavailable")
		return
	}
	if err := r.settingsRepo.SetMultiple(req.Context(), map[string]string{
		auth.LocalSessionMinutesSetting:    strconv.Itoa(settings.LocalMinutes),
		auth.ExternalSessionMinutesSetting: strconv.Itoa(settings.ExternalMinutes),
	}); err != nil {
		respondError(w, http.StatusInternalServerError, "Session settings could not be saved")
		return
	}
	respondJSON(w, http.StatusOK, settings)
}
