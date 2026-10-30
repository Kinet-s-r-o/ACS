package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const DeviceLogParameterName = "InternetGatewayDevice.DeviceInfo.DeviceLog"

type DeviceLogFilter struct {
	Search  string
	Filters map[string]DeviceLogColumnFilter
	Sort    string
	Desc    bool
}

type DeviceLogColumnFilter struct {
	Logic string `json:"logic"`
	Rules []struct {
		Operator string `json:"operator"`
		Value    string `json:"value"`
	} `json:"rules"`
}

type DeviceLogPage struct {
	Items  []models.DeviceLogEntry `json:"items"`
	Total  int64                   `json:"total"`
	Limit  int                     `json:"limit"`
	Offset int                     `json:"offset"`
}

func storeDeviceLog(db *gorm.DB, deviceID int64, value string) error {
	entries := parseDeviceLogEntries(deviceID, value)
	if len(entries) == 0 {
		return nil
	}
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "device_id"}, {Name: "fingerprint"}},
		DoNothing: true,
	}).CreateInBatches(&entries, 500).Error
}

func parseDeviceLogEntries(deviceID int64, value string) []models.DeviceLogEntry {
	entries := make([]models.DeviceLogEntry, 0)
	for _, raw := range strings.Split(value, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" {
			continue
		}
		entry := models.DeviceLogEntry{DeviceID: deviceID, Message: line}
		if len(line) >= 20 && line[4] == '-' && line[7] == '-' && line[10] == ' ' && len(line) > 21 && line[19] == ' ' && line[20] == '[' {
			if end := strings.IndexByte(line[21:], ']'); end >= 0 {
				entry.Timestamp = line[:19]
				entry.Severity = strings.TrimSpace(line[21 : 21+end])
				entry.Message = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line[22+end:]), ":"))
			}
		}
		hash := sha256.Sum256([]byte(line))
		entry.Fingerprint = hex.EncodeToString(hash[:])
		entries = append(entries, entry)
	}
	return entries
}

// BackfillDeviceLogs migrates cached DeviceLog parameter values into the
// append-only log table. Fingerprints make startup retries safe.
func BackfillDeviceLogs(ctx context.Context, db *gorm.DB) error {
	var lastID int64
	for {
		parameters := make([]models.DeviceParameter, 0, 100)
		if err := db.WithContext(ctx).Where("name = ? AND id > ?", DeviceLogParameterName, lastID).Order("id").Limit(100).Find(&parameters).Error; err != nil {
			return fmt.Errorf("load cached device logs: %w", err)
		}
		if len(parameters) == 0 {
			return nil
		}
		for _, parameter := range parameters {
			if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
				return upsertMany(tx, parameter.DeviceID, []models.DeviceParameter{parameter}, true)
			}); err != nil {
				return fmt.Errorf("backfill cached device log for device %d: %w", parameter.DeviceID, err)
			}
			lastID = parameter.ID
		}
	}
}

func ListDeviceLogs(ctx context.Context, db *gorm.DB, deviceID int64, offset, limit int, filter DeviceLogFilter) (DeviceLogPage, error) {
	if offset < 0 || limit < 1 || limit > 500 {
		return DeviceLogPage{}, fmt.Errorf("invalid device log page")
	}
	query := db.WithContext(ctx).Model(&models.DeviceLogEntry{}).Where("device_id = ?", deviceID)
	if search := strings.TrimSpace(filter.Search); search != "" {
		pattern := "%" + escapeLike(search) + "%"
		query = query.Where("(occurred_at ILIKE ? ESCAPE '!' OR severity ILIKE ? ESCAPE '!' OR message ILIKE ? ESCAPE '!')", pattern, pattern, pattern)
	}
	columns := map[string]string{"time": "occurred_at", "severity": "severity", "message": "message"}
	for key, columnFilter := range filter.Filters {
		column, ok := columns[key]
		if !ok || len(columnFilter.Rules) == 0 {
			continue
		}
		logic := " AND "
		if columnFilter.Logic == "any" {
			logic = " OR "
		}
		parts := make([]string, 0, len(columnFilter.Rules))
		args := make([]interface{}, 0, len(columnFilter.Rules))
		for _, rule := range columnFilter.Rules {
			op := "ILIKE"
			value := escapeLike(rule.Value)
			switch rule.Operator {
			case "contains":
				value = "%" + value + "%"
			case "not_contains":
				op, value = "NOT ILIKE", "%"+value+"%"
			case "starts_with":
				value += "%"
			case "ends_with":
				value = "%" + value
			case "equals":
			default:
				continue
			}
			parts = append(parts, column+" "+op+" ? ESCAPE '!'")
			args = append(args, value)
		}
		if len(parts) > 0 {
			query = query.Where("("+strings.Join(parts, logic)+")", args...)
		}
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return DeviceLogPage{}, err
	}
	sortColumn := columns[filter.Sort]
	if sortColumn == "" {
		sortColumn = "occurred_at"
	}
	direction := " ASC"
	if filter.Desc {
		direction = " DESC"
	}
	items := make([]models.DeviceLogEntry, 0)
	if err := query.Order(sortColumn + direction).Order("id DESC").Offset(offset).Limit(limit).Find(&items).Error; err != nil {
		return DeviceLogPage{}, err
	}
	return DeviceLogPage{Items: items, Total: total, Limit: limit, Offset: offset}, nil
}

func escapeLike(value string) string {
	return strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(value)
}

func ParseDeviceLogFilters(raw string) (map[string]DeviceLogColumnFilter, error) {
	filters := make(map[string]DeviceLogColumnFilter)
	if raw == "" {
		return filters, nil
	}
	if err := json.Unmarshal([]byte(raw), &filters); err != nil {
		return nil, fmt.Errorf("invalid log filters: %w", err)
	}
	return filters, nil
}
