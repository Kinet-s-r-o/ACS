package models

import "time"

// DeviceSnapshot stores a point-in-time copy of the parameters known by SKYACS.
// Sensitive values are encrypted before they are serialized into Parameters.
type DeviceSnapshot struct {
	ID              int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	DeviceID        int64     `json:"device_id" gorm:"index;not null"`
	Name            string    `json:"name" gorm:"size:128;not null"`
	Manufacturer    *string   `json:"manufacturer,omitempty"`
	ProductClass    *string   `json:"product_class,omitempty"`
	SoftwareVersion *string   `json:"software_version,omitempty"`
	ParameterCount  int       `json:"parameter_count"`
	Parameters      JSON      `json:"parameters" gorm:"type:jsonb;not null"`
	CreatedBy       string    `json:"created_by,omitempty" gorm:"size:128"`
	CreatedAt       time.Time `json:"created_at" gorm:"autoCreateTime;index"`
}

func (DeviceSnapshot) TableName() string { return "device_snapshots" }

type SnapshotParameter struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	ValueType string `json:"value_type,omitempty"`
	Writable  *bool  `json:"writable,omitempty"`
}
