package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/auth"
	"github.com/skydashnet/skyacs/internal/database"
	"github.com/skydashnet/skyacs/internal/models"
	"gorm.io/gorm"
)

const provisioningTransferVersion = 1

type provisioningTransfer struct {
	Format    string                         `json:"format"`
	Version   int                            `json:"version"`
	Scope     string                         `json:"scope"`
	CreatedAt time.Time                      `json:"created_at"`
	Templates []provisioningTransferTemplate `json:"templates"`
}

type provisioningTransferTemplate struct {
	Name         string                        `json:"name"`
	Manufacturer string                        `json:"manufacturer"`
	ProductClass string                        `json:"product_class"`
	Description  string                        `json:"description,omitempty"`
	Variables    []models.ProvisioningVariable `json:"variables,omitempty"`
	Features     []models.ProvisioningFeature  `json:"features,omitempty"`
	Rules        []models.ProvisioningRule     `json:"rules,omitempty"`
	Metrics      []models.MetricDefinition     `json:"metrics,omitempty"`
}

func requireFullProvisioningAccess(w http.ResponseWriter, req *http.Request) bool {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return false
	}
	return true
}

func (r *Router) handleExportProvisioning(w http.ResponseWriter, req *http.Request) {
	if !requireFullProvisioningAccess(w, req) {
		return
	}
	var templates []models.ProvisioningTemplate
	if err := r.db.WithContext(req.Context()).Order("id ASC").Find(&templates).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load provisioning templates")
		return
	}

	backup := provisioningTransfer{
		Format: "acs-backup", Version: provisioningTransferVersion, Scope: "provisioning",
		CreatedAt: time.Now().UTC(), Templates: make([]provisioningTransferTemplate, 0, len(templates)),
	}
	for _, template := range templates {
		item := provisioningTransferTemplate{
			Name: template.Name, Manufacturer: template.Manufacturer, ProductClass: template.ProductClass,
			Description: template.Description, Variables: template.Variables, Features: template.Features,
		}
		rules, err := r.provisioningRepo.ListForTemplate(req.Context(), template.ID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to load provisioning rules")
			return
		}
		item.Rules = make([]models.ProvisioningRule, 0, len(rules))
		for _, rule := range rules {
			if rule != nil {
				item.Rules = append(item.Rules, *rule)
			}
		}
		if err := r.db.WithContext(req.Context()).Where("template_id = ?", template.ID).Order("id ASC").Find(&item.Metrics).Error; err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to load metric definitions")
			return
		}
		// IDs and timestamps are database identity, not portable configuration.
		for index := range item.Rules {
			item.Rules[index].ID = 0
			item.Rules[index].TemplateID = 0
			item.Rules[index].Version = 0
			item.Rules[index].CreatedAt = time.Time{}
			item.Rules[index].UpdatedAt = time.Time{}
		}
		for index := range item.Metrics {
			item.Metrics[index].ID = 0
			item.Metrics[index].TemplateID = nil
			item.Metrics[index].LegacyInterfaceID = nil
			item.Metrics[index].CreatedAt = time.Time{}
			item.Metrics[index].UpdatedAt = time.Time{}
		}
		backup.Templates = append(backup.Templates, item)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="acs-backup.json"`)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(backup); err != nil {
		return
	}
}

func (r *Router) handleImportProvisioning(w http.ResponseWriter, req *http.Request) {
	if !requireFullProvisioningAccess(w, req) {
		return
	}
	var body struct {
		Mode string `json:"mode"`
		provisioningTransfer
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 20<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid ACS JSON backup")
		return
	}
	if body.Format != "acs-backup" || body.Version != provisioningTransferVersion || body.Scope != "provisioning" {
		respondError(w, http.StatusBadRequest, "Unsupported ACS backup format or version")
		return
	}
	if body.Mode == "" {
		body.Mode = "append"
	}
	if body.Mode != "append" && body.Mode != "replace" {
		respondError(w, http.StatusBadRequest, "Import mode must be append or replace")
		return
	}
	if len(body.Templates) > 100 {
		respondError(w, http.StatusBadRequest, "Backup contains too many templates")
		return
	}

	for index := range body.Templates {
		if err := validateTransferTemplate(&body.Templates[index]); err != nil {
			respondError(w, http.StatusBadRequest, fmt.Sprintf("Template %d: %s", index+1, err.Error()))
			return
		}
	}

	created := 0
	err := r.db.WithContext(req.Context()).Transaction(func(tx *gorm.DB) error {
		if body.Mode == "replace" {
			if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Where("1 = 1").Delete(&models.ProvisioningApplication{}).Error; err != nil {
				return err
			}
			for _, model := range []interface{}{&models.ProvisioningRule{}, &models.MetricDefinition{}, &models.ProvisioningTemplate{}} {
				if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).Where("1 = 1").Delete(model).Error; err != nil {
					return err
				}
			}
		}
		for index := range body.Templates {
			item := &body.Templates[index]
			if err := prepareProvisioningVariableSecrets(item.Variables, nil); err != nil {
				return err
			}
			template := models.ProvisioningTemplate{
				Name: item.Name, Manufacturer: strings.ToLower(item.Manufacturer), ProductClass: strings.ToLower(item.ProductClass),
				Description: item.Description, Variables: item.Variables, Features: item.Features,
			}
			if err := tx.Create(&template).Error; err != nil {
				return err
			}
			for ruleIndex := range item.Rules {
				rule := item.Rules[ruleIndex]
				rule.ID, rule.TemplateID, rule.Version = 0, template.ID, 1
				rule.CreatedAt, rule.UpdatedAt = time.Time{}, time.Time{}
				if database.IsSensitiveParameterName(rule.ParameterName) {
					value, err := database.EncryptProvisioningValue(rule.ParameterValue)
					if err != nil {
						return err
					}
					rule.ParameterValue = value
				}
				if err := tx.Create(&rule).Error; err != nil {
					return err
				}
			}
			for metricIndex := range item.Metrics {
				metric := item.Metrics[metricIndex]
				metric.ID, metric.LegacyInterfaceID = 0, nil
				metric.TemplateID = &template.ID
				metric.DeviceTypeMatch = templateMetricScope(template.Manufacturer, template.ProductClass)
				metric.CreatedAt, metric.UpdatedAt = time.Time{}, time.Time{}
				if err := tx.Create(&metric).Error; err != nil {
					return err
				}
			}
			created++
		}
		return nil
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, "Failed to import ACS backup: "+err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, map[string]interface{}{"status": "imported", "mode": body.Mode, "templates": created})
}

func validateTransferTemplate(item *provisioningTransferTemplate) error {
	item.Name = strings.TrimSpace(item.Name)
	item.Manufacturer = strings.TrimSpace(item.Manufacturer)
	item.ProductClass = strings.TrimSpace(item.ProductClass)
	item.Description = strings.TrimSpace(item.Description)
	if item.Name == "" || len(item.Name) > 256 || len(item.Manufacturer) > 128 || len(item.ProductClass) > 128 || len(item.Description) > 512 {
		return errors.New("invalid template identity or description")
	}
	if err := validateProvisioningVariables(item.Variables); err != nil {
		return err
	}
	if err := validateProvisioningFeatures(item.Features); err != nil {
		return err
	}
	for index := range item.Rules {
		rule := &item.Rules[index]
		if err := validateProvisioningRule(rule.ParameterName, rule.ParameterValue, rule.ParameterType, rule.AddObjectPath, rule.Phase, append(append([]string{}, rule.Tags...), rule.ExcludedTags...), rule.Description); err != nil {
			return fmt.Errorf("rule %d: %w", index+1, err)
		}
		if err := validateAddObjectPath(rule.AddObjectPath); err != nil {
			return fmt.Errorf("rule %d: %w", index+1, err)
		}
	}
	for index := range item.Metrics {
		metric := &item.Metrics[index]
		metric.ID, metric.TemplateID, metric.LegacyInterfaceID = 0, nil, nil
		metric.CreatedAt, metric.UpdatedAt = time.Time{}, time.Time{}
		if metric.Source == "" {
			metric.Source = "passive"
		}
		if metric.ThresholdDirection == "" {
			metric.ThresholdDirection = "higher_is_worse"
		}
		if metric.DisplayFormat == "" {
			metric.DisplayFormat = "number"
		}
		if metric.HealthSize == "" {
			metric.HealthSize = "small"
		}
		if metric.Multiplier == 0 {
			metric.Multiplier = 1
		}
		if err := validateMetricDefinition(metric); err != nil {
			return fmt.Errorf("metric %d: %w", index+1, err)
		}
	}
	return nil
}
