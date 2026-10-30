package database

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type DeviceRepository struct {
	db *gorm.DB
}

func EnsureWANParameterIndex(ctx context.Context, db *gorm.DB) error {
	if db.Dialector.Name() != "postgres" {
		return nil
	}
	return db.WithContext(ctx).Exec(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_parameters_wan_name_pattern
		ON device_parameters (name text_pattern_ops)
		WHERE name LIKE 'InternetGatewayDevice.WANDevice.%'`).Error
}

type DeviceGrowthPoint struct {
	Timestamp time.Time `json:"timestamp"`
	Count     int64     `json:"count"`
	Online    int64     `json:"online"`
}

type deviceGrowthSpec struct {
	SQLBucket string
	Step      time.Duration
	Buckets   int
}

var deviceGrowthSpecs = map[string]deviceGrowthSpec{
	"hourly":  {SQLBucket: "hour", Step: time.Hour, Buckets: 48},
	"daily":   {SQLBucket: "day", Step: 24 * time.Hour, Buckets: 30},
	"weekly":  {SQLBucket: "week", Step: 7 * 24 * time.Hour, Buckets: 26},
	"monthly": {SQLBucket: "month", Step: 0, Buckets: 24},
	"yearly":  {SQLBucket: "year", Step: 0, Buckets: 10},
}

func NewDeviceRepository(db *gorm.DB) *DeviceRepository {
	return &DeviceRepository{db: db}
}

func (r *DeviceRepository) UpsertFromInform(ctx context.Context, device *models.Device) error {
	_, err := r.UpsertFromInformWithTransition(ctx, device)
	return err
}

// UpsertFromInformWithTransition persists an Inform and reports whether an
// existing device changed from offline to online.
func (r *DeviceRepository) UpsertFromInformWithTransition(ctx context.Context, device *models.Device) (bool, error) {
	now := time.Now()
	device.LastInform = &now
	device.Online = true
	updates := []string{"last_inform", "online", "updated_at"}
	for _, field := range []struct {
		column string
		value  *string
	}{
		{"manufacturer", device.Manufacturer}, {"product_class", device.ProductClass},
		{"hardware_version", device.HardwareVersion}, {"software_version", device.SoftwareVersion},
		{"ip_address", device.IPAddress}, {"connection_request_url", device.ConnectionRequestURL},
	} {
		if field.value != nil && *field.value != "" {
			updates = append(updates, field.column)
		}
	}

	recovered := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing models.Device
		err := tx.Where("serial_number = ?", device.SerialNumber).First(&existing).Error
		isNew := errors.Is(err, gorm.ErrRecordNotFound)
		if err != nil && !isNew {
			return err
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "serial_number"}},
			DoUpdates: clause.AssignmentColumns(updates),
		}).Create(device).Error; err != nil {
			return err
		}
		if !isNew {
			if existing.Online {
				return nil
			}
			recovered = true
			return tx.Create(&models.DeviceLifecycleEvent{
				DeviceID: device.ID, SerialNumber: device.SerialNumber,
				EventType: models.DeviceLifecycleOnline, OccurredAt: now,
			}).Error
		}
		if err := tx.Create(&models.DeviceLifecycleEvent{
			DeviceID: device.ID, SerialNumber: device.SerialNumber,
			EventType: models.DeviceLifecycleRegistered, OccurredAt: device.CreatedAt,
		}).Error; err != nil {
			return err
		}
		return tx.Create(&models.DeviceLifecycleEvent{
			DeviceID: device.ID, SerialNumber: device.SerialNumber,
			EventType: models.DeviceLifecycleOnline, OccurredAt: now,
		}).Error
	})
	return recovered, err
}

func (r *DeviceRepository) MarkOverviewRefresh(ctx context.Context, deviceID int64) error {
	return r.db.WithContext(ctx).Model(&models.Device{}).Where("id = ?", deviceID).
		Update("last_overview_refresh", time.Now()).Error
}

func (r *DeviceRepository) MarkFullRefresh(ctx context.Context, deviceID int64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.Device{}).Where("id = ?", deviceID).
		Updates(map[string]interface{}{"last_overview_refresh": now, "last_full_refresh": now}).Error
}

func (r *DeviceRepository) MarkInformStaggered(ctx context.Context, deviceID, interval int64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.Device{}).Where("id = ?", deviceID).Updates(map[string]interface{}{
		"inform_staggered":        true,
		"inform_stagger_interval": interval,
		"inform_staggered_at":     now,
	}).Error
}

func (r *DeviceRepository) UpdateFromParameters(ctx context.Context, deviceID int64, params map[string]string) error {
	columns := map[string]string{
		"ModelName": "model_name", "HardwareVersion": "hardware_version",
		"SoftwareVersion": "software_version", "ExternalIPAddress": "ip_address",
		"ConnectionRequestURL": "connection_request_url",
	}
	updates := make(map[string]interface{})
	for key, column := range columns {
		if value := params[key]; value != "" {
			updates[column] = value
		}
	}
	if len(updates) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Model(&models.Device{}).Where("id = ?", deviceID).Updates(updates).Error
}

func (r *DeviceRepository) UpdateIPAddress(ctx context.Context, deviceID int64, ipAddress string) error {
	if ipAddress == "" {
		return nil
	}
	return r.db.WithContext(ctx).Model(&models.Device{}).Where("id = ?", deviceID).
		Update("ip_address", ipAddress).Error
}

func (r *DeviceRepository) GetBySerial(ctx context.Context, serialNumber string) (*models.Device, error) {
	var device models.Device
	err := r.db.WithContext(ctx).Where("serial_number = ?", serialNumber).First(&device).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &device, nil
}

func (r *DeviceRepository) GetByID(ctx context.Context, id int64) (*models.Device, error) {
	var device models.Device
	err := r.db.WithContext(ctx).First(&device, id).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &device, nil
}

func (r *DeviceRepository) List(ctx context.Context, limit, offset int) ([]*models.Device, int, error) {
	var total int64
	if err := r.db.WithContext(ctx).Model(&models.Device{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var devices []*models.Device
	err := r.db.WithContext(ctx).
		Model(&models.Device{}).
		Select("devices.*, (SELECT COUNT(*) FROM faults WHERE faults.device_id = devices.id AND faults.resolved = FALSE) AS active_faults").
		Order("last_inform DESC NULLS LAST").
		Limit(limit).
		Offset(offset).
		Find(&devices).Error
	if err != nil {
		return nil, 0, err
	}

	return devices, int(total), nil
}

// LoadInventoryParameters fetches only parameter values used by the requested
// inventory columns. The selected IP address is stored on the device row.
func (r *DeviceRepository) LoadInventoryParameters(ctx context.Context, devices []*models.Device, columns []string) error {
	if len(devices) == 0 || len(columns) == 0 {
		return nil
	}
	columnSet := make(map[string]bool, len(columns))
	for _, column := range columns {
		columnSet[column] = true
	}
	deviceIDs := make([]int64, 0, len(devices))
	deviceByID := make(map[int64]*models.Device, len(devices))
	for _, device := range devices {
		deviceIDs = append(deviceIDs, device.ID)
		device.Parameters = nil
		deviceByID[device.ID] = device
	}
	conditions := make([]string, 0, 12+len(devices))
	args := make([]interface{}, 0, 16+len(devices)*2)
	if columnSet["rx_power"] {
		conditions = append(conditions, "name LIKE ? OR name LIKE ? OR name LIKE ? OR name LIKE ? OR name LIKE ?")
		args = append(args, "%RXPower%", "%OpticalRxPower%", "%OpticalReceivedPower%", "%TransceiverRxPower%", "%ReceivedPower%")
	}
	if columnSet["uptime"] {
		conditions = append(conditions, "name = ?")
		args = append(args, "InternetGatewayDevice.DeviceInfo.UpTime")
	}
	if columnSet["ppp_username"] {
		conditions = append(conditions, "(name LIKE ? AND name LIKE ?)")
		args = append(args, "%WANPPPConnection%", "%Username%")
	}
	for _, entry := range []struct {
		column string
		name   string
	}{
		{"software_version", "InternetGatewayDevice.DeviceInfo.SoftwareVersion"},
		{"hardware_version", "InternetGatewayDevice.DeviceInfo.HardwareVersion"},
		{"manufacturer_oui", "InternetGatewayDevice.DeviceInfo.ManufacturerOUI"},
	} {
		if columnSet[entry.column] {
			conditions = append(conditions, "name = ?")
			args = append(args, entry.name)
		}
	}
	if len(conditions) == 0 {
		return nil
	}
	var parameters []models.DeviceParameter
	if err := r.db.WithContext(ctx).Where("device_id IN ?", deviceIDs).
		Where("("+strings.Join(conditions, " OR ")+")", args...).
		Order("device_id ASC, name ASC").Find(&parameters).Error; err != nil {
		return err
	}
	if err := decryptParameters(parameters); err != nil {
		return err
	}
	for _, parameter := range parameters {
		deviceByID[parameter.DeviceID].Parameters = append(deviceByID[parameter.DeviceID].Parameters, parameter)
	}
	return nil
}

// SelectPrimaryIPAddress applies the per-template inventory preference. The
// fallback is the legacy device-level IP stored from the most recent CWMP
// exchange, so existing templates remain backwards compatible.
func SelectPrimaryIPAddress(parameters []models.DeviceParameter, settings models.TemplateInventory, fallback string) string {
	values := make(map[string]string, len(parameters))
	for _, parameter := range parameters {
		if parameter.Value != "" {
			values[parameter.Name] = parameter.Value
		}
	}

	switch settings.PrimaryIPMode {
	case "parameter":
		if value := values[settings.PrimaryIPParameter]; value != "" {
			return value
		}
	case "interface_name":
		paths := make([]string, 0)
		for name, value := range values {
			match := wanInterfacePathPattern.FindStringSubmatch(name)
			if len(match) == 0 || value != settings.PrimaryIPInterfaceName || !strings.HasSuffix(name, ".Name") {
				continue
			}
			paths = append(paths, fmt.Sprintf("InternetGatewayDevice.WANDevice.%s.WANConnectionDevice.%s.%s.%s.", match[1], match[2], match[3], match[4]))
		}
		sort.Strings(paths)
		for _, path := range paths {
			for _, suffix := range []string{"ExternalIPAddress", "IPAddress"} {
				if value := values[path+suffix]; value != "" {
					return value
				}
			}
		}
	}

	return fallback
}

var wanInterfacePathPattern = regexp.MustCompile(`^InternetGatewayDevice\.WANDevice\.(\d+)\.WANConnectionDevice\.(\d+)\.(WANPPPConnection|WANIPConnection)\.(\d+)(?:\.|$)`)

type wanInterfaceGroup struct {
	path   string
	parent string
	params []models.DeviceParameter
}

func (r *DeviceRepository) ListWANInterfaces(ctx context.Context) ([]models.WANInterface, error) {
	var devices []*models.Device
	if err := r.db.WithContext(ctx).
		Preload("Parameters", "name LIKE ?", "InternetGatewayDevice.WANDevice.%").
		Order("serial_number ASC").
		Find(&devices).Error; err != nil {
		return nil, err
	}

	interfaces := make([]models.WANInterface, 0)
	for _, device := range devices {
		groups := make(map[string]*wanInterfaceGroup)
		for _, parameter := range device.Parameters {
			match := wanInterfacePathPattern.FindStringSubmatch(parameter.Name)
			if len(match) == 0 {
				continue
			}
			path := fmt.Sprintf("InternetGatewayDevice.WANDevice.%s.WANConnectionDevice.%s.%s.%s.", match[1], match[2], match[3], match[4])
			parent := fmt.Sprintf("InternetGatewayDevice.WANDevice.%s.WANConnectionDevice.%s.", match[1], match[2])
			if groups[path] == nil {
				groups[path] = &wanInterfaceGroup{path: path, parent: parent}
			}
			groups[path].params = append(groups[path].params, parameter)
		}

		paths := make([]string, 0, len(groups))
		for path := range groups {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		for _, path := range paths {
			group := groups[path]
			parentParams := make([]models.DeviceParameter, 0)
			for _, parameter := range device.Parameters {
				if strings.HasPrefix(parameter.Name, group.parent) && !wanInterfacePathPattern.MatchString(parameter.Name) {
					parentParams = append(parentParams, parameter)
				}
			}
			relevant := append(append([]models.DeviceParameter{}, group.params...), parentParams...)
			ownValue := func(suffix string) string {
				for _, parameter := range group.params {
					if parameter.Name == group.path+suffix && parameter.Value != "" {
						return parameter.Value
					}
				}
				return "-"
			}
			firstValue := func(names ...string) string {
				for _, name := range names {
					for _, parameter := range relevant {
						if (strings.HasSuffix(parameter.Name, "."+name) || strings.HasSuffix(parameter.Name, name)) && parameter.Value != "" {
							return parameter.Value
						}
					}
				}
				return "-"
			}
			name := ownValue("Name")
			if name == "-" {
				name = path
			}
			interfaces = append(interfaces, models.WANInterface{
				SerialNumber: device.SerialNumber,
				Name:         name,
				Type:         ownValue("ConnectionType"),
				Status:       ownValue("ConnectionStatus"),
				IPAddress:    firstValue("ExternalIPAddress", "IPAddress"),
				MACAddress:   firstValue("MACAddress", "MAC"),
			})
		}
	}

	return interfaces, nil
}

func (r *DeviceRepository) ListWANInterfacesPage(ctx context.Context, limit, offset int, search, sortColumn, direction string, filters map[string]TableColumnFilter) ([]models.WANInterface, int, error) {
	const rowsSQL = `WITH parsed AS MATERIALIZED (
		SELECT dp.device_id,
			regexp_replace(dp.name, '(\.(WANPPPConnection|WANIPConnection)\.[0-9]+)\.(Name|ConnectionType|ConnectionStatus|ExternalIPAddress|IPAddress|MACAddress)$', '\1.') AS interface_path,
			dp.name, dp.value
		FROM device_parameters dp
		WHERE dp.name LIKE 'InternetGatewayDevice.WANDevice.%'
			AND dp.name ~ '^InternetGatewayDevice\.WANDevice\.[0-9]+\.WANConnectionDevice\.[0-9]+\.(WANPPPConnection|WANIPConnection)\.[0-9]+\.(Name|ConnectionType|ConnectionStatus|ExternalIPAddress|IPAddress|MACAddress)$'
	), wan_rows AS (
		SELECT d.serial_number, p.interface_path,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.interface_path || 'Name'), ''), p.interface_path) AS name,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.interface_path || 'ConnectionType'), ''), '-') AS type,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.interface_path || 'ConnectionStatus'), ''), '-') AS status,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.interface_path || 'ExternalIPAddress'), ''), NULLIF(MAX(p.value) FILTER (WHERE p.name = p.interface_path || 'IPAddress'), ''), '-') AS ip_address,
			COALESCE(NULLIF(MAX(p.value) FILTER (WHERE p.name = p.interface_path || 'MACAddress'), ''), '-') AS mac_address
		FROM parsed p JOIN devices d ON d.id = p.device_id
		GROUP BY d.serial_number, p.interface_path
	)
	SELECT * FROM wan_rows`
	query := r.db.WithContext(ctx).Table("(" + rowsSQL + ") AS w")
	expressions := map[string]string{"serial_number": "w.serial_number", "name": "w.name", "type": "w.type", "status": "w.status", "ip_address": "w.ip_address", "mac_address": "w.mac_address"}
	query = applySearchTerms(query, search, []string{"w.serial_number", "w.name", "w.type", "w.status", "w.ip_address", "w.mac_address"})
	var err error
	query, err = ApplyTableColumnFilters(query, filters, expressions, nil)
	if err != nil {
		return nil, 0, err
	}
	sortColumns := map[string]string{"serial_number": "w.serial_number", "name": "w.name", "type": "w.type", "status": "w.status", "ip_address": "w.ip_address", "mac_address": "w.mac_address"}
	order := sortColumns[sortColumn]
	if order == "" {
		order, direction = "w.serial_number", "asc"
	}
	if direction != "asc" && direction != "desc" {
		return nil, 0, fmt.Errorf("invalid WAN interface sort direction")
	}
	var rows []struct {
		models.WANInterface
		Total int `gorm:"column:total_count"`
	}
	err = query.Select("w.serial_number, w.name, w.type, w.status, w.ip_address, w.mac_address, COUNT(*) OVER() AS total_count").
		Order(order + " " + strings.ToUpper(direction)).Order("w.serial_number ASC").Limit(limit).Offset(offset).Scan(&rows).Error
	if err != nil {
		return nil, 0, err
	}
	interfaces := make([]models.WANInterface, 0, len(rows))
	total := 0
	for _, row := range rows {
		interfaces = append(interfaces, row.WANInterface)
		total = row.Total
	}
	return interfaces, total, nil
}

func (r *DeviceRepository) GetStats(ctx context.Context) (*models.DeviceStats, error) {
	stats := &models.DeviceStats{}
	var total, online, offline int64

	if err := r.db.WithContext(ctx).Model(&models.Device{}).Count(&total).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&models.Device{}).Where("online = ?", true).Count(&online).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&models.Device{}).Where("online = ?", false).Count(&offline).Error; err != nil {
		return nil, err
	}

	stats.Total = int(total)
	stats.Online = int(online)
	stats.Offline = int(offline)

	return stats, nil
}

func (r *DeviceRepository) GetGrowth(ctx context.Context, interval string) ([]DeviceGrowthPoint, error) {
	spec, ok := deviceGrowthSpecs[interval]
	if !ok {
		return nil, fmt.Errorf("unsupported device growth interval %q", interval)
	}

	now := time.Now().UTC()
	start := growthBucketStart(now, interval)
	if interval == "monthly" {
		start = start.AddDate(0, -spec.Buckets, 0)
	} else if interval == "yearly" {
		start = start.AddDate(-spec.Buckets, 0, 0)
	} else {
		start = start.Add(-time.Duration(spec.Buckets) * spec.Step)
	}
	end := growthBucketStart(now, interval)

	var current struct {
		Count  int64 `gorm:"column:count"`
		Online int64 `gorm:"column:online"`
	}
	if err := r.db.WithContext(ctx).Model(&models.Device{}).
		Select("COUNT(*) AS count, COALESCE(SUM(CASE WHEN online THEN 1 ELSE 0 END), 0) AS online").
		Scan(&current).Error; err != nil {
		return nil, err
	}
	count, online := current.Count, current.Online
	type growthDelta struct{ active, online int64 }
	deltas := make(map[int64]growthDelta)
	var additions []struct {
		Bucket time.Time `gorm:"column:bucket"`
		Count  int64     `gorm:"column:count"`
	}
	if err := r.db.WithContext(ctx).Model(&models.Device{}).
		Select(fmt.Sprintf("date_trunc('%s', created_at) AS bucket, COUNT(*) AS count", spec.SQLBucket)).
		Where("created_at >= ? AND created_at < ?", start, growthNextBucket(end, interval)).
		Where("NOT EXISTS (SELECT 1 FROM device_lifecycle_events WHERE device_lifecycle_events.device_id = devices.id AND event_type = ?)", models.DeviceLifecycleRegistered).
		Group("bucket").Order("bucket ASC").Scan(&additions).Error; err != nil {
		return nil, err
	}
	for _, addition := range additions {
		key := growthBucketStart(addition.Bucket, interval).UnixNano()
		deltas[key] = growthDelta{active: deltas[key].active + addition.Count, online: deltas[key].online}
	}
	var lifecycle []struct {
		Bucket    time.Time `gorm:"column:bucket"`
		EventType string    `gorm:"column:event_type"`
		Count     int64     `gorm:"column:count"`
	}
	if err := r.db.WithContext(ctx).Model(&models.DeviceLifecycleEvent{}).
		Select(fmt.Sprintf("date_trunc('%s', occurred_at) AS bucket, event_type, COUNT(*) AS count", spec.SQLBucket)).
		Where("occurred_at >= ? AND occurred_at < ?", start, growthNextBucket(end, interval)).
		Group("bucket, event_type").Order("bucket ASC").Scan(&lifecycle).Error; err != nil {
		return nil, err
	}
	for _, event := range lifecycle {
		key := growthBucketStart(event.Bucket, interval).UnixNano()
		delta := deltas[key]
		switch event.EventType {
		case models.DeviceLifecycleRegistered:
			delta.active += event.Count
		case models.DeviceLifecycleDeleted:
			delta.active -= event.Count
		case models.DeviceLifecycleOnline:
			delta.online += event.Count
		case models.DeviceLifecycleOffline:
			delta.online -= event.Count
		}
		deltas[key] = delta
	}
	var untrackedOnline int64
	if err := r.db.WithContext(ctx).Model(&models.Device{}).
		Where("online = ?", true).
		Where("NOT EXISTS (SELECT 1 FROM device_lifecycle_events WHERE device_lifecycle_events.device_id = devices.id AND event_type IN ?)", []string{models.DeviceLifecycleOnline, models.DeviceLifecycleOffline}).
		Count(&untrackedOnline).Error; err != nil {
		return nil, err
	}
	if untrackedOnline > 0 {
		key := end.UnixNano()
		delta := deltas[key]
		delta.online += untrackedOnline
		deltas[key] = delta
	}

	points := make([]DeviceGrowthPoint, 0, spec.Buckets+1)
	buckets := make([]time.Time, 0, spec.Buckets+1)
	for bucket := start; !bucket.After(end); bucket = growthNextBucket(bucket, interval) {
		buckets = append(buckets, bucket)
	}
	for index := len(buckets) - 1; index >= 0; index-- {
		if count < 0 {
			count = 0
		}
		if online < 0 {
			online = 0
		}
		if online > count {
			online = count
		}
		points = append([]DeviceGrowthPoint{{Timestamp: buckets[index], Count: count, Online: online}}, points...)
		if index > 0 {
			delta := deltas[buckets[index].UnixNano()]
			count -= delta.active
			online -= delta.online
		}
	}
	return points, nil
}

func growthBucketStart(value time.Time, interval string) time.Time {
	value = value.UTC()
	switch interval {
	case "hourly":
		return value.Truncate(time.Hour)
	case "daily":
		return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
	case "weekly":
		day := time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
		daysSinceMonday := (int(day.Weekday()) + 6) % 7
		return day.AddDate(0, 0, -daysSinceMonday)
	case "monthly":
		return time.Date(value.Year(), value.Month(), 1, 0, 0, 0, 0, time.UTC)
	case "yearly":
		return time.Date(value.Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
	default:
		return value
	}
}

func growthNextBucket(value time.Time, interval string) time.Time {
	switch interval {
	case "monthly":
		return value.AddDate(0, 1, 0)
	case "yearly":
		return value.AddDate(1, 0, 0)
	default:
		return value.Add(deviceGrowthSpecs[interval].Step)
	}
}

func (r *DeviceRepository) ListForAnalytics(ctx context.Context, maxDevices int) ([]*models.Device, int, error) {
	var total int64
	if err := r.db.WithContext(ctx).Model(&models.Device{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	patterns := []string{"%RXPower%", "%RxPower%", "%Temperature%", "%Temp%", "%UpTime%", "%PONMode%", "%AccessType%", "%TotalAssociations%", "%AssociatedDeviceNumberOfEntries%"}
	query := r.db.WithContext(ctx)
	conditions := make([]string, 0, len(patterns))
	arguments := make([]interface{}, 0, len(patterns))
	for _, pattern := range patterns {
		conditions = append(conditions, "name LIKE ?")
		arguments = append(arguments, pattern)
	}
	preloadArgs := append([]interface{}{"(" + strings.Join(conditions, " OR ") + ")"}, arguments...)
	var devices []*models.Device
	err := query.Preload("Parameters", preloadArgs...).
		Order("last_inform DESC NULLS LAST").
		Limit(maxDevices).
		Find(&devices).Error
	return devices, int(total), err
}

type AnalyticsParameterValue struct {
	DeviceID int64  `gorm:"column:device_id"`
	Name     string `gorm:"column:name"`
	Value    string `gorm:"column:value"`
}

func (r *DeviceRepository) ListParameterValuesForAnalytics(ctx context.Context, pattern string, maxDevices int) ([]AnalyticsParameterValue, int, int, error) {
	var total int64
	if err := r.db.WithContext(ctx).Model(&models.Device{}).Count(&total).Error; err != nil {
		return nil, 0, 0, err
	}
	var deviceIDs []int64
	if err := r.db.WithContext(ctx).Model(&models.Device{}).
		Order("last_inform DESC NULLS LAST").Limit(maxDevices).Pluck("id", &deviceIDs).Error; err != nil {
		return nil, 0, 0, err
	}
	if len(deviceIDs) == 0 {
		return nil, 0, int(total), nil
	}

	pattern = strings.ReplaceAll(pattern, `\`, `\\`)
	pattern = strings.ReplaceAll(pattern, `%`, `\%`)
	pattern = strings.ReplaceAll(pattern, `_`, `\_`)
	pattern = strings.ReplaceAll(pattern, "*", "%")
	var values []AnalyticsParameterValue
	err := r.db.WithContext(ctx).Model(&models.DeviceParameter{}).
		Select("device_id, name, value").
		Where("device_id IN ?", deviceIDs).
		Where("name ILIKE ? ESCAPE '\\'", pattern).
		Order("device_id ASC, name ASC").
		Find(&values).Error
	return values, len(deviceIDs), int(total), err
}

func (r *DeviceRepository) SetTags(ctx context.Context, deviceID int64, tags []string) error {
	device := &models.Device{ID: deviceID, Tags: tags}
	return r.db.WithContext(ctx).Model(device).Select("tags").Updates(device).Error
}

// SetConnCredentials updates the per-device connection-request credential fields.
// password is plaintext; it is encrypted before storage. An empty password clears the field.
func (r *DeviceRepository) SetConnCredentials(ctx context.Context, deviceID int64, mode, username, password string) error {
	updates := map[string]interface{}{
		"conn_cred_mode":     mode,
		"conn_cred_username": username,
	}
	if password != "" {
		enc, err := encryptParameterValue(password)
		if err != nil {
			return err
		}
		updates["conn_cred_password"] = enc
	} else {
		updates["conn_cred_password"] = nil
	}
	return r.db.WithContext(ctx).Model(&models.Device{}).Where("id = ?", deviceID).Updates(updates).Error
}

func (r *DeviceRepository) SetOffline(ctx context.Context, serialNumber string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var device models.Device
		if err := tx.Where("serial_number = ?", serialNumber).First(&device).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if !device.Online {
			return nil
		}
		if err := tx.Create(&models.DeviceLifecycleEvent{DeviceID: device.ID, SerialNumber: device.SerialNumber, EventType: models.DeviceLifecycleOffline, OccurredAt: time.Now()}).Error; err != nil {
			return err
		}
		return tx.Model(&models.Device{}).Where("id = ?", device.ID).Update("online", false).Error
	})
}

func (r *DeviceRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var device models.Device
		if err := tx.First(&device, id).Error; err != nil {
			return err
		}
		var registered models.DeviceLifecycleEvent
		if err := tx.Where("device_id = ? AND event_type = ?", device.ID, models.DeviceLifecycleRegistered).First(&registered).Error; errors.Is(err, gorm.ErrRecordNotFound) {
			if err := tx.Create(&models.DeviceLifecycleEvent{DeviceID: device.ID, SerialNumber: device.SerialNumber, EventType: models.DeviceLifecycleRegistered, OccurredAt: device.CreatedAt}).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if device.Online {
			if err := tx.Create(&models.DeviceLifecycleEvent{DeviceID: device.ID, SerialNumber: device.SerialNumber, EventType: models.DeviceLifecycleOffline, OccurredAt: time.Now()}).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(&models.DeviceLifecycleEvent{
			DeviceID: device.ID, SerialNumber: device.SerialNumber,
			EventType: models.DeviceLifecycleDeleted, OccurredAt: time.Now(),
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("device_id = ?", id).Delete(&models.Task{}).Error; err != nil {
			return err
		}
		if err := tx.Where("device_id = ?", id).Delete(&models.DeviceParameter{}).Error; err != nil {
			return err
		}
		if err := tx.Where("device_id = ?", id).Delete(&models.Fault{}).Error; err != nil {
			return err
		}
		if err := tx.Where("device_id = ?", id).Delete(&models.ProvisioningApplication{}).Error; err != nil {
			return err
		}
		return tx.Delete(&models.Device{}, id).Error
	})
}
