package database

import (
	"context"
	"errors"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// RunDataMigrationOnce records completion only after the migration succeeds.
// Failed or interrupted migrations are retried safely on the next startup.
func RunDataMigrationOnce(ctx context.Context, db *gorm.DB, name string, migrate func() (int64, error)) (int64, bool, error) {
	var record models.DataMigrationRecord
	err := db.WithContext(ctx).First(&record, "name = ?", name).Error
	if err == nil {
		return 0, false, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, false, err
	}
	changed, err := migrate()
	if err != nil {
		return changed, false, err
	}
	record = models.DataMigrationRecord{Name: name, CompletedAt: time.Now().UTC()}
	if err := db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&record).Error; err != nil {
		return changed, false, err
	}
	return changed, true, nil
}
