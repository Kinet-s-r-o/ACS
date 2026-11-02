package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

func TestCreateDeviceRejectsInvalidInput(t *testing.T) {
	for _, body := range []string{
		`{}`, `{"serial_number":"  "}`, `{"serial_number":"BAD\nSERIAL"}`,
		`{"serial_number":"` + strings.Repeat("x", 129) + `"}`,
		`{"serial_number":"CPE","online":true}`, `{"serial_number":"CPE"} {}`,
		`{"serial_number":123}`, `{"serial_number":"CPE","tags":true}`,
	} {
		w := httptest.NewRecorder()
		(&Router{}).handleCreateDevice(w, httptest.NewRequest(http.MethodPost, "/devices", strings.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Errorf("invalid body returned %d", w.Code)
		}
	}
}

func TestCreateWaitingDevicePostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := db.AutoMigrate(&models.TagDefinition{}, &models.DeviceLifecycleEvent{}, &models.Fault{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&models.TagDefinition{ID: "branch", Name: "Branch", Color: "#123456"}).Error; err != nil {
		t.Fatal(err)
	}
	user := &models.User{Username: "factory-reset-authorizer", PasswordHash: "unused", Role: models.RoleRead}
	if err := db.Create(user).Error; err != nil {
		t.Fatal(err)
	}
	r := &Router{deviceRepo: database.NewDeviceRepository(db), tagRepo: database.NewTagRepository(db), userRepo: database.NewUserRepository(db), loginLimiter: newLoginLimiter(5, time.Minute)}
	create := auth.RequireAnyPermission(models.PermDevicesCreate, models.PermDevicesWrite)(r.handleCreateDevice)
	call := func(body string, permissions ...string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/devices", strings.NewReader(body))
		ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.Claims{UserID: user.ID, Role: models.RoleRead})
		ctx = context.WithValue(ctx, auth.PermissionsContextKey, permissions)
		w := httptest.NewRecorder()
		create(w, req.WithContext(ctx))
		return w
	}
	const body = `{"serial_number":" RESERVED-CPE ","tags":["branch","branch"]}`
	if w := call(body, models.PermDevicesRead); w.Code != http.StatusForbidden {
		t.Fatalf("read-only create returned %d", w.Code)
	}
	if w := call(`{"serial_number":"CPE","tags":["missing"]}`, models.PermDevicesCreate); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown tag returned %d", w.Code)
	}
	const automaticResetBody = `{"serial_number":"RESET-AUTH","tags":[],"factory_reset_on_first_inform":true}`
	if w := call(automaticResetBody, models.PermDevicesCreate); w.Code != http.StatusForbidden {
		t.Fatalf("automatic reset without reset permission returned %d", w.Code)
	}
	if w := call(automaticResetBody, models.PermDevicesCreate, models.PermDevicesReset); w.Code != http.StatusBadRequest {
		t.Fatalf("automatic reset without reauthentication returned %d", w.Code)
	}
	w := call(body, models.PermDevicesCreate)
	if w.Code != http.StatusCreated {
		t.Fatalf("create returned %d: %s", w.Code, w.Body.String())
	}
	var reserved models.Device
	if err := json.Unmarshal(w.Body.Bytes(), &reserved); err != nil {
		t.Fatal(err)
	}
	if reserved.SerialNumber != "RESERVED-CPE" || reserved.ID == 0 || reserved.Online || reserved.LastInform != nil || !reflect.DeepEqual(reserved.Tags, []string{"branch"}) {
		t.Fatal("incorrect waiting device")
	}
	if w := call(body, models.PermDevicesWrite); w.Code != http.StatusConflict {
		t.Fatalf("duplicate returned %d", w.Code)
	}
	stats, err := r.deviceRepo.GetStats(t.Context())
	if err != nil || stats.Total != 1 || stats.Waiting != 1 || stats.Offline != 0 {
		t.Fatalf("incorrect waiting stats: %+v, %v", stats, err)
	}
	assertStatus := func(status string, want int) {
		t.Helper()
		devices, total, err := r.deviceRepo.ListInventory(t.Context(), database.DeviceInventoryQuery{
			Sort: "status", Direction: "asc", Filters: map[string]database.DeviceInventoryColumnFilter{
				"status": {Logic: "all", Rules: []database.DeviceInventoryFilterRule{{Operator: "equals", Value: status}}},
			},
		})
		if err != nil || total != want || len(devices) != want {
			t.Fatalf("%s inventory: count %d, error %v", status, total, err)
		}
	}
	assertStatus("Waiting", 1)
	assertStatus("Offline", 0)
	beforeInform, err := r.deviceRepo.GetBySerial(t.Context(), reserved.SerialNumber)
	if err != nil || beforeInform == nil {
		t.Fatalf("get reserved device: %v", err)
	}
	manufacturer, productClass, ip := "Example", "Model", "192.0.2.10"
	inform := &models.Device{SerialNumber: reserved.SerialNumber, OUI: "001122", Manufacturer: &manufacturer, ProductClass: &productClass, IPAddress: &ip}
	recovered, err := r.deviceRepo.UpsertFromInformWithTransition(t.Context(), inform)
	if err != nil || recovered || inform.ID != reserved.ID {
		t.Fatalf("first Inform did not bind to reserved ID: recovered=%v, err=%v", recovered, err)
	}
	stored, err := r.deviceRepo.GetBySerial(t.Context(), reserved.SerialNumber)
	if err != nil || stored == nil {
		t.Fatalf("get device: %v", err)
	}
	if !stored.Online || stored.LastInform == nil || stored.OUI != "001122" || !reflect.DeepEqual(stored.Tags, reserved.Tags) || !stored.CreatedAt.Equal(beforeInform.CreatedAt) || stored.Manufacturer == nil || *stored.Manufacturer != manufacturer {
		t.Fatal("first Inform did not preserve tags/creation time or populate device identity")
	}
	assertStatus("Waiting", 0)
	assertStatus("Online", 1)
	if w := call(body, models.PermDevicesWrite); w.Code != http.StatusConflict {
		t.Fatalf("registered CPE could be overwritten: %d", w.Code)
	}
	if err := r.deviceRepo.SetOffline(t.Context(), reserved.SerialNumber); err != nil {
		t.Fatal(err)
	}
	assertStatus("Offline", 1)
	assertStatus("Waiting", 0)
	recovered, err = r.deviceRepo.UpsertFromInformWithTransition(t.Context(), &models.Device{SerialNumber: reserved.SerialNumber, OUI: "001122"})
	if err != nil || !recovered {
		t.Fatalf("subsequent Inform should recover offline CPE: %v", err)
	}
	var registered int64
	if err := db.Model(&models.DeviceLifecycleEvent{}).Where("device_id = ? AND event_type = ?", reserved.ID, models.DeviceLifecycleRegistered).Count(&registered).Error; err != nil || registered != 1 {
		t.Fatal("registration lifecycle event was duplicated")
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- call(`{"serial_number":"CONCURRENT-CPE","tags":[]}`, models.PermDevicesWrite).Code
		}()
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent registration returned %v", counts)
	}

	resetDevice, err := r.deviceRepo.CreateWaiting(t.Context(), "FIRST-RESET", []string{"branch"}, true)
	if err != nil || !resetDevice.FactoryResetOnFirstInform {
		t.Fatalf("arm automatic reset: %v", err)
	}
	olderTask, err := models.NewTaskWithPayload(resetDevice.ID, models.TaskTypeGetParameterValues, []string{"Device.Test.Parameter"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(olderTask).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := r.deviceRepo.UpsertFromInformWithTransition(t.Context(), &models.Device{SerialNumber: resetDevice.SerialNumber, OUI: "001122"}); err != nil {
		t.Fatal(err)
	}
	var automaticTasks []models.Task
	if err := db.Where("device_id = ? AND automatic_factory_reset = TRUE", resetDevice.ID).Find(&automaticTasks).Error; err != nil {
		t.Fatal(err)
	}
	if len(automaticTasks) != 1 || automaticTasks[0].Type != models.TaskTypeFactoryReset || automaticTasks[0].Status != models.TaskStatusPending {
		t.Fatalf("first Inform should queue one automatic reset: %+v", automaticTasks)
	}
	claimed, err := database.NewTaskRepository(db).ClaimNextPending(t.Context(), resetDevice.ID, []string{"1 BOOT"})
	if err != nil || claimed == nil || !claimed.AutomaticFactoryReset {
		t.Fatalf("automatic reset must precede older tasks in the first session: %+v, %v", claimed, err)
	}
	resetStored, err := r.deviceRepo.GetBySerial(t.Context(), resetDevice.SerialNumber)
	if err != nil || resetStored.FactoryResetOnFirstInform || !resetStored.Online {
		t.Fatalf("first Inform should consume reset option and set CPE online: %+v, %v", resetStored, err)
	}
	if _, err := r.deviceRepo.UpsertFromInformWithTransition(t.Context(), &models.Device{SerialNumber: resetDevice.SerialNumber, OUI: "001122"}); err != nil {
		t.Fatal(err)
	}
	var automaticCount int64
	if err := db.Model(&models.Task{}).Where("device_id = ? AND automatic_factory_reset = TRUE", resetDevice.ID).Count(&automaticCount).Error; err != nil || automaticCount != 1 {
		t.Fatalf("subsequent Inform queued a duplicate reset: %d, %v", automaticCount, err)
	}

	missedDevice, err := r.deviceRepo.CreateWaiting(t.Context(), "MISSED-RESET", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.deviceRepo.UpsertFromInformWithTransition(t.Context(), &models.Device{SerialNumber: missedDevice.SerialNumber, OUI: "001122"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.deviceRepo.UpsertFromInformWithTransition(t.Context(), &models.Device{SerialNumber: missedDevice.SerialNumber, OUI: "001122"}); err != nil {
		t.Fatal(err)
	}
	var missedTask models.Task
	if err := db.Where("device_id = ? AND automatic_factory_reset = TRUE", missedDevice.ID).First(&missedTask).Error; err != nil {
		t.Fatal(err)
	}
	if missedTask.Status != models.TaskStatusFailed {
		t.Fatalf("reset not dispatched in the first session should fail instead of retry: %s", missedTask.Status)
	}
}
