package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

func TestFleetAnalyticsPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	if err := database.EnsureAnalyticsParameterIndex(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	old := now.Add(-time.Hour)
	for _, d := range []models.Device{
		{ID: 1, SerialNumber: "FLEET-1", OUI: "000000", LastInform: &now},
		{ID: 2, SerialNumber: "FLEET-2", OUI: "000000", LastInform: &old},
		{ID: 3, SerialNumber: "FLEET-3", OUI: "000000"},
	} {
		if err := db.Create(&d).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []models.DeviceParameter{
		{DeviceID: 1, Name: "Device.A.UpTime", Value: " 100 ", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.B.UpTime", Value: "200", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.Old.UpTime", Value: "10", UpdatedAt: old},
		{DeviceID: 1, Name: "Device.Invalid.UpTime", Value: "not a number", UpdatedAt: now.Add(time.Minute)},
		{DeviceID: 1, Name: "Device.Overflow.UpTime", Value: "1e999", UpdatedAt: now.Add(time.Minute)},
		{DeviceID: 1, Name: "Device.Temperature", Value: "2560", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.RxPower", Value: "100", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.PONMode", Value: "GPON", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.WLAN.1.TotalAssociations", Value: "3", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.WLAN.2.AssociatedDeviceNumberOfEntries", Value: "4", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.WLAN.3.TotalAssociations", Value: "invalid", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.WLAN.4.TotalAssociations", Value: "99999999999999999999", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.Secret.Numeric", Value: "123", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.X_Test.Value", Value: "12", UpdatedAt: now},
		{DeviceID: 1, Name: "Device.XATest.Value", Value: "22", UpdatedAt: now.Add(time.Minute)},
		{DeviceID: 3, Name: "Device.UpTime", Value: "999", UpdatedAt: now},
	} {
		if err := db.Create(&p).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := database.NewDeviceRepository(db)
	devices, total, err := repo.ListForAnalytics(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 || len(devices) != 2 {
		t.Fatalf("sample=%d total=%d", len(devices), total)
	}
	var populated, missing int
	for _, d := range devices {
		if d.Uptime == nil {
			missing++
			if d.WifiStations != 0 || d.Temperature != nil || d.AccessType != nil {
				t.Fatalf("missing device received parameter values: %+v", d)
			}
			continue
		}
		populated++
		if strings.TrimSpace(*d.Uptime) != "100" || d.Temperature == nil || *d.Temperature != "2560" || d.RxPowerValue == nil || *d.RxPowerValue != "100" || d.AccessType == nil || *d.AccessType != "GPON" || d.WifiStations != 7 {
			t.Fatalf("wrong latest values or station sum: %+v", d)
		}
	}
	if populated != 1 || missing != 1 {
		t.Fatalf("populated=%d missing=%d", populated, missing)
	}
	router := &Router{deviceRepo: repo}
	for _, tc := range []struct {
		pattern string
		max     float64
		low     int
		high    int
		missing int
	}{
		{"Device.*uptime", 100, 1, 1, 1},
		{"Device.*Temp*", 10, 1, 0, 2},
		{"Device.*RxPower", -19, 1, 0, 2},
		{"Device.*Secret*", 1000, 0, 0, 3},
		{"Device.X_Test.*", 15, 1, 0, 2},
	} {
		t.Run(tc.pattern, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{"parameter_pattern": tc.pattern, "thresholds": []map[string]any{{"label": "low", "max": tc.max}, {"label": "high", "max": nil}}})
			response := httptest.NewRecorder()
			router.handleDeviceParameterDistribution(response, httptest.NewRequest(http.MethodPost, "/devices/analytics/distribution", strings.NewReader(string(body))))
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var result struct {
				Distribution map[string]int `json:"distribution"`
				Sampled      int            `json:"sampled"`
				Total        int            `json:"total"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Total != 3 || result.Sampled != 3 || result.Distribution["low"] != tc.low || result.Distribution["high"] != tc.high || result.Distribution["N/A"] != tc.missing {
				t.Fatalf("incorrect distribution: %+v", result)
			}
		})
	}
}

func TestFleetParameterSearchIndexPostgres(t *testing.T) {
	db := integrationTestDatabase(t)
	// The extension may already live outside the application's search_path.
	if err := db.Exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.EnsureAnalyticsParameterIndex(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var originalOID int64
	if err := db.Raw(`SELECT 'idx_device_parameters_name_trgm'::regclass::oid`).Scan(&originalOID).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.EnsureAnalyticsParameterIndex(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var currentOID int64
	if err := db.Raw(`SELECT 'idx_device_parameters_name_trgm'::regclass::oid`).Scan(&currentOID).Error; err != nil {
		t.Fatal(err)
	}
	if originalOID != currentOID {
		t.Fatal("startup rebuilt an already valid search index")
	}
	device := models.Device{SerialNumber: "INDEX-RECOVERY", OUI: "000000"}
	if err := db.Create(&device).Error; err != nil {
		t.Fatal(err)
	}
	params := []models.DeviceParameter{{DeviceID: device.ID, Name: "Device.Temperature", Value: "40"}, {DeviceID: device.ID, Name: "Device.UpTime", Value: "100"}}
	if err := db.Create(&params).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`DROP INDEX idx_device_parameters_name_trgm`).Error; err != nil {
		t.Fatal(err)
	}
	// A failed concurrent build leaves the same invalid catalog state as interruption.
	if err := db.Exec(`CREATE UNIQUE INDEX CONCURRENTLY idx_device_parameters_name_trgm ON device_parameters (device_id)`).Error; err == nil {
		t.Fatal("expected duplicate device IDs to fail the concurrent unique index build")
	}
	if err := database.EnsureAnalyticsParameterIndex(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var ready bool
	if err := db.Raw(`SELECT i.indisvalid AND am.amname = 'gin'
		FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
		WHERE i.indexrelid = 'idx_device_parameters_name_trgm'::regclass`).Scan(&ready).Error; err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("failed concurrent index was not replaced with a valid GIN search index")
	}
}
