package api

import (
	"crypto/tls"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/auth"
)

func TestRefreshIntervalSettingsRejectInvalidValues(t *testing.T) {
	for _, body := range []string{
		`{"overview_poll_interval":"0m"}`,
		`{"overview_poll_interval":"25h"}`,
		`{"full_tree_poll_interval":"8d"}`,
		`{"full_tree_poll_interval":"bad"}`,
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("PUT", "/settings", strings.NewReader(body))
		(&Router{}).handleUpdateSettings(recorder, request)
		if recorder.Code != 400 {
			t.Errorf("settings %s returned %d, want 400", body, recorder.Code)
		}
	}
}

func TestSameOrigin(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")

	direct := httptest.NewRequest("GET", "http://acs.example.test:7548/health", nil)
	if !isSameOrigin(direct, "http://acs.example.test:7548") {
		t.Fatal("direct same-origin request was rejected")
	}
	if isSameOrigin(direct, "https://evil.example.test") {
		t.Fatal("cross-origin request was accepted")
	}

	proxied := httptest.NewRequest("GET", "http://acs.example.test:8080/api/health", nil)
	proxied.RemoteAddr = "127.0.0.1:41234"
	proxied.Header.Set("X-Forwarded-Proto", "http")
	if !isSameOrigin(proxied, "http://acs.example.test:8080") {
		t.Fatal("trusted reverse-proxy origin was rejected")
	}

	untrusted := httptest.NewRequest("GET", "http://acs.example.test/health", nil)
	untrusted.RemoteAddr = "203.0.113.10:41234"
	untrusted.Header.Set("X-Forwarded-Proto", "https")
	if isSameOrigin(untrusted, "https://acs.example.test") {
		t.Fatal("untrusted forwarded protocol was accepted")
	}

	tlsRequest := httptest.NewRequest("GET", "https://acs.example.test/health", nil)
	tlsRequest.TLS = &tls.ConnectionState{}
	if !isSameOrigin(tlsRequest, "https://acs.example.test") {
		t.Fatal("TLS same-origin request was rejected")
	}
}

func TestValidUsername(t *testing.T) {
	for _, username := range []string{"net.admin", "operator-1", "noc_user"} {
		if !validUsername(username) {
			t.Fatalf("valid username %q rejected", username)
		}
	}
	for _, username := range []string{"x", "bad user", "operator/../../admin"} {
		if validUsername(username) {
			t.Fatalf("invalid username %q accepted", username)
		}
	}
}

func TestClientIPOnlyTrustsConfiguredProxy(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	trusted := httptest.NewRequest("GET", "/", nil)
	trusted.RemoteAddr = "127.0.0.1:1234"
	trusted.Header.Set("X-Forwarded-For", "203.0.113.66, 198.51.100.25, 127.0.0.1")
	if got := clientIP(trusted); got != "198.51.100.25" {
		t.Fatalf("trusted proxy address not used: %q", got)
	}

	untrusted := httptest.NewRequest("GET", "/", nil)
	untrusted.RemoteAddr = "203.0.113.9:1234"
	untrusted.Header.Set("X-Forwarded-For", "198.51.100.25")
	if got := clientIP(untrusted); got != "203.0.113.9" {
		t.Fatalf("untrusted proxy spoofed client address: %q", got)
	}
}

func TestAdminWebClientAllowlist(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	router := &Router{adminWebNetworks: parseAllowedNetworks("192.0.2.0/24,198.51.100.10")}

	allowed := httptest.NewRequest("POST", "/auth/login", nil)
	allowed.RemoteAddr = "127.0.0.1:1234"
	allowed.Header.Set("X-Forwarded-For", "192.0.2.25, 127.0.0.1")
	if !router.isAdminWebClientAllowed(allowed) {
		t.Fatal("allowed administrator network was rejected")
	}

	denied := httptest.NewRequest("POST", "/auth/login", nil)
	denied.RemoteAddr = "127.0.0.1:1234"
	denied.Header.Set("X-Forwarded-For", "203.0.113.25, 127.0.0.1")
	if router.isAdminWebClientAllowed(denied) {
		t.Fatal("unallowed administrator network was accepted")
	}

	spoofed := httptest.NewRequest("POST", "/auth/login", nil)
	spoofed.RemoteAddr = "203.0.113.50:1234"
	spoofed.Header.Set("X-Forwarded-For", "192.0.2.25")
	if router.isAdminWebClientAllowed(spoofed) {
		t.Fatal("untrusted client spoofed the administrator network")
	}
}

func TestAdminWebClientAllowlistEmptyAllowsAll(t *testing.T) {
	router := &Router{}
	request := httptest.NewRequest("POST", "/auth/login", nil)
	request.RemoteAddr = "203.0.113.50:1234"
	if !router.isAdminWebClientAllowed(request) {
		t.Fatal("empty administrator allowlist rejected a client")
	}
}

func TestAdminWebAccessMiddlewareRejectsDisallowedClient(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	router := &Router{adminWebNetworks: parseAllowedNetworks("192.0.2.0/24")}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := router.adminWebAccessMiddleware(next)

	request := httptest.NewRequest("GET", "/auth/me", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Forwarded-For", "203.0.113.25, 127.0.0.1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("disallowed client returned %d, want %d", recorder.Code, http.StatusForbidden)
	}

	allowed := httptest.NewRequest("GET", "/auth/me", nil)
	allowed.RemoteAddr = "127.0.0.1:1234"
	allowed.Header.Set("X-Forwarded-For", "192.0.2.25, 127.0.0.1")
	allowedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(allowedRecorder, allowed)
	if allowedRecorder.Code != http.StatusNoContent {
		t.Fatalf("allowed client returned %d, want %d", allowedRecorder.Code, http.StatusNoContent)
	}
}

func TestFirmwareTokenUsesCryptographicEntropy(t *testing.T) {
	token, err := newFirmwareToken()
	if err != nil {
		t.Fatalf("newFirmwareToken: %v", err)
	}
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("expected a 32-byte hex token, got %q", token)
	}
}

func TestLoginLimiter(t *testing.T) {
	limiter := newLoginLimiter(2, time.Hour)
	for attempt := 0; attempt < 2; attempt++ {
		if !limiter.Allow("192.0.2.1") {
			t.Fatal("valid attempt rejected")
		}
	}
	if limiter.Allow("192.0.2.1") {
		t.Fatal("rate limit was not enforced")
	}
	limiter.Reset("192.0.2.1")
	if !limiter.Allow("192.0.2.1") {
		t.Fatal("reset did not clear attempts")
	}
}

func TestLoginLimiterHasBoundedMemory(t *testing.T) {
	limiter := newLoginLimiter(1, time.Hour)
	for index := 0; index < maxLimiterEntries; index++ {
		if !limiter.Allow(strconv.Itoa(index)) {
			t.Fatalf("entry %d rejected before the cap", index)
		}
	}
	if limiter.Allow("over-cap") {
		t.Fatal("limiter accepted an entry beyond its memory cap")
	}
}

func TestCSRFMiddlewareRequiresMatchingTokenForMutation(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := csrfMiddleware(next)

	missing := httptest.NewRequest(http.MethodPost, "/settings", nil)
	missingRecorder := httptest.NewRecorder()
	handler.ServeHTTP(missingRecorder, missing)
	if missingRecorder.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF token returned %d", missingRecorder.Code)
	}

	valid := httptest.NewRequest(http.MethodPost, "/settings", nil)
	valid.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "csrf-value"})
	valid.Header.Set(csrfHeaderName, "csrf-value")
	validRecorder := httptest.NewRecorder()
	handler.ServeHTTP(validRecorder, valid)
	if validRecorder.Code != http.StatusNoContent {
		t.Fatalf("valid CSRF token returned %d", validRecorder.Code)
	}
}

func TestCSRFTokenIsCryptographicallyRandom(t *testing.T) {
	first, err := newCSRFToken()
	if err != nil || len(first) < 40 {
		t.Fatalf("unexpected CSRF token: %q, %v", first, err)
	}
	second, err := newCSRFToken()
	if err != nil || first == second {
		t.Fatalf("CSRF tokens were not unique: %q and %q", first, second)
	}
}

func TestSessionCookiesUseHttpOnlyForAuthenticationOnly(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	req := httptest.NewRequest(http.MethodPost, "http://acs.example.test/auth/login", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	setSessionCookies(recorder, req, "session-value", "csrf-value")
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("expected two session cookies, got %d", len(cookies))
	}
	for _, cookie := range cookies {
		if !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("cookie %q is missing secure SameSite attributes: %#v", cookie.Name, cookie)
		}
		if cookie.Name == auth.SessionCookieName && !cookie.HttpOnly {
			t.Fatal("authentication cookie is not HttpOnly")
		}
		if cookie.Name == csrfCookieName && cookie.HttpOnly {
			t.Fatal("CSRF cookie must be readable by the Frontend")
		}
	}
}
