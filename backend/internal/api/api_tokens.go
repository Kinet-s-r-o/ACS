package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

func (r *Router) tokenUser(w http.ResponseWriter, req *http.Request) int64 {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		respondError(w, http.StatusBadRequest, "Invalid user ID")
		return 0
	}
	user, err := r.userRepo.GetByID(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get user")
		return 0
	}
	if user == nil {
		respondError(w, http.StatusNotFound, "User not found")
		return 0
	}
	return id
}

func (r *Router) handleListAPITokens(w http.ResponseWriter, req *http.Request) {
	id := r.tokenUser(w, req)
	if id == 0 {
		return
	}
	tokens, err := r.apiTokenRepo.List(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list API tokens")
		return
	}
	respondJSON(w, http.StatusOK, tokens)
}

func (r *Router) handleCreateAPIToken(w http.ResponseWriter, req *http.Request) {
	id := r.tokenUser(w, req)
	if id == 0 {
		return
	}
	var body struct {
		Name          string `json:"name"`
		Description   string `json:"description"`
		ExpiresInDays int    `json:"expires_in_days"`
	}
	body.ExpiresInDays = 90
	if err := decodeIntegrationBody(req, &body); err != nil {
		respondIntegrationBodyError(w, err)
		return
	}
	body.Name, body.Description = strings.TrimSpace(body.Name), strings.TrimSpace(body.Description)
	if body.Name == "" || len(body.Name) > 128 || len(body.Description) > 512 || body.ExpiresInDays < 1 || body.ExpiresInDays > 365 {
		respondError(w, http.StatusBadRequest, "System name is required (max 128 bytes), description max 512 bytes, expiry 1–365 days")
		return
	}
	secret, digest, prefix, err := auth.NewAPIToken()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to generate API token")
		return
	}
	token := &models.APIToken{UserID: id, Name: body.Name, Description: body.Description, Prefix: prefix, Digest: digest, ExpiresAt: time.Now().UTC().Add(time.Duration(body.ExpiresInDays) * 24 * time.Hour)}
	if err := r.apiTokenRepo.Create(req.Context(), token); err != nil {
		if errors.Is(err, database.ErrAPITokenLimit) {
			respondError(w, http.StatusConflict, err.Error())
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to create API token")
		return
	}
	respondJSON(w, http.StatusCreated, struct {
		*models.APIToken
		Token string `json:"token"`
	}{token, secret})
}

func (r *Router) handleRevokeAPIToken(w http.ResponseWriter, req *http.Request) {
	userID := r.tokenUser(w, req)
	if userID == 0 {
		return
	}
	id, err := strconv.ParseInt(req.PathValue("tokenID"), 10, 64)
	if err != nil || id < 1 {
		respondError(w, http.StatusBadRequest, "Invalid token ID")
		return
	}
	if err := r.apiTokenRepo.Revoke(req.Context(), userID, id); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respondError(w, http.StatusNotFound, "API token not found for this user")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to revoke API token")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}
