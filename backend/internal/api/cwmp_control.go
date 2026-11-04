package api

import (
	"net/http"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/cwmpcontrol"
)

func firstCWMPControl(controls []*cwmpcontrol.Controller) *cwmpcontrol.Controller {
	if len(controls) > 0 {
		return controls[0]
	}
	return nil
}

func (r *Router) handleCWMPControl(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.cwmpControl == nil {
		respondError(w, http.StatusServiceUnavailable, "CWMP control is unavailable")
		return
	}
	if req.Method == http.MethodGet {
		respondJSON(w, http.StatusOK, r.cwmpControl.Snapshot())
		return
	}
	state := req.PathValue("state")
	if state != "on" && state != "off" {
		respondError(w, http.StatusBadRequest, "CWMP state must be on or off")
		return
	}
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	updated, err := r.cwmpControl.Set(req.Context(), state == "on", claims.Username)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not save CWMP communication state")
		return
	}
	respondJSON(w, http.StatusOK, updated)
}
