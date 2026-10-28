package database

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

// TestListPopulatesSerialNumber verifies that List and GetByDeviceID populate
// the denormalized SerialNumber field from the devices join (regression test
// for the gorm:"-" tag that prevented Scan from mapping d.serial_number).
func TestListPopulatesSerialNumber(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Fault{}); err != nil {
		t.Fatalf("auto-migrate faults: %v", err)
	}
	ctx := context.Background()

	faultRepo := NewFaultRepository(db)

	serial := fmt.Sprintf("test-fault-%d", time.Now().UnixNano())
	device := &models.Device{SerialNumber: serial, OUI: "00:00:02"}
	if err := db.Create(device).Error; err != nil {
		t.Fatalf("create device: %v", err)
	}

	fault := &models.Fault{DeviceID: device.ID, FaultCode: "9005", FaultString: "Invalid parameter name"}
	if err := faultRepo.Create(ctx, fault); err != nil {
		t.Fatalf("create fault: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Delete(&models.Fault{}, fault.ID)
		_ = db.Delete(&models.Device{}, device.ID)
	})

	// List must return the device serial via the join.
	listed, total, err := faultRepo.List(ctx, 50, 0, nil)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total == 0 {
		t.Fatal("List returned no faults")
	}
	found := false
	for _, f := range listed {
		if f.ID == fault.ID {
			found = true
			if f.SerialNumber != serial {
				t.Errorf("List: serial_number = %q, want %q", f.SerialNumber, serial)
			}
		}
	}
	if !found {
		t.Fatal("List did not return the created fault")
	}

	// GetByDeviceID must return the device serial via the join.
	byDevice, err := faultRepo.GetByDeviceID(ctx, device.ID)
	if err != nil {
		t.Fatalf("GetByDeviceID: %v", err)
	}
	if len(byDevice) != 1 {
		t.Fatalf("GetByDeviceID returned %d faults, want 1", len(byDevice))
	}
	if byDevice[0].SerialNumber != serial {
		t.Errorf("GetByDeviceID: serial_number = %q, want %q", byDevice[0].SerialNumber, serial)
	}
}

func TestDeleteMany(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Fault{}); err != nil {
		t.Fatalf("auto-migrate faults: %v", err)
	}
	ctx := context.Background()

	faultRepo := NewFaultRepository(db)

	serial := fmt.Sprintf("test-bulk-%d", time.Now().UnixNano())
	device := &models.Device{SerialNumber: serial, OUI: "00:00:03"}
	if err := db.Create(device).Error; err != nil {
		t.Fatalf("create device: %v", err)
	}

	var ids []int64
	for i := 0; i < 3; i++ {
		f := &models.Fault{DeviceID: device.ID, FaultCode: fmt.Sprintf("%d", 9000+i), FaultString: "Bulk test"}
		if err := faultRepo.Create(ctx, f); err != nil {
			t.Fatalf("create fault %d: %v", i, err)
		}
		ids = append(ids, f.ID)
	}
	t.Cleanup(func() {
		_ = db.Delete(&models.Fault{}, "id IN ?", ids)
		_ = db.Delete(&models.Device{}, device.ID)
	})

	// Empty slice should be a no-op.
	n, err := faultRepo.DeleteMany(ctx, []int64{})
	if err != nil {
		t.Fatalf("DeleteMany(empty): %v", err)
	}
	if n != 0 {
		t.Errorf("DeleteMany(empty) rows = %d, want 0", n)
	}

	// Delete all three.
	n, err = faultRepo.DeleteMany(ctx, ids)
	if err != nil {
		t.Fatalf("DeleteMany: %v", err)
	}
	if n != 3 {
		t.Errorf("DeleteMany rows = %d, want 3", n)
	}

	// Verify they are gone.
	remaining, err := faultRepo.GetByDeviceID(ctx, device.ID)
	if err != nil {
		t.Fatalf("GetByDeviceID after delete: %v", err)
	}
	if len(remaining) != 0 {
		t.Errorf("GetByDeviceID after delete = %d faults, want 0", len(remaining))
	}
}
