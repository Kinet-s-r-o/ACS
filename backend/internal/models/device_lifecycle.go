package models

import "time"

const (
	DeviceLifecycleRegistered = "registered"
	DeviceLifecycleDeleted    = "deleted"
)

type DeviceLifecycleEvent struct {
	ID           int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	DeviceID     int64     `json:"device_id" gorm:"not null;uniqueIndex:idx_device_lifecycle_device_type,priority:1"`
	SerialNumber string    `json:"serial_number" gorm:"size:256;not null"`
	EventType    string    `json:"event_type" gorm:"size:32;not null;uniqueIndex:idx_device_lifecycle_device_type,priority:2"`
	OccurredAt   time.Time `json:"occurred_at" gorm:"not null;index"`
}

func (DeviceLifecycleEvent) TableName() string {
	return "device_lifecycle_events"
}
