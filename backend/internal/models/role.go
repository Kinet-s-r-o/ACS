package models

import "time"

// Permission keys for granular access control.
const (
	PermUsersRead             = "users.read"
	PermAuthSettingsRead      = "auth.settings.read"
	PermAuthSettingsWrite     = "auth.settings.write"
	PermUsersWrite            = "users.write"
	PermRolesRead             = "roles.read"
	PermRolesWrite            = "roles.write"
	PermDevicesRead           = "devices.read"
	PermDevicesWrite          = "devices.write"
	PermDevicesCreate         = "devices.create"
	PermFirmwaresRead         = "firmwares.read"
	PermFirmwaresWrite        = "firmwares.write"
	PermFaultsRead            = "faults.read"
	PermFaultsWrite           = "faults.write"
	PermProvisioningRead      = "provisioning.read"
	PermProvisioningWrite     = "provisioning.write"
	PermSettingsRead          = "settings.read"
	PermSettingsWrite         = "settings.write"
	PermDatabaseStatsRead     = "database.stats.read"
	PermDatabaseIndexesRead   = "database.indexes.read"
	PermDatabaseIndexesWrite  = "database.indexes.write"
	PermMetricsRead           = "metrics.read"
	PermMetricsWrite          = "metrics.write"
	PermSecurityRead          = "security.read"
	PermSecurityWrite         = "security.write"
	PermDevicesConfigure      = "devices.configure"
	PermDevicesCommand        = "devices.command"
	PermDevicesReset          = "devices.reset"
	PermDevicesDelete         = "devices.delete"
	PermDevicesCredentials    = "devices.credentials"
	PermDevicesSnapshots      = "devices.snapshots.write"
	PermDevicesFirmware       = "devices.firmware"
	PermFirmwaresManage       = "firmwares.manage"
	PermUsersTokens           = "users.tokens"
	PermUsersDashboards       = "users.dashboards"
	PermProvisioningRules     = "provisioning.rules.write"
	PermProvisioningTemplates = "provisioning.templates.write"
	PermCWMPControl           = "cwmp.control"
)

// AllPermissions contains only the six section-scoped action types.
var AllPermissions = permissionKeys(false)

// ReadPermissions is the safe default for the built-in viewer.
var ReadPermissions = permissionKeys(true)

// Role represents a named role with a set of permissions.
type Role struct {
	ID          int64     `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"uniqueIndex;size:64;not null" json:"name"`
	Description string    `gorm:"size:256" json:"description"`
	Permissions []string  `gorm:"type:jsonb;serializer:json;default:'[]'" json:"permissions"`
	IsSystem    bool      `gorm:"default:false" json:"is_system"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (Role) TableName() string { return "roles" }

// CreateRoleRequest is the request body for creating a role.
type CreateRoleRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

// UpdateRoleRequest is the request body for updating a role.
type UpdateRoleRequest struct {
	Name        *string  `json:"name"`
	Description *string  `json:"description"`
	Permissions []string `json:"permissions"`
}
