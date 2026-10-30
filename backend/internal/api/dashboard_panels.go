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
	ID               string                    `json:"id"`
	Title            string                    `json:"title"`
	Kind             string                    `json:"kind,omitempty"`
	Source           string                    `json:"source,omitempty"`
	Limit            int                       `json:"limit,omitempty"`
	ParameterPattern string                    `json:"parameter_pattern"`
	Thresholds       []dashboardPanelThreshold `json:"thresholds"`
}

var dashboardPanelIDRe = regexp.MustCompile(`^custom-[a-zA-Z0-9-]{1,64}$`)

var dashboardPanelColors = map[string]struct{}{
	"blue": {}, "green": {}, "amber": {}, "orange": {}, "red": {}, "gray": {},
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
			values, err = r.deviceRepo.GetCategoricalAnalytics(req.Context(), config.Source, 10000, config.Limit)
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
