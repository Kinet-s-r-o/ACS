package models

import (
	"errors"
	"testing"
)

func TestValidateProvisioningPhases(t *testing.T) {
	base := ProvisioningRule{ID: 1, TemplateID: 2, ParameterName: "Device.Test", Phase: "bootstrap", Tags: []string{"a", "b"}, ExcludedTags: []string{"c"}, Condition: "x = 1"}
	for _, tc := range []struct {
		name     string
		change   func(*ProvisioningRule)
		conflict bool
	}{
		{"different values still conflict", func(r *ProvisioningRule) { r.ParameterValue = "other" }, true},
		{"disabled still conflicts", func(r *ProvisioningRule) { r.Enabled = false }, true},
		{"tag order and duplicates", func(r *ProvisioningRule) { r.Tags = []string{"b", "a", "a"} }, true},
		{"tag case", func(r *ProvisioningRule) { r.Tags = []string{"A", "B"}; r.ExcludedTags = []string{"C"} }, true},
		{"trimmed targeting", func(r *ProvisioningRule) { r.Condition = " x = 1 "; r.Tags = []string{" a ", "b"} }, true},
		{"different template", func(r *ProvisioningRule) { r.TemplateID++ }, false},
		{"different parameter", func(r *ProvisioningRule) { r.ParameterName += ".Other" }, false},
		{"different condition", func(r *ProvisioningRule) { r.Condition = "x = 2" }, false},
		{"different tags", func(r *ProvisioningRule) { r.Tags = []string{"a"} }, false},
		{"different excluded tags", func(r *ProvisioningRule) { r.ExcludedTags = nil }, false},
		{"same phase", func(r *ProvisioningRule) { r.Phase = "bootstrap" }, false},
		{"implicit bootstrap", func(r *ProvisioningRule) { r.Phase = "" }, false},
		{"add object", func(r *ProvisioningRule) { r.AddObjectPath = "Device.Object." }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := base
			candidate.ID, candidate.Phase = 3, "default"
			tc.change(&candidate)
			err := ValidateProvisioningPhases([]ProvisioningRule{base, candidate})
			if errors.Is(err, ErrProvisioningPhaseConflict) != tc.conflict {
				t.Fatalf("conflict = %v, want %v", err, tc.conflict)
			}
		})
	}
	for _, rules := range [][]ProvisioningRule{
		{{ParameterName: "Device.Test"}, {ParameterName: "Device.Test", Phase: "default", Tags: []string{}}},
		{{ParameterName: "Device.Test", Phase: "default"}, {ParameterName: "Device.Test", Phase: "bootstrap"}},
	} {
		if !errors.Is(ValidateProvisioningPhases(rules), ErrProvisioningPhaseConflict) {
			t.Fatal("expected conflict for default bootstrap or empty tags")
		}
	}
}
