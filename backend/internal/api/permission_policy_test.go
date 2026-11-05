package api

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

func scopedRequest(method, path string, permissions []string, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.Claims{Role: models.RoleRead})
	ctx = context.WithValue(ctx, auth.PermissionsContextKey, permissions)
	return req.WithContext(ctx)
}

func TestScopedRouteAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name, pattern, section, action string
		status                         int
	}{
		{"parent-full-does-not-grant-index-read", "GET /settings/database/indexes", "settings.database", "full", 403},
		{"same-row-full", "GET /settings/database/indexes", "settings.database.indexes", "full", 204},
		{"read-not-edit", "POST /roles", "settings.users.roles", "read", 403},
		{"edit-not-delete", "DELETE /roles/1", "settings.users.roles", "edit", 403},
		{"delete-not-edit", "POST /roles", "settings.users.roles", "delete", 403},
		{"read-does-not-export", "GET /provisioning/export", "settings.provisioning.templates", "read", 403},
		{"edit-custom-role", "POST /roles", "settings.users.roles", "edit", 204},
		{"radius-independent-of-authentication-parent", "PUT /settings/authentication/radius", "settings.authentication", "full", 403},
		{"radius-edit", "PUT /settings/authentication/radius", "settings.authentication.radius", "edit", 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mux := newPermissionMux()
			mux.HandleFunc(tc.pattern, auth.RequireFullAccess(auth.RequirePermission(models.PermUsersWrite)(func(w http.ResponseWriter, req *http.Request) { w.WriteHeader(204) })))
			method, path, _ := strings.Cut(tc.pattern, " ")
			req := scopedRequest(method, path, []string{models.PermissionKey(tc.section, "read"), models.PermissionKey(tc.section, tc.action)}, "")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d", w.Code, tc.status)
			}
		})
	}
}

func TestSettingsPayloadCannotCrossTabPermissions(t *testing.T) {
	r := &Router{}
	mux := newPermissionMux()
	mux.HandleFunc("PUT /settings", r.handleUpdateSettings)
	req := scopedRequest("PUT", "/settings", []string{models.PermissionKey("settings.general.ui", "read"), models.PermissionKey("settings.general.ui", "edit")}, `{"retention_enabled":"false"}`)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal("UI settings edit reached retention persistence")
	}
}

func TestEveryRegisteredEndpointHasCatalogPolicy(t *testing.T) {
	sections := map[string]bool{}
	for _, section := range models.PermissionSections {
		sections[section.ID] = true
	}
	for _, name := range []string{"router.go", "integration.go"} {
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "HandleFunc" {
				return true
			}
			receiver, ok := selector.X.(*ast.Ident)
			if !ok || (name == "router.go" && receiver.Name != "apiMux") {
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok {
				return true
			}
			pattern, _ := strconv.Unquote(literal.Value)
			scopes, action, sessionOnly := endpointPermissions(pattern)
			if len(scopes) == 0 && !sessionOnly {
				t.Errorf("unprotected endpoint %s", pattern)
			}
			for _, scope := range scopes {
				if !sections[scope] || !models.IsSectionPermission(models.PermissionKey(scope, action)) {
					t.Errorf("invalid policy %s: %s / %s", pattern, scope, action)
				}
			}
			return true
		})
	}
}

func TestBuiltInAdministratorAlwaysHasWholeCatalogPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	role := &models.Role{Name: "admin", IsSystem: true, Permissions: []string{}}
	if err := db.Create(role).Error; err != nil {
		t.Fatal(err)
	}
	permissions, err := database.NewRoleRepository(db).GetPermissions(t.Context(), role.ID)
	if err != nil || len(permissions) != len(models.AllPermissions) {
		t.Fatal("built-in administrator lost catalog access")
	}
	for _, section := range models.PermissionSections {
		for _, action := range models.PermissionActions {
			if !models.HasSectionPermission(permissions, section.ID, action) {
				t.Fatalf("administrator missing %s / %s", section.ID, action)
			}
		}
	}
}

func TestDynamicPermissionCatalogPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&models.ProvisioningTemplate{}); err != nil {
		t.Fatal(err)
	}
	template := models.ProvisioningTemplate{Name: "Test", Features: []models.ProvisioningFeature{{ID: "wifi", Name: "WiFi"}}}
	if err := db.Create(&template).Error; err != nil {
		t.Fatal(err)
	}
	role := models.Role{Name: "admin", IsSystem: true, Permissions: []string{}}
	if err := db.Create(&role).Error; err != nil {
		t.Fatal(err)
	}
	repo := database.NewRoleRepository(db)
	grants, err := repo.GetPermissions(t.Context(), role.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, section := range []string{"settings.provisioning.features.wifi", "inventory.cpes.features.wifi"} {
		for _, action := range models.PermissionActions {
			if !models.HasSectionPermission(grants, section, action) {
				t.Fatalf("admin missing dynamic %s / %s", section, action)
			}
		}
		if models.HasSectionPermission([]string{models.PermissionKey("settings.provisioning.features", "full")}, section, "read") {
			t.Fatal("parent granted dynamic child")
		}
	}
}

func TestFeatureTabsIsolationPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&models.ProvisioningTemplate{}); err != nil {
		t.Fatal(err)
	}
	features := []models.ProvisioningFeature{
		{ID: "wifi", Name: "WiFi", Controls: []models.ProvisioningFeatureControl{{Key: "ssid", Label: "SSID", Type: "string", Parameter: "Device.WiFi.SSID"}, {Key: "mode", Label: "Mode", Type: "string", Parameter: "Device.WiFi.Mode"}}},
		{ID: "hidden", Name: "Hidden", Controls: []models.ProvisioningFeatureControl{}},
	}
	template := models.ProvisioningTemplate{Name: "Test", Features: features}
	if err := db.Create(&template).Error; err != nil {
		t.Fatal(err)
	}
	r := &Router{provisioningRepo: database.NewProvisioningRepository(db)}
	mux := newPermissionMux()
	mux.HandleFunc("PUT /provisioning/templates/{id}/features", r.handleSaveTemplateFeatures)
	call := func(action string, selected []models.ProvisioningFeature, deleted []string) int {
		payload, err := json.Marshal(map[string]any{"features": selected, "deleted_ids": deleted})
		if err != nil {
			t.Fatal(err)
		}
		permissions := []string{models.PermissionKey("settings.provisioning.features.wifi", "read"), models.PermissionKey("settings.provisioning.features.wifi", action)}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, scopedRequest("PUT", "/provisioning/templates/"+strconv.FormatInt(template.ID, 10)+"/features", permissions, string(payload)))
		return w.Code
	}
	changed := features[0]
	changed.Name = "Updated WiFi"
	if status := call("edit", []models.ProvisioningFeature{changed}, nil); status != 200 {
		t.Fatalf("own edit: %d", status)
	}
	stored, err := r.provisioningRepo.GetTemplate(t.Context(), template.ID)
	if err != nil || len(stored.Features) != 2 || stored.Features[1].Name != "Hidden" {
		t.Fatal("unsubmitted sibling was changed")
	}
	if status := call("edit", []models.ProvisioningFeature{changed}, []string{"hidden"}); status != 403 {
		t.Fatalf("sibling deletion allowed: %d", status)
	}
	changed.Controls = changed.Controls[:1]
	if status := call("edit", []models.ProvisioningFeature{changed}, nil); status != 403 {
		t.Fatalf("edit granted control deletion: %d", status)
	}
	if status := call("delete", []models.ProvisioningFeature{changed}, nil); status != 200 {
		t.Fatalf("own delete: %d", status)
	}
	changed.Name = "Forbidden rename"
	if status := call("delete", []models.ProvisioningFeature{changed}, nil); status != 403 {
		t.Fatalf("delete granted edit: %d", status)
	}
	if status := call("delete", []models.ProvisioningFeature{}, []string{"wifi"}); status != 200 {
		t.Fatalf("own tab deletion: %d", status)
	}
	stored, err = r.provisioningRepo.GetTemplate(t.Context(), template.ID)
	if err != nil || len(stored.Features) != 1 || stored.Features[0].ID != "hidden" {
		t.Fatal("tab deletion changed sibling")
	}
}

func TestMetricAndHealthFieldIsolation(t *testing.T) {
	before := models.MetricDefinition{Name: "Stored", ParameterName: "Device.Stored", Source: "passive", Health: true, HealthOrder: 2}
	body := models.MetricDefinition{Name: "Injected", ParameterName: "Device.Injected", Health: false, HealthOrder: 3}
	req := scopedRequest("PUT", "/", []string{models.PermissionKey("settings.provisioning.metrics.general.health", "read"), models.PermissionKey("settings.provisioning.metrics.general.health", "edit")}, "")
	req = req.WithContext(auth.WithOperation(req.Context(), "settings.provisioning.metrics.general.health", "edit"))
	mergeMetricPermissions(req, &body, &before, "settings.provisioning.metrics.general")
	if body.Name != before.Name || body.ParameterName != before.ParameterName || body.Source != before.Source || body.Health || body.HealthOrder != 3 {
		t.Fatal("Health edit crossed into Metric fields")
	}
	redactMetricTabs(req, &body, "settings.provisioning.metrics.general")
	if body.ParameterName != "" || body.Source != "" || body.HealthOrder != 3 {
		t.Fatal("Metric data disclosed without Metric read")
	}
}

func TestGrantCannotElevatePrivileges(t *testing.T) {
	req := scopedRequest("POST", "/roles", []string{models.PermissionKey("settings.users.roles", "read"), models.PermissionKey("settings.users.roles", "edit")}, "")
	req = req.WithContext(auth.WithOperation(req.Context(), "settings.users.roles", "edit"))
	if canGrantPermissions(req, []string{models.PermissionKey("settings.authentication.radius", "full")}) {
		t.Fatal("role editor escalated outside owned rights")
	}
	if !canGrantPermissions(req, []string{models.PermissionKey("settings.users.roles", "read")}) {
		t.Fatal("owned grant rejected")
	}
}

func TestTemplateCreateCannotWriteVariables(t *testing.T) {
	mux := newPermissionMux()
	mux.HandleFunc("POST /provisioning/templates", (&Router{}).handleCreateProvisioningTemplate)
	w := httptest.NewRecorder()
	permissions := []string{models.PermissionKey("settings.provisioning.templates", "full")}
	mux.ServeHTTP(w, scopedRequest("POST", "/provisioning/templates", permissions, `{"name":"Test","variables":[{"name":"injected"}]}`))
	if w.Code != 403 {
		t.Fatalf("template edit wrote variables: %d", w.Code)
	}
}

func TestNetworkTabsCannotEditSiblingFields(t *testing.T) {
	const section = "inventory.cpes.overview.wifi.general"
	req := scopedRequest("POST", "/device/test/set-parameters", []string{models.PermissionKey(section, "full")}, "")
	req = req.WithContext(auth.WithOperation(req.Context(), section, "edit"))
	for _, test := range []struct {
		name    string
		allowed bool
	}{
		{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", true},
		{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", false},
		{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BeaconPeriod", false},
		{"InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.Enable", false},
		{"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.NATEnabled", false},
	} {
		w := httptest.NewRecorder()
		if requireParameterEdits(w, req, map[string]string{test.name: "value"}) != test.allowed {
			t.Fatalf("cross-tab field access: %s", test.name)
		}
	}
}

func TestOverviewFullDoesNotRevealWiFiSecuritySecrets(t *testing.T) {
	req := scopedRequest("GET", "/device/test/detail-parameters", []string{models.PermissionKey("inventory.cpes.overview", "full"), models.PermissionKey("inventory.cpes.overview.wifi.security", "read")}, "")
	req = req.WithContext(auth.WithOperation(req.Context(), "inventory.cpes.overview", "read"))
	parameters := []models.DeviceParameter{{Name: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", Value: "test-only"}}
	redactSensitiveParameters(req, parameters)
	if parameters[0].Value != "[REDACTED]" {
		t.Fatal("parent Full exposed child's secret")
	}
}

func TestBulkRuleActionsRequireTheirOwnPermission(t *testing.T) {
	for _, pair := range [][2]string{{"edit", "delete"}, {"delete", "enable"}} {
		mux := newPermissionMux()
		mux.HandleFunc("POST /provisioning/bulk", (&Router{}).handleBulkProvisioningRules)
		grants := []string{models.PermissionKey("settings.provisioning.rules", "read"), models.PermissionKey("settings.provisioning.rules", pair[0])}
		req := scopedRequest("POST", "/provisioning/bulk", grants, `{"template_id":1,"ids":[1],"action":"`+pair[1]+`"}`)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("%s allowed %s: %d", pair[0], pair[1], w.Code)
		}
	}
}
