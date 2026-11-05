package models

import (
	"slices"
	"testing"
)

func TestOperatorPermissionCatalog(t *testing.T) {
	want := map[string][]string{
		"fleet": {"full", "add", "read", "edit", "delete"}, "inventory": {"full", "add", "read", "write", "export"},
		"cpe": {"full", "read", "write", "delete", "export"}, "tasks": {"full", "read", "delete", "export"},
		"faults": {"full", "read", "write", "delete", "export"}, "firmwares": {"full", "read", "write", "delete"},
		"security": {}, "security.blocklist": {"full", "read", "add", "remove"}, "security.audit": {"read"}, "settings": {},
		"settings.general": {"full", "read", "write"}, "settings.system_tasks": {"full", "read", "write", "delete"},
		"settings.database": {"full", "read", "write", "delete"}, "settings.dictionaries": {"full", "read", "write", "delete", "export"},
		"settings.users": {"full", "read", "write", "delete", "import", "export"}, "settings.authentication": {"full", "read", "write"},
		"settings.delivery": {"full", "read", "write"}, "settings.provisioning": {"full", "read", "write", "delete"}, "settings.api_docs": {"full", "read", "write"},
	}
	if len(want) != len(PermissionSections) {
		t.Fatal("catalog section count changed")
	}
	total := 0
	for _, section := range PermissionSections {
		if !slices.Equal(section.Actions, want[section.ID]) {
			t.Fatalf("unexpected actions for %s", section.ID)
		}
		total += len(section.Actions)
	}
	if len(AllPermissions) != total {
		t.Fatal("catalog includes unsupported actions")
	}
}

func TestSectionInheritanceAndIndependentDetail(t *testing.T) {
	permissions := []string{PermissionKey("inventory", "read")}
	for _, section := range []string{"inventory.cpes", "inventory.wans", "inventory.future"} {
		if !CanVisitSection(permissions, section) {
			t.Fatal("missing inventory subtab", section)
		}
	}
	if CanVisitSection(permissions, "cpe") || CanVisitSection(permissions, "inventory.cpes.overview") {
		t.Fatal("inventory read granted independent CPE detail")
	}
	permissions = []string{PermissionKey("settings.database", "full")}
	for _, section := range []string{"settings.database.retention", "settings.database.indexes", "settings.database.future"} {
		if !HasSectionPermission(permissions, section, "write") {
			t.Fatal("missing section inheritance", section)
		}
	}
	if HasSectionPermission(permissions, "settings.authentication", "write") {
		t.Fatal("Full crossed section boundary")
	}
}

func TestSectionActionsAreIndependent(t *testing.T) {
	for _, section := range PermissionSections {
		for _, selected := range section.Actions {
			if selected == "full" || selected == "read" {
				continue
			}
			if HasSectionPermission([]string{PermissionKey(section.ID, selected)}, section.ID, selected) {
				t.Fatal("mutation without read granted")
			}
			permissions := []string{PermissionKey(section.ID, "read"), PermissionKey(section.ID, selected)}
			for _, action := range section.Actions {
				if action == "read" {
					continue
				}
				if HasSectionPermission(permissions, section.ID, action) != (action == selected) {
					t.Fatalf("%s %s granted %s", section.ID, selected, action)
				}
			}
		}
	}
	if HasSectionPermission([]string{PermissionKey("security.audit", "full")}, "security.audit", "read") {
		t.Fatal("unsupported Full accepted")
	}
}
