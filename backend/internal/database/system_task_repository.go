package database

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type SystemTaskRepository struct{ db *gorm.DB }

type SystemTaskListItem struct {
	ID           int64                   `json:"id"`
	Type         models.SystemTaskType   `json:"type"`
	DeviceID     int64                   `json:"device_id"`
	SerialNumber string                  `json:"serial_number"`
	CWMPTaskID   *int64                  `json:"cwmp_task_id,omitempty"`
	Status       models.SystemTaskStatus `json:"status"`
	Attempts     int                     `json:"attempts"`
	ErrorMessage string                  `json:"error_message,omitempty"`
	CreatedBy    string                  `json:"created_by"`
	CreatedAt    time.Time               `json:"created_at"`
	CompletedAt  *time.Time              `json:"completed_at,omitempty"`
}

type SystemTaskCounts map[models.SystemTaskType]map[models.SystemTaskStatus]int64

func NewSystemTaskRepository(db *gorm.DB) *SystemTaskRepository {
	return &SystemTaskRepository{db: db}
}

func (r *SystemTaskRepository) CreateMany(ctx context.Context, tasks []models.SystemTask) error {
	if len(tasks) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(&tasks, 200).Error
}

func (r *SystemTaskRepository) ListPage(ctx context.Context, taskType models.SystemTaskType, limit, offset int, search, sort, direction string) ([]SystemTaskListItem, int, error) {
	query := r.db.WithContext(ctx).Table("system_tasks st").Joins("JOIN devices d ON d.id = st.device_id").Where("st.type = ?", taskType)
	query = applySearchTerms(query, search, []string{"d.serial_number", "st.created_by", "st.status", "st.error_message", "CAST(st.id AS TEXT)"})
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	sortColumns := map[string]string{
		"serial_number": "d.serial_number", "status": "st.status", "attempts": "st.attempts",
		"created_at": "st.created_at", "created_by": "st.created_by", "error": "st.error_message",
	}
	order := sortColumns[sort]
	if order == "" {
		order, direction = "st.created_at", "desc"
	}
	if direction != "asc" && direction != "desc" {
		return nil, 0, fmt.Errorf("invalid system task sort direction")
	}
	var items []SystemTaskListItem
	err := query.Select("st.id, st.type, st.device_id, d.serial_number, st.cwmp_task_id, st.status, st.attempts, st.error_message, st.created_by, st.created_at, st.completed_at").
		Order(order + " " + strings.ToUpper(direction) + " NULLS LAST").Order("st.id DESC").Limit(limit).Offset(offset).Scan(&items).Error
	return items, int(total), err
}

func (r *SystemTaskRepository) Counts(ctx context.Context) (SystemTaskCounts, error) {
	type row struct {
		Type   models.SystemTaskType   `gorm:"column:type"`
		Status models.SystemTaskStatus `gorm:"column:status"`
		Count  int64                   `gorm:"column:count"`
	}
	var rows []row
	if err := r.db.WithContext(ctx).Model(&models.SystemTask{}).Select("type, status, COUNT(*) AS count").Group("type, status").Scan(&rows).Error; err != nil {
		return nil, err
	}
	counts := SystemTaskCounts{
		models.SystemTaskTypeSummonFromCPE: {},
		models.SystemTaskTypeBulkSummon:    {},
	}
	for _, item := range rows {
		if counts[item.Type] == nil {
			counts[item.Type] = map[models.SystemTaskStatus]int64{}
		}
		counts[item.Type][item.Status] = item.Count
	}
	return counts, nil
}

func (r *SystemTaskRepository) ClaimNext(ctx context.Context, taskType models.SystemTaskType) (*models.SystemTask, error) {
	var claimed *models.SystemTask
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var task models.SystemTask
		err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("type = ? AND status = ?", taskType, models.SystemTaskStatusPending).
			Order("created_at ASC, id ASC").First(&task).Error
		if err == gorm.ErrRecordNotFound {
			return nil
		}
		if err != nil {
			return err
		}
		now := time.Now()
		result := tx.Model(&task).Where("id = ? AND status = ?", task.ID, models.SystemTaskStatusPending).
			Updates(map[string]interface{}{"status": models.SystemTaskStatusProcessing, "attempts": gorm.Expr("attempts + 1"), "started_at": now, "error_message": ""})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 1 {
			task.Status = models.SystemTaskStatusProcessing
			task.Attempts++
			task.StartedAt = &now
			claimed = &task
		}
		return nil
	})
	return claimed, err
}

func (r *SystemTaskRepository) Active(ctx context.Context, taskType models.SystemTaskType) ([]models.SystemTask, error) {
	var tasks []models.SystemTask
	err := r.db.WithContext(ctx).Where("type = ? AND status IN ?", taskType, []models.SystemTaskStatus{models.SystemTaskStatusProcessing, models.SystemTaskStatusWaiting}).Order("id ASC").Find(&tasks).Error
	return tasks, err
}

func (r *SystemTaskRepository) CountActive(ctx context.Context, taskType models.SystemTaskType) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.SystemTask{}).Where("type = ? AND status IN ?", taskType, []models.SystemTaskStatus{models.SystemTaskStatusProcessing, models.SystemTaskStatusWaiting}).Count(&count).Error
	return count, err
}

func (r *SystemTaskRepository) LastStartedAt(ctx context.Context, taskType models.SystemTaskType) (*time.Time, error) {
	var task models.SystemTask
	err := r.db.WithContext(ctx).Where("type = ? AND started_at IS NOT NULL", taskType).Order("started_at DESC").First(&task).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return task.StartedAt, nil
}

func (r *SystemTaskRepository) MarkWaiting(ctx context.Context, id int64, cwmpTaskID *int64, lastInformBefore *time.Time) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.SystemTask{}).Where("id = ?", id).Updates(map[string]interface{}{
		"status": models.SystemTaskStatusWaiting, "cwmp_task_id": cwmpTaskID, "dispatched_at": now, "last_inform_before": lastInformBefore, "error_message": "",
	}).Error
}

func (r *SystemTaskRepository) MarkCompleted(ctx context.Context, id int64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.SystemTask{}).Where("id = ?", id).Updates(map[string]interface{}{"status": models.SystemTaskStatusCompleted, "completed_at": now, "error_message": ""}).Error
}

func (r *SystemTaskRepository) MarkFailed(ctx context.Context, id int64, message string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.SystemTask{}).Where("id = ?", id).Updates(map[string]interface{}{"status": models.SystemTaskStatusFailed, "completed_at": now, "error_message": message}).Error
}

func (r *SystemTaskRepository) RetryFailed(ctx context.Context, id int64) (bool, error) {
	updated := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var systemTask models.SystemTask
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND status = ?", id, models.SystemTaskStatusFailed).First(&systemTask).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				return nil
			}
			return err
		}
		if systemTask.CWMPTaskID != nil {
			var task models.Task
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("status").First(&task, *systemTask.CWMPTaskID).Error; err != nil && err != gorm.ErrRecordNotFound {
				return err
			}
			if task.Status == models.TaskStatusPending || task.Status == models.TaskStatusSent {
				return fmt.Errorf("linked CWMP task is still active")
			}
		}
		result := tx.Model(&systemTask).Updates(map[string]interface{}{"status": models.SystemTaskStatusPending, "cwmp_task_id": nil, "started_at": nil, "dispatched_at": nil, "last_inform_before": nil, "completed_at": nil, "error_message": ""})
		if result.Error != nil {
			return result.Error
		}
		updated = result.RowsAffected == 1
		return nil
	})
	return updated, err
}

func (r *SystemTaskRepository) ClearFinished(ctx context.Context, taskType models.SystemTaskType) (int64, error) {
	result := r.db.WithContext(ctx).Where("type = ? AND status IN ?", taskType, []models.SystemTaskStatus{models.SystemTaskStatusCompleted, models.SystemTaskStatusFailed}).Delete(&models.SystemTask{})
	return result.RowsAffected, result.Error
}

func (r *SystemTaskRepository) RecoverProcessing(ctx context.Context) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.SystemTask{}).Where("status = ? AND cwmp_task_id IS NOT NULL", models.SystemTaskStatusProcessing).
			Update("status", models.SystemTaskStatusWaiting).Error; err != nil {
			return err
		}
		return tx.Model(&models.SystemTask{}).Where("status = ? AND cwmp_task_id IS NULL", models.SystemTaskStatusProcessing).
			Updates(map[string]interface{}{"status": models.SystemTaskStatusFailed, "error_message": "Worker stopped before sending the Connection Request. Retry this task if needed.", "completed_at": time.Now()}).Error
	})
}
