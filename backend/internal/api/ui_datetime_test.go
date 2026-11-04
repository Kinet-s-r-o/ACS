package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUIDateTimeFormatValidation(t *testing.T) {
	for _, value := range []string{"locale", "dmy", "ymd", "mdy", "iso"} {
		if !validUIDateTimeFormat(value) {
			t.Fatalf("rejected supported format %q", value)
		}
	}
	for _, body := range []string{`{"ui_datetime_format":""}`, `{"ui_datetime_format":"custom"}`, `{"ui_datetime_format":"YYYY"}`} {
		response := httptest.NewRecorder()
		(&Router{}).handleUpdateSettings(response, httptest.NewRequest("PUT", "/settings", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "ui_datetime_format") {
			t.Fatalf("invalid format returned %d: %s", response.Code, response.Body.String())
		}
	}
}
