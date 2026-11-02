package api

import (
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestValidateTemplateCPEInfoFields(t *testing.T) {
	fields, err := validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "  RX power ", ParameterName: " Device.WAN.PON.RXPower "}})
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields[0].Name != "RX power" || fields[0].ParameterName != "Device.WAN.PON.RXPower" {
		t.Fatalf("unexpected normalized CPE info fields: %#v", fields)
	}
	if _, err := validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "Missing path"}}); err == nil {
		t.Fatal("expected an empty parameter name to be rejected")
	}
	if _, err := validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "Invalid path", ParameterName: "Device.X;DROP"}}); err == nil {
		t.Fatal("expected an invalid CWMP parameter name to be rejected")
	}
}
