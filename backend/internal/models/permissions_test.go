package models

import (
	"slices"
	"strings"
	"testing"
)

func TestPermissionCatalogUsesSixActions(t *testing.T) {
	if !slices.Equal(PermissionActions, []string{"full", "read", "edit", "delete", "import", "export"}) {
		t.Fatal("unexpected permission action types")
	}
	sections := map[string]bool{}
	for _, section := range PermissionSections {
		if section.ID == "" || section.Label == "" || sections[section.ID] {
			t.Fatalf("invalid section %q", section.ID)
		}
		if section.Parent != "" && !sections[section.Parent] {
			t.Fatalf("missing parent for %s", section.ID)
		}
		sections[section.ID] = true
	}
	if len(AllPermissions) != len(PermissionSections)*6 {
		t.Fatal("incomplete section/action matrix")
	}
	seen := map[string]bool{}
	for _, key := range AllPermissions {
		if seen[key] || !strings.HasPrefix(key, "access.") {
			t.Fatal("duplicate or legacy permission key")
		}
		seen[key] = true
	}
}

func TestFullIsLocalToOneSection(t *testing.T) {
	permissions := []string{PermissionKey("settings.database", "full")}
	for _, action := range PermissionActions {
		if !HasSectionPermission(permissions, "settings.database", action) {
			t.Fatalf("full denied %s", action)
		}
	}
	for _, section := range []string{"settings", "settings.database.retention", "settings.database.statistics", "settings.database.indexes", "settings.authentication.radius"} {
		for _, action := range PermissionActions {
			if HasSectionPermission(permissions, section, action) {
				t.Fatalf("parent full leaked to %s / %s", section, action)
			}
		}
	}
	if !CanVisitSection([]string{PermissionKey("settings.authentication.radius", "read")}, "settings") {
		t.Fatal("child permission did not make its navigation container reachable")
	}
}

func TestSectionActionsAreIndependent(t *testing.T) {
	scope := "settings.provisioning.templates"
	if HasSectionPermission([]string{PermissionKey(scope, "edit")}, scope, "edit") {
		t.Fatal("mutation without read granted")
	}
	for _, selected := range []string{"read", "edit", "delete", "import", "export"} {
		permissions := []string{PermissionKey(scope, "read"), PermissionKey(scope, selected)}
		for _, action := range []string{"edit", "delete", "import", "export", "full"} {
			if HasSectionPermission(permissions, scope, action) != (action == selected) {
				t.Fatalf("%s unexpectedly changed %s", selected, action)
			}
		}
	}
}
