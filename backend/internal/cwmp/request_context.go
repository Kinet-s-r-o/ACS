package cwmp

import (
	"fmt"
	"strings"
)

// Capture at the HTTP dispatch boundary so response-driven follow-up RPCs and
// queued tasks have the same diagnostic context. Never include parameter values
// or download URLs, which can contain credentials or signed access tokens.
func (h *Handler) rememberSentRequest(sessionID string, request interface{}) {
	var method, path string
	var parameters []string
	switch rpc := request.(type) {
	case *GetParameterValues:
		method = "GetParameterValues"
		parameters = append([]string(nil), rpc.ParameterNames...)
		path = strings.Join(parameters, ", ")
		if path == "" {
			path = "(entire parameter tree)"
		}
	case *GetParameterNames:
		method, path = "GetParameterNames", rpc.ParameterPath
		if path == "" {
			path = "(entire parameter tree)"
		}
	case *SetParameterValues:
		method = "SetParameterValues"
		names := make([]string, 0, len(rpc.ParameterList.Parameters))
		for _, parameter := range rpc.ParameterList.Parameters {
			names = append(names, parameter.Name)
		}
		path = strings.Join(names, ", ")
	case *AddObject:
		method, path = "AddObject", rpc.ObjectName
	case *DeleteObject:
		method, path = "DeleteObject", rpc.ObjectName
	case *Reboot:
		method = "Reboot"
	case *FactoryReset:
		method = "FactoryReset"
	case *Download:
		method = "Download"
	default:
		return
	}
	session := h.sessions.Get(sessionID)
	if session == nil {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	session.LastSentRPC = method
	session.LastSentContext = path
	session.LastSentParameters = parameters
	switch {
	case session.CurrentTaskID > 0:
		session.LastSentSource = fmt.Sprintf("task %d", session.CurrentTaskID)
	case session.AutoFetchPhase > 0:
		session.LastSentSource = "full parameter tree refresh"
	case session.DynamicDiscoveryActive:
		session.LastSentSource = "dynamic parameter discovery"
	case session.OverviewFetchActive:
		session.LastSentSource = "overview refresh"
	case session.ConditionalExistsCurrent != "" || (method == "GetParameterValues" && len(session.PendingConditionalParams) > 0):
		session.LastSentSource = "provisioning condition"
	case method == "SetParameterValues" && session.InformStaggerPending:
		session.LastSentSource = "provisioning / Inform scheduling"
	case method == "SetParameterValues" || method == "AddObject":
		session.LastSentSource = "provisioning"
	case method == "GetParameterValues":
		session.LastSentSource = "metrics / additional polling"
	default:
		session.LastSentSource = "ACS request"
	}
}

func requestFaultMessage(session *Session, message string) string {
	if session.LastSentRPC == "" {
		return message
	}
	return fmt.Sprintf("%s [%s; %s]", message, session.LastSentRPC, session.LastSentSource)
}
