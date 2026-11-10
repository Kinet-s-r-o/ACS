package api

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestDynamicFaultSuppressionPolicyLifecycle(t *testing.T) {
	branch := "InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*."
	prior := map[string][]string{branch: {"9002", "9005"}, "Device.Hosts.Host.*.": {"9005"}}
	kept, err := resolveDynamicFaultSuppression(nil, prior, []string{branch})
	if err != nil || len(kept) != 1 || !slices.Equal(kept[branch], []string{"9002", "9005"}) {
		t.Fatalf("omitted policy lost selection: %v %v", kept, err)
	}
	cleared, err := resolveDynamicFaultSuppression(map[string][]string{}, prior, []string{branch})
	if err != nil || len(cleared) != 0 || !equalDynamicFaultSuppression(nil, cleared) {
		t.Fatalf("explicit empty policy not cleared: %v %v", cleared, err)
	}
	normalized, err := resolveDynamicFaultSuppression(map[string][]string{" " + branch + " ": {" 9801 ", "9005", "9005"}}, nil, []string{branch})
	if err != nil || !slices.Equal(normalized[branch], []string{"9005", "9801"}) {
		t.Fatalf("normalization=%v err=%v", normalized, err)
	}
	for _, bad := range []map[string][]string{{"Device.Other.": {"9005"}}, {branch: {"8005"}}, {branch: {"9x05"}}, {branch: {"90050"}}, {branch: make([]string, 33)}} {
		if _, err := resolveDynamicFaultSuppression(bad, nil, []string{branch}); err == nil {
			t.Fatalf("accepted invalid policy %v", bad)
		}
	}
}

func TestDynamicFaultSuppressionTransfer(t *testing.T) {
	const branch = "Device.Hosts.Host.*."
	item := provisioningTransferTemplate{Name: "Test", DynamicParameterBranches: []string{branch}, DynamicParameterSuppressedFaults: map[string][]string{branch: {"9005", "9801"}}}
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	var decoded provisioningTransferTemplate
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := validateTransferTemplate(&decoded); err != nil {
		t.Fatal(err)
	}
	if !equalDynamicFaultSuppression(item.DynamicParameterSuppressedFaults, decoded.DynamicParameterSuppressedFaults) {
		t.Fatal("transfer lost suppressed codes")
	}
}
