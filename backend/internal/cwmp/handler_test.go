package cwmp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestTargetedFetchDoesNotPurgeParameters(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		fullTree bool
		overview bool
		empty    bool
		wantMark bool
	}{
		{name: "targeted GPV"},
		{name: "overview GPV", overview: true, wantMark: true},
		{name: "empty full-tree GPV", fullTree: true, empty: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Exercise repository SQL generation without requiring a PostgreSQL server.
			db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{
				DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			var saved, purged, marked bool
			if err := db.Callback().Create().Before("gorm:create").Register("test:device-id", func(tx *gorm.DB) {
				if device, ok := tx.Statement.Dest.(*models.Device); ok {
					device.ID = 1
				}
				if tx.Statement.Table == "device_parameters" {
					saved = true
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Delete().Before("gorm:delete").Register("test:purge", func(tx *gorm.DB) {
				if tx.Statement.Table == "device_parameters" {
					purged = true
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Update().Before("gorm:update").Register("test:refresh", func(tx *gorm.DB) {
				if tx.Statement.Table == "devices" {
					marked = true
				}
			}); err != nil {
				t.Fatal(err)
			}
			handler := NewHandler(nil)
			handler.deviceRepo = database.NewDeviceRepository(db)
			handler.parameterRepo = database.NewParameterRepository(db)
			parameters := ParameterList{Parameters: []ParameterValueStruct{{Name: "InternetGatewayDevice.DeviceInfo.UpTime", Value: "1500"}}}
			if scenario.empty {
				parameters.Parameters = nil
			}
			session := handler.sessions.GetOrCreate("parameter-update", "INFORM-UPDATE")
			session.DeviceID = 1
			session.State = StateProcessingTasks
			if scenario.fullTree {
				session.AutoFetchPhase = 1
			}
			session.OverviewFetchActive = scenario.overview
			_, err = handler.handleGetParameterValuesResponse(context.Background(), &GetParameterValuesResp{ParameterList: parameters}, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if saved == scenario.empty || purged || marked != scenario.wantMark {
				t.Fatalf("saved=%v purged=%v marked=%v; want saved=%v purged=false marked=%v", saved, purged, marked, !scenario.empty, scenario.wantMark)
			}
		})
	}
}

func TestRefreshDueSurvivesSessionChanges(t *testing.T) {
	now := time.Now()
	recent := now.Add(-14 * time.Minute)
	oldOverview := now.Add(-16 * time.Minute)
	oldFull := now.Add(-7 * time.Hour)
	if !refreshDue(nil, 15*time.Minute) || refreshDue(&recent, 15*time.Minute) ||
		!refreshDue(&oldOverview, 15*time.Minute) || refreshDue(&oldOverview, 6*time.Hour) ||
		!refreshDue(&oldFull, 6*time.Hour) {
		t.Fatal("refresh interval decision is incorrect")
	}
}

func TestRefreshIntervalsLoadSavedSettings(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{
		DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().After("gorm:query").Register("test:settings", func(tx *gorm.DB) {
		if settings, ok := tx.Statement.Dest.(*[]database.Setting); ok {
			*settings = []database.Setting{
				{Key: "overview_poll_interval", Value: "30m"},
				{Key: "full_tree_poll_interval", Value: "12h"},
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(nil)
	handler.settingsRepo = database.NewSettingsRepository(db)
	overview, full := handler.refreshIntervals(context.Background())
	if overview != 30*time.Minute || full != 12*time.Hour {
		t.Fatalf("saved intervals were not applied: overview=%s full=%s", overview, full)
	}
}

func TestOverviewFetchUsesKnownParameterNames(t *testing.T) {
	handler := NewHandler(nil)
	session := handler.sessions.GetOrCreate("overview-test", "SERIAL")
	session.State = StateInformReceived
	session.DataModelRoot = "InternetGatewayDevice."
	session.OverviewFetchReady = true
	session.OverviewFetchParams = []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID"}
	request, _, err := handler.handleEmptyPost(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	gpv, ok := request.(*GetParameterValues)
	if !ok || len(gpv.ParameterNames) != 1 || gpv.ParameterNames[0] != session.OverviewFetchParams[0] {
		t.Fatalf("unexpected overview fetch: %#v", request)
	}
	_, err = handler.handleFault(context.Background(), &SOAPFault{FaultCode: "Client", FaultString: "failed"}, session.ID)
	if err != nil || session.OverviewFetchActive {
		t.Fatalf("failed overview fetch remained active: %v", err)
	}
}

func TestInformIsAcknowledgedBeforeACSRequest(t *testing.T) {
	handler := NewHandler(nil)
	inform := `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soap:Header><cwmp:ID soap:mustUnderstand="1">inform-1</cwmp:ID></soap:Header>
  <soap:Body><cwmp:Inform>
    <DeviceId><Manufacturer>Lab</Manufacturer><OUI>001122</OUI><ProductClass>ONU</ProductClass><SerialNumber>TEST-1</SerialNumber></DeviceId>
    <Event><EventStruct><EventCode>0 BOOTSTRAP</EventCode><CommandKey></CommandKey></EventStruct></Event>
    <MaxEnvelopes>1</MaxEnvelopes><CurrentTime>2026-01-01T00:00:00Z</CurrentTime><RetryCount>0</RetryCount>
    <ParameterList><ParameterValueStruct><Name>Device.DeviceInfo.SerialNumber</Name><Value>TEST-1</Value></ParameterValueStruct></ParameterList>
  </cwmp:Inform></soap:Body>
</soap:Envelope>`

	request := httptest.NewRequest(http.MethodPost, "http://acs.test/", strings.NewReader(inform))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	response := recorder.Result()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected Inform status %d: %s", response.StatusCode, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "InformResponse") || strings.Contains(recorder.Body.String(), "GetParameterValues") {
		t.Fatalf("Inform was not acknowledged before ACS request: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "inform-1") {
		t.Fatalf("Inform ID was not echoed: %s", recorder.Body.String())
	}

	cookies := response.Cookies()
	if len(cookies) == 0 {
		t.Fatal("CWMP session cookie was not set")
	}
	emptyRequest := httptest.NewRequest(http.MethodPost, "http://acs.test/", nil)
	emptyRequest.AddCookie(cookies[0])
	emptyRecorder := httptest.NewRecorder()
	handler.ServeHTTP(emptyRecorder, emptyRequest)
	if emptyRecorder.Code != http.StatusOK || !strings.Contains(emptyRecorder.Body.String(), "GetParameterValues") {
		t.Fatalf("ACS request was not dispatched after empty POST: status=%d body=%s", emptyRecorder.Code, emptyRecorder.Body.String())
	}
}

// TestPeriodicInformOnNewSessionTriggersAutoFetch verifies that a PERIODIC
// event on a brand-new session (e.g. after an ACS restart) still triggers the
// full-tree parameter fetch so WAN/WiFi/health data is available.
func TestPeriodicInformOnNewSessionTriggersAutoFetch(t *testing.T) {
	handler := NewHandler(nil)
	inform := `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soap:Header><cwmp:ID soap:mustUnderstand="1">inform-periodic</cwmp:ID></soap:Header>
  <soap:Body><cwmp:Inform>
    <DeviceId><Manufacturer>Huawei</Manufacturer><OUI>001122</OUI><ProductClass>EG8145V5</ProductClass><SerialNumber>HW-PERIODIC-1</SerialNumber></DeviceId>
    <Event><EventStruct><EventCode>4 PERIODIC</EventCode><CommandKey></CommandKey></EventStruct></Event>
    <MaxEnvelopes>1</MaxEnvelopes><CurrentTime>2026-09-29T06:20:00Z</CurrentTime><RetryCount>0</RetryCount>
    <ParameterList><ParameterValueStruct><Name>InternetGatewayDevice.DeviceInfo.SerialNumber</Name><Value>HW-PERIODIC-1</Value></ParameterValueStruct></ParameterList>
  </cwmp:Inform></soap:Body>
</soap:Envelope>`

	request := httptest.NewRequest(http.MethodPost, "http://acs.test/", strings.NewReader(inform))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected Inform status %d: %s", recorder.Code, recorder.Body.String())
	}

	cookies := recorder.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("CWMP session cookie was not set")
	}
	emptyRequest := httptest.NewRequest(http.MethodPost, "http://acs.test/", nil)
	emptyRequest.AddCookie(cookies[0])
	emptyRecorder := httptest.NewRecorder()
	handler.ServeHTTP(emptyRecorder, emptyRequest)
	if emptyRecorder.Code != http.StatusOK || !strings.Contains(emptyRecorder.Body.String(), "GetParameterValues") {
		t.Fatalf("full-tree fetch was not dispatched for new-session PERIODIC inform: status=%d body=%s", emptyRecorder.Code, emptyRecorder.Body.String())
	}
}

// TestPeriodicInformOnExistingSessionDoesNotReTriggerAutoFetch verifies that
// after the AutoFetch is consumed, a subsequent empty POST on the same session
// does NOT re-trigger the full-tree fetch (keeps periodic informs cheap).
func TestPeriodicInformOnExistingSessionDoesNotReTriggerAutoFetch(t *testing.T) {
	handler := NewHandler(nil)
	inform := `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soap:Header><cwmp:ID soap:mustUnderstand="1">inform-1</cwmp:ID></soap:Header>
  <soap:Body><cwmp:Inform>
    <DeviceId><Manufacturer>Huawei</Manufacturer><OUI>001122</OUI><ProductClass>EG8145V5</ProductClass><SerialNumber>HW-EXISTING-1</SerialNumber></DeviceId>
    <Event><EventStruct><EventCode>4 PERIODIC</EventCode><CommandKey></CommandKey></EventStruct></Event>
    <MaxEnvelopes>1</MaxEnvelopes><CurrentTime>2026-09-29T06:20:00Z</CurrentTime><RetryCount>0</RetryCount>
    <ParameterList><ParameterValueStruct><Name>InternetGatewayDevice.DeviceInfo.SerialNumber</Name><Value>HW-EXISTING-1</Value></ParameterValueStruct></ParameterList>
  </cwmp:Inform></soap:Body>
</soap:Envelope>`

	req1 := httptest.NewRequest(http.MethodPost, "http://acs.test/", strings.NewReader(inform))
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first Inform failed: %d", rec1.Code)
	}
	cookies := rec1.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("session cookie not set")
	}

	// Consume the AutoFetch (empty POST → GetParameterValues)
	emptyReq := httptest.NewRequest(http.MethodPost, "http://acs.test/", nil)
	emptyReq.AddCookie(cookies[0])
	emptyRec := httptest.NewRecorder()
	handler.ServeHTTP(emptyRec, emptyReq)
	if !strings.Contains(emptyRec.Body.String(), "GetParameterValues") {
		t.Fatalf("expected GetParameterValues on first empty POST, got: %s", emptyRec.Body.String())
	}

	// Second empty POST on the same session: AutoFetch already consumed.
	emptyReq2 := httptest.NewRequest(http.MethodPost, "http://acs.test/", nil)
	emptyReq2.AddCookie(cookies[0])
	emptyRec2 := httptest.NewRecorder()
	handler.ServeHTTP(emptyRec2, emptyReq2)
	if strings.Contains(emptyRec2.Body.String(), "GetParameterValues") {
		t.Fatalf("AutoFetch was re-triggered on existing session: %s", emptyRec2.Body.String())
	}
}

func TestAddObjectUsesCollectionPath(t *testing.T) {
	for _, path := range []string{
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice",
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.",
	} {
		request := addObjectForPath(path)
		if request.ObjectName != "InternetGatewayDevice.WANDevice.1.WANConnectionDevice." || request.ParameterKey != "auto-provisioning" {
			t.Fatalf("unexpected AddObject for %q: %+v", path, request)
		}
	}
}

func TestAddObjectSequenceResolvesPreviousInstance(t *testing.T) {
	handler := NewHandler(nil)
	session := handler.sessions.GetOrCreate("add-object-test", "SERIAL")
	session.State = StateInformReceived
	session.AddObjectQueue = []*AddObject{
		addObjectForPath("InternetGatewayDevice.WANDevice.1.WANConnectionDevice"),
		addObjectForPath("InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{prev}.WANIPConnection"),
	}
	session.Provisioning = &SetParameterValues{ParameterList: ParameterList{Parameters: []ParameterValueStruct{{
		Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{prev}.Name", Value: "wan-{prev}",
	}}}}

	first, _, err := handler.handleEmptyPost(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := first.(*AddObject).ObjectName; got != "InternetGatewayDevice.WANDevice.1.WANConnectionDevice." {
		t.Fatalf("first ObjectName = %q", got)
	}
	second, err := handler.handleAddObjectResponse(context.Background(), &AddObjectResponse{InstanceNumber: "7"}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := second.(*AddObject).ObjectName; got != "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.7.WANIPConnection." {
		t.Fatalf("second ObjectName = %q", got)
	}
	provisioning, err := handler.handleAddObjectResponse(context.Background(), &AddObjectResponse{InstanceNumber: "3"}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	parameter := provisioning.(*SetParameterValues).ParameterList.Parameters[0]
	if parameter.Name != "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.Name" || parameter.Value != "wan-3" {
		t.Fatalf("unresolved provisioning parameter: %+v", parameter)
	}
}

func TestAddObjectFaultClearsProvisioning(t *testing.T) {
	handler := NewHandler(nil)
	session := handler.sessions.GetOrCreate("add-object-fault-test", "SERIAL")
	session.State = StateProcessingTasks
	session.AddObjectQueue = []*AddObject{addObjectForPath("Device.Test.Table")}
	session.Provisioning = &SetParameterValues{}
	_, err := handler.handleFault(context.Background(), &SOAPFault{Detail: FaultDetail{CWMPFault: &CWMPFault{
		FaultCode: "9005", FaultString: "Invalid parameter name",
	}}}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(session.AddObjectQueue) != 0 || session.Provisioning != nil {
		t.Fatal("provisioning continued after AddObject fault")
	}
}

func TestFaultClearsLastSentContext(t *testing.T) {
	handler := NewHandler(nil)
	session := handler.sessions.GetOrCreate("fault-context-test", "SERIAL")
	session.State = StateProcessingTasks
	session.DeviceID = 1
	session.LastSentContext = "InternetGatewayDevice.WANDevice.1.WANConnectionHandling.1"

	_, err := handler.handleFault(context.Background(), &SOAPFault{Detail: FaultDetail{CWMPFault: &CWMPFault{
		FaultCode: "9005", FaultString: "Invalid parameter name",
	}}}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.LastSentContext != "" {
		t.Fatalf("LastSentContext not cleared after fault, got %q", session.LastSentContext)
	}
}

func TestSetParameterValuesResponseClearsLastSentContext(t *testing.T) {
	handler := NewHandler(nil)
	session := handler.sessions.GetOrCreate("spv-context-test", "SERIAL")
	session.State = StateProcessingTasks
	session.LastSentContext = "InternetGatewayDevice.LANDevice.1.LANHostConfigTable"

	_, err := handler.handleSetParameterValuesResponse(context.Background(), &SetParameterValuesResp{Status: 0}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.LastSentContext != "" {
		t.Fatalf("LastSentContext not cleared after SPV response, got %q", session.LastSentContext)
	}
}

func TestAddObjectResponseClearsLastSentContext(t *testing.T) {
	handler := NewHandler(nil)
	session := handler.sessions.GetOrCreate("addobj-context-test", "SERIAL")
	session.State = StateProcessingTasks
	session.LastSentContext = "InternetGatewayDevice.LANDevice.1.LANHostConfigTable"

	_, err := handler.handleAddObjectResponse(context.Background(), &AddObjectResponse{InstanceNumber: "1", Status: 0}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.LastSentContext != "" {
		t.Fatalf("LastSentContext not cleared after AddObject response, got %q", session.LastSentContext)
	}
}

func TestBuildTaskRequestSetParameterValuesUsesStringType(t *testing.T) {
	handler := NewHandler(nil)
	task, err := models.NewTaskWithPayload(1, models.TaskTypeSetParameterValues, map[string]string{
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_HW_LANBIND.Lan1Enable":  "true",
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.X_HW_LANBIND.SSID1Enable": "false",
	})
	if err != nil {
		t.Fatalf("NewTaskWithPayload: %v", err)
	}

	request, err := handler.buildTaskRequest(task)
	if err != nil {
		t.Fatalf("buildTaskRequest: %v", err)
	}
	spv, ok := request.(*SetParameterValues)
	if !ok {
		t.Fatalf("expected *SetParameterValues, got %T", request)
	}
	if len(spv.ParameterList.Parameters) != 2 {
		t.Fatalf("expected 2 parameters, got %d", len(spv.ParameterList.Parameters))
	}
	for _, p := range spv.ParameterList.Parameters {
		if p.Type != "" {
			t.Errorf("parameter %q: expected empty Type (xsd:string default), got %q", p.Name, p.Type)
		}
	}
}

func TestBuildTaskRequestIperfParametersUsesUnsignedIntType(t *testing.T) {
	task, err := models.NewTaskWithPayload(1, models.TaskTypeSetParameterValues, map[string]string{
		"InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.Port":       "5201",
		"InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.MaxTime":    "10",
		"InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.ServerAddr": "192.0.2.10",
	})
	if err != nil {
		t.Fatalf("NewTaskWithPayload: %v", err)
	}
	handler := NewHandler(nil)
	request, err := handler.buildTaskRequest(task)
	if err != nil {
		t.Fatalf("buildTaskRequest: %v", err)
	}
	spv, ok := request.(*SetParameterValues)
	if !ok {
		t.Fatalf("expected *SetParameterValues, got %T", request)
	}
	types := make(map[string]string, len(spv.ParameterList.Parameters))
	for _, parameter := range spv.ParameterList.Parameters {
		types[parameter.Name] = parameter.Type
	}
	if types["InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.Port"] != "unsignedInt" {
		t.Fatalf("expected Port to use unsignedInt, got %q", types["InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.Port"])
	}
	if types["InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.MaxTime"] != "unsignedInt" {
		t.Fatalf("expected MaxTime to use unsignedInt, got %q", types["InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.MaxTime"])
	}
	if types["InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.ServerAddr"] != "" {
		t.Fatalf("expected ServerAddr to use the default string type, got %q", types["InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.ServerAddr"])
	}
}
