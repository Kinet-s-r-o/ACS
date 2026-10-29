package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/matrix8412/acs/internal/api"
	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/cwmp"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found; using process environment")
	}
	if err := godotenv.Load(".acs.env"); err != nil {
		log.Println("No .acs.env file found")
	}
	if err := auth.ConfigureJWT(os.Getenv("JWT_SECRET")); err != nil {
		log.Fatalf("Security configuration error: %v", err)
	}
	if err := database.ConfigureParameterEncryption(os.Getenv("PARAMETER_ENCRYPTION_KEY")); err != nil {
		log.Fatalf("Security configuration error: %v", err)
	}
	if err := validateCWMPAuthenticationConfig(); err != nil {
		log.Fatalf("Security configuration error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	db, err := connectDatabase()
	if err != nil {
		log.Fatalf("Database connection failed: %v", err)
	}
	log.Println("Database connected successfully")
	if err := runAutoMigrate(db); err != nil {
		log.Fatalf("Database migration failed: %v", err)
	}
	if count, err := database.NewParameterRepository(db).EncryptLegacySensitiveValues(ctx); err != nil {
		log.Fatalf("Sensitive parameter migration failed: %v", err)
	} else if count > 0 {
		log.Printf("Encrypted %d legacy sensitive parameter values", count)
	}
	if count, err := database.NewProvisioningRepository(db).EncryptLegacySensitiveValues(ctx); err != nil {
		log.Fatalf("Sensitive provisioning migration failed: %v", err)
	} else if count > 0 {
		log.Printf("Encrypted %d legacy sensitive provisioning values", count)
	}
	if count, err := database.NewSettingsRepository(db).EncryptLegacySensitiveValues(ctx); err != nil {
		log.Fatalf("Sensitive settings migration failed: %v", err)
	} else if count > 0 {
		log.Printf("Encrypted %d legacy sensitive settings", count)
	}
	if count, err := database.NewTaskRepository(db).ProtectLegacyTaskSecrets(ctx); err != nil {
		log.Fatalf("Sensitive task migration failed: %v", err)
	} else if count > 0 {
		log.Printf("Protected %d legacy task records containing sensitive values", count)
	}
	go runTaskRecovery(ctx, database.NewTaskRepository(db))
	go database.RunRetentionMaintenance(ctx, db)

	cwmpPort := os.Getenv("PORT")
	if cwmpPort == "" {
		cwmpPort = "7547"
	}
	apiPort := os.Getenv("API_PORT")
	if apiPort == "" {
		apiPort = "7548"
	}
	cwmpBindAddress := envOrDefault("CWMP_BIND_ADDR", "127.0.0.1")
	apiBindAddress := envOrDefault("API_BIND_ADDR", "127.0.0.1")

	cwmpMux := http.NewServeMux()
	cwmpHandler := cwmp.NewHandler(db)
	cwmpMux.Handle("/", cwmpHandler)

	cwmpServer := &http.Server{
		Addr:              net.JoinHostPort(cwmpBindAddress, cwmpPort),
		Handler:           cwmpMux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	apiMux := http.NewServeMux()
	apiRouter := api.NewRouter(db)
	apiMux.Handle("/", apiRouter.Handler())

	apiServer := &http.Server{
		Addr:              net.JoinHostPort(apiBindAddress, apiPort),
		Handler:           apiMux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	watchdog := cwmp.NewDeviceWatchdog(db)
	go watchdog.Start(ctx)

	go func() {
		log.Printf("ACS CWMP server listening on %s", cwmpServer.Addr)
		if err := cwmpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("CWMP server failed: %v", err)
		}
	}()

	go func() {
		log.Printf("ACS API server listening on %s", apiServer.Addr)
		if err := apiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("API server failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down servers...")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := cwmpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("CWMP Server shutdown failed: %v", err)
	}
	if err := apiServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("API Server shutdown failed: %v", err)
	}

	log.Println("Servers stopped")
}

func validateCWMPAuthenticationConfig() error {
	usernameSet := strings.TrimSpace(os.Getenv("CWMP_USERNAME")) != ""
	passwordSet := os.Getenv("CWMP_PASSWORD") != ""
	if usernameSet != passwordSet {
		return errors.New("CWMP_USERNAME and CWMP_PASSWORD must be configured together")
	}
	if usernameSet && strings.TrimSpace(os.Getenv("CWMP_TRUSTED_PROXY_CIDRS")) == "" {
		return errors.New("CWMP Basic authentication requires TLS termination and CWMP_TRUSTED_PROXY_CIDRS")
	}
	for _, key := range []string{"ADMIN_WEB_ALLOWED_CIDRS", "CWMP_ALLOWED_CIDRS", "CWMP_TRUSTED_PROXY_CIDRS", "TRUSTED_PROXY_CIDRS", "CONNECTION_REQUEST_ALLOWED_CIDRS"} {
		if err := validateCIDRList(key, os.Getenv(key)); err != nil {
			return err
		}
	}
	return nil
}

func validateCIDRList(key, raw string) error {
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if net.ParseIP(item) != nil {
			continue
		}
		if _, _, err := net.ParseCIDR(item); err != nil {
			return fmt.Errorf("%s contains invalid address or CIDR %q", key, item)
		}
	}
	return nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func connectDatabase() (*gorm.DB, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		host := os.Getenv("DB_HOST")
		port := os.Getenv("DB_PORT")
		dbname := os.Getenv("DB_NAME")
		user := os.Getenv("DB_USER")
		password := os.Getenv("DB_PASSWORD")

		if host == "" || dbname == "" || user == "" {
			return nil, fmt.Errorf("database credentials not found - run ./setup.sh first")
		}
		if port == "" {
			port = "5432"
		}

		sslMode := os.Getenv("DB_SSLMODE")
		if sslMode == "" {
			if host == "localhost" || host == "127.0.0.1" || host == "::1" {
				sslMode = "disable"
			} else {
				sslMode = "verify-full"
			}
		}
		switch sslMode {
		case "disable", "require", "verify-ca", "verify-full":
		default:
			return nil, fmt.Errorf("unsupported DB_SSLMODE %q", sslMode)
		}
		query := url.Values{"sslmode": []string{sslMode}}
		dsn = (&url.URL{
			Scheme:   "postgres",
			User:     url.UserPassword(user, password),
			Host:     net.JoinHostPort(host, port),
			Path:     "/" + dbname,
			RawQuery: query.Encode(),
		}).String()
	}

	gormLogger := logger.New(
		log.New(os.Stdout, "\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             time.Second,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  !strings.Contains(os.Getenv("TERM"), "dumb"),
		},
	)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: gormLogger,
	})
	if err != nil {
		return nil, err
	}
	if err := validatePostgreSQLVersion(db); err != nil {
		return nil, err
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	maxOpen, err := envInt("DB_MAX_OPEN_CONNS", 50, 1, 500)
	if err != nil {
		return nil, err
	}
	maxIdle, err := envInt("DB_MAX_IDLE_CONNS", 10, 0, maxOpen)
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetConnMaxLifetime(time.Hour)

	return db, nil
}

const (
	minimumPostgreSQLMajor     = 14
	maximumTestedPostgresMajor = 18
)

func validatePostgreSQLVersion(db *gorm.DB) error {
	var versionNumber int
	if err := db.Raw("SHOW server_version_num").Scan(&versionNumber).Error; err != nil {
		return fmt.Errorf("read PostgreSQL server version: %w", err)
	}
	major, err := validatePostgreSQLVersionNumber(versionNumber)
	if err != nil {
		return err
	}
	if major > maximumTestedPostgresMajor {
		log.Printf("Warning: PostgreSQL %d is newer than the tested range (%d-%d)", major, minimumPostgreSQLMajor, maximumTestedPostgresMajor)
	}
	return nil
}

func validatePostgreSQLVersionNumber(versionNumber int) (int, error) {
	major := versionNumber / 10000
	if major < minimumPostgreSQLMajor {
		return major, fmt.Errorf("PostgreSQL %d is unsupported; version %d or newer is required", major, minimumPostgreSQLMajor)
	}
	return major, nil
}

func envInt(key string, fallback, minimum, maximum int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return value, nil
}

func runAutoMigrate(db *gorm.DB) error {
	log.Println("Running database migrations...")
	if db.Migrator().HasColumn(&models.User{}, "required2_fa") && !db.Migrator().HasColumn(&models.User{}, "required_2fa") {
		if err := db.Migrator().RenameColumn(&models.User{}, "required2_fa", "required_2fa"); err != nil {
			return fmt.Errorf("rename required 2FA column: %w", err)
		}
	}

	allModels := []interface{}{
		&models.Device{},
		&models.DeviceParameter{},
		&models.DeviceLogEntry{},
		&models.Task{},
		&models.User{},
		&models.APIToken{},
		&models.Role{},
		&models.Fault{},
		&models.Firmware{},
		&models.ProvisioningTemplate{},
		&models.ProvisioningRule{},
		&models.ProvisioningApplication{},
		&models.AuditLog{},
		&models.BlockedDevice{},
		&models.MetricDefinition{},
		&models.MetricPollState{},
		&models.ParameterPollDefinition{},
		&models.ParameterPollState{},
		&models.MetricSample{},
		&models.InterfaceMetricDefinition{},
		&models.InterfaceMetricSample{},
		&models.DeviceSnapshot{},
		&models.TagDefinition{},
		&database.Setting{},
	}

	for _, model := range allModels {
		if err := db.AutoMigrate(model); err != nil {
			return fmt.Errorf("migrate %T: %w", model, err)
		}
	}
	if err := database.BackfillDeviceLogs(context.Background(), db); err != nil {
		return fmt.Errorf("backfill device logs: %w", err)
	}
	if err := database.NewTagRepository(db).SeedLegacyDefinitions(context.Background()); err != nil {
		return fmt.Errorf("seed legacy tag definitions: %w", err)
	}
	if db.Migrator().HasIndex(&models.ProvisioningApplication{}, "idx_provisioning_application") {
		if err := db.Migrator().DropIndex(&models.ProvisioningApplication{}, "idx_provisioning_application"); err != nil {
			return fmt.Errorf("drop obsolete provisioning application index: %w", err)
		}
	}
	// Migrate metric_definitions unique index from single-column (name) to composite (name, device_type_match).
	if db.Migrator().HasIndex(&models.MetricDefinition{}, "idx_metric_definitions_name") {
		if err := db.Migrator().DropIndex(&models.MetricDefinition{}, "idx_metric_definitions_name"); err != nil {
			return fmt.Errorf("drop obsolete metric name index: %w", err)
		}
	}
	if db.Migrator().HasIndex(&models.MetricDefinition{}, "idx_metric_name_match") {
		if err := db.Migrator().DropIndex(&models.MetricDefinition{}, "idx_metric_name_match"); err != nil {
			return fmt.Errorf("drop old metric name index: %w", err)
		}
	}
	if err := db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_name_scope ON metric_definitions (name, device_type_match, COALESCE(template_id, 0))").Error; err != nil {
		return fmt.Errorf("create composite metric name index: %w", err)
	}
	if err := database.MigrateInterfaceMetricDefinitions(context.Background(), db); err != nil {
		return fmt.Errorf("merge interface metric definitions: %w", err)
	}
	if err := db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_command_key_unique ON tasks (command_key) WHERE command_key <> ''").Error; err != nil {
		return fmt.Errorf("create unique task command key index: %w", err)
	}
	if err := migrateProvisioningTemplates(db); err != nil {
		return fmt.Errorf("migrate provisioning templates: %w", err)
	}
	if err := database.MigrateGlobalMetricDefinitions(context.Background(), db); err != nil {
		return fmt.Errorf("scope metric definitions to provisioning templates: %w", err)
	}
	// Enforce NOT NULL on template_id (idempotent — no-op if already set).
	if err := db.Exec("ALTER TABLE provisioning_rules ALTER COLUMN template_id SET NOT NULL").Error; err != nil {
		return fmt.Errorf("set template_id NOT NULL: %w", err)
	}
	if err := database.SetupTimescaleDB(db); err != nil {
		return fmt.Errorf("setup timescaledb: %w", err)
	}

	defaultSettings := []database.Setting{
		{Key: "firmware_base_url", Value: "", Description: "Public HTTPS API base URL used by CPE firmware downloads"},
		{Key: "connection_request_username", Value: "", Description: "Connection request username"},
		{Key: "connection_request_password", Value: "", Description: "Connection request password"},
		{Key: "use_auto_conn_credentials", Value: "false", Description: "Derive unique per-device credentials with HMAC-SHA256"},
		{Key: "default_page_size", Value: "20", Description: "Default number of rows per page in list views"},
		{Key: "chart_show_points", Value: "true", Description: "Show data points on metric charts"},
		{Key: "app_name", Value: "ACS", Description: "Application name displayed in the UI"},
	}
	for index := range defaultSettings {
		if err := db.Where(database.Setting{Key: defaultSettings[index].Key}).FirstOrCreate(&defaultSettings[index]).Error; err != nil {
			return fmt.Errorf("seed setting %s: %w", defaultSettings[index].Key, err)
		}
	}
	if err := db.Where("key IN ?", []string{"acs_url", "acs_username", "acs_password", "inform_interval", "default_refresh_interval"}).Delete(&database.Setting{}).Error; err != nil {
		return fmt.Errorf("remove obsolete settings: %w", err)
	}

	var count int64
	if err := db.Model(&models.User{}).Count(&count).Error; err != nil {
		return fmt.Errorf("count bootstrap users: %w", err)
	}
	if count == 0 {
		log.Println("Creating bootstrap administrator...")
		initialPassword := os.Getenv("INITIAL_ADMIN_PASSWORD")
		if initialPassword != "" {
			if err := auth.ValidatePassword(initialPassword); err != nil {
				return fmt.Errorf("invalid INITIAL_ADMIN_PASSWORD: %w", err)
			}
		} else {
			initialPassword = generateBootstrapPassword()
		}
		hashedPassword, err := bcrypt.GenerateFromPassword([]byte(initialPassword), 12)
		if err != nil {
			return fmt.Errorf("hash bootstrap password: %w", err)
		}
		admin := &models.User{
			Username:     "admin",
			PasswordHash: string(hashedPassword),
			Role:         models.RoleFull,
		}
		if err := db.Create(admin).Error; err != nil {
			return fmt.Errorf("create bootstrap administrator: %w", err)
		} else {
			log.Printf("Bootstrap administrator created. Username: admin Password: %s", initialPassword)
			log.Println("Store this password securely; it is only printed once and should be rotated after first login.")
		}
	}

	// Seed built-in roles.
	adminRole := &models.Role{Name: "admin", Description: "Full access to all features", Permissions: models.AllPermissions, IsSystem: true}
	viewerRole := &models.Role{Name: "viewer", Description: "Read-only access to all features", Permissions: models.ReadPermissions, IsSystem: true}
	for _, role := range []*models.Role{adminRole, viewerRole} {
		var existing models.Role
		if err := db.Where("name = ?", role.Name).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				if err := db.Create(role).Error; err != nil {
					return fmt.Errorf("seed role %s: %w", role.Name, err)
				}
				log.Printf("Seeded built-in role: %s", role.Name)
			} else {
				return fmt.Errorf("check role %s: %w", role.Name, err)
			}
		} else if role.Name == "admin" && (!slices.Equal(existing.Permissions, models.AllPermissions) || existing.Description != role.Description || !existing.IsSystem) {
			// Keep the built-in administrator role in sync with the complete permission catalog.
			// New permissions added to AllPermissions are granted automatically at startup.
			existing.Permissions = append([]string(nil), models.AllPermissions...)
			existing.Description = role.Description
			existing.IsSystem = true
			if err := db.Save(&existing).Error; err != nil {
				return fmt.Errorf("update built-in admin role: %w", err)
			}
			log.Printf("Updated built-in admin role to %d permissions", len(models.AllPermissions))
		}
	}

	// Migrate existing users to use RoleID.
	if err := migrateUsersToRoles(db); err != nil {
		return fmt.Errorf("migrate users to roles: %w", err)
	}

	log.Println("Database migrations completed")
	return nil
}

func migrateUsersToRoles(db *gorm.DB) error {
	var adminRole models.Role
	if err := db.Where("name = ?", "admin").First(&adminRole).Error; err != nil {
		return fmt.Errorf("find admin role: %w", err)
	}
	var viewerRole models.Role
	if err := db.Where("name = ?", "viewer").First(&viewerRole).Error; err != nil {
		return fmt.Errorf("find viewer role: %w", err)
	}

	// Assign RoleID to users with legacy "full" role.
	var fullUsers []models.User
	if err := db.Where("role = ? AND role_id IS NULL", models.RoleFull).Find(&fullUsers).Error; err != nil {
		return fmt.Errorf("find full users: %w", err)
	}
	for i := range fullUsers {
		if err := db.Model(&fullUsers[i]).Update("role_id", adminRole.ID).Error; err != nil {
			return fmt.Errorf("assign admin role to user %d: %w", fullUsers[i].ID, err)
		}
	}
	if len(fullUsers) > 0 {
		log.Printf("Migrated %d users to admin role", len(fullUsers))
	}

	// Assign RoleID to users with legacy "read" role.
	var readUsers []models.User
	if err := db.Where("role = ? AND role_id IS NULL", models.RoleRead).Find(&readUsers).Error; err != nil {
		return fmt.Errorf("find read users: %w", err)
	}
	for i := range readUsers {
		if err := db.Model(&readUsers[i]).Update("role_id", viewerRole.ID).Error; err != nil {
			return fmt.Errorf("assign viewer role to user %d: %w", readUsers[i].ID, err)
		}
	}
	if len(readUsers) > 0 {
		log.Printf("Migrated %d users to viewer role", len(readUsers))
	}

	return nil
}

func runTaskRecovery(ctx context.Context, repo *database.TaskRepository) {
	cleanup := func() {
		if count, err := repo.MarkOldPendingDownloadsAsFailed(ctx, 24*time.Hour); err != nil {
			log.Printf("Firmware task cleanup failed: %v", err)
		} else if count > 0 {
			log.Printf("Task cleanup marked %d expired firmware tasks as failed", count)
		}
		if count, err := repo.MarkOldSentAsFailed(ctx, 24*time.Hour); err != nil {
			log.Printf("Task recovery failed: %v", err)
		} else if count > 0 {
			log.Printf("Task recovery marked %d stale sent tasks as failed", count)
		}
		if count, err := repo.MarkOldPendingAsFailed(ctx, 30*24*time.Hour); err != nil {
			log.Printf("Pending task cleanup failed: %v", err)
		} else if count > 0 {
			log.Printf("Task cleanup marked %d expired pending tasks as failed", count)
		}
	}
	cleanup()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanup()
		}
	}
}

func migrateProvisioningTemplates(db *gorm.DB) error {
	var unassigned int64
	if err := db.Model(&models.ProvisioningRule{}).Where("template_id = 0 OR template_id IS NULL").Count(&unassigned).Error; err != nil {
		return err
	}
	if unassigned == 0 {
		return nil
	}

	log.Println("Migrating provisioning rules to templates...")

	type legacyRule struct {
		ID             int64    `gorm:"column:id"`
		Manufacturer   string   `gorm:"column:manufacturer"`
		ProductClass   string   `gorm:"column:product_class"`
		ProductClasses []string `gorm:"column:product_classes;type:jsonb;serializer:json"`
		Tag            string   `gorm:"column:tag"`
	}

	var rules []legacyRule
	if err := db.Table("provisioning_rules").Select("id, manufacturer, product_class, product_classes, tag").Find(&rules).Error; err != nil {
		return fmt.Errorf("read legacy rules: %w", err)
	}

	type scope struct {
		Manufacturer string
		ProductClass string
	}
	scopes := make(map[scope]bool)
	for _, rule := range rules {
		mfr := strings.ToLower(strings.TrimSpace(rule.Manufacturer))
		if rule.ProductClasses != nil && len(rule.ProductClasses) > 0 {
			for _, pc := range rule.ProductClasses {
				scopes[scope{Manufacturer: mfr, ProductClass: strings.ToLower(strings.TrimSpace(pc))}] = true
			}
		} else {
			pc := strings.ToLower(strings.TrimSpace(rule.ProductClass))
			scopes[scope{Manufacturer: mfr, ProductClass: pc}] = true
		}
	}
	scopes[scope{}] = true

	templateMap := make(map[scope]int64)
	for s := range scopes {
		name := provisioningTemplateName(s.Manufacturer, s.ProductClass)
		var template models.ProvisioningTemplate
		result := db.Where("manufacturer = ? AND product_class = ?", s.Manufacturer, s.ProductClass).First(&template)
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			template = models.ProvisioningTemplate{
				Name:         name,
				Manufacturer: s.Manufacturer,
				ProductClass: s.ProductClass,
			}
			if err := db.Create(&template).Error; err != nil {
				return fmt.Errorf("create template %s: %w", name, err)
			}
		} else if result.Error != nil {
			return fmt.Errorf("find template: %w", result.Error)
		}
		templateMap[s] = template.ID
	}

	for _, rule := range rules {
		mfr := strings.ToLower(strings.TrimSpace(rule.Manufacturer))
		if rule.ProductClasses != nil && len(rule.ProductClasses) > 0 {
			for _, pc := range rule.ProductClasses {
				s := scope{Manufacturer: mfr, ProductClass: strings.ToLower(strings.TrimSpace(pc))}
				templateID, ok := templateMap[s]
				if !ok {
					continue
				}
				if err := db.Exec(
					`INSERT INTO provisioning_rules (template_id, parameter_name, parameter_value, parameter_type, phase, tags, enabled, version, description, add_object_path, "order", condition, created_at, updated_at)
					 SELECT ?, parameter_name, parameter_value, parameter_type, phase,
					   CASE WHEN tag <> '' THEN to_jsonb(ARRAY[LOWER(tag)]) ELSE NULL END,
					   enabled, version, description, add_object_path, "order", condition, created_at, updated_at
					 FROM provisioning_rules WHERE id = ?`,
					templateID, rule.ID,
				).Error; err != nil {
					return fmt.Errorf("copy rule %d to template %d: %w", rule.ID, templateID, err)
				}
			}
			if err := db.Exec("DELETE FROM provisioning_rules WHERE id = ?", rule.ID).Error; err != nil {
				return fmt.Errorf("delete legacy rule %d: %w", rule.ID, err)
			}
		} else {
			s := scope{Manufacturer: mfr, ProductClass: strings.ToLower(strings.TrimSpace(rule.ProductClass))}
			templateID, ok := templateMap[s]
			if !ok {
				continue
			}
			if err := db.Exec(
				`UPDATE provisioning_rules SET template_id = ?, tags = CASE WHEN tag <> '' THEN to_jsonb(ARRAY[LOWER(tag)]) ELSE NULL END WHERE id = ?`,
				templateID, rule.ID,
			).Error; err != nil {
				return fmt.Errorf("assign rule %d to template %d: %w", rule.ID, templateID, err)
			}
		}
	}

	for _, col := range []string{"manufacturer", "product_class", "product_classes", "tag"} {
		if db.Migrator().HasColumn(&models.ProvisioningRule{}, col) {
			if err := db.Migrator().DropColumn(&models.ProvisioningRule{}, col); err != nil {
				return fmt.Errorf("drop column %s: %w", col, err)
			}
		}
	}

	log.Printf("Provisioning template migration complete: %d templates", len(templateMap))
	return nil
}

func provisioningTemplateName(manufacturer, productClass string) string {
	switch {
	case manufacturer != "" && productClass != "":
		return manufacturer + " " + productClass
	case manufacturer != "":
		return manufacturer
	case productClass != "":
		return productClass
	default:
		return "Global"
	}
}

func generateBootstrapPassword() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("cannot generate bootstrap password: %v", err))
	}
	return "ACS-" + hex.EncodeToString(buffer)
}
