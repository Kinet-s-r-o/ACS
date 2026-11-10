package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Queue while holding the device row so checks and restarts cannot duplicate work.
func (r *SnapshotRepository) QueueAutomatic(ctx context.Context, deviceID, templateID int64, kind string, slot, now time.Time) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var device models.Device
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&device, deviceID).Error; err != nil {
			return err
		}
		if !device.Online {
			return nil
		}
		manufacturer, productClass := snapshotDeviceIdentity(device)
		template, err := NewProvisioningRepository(tx).ResolveTemplateForDevice(ctx, manufacturer, productClass)
		if err != nil {
			return err
		}
		if template.ID != templateID {
			return nil
		}
		if kind == "initial" {
			exists, err := hasInitialSnapshot(ctx, tx, device.ID)
			if err != nil {
				return err
			}
			if exists {
				return nil
			}
			if !InitialSnapshotDue(device, *template, now) {
				return nil
			}
		} else if kind == "scheduled" {
			if !template.Snapshots.ScheduledEnabled {
				return nil
			}
			last, err := lastScheduledSnapshot(ctx, tx, device.ID)
			if err != nil {
				return err
			}
			if !ScheduledSnapshotDue(now, device.CreatedAt, last, template.Snapshots.ScheduledIntervalMinutes) {
				return nil
			}
			slot = now
		} else {
			return errors.New("invalid automatic snapshot kind")
		}
		var count int64
		// An old timed-out job may still have an in-flight CWMP request.
		if err := tx.Model(&models.SystemTask{}).Where("device_id = ? AND snapshot_kind <> ''", deviceID).
			Where("status IN ? OR cwmp_task_id IN (SELECT id FROM tasks WHERE device_id = ? AND status IN ?)", []models.SystemTaskStatus{models.SystemTaskStatusPending, models.SystemTaskStatusProcessing, models.SystemTaskStatusWaiting}, deviceID, []models.TaskStatus{models.TaskStatusPending, models.TaskStatusSent}).Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return nil
		}
		var retry models.SystemTask
		err = tx.Where("device_id = ? AND snapshot_kind = ? AND snapshot_template_id = ? AND status = ?", deviceID, kind, templateID, models.SystemTaskStatusFailed).Order("id DESC").First(&retry).Error
		if err == nil {
			return tx.Model(&retry).Updates(map[string]interface{}{"status": models.SystemTaskStatusPending, "snapshot_slot": slot, "cwmp_task_id": nil, "started_at": nil, "dispatched_at": nil, "last_inform_before": nil, "completed_at": nil, "error_message": ""}).Error
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		return tx.Create(&models.SystemTask{Type: models.SystemTaskTypeBulkSummon, DeviceID: deviceID, RefreshParameters: true, Status: models.SystemTaskStatusPending, CreatedBy: "snapshot scheduler", SnapshotKind: kind, SnapshotSlot: &slot, SnapshotTemplateID: &templateID}).Error
	})
}

func InitialSnapshotDue(device models.Device, template models.ProvisioningTemplate, now time.Time) bool {
	// Existence is checked against saved snapshots while holding the device row;
	// cached completion/activation markers must not exclude older or restored CPEs.
	return template.Snapshots.InitialEnabled && !now.Before(device.CreatedAt.Add(time.Duration(template.Snapshots.InitialDelayMinutes)*time.Minute))
}

func hasInitialSnapshot(ctx context.Context, tx *gorm.DB, deviceID int64) (bool, error) {
	var initial []models.DeviceSnapshot
	err := tx.WithContext(ctx).Select("id").Where("device_id = ? AND kind = ?", deviceID, "initial").Limit(1).Find(&initial).Error
	return len(initial) > 0, err
}

func ScheduledSnapshotDue(now, createdAt time.Time, last *time.Time, minutes int) bool {
	if minutes < 1 || minutes > 525600 {
		return false
	}
	anchor := createdAt
	if last != nil {
		anchor = *last
	}
	return !now.Before(anchor.Add(time.Duration(minutes) * time.Minute))
}

func lastScheduledSnapshot(ctx context.Context, tx *gorm.DB, deviceID int64) (*time.Time, error) {
	var snapshots []models.DeviceSnapshot
	if err := tx.WithContext(ctx).Select("created_at").Where("device_id = ? AND kind = ?", deviceID, "scheduled").Order("created_at DESC, id DESC").Limit(1).Find(&snapshots).Error; err != nil {
		return nil, err
	}
	if len(snapshots) == 0 {
		return nil, nil
	}
	return &snapshots[0].CreatedAt, nil
}

func snapshotDeviceIdentity(device models.Device) (string, string) {
	m, p := "", ""
	if device.Manufacturer != nil {
		m = *device.Manufacturer
	}
	if device.ProductClass != nil {
		p = *device.ProductClass
	}
	return m, p
}

// Called in the same transaction as the system-task completion marker.
func completeAutomaticSnapshot(ctx context.Context, tx *gorm.DB, task models.SystemTask, now time.Time) error {
	if task.SnapshotKind == "" {
		return nil
	}
	if (task.SnapshotKind != "initial" && task.SnapshotKind != "scheduled" && task.SnapshotKind != "manual") || !task.RefreshParameters || task.CWMPTaskID == nil || (task.SnapshotKind != "manual" && (task.SnapshotSlot == nil || task.SnapshotTemplateID == nil)) {
		return errors.New("invalid snapshot task")
	}
	var cwmpTask models.Task
	if err := tx.Select("id", "device_id", "status", "error_message").First(&cwmpTask, *task.CWMPTaskID).Error; err != nil {
		return err
	}
	if cwmpTask.Status != models.TaskStatusCompleted || cwmpTask.DeviceID != task.DeviceID || strings.TrimSpace(cwmpTask.ErrorMessage) != "" {
		return errors.New("snapshot requires a completed CPE refresh")
	}
	var device models.Device
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&device, task.DeviceID).Error; err != nil {
		return err
	}
	if !device.Online {
		return ErrSnapshotDeviceOffline
	}
	if task.SnapshotKind == "manual" {
		if task.DispatchedAt == nil {
			return errors.New("manual snapshot requires a successful summon")
		}
		parameters, err := NewParameterRepository(tx).GetByDeviceID(ctx, device.ID)
		if err != nil {
			return err
		}
		name := task.SnapshotName
		if name == "" {
			name = "Snapshot " + now.UTC().Format(time.RFC3339)
		}
		snapshot, err := BuildDeviceSnapshot(&device, parameters, name, "manual", task.CreatedBy)
		if err != nil {
			return err
		}
		return tx.Create(snapshot).Error
	}
	m, p := snapshotDeviceIdentity(device)
	template, err := NewProvisioningRepository(tx).ResolveTemplateForDevice(ctx, m, p)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if template.ID != *task.SnapshotTemplateID {
		return nil
	}
	column := "snapshot_scheduled_at"
	stamp := now
	kind := task.SnapshotKind
	updates := map[string]interface{}{}
	if task.SnapshotKind == "initial" {
		if !InitialSnapshotDue(device, *template, now) {
			return nil
		}
		exists, err := hasInitialSnapshot(ctx, tx, device.ID)
		if err != nil {
			return err
		}
		if exists {
			return nil
		}
		column, stamp = "snapshot_initial_at", now
	} else {
		if !template.Snapshots.ScheduledEnabled {
			return nil
		}
		last, err := lastScheduledSnapshot(ctx, tx, device.ID)
		if err != nil {
			return err
		}
		if !ScheduledSnapshotDue(now, device.CreatedAt, last, template.Snapshots.ScheduledIntervalMinutes) {
			return nil
		}
	}
	parameters, err := NewParameterRepository(tx).GetByDeviceID(ctx, device.ID)
	if err != nil {
		return err
	}
	snapshot, err := BuildDeviceSnapshot(&device, parameters, fmt.Sprintf("%s snapshot %s", kind, stamp.UTC().Format(time.RFC3339)), kind, "snapshot scheduler")
	if err != nil {
		return err
	}
	snapshot.ScheduledFor = task.SnapshotSlot
	if err := tx.Create(snapshot).Error; err != nil {
		return err
	}
	updates[column] = stamp
	return tx.Model(&device).UpdateColumns(updates).Error
}
