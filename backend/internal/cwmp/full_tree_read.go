package cwmp

import (
	"context"
	"fmt"
	"strings"

	"github.com/matrix8412/acs/internal/models"
)

const (
	fullTreeReadBatchSize = 64
	fullTreeReadMaxSplits = 128
)

// Keep the original task active until every batch succeeds. Partial results
// must never replace the cached full tree or complete a snapshot refresh.
type fullTreeRead struct {
	root      string
	names     []string
	current   []string
	values    []ParameterValueStruct
	retries   [][]string
	batchSize int
	splits    int
}

func (read *fullTreeRead) next() *GetParameterValues {
	if len(read.retries) > 0 {
		read.current = read.retries[0]
		read.retries = read.retries[1:]
		return &GetParameterValues{ParameterNames: read.current}
	}
	if len(read.names) == 0 {
		return nil
	}
	if read.batchSize == 0 {
		read.batchSize = fullTreeReadBatchSize
	}
	count := min(len(read.names), read.batchSize)
	request := &GetParameterValues{ParameterNames: read.names[:count]}
	read.current = request.ParameterNames
	read.names = read.names[count:]
	return request
}

func (read *fullTreeRead) split() *GetParameterValues {
	if len(read.current) < 2 || read.splits >= fullTreeReadMaxSplits {
		return nil
	}
	middle := len(read.current) / 2
	read.splits++
	// Retain both halves; a successful probe must not skip its sibling.
	read.retries = append([][]string{read.current[:middle], read.current[middle:]}, read.retries...)
	if read.batchSize == 0 {
		read.batchSize = fullTreeReadBatchSize
	}
	read.batchSize = min(read.batchSize, middle)
	return read.next()
}

func (read *fullTreeRead) accept(resp *GetParameterValuesResp) bool {
	values := make(map[string]ParameterValueStruct, len(resp.ParameterList.Parameters))
	for _, parameter := range resp.ParameterList.Parameters {
		values[parameter.Name] = parameter
	}
	for _, name := range read.current {
		if _, found := values[name]; !found {
			return false
		}
	}
	for _, name := range read.current {
		read.values = append(read.values, values[name])
	}
	return true
}

func (h *Handler) continueFullTreeRead(ctx context.Context, session *Session, resp *GetParameterNamesResp) (interface{}, error) {
	read := session.FullTreeRead
	seen := make(map[string]bool)
	for _, parameter := range resp.ParameterList {
		name := parameter.Name
		if strings.HasPrefix(name, read.root) && !strings.HasSuffix(name, ".") && !seen[name] {
			seen[name] = true
			read.names = append(read.names, name)
		}
	}
	if request := read.next(); request != nil {
		return request, nil
	}
	return h.failFullTreeRead(ctx, session, "Full parameter refresh failed: GetParameterNames returned no leaf parameters after GPV fault 9002")
}

func (h *Handler) failFullTreeRead(ctx context.Context, session *Session, message string) (interface{}, error) {
	root := session.FullTreeRead.root
	session.FullTreeRead = nil
	session.CurrentFullTreeFetch = false
	if h.faultRepo != nil && session.DeviceID > 0 {
		if err := h.faultRepo.Create(ctx, &models.Fault{DeviceID: session.DeviceID, FaultCode: "9002", FaultString: message, ParameterName: root}); err != nil {
			return nil, fmt.Errorf("record full-tree read failure: %w", err)
		}
	}
	if session.CurrentTaskID > 0 && h.taskRepo != nil {
		if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusFailed, nil, message); err != nil {
			return nil, fmt.Errorf("fail full-tree read task: %w", err)
		}
		session.CurrentTaskID = 0
	}
	if session.AutoFetchPhase > 0 {
		return h.continueAutoFetch(session)
	}
	return h.getNextTask(ctx, session)
}
