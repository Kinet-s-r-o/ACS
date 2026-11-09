package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestTemplateBootstrapRebootCreateDefaultsAndPermissions(t *testing.T) {
	for _, tc := range []struct {
		name, body, action string
		wantStatus         int
		wantEnabled        bool
	}{
		{"old client defaults off", `{"name":"Test"}`, "write", 201, false},
		{"explicit enable", `{"name":"Test","reboot_after_bootstrap":true}`, "write", 201, true},
		{"explicit disable", `{"name":"Test","reboot_after_bootstrap":false}`, "write", 201, false},
		{"read cannot enable", `{"name":"Test","reboot_after_bootstrap":true}`, "read", 403, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			router := &Router{db: db, provisioningRepo: database.NewProvisioningRepository(db)}
			mux := newPermissionMux()
			mux.HandleFunc("POST /provisioning/templates", router.handleCreateProvisioningTemplate)
			response := httptest.NewRecorder()
			permissions := []string{models.PermissionKey("settings.provisioning", "read"), models.PermissionKey("settings.provisioning", tc.action)}
			mux.ServeHTTP(response, scopedRequest(http.MethodPost, "/provisioning/templates", permissions, tc.body))
			if response.Code != tc.wantStatus {
				t.Fatalf("status=%d, want %d: %s", response.Code, tc.wantStatus, response.Body.String())
			}
			if response.Code == http.StatusCreated {
				var template models.ProvisioningTemplate
				if err := json.Unmarshal(response.Body.Bytes(), &template); err != nil {
					t.Fatal(err)
				}
				if template.RebootAfterBootstrap != tc.wantEnabled {
					t.Fatalf("enabled=%v, want %v", template.RebootAfterBootstrap, tc.wantEnabled)
				}
			}
		})
	}
}

func TestProvisioningTransferBootstrapRebootCompatibility(t *testing.T) {
	for _, body := range []string{`{"name":"Old backup"}`, `{"name":"Enabled","reboot_after_bootstrap":true}`, `{"name":"Disabled","reboot_after_bootstrap":false}`} {
		var item provisioningTransferTemplate
		if err := json.Unmarshal([]byte(body), &item); err != nil {
			t.Fatal(err)
		}
		if item.RebootAfterBootstrap != (item.Name == "Enabled") {
			t.Fatalf("incorrect default or imported value for %s", item.Name)
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		var restored provisioningTransferTemplate
		if err := json.Unmarshal(encoded, &restored); err != nil || restored.RebootAfterBootstrap != item.RebootAfterBootstrap {
			t.Fatalf("backup round trip lost bootstrap reboot: %v", err)
		}
	}
}
