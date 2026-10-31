package models

import "time"

type SystemTaskType string
type SystemTaskStatus string

const (
	SystemTaskTypeSummonFromCPE SystemTaskType = "summon_from_cpe"
	SystemTaskTypeBulkSummon    SystemTaskType = "bulk_summon"
)

const (
	SystemTaskStatusPending    SystemTaskStatus = "pending"
	SystemTaskStatusProcessing SystemTaskStatus = "processing"
	SystemTaskStatusWaiting    SystemTaskStatus = "waiting"
	SystemTaskStatusCompleted  SystemTaskStatus = "completed"
	SystemTaskStatusFailed     SystemTaskStatus = "failed"
)

type SystemTask struct {
	ID                int64            `json:"id" gorm:"primaryKey;autoIncrement"`
	Type              SystemTaskType   `json:"type" gorm:"type:text;not null;index:idx_system_tasks_type_status,priority:1"`
	DeviceID          int64            `json:"device_id" gorm:"not null;index"`
	RefreshParameters bool             `json:"refresh_parameters" gorm:"not null;default:false"`
	CWMPTaskID        *int64           `json:"cwmp_task_id,omitempty" gorm:"index"`
	Status            SystemTaskStatus `json:"status" gorm:"type:text;not null;default:'pending';index:idx_system_tasks_type_status,priority:2;index:idx_system_tasks_status_created,priority:1"`
	Attempts          int              `json:"attempts" gorm:"not null;default:0"`
	ErrorMessage      string           `json:"error_message,omitempty" gorm:"type:text"`
	CreatedBy         string           `json:"created_by" gorm:"size:128;not null"`
	StartedAt         *time.Time       `json:"started_at,omitempty"`
	DispatchedAt      *time.Time       `json:"dispatched_at,omitempty"`
	LastInformBefore  *time.Time       `json:"last_inform_before,omitempty"`
	CompletedAt       *time.Time       `json:"completed_at,omitempty"`
	CreatedAt         time.Time        `json:"created_at" gorm:"autoCreateTime;index:idx_system_tasks_status_created,priority:2,sort:desc"`
	UpdatedAt         time.Time        `json:"updated_at" gorm:"autoUpdateTime"`
}

func (SystemTask) TableName() string { return "system_tasks" }
