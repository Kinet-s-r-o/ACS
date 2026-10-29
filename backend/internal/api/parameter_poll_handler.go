package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/matrix8412/acs/internal/models"
)

type parameterPollRequest struct {
	ParameterPattern string `json:"parameter_pattern"`
	IntervalSeconds  int    `json:"interval_seconds"`
	Active           *bool  `json:"active"`
}

func (r *Router) handleListParameterPolls(w http.ResponseWriter, req *http.Request) {
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var definitions []models.ParameterPollDefinition
	if err := r.db.WithContext(req.Context()).Where("template_id = ?", templateID).Order("id ASC").Find(&definitions).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list parameter polling rules")
		return
	}
	respondJSON(w, http.StatusOK, definitions)
}

func (r *Router) handleSaveParameterPoll(w http.ResponseWriter, req *http.Request) {
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var template models.ProvisioningTemplate
	if err := r.db.WithContext(req.Context()).First(&template, templateID).Error; err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	var body parameterPollRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	body.ParameterPattern = strings.TrimSpace(body.ParameterPattern)
	if !validParameterPollPattern(body.ParameterPattern) {
		respondError(w, http.StatusBadRequest, "Parameter path must start with Device. or InternetGatewayDevice. and use complete path segments")
		return
	}
	if body.IntervalSeconds < 1 || body.IntervalSeconds > 31536000 {
		respondError(w, http.StatusBadRequest, "Interval must be between 1 and 31536000 seconds")
		return
	}
	active := true
	if body.Active != nil {
		active = *body.Active
	}
	definition := models.ParameterPollDefinition{TemplateID: templateID, ParameterPattern: body.ParameterPattern, IntervalSeconds: body.IntervalSeconds, Active: active}
	if req.Method == http.MethodPost {
		if err := r.db.WithContext(req.Context()).Create(&definition).Error; err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to create parameter polling rule")
			return
		}
		respondJSON(w, http.StatusCreated, definition)
		return
	}
	id, err := strconv.ParseInt(req.PathValue("pollID"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid polling rule ID")
		return
	}
	result := r.db.WithContext(req.Context()).Model(&models.ParameterPollDefinition{}).Where("id = ? AND template_id = ?", id, templateID).Select("parameter_pattern", "interval_seconds", "active").Updates(&definition)
	if result.Error != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update parameter polling rule")
		return
	}
	if result.RowsAffected == 0 {
		respondError(w, http.StatusNotFound, "Parameter polling rule not found")
		return
	}
	definition.ID = id
	respondJSON(w, http.StatusOK, definition)
}

func (r *Router) handleDeleteParameterPoll(w http.ResponseWriter, req *http.Request) {
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("pollID"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid polling rule ID")
		return
	}
	result := r.db.WithContext(req.Context()).Where("template_id = ?", templateID).Delete(&models.ParameterPollDefinition{}, id)
	if result.Error != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete parameter polling rule")
		return
	}
	if result.RowsAffected == 0 {
		respondError(w, http.StatusNotFound, "Parameter polling rule not found")
		return
	}
	if err := r.db.WithContext(req.Context()).Where("definition_id = ?", id).Delete(&models.ParameterPollState{}).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Polling rule deleted but its schedule state could not be cleared")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func validParameterPollPattern(pattern string) bool {
	if len(pattern) == 0 || len(pattern) > 512 || !(strings.HasPrefix(pattern, "Device.") || strings.HasPrefix(pattern, "InternetGatewayDevice.")) {
		return false
	}
	for _, part := range strings.Split(pattern, ".") {
		if part == "" || (strings.Contains(part, "*") && part != "*") {
			return false
		}
	}
	return true
}
