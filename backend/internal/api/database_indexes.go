package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"gorm.io/gorm"
)

func decodeIndexSpec(w http.ResponseWriter, req *http.Request) (database.IndexSpec, bool) {
	var spec database.IndexSpec
	req.Body = http.MaxBytesReader(w, req.Body, 4096)
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		respondError(w, http.StatusBadRequest, "Provide label, purpose, recipe and parameter_path only. Custom SQL and index methods, including GIN, are forbidden.")
		return spec, false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		respondError(w, http.StatusBadRequest, "Provide exactly one index definition.")
		return spec, false
	}
	if err := database.ValidateIndexSpec(spec); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return spec, false
	}
	return spec, true
}

func indexID(w http.ResponseWriter, req *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		respondError(w, http.StatusBadRequest, "Invalid index definition ID")
		return 0, false
	}
	return id, true
}

func indexAPIError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		respondError(w, http.StatusNotFound, "UI index definition not found")
	case errors.Is(err, database.ErrIndexProtected):
		respondError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, database.ErrIndexBusy):
		respondError(w, http.StatusConflict, err.Error())
	case errors.Is(err, database.ErrIndexPolicy):
		respondError(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		respondError(w, http.StatusServiceUnavailable, "Database index inspection timed out. Retry after checking database load.")
	default:
		log.Printf("DB indexes API: %v", err)
		respondError(w, http.StatusServiceUnavailable, "Database index tools are unavailable. Check database connectivity and server logs.")
	}
}

func (r *Router) handleDatabaseIndexes(w http.ResponseWriter, req *http.Request) {
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	data, err := database.GetIndexOverview(ctx, r.db)
	if err != nil {
		indexAPIError(w, err)
		return
	}
	respondJSON(w, http.StatusOK, data)
}

func (r *Router) handlePreviewDatabaseIndex(w http.ResponseWriter, req *http.Request) {
	spec, ok := decodeIndexSpec(w, req)
	if !ok {
		return
	}
	id := int64(0)
	if req.PathValue("id") != "" {
		id, ok = indexID(w, req)
		if !ok {
			return
		}
	}
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	data, err := database.PreviewManagedIndex(ctx, r.db, spec, id)
	if err != nil {
		indexAPIError(w, err)
		return
	}
	respondJSON(w, http.StatusOK, data)
}

func (r *Router) handleSaveDatabaseIndex(w http.ResponseWriter, req *http.Request) {
	spec, ok := decodeIndexSpec(w, req)
	if !ok {
		return
	}
	id := int64(0)
	if req.Method == http.MethodPut {
		id, ok = indexID(w, req)
		if !ok {
			return
		}
	}
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), 8*time.Second)
	defer cancel()
	data, err := database.QueueManagedIndex(ctx, r.db, id, spec, claims.UserID)
	if err != nil {
		indexAPIError(w, err)
		return
	}
	respondJSON(w, http.StatusAccepted, data)
}

func (r *Router) handleDatabaseIndexAction(w http.ResponseWriter, req *http.Request) {
	id, ok := indexID(w, req)
	if !ok {
		return
	}
	action := "delete"
	if req.Method == http.MethodPost {
		action = "cancel"
	}
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	if err := database.RequestManagedIndexAction(ctx, r.db, id, action); err != nil {
		indexAPIError(w, err)
		return
	}
	respondJSON(w, http.StatusAccepted, map[string]string{"status": "queued"})
}
