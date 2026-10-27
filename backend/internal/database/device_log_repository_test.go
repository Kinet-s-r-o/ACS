package database

import "testing"

func TestParseDeviceLogEntries(t *testing.T) {
	value := "2026-10-27 06:10:13 [Notice] SourceId[15] : Get CMP security Rpc.\r\n2026-10-27 06:04:21 [Critical] Terminal:OLT-XML(-),Result:Success,Type:Set\n\nmalformed entry"
	entries := parseDeviceLogEntries(42, value)
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(entries))
	}
	if entries[0].DeviceID != 42 || entries[0].Timestamp != "2026-10-27 06:10:13" || entries[0].Severity != "Notice" || entries[0].Message != "SourceId[15] : Get CMP security Rpc." {
		t.Fatalf("unexpected parsed notice: %#v", entries[0])
	}
	if entries[1].Severity != "Critical" || entries[1].Message != "Terminal:OLT-XML(-),Result:Success,Type:Set" {
		t.Fatalf("unexpected parsed critical entry: %#v", entries[1])
	}
	if entries[2].Timestamp != "" || entries[2].Severity != "" || entries[2].Message != "malformed entry" {
		t.Fatalf("malformed line was not preserved: %#v", entries[2])
	}
	if entries[0].Fingerprint != parseDeviceLogEntries(42, value)[0].Fingerprint {
		t.Fatal("same source line must produce a stable deduplication fingerprint")
	}
}
