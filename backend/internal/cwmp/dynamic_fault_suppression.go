package cwmp

import (
	"github.com/matrix8412/acs/internal/database"
	"slices"
)

func requestedReadPaths(session *Session) []string {
	switch session.LastSentRPC {
	case "GetParameterValues":
		return session.LastSentParameters
	case "GetParameterNames":
		if session.LastSentContext != "" {
			return []string{session.LastSentContext}
		}
	}
	return nil
}

// Suppress recording only when every candidate is explicitly covered for this
// code. A mixed/unattributed batch must retain its fault, as must write RPCs.
// Task failures, partial-refresh warnings and cache handling are unchanged.
func suppressDynamicReadFault(session *Session, code string, names []string) bool {
	if (session.LastSentRPC != "GetParameterNames" && session.LastSentRPC != "GetParameterValues") || len(names) == 0 || len(session.DynamicParameterSuppressedFaults) == 0 {
		return false
	}
	for _, name := range names {
		matched := false
		for branch, codes := range session.DynamicParameterSuppressedFaults {
			if slices.Contains(codes, code) && database.DynamicParameterBranchMatches(branch, name) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	logCWMPSession(session.SerialNumber, session.ID, "Suppressed CWMP read fault %s by template policy (%d requested paths)", code, len(names))
	return true
}
