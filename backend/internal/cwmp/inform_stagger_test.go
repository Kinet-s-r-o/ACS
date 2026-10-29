package cwmp

import (
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

func TestPlanInformStaggerUsesStablePhase(t *testing.T) {
	inform := &Inform{DeviceId: DeviceId{OUI: "001122", SerialNumber: "CPE-1"}}
	cached := []models.DeviceParameter{{
		Name:  "InternetGatewayDevice.ManagementServer.PeriodicInformInterval",
		Value: "300",
	}}
	now := time.Date(2026, 10, 29, 19, 50, 49, 0, time.UTC)

	first, ok := planInformStagger(inform, cached, now)
	if !ok {
		t.Fatal("expected a stagger plan")
	}
	second, ok := planInformStagger(inform, cached, now)
	if !ok || first != second {
		t.Fatalf("stagger plan is not stable: first=%+v second=%+v", first, second)
	}
	parsed, err := time.Parse(time.RFC3339, first.Value)
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.After(now) {
		t.Fatalf("planned time %s is not in the future", parsed)
	}
}

func TestPlanInformStaggerSkipsMissingOrInvalidInterval(t *testing.T) {
	inform := &Inform{DeviceId: DeviceId{OUI: "001122", SerialNumber: "CPE-1"}}
	for _, value := range []string{"", "0", "not-a-number"} {
		cached := []models.DeviceParameter{{Name: "Device.ManagementServer.PeriodicInformInterval", Value: value}}
		if _, ok := planInformStagger(inform, cached, time.Now()); ok {
			t.Fatalf("expected invalid interval %q to be skipped", value)
		}
	}
}
