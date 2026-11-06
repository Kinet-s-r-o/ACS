package database

import (
	"context"
	"errors"
	"fmt"
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
		manufacturer, productClass := snapshotDeviceIdentity(device)
		template, err := NewProvisioningRepository(tx).ResolveTemplateForDevice(ctx, manufacturer, productClass)
		if err != nil {
			return err
		}
		if template.ID != templateID {
			return nil
		}
		if kind == "initial" {
			if !InitialSnapshotDue(device, *template, now) {
				return nil
			}
		} else if kind == "scheduled" {
			if !template.Snapshots.ScheduledEnabled {
				return nil
			}
			var anchor models.DeviceParameter
			err := tx.Select("value").Where("device_id = ? AND name = ?", deviceID, "InternetGatewayDevice.ManagementServer.PeriodicInformTime").Take(&anchor).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			var due bool
			slot, due = ScheduledSnapshotSlot(now, device.CreatedAt, anchor.Value, template.Snapshots.ScheduledIntervalMinutes)
			if !due || (device.SnapshotScheduledAt != nil && !slot.After(*device.SnapshotScheduledAt)) {
				return nil
			}
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
	return template.Snapshots.InitialEnabled && template.SnapshotInitialSince != nil && device.SnapshotInitialAt == nil && !device.CreatedAt.Before(*template.SnapshotInitialSince) && !now.Before(device.CreatedAt.Add(time.Duration(template.Snapshots.InitialDelayMinutes)*time.Minute))
}

func ScheduledSnapshotSlot(now, createdAt time.Time, anchorValue string, minutes int) (time.Time, bool) {
	if minutes < 1 || minutes > 525600 {
		return time.Time{}, false
	}
	anchor, err := time.Parse(time.RFC3339Nano, anchorValue)
	if err != nil || anchor.Year() < 1970 || anchor.After(now) {
		return time.Time{}, false
	}
	interval := time.Duration(minutes) * time.Minute
	slot := anchor.Add(now.Sub(anchor) / interval * interval)
	return slot, !slot.Before(createdAt)
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
	if err := tx.Select("id", "device_id", "status").First(&cwmpTask, *task.CWMPTaskID).Error; err != nil {
		return err
	}
	if cwmpTask.Status != models.TaskStatusCompleted || cwmpTask.DeviceID != task.DeviceID {
		return errors.New("snapshot requires a completed CPE refresh")
	}
	var device models.Device
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&device, task.DeviceID).Error; err != nil {
		return err
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
	stamp := *task.SnapshotSlot
	kind := task.SnapshotKind
	updates := map[string]interface{}{}
	if task.SnapshotKind == "initial" {
		if !InitialSnapshotDue(device, *template, now) {
			return nil
		}
		column, stamp = "snapshot_initial_at", now
	} else if !template.Snapshots.ScheduledEnabled || (device.SnapshotScheduledAt != nil && !stamp.After(*device.SnapshotScheduledAt)) {
		return nil
	} else {
		var initial []models.DeviceSnapshot
		if err := tx.Select("id").Where("device_id = ? AND kind = ?", device.ID, "initial").Limit(1).Find(&initial).Error; err != nil {
			return err
		}
		if len(initial) == 0 {
			kind = "initial"
			updates["snapshot_initial_at"] = now
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
