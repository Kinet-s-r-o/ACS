package database

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrIdempotencyConflict = errors.New("idempotency key already used for a different request")
var ErrInactiveAPIToken = errors.New("API token is no longer active")

// Serialize submissions for a token so concurrent retries create only one CWMP task.
func (r *TaskRepository) CreateIntegration(ctx context.Context, task *models.Task) (bool, error) {
	replayed := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var token models.APIToken
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&token, *task.APITokenID).Error; err != nil {
			return err
		}
		if token.RevokedAt != nil || !time.Now().Before(token.ExpiresAt) {
			return ErrInactiveAPIToken
		}
		if task.APIRequestKey != nil {
			var previous models.Task
			err := tx.Where("api_token_id = ? AND api_request_key = ?", *task.APITokenID, *task.APIRequestKey).First(&previous).Error
			if err == nil {
				if err := decryptSetTaskPayload(&previous); err != nil {
					return err
				}
				var previousPayload, currentPayload any
				if err := json.Unmarshal(previous.Payload, &previousPayload); err != nil {
					return err
				}
				if err := json.Unmarshal(task.Payload, &currentPayload); err != nil {
					return err
				}
				if previous.DeviceID != task.DeviceID || previous.Type != task.Type || !reflect.DeepEqual(previousPayload, currentPayload) {
					return ErrIdempotencyConflict
				}
				*task = previous
				redactSetTaskPayload(task)
				redactGetTaskResult(task)
				replayed = true
				return nil
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		return NewTaskRepository(tx).Create(ctx, task)
	})
	return replayed, err
}

// IntegrationDevice deliberately excludes connection-request credentials and parameter trees.
type IntegrationDevice struct {
	ID              int64      `json:"id"`
	SerialNumber    string     `json:"serial_number"`
	Manufacturer    *string    `json:"manufacturer"`
	ProductClass    *string    `json:"product_class"`
	ModelName       *string    `json:"model_name"`
	SoftwareVersion *string    `json:"software_version"`
	Online          bool       `json:"online"`
	LastInform      *time.Time `json:"last_inform"`
}

func (r *DeviceRepository) IntegrationList(ctx context.Context, after int64, limit int) ([]IntegrationDevice, error) {
	items := make([]IntegrationDevice, 0)
	err := r.db.WithContext(ctx).Model(&models.Device{}).Select("id, serial_number, manufacturer, product_class, model_name, software_version, online, last_inform").
		Where("id > ?", after).Order("id ASC").Limit(limit).Find(&items).Error
	return items, err
}

func (r *ParameterRepository) IntegrationList(ctx context.Context, deviceID int64, after, prefix string, names []string, limit int, sensitive bool) ([]models.DeviceParameter, error) {
	items := make([]models.DeviceParameter, 0)
	query := r.db.WithContext(ctx).Where("device_id = ? AND name > ?", deviceID, after)
	if prefix != "" {
		escaped := strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(prefix)
		query = query.Where("name LIKE ?", escaped+"%")
	}
	if len(names) > 0 {
		query = query.Where("name IN ?", names)
	}
	if err := query.Order("name ASC").Limit(limit).Find(&items).Error; err != nil {
		return nil, err
	}
	for i := range items {
		if !sensitive && IsSensitiveParameterName(items[i].Name) {
			items[i].Value = "[REDACTED]"
			continue
		}
		value, err := decryptParameterValue(items[i].Value)
		if err != nil {
			return nil, err
		}
		items[i].Value = value
	}
	return items, nil
}

func (r *TaskRepository) IntegrationList(ctx context.Context, deviceID, before int64, limit int) ([]models.Task, error) {
	items := make([]models.Task, 0)
	query := r.db.WithContext(ctx).Where("device_id = ?", deviceID)
	if before > 0 {
		query = query.Where("id < ?", before)
	}
	// Payload and result are fetched only by the task detail endpoint.
	err := query.Omit("payload", "result").Order("id DESC").Limit(limit).Find(&items).Error
	return items, err
}
