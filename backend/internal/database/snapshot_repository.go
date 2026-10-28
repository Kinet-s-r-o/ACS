package database

import (
	"context"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

type SnapshotRepository struct {
	db *gorm.DB
}

func NewSnapshotRepository(db *gorm.DB) *SnapshotRepository {
	return &SnapshotRepository{db: db}
}

func (r *SnapshotRepository) Create(ctx context.Context, snapshot *models.DeviceSnapshot) error {
	return r.db.WithContext(ctx).Create(snapshot).Error
}

func (r *SnapshotRepository) ListByDeviceID(ctx context.Context, deviceID int64) ([]models.DeviceSnapshot, error) {
	var snapshots []models.DeviceSnapshot
	err := r.db.WithContext(ctx).Omit("parameters").Where("device_id = ?", deviceID).
		Order("created_at DESC").Find(&snapshots).Error
	return snapshots, err
}

func (r *SnapshotRepository) GetByID(ctx context.Context, deviceID, id int64) (*models.DeviceSnapshot, error) {
	var snapshot models.DeviceSnapshot
	err := r.db.WithContext(ctx).Where("device_id = ? AND id = ?", deviceID, id).First(&snapshot).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func (r *SnapshotRepository) Delete(ctx context.Context, deviceID, id int64) error {
	return r.db.WithContext(ctx).Where("device_id = ? AND id = ?", deviceID, id).
		Delete(&models.DeviceSnapshot{}).Error
}
