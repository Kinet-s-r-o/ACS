package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/cwmp"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"github.com/matrix8412/acs/internal/netutil"
	"gorm.io/gorm"
)

type Router struct {
	db                   *gorm.DB
	deviceRepo           *database.DeviceRepository
	settingsRepo         *database.SettingsRepository
	taskRepo             *database.TaskRepository
	parameterRepo        *database.ParameterRepository
	firmwareRepo         *database.FirmwareRepository
	faultRepo            *database.FaultRepository
	userRepo             *database.UserRepository
	apiTokenRepo         *database.APITokenRepository
	apiTokenLimiter      *loginLimiter
	apiIPLimiter         *loginLimiter
	roleRepo             *database.RoleRepository
	provisioningRepo     *database.ProvisioningRepository
	auditRepo            *database.AuditRepository
	blockedRepo          *database.BlockedDeviceRepository
	metricRepo           *database.MetricRepository
	dashboardPanelRepo   *database.DashboardPanelRepository
	dashboardLayoutRepo  *database.DashboardLayoutRepository
	snapshotRepo         *database.SnapshotRepository
	tagRepo              *database.TagRepository
	loginLimiter         *loginLimiter
	twoFactorLimiter     *loginLimiter
	downloadLimiter      *loginLimiter
	adminWebNetworks     []*net.IPNet
	uploadDir            string
	uploadInitErr        error
	templateImageDir     string
	templateImageInitErr error
}

const maxTemplateImageSize = 5 << 20

func NewRouter(db *gorm.DB) *Router {
	uploadDir := os.Getenv("FIRMWARE_UPLOAD_DIR")
	if uploadDir == "" {
		uploadDir = "./uploads/firmware"
	}
	uploadInitErr := os.MkdirAll(uploadDir, 0750)
	if uploadInitErr == nil {
		var probe *os.File
		probe, uploadInitErr = os.CreateTemp(uploadDir, ".write-probe-*")
		if uploadInitErr == nil {
			probeName := probe.Name()
			uploadInitErr = probe.Close()
			if removeErr := os.Remove(probeName); uploadInitErr == nil {
				uploadInitErr = removeErr
			}
		}
	}
	if uploadInitErr != nil {
		log.Printf("Firmware storage is not writable: %v", uploadInitErr)
	}
	templateImageDir := os.Getenv("TEMPLATE_IMAGE_UPLOAD_DIR")
	if templateImageDir == "" {
		templateImageDir = "./uploads/template-images"
	}
	templateImageInitErr := os.MkdirAll(templateImageDir, 0750)
	if templateImageInitErr == nil {
		var probe *os.File
		probe, templateImageInitErr = os.CreateTemp(templateImageDir, ".write-probe-*")
		if templateImageInitErr == nil {
			probeName := probe.Name()
			templateImageInitErr = probe.Close()
			if removeErr := os.Remove(probeName); templateImageInitErr == nil {
				templateImageInitErr = removeErr
			}
		}
	}
	if templateImageInitErr != nil {
		log.Printf("Template image storage is not writable: %v", templateImageInitErr)
	}

	return &Router{
		db:                   db,
		deviceRepo:           database.NewDeviceRepository(db),
		settingsRepo:         database.NewSettingsRepository(db),
		taskRepo:             database.NewTaskRepository(db),
		parameterRepo:        database.NewParameterRepository(db),
		firmwareRepo:         database.NewFirmwareRepository(db),
		faultRepo:            database.NewFaultRepository(db),
		userRepo:             database.NewUserRepository(db),
		apiTokenRepo:         database.NewAPITokenRepository(db),
		apiTokenLimiter:      newLoginLimiter(120, time.Minute),
		apiIPLimiter:         newLoginLimiter(600, time.Minute),
		roleRepo:             database.NewRoleRepository(db),
		provisioningRepo:     database.NewProvisioningRepository(db),
		auditRepo:            database.NewAuditRepository(db),
		blockedRepo:          database.NewBlockedDeviceRepository(db),
		metricRepo:           database.NewMetricRepository(db),
		dashboardPanelRepo:   database.NewDashboardPanelRepository(db),
		dashboardLayoutRepo:  database.NewDashboardLayoutRepository(db),
		snapshotRepo:         database.NewSnapshotRepository(db),
		tagRepo:              database.NewTagRepository(db),
		loginLimiter:         newLoginLimiter(5, 15*time.Minute),
		twoFactorLimiter:     newLoginLimiter(5, 15*time.Minute),
		downloadLimiter:      newLoginLimiter(60, time.Minute),
		adminWebNetworks:     parseAllowedNetworks(os.Getenv("ADMIN_WEB_ALLOWED_CIDRS")),
		uploadDir:            uploadDir,
		uploadInitErr:        uploadInitErr,
		templateImageDir:     templateImageDir,
		templateImageInitErr: templateImageInitErr,
	}
}

func (r *Router) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public endpoints (no auth required)
	mux.HandleFunc("GET /health", r.handleHealth)
	mux.HandleFunc("GET /meta", r.handleMeta)
	mux.HandleFunc("GET /meta/logo", r.handleMetaLogo)
	mux.HandleFunc("POST /auth/login", r.handleLogin)
	mux.Handle("POST /auth/2fa/setup", r.twoFactorChallengeMiddleware(http.HandlerFunc(r.handleCompleteTwoFactorSetup)))
	mux.Handle("POST /auth/2fa/verify", r.twoFactorChallengeMiddleware(http.HandlerFunc(r.handleVerifyTwoFactor)))
	mux.Handle("POST /auth/2fa/cancel", r.twoFactorChallengeMiddleware(http.HandlerFunc(r.handleCancelTwoFactor)))
	mux.HandleFunc("GET /files/{id}/{filename}", r.handleFirmwareFile)

	// Protected API mux
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /users/{id}/api-tokens", auth.RequireFullAccess(auth.RequirePermission(models.PermUsersRead)(r.handleListAPITokens)))
	apiMux.HandleFunc("POST /users/{id}/api-tokens", auth.RequireFullAccess(auth.RequireAnyPermission(models.PermUsersTokens, models.PermUsersWrite)(r.handleCreateAPIToken)))
	apiMux.HandleFunc("DELETE /users/{id}/api-tokens/{tokenID}", auth.RequireFullAccess(auth.RequireAnyPermission(models.PermUsersTokens, models.PermUsersWrite)(r.handleRevokeAPIToken)))
	apiMux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(integrationOpenAPI)
	})
	mux.Handle("/v1/", r.adminWebAccessMiddleware(r.integrationHandler()))

	// Auth endpoints
	apiMux.HandleFunc("GET /auth/me", r.handleAuthMe)
	apiMux.HandleFunc("POST /auth/logout", r.handleLogout)
	apiMux.HandleFunc("POST /auth/change-password", r.handleChangePassword)

	// User management
	apiMux.HandleFunc("GET /users", auth.RequirePermission(models.PermUsersRead)(r.handleListUsers))
	apiMux.HandleFunc("POST /users", auth.RequirePermission(models.PermUsersWrite)(r.handleCreateUser))
	apiMux.HandleFunc("PUT /users/{id}", auth.RequirePermission(models.PermUsersWrite)(r.handleUpdateUser))
	apiMux.HandleFunc("DELETE /users/{id}", auth.RequirePermission(models.PermUsersWrite)(r.handleDeleteUser))
	apiMux.HandleFunc("GET /dashboard/panels", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDashboardPanels))
	apiMux.HandleFunc("GET /dashboard/aggregation-options", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDashboardAggregationOptions))
	apiMux.HandleFunc("PUT /dashboard/panels", auth.RequirePermission(models.PermDevicesRead)(r.handleSaveDashboardPanels))
	apiMux.HandleFunc("GET /dashboard/layout", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDashboardLayout))
	apiMux.HandleFunc("PUT /dashboard/layout", auth.RequirePermission(models.PermDevicesRead)(r.handleSaveDashboardLayout))
	apiMux.HandleFunc("POST /dashboard/panels/copy", auth.RequireFullAccess(auth.RequirePermission(models.PermUsersWrite)(r.handleCopyDashboardPanel)))

	// Role management
	apiMux.HandleFunc("GET /roles", auth.RequirePermission(models.PermRolesRead)(r.handleListRoles))
	apiMux.HandleFunc("POST /roles", auth.RequirePermission(models.PermRolesWrite)(r.handleCreateRole))
	apiMux.HandleFunc("PUT /roles/{id}", auth.RequirePermission(models.PermRolesWrite)(r.handleUpdateRole))
	apiMux.HandleFunc("DELETE /roles/{id}", auth.RequirePermission(models.PermRolesWrite)(r.handleDeleteRole))

	// Device endpoints (by ID - legacy)
	apiMux.HandleFunc("GET /devices", auth.RequirePermission(models.PermDevicesRead)(r.handleListDevices))
	apiMux.HandleFunc("GET /wan-interfaces", auth.RequirePermission(models.PermDevicesRead)(r.handleListWANInterfaces))
	apiMux.HandleFunc("GET /tasks", auth.RequirePermission(models.PermDevicesRead)(r.handleListTasks))
	apiMux.HandleFunc("GET /tasks/{id}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetTask))
	apiMux.HandleFunc("DELETE /tasks/{id}", auth.RequireAnyPermission(models.PermDevicesDelete, models.PermDevicesWrite)(r.handleDeletePendingTask))
	apiMux.HandleFunc("POST /tasks/bulk-delete", auth.RequireAnyPermission(models.PermDevicesDelete, models.PermDevicesWrite)(r.handleBulkDeletePendingTasks))
	apiMux.HandleFunc("GET /devices/stats", auth.RequirePermission(models.PermDevicesRead)(r.handleDeviceStats))
	apiMux.HandleFunc("GET /devices/growth", auth.RequirePermission(models.PermDevicesRead)(r.handleDeviceGrowth))
	apiMux.HandleFunc("GET /devices/analytics", auth.RequirePermission(models.PermDevicesRead)(r.handleDeviceAnalytics))
	apiMux.HandleFunc("POST /devices/analytics/panels", auth.RequirePermission(models.PermDevicesRead)(r.handleDashboardPanelAnalytics))
	apiMux.HandleFunc("POST /devices/analytics/distribution", auth.RequirePermission(models.PermDevicesRead)(r.handleDeviceParameterDistribution))
	apiMux.HandleFunc("GET /devices/{id}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDevice))
	apiMux.HandleFunc("DELETE /devices/{id}", auth.RequireAnyPermission(models.PermDevicesDelete, models.PermDevicesWrite)(r.handleDeleteDevice))
	apiMux.HandleFunc("GET /devices/{id}/parameters", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceParameters))
	apiMux.HandleFunc("GET /devices/{id}/tasks", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTasks))

	// Device actions (by ID - legacy)
	apiMux.HandleFunc("POST /devices/{id}/get-parameters", auth.RequireAnyPermission(models.PermDevicesCommand, models.PermDevicesWrite)(r.handleGetParameterValues))
	apiMux.HandleFunc("POST /devices/{id}/set-parameters", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleSetParameterValues))
	apiMux.HandleFunc("POST /devices/{id}/reboot", auth.RequireAnyPermission(models.PermDevicesCommand, models.PermDevicesWrite)(r.handleReboot))
	apiMux.HandleFunc("POST /devices/{id}/factory-reset", auth.RequireAnyPermission(models.PermDevicesReset, models.PermDevicesWrite)(r.handleFactoryReset))
	apiMux.HandleFunc("POST /devices/{id}/connection-request", auth.RequireAnyPermission(models.PermDevicesCommand, models.PermDevicesWrite)(r.handleConnectionRequest))
	apiMux.HandleFunc("POST /devices/{id}/download-firmware", auth.RequireAnyPermission(models.PermDevicesFirmware, models.PermDevicesWrite)(r.handleDownloadFirmware))

	// Device endpoints (by serial - new)
	apiMux.HandleFunc("GET /tags", auth.RequireAnyPermission(models.PermDevicesRead, models.PermSettingsRead, models.PermProvisioningRead)(r.handleListTags))
	apiMux.HandleFunc("POST /tags", auth.RequirePermission(models.PermSettingsWrite)(r.handleCreateTag))
	apiMux.HandleFunc("PUT /tags/{id}", auth.RequirePermission(models.PermSettingsWrite)(r.handleUpdateTag))
	apiMux.HandleFunc("DELETE /tags/{id}", auth.RequirePermission(models.PermSettingsWrite)(r.handleDeleteTag))
	apiMux.HandleFunc("GET /device/{serial}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceBySerial))
	apiMux.HandleFunc("DELETE /device/{serial}", auth.RequireAnyPermission(models.PermDevicesDelete, models.PermDevicesWrite)(r.handleDeleteDeviceBySerial))
	apiMux.HandleFunc("GET /device/{serial}/parameters", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceParametersBySerial))
	apiMux.HandleFunc("GET /device/{serial}/detail-parameters", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceDetailParametersBySerial))
	apiMux.HandleFunc("GET /device/{serial}/parameter-view", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceParameterViewBySerial))
	apiMux.HandleFunc("GET /device/{serial}/logs", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceLogsBySerial))
	apiMux.HandleFunc("GET /device/{serial}/tasks", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTasksBySerial))
	apiMux.HandleFunc("GET /device/{serial}/tasks/page", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTasksPageBySerial))
	apiMux.HandleFunc("GET /device/{serial}/task-counts", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTaskCountsBySerial))
	apiMux.HandleFunc("GET /device/{serial}/snapshots", auth.RequirePermission(models.PermDevicesRead)(r.handleListSnapshotsBySerial))
	apiMux.HandleFunc("POST /device/{serial}/snapshots", auth.RequireAnyPermission(models.PermDevicesSnapshots, models.PermDevicesWrite)(r.handleCreateSnapshotBySerial))
	apiMux.HandleFunc("GET /device/{serial}/snapshots/{id}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetSnapshotBySerial))
	apiMux.HandleFunc("POST /device/{serial}/snapshots/{id}/restore", auth.RequireAnyPermission(models.PermDevicesSnapshots, models.PermDevicesWrite)(r.handleRestoreSnapshotBySerial))
	apiMux.HandleFunc("DELETE /device/{serial}/snapshots/{id}", auth.RequireAnyPermission(models.PermDevicesSnapshots, models.PermDevicesWrite)(r.handleDeleteSnapshotBySerial))
	apiMux.HandleFunc("GET /device/{serial}/faults", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceFaultsBySerial))
	apiMux.HandleFunc("GET /device/{serial}/faults/page", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceFaultsPageBySerial))
	apiMux.HandleFunc("GET /device/{serial}/fault-counts", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceFaultCountsBySerial))
	apiMux.HandleFunc("PUT /device/{serial}/tags", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleSetDeviceTagsBySerial))
	apiMux.HandleFunc("POST /device/{serial}/get-parameters", auth.RequireAnyPermission(models.PermDevicesCommand, models.PermDevicesWrite)(r.handleGetParameterValuesBySerial))
	apiMux.HandleFunc("POST /device/{serial}/set-parameters", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleSetParameterValuesBySerial))
	apiMux.HandleFunc("POST /device/{serial}/reboot", auth.RequireAnyPermission(models.PermDevicesCommand, models.PermDevicesWrite)(r.handleRebootBySerial))
	apiMux.HandleFunc("POST /device/{serial}/factory-reset", auth.RequireAnyPermission(models.PermDevicesReset, models.PermDevicesWrite)(r.handleFactoryResetBySerial))
	apiMux.HandleFunc("POST /device/{serial}/connection-request", auth.RequireAnyPermission(models.PermDevicesCommand, models.PermDevicesWrite)(r.handleConnectionRequestBySerial))
	apiMux.HandleFunc("POST /device/{serial}/download-firmware", auth.RequireAnyPermission(models.PermDevicesFirmware, models.PermDevicesWrite)(r.handleDownloadFirmwareBySerial))
	apiMux.HandleFunc("PATCH /device/{serial}/conn-credentials", auth.RequireAnyPermission(models.PermDevicesCredentials, models.PermDevicesWrite)(r.handleUpdateDeviceConnCredentials))
	apiMux.HandleFunc("POST /device/{serial}/conn-credentials/generate", auth.RequireAnyPermission(models.PermDevicesCredentials, models.PermDevicesWrite)(r.handleGenerateDeviceConnCredentials))

	// Firmware endpoints
	apiMux.HandleFunc("GET /firmwares", auth.RequirePermission(models.PermFirmwaresRead)(r.handleListFirmwares))
	apiMux.HandleFunc("POST /firmwares", auth.RequireAnyPermission(models.PermFirmwaresManage, models.PermFirmwaresWrite)(r.handleUploadFirmware))
	apiMux.HandleFunc("DELETE /firmwares/{id}", auth.RequireAnyPermission(models.PermFirmwaresManage, models.PermFirmwaresWrite)(r.handleDeleteFirmware))

	// Settings endpoints
	apiMux.HandleFunc("GET /settings", auth.RequirePermission(models.PermSettingsRead)(r.handleGetSettings))
	apiMux.HandleFunc("GET /settings/connection-request-secret", auth.RequireFullAccess(auth.RequirePermission(models.PermSettingsRead)(r.handleGetConnectionRequestSecret)))
	apiMux.HandleFunc("GET /settings/retention/stats", auth.RequirePermission(models.PermSettingsRead)(r.handleRetentionStats))
	apiMux.HandleFunc("GET /settings/retention/compression", auth.RequirePermission(models.PermSettingsRead)(r.handleCompressionStatus))
	apiMux.HandleFunc("GET /settings/database/statistics", auth.RequirePermission(models.PermDatabaseStatsRead)(r.handleDatabaseStatistics))
	apiMux.HandleFunc("PUT /settings", auth.RequirePermission(models.PermSettingsWrite)(r.handleUpdateSettings))

	// Faults endpoints
	apiMux.HandleFunc("GET /faults", auth.RequirePermission(models.PermFaultsRead)(r.handleListFaults))
	apiMux.HandleFunc("GET /faults/stats", auth.RequirePermission(models.PermFaultsRead)(r.handleFaultStats))
	apiMux.HandleFunc("POST /faults/{id}/resolve", auth.RequirePermission(models.PermFaultsWrite)(r.handleResolveFault))
	apiMux.HandleFunc("DELETE /faults/{id}", auth.RequirePermission(models.PermFaultsWrite)(r.handleDeleteFault))
	apiMux.HandleFunc("POST /faults/bulk-delete", auth.RequirePermission(models.PermFaultsWrite)(r.handleBulkDeleteFaults))

	// Provisioning endpoints
	apiMux.HandleFunc("GET /provisioning", auth.RequirePermission(models.PermProvisioningRead)(r.handleListProvisioningRules))
	apiMux.HandleFunc("POST /provisioning", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleCreateProvisioningRule))
	apiMux.HandleFunc("POST /provisioning/bulk", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleBulkProvisioningRules))
	apiMux.HandleFunc("PUT /provisioning/{id}", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleUpdateProvisioningRule))
	apiMux.HandleFunc("DELETE /provisioning/{id}", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleDeleteProvisioningRule))
	apiMux.HandleFunc("POST /provisioning/{id}/toggle", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleToggleProvisioningRule))
	apiMux.HandleFunc("POST /provisioning/reorder", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleReorderProvisioningRules))
	apiMux.HandleFunc("GET /provisioning/templates", auth.RequirePermission(models.PermProvisioningRead)(r.handleListProvisioningTemplates))
	apiMux.HandleFunc("GET /provisioning/export", auth.RequirePermission(models.PermProvisioningRead)(r.handleExportProvisioning))
	apiMux.HandleFunc("POST /provisioning/import", auth.RequireAnyPermission(models.PermProvisioningRules, models.PermProvisioningWrite)(r.handleImportProvisioning))
	apiMux.HandleFunc("POST /provisioning/templates", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleCreateProvisioningTemplate))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/clone", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleCloneProvisioningTemplate))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleUpdateProvisioningTemplate))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleDeleteProvisioningTemplate))
	apiMux.HandleFunc("GET /provisioning/templates/{id}/image", auth.RequirePermission(models.PermProvisioningRead)(r.handleGetProvisioningTemplateImage))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/image", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleUploadProvisioningTemplateImage))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/image", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleDeleteProvisioningTemplateImage))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}/features", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveTemplateFeatures))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/features/import", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleImportTemplateFeature))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/features/{featureID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleDeleteTemplateFeature))
	apiMux.HandleFunc("POST /device/{serial}/features/{featureID}/controls/{key}", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleSetFeatureControl))
	apiMux.HandleFunc("POST /device/{serial}/features/{featureID}/objects/{key}", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleAddFeatureObject))
	apiMux.HandleFunc("POST /device/{serial}/features/{featureID}/objects/{key}/instances/{instance}/parameters", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleSetFeatureObjectParameter))
	apiMux.HandleFunc("DELETE /device/{serial}/features/{featureID}/objects/{key}/instances/{instance}", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleDeleteFeatureObject))
	apiMux.HandleFunc("DELETE /device/{serial}/wifi/ssids/{instance}", auth.RequireAnyPermission(models.PermDevicesConfigure, models.PermDevicesWrite)(r.handleDeleteWifiSSID))
	apiMux.HandleFunc("GET /provisioning/templates/{id}/interface-metrics", auth.RequirePermission(models.PermProvisioningRead)(r.handleListInterfaceMetrics))
	apiMux.HandleFunc("GET /provisioning/templates/{id}/metrics", auth.RequirePermission(models.PermProvisioningRead)(r.handleTemplateMetricDefinitions))
	apiMux.HandleFunc("GET /provisioning/templates/{id}/parameter-polls", auth.RequirePermission(models.PermProvisioningRead)(r.handleListParameterPolls))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/parameter-polls", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveParameterPoll))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}/parameter-polls/{pollID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveParameterPoll))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/parameter-polls/{pollID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleDeleteParameterPoll))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/metrics", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveTemplateMetric))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}/metrics/{metricID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveTemplateMetric))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/metrics/{metricID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleDeleteTemplateMetric))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/interface-metrics", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveInterfaceMetric))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}/interface-metrics/{metricID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleSaveInterfaceMetric))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/interface-metrics/{metricID}", auth.RequireAnyPermission(models.PermProvisioningTemplates, models.PermProvisioningWrite)(r.handleDeleteInterfaceMetric))
	apiMux.HandleFunc("GET /device/{serial}/interface-metrics", auth.RequirePermission(models.PermMetricsRead)(r.handleGetDeviceInterfaceMetric))
	apiMux.HandleFunc("GET /device/{serial}/interface-metric-definitions", auth.RequirePermission(models.PermMetricsRead)(r.handleListDeviceInterfaceMetricDefinitions))
	apiMux.HandleFunc("GET /device/{serial}/metric-definitions", auth.RequirePermission(models.PermMetricsRead)(r.handleDeviceMetricDefinitions))

	// Metric endpoints
	apiMux.HandleFunc("GET /metrics/definitions", auth.RequirePermission(models.PermMetricsRead)(r.handleListMetricDefinitions))
	apiMux.HandleFunc("POST /metrics/definitions", auth.RequirePermission(models.PermMetricsWrite)(r.handleCreateMetricDefinition))
	apiMux.HandleFunc("PUT /metrics/definitions/{id}", auth.RequirePermission(models.PermMetricsWrite)(r.handleUpdateMetricDefinition))
	apiMux.HandleFunc("DELETE /metrics/definitions/{id}", auth.RequirePermission(models.PermMetricsWrite)(r.handleDeleteMetricDefinition))
	apiMux.HandleFunc("GET /device/{serial}/metrics", auth.RequirePermission(models.PermMetricsRead)(r.handleGetDeviceMetrics))
	apiMux.HandleFunc("GET /devices/device-types", auth.RequirePermission(models.PermMetricsRead)(r.handleGetDeviceTypes))

	// Security center
	apiMux.HandleFunc("GET /security/overview", auth.RequirePermission(models.PermSecurityRead)(r.handleSecurityOverview))
	apiMux.HandleFunc("GET /audit-logs", auth.RequirePermission(models.PermSecurityRead)(r.handleListAuditLogs))
	apiMux.HandleFunc("GET /blocked-devices", auth.RequirePermission(models.PermSecurityRead)(r.handleListBlockedDevices))
	apiMux.HandleFunc("POST /blocked-devices", auth.RequirePermission(models.PermSecurityWrite)(r.handleAddBlockedDevice))
	apiMux.HandleFunc("DELETE /blocked-devices/{serial}", auth.RequirePermission(models.PermSecurityWrite)(r.handleRemoveBlockedDevice))

	// Authentication precedes the audit logger so actor details are available.
	protectedHandler := csrfMiddleware(auth.AuthMiddleware(r.userRepo, r.roleRepo, auditMiddleware(r.auditRepo, apiMux)))
	mux.Handle("/", r.adminWebAccessMiddleware(protectedHandler))

	return securityHeaders(corsMiddleware(requestBodyLimit(mux)))
}

func (r *Router) handleHealth(w http.ResponseWriter, req *http.Request) {
	if r.uploadInitErr != nil {
		respondError(w, http.StatusServiceUnavailable, "firmware storage unavailable")
		return
	}
	sqlDB, err := r.db.DB()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), 2*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		respondError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (r *Router) handleMeta(w http.ResponseWriter, req *http.Request) {
	appName := "ACS"
	if s, err := r.settingsRepo.Get(req.Context(), "app_name"); err == nil && s != nil && s.Value != "" {
		appName = s.Value
	}
	appLogo := ""
	if s, err := r.settingsRepo.Get(req.Context(), "app_logo"); err == nil && s != nil {
		appLogo = s.Value
	}
	respondJSON(w, http.StatusOK, map[string]string{"app_name": appName, "app_logo": appLogo})
}

func (r *Router) handleMetaLogo(w http.ResponseWriter, req *http.Request) {
	setting, err := r.settingsRepo.Get(req.Context(), "app_logo")
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Application logo is unavailable")
		return
	}
	if setting == nil || setting.Value == "" {
		http.NotFound(w, req)
		return
	}
	const prefix = "data:image/webp;base64,"
	if !strings.HasPrefix(setting.Value, prefix) {
		http.NotFound(w, req)
		return
	}
	logo, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(setting.Value, prefix))
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Application logo is invalid")
		return
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(logo)
}

func (r *Router) handleListDevices(w http.ResponseWriter, req *http.Request) {
	query := req.URL.Query()
	columns, err := parseInventoryColumns(query["columns"], query.Has("columns"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid inventory columns")
		return
	}
	filters, err := database.ParseDeviceInventoryFilters(query.Get("filters"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid inventory filters")
		return
	}
	search := strings.TrimSpace(query.Get("search"))
	if len(search) > 256 {
		respondError(w, http.StatusBadRequest, "Inventory search is too long")
		return
	}
	limit := 50
	offset := 0

	if l := req.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 500 {
			limit = parsed
		}
	}

	if o := req.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	sortColumn := query.Get("sort")
	if sortColumn != "" && !map[string]bool{
		"serial_number": true, "manufacturer": true, "model": true, "ip_address": true,
		"rx_power": true, "uptime": true, "status": true, "last_inform": true,
		"tags": true, "software_version": true, "hardware_version": true,
		"manufacturer_oui": true, "active_faults": true, "created_at": true,
	}[sortColumn] {
		respondError(w, http.StatusBadRequest, "Invalid inventory sort column")
		return
	}
	direction := strings.ToLower(query.Get("direction"))
	if direction == "" {
		direction = "asc"
	}
	if direction != "asc" && direction != "desc" {
		respondError(w, http.StatusBadRequest, "Invalid inventory sort direction")
		return
	}
	claims := auth.GetUserFromContext(req.Context())
	includeSensitive := claims != nil && claims.Role == models.RoleFull

	devices, total, err := r.deviceRepo.ListInventory(req.Context(), database.DeviceInventoryQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sortColumn, Direction: direction,
		Filters: filters, IncludeSensitive: includeSensitive,
	})
	if err != nil {
		log.Printf("Error listing devices: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list devices")
		return
	}
	if err := r.deviceRepo.LoadInventoryParameters(req.Context(), devices, columns); err != nil {
		log.Printf("Error loading inventory parameters: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to load inventory parameters")
		return
	}
	for _, device := range devices {
		device.Parameters = filterInventoryParameters(device.Parameters, columns)
		redactSensitiveParameters(req, device.Parameters)
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"devices": devices,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}

type tableQueryOptions struct {
	Limit, Offset int
	Search        string
	Sort          string
	Direction     string
	Filters       map[string]database.TableColumnFilter
}

func parseTableQuery(req *http.Request, columns ...string) (tableQueryOptions, error) {
	limit, offset := parsePagination(req, 20, 500)
	query := req.URL.Query()
	search := strings.TrimSpace(query.Get("search"))
	if len(search) > 256 {
		return tableQueryOptions{}, fmt.Errorf("search is too long")
	}
	filters, err := database.ParseTableColumnFilters(query.Get("filters"), columns)
	if err != nil {
		return tableQueryOptions{}, err
	}
	sortColumn := query.Get("sort")
	allowed := false
	for _, column := range columns {
		if sortColumn == column {
			allowed = true
			break
		}
	}
	if sortColumn != "" && !allowed {
		return tableQueryOptions{}, fmt.Errorf("invalid sort column")
	}
	direction := strings.ToLower(query.Get("direction"))
	if direction == "" {
		direction = "asc"
	}
	if direction != "asc" && direction != "desc" {
		return tableQueryOptions{}, fmt.Errorf("invalid sort direction")
	}
	return tableQueryOptions{Limit: limit, Offset: offset, Search: search, Sort: sortColumn, Direction: direction, Filters: filters}, nil
}

func parseInventoryColumns(values []string, supplied bool) ([]string, error) {
	if !supplied {
		return []string{"ip_address", "rx_power", "uptime", "software_version", "hardware_version", "manufacturer_oui"}, nil
	}
	columnChars := 0
	for _, value := range values {
		columnChars += len(value)
	}
	if columnChars > 512 {
		return nil, fmt.Errorf("inventory column list is too long")
	}
	allowed := map[string]bool{
		"serial_number": true, "manufacturer": true, "model": true, "product_class": true,
		"ip_address": true, "ppp_username": true, "rx_power": true, "uptime": true,
		"status": true, "last_inform": true, "tags": true, "software_version": true,
		"hardware_version": true, "manufacturer_oui": true, "active_faults": true, "created_at": true,
	}
	requested := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		requested = append(requested, strings.Split(value, ",")...)
	}
	if len(requested) > len(allowed) {
		return nil, fmt.Errorf("too many inventory columns")
	}
	columns := make([]string, 0, len(requested))
	seen := make(map[string]bool, len(requested))
	for _, value := range requested {
		if !allowed[value] {
			return nil, fmt.Errorf("unknown inventory column")
		}
		if !seen[value] {
			seen[value] = true
			columns = append(columns, value)
		}
	}
	return columns, nil
}

func containsInventoryColumn(columns []string, column string) bool {
	for _, current := range columns {
		if current == column {
			return true
		}
	}
	return false
}

func filterInventoryParameters(parameters []models.DeviceParameter, columns []string) []models.DeviceParameter {
	visible := make(map[string]bool, len(columns))
	for _, column := range columns {
		visible[column] = true
	}
	filtered := make([]models.DeviceParameter, 0, len(parameters))
	for _, parameter := range parameters {
		if (visible["rx_power"] && (strings.Contains(parameter.Name, "RXPower") || strings.Contains(parameter.Name, "OpticalRxPower") || strings.Contains(parameter.Name, "OpticalReceivedPower") || strings.Contains(parameter.Name, "TransceiverRxPower") || strings.Contains(parameter.Name, "ReceivedPower"))) ||
			(visible["uptime"] && parameter.Name == "InternetGatewayDevice.DeviceInfo.UpTime") ||
			(visible["ppp_username"] && strings.Contains(parameter.Name, "WANPPPConnection") && strings.Contains(parameter.Name, "Username")) ||
			(visible["software_version"] && parameter.Name == "InternetGatewayDevice.DeviceInfo.SoftwareVersion") ||
			(visible["hardware_version"] && parameter.Name == "InternetGatewayDevice.DeviceInfo.HardwareVersion") ||
			(visible["manufacturer_oui"] && parameter.Name == "InternetGatewayDevice.DeviceInfo.ManufacturerOUI") {
			filtered = append(filtered, parameter)
		}
	}
	return filtered
}

func (r *Router) handleListWANInterfaces(w http.ResponseWriter, req *http.Request) {
	options, err := parseTableQuery(req, "serial_number", "name", "type", "status", "ip_address", "mac_address")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid WAN interface query")
		return
	}
	ready, err := database.WANInterfaceCacheReady(req.Context(), r.db)
	if err != nil {
		log.Printf("Error checking WAN interface inventory readiness: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to check WAN interface inventory")
		return
	}
	if !ready {
		respondJSON(w, http.StatusOK, map[string]interface{}{"items": []models.WANInterface{}, "total": 0, "limit": options.Limit, "offset": options.Offset, "preparing": true})
		return
	}
	interfaces, total, err := r.deviceRepo.ListWANInterfacesPage(req.Context(), options.Limit, options.Offset, options.Search, options.Sort, options.Direction, options.Filters)
	if err != nil {
		log.Printf("Error listing WAN interfaces: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list WAN interfaces")
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{"items": interfaces, "total": total, "limit": options.Limit, "offset": options.Offset})
}

func (r *Router) handleListTasks(w http.ResponseWriter, req *http.Request) {
	options, err := parseTableQuery(req, "serial_number", "type", "trigger_event", "status", "created_at", "completed_at", "created_by", "deleted_by", "error")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid task query")
		return
	}
	tasks, total, err := r.taskRepo.ListWithDevicesPage(req.Context(), options.Limit, options.Offset, options.Search, options.Sort, options.Direction, options.Filters)
	if err != nil {
		log.Printf("Error listing tasks: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list tasks")
		return
	}
	counts, err := r.taskRepo.GetGlobalCounts(req.Context())
	if err != nil {
		log.Printf("Error counting tasks: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to count tasks")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"tasks": tasks, "total": total, "limit": options.Limit, "offset": options.Offset, "counts": counts})
}

func (r *Router) handleGetTask(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		respondError(w, http.StatusBadRequest, "Invalid task ID")
		return
	}
	task, err := r.taskRepo.GetWithDevice(req.Context(), id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		respondError(w, http.StatusNotFound, "Task not found")
		return
	}
	if err != nil {
		log.Printf("Error getting task %d: %v", id, err)
		respondError(w, http.StatusInternalServerError, "Failed to get task")
		return
	}
	respondJSON(w, http.StatusOK, task)
}

func (r *Router) handleDeletePendingTask(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		respondError(w, http.StatusBadRequest, "Invalid task ID")
		return
	}

	deleted, err := r.taskRepo.MarkPendingDeleted(req.Context(), id, claims.Username)
	if err != nil {
		log.Printf("Error deleting pending task %d: %v", id, err)
		respondError(w, http.StatusInternalServerError, "Failed to mark pending task as deleted")
		return
	}
	if !deleted {
		respondError(w, http.StatusConflict, "Only pending tasks can be marked as deleted")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted", "deleted_by": claims.Username})
}

func (r *Router) handleBulkDeletePendingTasks(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(body.IDs) == 0 {
		respondError(w, http.StatusBadRequest, "No task IDs provided")
		return
	}
	if len(body.IDs) > 500 {
		respondError(w, http.StatusBadRequest, "Too many task IDs provided")
		return
	}

	deleted, err := r.taskRepo.MarkPendingDeletedMany(req.Context(), body.IDs, claims.Username)
	if err != nil {
		log.Printf("Error bulk-deleting pending tasks: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to mark pending tasks as deleted")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"deleted": deleted, "deleted_by": claims.Username})
}

func (r *Router) handleGetDevice(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	device, err := r.deviceRepo.GetByID(req.Context(), id)
	if err != nil {
		log.Printf("Error getting device: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get device")
		return
	}

	if device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}

	maskDeviceSecrets(device)
	respondJSON(w, http.StatusOK, device)
}

func (r *Router) handleDeleteDevice(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	if err := r.deviceRepo.Delete(req.Context(), id); err != nil {
		log.Printf("Error deleting device: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete device")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleDeviceStats(w http.ResponseWriter, req *http.Request) {
	stats, err := r.deviceRepo.GetStats(req.Context())
	if err != nil {
		log.Printf("Error getting stats: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get stats")
		return
	}

	respondJSON(w, http.StatusOK, stats)
}

func (r *Router) handleDeviceGrowth(w http.ResponseWriter, req *http.Request) {
	interval := req.URL.Query().Get("interval")
	if interval == "" {
		interval = "daily"
	}
	points, err := r.deviceRepo.GetGrowth(req.Context(), interval)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device growth interval")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"interval": interval, "points": points})
}

func (r *Router) handleDeviceAnalytics(w http.ResponseWriter, req *http.Request) {
	devices, totalDevices, err := r.deviceRepo.ListForAnalytics(req.Context(), 10000)
	if err != nil {
		log.Printf("Error getting devices for analytics: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get analytics")
		return
	}

	// Aggregate data
	rxPowerRanges := map[string]int{
		"Excellent (-15 to -23)": 0,
		"Normal (-23 to -25)":    0,
		"Poor (-25 to -29)":      0,
		"Critical (< -29)":       0,
		"N/A":                    0,
	}

	tempRanges := map[string]int{
		"Normal (< 45)":   0,
		"Warm (45-55)":    0,
		"Hot (55-65)":     0,
		"Critical (> 65)": 0,
		"N/A":             0,
	}

	accessTypes := map[string]int{
		"EPON":  0,
		"GPON":  0,
		"Other": 0,
	}

	uptimeRanges := map[string]int{
		"< 1 hour":   0,
		"1-24 hours": 0,
		"1-7 days":   0,
		"1-30 days":  0,
		"> 1 month":  0,
	}

	lastInformRanges := map[string]int{
		"Online":       0,
		"Offline >30m": 0,
		"Offline >1h":  0,
		"Offline >1d":  0,
		"Offline >7d":  0,
		"Offline >30d": 0,
	}

	wifiStationsRanges := map[string]int{
		"0 Stations":    0,
		"1-5 Stations":  0,
		"6-10 Stations": 0,
		"10+ Stations":  0,
	}
	manufacturers := make(map[string]int)
	productClasses := make(map[string]int)

	now := time.Now()

	for _, device := range devices {
		manufacturer := "Unknown"
		if device.Manufacturer != nil && strings.TrimSpace(*device.Manufacturer) != "" {
			manufacturer = *device.Manufacturer
		}
		manufacturers[manufacturer]++
		productClass := "Unknown"
		if device.ProductClass != nil && strings.TrimSpace(*device.ProductClass) != "" {
			productClass = *device.ProductClass
		} else if device.ModelName != nil && strings.TrimSpace(*device.ModelName) != "" {
			productClass = *device.ModelName
		}
		productClasses[productClass]++
		if device.LastInform != nil {
			diff := now.Sub(*device.LastInform)
			if diff < 5*time.Minute {
				lastInformRanges["Online"]++
			} else if diff < 30*time.Minute {
				lastInformRanges["Online"]++
			} else if diff < time.Hour {
				lastInformRanges["Offline >30m"]++
			} else if diff < 24*time.Hour {
				lastInformRanges["Offline >1h"]++
			} else if diff < 7*24*time.Hour {
				lastInformRanges["Offline >1d"]++
			} else if diff < 30*24*time.Hour {
				lastInformRanges["Offline >7d"]++
			} else {
				lastInformRanges["Offline >30d"]++
			}
		} else {
			lastInformRanges["Offline >30d"]++
		}

		var deviceRxPower float64 = -999
		var deviceTemp float64 = -999
		var deviceUptime float64 = -1
		var deviceAccessType string
		totalStations := int(device.WifiStations)
		if device.RxPowerValue != nil {
			if val, err := strconv.ParseFloat(strings.TrimSpace(*device.RxPowerValue), 64); err == nil {
				if val > 0 && val < 10000 {
					val = 10 * math.Log10(val/10000)
				} else if val > 100 {
					val /= 100
				}
				deviceRxPower = val
			}
		}
		if device.Temperature != nil {
			if val, err := strconv.ParseFloat(strings.TrimSpace(*device.Temperature), 64); err == nil {
				if val > 1000 {
					val /= 256
				} else if val > 100 {
					val /= 10
				}
				deviceTemp = val
			}
		}
		if device.Uptime != nil {
			if val, err := strconv.ParseFloat(strings.TrimSpace(*device.Uptime), 64); err == nil {
				deviceUptime = val
			}
		}
		if device.AccessType != nil {
			valUpper := strings.ToUpper(*device.AccessType)
			if strings.Contains(valUpper, "EPON") {
				deviceAccessType = "EPON"
			} else if strings.Contains(valUpper, "GPON") {
				deviceAccessType = "GPON"
			} else if strings.Contains(valUpper, "ETH") {
				deviceAccessType = "Ethernet"
			} else if *device.AccessType != "" {
				deviceAccessType = "Other"
			}
		}

		// Count RX Power
		if deviceRxPower != -999 {
			if deviceRxPower >= -23 && deviceRxPower <= -15 {
				rxPowerRanges["Excellent (-15 to -23)"]++
			} else if deviceRxPower >= -25 && deviceRxPower < -23 {
				rxPowerRanges["Normal (-23 to -25)"]++
			} else if deviceRxPower >= -29 && deviceRxPower < -25 {
				rxPowerRanges["Poor (-25 to -29)"]++
			} else if deviceRxPower < -29 {
				rxPowerRanges["Critical (< -29)"]++
			}
		} else {
			rxPowerRanges["N/A"]++
		}

		// Count Temperature
		if deviceTemp != -999 {
			if deviceTemp < 45 {
				tempRanges["Normal (< 45)"]++
			} else if deviceTemp < 55 {
				tempRanges["Warm (45-55)"]++
			} else if deviceTemp < 65 {
				tempRanges["Hot (55-65)"]++
			} else {
				tempRanges["Critical (> 65)"]++
			}
		} else {
			tempRanges["N/A"]++
		}

		// Count Uptime
		if deviceUptime >= 0 {
			hours := deviceUptime / 3600
			if hours < 1 {
				uptimeRanges["< 1 hour"]++
			} else if hours < 24 {
				uptimeRanges["1-24 hours"]++
			} else if hours < 168 {
				uptimeRanges["1-7 days"]++
			} else if hours < 720 {
				uptimeRanges["1-30 days"]++
			} else {
				uptimeRanges["> 1 month"]++
			}
		}

		// Count Access Type
		if deviceAccessType != "" {
			accessTypes[deviceAccessType]++
		} else {
			accessTypes["Other"]++
		}

		// Count WiFi Stations
		if totalStations == 0 {
			wifiStationsRanges["0 Stations"]++
		} else if totalStations <= 5 {
			wifiStationsRanges["1-5 Stations"]++
		} else if totalStations <= 10 {
			wifiStationsRanges["6-10 Stations"]++
		} else {
			wifiStationsRanges["10+ Stations"]++
		}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"rxPower":        rxPowerRanges,
		"temperature":    tempRanges,
		"uptime":         uptimeRanges,
		"accessType":     accessTypes,
		"lastInform":     lastInformRanges,
		"wifiStations":   wifiStationsRanges,
		"manufacturers":  manufacturers,
		"productClasses": productClasses,
		"sampled":        len(devices),
		"total":          totalDevices,
	})
}

func (r *Router) handleDeviceParameterDistribution(w http.ResponseWriter, req *http.Request) {
	type threshold struct {
		Label string   `json:"label"`
		Max   *float64 `json:"max"`
	}
	var body struct {
		ParameterPattern string      `json:"parameter_pattern"`
		Thresholds       []threshold `json:"thresholds"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 32*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid parameter distribution request")
		return
	}
	body.ParameterPattern = strings.TrimSpace(body.ParameterPattern)
	if strings.Count(body.ParameterPattern, "*") > 8 || strings.ContainsAny(body.ParameterPattern, "?[]{}") || validateParameterNames([]string{strings.ReplaceAll(body.ParameterPattern, "*", "X")}) != nil {
		respondError(w, http.StatusBadRequest, "Invalid parameter pattern")
		return
	}
	if len(body.Thresholds) == 0 || len(body.Thresholds) > 16 {
		respondError(w, http.StatusBadRequest, "Configure between 1 and 16 thresholds")
		return
	}
	labels := make(map[string]struct{}, len(body.Thresholds))
	var previousMax *float64
	for index, item := range body.Thresholds {
		item.Label = strings.TrimSpace(item.Label)
		if item.Label == "" || len(item.Label) > 48 || strings.EqualFold(item.Label, "N/A") {
			respondError(w, http.StatusBadRequest, "Threshold labels must be unique, non-empty, and cannot be N/A")
			return
		}
		if _, exists := labels[strings.ToLower(item.Label)]; exists {
			respondError(w, http.StatusBadRequest, "Threshold labels must be unique")
			return
		}
		labels[strings.ToLower(item.Label)] = struct{}{}
		if item.Max == nil {
			if index != len(body.Thresholds)-1 {
				respondError(w, http.StatusBadRequest, "Only the final threshold may have no maximum")
				return
			}
			continue
		}
		if previousMax != nil && *item.Max <= *previousMax {
			respondError(w, http.StatusBadRequest, "Threshold maximums must be in ascending order")
			return
		}
		previousMax = item.Max
	}
	if body.Thresholds[len(body.Thresholds)-1].Max != nil {
		respondError(w, http.StatusBadRequest, "The final threshold must have no maximum")
		return
	}

	thresholds := make([]database.AnalyticsDistributionThreshold, 0, len(body.Thresholds))
	for _, item := range body.Thresholds {
		thresholds = append(thresholds, database.AnalyticsDistributionThreshold{Label: strings.TrimSpace(item.Label), Max: item.Max})
	}
	rows, err := r.deviceRepo.GetParameterDistribution(req.Context(), body.ParameterPattern, 10000, thresholds)
	if err != nil {
		log.Printf("Error getting dashboard parameter distribution: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get parameter distribution")
		return
	}
	distribution := make(map[string]int, len(body.Thresholds)+1)
	for _, item := range body.Thresholds {
		distribution[strings.TrimSpace(item.Label)] = 0
	}
	var sampled, total int
	var classified int
	for _, row := range rows {
		if row.Label == nil {
			sampled, total = row.Sampled, row.Total
			continue
		}
		distribution[*row.Label] = row.Count
		classified += row.Count
	}
	distribution["N/A"] = sampled - classified
	respondJSON(w, http.StatusOK, map[string]interface{}{"distribution": distribution, "sampled": sampled, "total": total})
}

func (r *Router) handleGetDeviceParameters(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	params, err := r.parameterRepo.GetByDeviceID(req.Context(), id)
	if err != nil {
		log.Printf("Error getting parameters: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get parameters")
		return
	}
	redactSensitiveParameters(req, params)

	respondJSON(w, http.StatusOK, params)
}

func (r *Router) handleGetDeviceTasks(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	tasks, err := r.taskRepo.GetByDeviceID(req.Context(), id, 50)
	if err != nil {
		log.Printf("Error getting tasks: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get tasks")
		return
	}

	respondJSON(w, http.StatusOK, tasks)
}

func (r *Router) handleGetParameterValues(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	var payload struct {
		Parameters []string `json:"parameters"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if len(payload.Parameters) == 0 {
		respondError(w, http.StatusBadRequest, "No parameters specified")
		return
	}
	if err := validateParameterNames(payload.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	task, err := models.NewTaskWithPayload(id, models.TaskTypeGetParameterValues, payload.Parameters)
	if err != nil {
		log.Printf("Error creating task payload: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}

	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		log.Printf("Error creating task: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}

	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleSetParameterValues(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	var payload struct {
		Parameters map[string]string `json:"parameters"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if len(payload.Parameters) == 0 {
		respondError(w, http.StatusBadRequest, "No parameters specified")
		return
	}
	if err := validateSetParameters(payload.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.rejectKnownReadOnly(req.Context(), id, payload.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	task, err := models.NewTaskWithPayload(id, models.TaskTypeSetParameterValues, payload.Parameters)
	if err != nil {
		log.Printf("Error creating task payload: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}

	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		log.Printf("Error creating task: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}

	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleReboot(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	task, err := models.NewTaskWithPayload(id, models.TaskTypeReboot, nil)
	if err != nil {
		log.Printf("Error creating task payload: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}

	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		log.Printf("Error creating task: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}

	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleFactoryReset(w http.ResponseWriter, req *http.Request) {
	if !r.requireCurrentPassword(w, req) {
		return
	}
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	task, err := models.NewTaskWithPayload(id, models.TaskTypeFactoryReset, nil)
	if err != nil {
		log.Printf("Error creating task payload: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}

	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		log.Printf("Error creating task: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}

	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) requireCurrentPassword(w http.ResponseWriter, req *http.Request) bool {
	var body struct {
		CurrentPassword string `json:"current_password"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body.CurrentPassword == "" {
		respondError(w, http.StatusBadRequest, "Current password is required")
		return false
	}
	return r.verifyCurrentPassword(w, req, body.CurrentPassword)
}

func (r *Router) verifyCurrentPassword(w http.ResponseWriter, req *http.Request, currentPassword string) bool {
	key := "reauth:" + clientIP(req)
	if !r.loginLimiter.Allow(key) {
		w.Header().Set("Retry-After", "900")
		respondError(w, http.StatusTooManyRequests, "Too many reauthentication attempts; try again later")
		return false
	}
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return false
	}
	user, err := r.userRepo.GetByID(req.Context(), claims.UserID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to verify current password")
		return false
	}
	if user == nil || !auth.CheckPassword(currentPassword, user.PasswordHash) {
		respondError(w, http.StatusForbidden, "Current password is incorrect")
		return false
	}
	r.loginLimiter.Reset(key)
	return true
}

func (r *Router) handleConnectionRequest(w http.ResponseWriter, req *http.Request) {
	id, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	device, err := r.deviceRepo.GetByID(req.Context(), id)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	r.executeConnectionRequest(w, req, device)
}

func (r *Router) executeConnectionRequest(w http.ResponseWriter, req *http.Request, device *models.Device) {
	if device.ConnectionRequestURL == nil || *device.ConnectionRequestURL == "" {
		respondError(w, http.StatusBadRequest, "Device has no connection request URL")
		return
	}
	connReqURL := *device.ConnectionRequestURL
	settings, err := r.settingsRepo.GetAll(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load connection request settings")
		return
	}
	globalUsername, globalPassword, useAuto := "", "", false
	for _, setting := range settings {
		switch setting.Key {
		case "connection_request_username":
			globalUsername = setting.Value
		case "connection_request_password":
			globalPassword = setting.Value
		case "use_auto_conn_credentials":
			useAuto = setting.Value == "true"
		}
	}
	// Resolve per-device credentials
	perDeviceMode, perDeviceUsername, perDevicePassword := "", "", ""
	if device.ConnCredMode != nil {
		perDeviceMode = *device.ConnCredMode
	}
	if device.ConnCredUsername != nil {
		perDeviceUsername = *device.ConnCredUsername
	}
	if device.ConnCredPassword != nil && *device.ConnCredPassword != "" {
		perDevicePassword, err = database.DecryptValue(*device.ConnCredPassword)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to decrypt device credentials")
			return
		}
	}
	username, password, err := netutil.ResolveConnCredentials(
		device.SerialNumber, perDeviceMode, perDeviceUsername, perDevicePassword,
		globalUsername, globalPassword, useAuto,
	)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	client, err := netutil.NewDeviceHTTPClient(connReqURL, username, password, 10*time.Second)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Unsafe connection request URL: "+err.Error())
		return
	}
	httpReq, err := http.NewRequestWithContext(req.Context(), http.MethodGet, connReqURL, nil)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create connection request")
		return
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		log.Printf("[ConnReq] %s failed: %v", device.SerialNumber, err)
		respondJSON(w, http.StatusOK, map[string]string{"status": "failed", "url": connReqURL, "message": "Device unreachable: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		respondJSON(w, http.StatusOK, map[string]string{"status": "success", "url": connReqURL, "message": "Device will send Inform in a few seconds"})
		return
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		respondJSON(w, http.StatusOK, map[string]string{"status": "auth_failed", "url": connReqURL, "message": "Connection request credentials were rejected by the device"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "unknown", "url": connReqURL, "message": "Device responded with status " + resp.Status})
}

func (r *Router) handleGetSettings(w http.ResponseWriter, req *http.Request) {
	settings, err := r.settingsRepo.GetAll(req.Context())
	if err != nil {
		log.Printf("Error getting settings: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get settings")
		return
	}

	result := database.RetentionDefaults()
	for key, value := range database.CompressionDefaults() {
		result[key] = value
	}
	for _, s := range settings {
		if isSecretSetting(s.Key) && s.Value != "" {
			result[s.Key] = "••••••••"
		} else {
			result[s.Key] = s.Value
		}
	}

	respondJSON(w, http.StatusOK, result)
}

func (r *Router) handleGetConnectionRequestSecret(w http.ResponseWriter, req *http.Request) {
	setting, err := r.settingsRepo.GetSensitive(req.Context(), "connection_request_password")
	if err != nil {
		log.Printf("Error getting connection request secret: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get connection request secret")
		return
	}
	if setting == nil {
		respondJSON(w, http.StatusOK, map[string]string{"value": ""})
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"value": setting.Value})
}

func (r *Router) handleRetentionStats(w http.ResponseWriter, req *http.Request) {
	ctx, cancel := context.WithTimeout(req.Context(), 30*time.Second)
	defer cancel()
	stats, err := database.GetRetentionTableStats(ctx, r.db)
	if err != nil {
		log.Printf("Error getting retention table stats: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get database retention stats")
		return
	}
	respondJSON(w, http.StatusOK, stats)
}

func (r *Router) handleCompressionStatus(w http.ResponseWriter, req *http.Request) {
	ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
	defer cancel()
	status, err := database.GetCompressionStatus(ctx, r.db)
	if err != nil {
		log.Printf("Error getting compression status: %v", err)
		respondError(w, http.StatusServiceUnavailable, "Compression status is unavailable")
		return
	}
	respondJSON(w, http.StatusOK, status)
}

func (r *Router) handleDatabaseStatistics(w http.ResponseWriter, req *http.Request) {
	ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
	defer cancel()
	filterJSON := req.URL.Query().Get("filters")
	if len(filterJSON) > 8192 {
		respondError(w, http.StatusBadRequest, "Database query filters are too large")
		return
	}
	filters, err := database.ParseDatabaseQueryFilters(filterJSON)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid database query filters")
		return
	}
	if err := database.ValidateDatabaseQueryFilters(filters); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid database query filters")
		return
	}
	stats, err := database.GetDatabaseStatistics(ctx, r.db, req.URL.Query().Get("sort"), req.URL.Query().Get("direction"), filters)
	if err != nil {
		log.Printf("Error getting database query statistics: %v", err)
		respondError(w, http.StatusServiceUnavailable, "Database query statistics are unavailable")
		return
	}
	respondJSON(w, http.StatusOK, stats)
}

func (r *Router) handleUpdateSettings(w http.ResponseWriter, req *http.Request) {
	var settings map[string]string
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	allowed := map[string]bool{
		"firmware_base_url": true, "connection_request_username": true,
		"connection_request_password": true, "use_auto_conn_credentials": true,
		"default_page_size": true, "chart_show_points": true, "app_name": true,
		"app_logo":               true,
		"overview_poll_interval": true, "full_tree_poll_interval": true,
		"auto_refresh_interval":  true,
		"ui_transitions_enabled": true, "ui_transition_style": true,
		"ui_transition_duration":           true,
		dashboardAggregationOptionsSetting: true,
	}
	for key := range database.RetentionDefaults() {
		allowed[key] = true
	}
	for key := range database.CompressionDefaults() {
		allowed[key] = true
	}
	if err := database.ValidateCompressionSettings(settings); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := database.ValidateRetentionSettings(settings); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	for key, value := range settings {
		if !allowed[key] {
			respondError(w, http.StatusBadRequest, "Unsupported setting: "+key)
			return
		}
		if isSecretSetting(key) && value == "••••••••" {
			delete(settings, key)
		}
	}
	if raw, ok := settings[dashboardAggregationOptionsSetting]; ok {
		validated, err := validateDashboardAggregationOptionsJSON(raw)
		if err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		settings[dashboardAggregationOptionsSetting] = validated
	}
	for _, key := range []string{"firmware_base_url"} {
		if raw, ok := settings[key]; ok {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				settings[key] = ""
				continue
			}
			parsed, err := url.Parse(raw)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				respondError(w, http.StatusBadRequest, key+" must be an absolute HTTP or HTTPS URL")
				return
			}
			settings[key] = raw
		}
	}
	if value, ok := settings["use_auto_conn_credentials"]; ok && value != "true" && value != "false" {
		respondError(w, http.StatusBadRequest, "use_auto_conn_credentials must be true or false")
		return
	}
	if value, ok := settings["default_page_size"]; ok {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 5 || parsed > 500 {
			respondError(w, http.StatusBadRequest, "default_page_size must be an integer between 5 and 500")
			return
		}
	}
	if value, ok := settings["chart_show_points"]; ok && value != "true" && value != "false" {
		respondError(w, http.StatusBadRequest, "chart_show_points must be true or false")
		return
	}
	if value, ok := settings["ui_transitions_enabled"]; ok && value != "true" && value != "false" {
		respondError(w, http.StatusBadRequest, "ui_transitions_enabled must be true or false")
		return
	}
	if value, ok := settings["ui_transition_style"]; ok && value != "fade" && value != "slide" && value != "fade-slide" {
		respondError(w, http.StatusBadRequest, "ui_transition_style must be fade, slide, or fade-slide")
		return
	}
	if value, ok := settings["ui_transition_duration"]; ok && value != "150" && value != "250" && value != "400" && value != "600" {
		respondError(w, http.StatusBadRequest, "ui_transition_duration must be 150, 250, 400, or 600 milliseconds")
		return
	}
	if value, ok := settings["auto_refresh_interval"]; ok {
		interval, err := strconv.Atoi(value)
		if err != nil || (interval != 0 && (interval < 15 || interval > 3600)) {
			respondError(w, http.StatusBadRequest, "auto_refresh_interval must be 0 or an integer between 15 and 3600 seconds")
			return
		}
	}
	for _, interval := range []struct {
		key string
		min time.Duration
		max time.Duration
	}{
		{"overview_poll_interval", time.Minute, 24 * time.Hour},
		{"full_tree_poll_interval", 15 * time.Minute, 7 * 24 * time.Hour},
	} {
		if value, ok := settings[interval.key]; ok {
			duration, err := time.ParseDuration(value)
			if err != nil || duration < interval.min || duration > interval.max {
				respondError(w, http.StatusBadRequest, interval.key+" must be a duration between "+interval.min.String()+" and "+interval.max.String())
				return
			}
		}
	}
	if value, ok := settings["app_name"]; ok {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || len(trimmed) > 64 {
			respondError(w, http.StatusBadRequest, "app_name must be a non-empty string of at most 64 characters")
			return
		}
		settings["app_name"] = trimmed
	}
	if value, ok := settings["app_logo"]; ok && value != "" {
		const logoPrefix = "data:image/webp;base64,"
		if !strings.HasPrefix(value, logoPrefix) {
			respondError(w, http.StatusBadRequest, "app_logo must be a WebP image")
			return
		}
		logoBytes, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, logoPrefix))
		if err != nil || len(logoBytes) > 128*1024 {
			respondError(w, http.StatusBadRequest, "app_logo must not exceed 128 KiB")
			return
		}
	}
	autoCredentials := settings["use_auto_conn_credentials"] == "true"
	if _, supplied := settings["use_auto_conn_credentials"]; !supplied {
		current, err := r.settingsRepo.Get(req.Context(), "use_auto_conn_credentials")
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to validate connection request mode")
			return
		}
		autoCredentials = current != nil && current.Value == "true"
	}
	if autoCredentials {
		masterSecret := settings["connection_request_password"]
		if masterSecret == "" {
			current, err := r.settingsRepo.Get(req.Context(), "connection_request_password")
			if err != nil {
				respondError(w, http.StatusInternalServerError, "Failed to validate connection request secret")
				return
			}
			if current != nil {
				masterSecret = current.Value
			}
		}
		if len(masterSecret) < 16 {
			respondError(w, http.StatusBadRequest, "Auto credentials require a connection request master secret of at least 16 characters")
			return
		}
	}

	if err := r.settingsRepo.SetMultiple(req.Context(), settings); err != nil {
		log.Printf("Error updating settings: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to update settings")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func isSecretSetting(key string) bool {
	return key == "connection_request_password"
}

func maskDeviceSecrets(device *models.Device) {
	if device.ConnCredPassword != nil && *device.ConnCredPassword != "" {
		masked := "••••••••"
		device.ConnCredPassword = &masked
	}
}

func (r *Router) handleListFirmwares(w http.ResponseWriter, req *http.Request) {
	firmwares, err := r.firmwareRepo.List(req.Context())
	if err != nil {
		log.Printf("Error listing firmwares: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list firmwares")
		return
	}
	respondJSON(w, http.StatusOK, firmwares)
}

func (r *Router) handleUploadFirmware(w http.ResponseWriter, req *http.Request) {
	if err := req.ParseMultipartForm(maxFirmwareBody); err != nil {
		respondError(w, http.StatusBadRequest, "File too large or invalid form")
		return
	}

	file, header, err := req.FormFile("file")
	if err != nil {
		respondError(w, http.StatusBadRequest, "No file uploaded")
		return
	}
	defer file.Close()

	originalFilename := filepath.Base(header.Filename)
	if originalFilename == "." || len(originalFilename) > 255 || strings.ContainsAny(originalFilename, "\r\n\x00") {
		respondError(w, http.StatusBadRequest, "Invalid firmware filename")
		return
	}
	extension := strings.ToLower(filepath.Ext(originalFilename))
	allowedExtensions := map[string]bool{".bin": true, ".img": true, ".tar": true, ".gz": true, ".zip": true}
	if !allowedExtensions[extension] {
		respondError(w, http.StatusBadRequest, "Unsupported firmware file type")
		return
	}
	version := strings.TrimSpace(req.FormValue("version"))
	if version == "" || len(version) > 128 || strings.ContainsAny(version, "\r\n\x00") {
		respondError(w, http.StatusBadRequest, "Firmware version is required and must be under 128 characters")
		return
	}
	manufacturer := strings.TrimSpace(req.FormValue("manufacturer"))
	productClass := strings.TrimSpace(req.FormValue("product_class"))
	if manufacturer == "" || productClass == "" || len(manufacturer) > 128 || len(productClass) > 128 || strings.ContainsAny(manufacturer+productClass, "\r\n\x00") {
		respondError(w, http.StatusBadRequest, "Firmware manufacturer and product class are required and must be under 128 characters")
		return
	}
	var description *string
	if value := strings.TrimSpace(req.FormValue("description")); value != "" {
		if len(value) > 2048 || strings.ContainsRune(value, '\x00') {
			respondError(w, http.StatusBadRequest, "Firmware description is invalid or exceeds 2048 characters")
			return
		}
		description = &value
	}

	tempFile, err := os.CreateTemp(r.uploadDir, ".firmware-*")
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save file")
		return
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(tempFile, hash), file)
	closeErr := tempFile.Close()
	if copyErr != nil || closeErr != nil || written == 0 {
		respondError(w, http.StatusBadRequest, "Failed to store firmware file")
		return
	}
	checksum := hex.EncodeToString(hash.Sum(nil))
	filename := strconv.FormatInt(time.Now().UnixNano(), 10) + extension
	filePath := filepath.Join(r.uploadDir, filename)
	if err := os.Chmod(tempPath, 0600); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to secure firmware file")
		return
	}
	if err := os.Rename(tempPath, filePath); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to finalize firmware file")
		return
	}

	fw := &models.Firmware{
		Filename:     originalFilename,
		Version:      version,
		FileSize:     written,
		FilePath:     filePath,
		Checksum:     &checksum,
		Manufacturer: &manufacturer,
		ProductClass: &productClass,
		Description:  description,
	}

	if err := r.firmwareRepo.Create(req.Context(), fw); err != nil {
		log.Printf("Error saving firmware: %v", err)
		if removeErr := os.Remove(filePath); removeErr != nil {
			log.Printf("Failed to remove orphaned firmware file %s: %v", filePath, removeErr)
		}
		respondError(w, http.StatusInternalServerError, "Failed to save firmware")
		return
	}

	respondJSON(w, http.StatusCreated, fw)
}

func (r *Router) handleDeleteFirmware(w http.ResponseWriter, req *http.Request) {
	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid firmware ID")
		return
	}

	fw, err := r.firmwareRepo.GetByID(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get firmware")
		return
	}
	if fw == nil {
		respondError(w, http.StatusNotFound, "Firmware not found")
		return
	}
	activeTasks, err := r.taskRepo.CountActiveFirmwareTasks(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to check active firmware tasks")
		return
	}
	if activeTasks > 0 {
		respondError(w, http.StatusConflict, "Firmware has active download tasks and cannot be deleted")
		return
	}

	quarantinePath := ""
	if _, statErr := os.Stat(fw.FilePath); statErr == nil {
		suffix, tokenErr := newFirmwareToken()
		if tokenErr != nil {
			respondError(w, http.StatusInternalServerError, "Failed to prepare firmware deletion")
			return
		}
		quarantinePath = fw.FilePath + ".deleting-" + suffix[:16]
		if err := os.Rename(fw.FilePath, quarantinePath); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to quarantine firmware file")
			return
		}
	} else if !os.IsNotExist(statErr) {
		respondError(w, http.StatusInternalServerError, "Failed to inspect firmware file")
		return
	}
	if err := r.firmwareRepo.Delete(req.Context(), id); err != nil {
		if quarantinePath != "" {
			if restoreErr := os.Rename(quarantinePath, fw.FilePath); restoreErr != nil {
				log.Printf("Failed to restore firmware after database deletion error: %v", restoreErr)
			}
		}
		respondError(w, http.StatusInternalServerError, "Failed to delete firmware record")
		return
	}
	if quarantinePath != "" {
		if err := os.Remove(quarantinePath); err != nil {
			log.Printf("Failed to remove quarantined firmware file %s: %v", quarantinePath, err)
		}
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func newFirmwareToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func (r *Router) firmwareDownloadURL(req *http.Request, fw *models.Firmware) (string, error) {
	minimumExpiry := time.Now().Add(24 * time.Hour)
	if fw.DownloadToken == "" {
		token, err := newFirmwareToken()
		if err != nil {
			return "", fmt.Errorf("failed to secure firmware download")
		}
		if err := r.firmwareRepo.UpdateDownloadToken(req.Context(), fw.ID, token, minimumExpiry); err != nil {
			return "", fmt.Errorf("failed to persist firmware download token")
		}
		fw.DownloadToken = token
		fw.TokenExpiresAt = &minimumExpiry
	} else if fw.TokenExpiresAt == nil || fw.TokenExpiresAt.Before(minimumExpiry) {
		// Extend the existing grant instead of rotating it: rotation would break
		// download tasks already queued for offline devices.
		if err := r.firmwareRepo.UpdateDownloadToken(req.Context(), fw.ID, fw.DownloadToken, minimumExpiry); err != nil {
			return "", fmt.Errorf("failed to extend firmware download token")
		}
		fw.TokenExpiresAt = &minimumExpiry
	}

	setting, err := r.settingsRepo.Get(req.Context(), "firmware_base_url")
	if err != nil || setting == nil || strings.TrimSpace(setting.Value) == "" {
		return "", fmt.Errorf("configure firmware_base_url before scheduling a download")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(setting.Value), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("firmware_base_url must be an absolute HTTP or HTTPS URL")
	}
	if parsed.Scheme != "https" && os.Getenv("ALLOW_INSECURE_FIRMWARE_URL") != "true" {
		return "", fmt.Errorf("firmware_base_url must use HTTPS")
	}

	return fmt.Sprintf("%s/files/%d/%s?token=%s", baseURL, fw.ID, url.PathEscape(fw.Filename), url.QueryEscape(fw.DownloadToken)), nil
}

func (r *Router) handleFirmwareFile(w http.ResponseWriter, req *http.Request) {
	if !r.downloadLimiter.Allow(clientIP(req)) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "Too many download requests", http.StatusTooManyRequests)
		return
	}
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, req)
		return
	}
	fw, err := r.firmwareRepo.GetByID(req.Context(), id)
	if err != nil || fw == nil || fw.DownloadToken == "" || fw.TokenExpiresAt == nil || time.Now().After(*fw.TokenExpiresAt) || req.PathValue("filename") != fw.Filename {
		http.NotFound(w, req)
		return
	}
	providedToken := req.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(providedToken), []byte(fw.DownloadToken)) != 1 {
		http.NotFound(w, req)
		return
	}

	uploadRoot, err := filepath.Abs(r.uploadDir)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Firmware storage is unavailable")
		return
	}
	firmwarePath, err := filepath.Abs(fw.FilePath)
	if err != nil {
		http.NotFound(w, req)
		return
	}
	relativePath, err := filepath.Rel(uploadRoot, firmwarePath)
	if err != nil || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		http.NotFound(w, req)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(fw.Filename)))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, req, firmwarePath)
}

func (r *Router) handleDownloadFirmware(w http.ResponseWriter, req *http.Request) {
	deviceID, err := r.parseDeviceID(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device ID")
		return
	}

	var payload struct {
		FirmwareID int64  `json:"firmware_id"`
		FileType   string `json:"file_type"` // "1 Firmware Upgrade Image", "3 Vendor Configuration File"
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	fw, err := r.firmwareRepo.GetByID(req.Context(), payload.FirmwareID)
	if err != nil || fw == nil {
		respondError(w, http.StatusNotFound, "Firmware not found")
		return
	}
	device, err := r.deviceRepo.GetByID(req.Context(), deviceID)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	if err := validateFirmwareCompatibility(device, fw); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	downloadURL, err := r.firmwareDownloadURL(req, fw)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	fileType := payload.FileType
	if fileType == "" {
		fileType = "1 Firmware Upgrade Image"
	}
	if err := validateFirmwareFileType(fileType); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	task, err := models.NewTaskWithPayload(deviceID, models.TaskTypeDownload, map[string]interface{}{
		"firmware_id":     fw.ID,
		"file_type":       fileType,
		"url":             downloadURL,
		"file_size":       fw.FileSize,
		"filename":        fw.Filename,
		"target_filename": fw.Filename,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}

	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}

	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) parseDeviceID(req *http.Request) (int64, error) {
	idStr := req.PathValue("id")
	return strconv.ParseInt(idStr, 10, 64)
}

func validateParameterNames(names []string) error {
	if len(names) > 100 {
		return errors.New("a maximum of 100 parameters can be requested per task")
	}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || len(name) > 512 || (!strings.HasPrefix(name, "Device.") && !strings.HasPrefix(name, "InternetGatewayDevice.")) {
			return fmt.Errorf("invalid parameter name %q", name)
		}
	}
	return nil
}

func validateSetParameters(parameters map[string]string) error {
	if len(parameters) > 100 {
		return errors.New("a maximum of 100 parameters can be changed per task")
	}
	names := make([]string, 0, len(parameters))
	for name, value := range parameters {
		names = append(names, name)
		if len(value) > 4096 {
			return fmt.Errorf("value for %q exceeds 4096 bytes", name)
		}
	}
	return validateParameterNames(names)
}

func (r *Router) rejectKnownReadOnly(ctx context.Context, deviceID int64, parameters map[string]string) error {
	names := make([]string, 0, len(parameters))
	for name := range parameters {
		names = append(names, name)
	}
	readOnly, err := r.parameterRepo.KnownReadOnly(ctx, deviceID, names)
	if err != nil {
		return errors.New("could not verify parameter write access")
	}
	if len(readOnly) > 0 {
		return fmt.Errorf("parameter is reported read-only by the CPE: %s", strings.Join(readOnly, ", "))
	}
	return nil
}

func validateFirmwareFileType(fileType string) error {
	switch fileType {
	case "1 Firmware Upgrade Image", "3 Vendor Configuration File":
		return nil
	default:
		return errors.New("unsupported firmware file type")
	}
}

func (r *Router) parseDeviceBySerial(req *http.Request) (*models.Device, error) {
	serial := req.PathValue("serial")
	device, err := r.deviceRepo.GetBySerial(req.Context(), serial)
	if err != nil {
		return nil, err
	}
	return device, nil
}

func (r *Router) handleGetDeviceBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get device")
		return
	}
	if device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	maskDeviceSecrets(device)
	respondJSON(w, http.StatusOK, device)
}

func (r *Router) handleDeleteDeviceBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	if err := r.deviceRepo.Delete(req.Context(), device.ID); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete device")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleGetDeviceParametersBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	params, err := r.parameterRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get parameters")
		return
	}
	redactSensitiveParameters(req, params)
	respondJSON(w, http.StatusOK, params)
}

func (r *Router) handleGetDeviceDetailParametersBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	prefixes := []string{"DeviceInfo.", "Device.DeviceInfo.", "InternetGatewayDevice.DeviceInfo.", "InternetGatewayDevice.LANDevice.", "InternetGatewayDevice.WANDevice."}
	names := []string{"InternetGatewayDevice.ManagementServer.PeriodicInformInterval", "Device.ManagementServer.PeriodicInformInterval"}
	manufacturer, productClass := "", ""
	if device.Manufacturer != nil {
		manufacturer = *device.Manufacturer
	}
	if device.ProductClass != nil {
		productClass = *device.ProductClass
	}
	template, err := r.metricRepo.TemplateForDeviceType(req.Context(), manufacturer+"/"+productClass)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		respondError(w, http.StatusInternalServerError, "Failed to load device template")
		return
	}
	if err == nil {
		var defs []models.MetricDefinition
		if err := r.db.WithContext(req.Context()).Where("template_id = ? AND active = ? AND parameter_pattern = ''", template.ID, true).Find(&defs).Error; err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to load metric parameters")
			return
		}
		for _, def := range defs {
			if def.ParameterName != "" {
				names = append(names, def.ParameterName)
			}
		}
		interfaceNames, err := r.metricRepo.InterfaceMetricParamNamesForTemplate(req.Context(), device.ID, template.ID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to load interface metric parameters")
			return
		}
		names = append(names, interfaceNames...)
		for _, feature := range template.Features {
			for _, control := range feature.Controls {
				if control.Parameter == "" {
					continue
				}
				if control.Type == "object" {
					prefix := control.Parameter
					if !strings.HasSuffix(prefix, ".") {
						prefix += "."
					}
					prefixes = append(prefixes, prefix)
				} else {
					names = append(names, control.Parameter)
				}
			}
		}
	}
	params, err := r.parameterRepo.GetByDeviceIDMatching(req.Context(), device.ID, prefixes, names)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get detail parameters")
		return
	}
	if err == nil && template != nil && len(template.DynamicParameterBranches) > 0 {
		dynamicParams, dynamicErr := r.parameterRepo.GetByDeviceIDDynamicBranches(req.Context(), device.ID, template.DynamicParameterBranches)
		if dynamicErr != nil {
			respondError(w, http.StatusInternalServerError, "Failed to get dynamic detail parameters")
			return
		}
		known := make(map[string]struct{}, len(params)+len(dynamicParams))
		for _, param := range params {
			known[param.Name] = struct{}{}
		}
		for _, param := range dynamicParams {
			if _, exists := known[param.Name]; !exists {
				params = append(params, param)
			}
		}
		sort.Slice(params, func(i, j int) bool { return params[i].Name < params[j].Name })
	}
	redactSensitiveParameters(req, params)
	respondJSON(w, http.StatusOK, params)
}

func (r *Router) handleGetDeviceParameterViewBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	query := req.URL.Query()
	prefixes, names := query["prefix"], query["name"]
	if len(prefixes)+len(names) == 0 || len(prefixes) > 64 || len(names) > 256 {
		respondError(w, http.StatusBadRequest, "Parameter view filters are missing or exceed limits")
		return
	}
	for _, value := range append(append([]string{}, prefixes...), names...) {
		if value == "" || len(value) > 512 {
			respondError(w, http.StatusBadRequest, "Invalid parameter view filter")
			return
		}
	}
	params, err := r.parameterRepo.GetByDeviceIDMatching(req.Context(), device.ID, prefixes, names)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get parameters")
		return
	}
	redactSensitiveParameters(req, params)
	respondJSON(w, http.StatusOK, params)
}

func (r *Router) handleGetDeviceLogsBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	query := req.URL.Query()
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 500 {
			respondError(w, http.StatusBadRequest, "Limit must be between 1 and 500")
			return
		}
	}
	offset := 0
	if raw := query.Get("offset"); raw != "" {
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 {
			respondError(w, http.StatusBadRequest, "Offset must be a non-negative integer")
			return
		}
	}
	if len(query.Get("filters")) > 8192 || len(query.Get("search")) > 256 {
		respondError(w, http.StatusBadRequest, "Log filters are too large")
		return
	}
	filters, err := database.ParseDeviceLogFilters(query.Get("filters"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid log filters")
		return
	}
	page, err := database.ListDeviceLogs(req.Context(), r.db, device.ID, offset, limit, database.DeviceLogFilter{
		Search: query.Get("search"), Filters: filters, Sort: query.Get("sort"), Desc: query.Get("direction") == "desc",
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get device logs")
		return
	}
	respondJSON(w, http.StatusOK, page)
}

func redactSensitiveParameters(req *http.Request, params []models.DeviceParameter) {
	claims := auth.GetUserFromContext(req.Context())
	if claims != nil && claims.Role == models.RoleFull {
		return
	}
	for index := range params {
		if database.IsSensitiveParameterName(params[index].Name) {
			params[index].Value = "[REDACTED]"
		}
	}
}

func (r *Router) handleGetDeviceTasksBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	tasks, err := r.taskRepo.GetByDeviceID(req.Context(), device.ID, 50)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get tasks")
		return
	}
	respondJSON(w, http.StatusOK, tasks)
}

func (r *Router) handleGetDeviceTasksPageBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	options, err := parseTableQuery(req, "type", "trigger_event", "status", "created_at", "completed_at", "created_by", "deleted_by", "error")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device task query")
		return
	}
	tasks, total, err := r.taskRepo.GetByDeviceIDPage(req.Context(), device.ID, options.Limit, options.Offset, options.Search, options.Sort, options.Direction, options.Filters)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get device tasks")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"items": tasks, "total": total, "limit": options.Limit, "offset": options.Offset})
}

func (r *Router) handleGetDeviceTaskCountsBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	counts, err := r.taskRepo.CountByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to count device tasks")
		return
	}
	result := map[string]int64{}
	for _, status := range []models.TaskStatus{models.TaskStatusPending, models.TaskStatusSent, models.TaskStatusCompleted, models.TaskStatusFailed, models.TaskStatusDeleted} {
		result[string(status)] = counts[status]
		result["total"] += counts[status]
	}
	respondJSON(w, http.StatusOK, result)
}

func (r *Router) handleListSnapshotsBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	snapshots, err := r.snapshotRepo.ListByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get snapshots")
		return
	}
	for index := range snapshots {
		snapshots[index].Parameters = nil
	}
	respondJSON(w, http.StatusOK, snapshots)
}

func (r *Router) handleCreateSnapshotBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	var payload struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	payload.Name = strings.TrimSpace(payload.Name)
	if payload.Name == "" {
		payload.Name = "Snapshot " + time.Now().Format("2006-01-02 15:04:05")
	}
	if len(payload.Name) > 128 {
		respondError(w, http.StatusBadRequest, "Snapshot name must be 128 characters or fewer")
		return
	}
	parameters, err := r.parameterRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read device parameters")
		return
	}
	if len(parameters) == 0 {
		respondError(w, http.StatusConflict, "No cached device parameters are available")
		return
	}
	snapshotParameters := make([]models.SnapshotParameter, 0, len(parameters))
	for _, parameter := range parameters {
		if parameter.Writable == nil || !*parameter.Writable {
			continue
		}
		value := parameter.Value
		if database.IsSensitiveParameterName(parameter.Name) {
			value, err = database.EncryptValue(value)
			if err != nil {
				respondError(w, http.StatusInternalServerError, "Failed to protect snapshot values")
				return
			}
		}
		snapshotParameters = append(snapshotParameters, models.SnapshotParameter{
			Name: parameter.Name, Value: value, ValueType: parameter.ValueType, Writable: parameter.Writable,
		})
	}
	if len(snapshotParameters) == 0 {
		respondError(w, http.StatusConflict, "No writable device parameters are available")
		return
	}
	encoded, err := json.Marshal(snapshotParameters)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to encode snapshot")
		return
	}
	snapshot := &models.DeviceSnapshot{
		DeviceID: device.ID, Name: payload.Name, Manufacturer: device.Manufacturer,
		ProductClass: device.ProductClass, SoftwareVersion: device.SoftwareVersion,
		ParameterCount: len(snapshotParameters), Parameters: models.JSON(encoded),
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		snapshot.CreatedBy = claims.Username
	}
	if err := r.snapshotRepo.Create(req.Context(), snapshot); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create snapshot")
		return
	}
	snapshot.Parameters = nil
	respondJSON(w, http.StatusCreated, snapshot)
}

func (r *Router) handleGetSnapshotBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid snapshot ID")
		return
	}
	snapshot, err := r.snapshotRepo.GetByID(req.Context(), device.ID, id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get snapshot")
		return
	}
	if snapshot == nil {
		respondError(w, http.StatusNotFound, "Snapshot not found")
		return
	}
	if err := r.decodeSnapshotParameters(snapshot, req); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to decode snapshot")
		return
	}
	respondJSON(w, http.StatusOK, snapshot)
}

func (r *Router) handleRestoreSnapshotBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid snapshot ID")
		return
	}
	snapshot, err := r.snapshotRepo.GetByID(req.Context(), device.ID, id)
	if err != nil || snapshot == nil {
		respondError(w, http.StatusNotFound, "Snapshot not found")
		return
	}
	var payload struct {
		Parameters []string `json:"parameters"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil && err != io.EOF {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	selected := make(map[string]bool, len(payload.Parameters))
	for _, name := range payload.Parameters {
		selected[name] = true
	}
	var snapshotParameters []models.SnapshotParameter
	if err := json.Unmarshal(snapshot.Parameters, &snapshotParameters); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to decode snapshot values")
		return
	}
	current, err := r.parameterRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read current device parameters")
		return
	}
	currentWritable := make(map[string]bool, len(current))
	for _, parameter := range current {
		currentWritable[parameter.Name] = parameter.Writable != nil && *parameter.Writable
	}
	values := make(map[string]string)
	for _, parameter := range snapshotParameters {
		if len(selected) > 0 && !selected[parameter.Name] {
			continue
		}
		if !currentWritable[parameter.Name] {
			continue
		}
		value := parameter.Value
		if database.IsSensitiveParameterName(parameter.Name) {
			value, err = database.DecryptValue(value)
			if err != nil {
				respondError(w, http.StatusInternalServerError, "Failed to decrypt snapshot values")
				return
			}
		}
		values[parameter.Name] = value
	}
	if len(values) == 0 {
		respondError(w, http.StatusConflict, "Snapshot has no selected writable parameters")
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeSetParameterValues, values)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create restore task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create restore task")
		return
	}
	respondJSON(w, http.StatusCreated, map[string]interface{}{"task": task, "restored": len(values)})
}

func (r *Router) handleDeleteSnapshotBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid snapshot ID")
		return
	}
	if err := r.snapshotRepo.Delete(req.Context(), device.ID, id); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete snapshot")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) decodeSnapshotParameters(snapshot *models.DeviceSnapshot, req *http.Request) error {
	var parameters []models.SnapshotParameter
	if err := json.Unmarshal(snapshot.Parameters, &parameters); err != nil {
		return err
	}
	claims := auth.GetUserFromContext(req.Context())
	fullAccess := claims != nil && claims.Role == models.RoleFull
	for index := range parameters {
		if database.IsSensitiveParameterName(parameters[index].Name) {
			if !fullAccess {
				parameters[index].Value = "[REDACTED]"
				continue
			}
			value, err := database.DecryptValue(parameters[index].Value)
			if err != nil {
				return err
			}
			parameters[index].Value = value
		}
	}
	encoded, err := json.Marshal(parameters)
	if err != nil {
		return err
	}
	snapshot.Parameters = models.JSON(encoded)
	return nil
}

func (r *Router) handleGetDeviceFaultsBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	faults, err := r.faultRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get faults")
		return
	}
	respondJSON(w, http.StatusOK, faults)
}

func (r *Router) handleGetDeviceFaultsPageBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	options, err := parseTableQuery(req, "code", "message", "parameter", "time", "status")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid device fault query")
		return
	}
	faults, total, err := r.faultRepo.GetByDeviceIDPage(req.Context(), device.ID, options.Limit, options.Offset, options.Search, options.Sort, options.Direction, options.Filters)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get device faults")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"items": faults, "total": total, "limit": options.Limit, "offset": options.Offset})
}

func (r *Router) handleGetDeviceFaultCountsBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	counts, err := r.faultRepo.GetStatsByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get fault counts")
		return
	}
	respondJSON(w, http.StatusOK, counts)
}

func (r *Router) handleSetDeviceTagsBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}

	var body struct {
		Tags []string `json:"tags"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	tags := normalizeTags(body.Tags)
	if len(tags) > 32 {
		respondError(w, http.StatusBadRequest, "A device can have at most 32 tags")
		return
	}
	for _, tag := range tags {
		if len(tag) > 64 {
			respondError(w, http.StatusBadRequest, "A tag must be 64 characters or fewer")
			return
		}
	}
	catalog, err := r.tagRepo.List(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read tag catalog")
		return
	}
	knownTags := make(map[string]struct{}, len(catalog))
	for _, definition := range catalog {
		knownTags[definition.ID] = struct{}{}
	}
	for _, tag := range tags {
		if _, exists := knownTags[tag]; !exists {
			respondError(w, http.StatusBadRequest, "Unknown tag: "+tag)
			return
		}
	}

	if err := r.deviceRepo.SetTags(req.Context(), device.ID, tags); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update tags")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"status": "updated", "tags": tags})
}

// normalizeProductClasses trims, lowercases, de-duplicates and drops empty
// product-class entries so that SQL jsonb matching is case-insensitive and stable.
func normalizeProductClasses(pcs []string) []string {
	if len(pcs) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(pcs))
	result := make([]string, 0, len(pcs))
	for _, pc := range pcs {
		pc = strings.ToLower(strings.TrimSpace(pc))
		if pc == "" {
			continue
		}
		if _, ok := seen[pc]; ok {
			continue
		}
		seen[pc] = struct{}{}
		result = append(result, pc)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// normalizeTags trims, lowercases, de-duplicates and drops empty tags so that
// tag matching is case-insensitive and stable.
func normalizeTags(tags []string) []string {
	seen := make(map[string]struct{}, len(tags))
	result := make([]string, 0, len(tags))
	for _, tag := range tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		result = append(result, tag)
	}
	return result
}

func (r *Router) handleGetParameterValuesBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	var payload struct {
		Parameters []string `json:"parameters"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if len(payload.Parameters) == 0 {
		respondError(w, http.StatusBadRequest, "No parameters specified")
		return
	}
	if err := validateParameterNames(payload.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeGetParameterValues, payload.Parameters)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleSetParameterValuesBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	var payload struct {
		Parameters map[string]string `json:"parameters"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	if len(payload.Parameters) == 0 {
		respondError(w, http.StatusBadRequest, "No parameters specified")
		return
	}
	if err := validateSetParameters(payload.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.rejectKnownReadOnly(req.Context(), device.ID, payload.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeSetParameterValues, payload.Parameters)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleRebootBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeReboot, nil)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleFactoryResetBySerial(w http.ResponseWriter, req *http.Request) {
	if !r.requireCurrentPassword(w, req) {
		return
	}
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeFactoryReset, nil)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleConnectionRequestBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	r.executeConnectionRequest(w, req, device)
}

func (r *Router) handleDownloadFirmwareBySerial(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	var payload struct {
		FirmwareID int64  `json:"firmware_id"`
		FileType   string `json:"file_type"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	fw, err := r.firmwareRepo.GetByID(req.Context(), payload.FirmwareID)
	if err != nil || fw == nil {
		respondError(w, http.StatusNotFound, "Firmware not found")
		return
	}
	if err := validateFirmwareCompatibility(device, fw); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	downloadURL, err := r.firmwareDownloadURL(req, fw)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	fileType := payload.FileType
	if fileType == "" {
		fileType = "1 Firmware Upgrade Image"
	}
	if err := validateFirmwareFileType(fileType); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeDownload, map[string]interface{}{
		"firmware_id":     fw.ID,
		"file_type":       fileType,
		"url":             downloadURL,
		"file_size":       fw.FileSize,
		"filename":        fw.Filename,
		"target_filename": fw.Filename,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleUpdateDeviceConnCredentials(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}

	var body struct {
		Mode     string `json:"mode"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate mode
	switch body.Mode {
	case "auto", "custom", "inherit":
	default:
		respondError(w, http.StatusBadRequest, "mode must be 'auto', 'custom', or 'inherit'")
		return
	}

	// Validate custom mode requires credentials
	if body.Mode == "custom" {
		if body.Username == "" || body.Password == "" {
			respondError(w, http.StatusBadRequest, "custom mode requires both username and password")
			return
		}
	}

	// Validate auto mode requires a valid global master secret
	if body.Mode == "auto" {
		current, err := r.settingsRepo.Get(req.Context(), "connection_request_password")
		if err != nil || current == nil || len(current.Value) < 16 {
			respondError(w, http.StatusBadRequest, "auto mode requires a global master secret of at least 16 characters")
			return
		}
	}

	// For "inherit" mode, clear per-device fields
	username, password := "", ""
	if body.Mode == "custom" {
		username = body.Username
		password = body.Password
	}

	if err := r.deviceRepo.SetConnCredentials(req.Context(), device.ID, body.Mode, username, password); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update connection credentials")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "updated", "mode": body.Mode})
}

func (r *Router) handleGenerateDeviceConnCredentials(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}

	// Generate a random 24-character password
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to generate password")
		return
	}
	generatedPassword := base64.RawURLEncoding.EncodeToString(buf)

	if err := r.deviceRepo.SetConnCredentials(req.Context(), device.ID, "custom", device.SerialNumber, generatedPassword); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to generate connection credentials")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{
		"status":   "generated",
		"mode":     "custom",
		"username": device.SerialNumber,
		"password": generatedPassword,
	})
}

func validateFirmwareCompatibility(device *models.Device, firmware *models.Firmware) error {
	if firmware.Manufacturer == nil || strings.TrimSpace(*firmware.Manufacturer) == "" ||
		firmware.ProductClass == nil || strings.TrimSpace(*firmware.ProductClass) == "" {
		return errors.New("firmware manufacturer and product class are required before scheduling an upgrade")
	}
	if device.Manufacturer == nil || !strings.EqualFold(strings.TrimSpace(*device.Manufacturer), strings.TrimSpace(*firmware.Manufacturer)) {
		return errors.New("firmware manufacturer does not match device")
	}
	if device.ProductClass == nil || !strings.EqualFold(strings.TrimSpace(*device.ProductClass), strings.TrimSpace(*firmware.ProductClass)) {
		return errors.New("firmware product class does not match device")
	}
	return nil
}

// Fault handlers
func (r *Router) handleListFaults(w http.ResponseWriter, req *http.Request) {
	options, err := parseTableQuery(req, "serial_number", "model_name", "fault_code", "fault_string", "parameter_name", "created_at", "resolved", "software_version", "hardware_version", "manufacturer_oui")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid fault query")
		return
	}
	var resolved *bool
	if rs := req.URL.Query().Get("resolved"); rs != "" {
		val, err := strconv.ParseBool(rs)
		if err != nil {
			respondError(w, http.StatusBadRequest, "Invalid fault state")
			return
		}
		resolved = &val
	}

	faults, total, err := r.faultRepo.ListPage(req.Context(), options.Limit, options.Offset, resolved, options.Search, options.Sort, options.Direction, options.Filters)
	if err != nil {
		log.Printf("Error listing faults: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list faults")
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"faults": faults,
		"total":  total,
		"limit":  options.Limit,
		"offset": options.Offset,
	})
}

func (r *Router) handleFaultStats(w http.ResponseWriter, req *http.Request) {
	stats, err := r.faultRepo.GetStats(req.Context())
	if err != nil {
		log.Printf("Error getting fault stats: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get stats")
		return
	}

	respondJSON(w, http.StatusOK, stats)
}

func (r *Router) handleResolveFault(w http.ResponseWriter, req *http.Request) {
	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid fault ID")
		return
	}

	if err := r.faultRepo.Resolve(req.Context(), id); err != nil {
		log.Printf("Error resolving fault: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to resolve fault")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "resolved"})
}

func (r *Router) handleDeleteFault(w http.ResponseWriter, req *http.Request) {
	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid fault ID")
		return
	}

	if err := r.faultRepo.Delete(req.Context(), id); err != nil {
		log.Printf("Error deleting fault: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete fault")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleBulkDeleteFaults(w http.ResponseWriter, req *http.Request) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(body.IDs) == 0 {
		respondError(w, http.StatusBadRequest, "No fault IDs provided")
		return
	}

	deleted, err := r.faultRepo.DeleteMany(req.Context(), body.IDs)
	if err != nil {
		log.Printf("Error bulk-deleting faults: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete faults")
		return
	}

	respondJSON(w, http.StatusOK, map[string]int64{"deleted": deleted})
}

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Failed to encode HTTP response: %v", err)
	}
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}

func (r *Router) handleLogin(w http.ResponseWriter, req *http.Request) {
	if !r.isAdminWebClientAllowed(req) {
		r.recordLoginAudit(req, "unknown", http.StatusForbidden)
		respondError(w, http.StatusForbidden, "Web UI access is not allowed from this network")
		return
	}
	ip := clientIP(req)
	if !r.loginLimiter.Allow(ip) {
		r.recordLoginAudit(req, "unknown", http.StatusTooManyRequests)
		w.Header().Set("Retry-After", "900")
		respondError(w, http.StatusTooManyRequests, "Too many login attempts; try again later")
		return
	}

	var loginReq models.LoginRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&loginReq); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	loginReq.Username = strings.TrimSpace(loginReq.Username)

	if loginReq.Username == "" || loginReq.Password == "" {
		respondError(w, http.StatusBadRequest, "Username and password required")
		return
	}

	user, err := r.userRepo.GetByUsername(req.Context(), loginReq.Username)
	if err != nil || user == nil {
		// Keep invalid-user and invalid-password paths close in cost.
		auth.CheckPassword(loginReq.Password, "$2a$12$nKdFyIgp4jmSASeOXMjq2eHRjk9J4ypQdXkxEEz2Q2nURZ4Fi9PVW")
		r.recordLoginAudit(req, loginReq.Username, http.StatusUnauthorized)
		respondError(w, http.StatusUnauthorized, "Invalid username or password")
		return
	}

	if !auth.CheckPassword(loginReq.Password, user.PasswordHash) {
		r.recordLoginAudit(req, loginReq.Username, http.StatusUnauthorized)
		respondError(w, http.StatusUnauthorized, "Invalid username or password")
		return
	}
	r.loginLimiter.Reset(ip)
	if user.Required2FA {
		if err := r.beginTwoFactorChallenge(w, req, user); err != nil {
			log.Printf("Could not start 2FA for user %d: %v", user.ID, err)
			respondError(w, http.StatusInternalServerError, "Could not start two-factor authentication")
		}
		return
	}
	r.finishLogin(w, req, user)
}

func (r *Router) beginTwoFactorChallenge(w http.ResponseWriter, req *http.Request, user *models.User) error {
	token, err := auth.GenerateTwoFactorChallengeToken(user)
	if err != nil {
		return err
	}
	if user.TwoFactorSecret != "" {
		clearSessionCookies(w, req)
		setTwoFactorChallengeCookie(w, req, token)
		respondJSON(w, http.StatusOK, models.LoginResponse{TwoFactorRequired: true})
		return nil
	}
	secret, err := database.DecryptValue(user.TwoFactorPendingSecret)
	if err != nil {
		return err
	}
	if secret == "" {
		secret, err = auth.GenerateTOTPSecret()
		if err != nil {
			return err
		}
		encrypted, encryptErr := database.EncryptValue(secret)
		if encryptErr != nil {
			return encryptErr
		}
		if err := r.userRepo.SetTwoFactorPendingSecret(req.Context(), user.ID, encrypted); err != nil {
			return err
		}
	}
	appName := "ACS"
	if setting, settingErr := r.settingsRepo.Get(req.Context(), "app_name"); settingErr == nil && setting != nil && strings.TrimSpace(setting.Value) != "" {
		appName = strings.TrimSpace(setting.Value)
	}
	label := url.PathEscape(appName + ":" + user.Username)
	otpURL := "otpauth://totp/" + label + "?secret=" + url.QueryEscape(secret) + "&issuer=" + url.QueryEscape(appName) + "&algorithm=SHA1&digits=6&period=30"
	if logo, logoErr := r.settingsRepo.Get(req.Context(), "app_logo"); logoErr == nil && logo != nil && strings.HasPrefix(logo.Value, "data:image/webp;base64,") {
		if imageURL := publicAppLogoURL(req); imageURL != "" {
			otpURL += "&image=" + url.QueryEscape(imageURL)
		}
	}
	clearSessionCookies(w, req)
	setTwoFactorChallengeCookie(w, req, token)
	respondJSON(w, http.StatusOK, models.LoginResponse{TwoFactorSetupRequired: true, TwoFactorSecret: secret, TwoFactorOTPAuthURL: otpURL})
	return nil
}

func publicAppLogoURL(req *http.Request) string {
	origin := req.Header.Get("Origin")
	if origin == "" {
		return ""
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	path := "/meta/logo"
	if isSameOrigin(req, origin) {
		path = "/api/meta/logo"
	}
	scheme := "http"
	if isSecureRequest(req) {
		scheme = "https"
	}
	return (&url.URL{Scheme: scheme, Host: req.Host, Path: path}).String()
}

func (r *Router) twoFactorChallengeMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !r.isAdminWebClientAllowed(req) {
			respondError(w, http.StatusForbidden, "Web UI access is not allowed from this network")
			return
		}
		cookie, err := req.Cookie(auth.TwoFactorCookieName)
		if err != nil {
			respondError(w, http.StatusUnauthorized, "Two-factor challenge expired; sign in again")
			return
		}
		claims, err := auth.ValidateToken(cookie.Value)
		if err != nil || claims.Purpose != "two_factor" {
			respondError(w, http.StatusUnauthorized, "Two-factor challenge expired; sign in again")
			return
		}
		user, err := r.userRepo.GetByID(req.Context(), claims.UserID)
		if err != nil || user == nil || !user.Required2FA || user.Username != claims.Username || user.Role != claims.Role || user.TokenVersion != claims.TokenVersion {
			respondError(w, http.StatusUnauthorized, "Two-factor challenge expired; sign in again")
			return
		}
		ctx := context.WithValue(req.Context(), auth.UserContextKey, claims)
		next.ServeHTTP(w, req.WithContext(ctx))
	})
}

func (r *Router) handleCompleteTwoFactorSetup(w http.ResponseWriter, req *http.Request) {
	r.completeTwoFactorChallenge(w, req, true)
}

func (r *Router) handleVerifyTwoFactor(w http.ResponseWriter, req *http.Request) {
	r.completeTwoFactorChallenge(w, req, false)
}

func (r *Router) handleCancelTwoFactor(w http.ResponseWriter, req *http.Request) {
	clearTwoFactorChallengeCookie(w, req)
	w.WriteHeader(http.StatusNoContent)
}

func (r *Router) completeTwoFactorChallenge(w http.ResponseWriter, req *http.Request, setup bool) {
	if !r.twoFactorLimiter.Allow(clientIP(req)) {
		w.Header().Set("Retry-After", "900")
		respondError(w, http.StatusTooManyRequests, "Too many two-factor attempts; try again later")
		return
	}
	claims := auth.GetUserFromContext(req.Context())
	user, err := r.userRepo.GetByID(req.Context(), claims.UserID)
	if err != nil || user == nil {
		respondError(w, http.StatusUnauthorized, "Two-factor challenge expired; sign in again")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Enter the six-digit code from your authenticator app")
		return
	}
	secretValue := user.TwoFactorSecret
	if setup {
		if user.TwoFactorSecret != "" {
			respondError(w, http.StatusConflict, "Two-factor authentication is already configured")
			return
		}
		secretValue = user.TwoFactorPendingSecret
	} else if user.TwoFactorSecret == "" {
		respondError(w, http.StatusConflict, "Two-factor authentication setup is required")
		return
	}
	secret, err := database.DecryptValue(secretValue)
	if err != nil || secret == "" {
		respondError(w, http.StatusUnauthorized, "Two-factor challenge expired; sign in again")
		return
	}
	step, valid := auth.VerifyTOTP(secret, body.Code, time.Now())
	if !valid {
		r.recordLoginAudit(req, user.Username, http.StatusUnauthorized)
		respondError(w, http.StatusUnauthorized, "Invalid authenticator code")
		return
	}
	if setup {
		if err := r.userRepo.CompleteTwoFactorSetup(req.Context(), user.ID, step); err != nil {
			respondError(w, http.StatusInternalServerError, "Could not complete two-factor setup")
			return
		}
		user, err = r.userRepo.GetByID(req.Context(), user.ID)
		if err != nil || user == nil {
			respondError(w, http.StatusInternalServerError, "Could not load user account")
			return
		}
	} else {
		consumed, consumeErr := r.userRepo.ConsumeTwoFactorStep(req.Context(), user.ID, step)
		if consumeErr != nil {
			respondError(w, http.StatusInternalServerError, "Could not verify authenticator code")
			return
		}
		if !consumed {
			respondError(w, http.StatusUnauthorized, "This authenticator code has already been used")
			return
		}
	}
	r.twoFactorLimiter.Reset(clientIP(req))
	r.finishLogin(w, req, user)
}

func (r *Router) finishLogin(w http.ResponseWriter, req *http.Request, user *models.User) {
	token, err := auth.GenerateToken(user)
	if err != nil {
		log.Printf("Error generating token: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to generate token")
		return
	}
	csrfToken, err := newCSRFToken()
	if err != nil {
		log.Printf("Error generating CSRF token: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to generate session")
		return
	}
	if err := r.userRepo.UpdateLastLogin(req.Context(), user.ID); err != nil {
		log.Printf("Failed to record last login for user %d: %v", user.ID, err)
	}
	r.loginLimiter.Reset(clientIP(req))
	r.twoFactorLimiter.Reset(clientIP(req))
	r.recordLoginAudit(req, user.Username, http.StatusOK)
	clearTwoFactorChallengeCookie(w, req)
	setSessionCookies(w, req, token, csrfToken)
	var perms []string
	if user.RoleID != nil {
		perms, _ = r.roleRepo.GetPermissions(req.Context(), *user.RoleID)
	}
	respondJSON(w, http.StatusOK, models.LoginResponse{User: user, Permissions: perms})
}

func (r *Router) handleLogout(w http.ResponseWriter, req *http.Request) {
	clearSessionCookies(w, req)
	clearTwoFactorChallengeCookie(w, req)
	w.WriteHeader(http.StatusNoContent)
}

func (r *Router) recordLoginAudit(req *http.Request, username string, status int) {
	entry := &models.AuditLog{
		Username:  truncate(username, 128),
		Action:    "LOGIN",
		Resource:  "/auth/login",
		Status:    status,
		IPAddress: clientIP(req),
		UserAgent: truncate(req.UserAgent(), 512),
	}
	if user, err := r.userRepo.GetByUsername(req.Context(), username); err == nil && user != nil {
		entry.UserID = &user.ID
	}
	if err := r.auditRepo.Create(req.Context(), entry); err != nil {
		log.Printf("Failed to record login audit event: %v", err)
	}
}

func (r *Router) handleAuthMe(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	user, err := r.userRepo.GetByID(req.Context(), claims.UserID)
	if err != nil || user == nil {
		respondError(w, http.StatusNotFound, "User not found")
		return
	}

	perms := auth.GetPermissionsFromContext(req.Context())
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"user":        user,
		"permissions": perms,
	})
}

func (r *Router) handleChangePassword(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := auth.ValidatePassword(body.NewPassword); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	user, err := r.userRepo.GetByID(req.Context(), claims.UserID)
	if err != nil || user == nil {
		respondError(w, http.StatusNotFound, "User not found")
		return
	}

	if !auth.CheckPassword(body.CurrentPassword, user.PasswordHash) {
		respondError(w, http.StatusForbidden, "Current password is incorrect")
		return
	}
	if auth.CheckPassword(body.NewPassword, user.PasswordHash) {
		respondError(w, http.StatusBadRequest, "New password must be different from the current password")
		return
	}

	hash, err := auth.HashPassword(body.NewPassword)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	if err := r.userRepo.UpdatePassword(req.Context(), user.ID, hash); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update password")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "password changed"})
}

func (r *Router) handleListUsers(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	users, err := r.userRepo.List(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list users")
		return
	}
	for _, user := range users {
		user.TwoFactorConfigured = user.TwoFactorSecret != ""
	}

	respondJSON(w, http.StatusOK, users)
}

func (r *Router) handleCreateUser(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	var body models.CreateUserRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	if !validUsername(body.Username) {
		respondError(w, http.StatusBadRequest, "Username must be 3-64 characters and use only letters, numbers, dot, dash, or underscore")
		return
	}
	if err := auth.ValidatePassword(body.Password); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	body.FirstName = strings.TrimSpace(body.FirstName)
	body.LastName = strings.TrimSpace(body.LastName)
	body.Email = strings.TrimSpace(body.Email)
	if err := validateUserProfile(body.FirstName, body.LastName, body.Email); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	roleID, legacyRole, err := r.resolveAssignedRole(req.Context(), body.RoleID, body.Role)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid role")
		return
	}

	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	user := &models.User{
		Username:     body.Username,
		FirstName:    body.FirstName,
		LastName:     body.LastName,
		Email:        body.Email,
		Required2FA:  body.Required2FA,
		PasswordHash: hash,
		Role:         legacyRole,
		RoleID:       roleID,
	}

	if err := r.userRepo.Create(req.Context(), user); err != nil {
		if strings.Contains(err.Error(), "duplicate") {
			respondError(w, http.StatusConflict, "Username already exists")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to create user")
		return
	}

	respondJSON(w, http.StatusCreated, user)
}

func (r *Router) handleUpdateUser(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	var body models.UpdateUserRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	user, err := r.userRepo.GetByID(req.Context(), id)
	if err != nil || user == nil {
		respondError(w, http.StatusNotFound, "User not found")
		return
	}
	var passwordHash string
	if body.Password != "" {
		if err := auth.ValidatePassword(body.Password); err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		passwordHash, err = auth.HashPassword(body.Password)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to hash password")
			return
		}
	}

	if body.Username != "" {
		body.Username = strings.TrimSpace(body.Username)
		if !validUsername(body.Username) {
			respondError(w, http.StatusBadRequest, "Invalid username format")
			return
		}
		user.Username = body.Username
	}
	if body.FirstName != nil {
		user.FirstName = strings.TrimSpace(*body.FirstName)
	}
	if body.LastName != nil {
		user.LastName = strings.TrimSpace(*body.LastName)
	}
	if body.Email != nil {
		user.Email = strings.TrimSpace(*body.Email)
	}
	if body.Required2FA != nil {
		user.Required2FA = *body.Required2FA
	}
	if err := validateUserProfile(user.FirstName, user.LastName, user.Email); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.RoleID != nil || body.Role != "" {
		roleID, legacyRole, resolveErr := r.resolveAssignedRole(req.Context(), body.RoleID, body.Role)
		if resolveErr != nil {
			respondError(w, http.StatusBadRequest, "Invalid role")
			return
		}
		user.RoleID = roleID
		user.Role = legacyRole
	}

	if err := r.userRepo.UpdateAccount(req.Context(), id, user.Username, user.FirstName, user.LastName, user.Email, user.Required2FA, body.Reset2FA, user.Role, user.RoleID, passwordHash); err != nil {
		if errors.Is(err, database.ErrLastFullAdmin) {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			respondError(w, http.StatusConflict, "Username already exists")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to update user")
		return
	}

	user.TwoFactorConfigured = user.TwoFactorSecret != "" && !body.Reset2FA
	respondJSON(w, http.StatusOK, user)
}

func validateUserProfile(firstName, lastName, email string) error {
	if len(firstName) > 100 || len(lastName) > 100 {
		return errors.New("First and last name must be 100 characters or fewer")
	}
	if len(email) > 254 {
		return errors.New("Email must be 254 characters or fewer")
	}
	if email != "" {
		address, err := mail.ParseAddress(email)
		if err != nil || address.Address != email {
			return errors.New("Enter a valid email address")
		}
	}
	return nil
}

func (r *Router) resolveAssignedRole(ctx context.Context, roleID *int64, fallback models.UserRole) (*int64, models.UserRole, error) {
	var role *models.Role
	var err error
	if roleID != nil {
		role, err = r.roleRepo.GetByID(ctx, *roleID)
	} else {
		if fallback != models.RoleFull && fallback != models.RoleRead {
			fallback = models.RoleRead
		}
		name := "viewer"
		if fallback == models.RoleFull {
			name = "admin"
		}
		role, err = r.roleRepo.GetByName(ctx, name)
	}
	if err != nil || role == nil {
		return nil, "", errors.New("role not found")
	}
	legacyRole := models.RoleRead
	if role.IsSystem && role.Name == "admin" {
		legacyRole = models.RoleFull
	}
	return &role.ID, legacyRole, nil
}

func (r *Router) handleDeleteUser(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	if id == claims.UserID {
		respondError(w, http.StatusBadRequest, "Cannot delete yourself")
		return
	}

	user, err := r.userRepo.GetByID(req.Context(), id)
	if err != nil || user == nil {
		respondError(w, http.StatusNotFound, "User not found")
		return
	}
	if err := r.userRepo.DeleteSafely(req.Context(), id); err != nil {
		if errors.Is(err, database.ErrLastFullAdmin) || errors.Is(err, database.ErrLastUser) {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to delete user")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleListRoles(w http.ResponseWriter, req *http.Request) {
	roles, err := r.roleRepo.List(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list roles")
		return
	}
	respondJSON(w, http.StatusOK, roles)
}

func (r *Router) handleCreateRole(w http.ResponseWriter, req *http.Request) {
	var body models.CreateRoleRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 64 {
		respondError(w, http.StatusBadRequest, "Role name is required (max 64 chars)")
		return
	}
	for _, p := range body.Permissions {
		if !isValidPermission(p) {
			respondError(w, http.StatusBadRequest, "Invalid permission: "+p)
			return
		}
	}

	role := &models.Role{
		Name:        body.Name,
		Description: body.Description,
		Permissions: body.Permissions,
	}
	if err := r.roleRepo.Create(req.Context(), role); err != nil {
		if errors.Is(err, database.ErrDuplicateRole) {
			respondError(w, http.StatusConflict, "Role name already exists")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to create role")
		return
	}
	respondJSON(w, http.StatusCreated, role)
}

func (r *Router) handleUpdateRole(w http.ResponseWriter, req *http.Request) {
	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid role ID")
		return
	}

	role, err := r.roleRepo.GetByID(req.Context(), id)
	if err != nil {
		if errors.Is(err, database.ErrRoleNotFound) {
			respondError(w, http.StatusNotFound, "Role not found")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to get role")
		return
	}
	if role.IsSystem {
		respondError(w, http.StatusBadRequest, "Cannot modify system role")
		return
	}

	var body models.UpdateRoleRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if body.Name != nil {
		role.Name = strings.TrimSpace(*body.Name)
		if role.Name == "" || len(role.Name) > 64 {
			respondError(w, http.StatusBadRequest, "Role name is required (max 64 chars)")
			return
		}
	}
	if body.Description != nil {
		role.Description = *body.Description
	}
	if body.Permissions != nil {
		for _, p := range body.Permissions {
			if !isValidPermission(p) {
				respondError(w, http.StatusBadRequest, "Invalid permission: "+p)
				return
			}
		}
		role.Permissions = body.Permissions
	}

	if err := r.roleRepo.Update(req.Context(), role); err != nil {
		if errors.Is(err, database.ErrDuplicateRole) {
			respondError(w, http.StatusConflict, "Role name already exists")
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to update role")
		return
	}
	respondJSON(w, http.StatusOK, role)
}

func (r *Router) handleDeleteRole(w http.ResponseWriter, req *http.Request) {
	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid role ID")
		return
	}

	if err := r.roleRepo.Delete(req.Context(), id); err != nil {
		switch {
		case errors.Is(err, database.ErrRoleNotFound):
			respondError(w, http.StatusNotFound, "Role not found")
		case errors.Is(err, database.ErrSystemRole):
			respondError(w, http.StatusBadRequest, "Cannot delete system role")
		case errors.Is(err, database.ErrRoleInUse):
			respondError(w, http.StatusBadRequest, "Role is assigned to one or more users")
		default:
			respondError(w, http.StatusInternalServerError, "Failed to delete role")
		}
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func isValidPermission(perm string) bool {
	for _, p := range models.AllPermissions {
		if p == perm {
			return true
		}
	}
	return false
}

func (r *Router) handleListProvisioningRules(w http.ResponseWriter, req *http.Request) {
	var rules []*models.ProvisioningRule
	var err error
	if templateIDStr := req.URL.Query().Get("template_id"); templateIDStr != "" {
		templateID, parseErr := strconv.ParseInt(templateIDStr, 10, 64)
		if parseErr != nil {
			respondError(w, http.StatusBadRequest, "Invalid template_id")
			return
		}
		rules, err = r.provisioningRepo.ListForTemplate(req.Context(), templateID)
	} else {
		rules, err = r.provisioningRepo.List(req.Context())
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list provisioning rules")
		return
	}
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		for _, rule := range rules {
			if database.IsSensitiveParameterName(rule.ParameterName) {
				rule.ParameterValue = "[REDACTED]"
			}
		}
	}
	respondJSON(w, http.StatusOK, rules)
}

var provisioningAddObjectReference = regexp.MustCompile(`\{prev([0-9]*)\}`)

// validatePrevReferenceInList checks that each referenced AddObject result is
// available before the rule in the (order, id) execution order.
func validatePrevReferenceInList(rules []*models.ProvisioningRule, ruleID int64, order int, parameterName, parameterValue, addObjectPath string) error {
	text := parameterName + "\n" + parameterValue + "\n" + addObjectPath
	refs := provisioningAddObjectReference.FindAllStringSubmatch(text, -1)
	if len(refs) == 0 {
		return nil
	}
	available := 0
	for _, rule := range rules {
		if rule.ID == ruleID {
			continue
		}
		if rule.AddObjectPath == "" {
			continue
		}
		// For create (ruleID=0): new rule gets highest id, so same-order rules precede it.
		// For update: the AddObject rule must come strictly before by (order, id).
		if rule.Order < order || (rule.Order == order && (ruleID == 0 || rule.ID < ruleID)) {
			available++
		}
	}
	for _, ref := range refs {
		required := 1
		if ref[1] != "" {
			n, err := strconv.Atoi(ref[1])
			if err != nil || n < 1 {
				return fmt.Errorf("invalid AddObject reference %s", ref[0])
			}
			required = n
		}
		if available < required {
			if ref[1] == "" {
				return fmt.Errorf("rule uses {prev} but no AddObject rule exists before it in the execution order")
			}
			return fmt.Errorf("rule uses %s but only %d AddObject rule(s) exist before it in the execution order", ref[0], available)
		}
	}
	return nil
}

// validatePrevReference loads all rules for the template and delegates to validatePrevReferenceInList.
func (r *Router) validatePrevReference(ctx context.Context, templateID, ruleID int64, order int, parameterName, parameterValue, addObjectPath string) error {
	rules, err := r.provisioningRepo.ListForTemplate(ctx, templateID)
	if err != nil {
		return fmt.Errorf("validate {prev} reference: %w", err)
	}
	return validatePrevReferenceInList(rules, ruleID, order, parameterName, parameterValue, addObjectPath)
}

func (r *Router) handleCreateProvisioningRule(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	var body models.CreateProvisioningRuleRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if body.TemplateID == 0 {
		respondError(w, http.StatusBadRequest, "template_id is required")
		return
	}
	if _, err := r.provisioningRepo.GetTemplate(req.Context(), body.TemplateID); err != nil {
		respondError(w, http.StatusBadRequest, "Template not found")
		return
	}
	if err := validateProvisioningRule(body.ParameterName, body.ParameterValue, body.ParameterType, body.AddObjectPath, body.Phase, append(append([]string{}, body.Tags...), body.ExcludedTags...), body.Description); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := cwmp.ValidateCondition(body.Condition); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid condition: "+err.Error())
		return
	}
	if err := validateAddObjectPath(body.AddObjectPath); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(body.AddObjectPath) != "" {
		body.ParameterName = ""
		body.ParameterValue = ""
		body.ParameterType = "string"
	}
	if err := r.validatePrevReference(req.Context(), body.TemplateID, 0, body.Order, body.ParameterName, body.ParameterValue, body.AddObjectPath); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	if body.ParameterType == "" {
		body.ParameterType = "string"
	}
	if body.Phase == "" {
		body.Phase = "bootstrap"
	}

	maxOrder, err := r.provisioningRepo.MaxOrder(req.Context(), body.TemplateID, body.Phase)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to determine next order")
		return
	}

	rule := &models.ProvisioningRule{
		TemplateID:     body.TemplateID,
		ParameterName:  body.ParameterName,
		ParameterValue: body.ParameterValue,
		ParameterType:  body.ParameterType,
		Phase:          body.Phase,
		Tags:           normalizeTags(body.Tags),
		ExcludedTags:   normalizeTags(body.ExcludedTags),
		Enabled:        body.Enabled,
		Description:    body.Description,
		AddObjectPath:  strings.TrimSpace(body.AddObjectPath),
		Order:          maxOrder + 1,
		Condition:      strings.TrimSpace(body.Condition),
	}

	if err := r.provisioningRepo.Create(req.Context(), rule); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create rule")
		return
	}

	respondJSON(w, http.StatusCreated, rule)
}

func (r *Router) handleUpdateProvisioningRule(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid rule ID")
		return
	}

	var body models.ProvisioningRule
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if body.TemplateID == 0 {
		respondError(w, http.StatusBadRequest, "template_id is required")
		return
	}
	if _, err := r.provisioningRepo.GetTemplate(req.Context(), body.TemplateID); err != nil {
		respondError(w, http.StatusBadRequest, "Template not found")
		return
	}
	if err := validateProvisioningRule(body.ParameterName, body.ParameterValue, body.ParameterType, body.AddObjectPath, body.Phase, append(append([]string{}, body.Tags...), body.ExcludedTags...), body.Description); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := cwmp.ValidateCondition(body.Condition); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid condition: "+err.Error())
		return
	}
	if err := validateAddObjectPath(body.AddObjectPath); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(body.AddObjectPath) != "" {
		body.ParameterName = ""
		body.ParameterValue = ""
		body.ParameterType = "string"
	}
	if err := r.validatePrevReference(req.Context(), body.TemplateID, id, body.Order, body.ParameterName, body.ParameterValue, body.AddObjectPath); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	body.ID = id
	body.Condition = strings.TrimSpace(body.Condition)
	body.Tags = normalizeTags(body.Tags)
	body.ExcludedTags = normalizeTags(body.ExcludedTags)
	if err := r.provisioningRepo.Update(req.Context(), &body); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update rule")
		return
	}

	respondJSON(w, http.StatusOK, body)
}

func validateProvisioningRule(name, value, valueType, addObjectPath, phase string, tags []string, description string) error {
	if strings.TrimSpace(addObjectPath) == "" {
		if err := validateParameterNames([]string{name}); err != nil {
			return err
		}
		if len(value) > 4096 {
			return errors.New("provisioning value exceeds 4096 bytes")
		}
		switch valueType {
		case "", "string", "boolean", "int", "unsignedInt", "long", "unsignedLong", "dateTime", "base64", "hexBinary":
		default:
			return errors.New("unsupported CWMP parameter type")
		}
	}
	switch phase {
	case "", "bootstrap", "default":
	default:
		return errors.New("unsupported provisioning phase (must be 'bootstrap' or 'default')")
	}
	if len(tags) > 32 {
		return errors.New("a rule can target at most 32 tags")
	}
	for _, tag := range tags {
		if len(tag) > 128 {
			return errors.New("tag entry exceeds 128 characters")
		}
	}
	if len(description) > 2048 || strings.ContainsRune(description, '\x00') {
		return errors.New("provisioning description is invalid or exceeds 2048 characters")
	}
	return nil
}

func validateAddObjectPath(path string) error {
	if path == "" {
		return nil
	}
	if len(path) > 512 {
		return errors.New("add_object_path exceeds 512 characters")
	}
	if err := validateParameterNames([]string{path}); err != nil {
		return fmt.Errorf("invalid add_object_path: %w", err)
	}
	return nil
}

func (r *Router) handleDeleteProvisioningRule(w http.ResponseWriter, req *http.Request) {
	if !r.requireCurrentPassword(w, req) {
		return
	}
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid rule ID")
		return
	}

	if err := r.provisioningRepo.Delete(req.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete rule")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (r *Router) handleToggleProvisioningRule(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid rule ID")
		return
	}

	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := r.provisioningRepo.ToggleEnabled(req.Context(), id, body.Enabled); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to toggle rule")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

func (r *Router) handleBulkProvisioningRules(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	var body struct {
		TemplateID      int64   `json:"template_id"`
		IDs             []int64 `json:"ids"`
		Action          string  `json:"action"`
		CurrentPassword string  `json:"current_password"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if body.TemplateID == 0 || len(body.IDs) == 0 {
		respondError(w, http.StatusBadRequest, "template_id and ids are required")
		return
	}
	if body.Action != "enable" && body.Action != "disable" && body.Action != "delete" {
		respondError(w, http.StatusBadRequest, "action must be enable, disable, or delete")
		return
	}
	if body.Action == "delete" && !r.verifyCurrentPassword(w, req, body.CurrentPassword) {
		return
	}

	var err error
	switch body.Action {
	case "enable", "disable":
		err = r.provisioningRepo.BulkToggleEnabled(req.Context(), body.TemplateID, body.IDs, body.Action == "enable")
	case "delete":
		err = r.provisioningRepo.BulkDelete(req.Context(), body.TemplateID, body.IDs)
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to apply bulk rule action")
		return
	}

	status := map[string]string{"enable": "enabled", "disable": "disabled", "delete": "deleted"}[body.Action]
	respondJSON(w, http.StatusOK, map[string]string{"status": status})
}

func (r *Router) handleReorderProvisioningRules(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	var body struct {
		TemplateID int64   `json:"template_id"`
		IDs        []int64 `json:"ids"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if body.TemplateID == 0 {
		respondError(w, http.StatusBadRequest, "template_id is required")
		return
	}
	if len(body.IDs) == 0 {
		respondError(w, http.StatusBadRequest, "IDs list is required")
		return
	}

	if err := r.provisioningRepo.Reorder(req.Context(), body.TemplateID, body.IDs); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to reorder rules")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "reordered"})
}

// ── Provisioning Template Handlers ───────────────────────────────────────────

func (r *Router) handleListProvisioningTemplates(w http.ResponseWriter, req *http.Request) {
	templates, err := r.provisioningRepo.ListTemplates(req.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list provisioning templates")
		return
	}
	for _, template := range templates {
		r.templateImageURL(template)
		redactProvisioningVariableSecrets(template.Variables)
	}
	respondJSON(w, http.StatusOK, templates)
}

func (r *Router) handleCreateProvisioningTemplate(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	var body models.CreateProvisioningTemplateRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		respondError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(body.Name) > 256 {
		respondError(w, http.StatusBadRequest, "name exceeds 256 characters")
		return
	}
	if len(body.Manufacturer) > 128 {
		respondError(w, http.StatusBadRequest, "manufacturer exceeds 128 characters")
		return
	}
	if len(body.ProductClass) > 128 {
		respondError(w, http.StatusBadRequest, "product_class exceeds 128 characters")
		return
	}
	inventory := models.TemplateInventory{}
	if body.Inventory != nil {
		inventory = *body.Inventory
	}
	if err := validateTemplateInventory(&inventory); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateDynamicParameterBranches(body.DynamicParameterBranches); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	template := &models.ProvisioningTemplate{
		Name:                     strings.TrimSpace(body.Name),
		Manufacturer:             strings.ToLower(strings.TrimSpace(body.Manufacturer)),
		ProductClass:             strings.ToLower(strings.TrimSpace(body.ProductClass)),
		Description:              strings.TrimSpace(body.Description),
		Inventory:                inventory,
		DynamicParameterBranches: normalizeDynamicParameterBranches(body.DynamicParameterBranches),
		Variables:                body.Variables,
	}
	if err := prepareProvisioningVariableSecrets(template.Variables, nil); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateProvisioningVariables(template.Variables); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.provisioningRepo.CreateTemplate(req.Context(), template); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create template")
		return
	}
	r.templateImageURL(template)
	redactProvisioningVariableSecrets(template.Variables)
	respondJSON(w, http.StatusCreated, template)
}

func (r *Router) handleUpdateProvisioningTemplate(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}

	var body models.CreateProvisioningTemplateRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		respondError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(body.Name) > 256 {
		respondError(w, http.StatusBadRequest, "name exceeds 256 characters")
		return
	}
	if len(body.Manufacturer) > 128 {
		respondError(w, http.StatusBadRequest, "manufacturer exceeds 128 characters")
		return
	}
	if len(body.ProductClass) > 128 {
		respondError(w, http.StatusBadRequest, "product_class exceeds 128 characters")
		return
	}
	previous, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	inventory := previous.Inventory
	if body.Inventory != nil {
		inventory = *body.Inventory
	}
	if err := validateTemplateInventory(&inventory); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	dynamicBranches := previous.DynamicParameterBranches
	if body.DynamicParameterBranches != nil {
		dynamicBranches = normalizeDynamicParameterBranches(body.DynamicParameterBranches)
	}
	if err := validateDynamicParameterBranches(dynamicBranches); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	template := &models.ProvisioningTemplate{
		ID:                       id,
		Name:                     strings.TrimSpace(body.Name),
		Manufacturer:             strings.ToLower(strings.TrimSpace(body.Manufacturer)),
		ProductClass:             strings.ToLower(strings.TrimSpace(body.ProductClass)),
		Description:              strings.TrimSpace(body.Description),
		Inventory:                inventory,
		DynamicParameterBranches: dynamicBranches,
		Variables:                body.Variables,
	}
	if err := prepareProvisioningVariableSecrets(template.Variables, previous.Variables); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateProvisioningVariables(template.Variables); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.provisioningRepo.UpdateTemplate(req.Context(), template); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update template")
		return
	}
	if err := r.db.WithContext(req.Context()).Model(&models.MetricDefinition{}).Where("template_id = ?", id).Update("device_type_match", template.Manufacturer+"/"+template.ProductClass).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Template was updated but metric scopes could not be refreshed")
		return
	}
	updated, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load updated template")
		return
	}
	r.templateImageURL(updated)
	redactProvisioningVariableSecrets(updated.Variables)
	respondJSON(w, http.StatusOK, updated)
}

func (r *Router) handleDeleteProvisioningTemplate(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}

	idStr := req.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}

	template, _ := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err := r.provisioningRepo.DeleteTemplate(req.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete template")
		return
	}
	if template != nil && template.ImagePath != "" {
		if imagePath, pathErr := secureTemplateImagePath(r.templateImageDir, template.ImagePath); pathErr == nil {
			_ = os.Remove(imagePath)
		}
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func validateTemplateInventory(settings *models.TemplateInventory) error {
	if settings == nil {
		return nil
	}
	settings.PrimaryIPMode = strings.TrimSpace(settings.PrimaryIPMode)
	settings.PrimaryIPParameter = strings.TrimSpace(settings.PrimaryIPParameter)
	settings.PrimaryIPInterfaceName = strings.TrimSpace(settings.PrimaryIPInterfaceName)
	if settings.PrimaryIPMode == "" {
		settings.PrimaryIPMode = "automatic"
	}
	switch settings.PrimaryIPMode {
	case "automatic":
		settings.PrimaryIPParameter = ""
		settings.PrimaryIPInterfaceName = ""
	case "parameter":
		if err := validateParameterNames([]string{settings.PrimaryIPParameter}); err != nil {
			return fmt.Errorf("primary IP parameter is invalid: %w", err)
		}
		settings.PrimaryIPInterfaceName = ""
	case "interface_name":
		if settings.PrimaryIPInterfaceName == "" || len(settings.PrimaryIPInterfaceName) > 256 || strings.ContainsAny(settings.PrimaryIPInterfaceName, "\r\n\x00") {
			return errors.New("primary IP interface name is required and must be under 256 characters")
		}
		settings.PrimaryIPParameter = ""
	default:
		return fmt.Errorf("unsupported primary IP mode %q", settings.PrimaryIPMode)
	}
	return nil
}

func normalizeDynamicParameterBranches(branches []string) []string {
	seen := make(map[string]bool, len(branches))
	result := make([]string, 0, len(branches))
	for _, branch := range branches {
		branch = strings.TrimSpace(branch)
		if branch == "" || seen[branch] {
			continue
		}
		seen[branch] = true
		result = append(result, branch)
	}
	return result
}

func validateDynamicParameterBranches(branches []string) error {
	if len(branches) > 64 {
		return errors.New("a template can define at most 64 dynamic parameter branches")
	}
	seen := make(map[string]bool, len(branches))
	for _, raw := range branches {
		branch := strings.TrimSpace(raw)
		if branch == "" || len(branch) > 512 || seen[branch] {
			if branch == "" || len(branch) > 512 {
				return fmt.Errorf("dynamic parameter branch must be 1–512 characters")
			}
			return fmt.Errorf("duplicate dynamic parameter branch %q", branch)
		}
		seen[branch] = true
		if !strings.HasSuffix(branch, ".") || (!strings.HasPrefix(branch, "InternetGatewayDevice.") && !strings.HasPrefix(branch, "Device.")) {
			return fmt.Errorf("invalid dynamic parameter branch %q: use a CWMP object path ending in a dot", branch)
		}
		parts := strings.Split(strings.TrimSuffix(branch, "."), ".")
		for _, part := range parts {
			if part == "" || part == "*" {
				continue
			}
			for _, character := range part {
				if !(character == '_' || character == '-' || character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9') {
					return fmt.Errorf("invalid segment in dynamic parameter branch %q", branch)
				}
			}
		}
	}
	return nil
}

func validateProvisioningVariables(variables []models.ProvisioningVariable) error {
	if len(variables) > 100 {
		return errors.New("a template can define at most 100 variables")
	}
	namePattern := regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	allowedSources := map[string]bool{"": true, "literal": true, "serial_number": true, "manufacturer": true, "product_class": true, "oui": true, "parameter": true}
	allowedFunctions := map[string]bool{"trim": true, "upper": true, "lower": true, "prefix": true, "suffix": true, "slice": true, "replace": true, "regex_replace": true, "pad_start": true, "pad_end": true, "default": true, "random_string": true, "sha256": true, "hmac_sha256": true, "base64_encode": true, "base64_decode": true, "hex_encode": true, "hex_decode": true}
	seen := make(map[string]bool, len(variables))
	for _, variable := range variables {
		if !namePattern.MatchString(variable.Name) || seen[variable.Name] {
			return fmt.Errorf("variable names must be unique identifiers: %q", variable.Name)
		}
		seen[variable.Name] = true
		if !allowedSources[variable.Source] {
			return fmt.Errorf("unsupported source %q for variable %s", variable.Source, variable.Name)
		}
		if variable.Source == "parameter" {
			if variable.Value == "" || len(variable.Value) > 512 {
				return fmt.Errorf("parameter source for variable %s requires a parameter path up to 512 characters", variable.Name)
			}
			if err := validateParameterNames([]string{variable.Value}); err != nil {
				return fmt.Errorf("invalid parameter source for variable %s: %w", variable.Name, err)
			}
		}
		if len(variable.Value) > 4096 || len(variable.Steps) > 20 {
			return fmt.Errorf("variable %s exceeds the value or transformation limit", variable.Name)
		}
		for _, step := range variable.Steps {
			if !allowedFunctions[step.Function] {
				return fmt.Errorf("unsupported transformation %q for variable %s", step.Function, variable.Name)
			}
			for _, value := range step.Args {
				if len(value) > 4096 {
					return fmt.Errorf("transformation argument for %s is too long", variable.Name)
				}
			}
			if step.Function == "regex_replace" {
				if _, err := regexp.Compile(step.Args["pattern"]); err != nil {
					return fmt.Errorf("invalid regex in variable %s: %w", variable.Name, err)
				}
			}
			if step.Function == "random_string" {
				length, err := strconv.Atoi(step.Args["length"])
				charset := step.Args["charset"]
				if err != nil || length < 1 || length > 256 || (charset != "alphanumeric" && charset != "digits" && charset != "lowercase" && charset != "uppercase" && charset != "hex") {
					return fmt.Errorf("random_string in variable %s requires length 1–256 and a supported charset", variable.Name)
				}
			}
			if step.Function == "hmac_sha256" {
				if step.Args["key_source"] != "application" && step.Args["key_source"] != "custom" {
					return fmt.Errorf("hmac_sha256 in variable %s requires an application or custom key source", variable.Name)
				}
				encoding := step.Args["encoding"]
				if encoding != "" && encoding != "connection_request" && encoding != "base64url" && encoding != "hex" {
					return fmt.Errorf("hmac_sha256 in variable %s has an unsupported output encoding", variable.Name)
				}
				if step.Args["key_source"] == "custom" {
					secret := step.Args["key_secret"]
					if secret != "" && !strings.HasPrefix(secret, "enc:v1:") && len(secret) < 16 {
						return fmt.Errorf("hmac_sha256 in variable %s requires a custom key of at least 16 characters", variable.Name)
					}
				}
			}
		}
	}
	return nil
}
