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
	if err := database.EnsureDeviceInventoryParameterIndex(context.Background(), db); err != nil {
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
		{DeviceID: 1, Name: "InternetGatewayDevice.DeviceInfo.UpTime", Value: "300", UpdatedAt: now},
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

	router := &Router{deviceRepo: repo}
	for _, tc := range []struct {
		pattern string
		max     float64
		low     int
		high    int
		missing int
	}{
		{"Device.*uptime", 100, 1, 1, 1},
		{"InternetGatewayDevice.DeviceInfo.UpTime", 350, 1, 0, 2},
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
