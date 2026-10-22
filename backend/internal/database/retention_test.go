package database

import (
	"context"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type retentionSQLLog struct {
	logger.Interface
	queries []string
}

func (l *retentionSQLLog) Trace(_ context.Context, _ time.Time, sql func() (string, int64), _ error) {
	query, _ := sql()
	l.queries = append(l.queries, query)
}

func TestValidateRetentionSettings(t *testing.T) {
	if err := ValidateRetentionSettings(RetentionDefaults()); err != nil {
		t.Fatal(err)
	}
	for key, spec := range retentionSettings {
		for _, value := range []string{"", "-1", "1.5", "NaN", "999999999999999999999999"} {
			if err := ValidateRetentionSettings(map[string]string{key: value}); err == nil {
				t.Errorf("accepted invalid %s=%s", key, value)
			}
		}
		if spec.min == 0 {
			if err := ValidateRetentionSettings(map[string]string{key: "0"}); err != nil {
				t.Errorf("cannot disable %s: %v", key, err)
			}
		} else if err := ValidateRetentionSettings(map[string]string{key: "0"}); err == nil {
			t.Errorf("accepted zero for %s", key)
		}
	}
	if err := ValidateRetentionSettings(map[string]string{"retention_enabled": "yes"}); err == nil {
		t.Fatal("accepted invalid enable flag")
	}
}

func TestRetentionCleanupSQL(t *testing.T) {
	log := &retentionSQLLog{Interface: logger.Default}
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test sslmode=disable"), &gorm.Config{
		DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true, Logger: log,
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	values := RetentionDefaults()
	values["retention_resolved_fault_days"] = "2"
	values["retention_batch_size"] = "250"
	if err := runRetentionCleanup(context.Background(), db, values, now); err != nil {
		t.Fatal(err)
	}
	queries := strings.Join(log.queries, "\n")
	for _, required := range []string{
		"resolved = true AND resolved_at < '2026-10-20 12:00:00'",
		"status = 'completed' AND completed_at <",
		"status = 'failed' AND completed_at <",
		"ORDER BY id LIMIT 250",
		"drop_chunks(CAST('metric_samples' AS regclass), older_than => CAST('2026-10-22 06:00:00' AS timestamptz))",
	} {
		if !strings.Contains(queries, required) {
			t.Errorf("missing %s in SQL:\n%s", required, queries)
		}
	}
	if strings.Contains(queries, "device_snapshots") || strings.Contains(queries, "interface_metric_samples") {
		t.Fatal("zero retention must not delete snapshots or interface metrics")
	}
	log.queries = nil
	values["retention_enabled"] = "false"
	if err := runRetentionCleanup(context.Background(), db, values, now); err != nil || len(log.queries) != 0 {
		t.Fatalf("disabled cleanup executed SQL: %v %v", err, log.queries)
	}
	values["retention_enabled"] = "true"
	values["retention_audit_days"] = "-1"
	if err := runRetentionCleanup(context.Background(), db, values, now); err == nil || len(log.queries) != 0 {
		t.Fatal("invalid configuration must stop cleanup before any deletion")
	}
}
