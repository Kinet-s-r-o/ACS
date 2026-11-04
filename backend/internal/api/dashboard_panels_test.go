package api

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

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

func TestRetiredDashboardPanelsMigrationPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&models.UserDashboardPanel{}, &models.UserDashboardLayout{}); err != nil {
		t.Fatal(err)
	}
	user := models.User{Username: "dashboard-migration"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	panels := []models.UserDashboardPanel{
		{UserID: user.ID, PanelID: "contactRecency", Config: `{"id":"contactRecency","kind":"recency"}`},
		{UserID: user.ID, PanelID: "custom-old", Config: `{"id":"custom-old","kind":"recency"}`},
		{UserID: user.ID, PanelID: "custom-model", Config: `{"id":"custom-model","kind":"category","source":"product_class"}`},
		{UserID: user.ID, PanelID: "custom-parameter", Config: `{"id":"custom-parameter","parameter_pattern":"Device.UpTime"}`},
	}
	if err := db.Create(&panels).Error; err != nil {
		t.Fatal(err)
	}
	layout := `{"growth":{"width":60},"contactRecency":{"width":30},"custom-old":{"width":30},"custom-model":{"width":80},"custom-parameter":{"width":40},"manufacturer":{"width":30}}`
	if err := database.NewDashboardLayoutRepository(db).Save(context.Background(), user.ID, layout); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := database.MigrateRetiredDashboardPanels(context.Background(), db); err != nil {
			t.Fatal(err)
		}
	}
	remaining, err := database.NewDashboardPanelRepository(db).List(context.Background(), user.ID)
	if err != nil || len(remaining) != 2 {
		t.Fatalf("expected two custom panels, got %d: %v", len(remaining), err)
	}
	for _, panel := range remaining {
		if panel.PanelID != "custom-model" && panel.PanelID != "custom-parameter" {
			t.Errorf("unexpected panel %s", panel.PanelID)
		}
	}
	encoded, err := database.NewDashboardLayoutRepository(db).Get(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	var cleaned map[string]map[string]int
	if err := json.Unmarshal([]byte(encoded), &cleaned); err != nil {
		t.Fatal(err)
	}
	if len(cleaned) != 3 || cleaned["growth"]["width"] != 60 || cleaned["custom-model"]["width"] != 80 || cleaned["custom-parameter"]["width"] != 40 {
		t.Fatalf("custom layout was not preserved: %s", encoded)
	}
}
