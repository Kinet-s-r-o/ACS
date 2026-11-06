package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestManualSnapshotQueuesSummonWithoutReadingCachedValues(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
		device, ok := tx.Statement.Dest.(*models.Device)
		if !ok {
			t.Fatalf("snapshot request read cached data: %T", tx.Statement.Dest)
		}
		*device = models.Device{ID: 1, SerialNumber: "test-ONT", Online: true}
		tx.RowsAffected = 1
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
		tasks, ok := tx.Statement.Dest.(*[]models.SystemTask)
		if !ok || len(*tasks) != 1 {
			t.Fatalf("request created something other than one queued task: %T", tx.Statement.Dest)
		}
		(*tasks)[0].ID = 42
		tx.RowsAffected = 1
	}); err != nil {
		t.Fatal(err)
	}
	r := &Router{db: db, deviceRepo: database.NewDeviceRepository(db), systemTaskRepo: database.NewSystemTaskRepository(db)}
	req := httptest.NewRequest(http.MethodPost, "/device/test-ONT/snapshots", strings.NewReader(`{"name":"Before maintenance"}`))
	req.SetPathValue("serial", "test-ONT")
	w := httptest.NewRecorder()
	r.handleCreateSnapshotBySerial(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected accepted: %d %s", w.Code, w.Body.String())
	}
	var task models.SystemTask
	if err := json.Unmarshal(w.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if task.ID != 42 || task.Type != models.SystemTaskTypeBulkSummon || task.Status != models.SystemTaskStatusPending || !task.RefreshParameters || task.SnapshotKind != "manual" || task.SnapshotName != "Before maintenance" {
		t.Fatalf("incorrect queued request: %+v", task)
	}
}

func TestCPEWriterCanTrackOnlyOwnManualSnapshotRequest(t *testing.T) {
	for _, tc := range []struct {
		owner, kind string
		want        int
	}{{"operator", "manual", 200}, {"other", "manual", 403}, {"operator", "scheduled", 403}, {"operator", "", 403}} {
		db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
			*tx.Statement.Dest.(*models.SystemTask) = models.SystemTask{ID: 42, Type: models.SystemTaskTypeBulkSummon, CreatedBy: tc.owner, SnapshotKind: tc.kind}
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		req := scopedRequest(http.MethodGet, "/system-tasks/42", []string{models.PermissionKey("cpe", "read"), models.PermissionKey("cpe", "write")}, "")
		req.SetPathValue("id", "42")
		ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.Claims{Username: "operator", Role: models.RoleRead})
		req = req.WithContext(auth.WithOperation(ctx, "cpe", "read"))
		w := httptest.NewRecorder()
		(&Router{db: db}).handleGetSystemTask(w, req)
		if w.Code != tc.want {
			t.Fatalf("owner=%s kind=%s: got %d want %d", tc.owner, tc.kind, w.Code, tc.want)
		}
	}
}

func TestOfflineManualSnapshotCreatesNoQueueTask(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
		*tx.Statement.Dest.(*models.Device) = models.Device{ID: 1, Online: false}
		tx.RowsAffected = 1
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) { t.Fatal("offline request created a queue task or snapshot") }); err != nil {
		t.Fatal(err)
	}
	r := &Router{db: db, deviceRepo: database.NewDeviceRepository(db), systemTaskRepo: database.NewSystemTaskRepository(db)}
	req := httptest.NewRequest(http.MethodPost, "/device/test-ONT/snapshots", strings.NewReader(`{"name":"Offline test"}`))
	req.SetPathValue("serial", "test-ONT")
	w := httptest.NewRecorder()
	r.handleCreateSnapshotBySerial(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("offline request got %d", w.Code)
	}
}
