package database

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func testIndexSpec() IndexSpec {
	return IndexSpec{Label: "Uptime lookup", Purpose: "Find CPEs reporting uptime", Recipe: "parameter_presence", ParameterPath: "InternetGatewayDevice.DeviceInfo.UpTime"}
}

func TestManagedIndexPolicy(t *testing.T) {
	if err := ValidateIndexSpec(testIndexSpec()); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*IndexSpec){
		func(s *IndexSpec) { s.Recipe = "gin" }, func(s *IndexSpec) { s.Recipe = "custom" },
		func(s *IndexSpec) { s.ParameterPath = "InternetGatewayDevice.WANDevice.*.Status" },
		func(s *IndexSpec) { s.ParameterPath = "InternetGatewayDevice.DeviceInfo." },
		func(s *IndexSpec) { s.ParameterPath = "Device.Test.Password" },
		func(s *IndexSpec) { s.ParameterPath = "Device.Test.ConnectionRequestUsername" },
		func(s *IndexSpec) { s.ParameterPath = "Device.Test.Name' OR TRUE--" },
		func(s *IndexSpec) { s.ParameterPath = "Device.Test.Name%" },
		func(s *IndexSpec) { s.Label = "x\nDROP INDEX" },
		func(s *IndexSpec) { s.Purpose = "" },
	} {
		spec := testIndexSpec()
		mutate(&spec)
		if !errors.Is(ValidateIndexSpec(spec), ErrIndexPolicy) {
			t.Errorf("accepted unsafe spec: %+v", spec)
		}
	}
	if _, err := indexDDL("public", "idx_device_parameters_unique", testIndexSpec()); !errors.Is(err, ErrIndexProtected) {
		t.Fatal("accepted caller-selected index name")
	}
	name, token, err := newIndexIdentity()
	if err != nil {
		t.Fatal(err)
	}
	c := IndexCatalogEntry{Name: name, OID: 42, TableName: "device_parameters", Method: "btree", Definition: "approved", DefaultStorage: true, Comment: "acs-ui-index:" + token}
	if !indexOwned(c, name, 42, "approved", token) {
		t.Fatal("valid ownership rejected")
	}
	for _, mutate := range []func(*IndexCatalogEntry){func(c *IndexCatalogEntry) { c.OID++ }, func(c *IndexCatalogEntry) { c.Comment = "" }, func(c *IndexCatalogEntry) { c.Unique = true }, func(c *IndexCatalogEntry) { c.Primary = true }, func(c *IndexCatalogEntry) { c.Constraint = true }, func(c *IndexCatalogEntry) { c.Definition = "changed" }, func(c *IndexCatalogEntry) { c.Method = "gin" }, func(c *IndexCatalogEntry) { c.DefaultStorage = false }} {
		other := c
		mutate(&other)
		if indexOwned(other, name, 42, "approved", token) {
			t.Fatal("accepted altered/protected index")
		}
	}
}

func indexTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	base, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("index_test_%d", time.Now().UnixNano())
	if err := base.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { base.Exec("DROP SCHEMA " + schema + " CASCADE"); pool, _ := base.DB(); pool.Close() })
	u, err := url.Parse(dsn)
	if err != nil || u.Scheme == "" {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, err := gorm.Open(postgres.Open(u.String()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool, _ := db.DB(); pool.Close() })
	if err := db.AutoMigrate(&models.ManagedDatabaseIndex{}, &models.DatabaseIndexStorageProbe{}); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		"CREATE TABLE devices (id bigint PRIMARY KEY)",
		"INSERT INTO devices VALUES (1)",
		"CREATE TABLE device_parameters(id bigserial PRIMARY KEY,device_id bigint NOT NULL,name text NOT NULL,value text,value_type text,writable boolean,updated_at timestamptz,UNIQUE(device_id,name))",
		"CREATE INDEX protected_existing ON device_parameters(updated_at)",
	} {
		if err := db.Exec(query).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func setIndexProbe(t *testing.T, db *gorm.DB, free int64, age time.Duration) {
	t.Helper()
	if err := db.Exec(`INSERT INTO database_index_storage_probes(id,total_bytes,free_bytes,measured_at) VALUES (1,?, ?, ?) ON CONFLICT(id) DO UPDATE SET free_bytes=excluded.free_bytes,measured_at=excluded.measured_at`, int64(100<<30), free, time.Now().Add(-age)).Error; err != nil {
		t.Fatal(err)
	}
}

func readManaged(t *testing.T, db *gorm.DB, id int64) models.ManagedDatabaseIndex {
	t.Helper()
	var m models.ManagedDatabaseIndex
	if err := db.First(&m, id).Error; err != nil {
		t.Fatal(err)
	}
	return m
}

func indexTick(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := managedIndexTick(context.Background(), db); err != nil {
		t.Fatal(err)
	}
}

func TestManagedIndexPostgresLifecycle(t *testing.T) {
	db := indexTestDB(t)
	pool, _ := db.DB()
	pool.SetMaxOpenConns(1)
	ctx := context.Background()
	spec := testIndexSpec()
	if _, err := QueueManagedIndex(ctx, db, 0, spec, 1); !errors.Is(err, ErrIndexPolicy) {
		t.Fatalf("missing probe allowed: %v", err)
	}
	setIndexProbe(t, db, 90<<30, 0)
	m, err := QueueManagedIndex(ctx, db, 0, spec, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := QueueManagedIndex(ctx, db, 0, spec, 1); !errors.Is(err, ErrIndexPolicy) {
		t.Fatal("duplicate definition allowed")
	}
	guard, err := indexConnection(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := guard.ExecContext(ctx, "SELECT pg_advisory_lock($1)", indexWorkerLock); err != nil {
		t.Fatal(err)
	}
	indexTick(t, db)
	if got := readManaged(t, db, m.ID); got.Status != "queued" {
		t.Fatal("second worker bypassed advisory lock")
	}
	closeIndexSession(guard)
	indexTick(t, db)
	first := readManaged(t, db, m.ID)
	if first.Status != "ready" {
		t.Fatalf("build failed: %+v", first)
	}
	view, err := GetIndexOverview(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Managed) != 1 || !view.Managed[0].Owned || !view.Managed[0].Valid {
		t.Fatalf("ownership/validity missing: %+v", view.Managed)
	}
	// A large changed parameter value cannot enlarge the fixed-width index or
	// violate a B-tree key size limit on future Inform/GPV writes.
	repo := NewParameterRepository(db)
	for _, value := range []string{"123", strings.Repeat("value", 30000)} {
		if err := repo.UpsertMany(ctx, 1, []models.DeviceParameter{{Name: spec.ParameterPath, Value: value}}); err != nil {
			t.Fatal(err)
		}
	}
	var count int64
	db.Model(&models.DeviceParameter{}).Count(&count)
	if count != 1 {
		t.Fatal("parameter upsert became history")
	}
	spec.Recipe = "parameter_freshness"
	spec.Label = "Uptime freshness"
	if _, err := QueueManagedIndex(ctx, db, m.ID, spec, 1); err != nil {
		t.Fatal(err)
	}
	before := readManaged(t, db, m.ID)
	if before.ActiveName != first.ActiveName {
		t.Fatal("edit removed the old index before replacement")
	}
	indexTick(t, db)
	second := readManaged(t, db, m.ID)
	if second.Status != "ready" || second.ActiveName == first.ActiveName {
		t.Fatalf("replacement failed: %+v", second)
	}
	if old, err := findCatalogIndex(ctx, db, first.ActiveName); err != nil || old != nil {
		t.Fatal("replacement left old index in PostgreSQL")
	}
	if err := RequestManagedIndexAction(ctx, db, m.ID, "delete"); err != nil {
		t.Fatal(err)
	}
	indexTick(t, db)
	if err := db.First(&models.ManagedDatabaseIndex{}, m.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("registry row retained after drop")
	}
	if c, err := findCatalogIndex(ctx, db, second.ActiveName); err != nil || c != nil {
		t.Fatal("index retained in PostgreSQL after delete")
	}
	var valueLength int
	if err := db.Raw("SELECT length(value) FROM device_parameters WHERE device_id=1 AND name=?", spec.ParameterPath).Scan(&valueLength).Error; err != nil || valueLength != 150000 {
		t.Fatalf("index removal changed real parameter data: length=%d err=%v", valueLength, err)
	}
	if c, err := findCatalogIndex(ctx, db, "protected_existing"); err != nil || c == nil {
		t.Fatal("existing index was modified")
	}
	setIndexProbe(t, db, 90<<30, time.Minute)
	if _, err := QueueManagedIndex(ctx, db, 0, spec, 1); !errors.Is(err, ErrIndexPolicy) {
		t.Fatal("stale probe allowed")
	}
}

func TestManagedIndexPostgresCancelRecoveryAndProtection(t *testing.T) {
	db := indexTestDB(t)
	ctx := context.Background()
	spec := testIndexSpec()
	setIndexProbe(t, db, 90<<30, 0)
	m, err := QueueManagedIndex(ctx, db, 0, spec, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := RequestManagedIndexAction(ctx, db, m.ID, "cancel"); err != nil {
		t.Fatal(err)
	}
	indexTick(t, db)
	cancelled := readManaged(t, db, m.ID)
	if cancelled.CandidateName != "" || cancelled.ActiveName != "" || cancelled.Status != "failed" {
		t.Fatalf("cancel did not clear candidate: %+v", cancelled)
	}
	if _, err := QueueManagedIndex(ctx, db, m.ID, spec, 1); err != nil {
		t.Fatal(err)
	}
	interrupted := readManaged(t, db, m.ID)
	schema, _ := getIndexSchema(ctx, db)
	ddl, _ := indexDDL(schema, interrupted.CandidateName, spec)
	if err := db.Exec(ddl).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&interrupted).Update("status", "building").Error; err != nil {
		t.Fatal(err)
	}
	indexTick(t, db)
	recovered := readManaged(t, db, m.ID)
	if recovered.CandidateName != "" || recovered.Status != "failed" {
		t.Fatalf("restart recovery left candidate: %+v", recovered)
	}
	if c, err := findCatalogIndex(ctx, db, interrupted.CandidateName); err != nil || c != nil {
		t.Fatal("restart left an orphan index")
	}
	if _, err := QueueManagedIndex(ctx, db, m.ID, spec, 1); err != nil {
		t.Fatal(err)
	}
	indexTick(t, db)
	ready := readManaged(t, db, m.ID)
	if ready.Status != "ready" {
		t.Fatalf("retry failed: %+v", ready)
	}
	if err := db.Exec("COMMENT ON INDEX " + quoteIdentifier(schema) + "." + quoteIdentifier(ready.ActiveName) + " IS 'changed outside UI'").Error; err != nil {
		t.Fatal(err)
	}
	if err := RequestManagedIndexAction(ctx, db, m.ID, "delete"); !errors.Is(err, ErrIndexProtected) {
		t.Fatalf("altered object was deletable: %v", err)
	}
	if _, err := QueueManagedIndex(ctx, db, m.ID, spec, 1); !errors.Is(err, ErrIndexProtected) {
		t.Fatal("altered object was editable")
	}
	if err := db.Exec("COMMENT ON INDEX " + quoteIdentifier(schema) + "." + quoteIdentifier(ready.ActiveName) + " IS " + quoteLiteral("acs-ui-index:"+ready.ActiveToken)).Error; err != nil {
		t.Fatal(err)
	}
	setIndexProbe(t, db, 9<<30, 0)
	indexTick(t, db)
	evicted := readManaged(t, db, m.ID)
	if evicted.Status != "evicted" || evicted.ActiveName != "" {
		t.Fatalf("disk reserve did not evict UI index: %+v", evicted)
	}
	if c, err := findCatalogIndex(ctx, db, "protected_existing"); err != nil || c == nil {
		t.Fatal("disk cleanup removed existing index")
	}
}

func TestManagedIndexPostgresCancelRunningBuild(t *testing.T) {
	db := indexTestDB(t)
	ctx := context.Background()
	setIndexProbe(t, db, 90<<30, 0)
	m, err := QueueManagedIndex(ctx, db, 0, testIndexSpec(), 1)
	if err != nil {
		t.Fatal(err)
	}
	// Keep a writer open so CREATE INDEX CONCURRENTLY must wait and the test
	// exercises cancellation of an executing PostgreSQL statement, not just a queue flag.
	pool, _ := db.DB()
	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "INSERT INTO device_parameters(device_id,name,value) VALUES(1,'Device.Test.Pending','1')"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- managedIndexTick(ctx, db) }()
	deadline := time.Now().Add(10 * time.Second)
	started := false
	for time.Now().Before(deadline) {
		var count int64
		if err := db.Raw(`SELECT COUNT(*) FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid=p.index_relid WHERE c.relname=?`, m.CandidateName).Scan(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			started = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !started {
		t.Fatal("concurrent build did not reach PostgreSQL progress reporting")
	}
	if err := RequestManagedIndexAction(ctx, db, m.ID, "cancel"); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("running build did not stop")
	}
	result := readManaged(t, db, m.ID)
	if result.Status != "failed" || result.CandidateName != "" || result.ActiveName != "" {
		t.Fatalf("running cancellation left an object: %+v", result)
	}
	if c, err := findCatalogIndex(ctx, db, m.CandidateName); err != nil || c != nil {
		t.Fatal("cancelled build left PostgreSQL index")
	}
}

func TestManagedIndexPostgresBudgetsAndDefinitionLimit(t *testing.T) {
	db := indexTestDB(t)
	ctx := context.Background()
	setIndexProbe(t, db, 90<<30, 0)
	// The full physical size allowance is reserved for queued work, so parallel
	// API requests cannot overbook the total budget with small-looking estimates.
	for i := 0; i < 4; i++ {
		spec := testIndexSpec()
		spec.ParameterPath = fmt.Sprintf("Device.Budget.Param%d", i)
		if _, err := QueueManagedIndex(ctx, db, 0, spec, 1); err != nil {
			t.Fatal(err)
		}
	}
	extra := testIndexSpec()
	extra.ParameterPath = "Device.Budget.Overflow"
	if _, err := QueueManagedIndex(ctx, db, 0, extra, 1); !errors.Is(err, ErrIndexPolicy) {
		t.Fatal("queued jobs overbooked total index budget")
	}
	for i := 0; i < 4; i++ {
		indexTick(t, db)
	}
	for i := 4; i < ManagedIndexMaxCount; i++ {
		spec := testIndexSpec()
		spec.ParameterPath = fmt.Sprintf("Device.Budget.Param%d", i)
		if _, err := QueueManagedIndex(ctx, db, 0, spec, 1); err != nil {
			t.Fatal(err)
		}
		indexTick(t, db)
	}
	if _, err := QueueManagedIndex(ctx, db, 0, extra, 1); !errors.Is(err, ErrIndexPolicy) {
		t.Fatal("definition count cap bypassed")
	}
	first := readManaged(t, db, 1)
	edit := IndexSpec{Label: first.Label, Purpose: first.Purpose, Recipe: "parameter_freshness", ParameterPath: first.ParameterPath}
	if _, err := QueueManagedIndex(ctx, db, first.ID, edit, 1); err != nil {
		t.Fatalf("editing should not consume a new definition slot: %v", err)
	}
	indexTick(t, db)
	if got := readManaged(t, db, first.ID); got.Status != "ready" {
		t.Fatalf("replacement at definition limit failed: %+v", got)
	}
}
