package database

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestCompressionValidation(t *testing.T) {
	if err := ValidateCompressionSettings(CompressionDefaults()); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "0", "-1", "0.01", "3651", "NaN", "+Inf", "bad"} {
		if ValidateCompressionSettings(map[string]string{"compression_metric_after_days": value}) == nil {
			t.Fatalf("accepted age %q", value)
		}
	}
	if ValidateCompressionSettings(map[string]string{"compression_metric_enabled": "yes"}) == nil {
		t.Fatal("accepted invalid switch")
	}
}

func TestCompressionPoliciesTimescale(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	defer conn.Close()
	var available bool
	if err := db.Raw("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='timescaledb')").Scan(&available).Error; err != nil {
		t.Fatal(err)
	}
	if !available {
		t.Skip("TimescaleDB not installed")
	}
	schema := fmt.Sprintf("compression_test_%d", time.Now().UnixNano())
	if err := db.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	defer db.Exec("DROP SCHEMA " + schema + " CASCADE")
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema+",public")
	u.RawQuery = q.Encode()
	isolated, err := gorm.Open(postgres.Open(u.String()), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	isql, _ := isolated.DB()
	defer isql.Close()
	exec := func(query string) {
		t.Helper()
		if err := isolated.Exec(query).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"metric_samples", "interface_metric_samples"} {
		exec("CREATE TABLE " + table + " (device_id text, metric_id bigint, timestamp timestamptz NOT NULL, value double precision)")
		exec("SELECT create_hypertable('" + table + "', 'timestamp', chunk_time_interval => INTERVAL '1 day')")
		exec("ALTER TABLE " + table + " SET (timescaledb.compress=true, timescaledb.compress_segmentby='device_id,metric_id', timescaledb.compress_orderby='timestamp DESC')")
	}
	for _, aggregate := range []struct{ name, bucket string }{{"metric_samples_5min", "5 minutes"}, {"metric_samples_1h", "1 hour"}, {"metric_samples_1d", "1 day"}} {
		exec("CREATE MATERIALIZED VIEW " + aggregate.name + " WITH (timescaledb.continuous) AS SELECT time_bucket(INTERVAL '" + aggregate.bucket + "', timestamp) AS bucket, device_id, metric_id, AVG(value) AS value FROM metric_samples GROUP BY 1,2,3 WITH NO DATA")
		exec("SELECT add_continuous_aggregate_policy('" + aggregate.name + "', start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 day')")
	}
	exec("CREATE TABLE device_logs (message text)")
	ctx := context.Background()
	values := CompressionDefaults()
	values["compression_metric_after_days"] = "2"
	apply := func() {
		t.Helper()
		if err := ApplyCompressionSettings(ctx, isolated, values); err != nil {
			t.Fatal(err)
		}
	}
	status := func() CompressionStatus {
		t.Helper()
		result, err := GetCompressionStatus(ctx, isolated)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	apply()
	first := status()
	for i, row := range first.Tables {
		want := []float64{2, 2, 8, 31, 366}[i]
		if !row.Present || !row.Scheduled || !row.CompressionEnabled || row.AfterDays != want {
			t.Fatalf("unexpected policy: %+v", row)
		}
	}
	if first.Operational[4].CompressibleColumns != 1 {
		t.Fatalf("operational metadata: %+v", first.Operational)
	}
	apply()
	for i, row := range status().Tables {
		if row.JobID != first.Tables[i].JobID {
			t.Fatal("idempotent apply replaced policy")
		}
	}
	exec("INSERT INTO metric_samples VALUES ('test', 1, now() - INTERVAL '10 days', 42)")
	exec("SELECT compress_chunk(c) FROM show_chunks('metric_samples') c")
	values["compression_metric_enabled"] = "false"
	apply()
	for _, row := range status().Tables {
		if row.JobID != 0 || row.Scheduled {
			t.Fatalf("policy still enabled: %+v", row)
		}
	}
	if status().Tables[0].CompressedChunks != 1 {
		t.Fatal("disabling decompressed history")
	}
	var sample float64
	if err := isolated.Raw("SELECT value FROM metric_samples").Scan(&sample).Error; err != nil || sample != 42 {
		t.Fatalf("history unreadable: %v %v", sample, err)
	}
	values["compression_metric_enabled"] = "true"
	values["compression_metric_after_days"] = "40"
	apply()
	for i, row := range status().Tables {
		want := float64(40)
		if i == 4 {
			want = 366
		}
		if !row.Scheduled || row.AfterDays != want {
			t.Fatalf("reenable/change: %+v", row)
		}
	}
}
