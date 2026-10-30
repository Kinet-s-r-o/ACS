package database

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

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

type DatabaseQueryFilter struct {
	Logic string                    `json:"logic"`
	Rules []DatabaseQueryFilterRule `json:"rules"`
}

type DatabaseQueryFilterRule struct {
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

var databaseQueryFilterColumns = map[string]struct {
	expression string
	numeric    bool
}{
	"query":              {"COALESCE(query, '')", false},
	"calls":              {"calls", true},
	"total_time":         {"total_exec_time", true},
	"mean_time":          {"mean_exec_time", true},
	"rows":               {"rows", true},
	"shared_read_blocks": {"shared_blks_read", true},
	"shared_hit_blocks":  {"shared_blks_hit", true},
	"temp_blocks":        {"(temp_blks_read + temp_blks_written)", true},
}

func ParseDatabaseQueryFilters(raw string) (map[string]DatabaseQueryFilter, error) {
	filters := make(map[string]DatabaseQueryFilter)
	if raw == "" {
		return filters, nil
	}
	if err := json.Unmarshal([]byte(raw), &filters); err != nil {
		return nil, fmt.Errorf("invalid query filters: %w", err)
	}
	if len(filters) > 8 {
		return nil, fmt.Errorf("too many query filter columns")
	}
	return filters, nil
}

func ValidateDatabaseQueryFilters(filters map[string]DatabaseQueryFilter) error {
	if len(filters) > len(databaseQueryFilterColumns) {
		return fmt.Errorf("too many query filter columns")
	}
	for key, filter := range filters {
		column, ok := databaseQueryFilterColumns[key]
		if !ok || len(filter.Rules) == 0 || len(filter.Rules) > 8 || (filter.Logic != "all" && filter.Logic != "any") {
			return fmt.Errorf("invalid query filter for %q", key)
		}
		for _, rule := range filter.Rules {
			if len(rule.Value) > 256 || strings.TrimSpace(rule.Value) == "" {
				return fmt.Errorf("invalid query filter value")
			}
			switch rule.Operator {
			case "contains", "not_contains", "starts_with", "ends_with", "equals":
			case "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal":
				if !column.numeric {
					return fmt.Errorf("numeric operator is invalid for %q", key)
				}
				value, err := strconv.ParseFloat(rule.Value, 64)
				if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
					return fmt.Errorf("invalid numeric filter value")
				}
			default:
				return fmt.Errorf("invalid query filter operator")
			}
		}
	}
	return nil
}

// GetDatabaseStatistics reads per-query execution data only when the optional
// pg_stat_statements extension is installed in the current database.
func GetDatabaseStatistics(ctx context.Context, db *gorm.DB, sortBy, direction string, filters map[string]DatabaseQueryFilter) (DatabaseStatistics, error) {
	result := DatabaseStatistics{Queries: make([]DatabaseQueryStat, 0)}
	if err := ValidateDatabaseQueryFilters(filters); err != nil {
		return result, err
	}
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

	orderColumn := map[string]string{
		"query":              "query",
		"calls":              "calls",
		"total_time":         "total_exec_time",
		"mean_time":          "mean_exec_time",
		"rows":               "rows",
		"shared_read_blocks": "shared_blks_read",
		"shared_hit_blocks":  "shared_blks_hit",
		"temp_blocks":        "(temp_blks_read + temp_blks_written)",
	}[sortBy]
	if orderColumn == "" {
		orderColumn = "total_exec_time"
	}
	orderDirection := map[string]string{"asc": "ASC", "desc": "DESC"}[direction]
	if orderDirection == "" {
		orderDirection = "DESC"
	}
	query := `SELECT COALESCE(queryid::text, '') AS query_id, COALESCE(LEFT(query, 4000), '') AS query, calls, rows,
		total_exec_time AS total_time_ms, mean_exec_time AS mean_time_ms,
		shared_blks_hit AS shared_hit_blocks, shared_blks_read AS shared_read_blocks,
		temp_blks_read AS temp_read_blocks, temp_blks_written AS temp_write_blocks
		FROM pg_stat_statements
		WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`
	args := make([]interface{}, 0)
	conditions := make([]string, 0, len(filters))
	for key, filter := range filters {
		column := databaseQueryFilterColumns[key]
		logic := " AND "
		if filter.Logic == "any" {
			logic = " OR "
		}
		parts := make([]string, 0, len(filter.Rules))
		for _, rule := range filter.Rules {
			operator := ""
			value := escapeLike(rule.Value)
			switch rule.Operator {
			case "contains":
				operator, value = "ILIKE", "%"+value+"%"
			case "not_contains":
				operator, value = "NOT ILIKE", "%"+value+"%"
			case "starts_with":
				operator, value = "ILIKE", value+"%"
			case "ends_with":
				operator, value = "ILIKE", "%"+value
			case "equals":
				operator = "ILIKE"
			case "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal":
				numericOperator := map[string]string{
					"greater_than": ">", "greater_than_or_equal": ">=", "less_than": "<", "less_than_or_equal": "<=",
				}[rule.Operator]
				parts = append(parts, "("+column.expression+")::numeric "+numericOperator+" ?::numeric")
				args = append(args, rule.Value)
				continue
			default:
				return result, fmt.Errorf("invalid query filter operator")
			}
			parts = append(parts, column.expression+"::text "+operator+" ? ESCAPE '!'")
			args = append(args, value)
		}
		conditions = append(conditions, "("+strings.Join(parts, logic)+")")
	}
	if len(conditions) > 0 {
		query += " AND " + strings.Join(conditions, " AND ")
	}
	query += `
		ORDER BY ` + orderColumn + ` ` + orderDirection + `
		LIMIT 50`
	if err := db.WithContext(ctx).Raw(query, args...).Scan(&result.Queries).Error; err != nil {
		return result, fmt.Errorf("read pg_stat_statements: %w", err)
	}
	return result, nil
}
