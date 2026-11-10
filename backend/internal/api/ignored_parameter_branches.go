package api

import (
	"fmt"
	"strings"
)

// Ignored branches use the same object path syntax as dynamic discovery.
func validateIgnoredParameterBranches(branches []string) error {
	if err := validateDynamicParameterBranches(branches); err != nil {
		return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), "dynamic parameter", "ignored parameter"))
	}
	for _, branch := range branches {
		parts := strings.Split(strings.TrimSuffix(strings.TrimSpace(branch), "."), ".")
		if len(parts) < 2 {
			return fmt.Errorf("ignored parameter branch must be below the data model root")
		}
		for _, part := range parts {
			if part == "" {
				return fmt.Errorf("ignored parameter branch contains an empty path segment")
			}
		}
	}
	return nil
}
