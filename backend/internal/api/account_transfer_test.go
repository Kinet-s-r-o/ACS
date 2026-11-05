package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

func TestAccountTransferRejectsInvalidFiles(t *testing.T) {
	for _, body := range []string{
		`{"format":"acs-users","version":1,"users":[{"username":"new","password":"unexpected"}]}`,
		`{"format":"acs-users","version":1,"users":[{"username":"new","two_factor_secret":"unexpected"}]}`,
		`{"format":"acs-users","version":1,"users":[{"username":"new","api_tokens":[]}]}`,
		`{} {}`,
		strings.Repeat(" ", maxAccountTransferSize+1),
	} {
		var backup accountTransfer
		if err := decodeAccountTransfer(httptest.NewRecorder(), httptest.NewRequest("POST", "/users/import", strings.NewReader(body)), &backup); err == nil {
			t.Fatal("accepted unsupported fields, multiple documents or oversized input")
		}
	}
	for _, backup := range []accountTransfer{
		{Format: "acs-users", Version: 2, Users: []transferredUser{{Username: "new"}}},
		{Format: "acs-roles", Version: 1, Roles: []transferredRole{{Name: "role"}}},
		{Format: "acs-users", Version: 1},
		{Format: "acs-users", Version: 1, Users: []transferredUser{{Username: "new"}}, Roles: []transferredRole{{Name: "role"}}},
	} {
		if err := validateAccountTransfer(&backup, "users"); err == nil {
			t.Fatal("accepted incompatible transfer format")
		}
	}
}

func TestAccountTransferUsesIndependentPermissions(t *testing.T) {
	for _, kind := range []string{"users", "roles"} {
		section := "settings.users." + kind
		for _, operation := range []string{"import", "export"} {
			for _, action := range []string{"read", "edit", "import", "export", "full"} {
				mux := newPermissionMux()
				path := "/" + kind + "/" + operation
				mux.HandleFunc("POST "+path, func(w http.ResponseWriter, req *http.Request) { w.WriteHeader(http.StatusNoContent) })
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, scopedRequest("POST", path, []string{models.PermissionKey(section, "read"), models.PermissionKey(section, action)}, ""))
				want := http.StatusForbidden
				if action == operation || action == "full" {
					want = http.StatusNoContent
				}
				if w.Code != want {
					t.Errorf("%s %s with %s: got %d, want %d", kind, operation, action, w.Code, want)
				}
			}
		}
	}
}

func TestUserTransferProjection(t *testing.T) {
	projection, err := schema.Parse(&struct {
		ID   int64
		User transferredUser `gorm:"embedded"`
	}{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"username", "auth_provider", "role_name", "required_2fa", "active"} {
		if projection.LookUpField(name) == nil {
			t.Errorf("export projection cannot scan %s", name)
		}
	}
	for _, name := range []string{"password_hash", "two_factor_secret", "token_version"} {
		if projection.LookUpField(name) != nil {
			t.Errorf("export projection includes %s", name)
		}
	}
}

func TestAccountTransferPostgres(t *testing.T) {
	db := accountTransferTestDatabase(t)
	r := &Router{db: db, roleRepo: database.NewRoleRepository(db), userRepo: database.NewUserRepository(db)}
	viewer := models.Role{Name: "viewer", IsSystem: true, Permissions: []string{}}
	if err := db.Create(&viewer).Error; err != nil {
		t.Fatal(err)
	}
	call := func(kind, operation, body string, grants []string) *httptest.ResponseRecorder {
		t.Helper()
		mux := newPermissionMux()
		path := "/" + kind + "/" + operation
		handler := r.handleImportAccounts(kind)
		if operation == "export" {
			handler = r.handleExportAccounts(kind)
		}
		mux.HandleFunc("POST "+path, handler)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, scopedRequest("POST", path, grants, body))
		return w
	}
	grants := []string{"access.settings.users.users.full", "access.settings.users.roles.full", "access.fleet.read"}
	roleFile := `{"format":"acs-roles","version":1,"roles":[{"name":"Support","description":"Support role","permissions":["access.fleet.read"]},{"name":"viewer","is_system":true}]}`
	for i := 0; i < 2; i++ {
		w := call("roles", "import", roleFile, grants)
		if w.Code != 200 {
			t.Fatalf("role import returned %d: %s", w.Code, w.Body.String())
		}
		var result struct{ Created, Skipped int }
		if json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Created != 1-i || result.Skipped != 1+i {
			t.Fatal("role import did not skip existing and system roles")
		}
	}
	support, err := r.roleRepo.GetByName(t.Context(), "Support")
	if err != nil {
		t.Fatal(err)
	}
	w := call("roles", "export", `{"ids":[`+strconv.FormatInt(support.ID, 10)+`,`+strconv.FormatInt(viewer.ID, 10)+`]}`, grants)
	var roleExport accountTransfer
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &roleExport) != nil || len(roleExport.Roles) != 2 || roleExport.Roles[0].Name != "Support" || len(roleExport.Roles[0].Permissions) != 1 || !roleExport.Roles[1].IsSystem {
		t.Fatal("role export lost record order, permissions or system type")
	}
	userFile := `{"format":"acs-users","version":1,"users":[{"username":"imported","auth_provider":"local","role_name":"Support","active":true,"required_2fa":true}]}`
	w = call("users", "import", userFile, grants)
	if w.Code != 200 {
		t.Fatalf("user import returned %d: %s", w.Code, w.Body.String())
	}
	user, err := r.userRepo.GetByUsername(t.Context(), "imported")
	if err != nil || user == nil || user.Active || user.PasswordHash != "" || !user.Required2FA || user.TwoFactorSecret != "" {
		t.Fatal("imported account did not retain its disabled, unpaired state")
	}
	w = call("users", "export", `{"ids":[`+strconv.FormatInt(user.ID, 10)+`]}`, grants)
	var exported accountTransfer
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &exported) != nil || len(exported.Users) != 1 || exported.Users[0].RoleName != "Support" || exported.Users[0].Username != "imported" {
		t.Fatalf("user export failed: %d %s", w.Code, w.Body.String())
	}
	w = call("users", "import", userFile, grants)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"skipped":1`) || !strings.Contains(w.Body.String(), `"created":0`) {
		t.Fatal("user import did not skip an existing account")
	}
	w = call("users", "import", `{"format":"acs-users","version":1,"users":[{"username":"rollback","role_name":"Support"},{"username":"missing","role_name":"Absent"}]}`, grants)
	rolledBack, err := r.userRepo.GetByUsername(t.Context(), "rollback")
	if w.Code != 400 || err != nil || rolledBack != nil {
		t.Fatal("invalid user import was not fully rolled back")
	}
	w = call("roles", "import", `{"format":"acs-roles","version":1,"roles":[{"name":"Escalation","permissions":["access.settings.general.ui.full"]}]}`, grants)
	if w.Code != 403 {
		t.Fatalf("role import did not reject privilege escalation: %d", w.Code)
	}
	broader := models.Role{Name: "Broader", Permissions: []string{"access.settings.general.ui.full"}}
	if err := db.Create(&broader).Error; err != nil {
		t.Fatal(err)
	}
	w = call("users", "import", `{"format":"acs-users","version":1,"users":[{"username":"escalation","role_name":"Broader"}]}`, grants)
	if w.Code != 403 {
		t.Fatalf("user import did not reject privilege escalation: %d", w.Code)
	}
	w = call("roles", "import", `{"format":"acs-roles","version":1,"roles":[{"name":"Rollback role","permissions":[]},{"name":"Bad permission","permissions":["access.nonexistent.read"]}]}`, grants)
	if w.Code != 400 {
		t.Fatal("unknown role permission was accepted")
	}
	var count int64
	if err := db.Model(&models.Role{}).Where("name = ?", "Rollback role").Count(&count).Error; err != nil || count != 0 {
		t.Fatal("invalid role import was not fully rolled back")
	}
}

// Keep the transfer fixture independent of AutoMigrate: no indexes are created.
func accountTransferTestDatabase(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping account transfer PostgreSQL test")
	}
	config := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}
	base, err := gorm.Open(postgres.Open(dsn), config)
	if err != nil {
		t.Fatal("could not connect to test PostgreSQL")
	}
	schemaName := fmt.Sprintf("account_transfer_test_%d", time.Now().UnixNano())
	if err := base.Exec("CREATE SCHEMA " + schemaName).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = base.Exec("DROP SCHEMA " + schemaName + " CASCADE").Error
		sqlDB, _ := base.DB()
		_ = sqlDB.Close()
	})
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	query := parsed.Query()
	query.Set("search_path", schemaName)
	parsed.RawQuery = query.Encode()
	db, err := gorm.Open(postgres.Open(parsed.String()), config)
	if err != nil {
		t.Fatal("could not open isolated test schema")
	}
	t.Cleanup(func() { sqlDB, _ := db.DB(); _ = sqlDB.Close() })
	for _, statement := range []string{
		`CREATE TABLE roles (id bigserial, name text NOT NULL, description text, permissions jsonb DEFAULT '[]', is_system boolean DEFAULT false, created_at timestamptz, updated_at timestamptz)`,
		`CREATE TABLE users (id bigserial, username text NOT NULL, auth_provider text DEFAULT 'local', first_name text, last_name text, email text, active boolean DEFAULT true, required_2fa boolean DEFAULT false, password_hash text NOT NULL, role text, role_id bigint, two_factor_secret text DEFAULT '', two_factor_pending_secret text DEFAULT '', two_factor_last_step bigint DEFAULT -1, token_version bigint DEFAULT 0, created_at timestamptz, updated_at timestamptz, last_login timestamptz)`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	return db
}
