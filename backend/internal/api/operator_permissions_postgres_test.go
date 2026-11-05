package api

import (
	"encoding/json"
	"errors"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestOperatorCatalogMigrationPostgres(t *testing.T) {
	db := accountTransferTestDatabase(t)
	if err := db.Exec(`CREATE TABLE settings (key text NOT NULL, value text, description text, updated_at timestamptz)`).Error; err != nil {
		t.Fatal(err)
	}
	role := models.Role{Name: "Old partial role", Permissions: []string{"access.settings.users.roles.full", "access.inventory.cpes.overview.full"}}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateOperatorPermissionCatalog(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&role, role.ID).Error; err != nil {
		t.Fatal(err)
	}
	if models.HasSectionPermission(role.Permissions, "settings.users", "full") || models.HasSectionPermission(role.Permissions, "cpe", "full") {
		t.Fatal("migration broadened partial rights")
	}
	role.Permissions = []string{"access.inventory.read", "access.inventory.add"}
	if err := db.Model(&role).Select("permissions").Updates(&role).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateOperatorPermissionCatalog(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&role, role.ID).Error; err != nil || !models.HasSectionPermission(role.Permissions, "inventory", "add") {
		t.Fatal("migration was not idempotent", err)
	}
}

func TestFleetMutationPermissionsPostgres(t *testing.T) {
	db := accountTransferTestDatabase(t)
	if err := db.Exec(`CREATE TABLE user_dashboard_panels (id bigserial, user_id bigint, panel_id text, config text, created_at timestamptz, updated_at timestamptz)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&models.User{}).Create(map[string]any{"id": 0, "username": "test", "password_hash": "", "active": true}).Error; err != nil {
		t.Fatal(err)
	}
	r := &Router{db: db, dashboardPanelRepo: database.NewDashboardPanelRepository(db)}
	call := func(action string, configs []dashboardPanelConfig) int {
		payload, _ := json.Marshal(configs)
		mux := newPermissionMux()
		mux.HandleFunc("PUT /dashboard/panels", r.handleSaveDashboardPanels)
		req := scopedRequest("PUT", "/dashboard/panels", []string{"access.fleet.read", "access.fleet." + action}, string(payload))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w.Code
	}
	old := dashboardPanelConfig{ID: "custom-old", Title: "Old", Kind: "category", Source: "manufacturer"}
	if status := call("add", []dashboardPanelConfig{old}); status != 200 {
		t.Fatal("Add failed", status)
	}
	changed := old
	changed.Title = "Changed"
	if status := call("add", []dashboardPanelConfig{changed}); status != 403 {
		t.Fatal("Add edited an existing panel", status)
	}
	if status := call("edit", []dashboardPanelConfig{changed}); status != 200 {
		t.Fatal("Edit failed", status)
	}
	if status := call("edit", []dashboardPanelConfig{}); status != 403 {
		t.Fatal("Edit deleted a panel", status)
	}
	if status := call("delete", []dashboardPanelConfig{}); status != 200 {
		t.Fatal("Delete failed", status)
	}
}

func TestUserDeletionGuardsPostgres(t *testing.T) {
	db := accountTransferTestDatabase(t)
	for _, table := range []string{"api_tokens", "user_dashboard_panels", "user_dashboard_layouts"} {
		if err := db.Exec("CREATE TABLE " + table + " (user_id bigint)").Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := database.NewUserRepository(db)
	if err := db.Model(&models.User{}).Create(map[string]any{"id": 1, "username": "localadmin", "password_hash": "", "role": "full", "active": true, "auth_provider": "local"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(t.Context(), 1); !errors.Is(err, database.ErrLastLocalAdmin) {
		t.Fatal("deleted the last local admin", err)
	}
	if err := db.Model(&models.User{}).Create(map[string]any{"id": 2, "username": "operator", "password_hash": "", "role": "read", "active": true, "auth_provider": "local"}).Error; err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"api_tokens", "user_dashboard_panels", "user_dashboard_layouts"} {
		if err := db.Exec("INSERT INTO " + table + " (user_id) VALUES (2)").Error; err != nil {
			t.Fatal(err)
		}
	}
	r := &Router{db: db, userRepo: repo}
	mux := newPermissionMux()
	mux.HandleFunc("DELETE /users/{id}", r.handleDeleteUser)
	req := scopedRequest("DELETE", "/users/"+strconv.Itoa(2), []string{"access.settings.users.read", "access.settings.users.delete"}, "")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 204 {
		t.Fatal("Delete user failed", w.Code, w.Body.String())
	}
	for _, table := range []string{"api_tokens", "user_dashboard_panels", "user_dashboard_layouts"} {
		var count int64
		if err := db.Table(table).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("deleted operator data remains", table, err)
		}
	}
	user, err := repo.GetByID(t.Context(), 2)
	if err != nil || user != nil {
		t.Fatal("operator was not deleted", err)
	}
}
