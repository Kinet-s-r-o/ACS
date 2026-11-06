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
		{"edit-window-read", "GET /device/{serial}/edit-window", "cpe", "read", 204},
		{"edit-window-write", "POST /device/{serial}/edit-window", "cpe", "write", 204},
		{"edit-window-read-cannot-write", "POST /device/{serial}/edit-window", "cpe", "read", 403},
		{"edit-designer-read", "GET /provisioning/templates/{id}/edit-windows/parameters", "settings.provisioning", "read", 204},
		{"edit-designer-save", "PUT /provisioning/templates/{id}/edit-windows", "settings.provisioning", "write", 204},
		{"edit-designer-read-cannot-save", "PUT /provisioning/templates/{id}/edit-windows", "settings.provisioning", "read", 403},
		{"database-full-includes-index-read", "GET /settings/database/indexes", "settings.database", "full", 204},
		{"retired-leaf-full-denied", "GET /settings/database/indexes", "settings.database.indexes", "full", 403},
		{"read-not-edit", "POST /roles", "settings.users", "read", 403},
		{"edit-not-delete", "DELETE /roles/1", "settings.users", "write", 403},
		{"delete-not-edit", "POST /roles", "settings.users", "delete", 403},
		{"read-does-not-export", "GET /provisioning/export", "settings.provisioning.templates", "read", 403},
		{"edit-custom-role", "POST /roles", "settings.users", "write", 204},
		{"authentication-full-includes-radius", "PUT /settings/authentication/radius", "settings.authentication", "full", 204},
		{"radius-write", "PUT /settings/authentication/radius", "settings.authentication", "write", 204},
		{"inventory-add", "POST /devices", "inventory", "add", 204},
		{"inventory-write-cannot-add", "POST /devices", "inventory", "write", 403},
		{"inventory-read-wans", "GET /wan-interfaces", "inventory", "read", 204},
		{"cpe-read-cannot-list-inventory", "GET /devices", "cpe", "read", 403},
		{"inventory-full-cannot-open-detail", "GET /device/{serial}", "inventory", "full", 403},
		{"inventory-read-cannot-open-integration-detail", "GET /v1/devices/{serial}", "inventory", "read", 403},
		{"cpe-write-factory-reset", "POST /device/{serial}/factory-reset", "cpe", "write", 204},
		{"cpe-delete-cannot-reset", "POST /device/{serial}/factory-reset", "cpe", "delete", 403},
		{"cpe-write-delete-ssid", "DELETE /device/{serial}/wifi/ssids/{instance}", "cpe", "write", 204},
		{"cpe-delete-is-only-device-deletion", "DELETE /device/{serial}/wifi/ssids/{instance}", "cpe", "delete", 403},
		{"cpe-write-not-delete-record", "DELETE /device/{serial}", "cpe", "write", 403},
		{"cpe-delete-record", "DELETE /device/{serial}", "cpe", "delete", 204},
		{"inventory-write-bulk-summon", "POST /system-tasks/bulk-summon", "inventory", "write", 204},
		{"cpe-write-not-bulk-restart", "POST /system-tasks/bulk-restart", "cpe", "write", 403},
		{"inventory-write-not-tags", "PUT /device/{serial}/tags", "inventory", "write", 403},
		{"inventory-write-not-diagnostics", "POST /device/{serial}/diagnostics/ping", "inventory", "write", 403},
		{"cpe-write-diagnostics", "POST /device/{serial}/diagnostics/ping", "cpe", "write", 204},
		{"cpe-write-tags", "PUT /device/{serial}/tags", "cpe", "write", 204},
		{"blocklist-add", "POST /blocked-devices", "security.blocklist", "add", 204},
		{"blocklist-remove", "DELETE /blocked-devices/{serial}", "security.blocklist", "remove", 204},
		{"blocklist-add-not-remove", "DELETE /blocked-devices/{serial}", "security.blocklist", "add", 403},
		{"firmware-upload-write", "POST /firmwares", "firmwares", "write", 204},
		{"firmware-upload-read-denied", "POST /firmwares", "firmwares", "read", 403},
		{"metric-definitions-belong-to-provisioning", "GET /metrics/definitions", "settings.provisioning", "read", 204},
		{"cpe-read-metric-definitions", "GET /device/{serial}/metric-definitions", "cpe", "read", 204},
		{"cpe-read-metric-samples", "GET /device/{serial}/metrics", "cpe", "read", 204},
		{"cpe-read-interface-definitions", "GET /device/{serial}/interface-metric-definitions", "cpe", "read", 204},
		{"cpe-read-interface-samples", "GET /device/{serial}/interface-metrics", "cpe", "read", 204},
		{"cpe-read-cannot-read-system-settings", "GET /settings", "cpe", "read", 403},
		{"cpe-read-cannot-read-provisioning-metrics", "GET /metrics/definitions", "cpe", "read", 403},
		{"cpe-read-cannot-edit-metrics", "PUT /metrics/definitions/{id}", "cpe", "read", 403},
		{"users-write-not-import", "POST /users/import", "settings.users", "write", 403},
		{"roles-import", "POST /roles/import", "settings.users", "import", 204},
		{"provisioning-write-not-backup", "GET /provisioning/export", "settings.provisioning", "write", 403},
		{"provisioning-full-backup", "GET /provisioning/export", "settings.provisioning", "full", 204},
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
	req := scopedRequest("PUT", "/settings", []string{models.PermissionKey("settings.general", "read"), models.PermissionKey("settings.general", "write")}, `{"retention_enabled":"false"}`)
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
		for _, action := range section.Actions {
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
		if !models.HasSectionPermission([]string{models.PermissionKey("settings.provisioning", "read")}, section, "read") && strings.HasPrefix(section, "settings.") {
			t.Fatal("Provisioning Read omitted a feature tab")
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
		permissions := []string{models.PermissionKey("settings.provisioning", "read"), models.PermissionKey("settings.provisioning", action)}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, scopedRequest("PUT", "/provisioning/templates/"+strconv.FormatInt(template.ID, 10)+"/features", permissions, string(payload)))
		return w.Code
	}
	changed := features[0]
	changed.Name = "Updated WiFi"
	if status := call("write", []models.ProvisioningFeature{changed}, nil); status != 200 {
		t.Fatalf("own edit: %d", status)
	}
	stored, err := r.provisioningRepo.GetTemplate(t.Context(), template.ID)
	if err != nil || len(stored.Features) != 2 || stored.Features[1].Name != "Hidden" {
		t.Fatal("unsubmitted sibling was changed")
	}
	if status := call("write", []models.ProvisioningFeature{changed}, []string{"hidden"}); status != 403 {
		t.Fatalf("sibling deletion allowed: %d", status)
	}
	changed.Controls = changed.Controls[:1]
	if status := call("write", []models.ProvisioningFeature{changed}, nil); status != 403 {
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

func TestMetricAndHealthShareProvisioningPermissions(t *testing.T) {
	before := models.MetricDefinition{Name: "Stored", ParameterName: "Device.Stored", Health: true, HealthShowUpdatedAt: true}
	for _, action := range []string{"read", "write"} {
		body := models.MetricDefinition{Name: "Changed", ParameterName: "Device.Changed", Health: false}
		req := scopedRequest("PUT", "/", []string{models.PermissionKey("settings.provisioning", "read"), models.PermissionKey("settings.provisioning", action)}, "")
		req = req.WithContext(auth.WithOperation(req.Context(), "settings.provisioning", action))
		mergeMetricPermissions(req, &body, &before, "settings.provisioning.metrics.general")
		if action == "read" && (body.Name != before.Name || body.ParameterName != before.ParameterName || body.Health != before.Health || body.HealthShowUpdatedAt != before.HealthShowUpdatedAt) {
			t.Fatal("Read changed a metric")
		}
		if action == "write" && (body.Name != "Changed" || body.ParameterName != "Device.Changed" || body.Health || body.HealthShowUpdatedAt) {
			t.Fatal("Write did not cover Metric and Health")
		}
	}
}

func TestGrantCannotElevatePrivileges(t *testing.T) {
	req := scopedRequest("POST", "/roles", []string{models.PermissionKey("settings.users", "read"), models.PermissionKey("settings.users", "write")}, "")
	req = req.WithContext(auth.WithOperation(req.Context(), "settings.users", "write"))
	if canGrantPermissions(req, []string{models.PermissionKey("settings.authentication", "full")}) {
		t.Fatal("role editor escalated outside owned rights")
	}
	if !canGrantPermissions(req, []string{models.PermissionKey("settings.users", "read")}) {
		t.Fatal("owned grant rejected")
	}
}

func TestTemplateCreateCannotWriteVariables(t *testing.T) {
	mux := newPermissionMux()
	mux.HandleFunc("POST /provisioning/templates", (&Router{}).handleCreateProvisioningTemplate)
	w := httptest.NewRecorder()
	permissions := []string{models.PermissionKey("settings.provisioning", "read")}
	mux.ServeHTTP(w, scopedRequest("POST", "/provisioning/templates", permissions, `{"name":"Test","variables":[{"name":"injected"}]}`))
	if w.Code != 403 {
		t.Fatalf("template edit wrote variables: %d", w.Code)
	}
}

func TestCPEWriteCoversNetworkTabs(t *testing.T) {
	for _, action := range []string{"read", "write"} {
		req := scopedRequest("POST", "/device/test/set-parameters", []string{models.PermissionKey("cpe", "read"), models.PermissionKey("cpe", action)}, "")
		req = req.WithContext(auth.WithOperation(req.Context(), "cpe", action))
		for _, name := range []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", "InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.Enable", "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.NATEnabled"} {
			if requireParameterEdits(httptest.NewRecorder(), req, map[string]string{name: "value"}) != (action == "write") {
				t.Fatal("incorrect network permission", action, name)
			}
		}
	}
}

func TestOverviewFullDoesNotRevealWiFiSecuritySecrets(t *testing.T) {
	req := scopedRequest("GET", "/device/test/detail-parameters", []string{models.PermissionKey("cpe", "read")}, "")
	req = req.WithContext(auth.WithOperation(req.Context(), "inventory.cpes.overview", "read"))
	parameters := []models.DeviceParameter{{Name: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", Value: "test-only"}}
	redactSensitiveParameters(req, parameters)
	if parameters[0].Value != "[REDACTED]" {
		t.Fatal("parent Full exposed child's secret")
	}
}

func TestBulkRuleActionsRequireTheirOwnPermission(t *testing.T) {
	for _, pair := range [][2]string{{"write", "delete"}, {"delete", "enable"}} {
		mux := newPermissionMux()
		mux.HandleFunc("POST /provisioning/bulk", (&Router{}).handleBulkProvisioningRules)
		grants := []string{models.PermissionKey("settings.provisioning", "read"), models.PermissionKey("settings.provisioning", pair[0])}
		req := scopedRequest("POST", "/provisioning/bulk", grants, `{"template_id":1,"ids":[1],"action":"`+pair[1]+`"}`)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("%s allowed %s: %d", pair[0], pair[1], w.Code)
		}
	}
}
