package database

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/callbacks"
	"gorm.io/gorm/logger"
)

func TestSystemTaskFiltersApplyBeforeCountAndPagination(t *testing.T) {
	for _, taskType := range []models.SystemTaskType{models.SystemTaskTypeSummonFromCPE, models.SystemTaskTypeBulkSummon, models.SystemTaskTypeBulkRestart} {
		t.Run(string(taskType), func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DisableAutomaticPing: true, SkipDefaultTransaction: true, Logger: logger.Default.LogMode(logger.Silent)})
			if err != nil {
				t.Fatal(err)
			}
			var statements []string
			capture := func(tx *gorm.DB) {
				callbacks.BuildQuerySQL(tx)
				statements = append(statements, tx.Statement.SQL.String())
			}
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				capture(tx)
				*tx.Statement.Dest.(*int64) = 7
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}
			stopBeforeExecution := errors.New("stop before executing page query")
			if err := db.Callback().Row().Replace("gorm:row", func(tx *gorm.DB) {
				capture(tx)
				tx.AddError(stopBeforeExecution)
			}); err != nil {
				t.Fatal(err)
			}
			filters := map[string]TableColumnFilter{
				"status":       {Logic: "any", Rules: []TableFilterRule{{Operator: "equals", Value: "failed"}, {Operator: "equals", Value: "waiting"}}},
				"attempts":     {Logic: "all", Rules: []TableFilterRule{{Operator: "greater_than", Value: "1"}}},
				"id":           {Logic: "all", Rules: []TableFilterRule{{Operator: "less_than", Value: "100"}}},
				"cwmp_task_id": {Logic: "all", Rules: []TableFilterRule{{Operator: "greater_than_or_equal", Value: "10"}}},
			}
			_, total, err := NewSystemTaskRepository(db).ListPage(context.Background(), taskType, 20, 40, "serial", "created_at", "desc", filters)
			if !errors.Is(err, stopBeforeExecution) || total != 7 || len(statements) != 2 {
				t.Fatalf("total=%d statements=%d error=%v", total, len(statements), err)
			}
			for _, sql := range statements {
				for _, fragment := range []string{"st.type = $", "d.serial_number", "st.status", " OR ", "(st.attempts) > $", "(st.id) < $", "(st.cwmp_task_id) >= $"} {
					if !strings.Contains(sql, fragment) {
						t.Fatalf("query missing %q: %s", fragment, sql)
					}
				}
			}
			if strings.Contains(statements[0], "LIMIT") || !strings.Contains(statements[1], "LIMIT $") || !strings.Contains(statements[1], "OFFSET $") {
				t.Fatalf("pagination applied incorrectly: %v", statements)
			}
		})
	}
}
