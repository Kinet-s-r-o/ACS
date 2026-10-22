package database

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"gorm.io/gorm"
)

type retentionSetting struct {
	defaultValue int
	min          int
	max          int
}

var retentionSettings = map[string]retentionSetting{
	"retention_interval_hours":        {24, 1, 168},
	"retention_batch_size":            {1000, 100, 10000},
	"retention_max_batches":           {100, 1, 1000},
	"retention_audit_days":            {180, 0, 3650},
	"retention_resolved_fault_days":   {90, 0, 3650},
	"retention_completed_task_days":   {90, 0, 3650},
	"retention_failed_task_days":      {90, 0, 3650},
	"retention_snapshot_days":         {0, 0, 3650},
	"retention_metric_hours":          {6, 0, 87600},
	"retention_interface_metric_days": {0, 0, 3650},
	"retention_metric_5min_days":      {7, 0, 3650},
	"retention_metric_1h_days":        {30, 0, 3650},
	"retention_metric_1d_days":        {365, 0, 3650},
}

func RetentionDefaults() map[string]string {
	values := map[string]string{"retention_enabled": "true"}
	for key, spec := range retentionSettings {
		values[key] = strconv.Itoa(spec.defaultValue)
	}
	return values
}

func ValidateRetentionSettings(values map[string]string) error {
	if value, ok := values["retention_enabled"]; ok && value != "true" && value != "false" {
		return fmt.Errorf("retention_enabled must be true or false")
	}
	for key, spec := range retentionSettings {
		if value, ok := values[key]; ok {
			n, err := strconv.Atoi(value)
			if err != nil || n < spec.min || n > spec.max {
				return fmt.Errorf("%s must be an integer between %d and %d", key, spec.min, spec.max)
			}
		}
	}
	return nil
}

type retentionRule struct {
	key, table, predicate string
	unit                  time.Duration
	chunks                bool
}

type RetentionTableStats struct {
	Table     string `json:"table"`
	Records   int64  `json:"records"`
	SizeBytes int64  `json:"size_bytes"`
}

// GetRetentionTableStats uses PostgreSQL's catalog estimates so inspecting a
// large table does not require a full table scan. Timescale counts include
// estimates for every data chunk. Sizes include indexes and TOAST data.
func GetRetentionTableStats(ctx context.Context, db *gorm.DB) ([]RetentionTableStats, error) {
	stats := make([]RetentionTableStats, 0, len(retentionRules))
	for _, rule := range retentionRules {
		var row RetentionTableStats
		row.Table = rule.table
		var query string
		var args []interface{}
		if rule.chunks {
			query = `WITH target_hypertables AS (
				SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = ?
				UNION ALL
				SELECT materialization_hypertable_name AS hypertable_name
				FROM timescaledb_information.continuous_aggregates WHERE view_name = ?
			)
			SELECT COALESCE(SUM(GREATEST(stats.n_live_tup, 0)), 0)::bigint AS records,
			       COALESCE(hypertable_size(?::regclass), 0)::bigint AS size_bytes
			FROM timescaledb_information.chunks chunks
			JOIN target_hypertables target USING (hypertable_name)
			JOIN pg_class relation ON relation.oid = to_regclass(format('%I.%I', chunks.chunk_schema, chunks.chunk_name))
			LEFT JOIN pg_stat_user_tables stats ON stats.relid = relation.oid`
			args = []interface{}{rule.table, rule.table, rule.table}
		} else {
			query = `SELECT COALESCE(SUM(stats.n_live_tup), 0)::bigint AS records,
			        COALESCE(pg_total_relation_size(?::regclass), 0)::bigint AS size_bytes
			FROM pg_stat_user_tables stats
			WHERE stats.relid = to_regclass(?::text)`
			args = []interface{}{rule.table, rule.table}
		}
		if err := db.WithContext(ctx).Raw(query, args...).Scan(&row).Error; err != nil {
			return nil, fmt.Errorf("read retention stats for %s: %w", rule.table, err)
		}
		stats = append(stats, row)
	}
	return stats, nil
}

var retentionRules = []retentionRule{
	{"retention_audit_days", "audit_logs", "created_at < ?", 24 * time.Hour, false},
	{"retention_resolved_fault_days", "faults", "resolved = true AND resolved_at < ?", 24 * time.Hour, false},
	{"retention_completed_task_days", "tasks", "status = 'completed' AND completed_at < ?", 24 * time.Hour, false},
	{"retention_failed_task_days", "tasks", "status = 'failed' AND completed_at < ?", 24 * time.Hour, false},
	{"retention_snapshot_days", "device_snapshots", "created_at < ?", 24 * time.Hour, false},
	{"retention_metric_hours", "metric_samples", "", time.Hour, true},
	{"retention_interface_metric_days", "interface_metric_samples", "", 24 * time.Hour, true},
	{"retention_metric_5min_days", "metric_samples_5min", "", 24 * time.Hour, true},
	{"retention_metric_1h_days", "metric_samples_1h", "", 24 * time.Hour, true},
	{"retention_metric_1d_days", "metric_samples_1d", "", 24 * time.Hour, true},
}

func runRetentionCleanup(ctx context.Context, db *gorm.DB, values map[string]string, now time.Time) error {
	if err := ValidateRetentionSettings(values); err != nil {
		return err
	}
	if values["retention_enabled"] != "true" {
		return nil
	}
	batchSize, _ := strconv.Atoi(values["retention_batch_size"])
	maxBatches, _ := strconv.Atoi(values["retention_max_batches"])
	for _, rule := range retentionRules {
		age, _ := strconv.Atoi(values[rule.key])
		if age == 0 {
			continue
		}
		cutoff := now.Add(-time.Duration(age) * rule.unit)
		if rule.chunks {
			if err := db.WithContext(ctx).Exec("SELECT drop_chunks(CAST(? AS regclass), older_than => CAST(? AS timestamptz))", rule.table, cutoff).Error; err != nil {
				return fmt.Errorf("retention %s: %w", rule.table, err)
			}
			continue
		}
		// Table names and predicates come exclusively from the fixed rules above.
		query := fmt.Sprintf("DELETE FROM %s WHERE id IN (SELECT id FROM %s WHERE %s ORDER BY id LIMIT ?)", rule.table, rule.table, rule.predicate)
		for batch := 0; batch < maxBatches; batch++ {
			result := db.WithContext(ctx).Exec(query, cutoff, batchSize)
			if result.Error != nil {
				return fmt.Errorf("retention %s: %w", rule.table, result.Error)
			}
			if result.RowsAffected < int64(batchSize) {
				break
			}
		}
	}
	return nil
}

// Settings are reloaded every minute; changed settings take effect on the next check.
func RunRetentionMaintenance(ctx context.Context, db *gorm.DB) {
	defaults := RetentionDefaults()
	keys := make([]string, 0, len(defaults))
	for key := range defaults {
		keys = append(keys, key)
	}
	var lastRun time.Time
	lastConfig := ""
	check := func() {
		checkCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		saved, err := NewSettingsRepository(db).GetValues(checkCtx, keys...)
		if err != nil {
			log.Printf("Retention settings unavailable: %v", err)
			return
		}
		values := RetentionDefaults()
		for key, value := range saved {
			values[key] = value
		}
		if err := ValidateRetentionSettings(values); err != nil {
			log.Printf("Retention settings invalid; cleanup skipped: %v", err)
			return
		}
		config := fmt.Sprint(values)
		hours, _ := strconv.Atoi(values["retention_interval_hours"])
		if config == lastConfig && time.Since(lastRun) < time.Duration(hours)*time.Hour {
			return
		}
		if err := runRetentionCleanup(checkCtx, db, values, time.Now()); err != nil {
			log.Printf("Retention cleanup failed: %v", err)
			return
		}
		lastConfig, lastRun = config, time.Now()
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
