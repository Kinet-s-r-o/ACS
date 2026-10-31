package database

import (
	"context"
	"fmt"
	"strconv"
)

const (
	settingBulkSummonMaxInFlight    = "bulk_summon_max_in_flight"
	settingBulkSummonInterval       = "bulk_summon_interval_seconds"
	settingBulkSummonContactTimeout = "bulk_summon_contact_timeout_seconds"
)

type BulkSummonSettings struct {
	MaxInFlight           int `json:"max_in_flight"`
	IntervalSeconds       int `json:"interval_seconds"`
	ContactTimeoutSeconds int `json:"contact_timeout_seconds"`
}

func DefaultBulkSummonSettings() BulkSummonSettings {
	return BulkSummonSettings{MaxInFlight: 2, IntervalSeconds: 5, ContactTimeoutSeconds: 120}
}

func (r *SettingsRepository) GetBulkSummonSettings(ctx context.Context) (BulkSummonSettings, error) {
	settings := DefaultBulkSummonSettings()
	values, err := r.GetValues(ctx, settingBulkSummonMaxInFlight, settingBulkSummonInterval, settingBulkSummonContactTimeout)
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
	if raw := values[settingBulkSummonContactTimeout]; raw != "" {
		settings.ContactTimeoutSeconds, err = strconv.Atoi(raw)
		if err != nil {
			return BulkSummonSettings{}, fmt.Errorf("invalid stored bulk summon contact timeout: %w", err)
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
	if settings.ContactTimeoutSeconds < 10 || settings.ContactTimeoutSeconds > 3600 {
		return fmt.Errorf("contact_timeout_seconds must be between 10 and 3600")
	}
	return r.SetMultiple(ctx, map[string]string{
		settingBulkSummonMaxInFlight:    strconv.Itoa(settings.MaxInFlight),
		settingBulkSummonInterval:       strconv.Itoa(settings.IntervalSeconds),
		settingBulkSummonContactTimeout: strconv.Itoa(settings.ContactTimeoutSeconds),
	})
}
