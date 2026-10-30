package database

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

func TestBuildWANInterfaceRecords(t *testing.T) {
	first := "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1."
	second := "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1."
	rows := buildWANInterfaceRecords(7, []models.DeviceParameter{
		{Name: first + "Name", Value: "Internet"},
		{Name: first + "IPAddress", Value: "192.0.2.1"},
		{Name: first + "ExternalIPAddress", Value: "198.51.100.2"},
		{Name: first + "ConnectionStatus", Value: "Connected"},
		{Name: second + "MACAddress", Value: "aa:bb:cc:dd:ee:ff"},
		{Name: "InternetGatewayDevice.LANDevice.1.Name", Value: "ignored"},
	})
	if len(rows) != 2 {
		t.Fatalf("got %d WAN rows, want 2", len(rows))
	}
	if rows[0].DeviceID != 7 || rows[0].Path != first || rows[0].Name != "Internet" || rows[0].IPAddress != "198.51.100.2" || rows[0].Status != "Connected" {
		t.Fatalf("unexpected first WAN row: %+v", rows[0])
	}
	if rows[1].Path != second || rows[1].Name != second || rows[1].MACAddress != "aa:bb:cc:dd:ee:ff" || rows[1].IPAddress != "-" {
		t.Fatalf("unexpected second WAN row: %+v", rows[1])
	}
}

func TestListWANInterfacesPageFromCache(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Device{}, &models.WANInterfaceRecord{}); err != nil {
		t.Fatal(err)
	}
	serial := fmt.Sprintf("wan-cache-test-%d", time.Now().UnixNano())
	device := models.Device{SerialNumber: serial, OUI: "00:00:03"}
	if err := db.Create(&device).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.Where("device_id = ?", device.ID).Delete(&models.WANInterfaceRecord{})
		_ = db.Delete(&device)
	})
	for _, name := range []string{"C", "A", "B"} {
		if err := db.Create(&models.WANInterfaceRecord{DeviceID: device.ID, Path: name, Name: name, Status: "Connected", Type: "IP", IPAddress: "-", MACAddress: "-"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	filters := map[string]TableColumnFilter{"serial_number": {Logic: "all", Rules: []TableFilterRule{{Operator: "equals", Value: serial}}}}
	repo := NewDeviceRepository(db)
	first, total, err := repo.ListWANInterfacesPage(context.Background(), 2, 0, "", "name", "asc", filters)
	if err != nil || total != 3 || len(first) != 2 || first[0].Name != "A" || first[1].Name != "B" {
		t.Fatalf("first page: rows=%+v total=%d error=%v", first, total, err)
	}
	second, total, err := repo.ListWANInterfacesPage(context.Background(), 2, 2, "", "name", "asc", filters)
	if err != nil || total != 3 || len(second) != 1 || second[0].Name != "C" {
		t.Fatalf("second page: rows=%+v total=%d error=%v", second, total, err)
	}
}
