package database

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// openTestDB connects to a real PostgreSQL instance for integration tests.
// It skips the test when no DSN is configured so the suite still passes in
// environments without a database (e.g. the unit-test CI job).
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping PostgreSQL integration test")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	if err := db.AutoMigrate(&models.Device{}, &models.ProvisioningTemplate{}, &models.ProvisioningRule{}, &models.ProvisioningApplication{}); err != nil {
		t.Fatalf("auto-migrate test schema: %v", err)
	}
	return db
}

// TestListPendingForDeviceTagFilter verifies the jsonb tag-containment filter:
// a rule with a tag applies only to devices carrying that tag, while a rule
// with an empty tag applies to every device.
func TestListPendingForDeviceTagFilter(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	provRepo := NewProvisioningRepository(db)

	serial := fmt.Sprintf("test-tag-%d", time.Now().UnixNano())
	device := &models.Device{SerialNumber: serial, OUI: "00:00:00", Tags: []string{"branch-a", "hq"}}
	if err := db.Create(device).Error; err != nil {
		t.Fatalf("create device: %v", err)
	}

	template := &models.ProvisioningTemplate{Name: "test-tag-template", Manufacturer: "", ProductClass: ""}
	if err := db.Create(template).Error; err != nil {
		t.Fatalf("create template: %v", err)
	}

	matching := &models.ProvisioningRule{TemplateID: template.ID, ParameterName: "Device.WiFi.SSID.1.SSID", ParameterValue: "match", ParameterType: "string", Phase: "bootstrap", Tags: []string{"branch-a"}, Enabled: true}
	nonMatching := &models.ProvisioningRule{TemplateID: template.ID, ParameterName: "Device.WiFi.SSID.2.SSID", ParameterValue: "nope", ParameterType: "string", Phase: "bootstrap", Tags: []string{"other"}, Enabled: true}
	unscoped := &models.ProvisioningRule{TemplateID: template.ID, ParameterName: "Device.WiFi.SSID.3.SSID", ParameterValue: "all", ParameterType: "string", Phase: "bootstrap", Enabled: true}
	for _, rule := range []*models.ProvisioningRule{matching, nonMatching, unscoped} {
		if err := provRepo.Create(ctx, rule); err != nil {
			t.Fatalf("create rule: %v", err)
		}
	}
	t.Cleanup(func() {
		_ = db.Where("device_id = ?", device.ID).Delete(&models.ProvisioningApplication{})
		_ = db.Delete(&models.ProvisioningRule{}, []int64{matching.ID, nonMatching.ID, unscoped.ID})
		_ = db.Delete(&models.Device{}, device.ID)
		_ = db.Delete(&models.ProvisioningTemplate{}, template.ID)
	})

	assertPending := func(deviceID int64, want map[string]bool) {
		t.Helper()
		rules, err := provRepo.ListPendingForDevice(ctx, deviceID, "", "", "bootstrap")
		if err != nil {
			t.Fatalf("ListPendingForDevice: %v", err)
		}
		got := map[string]bool{}
		for _, r := range rules {
			got[r.ParameterName] = true
		}
		for name, expected := range want {
			if got[name] != expected {
				t.Errorf("rule %q pending=%v, want %v (full set: %v)", name, got[name], expected, got)
			}
		}
	}

	// Tagged device: matching-tag and unscoped rules apply; other-tag rule does not.
	assertPending(device.ID, map[string]bool{
		"Device.WiFi.SSID.1.SSID": true,
		"Device.WiFi.SSID.2.SSID": false,
		"Device.WiFi.SSID.3.SSID": true,
	})

	// Untagged device: tag-scoped rules must not apply; unscoped rules still do.
	untagged := &models.Device{SerialNumber: fmt.Sprintf("test-tag-none-%d", time.Now().UnixNano()), OUI: "00:00:01"}
	if err := db.Create(untagged).Error; err != nil {
		t.Fatalf("create untagged device: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Where("device_id = ?", untagged.ID).Delete(&models.ProvisioningApplication{})
		_ = db.Delete(&models.Device{}, untagged.ID)
	})
	assertPending(untagged.ID, map[string]bool{
		"Device.WiFi.SSID.1.SSID": false,
		"Device.WiFi.SSID.2.SSID": false,
		"Device.WiFi.SSID.3.SSID": true,
	})
}

func TestExcludedTags(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	repo := NewProvisioningRepository(db)
	name := fmt.Sprintf("excluded-tags-%d", time.Now().UnixNano())
	template := &models.ProvisioningTemplate{Name: name, Manufacturer: name}
	if err := db.Create(template).Error; err != nil {
		t.Fatal(err)
	}
	device := &models.Device{SerialNumber: name, OUI: "000000"}
	if err := db.Create(device).Error; err != nil {
		t.Fatal(err)
	}
	rule := &models.ProvisioningRule{TemplateID: template.ID, ParameterName: "Device.Test", ParameterType: "string", Phase: "bootstrap", Enabled: true}
	if err := repo.Create(ctx, rule); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Delete(rule)
		db.Delete(device)
		db.Delete(template)
	})
	for _, tc := range []struct {
		name                       string
		tags, excluded, deviceTags []string
		want                       int
	}{
		{"legacy unscoped", nil, nil, nil, 1},
		{"excluded present", nil, []string{"blocked"}, []string{"blocked"}, 0},
		{"excluded absent", nil, []string{"blocked"}, []string{"branch-a"}, 1},
		{"untagged allowed", nil, []string{"blocked"}, nil, 1},
		{"both conditions match", []string{"branch-a", "branch-b"}, []string{"blocked"}, []string{"branch-b"}, 1},
		{"exclusion wins", []string{"branch-a"}, []string{"blocked"}, []string{"branch-a", "blocked"}, 0},
		{"inclusion required", []string{"branch-a"}, []string{"blocked"}, nil, 0},
		{"clear exclusions", nil, nil, []string{"blocked"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rule.Tags, rule.ExcludedTags = tc.tags, tc.excluded
			if err := repo.Update(ctx, rule); err != nil {
				t.Fatal(err)
			}
			device.Tags = tc.deviceTags
			if err := db.Save(device).Error; err != nil {
				t.Fatal(err)
			}
			for _, list := range []func(context.Context, int64, string, string, string) ([]*models.ProvisioningRule, error){repo.ListForDevice, repo.ListPendingForDevice} {
				rules, err := list(ctx, device.ID, name, "", "bootstrap")
				if err != nil {
					t.Fatal(err)
				}
				if len(rules) != tc.want {
					t.Fatalf("got %d rules, want %d", len(rules), tc.want)
				}
			}
		})
	}
}

// TestUpdateTags verifies JSON serialization in map-based updates.
func TestUpdateTags(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	provRepo := NewProvisioningRepository(db)

	template := &models.ProvisioningTemplate{Name: fmt.Sprintf("test-tags-%d", time.Now().UnixNano())}
	if err := db.Create(template).Error; err != nil {
		t.Fatalf("create template: %v", err)
	}

	// Create a rule with initial tags.
	initial := []string{"tag-a", "tag-b"}
	rule := &models.ProvisioningRule{
		TemplateID:     template.ID,
		ParameterName:  "Test.Update.Tags",
		ParameterValue: "initial",
		ParameterType:  "string",
		Phase:          "bootstrap",
		Tags:           initial,
		Enabled:        true,
		Order:          0,
	}
	if err := provRepo.Create(ctx, rule); err != nil {
		t.Fatalf("create rule: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Delete(&models.ProvisioningRule{}, rule.ID)
		_ = db.Delete(&models.ProvisioningTemplate{}, template.ID)
	})

	// Verify initial state.
	var loaded models.ProvisioningRule
	if err := db.First(&loaded, rule.ID).Error; err != nil {
		t.Fatalf("load rule: %v", err)
	}
	if len(loaded.Tags) != 2 || loaded.Tags[0] != "tag-a" || loaded.Tags[1] != "tag-b" {
		t.Fatalf("initial Tags = %v, want %v", loaded.Tags, initial)
	}

	// Update with new tags.
	updated := []string{"tag-c", "tag-d", "tag-e"}
	rule.ParameterValue = "updated"
	rule.Tags = updated
	if err := provRepo.Update(ctx, rule); err != nil {
		t.Fatalf("update rule: %v", err)
	}

	// Verify the update persisted correctly.
	if err := db.First(&loaded, rule.ID).Error; err != nil {
		t.Fatalf("reload rule: %v", err)
	}
	if len(loaded.Tags) != 3 {
		t.Fatalf("updated Tags len = %d, want 3 (got %v)", len(loaded.Tags), loaded.Tags)
	}
	for i, want := range updated {
		if loaded.Tags[i] != want {
			t.Errorf("Tags[%d] = %q, want %q", i, loaded.Tags[i], want)
		}
	}
	if loaded.ParameterValue != "updated" {
		t.Errorf("ParameterValue = %q, want %q", loaded.ParameterValue, "updated")
	}

	// Update to nil (clear tags).
	rule.Tags = nil
	if err := provRepo.Update(ctx, rule); err != nil {
		t.Fatalf("update rule to nil: %v", err)
	}
	if err := db.First(&loaded, rule.ID).Error; err != nil {
		t.Fatalf("reload rule after nil: %v", err)
	}
	if loaded.Tags != nil {
		t.Errorf("Tags after nil update = %v, want nil", loaded.Tags)
	}
}

// TestMaxOrder verifies that MaxOrder returns the highest order value for a
// given phase and 0 when no rules exist for that phase.
func TestMaxOrder(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	provRepo := NewProvisioningRepository(db)

	template := &models.ProvisioningTemplate{Name: fmt.Sprintf("test-max-order-%d", time.Now().UnixNano())}
	if err := db.Create(template).Error; err != nil {
		t.Fatalf("create template: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Delete(&models.ProvisioningTemplate{}, template.ID)
	})

	// Use a unique phase to avoid interference with other tests.
	phase := fmt.Sprintf("test-max-order-%d", time.Now().UnixNano())

	// No rules yet: MaxOrder should return 0.
	max, err := provRepo.MaxOrder(ctx, template.ID, phase)
	if err != nil {
		t.Fatalf("MaxOrder (empty): %v", err)
	}
	if max != 0 {
		t.Fatalf("MaxOrder (empty) = %d, want 0", max)
	}

	// Create rules with orders 0, 1, 2.
	ids := make([]int64, 3)
	for i := 0; i < 3; i++ {
		rule := &models.ProvisioningRule{
			TemplateID:     template.ID,
			ParameterName:  fmt.Sprintf("Test.Param.%d", i),
			ParameterValue: "val",
			ParameterType:  "string",
			Phase:          phase,
			Enabled:        true,
			Order:          i,
		}
		if err := provRepo.Create(ctx, rule); err != nil {
			t.Fatalf("create rule %d: %v", i, err)
		}
		ids[i] = rule.ID
	}
	t.Cleanup(func() {
		_ = db.Delete(&models.ProvisioningRule{}, ids)
	})

	max, err = provRepo.MaxOrder(ctx, template.ID, phase)
	if err != nil {
		t.Fatalf("MaxOrder: %v", err)
	}
	if max != 2 {
		t.Fatalf("MaxOrder = %d, want 2", max)
	}

	// A different phase should still return 0.
	otherPhase := phase + "-other"
	max, err = provRepo.MaxOrder(ctx, template.ID, otherPhase)
	if err != nil {
		t.Fatalf("MaxOrder (other phase): %v", err)
	}
	if max != 0 {
		t.Fatalf("MaxOrder (other phase) = %d, want 0", max)
	}
}
