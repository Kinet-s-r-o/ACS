package database

import (
	"context"

	"github.com/matrix8412/acs/internal/models"
)

// User-defined Advanced settings tabs get stable rows keyed by their feature ID.
func (r *RoleRepository) PermissionCatalog(ctx context.Context) ([]models.PermissionSection, error) {
	sections := append([]models.PermissionSection{}, models.PermissionSections...)
	var exists bool
	if err := r.db.WithContext(ctx).Raw("SELECT to_regclass('provisioning_templates') IS NOT NULL").Scan(&exists).Error; err != nil {
		return nil, err
	}
	if !exists {
		return sections, nil
	}
	var templates []models.ProvisioningTemplate
	if err := r.db.WithContext(ctx).Select("features").Find(&templates).Error; err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, template := range templates {
		for _, feature := range template.Features {
			if feature.ID == "" || seen[feature.ID] {
				continue
			}
			seen[feature.ID] = true
			for _, parent := range []string{"settings.provisioning.features", "inventory.cpes.features"} {
				sections = append(sections, models.PermissionSection{ID: parent + "." + feature.ID, Label: feature.Name, Parent: parent})
			}
		}
	}
	children := map[string][]models.PermissionSection{}
	for _, section := range sections {
		children[section.Parent] = append(children[section.Parent], section)
	}
	ordered := make([]models.PermissionSection, 0, len(sections))
	var appendChildren func(string)
	appendChildren = func(parent string) {
		for _, section := range children[parent] {
			ordered = append(ordered, section)
			appendChildren(section.ID)
		}
	}
	appendChildren("")
	return ordered, nil
}

func CatalogPermissionKeys(sections []models.PermissionSection) []string {
	keys := make([]string, 0, len(sections)*len(models.PermissionActions))
	for _, section := range sections {
		for _, action := range models.PermissionActions {
			keys = append(keys, models.PermissionKey(section.ID, action))
		}
	}
	return keys
}
