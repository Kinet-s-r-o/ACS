package database

import (
	"context"
	"fmt"
	"strconv"
)

const (
	settingBulkSummonMaxInFlight = "bulk_summon_max_in_flight"
	settingBulkSummonInterval    = "bulk_summon_interval_seconds"
)

type BulkSummonSettings struct {
	MaxInFlight     int `json:"max_in_flight"`
	IntervalSeconds int `json:"interval_seconds"`
}

func DefaultBulkSummonSettings() BulkSummonSettings {
	return BulkSummonSettings{MaxInFlight: 2, IntervalSeconds: 5}
}

func (r *SettingsRepository) GetBulkSummonSettings(ctx context.Context) (BulkSummonSettings, error) {
	settings := DefaultBulkSummonSettings()
	values, err := r.GetValues(ctx, settingBulkSummonMaxInFlight, settingBulkSummonInterval)
	if err != nil {
		return BulkSummonSettings{}, err
	}
	if raw := values[settingBulkSummonMaxInFlight]; raw != "" {
		settings.MaxInFlight, err = strconv.Atoi(raw)
		if err != nil {
			return BulkSummonSettings{}, fmt.Errorf("invalid stored bulk summon concurrency: %w", err)
		}
	}
	if raw := values[settingBulkSummonInterval]; raw != "" {
		settings.IntervalSeconds, err = strconv.Atoi(raw)
		if err != nil {
			return BulkSummonSettings{}, fmt.Errorf("invalid stored bulk summon interval: %w", err)
		}
	}
	return settings, nil
}

func (r *SettingsRepository) SaveBulkSummonSettings(ctx context.Context, settings BulkSummonSettings) error {
	if settings.MaxInFlight < 1 || settings.MaxInFlight > 20 {
		return fmt.Errorf("max_in_flight must be between 1 and 20")
	}
	if settings.IntervalSeconds < 1 || settings.IntervalSeconds > 300 {
		return fmt.Errorf("interval_seconds must be between 1 and 300")
	}
	return r.SetMultiple(ctx, map[string]string{
		settingBulkSummonMaxInFlight: strconv.Itoa(settings.MaxInFlight),
		settingBulkSummonInterval:    strconv.Itoa(settings.IntervalSeconds),
	})
}
