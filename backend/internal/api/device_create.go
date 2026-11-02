package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

func (r *Router) handleCreateDevice(w http.ResponseWriter, req *http.Request) {
	var body struct {
		SerialNumber              string   `json:"serial_number"`
		Tags                      []string `json:"tags"`
		FactoryResetOnFirstInform bool     `json:"factory_reset_on_first_inform"`
		CurrentPassword           string   `json:"current_password"`
		TOTPCode                  string   `json:"totp_code"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 16*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	body.SerialNumber = strings.TrimSpace(body.SerialNumber)
	if body.SerialNumber == "" || len(body.SerialNumber) > 128 || strings.ContainsFunc(body.SerialNumber, unicode.IsControl) {
		respondError(w, http.StatusBadRequest, "Serial number is required and must be at most 128 bytes without control characters")
		return
	}
	tags, valid := r.validateDeviceTags(w, req, body.Tags)
	if !valid {
		return
	}
	if body.FactoryResetOnFirstInform {
		if !hasRequestPermission(req, models.PermDevicesReset, models.PermDevicesWrite) {
			respondError(w, http.StatusForbidden, "Factory reset permission is required to enable automatic reset")
			return
		}
		if !r.verifyCurrentReauthentication(w, req, body.CurrentPassword, body.TOTPCode) {
			return
		}
	}
	device, err := r.deviceRepo.CreateWaiting(req.Context(), body.SerialNumber, tags, body.FactoryResetOnFirstInform)
	if errors.Is(err, database.ErrDeviceExists) {
		respondError(w, http.StatusConflict, "A CPE with this serial number already exists")
		return
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to add CPE")
		return
	}
	respondJSON(w, http.StatusCreated, device)
}

func hasRequestPermission(req *http.Request, required ...string) bool {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		return false
	}
	permissions := auth.GetPermissionsFromContext(req.Context())
	if permissions == nil {
		return claims.Role == models.RoleFull
	}
	for _, permission := range permissions {
		for _, requiredPermission := range required {
			if permission == requiredPermission {
				return true
			}
		}
	}
	return false
}
