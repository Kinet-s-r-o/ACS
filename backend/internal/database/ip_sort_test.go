package database

import (
	"encoding/json"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestIPAddressSortPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	pool, _ := db.DB()
	t.Cleanup(func() { pool.Close() })
	expression := ipAddressSortExpression("ip")
	for _, value := range []string{
		"10.161.0.3", "255.255.255.255", "0.0.0.0", " 10.0.0.1 ",
		"::", "::1", "2001:db8::10", "1:2:3:4:5:6:7:8", "1::", "1:2:3:4:5:6:7::",
		"::ffff:192.0.2.1", "::192.0.2.1", "1:2:3:4:5:6:192.0.2.1",
		"", "-", "hostname", "999.1.1.1", "1.2.3", "01.2.3.4", "1.2.3.4/24",
		"1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8::", "1:::2", "::ffff:999.1.1.1", "fe80::1%eth0",
	} {
		t.Run(value, func(t *testing.T) {
			var valid bool
			if err := db.Raw("SELECT ("+expression+") IS NOT NULL FROM (VALUES (?::text)) AS addresses(ip)", value).Scan(&valid).Error; err != nil {
				t.Fatal(err)
			}
			addr, err := netip.ParseAddr(strings.TrimSpace(value))
			want := err == nil && addr.Zone() == ""
			if valid != want {
				t.Fatalf("valid = %v, want %v", valid, want)
			}
		})
	}
	values := []string{"10.161.0.10", "10.161.0.3", "10.161.1.2", "10.161.0.100", "2001:db8::10", "2001:db8::2", "-", ""}
	encoded, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		direction string
		want      []string
	}{
		{"ASC", []string{"10.161.0.3", "10.161.0.10", "10.161.0.100", "10.161.1.2", "2001:db8::2", "2001:db8::10", "-", ""}},
		{"DESC", []string{"2001:db8::10", "2001:db8::2", "10.161.1.2", "10.161.0.100", "10.161.0.10", "10.161.0.3", "-", ""}},
	} {
		for _, offset := range []int{0, 2, 4, 6} {
			var got []string
			err := db.Raw("SELECT ip FROM jsonb_array_elements_text(?::jsonb) WITH ORDINALITY AS addresses(ip, ordinal) ORDER BY "+expression+" "+scenario.direction+" NULLS LAST, ordinal LIMIT 2 OFFSET ?", string(encoded), offset).Scan(&got).Error
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, scenario.want[offset:offset+2]) {
				t.Fatalf("%s offset %d: got %v, want %v", scenario.direction, offset, got, scenario.want[offset:offset+2])
			}
		}
	}
}
