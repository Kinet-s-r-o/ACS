package cwmp

import (
	"sync"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

// SessionState track current state of a CWMP session
type SessionState int

const (
	StateWaitingInform SessionState = iota
	StateInformReceived
	StateProcessingTasks
	StateIdle
)

// Session represents single CPE session
type Session struct {
	mu                       sync.Mutex
	ID                       string
	SerialNumber             string
	DeviceID                 int64
	CurrentTaskID            int64
	CurrentDeleteObjectPath  string
	CurrentFullTreeFetch     bool
	FeatureObjectPath        string
	FeatureObjectInstance    string
	FeatureObjectStage       int
	FeatureObjectNames       []string
	AutoFetchPhase           int
	DataModelRoot            string
	CWMPNamespace            string
	AutoFetchReady           bool
	OverviewFetchReady       bool
	OverviewFetchActive      bool
	OverviewFetchParams      []string
	DynamicParameterBranches []string
	DynamicDiscoveryActive   bool
	DynamicDiscoveryQueue    []DynamicDiscoveryStep
	DynamicDiscoveryCurrent  *DynamicDiscoveryStep
	DynamicDiscoveryNames    []string
	InformEvents             []string
	Provisioning             *SetParameterValues
	ProvisioningRules        []models.ProvisioningApplication
	ProvisioningVariables    map[string]string
	// PendingSetParameters mirrors the last SetParameterValues request. A
	// successful response confirms these values on the CPE even when the next
	// periodic Inform does not include the affected parameters.
	PendingSetParameters  []ParameterValueStruct
	InformStaggerPending  bool
	InformStaggerInterval int64

	// AddObject queue for creating new objects before SetParameterValues
	AddObjectQueue     []*AddObject
	AddObjectPhase     int
	AddObjectInstances []string

	// Conditional provisioning state
	PendingConditionalRules  []models.ProvisioningApplication
	PendingConditionalConds  []*Condition
	PendingConditionalParams []string
	ConditionalFetchActive   bool
	PendingConditionalData   []*models.ProvisioningRule

	// Metric collection state
	DeviceType       string
	MetricFetchReady bool

	// LastSentContext holds a human-readable description of the last CWMP
	// operation sent to the CPE (parameter names, object name, etc.).
	// Used to populate Fault.ParameterName when a SOAP Fault arrives.
	LastSentContext    string
	LastSentParameters []string

	// Diagnostic9005 isolates an invalid parameter from a multi-parameter GPV
	// request. It is activated only for devices carrying the diagnostic tag.
	Diagnostic9005Active    bool
	Diagnostic9005Queue     [][]string
	Diagnostic9005Current   []string
	Diagnostic9005Invalid   []string
	Diagnostic9005Original  []string
	Diagnostic9005Requests  int
	Diagnostic9005StartedAt time.Time

	State        SessionState
	CreatedAt    time.Time
	LastActivity time.Time
}

type DynamicDiscoveryStep struct {
	Path     string
	Segments []string
	Index    int
	Leaf     bool
}

// SessionManager manage active CWMP sessions
type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	timeout  time.Duration
	maxSize  int
}

func NewSessionManager(timeout time.Duration) *SessionManager {
	sm := &SessionManager{
		sessions: make(map[string]*Session),
		timeout:  timeout,
		maxSize:  100000,
	}

	// Start cleanup goroutine
	go sm.cleanupLoop()

	return sm
}

// GetOrCreate get existing session atau create new
func (sm *SessionManager) GetOrCreate(sessionID, serialNumber string) *Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if s, ok := sm.sessions[sessionID]; ok {
		if serialNumber != "" && s.SerialNumber != serialNumber {
			// A CWMP cookie must never carry in-flight state across devices. This
			// can happen after a CPE restore or through a malformed client.
			s = &Session{
				ID:           sessionID,
				SerialNumber: serialNumber,
				State:        StateWaitingInform,
				CreatedAt:    time.Now(),
				LastActivity: time.Now(),
			}
			sm.sessions[sessionID] = s
			return s
		}
		s.mu.Lock()
		s.LastActivity = time.Now()
		s.mu.Unlock()
		return s
	}
	if sm.maxSize > 0 && len(sm.sessions) >= sm.maxSize {
		sm.removeOneLocked()
	}

	s := &Session{
		ID:           sessionID,
		SerialNumber: serialNumber,
		State:        StateWaitingInform,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
	}
	sm.sessions[sessionID] = s
	return s
}

func (sm *SessionManager) removeOneLocked() {
	for id := range sm.sessions {
		delete(sm.sessions, id)
		return
	}
}

// Get session by ID
func (sm *SessionManager) Get(sessionID string) *Session {
	sm.mu.RLock()
	session := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if session != nil {
		session.mu.Lock()
		session.LastActivity = time.Now()
		session.mu.Unlock()
	}
	return session
}

func (sm *SessionManager) Remove(sessionID string) {
	sm.mu.Lock()
	delete(sm.sessions, sessionID)
	sm.mu.Unlock()
}

// cleanupLoop remove expired sessions
func (sm *SessionManager) cleanupLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		sm.cleanup()
	}
}

func (sm *SessionManager) cleanup() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	now := time.Now()
	for id, s := range sm.sessions {
		s.mu.Lock()
		expired := now.Sub(s.LastActivity) > sm.timeout
		s.mu.Unlock()
		if expired {
			delete(sm.sessions, id)
		}
	}
}
