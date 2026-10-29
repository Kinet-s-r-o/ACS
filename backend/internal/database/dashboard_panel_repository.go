package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

var ErrDashboardPanelLimit = errors.New("a user can have at most 12 dashboard panels")

type DashboardPanelRepository struct {
	db *gorm.DB
}

func NewDashboardPanelRepository(db *gorm.DB) *DashboardPanelRepository {
	return &DashboardPanelRepository{db: db}
}

func (r *DashboardPanelRepository) List(ctx context.Context, userID int64) ([]models.UserDashboardPanel, error) {
	var panels []models.UserDashboardPanel
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("created_at ASC, id ASC").Find(&panels).Error
	return panels, err
}

func (r *DashboardPanelRepository) Replace(ctx context.Context, userID int64, panels []models.UserDashboardPanel) error {
	if len(panels) > 12 {
		return ErrDashboardPanelLimit
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&models.UserDashboardPanel{}).Error; err != nil {
			return err
		}
		if len(panels) == 0 {
			return nil
		}
		for index := range panels {
			panels[index].ID = 0
			panels[index].UserID = userID
		}
		return tx.Omit("User").Create(&panels).Error
	})
}

func (r *DashboardPanelRepository) CopyToUsers(ctx context.Context, sourceConfig string, userIDs []int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing int64
		if err := tx.Model(&models.User{}).Where("id IN ?", userIDs).Count(&existing).Error; err != nil {
			return err
		}
		if existing != int64(len(userIDs)) {
			return gorm.ErrRecordNotFound
		}
		for _, userID := range userIDs {
			var count int64
			if err := tx.Model(&models.UserDashboardPanel{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
				return err
			}
			if count >= 12 {
				return ErrDashboardPanelLimit
			}
			panelID, err := newCopiedPanelID()
			if err != nil {
				return err
			}
			var config map[string]json.RawMessage
			if err := json.Unmarshal([]byte(sourceConfig), &config); err != nil {
				return err
			}
			encodedID, err := json.Marshal(panelID)
			if err != nil {
				return err
			}
			config["id"] = encodedID
			encodedConfig, err := json.Marshal(config)
			if err != nil {
				return err
			}
			if err := tx.Omit("User").Create(&models.UserDashboardPanel{UserID: userID, PanelID: panelID, Config: string(encodedConfig)}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func newCopiedPanelID() (string, error) {
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return "custom-" + hex.EncodeToString(entropy[:]), nil
}
