package database

import (
	"context"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/cwmpcontrol"
	"github.com/matrix8412/acs/internal/models"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestCWMPControlLoadsPersistentStateFailClosed(t *testing.T) {
	for _, scenario := range []struct {
		name, value                     string
		missing, wantEnabled, wantError bool
	}{
		{name: "first installation", missing: true, wantEnabled: true},
		{name: "persisted pause", value: `{"enabled":false,"updated_by":"operator","updated_at":"2026-11-04T10:00:00Z"}`},
		{name: "persisted enabled", value: `{"enabled":true}`, wantEnabled: true},
		{name: "corrupt state", value: `{`, wantError: true},
		{name: "missing enabled flag", value: `{}`, wantError: true},
		{name: "invalid timestamp", value: `{"enabled":true,"updated_at":"invalid"}`, wantError: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			err = db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				if scenario.missing {
					tx.AddError(gorm.ErrRecordNotFound)
					return
				}
				*tx.Statement.Dest.(*Setting) = Setting{Key: cwmpControlSetting, Value: scenario.value}
				tx.RowsAffected = 1
			})
			if err != nil {
				t.Fatal(err)
			}
			state, err := NewCWMPControlStore(NewSettingsRepository(db)).Load(context.Background())
			if (err != nil) != scenario.wantError || (!scenario.wantError && state.Enabled != scenario.wantEnabled) {
				t.Fatalf("state=%#v err=%v", state, err)
			}
		})
	}
}

func TestCWMPControlPostgresPersistenceAndTimerResume(t *testing.T) {
	// Reuse the existing isolated-schema PostgreSQL fixture; never use the
	// application's schema or a fallback production DATABASE_URL.
	db := indexTestDB(t)
	if err := db.AutoMigrate(&Setting{}, &models.SystemTask{}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := NewCWMPControlStore(NewSettingsRepository(db))
	initial, err := store.Load(ctx)
	if err != nil || !initial.Enabled {
		t.Fatalf("initial state: %#v %v", initial, err)
	}
	pause := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	if err := store.Save(ctx, cwmpcontrol.State{Enabled: false, UpdatedAt: &pause, UpdatedBy: "operator"}); err != nil {
		t.Fatal(err)
	}
	restarted, err := cwmpcontrol.New(ctx, store)
	if err != nil || restarted.Enabled() {
		t.Fatalf("pause not restored: %v", err)
	}
	started, dispatched := pause.Add(-10*time.Second), pause.Add(-5*time.Second)
	active := models.SystemTask{Type: models.SystemTaskTypeSummonFromCPE, DeviceID: 1, Status: models.SystemTaskStatusWaiting, StartedAt: &started, DispatchedAt: &dispatched}
	finished := models.SystemTask{Type: models.SystemTaskTypeSummonFromCPE, DeviceID: 1, Status: models.SystemTaskStatusCompleted, StartedAt: &started}
	for _, task := range []*models.SystemTask{&active, &finished} {
		if err := db.Create(task).Error; err != nil {
			t.Fatal(err)
		}
	}
	resume := pause.Add(2 * time.Hour)
	if err := store.Save(ctx, cwmpcontrol.State{Enabled: true, UpdatedAt: &resume, UpdatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&active, active.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !active.StartedAt.Equal(resume.Add(-10*time.Second)) || !active.DispatchedAt.Equal(resume.Add(-5*time.Second)) {
		t.Fatalf("paused time counted against waiting task: %#v", active)
	}
	if err := db.First(&finished, finished.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !finished.StartedAt.Equal(pause.Add(-10 * time.Second)) {
		t.Fatal("completed task timestamps changed")
	}
	state, err := store.Load(ctx)
	if err != nil || !state.Enabled || state.UpdatedBy != "admin" {
		t.Fatalf("resume not persisted: %#v %v", state, err)
	}
}
