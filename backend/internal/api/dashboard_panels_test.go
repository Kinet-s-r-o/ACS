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

func TestFleetActionsAreIndependent(t *testing.T) {
	old := dashboardPanelConfig{ID: "custom-old", Title: "Original"}
	changed := old
	changed.Title = "Changed"
	added := dashboardPanelConfig{ID: "custom-new", Title: "New"}
	for _, action := range []string{"add", "edit", "delete"} {
		can := func(requested string) bool { return requested == action }
		for _, tc := range []struct {
			next     []dashboardPanelConfig
			required string
		}{
			{[]dashboardPanelConfig{old, added}, "add"}, {[]dashboardPanelConfig{changed}, "edit"}, {[]dashboardPanelConfig{}, "delete"},
		} {
			err := authorizeDashboardChanges([]dashboardPanelConfig{old}, tc.next, can)
			if (err == nil) != (action == tc.required) {
				t.Fatalf("%s applied %s", action, tc.required)
			}
		}
	}
	// Combining an allowed addition with a forbidden edit must fail as one request.
	if authorizeDashboardChanges([]dashboardPanelConfig{old}, []dashboardPanelConfig{changed, added}, func(action string) bool { return action == "add" }) == nil {
		t.Fatal("Add smuggled an edit")
	}
}

func TestFleetAddCannotMoveExistingPanelsAndEditCannotHideThem(t *testing.T) {
	first := dashboardPanelConfig{ID: "custom-first", Title: "First"}
	second := dashboardPanelConfig{ID: "custom-second", Title: "Second"}
	canAdd := func(action string) bool { return action == "add" }
	if authorizeDashboardChanges([]dashboardPanelConfig{first, second}, []dashboardPanelConfig{second, first}, canAdd) == nil {
		t.Fatal("Add reordered existing panels")
	}
	added := dashboardPanelConfig{ID: "custom-new", Title: "New"}
	if authorizeDashboardChanges([]dashboardPanelConfig{first}, []dashboardPanelConfig{added, first}, canAdd) == nil {
		t.Fatal("Add moved an existing panel by insertion")
	}
	hidden := first
	hidden.Hidden = true
	if authorizeDashboardChanges([]dashboardPanelConfig{first}, []dashboardPanelConfig{hidden}, func(action string) bool { return action == "edit" }) == nil {
		t.Fatal("Edit removed a panel by hiding it")
	}
}
