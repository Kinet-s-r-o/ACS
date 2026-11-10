package api

import "testing"

func TestIgnoredBranchValidation(t *testing.T) {
	for _, branch := range []string{"InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.STAWMMParameter.", "Device.WiFi.", " Device.WiFi. "} {
		if err := validateIgnoredParameterBranches([]string{branch}); err != nil {
			t.Fatalf("valid %q: %v", branch, err)
		}
	}
	for _, branch := range []string{"", "Device.", "InternetGatewayDevice.", "Device..WiFi.", "Device.WiFi", "Other.WiFi.", "Device.Wi*Fi.", "Device.WiFi.\nBad."} {
		if validateIgnoredParameterBranches([]string{branch}) == nil {
			t.Fatalf("accepted %q", branch)
		}
	}
	if validateIgnoredParameterBranches([]string{"Device.WiFi.", "Device.WiFi."}) == nil {
		t.Fatal("accepted duplicate")
	}
	if validateIgnoredParameterBranches(make([]string, 65)) == nil {
		t.Fatal("accepted too many branches")
	}
	if err := validateIgnoredParameterBranches(nil); err != nil {
		t.Fatal(err)
	}
}
