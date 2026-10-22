package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/skydashnet/skyacs/internal/auth"
	"github.com/skydashnet/skyacs/internal/models"
)

var colorHexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (r *Router) handleListMetricDefinitions(w http.ResponseWriter, req *http.Request) {
	defs, err := r.metricRepo.ListAll(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list metric definitions")
		return
	}
	respondJSON(w, http.StatusOK, defs)
}

func (r *Router) handleTemplateMetricDefinitions(w http.ResponseWriter, req *http.Request) {
	templateID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	defs, err := r.metricRepo.ListTemplateMetrics(req.Context(), templateID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list template metrics")
		return
	}
	respondJSON(w, http.StatusOK, defs)
}

func (r *Router) handleSaveTemplateMetric(w http.ResponseWriter, req *http.Request) {
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
	var template models.ProvisioningTemplate
	if err := r.db.WithContext(req.Context()).First(&template, templateID).Error; err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	var body models.MetricDefinition
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	defaultMetricHistory(&body)
	if body.Source == "" {
		body.Source = "passive"
	}
	if body.ThresholdDirection == "" {
		body.ThresholdDirection = "higher_is_worse"
	}
	if body.DisplayFormat == "" {
		body.DisplayFormat = "number"
	}
	if body.HealthSize == "" {
		body.HealthSize = "small"
	}
	body.DeviceTypeMatch = template.Manufacturer + "/" + template.ProductClass
	body.TemplateID = &templateID
	body.InterfaceType = ""
	body.ParameterPattern = ""
	if err := validateMetricDefinition(&body); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Multiplier == 0 {
		body.Multiplier = 1
	}
	if req.Method == http.MethodPost {
		if err := r.metricRepo.Create(req.Context(), &body); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to create template metric")
			return
		}
		respondJSON(w, http.StatusCreated, body)
		return
	}
	id, err := strconv.ParseInt(req.PathValue("metricID"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid metric ID")
		return
	}
	body.ID = id
	result := r.db.WithContext(req.Context()).Model(&models.MetricDefinition{}).Where("id = ? AND template_id = ? AND parameter_pattern = ''", id, templateID).Select("name", "description", "device_type_match", "template_id", "parameter_name", "unit", "source", "active", "store_history", "group", "color", "axis", "transform", "multiplier", "unit_scale", "health", "health_order", "health_size", "warn_threshold", "critical_threshold", "threshold_direction", "display_format", "gauge_animated", "gauge_min", "gauge_max", "gauge_arc", "gauge_pointer", "gauge_style", "thresholds", "chart_type").Updates(&body)
	if result.Error != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update template metric")
		return
	}
	if result.RowsAffected == 0 {
		respondError(w, http.StatusNotFound, "Template metric not found")
		return
	}
	respondJSON(w, http.StatusOK, body)
}

func (r *Router) handleDeleteTemplateMetric(w http.ResponseWriter, req *http.Request) {
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
	result := r.db.WithContext(req.Context()).Where("template_id = ? AND parameter_pattern = ''", templateID).Delete(&models.MetricDefinition{}, id)
	if result.Error != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete template metric")
		return
	}
	if result.RowsAffected == 0 {
		respondError(w, http.StatusNotFound, "Template metric not found")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleDeviceMetricDefinitions(w http.ResponseWriter, req *http.Request) {
	device, err := r.deviceRepo.GetBySerial(req.Context(), req.PathValue("serial"))
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	manufacturer, productClass := "", ""
	if device.Manufacturer != nil {
		manufacturer = *device.Manufacturer
	}
	if device.ProductClass != nil {
		productClass = *device.ProductClass
	}
	defs, err := r.metricRepo.TemplateMetricsForDevice(req.Context(), manufacturer+"/"+productClass, false)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load metric definitions")
		return
	}
	respondJSON(w, http.StatusOK, defs)
}

func (r *Router) handleCreateMetricDefinition(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	respondError(w, http.StatusBadRequest, "Create metrics through a provisioning template")
	return

	var body models.MetricDefinition
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	defaultMetricHistory(&body)

	if err := validateMetricDefinition(&body); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	if body.Source == "" {
		body.Source = "passive"
	}
	if body.DeviceTypeMatch == "" {
		body.DeviceTypeMatch = "*"
	}
	if body.ThresholdDirection == "" {
		body.ThresholdDirection = "higher_is_worse"
	}
	if body.DisplayFormat == "" {
		body.DisplayFormat = "number"
	}
	if body.HealthSize == "" {
		body.HealthSize = "small"
	}

	if err := r.metricRepo.Create(req.Context(), &body); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create metric definition")
		return
	}

	respondJSON(w, http.StatusCreated, body)
}

func (r *Router) handleUpdateMetricDefinition(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	respondError(w, http.StatusBadRequest, "Manage metrics through their provisioning template")
	return

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid metric ID")
		return
	}
	if current, err := r.metricRepo.GetByID(req.Context(), id); err == nil && current.TemplateID != nil {
		respondError(w, http.StatusBadRequest, "Manage interface metrics through their provisioning template")
		return
	}

	var body models.MetricDefinition
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	defaultMetricHistory(&body)

	if err := validateMetricDefinition(&body); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	if body.HealthSize == "" {
		body.HealthSize = "small"
	}
	body.ID = id
	if err := r.metricRepo.Update(req.Context(), &body); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update metric definition")
		return
	}

	respondJSON(w, http.StatusOK, body)
}

func (r *Router) handleDeleteMetricDefinition(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	respondError(w, http.StatusBadRequest, "Manage metrics through their provisioning template")
	return

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid metric ID")
		return
	}
	if def, err := r.metricRepo.GetByID(req.Context(), id); err == nil && def.TemplateID != nil {
		respondError(w, http.StatusBadRequest, "Manage interface metrics through their provisioning template")
		return
	}

	if err := r.metricRepo.Delete(req.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete metric definition")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleGetDeviceMetrics(w http.ResponseWriter, req *http.Request) {
	serial := req.PathValue("serial")
	device, err := r.deviceRepo.GetBySerial(req.Context(), serial)
	if err != nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}

	q := req.URL.Query()
	metricIDStr := q.Get("metric_id")
	metricID, err := strconv.ParseInt(metricIDStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "metric_id query parameter is required")
		return
	}

	bucket := q.Get("bucket")
	if bucket == "" {
		bucket = "5min"
	}

	from := time.Now().Add(-24 * time.Hour)
	if v := q.Get("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = t
		}
	}
	to := time.Now()
	if v := q.Get("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = t
		}
	}

	// Fetch metric definition to check for rate transform
	def, defErr := r.metricRepo.GetByID(req.Context(), metricID)
	isRate := defErr == nil && def.Transform == "rate"
	multiplier := 1.0
	if defErr == nil {
		multiplier = def.Multiplier
		if multiplier <= 0 {
			multiplier = 1.0
		}
	}

	if bucket == "raw" {
		if isRate {
			samples, err := r.metricRepo.QueryRawRate(req.Context(), device.ID, metricID, from, to, multiplier)
			if err != nil {
				respondError(w, http.StatusInternalServerError, "Failed to query metric samples")
				return
			}
			respondJSON(w, http.StatusOK, map[string]interface{}{"samples": samples})
			return
		}
		samples, err := r.metricRepo.QueryRaw(req.Context(), device.ID, metricID, from, to, multiplier)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to query metric samples")
			return
		}
		respondJSON(w, http.StatusOK, map[string]interface{}{"samples": samples})
		return
	}

	if isRate {
		rows, err := r.metricRepo.QueryAggregatedRate(req.Context(), device.ID, metricID, from, to, bucket, multiplier)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to query aggregated metrics")
			return
		}
		// Fallback: if the CA returned no rows, try raw rate samples.
		if len(rows) == 0 {
			samples, rawErr := r.metricRepo.QueryRawRate(req.Context(), device.ID, metricID, from, to, multiplier)
			if rawErr == nil && len(samples) > 0 {
				respondJSON(w, http.StatusOK, map[string]interface{}{"samples": samples})
				return
			}
		}
		respondJSON(w, http.StatusOK, map[string]interface{}{"aggregates": rows})
		return
	}

	rows, err := r.metricRepo.QueryAggregated(req.Context(), device.ID, metricID, from, to, bucket, multiplier)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to query aggregated metrics")
		return
	}

	// Fallback: if the CA returned no rows (e.g. not yet refreshed), try raw samples.
	if len(rows) == 0 {
		samples, rawErr := r.metricRepo.QueryRaw(req.Context(), device.ID, metricID, from, to, multiplier)
		if rawErr == nil && len(samples) > 0 {
			respondJSON(w, http.StatusOK, map[string]interface{}{"samples": samples})
			return
		}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{"aggregates": rows})
}

func (r *Router) handleGetDeviceTypes(w http.ResponseWriter, req *http.Request) {
	var types []string
	if err := r.db.Model(&models.Device{}).
		Where("manufacturer IS NOT NULL AND product_class IS NOT NULL AND manufacturer <> '' AND product_class <> ''").
		Distinct().
		Pluck("manufacturer || '/' || product_class", &types).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list device types")
		return
	}
	if types == nil {
		types = []string{}
	}
	respondJSON(w, http.StatusOK, types)
}

func defaultMetricHistory(def *models.MetricDefinition) {
	if def.StoreHistory == nil {
		storeHistory := true
		def.StoreHistory = &storeHistory
	}
}

func validateMetricDefinition(def *models.MetricDefinition) error {
	if def.Name == "" || len(def.Name) > 128 {
		return errors.New("metric name is required and must be at most 128 characters")
	}
	if def.ParameterName == "" || len(def.ParameterName) > 512 {
		return errors.New("parameter_name is required and must be at most 512 characters")
	}
	if len(def.DeviceTypeMatch) > 256 {
		return errors.New("device_type_match exceeds 256 characters")
	}
	if len(def.Unit) > 32 {
		return errors.New("unit exceeds 32 characters")
	}
	switch def.Source {
	case "passive", "active", "universal":
	default:
		return errors.New("source must be 'passive', 'active', or 'universal'")
	}
	if len(def.Description) > 512 {
		return errors.New("description exceeds 512 characters")
	}
	if len(def.Group) > 64 {
		return errors.New("group exceeds 64 characters")
	}
	if def.Color != "" && !colorHexRe.MatchString(def.Color) {
		return errors.New("color must be a valid hex color (e.g. #38bdf8)")
	}
	switch def.Axis {
	case "", "left", "right":
	default:
		return errors.New("axis must be 'left' or 'right'")
	}
	switch def.Transform {
	case "", "rate":
	default:
		return errors.New("transform must be '' or 'rate'")
	}
	if def.Multiplier < 0 {
		return errors.New("multiplier must be non-negative")
	}
	if !def.StoresHistory() && def.Transform == "rate" {
		return errors.New("rate transform requires metric history")
	}
	switch def.UnitScale {
	case "", "auto", "bytes", "bits", "pps":
	default:
		return errors.New("unit_scale must be '', 'auto', 'bytes', 'bits', or 'pps'")
	}
	switch def.ThresholdDirection {
	case "", "higher_is_worse", "lower_is_worse":
	default:
		return errors.New("threshold_direction must be 'higher_is_worse' or 'lower_is_worse'")
	}
	switch def.DisplayFormat {
	case "", "number", "uptime", "gauge":
	default:
		return errors.New("display_format must be 'number', 'uptime', or 'gauge'")
	}
	switch def.HealthSize {
	case "", "small", "medium", "large":
	default:
		return errors.New("health_size must be 'small', 'medium', or 'large'")
	}
	if def.HealthOrder < 0 {
		return errors.New("health_order must be non-negative")
	}
	if len(def.Thresholds) > 20 {
		return errors.New("thresholds must have at most 20 entries")
	}
	for _, t := range def.Thresholds {
		if t.Color != "" && !colorHexRe.MatchString(t.Color) {
			return errors.New("thresholds color must be a valid hex color (e.g. #38bdf8)")
		}
	}
	switch def.ChartType {
	case "", "line", "bar", "pictorialBar", "scatter", "effectScatter", "candlestick", "boxplot", "heatmap", "pie", "sunburst", "gauge", "radar", "funnel", "graph", "chord", "sankey", "treemap", "tree", "map", "lines", "parallel", "themeRiver", "custom":
	default:
		return errors.New("chart_type is not a valid ECharts type")
	}
	switch def.GaugeArc {
	case "", "180", "220", "270", "360":
	default:
		return errors.New("gauge_arc must be '180', '220', '270', or '360'")
	}
	switch def.GaugeStyle {
	case "", "basic", "simple", "speed", "progress", "stage", "grade", "multi", "temperature", "ring", "barometer":
	default:
		return errors.New("gauge_style is not supported")
	}
	return nil
}
