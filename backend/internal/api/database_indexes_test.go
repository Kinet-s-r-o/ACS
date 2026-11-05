package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/models"
)

func TestDatabaseIndexStrictPayload(t *testing.T) {
	for _, payload := range []string{
		`{"label":"Test","purpose":"Test parameter query","recipe":"gin","parameter_path":"Device.Test.Name"}`,
		`{"label":"Test","purpose":"Test parameter query","recipe":"parameter_presence","parameter_path":"Device.Test.Name","method":"gin"}`,
		`{"label":"Test","purpose":"Test parameter query","recipe":"parameter_presence","parameter_path":"Device.Test.Name","sql":"DROP TABLE devices"}`,
		`{"label":"Test","purpose":"Test parameter query","recipe":"devices_last_inform","parameter_path":"","include_columns":["value"]}`,
		`{"label":"Test","purpose":"Test parameter query","recipe":"parameters_device_latest","parameter_path":"","table_name":"users"}`,
		`{"label":"Test","purpose":"Test parameter query","recipe":"parameters_device_latest","parameter_path":"Device.Test.Name"}`,
		`{"label":"Test","purpose":"Test parameter query","recipe":"parameter_presence","parameter_path":"Device.Test.Name"} {}`,
		strings.Repeat("x", 5000),
	} {
		r := httptest.NewRequest("POST", "/settings/database/indexes", strings.NewReader(payload))
		w := httptest.NewRecorder()
		if _, ok := decodeIndexSpec(w, r); ok || w.Code != http.StatusBadRequest {
			t.Fatal("unsafe index payload accepted")
		}
	}
}

func TestDatabaseIndexFleetPayload(t *testing.T) {
	for _, recipe := range []string{"devices_last_inform", "parameters_device_latest"} {
		payload := fmt.Sprintf(`{"label":"Fleet index","purpose":"Accelerate Fleet distributions","recipe":%q,"parameter_path":""}`, recipe)
		r := httptest.NewRequest("POST", "/settings/database/indexes", strings.NewReader(payload))
		w := httptest.NewRecorder()
		if spec, ok := decodeIndexSpec(w, r); !ok || spec.Recipe != recipe || spec.ParameterPath != "" {
			t.Fatalf("approved Fleet payload rejected: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestDatabaseIndexPostgresPermissions(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&models.ManagedDatabaseIndex{}, &models.DatabaseIndexStorageProbe{}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FIRMWARE_UPLOAD_DIR", t.TempDir())
	t.Setenv("TEMPLATE_IMAGE_UPLOAD_DIR", t.TempDir())
	t.Setenv("ADMIN_WEB_ALLOWED_CIDRS", "")
	if err := auth.ConfigureJWT(strings.Repeat("index-test-jwt-", 3)); err != nil {
		t.Fatal(err)
	}
	r := NewRouter(db)
	handler := r.Handler()
	call := func(grants []string, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		role := models.Role{Name: fmt.Sprintf("index-role-%d", time.Now().UnixNano()), Permissions: grants}
		if err := db.Create(&role).Error; err != nil {
			t.Fatal(err)
		}
		user := models.User{Username: role.Name, PasswordHash: "unused", Role: models.RoleRead, RoleID: &role.ID, Active: true}
		if err := db.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
		token, err := auth.GenerateToken(&user)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token})
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "index-test-csrf"})
		req.Header.Set(csrfHeaderName, "index-test-csrf")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	path := "/settings/database/indexes"
	spec := `{"label":"Uptime","purpose":"Find recent uptime values","recipe":"parameter_freshness","parameter_path":"InternetGatewayDevice.DeviceInfo.UpTime"}`
	for _, grants := range [][]string{{models.PermissionKey("settings.database", "full")}, {models.PermissionKey("settings.database.indexes", "read")}, {models.PermissionKey("settings.database.indexes", "edit")}} {
		for _, op := range []struct{ method, path string }{{"POST", path}, {"POST", path + "/preview"}, {"PUT", path + "/1"}, {"DELETE", path + "/1"}, {"POST", path + "/1/cancel"}} {
			w := call(grants, op.method, op.path, spec)
			if w.Code != http.StatusForbidden {
				t.Fatalf("%s %s allowed without both grants: %d %s", op.method, op.path, w.Code, w.Body.String())
			}
		}
	}
	w := call([]string{models.PermissionKey("settings.database.indexes", "read")}, "GET", path, "")
	if w.Code != 200 {
		t.Fatalf("read-only index inspection failed: %d %s", w.Code, w.Body.String())
	}
	grants := []string{models.PermissionKey("settings.database.indexes", "read"), models.PermissionKey("settings.database.indexes", "edit"), models.PermissionKey("settings.database.indexes", "delete")}
	w = call(grants, "POST", path, spec)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing disk probe bypassed: %d %s", w.Code, w.Body.String())
	}
	if err := db.Create(&models.DatabaseIndexStorageProbe{ID: 1, TotalBytes: 100 << 30, FreeBytes: 90 << 30, MeasuredAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	w = call(grants, "POST", path, spec)
	if w.Code != http.StatusAccepted {
		t.Fatalf("valid create failed: %d %s", w.Code, w.Body.String())
	}
	var m models.ManagedDatabaseIndex
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m.ID <= 0 || m.Status != "queued" {
		t.Fatal("index was not queued")
	}
	if strings.Contains(w.Body.String(), "candidate_token") || strings.Contains(w.Body.String(), "active_token") {
		t.Fatal("internal ownership tokens exposed")
	}
	w = call(grants, "DELETE", path+"/999999", "")
	if w.Code != http.StatusNotFound {
		t.Fatal("external catalog OID treated as managed definition")
	}
	var count int64
	if err := db.Model(&models.AuditLog{}).Where("resource = ? AND status = ?", path, 202).Count(&count).Error; err != nil || count == 0 {
		t.Fatalf("index mutation was not audited: %v", err)
	}
}
