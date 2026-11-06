package cwmp

import (
	"context"
	"testing"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestSnapshotWorkerSkipsOfflineDeviceBeforeCreatingCWMPTask(t *testing.T) {
	for _, kind := range []string{"initial", "scheduled", "manual"} {
		db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=unused dbname=unused sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
		if err != nil {
			t.Fatal(err)
		}
		url := "http://127.0.0.1:1/should-not-be-contacted"
		if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
			device, ok := tx.Statement.Dest.(*models.Device)
			if !ok {
				t.Fatalf("offline dispatch read unexpected data: %T", tx.Statement.Dest)
			}
			*device = models.Device{ID: 1, Online: false, ConnectionRequestURL: &url}
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) { t.Fatal("offline dispatch created a CWMP task") }); err != nil {
			t.Fatal(err)
		}
		failed := false
		if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) {
			changes := tx.Statement.Dest.(map[string]interface{})
			if changes["status"] != models.SystemTaskStatusFailed {
				t.Fatal("offline task did not fail")
			}
			failed = true
			tx.RowsAffected = 1
		}); err != nil {
			t.Fatal(err)
		}
		NewSystemTaskWorker(db).process(context.Background(), &models.SystemTask{ID: 2, DeviceID: 1, Type: models.SystemTaskTypeBulkSummon, SnapshotKind: kind, RefreshParameters: true})
		if !failed {
			t.Fatal("offline snapshot was not stopped")
		}
	}
}
