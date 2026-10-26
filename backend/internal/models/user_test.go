package models

import (
	"sync"
	"testing"

	"gorm.io/gorm/schema"
)

func TestRequired2FAUsesDatabaseColumnName(t *testing.T) {
	parsed, err := schema.Parse(&User{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.LookUpField("Required2FA").DBName; got != "required_2fa" {
		t.Fatalf("Required2FA column = %q, want required_2fa", got)
	}
}
