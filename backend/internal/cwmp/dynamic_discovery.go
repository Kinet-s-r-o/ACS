package cwmp

import (
	"context"
	"strings"

	"github.com/matrix8412/acs/internal/models"
)

// DynamicInstanceVerification rechecks a just-discovered wildcard instance after
// a GPN fault. Only a successful parent listing can prove that it disappeared.
type DynamicInstanceVerification struct {
	Step         DynamicDiscoveryStep
	FaultMessage string
}

func startDynamicInstanceVerification(session *Session, faultMessage string) *GetParameterNames {
	step := session.DynamicDiscoveryCurrent
	if !session.OverviewFetchActive || !session.DynamicDiscoveryActive || session.CurrentTaskID != 0 ||
		session.AutoFetchPhase != 0 || session.Diagnostic9005Active || step == nil ||
		step.Index <= 0 || step.Index > len(step.Segments) || step.Segments[step.Index-1] != "*" ||
		len(session.LastSentParameters) != 0 || session.LastSentContext != step.Path {
		return nil
	}
	path := strings.TrimSuffix(step.Path, ".")
	dot := strings.LastIndex(path, ".")
	if dot < 0 {
		return nil
	}
	session.DynamicDiscoveryVerification = &DynamicInstanceVerification{Step: *step, FaultMessage: faultMessage}
	session.LastSentContext = path[:dot+1]
	logCWMPSession(session.SerialNumber, session.ID, "Rechecking parent after dynamic instance GPN fault 9005: %s", step.Path)
	return &GetParameterNames{ParameterPath: session.LastSentContext, NextLevel: true}
}

func (h *Handler) handleDynamicInstanceVerification(ctx context.Context, session *Session, resp *GetParameterNamesResp) (interface{}, error) {
	verification := session.DynamicDiscoveryVerification
	for _, parameter := range resp.ParameterList {
		if strings.TrimSuffix(parameter.Name, ".") == strings.TrimSuffix(verification.Step.Path, ".") {
			return h.failDynamicInstanceVerification(ctx, session)
		}
	}
	logCWMPSession(session.SerialNumber, session.ID, "Dynamic instance disappeared during discovery; skipping %s", verification.Step.Path)
	session.DynamicDiscoveryVerification = nil
	session.DynamicDiscoveryCurrent = nil
	session.LastSentContext = ""
	return h.continueDynamicDiscovery(ctx, session)
}

func (h *Handler) failDynamicInstanceVerification(ctx context.Context, session *Session) (interface{}, error) {
	verification := session.DynamicDiscoveryVerification
	// Keep the original fault and path when absence was not proved. Do not retry
	// the same instance or suppress a firmware error for an object still advertised.
	if h.faultRepo != nil && session.DeviceID > 0 {
		if err := h.faultRepo.Create(ctx, &models.Fault{
			DeviceID: session.DeviceID, FaultCode: "9005", FaultString: verification.FaultMessage, ParameterName: verification.Step.Path,
		}); err != nil {
			logCWMPSession(session.SerialNumber, session.ID, "Error saving dynamic instance fault: %v", err)
		}
	}
	session.OverviewFetchActive = false
	session.LastSentContext = ""
	session.LastSentParameters = nil
	clearDynamicDiscovery(session)
	return h.getNextTask(ctx, session)
}

func clearDynamicDiscovery(session *Session) {
	session.DynamicDiscoveryActive = false
	session.DynamicDiscoveryCurrent = nil
	session.DynamicDiscoveryQueue = nil
	session.DynamicDiscoveryNames = nil
	session.DynamicDiscoveryVerification = nil
}

func (h *Handler) continueDynamicDiscovery(ctx context.Context, session *Session) (interface{}, error) {
	if len(session.DynamicDiscoveryQueue) > 0 {
		return nextDynamicDiscoveryRequest(session), nil
	}
	seen := make(map[string]bool, len(session.OverviewFetchParams)+len(session.DynamicDiscoveryNames))
	for _, name := range session.OverviewFetchParams {
		seen[name] = true
	}
	for _, name := range session.DynamicDiscoveryNames {
		if !seen[name] {
			session.OverviewFetchParams = append(session.OverviewFetchParams, name)
			seen[name] = true
		}
	}
	if len(session.OverviewFetchParams) == 0 {
		// An empty GPV name list asks for the whole tree, not for zero values.
		if h.parameterRepo != nil && session.DeviceID > 0 {
			if err := h.parameterRepo.ReplaceDynamicParameters(ctx, session.DeviceID, session.DynamicParameterBranches, nil); err != nil {
				return nil, err
			}
		}
		session.OverviewFetchActive = false
		clearDynamicDiscovery(session)
		return h.getNextTask(ctx, session)
	}
	session.State = StateProcessingTasks
	session.LastSentContext = strings.Join(session.OverviewFetchParams, ", ")
	session.LastSentParameters = append([]string(nil), session.OverviewFetchParams...)
	return &GetParameterValues{ParameterNames: session.OverviewFetchParams}, nil
}
