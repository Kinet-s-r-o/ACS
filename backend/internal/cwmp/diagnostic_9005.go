package cwmp

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
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
	if err != nil {
		log.Printf("Cannot check 9005 diagnostic tag for device %d: %v", deviceID, err)
		return false
	}
	if device == nil {
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
	if session.Diagnostic9005Active {
		return nil, false, nil
	}
	if !h.deviceHas9005DiagnosticTag(ctx, session.DeviceID) {
		return nil, false, nil
	}
	if len(session.LastSentParameters) <= 1 {
		logCWMPSession(session.SerialNumber, session.ID, "9005 diagnostic skipped: last RPC has %d GPV candidates (requires multiple names)", len(session.LastSentParameters))
		return nil, false, nil
	}
	if !h.acquire9005DiagnosticSlot() {
		logCWMPSession(session.SerialNumber, session.ID, "9005 diagnostic skipped: concurrency limit reached (%d GPV candidates)", len(session.LastSentParameters))
		return nil, false, nil
	}

	params := append([]string(nil), session.LastSentParameters...)
	session.Diagnostic9005Active = true
	session.Diagnostic9005Original = params
	session.Diagnostic9005Queue = nil
	if len(params) <= diagnostic9005MaxParams {
		session.Diagnostic9005Queue = split9005Parameters(params)
	} else {
		// Bound each probe, rather than silently skipping large overview reads.
		for offset := 0; offset < len(params); offset += diagnostic9005MaxParams {
			end := min(offset+diagnostic9005MaxParams, len(params))
			session.Diagnostic9005Queue = append(session.Diagnostic9005Queue, params[offset:end])
		}
	}
	session.Diagnostic9005Current = nil
	session.Diagnostic9005Invalid = nil
	session.Diagnostic9005Requests = 0
	session.Diagnostic9005StartedAt = time.Now()
	done := make(chan struct{})
	// A completed/removed session's timer must never release another session's slot.
	release := sync.OnceFunc(func() {
		close(done)
		h.release9005DiagnosticSlot()
	})
	session.Diagnostic9005Cancel = release

	startedAt := session.Diagnostic9005StartedAt
	go func(sessionID string) {
		timer := time.NewTimer(diagnostic9005Timeout)
		defer timer.Stop()
		defer release()
		select {
		case <-done:
		case <-timer.C:
			h.expire9005Diagnostic(context.Background(), sessionID, startedAt)
		}
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
	if session.Diagnostic9005Requests >= diagnostic9005MaxCalls {
		return nil, fmt.Errorf("9005 diagnostic request limit exceeded")
	}
	current := session.Diagnostic9005Queue[0]
	session.Diagnostic9005Queue = session.Diagnostic9005Queue[1:]
	if len(current) == 0 {
		return h.next9005DiagnosticRequest(session)
	}
	session.Diagnostic9005Current = append([]string(nil), current...)
	session.Diagnostic9005Requests++
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

func (h *Handler) handle9005DiagnosticFault(ctx context.Context, session *Session) (interface{}, error) {
	current := session.Diagnostic9005Current
	if len(current) > 1 {
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
	defer h.clear9005Diagnostic(session)
	invalid := append([]string(nil), session.Diagnostic9005Invalid...)
	var unresolved []string
	for _, pending := range session.Diagnostic9005Queue {
		unresolved = append(unresolved, pending...)
	}
	logCWMPSession(session.SerialNumber, session.ID, "9005 diagnostic finished: %d requests, %d isolated parameters, %d untested candidates", session.Diagnostic9005Requests, len(invalid), len(unresolved))
	if h.faultRepo != nil && session.DeviceID > 0 {
		for _, name := range invalid {
			if suppressDynamicReadFault(session, "9005", []string{name}) {
				continue
			}
			if err := h.faultRepo.Create(ctx, &models.Fault{DeviceID: session.DeviceID, FaultCode: "9005", FaultString: "Invalid parameter name (isolated by diagnostic mode)", ParameterName: name}); err != nil {
				return nil, fmt.Errorf("save isolated 9005 fault: %w", err)
			}
		}
		message := "Invalid parameter name (diagnostic request limit reached; remaining candidates are not confirmed invalid)"
		if len(invalid) == 0 && len(unresolved) == 0 {
			unresolved = append(unresolved, session.Diagnostic9005Original...)
			message = "Invalid parameter name (diagnostic could not isolate a singleton)"
		}
		if len(unresolved) > 0 {
			if err := h.faultRepo.Create(ctx, &models.Fault{DeviceID: session.DeviceID, FaultCode: "9005", FaultString: message, ParameterName: strings.Join(unresolved, ", ")}); err != nil {
				return nil, fmt.Errorf("save 9005 diagnostic fault: %w", err)
			}
		}
	}
	if session.CurrentTaskID > 0 && h.taskRepo != nil {
		message := "CPE rejected one or more parameters"
		if len(invalid) > 0 {
			message = "Invalid parameter name: " + strings.Join(invalid, ", ")
		}
		if len(unresolved) > 0 {
			message += "; diagnostic incomplete"
		}
		if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusFailed, nil, message); err != nil {
			return nil, fmt.Errorf("fail task after 9005 diagnostic: %w", err)
		}
		session.CurrentTaskID = 0
	}
	h.clear9005Diagnostic(session)
	return h.getNextTask(ctx, session)
}

func (h *Handler) clear9005Diagnostic(session *Session) {
	if !session.Diagnostic9005Active {
		return
	}
	session.OverviewFetchActive = false
	session.DynamicDiscoveryActive = false
	session.Diagnostic9005Active = false
	session.Diagnostic9005Queue = nil
	session.Diagnostic9005Current = nil
	session.Diagnostic9005Invalid = nil
	session.Diagnostic9005Original = nil
	session.Diagnostic9005Requests = 0
	session.Diagnostic9005StartedAt = time.Time{}
	session.LastSentContext = ""
	session.LastSentParameters = nil
	if session.Diagnostic9005Cancel != nil {
		session.Diagnostic9005Cancel()
		session.Diagnostic9005Cancel = nil
	}
}

func (h *Handler) expire9005Diagnostic(ctx context.Context, sessionID string, startedAt time.Time) {
	session := h.sessions.Get(sessionID)
	if session == nil {
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
	h.clear9005Diagnostic(session)
}
