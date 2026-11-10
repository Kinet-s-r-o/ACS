package cwmp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestHTTPFaultIncludesRPCAndOverviewSource(t *testing.T) {
	h, faults := diagnostic9005TestHandler(t, nil)
	s := h.sessions.GetOrCreate("fault-http-context", "TEST")
	s.DeviceID = 1
	s.OverviewFetchReady = true
	s.OverviewFetchParams = []string{"Device.DeviceInfo.UpTime"}
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: "cwmp_session", Value: s.ID})
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, req)
		return recorder
	}
	first := post("")
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), "GetParameterValues") {
		t.Fatalf("expected overview GPV, status=%d body=%s", first.Code, first.Body.String())
	}
	// A generic CPE fault contains no parameter name or RPC method itself.
	fault := `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0"><soap:Body><soap:Fault><faultcode>Client</faultcode><faultstring>CWMP fault</faultstring><detail><cwmp:Fault><FaultCode>9002</FaultCode><FaultString>Internal error</FaultString></cwmp:Fault></detail></soap:Fault></soap:Body></soap:Envelope>`
	response := post(fault)
	if response.Code != http.StatusNoContent || len(*faults) != 1 {
		t.Fatalf("status=%d faults=%v", response.Code, *faults)
	}
	saved := (*faults)[0]
	if saved.FaultCode != "9002" || saved.ParameterName != s.OverviewFetchParams[0] || saved.FaultString != "Internal error [GetParameterValues; overview refresh]" {
		t.Fatalf("fault lost request context: %+v", saved)
	}
}

func TestRememberRequestContextDoesNotLeakValuesOrStalePaths(t *testing.T) {
	h := NewHandler(nil)
	s := h.sessions.GetOrCreate("request-context", "TEST")
	s.DeviceID, s.CurrentTaskID = 1, 42
	h.rememberSentRequest(s.ID, &GetParameterValues{ParameterNames: []string{"Device.Test.A", "Device.Test.B"}})
	if s.LastSentContext != "Device.Test.A, Device.Test.B" || s.LastSentSource != "task 42" || len(s.LastSentParameters) != 2 {
		t.Fatalf("queued GPV context missing: %+v", s)
	}
	h.rememberSentRequest(s.ID, &SetParameterValues{ParameterList: ParameterList{Parameters: []ParameterValueStruct{{Name: "Device.Test.Password", Value: "test-value-must-not-appear"}}}})
	if s.LastSentContext != "Device.Test.Password" || len(s.LastSentParameters) != 0 || strings.Contains(requestFaultMessage(s, "Internal error"), "test-value-must-not-appear") {
		t.Fatal("SPV context retained GPV names or exposed a value")
	}
	h.rememberSentRequest(s.ID, &Download{URL: "https://example.invalid/file?token=test-only"})
	if s.LastSentContext != "" || s.LastSentRPC != "Download" || strings.Contains(requestFaultMessage(s, "Internal error"), "token=") {
		t.Fatal("Download context retained a parameter path or exposed a URL")
	}
	h.rememberSentRequest(s.ID, &Reboot{})
	if s.LastSentRPC != "Reboot" || s.LastSentContext != "" {
		t.Fatal("parameterless RPC retained stale context")
	}
}

func TestHTTPFollowupRequestReplacesFaultContext(t *testing.T) {
	h := NewHandler(nil)
	s := h.sessions.GetOrCreate("followup-context", "TEST")
	s.State, s.AutoFetchPhase, s.DataModelRoot = StateProcessingTasks, 1, "Device."
	s.LastSentRPC, s.LastSentContext = "GetParameterValues", "stale parameter"
	body := `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0"><soap:Body><cwmp:GetParameterValuesResponse><ParameterList/></cwmp:GetParameterValuesResponse></soap:Body></soap:Envelope>`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.AddCookie(&http.Cookie{Name: "cwmp_session", Value: s.ID})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, req)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "GetParameterNames") || s.LastSentRPC != "GetParameterNames" || s.LastSentContext != "Device." || s.LastSentSource != "full parameter tree refresh" {
		t.Fatalf("followup context: status=%d rpc=%q path=%q source=%q", response.Code, s.LastSentRPC, s.LastSentContext, s.LastSentSource)
	}
}

func TestRequestContextIdentifiesIndependentAutomaticSources(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prepare func(*Session) interface{}
		want    string
	}{
		{"dynamic discovery", func(s *Session) interface{} {
			s.DynamicDiscoveryActive = true
			return &GetParameterNames{ParameterPath: "Device.WiFi."}
		}, "dynamic parameter discovery"},
		{"full refresh", func(s *Session) interface{} {
			s.AutoFetchPhase = 1
			return &GetParameterValues{ParameterNames: []string{"Device."}}
		}, "full parameter tree refresh"},
		{"metrics", func(s *Session) interface{} {
			return &GetParameterValues{ParameterNames: []string{"Device.DeviceInfo.UpTime"}}
		}, "metrics / additional polling"},
		{"condition", func(s *Session) interface{} {
			s.ConditionalExistsCurrent = "Device.Test"
			return &GetParameterNames{ParameterPath: "Device."}
		}, "provisioning condition"},
		{"stagger", func(s *Session) interface{} { s.InformStaggerPending = true; return &SetParameterValues{} }, "provisioning / Inform scheduling"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(nil)
			s := h.sessions.GetOrCreate(tc.name, "TEST")
			h.rememberSentRequest(s.ID, tc.prepare(s))
			if s.LastSentSource != tc.want {
				t.Fatalf("source=%q, want %q", s.LastSentSource, tc.want)
			}
		})
	}
}

func TestTemplateCanDisableBothRefreshesIndependentlyOfMetrics(t *testing.T) {
	h := NewHandler(nil)
	overview, full := h.refreshIntervals(context.Background(), &models.ProvisioningTemplate{OverviewPollInterval: "0", FullTreePollInterval: "0"})
	if overview != 0 || full != 0 {
		t.Fatalf("refreshes were not disabled: overview=%v full=%v", overview, full)
	}
}
