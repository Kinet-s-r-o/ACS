package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/auth"
	"github.com/skydashnet/skyacs/internal/models"
)

func (r *Router) handleListInterfaceMetrics(w http.ResponseWriter, req *http.Request) {
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var defs []models.InterfaceMetricDefinition
	if err := r.db.WithContext(req.Context()).Where("template_id = ?", templateID).Order("id ASC").Find(&defs).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list interface metrics")
		return
	}
	respondJSON(w, http.StatusOK, defs)
}

func (r *Router) handleGetDeviceInterfaceMetric(w http.ResponseWriter, req *http.Request) {
	device, err := r.deviceRepo.GetBySerial(req.Context(), req.PathValue("serial"))
	if err != nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	metricID, err := strconv.ParseInt(req.URL.Query().Get("metric_id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "metric_id is required")
		return
	}
	parameterName := req.URL.Query().Get("parameter_name")
	if parameterName == "" {
		respondError(w, http.StatusBadRequest, "parameter_name is required")
		return
	}
	var def models.InterfaceMetricDefinition
	if err := r.db.WithContext(req.Context()).First(&def, metricID).Error; err != nil {
		respondError(w, http.StatusNotFound, "Interface metric not found")
		return
	}
	from, to := time.Now().Add(-24*time.Hour), time.Now()
	if value := req.URL.Query().Get("from"); value != "" {
		if parsed, parseErr := time.Parse(time.RFC3339, value); parseErr == nil {
			from = parsed
		}
	}
	if value := req.URL.Query().Get("to"); value != "" {
		if parsed, parseErr := time.Parse(time.RFC3339, value); parseErr == nil {
			to = parsed
		}
	}
	multiplier := def.Multiplier
	if multiplier <= 0 {
		multiplier = 1
	}
	samples, err := r.metricRepo.QueryInterfaceMetric(req.Context(), device.ID, metricID, parameterName, from, to, def.Transform == "rate", multiplier)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to query interface metric samples")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"samples": samples})
}

func (r *Router) handleSaveInterfaceMetric(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var def models.InterfaceMetricDefinition
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&def); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if def.Name == "" || len(def.Name) > 128 || def.ParameterPattern == "" || len(def.ParameterPattern) > 512 || (def.InterfaceType != "wan" && def.InterfaceType != "lan") || (def.Transform != "" && def.Transform != "rate") || def.Multiplier < 0 || (def.Color != "" && !colorHexRe.MatchString(def.Color)) {
		respondError(w, http.StatusBadRequest, "Invalid interface metric definition")
		return
	}
	if strings.Contains(def.ParameterPattern, "*") {
		for _, segment := range strings.Split(def.ParameterPattern, ".") {
			if strings.Contains(segment, "*") && segment != "*" {
				respondError(w, http.StatusBadRequest, "Use * as a complete path segment")
				return
			}
		}
	}
	var template models.ProvisioningTemplate
	if err := r.db.WithContext(req.Context()).First(&template, templateID).Error; err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	def.TemplateID = templateID
	if def.Multiplier == 0 {
		def.Multiplier = 1
	}
	if req.Method == http.MethodPost {
		if err := r.db.WithContext(req.Context()).Create(&def).Error; err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to create interface metric")
			return
		}
		respondJSON(w, http.StatusCreated, def)
		return
	}
	id, err := strconv.ParseInt(req.PathValue("metricID"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid metric ID")
		return
	}
	def.ID = id
	result := r.db.WithContext(req.Context()).Model(&models.InterfaceMetricDefinition{}).Where("id = ? AND template_id = ?", id, templateID).Updates(map[string]any{"name": def.Name, "description": def.Description, "interface_type": def.InterfaceType, "parameter_pattern": def.ParameterPattern, "unit": def.Unit, "color": def.Color, "transform": def.Transform, "multiplier": def.Multiplier, "active": def.Active})
	if result.Error != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update interface metric")
		return
	}
	if result.RowsAffected == 0 {
		respondError(w, http.StatusNotFound, "Interface metric not found")
		return
	}
	respondJSON(w, http.StatusOK, def)
}

func (r *Router) handleDeleteInterfaceMetric(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("metricID"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid metric ID")
		return
	}
	result := r.db.WithContext(req.Context()).Where("id = ? AND template_id = ?", id, templateID).Delete(&models.InterfaceMetricDefinition{})
	if result.Error != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete interface metric")
		return
	}
	if result.RowsAffected == 0 {
		respondError(w, http.StatusNotFound, "Interface metric not found")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
