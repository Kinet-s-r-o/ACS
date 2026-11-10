package database

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestSystemTaskClearRejectsUnsafeStatusesBeforeDatabaseAccess(t *testing.T) {
	for _, statuses := range [][]models.SystemTaskStatus{nil, {models.SystemTaskStatusProcessing}, {models.SystemTaskStatusPending, models.SystemTaskStatusWaiting}, {"unknown"}} {
		if _, err := (&SystemTaskRepository{}).ClearStatuses(context.Background(), models.SystemTaskTypeBulkSummon, statuses, "operator"); err == nil {
			t.Fatalf("accepted unsafe selection %v", statuses)
		}
	}
}

func TestSystemTaskClearCancelsOnlyUnsentLinkedRequests(t *testing.T) {
	for _, failCancellation := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancellation-fails=%v", failCancellation), func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotTestConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			pendingID, sentID := int64(11), int64(12)
			var cancelled, deleted []int64
			failure := errors.New("CWMP cancellation failed")
			if err := db.Callback().Query().After("gorm:query").Register("test:clear-queue", func(tx *gorm.DB) {
				if !strings.Contains(tx.Statement.SQL.String(), "FOR UPDATE") {
					t.Error("queue rows were not locked against dispatch")
				}
				switch records := tx.Statement.Dest.(type) {
				case *[]models.SystemTask:
					*records = []models.SystemTask{
						{ID: 1, Status: models.SystemTaskStatusPending},
						{ID: 2, Status: models.SystemTaskStatusPending, CWMPTaskID: &pendingID},
						{ID: 3, Status: models.SystemTaskStatusPending, CWMPTaskID: &sentID},
						{ID: 4, Status: models.SystemTaskStatusFailed},
					}
				case *[]models.Task:
					*records = []models.Task{{ID: pendingID, Status: models.TaskStatusPending}, {ID: sentID, Status: models.TaskStatusSent}}
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Update().After("gorm:update").Register("test:cancel-cwmp", func(tx *gorm.DB) {
				for _, value := range tx.Statement.Vars {
					if id, ok := value.(int64); ok {
						cancelled = append(cancelled, id)
					}
				}
				if tx.Statement.Dest.(map[string]interface{})["status"] != models.TaskStatusDeleted {
					t.Error("linked request was not cancelled")
				}
				if tx.Statement.Dest.(map[string]interface{})["deleted_by"] != "operator" {
					t.Error("cancellation actor was not recorded")
				}
				if failCancellation {
					tx.AddError(failure)
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Delete().After("gorm:delete").Register("test:delete-system", func(tx *gorm.DB) {
				for _, value := range tx.Statement.Vars {
					if id, ok := value.(int64); ok {
						deleted = append(deleted, id)
					}
				}
				tx.RowsAffected = int64(len(deleted))
			}); err != nil {
				t.Fatal(err)
			}
			result, err := NewSystemTaskRepository(db).ClearStatuses(context.Background(), models.SystemTaskTypeBulkSummon, []models.SystemTaskStatus{models.SystemTaskStatusPending, models.SystemTaskStatusFailed}, "operator")
			if !slices.Equal(cancelled, []int64{11}) {
				t.Fatalf("cancelled sent or unrelated requests: %v", cancelled)
			}
			if failCancellation {
				if !errors.Is(err, failure) || result != (SystemTaskClearResult{}) || len(deleted) != 0 {
					t.Fatalf("deleted records despite failed cancellation: %+v %v ids=%v", result, err, deleted)
				}
			} else if err != nil || result.Deleted != 3 || result.Skipped != 1 || !slices.Equal(deleted, []int64{1, 2, 4}) {
				t.Fatalf("incorrect deletion: result=%+v ids=%v error=%v", result, deleted, err)
			}
		})
	}
}

func clearSystemTasksTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping isolated PostgreSQL queue tests")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	base, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot connect to test PostgreSQL")
	}
	schema := fmt.Sprintf("task_clear_test_%d", time.Now().UnixNano())
	if err := base.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { base.Exec("DROP SCHEMA " + schema + " CASCADE"); pool, _ := base.DB(); pool.Close() })
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := gorm.Open(postgres.Open(parsed.String()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("cannot connect to isolated test schema")
	}
	t.Cleanup(func() { pool, _ := db.DB(); pool.Close() })
	// No AutoMigrate, primary keys or indexes: only isolated test tables.
	for _, statement := range []string{
		"CREATE TABLE system_tasks (id bigint, type text, status text, cwmp_task_id bigint)",
		"CREATE TABLE tasks (id bigint, status text, completed_at timestamptz, error_message text, deleted_by text)",
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestSystemTaskClearPostgresPreservesActiveAndUnselectedTasks(t *testing.T) {
	db := clearSystemTasksTestDB(t)
	if err := db.Exec(`INSERT INTO tasks(id,status) VALUES (11,'pending'),(12,'sent'),(13,'completed')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO system_tasks VALUES
		(1,'bulk_summon','pending',NULL),(2,'bulk_summon','pending',11),
		(3,'bulk_summon','pending',12),(4,'bulk_summon','completed',13),
		(5,'bulk_summon','failed',NULL),(6,'bulk_summon','processing',NULL),
		(7,'bulk_summon','waiting',NULL),(8,'bulk_restart','pending',NULL)`).Error; err != nil {
		t.Fatal(err)
	}
	result, err := NewSystemTaskRepository(db).ClearStatuses(context.Background(), models.SystemTaskTypeBulkSummon, []models.SystemTaskStatus{models.SystemTaskStatusPending, models.SystemTaskStatusFailed}, "operator")
	if err != nil || result.Deleted != 3 || result.Skipped != 1 {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	var ids []int64
	if err := db.Model(&models.SystemTask{}).Order("id").Pluck("id", &ids).Error; err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ids, []int64{3, 4, 6, 7, 8}) {
		t.Fatalf("wrong tasks retained: %v", ids)
	}
	var linked []models.Task
	if err := db.Select("id", "status").Order("id").Find(&linked).Error; err != nil {
		t.Fatal(err)
	}
	if linked[0].Status != models.TaskStatusDeleted || linked[1].Status != models.TaskStatusSent || linked[2].Status != models.TaskStatusCompleted {
		t.Fatalf("incorrect linked task statuses: %+v", linked)
	}
	// Repeated deletion never dispatches or deletes the already-sent CWMP task.
	result, err = NewSystemTaskRepository(db).ClearStatuses(context.Background(), models.SystemTaskTypeBulkSummon, []models.SystemTaskStatus{models.SystemTaskStatusPending}, "operator")
	if err != nil || result.Deleted != 0 || result.Skipped != 1 {
		t.Fatalf("repeat result=%+v error=%v", result, err)
	}
}

func TestSystemTaskClearPostgresKeepsTaskClaimedByWorker(t *testing.T) {
	db := clearSystemTasksTestDB(t)
	if err := db.Exec("INSERT INTO system_tasks VALUES (1,'bulk_summon','pending',NULL)").Error; err != nil {
		t.Fatal(err)
	}
	worker := db.Begin()
	if worker.Error != nil {
		t.Fatal(worker.Error)
	}
	defer worker.Rollback()
	if err := worker.Exec("UPDATE system_tasks SET status='processing' WHERE id=1").Error; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type outcome struct {
		result SystemTaskClearResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := NewSystemTaskRepository(db).ClearStatuses(ctx, models.SystemTaskTypeBulkSummon, []models.SystemTaskStatus{models.SystemTaskStatusPending}, "operator")
		done <- outcome{result, err}
	}()
	if err := worker.Commit().Error; err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil || got.result.Deleted != 0 {
		t.Fatalf("deleted a claimed task: %+v %v", got.result, got.err)
	}
	var task models.SystemTask
	if err := db.First(&task, 1).Error; err != nil || task.Status != models.SystemTaskStatusProcessing {
		t.Fatalf("claimed task was changed: %+v %v", task, err)
	}
}

func TestSystemTaskClearPostgresRollsBackWhenLinkedCancellationFails(t *testing.T) {
	db := clearSystemTasksTestDB(t)
	for _, statement := range []string{
		"ALTER TABLE tasks ADD CONSTRAINT reject_cancellation CHECK (status <> 'deleted')",
		"INSERT INTO tasks(id,status) VALUES (11,'pending')",
		"INSERT INTO system_tasks VALUES (1,'bulk_summon','pending',11)",
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	result, err := NewSystemTaskRepository(db).ClearStatuses(context.Background(), models.SystemTaskTypeBulkSummon, []models.SystemTaskStatus{models.SystemTaskStatusPending}, "operator")
	if err == nil || result.Deleted != 0 {
		t.Fatalf("cancellation failure reported success: %+v %v", result, err)
	}
	var systemTask models.SystemTask
	if err := db.First(&systemTask, 1).Error; err != nil || systemTask.Status != models.SystemTaskStatusPending {
		t.Fatalf("system task was removed on failure: %+v %v", systemTask, err)
	}
	var linked models.Task
	if err := db.Select("id", "status").First(&linked, 11).Error; err != nil || linked.Status != models.TaskStatusPending {
		t.Fatalf("CWMP task was changed on failure: %+v %v", linked, err)
	}
}
