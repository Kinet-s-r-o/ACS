package database

import (
	"context"
	"encoding/json"
	"errors"

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

var ErrInitialSnapshotLocked = errors.New("initial snapshots can only be deleted with CPE Full access")
var ErrNoWritableSnapshotParameters = errors.New("no writable device parameters are available")
var ErrSnapshotDeviceOffline = errors.New("CPE is offline; no snapshot was created")

func (r *SnapshotRepository) Delete(ctx context.Context, deviceID, id int64, full bool) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var snapshot models.DeviceSnapshot
		if err := tx.Select("id", "kind").Where("device_id = ? AND id = ?", deviceID, id).First(&snapshot).Error; err != nil {
			return err
		}
		if snapshot.Kind == "initial" && !full {
			return ErrInitialSnapshotLocked
		}
		return tx.Where("device_id = ? AND id = ?", deviceID, id).Delete(&models.DeviceSnapshot{}).Error
	})
}

func BuildDeviceSnapshot(device *models.Device, parameters []models.DeviceParameter, name, kind, actor string) (*models.DeviceSnapshot, error) {
	values := []models.SnapshotParameter{}
	for _, parameter := range parameters {
		if parameter.Writable == nil || !*parameter.Writable {
			continue
		}
		value := parameter.Value
		if IsSensitiveParameterName(parameter.Name) {
			var err error
			value, err = EncryptValue(value)
			if err != nil {
				return nil, err
			}
		}
		values = append(values, models.SnapshotParameter{Name: parameter.Name, Value: value, ValueType: parameter.ValueType, Writable: parameter.Writable})
	}
	if len(values) == 0 {
		return nil, ErrNoWritableSnapshotParameters
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return nil, err
	}
	return &models.DeviceSnapshot{DeviceID: device.ID, Name: name, Kind: kind, Manufacturer: device.Manufacturer, ProductClass: device.ProductClass, SoftwareVersion: device.SoftwareVersion, ParameterCount: len(values), Parameters: models.JSON(encoded), CreatedBy: actor}, nil
}
