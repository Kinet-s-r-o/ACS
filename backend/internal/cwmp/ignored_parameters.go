package cwmp

import "github.com/matrix8412/acs/internal/database"

func ignoredParameterName(name string, branches []string) bool {
	for _, branch := range branches {
		if database.DynamicParameterBranchMatches(branch, name) {
			return true
		}
	}
	return false
}

func filterIgnoredParameterNames(names, branches []string) []string {
	return database.FilterDynamicParameterNames(names, branches)
}

// A root GPV cannot express exclusions. Discover names first whenever a template
// has exclusions, for both automatic refreshes and queued full-tree reads.
func startFullTreeRefresh(session *Session, root string) interface{} {
	if len(session.IgnoredParameterBranches) == 0 {
		return &GetParameterValues{ParameterNames: []string{root}}
	}
	session.FullTreeRead = &fullTreeRead{root: root}
	return &GetParameterNames{ParameterPath: root, NextLevel: false}
}
