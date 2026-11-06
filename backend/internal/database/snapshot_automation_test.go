package database

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestAutomaticSnapshotDueTimes(t *testing.T) {
	start := time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC)
	template := models.ProvisioningTemplate{SnapshotInitialSince: &start, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: true, InitialDelayMinutes: 10}}
	device := models.Device{CreatedAt: start.Add(time.Minute)}
	if InitialSnapshotDue(device, template, start.Add(10*time.Minute)) {
		t.Fatal("initial snapshot ran before delay")
	}
	if !InitialSnapshotDue(device, template, start.Add(11*time.Minute)) {
		t.Fatal("initial snapshot not due at delay")
	}
	device.SnapshotInitialAt = &start
	if InitialSnapshotDue(device, template, start.Add(time.Hour)) {
		t.Fatal("initial snapshot repeated")
	}
	device.SnapshotInitialAt = nil
	device.CreatedAt = start.Add(-time.Minute)
	if InitialSnapshotDue(device, template, start.Add(time.Hour)) {
		t.Fatal("initial snapshots backfilled pre-existing ONTs")
	}
	for _, tc := range []struct {
		value   string
		minutes int
		want    time.Time
		valid   bool
	}{
		{"2026-11-06T10:02:00Z", 15, start.Add(32 * time.Minute), true},
		{"2026-11-06T11:02:00+01:00", 15, start.Add(32 * time.Minute), true},
		{"2026-11-06T10:02:30Z", 15, start.Add(32*time.Minute + 30*time.Second), true},
		{"", 15, time.Time{}, false}, {"bad", 15, time.Time{}, false},
		{"0001-01-01T00:00:00Z", 15, time.Time{}, false},
		{"2026-11-07T10:02:00Z", 15, time.Time{}, false},
		{"2026-11-06T10:02:00Z", 0, time.Time{}, false},
	} {
		slot, valid := ScheduledSnapshotSlot(start.Add(34*time.Minute), start, tc.value, tc.minutes)
		if valid != tc.valid || (valid && !slot.Equal(tc.want)) {
			t.Fatalf("wrong schedule for %s / %d: %s %v", tc.value, tc.minutes, slot, valid)
		}
	}
	if _, ok := ScheduledSnapshotSlot(start.Add(34*time.Minute), start.Add(33*time.Minute), "2026-11-06T10:02:00Z", 15); ok {
		t.Fatal("scheduled slot predates device creation")
	}
}

func TestAutomaticSnapshotWaitsForRefreshAndIsIdempotent(t *testing.T) {
	now := time.Now().UTC()
	activation := now.Add(-time.Hour)
	created := now.Add(-30 * time.Minute)
	jobID, templateID := int64(10), int64(20)
	job := models.SystemTask{DeviceID: 1, SnapshotKind: "initial", SnapshotSlot: &now, SnapshotTemplateID: &templateID, RefreshParameters: true, CWMPTaskID: &jobID}
	for _, status := range []models.TaskStatus{models.TaskStatusPending, models.TaskStatusSent, models.TaskStatusFailed, models.TaskStatusCompleted} {
		t.Run(string(status), func(t *testing.T) {
			db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			writable := true
			var marker *time.Time
			createdCount := 0
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *models.Task:
					*dest = models.Task{ID: jobID, DeviceID: 1, Status: status}
				case *models.Device:
					*dest = models.Device{ID: 1, CreatedAt: created, SnapshotInitialAt: marker}
				case *models.ProvisioningTemplate:
					*dest = models.ProvisioningTemplate{ID: templateID, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: true}}
				case *[]models.DeviceParameter:
					*dest = []models.DeviceParameter{{Name: "Device.Test.Enabled", Value: "true", Writable: &writable}}
				default:
					t.Fatalf("unexpected read %T", dest)
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
				snapshot := tx.Statement.Dest.(*models.DeviceSnapshot)
				if snapshot.Kind != "initial" || snapshot.ScheduledFor == nil || snapshot.ParameterCount != 1 {
					t.Fatal("invalid automatic snapshot")
				}
				createdCount++
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) { marker = &now; tx.RowsAffected = 1 }); err != nil {
				t.Fatal(err)
			}
			err = completeAutomaticSnapshot(context.Background(), db, job, now)
			if status != models.TaskStatusCompleted {
				if err == nil || createdCount != 0 {
					t.Fatal("snapshot saved before successful refresh")
				}
				return
			}
			if err != nil || createdCount != 1 {
				t.Fatalf("missing snapshot: %v", err)
			}
			if err := completeAutomaticSnapshot(context.Background(), db, job, now); err != nil || createdCount != 1 {
				t.Fatalf("completion created a duplicate: %v", err)
			}
		})
	}
}

func TestSnapshotBuilderEncryptsOnlyWritableValues(t *testing.T) {
	if err := ConfigureParameterEncryption(strings.Repeat("snapshot-test-key-", 2)); err != nil {
		t.Fatal(err)
	}
	yes, no := true, false
	parameters := []models.DeviceParameter{{Name: "Device.Test.Password", Value: "synthetic-test-value", Writable: &yes}, {Name: "Device.Test.ReadOnly", Value: "skip", Writable: &no}, {Name: "Device.Test.Unknown", Value: "skip"}}
	snapshot, err := BuildDeviceSnapshot(&models.Device{ID: 1}, parameters, "Initial", "initial", "snapshot scheduler")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ParameterCount != 1 || strings.Contains(string(snapshot.Parameters), "synthetic-test-value") {
		t.Fatal("snapshot stored plaintext or non-writable values")
	}
	var values []models.SnapshotParameter
	if err := json.Unmarshal(snapshot.Parameters, &values); err != nil {
		t.Fatal(err)
	}
	value, err := DecryptValue(values[0].Value)
	if err != nil || value != "synthetic-test-value" {
		t.Fatal("snapshot cannot restore the encrypted value")
	}
}

func TestSnapshotRetentionProtectsInitial(t *testing.T) {
	for _, rule := range retentionRules {
		if rule.table == "device_snapshots" {
			if !strings.Contains(rule.predicate, "kind <> 'initial'") {
				t.Fatal("retention can delete initial snapshots")
			}
			return
		}
	}
	t.Fatal("missing snapshot retention rule")
}

func TestManualSnapshotRequiresSuccessfulSummonAndRefresh(t *testing.T) {
	for _, tc := range []struct {
		status   models.TaskStatus
		summoned bool
		allowed  bool
	}{
		{models.TaskStatusPending, true, false}, {models.TaskStatusSent, true, false}, {models.TaskStatusFailed, true, false}, {models.TaskStatusCompleted, false, false}, {models.TaskStatusCompleted, true, true},
	} {
		db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		cwmpID := int64(2)
		writable := true
		job := models.SystemTask{DeviceID: 1, SnapshotKind: "manual", SnapshotName: "Before maintenance", CreatedBy: "test-operator", RefreshParameters: true, CWMPTaskID: &cwmpID}
		if tc.summoned {
			job.DispatchedAt = &now
		}
		created := false
		if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
			switch dest := tx.Statement.Dest.(type) {
			case *models.Task:
				*dest = models.Task{ID: cwmpID, DeviceID: 1, Status: tc.status}
			case *models.Device:
				*dest = models.Device{ID: 1}
			case *[]models.DeviceParameter:
				*dest = []models.DeviceParameter{{Name: "Device.Test.Enable", Value: "true", Writable: &writable}}
			default:
				t.Fatalf("manual snapshot must not depend on a template: %T", dest)
			}
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
			snapshot := tx.Statement.Dest.(*models.DeviceSnapshot)
			if snapshot.Name != job.SnapshotName || snapshot.Kind != "manual" || snapshot.CreatedBy != job.CreatedBy || snapshot.ParameterCount != 1 {
				t.Fatal("manual snapshot lost its metadata")
			}
			created = true
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		err = completeAutomaticSnapshot(context.Background(), db, job, now)
		if created != tc.allowed || (err == nil) != tc.allowed {
			t.Fatalf("incorrect summon/refresh gate: %+v created=%v error=%v", tc, created, err)
		}
	}
}

func TestScheduledSnapshotProvidesMissingInitialForAnyONT(t *testing.T) {
	for _, tc := range []struct {
		name              string
		exists, oldMarker bool
	}{
		{"old-ONT", false, false}, {"deleted-initial", false, true}, {"existing-initial", true, true}, {"existing-without-marker", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			old := now.Add(-365 * 24 * time.Hour)
			activation := now.Add(-time.Hour)
			templateID, cwmpID := int64(2), int64(3)
			job := models.SystemTask{DeviceID: 1, SnapshotKind: "scheduled", SnapshotSlot: &now, SnapshotTemplateID: &templateID, CWMPTaskID: &cwmpID, RefreshParameters: true}
			device := models.Device{ID: 1, CreatedAt: old}
			if tc.oldMarker {
				device.SnapshotInitialAt = &old
			}
			hasInitial := tc.exists
			db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			writable := true
			kinds := []string{}
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *models.Task:
					*dest = models.Task{ID: cwmpID, DeviceID: 1, Status: models.TaskStatusCompleted}
				case *models.Device:
					*dest = device
				case *models.ProvisioningTemplate:
					*dest = models.ProvisioningTemplate{ID: templateID, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: false, ScheduledEnabled: true}}
				case *[]models.DeviceSnapshot:
					if hasInitial {
						*dest = []models.DeviceSnapshot{{ID: 1, Kind: "initial"}}
					}
				case *[]models.DeviceParameter:
					*dest = []models.DeviceParameter{{Name: "Device.Test.Enable", Value: "true", Writable: &writable}}
				default:
					t.Fatalf("unexpected read %T", dest)
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
				snapshot := tx.Statement.Dest.(*models.DeviceSnapshot)
				kinds = append(kinds, snapshot.Kind)
				if snapshot.Kind == "initial" {
					hasInitial = true
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) {
				changes := tx.Statement.Dest.(map[string]interface{})
				if stamp, ok := changes["snapshot_initial_at"].(time.Time); ok {
					device.SnapshotInitialAt = &stamp
				}
				if stamp, ok := changes["snapshot_scheduled_at"].(time.Time); ok {
					device.SnapshotScheduledAt = &stamp
				}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := completeAutomaticSnapshot(context.Background(), db, job, now); err != nil {
				t.Fatal(err)
			}
			want := "initial"
			if tc.exists {
				want = "scheduled"
			}
			if len(kinds) != 1 || kinds[0] != want || device.SnapshotScheduledAt == nil {
				t.Fatalf("incorrect scheduled result: %v", kinds)
			}
			if !tc.exists && (device.SnapshotInitialAt == nil || !device.SnapshotInitialAt.Equal(now)) {
				t.Fatal("missing initial marker update")
			}
			if err := completeAutomaticSnapshot(context.Background(), db, job, now); err != nil || len(kinds) != 1 {
				t.Fatalf("duplicate slot: %v", err)
			}
			next := now.Add(time.Hour)
			job.SnapshotSlot = &next
			if err := completeAutomaticSnapshot(context.Background(), db, job, next); err != nil || len(kinds) != 2 || kinds[1] != "scheduled" {
				t.Fatalf("next snapshot did not remain scheduled: %v %v", kinds, err)
			}
		})
	}
}

func TestAutomaticSnapshotQueueDeduplicatesAndReusesFailedJobs(t *testing.T) {
	now := time.Now().UTC()
	activation := now.Add(-time.Hour)
	for _, reuse := range []bool{false, true} {
		db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
		if err != nil {
			t.Fatal(err)
		}
		active, created, updated := int64(0), 0, 0
		if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
			switch dest := tx.Statement.Dest.(type) {
			case *models.Device:
				if _, locked := tx.Statement.Clauses["FOR"]; !locked {
					t.Fatal("queue must lock the device row")
				}
				*dest = models.Device{ID: 1, CreatedAt: activation.Add(time.Minute)}
			case *models.ProvisioningTemplate:
				*dest = models.ProvisioningTemplate{ID: 2, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: true}}
			case *int64:
				*dest = active
			case *models.SystemTask:
				if reuse {
					*dest = models.SystemTask{ID: 3, Status: models.SystemTaskStatusFailed}
				} else {
					tx.AddError(gorm.ErrRecordNotFound)
					return
				}
			default:
				t.Fatalf("unexpected queue read: %T", dest)
			}
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
			job := tx.Statement.Dest.(*models.SystemTask)
			if !job.RefreshParameters || job.SnapshotKind != "initial" || job.SnapshotTemplateID == nil || *job.SnapshotTemplateID != 2 {
				t.Fatal("queue lost refresh/ownership metadata")
			}
			created++
			active = 1
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) {
			changes := tx.Statement.Dest.(map[string]interface{})
			if changes["status"] != models.SystemTaskStatusPending || changes["cwmp_task_id"] != nil {
				t.Fatal("retry did not reset the failed refresh")
			}
			updated++
			active = 1
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 2; i++ {
			if err := NewSnapshotRepository(db).QueueAutomatic(context.Background(), 1, 2, "initial", now, now); err != nil {
				t.Fatal(err)
			}
		}
		if created+updated != 1 || (reuse && created != 0) || (!reuse && updated != 0) {
			t.Fatalf("duplicate/retry error: reuse=%v created=%d updated=%d", reuse, created, updated)
		}
	}
}
