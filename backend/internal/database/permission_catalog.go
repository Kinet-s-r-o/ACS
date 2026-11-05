package database

import (
	"context"
	"github.com/matrix8412/acs/internal/models"
)

// Features and future subtabs inherit their owning catalog section.
func (r *RoleRepository) PermissionCatalog(ctx context.Context) ([]models.PermissionSection, error) {
	return append([]models.PermissionSection{}, models.PermissionSections...), nil
}

func CatalogPermissionKeys(sections []models.PermissionSection) []string {
	keys := []string{}
	for _, section := range sections {
		for _, action := range section.Actions {
			keys = append(keys, models.PermissionKey(section.ID, action))
		}
	}
	return keys
}
