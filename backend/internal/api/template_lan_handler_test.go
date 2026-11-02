package api

import (
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestValidateTemplateLANConfiguration(t *testing.T) {
	mappings, err := validateTemplateLANConfiguration(2, []models.ProvisioningLANPortMapping{{Port: 2, StatusParameter: "Device.Ethernet.Interface.2.Status"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 2 || mappings[0].Port != 1 || mappings[1].StatusParameter != "Device.Ethernet.Interface.2.Status" {
		t.Fatalf("unexpected normalized port mappings: %#v", mappings)
	}
	if _, err := validateTemplateLANConfiguration(1, []models.ProvisioningLANPortMapping{{Port: 2}}); err == nil {
		t.Fatal("expected mapping outside configured port count to be rejected")
	}
	if _, err := validateTemplateLANConfiguration(1, []models.ProvisioningLANPortMapping{{Port: 1}, {Port: 1}}); err == nil {
		t.Fatal("expected duplicate port mappings to be rejected")
	}
	if _, err := validateTemplateLANConfiguration(1, []models.ProvisioningLANPortMapping{{Port: 1, StatusParameter: "Device.X;DROP"}}); err == nil {
		t.Fatal("expected malformed CWMP parameter path to be rejected")
	}
}

func TestSanitizeTemplateLANVisualization(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.lan{fill:red}</style><script><![CDATA[window.evil=true]]></script><g id="lan1" class="lan"><circle class="port-led" cx="50" cy="10" r="2"/><g class="cable-system"><path d="M50 12V90"/></g></g></svg>`)
	sanitized, err := sanitizeTemplateLANVisualization(svg, 1)
	if err != nil {
		t.Fatal(err)
	}
	result := string(sanitized)
	if strings.Contains(result, "<script") || strings.Contains(result, "<style") || strings.Contains(result, "window.evil") {
		t.Fatalf("active content remained in sanitized SVG: %s", result)
	}
	if !strings.Contains(result, `id="lan1"`) || !strings.Contains(result, `class="port-led"`) || !strings.Contains(result, `class="cable-system"`) {
		t.Fatalf("port interface was not preserved in sanitized SVG: %s", result)
	}
}

func TestSanitizeTemplateLANVisualizationRejectsUnsafeMarkup(t *testing.T) {
	unsafe := []string{
		`<svg viewBox="0 0 1 1" onload="alert(1)"><g id="lan1"/></svg>`,
		`<svg viewBox="0 0 1 1"><foreignObject/></svg>`,
		`<svg viewBox="0 0 1 1"><use href="https://example.com/other.svg#lan1"/></svg>`,
	}
	for _, input := range unsafe {
		if _, err := sanitizeTemplateLANVisualization([]byte(input), 1); err == nil {
			t.Fatalf("expected unsafe SVG to be rejected: %s", input)
		}
	}
}
