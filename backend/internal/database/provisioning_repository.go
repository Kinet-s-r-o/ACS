package database

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ProvisioningRepository struct {
	db *gorm.DB
}

func NewProvisioningRepository(db *gorm.DB) *ProvisioningRepository {
	return &ProvisioningRepository{db: db}
}

// ── Template CRUD ────────────────────────────────────────────────────────────

func (r *ProvisioningRepository) CreateTemplate(ctx context.Context, template *models.ProvisioningTemplate) error {
	return r.db.WithContext(ctx).Create(template).Error
}

func (r *ProvisioningRepository) ListTemplates(ctx context.Context) ([]*models.ProvisioningTemplate, error) {
	var templates []*models.ProvisioningTemplate
	if err := r.db.WithContext(ctx).Order("id ASC").Find(&templates).Error; err != nil {
		return nil, err
	}
	return templates, nil
}

func (r *ProvisioningRepository) GetTemplate(ctx context.Context, id int64) (*models.ProvisioningTemplate, error) {
	var template models.ProvisioningTemplate
	if err := r.db.WithContext(ctx).First(&template, id).Error; err != nil {
		return nil, err
	}
	return &template, nil
}

func (r *ProvisioningRepository) UpdateTemplateFeatures(ctx context.Context, id int64, features []models.ProvisioningFeature) error {
	template := models.ProvisioningTemplate{ID: id, Features: features}
	return r.db.WithContext(ctx).Model(&template).Select("features").Updates(&template).Error
}

func (r *ProvisioningRepository) UpdateTemplate(ctx context.Context, template *models.ProvisioningTemplate) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		query := tx.Model(&models.ProvisioningTemplate{}).Where("id = ?", template.ID)
		var err error
		if template.Variables != nil {
			err = query.Select("name", "manufacturer", "product_class", "description", "variables").Updates(template).Error
		} else {
			err = query.Select("name", "manufacturer", "product_class", "description").Updates(template).Error
		}
		if err != nil || template.Variables == nil {
			return err
		}
		return tx.Model(&models.ProvisioningRule{}).
			Where("template_id = ? AND parameter_value LIKE ?", template.ID, "%{{%").
			UpdateColumn("version", gorm.Expr("version + 1")).Error
	})
}

func (r *ProvisioningRepository) UpdateTemplateImage(ctx context.Context, id int64, path, contentType string) error {
	return r.db.WithContext(ctx).Model(&models.ProvisioningTemplate{}).Where("id = ?", id).
		Updates(map[string]interface{}{"image_path": path, "image_type": contentType}).Error
}

func (r *ProvisioningRepository) ClearTemplateImage(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Model(&models.ProvisioningTemplate{}).Where("id = ?", id).
		Updates(map[string]interface{}{"image_path": "", "image_type": ""}).Error
}

func (r *ProvisioningRepository) DeleteTemplate(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("template_id = ?", id).Delete(&models.MetricDefinition{}).Error; err != nil {
			return err
		}
		if err := tx.Where("template_id = ?", id).Delete(&models.InterfaceMetricDefinition{}).Error; err != nil {
			return err
		}
		if err := tx.Where("template_id = ?", id).Delete(&models.ProvisioningRule{}).Error; err != nil {
			return err
		}
		return tx.Delete(&models.ProvisioningTemplate{}, id).Error
	})
}

// ResolveTemplateForDevice returns the most specific template matching the
// device's (manufacturer, product_class). Specificity: 2 > 1 > 0. Ties broken by lower ID.
func (r *ProvisioningRepository) ResolveTemplateForDevice(ctx context.Context, manufacturer, productClass string) (*models.ProvisioningTemplate, error) {
	var template models.ProvisioningTemplate
	err := r.db.WithContext(ctx).
		Where("(manufacturer = '' OR LOWER(manufacturer) = LOWER(?))", manufacturer).
		Where("(product_class = '' OR LOWER(product_class) = LOWER(?))", productClass).
		Order("CASE WHEN manufacturer <> '' AND product_class <> '' THEN 2 WHEN manufacturer <> '' OR product_class <> '' THEN 1 ELSE 0 END DESC, id ASC").
		First(&template).Error
	if err != nil {
		return nil, err
	}
	return &template, nil
}

// SelectProvisioningTemplate resolves the most specific matching template
// from an already loaded list, using the same precedence as the database
// resolver while avoiding one query per device in inventory responses.
func SelectProvisioningTemplate(templates []*models.ProvisioningTemplate, manufacturer, productClass string) *models.ProvisioningTemplate {
	manufacturer = strings.ToLower(strings.TrimSpace(manufacturer))
	productClass = strings.ToLower(strings.TrimSpace(productClass))
	var selected *models.ProvisioningTemplate
	for _, template := range templates {
		if template == nil || (template.Manufacturer != "" && !strings.EqualFold(template.Manufacturer, manufacturer)) || (template.ProductClass != "" && !strings.EqualFold(template.ProductClass, productClass)) {
			continue
		}
		if selected == nil || template.SpecificityScore() > selected.SpecificityScore() || (template.SpecificityScore() == selected.SpecificityScore() && template.ID < selected.ID) {
			selected = template
		}
	}
	return selected
}

// ── Rule CRUD ────────────────────────────────────────────────────────────────

func (r *ProvisioningRepository) Create(ctx context.Context, rule *models.ProvisioningRule) error {
	stored := *rule
	if IsSensitiveParameterName(stored.ParameterName) {
		value, err := encryptParameterValue(stored.ParameterValue)
		if err != nil {
			return fmt.Errorf("encrypt provisioning value: %w", err)
		}
		stored.ParameterValue = value
	}
	if err := r.db.WithContext(ctx).Create(&stored).Error; err != nil {
		return err
	}
	plaintext := rule.ParameterValue
	*rule = stored
	rule.ParameterValue = plaintext
	return nil
}

func (r *ProvisioningRepository) List(ctx context.Context) ([]*models.ProvisioningRule, error) {
	var rules []*models.ProvisioningRule
	if err := r.db.WithContext(ctx).Order("\"order\" ASC, id ASC").Find(&rules).Error; err != nil {
		return nil, err
	}
	return rules, decryptProvisioningRules(rules)
}

func (r *ProvisioningRepository) ListForTemplate(ctx context.Context, templateID int64) ([]*models.ProvisioningRule, error) {
	var rules []*models.ProvisioningRule
	if err := r.db.WithContext(ctx).Where("template_id = ?", templateID).Order("\"order\" ASC, id ASC").Find(&rules).Error; err != nil {
		return nil, err
	}
	return rules, decryptProvisioningRules(rules)
}

// tagInclusionSQL checks whether the rule's tags are satisfied by the device's tags.
// Empty/NULL rule tags → always true.
const tagInclusionSQL = `(r.tags IS NULL OR jsonb_array_length(r.tags) = 0 OR (
	d.tags IS NOT NULL AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text(r.tags) AS rt(tag)
		WHERE d.tags @> to_jsonb(rt.tag)
	)
)) AND NOT EXISTS (
	SELECT 1 FROM jsonb_array_elements_text(r.excluded_tags) AS rt(tag)
	WHERE COALESCE(d.tags, '[]'::jsonb) @> to_jsonb(rt.tag)
)`

// ListPendingForDevice returns enabled rules for the device's resolved template
// that have not yet been applied at the current version.
func (r *ProvisioningRepository) ListPendingForDevice(ctx context.Context, deviceID int64, manufacturer, productClass, phase string) ([]*models.ProvisioningRule, error) {
	template, err := r.ResolveTemplateForDevice(ctx, manufacturer, productClass)
	if err != nil {
		return nil, err
	}
	var rules []*models.ProvisioningRule
	query := `
		SELECT r.* FROM provisioning_rules r
		JOIN devices d ON d.id = ?
		WHERE r.template_id = ?
		  AND r.enabled = true
		  AND r.phase = ?
		  AND ` + tagInclusionSQL + `
		  AND NOT EXISTS (
			SELECT 1 FROM provisioning_applications pa
			WHERE pa.rule_id = r.id AND pa.rule_version = r.version AND pa.device_id = ?
		  )
		ORDER BY r."order" ASC, r.id ASC`
	if err := r.db.WithContext(ctx).Raw(query, deviceID, template.ID, phase, deviceID).Scan(&rules).Error; err != nil {
		return nil, err
	}
	return rules, decryptProvisioningRules(rules)
}

// ListForDevice returns all enabled rules for the device's resolved template
// without filtering by provisioning_applications. Used on BOOTSTRAP events.
func (r *ProvisioningRepository) ListForDevice(ctx context.Context, deviceID int64, manufacturer, productClass, phase string) ([]*models.ProvisioningRule, error) {
	template, err := r.ResolveTemplateForDevice(ctx, manufacturer, productClass)
	if err != nil {
		return nil, err
	}
	var rules []*models.ProvisioningRule
	query := `
		SELECT r.* FROM provisioning_rules r
		JOIN devices d ON d.id = ?
		WHERE r.template_id = ?
		  AND r.enabled = true
		  AND r.phase = ?
		  AND ` + tagInclusionSQL + `
		ORDER BY r."order" ASC, r.id ASC`
	if err := r.db.WithContext(ctx).Raw(query, deviceID, template.ID, phase).Scan(&rules).Error; err != nil {
		return nil, err
	}
	return rules, decryptProvisioningRules(rules)
}

func (r *ProvisioningRepository) MarkApplied(ctx context.Context, deviceID int64, applications []models.ProvisioningApplication) error {
	for index := range applications {
		applications[index].DeviceID = deviceID
		applications[index].ID = 0
		applications[index].AppliedAt = time.Time{}
	}
	if len(applications) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&applications).Error
}

func (r *ProvisioningRepository) Update(ctx context.Context, rule *models.ProvisioningRule) error {
	value := rule.ParameterValue
	if IsSensitiveParameterName(rule.ParameterName) {
		var err error
		value, err = encryptParameterValue(value)
		if err != nil {
			return fmt.Errorf("encrypt provisioning value: %w", err)
		}
	}
	var excludedTagsJSON interface{}
	if rule.ExcludedTags != nil {
		b, err := json.Marshal(rule.ExcludedTags)
		if err != nil {
			return fmt.Errorf("marshal excluded tags: %w", err)
		}
		excludedTagsJSON = string(b)
	}
	var tagsJSON interface{}
	if rule.Tags != nil {
		b, err := json.Marshal(rule.Tags)
		if err != nil {
			return fmt.Errorf("marshal tags: %w", err)
		}
		tagsJSON = string(b)
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return tx.Model(&models.ProvisioningRule{}).Where("id = ?", rule.ID).Updates(map[string]interface{}{
			"template_id": rule.TemplateID, "parameter_name": rule.ParameterName, "parameter_value": value, "parameter_type": rule.ParameterType,
			"phase": rule.Phase, "tags": tagsJSON, "excluded_tags": excludedTagsJSON, "enabled": rule.Enabled, "description": rule.Description,
			"add_object_path": rule.AddObjectPath, "order": rule.Order, "condition": rule.Condition,
			"version": gorm.Expr("version + 1"),
		}).Error
	})
}

// MaxOrder returns the highest order value for the given template and phase, or 0 if no rules exist.
func (r *ProvisioningRepository) MaxOrder(ctx context.Context, templateID int64, phase string) (int, error) {
	var max int
	if err := r.db.WithContext(ctx).Model(&models.ProvisioningRule{}).
		Where("template_id = ? AND phase = ?", templateID, phase).
		Select("COALESCE(MAX(\"order\"), 0)").
		Scan(&max).Error; err != nil {
		return 0, err
	}
	return max, nil
}

func (r *ProvisioningRepository) Reorder(ctx context.Context, templateID int64, orderedIDs []int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for i, id := range orderedIDs {
			if err := tx.Model(&models.ProvisioningRule{}).Where("id = ? AND template_id = ?", id, templateID).Update("order", i).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func decryptProvisioningRules(rules []*models.ProvisioningRule) error {
	for _, rule := range rules {
		if !IsSensitiveParameterName(rule.ParameterName) {
			continue
		}
		value, err := decryptParameterValue(rule.ParameterValue)
		if err != nil {
			return fmt.Errorf("decrypt provisioning rule %d: %w", rule.ID, err)
		}
		rule.ParameterValue = value
	}
	return nil
}

func (r *ProvisioningRepository) EncryptLegacySensitiveValues(ctx context.Context) (int64, error) {
	var encrypted int64
	var lastID int64
	for {
		var rules []models.ProvisioningRule
		if err := r.db.WithContext(ctx).Select("id", "parameter_name", "parameter_value").
			Where("id > ?", lastID).Order("id ASC").Limit(500).Find(&rules).Error; err != nil {
			return encrypted, err
		}
		if len(rules) == 0 {
			return encrypted, nil
		}
		if err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			for _, rule := range rules {
				lastID = rule.ID
				if !IsSensitiveParameterName(rule.ParameterName) || rule.ParameterValue == "" || strings.HasPrefix(rule.ParameterValue, encryptedParameterPrefix) {
					continue
				}
				value, err := encryptParameterValue(rule.ParameterValue)
				if err != nil {
					return err
				}
				if err := tx.Model(&models.ProvisioningRule{}).Where("id = ?", rule.ID).Update("parameter_value", value).Error; err != nil {
					return err
				}
				encrypted++
			}
			return nil
		}); err != nil {
			return encrypted, err
		}
	}
}

func (r *ProvisioningRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("rule_id = ?", id).Delete(&models.ProvisioningApplication{}).Error; err != nil {
			return err
		}
		return tx.Delete(&models.ProvisioningRule{}, id).Error
	})
}

func (r *ProvisioningRepository) ToggleEnabled(ctx context.Context, id int64, enabled bool) error {
	return r.db.WithContext(ctx).Model(&models.ProvisioningRule{}).
		Where("id = ?", id).
		Update("enabled", enabled).Error
}
