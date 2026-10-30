package database

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

type DeviceInventoryFilterRule struct {
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type DeviceInventoryColumnFilter struct {
	Logic string                      `json:"logic"`
	Rules []DeviceInventoryFilterRule `json:"rules"`
}

type DeviceInventoryQuery struct {
	Limit            int
	Offset           int
	Search           string
	Sort             string
	Direction        string
	Filters          map[string]DeviceInventoryColumnFilter
	IncludeSensitive bool
}

var inventoryColumns = map[string]bool{
	"serial_number": true, "manufacturer": true, "model": true, "product_class": true,
	"ip_address": true, "ppp_username": true, "rx_power": true, "uptime": true,
	"status": true, "last_inform": true, "tags": true, "software_version": true,
	"hardware_version": true, "manufacturer_oui": true, "active_faults": true, "created_at": true,
}

func ParseDeviceInventoryFilters(value string) (map[string]DeviceInventoryColumnFilter, error) {
	filters := map[string]DeviceInventoryColumnFilter{}
	if value == "" {
		return filters, nil
	}
	if len(value) > 16*1024 {
		return nil, fmt.Errorf("inventory filters are too large")
	}
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&filters); err != nil {
		return nil, err
	}
	if len(filters) > len(inventoryColumns) {
		return nil, fmt.Errorf("too many inventory filters")
	}
	operators := map[string]bool{
		"contains": true, "not_contains": true, "starts_with": true, "ends_with": true,
		"equals": true, "greater_than": true, "greater_than_or_equal": true,
		"less_than": true, "less_than_or_equal": true,
	}
	for column, filter := range filters {
		if !inventoryColumns[column] || (filter.Logic != "all" && filter.Logic != "any") || len(filter.Rules) > 10 {
			return nil, fmt.Errorf("invalid inventory filter")
		}
		for _, rule := range filter.Rules {
			if !operators[rule.Operator] || len(rule.Value) > 256 || strings.TrimSpace(rule.Value) == "" {
				return nil, fmt.Errorf("invalid inventory filter rule")
			}
			if strings.HasPrefix(rule.Operator, "greater_than") || strings.HasPrefix(rule.Operator, "less_than") {
				if column != "rx_power" && column != "uptime" && column != "active_faults" {
					return nil, fmt.Errorf("numeric operator is not supported for this inventory column")
				}
			}
		}
	}
	return filters, nil
}

func (r *DeviceRepository) ListInventory(ctx context.Context, options DeviceInventoryQuery) ([]*models.Device, int, error) {
	if options.Limit < 1 || options.Limit > 500 {
		options.Limit = 50
	}
	if options.Offset < 0 {
		options.Offset = 0
	}
	query := r.db.WithContext(ctx).Model(&models.Device{})
	if search := strings.TrimSpace(options.Search); search != "" {
		searchExpressions := []string{
			`STRPOS(LOWER(COALESCE(devices.serial_number, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(devices.manufacturer, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(devices.model_name, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(devices.product_class, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(devices.ip_address, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(` + inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.SoftwareVersion") + `, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(` + inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.HardwareVersion") + `, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(COALESCE(` + inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.ManufacturerOUI") + `, '')), LOWER(?)) > 0`,
			`STRPOS(LOWER(CAST(` + inventoryActiveFaultsExpression + ` AS TEXT)), LOWER(?)) > 0`,
		}
		args := make([]interface{}, len(searchExpressions))
		for i := range args {
			args[i] = search
		}
		query = query.Where("("+strings.Join(searchExpressions, " OR ")+")", args...)
	}
	for column, filter := range options.Filters {
		if len(filter.Rules) == 0 {
			continue
		}
		expression, err := inventoryFilterExpression(column, options.IncludeSensitive)
		if err != nil {
			return nil, 0, err
		}
		ruleSQL := make([]string, 0, len(filter.Rules))
		args := make([]interface{}, 0, len(filter.Rules)*2)
		for _, rule := range filter.Rules {
			sql, values, err := inventoryRuleSQL(expression, column, rule)
			if err != nil {
				return nil, 0, err
			}
			ruleSQL = append(ruleSQL, sql)
			args = append(args, values...)
		}
		logic := " AND "
		if filter.Logic == "any" {
			logic = " OR "
		}
		query = query.Where("("+strings.Join(ruleSQL, logic)+")", args...)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	sortColumn := options.Sort
	if sortColumn == "" {
		sortColumn = "last_inform"
		options.Direction = "desc"
	}
	sortExpression, ok := inventorySortExpression(sortColumn, options.IncludeSensitive)
	if !ok {
		return nil, 0, fmt.Errorf("invalid inventory sort column")
	}
	direction := strings.ToUpper(options.Direction)
	if direction != "ASC" && direction != "DESC" {
		return nil, 0, fmt.Errorf("invalid inventory sort direction")
	}
	nullOrdering := " NULLS LAST"
	if direction == "ASC" && (sortColumn == "rx_power" || sortColumn == "uptime" || sortColumn == "last_inform") {
		nullOrdering = " NULLS FIRST"
	}
	var devices []*models.Device
	err := query.Select("devices.*, " + inventoryActiveFaultsExpression + " AS active_faults").
		Order(gorm.Expr(sortExpression + " " + direction + nullOrdering)).
		Order("devices.id ASC").Limit(options.Limit).Offset(options.Offset).Find(&devices).Error
	if err != nil {
		return nil, 0, err
	}
	return devices, int(total), nil
}

const inventoryActiveFaultsExpression = `(SELECT COUNT(*) FROM faults WHERE faults.device_id = devices.id AND faults.resolved = FALSE)`

func inventoryParameterExpression(name string) string {
	return `(SELECT dp.value FROM device_parameters dp WHERE dp.device_id = devices.id AND dp.name = '` + strings.ReplaceAll(name, "'", "''") + `' ORDER BY dp.name LIMIT 1)`
}

func inventoryPPPExpression(includeSensitive bool, filter bool) string {
	parameter := `(SELECT dp.value FROM device_parameters dp WHERE dp.device_id = devices.id AND dp.name LIKE '%WANPPPConnection%' AND dp.name LIKE '%Username%' ORDER BY dp.name LIMIT 1)`
	if includeSensitive {
		if filter {
			return `COALESCE(` + parameter + `, '')`
		}
		return `COALESCE(` + parameter + `, '-')`
	}
	if filter {
		return `CASE WHEN EXISTS (SELECT 1 FROM device_parameters dp WHERE dp.device_id = devices.id AND dp.name LIKE '%WANPPPConnection%' AND dp.name LIKE '%Username%') THEN '[REDACTED]' ELSE '' END`
	}
	return `CASE WHEN EXISTS (SELECT 1 FROM device_parameters dp WHERE dp.device_id = devices.id AND dp.name LIKE '%WANPPPConnection%' AND dp.name LIKE '%Username%') THEN '[REDACTED]' ELSE '-' END`
}

func inventoryTagExpression() string {
	return `(SELECT COALESCE(string_agg(COALESCE(td.name, tags.tag_id), ', ' ORDER BY tags.ordinal), '') FROM jsonb_array_elements_text(COALESCE(devices.tags, '[]'::jsonb)) WITH ORDINALITY AS tags(tag_id, ordinal) LEFT JOIN tag_definitions td ON td.id = tags.tag_id)`
}

func inventoryRXExpressions() (string, string) {
	raw := `(SELECT dp.value FROM device_parameters dp WHERE dp.device_id = devices.id AND (dp.name LIKE '%RXPower%' OR dp.name LIKE '%OpticalRxPower%' OR dp.name LIKE '%OpticalReceivedPower%' OR dp.name LIKE '%TransceiverRxPower%' OR dp.name LIKE '%ReceivedPower%') ORDER BY dp.name LIMIT 1)`
	numeric := `CASE WHEN ` + raw + ` ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN (` + raw + `)::double precision END`
	converted := `CASE WHEN (` + numeric + `) <= 0 THEN (` + numeric + `) WHEN (` + numeric + `) < 10000 THEN 10 * ln((` + numeric + `) / 10000) / ln(10) WHEN abs(` + numeric + `) > 100 THEN (` + numeric + `) / 100 ELSE (` + numeric + `) END`
	text := `CASE WHEN ` + raw + ` IS NULL THEN '-' WHEN (` + numeric + `) IS NULL THEN ` + raw + ` ELSE to_char(round((` + converted + `)::numeric, 2), 'FM999999999999990.00') END`
	return text, converted
}

func inventorySortExpression(column string, includeSensitive bool) (string, bool) {
	switch column {
	case "serial_number":
		return "devices.serial_number", true
	case "manufacturer":
		return "COALESCE(devices.manufacturer, '')", true
	case "model":
		return "COALESCE(NULLIF(devices.model_name, ''), devices.product_class, '')", true
	case "product_class":
		return "COALESCE(devices.product_class, '')", true
	case "ip_address":
		return "COALESCE(devices.ip_address, '')", true
	case "ppp_username":
		return inventoryPPPExpression(includeSensitive, false), true
	case "rx_power":
		_, numeric := inventoryRXExpressions()
		return numeric, true
	case "uptime":
		raw := inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.UpTime")
		return `CASE WHEN ` + raw + ` ~ '^[0-9]+([.][0-9]+)?$' THEN (` + raw + `)::double precision END`, true
	case "status":
		return "devices.online", true
	case "last_inform":
		return "devices.last_inform", true
	case "created_at":
		return "devices.created_at", true
	case "tags":
		return inventoryTagExpression(), true
	case "software_version":
		return `COALESCE(` + inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.SoftwareVersion") + `, '-')`, true
	case "hardware_version":
		return `COALESCE(` + inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.HardwareVersion") + `, '-')`, true
	case "manufacturer_oui":
		return `COALESCE(` + inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.ManufacturerOUI") + `, '-')`, true
	case "active_faults":
		return inventoryActiveFaultsExpression, true
	default:
		return "", false
	}
}

func inventoryFilterExpression(column string, includeSensitive bool) (string, error) {
	if !inventoryColumns[column] {
		return "", fmt.Errorf("invalid inventory filter column")
	}
	if column == "ppp_username" {
		return inventoryPPPExpression(includeSensitive, true), nil
	}
	if column == "status" {
		return `CASE WHEN devices.online THEN 'Online' ELSE 'Offline' END`, nil
	}
	if column == "rx_power" {
		text, _ := inventoryRXExpressions()
		return `CASE WHEN ` + text + ` = '-' THEN '' ELSE ` + text + ` END`, nil
	}
	expression, _ := inventorySortExpression(column, includeSensitive)
	switch column {
	case "software_version", "hardware_version", "manufacturer_oui":
		return `NULLIF(` + expression + `, '-')`, nil
	case "uptime":
		return inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.UpTime"), nil
	case "active_faults":
		return "CAST(" + expression + " AS TEXT)", nil
	default:
		return expression, nil
	}
}

func inventoryRuleSQL(expression, column string, rule DeviceInventoryFilterRule) (string, []interface{}, error) {
	if strings.HasPrefix(rule.Operator, "greater_than") || strings.HasPrefix(rule.Operator, "less_than") {
		var numericExpression string
		switch column {
		case "rx_power":
			_, numericExpression = inventoryRXExpressions()
		case "uptime":
			raw := inventoryParameterExpression("InternetGatewayDevice.DeviceInfo.UpTime")
			numericExpression = `CASE WHEN ` + raw + ` ~ '^[0-9]+([.][0-9]+)?$' THEN (` + raw + `)::double precision END`
		case "active_faults":
			numericExpression = inventoryActiveFaultsExpression
		default:
			return "", nil, fmt.Errorf("numeric operator is not supported for this inventory column")
		}
		value, err := strconv.ParseFloat(rule.Value, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return "FALSE", nil, nil
		}
		operator := map[string]string{
			"greater_than": ">", "greater_than_or_equal": ">=", "less_than": "<", "less_than_or_equal": "<=",
		}[rule.Operator]
		return "(" + numericExpression + ") " + operator + " ?", []interface{}{value}, nil
	}
	value := strings.ToLower(rule.Value)
	textExpression := "LOWER(COALESCE((" + expression + ")::text, ''))"
	switch rule.Operator {
	case "contains":
		return "STRPOS(" + textExpression + ", LOWER(?)) > 0", []interface{}{value}, nil
	case "not_contains":
		return "STRPOS(" + textExpression + ", LOWER(?)) = 0", []interface{}{value}, nil
	case "starts_with":
		return "LEFT(" + textExpression + ", LENGTH(?)) = LOWER(?)", []interface{}{rule.Value, value}, nil
	case "ends_with":
		return "RIGHT(" + textExpression + ", LENGTH(?)) = LOWER(?)", []interface{}{rule.Value, value}, nil
	case "equals":
		return textExpression + " = LOWER(?)", []interface{}{value}, nil
	default:
		return "", nil, fmt.Errorf("invalid inventory filter operator")
	}
}
