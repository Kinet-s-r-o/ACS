package database

import (
	"context"
	"encoding/json"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

const OperatorPermissionCatalogVersionKey = "internal.operator_permission_catalog_version"

// A consolidated grant is retained only if all former boundaries were granted.
var previousOperatorSections = map[string][]string{
	"fleet":                   {"fleet"},
	"inventory":               {"inventory.cpes", "inventory.wans"},
	"cpe":                     {"inventory.cpes.overview", "inventory.cpes.overview.wifi", "inventory.cpes.overview.wifi.general", "inventory.cpes.overview.wifi.security", "inventory.cpes.overview.wifi.advanced", "inventory.cpes.overview.lan", "inventory.cpes.overview.lan.general", "inventory.cpes.overview.lan.advanced", "inventory.cpes.overview.wan", "inventory.cpes.overview.wan.general", "inventory.cpes.overview.wan.ipv4", "inventory.cpes.overview.wan.ipv6", "inventory.cpes.overview.wan.advanced", "inventory.cpes.hosts", "inventory.cpes.metrics", "inventory.cpes.features", "inventory.cpes.snapshots", "inventory.cpes.tasks", "inventory.cpes.tasks.requested", "inventory.cpes.tasks.result", "inventory.cpes.faults", "inventory.cpes.maintenance", "inventory.cpes.maintenance.diagnostic", "inventory.cpes.log"},
	"tasks":                   {"tasks", "tasks.requested", "tasks.result"},
	"faults":                  {"faults"},
	"firmwares":               {"firmwares"},
	"security.blocklist":      {"security.blocklist"},
	"security.audit":          {"security.audit"},
	"settings.general":        {"settings.general.general", "settings.general.ui", "settings.general.aggregations"},
	"settings.system_tasks":   {"settings.system_tasks.summon_from_cpe", "settings.system_tasks.bulk_summon", "settings.system_tasks.bulk_restart"},
	"settings.database":       {"settings.database.retention", "settings.database.statistics", "settings.database.indexes"},
	"settings.dictionaries":   {"settings.dictionaries.tags"},
	"settings.users":          {"settings.users.users", "settings.users.users.tokens", "settings.users.users.dashboards", "settings.users.roles"},
	"settings.authentication": {"settings.authentication.radius"},
	"settings.delivery":       {"settings.delivery"},
	"settings.provisioning":   {"settings.provisioning", "settings.provisioning.templates", "settings.provisioning.rules", "settings.provisioning.variables", "settings.provisioning.metrics", "settings.provisioning.metrics.general", "settings.provisioning.metrics.general.metric", "settings.provisioning.metrics.general.health", "settings.provisioning.metrics.interface", "settings.provisioning.metrics.polling", "settings.provisioning.features", "settings.provisioning.cpe_detail", "settings.provisioning.cpe_detail.lan", "settings.provisioning.cpe_detail.info", "settings.metrics", "settings.metrics.metric", "settings.metrics.health"},
	"settings.api_docs":       {"settings.api_docs"},
}

func MigrateOperatorGrants(previous []string, dynamicFeatures []string) []string {
	has := func(section, action string) bool {
		for _, key := range previous {
			if key == models.PermissionKey(section, "full") || key == models.PermissionKey(section, action) {
				return true
			}
		}
		return false
	}
	next := []string{}
	for _, section := range models.PermissionSections {
		scopes := append([]string{}, previousOperatorSections[section.ID]...)
		for _, feature := range dynamicFeatures {
			if section.ID == "cpe" {
				scopes = append(scopes, "inventory.cpes.features."+feature)
			}
			if section.ID == "settings.provisioning" {
				scopes = append(scopes, "settings.provisioning.features."+feature)
			}
		}
		all := func(action string) bool {
			if len(scopes) == 0 {
				return false
			}
			for _, scope := range scopes {
				if !has(scope, action) {
					return false
				}
			}
			return true
		}
		complete := all("full")
		if section.ID == "inventory" {
			complete = complete && has("settings.system_tasks.bulk_summon", "full") && has("settings.system_tasks.bulk_restart", "full")
		}
		if section.ID == "cpe" {
			complete = complete && has("inventory.cpes.credentials", "full") && has("inventory.cpes", "delete")
		}
		if complete && models.IsSectionPermission(models.PermissionKey(section.ID, "full")) {
			next = append(next, models.PermissionKey(section.ID, "full"))
			continue
		}
		if !all("read") {
			continue
		}
		next = append(next, models.PermissionKey(section.ID, "read"))
		for _, action := range section.Actions {
			if action == "full" || action == "read" {
				continue
			}
			legacyAction := action
			if action == "write" || action == "add" {
				legacyAction = "edit"
			}
			granted := all(legacyAction)
			if section.ID == "fleet" && action == "delete" {
				granted = all("edit")
			}
			if section.ID == "security.blocklist" && action == "remove" {
				granted = all("delete")
			}
			if section.ID == "inventory" && action == "add" {
				granted = has("inventory.cpes", "edit")
			}
			if section.ID == "inventory" && action == "write" {
				granted = has("inventory.cpes", "edit") && has("settings.system_tasks.bulk_summon", "edit") && has("settings.system_tasks.bulk_restart", "edit")
			}
			if section.ID == "cpe" && action == "write" {
				granted = granted && has("inventory.cpes.maintenance.diagnostic", "full") && has("inventory.cpes.credentials", "edit")
			}
			if section.ID == "cpe" && action == "delete" {
				granted = has("inventory.cpes", "delete")
			}
			if section.ID == "cpe" && action == "export" {
				granted = has("inventory.cpes.maintenance.diagnostic", "export")
			}
			if section.ID == "firmwares" && action == "write" {
				granted = has("firmwares", "edit") || has("firmwares", "import")
			}
			if granted {
				next = append(next, models.PermissionKey(section.ID, action))
			}
		}
	}
	return next
}

// This one-time data migration changes no schema, indexes or system-role defaults.
func MigrateOperatorPermissionCatalog(ctx context.Context, db *gorm.DB) error {
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("LOCK TABLE roles, settings IN SHARE ROW EXCLUSIVE MODE").Error; err != nil {
			return err
		}
		var version Setting
		if err := tx.Where("key = ?", OperatorPermissionCatalogVersionKey).Limit(1).Find(&version).Error; err != nil {
			return err
		}
		if version.Value == "2" {
			return nil
		}
		features := []string{}
		var templatesExist bool
		if err := tx.Raw("SELECT to_regclass('provisioning_templates') IS NOT NULL").Scan(&templatesExist).Error; err != nil {
			return err
		}
		if templatesExist {
			var templates []struct{ Features json.RawMessage }
			if err := tx.Table("provisioning_templates").Select("features").Find(&templates).Error; err != nil {
				return err
			}
			seen := map[string]bool{}
			for _, template := range templates {
				var rows []struct{ ID string }
				if err := json.Unmarshal(template.Features, &rows); len(template.Features) > 0 && err != nil {
					return err
				}
				for _, row := range rows {
					if row.ID != "" && !seen[row.ID] {
						seen[row.ID] = true
						features = append(features, row.ID)
					}
				}
			}
		}
		var roles []models.Role
		if err := tx.Where("is_system = ?", false).Find(&roles).Error; err != nil {
			return err
		}
		for _, role := range roles {
			role.Permissions = MigrateOperatorGrants(role.Permissions, features)
			if err := tx.Model(&models.Role{}).Where("id = ?", role.ID).Select("permissions").Updates(&role).Error; err != nil {
				return err
			}
		}
		if version.Key != "" {
			return tx.Model(&Setting{}).Where("key = ?", OperatorPermissionCatalogVersionKey).Update("value", "2").Error
		}
		return tx.Create(&Setting{Key: OperatorPermissionCatalogVersionKey, Value: "2"}).Error
	})
}
