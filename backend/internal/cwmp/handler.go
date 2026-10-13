package cwmp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/database"
	"github.com/skydashnet/skyacs/internal/models"
	"gorm.io/gorm"
)

type Handler struct {
	sessions             *SessionManager
	deviceRepo           *database.DeviceRepository
	taskRepo             *database.TaskRepository
	parameterRepo        *database.ParameterRepository
	provisioningRepo     *database.ProvisioningRepository
	faultRepo            *database.FaultRepository
	blockedRepo          *database.BlockedDeviceRepository
	metricRepo           *database.MetricRepository
	settingsRepo         *database.SettingsRepository
	metricPollInterval   time.Duration
	overviewPollInterval time.Duration
	fullPollInterval     time.Duration
	cwmpUsername         string
	cwmpPassword         string
	allowedNetworks      []*net.IPNet
	trustedProxies       []*net.IPNet
}

func NewHandler(db *gorm.DB) *Handler {
	var deviceRepo *database.DeviceRepository
	var taskRepo *database.TaskRepository
	var parameterRepo *database.ParameterRepository
	var provisioningRepo *database.ProvisioningRepository
	var faultRepo *database.FaultRepository
	var blockedRepo *database.BlockedDeviceRepository
	var metricRepo *database.MetricRepository
	var settingsRepo *database.SettingsRepository

	if db != nil {
		deviceRepo = database.NewDeviceRepository(db)
		taskRepo = database.NewTaskRepository(db)
		parameterRepo = database.NewParameterRepository(db)
		provisioningRepo = database.NewProvisioningRepository(db)
		faultRepo = database.NewFaultRepository(db)
		blockedRepo = database.NewBlockedDeviceRepository(db)
		metricRepo = database.NewMetricRepository(db)
		settingsRepo = database.NewSettingsRepository(db)
	}

	pollInterval := 15 * time.Minute
	if v := os.Getenv("METRIC_POLL_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			pollInterval = d
		}
	}
	return &Handler{
		sessions:             NewSessionManager(2 * time.Minute),
		deviceRepo:           deviceRepo,
		taskRepo:             taskRepo,
		parameterRepo:        parameterRepo,
		provisioningRepo:     provisioningRepo,
		faultRepo:            faultRepo,
		blockedRepo:          blockedRepo,
		metricRepo:           metricRepo,
		settingsRepo:         settingsRepo,
		metricPollInterval:   pollInterval,
		overviewPollInterval: 15 * time.Minute,
		fullPollInterval:     6 * time.Hour,
		cwmpUsername:         os.Getenv("CWMP_USERNAME"),
		cwmpPassword:         os.Getenv("CWMP_PASSWORD"),
		allowedNetworks:      parseAllowedNetworks(os.Getenv("CWMP_ALLOWED_CIDRS")),
		trustedProxies:       parseAllowedNetworks(os.Getenv("CWMP_TRUSTED_PROXY_CIDRS")),
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.isNetworkAllowed(h.clientAddress(r)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	if h.cwmpUsername != "" || h.cwmpPassword != "" {
		if !h.isSecureRequest(r) {
			http.Error(w, "TLS required", http.StatusUpgradeRequired)
			return
		}
		username, password, ok := r.BasicAuth()
		if !ok || !secureEqual(username, h.cwmpUsername) || !secureEqual(password, h.cwmpPassword) {
			w.Header().Set("WWW-Authenticate", `Basic realm="ACS CWMP"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionKey := ""
	if cookie, err := r.Cookie("cwmp_session"); err == nil {
		sessionKey = cookie.Value
	}
	if sessionKey == "" {
		sessionKey = newSessionKey()
		http.SetCookie(w, &http.Cookie{
			Name:     "cwmp_session",
			Value:    sessionKey,
			Path:     "/",
			HttpOnly: true,
			Secure:   h.isSecureRequest(r),
			SameSite: http.SameSiteStrictMode,
			MaxAge:   300,
		})
	}

	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	envelope, err := ParseSOAPEnvelope(r.Body)
	if err != nil {
		log.Printf("Error parsing SOAP: %v", err)
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	if envelope == nil {
		response, namespace, err := h.handleEmptyPost(r.Context(), sessionKey)
		if err != nil {
			log.Printf("Error dispatching CWMP request: %v", err)
			h.sendFault(w, err, nil)
			return
		}
		if response == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		responseBytes, err := GenerateSOAPEnvelopeWithContext(response, namespace, newMessageID())
		if err != nil {
			h.failCurrentTask(r.Context(), sessionKey, err)
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/xml; charset=utf-8")
		if _, err := w.Write(responseBytes); err != nil {
			log.Printf("Error writing CWMP request: %v", err)
		}
		return
	}

	response, err := h.routeMessage(r.Context(), envelope, sessionKey)
	if err != nil {
		log.Printf("Error processing message: %v", err)
		h.sendFault(w, err, envelope)
		return
	}

	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	if response == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	responseBytes, err := GenerateSOAPEnvelopeForRequest(response, envelope)
	if err != nil {
		log.Printf("Error generating response: %v", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if _, err := w.Write(responseBytes); err != nil {
		log.Printf("Error writing CWMP response: %v", err)
	}
}

func (h *Handler) routeMessage(ctx context.Context, envelope *SOAPEnvelope, remoteAddr string) (interface{}, error) {
	msgType := DetectMessageType(&envelope.Body)
	log.Printf("Received CWMP message: %s from %s", msgType, remoteAddr)

	switch msgType {
	case "Inform":
		return h.handleInform(ctx, envelope, remoteAddr)

	case "GetParameterValuesResponse":
		return h.handleGetParameterValuesResponse(ctx, envelope.Body.GetParameterValuesResp, remoteAddr)

	case "GetParameterNamesResponse":
		return h.handleGetParameterNamesResponse(ctx, envelope.Body.GetParameterNamesResp, remoteAddr)

	case "SetParameterValuesResponse":
		return h.handleSetParameterValuesResponse(ctx, envelope.Body.SetParameterValuesResp, remoteAddr)

	case "RebootResponse":
		return h.handleRebootResponse(ctx, remoteAddr)

	case "FactoryResetResponse":
		return h.handleFactoryResetResponse(ctx, remoteAddr)

	case "DownloadResponse":
		return h.handleDownloadResponse(ctx, envelope.Body.DownloadResponse, remoteAddr)

	case "TransferComplete":
		return h.handleTransferComplete(ctx, envelope.Body.TransferComplete, remoteAddr)

	case "AddObjectResponse":
		return h.handleAddObjectResponse(ctx, envelope.Body.AddObjectResponse, remoteAddr)

	case "Fault":
		return h.handleFault(ctx, envelope.Body.Fault, remoteAddr)

	default:
		return &SOAPFault{FaultCode: "Client", FaultString: "CWMP fault", Detail: FaultDetail{CWMPFault: &CWMPFault{FaultCode: "8000", FaultString: "Method not supported"}}}, nil
	}
}

func (h *Handler) handleInform(ctx context.Context, envelope *SOAPEnvelope, remoteAddr string) (interface{}, error) {
	inform := envelope.Body.Inform
	if inform == nil || inform.DeviceId.SerialNumber == "" {
		return nil, fmt.Errorf("device serial number is required")
	}
	if h.blockedRepo != nil {
		blocked, err := h.blockedRepo.IsBlocked(ctx, inform.DeviceId.SerialNumber)
		if err != nil {
			return nil, fmt.Errorf("check device admission: %w", err)
		}
		if blocked {
			log.Printf("Blocked device rejected: %s", inform.DeviceId.SerialNumber)
			h.sessions.Remove(remoteAddr)
			if h.deviceRepo != nil {
				if err := h.deviceRepo.SetOffline(ctx, inform.DeviceId.SerialNumber); err != nil {
					log.Printf("Failed to mark blocked device offline: %v", err)
				}
			}
			return &InformResponse{MaxEnvelopes: 1}, nil
		}
	}

	response, err := ProcessInform(inform)
	if err != nil {
		return nil, err
	}

	var deviceID int64

	if h.deviceRepo != nil {
		params := ExtractImportantParameters(inform.ParameterList.Parameters)

		var ipAddrStr *string
		if ip := params["ExternalIPAddress"]; ip != "" {
			ipAddrStr = &ip
		}

		device := &models.Device{
			SerialNumber:         inform.DeviceId.SerialNumber,
			OUI:                  inform.DeviceId.OUI,
			Manufacturer:         strPtr(inform.DeviceId.Manufacturer),
			ProductClass:         strPtr(inform.DeviceId.ProductClass),
			HardwareVersion:      strPtr(params["HardwareVersion"]),
			SoftwareVersion:      strPtr(params["SoftwareVersion"]),
			IPAddress:            ipAddrStr,
			ConnectionRequestURL: strPtr(params["ConnectionRequestURL"]),
		}

		if err := h.deviceRepo.UpsertFromInform(ctx, device); err != nil {
			log.Printf("Error saving device: %v", err)
		} else {
			deviceID = device.ID
			log.Printf("Device saved: %s (ID: %d)", device.SerialNumber, device.ID)
		}

		if h.parameterRepo != nil && deviceID > 0 && len(inform.ParameterList.Parameters) > 0 {
			// Inform is a partial update, not an inventory of the parameter tree.
			paramsToSave := make([]models.DeviceParameter, 0, len(inform.ParameterList.Parameters))
			for _, parameter := range inform.ParameterList.Parameters {
				paramsToSave = append(paramsToSave, models.DeviceParameter{
					DeviceID: deviceID,
					Name:     parameter.Name,
					Value:    parameter.Value,
				})
			}
			log.Printf("Inform from %s carries %d parameters", inform.DeviceId.SerialNumber, len(inform.ParameterList.Parameters))
			if err := h.parameterRepo.SaveInformParameters(ctx, deviceID, paramsToSave); err != nil {
				log.Printf("Error saving Inform parameters: %v", err)
			}
		}

		if h.metricRepo != nil && deviceID > 0 {
			deviceType := inform.DeviceId.Manufacturer + "/" + inform.DeviceId.ProductClass
			paramMap := make(map[string]string, len(inform.ParameterList.Parameters))
			for _, p := range inform.ParameterList.Parameters {
				paramMap[p.Name] = p.Value
			}
			if err := h.metricRepo.ExtractAndStore(ctx, deviceID, deviceType, paramMap); err != nil {
				log.Printf("Error extracting metrics from Inform: %v", err)
			}
		}
	}

	hasBootstrap := hasEvent(inform, EventBootstrap)
	var provisioning *SetParameterValues
	var provisioningRules []models.ProvisioningApplication
	var addObjectQueue []*AddObject
	var sessionPendingConds []*Condition
	var sessionPendingApps []models.ProvisioningApplication
	var sessionPendingParams []string
	var sessionPendingData []*models.ProvisioningRule
	var sessionCondFetchActive bool
	var sessionImmediateEval bool
	provisioningVariableValues := map[string]string{}

	if deviceID > 0 && h.provisioningRepo != nil {
		if template, err := h.provisioningRepo.ResolveTemplateForDevice(ctx, inform.DeviceId.Manufacturer, inform.DeviceId.ProductClass); err == nil {
			parameterValues := make(map[string]string, len(inform.ParameterList.Parameters))
			for _, parameter := range inform.ParameterList.Parameters {
				parameterValues[parameter.Name] = parameter.Value
			}
			if values, err := resolveProvisioningVariables(template.Variables, inform.DeviceId, parameterValues); err != nil {
				log.Printf("Could not resolve provisioning variables for device %s: %v", inform.DeviceId.SerialNumber, err)
			} else {
				provisioningVariableValues = values
			}
		}
		var allRules []*models.ProvisioningRule

		// Default phase rules apply on every inform (re-applied when rule version changes)
		defaultRules, err := h.provisioningRepo.ListPendingForDevice(ctx, deviceID, inform.DeviceId.Manufacturer, inform.DeviceId.ProductClass, "default")
		if err == nil {
			allRules = append(allRules, defaultRules...)
		}

		// Bootstrap phase rules: on BOOTSTRAP event the CPE is in factory state,
		// so always re-apply regardless of prior application records.
		if hasBootstrap {
			bootstrapRules, err := h.provisioningRepo.ListForDevice(ctx, deviceID, inform.DeviceId.Manufacturer, inform.DeviceId.ProductClass, "bootstrap")
			if err == nil {
				allRules = append(allRules, bootstrapRules...)
			}
		}

		if len(allRules) > 0 {
			log.Printf("Applying %d provisioning rules to device %s", len(allRules), inform.DeviceId.SerialNumber)

			spv := &SetParameterValues{ParameterKey: "auto-provisioning"}
			var conditionalRules []*models.ProvisioningRule
			for _, rule := range allRules {
				if rule.Condition != "" {
					conditionalRules = append(conditionalRules, rule)
					continue
				}
				if rule.AddObjectPath != "" {
					provisioningRules = append(provisioningRules, models.ProvisioningApplication{RuleID: rule.ID, RuleVersion: rule.Version})
					addObjectQueue = append(addObjectQueue, addObjectForPath(rule.AddObjectPath))
				} else {
					value, err := expandProvisioningValue(rule.ParameterValue, provisioningVariableValues)
					if err != nil {
						log.Printf("Could not expand provisioning rule %d for device %s: %v", rule.ID, inform.DeviceId.SerialNumber, err)
						continue
					}
					provisioningRules = append(provisioningRules, models.ProvisioningApplication{RuleID: rule.ID, RuleVersion: rule.Version})
					spv.ParameterList.Parameters = append(spv.ParameterList.Parameters, ParameterValueStruct{
						Name:  rule.ParameterName,
						Value: value,
						Type:  rule.ParameterType,
					})
				}
			}

			if len(addObjectQueue) > 0 {
				log.Printf("Queued %d AddObject operations for device %s", len(addObjectQueue), inform.DeviceId.SerialNumber)
			}

			if len(spv.ParameterList.Parameters) > 0 {
				provisioning = spv
			}

			// Parse conditions and collect params needed for GPV fetch
			if len(conditionalRules) > 0 {
				log.Printf("Deferring %d conditional rules for device %s", len(conditionalRules), inform.DeviceId.SerialNumber)
				seen := make(map[string]bool)
				var condParams []string
				var pendingConds []*Condition
				var pendingApps []models.ProvisioningApplication
				var pendingData []*models.ProvisioningRule
				for _, rule := range conditionalRules {
					cond, err := ParseCondition(rule.Condition)
					if err != nil {
						log.Printf("Invalid condition on rule %d: %v (skipping)", rule.ID, err)
						continue
					}
					app := models.ProvisioningApplication{RuleID: rule.ID, RuleVersion: rule.Version}
					pendingApps = append(pendingApps, app)
					pendingConds = append(pendingConds, cond)
					pendingData = append(pendingData, rule)
					for _, p := range ExtractParamNames(cond) {
						if !seen[p] {
							seen[p] = true
							condParams = append(condParams, p)
						}
					}
				}
				if len(condParams) > 0 {
					sessionPendingConds = pendingConds
					sessionPendingApps = pendingApps
					sessionPendingParams = condParams
					sessionCondFetchActive = true
					sessionPendingData = pendingData
				} else if len(pendingConds) > 0 {
					// No params needed — evaluate immediately with empty map
					sessionPendingConds = pendingConds
					sessionPendingApps = pendingApps
					sessionCondFetchActive = false
					sessionPendingData = pendingData
					// Mark for immediate evaluation after session is created
					sessionImmediateEval = true
				}
			}
		}
	}

	session := h.sessions.GetOrCreate(remoteAddr, inform.DeviceId.SerialNumber)
	overviewInterval, fullInterval := h.refreshIntervals(ctx)
	session.mu.Lock()
	isNewSession := session.State == StateWaitingInform
	session.State = StateInformReceived
	session.DeviceID = deviceID
	session.DeviceType = inform.DeviceId.Manufacturer + "/" + inform.DeviceId.ProductClass
	session.DataModelRoot = DetectDataModelRoot(inform.ParameterList.Parameters)
	session.CWMPNamespace = envelope.CWMPNamespace
	session.Provisioning = provisioning
	session.ProvisioningRules = provisioningRules
	session.ProvisioningVariables = provisioningVariableValues
	session.AddObjectInstances = nil
	session.AddObjectQueue = addObjectQueue
	session.AddObjectPhase = 0
	// Conditional provisioning
	session.PendingConditionalConds = sessionPendingConds
	session.PendingConditionalRules = sessionPendingApps
	session.PendingConditionalParams = sessionPendingParams
	session.PendingConditionalData = sessionPendingData
	session.ConditionalFetchActive = sessionCondFetchActive
	if sessionImmediateEval {
		h.evaluateConditionalRules(session, h.buildDeviceAttrs(ctx, deviceID))
	}
	// The database timestamps survive CWMP session expiry and ACS restarts.
	// A new session alone must not force a full-tree read.
	session.AutoFetchReady = hasBootstrap
	session.OverviewFetchReady = false
	session.OverviewFetchActive = false
	session.OverviewFetchParams = nil
	if h.deviceRepo == nil {
		session.AutoFetchReady = session.AutoFetchReady || isNewSession
	} else if deviceID > 0 {
		stored, err := h.deviceRepo.GetBySerial(ctx, inform.DeviceId.SerialNumber)
		if err != nil {
			log.Printf("Error loading refresh times for %s: %v", inform.DeviceId.SerialNumber, err)
		} else if stored != nil {
			session.AutoFetchReady = session.AutoFetchReady || refreshDue(stored.LastFullRefresh, fullInterval)
			if !session.AutoFetchReady && refreshDue(stored.LastOverviewRefresh, overviewInterval) && h.parameterRepo != nil {
				if names, err := h.parameterRepo.OverviewNames(ctx, deviceID); err != nil {
					log.Printf("Error loading overview parameters for %s: %v", inform.DeviceId.SerialNumber, err)
				} else if len(names) > 0 {
					session.OverviewFetchReady = true
					session.OverviewFetchParams = names
				}
			}
		}
	}
	// Active metric polling: schedule a GPV fetch if the interval has elapsed.
	if h.metricRepo != nil && deviceID > 0 && h.metricPollInterval > 0 {
		if time.Since(session.LastMetricFetch) >= h.metricPollInterval {
			if params, err := h.metricRepo.ActiveParamNames(ctx, session.DeviceType); err == nil {
				if interfaceParams, interfaceErr := h.metricRepo.InterfaceActiveParamNames(ctx, deviceID, session.DeviceType); interfaceErr == nil {
					seen := make(map[string]bool, len(params))
					for _, name := range params {
						seen[name] = true
					}
					for _, name := range interfaceParams {
						if !seen[name] {
							params = append(params, name)
							seen[name] = true
						}
					}
				}
				if len(params) > 0 {
					session.MetricFetchReady = true
					session.MetricFetchParams = params
				}
			}
		}
	}
	session.mu.Unlock()

	return response, nil
}

func hasEvent(inform *Inform, code string) bool {
	for _, event := range inform.Event.Events {
		if event.EventCode == code {
			return true
		}
	}
	return false
}

func refreshDue(last *time.Time, interval time.Duration) bool {
	return last == nil || time.Since(*last) >= interval
}

func (h *Handler) refreshIntervals(ctx context.Context) (time.Duration, time.Duration) {
	overview, full := h.overviewPollInterval, h.fullPollInterval
	if h.settingsRepo == nil {
		return overview, full
	}
	values, err := h.settingsRepo.GetValues(ctx, "overview_poll_interval", "full_tree_poll_interval")
	if err != nil {
		log.Printf("Error loading provisioning refresh intervals: %v", err)
		return overview, full
	}
	if value, err := time.ParseDuration(values["overview_poll_interval"]); err == nil && value >= time.Minute && value <= 24*time.Hour {
		overview = value
	}
	if value, err := time.ParseDuration(values["full_tree_poll_interval"]); err == nil && value >= 15*time.Minute && value <= 7*24*time.Hour {
		full = value
	}
	return overview, full
}

func addObjectForPath(path string) *AddObject {
	return &AddObject{
		ObjectName:   strings.TrimSuffix(path, ".") + ".",
		ParameterKey: "auto-provisioning",
	}
}

func (h *Handler) handleEmptyPost(ctx context.Context, sessionID string) (interface{}, string, error) {
	session := h.sessions.Get(sessionID)
	if session == nil {
		return nil, CWMPNamespace10, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()

	namespace := defaultNamespace(session.CWMPNamespace)
	request, err := h.getNextTask(ctx, session)
	if err != nil || request != nil {
		return request, namespace, err
	}
	if len(session.AddObjectQueue) > 0 && session.AddObjectPhase < len(session.AddObjectQueue) {
		nextObj := session.AddObjectQueue[session.AddObjectPhase]
		nextObj.ObjectName = resolveAddObjectReferences(nextObj.ObjectName, session.AddObjectInstances)
		session.State = StateProcessingTasks
		session.LastSentContext = nextObj.ObjectName
		log.Printf("Sending AddObject: %s to %s", nextObj.ObjectName, sessionID)
		return nextObj, namespace, nil
	}
	// Conditional provisioning: fetch params needed for condition evaluation
	if session.ConditionalFetchActive && len(session.PendingConditionalParams) > 0 {
		session.ConditionalFetchActive = false
		session.State = StateProcessingTasks
		session.LastSentContext = strings.Join(session.PendingConditionalParams, ", ")
		log.Printf("Sending GPV for %d conditional params to %s", len(session.PendingConditionalParams), sessionID)
		return &GetParameterValues{ParameterNames: session.PendingConditionalParams}, namespace, nil
	}
	if session.Provisioning != nil {
		var paramNames []string
		for _, p := range session.Provisioning.ParameterList.Parameters {
			paramNames = append(paramNames, p.Name)
		}
		session.LastSentContext = strings.Join(paramNames, ", ")
		request = takeProvisioning(session)
		session.State = StateProcessingTasks
		return request, namespace, nil
	}
	if session.AutoFetchReady {
		session.AutoFetchReady = false
		session.OverviewFetchReady = false
		session.MetricFetchReady = false
		session.AutoFetchPhase = 1
		session.State = StateProcessingTasks
		session.LastSentContext = session.DataModelRoot
		return &GetParameterValues{ParameterNames: []string{session.DataModelRoot}}, namespace, nil
	}
	if session.OverviewFetchReady {
		session.OverviewFetchReady = false
		session.OverviewFetchActive = true
		session.State = StateProcessingTasks
		session.LastSentContext = strings.Join(session.OverviewFetchParams, ", ")
		return &GetParameterValues{ParameterNames: session.OverviewFetchParams}, namespace, nil
	}
	if session.MetricFetchReady {
		session.MetricFetchReady = false
		session.State = StateProcessingTasks
		session.LastSentContext = strings.Join(session.MetricFetchParams, ", ")
		return &GetParameterValues{ParameterNames: session.MetricFetchParams}, namespace, nil
	}
	session.State = StateIdle
	return nil, namespace, nil
}

func (h *Handler) handleGetParameterValuesResponse(ctx context.Context, resp *GetParameterValuesResp, remoteAddr string) (interface{}, error) {
	log.Printf("Received GetParameterValuesResponse with %d parameters from %s", len(resp.ParameterList.Parameters), remoteAddr)

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		log.Printf("No active session found for %s", remoteAddr)
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()

	if session.State != StateProcessingTasks {
		log.Printf("Session for %s not in processing state", remoteAddr)
		return nil, nil
	}

	if h.parameterRepo != nil && session.DeviceID > 0 {
		params := make([]models.DeviceParameter, 0, len(resp.ParameterList.Parameters))
		for _, p := range resp.ParameterList.Parameters {
			params = append(params, models.DeviceParameter{
				DeviceID:  session.DeviceID,
				Name:      p.Name,
				Value:     p.Value,
				ValueType: p.ValueType,
			})
		}
		fullTree := session.AutoFetchPhase == 1 && session.CurrentTaskID == 0 && len(params) > 0
		var saveErr error
		if fullTree {
			saveErr = h.parameterRepo.SaveFullTreeParameters(ctx, session.DeviceID, params)
		} else {
			saveErr = h.parameterRepo.UpsertMany(ctx, session.DeviceID, params)
		}
		if err := saveErr; err != nil {
			log.Printf("Error saving parameters: %v", err)
		} else {
			log.Printf("Saved %d parameters for device %d (serial: %s)", len(params), session.DeviceID, session.SerialNumber)
			if h.deviceRepo != nil {
				if err := h.deviceRepo.UpdateFromParameters(ctx, session.DeviceID, ExtractImportantParameters(resp.ParameterList.Parameters)); err != nil {
					log.Printf("Error updating device details from parameters: %v", err)
				}
			}
			if fullTree && h.deviceRepo != nil {
				if err := h.deviceRepo.MarkFullRefresh(ctx, session.DeviceID); err != nil {
					log.Printf("Error recording full-tree refresh: %v", err)
				}
			} else if session.OverviewFetchActive && len(params) > 0 && h.deviceRepo != nil {
				if err := h.deviceRepo.MarkOverviewRefresh(ctx, session.DeviceID); err != nil {
					log.Printf("Error recording overview refresh: %v", err)
				}
			}
		}
	}

	if h.metricRepo != nil && session.DeviceID > 0 {
		paramMap := make(map[string]string, len(resp.ParameterList.Parameters))
		for _, p := range resp.ParameterList.Parameters {
			paramMap[p.Name] = p.Value
		}
		if err := h.metricRepo.ExtractAndStore(ctx, session.DeviceID, session.DeviceType, paramMap); err != nil {
			log.Printf("Error extracting metrics from GPV response: %v", err)
		}
		session.LastMetricFetch = time.Now()
	}

	// Conditional provisioning: evaluate conditions against fetched params
	if len(session.PendingConditionalConds) > 0 {
		paramMap := make(map[string]string, len(resp.ParameterList.Parameters))
		for _, p := range resp.ParameterList.Parameters {
			paramMap[p.Name] = p.Value
		}
		// Inject device attrs for hasTag/notHasTag and device.* conditions
		for k, v := range h.buildDeviceAttrs(ctx, session.DeviceID) {
			if _, exists := paramMap[k]; !exists {
				paramMap[k] = v
			}
		}
		h.evaluateConditionalRules(session, paramMap)
		// After evaluation, the next empty post will send the SPV if any rules were satisfied
		return h.getNextTask(ctx, session)
	}

	if session.AutoFetchPhase > 0 {
		return h.continueAutoFetch(session)
	}
	if session.OverviewFetchActive {
		session.OverviewFetchActive = false
		return h.getNextTask(ctx, session)
	}
	if session.CurrentTaskID > 0 && h.taskRepo != nil {
		result := make(map[string]string)
		for _, p := range resp.ParameterList.Parameters {
			if database.IsSensitiveParameterName(p.Name) {
				result[p.Name] = "[REDACTED]"
			} else {
				result[p.Name] = p.Value
			}
		}
		if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusCompleted, result, ""); err != nil {
			return nil, fmt.Errorf("complete parameter task: %w", err)
		}
		session.CurrentTaskID = 0
	}

	return h.getNextTask(ctx, session)
}

func (h *Handler) continueAutoFetch(session *Session) (interface{}, error) {
	if session.AutoFetchPhase == 1 {
		session.AutoFetchPhase = 2
		return &GetParameterNames{ParameterPath: session.DataModelRoot, NextLevel: false}, nil
	}
	session.AutoFetchPhase = 0
	session.State = StateIdle
	return nil, nil
}

func (h *Handler) handleGetParameterNamesResponse(ctx context.Context, resp *GetParameterNamesResp, remoteAddr string) (interface{}, error) {
	if resp == nil {
		return nil, nil
	}
	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if h.parameterRepo != nil && session.DeviceID > 0 {
		params := make([]models.DeviceParameter, 0, len(resp.ParameterList))
		for _, parameter := range resp.ParameterList {
			writable := parameter.Writable
			params = append(params, models.DeviceParameter{Name: parameter.Name, Writable: &writable})
		}
		if err := h.parameterRepo.UpsertWritable(ctx, session.DeviceID, params); err != nil {
			log.Printf("Error saving writable parameter flags: %v", err)
		}
	}
	session.AutoFetchPhase = 0
	session.State = StateIdle
	return h.getNextTask(ctx, session)
}

func (h *Handler) handleSetParameterValuesResponse(ctx context.Context, resp *SetParameterValuesResp, remoteAddr string) (interface{}, error) {
	if resp == nil {
		return nil, errors.New("missing SetParameterValuesResponse")
	}
	log.Printf("SetParameterValues status: %d from %s", resp.Status, remoteAddr)

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	session.LastSentContext = ""

	if session.State == StateProcessingTasks && session.CurrentTaskID > 0 {
		if h.taskRepo != nil {
			if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusCompleted, map[string]int{"status": resp.Status}, ""); err != nil {
				return nil, fmt.Errorf("complete set-parameter task: %w", err)
			}
		}
		session.CurrentTaskID = 0
		return h.getNextTask(ctx, session)
	}
	if session.State == StateProcessingTasks && len(session.ProvisioningRules) > 0 {
		if h.provisioningRepo != nil {
			if err := h.provisioningRepo.MarkApplied(ctx, session.DeviceID, session.ProvisioningRules); err != nil {
				return nil, fmt.Errorf("record provisioning application: %w", err)
			}
		}
		session.ProvisioningRules = nil
		return h.getNextTask(ctx, session)
	}

	return nil, nil
}

func (h *Handler) handleAddObjectResponse(ctx context.Context, resp *AddObjectResponse, remoteAddr string) (interface{}, error) {
	if resp == nil {
		return nil, errors.New("missing AddObjectResponse")
	}
	log.Printf("AddObject response: InstanceNumber=%s, Status=%d from %s", resp.InstanceNumber, resp.Status, remoteAddr)

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	session.LastSentContext = ""

	if session.State != StateProcessingTasks {
		return nil, nil
	}

	// Preserve every AddObject result so later rules can refer to any instance.
	session.AddObjectInstances = append(session.AddObjectInstances, resp.InstanceNumber)
	session.AddObjectPhase++

	// If more AddObjects in queue, send the next one
	if session.AddObjectPhase < len(session.AddObjectQueue) {
		nextObj := session.AddObjectQueue[session.AddObjectPhase]
		nextObj.ObjectName = resolveAddObjectReferences(nextObj.ObjectName, session.AddObjectInstances)
		log.Printf("Sending next AddObject: %s", nextObj.ObjectName)
		return nextObj, nil
	}

	// All AddObjects done, proceed to provisioning
	session.AddObjectQueue = nil
	session.AddObjectPhase = 0
	if session.Provisioning != nil {
		return takeProvisioning(session), nil
	}
	if h.provisioningRepo != nil && len(session.ProvisioningRules) > 0 {
		if err := h.provisioningRepo.MarkApplied(ctx, session.DeviceID, session.ProvisioningRules); err != nil {
			return nil, fmt.Errorf("record add-object provisioning application: %w", err)
		}
	}
	session.ProvisioningRules = nil
	return h.getNextTask(ctx, session)
}

func takeProvisioning(session *Session) *SetParameterValues {
	request := session.Provisioning
	session.Provisioning = nil
	if request != nil && len(session.AddObjectInstances) > 0 {
		for i := range request.ParameterList.Parameters {
			parameter := &request.ParameterList.Parameters[i]
			parameter.Name = resolveAddObjectReferences(parameter.Name, session.AddObjectInstances)
			parameter.Value = resolveAddObjectReferences(parameter.Value, session.AddObjectInstances)
		}
	}
	return request
}

// buildDeviceAttrs loads device-level attributes (tags, product class, manufacturer)
// and returns them as a params map suitable for condition evaluation.
func (h *Handler) buildDeviceAttrs(ctx context.Context, deviceID int64) map[string]string {
	attrs := make(map[string]string)
	if h.deviceRepo == nil || deviceID <= 0 {
		return attrs
	}
	device, err := h.deviceRepo.GetByID(ctx, deviceID)
	if err != nil || device == nil {
		return attrs
	}
	if len(device.Tags) > 0 {
		attrs["device.tags"] = strings.Join(device.Tags, ",")
	}
	if device.ProductClass != nil && *device.ProductClass != "" {
		attrs["device.product_class"] = *device.ProductClass
	}
	if device.Manufacturer != nil && *device.Manufacturer != "" {
		attrs["device.manufacturer"] = *device.Manufacturer
	}
	return attrs
}

// evaluateConditionalRules evaluates pending conditional rules against the provided
// parameter map. Satisfied rules are merged into session.Provisioning (or a new SPV
// is created). The pending state is cleared after evaluation.
func (h *Handler) evaluateConditionalRules(session *Session, params map[string]string) {
	if len(session.PendingConditionalConds) == 0 {
		return
	}

	var satisfiedApps []models.ProvisioningApplication
	var spvParams []ParameterValueStruct
	var addObjectQueue []*AddObject

	for i, cond := range session.PendingConditionalConds {
		result, err := Evaluate(cond, params)
		if err != nil {
			log.Printf("Error evaluating condition for rule %d: %v (skipping)", session.PendingConditionalRules[i].RuleID, err)
			continue
		}
		if !result {
			log.Printf("Condition not met for rule %d (serial: %s)", session.PendingConditionalRules[i].RuleID, session.SerialNumber)
			continue
		}
		rule := session.PendingConditionalData[i]
		log.Printf("Condition satisfied for rule %d (serial: %s)", rule.ID, session.SerialNumber)
		if rule.AddObjectPath != "" {
			satisfiedApps = append(satisfiedApps, session.PendingConditionalRules[i])
			addObjectQueue = append(addObjectQueue, addObjectForPath(rule.AddObjectPath))
		} else {
			value, err := expandProvisioningValue(rule.ParameterValue, session.ProvisioningVariables)
			if err != nil {
				log.Printf("Could not expand conditional provisioning rule %d for device %s: %v", rule.ID, session.SerialNumber, err)
				continue
			}
			satisfiedApps = append(satisfiedApps, session.PendingConditionalRules[i])
			spvParams = append(spvParams, ParameterValueStruct{
				Name:  rule.ParameterName,
				Value: value,
				Type:  rule.ParameterType,
			})
		}
	}

	// Merge into existing provisioning or create new
	if len(spvParams) > 0 || len(addObjectQueue) > 0 {
		if session.Provisioning == nil {
			session.Provisioning = &SetParameterValues{ParameterKey: "auto-provisioning"}
		}
		session.Provisioning.ParameterList.Parameters = append(session.Provisioning.ParameterList.Parameters, spvParams...)
		if len(addObjectQueue) > 0 {
			session.AddObjectQueue = append(session.AddObjectQueue, addObjectQueue...)
		}
	}

	// Track satisfied rules for MarkApplied
	session.ProvisioningRules = append(session.ProvisioningRules, satisfiedApps...)

	// Clear pending state
	session.PendingConditionalConds = nil
	session.PendingConditionalRules = nil
	session.PendingConditionalParams = nil
	session.PendingConditionalData = nil
	session.ConditionalFetchActive = false
}

func (h *Handler) handleRebootResponse(ctx context.Context, remoteAddr string) (interface{}, error) {
	log.Printf("Received RebootResponse from %s", remoteAddr)

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()

	if session.State == StateProcessingTasks && session.CurrentTaskID > 0 {
		if h.taskRepo != nil {
			if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusCompleted, nil, ""); err != nil {
				return nil, fmt.Errorf("complete reboot task: %w", err)
			}
		}
		session.CurrentTaskID = 0
		return h.getNextTask(ctx, session)
	}

	return nil, nil
}

func (h *Handler) handleFactoryResetResponse(ctx context.Context, remoteAddr string) (interface{}, error) {
	log.Printf("Received FactoryResetResponse from %s", remoteAddr)

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()

	if session.State == StateProcessingTasks && session.CurrentTaskID > 0 {
		if h.taskRepo != nil {
			if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusCompleted, nil, ""); err != nil {
				return nil, fmt.Errorf("complete factory-reset task: %w", err)
			}
		}
		session.CurrentTaskID = 0
		return h.getNextTask(ctx, session)
	}

	return nil, nil
}

func (h *Handler) handleDownloadResponse(ctx context.Context, resp *DownloadResponse, remoteAddr string) (interface{}, error) {
	if resp == nil {
		return nil, nil
	}
	log.Printf("Received DownloadResponse: Status=%d from %s", resp.Status, remoteAddr)

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()

	if session.State == StateProcessingTasks && session.CurrentTaskID > 0 {
		if resp.Status == 0 {
			if h.taskRepo != nil {
				if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusCompleted, nil, ""); err != nil {
					return nil, fmt.Errorf("complete download task: %w", err)
				}
			}
			session.CurrentTaskID = 0
			return h.getNextTask(ctx, session)
		}
		log.Printf("Download started, waiting for TransferComplete")
		return nil, nil
	}
	return nil, nil
}

func (h *Handler) handleTransferComplete(ctx context.Context, tc *TransferComplete, remoteAddr string) (interface{}, error) {
	if tc == nil {
		return nil, nil
	}
	log.Printf("Received TransferComplete: CommandKey=%s, FaultCode=%d from %s", tc.CommandKey, tc.FaultStruct.FaultCode, remoteAddr)

	if h.taskRepo != nil && tc.CommandKey != "" {
		status := models.TaskStatusCompleted
		errorMessage := ""
		if tc.FaultStruct.FaultCode != 0 {
			status = models.TaskStatusFailed
			errorMessage = tc.FaultStruct.FaultString
		}
		result := map[string]interface{}{
			"fault_code":    tc.FaultStruct.FaultCode,
			"start_time":    tc.StartTime,
			"complete_time": tc.CompleteTime,
		}
		if err := h.taskRepo.UpdateByCommandKey(ctx, tc.CommandKey, status, result, errorMessage); err != nil && err != gorm.ErrRecordNotFound {
			return nil, fmt.Errorf("complete transfer task: %w", err)
		}
	}

	return &TransferCompleteResponse{}, nil
}

func (h *Handler) handleFault(ctx context.Context, fault *SOAPFault, remoteAddr string) (interface{}, error) {
	if fault == nil {
		return nil, errors.New("missing SOAP fault")
	}
	log.Printf("Received SOAP Fault: %s - %s from %s", fault.FaultCode, fault.FaultString, remoteAddr)

	faultCode := fault.FaultCode
	faultMessage := fault.FaultString
	if fault.Detail.CWMPFault != nil {
		log.Printf("  CWMP Fault: %s - %s",
			fault.Detail.CWMPFault.FaultCode,
			fault.Detail.CWMPFault.FaultString,
		)
		faultCode = fault.Detail.CWMPFault.FaultCode
		faultMessage = fault.Detail.CWMPFault.FaultString
	}

	session := h.sessions.Get(remoteAddr)
	if session == nil {
		return nil, nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()

	if session.State == StateProcessingTasks {
		if h.faultRepo != nil && session.DeviceID > 0 && session.AutoFetchPhase == 0 {
			deviceFault := &models.Fault{
				DeviceID:      session.DeviceID,
				FaultCode:     faultCode,
				FaultString:   faultMessage,
				ParameterName: session.LastSentContext,
			}
			if err := h.faultRepo.Create(ctx, deviceFault); err != nil {
				log.Printf("Error saving fault: %v", err)
			}
		}
		session.LastSentContext = ""
		if session.CurrentTaskID == 0 && len(session.AddObjectQueue) > 0 {
			log.Printf("Aborting provisioning after AddObject fault: %s - %s", faultCode, faultMessage)
			session.AddObjectQueue = nil
			session.AddObjectPhase = 0
			session.AddObjectInstances = nil
			session.Provisioning = nil
			session.ProvisioningRules = nil
			return h.getNextTask(ctx, session)
		}

		if session.AutoFetchPhase > 0 {
			log.Printf("Auto-fetch phase %d failed, continuing to next phase", session.AutoFetchPhase)
			return h.continueAutoFetch(session)
		}
		if session.OverviewFetchActive {
			session.OverviewFetchActive = false
			return h.getNextTask(ctx, session)
		}

		if session.CurrentTaskID > 0 && h.taskRepo != nil {
			if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusFailed, nil, faultMessage); err != nil {
				return nil, fmt.Errorf("fail task after CWMP fault: %w", err)
			}
			session.CurrentTaskID = 0
		}
		return h.getNextTask(ctx, session)
	}

	return nil, nil
}

func (h *Handler) getNextTask(ctx context.Context, session *Session) (interface{}, error) {
	if h.taskRepo == nil || session.DeviceID == 0 {
		session.State = StateIdle
		return nil, nil
	}
	if h.blockedRepo != nil {
		blocked, err := h.blockedRepo.IsBlocked(ctx, session.SerialNumber)
		if err != nil {
			return nil, fmt.Errorf("check device admission before task dispatch: %w", err)
		}
		if blocked {
			session.State = StateIdle
			session.CurrentTaskID = 0
			return nil, nil
		}
	}

	for {
		task, err := h.taskRepo.ClaimNextPending(ctx, session.DeviceID)
		if err != nil {
			return nil, fmt.Errorf("claim next task: %w", err)
		}
		if task == nil {
			session.State = StateIdle
			session.CurrentTaskID = 0
			return nil, nil
		}

		session.CurrentTaskID = task.ID
		session.State = StateProcessingTasks
		request, err := h.buildTaskRequest(task)
		if err == nil {
			if spv, ok := request.(*SetParameterValues); ok {
				names := make([]string, 0, len(spv.ParameterList.Parameters))
				for _, p := range spv.ParameterList.Parameters {
					names = append(names, p.Name)
				}
				session.LastSentContext = strings.Join(names, ", ")
			}
			return request, nil
		}
		if updateErr := h.taskRepo.UpdateStatus(ctx, task.ID, models.TaskStatusFailed, nil, err.Error()); updateErr != nil {
			return nil, fmt.Errorf("invalid task payload: %v; persist failure: %w", err, updateErr)
		}
		session.CurrentTaskID = 0
	}
}

func (h *Handler) buildTaskRequest(task *models.Task) (interface{}, error) {
	switch task.Type {
	case models.TaskTypeGetParameterValues:
		var params []string
		if err := json.Unmarshal(task.Payload, &params); err != nil {
			return nil, fmt.Errorf("decode get-parameter payload: %w", err)
		}
		if len(params) > 0 {
			log.Printf("Sending GetParameterValues: %v", params)
			return &GetParameterValues{ParameterNames: params}, nil
		}

	case models.TaskTypeSetParameterValues:
		var paramMap map[string]string
		if err := json.Unmarshal(task.Payload, &paramMap); err != nil {
			return nil, fmt.Errorf("decode set-parameter payload: %w", err)
		}
		if len(paramMap) > 0 {
			spv := &SetParameterValues{ParameterKey: task.CommandKey}
			for name, value := range paramMap {
				spv.ParameterList.Parameters = append(spv.ParameterList.Parameters, ParameterValueStruct{
					Name:  name,
					Value: value,
					Type:  inferSetParameterType(name),
				})
			}
			log.Printf("Sending SetParameterValues: %d params", len(spv.ParameterList.Parameters))
			return spv, nil
		}

	case models.TaskTypeReboot:
		log.Printf("Sending Reboot command")
		return &Reboot{CommandKey: task.CommandKey}, nil

	case models.TaskTypeFactoryReset:
		log.Printf("Sending FactoryReset command")
		return &FactoryReset{}, nil

	case models.TaskTypeDownload:
		var payload map[string]interface{}
		if err := json.Unmarshal(task.Payload, &payload); err != nil {
			return nil, fmt.Errorf("decode download payload: %w", err)
		}

		fileType, _ := payload["file_type"].(string)
		url, _ := payload["url"].(string)
		fileSize, _ := payload["file_size"].(float64)
		targetFilename, _ := payload["target_filename"].(string)

		if url != "" {
			log.Printf("Sending Download: %s", url)
			return &Download{
				CommandKey:     task.CommandKey,
				FileType:       fileType,
				URL:            url,
				FileSize:       int64(fileSize),
				TargetFileName: targetFilename,
			}, nil
		}
	}

	return nil, fmt.Errorf("unsupported or empty task payload for %s", task.Type)
}

// inferSetParameterType keeps the generic parameter API string-based while
// emitting the vendor-required CWMP types for Huawei's iPerf data model.
func inferSetParameterType(name string) string {
	if !strings.Contains(name, ".X_HW_IperfSpeedTest.IperfClient.") {
		return ""
	}
	switch name[strings.LastIndex(name, ".")+1:] {
	case "Bandwidth", "MaxTime", "Parallel", "Port":
		return "unsignedInt"
	default:
		return ""
	}
}

func (h *Handler) sendFault(w http.ResponseWriter, err error, request *SOAPEnvelope) {
	fault := &SOAPFault{
		FaultCode:   "Server",
		FaultString: err.Error(),
	}

	response, marshalErr := GenerateSOAPEnvelopeForRequest(fault, request)
	if marshalErr != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write(response)
}

func (h *Handler) failCurrentTask(ctx context.Context, sessionID string, failure error) {
	session := h.sessions.Get(sessionID)
	if session == nil || h.taskRepo == nil {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.CurrentTaskID == 0 {
		return
	}
	if err := h.taskRepo.UpdateStatus(ctx, session.CurrentTaskID, models.TaskStatusFailed, nil, failure.Error()); err != nil {
		log.Printf("Error failing undispatched task: %v", err)
	}
	session.CurrentTaskID = 0
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func newSessionKey() string {
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return fmt.Sprintf("sess_%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value)
}

func newMessageID() string {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		return fmt.Sprintf("skyacs-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value)
}

func secureEqual(left, right string) bool {
	leftHash := sha256.Sum256([]byte(left))
	rightHash := sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(leftHash[:], rightHash[:]) == 1
}

func parseAllowedNetworks(value string) []*net.IPNet {
	var networks []*net.IPNet
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if ip := net.ParseIP(item); ip != nil {
			bits := 128
			if ip.To4() != nil {
				bits = 32
			}
			networks = append(networks, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		if _, network, err := net.ParseCIDR(item); err == nil {
			networks = append(networks, network)
		} else {
			log.Printf("Ignoring invalid CWMP_ALLOWED_CIDRS entry %q", item)
		}
	}
	return networks
}

func (h *Handler) isNetworkAllowed(remoteAddress string) bool {
	if len(h.allowedNetworks) == 0 {
		return true
	}
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, network := range h.allowedNetworks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func (h *Handler) isSecureRequest(request *http.Request) bool {
	if request.TLS != nil {
		return true
	}
	if !networkContains(h.trustedProxies, request.RemoteAddr) {
		return false
	}
	return strings.EqualFold(request.Header.Get("X-Forwarded-Proto"), "https")
}

func (h *Handler) clientAddress(request *http.Request) string {
	if !networkContains(h.trustedProxies, request.RemoteAddr) {
		return request.RemoteAddr
	}
	forwarded := strings.Split(request.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		candidate := strings.TrimSpace(forwarded[index])
		if net.ParseIP(candidate) == nil {
			continue
		}
		if !networkContains(h.trustedProxies, candidate) {
			return candidate
		}
	}
	return request.RemoteAddr
}

func networkContains(networks []*net.IPNet, remoteAddress string) bool {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, network := range networks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
