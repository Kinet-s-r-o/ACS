package database

import (
	"context"
	"fmt"

	"gorm.io/gorm"
)

type DatabaseQueryStat struct {
	QueryID          string  `json:"query_id"`
	Query            string  `json:"query"`
	Calls            int64   `json:"calls"`
	Rows             int64   `json:"rows"`
	TotalTimeMS      float64 `json:"total_time_ms"`
	MeanTimeMS       float64 `json:"mean_time_ms"`
	SharedHitBlocks  int64   `json:"shared_hit_blocks"`
	SharedReadBlocks int64   `json:"shared_read_blocks"`
	TempReadBlocks   int64   `json:"temp_read_blocks"`
	TempWriteBlocks  int64   `json:"temp_write_blocks"`
}

type DatabaseStatistics struct {
	Available  bool                `json:"available"`
	Reason     string              `json:"reason,omitempty"`
	StatsReset *string             `json:"stats_reset,omitempty"`
	Queries    []DatabaseQueryStat `json:"queries"`
}

// GetDatabaseStatistics reads per-query execution data only when the optional
// pg_stat_statements extension is installed in the current database.
func GetDatabaseStatistics(ctx context.Context, db *gorm.DB, sortBy string) (DatabaseStatistics, error) {
	result := DatabaseStatistics{Queries: make([]DatabaseQueryStat, 0)}
	var extension struct {
		Installed bool
		Loaded    bool
	}
	if err := db.WithContext(ctx).Raw(`SELECT
		EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed,
		'pg_stat_statements' = ANY(string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ',')) AS loaded`).Scan(&extension).Error; err != nil {
		return result, fmt.Errorf("check pg_stat_statements availability: %w", err)
	}
	if !extension.Installed {
		result.Reason = "pg_stat_statements is not installed in the current database"
		return result, nil
	}
	if !extension.Loaded {
		result.Reason = "pg_stat_statements is not active; enable it in shared_preload_libraries and restart PostgreSQL"
		return result, nil
	}

	result.Available = true
	var reset struct {
		At *string `gorm:"column:stats_reset"`
	}
	if err := db.WithContext(ctx).Raw("SELECT stats_reset::text AS stats_reset FROM pg_stat_statements_info").Scan(&reset).Error; err != nil {
		return result, fmt.Errorf("read pg_stat_statements reset time: %w", err)
	}
	result.StatsReset = reset.At

	orderBy := map[string]string{
		"total_time": "total_exec_time DESC",
		"mean_time":  "mean_exec_time DESC",
		"calls":      "calls DESC",
	}[sortBy]
	if orderBy == "" {
		orderBy = "total_exec_time DESC"
	}
	query := `SELECT COALESCE(queryid::text, '') AS query_id, COALESCE(LEFT(query, 4000), '') AS query, calls, rows,
		total_exec_time AS total_time_ms, mean_exec_time AS mean_time_ms,
		shared_blks_hit AS shared_hit_blocks, shared_blks_read AS shared_read_blocks,
		temp_blks_read AS temp_read_blocks, temp_blks_written AS temp_write_blocks
		FROM pg_stat_statements
		WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
		ORDER BY ` + orderBy + `
		LIMIT 50`
	if err := db.WithContext(ctx).Raw(query).Scan(&result.Queries).Error; err != nil {
		return result, fmt.Errorf("read pg_stat_statements: %w", err)
	}
	return result, nil
}
