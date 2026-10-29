package database

import "strings"

// DynamicParameterBranchMatches reports whether name is below a configured
// dynamic object branch. A * matches exactly one object instance segment.
func DynamicParameterBranchMatches(pattern, name string) bool {
	patternParts := splitCWMPPath(pattern)
	nameParts := splitCWMPPath(name)
	if len(patternParts) == 0 || len(nameParts) < len(patternParts) {
		return false
	}
	for index, part := range patternParts {
		if part != "*" && part != nameParts[index] {
			return false
		}
	}
	return true
}

func FilterDynamicParameterNames(names, branches []string) []string {
	if len(branches) == 0 {
		return names
	}
	filtered := make([]string, 0, len(names))
	for _, name := range names {
		dynamic := false
		for _, branch := range branches {
			if DynamicParameterBranchMatches(branch, name) {
				dynamic = true
				break
			}
		}
		if !dynamic {
			filtered = append(filtered, name)
		}
	}
	return filtered
}

func splitCWMPPath(path string) []string {
	path = strings.TrimSuffix(strings.TrimSpace(path), ".")
	if path == "" {
		return nil
	}
	parts := strings.Split(path, ".")
	for _, part := range parts {
		if part == "" {
			return nil
		}
	}
	return parts
}
