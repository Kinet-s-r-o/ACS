package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func integrationTestDatabase(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration API PostgreSQL test")
	}
	base, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("could not connect to test PostgreSQL")
	}
	schema := fmt.Sprintf("api_test_%d", time.Now().UnixNano())
	if err := base.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = base.Exec("DROP SCHEMA " + schema + " CASCADE").Error
		sqlDB, _ := base.DB()
		_ = sqlDB.Close()
	})
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := gorm.Open(postgres.Open(parsed.String()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("could not open isolated test schema")
	}
	t.Cleanup(func() { sqlDB, _ := db.DB(); _ = sqlDB.Close() })
	if err := db.AutoMigrate(&models.User{}, &models.Role{}, &models.APIToken{}, &models.Device{}, &models.DeviceParameter{}, &models.Task{}, &models.AuditLog{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestDeviceDetailParametersPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&models.ProvisioningTemplate{}, &models.MetricDefinition{}); err != nil {
		t.Fatal(err)
	}
	manufacturer, productClass := "Huawei", "Model"
	device := &models.Device{SerialNumber: "DETAIL-TEST", OUI: "000000", Manufacturer: &manufacturer, ProductClass: &productClass}
	if err := db.Create(device).Error; err != nil {
		t.Fatal(err)
	}
	template := &models.ProvisioningTemplate{Manufacturer: manufacturer, ProductClass: productClass, Name: "Detail template", Features: []models.ProvisioningFeature{{ID: "feature", Name: "Feature", Controls: []models.ProvisioningFeatureControl{{Key: "mode", Type: "string", Parameter: "Device.X_HW_Feature.Mode"}, {Key: "object", Type: "object", Parameter: "Device.X_HW_Feature.Object."}}}}}
	if err := db.Create(template).Error; err != nil {
		t.Fatal(err)
	}
	for _, def := range []models.MetricDefinition{
		{TemplateID: &template.ID, Name: "Optical", ParameterName: "Device.X_HW_Optical.RXPower", Active: true},
		{TemplateID: &template.ID, Name: "Interface", ParameterPattern: "Device.X_HW_Interface.*.Bytes", Active: true},
	} {
		if err := db.Create(&def).Error; err != nil {
			t.Fatal(err)
		}
	}
	expected := []string{
		"InternetGatewayDevice.DeviceInfo.UpTime",
		"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID",
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ConnectionStatus",
		"Device.X_HW_Optical.RXPower",
		"Device.X_HW_Interface.1.Bytes",
		"Device.X_HW_Feature.Mode",
		"Device.X_HW_Feature.Object.1.Status",
	}
	for _, name := range append(expected, "Device.Unused.Value") {
		if err := db.Create(&models.DeviceParameter{DeviceID: device.ID, Name: name, Value: "sample"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	r := NewRouter(db)
	request := httptest.NewRequest(http.MethodGet, "/device/DETAIL-TEST/detail-parameters", nil)
	request.SetPathValue("serial", device.SerialNumber)
	response := httptest.NewRecorder()
	r.handleGetDeviceDetailParametersBySerial(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("detail parameter status: %d: %s", response.Code, response.Body.String())
	}
	var params []models.DeviceParameter
	if err := json.Unmarshal(response.Body.Bytes(), &params); err != nil {
		t.Fatal(err)
	}
	got := make(map[string]bool, len(params))
	for _, param := range params {
		got[param.Name] = true
	}
	for _, name := range expected {
		if !got[name] {
			t.Errorf("missing detail parameter %s", name)
		}
	}
	if got["Device.Unused.Value"] {
		t.Error("unrelated parameter was loaded")
	}

	request = httptest.NewRequest(http.MethodGet, "/device/DETAIL-TEST/parameter-view?prefix=Device.X_HW_Feature.", nil)
	request.SetPathValue("serial", device.SerialNumber)
	response = httptest.NewRecorder()
	r.handleGetDeviceParameterViewBySerial(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("underscore prefix status: %d: %s", response.Code, response.Body.String())
	}
}

func TestIntegrationAPIPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	t.Setenv("FIRMWARE_UPLOAD_DIR", t.TempDir())
	t.Setenv("TEMPLATE_IMAGE_UPLOAD_DIR", t.TempDir())
	t.Setenv("ADMIN_WEB_ALLOWED_CIDRS", "")
	if err := auth.ConfigureJWT(strings.Repeat("test-only-jwt-", 3)); err != nil {
		t.Fatal(err)
	}
	if err := database.ConfigureParameterEncryption(strings.Repeat("test-only-key-", 3)); err != nil {
		t.Fatal(err)
	}
	role := &models.Role{Name: "integration", Permissions: []string{models.PermDevicesRead, models.PermDevicesWrite}}
	if err := db.Create(role).Error; err != nil {
		t.Fatal(err)
	}
	owner := &models.User{Username: "billing-test", PasswordHash: "unused", Role: models.RoleRead, RoleID: &role.ID}
	admin := &models.User{Username: "admin-test", PasswordHash: "unused", Role: models.RoleFull}
	device := &models.Device{SerialNumber: "TEST-SERIAL", OUI: "000000"}
	for _, item := range []any{owner, admin, device} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"Device.Test.A", "Device.Test.B", "Device.Test.Secret"} {
		value := "sample"
		if database.IsSensitiveParameterName(name) {
			var err error
			value, err = database.EncryptProvisioningValue(value)
			if err != nil {
				t.Fatal(err)
			}
		}
		if err := db.Create(&models.DeviceParameter{DeviceID: device.ID, Name: name, Value: value}).Error; err != nil {
			t.Fatal(err)
		}
	}
	r := NewRouter(db)
	handler := r.Handler()
	jwt, err := auth.GenerateToken(admin)
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, bearer, key string, session bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		if session {
			req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: jwt})
			req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "test-csrf"})
			req.Header.Set(csrfHeaderName, "test-csrf")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	assertCode := func(w *httptest.ResponseRecorder, code int) {
		t.Helper()
		if w.Code != code {
			t.Fatalf("response status %d; want %d", w.Code, code)
		}
	}
	managementPath := fmt.Sprintf("/users/%d/api-tokens", owner.ID)
	created := call("POST", managementPath, `{"name":"Billing test"}`, "", "", true)
	assertCode(created, 201)
	var credential struct {
		models.APIToken
		Token string `json:"token"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &credential); err != nil {
		t.Fatal(err)
	}
	if credential.Token == "" {
		t.Fatal("no one-time credential")
	}
	listed := call("GET", managementPath, "", "", "", true)
	assertCode(listed, 200)
	if strings.Contains(listed.Body.String(), credential.Token) || strings.Contains(listed.Body.String(), "digest") {
		t.Fatal("list exposed credential material")
	}
	assertCode(call("GET", "/v1/me", "", "", "", true), 401)
	assertCode(call("GET", managementPath, "", credential.Token, "", false), 401)
	assertCode(call("POST", managementPath, `{"name":"unauthorized"}`, credential.Token, "", false), 403)
	assertCode(call("GET", "/v1/me", "", credential.Token, "", false), 200)
	adminJWT := jwt
	jwt, err = auth.GenerateToken(owner)
	if err != nil {
		t.Fatal(err)
	}
	assertCode(call("POST", managementPath, `{"name":"must-not-create"}`, "", "", true), 403)
	jwt = adminJWT
	basePath := "/v1/devices/TEST-SERIAL"
	assertCode(call("GET", "/v1/devices/missing", "", credential.Token, "", false), 404)
	parameters := call("GET", basePath+"/parameters?limit=1", "", credential.Token, "", false)
	assertCode(parameters, 200)
	var page struct {
		Items  []models.DeviceParameter `json:"items"`
		Cursor string                   `json:"next_cursor"`
	}
	if err := json.Unmarshal(parameters.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Cursor != "Device.Test.A" {
		t.Fatal("incorrect first parameter page")
	}
	parameters = call("GET", basePath+"/parameters?cursor="+url.QueryEscape(page.Cursor), "", credential.Token, "", false)
	if err := json.Unmarshal(parameters.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[1].Value != "[REDACTED]" || page.Cursor != "" {
		t.Fatal("pagination or secret redaction failed")
	}
	const writeBody = `{"parameters":{"Device.Test.Password":"synthetic-value","Device.Test.A":"updated"}}`
	readResponse := call("POST", basePath+"/read", `{"parameters":["Device.Test.A"]}`, credential.Token, "read-request", false)
	assertCode(readResponse, 202)
	var readTask models.Task
	if err := json.Unmarshal(readResponse.Body.Bytes(), &readTask); err != nil {
		t.Fatal(err)
	}
	if readResponse.Header().Get("Location") != "tasks/"+strconv.FormatInt(readTask.ID, 10) {
		t.Fatal("task Location must preserve proxy path prefixes")
	}
	if err := r.taskRepo.UpdateStatus(t.Context(), readTask.ID, models.TaskStatusCompleted, map[string]string{"Device.Test.A": "fresh", "Device.Test.Password": "synthetic-value"}, ""); err != nil {
		t.Fatal(err)
	}
	readDetail := call("GET", basePath+"/tasks/"+strconv.FormatInt(readTask.ID, 10), "", credential.Token, "", false)
	assertCode(readDetail, 200)
	if !strings.Contains(readDetail.Body.String(), "fresh") || strings.Contains(readDetail.Body.String(), "synthetic-value") {
		t.Fatal("read task result missing or not redacted")
	}
	if err := db.Model(&models.DeviceParameter{}).Where("device_id = ? AND name = ?", device.ID, "Device.Test.B").Update("writable", false).Error; err != nil {
		t.Fatal(err)
	}
	assertCode(call("POST", basePath+"/write", `{"parameters":{"Device.Test.B":"changed"}}`, credential.Token, "readonly-request", false), 400)
	results := make(chan *httptest.ResponseRecorder, 4)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- call("POST", basePath+"/write", writeBody, credential.Token, "same-request", false)
		}()
	}
	wg.Wait()
	close(results)
	var taskID int64
	newTasks := 0
	for response := range results {
		if response.Code != 200 && response.Code != 202 {
			t.Fatalf("concurrent write status %d", response.Code)
		}
		if response.Code == 202 {
			newTasks++
		}
		var task models.Task
		if err := json.Unmarshal(response.Body.Bytes(), &task); err != nil {
			t.Fatal(err)
		}
		if taskID != 0 && task.ID != taskID {
			t.Fatal("retry created another task")
		}
		taskID = task.ID
		if strings.Contains(response.Body.String(), "synthetic-value") {
			t.Fatal("acknowledgement exposed write secret")
		}
	}
	if newTasks != 1 {
		t.Fatalf("created %d tasks, want one", newTasks)
	}
	var stored models.Task
	if err := db.First(&stored, taskID).Error; err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored.Payload), "synthetic-value") || !strings.Contains(string(stored.Payload), "enc:v1:") {
		t.Fatal("stored task secret is not encrypted")
	}
	assertCode(call("POST", basePath+"/write", `{"parameters":{"Device.Test.A":"different"}}`, credential.Token, "same-request", false), 409)
	assertCode(call("GET", "/v1/devices/OTHER/tasks/"+strconv.FormatInt(taskID, 10), "", credential.Token, "", false), 404)
	taskPath := basePath + "/tasks/" + strconv.FormatInt(taskID, 10)
	detail := call("GET", taskPath, "", credential.Token, "", false)
	assertCode(detail, 200)
	if strings.Contains(detail.Body.String(), "synthetic-value") || strings.Contains(detail.Body.String(), "enc:v1:") {
		t.Fatal("task detail leaked secret")
	}
	if err := db.Model(role).Update("permissions", models.JSON(`[]`)).Error; err != nil {
		t.Fatal(err)
	}
	assertCode(call("GET", basePath+"/parameters", "", credential.Token, "", false), 403)
	assertCode(call("POST", basePath+"/write", writeBody, credential.Token, "another-request", false), 403)
	if err := db.Model(role).Update("permissions", models.JSON(`["devices.read"]`)).Error; err != nil {
		t.Fatal(err)
	}
	assertCode(call("GET", basePath+"/parameters", "", credential.Token, "", false), 200)
	assertCode(call("POST", basePath+"/read", `{"parameters":["Device.Test.A"]}`, credential.Token, "", false), 403)
	assertCode(call("DELETE", fmt.Sprintf("/users/%d/api-tokens/%d", admin.ID, credential.ID), "", "", "", true), 404)
	assertCode(call("DELETE", managementPath+"/"+strconv.FormatInt(credential.ID, 10), "", "", "", true), 200)
	assertCode(call("GET", "/v1/me", "", credential.Token, "", false), 401)
	var auditCount int64
	if err := db.Model(&models.AuditLog{}).Where("api_token_id = ? AND api_token_name = ?", credential.ID, "Billing test").Count(&auditCount).Error; err != nil || auditCount < 1 {
		t.Fatal("integration audit attribution missing")
	}
}
