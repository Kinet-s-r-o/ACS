package database

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type snapshotTestConnection struct{ gorm.ConnPool }
type snapshotTestTransaction struct{ gorm.ConnPool }

func (snapshotTestConnection) BeginTx(context.Context, *sql.TxOptions) (gorm.ConnPool, error) {
	return &snapshotTestTransaction{}, nil
}
func (snapshotTestTransaction) Commit() error   { return nil }
func (snapshotTestTransaction) Rollback() error { return nil }

func TestSnapshotDeleteEnforcesInitialLock(t *testing.T) {
	for _, tc := range []struct {
		kind          string
		full, allowed bool
	}{{"manual", false, true}, {"scheduled", false, true}, {"initial", false, false}, {"initial", true, true}} {
		t.Run(tc.kind+map[bool]string{true: "/full", false: "/write"}[tc.full], func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			deleted := false
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				*tx.Statement.Dest.(*models.DeviceSnapshot) = models.DeviceSnapshot{ID: 1, Kind: tc.kind}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Delete().Replace("gorm:delete", func(tx *gorm.DB) { deleted = true; tx.RowsAffected = 1 }); err != nil {
				t.Fatal(err)
			}
			err = NewSnapshotRepository(db).Delete(context.Background(), 1, 1, tc.full)
			if deleted != tc.allowed || (!tc.allowed && !errors.Is(err, ErrInitialSnapshotLocked)) || (tc.allowed && err != nil) {
				t.Fatalf("incorrect deletion permission: deleted=%v error=%v", deleted, err)
			}
		})
	}
}
