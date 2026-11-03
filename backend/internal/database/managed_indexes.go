package database

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

const (
	ManagedIndexMaxBytes   int64 = 256 << 20
	ManagedIndexTotalBytes int64 = 1 << 30
	ManagedIndexReserve    int64 = 10 << 30
	ManagedIndexMaxCount         = 8
	indexQueueLock         int64 = 714290101
	indexWorkerLock        int64 = 714290102
)

var (
	ErrIndexPolicy    = errors.New("database index policy rejected the operation")
	ErrIndexBusy      = errors.New("an index operation is already pending")
	ErrIndexProtected = errors.New("only indexes created and still owned by DB indexes can be changed")
	indexPathPattern  = regexp.MustCompile(`^(InternetGatewayDevice|Device)\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$`)
	managedIndexName  = regexp.MustCompile(`^acs_ui_idx_[a-f0-9]{32}$`)
)

type IndexSpec struct {
	Label         string `json:"label"`
	Purpose       string `json:"purpose"`
	Recipe        string `json:"recipe"`
	ParameterPath string `json:"parameter_path"`
}

type IndexRecipe struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

var indexRecipes = []IndexRecipe{
	{"parameter_presence", "Parameter presence by CPE", "B-tree on device_id for one exact parameter path. Supports lookups and joins for that parameter across CPEs."},
	{"parameter_freshness", "Parameter freshness", "B-tree on updated_at DESC and device_id for one exact parameter path. Supports newest readings and age filters."},
}

type IndexCatalogEntry struct {
	OID            int64  `json:"oid" gorm:"column:oid"`
	Schema         string `json:"schema"`
	Name           string `json:"name"`
	TableName      string `json:"table_name"`
	Method         string `json:"method"`
	Primary        bool   `json:"primary"`
	Unique         bool   `json:"unique"`
	Constraint     bool   `json:"constraint"`
	Valid          bool   `json:"valid"`
	SizeBytes      int64  `json:"size_bytes"`
	Scans          int64  `json:"scans"`
	Definition     string `json:"definition"`
	Comment        string `json:"-"`
	DefaultStorage bool   `json:"-"`
}

type ManagedIndexView struct {
	models.ManagedDatabaseIndex
	SizeBytes      int64  `json:"size_bytes"`
	Scans          int64  `json:"scans"`
	Valid          bool   `json:"valid"`
	Owned          bool   `json:"owned"`
	Phase          string `json:"phase,omitempty"`
	BlocksTotal    int64  `json:"blocks_total"`
	BlocksDone     int64  `json:"blocks_done"`
	CleanupPending bool   `json:"cleanup_pending"`
}

type IndexBudget struct {
	MaxIndexBytes int64     `json:"max_index_bytes"`
	MaxTotalBytes int64     `json:"max_total_bytes"`
	MaxCount      int       `json:"max_count"`
	ManagedBytes  int64     `json:"managed_bytes"`
	ReservedBytes int64     `json:"reserved_bytes"`
	FreeBytes     int64     `json:"free_bytes"`
	TotalBytes    int64     `json:"total_bytes"`
	ReserveBytes  int64     `json:"reserve_bytes"`
	ProbeFresh    bool      `json:"probe_fresh"`
	MeasuredAt    time.Time `json:"measured_at"`
	CanCreate     bool      `json:"can_create"`
	Reason        string    `json:"reason"`
}

type IndexOverview struct {
	Managed []ManagedIndexView  `json:"managed"`
	Catalog []IndexCatalogEntry `json:"catalog"`
	Recipes []IndexRecipe       `json:"recipes"`
	Budget  IndexBudget         `json:"budget"`
}

type IndexPreview struct {
	EstimatedRows  int64       `json:"estimated_rows"`
	EstimatedBytes int64       `json:"estimated_bytes"`
	Plan           string      `json:"plan"`
	Budget         IndexBudget `json:"budget"`
}

func ValidateIndexSpec(spec IndexSpec) error {
	for _, field := range []struct {
		value    string
		min, max int
	}{{spec.Label, 3, 80}, {spec.Purpose, 8, 256}} {
		if !utf8.ValidString(field.value) || utf8.RuneCountInString(strings.TrimSpace(field.value)) < field.min || utf8.RuneCountInString(field.value) > field.max || strings.IndexFunc(field.value, unicode.IsControl) >= 0 {
			return fmt.Errorf("%w: label must have 3–80 characters and purpose 8–256 characters, without control characters", ErrIndexPolicy)
		}
	}
	if spec.Recipe != "parameter_presence" && spec.Recipe != "parameter_freshness" {
		return fmt.Errorf("%w: choose an approved B-tree recipe; GIN, custom SQL, methods, expressions and INCLUDE columns are forbidden", ErrIndexPolicy)
	}
	if len(spec.ParameterPath) > 256 || !indexPathPattern.MatchString(spec.ParameterPath) || IsSensitiveParameterName(spec.ParameterPath) || spec.ParameterPath == DeviceLogParameterName {
		return fmt.Errorf("%w: provide one exact non-sensitive parameter path, without wildcards or a trailing dot", ErrIndexPolicy)
	}
	return nil
}

func indexKey(spec IndexSpec) string {
	if spec.Recipe == "parameter_freshness" {
		return "updated_at DESC, device_id"
	}
	return "device_id"
}

func quoteIdentifier(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func quoteLiteral(s string) string    { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func indexDDL(schema, name string, spec IndexSpec) (string, error) {
	if err := ValidateIndexSpec(spec); err != nil {
		return "", err
	}
	if !managedIndexName.MatchString(name) {
		return "", ErrIndexProtected
	}
	return "CREATE INDEX CONCURRENTLY " + quoteIdentifier(name) + " ON " + quoteIdentifier(schema) + `."device_parameters" USING btree (` + indexKey(spec) + ") WITH (fillfactor=90) TABLESPACE pg_default WHERE name = " + quoteLiteral(spec.ParameterPath), nil
}

func getIndexSchema(ctx context.Context, db *gorm.DB) (string, error) {
	var schema string
	err := db.WithContext(ctx).Raw("SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('device_parameters') AND c.relkind='r'").Scan(&schema).Error
	if err == nil && schema == "" {
		err = fmt.Errorf("%w: parameter table is unavailable", ErrIndexPolicy)
	}
	return schema, err
}

func readIndexCatalog(ctx context.Context, db *gorm.DB) ([]IndexCatalogEntry, error) {
	rows := []IndexCatalogEntry{}
	err := db.WithContext(ctx).Raw(`SELECT c.oid::bigint AS oid, n.nspname AS schema, c.relname AS name,
		t.relname AS table_name, am.amname AS method, i.indisprimary AS primary, i.indisunique AS unique,
		EXISTS(SELECT 1 FROM pg_constraint con WHERE con.conindid=c.oid) AS constraint,
		i.indisvalid AS valid, pg_relation_size(c.oid) AS size_bytes, COALESCE(s.idx_scan,0) AS scans,
		pg_get_indexdef(c.oid) AS definition, COALESCE(obj_description(c.oid,'pg_class'),'') AS comment,
		(c.reltablespace=0 AND d.dattablespace=(SELECT oid FROM pg_tablespace WHERE spcname='pg_default'))
		 OR c.reltablespace=(SELECT oid FROM pg_tablespace WHERE spcname='pg_default') AS default_storage
		FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
		JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam
		JOIN pg_database d ON d.datname=current_database()
		LEFT JOIN pg_stat_user_indexes s ON s.indexrelid=c.oid
		WHERE n.nspname=(SELECT n2.nspname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid=c2.relnamespace WHERE c2.oid=to_regclass('device_parameters'))
		ORDER BY pg_relation_size(c.oid) DESC, c.relname`).Scan(&rows).Error
	return rows, err
}

func indexOwned(c IndexCatalogEntry, name string, oid int64, definition, token string) bool {
	return managedIndexName.MatchString(name) && c.Name == name && oid != 0 && c.OID == oid && c.TableName == "device_parameters" && c.Method == "btree" && !c.Primary && !c.Unique && !c.Constraint && c.DefaultStorage && c.Definition == definition && token != "" && c.Comment == "acs-ui-index:"+token
}

func candidateMatches(c IndexCatalogEntry, m models.ManagedDatabaseIndex) bool {
	spec := IndexSpec{Label: m.Label, Purpose: m.Purpose, Recipe: m.Recipe, ParameterPath: m.ParameterPath}
	if ValidateIndexSpec(spec) != nil {
		return false
	}
	// A pending object can be recovered only under its cryptographically random,
	// pre-registered name and an exact approved definition. No prefix-based adoption.
	suffix := " USING btree (" + indexKey(spec) + ") WITH (fillfactor='90') WHERE (name = " + quoteLiteral(spec.ParameterPath) + "::text)"
	return managedIndexName.MatchString(m.CandidateName) && c.Name == m.CandidateName && c.TableName == "device_parameters" && c.Method == "btree" && !c.Primary && !c.Unique && !c.Constraint && c.DefaultStorage && strings.HasSuffix(c.Definition, suffix) && (m.CandidateOID == 0 || m.CandidateOID == c.OID) && (c.Comment == "" || c.Comment == "acs-ui-index:"+m.CandidateToken)
}

func GetIndexOverview(ctx context.Context, db *gorm.DB) (IndexOverview, error) {
	result := IndexOverview{Managed: []ManagedIndexView{}, Recipes: indexRecipes}
	var records []models.ManagedDatabaseIndex
	if err := db.WithContext(ctx).Order("id DESC").Find(&records).Error; err != nil {
		return result, err
	}
	catalog, err := readIndexCatalog(ctx, db)
	if err != nil {
		return result, err
	}
	result.Catalog = catalog
	byName := map[string]IndexCatalogEntry{}
	for _, c := range catalog {
		byName[c.Name] = c
	}
	budget := IndexBudget{MaxIndexBytes: ManagedIndexMaxBytes, MaxTotalBytes: ManagedIndexTotalBytes, MaxCount: ManagedIndexMaxCount, ReserveBytes: ManagedIndexReserve}
	for _, m := range records {
		c := byName[m.ActiveName]
		v := ManagedIndexView{ManagedDatabaseIndex: m, SizeBytes: c.SizeBytes, Scans: c.Scans, Valid: c.Valid, Owned: indexOwned(c, m.ActiveName, m.ActiveOID, m.ActiveDefinition, m.ActiveToken)}
		v.CleanupPending = m.CandidateName != "" && m.Status == "failed"
		if m.ActiveName == "" || c.Name == "" {
			v.Owned = true
		}
		budget.ManagedBytes += c.SizeBytes
		if m.CandidateName != "" {
			budget.ManagedBytes += byName[m.CandidateName].SizeBytes
			budget.ReservedBytes += ManagedIndexMaxBytes
		}
		result.Managed = append(result.Managed, v)
	}
	var probe struct {
		models.DatabaseIndexStorageProbe
		Fresh bool
	}
	if err := db.WithContext(ctx).Raw(`SELECT *, measured_at > clock_timestamp()-interval '35 seconds' AND measured_at <= clock_timestamp()+interval '2 seconds' AS fresh FROM database_index_storage_probes WHERE id=1`).Scan(&probe).Error; err != nil {
		return result, err
	}
	budget.FreeBytes = probe.FreeBytes
	budget.TotalBytes = probe.TotalBytes
	budget.MeasuredAt = probe.MeasuredAt
	budget.ProbeFresh = probe.Fresh && probe.TotalBytes > 0 && probe.FreeBytes >= 0 && probe.FreeBytes <= probe.TotalBytes
	budget.ReserveBytes = max(ManagedIndexReserve, probe.TotalBytes/5)
	switch {
	case !budget.ProbeFresh:
		budget.Reason = "A fresh disk reading from the PostgreSQL host is required. Check the PostgreSQL storage probe."
	case budget.FreeBytes-budget.ReserveBytes < 3*ManagedIndexMaxBytes+budget.ReservedBytes:
		budget.Reason = "Insufficient free disk space after reserving space for PostgreSQL, WAL and index construction."
	case budget.ManagedBytes+budget.ReservedBytes+ManagedIndexMaxBytes > ManagedIndexTotalBytes:
		budget.Reason = "The total UI index storage budget is reserved or exhausted."
	case len(records) >= ManagedIndexMaxCount:
		budget.Reason = "The maximum of eight UI index definitions has been reached."
	default:
		budget.CanCreate = true
	}
	result.Budget = budget
	var progress []struct {
		Name        string
		Phase       string
		BlocksTotal int64
		BlocksDone  int64
	}
	if err := db.WithContext(ctx).Raw(`SELECT c.relname AS name, p.phase, p.blocks_total, p.blocks_done FROM pg_stat_progress_create_index p LEFT JOIN pg_class c ON c.oid=p.index_relid WHERE p.datid=(SELECT oid FROM pg_database WHERE datname=current_database())`).Scan(&progress).Error; err != nil {
		return result, err
	}
	for i := range result.Managed {
		for _, p := range progress {
			if result.Managed[i].CandidateName != "" && p.Name == result.Managed[i].CandidateName {
				result.Managed[i].Phase = p.Phase
				result.Managed[i].BlocksTotal = p.BlocksTotal
				result.Managed[i].BlocksDone = p.BlocksDone
			}
		}
	}
	return result, nil
}

func PreviewManagedIndex(ctx context.Context, db *gorm.DB, spec IndexSpec, replacing int64) (IndexPreview, error) {
	var result IndexPreview
	if err := ValidateIndexSpec(spec); err != nil {
		return result, err
	}
	var defaultStorage bool
	if err := db.WithContext(ctx).Raw("SELECT dattablespace=(SELECT oid FROM pg_tablespace WHERE spcname='pg_default') FROM pg_database WHERE datname=current_database()").Scan(&defaultStorage).Error; err != nil {
		return result, err
	}
	if !defaultStorage {
		return result, fmt.Errorf("%w: DB indexes requires the monitored pg_default tablespace", ErrIndexPolicy)
	}
	// Non-superuser installations can have this cap installed by their DBA using
	// ALTER ROLE ... SET. Probe privilege inside a savepoint/transaction so a
	// rejected SET cannot poison the caller's transaction.
	if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var limit int64
		if err := tx.Raw("SELECT setting::bigint FROM pg_settings WHERE name='temp_file_limit'").Scan(&limit).Error; err != nil {
			return err
		}
		if limit >= 0 && limit <= 262144 {
			return nil
		}
		return tx.Exec("SET LOCAL temp_file_limit='262144kB'").Error
	}); err != nil {
		return result, fmt.Errorf("%w: PostgreSQL requires a temp_file_limit of at most 256 MiB for the ACS role; ask the database administrator to configure it", ErrIndexPolicy)
	}
	overview, err := GetIndexOverview(ctx, db)
	if err != nil {
		return result, err
	}
	result.Budget = overview.Budget
	// Editing does not consume a definition slot, but still needs replacement space.
	if !overview.Budget.CanCreate && !(replacing > 0 && len(overview.Managed) == ManagedIndexMaxCount && overview.Budget.Reason == "The maximum of eight UI index definitions has been reached.") {
		return result, fmt.Errorf("%w: %s", ErrIndexPolicy, overview.Budget.Reason)
	}
	for _, m := range overview.Managed {
		if m.ID != replacing && m.Recipe == spec.Recipe && m.ParameterPath == spec.ParameterPath {
			return result, fmt.Errorf("%w: this index definition already exists", ErrIndexPolicy)
		}
	}
	schema, err := getIndexSchema(ctx, db)
	if err != nil {
		return result, err
	}
	var raw string
	query := "EXPLAIN (FORMAT JSON) SELECT device_id FROM " + quoteIdentifier(schema) + `."device_parameters" WHERE name=` + quoteLiteral(spec.ParameterPath)
	if spec.Recipe == "parameter_freshness" {
		query += " ORDER BY updated_at DESC, device_id"
	}
	if err := db.WithContext(ctx).Raw(query).Row().Scan(&raw); err != nil {
		return result, err
	}
	var plan []struct {
		Plan struct {
			Rows float64 `json:"Plan Rows"`
			Type string  `json:"Node Type"`
		} `json:"Plan"`
	}
	if json.Unmarshal([]byte(raw), &plan) != nil || len(plan) != 1 {
		return result, fmt.Errorf("%w: cannot estimate query", ErrIndexPolicy)
	}
	var devices int64
	if err := db.WithContext(ctx).Model(&models.Device{}).Count(&devices).Error; err != nil {
		return result, err
	}
	result.EstimatedRows = int64(math.Ceil(math.Max(plan[0].Plan.Rows*2, float64(devices)*1.25)))
	// Fixed-width keys only, conservative overhead and at most one row per CPE/path.
	result.EstimatedBytes = max(1<<20, result.EstimatedRows*96)
	result.Plan = plan[0].Plan.Type
	if result.EstimatedBytes > ManagedIndexMaxBytes {
		return result, fmt.Errorf("%w: conservative size estimate exceeds 256 MiB per index", ErrIndexPolicy)
	}
	return result, nil
}

func newIndexIdentity() (string, string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", "", err
	}
	return "acs_ui_idx_" + hex.EncodeToString(b[:16]), hex.EncodeToString(b[16:]), nil
}

// QueueManagedIndex persists intent before any DDL. Both preview and mutation
// validate on the server; a forged request cannot bypass the policy.
func QueueManagedIndex(ctx context.Context, db *gorm.DB, id int64, spec IndexSpec, userID int64) (*models.ManagedDatabaseIndex, error) {
	if err := ValidateIndexSpec(spec); err != nil {
		return nil, err
	}
	var result models.ManagedDatabaseIndex
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", indexQueueLock).Error; err != nil {
			return err
		}
		if id > 0 {
			if err := tx.First(&result, id).Error; err != nil {
				return err
			}
			if result.Status == "queued" || result.Status == "building" || result.Status == "deleting" || result.CandidateName != "" {
				return ErrIndexBusy
			}
			if err := verifyActiveIndex(ctx, tx, result); err != nil {
				return err
			}
		}
		if _, err := PreviewManagedIndex(ctx, tx, spec, id); err != nil {
			return err
		}
		name, token, err := newIndexIdentity()
		if err != nil {
			return err
		}
		result.Label = strings.TrimSpace(spec.Label)
		result.Purpose = strings.TrimSpace(spec.Purpose)
		result.Recipe = spec.Recipe
		result.ParameterPath = spec.ParameterPath
		result.CandidateName = name
		result.CandidateToken = token
		result.CandidateOID = 0
		result.CandidateDefinition = ""
		result.CancelRequested = false
		result.Status = "queued"
		result.Message = "Queued for concurrent index creation."
		if id == 0 {
			result.CreatedBy = userID
			return tx.Create(&result).Error
		}
		return tx.Save(&result).Error
	})
	return &result, err
}

func verifyActiveIndex(ctx context.Context, db *gorm.DB, m models.ManagedDatabaseIndex) error {
	if m.ActiveName == "" {
		return nil
	}
	catalog, err := readIndexCatalog(ctx, db)
	if err != nil {
		return err
	}
	for _, c := range catalog {
		if c.Name == m.ActiveName {
			if indexOwned(c, m.ActiveName, m.ActiveOID, m.ActiveDefinition, m.ActiveToken) {
				return nil
			}
			return ErrIndexProtected
		}
	}
	// An index already removed in PostgreSQL has no object to modify.
	return nil
}

func RequestManagedIndexAction(ctx context.Context, db *gorm.DB, id int64, action string) error {
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", indexQueueLock).Error; err != nil {
			return err
		}
		var m models.ManagedDatabaseIndex
		if err := tx.First(&m, id).Error; err != nil {
			return err
		}
		if action == "cancel" {
			if m.Status != "queued" && m.Status != "building" {
				return ErrIndexBusy
			}
			return tx.Model(&m).Update("cancel_requested", true).Error
		}
		if action != "delete" {
			return ErrIndexPolicy
		}
		if m.CandidateName != "" || m.Status == "queued" || m.Status == "building" || m.Status == "deleting" {
			return ErrIndexBusy
		}
		if err := verifyActiveIndex(ctx, tx, m); err != nil {
			return err
		}
		return tx.Model(&m).Updates(map[string]any{"status": "deleting", "message": "Queued for removal from PostgreSQL."}).Error
	})
}

// DDL and its advisory lock must not occupy the application's connection pool:
// even a one-connection API pool must retain capacity for Inform/GPV and cancel.
type indexSession struct {
	*sql.Conn
	pool *sql.DB
}

func indexConnection(ctx context.Context, db *gorm.DB) (*indexSession, error) {
	dialector, ok := db.Dialector.(*postgres.Dialector)
	if !ok || dialector.Config == nil || dialector.DSN == "" {
		return nil, fmt.Errorf("%w: dedicated PostgreSQL index sessions are unavailable", ErrIndexPolicy)
	}
	driverName := dialector.DriverName
	if driverName == "" {
		driverName = "pgx"
	}
	pool, err := sql.Open(driverName, dialector.DSN)
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(1)
	pool.SetMaxIdleConns(0)
	conn, err := pool.Conn(ctx)
	if err != nil {
		_ = pool.Close()
		return nil, err
	}
	return &indexSession{Conn: conn, pool: pool}, nil
}

func closeIndexSession(conn *indexSession) {
	// MaxIdleConns(0) plus closing the private pool closes the physical session,
	// releases its advisory lock, and discards every session-level setting.
	_ = conn.Conn.Close()
	_ = conn.pool.Close()
}
