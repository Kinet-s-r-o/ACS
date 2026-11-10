package cwmp

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type snapshotInformConnection struct{ gorm.ConnPool }
type snapshotInformTransaction struct{ gorm.ConnPool }

func (snapshotInformConnection) BeginTx(context.Context, *sql.TxOptions) (gorm.ConnPool, error) {
	return &snapshotInformTransaction{}, nil
}
func (snapshotInformTransaction) Commit() error   { return nil }
func (snapshotInformTransaction) Rollback() error { return nil }

func TestEveryInformChecksInitialSnapshotAndDeduplicatesSummon(t *testing.T) {
	testInformSnapshotQueue(t, "initial")
}

func TestEveryInformChecksScheduledSnapshotAndDeduplicatesSummon(t *testing.T) {
	testInformSnapshotQueue(t, "scheduled")
}

func testInformSnapshotQueue(t *testing.T, kind string) {
	t.Helper()
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotInformConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	exists, queued, checks := false, 0, 0
	if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
		switch dest := tx.Statement.Dest.(type) {
		case *models.Device:
			*dest = models.Device{ID: 1, SerialNumber: "TEST-INITIAL", Online: true, CreatedAt: now.Add(-24 * time.Hour), LastInform: &now, SnapshotInitialAt: &now, SnapshotScheduledAt: &now}
		case *models.ProvisioningTemplate:
			*dest = models.ProvisioningTemplate{ID: 2, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: kind == "initial", InitialDelayMinutes: 60, ScheduledEnabled: kind == "scheduled", ScheduledIntervalMinutes: 60}}
		case *[]*models.ProvisioningRule:
			*dest = nil
		case *[]models.DeviceSnapshot:
			checks++
			if exists {
				*dest = []models.DeviceSnapshot{{ID: 10, Kind: kind, CreatedAt: now}}
			}
		case *int64:
			*dest = int64(queued)
		case *models.SystemTask:
			tx.AddError(gorm.ErrRecordNotFound)
			return
		default:
			t.Fatalf("unexpected Inform read: %T", dest)
		}
		tx.RowsAffected = 1
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
		switch dest := tx.Statement.Dest.(type) {
		case *models.Device:
			dest.ID = 1
		case *models.SystemTask:
			if dest.SnapshotKind != kind || !dest.RefreshParameters {
				t.Fatal("Inform did not request a full snapshot refresh")
			}
			queued++
		default:
			t.Fatalf("unexpected Inform write: %T", dest)
		}
		tx.RowsAffected = 1
	}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(nil)
	h.deviceRepo = database.NewDeviceRepository(db)
	h.provisioningRepo = database.NewProvisioningRepository(db)
	h.snapshotRepo = database.NewSnapshotRepository(db)
	inform := &SOAPEnvelope{Body: SOAPBody{Inform: &Inform{DeviceId: DeviceId{SerialNumber: "TEST-INITIAL"}}}}
	for i := 0; i < 3; i++ {
		if i == 2 {
			exists = true
		}
		if _, err := h.handleInform(context.Background(), inform, "initial-inform"); err != nil {
			t.Fatal(err)
		}
	}
	if checks != 3 || queued != 1 {
		t.Fatalf("Inform checks=%d queued Summons=%d; want 3 checks and one job", checks, queued)
	}
}
