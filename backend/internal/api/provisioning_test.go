package api

import (
	"reflect"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestNormalizeTags(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{name: "trims and lowercases", in: []string{"  Branch-A ", "PREMIUM"}, want: []string{"branch-a", "premium"}},
		{name: "drops empty and whitespace-only", in: []string{"", "   ", "ok"}, want: []string{"ok"}},
		{name: "deduplicates case-insensitively", in: []string{"a", "A", "a "}, want: []string{"a"}},
		{name: "empty input", in: []string{}, want: []string{}},
		{name: "nil input", in: nil, want: []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeTags(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("normalizeTags(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseFeatureCSVSupportsScalarTypes(t *testing.T) {
	csv := "key,label,type,parameter,options\n" +
		"name,Name,string,Device.Info.Name,\n" +
		"count,Count,int,Device.Info.Count,\n" +
		"limit,Limit,unsignedInt,Device.Info.Limit,"

	controls, err := parseFeatureCSV(csv)
	if err != nil {
		t.Fatalf("parseFeatureCSV returned error: %v", err)
	}
	if len(controls) != 3 {
		t.Fatalf("got %d controls, want 3", len(controls))
	}
	for i, want := range []string{"string", "int", "unsignedInt"} {
		if controls[i].Type != want {
			t.Errorf("control %d type = %q, want %q", i, controls[i].Type, want)
		}
	}
}

func TestParseFeatureCSVSupportsLegacyUnsignedInt(t *testing.T) {
	controls, err := parseFeatureCSV("Name,Writable,Value type\nDevice.Info.Limit,Yes,unsignedInt\n")
	if err != nil {
		t.Fatalf("parseFeatureCSV returned error: %v", err)
	}
	if len(controls) != 1 || controls[0].Type != "unsignedInt" {
		t.Fatalf("got %#v, want one unsignedInt control", controls)
	}
}

func TestValidateProvisioningRuleTag(t *testing.T) {
	base := func(tags []string) error {
		return validateProvisioningRule("InternetGatewayDevice.ManagementServer.URL", "http://acs.example.com", "string", "", "bootstrap", tags, "")
	}

	if err := base(nil); err != nil {
		t.Fatalf("nil tags should be valid (applies to all devices), got %v", err)
	}
	if err := base([]string{"branch-a"}); err != nil {
		t.Fatalf("valid tag was rejected: %v", err)
	}
	if err := base([]string{string(make([]byte, 129))}); err == nil {
		t.Fatal("tag over 128 characters should be rejected")
	}
}

func TestValidateProvisioningRuleAddObjectDoesNotRequireParameter(t *testing.T) {
	path := "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection"
	if err := validateProvisioningRule("", "", "", path, "bootstrap", nil, ""); err != nil {
		t.Fatalf("AddObject without SetParameterValues fields was rejected: %v", err)
	}
	if err := validateProvisioningRule("", "", "string", "", "bootstrap", nil, ""); err == nil {
		t.Fatal("parameter rule without a name was accepted")
	}
}

func TestValidateTransferTemplateAcceptsInterfaceMetricWithoutParameterName(t *testing.T) {
	template := provisioningTransferTemplate{
		Name: "Huawei", Manufacturer: "huawei", ProductClass: "eg8145",
		Metrics: []models.MetricDefinition{{
			Name: "WAN bytes received", InterfaceType: "wan",
			ParameterPattern: "Device.WANDevice.*.Stats.BytesReceived",
			Source:           "active", ChartType: "line", Multiplier: 1,
		}},
	}
	if err := validateTransferTemplate(&template); err != nil {
		t.Fatalf("interface metric without parameter_name was rejected: %v", err)
	}
}

func TestValidatePrevReferenceInList(t *testing.T) {
	addObject := &models.ProvisioningRule{ID: 1, AddObjectPath: "InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.1.Hosts.1.Host", Order: 0}
	plainRule := &models.ProvisioningRule{ID: 2, ParameterValue: "static", Order: 1}

	cases := []struct {
		name          string
		rules         []*models.ProvisioningRule
		ruleID        int64
		order         int
		parameterName string
		value         string
		path          string
		wantErr       bool
		errSubstr     string
	}{
		{
			name:    "no {prev} in value passes",
			rules:   []*models.ProvisioningRule{addObject},
			ruleID:  0,
			order:   1,
			value:   "static-value",
			wantErr: false,
		},
		{
			name:    "create with preceding AddObject passes",
			rules:   []*models.ProvisioningRule{addObject},
			ruleID:  0,
			order:   1,
			value:   "{prev}.1",
			wantErr: false,
		},
		{
			name:          "parameter name with preceding AddObject passes",
			rules:         []*models.ProvisioningRule{addObject},
			order:         1,
			parameterName: "InternetGatewayDevice.LANDevice.1.Host.{prev}.Name",
		},
		{
			name:          "parameter name without AddObject fails",
			rules:         []*models.ProvisioningRule{plainRule},
			order:         1,
			parameterName: "InternetGatewayDevice.LANDevice.1.Host.{prev}.Name",
			wantErr:       true,
		},
		{
			name:    "object path without preceding AddObject fails",
			rules:   []*models.ProvisioningRule{addObject},
			ruleID:  1,
			path:    "InternetGatewayDevice.LANDevice.1.Host.{prev}.Child",
			wantErr: true,
		},
		{
			name:    "create with same-order AddObject passes (new rule gets higher id)",
			rules:   []*models.ProvisioningRule{addObject},
			ruleID:  0,
			order:   0,
			value:   "{prev}.1",
			wantErr: false,
		},
		{
			name:      "create with no AddObject fails",
			rules:     []*models.ProvisioningRule{plainRule},
			ruleID:    0,
			order:     1,
			value:     "{prev}.1",
			wantErr:   true,
			errSubstr: "no AddObject rule exists before it",
		},
		{
			name:      "create with AddObject after fails",
			rules:     []*models.ProvisioningRule{{ID: 10, AddObjectPath: "path", Order: 5}},
			ruleID:    0,
			order:     1,
			value:     "{prev}.1",
			wantErr:   true,
			errSubstr: "no AddObject rule exists before it",
		},
		{
			name:    "update with preceding AddObject passes",
			rules:   []*models.ProvisioningRule{addObject, {ID: 2, ParameterValue: "{prev}.1", Order: 1}},
			ruleID:  2,
			order:   1,
			value:   "{prev}.1",
			wantErr: false,
		},
		{
			name:      "update with AddObject after fails",
			rules:     []*models.ProvisioningRule{{ID: 2, ParameterValue: "{prev}.1", Order: 0}, {ID: 10, AddObjectPath: "path", Order: 1}},
			ruleID:    2,
			order:     0,
			value:     "{prev}.1",
			wantErr:   true,
			errSubstr: "no AddObject rule exists before it",
		},
		{
			name:      "update excludes self even if self has AddObjectPath",
			rules:     []*models.ProvisioningRule{{ID: 5, AddObjectPath: "path", ParameterValue: "{prev}.1", Order: 0}},
			ruleID:    5,
			order:     0,
			value:     "{prev}.1",
			wantErr:   true,
			errSubstr: "no AddObject rule exists before it",
		},
		{
			name:      "empty rules list with {prev} fails",
			rules:     []*models.ProvisioningRule{},
			ruleID:    0,
			order:     0,
			value:     "{prev}.1",
			wantErr:   true,
			errSubstr: "no AddObject rule exists before it",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePrevReferenceInList(tc.rules, tc.ruleID, tc.order, tc.parameterName, tc.value, tc.path)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				if tc.errSubstr != "" && !strings.Contains(err.Error(), tc.errSubstr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tc.errSubstr)
				}
			} else if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
