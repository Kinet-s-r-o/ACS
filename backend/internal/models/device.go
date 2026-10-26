package models

import (
	"time"
)

type Device struct {
	ID                   int64             `json:"id" gorm:"primaryKey;autoIncrement"`
	SerialNumber         string            `json:"serial_number" gorm:"uniqueIndex:idx_devices_serial_number;not null"`
	OUI                  string            `json:"oui" gorm:"column:oui;not null"`
	Manufacturer         *string           `json:"manufacturer"`
	ProductClass         *string           `json:"product_class"`
	ModelName            *string           `json:"model_name"`
	HardwareVersion      *string           `json:"hardware_version"`
	SoftwareVersion      *string           `json:"software_version"`
	IPAddress            *string           `json:"ip_address"`
	ConnectionRequestURL *string           `json:"connection_request_url"`
	ConnCredMode         *string           `json:"conn_cred_mode" gorm:"column:conn_cred_mode"`
	ConnCredUsername     *string           `json:"conn_cred_username" gorm:"column:conn_cred_username"`
	ConnCredPassword     *string           `json:"conn_cred_password" gorm:"column:conn_cred_password"`
	Tags                 []string          `json:"tags" gorm:"type:jsonb;serializer:json"`
	LastInform           *time.Time        `json:"last_inform" gorm:"index:idx_devices_online_last_inform,priority:2"`
	LastOverviewRefresh  *time.Time        `json:"last_overview_refresh"`
	LastFullRefresh      *time.Time        `json:"last_full_refresh"`
	Online               bool              `json:"online" gorm:"default:false;index:idx_devices_online_last_inform,priority:1"`
	CreatedAt            time.Time         `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt            time.Time         `json:"updated_at" gorm:"autoUpdateTime"`
	Parameters           []DeviceParameter `json:"parameters,omitempty" gorm:"foreignKey:DeviceID"`
}

func (Device) TableName() string {
	return "devices"
}

type DeviceStats struct {
	Total   int `json:"total"`
	Online  int `json:"online"`
	Offline int `json:"offline"`
}

type WANInterface struct {
	SerialNumber string `json:"serial_number"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	Status       string `json:"status"`
	IPAddress    string `json:"ip_address"`
	MACAddress   string `json:"mac_address"`
}

type DeviceParameter struct {
	ID        int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	DeviceID  int64     `json:"device_id" gorm:"uniqueIndex:idx_device_parameters_unique,priority:1;not null"`
	Name      string    `json:"name" gorm:"uniqueIndex:idx_device_parameters_unique,priority:2;not null"`
	Value     string    `json:"value"`
	ValueType string    `json:"value_type,omitempty"`
	Writable  *bool     `json:"writable,omitempty"`
	UpdatedAt time.Time `json:"updated_at" gorm:"autoUpdateTime"`
}

func (DeviceParameter) TableName() string {
	return "device_parameters"
}
