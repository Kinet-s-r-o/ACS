package database

import "testing"

func TestDynamicParameterBranchMatches(t *testing.T) {
	branch := "InternetGatewayDevice.LANDevice.*.Hosts.Host."
	if !DynamicParameterBranchMatches(branch, "InternetGatewayDevice.LANDevice.1.Hosts.Host.8.HostName") {
		t.Fatal("expected dynamic host parameter to match")
	}
	if DynamicParameterBranchMatches(branch, "InternetGatewayDevice.LANDevice.1.Hosts.HostName") {
		t.Fatal("expected incomplete host path not to match")
	}
}

func TestFilterDynamicParameterNames(t *testing.T) {
	names := []string{
		"InternetGatewayDevice.DeviceInfo.SoftwareVersion",
		"InternetGatewayDevice.LANDevice.1.Hosts.Host.8.HostName",
	}
	filtered := FilterDynamicParameterNames(names, []string{"InternetGatewayDevice.LANDevice.*.Hosts.Host."})
	if len(filtered) != 1 || filtered[0] != names[0] {
		t.Fatalf("unexpected filtered names: %#v", filtered)
	}
}
