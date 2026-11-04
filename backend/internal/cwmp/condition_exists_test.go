package cwmp

import (
	"context"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestConditionExistsSyntaxAndEvaluation(t *testing.T) {
	for _, expr := range []string{
		`exists('Device.WiFi.SSID.1.')`,
		`NOT exists("InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1")`,
		`hasTag('a') AND (exists('Device.Foo') OR NOT exists('Device.Bar.'))`,
	} {
		if _, err := ParseCondition(expr); err != nil {
			t.Fatalf("%s: %v", expr, err)
		}
	}
	for _, expr := range []string{
		`exists()`, `exists(Device.Foo)`, `exists('Device.Foo'`,
		`exists('Device.Foo.*.')`, `exists('Device..Foo')`, `exists('other.path')`,
		`exists('')`, `exists('Device.{prev}.')`, `exists('Device.Foo', 'Device.Bar')`,
	} {
		if _, err := ParseCondition(expr); err == nil {
			t.Fatalf("accepted invalid condition %s", expr)
		}
	}
	cond, err := ParseCondition(`NOT exists('Device.Foo.')`)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"true", "false", "unknown", ""} {
		result, err := Evaluate(cond, map[string]string{conditionExistsKey("Device.Foo"): value})
		if (value == "unknown" || value == "") != (err != nil) {
			t.Fatalf("probe %q: err=%v", value, err)
		}
		if result != (value == "false") {
			t.Fatalf("probe %q: result=%v", value, result)
		}
	}
	if _, err := Evaluate(cond, map[string]string{"Device.Foo": ""}); err == nil {
		t.Fatal("a cached value must not substitute for a live existence probe")
	}
	cond, _ = ParseCondition(`exists('Device.Foo.') AND (exists('Device.Foo') OR NOT exists('Device.Bar')) AND Device.Info == 'x'`)
	var paths []string
	extractExistsPaths(cond, make(map[string]bool), &paths)
	if len(paths) != 2 || paths[0] != "Device.Foo" || paths[1] != "Device.Bar" {
		t.Fatalf("unexpected deduplicated paths: %v", paths)
	}
	if params := ExtractParamNames(cond); len(params) != 1 || params[0] != "Device.Info" {
		t.Fatalf("existence paths must not be fetched via GPV: %v", params)
	}
}

func prepareExistsSession(t *testing.T, h *Handler, expr string, addObject bool) *Session {
	t.Helper()
	cond, err := ParseCondition(expr)
	if err != nil {
		t.Fatal(err)
	}
	s := h.sessions.GetOrCreate("exists-test", "exists-test")
	s.PendingConditionalConds = []*Condition{cond}
	s.PendingConditionalRules = []models.ProvisioningApplication{{RuleID: 1, RuleVersion: 1}}
	rule := &models.ProvisioningRule{ParameterName: "Device.Test.Enable", ParameterValue: "true", ParameterType: "xsd:boolean"}
	if addObject {
		rule.AddObjectPath = "Device.Test.Objects."
	}
	s.PendingConditionalData = []*models.ProvisioningRule{rule}
	s.PendingConditionalParams = ExtractParamNames(cond)
	s.ConditionalFetchActive = true
	s.ConditionalExistsResults = make(map[string]string)
	extractExistsPaths(cond, make(map[string]bool), &s.ConditionalExistsPaths)
	return s
}

func TestConditionExistsLiveProbe(t *testing.T) {
	const path = "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1"
	for _, scenario := range []struct {
		name, expression, fault string
		names                   []ParameterInfoStruct
		apply, addObject        bool
	}{
		{name: "empty object", expression: `exists('` + path + `.')`, names: []ParameterInfoStruct{{Name: path + "."}}, apply: true},
		{name: "sibling is not target", expression: `exists('` + path + `')`, names: []ParameterInfoStruct{{Name: path + "0."}}},
		{name: "missing", expression: `NOT exists('` + path + `')`, apply: true},
		{name: "absent parent", expression: `NOT exists('` + path + `')`, fault: "9005", apply: true},
		{name: "unsupported method", expression: `NOT exists('` + path + `')`, fault: "9000"},
		{name: "internal fault", expression: `NOT exists('` + path + `')`, fault: "9002"},
		{name: "conditional AddObject", expression: `NOT exists('` + path + `')`, apply: true, addObject: true},
		{name: "leaf with no value", expression: `exists('Device.DeviceInfo.ModelName')`, names: []ParameterInfoStruct{{Name: "Device.DeviceInfo.ModelName"}}, apply: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			h := NewHandler(nil)
			s := prepareExistsSession(t, h, scenario.expression, scenario.addObject)
			request, _, err := h.handleEmptyPost(context.Background(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			gpn, ok := request.(*GetParameterNames)
			parent := "InternetGatewayDevice.WANDevice.1.WANConnectionDevice."
			if scenario.name == "leaf with no value" {
				parent = "Device.DeviceInfo."
			}
			if !ok || gpn.ParameterPath != parent || !gpn.NextLevel {
				t.Fatalf("expected shallow parent GPN, got %#v", request)
			}
			if scenario.fault != "" {
				request, err = h.handleFault(context.Background(), &SOAPFault{Detail: FaultDetail{CWMPFault: &CWMPFault{FaultCode: scenario.fault}}}, s.ID)
			} else {
				request, err = h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{ParameterList: scenario.names}, s.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if !scenario.apply && request != nil {
				t.Fatalf("unsatisfied/unknown condition dispatched %#v", request)
			}
			if scenario.apply {
				if scenario.addObject {
					if _, ok := request.(*AddObject); !ok {
						t.Fatalf("expected AddObject, got %#v", request)
					}
				} else if spv, ok := request.(*SetParameterValues); !ok || len(spv.ParameterList.Parameters) != 1 {
					t.Fatalf("expected conditional SPV, got %#v", request)
				}
			}
			if len(s.PendingConditionalConds) != 0 || s.ConditionalExistsResults != nil {
				t.Fatal("conditional state was not cleared")
			}
		})
	}
}

func TestConditionExistsCombinedWithValuesAndTags(t *testing.T) {
	h := NewHandler(nil)
	s := prepareExistsSession(t, h, `exists('Device.Foo.') AND NOT exists('Device.Bar.') AND Device.Info == 'x' AND notHasTag('blocked')`, false)
	ctx := context.Background()
	request, _, err := h.handleEmptyPost(ctx, s.ID)
	for _, path := range []string{"Device.Foo.", "Device.Bar."} {
		if _, ok := request.(*GetParameterNames); err != nil || !ok {
			t.Fatalf("expected GPN, got %#v, %v", request, err)
		}
		names := []ParameterInfoStruct{}
		if path == "Device.Foo." {
			names = append(names, ParameterInfoStruct{Name: path})
		}
		request, err = h.handleGetParameterNamesResponse(ctx, &GetParameterNamesResp{ParameterList: names}, s.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	gpv, ok := request.(*GetParameterValues)
	if err != nil || !ok || len(gpv.ParameterNames) != 1 || gpv.ParameterNames[0] != "Device.Info" {
		t.Fatalf("expected value GPV after probes, got %#v, %v", request, err)
	}
	request, err = h.handleGetParameterValuesResponse(ctx, &GetParameterValuesResp{ParameterList: ParameterList{Parameters: []ParameterValueStruct{{Name: "Device.Info", Value: "x"}}}}, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := request.(*SetParameterValues); err != nil || !ok {
		t.Fatalf("expected satisfied conditional SPV, got %#v, %v", request, err)
	}
}
