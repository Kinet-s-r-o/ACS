package auth

import (
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

func TestConfiguredSessionLifetimes(t *testing.T) {
	if err := ConfigureJWT("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		provider string
		settings SessionSettings
		want     time.Duration
	}{
		{"", DefaultSessionSettings(), 24 * time.Hour},
		{"local", DefaultSessionSettings(), 24 * time.Hour},
		{"radius", DefaultSessionSettings(), time.Hour},
		{"local", SessionSettings{LocalMinutes: 30, ExternalMinutes: 120}, 30 * time.Minute},
		{"radius", SessionSettings{LocalMinutes: 30, ExternalMinutes: 120}, 2 * time.Hour},
	} {
		token, err := GenerateTokenWithSessionSettings(&models.User{ID: 1, AuthProvider: tc.provider}, tc.settings)
		if err != nil {
			t.Fatal(err)
		}
		claims, err := ValidateToken(token)
		if err != nil {
			t.Fatal(err)
		}
		if got := claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time); got != tc.want {
			t.Fatalf("provider=%q: lifetime=%v, want %v", tc.provider, got, tc.want)
		}
	}
}

func TestSessionSettingsRejectInvalidDurations(t *testing.T) {
	for _, minutes := range []int{-1, 0, 4, MaxSessionMinutes + 1} {
		for _, settings := range []SessionSettings{
			{LocalMinutes: minutes, ExternalMinutes: 60},
			{LocalMinutes: 60, ExternalMinutes: minutes},
		} {
			if _, err := GenerateTokenWithSessionSettings(&models.User{ID: 1}, settings); err == nil {
				t.Fatalf("invalid settings issued a token: %+v", settings)
			}
		}
	}
	for _, minutes := range []int{MinSessionMinutes, MaxSessionMinutes} {
		if err := (SessionSettings{LocalMinutes: minutes, ExternalMinutes: minutes}).Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSessionSettingsDoNotChangeTwoFactorChallengeLifetime(t *testing.T) {
	if err := ConfigureJWT("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	user := &models.User{ID: 1, Username: "operator"}
	if _, err := GenerateTokenWithSessionSettings(user, SessionSettings{LocalMinutes: MaxSessionMinutes, ExternalMinutes: MaxSessionMinutes}); err != nil {
		t.Fatal(err)
	}
	token, err := GenerateTwoFactorChallengeToken(user)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ValidateToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Purpose != "two_factor" || claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time) != 5*time.Minute {
		t.Fatal("session settings changed the two-factor challenge")
	}
}
