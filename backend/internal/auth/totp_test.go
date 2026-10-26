package auth

import (
	"encoding/base32"
	"testing"
	"time"
)

func TestTOTPCodeMatchesRFC4226HOTPVector(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	if got := totpCode([]byte("12345678901234567890"), 1); got != "287082" {
		t.Fatalf("totpCode(counter=1) = %s, want 287082 (secret %s)", got, secret)
	}
}

func TestVerifyTOTPAllowsAdjacentTimeWindow(t *testing.T) {
	key := []byte("12345678901234567890")
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(key)
	now := time.Unix(60, 0)
	code := totpCode(key, 1)
	step, ok := VerifyTOTP(secret, code, now)
	if !ok || step != 1 {
		t.Fatalf("VerifyTOTP() = (%d, %t), want (1, true)", step, ok)
	}
	if _, ok := VerifyTOTP(secret, "12x456", now); ok {
		t.Fatal("VerifyTOTP accepted a non-numeric code")
	}
}
