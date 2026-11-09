package auth

import (
	"fmt"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

const (
	LocalSessionMinutesSetting    = "session_local_minutes"
	ExternalSessionMinutesSetting = "session_external_minutes"
	MinSessionMinutes             = 5
	MaxSessionMinutes             = 30 * 24 * 60
)

type SessionSettings struct {
	LocalMinutes    int `json:"local_minutes"`
	ExternalMinutes int `json:"external_minutes"`
}

func DefaultSessionSettings() SessionSettings {
	return SessionSettings{LocalMinutes: 24 * 60, ExternalMinutes: 60}
}

func (s SessionSettings) Validate() error {
	if s.LocalMinutes < MinSessionMinutes || s.LocalMinutes > MaxSessionMinutes || s.ExternalMinutes < MinSessionMinutes || s.ExternalMinutes > MaxSessionMinutes {
		return fmt.Errorf("session durations must be whole minutes between %d and %d", MinSessionMinutes, MaxSessionMinutes)
	}
	return nil
}

func GenerateTokenWithSessionSettings(user *models.User, settings SessionSettings) (string, error) {
	if err := settings.Validate(); err != nil {
		return "", err
	}
	if user == nil {
		return "", fmt.Errorf("missing session user")
	}
	minutes := settings.LocalMinutes
	if user.AuthProvider != "" && user.AuthProvider != "local" {
		minutes = settings.ExternalMinutes
	}
	return generateToken(user, "", time.Duration(minutes)*time.Minute)
}
