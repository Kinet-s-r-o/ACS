package api

import (
	"fmt"
	"slices"
	"strings"
)

// Omitted maps preserve existing policies for branches that remain configured.
// Explicit {} clears all policies. Explicit orphan keys are rejected.
func resolveDynamicFaultSuppression(request, previous map[string][]string, branches []string) (map[string][]string, error) {
	allowed := make(map[string]bool, len(branches))
	for _, branch := range branches {
		allowed[strings.TrimSpace(branch)] = true
	}
	if request == nil {
		request = make(map[string][]string)
		for branch, codes := range previous {
			if allowed[branch] {
				request[branch] = codes
			}
		}
	}
	if len(request) > 64 {
		return nil, fmt.Errorf("at most 64 dynamic branches can suppress faults")
	}
	result := make(map[string][]string)
	for raw, codes := range request {
		branch := strings.TrimSpace(raw)
		if !allowed[branch] {
			return nil, fmt.Errorf("fault suppression requires a configured dynamic parameter branch: %q", branch)
		}
		if len(codes) > 32 {
			return nil, fmt.Errorf("at most 32 suppressed fault codes per dynamic branch")
		}
		for _, rawCode := range codes {
			code := strings.TrimSpace(rawCode)
			if len(code) != 4 || code[0] != '9' || code[1] < '0' || code[1] > '9' || code[2] < '0' || code[2] > '9' || code[3] < '0' || code[3] > '9' {
				return nil, fmt.Errorf("suppressed fault code must be between 9000 and 9999")
			}
			if !slices.Contains(result[branch], code) {
				result[branch] = append(result[branch], code)
			}
		}
		if len(result[branch]) > 32 {
			return nil, fmt.Errorf("at most 32 suppressed fault codes per dynamic branch")
		}
		slices.Sort(result[branch])
	}
	return result, nil
}

func equalDynamicFaultSuppression(left, right map[string][]string) bool {
	if len(left) != len(right) {
		return false
	}
	for branch, codes := range left {
		if !slices.Equal(codes, right[branch]) {
			return false
		}
	}
	return true
}
