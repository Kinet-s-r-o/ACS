package database

import (
	"context"
	"fmt"
	"strings"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

type AuditRepository struct {
	db *gorm.DB
}

func (r *AuditRepository) ListPage(ctx context.Context, limit, offset int, search, sort, direction string, filters map[string]TableColumnFilter) ([]models.AuditLog, int64, error) {
	query := r.db.WithContext(ctx).Model(&models.AuditLog{})
	expressions := map[string]string{
		"created_at": "created_at::text", "username": "username", "action": "action",
		"resource": "resource", "ip_address": "ip_address", "status": "status::text",
	}
	query = applySearchTerms(query, search, []string{"username", "action", "resource", "ip_address"})
	var err error
	query, err = ApplyTableColumnFilters(query, filters, expressions, map[string]string{"status": "status"})
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	sortColumns := map[string]string{
		"created_at": "created_at", "username": "username", "action": "action",
		"resource": "resource", "ip_address": "ip_address", "status": "status",
	}
	order := sortColumns[sort]
	if order == "" {
		order, direction = "created_at", "desc"
	}
	if direction != "asc" && direction != "desc" {
		return nil, 0, fmt.Errorf("invalid audit sort direction")
	}
	var entries []models.AuditLog
	err = query.Order(order + " " + strings.ToUpper(direction) + " NULLS LAST").Order("id DESC").Limit(limit).Offset(offset).Find(&entries).Error
	return entries, total, err
}

func NewAuditRepository(db *gorm.DB) *AuditRepository {
	return &AuditRepository{db: db}
}

func (r *AuditRepository) Create(ctx context.Context, entry *models.AuditLog) error {
	return r.db.WithContext(ctx).Create(entry).Error
}

func (r *AuditRepository) List(ctx context.Context, limit, offset int) ([]models.AuditLog, int64, error) {
	var total int64
	if err := r.db.WithContext(ctx).Model(&models.AuditLog{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var entries []models.AuditLog
	err := r.db.WithContext(ctx).
		Order("created_at DESC").
		Limit(limit).
		Offset(offset).
		Find(&entries).Error
	return entries, total, err
}

func (r *AuditRepository) CountFailures(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.AuditLog{}).
		Where("status >= ?", 400).
		Count(&count).Error
	return count, err
}
