package cwmp

import (
	"context"
	"testing"
)

func TestDynamicFaultSuppressionIsScopedToCodePathsAndReadRPC(t *testing.T) {
	const branch = "InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*."
	const path = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice.3.StaDeviceStats.PacketsReceived"
	s := &Session{LastSentRPC: "GetParameterValues", DynamicParameterSuppressedFaults: map[string][]string{branch: {"9005", "9801"}}}
	for _, tc := range []struct {
		rpc, code string
		names     []string
		want      bool
	}{
		{"GetParameterValues", "9005", []string{path}, true},
		{"GetParameterValues", "9801", []string{path}, true},
		{"GetParameterNames", "9005", []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice.3."}, true},
		{"GetParameterValues", "9002", []string{path}, false},
		{"GetParameterValues", "9005", []string{path, "Device.DeviceInfo.UpTime"}, false},
		{"GetParameterValues", "9005", []string{"InternetGatewayDevice."}, false},
		{"GetParameterValues", "9005", nil, false},
		{"SetParameterValues", "9005", []string{path}, false},
		{"DeleteObject", "9005", []string{path}, false},
	} {
		s.LastSentRPC = tc.rpc
		if got := suppressDynamicReadFault(s, tc.code, tc.names); got != tc.want {
			t.Fatalf("%+v: got %v", tc, got)
		}
	}
}

func TestOverviewReadFaultSuppressionPreservesMixedFailures(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		h, faults := diagnostic9005TestHandler(t, nil)
		s := h.sessions.GetOrCreate("suppressed-overview", "TEST")
		s.DeviceID, s.State, s.OverviewFetchActive = 1, StateProcessingTasks, true
		s.DynamicParameterSuppressedFaults = map[string][]string{"Device.Hosts.Host.*.": {"9002"}}
		names := []string{"Device.Hosts.Host.1.HostName"}
		if mixed {
			names = append(names, "Device.DeviceInfo.UpTime")
		}
		h.rememberSentRequest(s.ID, &GetParameterValues{ParameterNames: names})
		request, err := h.handleFault(context.Background(), &SOAPFault{FaultCode: "9002", FaultString: "Internal error"}, s.ID)
		want := 0
		if mixed {
			want = 1
		}
		if err != nil || request != nil || len(*faults) != want || s.OverviewFetchActive {
			t.Fatalf("mixed=%v faults=%v request=%#v err=%v", mixed, *faults, request, err)
		}
	}
}

func TestDynamicDiscoverySuppressionHonorsExplicitPolicy(t *testing.T) {
	h, s, faults := prepareDynamicWiFiDiscovery(t, true)
	s.DynamicParameterSuppressedFaults = map[string][]string{"InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*.": {"9005"}}
	h.rememberSentRequest(s.ID, &GetParameterNames{ParameterPath: testAssociatedDevices + "1."})
	request, err := h.handleFault(context.Background(), diagnostic9005Fault(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	h.rememberSentRequest(s.ID, request)
	_, err = h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{{Name: testAssociatedDevices + "1."}}}, s.ID)
	if err != nil || len(*faults) != 0 || s.DynamicDiscoveryActive {
		t.Fatalf("faults=%v err=%v", *faults, err)
	}
}
