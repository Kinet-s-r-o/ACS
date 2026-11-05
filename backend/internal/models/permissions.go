package models

import "strings"

// Full applies to one section only. Parents never grant access to descendants.
var PermissionActions = []string{"full", "read", "edit", "delete", "import", "export"}

type PermissionSection struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Parent string `json:"parent,omitempty"`
	Path   string `json:"path,omitempty"`
}

// Keep this tree aligned with menu entries, page tabs and nested tabs.
var PermissionSections = []PermissionSection{
	{"fleet", "Fleet status", "", "/"},
	{"inventory", "CPE inventory", "", "/devices"},
	{"inventory.cpes", "CPEs", "inventory", "/devices"},
	{"inventory.wans", "WANs", "inventory", "/devices?tab=wans"},
	{"inventory.cpes.overview", "Overview", "inventory.cpes", ""},
	{"inventory.cpes.overview.wifi", "Wi-Fi settings", "inventory.cpes.overview", ""},
	{"inventory.cpes.overview.wifi.general", "General", "inventory.cpes.overview.wifi", ""},
	{"inventory.cpes.overview.wifi.security", "Security", "inventory.cpes.overview.wifi", ""},
	{"inventory.cpes.overview.wifi.advanced", "Advanced", "inventory.cpes.overview.wifi", ""},
	{"inventory.cpes.overview.lan", "LAN settings", "inventory.cpes.overview", ""},
	{"inventory.cpes.overview.lan.general", "General", "inventory.cpes.overview.lan", ""},
	{"inventory.cpes.overview.lan.advanced", "Advanced", "inventory.cpes.overview.lan", ""},
	{"inventory.cpes.overview.wan", "WAN settings", "inventory.cpes.overview", ""},
	{"inventory.cpes.overview.wan.general", "General", "inventory.cpes.overview.wan", ""},
	{"inventory.cpes.overview.wan.ipv4", "IPv4", "inventory.cpes.overview.wan", ""},
	{"inventory.cpes.overview.wan.ipv6", "IPv6", "inventory.cpes.overview.wan", ""},
	{"inventory.cpes.overview.wan.advanced", "Advanced", "inventory.cpes.overview.wan", ""},
	{"inventory.cpes.hosts", "Connected Hosts", "inventory.cpes", ""},
	{"inventory.cpes.metrics", "Metrics", "inventory.cpes", ""},
	{"inventory.cpes.features", "Advanced settings", "inventory.cpes", ""},
	{"inventory.cpes.snapshots", "Snapshots", "inventory.cpes", ""},
	{"inventory.cpes.tasks", "Tasks", "inventory.cpes", ""},
	{"inventory.cpes.tasks.requested", "Requested", "inventory.cpes.tasks", ""},
	{"inventory.cpes.tasks.result", "Result", "inventory.cpes.tasks", ""},
	{"inventory.cpes.faults", "Faults", "inventory.cpes", ""},
	{"inventory.cpes.credentials", "Credentials", "inventory.cpes", ""},
	{"inventory.cpes.maintenance", "Maintenance", "inventory.cpes", ""},
	{"inventory.cpes.maintenance.diagnostic", "Diagnostic", "inventory.cpes.maintenance", ""},
	{"inventory.cpes.log", "Device log", "inventory.cpes", ""},
	{"tasks", "CWMP tasks", "", "/tasks"},
	{"tasks.requested", "Requested", "tasks", ""},
	{"tasks.result", "Result", "tasks", ""},
	{"faults", "CWMP faults", "", "/faults"},
	{"firmwares", "Firmware library", "", "/firmwares"},
	{"security", "Access controls", "", "/security"},
	{"security.audit", "Operator audit trail", "security", ""},
	{"security.blocklist", "Blocked CPEs", "security", ""},
	{"settings", "System settings", "", "/settings"},
	{"settings.metrics", "Metric definitions", "settings", ""},
	{"settings.metrics.metric", "Metric", "settings.metrics", ""},
	{"settings.metrics.health", "Health", "settings.metrics", ""},
	{"settings.general", "General", "settings", "/settings/general"},
	{"settings.general.general", "General", "settings.general", ""},
	{"settings.general.ui", "UI settings", "settings.general", ""},
	{"settings.general.aggregations", "Fleet aggregations", "settings.general", ""},
	{"settings.system_tasks", "System tasks", "settings", "/settings/system-tasks"},
	{"settings.system_tasks.summon_from_cpe", "Summon from CPE", "settings.system_tasks", ""},
	{"settings.system_tasks.bulk_summon", "Bulk summon", "settings.system_tasks", ""},
	{"settings.system_tasks.bulk_restart", "Bulk restart", "settings.system_tasks", ""},
	{"settings.database", "DB tools", "settings", "/settings/retention"},
	{"settings.database.retention", "Retention", "settings.database", ""},
	{"settings.database.statistics", "Statistics", "settings.database", ""},
	{"settings.database.indexes", "DB indexes", "settings.database", ""},
	{"settings.dictionaries", "Dictionaries", "settings", "/settings/dictionaries"},
	{"settings.dictionaries.tags", "Tags", "settings.dictionaries", ""},
	{"settings.users", "Users and Roles", "settings", "/settings/users"},
	{"settings.users.users", "Users", "settings.users", ""},
	{"settings.users.users.tokens", "API tokens", "settings.users.users", ""},
	{"settings.users.users.dashboards", "Fleet dashboards", "settings.users.users", ""},
	{"settings.users.roles", "Roles", "settings.users", ""},
	{"settings.authentication", "Authentication", "settings", "/settings/authentication"},
	{"settings.authentication.radius", "RADIUS", "settings.authentication", "/settings/authentication/radius"},
	{"settings.api_docs", "API documentation", "settings", "/settings/api-docs"},
	{"settings.delivery", "Delivery & Connection", "settings", "/settings/delivery"},
	{"settings.provisioning", "Provisioning", "settings", "/settings/provisioning"},
	{"settings.provisioning.templates", "Templates", "settings.provisioning", ""},
	{"settings.provisioning.rules", "Rules", "settings.provisioning", ""},
	{"settings.provisioning.variables", "Variables", "settings.provisioning", ""},
	{"settings.provisioning.metrics", "Metrics", "settings.provisioning", ""},
	{"settings.provisioning.metrics.general", "General Metrics", "settings.provisioning.metrics", ""},
	{"settings.provisioning.metrics.general.metric", "Metric", "settings.provisioning.metrics.general", ""},
	{"settings.provisioning.metrics.general.health", "Health", "settings.provisioning.metrics.general", ""},
	{"settings.provisioning.metrics.interface", "Per-interface metrics", "settings.provisioning.metrics", ""},
	{"settings.provisioning.metrics.polling", "Additional polling", "settings.provisioning.metrics", ""},
	{"settings.provisioning.features", "Advanced settings", "settings.provisioning", ""},
	{"settings.provisioning.cpe_detail", "CPE detail", "settings.provisioning", ""},
	{"settings.provisioning.cpe_detail.lan", "LAN ports", "settings.provisioning.cpe_detail", ""},
	{"settings.provisioning.cpe_detail.info", "CPE info", "settings.provisioning.cpe_detail", ""},
}

func PermissionKey(section, action string) string { return "access." + section + "." + action }

func permissionKeys(readOnly bool) []string {
	keys := []string{}
	for _, section := range PermissionSections {
		for _, action := range PermissionActions {
			if readOnly && (action != "read" || section.ID == "settings.database.statistics" || section.ID == "settings.database.indexes" || section.ID == "inventory.cpes.credentials") {
				continue
			}
			keys = append(keys, PermissionKey(section.ID, action))
		}
	}
	return keys
}

func HasSectionPermission(permissions []string, section, action string) bool {
	full, requested := PermissionKey(section, "full"), PermissionKey(section, action)
	read := action == "read" || action == "full"
	granted := false
	for _, key := range permissions {
		if key == full {
			return true
		}
		if key == requested {
			granted = true
		}
		if key == PermissionKey(section, "read") {
			read = true
		}
	}
	return granted && read
}

func CanVisitSection(permissions []string, section string) bool {
	for _, key := range permissions {
		if !strings.HasPrefix(key, "access."+section+".") {
			continue
		}
		index := strings.LastIndex(key, ".")
		action := key[index+1:]
		if (action == "read" || action == "full") && HasSectionPermission(permissions, key[7:index], "read") {
			return true
		}
	}
	return false
}

func IsSectionPermission(key string) bool {
	for _, valid := range AllPermissions {
		if key == valid {
			return true
		}
	}
	return false
}
