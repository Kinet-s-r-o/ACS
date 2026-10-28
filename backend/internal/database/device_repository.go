package database

import (
	"context"
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

func NewDeviceRepository(db *gorm.DB) *DeviceRepository {
	return &DeviceRepository{db: db}
}

func (r *DeviceRepository) UpsertFromInform(ctx context.Context, device *models.Device) error {
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

	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "serial_number"}},
		DoUpdates: clause.AssignmentColumns(updates),
	}).Create(device).Error
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
		Preload("Parameters", "name LIKE ? OR name LIKE ? OR name LIKE ? OR name = ?", "%RXPower%", "InternetGatewayDevice.WANDevice.%", "Device.IP.%", "InternetGatewayDevice.DeviceInfo.UpTime").
		Order("last_inform DESC NULLS LAST").
		Limit(limit).
		Offset(offset).
		Find(&devices).Error
	if err != nil {
		return nil, 0, err
	}

	return devices, int(total), nil
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
	return r.db.WithContext(ctx).Model(&models.Device{}).
		Where("serial_number = ?", serialNumber).
		Update("online", false).Error
}

func (r *DeviceRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
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
