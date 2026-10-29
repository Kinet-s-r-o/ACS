package cwmp

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

const (
	diagnostic9005Tag       = "cwmp-9005-diagnostics"
	diagnostic9005MaxParams = 512
	diagnostic9005MaxCalls  = 32
	diagnostic9005Timeout   = 5 * time.Minute
)

func (h *Handler) acquire9005DiagnosticSlot() bool {
	if h.diagnosticSlots == nil {
		return false
	}
	select {
	case h.diagnosticSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (h *Handler) release9005DiagnosticSlot() {
	if h.diagnosticSlots == nil {
		return
	}
	select {
	case <-h.diagnosticSlots:
	default:
	}
}

func (h *Handler) deviceHas9005DiagnosticTag(ctx context.Context, deviceID int64) bool {
	if h.deviceRepo == nil || deviceID <= 0 {
		return false
	}
	device, err := h.deviceRepo.GetByID(ctx, deviceID)
	if err != nil || device == nil {
		return false
	}
	for _, tag := range device.Tags {
		if strings.EqualFold(strings.TrimSpace(tag), diagnostic9005Tag) {
			return true
		}
	}
	return false
}

func (h *Handler) start9005Diagnostic(ctx context.Context, session *Session) (interface{}, bool, error) {
	if session.Diagnostic9005Active || len(session.LastSentParameters) <= 1 || len(session.LastSentParameters) > diagnostic9005MaxParams {
		return nil, false, nil
	}
	if !h.deviceHas9005DiagnosticTag(ctx, session.DeviceID) || !h.acquire9005DiagnosticSlot() {
		return nil, false, nil
	}

	params := append([]string(nil), session.LastSentParameters...)
	mid := len(params) / 2
	session.Diagnostic9005Active = true
	session.Diagnostic9005Original = params
	session.Diagnostic9005Queue = [][]string{params[:mid], params[mid:]}
	session.Diagnostic9005Current = nil
	session.Diagnostic9005Invalid = nil
	session.Diagnostic9005Requests = 0
	session.Diagnostic9005StartedAt = time.Now()

	startedAt := session.Diagnostic9005StartedAt
	go func(sessionID string) {
		timer := time.NewTimer(diagnostic9005Timeout)
		defer timer.Stop()
		<-timer.C
		h.expire9005Diagnostic(context.Background(), sessionID, startedAt)
	}(session.ID)

	request, err := h.next9005DiagnosticRequest(session)
	if err != nil {
		h.finish9005Diagnostic(context.Background(), session)
		return nil, false, err
	}
	return request, true, nil
}

func (h *Handler) next9005DiagnosticRequest(session *Session) (interface{}, error) {
	if len(session.Diagnostic9005Queue) == 0 {
		return nil, nil
	}
	current := session.Diagnostic9005Queue[0]
	session.Diagnostic9005Queue = session.Diagnostic9005Queue[1:]
	if len(current) == 0 {
		return h.next9005DiagnosticRequest(session)
	}
	session.Diagnostic9005Current = append([]string(nil), current...)
	session.Diagnostic9005Requests++
	if session.Diagnostic9005Requests > diagnostic9005MaxCalls {
		return nil, fmt.Errorf("9005 diagnostic request limit exceeded")
	}
	session.State = StateProcessingTasks
	session.LastSentContext = strings.Join(current, ", ")
	session.LastSentParameters = append([]string(nil), current...)
	return &GetParameterValues{ParameterNames: current}, nil
}

func split9005Parameters(params []string) [][]string {
	if len(params) <= 1 {
		return nil
	}
	mid := len(params) / 2
	return [][]string{
		append([]string(nil), params[:mid]...),
		append([]string(nil), params[mid:]...),
	}
}

func (h *Handler) handle9005DiagnosticFault(ctx context.Context, session *Session, faultMessage string) (interface{}, error) {
	current := session.Diagnostic9005Current
	if len(current) > 1 && session.Diagnostic9005Requests < diagnostic9005MaxCalls {
		parts := split9005Parameters(current)
		session.Diagnostic9005Queue = append(parts, session.Diagnostic9005Queue...)
	} else {
		session.Diagnostic9005Invalid = append(session.Diagnostic9005Invalid, current...)
	}
	session.LastSentContext = ""
	request, err := h.next9005DiagnosticRequest(session)
	if err != nil {
		return h.finish9005Diagnostic(ctx, session)
	}
	if request != nil {
		return request, nil
	}
	if len(session.Diagnostic9005Invalid) == 0 && faultMessage != "" {
		// The CPE rejected a request but did not leave a singleton candidate.
		session.Diagnostic9005Invalid = append(session.Diagnostic9005Invalid, session.Diagnostic9005Original...)
	}
	return h.finish9005Diagnostic(ctx, session)
}

func (h *Handler) handle9005DiagnosticResponse(ctx context.Context, session *Session, resp *GetParameterValuesResp) (interface{}, error) {
	if h.parameterRepo != nil && session.DeviceID > 0 && len(resp.ParameterList.Parameters) > 0 {
		params := make([]models.DeviceParameter, 0, len(resp.ParameterList.Parameters))
		for _, parameter := range resp.ParameterList.Parameters {
			params = append(params, models.DeviceParameter{DeviceID: session.DeviceID, Name: parameter.Name, Value: parameter.Value, ValueType: parameter.ValueType})
		}
		if err := h.parameterRepo.UpsertMany(ctx, session.DeviceID, params); err != nil {
			return nil, fmt.Errorf("save 9005 diagnostic parameters: %w", err)
		}
	}
	session.LastSentContext = ""
	request, err := h.next9005DiagnosticRequest(session)
	if err != nil {
		return h.finish9005Diagnostic(ctx, session)
	}
	if request != nil {
		return request, nil
	}
	return h.finish9005Diagnostic(ctx, session)
}

func (h *Handler) finish9005Diagnostic(ctx context.Context, session *Session) (interface{}, error) {
	invalid := append([]string(nil), session.Diagnostic9005Invalid...)
	if h.faultRepo != nil && session.DeviceID > 0 {
		if len(invalid) == 0 {
			invalid = append(invalid, session.Diagnostic9005Original...)
			if err := h.faultRepo.Create(ctx, &models.Fault{DeviceID: session.DeviceID, FaultCode: "9005", FaultString: "Invalid parameter name (diagnostic could not isolate a singleton)", ParameterName: strings.Join(invalid, ", ")}); err != nil {
				return nil, fmt.Errorf("save 9005 diagnostic fault: %w", err)
			}
		} else {
			for _, name := range invalid {
				if err := h.faultRepo.Create(ctx, &models.Fault{DeviceID: session.DeviceID, FaultCode: "9005", FaultString: "Invalid parameter name (isolated by diagnostic mode)", ParameterName: name}); err != nil {
					return nil, fmt.Errorf("save isolated 9005 fault: %w", err)
				}
			}
		}
	}
	if session.CurrentTaskID > 0 && h.taskRepo != nil {
		message := "CPE rejected one or more parameters"
		if len(invalid) > 0 {
			message = "Invalid parameter name: " + strings.Join(invalid, ", ")
		}
		if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusFailed, nil, message); err != nil {
			return nil, fmt.Errorf("fail task after 9005 diagnostic: %w", err)
		}
		session.CurrentTaskID = 0
	}
	session.OverviewFetchActive = false
	session.Diagnostic9005Active = false
	session.Diagnostic9005Queue = nil
	session.Diagnostic9005Current = nil
	session.Diagnostic9005Invalid = nil
	session.Diagnostic9005Original = nil
	session.Diagnostic9005Requests = 0
	session.Diagnostic9005StartedAt = time.Time{}
	session.LastSentParameters = nil
	h.release9005DiagnosticSlot()
	return h.getNextTask(ctx, session)
}

func (h *Handler) expire9005Diagnostic(ctx context.Context, sessionID string, startedAt time.Time) {
	session := h.sessions.Get(sessionID)
	if session == nil {
		h.release9005DiagnosticSlot()
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if !session.Diagnostic9005Active || !session.Diagnostic9005StartedAt.Equal(startedAt) {
		return
	}
	log.Printf("9005 diagnostic timed out for device %s", session.SerialNumber)
	if h.faultRepo != nil && session.DeviceID > 0 {
		_ = h.faultRepo.Create(ctx, &models.Fault{DeviceID: session.DeviceID, FaultCode: "9005", FaultString: "Invalid parameter name (diagnostic timeout)", ParameterName: strings.Join(session.Diagnostic9005Original, ", ")})
	}
	if session.CurrentTaskID > 0 && h.taskRepo != nil {
		_ = h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusFailed, nil, "9005 diagnostic timeout")
		session.CurrentTaskID = 0
	}
	session.Diagnostic9005Active = false
	session.Diagnostic9005Queue = nil
	session.Diagnostic9005Current = nil
	session.Diagnostic9005Invalid = nil
	session.Diagnostic9005Original = nil
	session.Diagnostic9005Requests = 0
	session.Diagnostic9005StartedAt = time.Time{}
	h.release9005DiagnosticSlot()
}
