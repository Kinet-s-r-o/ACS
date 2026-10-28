package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

func (r *Router) handleCloneProvisioningTemplate(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	sourceID, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil || sourceID < 1 {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var body struct {
		Name         string                    `json:"name"`
		Manufacturer string                    `json:"manufacturer"`
		ProductClass string                    `json:"product_class"`
		Description  string                    `json:"description"`
		Inventory    *models.TemplateInventory `json:"inventory,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Manufacturer = strings.ToLower(strings.TrimSpace(body.Manufacturer))
	body.ProductClass = strings.ToLower(strings.TrimSpace(body.ProductClass))
	body.Description = strings.TrimSpace(body.Description)
	if body.Name == "" || len(body.Name) > 256 || len(body.Manufacturer) > 128 || len(body.ProductClass) > 128 || len(body.Description) > 512 {
		respondError(w, http.StatusBadRequest, "Invalid template name, manufacturer, product class, or description")
		return
	}
	source, err := r.provisioningRepo.GetTemplate(req.Context(), sourceID)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			respondError(w, http.StatusNotFound, "Template not found")
		} else {
			respondError(w, http.StatusInternalServerError, "Failed to load source template")
		}
		return
	}
	inventory := source.Inventory
	if body.Inventory != nil {
		inventory = *body.Inventory
	}
	if err := validateTemplateInventory(&inventory); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	clone := models.ProvisioningTemplate{
		Name: body.Name, Manufacturer: body.Manufacturer, ProductClass: body.ProductClass,
		Description: body.Description, Inventory: inventory, Variables: source.Variables, Features: source.Features,
	}
	targetMetricScope := templateMetricScope(clone.Manufacturer, clone.ProductClass)
	imageCopyPath := ""
	err = r.db.WithContext(req.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&clone).Error; err != nil {
			return err
		}

		var rules []models.ProvisioningRule
		if err := tx.Where("template_id = ?", sourceID).Order("id ASC").Find(&rules).Error; err != nil {
			return err
		}
		for index := range rules {
			rules[index].ID = 0
			rules[index].TemplateID = clone.ID
			rules[index].CreatedAt = time.Time{}
			rules[index].UpdatedAt = time.Time{}
		}
		if len(rules) > 0 {
			if err := tx.Create(&rules).Error; err != nil {
				return err
			}
		}

		var metrics []models.MetricDefinition
		if err := tx.Where("template_id = ? AND parameter_pattern = ''", sourceID).Find(&metrics).Error; err != nil {
			return err
		}
		clonedMetrics := make([]models.MetricDefinition, 0, len(metrics))
		for _, metric := range metrics {
			metric.ID = 0
			metric.DeviceTypeMatch = targetMetricScope
			metric.TemplateID = &clone.ID
			metric.LegacyInterfaceID = nil
			metric.CreatedAt = time.Time{}
			metric.UpdatedAt = time.Time{}
			clonedMetrics = append(clonedMetrics, metric)
		}
		if len(clonedMetrics) > 0 {
			if err := tx.Create(&clonedMetrics).Error; err != nil {
				return err
			}
		}

		var interfaceMetrics []models.MetricDefinition
		if err := tx.Where("template_id = ? AND parameter_pattern <> ''", sourceID).Find(&interfaceMetrics).Error; err != nil {
			return err
		}
		cloneID := clone.ID
		for index := range interfaceMetrics {
			interfaceMetrics[index].ID = 0
			interfaceMetrics[index].TemplateID = &cloneID
			interfaceMetrics[index].DeviceTypeMatch = targetMetricScope
			interfaceMetrics[index].LegacyInterfaceID = nil
			interfaceMetrics[index].CreatedAt = time.Time{}
			interfaceMetrics[index].UpdatedAt = time.Time{}
		}
		if len(interfaceMetrics) > 0 {
			if err := tx.Create(&interfaceMetrics).Error; err != nil {
				return err
			}
		}

		if source.ImagePath != "" {
			sourcePath, err := secureTemplateImagePath(r.templateImageDir, source.ImagePath)
			if err != nil {
				return err
			}
			imageData, err := os.ReadFile(sourcePath)
			if err != nil {
				return err
			}
			extension := filepath.Ext(sourcePath)
			imageCopyPath = filepath.Join(r.templateImageDir, strconv.FormatInt(clone.ID, 10)+"-"+strconv.FormatInt(time.Now().UnixNano(), 10)+extension)
			if err := os.WriteFile(imageCopyPath, imageData, 0640); err != nil {
				return err
			}
			clone.ImagePath = imageCopyPath
			clone.ImageType = source.ImageType
			if err := tx.Model(&clone).Updates(map[string]any{"image_path": clone.ImagePath, "image_type": clone.ImageType}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if imageCopyPath != "" {
			_ = os.Remove(imageCopyPath)
		}
		respondError(w, http.StatusInternalServerError, "Failed to clone provisioning template")
		return
	}
	r.templateImageURL(&clone)
	redactProvisioningVariableSecrets(clone.Variables)
	respondJSON(w, http.StatusCreated, clone)
}

func templateMetricScope(manufacturer, productClass string) string {
	manufacturer, productClass = strings.ToLower(manufacturer), strings.ToLower(productClass)
	if manufacturer == "" && productClass == "" {
		return "*"
	}
	if manufacturer == "" {
		manufacturer = "*"
	}
	if productClass == "" {
		productClass = "*"
	}
	return manufacturer + "/" + productClass
}

func metricAppliesToTemplate(pattern, manufacturer, productClass string) bool {
	pattern = strings.ToLower(pattern)
	manufacturer = strings.ToLower(manufacturer)
	productClass = strings.ToLower(productClass)
	if pattern == "" || pattern == "*" || (manufacturer == "" && productClass == "") {
		return true
	}
	if manufacturer != "" && productClass != "" {
		matched, _ := path.Match(pattern, manufacturer+"/"+productClass)
		return matched
	}
	segments := strings.Split(pattern, "/")
	if len(segments) != 2 {
		return false
	}
	if manufacturer != "" {
		matched, _ := path.Match(segments[0], manufacturer)
		return matched
	}
	matched, _ := path.Match(segments[1], productClass)
	return matched
}
