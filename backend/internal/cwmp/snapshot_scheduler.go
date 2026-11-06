package cwmp

import (
	"context"
	"log"
	"time"

	"github.com/matrix8412/acs/internal/cwmpcontrol"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

type SnapshotScheduler struct {
	db            *gorm.DB
	communication *cwmpcontrol.Controller
}

func NewSnapshotScheduler(db *gorm.DB, controls ...*cwmpcontrol.Controller) *SnapshotScheduler {
	return &SnapshotScheduler{db: db, communication: communicationControl(controls)}
}

func (s *SnapshotScheduler) Start(ctx context.Context) {
	initial := time.NewTicker(15 * time.Minute)
	scheduled := time.NewTicker(5 * time.Minute)
	defer initial.Stop()
	defer scheduled.Stop()
	s.check(ctx, true, true)
	for {
		select {
		case <-ctx.Done():
			return
		case <-initial.C:
			s.check(ctx, true, false)
		case <-scheduled.C:
			s.check(ctx, false, true)
		}
	}
}

func (s *SnapshotScheduler) check(ctx context.Context, initial, scheduled bool) {
	if !s.communication.Enabled() {
		return
	}
	if err := s.scan(ctx, initial, scheduled, time.Now()); err != nil && ctx.Err() == nil {
		log.Printf("Automatic snapshot check failed: %v", err)
	}
}

func (s *SnapshotScheduler) scan(ctx context.Context, initial, scheduled bool, now time.Time) error {
	templates, err := database.NewProvisioningRepository(s.db).ListTemplates(ctx)
	if err != nil {
		return err
	}
	enabled := false
	for _, template := range templates {
		if (initial && template.Snapshots.InitialEnabled) || (scheduled && template.Snapshots.ScheduledEnabled) {
			enabled = true
			break
		}
	}
	if !enabled {
		return nil
	}
	var after int64
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !s.communication.Enabled() {
			return nil
		}
		var devices []models.Device
		if err := s.db.WithContext(ctx).Select("id", "manufacturer", "product_class", "created_at", "snapshot_initial_at", "snapshot_scheduled_at").Where("id > ?", after).Order("id").Limit(200).Find(&devices).Error; err != nil {
			return err
		}
		if len(devices) == 0 {
			return nil
		}
		anchors := map[int64]string{}
		if scheduled {
			ids := []int64{}
			for _, device := range devices {
				ids = append(ids, device.ID)
			}
			var parameters []models.DeviceParameter
			if err := s.db.WithContext(ctx).Select("device_id", "value").Where("device_id IN ? AND name = ?", ids, "InternetGatewayDevice.ManagementServer.PeriodicInformTime").Find(&parameters).Error; err != nil {
				return err
			}
			for _, parameter := range parameters {
				anchors[parameter.DeviceID] = parameter.Value
			}
		}
		for _, device := range devices {
			if !s.communication.Enabled() {
				return nil
			}
			m, p := "", ""
			if device.Manufacturer != nil {
				m = *device.Manufacturer
			}
			if device.ProductClass != nil {
				p = *device.ProductClass
			}
			template := database.SelectProvisioningTemplate(templates, m, p)
			if template == nil {
				continue
			}
			kind, slot := "", now
			if initial && database.InitialSnapshotDue(device, *template, now) {
				kind = "initial"
			} else if scheduled && template.Snapshots.ScheduledEnabled {
				var due bool
				slot, due = database.ScheduledSnapshotSlot(now, device.CreatedAt, anchors[device.ID], template.Snapshots.ScheduledIntervalMinutes)
				if due && (device.SnapshotScheduledAt == nil || slot.After(*device.SnapshotScheduledAt)) {
					kind = "scheduled"
				}
			}
			if kind != "" {
				if err := database.NewSnapshotRepository(s.db).QueueAutomatic(ctx, device.ID, template.ID, kind, slot, now); err != nil {
					if ctx.Err() != nil {
						return ctx.Err()
					}
					log.Printf("Could not queue automatic snapshot for device %d: %v", device.ID, err)
				}
			}
		}
		after = devices[len(devices)-1].ID
	}
}
