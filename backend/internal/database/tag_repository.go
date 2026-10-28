package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrTagInUse = errors.New("tag is assigned to a device or provisioning rule")

type TagRepository struct{ db *gorm.DB }

func NewTagRepository(db *gorm.DB) *TagRepository { return &TagRepository{db: db} }

func (r *TagRepository) List(ctx context.Context) ([]models.TagDefinition, error) {
	var tags []models.TagDefinition
	err := r.db.WithContext(ctx).Order("name ASC").Find(&tags).Error
	return tags, err
}

func (r *TagRepository) Get(ctx context.Context, id string) (*models.TagDefinition, error) {
	var tag models.TagDefinition
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&tag).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &tag, nil
}

func (r *TagRepository) GetByName(ctx context.Context, name string) (*models.TagDefinition, error) {
	var tag models.TagDefinition
	err := r.db.WithContext(ctx).Where("LOWER(name) = LOWER(?)", name).First(&tag).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &tag, nil
}

func (r *TagRepository) Create(ctx context.Context, tag *models.TagDefinition) error {
	return r.db.WithContext(ctx).Create(tag).Error
}

func (r *TagRepository) Update(ctx context.Context, id string, name, color, description string) error {
	return r.db.WithContext(ctx).Model(&models.TagDefinition{}).Where("id = ?", id).
		Updates(map[string]interface{}{"name": name, "color": color, "description": description}).Error
}

func (r *TagRepository) Delete(ctx context.Context, id string) error {
	encoded, err := json.Marshal([]string{id})
	if err != nil {
		return err
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var deviceCount, ruleCount int64
		if err := tx.Model(&models.Device{}).Where("tags @> ?::jsonb", string(encoded)).Count(&deviceCount).Error; err != nil {
			return err
		}
		if err := tx.Model(&models.ProvisioningRule{}).Where("tags @> ?::jsonb", string(encoded)).Count(&ruleCount).Error; err != nil {
			return err
		}
		if deviceCount > 0 || ruleCount > 0 {
			return ErrTagInUse
		}
		return tx.Delete(&models.TagDefinition{}, "id = ?", id).Error
	})
}

// SeedLegacyDefinitions creates catalog entries for free-form tags already stored on devices and rules.
func (r *TagRepository) SeedLegacyDefinitions(ctx context.Context) error {
	var devices []models.Device
	if err := r.db.WithContext(ctx).Select("tags").Find(&devices).Error; err != nil {
		return err
	}
	var rules []models.ProvisioningRule
	if err := r.db.WithContext(ctx).Select("tags").Find(&rules).Error; err != nil {
		return err
	}
	legacy := make(map[string]struct{})
	for _, device := range devices {
		for _, tag := range device.Tags {
			if id := strings.ToLower(strings.TrimSpace(tag)); id != "" {
				legacy[id] = struct{}{}
			}
		}
	}
	for _, rule := range rules {
		for _, tag := range rule.Tags {
			if id := strings.ToLower(strings.TrimSpace(tag)); id != "" {
				legacy[id] = struct{}{}
			}
		}
	}
	for id := range legacy {
		tag := models.TagDefinition{ID: id, Name: id, Color: "#64748b"}
		if err := r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&tag).Error; err != nil {
			return err
		}
	}
	return nil
}
