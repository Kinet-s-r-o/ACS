package models

import (
	"time"
)

// Threshold is a single threshold level with an associated color.
// Thresholds are sorted by value; each threshold marks the start of a band.
type Threshold struct {
	Value float64 `json:"value"`
	Color string  `json:"color"`
}

// MetricDefinition describes a single metric that can be collected from devices.
// DeviceTypeMatch is a glob pattern matched against "Manufacturer/ProductClass".
// Source controls how the metric is collected:
//   - "passive": extracted from Inform parameter lists
//   - "active":  fetched via GetParameterValues on a polling interval
//   - "universal": collected from both sources
type MetricDefinition struct {
	ID                 int64       `json:"id" gorm:"primaryKey;autoIncrement"`
	Name               string      `json:"name" gorm:"not null;uniqueIndex:idx_metric_name_match,priority:1"`
	Description        string      `json:"description"`
	DeviceTypeMatch    string      `json:"device_type_match" gorm:"not null;default:'*';uniqueIndex:idx_metric_name_match,priority:2"`
	ParameterName      string      `json:"parameter_name" gorm:"not null"`
	Unit               string      `json:"unit"`
	Source             string      `json:"source" gorm:"not null;default:'passive'"`
	Active             bool        `json:"active" gorm:"default:true"`
	Group              string      `json:"group" gorm:"default:''"`
	Color              string      `json:"color" gorm:"default:''"`
	Axis               string      `json:"axis" gorm:"default:'left'"`
	Transform          string      `json:"transform" gorm:"default:''"`
	Multiplier         float64     `json:"multiplier" gorm:"default:1"`
	UnitScale          string      `json:"unit_scale" gorm:"default:''"`
	Health             bool        `json:"health" gorm:"default:false"`
	HealthOrder        int         `json:"health_order" gorm:"default:0"`
	HealthSize         string      `json:"health_size" gorm:"not null;default:'small'"`
	WarnThreshold      *float64    `json:"warn_threshold"`
	CriticalThreshold  *float64    `json:"critical_threshold"`
	ThresholdDirection string      `json:"threshold_direction" gorm:"not null;default:'higher_is_worse'"`
	DisplayFormat      string      `json:"display_format" gorm:"not null;default:'number'"`
	GaugeAnimated      bool        `json:"gauge_animated" gorm:"default:true"`
	GaugeMin           *float64    `json:"gauge_min"`
	GaugeMax           *float64    `json:"gauge_max"`
	GaugeArc           string      `json:"gauge_arc" gorm:"not null;default:'270'"`
	GaugePointer       bool        `json:"gauge_pointer" gorm:"default:true"`
	Thresholds         []Threshold `json:"thresholds" gorm:"type:jsonb;serializer:json"`
	ChartType          string      `json:"chart_type" gorm:"not null;default:'line'"`
	CreatedAt          time.Time   `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt          time.Time   `json:"updated_at" gorm:"autoUpdateTime"`
}

func (MetricDefinition) TableName() string {
	return "metric_definitions"
}

// MetricSample is a single time-series data point stored in a TimescaleDB hypertable.
// The composite primary key (device_id, metric_id, timestamp) satisfies the
// TimescaleDB requirement that the PK includes the time column.
type MetricSample struct {
	DeviceID  int64     `json:"device_id" gorm:"primaryKey"`
	MetricID  int64     `json:"metric_id" gorm:"primaryKey"`
	Value     float64   `json:"value" gorm:"not null"`
	Timestamp time.Time `json:"timestamp" gorm:"primaryKey"`
}

func (MetricSample) TableName() string {
	return "metric_samples"
}

// InterfaceMetricDefinition configures collection of a metric for each matching
// interface path on devices resolved to a provisioning template.
type InterfaceMetricDefinition struct {
	ID               int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	TemplateID       int64     `json:"template_id" gorm:"not null;index"`
	Name             string    `json:"name" gorm:"not null;size:128"`
	Description      string    `json:"description"`
	InterfaceType    string    `json:"interface_type" gorm:"not null;size:16"`
	ParameterPattern string    `json:"parameter_pattern" gorm:"not null;size:512"`
	Unit             string    `json:"unit"`
	Transform        string    `json:"transform" gorm:"not null;default:''"`
	Multiplier       float64   `json:"multiplier" gorm:"not null;default:1"`
	Active           bool      `json:"active" gorm:"not null;default:true"`
	CreatedAt        time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt        time.Time `json:"updated_at" gorm:"autoUpdateTime"`
}

func (InterfaceMetricDefinition) TableName() string { return "interface_metric_definitions" }

// InterfaceMetricSample retains the raw cumulative value and concrete parameter
// path so interfaces and their counter history remain distinct.
type InterfaceMetricSample struct {
	DeviceID      int64     `json:"device_id" gorm:"primaryKey"`
	MetricID      int64     `json:"metric_id" gorm:"primaryKey"`
	ParameterName string    `json:"parameter_name" gorm:"primaryKey;size:512"`
	Value         float64   `json:"value" gorm:"not null"`
	Timestamp     time.Time `json:"timestamp" gorm:"primaryKey"`
}

func (InterfaceMetricSample) TableName() string { return "interface_metric_samples" }

// AggregatedMetric is a row returned from a continuous aggregate query.
type AggregatedMetric struct {
	Timestamp time.Time `json:"timestamp"`
	Avg       float64   `json:"avg"`
	Min       float64   `json:"min"`
	Max       float64   `json:"max"`
	Count     int64     `json:"count"`
}
