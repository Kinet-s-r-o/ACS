package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

type dashboardPanelThreshold struct {
	Label string   `json:"label"`
	Max   *float64 `json:"max"`
	Color string   `json:"color"`
}

type dashboardPanelConfig struct {
	ID                  string                    `json:"id"`
	Title               string                    `json:"title"`
	Kind                string                    `json:"kind,omitempty"`
	Source              string                    `json:"source,omitempty"`
	AggregationOptionID string                    `json:"aggregation_option_id,omitempty"`
	Limit               int                       `json:"limit,omitempty"`
	ParameterPattern    string                    `json:"parameter_pattern"`
	Thresholds          []dashboardPanelThreshold `json:"thresholds"`
}

type dashboardAggregationOption struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	ParameterPattern string `json:"parameter_pattern"`
}

const dashboardAggregationOptionsSetting = "fleet_aggregation_options"

var dashboardPanelIDRe = regexp.MustCompile(`^custom-[a-zA-Z0-9-]{1,64}$`)
var dashboardAggregationOptionIDRe = regexp.MustCompile(`^aggregation-[a-zA-Z0-9-]{1,64}$`)
var dashboardParameterPatternRe = regexp.MustCompile(`^(InternetGatewayDevice|Device)\.[A-Za-z0-9_.*-]+$`)

var dashboardPanelColors = map[string]struct{}{
	"blue": {}, "green": {}, "amber": {}, "orange": {}, "red": {}, "gray": {},
}

func validateDashboardAggregationOptionsJSON(raw string) (string, error) {
	var options []dashboardAggregationOption
	if len(raw) > 16*1024 || json.Unmarshal([]byte(raw), &options) != nil || len(options) > 30 {
		return "", errors.New("configure at most 30 valid Fleet aggregation options")
	}
	ids := make(map[string]struct{}, len(options))
	titles := make(map[string]struct{}, len(options))
	for index := range options {
		option := &options[index]
		option.ID = strings.TrimSpace(option.ID)
		option.Title = strings.TrimSpace(option.Title)
		option.ParameterPattern = strings.TrimSpace(option.ParameterPattern)
		if !dashboardAggregationOptionIDRe.MatchString(option.ID) {
			return "", errors.New("invalid Fleet aggregation option ID")
		}
		if option.Title == "" || len(option.Title) > 48 {
			return "", errors.New("aggregation option names must be between 1 and 48 characters")
		}
		if _, duplicate := ids[option.ID]; duplicate {
			return "", errors.New("aggregation option IDs must be unique")
		}
		if _, duplicate := titles[strings.ToLower(option.Title)]; duplicate {
			return "", errors.New("aggregation option names must be unique")
		}
		ids[option.ID] = struct{}{}
		titles[strings.ToLower(option.Title)] = struct{}{}
		pattern := option.ParameterPattern
		if len(pattern) > 512 || strings.Count(pattern, "*") > 8 || !dashboardParameterPatternRe.MatchString(pattern) || validateParameterNames([]string{strings.ReplaceAll(pattern, "*", "X")}) != nil {
			return "", errors.New("aggregation option parameter paths must be valid Device. or InternetGatewayDevice. paths")
		}
	}
	encoded, err := json.Marshal(options)
	if err != nil {
		return "", errors.New("could not encode Fleet aggregation options")
	}
	return string(encoded), nil
}

type dashboardLayoutItem struct {
	Order  int     `json:"order"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type dashboardLayoutConfig map[string]dashboardLayoutItem

var builtInDashboardPanelIDs = map[string]struct{}{
	"growth": {}, "contactRecency": {}, "uptime": {}, "temperature": {}, "rxPower": {},
	"accessType": {}, "manufacturer": {}, "productClass": {},
}

func validateDashboardLayout(layout dashboardLayoutConfig) error {
	if len(layout) > 32 {
		return errors.New("dashboard layout has too many panels")
	}
	for id, item := range layout {
		if _, ok := builtInDashboardPanelIDs[id]; !ok && !dashboardPanelIDRe.MatchString(id) {
			return fmt.Errorf("invalid dashboard layout panel ID %q", id)
		}
		if item.Order < 0 || item.Order > 1000 || math.IsNaN(item.Width) || math.IsInf(item.Width, 0) || item.Width < 30 || item.Width > 120 || math.IsNaN(item.Height) || math.IsInf(item.Height, 0) || item.Height < 0 || item.Height > 10000 {
			return fmt.Errorf("invalid dashboard layout for panel %q", id)
		}
	}
	return nil
}

func validateDashboardPanelConfigs(configs []dashboardPanelConfig) error {
	if len(configs) > 12 {
		return database.ErrDashboardPanelLimit
	}
	ids := make(map[string]struct{}, len(configs))
	for _, config := range configs {
		if _, duplicate := ids[config.ID]; duplicate {
			return errors.New("dashboard panel IDs must be unique")
		}
		ids[config.ID] = struct{}{}
		if !validDashboardPanelID(config.ID) {
			return fmt.Errorf("invalid dashboard panel ID %q", config.ID)
		}
		if title := strings.TrimSpace(config.Title); title == "" || len(title) > 48 {
			return errors.New("panel title is required and must be at most 48 characters")
		}
		kind := config.Kind
		if kind == "" {
			kind = "parameter"
		}
		if kind != "parameter" && kind != "category" && kind != "recency" {
			return errors.New("invalid dashboard panel kind")
		}
		if kind == "category" {
			switch config.Source {
			case "access_type", "manufacturer", "product_class":
			case "custom_parameter":
				pattern := strings.TrimSpace(config.ParameterPattern)
				if len(pattern) > 512 || strings.Count(pattern, "*") > 8 || !dashboardParameterPatternRe.MatchString(pattern) || validateParameterNames([]string{strings.ReplaceAll(pattern, "*", "X")}) != nil {
					return errors.New("invalid dashboard category parameter pattern")
				}
				if !dashboardAggregationOptionIDRe.MatchString(config.AggregationOptionID) {
					return errors.New("select a configured aggregation option")
				}
			default:
				return errors.New("invalid dashboard category source")
			}
		} else if kind == "recency" && config.Source != "last_inform" {
			return errors.New("invalid dashboard recency source")
		}
		if config.Limit < 0 || config.Limit > 100 {
			return errors.New("dashboard panel limit must be between 0 and 100")
		}
		pattern := strings.TrimSpace(config.ParameterPattern)
		if kind != "parameter" {
			pattern = ""
		}
		if len(pattern) > 512 || strings.Count(pattern, "*") > 8 || strings.ContainsAny(pattern, "?[]{}") || validateParameterNames([]string{strings.ReplaceAll(pattern, "*", "X")}) != nil {
			if kind == "parameter" {
				return errors.New("invalid dashboard parameter pattern")
			}
		}
		if kind != "parameter" {
			continue
		}
		if len(config.Thresholds) == 0 || len(config.Thresholds) > 16 {
			return errors.New("configure between 1 and 16 threshold buckets")
		}
		labels := make(map[string]struct{}, len(config.Thresholds))
		var previousMax *float64
		for index, threshold := range config.Thresholds {
			label := strings.TrimSpace(threshold.Label)
			if label == "" || len(label) > 48 || strings.EqualFold(label, "N/A") {
				return errors.New("threshold labels must be unique, non-empty, and cannot be N/A")
			}
			if _, duplicate := labels[strings.ToLower(label)]; duplicate {
				return errors.New("threshold labels must be unique")
			}
			labels[strings.ToLower(label)] = struct{}{}
			if _, validColor := dashboardPanelColors[threshold.Color]; !validColor {
				return errors.New("threshold color is invalid")
			}
			if threshold.Max == nil {
				if index != len(config.Thresholds)-1 {
					return errors.New("only the final threshold may have no maximum")
				}
				continue
			}
			if math.IsNaN(*threshold.Max) || math.IsInf(*threshold.Max, 0) || previousMax != nil && *threshold.Max <= *previousMax {
				return errors.New("threshold maximums must be finite and in ascending order")
			}
			previousMax = threshold.Max
		}
		if config.Thresholds[len(config.Thresholds)-1].Max != nil {
			return errors.New("the final threshold must have no maximum")
		}
	}
	return nil
}

func validDashboardPanelID(id string) bool {
	switch id {
	case "uptime", "temperature", "rxPower", "contactRecency", "accessType", "manufacturer", "productClass":
		return true
	default:
		return dashboardPanelIDRe.MatchString(id)
	}
}

func (r *Router) handleGetDashboardPanels(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	rows, err := r.dashboardPanelRepo.List(req.Context(), claims.UserID)
	if err != nil {
		logDashboardPanelError("load", err)
		respondError(w, http.StatusInternalServerError, "Failed to load dashboard panels")
		return
	}
	configs := make([]dashboardPanelConfig, 0, len(rows))
	for _, row := range rows {
		var config dashboardPanelConfig
		if err := json.Unmarshal([]byte(row.Config), &config); err != nil {
			logDashboardPanelError("decode", err)
			respondError(w, http.StatusInternalServerError, "Stored dashboard panel configuration is invalid")
			return
		}
		configs = append(configs, config)
	}
	respondJSON(w, http.StatusOK, configs)
}

func (r *Router) handleGetDashboardAggregationOptions(w http.ResponseWriter, req *http.Request) {
	setting, err := r.settingsRepo.Get(req.Context(), dashboardAggregationOptionsSetting)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load Fleet aggregation options")
		return
	}
	options := make([]dashboardAggregationOption, 0)
	if setting != nil && setting.Value != "" {
		validated, err := validateDashboardAggregationOptionsJSON(setting.Value)
		if err != nil || json.Unmarshal([]byte(validated), &options) != nil {
			respondError(w, http.StatusInternalServerError, "Stored Fleet aggregation options are invalid")
			return
		}
	}
	respondJSON(w, http.StatusOK, options)
}

func (r *Router) handleGetDashboardLayout(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	encoded, err := r.dashboardLayoutRepo.Get(req.Context(), claims.UserID)
	if err != nil {
		log.Printf("Error loading dashboard layout: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to load dashboard layout")
		return
	}
	var layout dashboardLayoutConfig
	if err := json.Unmarshal([]byte(encoded), &layout); err != nil {
		log.Printf("Error decoding dashboard layout: %v", err)
		respondError(w, http.StatusInternalServerError, "Stored dashboard layout is invalid")
		return
	}
	if layout == nil {
		layout = dashboardLayoutConfig{}
	}
	respondJSON(w, http.StatusOK, layout)
}

func (r *Router) handleSaveDashboardLayout(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 16*1024))
	decoder.DisallowUnknownFields()
	var layout dashboardLayoutConfig
	if err := decoder.Decode(&layout); err != nil || layout == nil {
		respondError(w, http.StatusBadRequest, "Invalid dashboard layout")
		return
	}
	if err := validateDashboardLayout(layout); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	encoded, err := json.Marshal(layout)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid dashboard layout")
		return
	}
	if err := r.dashboardLayoutRepo.Save(req.Context(), claims.UserID, string(encoded)); err != nil {
		log.Printf("Error saving dashboard layout: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to save dashboard layout")
		return
	}
	respondJSON(w, http.StatusOK, layout)
}

func (r *Router) handleSaveDashboardPanels(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 128*1024))
	decoder.DisallowUnknownFields()
	var configs []dashboardPanelConfig
	if err := decoder.Decode(&configs); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid dashboard panel configuration")
		return
	}
	if err := validateDashboardPanelConfigs(configs); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, database.ErrDashboardPanelLimit) {
			status = http.StatusConflict
		}
		respondError(w, status, err.Error())
		return
	}
	rows := make([]models.UserDashboardPanel, 0, len(configs))
	for _, config := range configs {
		encoded, err := json.Marshal(config)
		if err != nil {
			respondError(w, http.StatusBadRequest, "Invalid dashboard panel configuration")
			return
		}
		rows = append(rows, models.UserDashboardPanel{UserID: claims.UserID, PanelID: config.ID, Config: string(encoded)})
	}
	if err := r.dashboardPanelRepo.Replace(req.Context(), claims.UserID, rows); err != nil {
		logDashboardPanelError("save", err)
		respondError(w, http.StatusInternalServerError, "Failed to save dashboard panels")
		return
	}
	respondJSON(w, http.StatusOK, configs)
}

func (r *Router) handleCopyDashboardPanel(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	var body struct {
		Panel   dashboardPanelConfig `json:"panel"`
		UserIDs []int64              `json:"user_ids"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 32*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid dashboard panel copy request")
		return
	}
	if err := validateDashboardPanelConfigs([]dashboardPanelConfig{body.Panel}); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.UserIDs) == 0 || len(body.UserIDs) > 50 {
		respondError(w, http.StatusBadRequest, "Select between 1 and 50 destination users")
		return
	}
	uniqueIDs := make(map[int64]struct{}, len(body.UserIDs))
	for _, userID := range body.UserIDs {
		if userID <= 0 || userID == claims.UserID {
			respondError(w, http.StatusBadRequest, "Destination user IDs must be valid and cannot include your own account")
			return
		}
		if _, duplicate := uniqueIDs[userID]; duplicate {
			respondError(w, http.StatusBadRequest, "Destination user IDs must be unique")
			return
		}
		uniqueIDs[userID] = struct{}{}
	}
	encoded, err := json.Marshal(body.Panel)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid dashboard panel configuration")
		return
	}
	if err := r.dashboardPanelRepo.CopyToUsers(req.Context(), string(encoded), body.UserIDs); err != nil {
		logDashboardPanelError("copy", err)
		if errors.Is(err, database.ErrDashboardPanelLimit) {
			respondError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respondError(w, http.StatusNotFound, "One or more destination users do not exist")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to copy dashboard panel")
		return
	}
	respondJSON(w, http.StatusOK, map[string]int{"copied_to": len(body.UserIDs)})
}

func (r *Router) handleDashboardPanelAnalytics(w http.ResponseWriter, req *http.Request) {
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64*1024))
	decoder.DisallowUnknownFields()
	var configs []dashboardPanelConfig
	if err := decoder.Decode(&configs); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid dashboard analytics request")
		return
	}
	if err := validateDashboardPanelConfigs(configs); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	panels := make(map[string]map[string]int)
	for _, config := range configs {
		if config.Kind == "" || config.Kind == "parameter" {
			continue
		}
		var values map[string]int
		var err error
		if config.Kind == "recency" {
			values, err = r.deviceRepo.GetRecencyAnalytics(req.Context(), 10000)
		} else {
			source, pattern := config.Source, config.ParameterPattern
			if source == "custom_parameter" {
				source = "parameter"
			}
			values, err = r.deviceRepo.GetCategoricalAnalytics(req.Context(), source, pattern, 10000, config.Limit)
		}
		if err != nil {
			log.Printf("Error getting dashboard panel analytics: %v", err)
			respondError(w, http.StatusInternalServerError, "Failed to get dashboard panel analytics")
			return
		}
		panels[config.ID] = values
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"panels": panels})
}

func logDashboardPanelError(action string, err error) {
	log.Printf("Dashboard panel %s failed: %v", action, err)
}
