package database

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

type FaultRepository struct {
	db *gorm.DB
}

func (r *FaultRepository) ListPage(ctx context.Context, limit, offset int, resolved *bool, search, sort, direction string, filters map[string]TableColumnFilter) ([]*models.Fault, int, error) {
	query := r.db.WithContext(ctx).Table("faults f").Joins("JOIN devices d ON f.device_id = d.id")
	if resolved != nil {
		query = query.Where("f.resolved = ?", *resolved)
	}
	expressions := map[string]string{
		"serial_number": "d.serial_number", "model_name": "COALESCE(NULLIF(d.model_name, ''), d.product_class, '')",
		"fault_code": "f.fault_code", "fault_string": "f.fault_string", "parameter_name": "f.parameter_name",
		"created_at": "f.created_at::text", "resolved": "CASE WHEN f.resolved THEN 'Resolved' ELSE 'Active' END",
		"software_version": "COALESCE(d.software_version, '')", "hardware_version": "COALESCE(d.hardware_version, '')",
		"manufacturer_oui": "COALESCE(d.oui, '')",
	}
	query = applySearchTerms(query, search, []string{
		"d.serial_number", "COALESCE(NULLIF(d.model_name, ''), d.product_class, '')", "f.fault_code",
		"f.fault_string", "f.parameter_name", "f.created_at::text", "CASE WHEN f.resolved THEN 'Resolved' ELSE 'Active' END",
		"COALESCE(d.software_version, '')", "COALESCE(d.hardware_version, '')", "COALESCE(d.oui, '')",
	})
	var err error
	query, err = ApplyTableColumnFilters(query, filters, expressions, nil)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	sortColumns := map[string]string{
		"serial_number": "d.serial_number", "model_name": "COALESCE(NULLIF(d.model_name, ''), d.product_class, '')",
		"fault_code": "f.fault_code", "fault_string": "f.fault_string", "parameter_name": "f.parameter_name",
		"created_at": "f.created_at", "resolved": "f.resolved", "software_version": "d.software_version",
		"hardware_version": "d.hardware_version", "manufacturer_oui": "d.oui",
	}
	order := sortColumns[sort]
	if order == "" {
		order, direction = "f.created_at", "desc"
	}
	if direction != "asc" && direction != "desc" {
		return nil, 0, fmt.Errorf("invalid fault sort direction")
	}
	var faults []*models.Fault
	err = query.Select("f.id, f.device_id, d.serial_number, COALESCE(NULLIF(d.model_name, ''), d.product_class, '') AS model_name, COALESCE(d.software_version, '') AS software_version, COALESCE(d.hardware_version, '') AS hardware_version, COALESCE(d.oui, '') AS manufacturer_oui, f.fault_code, f.fault_string, f.parameter_name, f.resolved, f.created_at, f.resolved_at").
		Order(order + " " + strings.ToUpper(direction) + " NULLS LAST").Order("f.id DESC").Limit(limit).Offset(offset).Scan(&faults).Error
	return faults, int(total), err
}

func NewFaultRepository(db *gorm.DB) *FaultRepository {
	return &FaultRepository{db: db}
}

func (r *FaultRepository) Create(ctx context.Context, fault *models.Fault) error {
	return r.db.WithContext(ctx).Create(fault).Error
}

func (r *FaultRepository) List(ctx context.Context, limit, offset int, resolved *bool) ([]*models.Fault, int, error) {
	var total int64
	query := r.db.WithContext(ctx).Model(&models.Fault{})

	if resolved != nil {
		query = query.Where("resolved = ?", *resolved)
	}
	query.Count(&total)

	var faults []*models.Fault
	q := r.db.WithContext(ctx).Table("faults f").
		Select("f.id, f.device_id, d.serial_number, COALESCE(NULLIF(d.model_name, ''), d.product_class, '') AS model_name, COALESCE(d.software_version, '') AS software_version, COALESCE(d.hardware_version, '') AS hardware_version, COALESCE(d.oui, '') AS manufacturer_oui, f.fault_code, f.fault_string, f.parameter_name, f.resolved, f.created_at, f.resolved_at").
		Joins("JOIN devices d ON f.device_id = d.id")

	if resolved != nil {
		q = q.Where("f.resolved = ?", *resolved)
	}

	err := q.Order("f.created_at DESC").
		Limit(limit).
		Offset(offset).
		Scan(&faults).Error

	if err != nil {
		return nil, 0, err
	}
	return faults, int(total), nil
}

func (r *FaultRepository) GetByDeviceID(ctx context.Context, deviceID int64) ([]*models.Fault, error) {
	var faults []*models.Fault
	err := r.db.WithContext(ctx).Table("faults f").
		Select("f.id, f.device_id, d.serial_number, COALESCE(NULLIF(d.model_name, ''), d.product_class, '') AS model_name, COALESCE(d.software_version, '') AS software_version, COALESCE(d.hardware_version, '') AS hardware_version, COALESCE(d.oui, '') AS manufacturer_oui, f.fault_code, f.fault_string, f.parameter_name, f.resolved, f.created_at, f.resolved_at").
		Joins("JOIN devices d ON f.device_id = d.id").
		Where("f.device_id = ?", deviceID).
		Order("f.created_at DESC").
		Scan(&faults).Error
	return faults, err
}

func (r *FaultRepository) GetByDeviceIDPage(ctx context.Context, deviceID int64, limit, offset int, search, sort, direction string, filters map[string]TableColumnFilter) ([]*models.Fault, int, error) {
	query := r.db.WithContext(ctx).Table("faults f").Where("f.device_id = ?", deviceID)
	expressions := map[string]string{
		"code": "f.fault_code", "message": "f.fault_string", "parameter": "f.parameter_name",
		"time": "f.created_at::text", "status": "CASE WHEN f.resolved THEN 'Resolved' ELSE 'Active' END",
	}
	query = applySearchTerms(query, search, []string{"f.fault_code", "f.fault_string", "f.parameter_name"})
	var err error
	query, err = ApplyTableColumnFilters(query, filters, expressions, nil)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	sortColumns := map[string]string{"code": "f.fault_code", "message": "f.fault_string", "parameter": "f.parameter_name", "time": "f.created_at", "status": "f.resolved"}
	order := sortColumns[sort]
	if order == "" {
		order, direction = "f.created_at", "desc"
	}
	if direction != "asc" && direction != "desc" {
		return nil, 0, fmt.Errorf("invalid fault sort direction")
	}
	var faults []*models.Fault
	err = query.Select("f.*").Order(order + " " + strings.ToUpper(direction) + " NULLS LAST").Order("f.id DESC").Limit(limit).Offset(offset).Scan(&faults).Error
	return faults, int(total), err
}

func (r *FaultRepository) GetStatsByDeviceID(ctx context.Context, deviceID int64) (map[string]int, error) {
	var counts struct {
		Active   int64 `gorm:"column:active"`
		Resolved int64 `gorm:"column:resolved"`
		Total    int64 `gorm:"column:total"`
	}
	err := r.db.WithContext(ctx).Model(&models.Fault{}).
		Select("COUNT(*) FILTER (WHERE resolved = false) AS active, COUNT(*) FILTER (WHERE resolved = true) AS resolved, COUNT(*) AS total").
		Where("device_id = ?", deviceID).
		Scan(&counts).Error
	if err != nil {
		return nil, err
	}
	return map[string]int{
		"active": int(counts.Active), "resolved": int(counts.Resolved), "total": int(counts.Total),
	}, nil
}

func (r *FaultRepository) Resolve(ctx context.Context, id int64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.Fault{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"resolved":    true,
			"resolved_at": &now,
		}).Error
}

// ResolveActiveByDeviceAndCode closes active faults created by a specific
// watchdog condition after the device has passed recovery verification.
func (r *FaultRepository) ResolveActiveByDeviceAndCode(ctx context.Context, deviceID int64, faultCode string) (int64, error) {
	now := time.Now()
	result := r.db.WithContext(ctx).Model(&models.Fault{}).
		Where("device_id = ? AND fault_code = ? AND resolved = ?", deviceID, faultCode, false).
		Updates(map[string]interface{}{"resolved": true, "resolved_at": &now})
	return result.RowsAffected, result.Error
}

func (r *FaultRepository) HasActiveByDeviceAndCode(ctx context.Context, deviceID int64, faultCode string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.Fault{}).
		Where("device_id = ? AND fault_code = ? AND resolved = ?", deviceID, faultCode, false).
		Count(&count).Error
	return count > 0, err
}

func (r *FaultRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Delete(&models.Fault{}, id).Error
}

func (r *FaultRepository) DeleteMany(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	result := r.db.WithContext(ctx).Delete(&models.Fault{}, ids)
	return result.RowsAffected, result.Error
}

func (r *FaultRepository) GetStats(ctx context.Context) (map[string]int, error) {
	var active, resolved, total int64

	r.db.WithContext(ctx).Model(&models.Fault{}).Where("resolved = ?", false).Count(&active)
	r.db.WithContext(ctx).Model(&models.Fault{}).Where("resolved = ?", true).Count(&resolved)
	r.db.WithContext(ctx).Model(&models.Fault{}).Count(&total)

	stats := map[string]int{
		"active":   int(active),
		"resolved": int(resolved),
		"total":    int(total),
	}

	type CodeCount struct {
		FaultCode string
		Count     int
	}
	var codeCounts []CodeCount
	r.db.WithContext(ctx).Model(&models.Fault{}).
		Select("fault_code, COUNT(*) as count").
		Where("resolved = ?", false).
		Group("fault_code").
		Order("count DESC").
		Limit(10).
		Scan(&codeCounts)

	for _, cc := range codeCounts {
		stats["code_"+cc.FaultCode] = cc.Count
	}

	return stats, nil
}
