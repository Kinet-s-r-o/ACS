package api

import (
	"github.com/matrix8412/acs/internal/models"
	"testing"
	"time"
)

func TestTemplateSnapshotSettingsPreserveActivation(t *testing.T) {
	before := time.Now().Add(-time.Hour)
	previous := &models.ProvisioningTemplate{SnapshotInitialSince: &before, Snapshots: models.TemplateSnapshotSettings{InitialEnabled: true, InitialDelayMinutes: 15}}
	var template models.ProvisioningTemplate
	if err := configureTemplateSnapshots(&template, nil, previous); err != nil {
		t.Fatal(err)
	}
	if template.Snapshots != previous.Snapshots || template.SnapshotInitialSince != previous.SnapshotInitialSince {
		t.Fatal("omitted settings changed the policy")
	}
	disabled := models.TemplateSnapshotSettings{}
	if err := configureTemplateSnapshots(&template, &disabled, previous); err != nil || template.SnapshotInitialSince != nil {
		t.Fatal("disable retained activation")
	}
	if err := configureTemplateSnapshots(&template, &previous.Snapshots, nil); err != nil || template.SnapshotInitialSince == nil || !template.SnapshotInitialSince.After(before) {
		t.Fatal("new policy did not get a fresh activation")
	}
	for _, settings := range []models.TemplateSnapshotSettings{{InitialDelayMinutes: -1}, {ScheduledEnabled: true}, {ScheduledIntervalMinutes: 525601}} {
		if configureTemplateSnapshots(&template, &settings, nil) == nil {
			t.Fatal("invalid snapshot configuration accepted")
		}
	}
}
