package database

import (
	"context"
	"encoding/json"
	"errors"
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
	if !InitialSnapshotDue(device, template, start.Add(time.Hour)) {
		t.Fatal("stale completion marker prevented checking actual snapshot existence")
	}
	device.SnapshotInitialAt = nil
	device.CreatedAt = start.Add(-time.Minute)
	if !InitialSnapshotDue(device, template, start.Add(time.Hour)) {
		t.Fatal("older ONT was excluded from Inform snapshot eligibility")
	}
}

func TestScheduledSnapshotDueUsesLastSuccessfulSnapshot(t *testing.T) {
	start := time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name    string
		last    *time.Time
		now     time.Time
		minutes int
		want    bool
	}{
		{"first before delay", nil, start.Add(14 * time.Minute), 15, false},
		{"first at delay", nil, start.Add(15 * time.Minute), 15, true},
		{"last before delay", &start, start.Add(15*time.Minute - time.Nanosecond), 15, false},
		{"last at delay", &start, start.Add(15 * time.Minute), 15, true},
		{"late Inform", &start, start.Add(48 * time.Hour), 15, true},
		{"future snapshot", &start, start.Add(-time.Minute), 15, false},
		{"zero interval", &start, start.Add(time.Hour), 0, false},
	} {
		if got := ScheduledSnapshotDue(tc.now, start, tc.last, tc.minutes); got != tc.want {
			t.Errorf("%s: due=%v want=%v", tc.name, got, tc.want)
		}
	}
}

func TestOfflineDeviceCreatesNoAutomaticSnapshotTask(t *testing.T) {
	for _, kind := range []string{"initial", "scheduled"} {
		db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
			device, ok := tx.Statement.Dest.(*models.Device)
			if !ok {
				t.Fatalf("offline queue check continued with %T", tx.Statement.Dest)
			}
			*device = models.Device{ID: 1, Online: false}
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) { t.Fatal("offline CPE created a task") }); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) { t.Fatal("offline CPE retried a task or changed due markers") }); err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		if err := NewSnapshotRepository(db).QueueAutomatic(context.Background(), 1, 2, kind, now, now); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOfflineDeviceCannotSaveSnapshotAfterRefresh(t *testing.T) {
	for _, kind := range []string{"initial", "scheduled", "manual"} {
		db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
			switch dest := tx.Statement.Dest.(type) {
			case *models.Task:
				*dest = models.Task{ID: 3, DeviceID: 1, Status: models.TaskStatusCompleted}
			case *models.Device:
				*dest = models.Device{ID: 1, Online: false}
			default:
				t.Fatalf("offline capture continued with %T", dest)
			}
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) { t.Fatal("saved snapshot for offline CPE") }); err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		id := int64(3)
		job := models.SystemTask{DeviceID: 1, SnapshotKind: kind, SnapshotTemplateID: &id, SnapshotSlot: &now, DispatchedAt: &now, CWMPTaskID: &id, RefreshParameters: true}
		if err := completeAutomaticSnapshot(context.Background(), db, job, now); !errors.Is(err, ErrSnapshotDeviceOffline) {
			t.Fatalf("offline snapshot error: %v", err)
		}
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
			hasInitial := false
			createdCount := 0
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *models.Task:
					*dest = models.Task{ID: jobID, DeviceID: 1, Status: status}
				case *models.Device:
					*dest = models.Device{ID: 1, Online: true, CreatedAt: created, SnapshotInitialAt: marker}
				case *models.ProvisioningTemplate:
					*dest = models.ProvisioningTemplate{ID: templateID, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: true}}
				case *[]models.DeviceSnapshot:
					if hasInitial {
						*dest = []models.DeviceSnapshot{{ID: 1, Kind: "initial"}}
					}
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
				hasInitial = true
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
				*dest = models.Device{ID: 1, Online: true}
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

func TestScheduledSnapshotKeepsItsTypeAndInitialState(t *testing.T) {
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
			queuedAt := now.Add(-20 * time.Minute)
			job := models.SystemTask{DeviceID: 1, SnapshotKind: "scheduled", SnapshotSlot: &queuedAt, SnapshotTemplateID: &templateID, CWMPTaskID: &cwmpID, RefreshParameters: true}
			device := models.Device{ID: 1, Online: true, CreatedAt: old}
			if tc.oldMarker {
				device.SnapshotInitialAt = &old
			}
			hasInitial := tc.exists
			var lastScheduled *time.Time
			captureTime := now
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
					*dest = models.ProvisioningTemplate{ID: templateID, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: false, ScheduledEnabled: true, ScheduledIntervalMinutes: 60}}
				case *[]models.DeviceSnapshot:
					if len(tx.Statement.Selects) == 1 && tx.Statement.Selects[0] == "created_at" {
						if lastScheduled != nil {
							*dest = []models.DeviceSnapshot{{Kind: "scheduled", CreatedAt: *lastScheduled}}
						}
					} else if hasInitial {
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
				if snapshot.Kind != "scheduled" {
					t.Fatal("scheduled job changed its snapshot type")
				}
				savedAt := captureTime
				lastScheduled = &savedAt
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) {
				changes := tx.Statement.Dest.(map[string]interface{})
				if _, ok := changes["snapshot_initial_at"]; ok {
					t.Fatal("scheduled snapshot changed the initial completion marker")
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
			if len(kinds) != 1 || kinds[0] != "scheduled" || device.SnapshotScheduledAt == nil || !device.SnapshotScheduledAt.Equal(now) {
				t.Fatalf("incorrect scheduled result: %v", kinds)
			}
			if (device.SnapshotInitialAt != nil) != tc.oldMarker {
				t.Fatal("scheduled snapshot changed initial snapshot state")
			}
			if err := completeAutomaticSnapshot(context.Background(), db, job, now); err != nil || len(kinds) != 1 {
				t.Fatalf("duplicate slot: %v", err)
			}
			next := now.Add(time.Hour)
			job.SnapshotSlot = &next
			captureTime = next
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
				*dest = models.Device{ID: 1, Online: true, CreatedAt: activation.Add(time.Minute)}
			case *models.ProvisioningTemplate:
				*dest = models.ProvisioningTemplate{ID: 2, SnapshotInitialSince: &activation, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: true}}
			case *[]models.DeviceSnapshot:
				*dest = nil
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
