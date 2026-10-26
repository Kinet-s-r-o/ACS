package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

func GenerateTOTPSecret() (string, error) {
	secret := make([]byte, 20)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret), nil
}

func VerifyTOTP(secret, code string, now time.Time) (int64, bool) {
	code = strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(code))
	if len(code) != 6 {
		return 0, false
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return 0, false
		}
	}
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimRight(secret, "=")))
	if err != nil || len(key) == 0 {
		return 0, false
	}
	current := now.Unix() / 30
	for step := current - 1; step <= current+1; step++ {
		if step < 0 {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(totpCode(key, step)), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

func totpCode(key []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	// SHA-1 is required by the TOTP standard for compatibility with authenticator apps.
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	hash := mac.Sum(nil)
	offset := hash[len(hash)-1] & 0x0f
	value := (uint32(hash[offset])&0x7f)<<24 |
		(uint32(hash[offset+1])&0xff)<<16 |
		(uint32(hash[offset+2])&0xff)<<8 |
		(uint32(hash[offset+3]) & 0xff)
	return fmt.Sprintf("%06d", value%1_000_000)
}
