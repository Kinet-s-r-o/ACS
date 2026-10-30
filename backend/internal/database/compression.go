package database

import (
	"context"
	"fmt"
	"log"
	"math"
	"strconv"
	"time"

	"gorm.io/gorm"
)

func CompressionDefaults() map[string]string {
	// Preserve the existing two-hour raw-metric compression threshold.
	return map[string]string{"compression_metric_enabled": "true", "compression_metric_after_days": "0.08333333333333333"}
}

func ValidateCompressionSettings(values map[string]string) error {
	if v, ok := values["compression_metric_enabled"]; ok && v != "true" && v != "false" {
		return fmt.Errorf("compression_metric_enabled must be true or false")
	}
	if v, ok := values["compression_metric_after_days"]; ok {
		days, err := strconv.ParseFloat(v, 64)
		if err != nil || math.IsNaN(days) || math.IsInf(days, 0) || days < 1.0/24 || days > 3650 {
			return fmt.Errorf("compression_metric_after_days must be between 1/24 and 3650 days")
		}
	}
	return nil
}

var compressionTables = []struct {
	name, label  string
	minimumDays  float64
	materialized bool
}{
	{"metric_samples", "Raw metric samples", 1.0 / 24, false},
	{"interface_metric_samples", "Interface metric samples", 1.0 / 24, false},
	{"metric_samples_15min", "15-minute aggregates", 8, true},
	{"metric_samples_1h", "Hourly aggregates", 31, true},
	{"metric_samples_1d", "Daily aggregates", 366, true},
	{"interface_metric_samples_15min", "Interface 15-minute aggregates", 8, true},
	{"interface_metric_samples_1h", "Interface hourly aggregates", 31, true},
	{"interface_metric_samples_1d", "Interface daily aggregates", 366, true},
}

type CompressionTableStatus struct {
	Table              string  `json:"table"`
	Label              string  `json:"label"`
	Present            bool    `json:"present"`
	CompressionEnabled bool    `json:"compression_enabled"`
	JobID              int     `json:"-"`
	Scheduled          bool    `json:"scheduled"`
	AfterDays          float64 `json:"after_days"`
	MinimumDays        float64 `json:"minimum_days"`
	CompressedChunks   int64   `json:"compressed_chunks"`
	TotalChunks        int64   `json:"total_chunks"`
}

type OperationalCompressionStatus struct {
	Table               string `json:"table"`
	CompressibleColumns int    `json:"compressible_columns"`
}

type CompressionStatus struct {
	Available   bool                           `json:"available"`
	Reason      string                         `json:"reason,omitempty"`
	Tables      []CompressionTableStatus       `json:"tables"`
	Operational []OperationalCompressionStatus `json:"operational"`
}

func GetCompressionStatus(ctx context.Context, db *gorm.DB) (CompressionStatus, error) {
	status := CompressionStatus{Tables: []CompressionTableStatus{}, Operational: []OperationalCompressionStatus{}}
	db = db.WithContext(ctx)
	if err := db.Raw(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')`).Scan(&status.Available).Error; err != nil {
		return status, err
	}
	for _, table := range []string{"audit_logs", "faults", "tasks", "device_snapshots", "device_logs"} {
		row := OperationalCompressionStatus{Table: table}
		if err := db.Raw(`SELECT COUNT(*) FROM pg_attribute WHERE attrelid = to_regclass(?)
			AND attnum > 0 AND NOT attisdropped AND attstorage IN ('x', 'm')`, table).Scan(&row.CompressibleColumns).Error; err != nil {
			return status, err
		}
		status.Operational = append(status.Operational, row)
	}
	if !status.Available {
		status.Reason = "TimescaleDB is not installed in this database."
		return status, nil
	}
	for _, table := range compressionTables {
		row := CompressionTableStatus{Table: table.name, Label: table.label, MinimumDays: table.minimumDays}
		query := `WITH target AS (
			SELECT hypertable_schema AS schema, hypertable_name AS name, compression_enabled
			FROM timescaledb_information.hypertables WHERE hypertable_schema = current_schema() AND hypertable_name = ?
			UNION ALL
			SELECT materialization_hypertable_schema, materialization_hypertable_name, compression_enabled
			FROM timescaledb_information.continuous_aggregates WHERE view_schema = current_schema() AND view_name = ?
		)
		SELECT TRUE AS present, t.compression_enabled,
			COALESCE(j.job_id, 0) AS job_id, COALESCE(j.scheduled, FALSE) AS scheduled,
			COALESCE(EXTRACT(EPOCH FROM (j.config->>'compress_after')::interval) / 86400.0, 0) AS after_days,
			(SELECT COUNT(*) FROM timescaledb_information.chunks c WHERE c.hypertable_schema=t.schema AND c.hypertable_name=t.name AND c.is_compressed) AS compressed_chunks,
			(SELECT COUNT(*) FROM timescaledb_information.chunks c WHERE c.hypertable_schema=t.schema AND c.hypertable_name=t.name) AS total_chunks
		FROM target t LEFT JOIN timescaledb_information.jobs j ON j.proc_name='policy_compression'
			AND ((j.hypertable_schema=t.schema AND j.hypertable_name=t.name)
			OR (j.hypertable_schema=current_schema() AND j.hypertable_name=?))`
		if err := db.Raw(query, table.name, table.name, table.name).Scan(&row).Error; err != nil {
			return status, fmt.Errorf("compression status for %s: %w", table.name, err)
		}
		row.Table, row.Label, row.MinimumDays = table.name, table.label, table.minimumDays
		status.Tables = append(status.Tables, row)
	}
	return status, nil
}

func ApplyCompressionSettings(ctx context.Context, db *gorm.DB, values map[string]string) error {
	if err := ValidateCompressionSettings(values); err != nil {
		return err
	}
	status, err := GetCompressionStatus(ctx, db)
	if err != nil || !status.Available {
		return err
	}
	enabled := values["compression_metric_enabled"] == "true"
	days, _ := strconv.ParseFloat(values["compression_metric_after_days"], 64)
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`SET LOCAL lock_timeout = '2s'`).Error; err != nil {
			return err
		}
		for index, table := range compressionTables {
			current := status.Tables[index]
			if !current.Present {
				return fmt.Errorf("compression target %s is not available", table.name)
			}
			seconds := int64(math.Round(math.Max(days, table.minimumDays) * 86400))
			if current.JobID != 0 {
				if enabled && int64(math.Round(current.AfterDays*86400)) == seconds {
					if !current.Scheduled {
						if err := tx.Exec(`SELECT alter_job(?, scheduled => TRUE)`, current.JobID).Error; err != nil {
							return err
						}
					}
					continue
				}
				if err := tx.Exec(`SELECT remove_compression_policy(?::regclass, if_exists => TRUE)`, table.name).Error; err != nil {
					return err
				}
			}
			if !enabled {
				continue
			}
			if !current.CompressionEnabled {
				kind := "TABLE"
				if table.materialized {
					kind = "MATERIALIZED VIEW"
				}
				if err := tx.Exec("ALTER " + kind + " " + table.name + " SET (timescaledb.compress = TRUE)").Error; err != nil {
					return err
				}
			}
			if err := tx.Exec(`SELECT add_compression_policy(?::regclass, compress_after => ?::interval, if_not_exists => TRUE)`, table.name, fmt.Sprintf("%d seconds", seconds)).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// Compression is independent of retention cleanup; disabling it keeps existing
// compressed chunks readable and stops only future automatic compression.
func RunCompressionMaintenance(ctx context.Context, db *gorm.DB) {
	check := func() {
		checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		values := CompressionDefaults()
		saved, err := NewSettingsRepository(db).GetValues(checkCtx, "compression_metric_enabled", "compression_metric_after_days")
		if err == nil {
			for key, value := range saved {
				values[key] = value
			}
			err = ApplyCompressionSettings(checkCtx, db, values)
		}
		if err != nil {
			log.Printf("Compression policy reconciliation failed: %v", err)
		}
	}
	check()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}
