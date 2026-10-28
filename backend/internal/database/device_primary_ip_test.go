package database

import (
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestSelectPrimaryIPAddressByParameter(t *testing.T) {
	parameters := []models.DeviceParameter{
		{Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress", Value: "10.0.0.1"},
		{Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress", Value: "172.16.0.1"},
	}

	got := SelectPrimaryIPAddress(parameters, models.TemplateInventory{
		PrimaryIPMode:      "parameter",
		PrimaryIPParameter: parameters[0].Name,
	}, "legacy")
	if got != "10.0.0.1" {
		t.Fatalf("selected IP = %q, want %q", got, "10.0.0.1")
	}
}

func TestSelectPrimaryIPAddressByInterfaceName(t *testing.T) {
	parameters := []models.DeviceParameter{
		{Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.Name", Value: "Internet"},
		{Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress", Value: "172.16.0.1"},
		{Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Name", Value: "Management"},
		{Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress", Value: "10.0.0.1"},
	}

	got := SelectPrimaryIPAddress(parameters, models.TemplateInventory{
		PrimaryIPMode:          "interface_name",
		PrimaryIPInterfaceName: "Internet",
	}, "legacy")
	if got != "172.16.0.1" {
		t.Fatalf("selected IP = %q, want %q", got, "172.16.0.1")
	}
}

func TestSelectPrimaryIPAddressFallsBackWhenConfiguredValueIsMissing(t *testing.T) {
	got := SelectPrimaryIPAddress(nil, models.TemplateInventory{
		PrimaryIPMode:          "interface_name",
		PrimaryIPInterfaceName: "Internet",
	}, "legacy")
	if got != "legacy" {
		t.Fatalf("selected IP = %q, want %q", got, "legacy")
	}
}
