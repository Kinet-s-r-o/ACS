package models

import "strings"

// The catalog follows operator tasks. Child screens use their owning section.
var PermissionActions = []string{"full", "add", "read", "write", "edit", "delete", "remove", "import", "export"}

type PermissionSection struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Parent  string   `json:"parent,omitempty"`
	Path    string   `json:"path,omitempty"`
	Actions []string `json:"actions"`
}

var PermissionSections = []PermissionSection{
	{"fleet", "Fleet status", "", "/", []string{"full", "add", "read", "edit", "delete"}},
	{"inventory", "CPE inventory", "", "/devices", []string{"full", "add", "read", "write", "export"}},
	{"cpe", "CPE overview", "", "", []string{"full", "read", "write", "delete", "export"}},
	{"tasks", "CWMP tasks", "", "/tasks", []string{"full", "read", "delete", "export"}},
	{"faults", "CWMP faults", "", "/faults", []string{"full", "read", "write", "delete", "export"}},
	{"firmwares", "Firmware library", "", "/firmwares", []string{"full", "read", "write", "delete"}},
	{"security", "Access controls", "", "", []string{}},
	{"security.blocklist", "Device block list", "security", "/security", []string{"full", "read", "add", "remove"}},
	{"security.audit", "Operator audit", "security", "/security?tab=audit", []string{"read"}},
	{"settings", "System settings", "", "", []string{}},
	{"settings.general", "General", "settings", "/settings/general", []string{"full", "read", "write"}},
	{"settings.system_tasks", "System tasks", "settings", "/settings/system-tasks", []string{"full", "read", "write", "delete"}},
	{"settings.database", "DB tools", "settings", "/settings/retention", []string{"full", "read", "write", "delete"}},
	{"settings.dictionaries", "Dictionaries", "settings", "/settings/dictionaries", []string{"full", "read", "write", "delete", "export"}},
	{"settings.users", "Users and Roles", "settings", "/settings/users", []string{"full", "read", "write", "delete", "import", "export"}},
	{"settings.authentication", "Authentication", "settings", "/settings/authentication", []string{"full", "read", "write"}},
	{"settings.delivery", "Delivery & connection", "settings", "/settings/delivery", []string{"full", "read", "write"}},
	{"settings.provisioning", "Provisioning", "settings", "/settings/provisioning", []string{"full", "read", "write", "delete"}},
	{"settings.api_docs", "API documentation", "settings", "/settings/api-docs", []string{"full", "read", "write"}},
}

// CanonicalPermission adapts internal screen IDs; saved roles accept catalog keys only.
func CanonicalPermission(section, action string) (string, string) {
	original := section
	switch {
	case strings.HasPrefix(section, "inventory.cpes."):
		section = "cpe"
	case section == "inventory" || strings.HasPrefix(section, "inventory."):
		section = "inventory"
	case strings.HasPrefix(section, "tasks."):
		section = "tasks"
	case strings.HasPrefix(section, "settings.metrics"):
		section = "settings.provisioning"
	default:
		for _, parent := range []string{"fleet", "cpe", "faults", "firmwares", "security.blocklist", "security.audit", "settings.general", "settings.system_tasks", "settings.database", "settings.dictionaries", "settings.users", "settings.authentication", "settings.delivery", "settings.provisioning", "settings.api_docs"} {
			if strings.HasPrefix(section, parent+".") {
				section = parent
				break
			}
		}
	}
	if action == "edit" && section != "fleet" {
		action = "write"
	}
	if section == "security.blocklist" {
		if action == "write" {
			action = "add"
		}
		if action == "delete" {
			action = "remove"
		}
	}
	if original == "inventory.cpes" && action == "delete" {
		section = "cpe"
	}
	if strings.HasPrefix(original, "inventory.cpes.tasks") && action == "delete" {
		section = "tasks"
	}
	if strings.HasPrefix(original, "inventory.cpes.faults") && action != "read" {
		section = "faults"
	}
	// Snapshot deletion is not the Delete CPE action.
	if original == "inventory.cpes.snapshots" && action == "delete" {
		action = "full"
	}
	return section, action
}

func PermissionKey(section, action string) string { return "access." + section + "." + action }

func permissionKeys(readOnly bool) []string {
	keys := []string{}
	for _, section := range PermissionSections {
		for _, action := range section.Actions {
			if !readOnly || action == "read" {
				keys = append(keys, PermissionKey(section.ID, action))
			}
		}
	}
	return keys
}

func HasSectionPermission(permissions []string, section, action string) bool {
	section, action = CanonicalPermission(section, action)
	if section == "security" && action == "read" {
		return HasSectionPermission(permissions, "security.blocklist", "read") || HasSectionPermission(permissions, "security.audit", "read")
	}
	full, requested := PermissionKey(section, "full"), PermissionKey(section, action)
	read, granted := action == "read" || action == "full", false
	for _, key := range permissions {
		if key == full && IsSectionPermission(full) {
			return true
		}
		if key == requested && IsSectionPermission(requested) {
			granted = true
		}
		if key == PermissionKey(section, "read") {
			read = true
		}
	}
	return granted && read
}

func CanVisitSection(permissions []string, section string) bool {
	section, _ = CanonicalPermission(section, "read")
	if HasSectionPermission(permissions, section, "read") {
		return true
	}
	for _, entry := range PermissionSections {
		if strings.HasPrefix(entry.ID, section+".") && HasSectionPermission(permissions, entry.ID, "read") {
			return true
		}
	}
	return false
}

func IsSectionPermission(key string) bool {
	for _, section := range PermissionSections {
		for _, action := range section.Actions {
			if key == PermissionKey(section.ID, action) {
				return true
			}
		}
	}
	return false
}
