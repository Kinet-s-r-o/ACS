package database

import (
	"context"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestInitialSnapshotQueueUsesExistenceAndCreationDelay(t *testing.T) {
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name                                     string
		created                                  time.Time
		exists, staleMarker, disabled, wantQueue bool
	}{
		{name: "before delay", created: now.Add(-59 * time.Minute)},
		{name: "at delay", created: now.Add(-60 * time.Minute), wantQueue: true},
		{name: "older than activation", created: now.Add(-365 * 24 * time.Hour), wantQueue: true},
		{name: "deleted initial with stale marker", created: now.Add(-2 * time.Hour), staleMarker: true, wantQueue: true},
		{name: "existing initial without marker", created: now.Add(-2 * time.Hour), exists: true},
		{name: "disabled", created: now.Add(-2 * time.Hour), disabled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			queued := 0
			activation := now.Add(-time.Hour)
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *models.Device:
					if _, locked := tx.Statement.Clauses["FOR"]; !locked {
						t.Fatal("initial eligibility was not protected by the device lock")
					}
					*dest = models.Device{ID: 1, Online: true, CreatedAt: tc.created}
					if tc.staleMarker {
						dest.SnapshotInitialAt = &activation
					}
				case *models.ProvisioningTemplate:
					*dest = models.ProvisioningTemplate{ID: 2, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: !tc.disabled, InitialDelayMinutes: 60}}
				case *[]models.DeviceSnapshot:
					if tc.exists {
						*dest = []models.DeviceSnapshot{{ID: 3, Kind: "initial"}}
					}
				case *int64:
					*dest = 0
				case *models.SystemTask:
					tx.AddError(gorm.ErrRecordNotFound)
					return
				default:
					t.Fatalf("unexpected eligibility read: %T", dest)
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
				job := tx.Statement.Dest.(*models.SystemTask)
				if job.SnapshotKind != "initial" || !job.RefreshParameters || job.Type != models.SystemTaskTypeBulkSummon {
					t.Fatal("initial check did not queue a Summon with refresh")
				}
				queued++
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := NewSnapshotRepository(db).QueueAutomatic(context.Background(), 1, 2, "initial", now, now); err != nil {
				t.Fatal(err)
			}
			if (queued == 1) != tc.wantQueue {
				t.Fatalf("queued=%d, want queue=%v", queued, tc.wantQueue)
			}
		})
	}
}

func TestScheduledSnapshotQueueUsesLatestSavedScheduledTime(t *testing.T) {
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name      string
		age       time.Duration
		last      *time.Time
		wantQueue bool
	}{
		{name: "first before creation delay", age: 59 * time.Minute},
		{name: "first at creation delay", age: time.Hour, wantQueue: true},
		{name: "last successful still recent", age: 24 * time.Hour, last: timePtr(now.Add(-59 * time.Minute))},
		{name: "last successful at interval", age: 24 * time.Hour, last: timePtr(now.Add(-time.Hour)), wantQueue: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			queued := 0
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *models.Device:
					*dest = models.Device{ID: 1, Online: true, CreatedAt: now.Add(-tc.age), SnapshotScheduledAt: &now}
				case *models.ProvisioningTemplate:
					*dest = models.ProvisioningTemplate{ID: 2, Snapshots: models.TemplateSnapshotSettings{ScheduledEnabled: true, ScheduledIntervalMinutes: 60}}
				case *[]models.DeviceSnapshot:
					if tc.last != nil {
						*dest = []models.DeviceSnapshot{{Kind: "scheduled", CreatedAt: *tc.last}}
					}
				case *int64:
					*dest = 0
				case *models.SystemTask:
					tx.AddError(gorm.ErrRecordNotFound)
					return
				default:
					t.Fatalf("unexpected scheduled check: %T", dest)
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
				job := tx.Statement.Dest.(*models.SystemTask)
				if job.SnapshotKind != "scheduled" || !job.RefreshParameters {
					t.Fatal("scheduled check lost Summon/refresh metadata")
				}
				queued++
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := NewSnapshotRepository(db).QueueAutomatic(context.Background(), 1, 2, "scheduled", now, now); err != nil {
				t.Fatal(err)
			}
			if (queued == 1) != tc.wantQueue {
				t.Fatalf("queued=%d want=%v", queued, tc.wantQueue)
			}
		})
	}
}

func timePtr(value time.Time) *time.Time { return &value }
