package models

import "fmt"

type TemplateSnapshotSettings struct {
	InitialEnabled           bool `json:"initial_enabled"`
	InitialDelayMinutes      int  `json:"initial_delay_minutes"`
	ScheduledEnabled         bool `json:"scheduled_enabled"`
	ScheduledIntervalMinutes int  `json:"scheduled_interval_minutes"`
}

func (s TemplateSnapshotSettings) Validate() error {
	if s.InitialDelayMinutes < 0 || s.InitialDelayMinutes > 525600 || s.ScheduledIntervalMinutes < 0 || s.ScheduledIntervalMinutes > 525600 || (s.ScheduledEnabled && s.ScheduledIntervalMinutes < 1) {
		return fmt.Errorf("snapshot delays must be whole minutes from 0 to 525600; enabled scheduled snapshots require at least 1 minute")
	}
	return nil
}
