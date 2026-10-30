package database

import (
	"context"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type DashboardLayoutRepository struct {
	db *gorm.DB
}

func NewDashboardLayoutRepository(db *gorm.DB) *DashboardLayoutRepository {
	return &DashboardLayoutRepository{db: db}
}

func (r *DashboardLayoutRepository) Get(ctx context.Context, userID int64) (string, error) {
	var layout models.UserDashboardLayout
	err := r.db.WithContext(ctx).Select("config").Where("user_id = ?", userID).First(&layout).Error
	if err == gorm.ErrRecordNotFound {
		return "{}", nil
	}
	return layout.Config, err
}

func (r *DashboardLayoutRepository) Save(ctx context.Context, userID int64, config string) error {
	layout := models.UserDashboardLayout{UserID: userID, Config: config}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"config", "updated_at"}),
	}).Create(&layout).Error
}
