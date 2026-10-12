package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/skydashnet/skyacs/internal/database"
	"github.com/skydashnet/skyacs/internal/models"
)

var tagColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (r *Router) handleListTags(w http.ResponseWriter, req *http.Request) {
	tags, err := r.tagRepo.List(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list tags")
		return
	}
	respondJSON(w, http.StatusOK, tags)
}

func (r *Router) handleCreateTag(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decodeTagBody(req, &body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid tag body")
		return
	}
	name := strings.TrimSpace(body.Name)
	id := strings.ToLower(name)
	if err := validateTag(name, body.Color); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	existing, err := r.tagRepo.GetByName(req.Context(), name)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to check tag")
		return
	}
	if existing != nil {
		respondError(w, http.StatusConflict, "A tag with this name already exists")
		return
	}
	existing, err = r.tagRepo.Get(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to check tag identifier")
		return
	}
	if existing != nil {
		respondError(w, http.StatusConflict, "This tag identifier is already in use")
		return
	}
	tag := &models.TagDefinition{ID: id, Name: name, Color: strings.ToLower(body.Color)}
	if err := r.tagRepo.Create(req.Context(), tag); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create tag")
		return
	}
	respondJSON(w, http.StatusCreated, tag)
}

func (r *Router) handleUpdateTag(w http.ResponseWriter, req *http.Request) {
	id := strings.ToLower(strings.TrimSpace(req.PathValue("id")))
	existing, err := r.tagRepo.Get(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get tag")
		return
	}
	if existing == nil {
		respondError(w, http.StatusNotFound, "Tag not found")
		return
	}
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decodeTagBody(req, &body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid tag body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if err := validateTag(name, body.Color); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	duplicate, err := r.tagRepo.GetByName(req.Context(), name)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to check tag name")
		return
	}
	if duplicate != nil && duplicate.ID != id {
		respondError(w, http.StatusConflict, "A tag with this name already exists")
		return
	}
	if err := r.tagRepo.Update(req.Context(), id, name, strings.ToLower(body.Color)); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update tag")
		return
	}
	updated, err := r.tagRepo.Get(req.Context(), id)
	if err != nil || updated == nil {
		respondError(w, http.StatusInternalServerError, "Failed to read updated tag")
		return
	}
	respondJSON(w, http.StatusOK, updated)
}

func (r *Router) handleDeleteTag(w http.ResponseWriter, req *http.Request) {
	id := strings.ToLower(strings.TrimSpace(req.PathValue("id")))
	existing, err := r.tagRepo.Get(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get tag")
		return
	}
	if existing == nil {
		respondError(w, http.StatusNotFound, "Tag not found")
		return
	}
	if err := r.tagRepo.Delete(req.Context(), id); err != nil {
		if errors.Is(err, database.ErrTagInUse) {
			respondError(w, http.StatusConflict, "Remove this tag from devices and provisioning rules before deleting it")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to delete tag")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func decodeTagBody(req *http.Request, body interface{}) error {
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(body)
}

func validateTag(name, color string) error {
	if name == "" || len(name) > 64 {
		return errors.New("Tag name must be between 1 and 64 characters")
	}
	if !tagColorPattern.MatchString(color) {
		return errors.New("Tag color must be a six-digit hex color")
	}
	return nil
}
