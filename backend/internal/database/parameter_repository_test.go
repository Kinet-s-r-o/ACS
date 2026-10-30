package database

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

func TestSensitiveParameterEncryptionRoundTrip(t *testing.T) {
	if err := ConfigureParameterEncryption("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	encrypted, err := encryptParameterValue("subscriber-secret")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == "subscriber-secret" {
		t.Fatal("sensitive value was stored as plaintext")
	}
	decrypted, err := decryptParameterValue(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted != "subscriber-secret" {
		t.Fatalf("unexpected decrypted value %q", decrypted)
	}
}

func TestSensitiveSetTaskPayloadEncryptedAndRedacted(t *testing.T) {
	if err := ConfigureParameterEncryption("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	task, err := models.NewTaskWithPayload(1, models.TaskTypeSetParameterValues, map[string]string{
		"Device.WiFi.AccessPoint.1.Security.KeyPassphrase": "wifi-secret",
		"Device.WiFi.SSID.1.SSID":                          "Office",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := encryptSetTaskPayload(task); err != nil {
		t.Fatal(err)
	}
	if string(task.Payload) == "" || string(task.Payload) == "wifi-secret" {
		t.Fatal("task payload was not encoded")
	}
	var stored map[string]string
	if err := json.Unmarshal(task.Payload, &stored); err != nil {
		t.Fatal(err)
	}
	if stored["Device.WiFi.AccessPoint.1.Security.KeyPassphrase"] == "wifi-secret" {
		t.Fatal("sensitive task value remained plaintext")
	}
	if err := decryptSetTaskPayload(task); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(task.Payload, &stored); err != nil || stored["Device.WiFi.AccessPoint.1.Security.KeyPassphrase"] != "wifi-secret" {
		t.Fatal("task payload did not decrypt for dispatch")
	}
	redactSetTaskPayload(task)
	if err := json.Unmarshal(task.Payload, &stored); err != nil || stored["Device.WiFi.AccessPoint.1.Security.KeyPassphrase"] != "[REDACTED]" {
		t.Fatal("task payload was not redacted for API history")
	}
}

func TestSensitiveProvisioningValueDecryptsForDispatch(t *testing.T) {
	if err := ConfigureParameterEncryption("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	encrypted, err := encryptParameterValue("wifi-secret")
	if err != nil {
		t.Fatal(err)
	}
	rules := []*models.ProvisioningRule{{ID: 1, ParameterName: "Device.WiFi.AccessPoint.1.Security.KeyPassphrase", ParameterValue: encrypted}}
	if err := decryptProvisioningRules(rules); err != nil {
		t.Fatal(err)
	}
	if rules[0].ParameterValue != "wifi-secret" {
		t.Fatal("sensitive provisioning value was not decrypted")
	}
}

func TestSensitiveParameterDetection(t *testing.T) {
	for _, name := range []string{"Device.WiFi.AccessPoint.1.Security.KeyPassphrase", "InternetGatewayDevice.WANPPPConnection.1.Password", "Device.Users.User.1.Username"} {
		if !IsSensitiveParameterName(name) {
			t.Fatalf("sensitive parameter %q was not detected", name)
		}
	}
	if IsSensitiveParameterName("Device.DeviceInfo.UpTime") {
		t.Fatal("non-sensitive telemetry was classified as sensitive")
	}
}

func TestOverviewParameterSelection(t *testing.T) {
	for _, name := range []string{
		"InternetGatewayDevice.DeviceInfo.UpTime",
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress",
		"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID",
		"InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.Status",
		"InternetGatewayDevice.LANDevice.1.Hosts.Host.1.MACAddress",
		"Device.WiFi.SSID.1.SSID",
	} {
		if !isOverviewName(name) {
			t.Errorf("overview parameter omitted: %s", name)
		}
	}
	for _, name := range []string{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", "Device.DeviceInfo.SerialNumber"} {
		if isOverviewName(name) {
			t.Errorf("unnecessary or sensitive parameter selected: %s", name)
		}
	}
}

func TestOverviewSelectionKeepsWanAndLanWhenHostsAreNumerous(t *testing.T) {
	var names []string
	for i := 1; i <= 300; i++ {
		names = append(names, fmt.Sprintf("InternetGatewayDevice.LANDevice.1.Hosts.Host.%d.MACAddress", i))
	}
	wan := "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress"
	lan := "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID"
	names = append(names, wan, lan)
	selected := selectOverviewNames(names)
	if len(selected) != 256 || !slices.Contains(selected, wan) || !slices.Contains(selected, lan) {
		t.Fatalf("overview selection omitted key data: count=%d", len(selected))
	}
}

func TestDeleteStaleRemovesMissingParameters(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Device{}, &models.DeviceParameter{}, &models.WANInterfaceRecord{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	ctx := context.Background()

	serial := fmt.Sprintf("test-stale-%d", time.Now().UnixNano())
	device := &models.Device{SerialNumber: serial, OUI: "00:00:03"}
	if err := db.Create(device).Error; err != nil {
		t.Fatalf("create device: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Where("device_id = ?", device.ID).Delete(&models.DeviceParameter{})
		_ = db.Where("device_id = ?", device.ID).Delete(&models.WANInterfaceRecord{})
		_ = db.Delete(&models.Device{}, device.ID)
	})

	repo := NewParameterRepository(db)

	// Simulate a full-tree fetch with 3 WAN connections.
	initialParams := []models.DeviceParameter{
		{DeviceID: device.ID, Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Name", Value: "WAN1"},
		{DeviceID: device.ID, Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.Name", Value: "WAN2"},
		{DeviceID: device.ID, Name: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1.Name", Value: "WAN3"},
	}
	if err := repo.UpsertMany(ctx, device.ID, initialParams); err != nil {
		t.Fatalf("UpsertMany: %v", err)
	}
	var cached int64
	if err := db.Model(&models.WANInterfaceRecord{}).Where("device_id = ?", device.ID).Count(&cached).Error; err != nil || cached != 3 {
		t.Fatalf("cached WAN rows after upsert: count=%d error=%v", cached, err)
	}

	// Verify all 3 are present.
	all, err := repo.GetByDeviceID(ctx, device.ID)
	if err != nil {
		t.Fatalf("GetByDeviceID: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 params, got %d", len(all))
	}

	// Simulate a second full-tree fetch where WAN3 was deleted on the CPE.
	// Only WAN1 and WAN2 are reported.
	currentNames := []string{
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Name",
		"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.Name",
	}
	if err := repo.DeleteStale(ctx, device.ID, currentNames); err != nil {
		t.Fatalf("DeleteStale: %v", err)
	}

	// Verify WAN3 is gone, WAN1 and WAN2 remain.
	remaining, err := repo.GetByDeviceID(ctx, device.ID)
	if err != nil {
		t.Fatalf("GetByDeviceID after delete: %v", err)
	}
	if len(remaining) != 2 {
		t.Fatalf("expected 2 params after DeleteStale, got %d", len(remaining))
	}
	for _, p := range remaining {
		if p.Name == "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1.Name" {
			t.Fatal("stale WAN3 parameter was not deleted")
		}
	}
	if err := db.Model(&models.WANInterfaceRecord{}).Where("device_id = ?", device.ID).Count(&cached).Error; err != nil || cached != 2 {
		t.Fatalf("cached WAN rows after deletion: count=%d error=%v", cached, err)
	}
}

func TestPartialInformKeepsUnreportedParameters(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Device{}, &models.DeviceParameter{}, &models.WANInterfaceRecord{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	ctx := context.Background()

	serial := fmt.Sprintf("test-partial-%d", time.Now().UnixNano())
	device := &models.Device{SerialNumber: serial, OUI: "00:00:03"}
	if err := db.Create(device).Error; err != nil {
		t.Fatalf("create device: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Where("device_id = ?", device.ID).Delete(&models.DeviceParameter{})
		_ = db.Where("device_id = ?", device.ID).Delete(&models.WANInterfaceRecord{})
		_ = db.Delete(&models.Device{}, device.ID)
	})

	repo := NewParameterRepository(db)

	// A WAN connection with several leaf parameters.
	const obj = "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1"
	initialParams := []models.DeviceParameter{
		{DeviceID: device.ID, Name: obj + ".Name", Value: "WAN1"},
		{DeviceID: device.ID, Name: obj + ".Enable", Value: "1"},
		{DeviceID: device.ID, Name: obj + ".ConnectionStatus", Value: "Connected"},
		{DeviceID: device.ID, Name: obj + ".ExternalIPAddress", Value: "10.160.60.4"},
	}
	if err := repo.UpsertMany(ctx, device.ID, initialParams); err != nil {
		t.Fatalf("UpsertMany: %v", err)
	}

	// A partial Inform that reports only Name and ExternalIPAddress, omitting
	// Enable and ConnectionStatus. The object is still present, so none of its
	// parameters may be purged.
	partial := []models.DeviceParameter{
		{Name: obj + ".Name", Value: "WAN1 updated"},
		{Name: obj + ".ExternalIPAddress", Value: "10.160.60.5"},
	}
	if err := repo.SaveInformParameters(ctx, device.ID, partial); err != nil {
		t.Fatalf("SaveInformParameters: %v", err)
	}

	remaining, err := repo.GetByDeviceID(ctx, device.ID)
	if err != nil {
		t.Fatalf("GetByDeviceID after delete: %v", err)
	}
	if len(remaining) != 4 {
		t.Fatalf("expected 4 params after partial Inform, got %d", len(remaining))
	}
	for _, name := range []string{".Enable", ".ConnectionStatus"} {
		found := false
		for _, p := range remaining {
			if p.Name == obj+name {
				found = true
			}
		}
		if !found {
			t.Fatalf("partial Inform wiped still-present parameter %s", obj+name)
		}
	}
}

func TestDeleteStaleEmptyListIsNoop(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Device{}, &models.DeviceParameter{}, &models.WANInterfaceRecord{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	ctx := context.Background()

	serial := fmt.Sprintf("test-stale-empty-%d", time.Now().UnixNano())
	device := &models.Device{SerialNumber: serial, OUI: "00:00:04"}
	if err := db.Create(device).Error; err != nil {
		t.Fatalf("create device: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Where("device_id = ?", device.ID).Delete(&models.DeviceParameter{})
		_ = db.Where("device_id = ?", device.ID).Delete(&models.WANInterfaceRecord{})
		_ = db.Delete(&models.Device{}, device.ID)
	})

	repo := NewParameterRepository(db)
	params := []models.DeviceParameter{
		{DeviceID: device.ID, Name: "Device.DeviceInfo.SoftwareVersion", Value: "1.0"},
	}
	if err := repo.UpsertMany(ctx, device.ID, params); err != nil {
		t.Fatalf("UpsertMany: %v", err)
	}

	// Empty currentNames must not delete anything (safety guard).
	if err := repo.DeleteStale(ctx, device.ID, nil); err != nil {
		t.Fatalf("DeleteStale(nil): %v", err)
	}
	remaining, err := repo.GetByDeviceID(ctx, device.ID)
	if err != nil {
		t.Fatalf("GetByDeviceID: %v", err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected 1 param (no-op), got %d", len(remaining))
	}
}
