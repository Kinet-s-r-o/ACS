package cwmp

import (
	"context"
	"slices"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

const testAssociatedDevices = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice."

func prepareDynamicWiFiDiscovery(t *testing.T, overview bool) (*Handler, *Session, *[]models.Fault) {
	t.Helper()
	h, faults := diagnostic9005TestHandler(t, nil)
	s := h.sessions.GetOrCreate("dynamic-wifi", "TEST")
	s.DeviceID = 1
	s.DataModelRoot = "InternetGatewayDevice."
	s.OverviewFetchReady = true
	s.DynamicParameterBranches = []string{"InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*."}
	if overview {
		s.OverviewFetchParams = []string{"InternetGatewayDevice.DeviceInfo.UpTime"}
	}
	request, _, err := h.handleEmptyPost(context.Background(), s.ID)
	for _, step := range []struct {
		path  string
		names []string
	}{
		{"InternetGatewayDevice.LANDevice.", []string{"InternetGatewayDevice.LANDevice.1."}},
		{"InternetGatewayDevice.LANDevice.1.", []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration."}},
		{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.", []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1."}},
		{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.", []string{testAssociatedDevices}},
		{testAssociatedDevices, []string{testAssociatedDevices + "1.", testAssociatedDevices + "2."}},
	} {
		gpn, ok := request.(*GetParameterNames)
		if err != nil || !ok || gpn.ParameterPath != step.path || !gpn.NextLevel {
			t.Fatalf("expected shallow GPN for %s, got %#v err=%v", step.path, request, err)
		}
		var names []ParameterInfoStruct
		for _, name := range step.names {
			names = append(names, ParameterInfoStruct{Name: name})
		}
		request, err = h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{ParameterList: names}, s.ID)
	}
	if gpn, ok := request.(*GetParameterNames); err != nil || !ok || gpn.ParameterPath != testAssociatedDevices+"1." || gpn.NextLevel {
		t.Fatalf("expected first client GPN, got %#v err=%v", request, err)
	}
	return h, s, faults
}

func TestDynamicInstanceDisappearsDuringDiscovery(t *testing.T) {
	h, s, faults := prepareDynamicWiFiDiscovery(t, true)
	ctx := context.Background()
	request, err := h.handleFault(ctx, diagnostic9005Fault(), s.ID)
	if gpn, ok := request.(*GetParameterNames); err != nil || !ok || gpn.ParameterPath != testAssociatedDevices || !gpn.NextLevel {
		t.Fatalf("expected parent verification GPN, got %#v err=%v", request, err)
	}
	request, err = h.handleGetParameterNamesResponse(ctx, &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{
		{Name: testAssociatedDevices + "2."},
	}}, s.ID)
	if gpn, ok := request.(*GetParameterNames); err != nil || !ok || gpn.ParameterPath != testAssociatedDevices+"2." || gpn.NextLevel {
		t.Fatalf("expected discovery to continue with second client, got %#v err=%v", request, err)
	}
	remainingName := testAssociatedDevices + "2.AssociatedDeviceMACAddress"
	request, err = h.handleGetParameterNamesResponse(ctx, &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{
		{Name: remainingName},
	}}, s.ID)
	gpv, ok := request.(*GetParameterValues)
	if err != nil || !ok || !slices.Equal(gpv.ParameterNames, []string{"InternetGatewayDevice.DeviceInfo.UpTime", remainingName}) {
		t.Fatalf("expected overview and remaining client values, got %#v err=%v", request, err)
	}
	if len(*faults) != 0 || s.DynamicDiscoveryVerification != nil || !s.DynamicDiscoveryActive {
		t.Fatalf("disappearance retained a fault or lost the dynamic refresh: faults=%v", *faults)
	}
}

func TestDynamicInstanceStillAdvertisedRetainsFault(t *testing.T) {
	h, s, faults := prepareDynamicWiFiDiscovery(t, true)
	ctx := context.Background()
	if _, err := h.handleFault(ctx, diagnostic9005Fault(), s.ID); err != nil {
		t.Fatal(err)
	}
	request, err := h.handleGetParameterNamesResponse(ctx, &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{
		{Name: testAssociatedDevices + "1."}, {Name: testAssociatedDevices + "2."},
	}}, s.ID)
	if err != nil || request != nil || len(*faults) != 1 || (*faults)[0].FaultCode != "9005" || (*faults)[0].ParameterName != testAssociatedDevices+"1." {
		t.Fatalf("original fault was not retained: request=%#v err=%v faults=%v", request, err, *faults)
	}
	if s.DynamicDiscoveryVerification != nil || s.DynamicDiscoveryActive || s.OverviewFetchActive || len(s.DynamicDiscoveryQueue) != 0 {
		t.Fatal("failed verification retained discovery state")
	}
}

func TestDynamicInstanceVerificationFaultDoesNotSuppressOriginal(t *testing.T) {
	for _, code := range []string{"9002", "9005"} {
		t.Run(code, func(t *testing.T) {
			h, s, faults := prepareDynamicWiFiDiscovery(t, true)
			ctx := context.Background()
			if _, err := h.handleFault(ctx, diagnostic9005Fault(), s.ID); err != nil {
				t.Fatal(err)
			}
			request, err := h.handleFault(ctx, &SOAPFault{Detail: FaultDetail{CWMPFault: &CWMPFault{FaultCode: code, FaultString: "Parent verification failed"}}}, s.ID)
			if err != nil || request != nil || len(*faults) != 1 || (*faults)[0].FaultCode != "9005" || (*faults)[0].ParameterName != testAssociatedDevices+"1." || (*faults)[0].FaultString != "Invalid parameter name" {
				t.Fatalf("original fault lost or verification retried: request=%#v err=%v faults=%v", request, err, *faults)
			}
		})
	}
}

func TestDynamicDiscoveryAllClientsDisappearWithoutEmptyGPV(t *testing.T) {
	h, s, faults := prepareDynamicWiFiDiscovery(t, false)
	ctx := context.Background()
	for index := 0; index < 2; index++ {
		if _, err := h.handleFault(ctx, diagnostic9005Fault(), s.ID); err != nil {
			t.Fatal(err)
		}
		request, err := h.handleGetParameterNamesResponse(ctx, &GetParameterNamesResp{}, s.ID)
		if err != nil || (index == 1 && request != nil) {
			t.Fatalf("empty discovery unexpectedly requested values: request=%#v err=%v", request, err)
		}
	}
	if len(*faults) != 0 || s.OverviewFetchActive || s.DynamicDiscoveryActive || s.DynamicDiscoveryVerification != nil {
		t.Fatal("empty discovery retained faults or active state")
	}
}

func TestDynamicDiscoveryDoesNotRecheckFixedPathsOrOtherFaults(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		fixed      bool
		gpv        bool
		task       bool
	}{
		{name: "fixed path 9005", code: "9005", fixed: true},
		{name: "instance internal error", code: "9002"},
		{name: "GPV fault", code: "9005", gpv: true},
		{name: "explicit task fault", code: "9005", task: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			h, s, faults := prepareDynamicWiFiDiscovery(t, true)
			path := s.DynamicDiscoveryCurrent.Path
			if scenario.fixed {
				s.DynamicDiscoveryCurrent.Index--
				s.DynamicDiscoveryCurrent.Path = testAssociatedDevices
				s.LastSentContext = testAssociatedDevices
				path = testAssociatedDevices
			}
			if scenario.gpv {
				path = testAssociatedDevices + "1.AssociatedDeviceIPAddress"
				s.LastSentContext = path
				s.LastSentParameters = []string{path}
			}
			if scenario.task {
				s.CurrentTaskID = 7
			}
			request, err := h.handleFault(context.Background(), &SOAPFault{Detail: FaultDetail{CWMPFault: &CWMPFault{FaultCode: scenario.code}}}, s.ID)
			if err != nil || request != nil || len(*faults) != 1 || (*faults)[0].FaultCode != scenario.code || (*faults)[0].ParameterName != path || s.DynamicDiscoveryVerification != nil {
				t.Fatalf("unexpected recovery: request=%#v err=%v faults=%v", request, err, *faults)
			}
		})
	}
}
