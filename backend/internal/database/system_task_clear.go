package database

import (
	"context"
	"errors"
	"slices"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func ValidateSystemTaskClearStatuses(statuses []models.SystemTaskStatus) error {
	if len(statuses) == 0 || len(statuses) > 3 {
		return errors.New("select at least one of pending, completed or failed")
	}
	for _, status := range statuses {
		if status != models.SystemTaskStatusPending && status != models.SystemTaskStatusCompleted && status != models.SystemTaskStatusFailed {
			return errors.New("only pending, completed and failed system tasks can be deleted")
		}
	}
	return nil
}

type SystemTaskClearResult struct {
	Deleted int64 `json:"deleted"`
	Skipped int64 `json:"skipped"`
}

func (r *SystemTaskRepository) ClearStatuses(ctx context.Context, taskType models.SystemTaskType, statuses []models.SystemTaskStatus, actor string) (SystemTaskClearResult, error) {
	result := SystemTaskClearResult{}
	if err := ValidateSystemTaskClearStatuses(statuses); err != nil {
		return result, err
	}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// ClaimNext uses the same row lock: a task cannot be dispatched while
		// it is being removed. Processing and waiting records never match.
		var tasks []models.SystemTask
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id", "status", "cwmp_task_id").
			Where("type = ? AND status IN ?", taskType, statuses).Order("id ASC").Find(&tasks).Error; err != nil {
			return err
		}
		var linkedIDs []int64
		for _, task := range tasks {
			if task.Status == models.SystemTaskStatusPending && task.CWMPTaskID != nil {
				linkedIDs = append(linkedIDs, *task.CWMPTaskID)
			}
		}
		slices.Sort(linkedIDs)
		linkedIDs = slices.Compact(linkedIDs)
		linkedStatuses := make(map[int64]models.TaskStatus)
		for start := 0; start < len(linkedIDs); start += 1000 {
			var linked []models.Task
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id", "status").
				Where("id IN ?", linkedIDs[start:min(start+1000, len(linkedIDs))]).Order("id ASC").Find(&linked).Error; err != nil {
				return err
			}
			for _, task := range linked {
				linkedStatuses[task.ID] = task.Status
			}
		}
		var ids, cancelIDs []int64
		for _, task := range tasks {
			if task.Status == models.SystemTaskStatusPending && task.CWMPTaskID != nil {
				status := linkedStatuses[*task.CWMPTaskID]
				if status == models.TaskStatusSent {
					result.Skipped++
					continue
				}
				if status == models.TaskStatusPending {
					cancelIDs = append(cancelIDs, *task.CWMPTaskID)
				}
			}
			ids = append(ids, task.ID)
		}
		for start := 0; start < len(cancelIDs); start += 1000 {
			if _, err := NewTaskRepository(tx).MarkPendingDeletedMany(ctx, cancelIDs[start:min(start+1000, len(cancelIDs))], actor); err != nil {
				return err
			}
		}
		for start := 0; start < len(ids); start += 1000 {
			deleted := tx.Where("id IN ? AND type = ? AND status IN ?", ids[start:min(start+1000, len(ids))], taskType, statuses).Delete(&models.SystemTask{})
			if deleted.Error != nil {
				return deleted.Error
			}
			result.Deleted += deleted.RowsAffected
		}
		return nil
	})
	if err != nil {
		return SystemTaskClearResult{}, err
	}
	return result, nil
}
