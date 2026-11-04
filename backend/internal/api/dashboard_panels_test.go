package api

import "testing"

func TestDashboardOnlyAllowsGrowthAndCustomPanels(t *testing.T) {
	for _, id := range []string{"growth", "custom-model"} {
		if err := validateDashboardLayout(dashboardLayoutConfig{id: {Width: 60}}); err != nil {
			t.Fatalf("layout %s: %v", id, err)
		}
	}
	for _, id := range []string{"contactRecency", "uptime", "temperature", "rxPower", "accessType", "manufacturer", "productClass"} {
		if validDashboardPanelID(id) || validateDashboardLayout(dashboardLayoutConfig{id: {Width: 60}}) == nil {
			t.Errorf("retired panel %s is still allowed", id)
		}
	}
	if err := validateDashboardPanelConfigs(nil); err != nil {
		t.Fatalf("default dashboard must allow no custom panels: %v", err)
	}
	if err := validateDashboardPanelConfigs([]dashboardPanelConfig{{ID: "custom-model", Title: "Model", Kind: "category", Source: "product_class"}}); err != nil {
		t.Fatalf("custom aggregation must remain available: %v", err)
	}
	if err := validateDashboardPanelConfigs([]dashboardPanelConfig{{ID: "custom-old", Title: "Old", Kind: "recency", Source: "last_inform"}}); err == nil {
		t.Fatal("retired recency kind is still allowed")
	}
}
