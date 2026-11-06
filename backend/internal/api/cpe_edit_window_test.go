package api

import (
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestEditHelpReferences(t *testing.T) {
	refs, err := editHelpReferences("Channel: {{param:Channel}} / {{param:InternetGatewayDevice.DeviceInfo.ModelName}}")
	if err != nil || len(refs) != 2 || refs[0] != "Channel" {
		t.Fatalf("invalid references: %v %v", refs, err)
	}
	for _, help := range []string{"{{param:}}", "{{param:Channel}", "{{param:Name with spaces}}", "{{param:Username}}", "{{param:PreSharedKey.1.KeyPassphrase}}", "{{param:Device.PPP.Interface.1.Password}}", strings.Repeat("{{param:Channel}}", 17)} {
		if _, err := editHelpReferences(help); err == nil {
			t.Fatalf("accepted unsafe or malformed help: %s", help)
		}
	}
	window := testEditWindow()
	readonly := false
	parameters := []models.DeviceParameter{{Name: "InternetGatewayDevice.LANDevice.7.WLANConfiguration.25.Channel", Writable: &readonly}, {Name: "InternetGatewayDevice.DeviceInfo.ModelName"}}
	for _, ref := range refs {
		if !editHelpReferenceExists(window, ref, parameters) {
			t.Fatalf("missing valid read-only reference: %s", ref)
		}
	}
	if editHelpReferenceExists(window, "Missing", parameters) {
		t.Fatal("accepted missing reference")
	}
	if editHelpReferenceExists(models.CPEEditWindow{Target: "lan"}, "Channel", parameters) {
		t.Fatal("bound to unrelated interface")
	}
	prefix := "InternetGatewayDevice.LANDevice.9.WLANConfiguration.88."
	if got := editHelpPath(prefix, refs[0]); got != prefix+"Channel" {
		t.Fatal(got)
	}
	if got := editHelpPath(prefix, refs[1]); got != refs[1] {
		t.Fatal(got)
	}
	window.Tabs[0].Fields[0].Help = "{{param:Password}}"
	if validateEditWindows([]models.CPEEditWindow{window}) == nil {
		t.Fatal("accepted sensitive help in imported definition")
	}
}

func testEditWindow() models.CPEEditWindow {
	return models.CPEEditWindow{Version: 1, Target: "wifi", Enabled: true, BasePattern: "InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.", Tabs: []models.CPEEditTab{{ID: "general", Name: "General", Columns: 2, Fields: []models.CPEEditField{{ID: "ssid", Name: "SSID", Parameter: "SSID", Type: "string", Input: "select", Span: 1, Options: []models.CPEEditOption{{Label: "Home network", Value: "home"}}}}}}}
}

func TestEditBindingUsesOpenedInterface(t *testing.T) {
	window := testEditWindow()
	for _, prefix := range []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.", "InternetGatewayDevice.LANDevice.7.WLANConfiguration.25."} {
		if !editBaseMatches(window, prefix) {
			t.Fatalf("interface did not match: %s", prefix)
		}
	}
	for _, prefix := range []string{"InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.", "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.", "Device.WiFi.SSID.1."} {
		if editBaseMatches(window, prefix) {
			t.Fatalf("unexpected interface match: %s", prefix)
		}
	}
	target, pattern, suffix := parseEditBinding("InternetGatewayDevice.WANDevice.3.WANConnectionDevice.9.WANPPPConnection.11.Username")
	if target != "wan_ppp" || pattern != "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*." || suffix != "Username" {
		t.Fatalf("unexpected binding: %s %s %s", target, pattern, suffix)
	}
}

func TestEditSelectDefinitionValidation(t *testing.T) {
	if err := validateEditWindows([]models.CPEEditWindow{testEditWindow()}); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*models.CPEEditField){
		func(f *models.CPEEditField) { f.Parameter = "Username" },
		func(f *models.CPEEditField) { f.Parameter = "KeyPassphrase" },
		func(f *models.CPEEditField) { f.Type = "unsignedInt"; f.Options[0].Value = "-1" },
		func(f *models.CPEEditField) { f.Options = append(f.Options, f.Options[0]) },
		func(f *models.CPEEditField) { f.Span = 3 },
	} {
		window := testEditWindow()
		mutate(&window.Tabs[0].Fields[0])
		if validateEditWindows([]models.CPEEditWindow{window}) == nil {
			t.Fatal("accepted invalid definition")
		}
	}
}

func TestEditChangesRequireWritableAndConfiguredValues(t *testing.T) {
	window := testEditWindow()
	prefix := "InternetGatewayDevice.LANDevice.7.WLANConfiguration.25."
	writable, readonly := true, false
	parameter := models.DeviceParameter{Name: prefix + "SSID", ValueType: "xsd:string", Writable: &writable}
	if err := validateEditWindowChanges(window, prefix, []models.DeviceParameter{parameter}, map[string]string{parameter.Name: "home"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, value string
		writable    *bool
		kind        string
	}{
		{parameter.Name, "Home network", &writable, "string"},
		{parameter.Name, "home", &readonly, "string"},
		{parameter.Name, "home", nil, "string"},
		{parameter.Name, "home", &writable, "boolean"},
		{prefix + "Enable", "home", &writable, "string"},
		{"InternetGatewayDevice.LANDevice.7.WLANConfiguration.1.SSID", "home", &writable, "string"},
	} {
		parameter.Writable, parameter.ValueType = tc.writable, tc.kind
		if validateEditWindowChanges(window, prefix, []models.DeviceParameter{parameter}, map[string]string{tc.name: tc.value}) == nil {
			t.Fatalf("accepted invalid change: %+v", tc)
		}
	}
	if validateEditWindowChanges(window, prefix, nil, map[string]string{parameter.Name: "home"}) == nil {
		t.Fatal("accepted missing parameter")
	}
}

func TestEditNumericRanges(t *testing.T) {
	for _, tc := range []struct {
		kind, value string
		valid       bool
	}{
		{"int", "-2147483648", true}, {"int", "2147483648", false}, {"unsignedInt", "4294967295", true}, {"unsignedInt", "4294967296", false}, {"unsignedInt", "-1", false}, {"int", "1.5", false}, {"boolean", "false", true}, {"boolean", "yes", false},
	} {
		if (validateEditValue(tc.kind, tc.value) == nil) != tc.valid {
			t.Fatalf("wrong validation: %+v", tc)
		}
	}
}
