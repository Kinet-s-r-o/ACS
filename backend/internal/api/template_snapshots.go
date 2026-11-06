package api

import (
	"time"

	"github.com/matrix8412/acs/internal/models"
)

func configureTemplateSnapshots(template *models.ProvisioningTemplate, requested *models.TemplateSnapshotSettings, previous *models.ProvisioningTemplate) error {
	template.SnapshotInitialSince = nil
	if previous != nil {
		template.Snapshots = previous.Snapshots
	}
	if requested != nil {
		template.Snapshots = *requested
	}
	if err := template.Snapshots.Validate(); err != nil {
		return err
	}
	if template.Snapshots.InitialEnabled {
		if previous != nil && previous.Snapshots.InitialEnabled && previous.SnapshotInitialSince != nil {
			template.SnapshotInitialSince = previous.SnapshotInitialSince
		} else {
			now := time.Now()
			template.SnapshotInitialSince = &now
		}
	}
	return nil
}
