package database

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

func TestMetricGPVPollIntervalPersistsAcrossSessions(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.MetricDefinition{}, &models.MetricPollState{}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	scope := fmt.Sprintf("MetricPollTest%d", time.Now().UnixNano())
	template := models.ProvisioningTemplate{Name: scope, Manufacturer: scope, ProductClass: "ONT"}
	if err := db.Create(&template).Error; err != nil {
		t.Fatal(err)
	}
	deviceType := scope + "/ONT"
	defs := []models.MetricDefinition{
		{Name: scope + "Fast", TemplateID: &template.ID, DeviceTypeMatch: deviceType, ParameterName: "Device.Metric.Fast", Source: "active", Active: true, GPVPollIntervalSeconds: 300},
		{Name: scope + "Slow", TemplateID: &template.ID, DeviceTypeMatch: deviceType, ParameterName: "Device.Metric.Slow", Source: "active", Active: true, GPVPollIntervalSeconds: 600},
	}
	if err := db.Create(&defs).Error; err != nil {
		t.Fatal(err)
	}
	deviceID := time.Now().UnixNano()
	t.Cleanup(func() {
		db.Where("device_id = ?", deviceID).Delete(&models.MetricPollState{})
		db.Where("template_id = ?", template.ID).Delete(&models.MetricDefinition{})
		db.Delete(&template)
	})

	first, err := NewMetricRepository(db).ReserveDueActiveMetricParams(ctx, deviceID, deviceType, 15*time.Minute)
	if err != nil || len(first) != 2 {
		t.Fatalf("first GPV paths: %v, err=%v", first, err)
	}
	second, err := NewMetricRepository(db).ReserveDueActiveMetricParams(ctx, deviceID, deviceType, 15*time.Minute)
	if err != nil || len(second) != 0 {
		t.Fatalf("repeated GPV paths before interval: %v, err=%v", second, err)
	}
	if err := db.Model(&models.MetricPollState{}).Where("device_id = ?", deviceID).Update("last_requested_at", time.Now().Add(-301*time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	third, err := NewMetricRepository(db).ReserveDueActiveMetricParams(ctx, deviceID, deviceType, 15*time.Minute)
	if err != nil || len(third) != 1 || third[0] != "Device.Metric.Fast" {
		t.Fatalf("GPV paths after five minutes: %v, err=%v", third, err)
	}
}

func TestSampleIntervalBoundary(t *testing.T) {
	previous := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	if sampleIntervalElapsed(previous.Add(299*time.Second), previous, 300) {
		t.Fatal("sample accepted before minimum interval")
	}
	if !sampleIntervalElapsed(previous.Add(300*time.Second), previous, 300) {
		t.Fatal("sample rejected at minimum interval")
	}
}

func TestMetricPollDueUsesConfiguredAndDefaultIntervals(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	if !metricPollDue(now, time.Time{}, 300, 15*time.Minute) {
		t.Fatal("new metric should be due")
	}
	if metricPollDue(now, now.Add(-299*time.Second), 300, 15*time.Minute) {
		t.Fatal("metric polled before configured interval")
	}
	if !metricPollDue(now, now.Add(-300*time.Second), 300, 15*time.Minute) {
		t.Fatal("metric not polled at configured interval")
	}
	if metricPollDue(now, now.Add(-300*time.Second), 0, 15*time.Minute) {
		t.Fatal("default interval was not used")
	}
}

func TestMetricSampleMinimumInterval(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.MetricSample{}, &models.InterfaceMetricSample{}); err != nil {
		t.Fatal(err)
	}
	repo := NewMetricRepository(db)
	ctx := context.Background()
	deviceID := time.Now().UnixNano()
	metricID := deviceID
	base := time.Now().UTC().Truncate(time.Second)
	t.Cleanup(func() {
		db.Where("device_id = ? AND metric_id = ?", deviceID, metricID).Delete(&models.MetricSample{})
		db.Where("device_id = ? AND metric_id = ?", deviceID, metricID).Delete(&models.InterfaceMetricSample{})
	})

	for _, offset := range []time.Duration{0, 60 * time.Second, 299 * time.Second, 300 * time.Second} {
		sample := models.MetricSample{DeviceID: deviceID, MetricID: metricID, Value: float64(offset / time.Second), Timestamp: base.Add(offset)}
		if err := repo.storeThrottledSample(ctx, deviceID, metricID, "", 300, sample.Timestamp, &sample); err != nil {
			t.Fatal(err)
		}
	}
	var standardCount int64
	if err := db.Model(&models.MetricSample{}).Where("device_id = ? AND metric_id = ?", deviceID, metricID).Count(&standardCount).Error; err != nil || standardCount != 2 {
		t.Fatalf("standard samples: count=%d err=%v, want 2", standardCount, err)
	}

	for _, path := range []string{"WAN.1", "WAN.2", "WAN.1"} {
		sample := models.InterfaceMetricSample{DeviceID: deviceID, MetricID: metricID, ParameterName: path, Value: 1, Timestamp: base}
		if err := repo.storeThrottledSample(ctx, deviceID, metricID, path, 300, sample.Timestamp, &sample); err != nil {
			t.Fatal(err)
		}
	}
	var interfaceCount int64
	if err := db.Model(&models.InterfaceMetricSample{}).Where("device_id = ? AND metric_id = ?", deviceID, metricID).Count(&interfaceCount).Error; err != nil || interfaceCount != 2 {
		t.Fatalf("interface samples: count=%d err=%v, want 2", interfaceCount, err)
	}
}
