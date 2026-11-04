package database

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/matrix8412/acs/internal/cwmpcontrol"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

const cwmpControlSetting = "cwmp_communication_state"

type CWMPControlStore struct{ settings *SettingsRepository }

func NewCWMPControlStore(settings *SettingsRepository) *CWMPControlStore {
	return &CWMPControlStore{settings: settings}
}

func (s *CWMPControlStore) Load(ctx context.Context) (cwmpcontrol.State, error) {
	setting, err := s.settings.Get(ctx, cwmpControlSetting)
	if err != nil {
		return cwmpcontrol.State{}, err
	}
	if setting == nil {
		return cwmpcontrol.State{Enabled: true}, nil
	}
	var stored struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.Unmarshal([]byte(setting.Value), &stored); err != nil || stored.Enabled == nil {
		return cwmpcontrol.State{}, fmt.Errorf("invalid persisted CWMP communication state")
	}
	var state cwmpcontrol.State
	if err := json.Unmarshal([]byte(setting.Value), &state); err != nil {
		return state, err
	}
	return state, nil
}

func (s *CWMPControlStore) Save(ctx context.Context, state cwmpcontrol.State) error {
	value, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return s.settings.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		settings := NewSettingsRepository(tx)
		previous, err := NewCWMPControlStore(settings).Load(ctx)
		if err != nil {
			return err
		}
		if state.Enabled && !previous.Enabled && previous.UpdatedAt != nil && state.UpdatedAt != nil {
			// Waiting jobs must not time out solely because communications were paused.
			if err := tx.Model(&models.SystemTask{}).Where("status IN ?", []models.SystemTaskStatus{models.SystemTaskStatusProcessing, models.SystemTaskStatusWaiting}).
				Updates(map[string]interface{}{
					"started_at":    gorm.Expr("started_at + (?::timestamptz - GREATEST(started_at, ?::timestamptz))", state.UpdatedAt, previous.UpdatedAt),
					"dispatched_at": gorm.Expr("dispatched_at + (?::timestamptz - GREATEST(dispatched_at, ?::timestamptz))", state.UpdatedAt, previous.UpdatedAt),
				}).Error; err != nil {
				return err
			}
		}
		return settings.SetMultiple(ctx, map[string]string{cwmpControlSetting: string(value)})
	})
}
