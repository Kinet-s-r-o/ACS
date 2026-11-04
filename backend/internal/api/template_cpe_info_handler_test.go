package api

import (
	"strings"
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
	fields, err = validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "Last inform", Source: "acs", ACSField: "last_inform", ParameterName: "ignored"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields[0].Source != "acs" || fields[0].ACSField != "last_inform" || fields[0].ParameterName != "" {
		t.Fatalf("unexpected normalized ACS CPE info field: %#v", fields)
	}
	if _, err := validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "Bad timestamp", Source: "acs", ACSField: "last_bootstrap;DROP"}}); err == nil {
		t.Fatal("expected an invalid ACS field to be rejected")
	}
}

func TestValidateTemplateCPEInfoPostfix(t *testing.T) {
	for _, postfix := range []string{"", " dBm", "%", " °C", "  unit ", strings.Repeat("°", 32)} {
		for _, source := range []string{"parameter", "acs"} {
			fields, err := validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "Value", Source: source, ParameterName: "Device.Test.Value", ACSField: "last_inform", Postfix: postfix}})
			if err != nil || len(fields) != 1 || fields[0].Postfix != postfix {
				t.Fatalf("postfix %q, source %s: fields=%#v, err=%v", postfix, source, fields, err)
			}
		}
	}
	for _, postfix := range []string{strings.Repeat("a", 33), "unit\n", "\tunit", "\x00"} {
		if _, err := validateTemplateCPEInfoFields([]models.ProvisioningCPEInfoField{{Name: "Value", ParameterName: "Device.Test.Value", Postfix: postfix}}); err == nil {
			t.Fatalf("accepted invalid postfix %q", postfix)
		}
	}
}
