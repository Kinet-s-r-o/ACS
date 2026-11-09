package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

type permissionMux struct{ *http.ServeMux }

var provisioningTransferSections = []string{"settings.provisioning.templates", "settings.provisioning.rules", "settings.provisioning.variables", "settings.provisioning.metrics.general.metric", "settings.provisioning.metrics.general.health", "settings.provisioning.metrics.interface", "settings.provisioning.metrics.polling", "settings.provisioning.features", "settings.provisioning.cpe_detail.lan", "settings.provisioning.cpe_detail.info"}

func requireProvisioningSections(w http.ResponseWriter, req *http.Request, action string, features []models.ProvisioningFeature) bool {
	for _, section := range provisioningTransferSections {
		if !requestCan(req, section, action) {
			respondError(w, http.StatusForbidden, "Operation requires "+action+" permission for every included provisioning section")
			return false
		}
	}
	for _, feature := range features {
		if !requestCan(req, "settings.provisioning.features."+feature.ID, action) {
			respondError(w, http.StatusForbidden, "Operation requires "+action+" permission for tab "+feature.Name)
			return false
		}
	}
	return true
}

func newPermissionMux() *permissionMux { return &permissionMux{http.NewServeMux()} }

func (r *Router) validPermissionKeys(ctx context.Context) (map[string]bool, error) {
	sections, err := r.roleRepo.PermissionCatalog(ctx)
	if err != nil {
		return nil, err
	}
	keys := map[string]bool{}
	for _, key := range database.CatalogPermissionKeys(sections) {
		keys[key] = true
	}
	return keys, nil
}

func requestCan(req *http.Request, section, action string) bool {
	if user := auth.GetUserFromContext(req.Context()); user != nil && user.Role == models.RoleFull {
		return true
	}
	if !auth.OperationAuthorized(req.Context()) {
		return auth.HasOperationAccess(req.Context())
	}
	return models.HasSectionPermission(auth.GetPermissionsFromContext(req.Context()), section, action)
}

func (r *Router) canManageUser(req *http.Request, user *models.User) bool {
	if !auth.OperationAuthorized(req.Context()) {
		return auth.HasOperationAccess(req.Context())
	}
	if user.RoleID == nil {
		return user.Role != models.RoleFull || canGrantPermissions(req, models.AllPermissions)
	}
	permissions, err := r.roleRepo.GetPermissions(req.Context(), *user.RoleID)
	return err == nil && permissions != nil && canGrantPermissions(req, permissions)
}

func redactTaskTabs(req *http.Request, task *models.Task, section string) {
	if task == nil || !auth.OperationAuthorized(req.Context()) {
		return
	}
	if !requestCan(req, section+".requested", "read") {
		task.Payload = nil
	}
	if !requestCan(req, section+".result", "read") {
		task.Result = nil
	}
}

func canGrantPermissions(req *http.Request, permissions []string) bool {
	if user := auth.GetUserFromContext(req.Context()); user != nil && user.Role == models.RoleFull {
		return true
	}
	if !auth.OperationAuthorized(req.Context()) {
		return auth.HasOperationAccess(req.Context())
	}
	actor := auth.GetPermissionsFromContext(req.Context())
	for _, key := range permissions {
		if !strings.HasPrefix(key, "access.") {
			return false
		}
		section, action, found := splitPermission(key)
		if !found || !models.HasSectionPermission(actor, section, action) {
			return false
		}
	}
	return true
}
func splitPermission(key string) (string, string, bool) {
	index := strings.LastIndex(key, ".")
	if index < 7 {
		return "", "", false
	}
	return key[7:index], key[index+1:], true
}

func settingSection(key string) string {
	switch {
	case key == auth.LocalSessionMinutesSetting || key == auth.ExternalSessionMinutesSetting:
		return "settings.users"
	case strings.HasPrefix(key, "retention_") || strings.HasPrefix(key, "compression_"):
		return "settings.database.retention"
	case key == "fleet_aggregation_options":
		return "settings.general.aggregations"
	case strings.HasPrefix(key, "ui_"):
		return "settings.general.ui"
	case key == "app_name" || key == "app_logo" || key == "default_page_size" || key == "auto_refresh_interval" || key == "chart_show_points":
		return "settings.general.general"
	default:
		return "settings.delivery"
	}
}

func (m *permissionMux) HandleFunc(pattern string, next http.HandlerFunc) {
	scopes, action, sessionOnly := endpointPermissions(pattern)
	if !sessionOnly && len(scopes) == 0 {
		panic("missing permission policy: " + pattern)
	}
	m.ServeMux.HandleFunc(pattern, func(w http.ResponseWriter, req *http.Request) {
		if sessionOnly {
			next(w, req.WithContext(auth.WithOperation(req.Context(), "", "read")))
			return
		}
		permissions := auth.GetPermissionsFromContext(req.Context())
		administrator := false
		if user := auth.GetUserFromContext(req.Context()); user != nil {
			administrator = user.Role == models.RoleFull
		}
		requestScopes := append([]string{}, scopes...)
		if strings.Contains(pattern, "/provisioning/import") || strings.Contains(pattern, "/provisioning/export") {
			for _, section := range provisioningTransferSections {
				if !administrator && !models.HasSectionPermission(permissions, section, action) {
					respondError(w, http.StatusForbidden, "Backup requires "+action+" permission for every included provisioning section")
					return
				}
			}
		}
		if req.Method == "PUT" && req.URL.Path == "/dashboard/panels" {
			for _, candidate := range []string{"add", "edit", "delete"} {
				if administrator || models.HasSectionPermission(permissions, "fleet", candidate) {
					next(w, req.WithContext(auth.WithOperation(req.Context(), "fleet", candidate)))
					return
				}
			}
			respondError(w, http.StatusForbidden, "Fleet Add, Edit or Delete permission required")
			return
		}
		for _, scope := range requestScopes {
			operationAction := action
			mixedMutation := (req.Method == "PUT" && strings.HasSuffix(req.URL.Path, "/features")) || (req.Method == "POST" && req.URL.Path == "/provisioning/bulk")
			if mixedMutation && !models.HasSectionPermission(permissions, scope, "edit") && models.HasSectionPermission(permissions, scope, "delete") {
				operationAction = "delete"
			}
			if administrator || models.HasSectionPermission(permissions, scope, operationAction) {
				next(w, req.WithContext(auth.WithOperation(req.Context(), scope, operationAction)))
				return
			}
		}
		respondError(w, http.StatusForbidden, "Section permission required: "+strings.Join(scopes, " or ")+" / "+action)
	})
}

// Every authenticated endpoint belongs to a section and one of the six actions.
// Shared reference data lists explicit consumers; parent permissions never satisfy a child.
func endpointPermissions(pattern string) ([]string, string, bool) {
	method, path, _ := strings.Cut(pattern, " ")
	switch {
	case path == "/dashboard/panels/copy":
		return []string{"settings.users"}, "write", false

	case (path == "/devices" || path == "/v1/devices") && method == "POST":
		return []string{"inventory"}, "add", false
	case path == "/devices/stats":
		return []string{"fleet", "inventory"}, "read", false
	case path == "/security/overview":
		return []string{"security.blocklist", "security.audit"}, "read", false
	case method == "POST" && (path == "/system-tasks/bulk-summon" || path == "/system-tasks/bulk-restart"):
		return []string{"inventory", "settings.system_tasks"}, "write", false
	case method == "POST" && path == "/system-tasks/summon":
		return []string{"cpe", "settings.system_tasks"}, "write", false
	case method == "GET" && path == "/system-tasks/{id}":
		return []string{"settings.system_tasks", "cpe", "inventory"}, "read", false
	case (strings.HasPrefix(path, "/device/") || strings.HasPrefix(path, "/devices/") || strings.HasPrefix(path, "/v1/devices/")) && strings.HasSuffix(path, "/factory-reset"):
		return []string{"cpe"}, "write", false
	case method == "DELETE" && path == "/device/{serial}/snapshots/{id}":
		return []string{"cpe"}, "write", false
	case method == "DELETE" && strings.HasPrefix(path, "/device/") && (strings.Contains(path, "/wifi/") || strings.Contains(path, "/wan-interfaces/") || strings.Contains(path, "/features/")):
		return []string{"cpe"}, "write", false
	case method == "GET" && ((strings.HasPrefix(path, "/device/") && strings.Count(path, "/") == 2) || (strings.HasPrefix(path, "/devices/") && strings.Count(path, "/") == 2) || (strings.HasPrefix(path, "/v1/devices/") && strings.Count(path, "/") == 3)):
		return []string{"cpe"}, "read", false
	case method != "GET" && method != "DELETE" && !strings.HasPrefix(path, "/devices/analytics/") && (strings.HasPrefix(path, "/device/") || strings.HasPrefix(path, "/devices/") || strings.HasPrefix(path, "/v1/devices/")):
		return []string{"cpe"}, "write", false
	}
	scopes, action, sessionOnly := internalEndpointPermissions(pattern)
	if sessionOnly {
		return scopes, action, true
	}
	canonical, seen := []string{}, map[string]bool{}
	inputAction := action
	for _, section := range scopes {
		target, targetAction := models.CanonicalPermission(section, inputAction)
		if !models.IsSectionPermission(models.PermissionKey(target, targetAction)) {
			// Unlisted operations (for example provisioning backups) require Full.
			targetAction = "full"
		}
		action = targetAction
		if !seen[target] {
			canonical = append(canonical, target)
			seen[target] = true
		}
	}
	return canonical, action, false
}

func internalEndpointPermissions(pattern string) ([]string, string, bool) {
	method, path, _ := strings.Cut(pattern, " ")
	action := "edit"
	if method == "GET" {
		action = "read"
	}
	if method == "DELETE" || strings.Contains(path, "bulk-delete") {
		action = "delete"
	}
	if strings.HasSuffix(path, "/import") {
		action = "import"
	}
	if strings.HasSuffix(path, "/export") {
		action = "export"
	}
	scope := func(ids ...string) ([]string, string, bool) { return ids, action, false }
	switch path {
	case "/auth/me", "/auth/logout", "/auth/change-password", "/permissions", "/v1/me":
		return nil, "read", true
	case "/openapi.json":
		return scope("settings.api_docs")
	case "/auth/providers":
		return scope("settings.users.users")
	case "/settings":
		return scope("settings.general.general", "settings.general.ui", "settings.general.aggregations", "settings.database.retention", "settings.delivery")
	case "/settings/connection-request-secret":
		return []string{"settings.delivery"}, "full", false
	case "/settings/retention/stats":
		return scope("settings.database.statistics")
	case "/settings/retention/compression":
		return scope("settings.database.retention")
	case "/settings/database/statistics":
		return scope("settings.database.statistics")
	case "/cwmp-control", "/cwmp-control/{state}":
		return scope("settings.provisioning")
	case "/devices/stats", "/devices/growth", "/devices/analytics/panels", "/devices/analytics/distribution":
		action = "read"
		return scope("fleet")
	case "/devices", "/v1/devices":
		return scope("inventory.cpes")
	case "/wan-interfaces":
		return scope("inventory.wans")
	case "/firmwares":
		if method == "POST" {
			action = "write"
		}
		return scope("firmwares")
	case "/devices/device-types":
		return scope("settings.metrics", "settings.provisioning.metrics.general")
	case "/tags":
		if method == "GET" {
			return scope("settings.dictionaries.tags", "inventory.cpes", "inventory.cpes.overview", "inventory.wans", "settings.provisioning.templates")
		}
		return scope("settings.dictionaries.tags")
	case "/roles":
		if method == "GET" {
			return scope("settings.users.roles", "settings.users.users")
		}
		return scope("settings.users.roles")
	case "/users":
		if method == "GET" {
			return scope("settings.users.users", "settings.users.users.tokens", "settings.users.users.dashboards")
		}
		return scope("settings.users.users")
	case "/provisioning":
		return scope("settings.provisioning.rules")
	case "/provisioning/templates":
		if method == "GET" {
			return scope("settings.provisioning.templates", "settings.provisioning.rules", "settings.provisioning.variables", "settings.provisioning.metrics.general", "settings.provisioning.metrics.interface", "settings.provisioning.metrics.polling", "settings.provisioning.features", "settings.provisioning.cpe_detail.lan", "settings.provisioning.cpe_detail.info", "inventory.cpes.overview", "inventory.cpes.hosts", "inventory.cpes.features")
		}
		return scope("settings.provisioning.templates")
	case "/provisioning/export", "/provisioning/import":
		return scope("settings.provisioning.templates")
	case "/security/overview":
		return scope("security")
	case "/audit-logs":
		return scope("security.audit")
	case "/blocked-devices":
		return scope("security.blocklist")
	}
	switch {
	case strings.HasPrefix(path, "/settings/authentication/radius"):
		return scope("settings.authentication.radius")
	case strings.HasPrefix(path, "/settings/database/indexes"):
		return scope("settings.database.indexes")
	case strings.HasPrefix(path, "/roles/"):
		return scope("settings.users.roles")
	case strings.HasPrefix(path, "/users/") && strings.Contains(path, "/api-tokens"):
		return scope("settings.users.users.tokens")
	case strings.HasPrefix(path, "/users/") && strings.Contains(path, "/dashboard-"):
		return scope("settings.users.users.dashboards")
	case path == "/users" || strings.HasPrefix(path, "/users/"):
		return scope("settings.users.users")
	case strings.HasPrefix(path, "/dashboard/"):
		return scope("fleet")
	case strings.HasPrefix(path, "/tags/"):
		return scope("settings.dictionaries.tags")
	case strings.HasPrefix(path, "/tasks"):
		if method == "DELETE" {
			return scope("tasks", "inventory.cpes.tasks")
		}
		if method == "GET" {
			return scope("tasks", "tasks.requested", "tasks.result")
		}
		return scope("tasks")
	case strings.HasPrefix(path, "/system-tasks/") && strings.Contains(path, "bulk-restart"):
		return scope("settings.system_tasks.bulk_restart")
	case strings.HasPrefix(path, "/system-tasks/") && strings.Contains(path, "bulk-summon"):
		return scope("settings.system_tasks.bulk_summon")
	case path == "/system-tasks/summon":
		return scope("settings.system_tasks.summon_from_cpe", "inventory.cpes.overview")
	case strings.HasPrefix(path, "/system-tasks"):
		return scope("settings.system_tasks.summon_from_cpe", "settings.system_tasks.bulk_summon", "settings.system_tasks.bulk_restart")
	case strings.HasPrefix(path, "/faults"):
		return scope("faults")
	case strings.HasPrefix(path, "/firmwares"):
		return scope("firmwares")
	case strings.HasPrefix(path, "/blocked-devices/"):
		return scope("security.blocklist")
	case strings.HasPrefix(path, "/metrics/definitions"):
		if method == "DELETE" {
			return scope("settings.metrics.metric")
		}
		return scope("settings.metrics.metric", "settings.metrics.health")
	case strings.HasPrefix(path, "/provisioning/templates/"):
		switch {
		case strings.Contains(path, "/edit-windows"):
			return scope("settings.provisioning.cpe_detail.edit_windows")
		case strings.Contains(path, "/interface-metrics"):
			return scope("settings.provisioning.metrics.interface")
		case strings.Contains(path, "/parameter-polls"):
			return scope("settings.provisioning.metrics.polling")
		case strings.Contains(path, "/metrics"):
			if method == "DELETE" {
				return scope("settings.provisioning.metrics.general.metric")
			}
			return scope("settings.provisioning.metrics.general.metric", "settings.provisioning.metrics.general.health")
		case strings.Contains(path, "/features"):
			return scope("settings.provisioning.features")
		case strings.HasSuffix(path, "/cpe-info"):
			return scope("settings.provisioning.cpe_detail.info")
		case strings.Contains(path, "/lan-"):
			if method == "GET" {
				return scope("settings.provisioning.cpe_detail.lan", "inventory.cpes.overview")
			}
			return scope("settings.provisioning.cpe_detail.lan")
		case strings.HasSuffix(path, "/image") && method == "GET":
			return scope("settings.provisioning.templates", "settings.provisioning.rules", "settings.provisioning.variables", "settings.provisioning.features", "settings.provisioning.metrics.general", "settings.provisioning.metrics.general.metric", "settings.provisioning.metrics.general.health", "settings.provisioning.metrics.interface", "settings.provisioning.metrics.polling", "settings.provisioning.cpe_detail.lan", "settings.provisioning.cpe_detail.info", "inventory.cpes.overview", "inventory.cpes.features")
		default:
			if method == "PUT" {
				return scope("settings.provisioning.templates", "settings.provisioning.variables")
			}
			return scope("settings.provisioning.templates")
		}
	case strings.HasPrefix(path, "/provisioning/"):
		return scope("settings.provisioning.rules")
	case strings.HasPrefix(path, "/device/") || strings.HasPrefix(path, "/devices/") || strings.HasPrefix(path, "/v1/devices/"):
		switch {
		case strings.Contains(path, "/conn-credentials"):
			return scope("inventory.cpes.credentials")
		case strings.Contains(path, "/snapshots"):
			return scope("inventory.cpes.snapshots")
		case strings.HasSuffix(path, "/logs"):
			return scope("inventory.cpes.log")
		case strings.Contains(path, "/fault"):
			return scope("inventory.cpes.faults")
		case strings.Contains(path, "/task"):
			return scope("inventory.cpes.tasks", "inventory.cpes.tasks.requested", "inventory.cpes.tasks.result")
		case strings.Contains(path, "/metric"):
			return scope("inventory.cpes.metrics")
		case strings.Contains(path, "/features/"):
			return scope("inventory.cpes.features")
		case strings.Contains(path, "/wifi/") || strings.Contains(path, "/wan-interfaces/"):
			return scope("inventory.cpes.overview")
		case strings.HasSuffix(path, "/factory-reset"):
			return []string{"inventory.cpes.maintenance.diagnostic"}, "full", false
		case strings.HasSuffix(path, "/reboot") || strings.HasSuffix(path, "/download-firmware"):
			return scope("inventory.cpes.maintenance.diagnostic")
		case strings.HasSuffix(path, "/connection-request") || strings.HasSuffix(path, "/reachability"):
			return scope("inventory.cpes.overview", "inventory.cpes.maintenance.diagnostic")
		case strings.HasSuffix(path, "/get-parameters") || strings.HasSuffix(path, "/read"):
			return scope("inventory.cpes.maintenance.diagnostic", "inventory.cpes.overview")
		case strings.HasSuffix(path, "/set-parameters") || strings.HasSuffix(path, "/write"):
			return scope("inventory.cpes.overview", "inventory.cpes.maintenance.diagnostic")
		case strings.HasSuffix(path, "/parameters") || strings.HasSuffix(path, "/parameter-view"):
			return scope("inventory.cpes.maintenance.diagnostic")
		case strings.HasSuffix(path, "/detail-parameters"):
			return scope("inventory.cpes.overview", "inventory.cpes.hosts", "inventory.cpes.features")
		default:
			if method == "DELETE" {
				return scope("inventory.cpes")
			}
			return scope("inventory.cpes", "inventory.cpes.overview", "inventory.cpes.hosts", "inventory.cpes.metrics", "inventory.cpes.features", "inventory.cpes.snapshots", "inventory.cpes.tasks", "inventory.cpes.tasks.requested", "inventory.cpes.tasks.result", "inventory.cpes.faults", "inventory.cpes.credentials", "inventory.cpes.maintenance.diagnostic", "inventory.cpes.log")
		}
	}
	return nil, action, false
}
