package database

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type MetricRepository struct {
	db *gorm.DB
}

func NewMetricRepository(db *gorm.DB) *MetricRepository {
	return &MetricRepository{db: db}
}

// MigrateInterfaceMetricDefinitions moves legacy template metrics into the shared metric catalog.
func MigrateInterfaceMetricDefinitions(ctx context.Context, db *gorm.DB) error {
	var legacy []models.InterfaceMetricDefinition
	if err := db.WithContext(ctx).Find(&legacy).Error; err != nil {
		return err
	}
	for _, old := range legacy {
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var existing models.MetricDefinition
			if err := tx.Where("legacy_interface_id = ?", old.ID).First(&existing).Error; err == nil {
				return copyLegacyInterfaceSamples(tx, old.ID, existing.ID)
			} else if err != gorm.ErrRecordNotFound {
				return err
			}
			var template models.ProvisioningTemplate
			if err := tx.First(&template, old.TemplateID).Error; err != nil {
				return err
			}
			templateID, legacyID := old.TemplateID, old.ID
			def := models.MetricDefinition{
				Name: old.Name, Description: old.Description,
				DeviceTypeMatch: template.Manufacturer + "/" + template.ProductClass,
				TemplateID:      &templateID, InterfaceType: old.InterfaceType,
				ParameterPattern: old.ParameterPattern, Unit: old.Unit, Source: "active",
				Active: old.Active, Group: old.Group, Color: old.Color, Transform: old.Transform,
				Multiplier: old.Multiplier, UnitScale: old.UnitScale, ChartType: old.ChartType,
				LegacyInterfaceID: &legacyID,
			}
			if err := tx.Create(&def).Error; err != nil {
				return err
			}
			return copyLegacyInterfaceSamples(tx, old.ID, def.ID)
		}); err != nil {
			return fmt.Errorf("migrate interface metric %d: %w", old.ID, err)
		}
	}
	return nil
}

// MigrateGlobalMetricDefinitions scopes legacy standard metrics to every template
// matching their former device-type glob.
func MigrateGlobalMetricDefinitions(ctx context.Context, db *gorm.DB) error {
	var templates []models.ProvisioningTemplate
	if err := db.WithContext(ctx).Order("id ASC").Find(&templates).Error; err != nil {
		return err
	}
	var defs []models.MetricDefinition
	if err := db.WithContext(ctx).Where("template_id IS NULL AND parameter_pattern = ''").Order("id ASC").Find(&defs).Error; err != nil {
		return err
	}
	var devices []models.Device
	if err := db.WithContext(ctx).Find(&devices).Error; err != nil {
		return err
	}
	deviceIDsByTemplate := make(map[int64][]int64)
	for _, device := range devices {
		manufacturer, productClass := "", ""
		if device.Manufacturer != nil {
			manufacturer = *device.Manufacturer
		}
		if device.ProductClass != nil {
			productClass = *device.ProductClass
		}
		if template := bestMatchingTemplate(templates, manufacturer, productClass); template != nil {
			deviceIDsByTemplate[template.ID] = append(deviceIDsByTemplate[template.ID], device.ID)
		}
	}
	winners := make(map[int64][]models.ProvisioningTemplate)
	for _, template := range templates {
		deviceType := template.Manufacturer + "/" + template.ProductClass
		bestByName := make(map[string]models.MetricDefinition)
		for _, def := range defs {
			if !deviceTypeMatches(deviceType, def.DeviceTypeMatch) {
				continue
			}
			score := metricMatchSpecificity(def.DeviceTypeMatch)
			current, exists := bestByName[def.Name]
			if !exists || score > metricMatchSpecificity(current.DeviceTypeMatch) || score == metricMatchSpecificity(current.DeviceTypeMatch) && def.ID > current.ID {
				bestByName[def.Name] = def
			}
		}
		for _, winner := range bestByName {
			winners[winner.ID] = append(winners[winner.ID], template)
		}
	}
	for _, original := range defs {
		matches := winners[original.ID]
		if len(matches) == 0 {
			continue
		}
		for i, template := range matches {
			templateID := template.ID
			scope := template.Manufacturer + "/" + template.ProductClass
			if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
				var existing models.MetricDefinition
				if err := tx.Where("template_id = ? AND parameter_pattern = '' AND name = ?", templateID, original.Name).First(&existing).Error; err == nil {
					return nil
				} else if err != gorm.ErrRecordNotFound {
					return err
				}
				if i == 0 {
					return tx.Model(&models.MetricDefinition{}).Where("id = ?", original.ID).Updates(map[string]any{"template_id": templateID, "device_type_match": scope}).Error
				}
				clone := original
				clone.ID = 0
				clone.TemplateID = &templateID
				clone.DeviceTypeMatch = scope
				if err := tx.Create(&clone).Error; err != nil {
					return err
				}
				deviceIDs := deviceIDsByTemplate[templateID]
				if len(deviceIDs) == 0 {
					return nil
				}
				return tx.Exec(`INSERT INTO metric_samples (device_id, metric_id, value, timestamp)
					SELECT device_id, ?, value, timestamp FROM metric_samples WHERE metric_id = ? AND device_id IN ?
					ON CONFLICT (device_id, metric_id, timestamp) DO NOTHING`, clone.ID, original.ID, deviceIDs).Error
			}); err != nil {
				return fmt.Errorf("scope metric %d to template %d: %w", original.ID, templateID, err)
			}
		}
	}
	return nil
}

func metricMatchSpecificity(pattern string) int {
	score := 0
	for _, char := range pattern {
		if char != '*' && char != '?' && char != '[' {
			score++
		}
	}
	return score
}

func bestMatchingTemplate(templates []models.ProvisioningTemplate, manufacturer, productClass string) *models.ProvisioningTemplate {
	var best *models.ProvisioningTemplate
	for i := range templates {
		template := &templates[i]
		if template.Manufacturer != "" && !strings.EqualFold(template.Manufacturer, manufacturer) || template.ProductClass != "" && !strings.EqualFold(template.ProductClass, productClass) {
			continue
		}
		if best == nil || template.SpecificityScore() > best.SpecificityScore() {
			best = template
		}
	}
	return best
}

func copyLegacyInterfaceSamples(tx *gorm.DB, oldID, newID int64) error {
	return tx.Exec(`INSERT INTO interface_metric_samples (device_id, metric_id, parameter_name, value, timestamp)
		SELECT device_id, ?, parameter_name, value, timestamp FROM interface_metric_samples WHERE metric_id = ?
		ON CONFLICT (device_id, metric_id, parameter_name, timestamp) DO NOTHING`, newID, oldID).Error
}

// ListActive returns all active metric definitions.
func (r *MetricRepository) ListActive(ctx context.Context) ([]models.MetricDefinition, error) {
	var defs []models.MetricDefinition
	err := r.db.WithContext(ctx).Where("active = ? AND template_id IS NULL", true).Order("name ASC").Find(&defs).Error
	return defs, err
}

// ListAll returns all metric definitions (for the settings UI).
func (r *MetricRepository) ListAll(ctx context.Context) ([]models.MetricDefinition, error) {
	var defs []models.MetricDefinition
	err := r.db.WithContext(ctx).Where("template_id IS NULL").Order("name ASC").Find(&defs).Error
	return defs, err
}

func (r *MetricRepository) ListTemplateMetrics(ctx context.Context, templateID int64) ([]models.MetricDefinition, error) {
	var defs []models.MetricDefinition
	err := r.db.WithContext(ctx).Where("template_id = ? AND parameter_pattern = ''", templateID).Order("name ASC").Find(&defs).Error
	return defs, err
}

func (r *MetricRepository) TemplateMetricsForDevice(ctx context.Context, deviceType string, activeOnly bool) ([]models.MetricDefinition, error) {
	template, err := r.TemplateForDeviceType(ctx, deviceType)
	if err != nil {
		return nil, err
	}
	query := r.db.WithContext(ctx).Where("template_id = ? AND parameter_pattern = ''", template.ID)
	if activeOnly {
		query = query.Where("active = ?", true)
	}
	var defs []models.MetricDefinition
	err = query.Order("id ASC").Find(&defs).Error
	return defs, err
}

func (r *MetricRepository) TemplateForDeviceType(ctx context.Context, deviceType string) (*models.ProvisioningTemplate, error) {
	parts := strings.SplitN(deviceType, "/", 2)
	manufacturer, productClass := "", ""
	if len(parts) > 0 {
		manufacturer = parts[0]
	}
	if len(parts) > 1 {
		productClass = parts[1]
	}
	var template models.ProvisioningTemplate
	err := r.db.WithContext(ctx).Where("(manufacturer = '' OR LOWER(manufacturer) = LOWER(?)) AND (product_class = '' OR LOWER(product_class) = LOWER(?))", manufacturer, productClass).
		Order("(CASE WHEN manufacturer <> '' THEN 1 ELSE 0 END + CASE WHEN product_class <> '' THEN 1 ELSE 0 END) DESC, id ASC").First(&template).Error
	return &template, err
}

// Create inserts a new metric definition.
func (r *MetricRepository) Create(ctx context.Context, def *models.MetricDefinition) error {
	return r.db.WithContext(ctx).Create(def).Error
}

// Update modifies an existing metric definition.
func (r *MetricRepository) Update(ctx context.Context, def *models.MetricDefinition) error {
	return r.db.WithContext(ctx).Save(def).Error
}

// Delete removes a metric definition by ID.
func (r *MetricRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Delete(&models.MetricDefinition{}, id).Error
}

// BatchInsert inserts metric samples in batches of 500.
func (r *MetricRepository) BatchInsert(ctx context.Context, samples []models.MetricSample) error {
	if len(samples) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(&samples, 500).Error
}

// storeThrottledSample checks the latest stored sample across CWMP sessions and
// serializes writes for the same device and metric on PostgreSQL.
func (r *MetricRepository) storeThrottledSample(ctx context.Context, deviceID, metricID int64, parameterName string, intervalSeconds int, now time.Time, sample any) error {
	table := "metric_samples"
	if parameterName != "" {
		table = "interface_metric_samples"
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if tx.Dialector.Name() == "postgres" {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?, ?)", int32(deviceID), int32(metricID)).Error; err != nil {
				return err
			}
		}
		query := tx.Table(table).Select("timestamp").Where("device_id = ? AND metric_id = ?", deviceID, metricID)
		if parameterName != "" {
			query = query.Where("parameter_name = ?", parameterName)
		}
		var latest struct{ Timestamp time.Time }
		err := query.Order("timestamp DESC").Take(&latest).Error
		if err != nil && err != gorm.ErrRecordNotFound {
			return err
		}
		if err == nil && !sampleIntervalElapsed(now, latest.Timestamp, intervalSeconds) {
			return nil
		}
		return tx.Create(sample).Error
	})
}

func sampleIntervalElapsed(now, previous time.Time, intervalSeconds int) bool {
	return now.Sub(previous) >= time.Duration(intervalSeconds)*time.Second
}

func (r *MetricRepository) InterfaceActiveParamNames(ctx context.Context, deviceID int64, deviceType string) ([]string, error) {
	defs, err := r.interfaceMetricDefinitions(ctx, deviceType, true)
	if err != nil || len(defs) == 0 {
		return nil, err
	}
	var params []models.DeviceParameter
	if err := r.db.WithContext(ctx).Select("name").Where("device_id = ?", deviceID).Find(&params).Error; err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var names []string
	for _, p := range params {
		for _, def := range defs {
			if def.Source != "active" && def.Source != "universal" {
				continue
			}
			if interfacePathMatches(def.ParameterPattern, p.Name) && !seen[p.Name] {
				names = append(names, p.Name)
				seen[p.Name] = true
				break
			}
		}
	}
	return names, nil
}

func (r *MetricRepository) InterfaceMetricParamNamesForTemplate(ctx context.Context, deviceID, templateID int64) ([]string, error) {
	var defs []models.MetricDefinition
	if err := r.db.WithContext(ctx).Where("template_id = ? AND active = ? AND parameter_pattern <> ''", templateID, true).Find(&defs).Error; err != nil || len(defs) == 0 {
		return nil, err
	}
	var names []string
	if err := r.db.WithContext(ctx).Model(&models.DeviceParameter{}).Where("device_id = ?", deviceID).Pluck("name", &names).Error; err != nil {
		return nil, err
	}
	matched := make([]string, 0)
	for _, name := range names {
		for _, def := range defs {
			if interfacePathMatches(def.ParameterPattern, name) {
				matched = append(matched, name)
				break
			}
		}
	}
	return matched, nil
}

func (r *MetricRepository) InterfaceMetricDefinitionsForDevice(ctx context.Context, deviceType string) ([]models.MetricDefinition, error) {
	return r.interfaceMetricDefinitions(ctx, deviceType, true)
}

func (r *MetricRepository) ExtractAndStoreInterface(ctx context.Context, deviceID int64, deviceType string, paramMap map[string]string) error {
	defs, err := r.interfaceMetricDefinitions(ctx, deviceType, true)
	if err != nil || len(defs) == 0 {
		return err
	}
	now := time.Now()
	var samples []models.InterfaceMetricSample
	for _, def := range defs {
		for name, value := range paramMap {
			if !interfacePathMatches(def.ParameterPattern, name) {
				continue
			}
			fv, parseErr := strconv.ParseFloat(value, 64)
			if parseErr != nil || math.IsNaN(fv) || math.IsInf(fv, 0) {
				continue
			}
			sample := models.InterfaceMetricSample{DeviceID: deviceID, MetricID: def.ID, ParameterName: name, Value: fv, Timestamp: now}
			if def.MinSampleIntervalSeconds > 0 {
				if err := r.storeThrottledSample(ctx, deviceID, def.ID, name, def.MinSampleIntervalSeconds, now, &sample); err != nil {
					return err
				}
				continue
			}
			samples = append(samples, sample)
		}
	}
	if len(samples) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(&samples, 500).Error
}

func (r *MetricRepository) QueryInterfaceMetric(ctx context.Context, deviceID, metricID int64, parameterName string, from, to time.Time, rate bool, multiplier float64) ([]models.InterfaceMetricSample, error) {
	var samples []models.InterfaceMetricSample
	query := `SELECT device_id, metric_id, parameter_name, value * $5 AS value, timestamp FROM interface_metric_samples WHERE device_id = $1 AND metric_id = $2 AND parameter_name = $3 AND timestamp BETWEEN $4 AND $6 ORDER BY timestamp ASC`
	if rate {
		query = `WITH samples AS (SELECT device_id, metric_id, parameter_name, value, timestamp, LAG(value) OVER (PARTITION BY parameter_name ORDER BY timestamp) AS previous_value, LAG(timestamp) OVER (PARTITION BY parameter_name ORDER BY timestamp) AS previous_time FROM interface_metric_samples WHERE device_id = $1 AND metric_id = $2 AND parameter_name = $3 AND timestamp <= $6) SELECT device_id, metric_id, parameter_name, CASE WHEN previous_value IS NULL OR value < previous_value THEN 0 ELSE (value - previous_value) / GREATEST(EXTRACT(EPOCH FROM (timestamp - previous_time)), 1) * $5 END AS value, timestamp FROM samples WHERE timestamp BETWEEN $4 AND $6 ORDER BY timestamp ASC`
	}
	err := r.db.WithContext(ctx).Raw(query, deviceID, metricID, parameterName, from, multiplier, to).Scan(&samples).Error
	return samples, err
}

func (r *MetricRepository) interfaceMetricDefinitions(ctx context.Context, deviceType string, activeOnly bool) ([]models.MetricDefinition, error) {
	template, err := r.TemplateForDeviceType(ctx, deviceType)
	if err != nil {
		return nil, err
	}
	query := r.db.WithContext(ctx).Where("template_id = ? AND parameter_pattern <> ''", template.ID)
	if activeOnly {
		query = query.Where("active = ?", true)
	}
	var defs []models.MetricDefinition
	err = query.Order("id ASC").Find(&defs).Error
	return defs, err
}

func interfacePathMatches(pattern, name string) bool {
	patternParts, nameParts := strings.Split(pattern, "."), strings.Split(name, ".")
	if len(patternParts) != len(nameParts) {
		return false
	}
	for i := range patternParts {
		if patternParts[i] != "*" && patternParts[i] != nameParts[i] {
			return false
		}
	}
	return true
}

// GetByID returns a single metric definition by its ID.
func (r *MetricRepository) GetByID(ctx context.Context, id int64) (*models.MetricDefinition, error) {
	var def models.MetricDefinition
	err := r.db.WithContext(ctx).First(&def, id).Error
	if err != nil {
		return nil, err
	}
	return &def, nil
}

// QueryRawRate returns raw metric samples with rate (delta/time) computed via LAG().
// Counter resets (value < previous) are clamped to 0.
func (r *MetricRepository) QueryRawRate(ctx context.Context, deviceID, metricID int64, from, to time.Time, multiplier float64) ([]models.MetricSample, error) {
	var samples []models.MetricSample
	query := `
		SELECT timestamp,
			CASE
				WHEN LAG(value) OVER w IS NULL THEN 0
				WHEN value < LAG(value) OVER w THEN 0
				ELSE (value - LAG(value) OVER w)
					 / GREATEST(EXTRACT(EPOCH FROM (timestamp - LAG(timestamp) OVER w)), 1)
					 * $4
			END AS value
		FROM metric_samples
		WHERE device_id = $1 AND metric_id = $2 AND timestamp BETWEEN $3 AND (
			SELECT MAX(timestamp) FROM metric_samples WHERE device_id = $1 AND metric_id = $2 AND timestamp BETWEEN $3 AND $5
		)
		WINDOW w AS (ORDER BY timestamp)
		ORDER BY timestamp ASC`
	err := r.db.WithContext(ctx).Raw(query, deviceID, metricID, from, multiplier, to).Scan(&samples).Error
	return samples, err
}

// QueryAggregatedRate returns aggregated metric data with rate computed as
// (max_value - min_value) / bucket_duration * multiplier.
func (r *MetricRepository) QueryAggregatedRate(ctx context.Context, deviceID, metricID int64, from, to time.Time, bucket string, multiplier float64) ([]models.AggregatedMetric, error) {
	table := caTableForBucket(bucket)
	if table == "" {
		return nil, fmt.Errorf("unsupported bucket: %s", bucket)
	}
	var duration float64
	switch bucket {
	case "5min":
		duration = 300
	case "1h":
		duration = 3600
	case "1d":
		duration = 86400
	default:
		return nil, fmt.Errorf("unsupported bucket: %s", bucket)
	}
	var rows []models.AggregatedMetric
	query := fmt.Sprintf(`
		SELECT time_bucket AS "timestamp",
			GREATEST(max_value - min_value, 0) / $4 * $5 AS "avg",
			0 AS "min",
			0 AS "max",
			0 AS "count"
		FROM %s
		WHERE device_id = $1 AND metric_id = $2 AND time_bucket BETWEEN $3 AND $6
		ORDER BY time_bucket ASC`, table)
	err := r.db.WithContext(ctx).Raw(query, deviceID, metricID, from, duration, multiplier, to).Scan(&rows).Error
	return rows, err
}

// QueryRaw returns metric samples with the definition multiplier applied.
func (r *MetricRepository) QueryRaw(ctx context.Context, deviceID, metricID int64, from, to time.Time, multiplier float64) ([]models.MetricSample, error) {
	var samples []models.MetricSample
	query := `
		SELECT timestamp, value * $5 AS value
		FROM metric_samples
		WHERE device_id = $1 AND metric_id = $2 AND timestamp BETWEEN $3 AND $4
		ORDER BY timestamp ASC`
	err := r.db.WithContext(ctx).Raw(query, deviceID, metricID, from, to, multiplier).Scan(&samples).Error
	return samples, err
}

// ExtractAndStore matches parameters against active metric definitions for a device
// and stores any numeric values found. deviceType is "Manufacturer/ProductClass".
func (r *MetricRepository) ExtractAndStore(ctx context.Context, deviceID int64, deviceType string, paramMap map[string]string) error {
	if err := r.extractStandard(ctx, deviceID, deviceType, paramMap); err != nil {
		return err
	}
	return r.ExtractAndStoreInterface(ctx, deviceID, deviceType, paramMap)
}

func (r *MetricRepository) extractStandard(ctx context.Context, deviceID int64, deviceType string, paramMap map[string]string) error {
	defs, err := r.TemplateMetricsForDevice(ctx, deviceType, true)
	if err != nil || len(defs) == 0 {
		return err
	}

	now := time.Now()
	var samples []models.MetricSample
	throttled := 0
	matched := 0
	missed := 0

	for _, def := range defs {
		matched++
		value, ok := paramMap[def.ParameterName]
		if !ok || value == "" {
			missed++
			log.Printf("Metric %q (id=%d): parameter %q not found in %d Inform params for device %d (%s)",
				def.Name, def.ID, def.ParameterName, len(paramMap), deviceID, deviceType)
			continue
		}
		fv, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(fv) || math.IsInf(fv, 0) {
			missed++
			log.Printf("Metric %q (id=%d): value %q for param %q is not numeric", def.Name, def.ID, value, def.ParameterName)
			continue
		}
		if !def.StoresHistory() {
			continue
		}
		sample := models.MetricSample{
			DeviceID:  deviceID,
			MetricID:  def.ID,
			Value:     fv,
			Timestamp: now,
		}
		if def.MinSampleIntervalSeconds > 0 {
			if err := r.storeThrottledSample(ctx, deviceID, def.ID, "", def.MinSampleIntervalSeconds, now, &sample); err != nil {
				return err
			}
			throttled++
			continue
		}
		samples = append(samples, sample)
	}

	if len(samples) == 0 {
		if matched > 0 && throttled == 0 {
			log.Printf("No metric samples stored for device %d (%s): %d defs matched device type, %d params available, %d missed",
				deviceID, deviceType, matched, len(paramMap), missed)
		}
		return nil
	}
	if err := r.BatchInsert(ctx, samples); err != nil {
		return fmt.Errorf("batch insert metric samples: %w", err)
	}
	log.Printf("Stored %d metric samples for device %d", len(samples), deviceID)
	return nil
}

// ReserveDueActiveMetricParams returns due GPV paths and persists their request
// time before the CWMP request is sent. A device lock prevents overlapping
// sessions from reserving the same metric concurrently.
func (r *MetricRepository) ReserveDueActiveMetricParams(ctx context.Context, deviceID int64, deviceType string, defaultInterval time.Duration) ([]string, error) {
	template, err := r.TemplateForDeviceType(ctx, deviceType)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var defs []models.MetricDefinition
	if err := r.db.WithContext(ctx).Where("template_id = ? AND active = ? AND source IN ?", template.ID, true, []string{"active", "universal"}).Order("id ASC").Find(&defs).Error; err != nil || len(defs) == 0 {
		return nil, err
	}
	var names []string
	err = r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if tx.Dialector.Name() == "postgres" {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", deviceID).Error; err != nil {
				return err
			}
		}
		ids := make([]int64, 0, len(defs))
		for _, def := range defs {
			ids = append(ids, def.ID)
		}
		var states []models.MetricPollState
		if err := tx.Where("device_id = ? AND metric_id IN ?", deviceID, ids).Find(&states).Error; err != nil {
			return err
		}
		lastRequest := make(map[int64]time.Time, len(states))
		for _, state := range states {
			lastRequest[state.MetricID] = state.LastRequestedAt
		}
		now := time.Now()
		var due []models.MetricDefinition
		needsInterfaceNames := false
		for _, def := range defs {
			if !metricPollDue(now, lastRequest[def.ID], def.GPVPollIntervalSeconds, defaultInterval) {
				continue
			}
			due = append(due, def)
			needsInterfaceNames = needsInterfaceNames || def.ParameterPattern != ""
		}
		var interfaceNames []string
		if needsInterfaceNames {
			if err := tx.Model(&models.DeviceParameter{}).Where("device_id = ?", deviceID).Pluck("name", &interfaceNames).Error; err != nil {
				return err
			}
		}
		seen := make(map[string]bool)
		var reserved []models.MetricPollState
		for _, def := range due {
			var matched []string
			if def.ParameterPattern == "" && def.ParameterName != "" {
				matched = []string{def.ParameterName}
			} else if def.ParameterPattern != "" {
				for _, name := range interfaceNames {
					if interfacePathMatches(def.ParameterPattern, name) {
						matched = append(matched, name)
					}
				}
			}
			if len(matched) == 0 {
				continue
			}
			for _, name := range matched {
				if !seen[name] {
					names = append(names, name)
					seen[name] = true
				}
			}
			reserved = append(reserved, models.MetricPollState{DeviceID: deviceID, MetricID: def.ID, LastRequestedAt: now})
		}
		if len(reserved) == 0 {
			return nil
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "device_id"}, {Name: "metric_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"last_requested_at"}),
		}).Create(&reserved).Error
	})
	if err != nil {
		return nil, err
	}
	return names, nil
}

func (r *MetricRepository) ReserveDueParameterPolls(ctx context.Context, deviceID int64, deviceType string) ([]string, error) {
	template, err := r.TemplateForDeviceType(ctx, deviceType)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var defs []models.ParameterPollDefinition
	if err := r.db.WithContext(ctx).Where("template_id = ? AND active = ?", template.ID, true).Order("id ASC").Find(&defs).Error; err != nil || len(defs) == 0 {
		return nil, err
	}
	var parameterNames []string
	err = r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if tx.Dialector.Name() == "postgres" {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", deviceID).Error; err != nil {
				return err
			}
		}
		ids := make([]int64, 0, len(defs))
		for _, def := range defs {
			ids = append(ids, def.ID)
		}
		var states []models.ParameterPollState
		if err := tx.Where("device_id = ? AND definition_id IN ?", deviceID, ids).Find(&states).Error; err != nil {
			return err
		}
		lastRequest := make(map[int64]time.Time, len(states))
		for _, state := range states {
			lastRequest[state.DefinitionID] = state.LastRequestedAt
		}
		now := time.Now()
		var due []models.ParameterPollDefinition
		needsDiscovery := false
		for _, def := range defs {
			if !def.Now && now.Sub(lastRequest[def.ID]) < time.Duration(def.IntervalSeconds)*time.Second {
				continue
			}
			due = append(due, def)
			needsDiscovery = needsDiscovery || strings.Contains(def.ParameterPattern, "*")
		}
		if needsDiscovery {
			if err := tx.Model(&models.DeviceParameter{}).Where("device_id = ?", deviceID).Pluck("name", &parameterNames).Error; err != nil {
				return err
			}
		}
		requested := make(map[string]bool)
		var reserved []models.ParameterPollState
		for _, def := range due {
			matched := false
			if !strings.Contains(def.ParameterPattern, "*") {
				requested[def.ParameterPattern] = true
				matched = true
			} else {
				for _, name := range parameterNames {
					if interfacePathMatches(def.ParameterPattern, name) {
						requested[name] = true
						matched = true
					}
				}
			}
			if matched {
				reserved = append(reserved, models.ParameterPollState{DeviceID: deviceID, DefinitionID: def.ID, LastRequestedAt: now})
			}
		}
		if len(reserved) == 0 {
			return nil
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "device_id"}, {Name: "definition_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"last_requested_at"}),
		}).Create(&reserved).Error; err != nil {
			return err
		}
		parameterNames = parameterNames[:0]
		for name := range requested {
			parameterNames = append(parameterNames, name)
		}
		sort.Strings(parameterNames)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return parameterNames, nil
}

func metricPollDue(now, lastRequest time.Time, intervalSeconds int, defaultInterval time.Duration) bool {
	interval := defaultInterval
	if intervalSeconds > 0 {
		interval = time.Duration(intervalSeconds) * time.Second
	}
	return now.Sub(lastRequest) >= interval
}

// ActiveParamNames returns the parameter names needed for active metric collection
// for a given device type.
func (r *MetricRepository) ActiveParamNames(ctx context.Context, deviceType string) ([]string, error) {
	defs, err := r.TemplateMetricsForDevice(ctx, deviceType, true)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var names []string
	for _, def := range defs {
		if def.Source != "active" && def.Source != "universal" {
			continue
		}
		if !seen[def.ParameterName] {
			seen[def.ParameterName] = true
			names = append(names, def.ParameterName)
		}
	}
	return names, nil
}

// PassiveParamNames returns the parameter names collected passively (from Inform)
// for a given device type.
func (r *MetricRepository) PassiveParamNames(ctx context.Context, deviceType string) ([]string, error) {
	defs, err := r.TemplateMetricsForDevice(ctx, deviceType, true)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var names []string
	for _, def := range defs {
		if def.Source != "passive" && def.Source != "universal" {
			continue
		}
		if !seen[def.ParameterName] {
			seen[def.ParameterName] = true
			names = append(names, def.ParameterName)
		}
	}
	return names, nil
}

// QueryAggregated returns aggregated metric data with the definition multiplier
// applied from a continuous aggregate table for a device within a time range.
func (r *MetricRepository) QueryAggregated(ctx context.Context, deviceID, metricID int64, from, to time.Time, bucket string, multiplier float64) ([]models.AggregatedMetric, error) {
	table := caTableForBucket(bucket)
	if table == "" {
		return nil, fmt.Errorf("unsupported bucket: %s", bucket)
	}
	var rows []models.AggregatedMetric
	query := fmt.Sprintf(`
		SELECT time_bucket AS "timestamp", avg_value * $5 AS "avg", min_value * $5 AS "min", max_value * $5 AS "max", sample_count AS "count"
		FROM %s
		WHERE device_id = $1 AND metric_id = $2 AND time_bucket BETWEEN $3 AND $4
		ORDER BY time_bucket ASC`, table)
	err := r.db.WithContext(ctx).Raw(query, deviceID, metricID, from, to, multiplier).Scan(&rows).Error
	return rows, err
}

// deviceTypeMatches checks whether a device type string matches a glob pattern.
// Matching is case-insensitive: both the device type and the pattern are
// lowercased before comparison, mirroring the case-insensitive template→device
// resolution (LOWER() in SQL) so metric collection stays consistent with how
// templates are scoped to devices.
func deviceTypeMatches(deviceType, pattern string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	matched, _ := path.Match(strings.ToLower(pattern), strings.ToLower(deviceType))
	return matched
}

// caTableForBucket maps a bucket name to its continuous aggregate table.
func caTableForBucket(bucket string) string {
	switch bucket {
	case "5min":
		return "metric_samples_5min"
	case "1h":
		return "metric_samples_1h"
	case "1d":
		return "metric_samples_1d"
	default:
		return ""
	}
}

// SetupTimescaleDB creates the TimescaleDB extension, hypertable, continuous
// aggregates, retention policies, and compression policy. It also attempts to
// enable optional pg_stat_statements query tracking.
func SetupTimescaleDB(db *gorm.DB) error {
	statements := []string{
		`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE`,
		`SELECT create_hypertable('metric_samples', 'timestamp', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day')`,
		`SELECT create_hypertable('interface_metric_samples', 'timestamp', if_not_exists => TRUE, migrate_data => TRUE, chunk_time_interval => INTERVAL '1 day')`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS metric_samples_5min
		 WITH (timescaledb.continuous) AS
		 SELECT
			time_bucket(INTERVAL '5 minutes', "timestamp") AS time_bucket,
			device_id,
			metric_id,
			AVG(value)  AS avg_value,
			MIN(value)  AS min_value,
			MAX(value)  AS max_value,
			COUNT(*)    AS sample_count
		 FROM metric_samples
		 GROUP BY time_bucket, device_id, metric_id`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS metric_samples_1h
		 WITH (timescaledb.continuous) AS
		 SELECT
			time_bucket(INTERVAL '1 hour', "timestamp") AS time_bucket,
			device_id,
			metric_id,
			AVG(value)  AS avg_value,
			MIN(value)  AS min_value,
			MAX(value)  AS max_value,
			COUNT(*)    AS sample_count
		 FROM metric_samples
		 GROUP BY time_bucket, device_id, metric_id`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS metric_samples_1d
		 WITH (timescaledb.continuous) AS
		 SELECT
			time_bucket(INTERVAL '1 day', "timestamp") AS time_bucket,
			device_id,
			metric_id,
			AVG(value)  AS avg_value,
			MIN(value)  AS min_value,
			MAX(value)  AS max_value,
			COUNT(*)    AS sample_count
		 FROM metric_samples
		 GROUP BY time_bucket, device_id, metric_id`,
		// The settings-driven housekeeping worker owns retention for these tables.
		`SELECT remove_retention_policy('metric_samples', if_exists => TRUE)`,
		`SELECT remove_retention_policy('interface_metric_samples', if_exists => TRUE)`,
		`SELECT remove_retention_policy('metric_samples_5min', if_exists => TRUE)`,
		`SELECT remove_retention_policy('metric_samples_1h', if_exists => TRUE)`,
		`SELECT remove_retention_policy('metric_samples_1d', if_exists => TRUE)`,
		`ALTER TABLE metric_samples SET (
			timescaledb.compress = TRUE,
			timescaledb.compress_segmentby = 'device_id, metric_id',
			timescaledb.compress_orderby = 'timestamp DESC'
		)`,
		`ALTER TABLE interface_metric_samples SET (
			timescaledb.compress = TRUE,
			timescaledb.compress_segmentby = 'device_id, metric_id, parameter_name',
			timescaledb.compress_orderby = 'timestamp DESC'
		)`,

		// Continuous aggregate refresh policies — without these the CAs stay empty.
		`SELECT add_continuous_aggregate_policy('metric_samples_5min', start_offset => INTERVAL '7 days', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE)`,
		`SELECT add_continuous_aggregate_policy('metric_samples_1h', start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`,
		`SELECT add_continuous_aggregate_policy('metric_samples_1d', start_offset => INTERVAL '365 days', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 day', if_not_exists => TRUE)`,
	}

	for _, stmt := range statements {
		if err := db.Exec(stmt).Error; err != nil {
			return fmt.Errorf("timescaledb setup: %w", err)
		}
	}
	if err := db.Exec(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).Error; err != nil {
		log.Printf("WARNING: pg_stat_statements is unavailable; query statistics will be disabled: %v", err)
	}
	log.Println("TimescaleDB setup completed (hypertable, CAs, retention, compression)")

	// One-time backfill: refresh any data that accumulated before the policy existed.
	// Non-fatal — a fresh DB or lock contention should not prevent startup.
	for _, ca := range []string{"metric_samples_5min", "metric_samples_1h", "metric_samples_1d"} {
		if err := db.Exec(fmt.Sprintf("SELECT refresh_continuous_aggregate('%s', NULL, NULL)", ca)).Error; err != nil {
			log.Printf("WARNING: backfill %s failed (non-fatal): %v", ca, err)
		}
	}
	return nil
}
