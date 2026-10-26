package api

import (
	"net/http/httptest"
	"testing"
)

func TestPublicAppLogoURLUsesPublicAPIPathForSameOrigin(t *testing.T) {
	req := httptest.NewRequest("POST", "https://acs.example.com/auth/login", nil)
	req.Header.Set("Origin", "https://acs.example.com")
	got := publicAppLogoURL(req)
	if got != "https://acs.example.com/api/meta/logo" {
		t.Fatalf("publicAppLogoURL() = %q, want same-origin proxy URL", got)
	}
}

func TestPublicAppLogoURLUsesDirectAPIHostForCrossOriginDev(t *testing.T) {
	req := httptest.NewRequest("POST", "http://localhost:7548/auth/login", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	got := publicAppLogoURL(req)
	if got != "http://localhost:7548/meta/logo" {
		t.Fatalf("publicAppLogoURL() = %q, want direct API URL", got)
	}
}
