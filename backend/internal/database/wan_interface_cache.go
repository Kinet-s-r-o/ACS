package database

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const wanParameterPrefix = "InternetGatewayDevice.WANDevice."

func wanInterfaceSummaryValues(params []models.DeviceParameter) map[string]string {
	values := make(map[string]string)
	for _, parameter := range params {
		objectPath := wanInterfacePathPattern.FindString(parameter.Name)
		if objectPath == "" {
			continue
		}
		switch strings.TrimPrefix(parameter.Name, objectPath) {
		case "Name", "ConnectionType", "ConnectionStatus", "ExternalIPAddress", "IPAddress", "MACAddress", "MAC":
			values[parameter.Name] = parameter.Value
		}
	}
	return values
}

func wanInterfaceSummaryChanged(db *gorm.DB, deviceID int64, params []models.DeviceParameter) (bool, error) {
	incoming := wanInterfaceSummaryValues(params)
	if len(incoming) == 0 {
		return false, nil
	}
	var existing []models.DeviceParameter
	if err := db.Model(&models.DeviceParameter{}).Select("name", "value").
		Where("device_id = ? AND name IN ?", deviceID, mapKeys(incoming)).Find(&existing).Error; err != nil {
		return false, err
	}
	current := make(map[string]string, len(existing))
	for _, parameter := range existing {
		current[parameter.Name] = parameter.Value
	}
	for name, value := range incoming {
		if currentValue, ok := current[name]; !ok || currentValue != value {
			return true, nil
		}
	}
	return false, nil
}

func mapKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func hasWANParameters(params []models.DeviceParameter) bool {
	for _, parameter := range params {
		if strings.HasPrefix(parameter.Name, wanParameterPrefix) {
			return true
		}
	}
	return false
}

func refreshWANInterfacesForDevice(db *gorm.DB, deviceID int64) error {
	var device models.Device
	if err := db.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&device, deviceID).Error; err != nil {
		return err
	}
	var parameters []models.DeviceParameter
	if err := db.Model(&models.DeviceParameter{}).
		Select("name", "value").Where("device_id = ? AND name LIKE ?", deviceID, wanParameterPrefix+"%").
		Find(&parameters).Error; err != nil {
		return err
	}
	rows := buildWANInterfaceRecords(deviceID, parameters)
	if err := db.Where("device_id = ?", deviceID).Delete(&models.WANInterfaceRecord{}).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	return db.CreateInBatches(&rows, 100).Error
}

func buildWANInterfaceRecords(deviceID int64, parameters []models.DeviceParameter) []models.WANInterfaceRecord {
	groups := make(map[string]*models.WANInterfaceRecord)
	for _, parameter := range parameters {
		match := wanInterfacePathPattern.FindStringSubmatch(parameter.Name)
		if len(match) == 0 {
			continue
		}
		path := fmt.Sprintf("InternetGatewayDevice.WANDevice.%s.WANConnectionDevice.%s.%s.%s.", match[1], match[2], match[3], match[4])
		row := groups[path]
		if row == nil {
			row = &models.WANInterfaceRecord{DeviceID: deviceID, Path: path, Name: path, Type: "-", Status: "-", IPAddress: "-", MACAddress: "-"}
			groups[path] = row
		}
		if parameter.Value == "" {
			continue
		}
		switch strings.TrimPrefix(parameter.Name, path) {
		case "Name":
			row.Name = parameter.Value
		case "ConnectionType":
			row.Type = parameter.Value
		case "ConnectionStatus":
			row.Status = parameter.Value
		case "ExternalIPAddress":
			row.IPAddress = parameter.Value
		case "IPAddress":
			if row.IPAddress == "-" {
				row.IPAddress = parameter.Value
			}
		case "MACAddress", "MAC":
			row.MACAddress = parameter.Value
		}
	}
	paths := make([]string, 0, len(groups))
	for path := range groups {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	rows := make([]models.WANInterfaceRecord, 0, len(paths))
	for _, path := range paths {
		rows = append(rows, *groups[path])
	}
	return rows
}

func PrepareWANInterfaceBackfill(ctx context.Context, db *gorm.DB) (bool, error) {
	var state models.WANInterfaceBackfillState
	err := db.WithContext(ctx).First(&state, 1).Error
	if err == nil {
		return !state.Complete, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	var existing int64
	if err := db.WithContext(ctx).Model(&models.WANInterfaceRecord{}).Count(&existing).Error; err != nil {
		return false, err
	}
	state = models.WANInterfaceBackfillState{ID: 1, Complete: existing > 0}
	if err := db.WithContext(ctx).Create(&state).Error; err != nil {
		return false, err
	}
	return !state.Complete, nil
}

func WANInterfaceCacheReady(ctx context.Context, db *gorm.DB) (bool, error) {
	var state models.WANInterfaceBackfillState
	if err := db.WithContext(ctx).First(&state, 1).Error; err != nil {
		return false, err
	}
	return state.Complete, nil
}

func BackfillWANInterfaces(ctx context.Context, db *gorm.DB) error {
	if err := db.WithContext(ctx).Exec(`WITH parsed AS (
		SELECT dp.device_id,
			regexp_replace(dp.name, '(\.(WANPPPConnection|WANIPConnection)\.[0-9]+)\..*$', '\1.') AS path,
			dp.name, dp.value
		FROM device_parameters dp
		WHERE dp.name LIKE 'InternetGatewayDevice.WANDevice.%'
			AND dp.name ~ '^InternetGatewayDevice\.WANDevice\.[0-9]+\.WANConnectionDevice\.[0-9]+\.(WANPPPConnection|WANIPConnection)\.[0-9]+\.'
	), wan_rows AS (
		SELECT p.device_id, p.path,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'Name'), ''), p.path) AS name,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'ConnectionType'), ''), '-') AS type,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'ConnectionStatus'), ''), '-') AS status,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'ExternalIPAddress'), ''), NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'IPAddress'), ''), '-') AS ip_address,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'MACAddress'), ''), NULLIF(MAX(p.value) FILTER (WHERE p.name = p.path || 'MAC'), ''), '-') AS mac_address
		FROM parsed p GROUP BY p.device_id, p.path
	)
	INSERT INTO wan_interfaces (device_id, path, name, type, status, ip_address, mac_address)
	SELECT device_id, path, name, type, status, ip_address, mac_address FROM wan_rows WHERE true
	ON CONFLICT (device_id, path) DO NOTHING`).Error; err != nil {
		return err
	}
	return db.WithContext(ctx).Model(&models.WANInterfaceBackfillState{}).Where("id = ?", 1).Update("complete", true).Error
}
