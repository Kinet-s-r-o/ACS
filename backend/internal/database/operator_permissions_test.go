package database

import (
	"github.com/matrix8412/acs/internal/models"
	"slices"
	"testing"
)

func TestOperatorGrantMigrationIsConservative(t *testing.T) {
	partial := []string{"access.inventory.cpes.overview.full", "access.settings.users.roles.full", "access.settings.provisioning.features.full"}
	migrated := MigrateOperatorGrants(partial, []string{"future"})
	for _, key := range []string{"access.cpe.full", "access.settings.users.full", "access.settings.provisioning.full"} {
		if slices.Contains(migrated, key) {
			t.Fatal("partial legacy grant became broader", key)
		}
	}
	all := []string{}
	for _, scopes := range previousOperatorSections {
		for _, section := range scopes {
			all = append(all, models.PermissionKey(section, "full"))
		}
	}
	all = append(all, "access.inventory.cpes.credentials.full", "access.inventory.cpes.full", "access.settings.system_tasks.bulk_summon.full", "access.settings.system_tasks.bulk_restart.full", "access.inventory.cpes.features.future.full", "access.settings.provisioning.features.future.full")
	migrated = MigrateOperatorGrants(all, []string{"future"})
	for _, section := range models.PermissionSections {
		if len(section.Actions) == 0 {
			continue
		}
		action := "full"
		if section.ID == "security.audit" {
			action = "read"
		}
		if !models.HasSectionPermission(migrated, section.ID, action) {
			t.Fatal("complete old access was lost", section.ID)
		}
	}
}

func TestFirmwareUploadAndFleetActionsMigration(t *testing.T) {
	migrated := MigrateOperatorGrants([]string{"access.firmwares.read", "access.firmwares.import", "access.fleet.read", "access.fleet.edit"}, nil)
	for _, key := range []string{"access.firmwares.write", "access.fleet.add", "access.fleet.edit", "access.fleet.delete"} {
		if !slices.Contains(migrated, key) {
			t.Fatal("old operation was not retained", key)
		}
	}
	if slices.Contains(migrated, "access.firmwares.delete") || slices.Contains(migrated, "access.fleet.full") {
		t.Fatal("migration added unrelated authority")
	}
}
