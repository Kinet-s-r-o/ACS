package cwmp

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestSessionCleanupFailsExpiredTaskAndPreservesActiveSession(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{
		DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var updates int
	if err := db.Callback().Update().After("gorm:update").Register("test:expired-session", func(tx *gorm.DB) {
		updates++
		sql := tx.Statement.SQL.String()
		if !strings.Contains(sql, "id = $4 AND status = $5 AND type <> $6") {
			t.Errorf("expiration must target only the sent non-download task: %s", sql)
		}
		vars := tx.Statement.Vars
		if len(vars) != 6 || vars[3] != int64(42) || vars[4] != models.TaskStatusSent || vars[5] != models.TaskTypeDownload {
			t.Errorf("unexpected expiration predicates: %v", vars)
		}
		values := tx.Statement.Dest.(map[string]interface{})
		if values["status"] != models.TaskStatusFailed || values["completed_at"] == nil || !strings.Contains(values["error_message"].(string), "session expired") {
			t.Errorf("expiration did not record a terminal timeout: %v", values)
		}
	}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(nil)
	h.taskRepo = database.NewTaskRepository(db)
	expired := h.sessions.GetOrCreate("expired", "TEST-EXPIRED")
	expired.CurrentTaskID = 42
	expired.State = StateProcessingTasks
	expired.LastActivity = time.Now().Add(-3 * time.Minute)
	active := h.sessions.GetOrCreate("active", "TEST-ACTIVE")
	active.CurrentTaskID = 43
	active.State = StateProcessingTasks
	idle := h.sessions.GetOrCreate("idle", "TEST-IDLE")
	idle.LastActivity = expired.LastActivity

	h.sessions.cleanup()
	if updates != 1 || h.sessions.Get(expired.ID) != nil || h.sessions.Get(idle.ID) != nil {
		t.Fatalf("expired sessions were not retired after one task update: updates=%d", updates)
	}
	if h.sessions.Get(active.ID) != active || active.CurrentTaskID != 43 {
		t.Fatal("cleanup changed an active task")
	}
}

func TestSessionCleanupRetriesFailedTaskUpdate(t *testing.T) {
	manager := &SessionManager{sessions: make(map[string]*Session), timeout: time.Minute}
	s := manager.GetOrCreate("retry", "TEST")
	s.CurrentTaskID = 42
	s.LastActivity = time.Now().Add(-2 * time.Minute)
	attempts := 0
	manager.expireTask = func(id int64) error {
		attempts++
		if id != 42 {
			t.Fatalf("unexpected task %d", id)
		}
		// The database operation must not hold the global session lock.
		manager.GetOrCreate("another-device", "OTHER")
		if attempts == 1 {
			return errors.New("database unavailable")
		}
		return nil
	}
	manager.cleanup()
	if manager.sessions[s.ID] != s || s.CurrentTaskID != 42 {
		t.Fatal("failed update discarded the task needed for retry")
	}
	manager.cleanup()
	if manager.sessions[s.ID] != nil || attempts != 2 {
		t.Fatalf("expiration was not retried successfully: attempts=%d", attempts)
	}
}

func TestSessionCleanupKeepsRefreshedSession(t *testing.T) {
	manager := &SessionManager{sessions: make(map[string]*Session), timeout: time.Minute}
	s := manager.GetOrCreate("refreshed", "TEST")
	s.LastActivity = time.Now().Add(-2 * time.Minute)
	manager.Get(s.ID)
	manager.expireTask = func(int64) error {
		t.Fatal("refreshed session must not expire")
		return nil
	}
	s.CurrentTaskID = 42
	manager.cleanup()
	if manager.Get(s.ID) != s || s.CurrentTaskID != 42 {
		t.Fatal("refreshed session was discarded")
	}
}
