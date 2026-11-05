package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	return r.ReplaceChecked(ctx, userID, panels, nil)
}

// Check the persisted snapshot while holding the dashboard owner's row lock.
func (r *DashboardPanelRepository) ReplaceChecked(ctx context.Context, userID int64, panels []models.UserDashboardPanel, check func([]models.UserDashboardPanel) error) error {
	if len(panels) > 12 {
		return ErrDashboardPanelLimit
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var owner struct{ ID int64 }
		if err := tx.Model(&models.User{}).Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", userID).Take(&owner).Error; err != nil {
			return err
		}
		if check != nil {
			var previous []models.UserDashboardPanel
			if err := tx.Where("user_id = ?", userID).Find(&previous).Error; err != nil {
				return err
			}
			if err := check(previous); err != nil {
				return err
			}
		}
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

func (r *DashboardPanelRepository) DeletePanel(ctx context.Context, userID int64, panelID string) (bool, error) {
	deleted := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var owner struct{ ID int64 }
		if err := tx.Model(&models.User{}).Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", userID).Take(&owner).Error; err != nil {
			return err
		}
		result := tx.Where("user_id = ? AND panel_id = ?", userID, panelID).Delete(&models.UserDashboardPanel{})
		deleted = result.RowsAffected > 0
		return result.Error
	})
	return deleted, err
}

func (r *DashboardPanelRepository) CopyToUsers(ctx context.Context, sourceConfig string, userIDs []int64) error {
	userIDs = append([]int64{}, userIDs...)
	slices.Sort(userIDs)
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing int64
		if err := tx.Model(&models.User{}).Where("id IN ?", userIDs).Count(&existing).Error; err != nil {
			return err
		}
		if existing != int64(len(userIDs)) {
			return gorm.ErrRecordNotFound
		}
		for _, userID := range userIDs {
			var owner struct{ ID int64 }
			if err := tx.Model(&models.User{}).Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", userID).Take(&owner).Error; err != nil {
				return err
			}
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
