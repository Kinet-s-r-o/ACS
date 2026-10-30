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

func EnsureAnalyticsParameterIndex(ctx context.Context, db *gorm.DB) error {
	if db.Dialector.Name() != "postgres" {
		return nil
	}
	db = db.WithContext(ctx)
	var index struct{ Valid bool }
	result := db.Raw(`SELECT indisvalid AS valid FROM pg_index
		WHERE indexrelid = to_regclass('idx_device_parameters_name_trgm')`).Scan(&index)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected > 0 && !index.Valid {
		// An interrupted concurrent build leaves an unusable index with the same name.
		if err := db.Exec(`DROP INDEX CONCURRENTLY IF EXISTS idx_device_parameters_name_trgm`).Error; err != nil {
			return err
		}
	}
	if err := db.Exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).Error; err != nil {
		return fmt.Errorf("enable pg_trgm for parameter search: %w", err)
	}
	var extensionSchema string
	if err := db.Raw(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
		WHERE e.extname = 'pg_trgm'`).Scan(&extensionSchema).Error; err != nil {
		return err
	}
	operatorClass := `"` + strings.ReplaceAll(extensionSchema, `"`, `""`) + `".gin_trgm_ops`
	if err := db.Exec(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_parameters_name_trgm
		ON device_parameters USING gin (name ` + operatorClass + `)`).Error; err != nil {
		return err
	}
	if err := db.Exec(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_parameters_device_updated
		ON device_parameters (device_id, updated_at DESC, name) INCLUDE (value)`).Error; err != nil {
		return err
	}
	return db.Exec(`ANALYZE device_parameters (name)`).Error
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
	query := r.db.WithContext(ctx).Table("wan_interfaces AS w").Joins("JOIN devices AS d ON d.id = w.device_id")
	expressions := map[string]string{"serial_number": "d.serial_number", "name": "w.name", "type": "w.type", "status": "w.status", "ip_address": "w.ip_address", "mac_address": "w.mac_address"}
	query = applySearchTerms(query, search, []string{"d.serial_number", "w.name", "w.type", "w.status", "w.ip_address", "w.mac_address"})
	var err error
	query, err = ApplyTableColumnFilters(query, filters, expressions, nil)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	sortColumns := map[string]string{"serial_number": "d.serial_number", "name": "w.name", "type": "w.type", "status": "w.status", "ip_address": "w.ip_address", "mac_address": "w.mac_address"}
	order := sortColumns[sortColumn]
	if order == "" {
		order, direction = "d.serial_number", "asc"
	}
	if direction != "asc" && direction != "desc" {
		return nil, 0, fmt.Errorf("invalid WAN interface sort direction")
	}
	var interfaces []models.WANInterface
	err = query.Select("d.serial_number, w.name, w.type, w.status, w.ip_address, w.mac_address").
		Order(order + " " + strings.ToUpper(direction)).Order("w.device_id, w.path").Limit(limit).Offset(offset).Scan(&interfaces).Error
	return interfaces, int(total), err
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

type FleetAnalyticsDevice struct {
	Manufacturer *string    `gorm:"column:manufacturer"`
	ProductClass *string    `gorm:"column:product_class"`
	ModelName    *string    `gorm:"column:model_name"`
	LastInform   *time.Time `gorm:"column:last_inform"`
	RxPowerValue *string    `gorm:"column:rx_power_value"`
	Temperature  *string    `gorm:"column:temperature_value"`
	Uptime       *string    `gorm:"column:uptime_value"`
	AccessType   *string    `gorm:"column:access_type_value"`
	WifiStations int64      `gorm:"column:wifi_stations"`
}

const analyticsIntegerValuePattern = `^([+-]{0,1})[0-9]+$`

func (r *DeviceRepository) ListForAnalytics(ctx context.Context, maxDevices int) ([]FleetAnalyticsDevice, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	query := `WITH sampled_devices AS MATERIALIZED (
		SELECT id, manufacturer, product_class, model_name, last_inform
		FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?
	), matching_parameters AS MATERIALIZED (
		SELECT p.device_id, p.name, p.value, p.updated_at
		FROM device_parameters p JOIN sampled_devices d ON d.id = p.device_id
		WHERE p.name LIKE '%TotalAssociations%' OR p.name LIKE '%AssociatedDeviceNumberOfEntries%'
			OR p.name LIKE '%RXPower%' OR p.name LIKE '%RxPower%' OR p.name LIKE '%Temp%'
			OR p.name LIKE '%UpTime' OR p.name LIKE '%PONMode%' OR p.name LIKE '%AccessType%'
	), numeric_parameters AS MATERIALIZED (
		SELECT * FROM matching_parameters p
		WHERE CASE WHEN LENGTH(BTRIM(p.value)) <= 256 AND BTRIM(p.value) ~ ?
			THEN BTRIM(p.value)::numeric BETWEEN '-1.7976931348623157e308'::numeric AND '1.7976931348623157e308'::numeric
			ELSE FALSE END
	), selected_values AS (
		SELECT DISTINCT ON (p.device_id, metric.kind) p.device_id, metric.kind, p.value
		FROM numeric_parameters p
		CROSS JOIN LATERAL (VALUES
			('rx', p.name LIKE '%RXPower%' OR p.name LIKE '%RxPower%'),
			('temp', p.name LIKE '%Temp%'),
			('uptime', p.name LIKE '%UpTime')
		) metric(kind, matches)
		WHERE metric.matches
		ORDER BY p.device_id, metric.kind, p.updated_at DESC, p.name
	), device_values AS (
		SELECT device_id,
			MAX(value) FILTER (WHERE kind = 'rx') AS rx_power_value,
			MAX(value) FILTER (WHERE kind = 'temp') AS temperature_value,
			MAX(value) FILTER (WHERE kind = 'uptime') AS uptime_value
		FROM selected_values GROUP BY device_id
	), station_counts AS (
		SELECT p.device_id, SUM(CASE
			WHEN LENGTH(BTRIM(p.value)) <= 20 AND BTRIM(p.value) ~ ? THEN
				CASE WHEN BTRIM(p.value)::numeric BETWEEN '-9223372036854775808'::numeric AND '9223372036854775807'::numeric
					THEN BTRIM(p.value)::bigint ELSE 0 END
			ELSE 0 END) AS wifi_stations
		FROM matching_parameters p
		WHERE p.name LIKE '%TotalAssociations%' OR p.name LIKE '%AssociatedDeviceNumberOfEntries%'
		GROUP BY p.device_id
	), access_types AS (
		SELECT DISTINCT ON (p.device_id) p.device_id, p.value
		FROM matching_parameters p
		WHERE (p.name LIKE '%PONMode%' OR p.name LIKE '%AccessType%') AND p.value <> ''
		ORDER BY p.device_id, p.updated_at DESC, p.name
	)
	SELECT d.manufacturer, d.product_class, d.model_name, d.last_inform,
		v.rx_power_value, v.temperature_value, v.uptime_value, access_type.value AS access_type_value,
		COALESCE(station_counts.wifi_stations, 0) AS wifi_stations
	FROM sampled_devices d
	LEFT JOIN device_values v ON v.device_id = d.id
	LEFT JOIN station_counts ON station_counts.device_id = d.id
	LEFT JOIN access_types access_type ON access_type.device_id = d.id`
	var devices []FleetAnalyticsDevice
	args := []interface{}{maxDevices, analyticsNumericValuePattern, analyticsIntegerValuePattern}
	err := r.db.WithContext(ctx).Raw(query, args...).Scan(&devices).Error
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := r.db.WithContext(ctx).Model(&models.Device{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	return devices, int(total), nil
}

type AnalyticsDistributionThreshold struct {
	Label string
	Max   *float64
}

const analyticsNumericValuePattern = `^([+-]{0,1})([0-9]+(\.[0-9]*){0,1}|\.[0-9]+)([eE][+-]{0,1}[0-9]{1,3}){0,1}$`

type AnalyticsDistributionRow struct {
	Label   *string `gorm:"column:label"`
	Count   int     `gorm:"column:count"`
	Sampled int     `gorm:"column:sampled"`
	Total   int     `gorm:"column:total"`
}

func (r *DeviceRepository) GetCategoricalAnalytics(ctx context.Context, source, parameterPattern string, maxDevices, limit int) (map[string]int, error) {
	if maxDevices < 1 {
		maxDevices = 10000
	}
	if limit < 1 || limit > 100 {
		limit = 10
	}
	queries := map[string]string{
		"manufacturer": `WITH sampled AS (SELECT manufacturer AS value FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?)
			SELECT COALESCE(NULLIF(BTRIM(value), ''), 'Unknown') AS label, COUNT(*) AS count
			FROM sampled GROUP BY 1 ORDER BY count DESC, label LIMIT ?`,
		"product_class": `WITH sampled AS (SELECT COALESCE(NULLIF(product_class, ''), model_name) AS value FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?)
			SELECT COALESCE(NULLIF(BTRIM(value), ''), 'Unknown') AS label, COUNT(*) AS count
			FROM sampled GROUP BY 1 ORDER BY count DESC, label LIMIT ?`,
		"access_type": `WITH sampled AS (SELECT id FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?), latest AS (
			SELECT DISTINCT ON (p.device_id) p.device_id, p.value
			FROM device_parameters p JOIN sampled s ON s.id = p.device_id
			WHERE p.name LIKE '%PONMode%' OR p.name LIKE '%AccessType%'
			ORDER BY p.device_id, p.updated_at DESC, p.name
		) SELECT CASE WHEN UPPER(latest.value) LIKE '%GPON%' THEN 'GPON' WHEN UPPER(latest.value) LIKE '%EPON%' THEN 'EPON'
			WHEN UPPER(latest.value) LIKE '%ETH%' THEN 'Ethernet' ELSE 'Other' END AS label,
			COUNT(*) AS count FROM sampled LEFT JOIN latest ON latest.device_id = sampled.id GROUP BY 1 ORDER BY count DESC, label LIMIT ?`,
		"parameter": `WITH sampled AS MATERIALIZED (
			SELECT id FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?
		), latest AS MATERIALIZED (
			SELECT DISTINCT ON (p.device_id) p.device_id, NULLIF(BTRIM(p.value), '') AS value
			FROM device_parameters p JOIN sampled s ON s.id = p.device_id
			WHERE p.name ILIKE ? ESCAPE '!'
				AND p.name NOT ILIKE '%password%' AND p.name NOT ILIKE '%passphrase%'
				AND p.name NOT ILIKE '%presharedkey%' AND p.name NOT ILIKE '%pre_shared_key%'
				AND p.name NOT ILIKE '%privatekey%' AND p.name NOT ILIKE '%secret%'
				AND p.name NOT ILIKE '%connectionrequestusername%' AND p.name NOT ILIKE '%.username'
				AND p.value NOT LIKE 'enc:v1:%' AND LENGTH(BTRIM(p.value)) <= 128
			ORDER BY p.device_id, p.updated_at DESC, p.name
		)
		SELECT COALESCE(latest.value, 'Unknown') AS label, COUNT(*) AS count
		FROM sampled s LEFT JOIN latest ON latest.device_id = s.id
		GROUP BY 1 ORDER BY count DESC, label LIMIT ?`,
	}
	query, ok := queries[source]
	if !ok {
		return nil, fmt.Errorf("invalid analytics category source")
	}
	args := []interface{}{maxDevices}
	if source == "parameter" {
		parameterPattern = strings.NewReplacer("!", "!!", "%", "!%", "_", "!_", "*", "%").Replace(parameterPattern)
		args = append(args, parameterPattern)
	}
	args = append(args, limit)
	rows, err := r.db.WithContext(ctx).Raw(query, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]int)
	for rows.Next() {
		var label string
		var count int
		if err := rows.Scan(&label, &count); err != nil {
			return nil, err
		}
		result[label] = count
	}
	return result, rows.Err()
}

func (r *DeviceRepository) GetRecencyAnalytics(ctx context.Context, maxDevices int) (map[string]int, error) {
	if maxDevices < 1 {
		maxDevices = 10000
	}
	query := `SELECT CASE WHEN last_inform IS NULL OR NOW() - last_inform >= INTERVAL '30 days' THEN 'Offline >30d'
		WHEN NOW() - last_inform >= INTERVAL '7 days' THEN 'Offline >7d'
		WHEN NOW() - last_inform >= INTERVAL '1 day' THEN 'Offline >1d'
		WHEN NOW() - last_inform >= INTERVAL '1 hour' THEN 'Offline >1h'
		WHEN NOW() - last_inform >= INTERVAL '30 minutes' THEN 'Offline >30m'
		ELSE 'Online' END AS label, COUNT(*) AS count
		FROM (SELECT last_inform FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?) sampled
		GROUP BY 1 ORDER BY count DESC, label`
	rows, err := r.db.WithContext(ctx).Raw(query, maxDevices).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]int)
	for rows.Next() {
		var label string
		var count int
		if err := rows.Scan(&label, &count); err != nil {
			return nil, err
		}
		result[label] = count
	}
	return result, rows.Err()
}

func (r *DeviceRepository) GetParameterDistribution(ctx context.Context, pattern string, maxDevices int, thresholds []AnalyticsDistributionThreshold) ([]AnalyticsDistributionRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	pattern = strings.NewReplacer("!", "!!", "%", "!%", "_", "!_", "*", "%").Replace(pattern)
	caseParts := make([]string, 0, len(thresholds))
	args := []interface{}{maxDevices, pattern, analyticsNumericValuePattern}
	for _, threshold := range thresholds {
		if threshold.Max == nil {
			caseParts = append(caseParts, "ELSE ?")
			args = append(args, threshold.Label)
			continue
		}
		caseParts = append(caseParts, "WHEN value <= ? THEN ?")
		args = append(args, *threshold.Max, threshold.Label)
	}
	if len(caseParts) == 0 || thresholds[len(thresholds)-1].Max != nil {
		return nil, fmt.Errorf("analytics distribution requires an unbounded final threshold")
	}

	query := `WITH sampled_devices AS MATERIALIZED (
		SELECT id FROM devices ORDER BY last_inform DESC NULLS LAST LIMIT ?
	), selected_values AS MATERIALIZED (
		SELECT sd.id AS device_id, latest.name,
			BTRIM(latest.value)::numeric::double precision AS value
		FROM sampled_devices sd
		CROSS JOIN LATERAL (
			SELECT dp.name, dp.value
			FROM device_parameters dp
			WHERE dp.device_id = sd.id
				AND dp.name ILIKE ? ESCAPE '!'
				AND dp.name NOT ILIKE '%password%'
				AND dp.name NOT ILIKE '%passphrase%'
				AND dp.name NOT ILIKE '%presharedkey%'
				AND dp.name NOT ILIKE '%pre_shared_key%'
				AND dp.name NOT ILIKE '%privatekey%'
				AND dp.name NOT ILIKE '%secret%'
				AND dp.name NOT ILIKE '%connectionrequestusername%'
				AND dp.name NOT ILIKE '%.username'
				AND CASE WHEN LENGTH(BTRIM(dp.value)) <= 256 AND BTRIM(dp.value) ~ ?
					THEN BTRIM(dp.value)::numeric BETWEEN '-1.7976931348623157e308'::numeric AND '1.7976931348623157e308'::numeric
					ELSE FALSE END
			ORDER BY dp.updated_at DESC, dp.name
			LIMIT 1
		) latest
	), normalized_values AS (
		SELECT device_id, name, value
		FROM selected_values
		WHERE value IS NOT NULL
	), normalized_values_with_units AS (
		SELECT device_id, name,
			CASE
				WHEN LOWER(name) LIKE '%rxpower%' AND value > 0 AND value < 10000 THEN 10 * LN(value / 10000.0) / LN(10.0)
				WHEN LOWER(name) LIKE '%rxpower%' AND value > 100 THEN value / 100.0
				WHEN (LOWER(name) LIKE '%temperature%' OR LOWER(name) LIKE '%temp%') AND value > 1000 THEN value / 256.0
				WHEN (LOWER(name) LIKE '%temperature%' OR LOWER(name) LIKE '%temp%') AND value > 100 THEN value / 10.0
				ELSE value
			END AS value
		FROM normalized_values
	), bucketed AS (
		SELECT CASE ` + strings.Join(caseParts, " ") + ` END AS label FROM normalized_values_with_units
	), bucket_counts AS (
		SELECT label, COUNT(*) AS count FROM bucketed GROUP BY label
	)
	SELECT label, count, 0::bigint AS sampled, 0::bigint AS total FROM bucket_counts
	UNION ALL
	SELECT NULL::text AS label, 0::bigint AS count,
		(SELECT COUNT(*) FROM sampled_devices) AS sampled,
		(SELECT COUNT(*) FROM devices) AS total`
	var rows []AnalyticsDistributionRow
	err := r.db.WithContext(ctx).Raw(query, args...).Scan(&rows).Error
	return rows, err
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
		if err := tx.Where("device_id = ?", id).Delete(&models.WANInterfaceRecord{}).Error; err != nil {
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
