package models

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
)

var ErrProvisioningPhaseConflict = errors.New("the same parameter with identical conditions and tags cannot be used in both Bootstrap and Default; remove or change the conflicting rule to prevent a provisioning loop")

// ValidateProvisioningPhases compares targeting, not values or activation state.
func ValidateProvisioningPhases(rules []ProvisioningRule) error {
	seen := make(map[string]string)
	for _, rule := range rules {
		if rule.AddObjectPath != "" || strings.TrimSpace(rule.ParameterName) == "" {
			continue
		}
		phase := rule.Phase
		if phase == "" {
			phase = "bootstrap"
		}
		if phase != "bootstrap" && phase != "default" {
			continue
		}
		tags := func(values []string) []string {
			result := make([]string, 0, len(values))
			for _, value := range values {
				if value = strings.ToLower(strings.TrimSpace(value)); value != "" {
					result = append(result, value)
				}
			}
			slices.Sort(result)
			return slices.Compact(result)
		}
		key, _ := json.Marshal([]interface{}{rule.TemplateID, strings.TrimSpace(rule.ParameterName), strings.TrimSpace(rule.Condition), tags(rule.Tags), tags(rule.ExcludedTags)})
		if previous, ok := seen[string(key)]; ok && previous != phase {
			return ErrProvisioningPhaseConflict
		}
		seen[string(key)] = phase
	}
	return nil
}
