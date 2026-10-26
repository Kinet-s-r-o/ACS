package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIntegrationInputValidation(t *testing.T) {
	for _, body := range []string{`{"parameters":[]}`, `{"parameters":null}`, `{"parameters":["wrong.path"]}`, `{"parameters":["Device.X"],"unknown":true}`, `{"parameters":["Device.X"]} {}`, `{"parameters":["Device.*.X"]}`, `{"parameters":[" Device.X"]}`} {
		w := httptest.NewRecorder()
		(&Router{}).integrationRead(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		if w.Code != 400 {
			t.Errorf("invalid read body accepted: %d", w.Code)
		}
	}
	for _, body := range []string{`{"parameters":{}}`, `{"parameters":{"Device.X.":"value"}}`, `{"parameters":{"Device.*.X":"value"}}`, `{"parameters":{"Device.X":true}}`, `{"parameters":{"Device.X":null}}`, `{"parameters":{"Device.X":"value"},"unknown":true}`} {
		w := httptest.NewRecorder()
		(&Router{}).integrationWrite(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		if w.Code != 400 {
			t.Errorf("invalid write body accepted: %d", w.Code)
		}
	}
	for _, query := range []string{"limit=0", "limit=501", "limit=bad", "cursor=-1", "cursor=abc"} {
		if _, _, err := integrationPage(httptest.NewRequest("GET", "/?"+query, nil), true); err == nil {
			t.Errorf("invalid page accepted: %s", query)
		}
	}
}

func TestIntegrationOpenAPIAndRouteCoverage(t *testing.T) {
	var spec struct {
		OpenAPI string                                `json:"openapi"`
		Paths   map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(integrationOpenAPI, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.0.3" {
		t.Fatal("unexpected OpenAPI version")
	}
	for path, verbs := range map[string][]string{
		"/v1/me": {"get"}, "/v1/devices": {"get"}, "/v1/devices/{serial}": {"get"},
		"/v1/devices/{serial}/parameters": {"get"}, "/v1/devices/{serial}/read": {"post"}, "/v1/devices/{serial}/write": {"post"},
		"/v1/devices/{serial}/tasks": {"get"}, "/v1/devices/{serial}/tasks/{taskID}": {"get"},
		"/users/{id}/api-tokens": {"get", "post"}, "/users/{id}/api-tokens/{tokenID}": {"delete"}, "/openapi.json": {"get"},
	} {
		for _, verb := range verbs {
			if len(spec.Paths[path][verb]) == 0 {
				t.Errorf("missing API documentation: %s %s", verb, path)
			}
		}
	}
	// Exercise route registration and network guard without opening a database.
	r := &Router{adminWebNetworks: parseAllowedNetworks("192.0.2.0/24"), apiIPLimiter: newLoginLimiter(600, time.Minute), apiTokenLimiter: newLoginLimiter(120, time.Minute)}
	for _, path := range []string{"/v1/me", "/v1/devices/SERIAL/parameters"} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "198.51.100.1:1234"
		r.Handler().ServeHTTP(w, req)
		if w.Code != 403 {
			t.Errorf("integration bypassed network guard: %d", w.Code)
		}
	}
}
