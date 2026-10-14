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
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/auth"
	"github.com/skydashnet/skyacs/internal/cwmp"
	"github.com/skydashnet/skyacs/internal/database"
	"github.com/skydashnet/skyacs/internal/models"
	"github.com/skydashnet/skyacs/internal/netutil"
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
	roleRepo             *database.RoleRepository
	provisioningRepo     *database.ProvisioningRepository
	auditRepo            *database.AuditRepository
	blockedRepo          *database.BlockedDeviceRepository
	metricRepo           *database.MetricRepository
	snapshotRepo         *database.SnapshotRepository
	tagRepo              *database.TagRepository
	loginLimiter         *loginLimiter
	downloadLimiter      *loginLimiter
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
		roleRepo:             database.NewRoleRepository(db),
		provisioningRepo:     database.NewProvisioningRepository(db),
		auditRepo:            database.NewAuditRepository(db),
		blockedRepo:          database.NewBlockedDeviceRepository(db),
		metricRepo:           database.NewMetricRepository(db),
		snapshotRepo:         database.NewSnapshotRepository(db),
		tagRepo:              database.NewTagRepository(db),
		loginLimiter:         newLoginLimiter(5, 15*time.Minute),
		downloadLimiter:      newLoginLimiter(60, time.Minute),
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
	mux.HandleFunc("POST /auth/login", r.handleLogin)
	mux.HandleFunc("GET /files/{id}/{filename}", r.handleFirmwareFile)

	// Protected API mux
	apiMux := http.NewServeMux()

	// Auth endpoints
	apiMux.HandleFunc("GET /auth/me", r.handleAuthMe)
	apiMux.HandleFunc("POST /auth/change-password", r.handleChangePassword)

	// User management
	apiMux.HandleFunc("GET /users", auth.RequirePermission(models.PermUsersRead)(r.handleListUsers))
	apiMux.HandleFunc("POST /users", auth.RequirePermission(models.PermUsersWrite)(r.handleCreateUser))
	apiMux.HandleFunc("PUT /users/{id}", auth.RequirePermission(models.PermUsersWrite)(r.handleUpdateUser))
	apiMux.HandleFunc("DELETE /users/{id}", auth.RequirePermission(models.PermUsersWrite)(r.handleDeleteUser))

	// Role management
	apiMux.HandleFunc("GET /roles", auth.RequirePermission(models.PermRolesRead)(r.handleListRoles))
	apiMux.HandleFunc("POST /roles", auth.RequirePermission(models.PermRolesWrite)(r.handleCreateRole))
	apiMux.HandleFunc("PUT /roles/{id}", auth.RequirePermission(models.PermRolesWrite)(r.handleUpdateRole))
	apiMux.HandleFunc("DELETE /roles/{id}", auth.RequirePermission(models.PermRolesWrite)(r.handleDeleteRole))

	// Device endpoints (by ID - legacy)
	apiMux.HandleFunc("GET /devices", auth.RequirePermission(models.PermDevicesRead)(r.handleListDevices))
	apiMux.HandleFunc("GET /wan-interfaces", auth.RequirePermission(models.PermDevicesRead)(r.handleListWANInterfaces))
	apiMux.HandleFunc("GET /tasks", auth.RequirePermission(models.PermDevicesRead)(r.handleListTasks))
	apiMux.HandleFunc("DELETE /tasks/{id}", auth.RequirePermission(models.PermDevicesWrite)(r.handleDeletePendingTask))
	apiMux.HandleFunc("GET /devices/stats", auth.RequirePermission(models.PermDevicesRead)(r.handleDeviceStats))
	apiMux.HandleFunc("GET /devices/analytics", auth.RequirePermission(models.PermDevicesRead)(r.handleDeviceAnalytics))
	apiMux.HandleFunc("GET /devices/{id}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDevice))
	apiMux.HandleFunc("DELETE /devices/{id}", auth.RequirePermission(models.PermDevicesWrite)(r.handleDeleteDevice))
	apiMux.HandleFunc("GET /devices/{id}/parameters", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceParameters))
	apiMux.HandleFunc("GET /devices/{id}/tasks", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTasks))

	// Device actions (by ID - legacy)
	apiMux.HandleFunc("POST /devices/{id}/get-parameters", auth.RequirePermission(models.PermDevicesWrite)(r.handleGetParameterValues))
	apiMux.HandleFunc("POST /devices/{id}/set-parameters", auth.RequirePermission(models.PermDevicesWrite)(r.handleSetParameterValues))
	apiMux.HandleFunc("POST /devices/{id}/reboot", auth.RequirePermission(models.PermDevicesWrite)(r.handleReboot))
	apiMux.HandleFunc("POST /devices/{id}/factory-reset", auth.RequirePermission(models.PermDevicesWrite)(r.handleFactoryReset))
	apiMux.HandleFunc("POST /devices/{id}/connection-request", auth.RequirePermission(models.PermDevicesWrite)(r.handleConnectionRequest))
	apiMux.HandleFunc("POST /devices/{id}/download-firmware", auth.RequirePermission(models.PermDevicesWrite)(r.handleDownloadFirmware))

	// Device endpoints (by serial - new)
	apiMux.HandleFunc("GET /tags", auth.RequireAnyPermission(models.PermDevicesRead, models.PermSettingsRead, models.PermProvisioningRead)(r.handleListTags))
	apiMux.HandleFunc("POST /tags", auth.RequirePermission(models.PermSettingsWrite)(r.handleCreateTag))
	apiMux.HandleFunc("PUT /tags/{id}", auth.RequirePermission(models.PermSettingsWrite)(r.handleUpdateTag))
	apiMux.HandleFunc("DELETE /tags/{id}", auth.RequirePermission(models.PermSettingsWrite)(r.handleDeleteTag))
	apiMux.HandleFunc("GET /device/{serial}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceBySerial))
	apiMux.HandleFunc("DELETE /device/{serial}", auth.RequirePermission(models.PermDevicesWrite)(r.handleDeleteDeviceBySerial))
	apiMux.HandleFunc("GET /device/{serial}/parameters", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceParametersBySerial))
	apiMux.HandleFunc("GET /device/{serial}/tasks", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTasksBySerial))
	apiMux.HandleFunc("GET /device/{serial}/task-counts", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceTaskCountsBySerial))
	apiMux.HandleFunc("GET /device/{serial}/snapshots", auth.RequirePermission(models.PermDevicesRead)(r.handleListSnapshotsBySerial))
	apiMux.HandleFunc("POST /device/{serial}/snapshots", auth.RequirePermission(models.PermDevicesWrite)(r.handleCreateSnapshotBySerial))
	apiMux.HandleFunc("GET /device/{serial}/snapshots/{id}", auth.RequirePermission(models.PermDevicesRead)(r.handleGetSnapshotBySerial))
	apiMux.HandleFunc("POST /device/{serial}/snapshots/{id}/restore", auth.RequirePermission(models.PermDevicesWrite)(r.handleRestoreSnapshotBySerial))
	apiMux.HandleFunc("DELETE /device/{serial}/snapshots/{id}", auth.RequirePermission(models.PermDevicesWrite)(r.handleDeleteSnapshotBySerial))
	apiMux.HandleFunc("GET /device/{serial}/faults", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceFaultsBySerial))
	apiMux.HandleFunc("GET /device/{serial}/fault-counts", auth.RequirePermission(models.PermDevicesRead)(r.handleGetDeviceFaultCountsBySerial))
	apiMux.HandleFunc("PUT /device/{serial}/tags", auth.RequirePermission(models.PermDevicesWrite)(r.handleSetDeviceTagsBySerial))
	apiMux.HandleFunc("POST /device/{serial}/get-parameters", auth.RequirePermission(models.PermDevicesWrite)(r.handleGetParameterValuesBySerial))
	apiMux.HandleFunc("POST /device/{serial}/set-parameters", auth.RequirePermission(models.PermDevicesWrite)(r.handleSetParameterValuesBySerial))
	apiMux.HandleFunc("POST /device/{serial}/reboot", auth.RequirePermission(models.PermDevicesWrite)(r.handleRebootBySerial))
	apiMux.HandleFunc("POST /device/{serial}/factory-reset", auth.RequirePermission(models.PermDevicesWrite)(r.handleFactoryResetBySerial))
	apiMux.HandleFunc("POST /device/{serial}/connection-request", auth.RequirePermission(models.PermDevicesWrite)(r.handleConnectionRequestBySerial))
	apiMux.HandleFunc("POST /device/{serial}/download-firmware", auth.RequirePermission(models.PermDevicesWrite)(r.handleDownloadFirmwareBySerial))
	apiMux.HandleFunc("PATCH /device/{serial}/conn-credentials", auth.RequirePermission(models.PermDevicesWrite)(r.handleUpdateDeviceConnCredentials))
	apiMux.HandleFunc("POST /device/{serial}/conn-credentials/generate", auth.RequirePermission(models.PermDevicesWrite)(r.handleGenerateDeviceConnCredentials))

	// Firmware endpoints
	apiMux.HandleFunc("GET /firmwares", auth.RequirePermission(models.PermFirmwaresRead)(r.handleListFirmwares))
	apiMux.HandleFunc("POST /firmwares", auth.RequirePermission(models.PermFirmwaresWrite)(r.handleUploadFirmware))
	apiMux.HandleFunc("DELETE /firmwares/{id}", auth.RequirePermission(models.PermFirmwaresWrite)(r.handleDeleteFirmware))

	// Settings endpoints
	apiMux.HandleFunc("GET /settings", auth.RequirePermission(models.PermSettingsRead)(r.handleGetSettings))
	apiMux.HandleFunc("PUT /settings", auth.RequirePermission(models.PermSettingsWrite)(r.handleUpdateSettings))

	// Faults endpoints
	apiMux.HandleFunc("GET /faults", auth.RequirePermission(models.PermFaultsRead)(r.handleListFaults))
	apiMux.HandleFunc("GET /faults/stats", auth.RequirePermission(models.PermFaultsRead)(r.handleFaultStats))
	apiMux.HandleFunc("POST /faults/{id}/resolve", auth.RequirePermission(models.PermFaultsWrite)(r.handleResolveFault))
	apiMux.HandleFunc("DELETE /faults/{id}", auth.RequirePermission(models.PermFaultsWrite)(r.handleDeleteFault))
	apiMux.HandleFunc("POST /faults/bulk-delete", auth.RequirePermission(models.PermFaultsWrite)(r.handleBulkDeleteFaults))

	// Provisioning endpoints
	apiMux.HandleFunc("GET /provisioning", auth.RequirePermission(models.PermProvisioningRead)(r.handleListProvisioningRules))
	apiMux.HandleFunc("POST /provisioning", auth.RequirePermission(models.PermProvisioningWrite)(r.handleCreateProvisioningRule))
	apiMux.HandleFunc("PUT /provisioning/{id}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleUpdateProvisioningRule))
	apiMux.HandleFunc("DELETE /provisioning/{id}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleDeleteProvisioningRule))
	apiMux.HandleFunc("POST /provisioning/{id}/toggle", auth.RequirePermission(models.PermProvisioningWrite)(r.handleToggleProvisioningRule))
	apiMux.HandleFunc("POST /provisioning/reorder", auth.RequirePermission(models.PermProvisioningWrite)(r.handleReorderProvisioningRules))
	apiMux.HandleFunc("GET /provisioning/templates", auth.RequirePermission(models.PermProvisioningRead)(r.handleListProvisioningTemplates))
	apiMux.HandleFunc("POST /provisioning/templates", auth.RequirePermission(models.PermProvisioningWrite)(r.handleCreateProvisioningTemplate))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleUpdateProvisioningTemplate))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleDeleteProvisioningTemplate))
	apiMux.HandleFunc("GET /provisioning/templates/{id}/image", auth.RequirePermission(models.PermProvisioningRead)(r.handleGetProvisioningTemplateImage))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/image", auth.RequirePermission(models.PermProvisioningWrite)(r.handleUploadProvisioningTemplateImage))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/image", auth.RequirePermission(models.PermProvisioningWrite)(r.handleDeleteProvisioningTemplateImage))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}/features", auth.RequirePermission(models.PermProvisioningWrite)(r.handleSaveTemplateFeatures))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/features/import", auth.RequirePermission(models.PermProvisioningWrite)(r.handleImportTemplateFeature))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/features/{featureID}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleDeleteTemplateFeature))
	apiMux.HandleFunc("POST /device/{serial}/features/{featureID}/controls/{key}", auth.RequirePermission(models.PermDevicesWrite)(r.handleSetFeatureControl))
	apiMux.HandleFunc("POST /device/{serial}/features/{featureID}/objects/{key}", auth.RequirePermission(models.PermDevicesWrite)(r.handleAddFeatureObject))
	apiMux.HandleFunc("POST /device/{serial}/features/{featureID}/objects/{key}/instances/{instance}/parameters", auth.RequirePermission(models.PermDevicesWrite)(r.handleSetFeatureObjectParameter))
	apiMux.HandleFunc("DELETE /device/{serial}/features/{featureID}/objects/{key}/instances/{instance}", auth.RequirePermission(models.PermDevicesWrite)(r.handleDeleteFeatureObject))
	apiMux.HandleFunc("GET /provisioning/templates/{id}/interface-metrics", auth.RequirePermission(models.PermProvisioningRead)(r.handleListInterfaceMetrics))
	apiMux.HandleFunc("POST /provisioning/templates/{id}/interface-metrics", auth.RequirePermission(models.PermProvisioningWrite)(r.handleSaveInterfaceMetric))
	apiMux.HandleFunc("PUT /provisioning/templates/{id}/interface-metrics/{metricID}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleSaveInterfaceMetric))
	apiMux.HandleFunc("DELETE /provisioning/templates/{id}/interface-metrics/{metricID}", auth.RequirePermission(models.PermProvisioningWrite)(r.handleDeleteInterfaceMetric))
	apiMux.HandleFunc("GET /device/{serial}/interface-metrics", auth.RequirePermission(models.PermMetricsRead)(r.handleGetDeviceInterfaceMetric))
	apiMux.HandleFunc("GET /device/{serial}/interface-metric-definitions", auth.RequirePermission(models.PermMetricsRead)(r.handleListDeviceInterfaceMetricDefinitions))

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
	mux.Handle("/", auth.AuthMiddleware(r.userRepo, r.roleRepo, auditMiddleware(r.auditRepo, apiMux)))

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

func (r *Router) handleListDevices(w http.ResponseWriter, req *http.Request) {
	limit := 50
	offset := 0

	if l := req.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	if o := req.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	devices, total, err := r.deviceRepo.List(req.Context(), limit, offset)
	if err != nil {
		log.Printf("Error listing devices: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list devices")
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"devices": devices,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}

func (r *Router) handleListWANInterfaces(w http.ResponseWriter, req *http.Request) {
	interfaces, err := r.deviceRepo.ListWANInterfaces(req.Context())
	if err != nil {
		log.Printf("Error listing WAN interfaces: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list WAN interfaces")
		return
	}

	respondJSON(w, http.StatusOK, interfaces)
}

func (r *Router) handleListTasks(w http.ResponseWriter, req *http.Request) {
	tasks, err := r.taskRepo.ListWithDevices(req.Context())
	if err != nil {
		log.Printf("Error listing tasks: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list tasks")
		return
	}

	respondJSON(w, http.StatusOK, tasks)
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

func (r *Router) handleDeviceAnalytics(w http.ResponseWriter, req *http.Request) {
	devices, totalDevices, err := r.deviceRepo.ListForAnalytics(req.Context(), 10000)
	if err != nil {
		log.Printf("Error getting devices for analytics: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to get analytics")
		return
	}

	// Aggregate data
	rxPowerRanges := map[string]int{
		"Sangat Bagus (-15 to -23)": 0,
		"Normal (-23 to -25)":       0,
		"Buruk (-25 to -29)":        0,
		"Kritis (< -29)":            0,
		"N/A":                       0,
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
		"< 1 jam":   0,
		"1-24 jam":  0,
		"1-7 hari":  0,
		"1-30 hari": 0,
		"> 1 bulan": 0,
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
		totalStations := 0

		for _, p := range device.Parameters {
			// RX Power - ambil nilai pertama yang valid
			if deviceRxPower == -999 && (strings.Contains(p.Name, "RXPower") || strings.Contains(p.Name, "RxPower")) {
				if val, err := strconv.ParseFloat(p.Value, 64); err == nil {
					if val > 0 && val < 10000 {
						val = 10 * math.Log10(val/10000)
					} else if val > 100 {
						val = val / 100
					}
					deviceRxPower = val
				}
			}

			// Temperature - ambil nilai pertama yang valid
			if deviceTemp == -999 && (strings.Contains(p.Name, "Temperature") || strings.Contains(p.Name, "Temp")) {
				if val, err := strconv.ParseFloat(p.Value, 64); err == nil {
					if val > 1000 {
						val = val / 256
					} else if val > 100 {
						val = val / 10
					}
					deviceTemp = val
				}
			}

			// Uptime - prioritaskan DeviceInfo.UpTime
			if deviceUptime == -1 && (strings.HasSuffix(p.Name, "DeviceInfo.UpTime") || strings.HasSuffix(p.Name, "UpTime")) {
				if val, err := strconv.ParseFloat(p.Value, 64); err == nil {
					deviceUptime = val
				}
			}

			// Access Type - ambil pertama yang valid
			if deviceAccessType == "" && (strings.Contains(p.Name, "PONMode") || strings.Contains(p.Name, "AccessType")) {
				valUpper := strings.ToUpper(p.Value)
				if strings.Contains(valUpper, "EPON") {
					deviceAccessType = "EPON"
				} else if strings.Contains(valUpper, "GPON") {
					deviceAccessType = "GPON"
				} else if strings.Contains(valUpper, "ETH") {
					deviceAccessType = "Ethernet"
				} else if p.Value != "" {
					deviceAccessType = "Other"
				}
			}

			// WiFi Stations - sum semua
			if strings.Contains(p.Name, "TotalAssociations") || strings.Contains(p.Name, "AssociatedDeviceNumberOfEntries") {
				if val, err := strconv.Atoi(p.Value); err == nil {
					totalStations += val
				}
			}
		}

		// Count RX Power
		if deviceRxPower != -999 {
			if deviceRxPower >= -23 && deviceRxPower <= -15 {
				rxPowerRanges["Sangat Bagus (-15 to -23)"]++
			} else if deviceRxPower >= -25 && deviceRxPower < -23 {
				rxPowerRanges["Normal (-23 to -25)"]++
			} else if deviceRxPower >= -29 && deviceRxPower < -25 {
				rxPowerRanges["Buruk (-25 to -29)"]++
			} else if deviceRxPower < -29 {
				rxPowerRanges["Kritis (< -29)"]++
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
				uptimeRanges["< 1 jam"]++
			} else if hours < 24 {
				uptimeRanges["1-24 jam"]++
			} else if hours < 168 {
				uptimeRanges["1-7 hari"]++
			} else if hours < 720 {
				uptimeRanges["1-30 hari"]++
			} else {
				uptimeRanges["> 1 bulan"]++
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
	key := "reauth:" + clientIP(req)
	if !r.loginLimiter.Allow(key) {
		w.Header().Set("Retry-After", "900")
		respondError(w, http.StatusTooManyRequests, "Too many reauthentication attempts; try again later")
		return false
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body.CurrentPassword == "" {
		respondError(w, http.StatusBadRequest, "Current password is required")
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
	if user == nil || !auth.CheckPassword(body.CurrentPassword, user.PasswordHash) {
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

	result := make(map[string]string)
	for _, s := range settings {
		if isSecretSetting(s.Key) && s.Value != "" {
			result[s.Key] = "••••••••"
		} else {
			result[s.Key] = s.Value
		}
	}

	respondJSON(w, http.StatusOK, result)
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
		if err != nil || parsed < 5 || parsed > 100 {
			respondError(w, http.StatusBadRequest, "default_page_size must be an integer between 5 and 100")
			return
		}
	}
	if value, ok := settings["chart_show_points"]; ok && value != "true" && value != "false" {
		respondError(w, http.StatusBadRequest, "chart_show_points must be true or false")
		return
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
	limit := 50
	offset := 0
	var resolved *bool

	if l := req.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if o := req.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	if rs := req.URL.Query().Get("resolved"); rs != "" {
		val := rs == "true"
		resolved = &val
	}

	faults, total, err := r.faultRepo.List(req.Context(), limit, offset, resolved)
	if err != nil {
		log.Printf("Error listing faults: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to list faults")
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"faults": faults,
		"total":  total,
		"limit":  limit,
		"offset": offset,
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

	token, err := auth.GenerateToken(user)
	if err != nil {
		log.Printf("Error generating token: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to generate token")
		return
	}

	if err := r.userRepo.UpdateLastLogin(req.Context(), user.ID); err != nil {
		log.Printf("Failed to record last login for user %d: %v", user.ID, err)
	}
	r.loginLimiter.Reset(ip)
	r.recordLoginAudit(req, user.Username, http.StatusOK)

	var perms []string
	if user.RoleID != nil {
		perms, _ = r.roleRepo.GetPermissions(req.Context(), *user.RoleID)
	}

	respondJSON(w, http.StatusOK, models.LoginResponse{
		Token:       token,
		User:        user,
		Permissions: perms,
	})
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

	if body.Role != models.RoleFull && body.Role != models.RoleRead {
		body.Role = models.RoleRead
	}

	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to hash password")
		return
	}

	user := &models.User{
		Username:     body.Username,
		PasswordHash: hash,
		Role:         body.Role,
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
	if body.Role != "" {
		if body.Role != models.RoleFull && body.Role != models.RoleRead {
			respondError(w, http.StatusBadRequest, "Invalid role")
			return
		}
		if user.Role == models.RoleFull && body.Role != models.RoleFull {
			fullAdmins, countErr := r.userRepo.CountByRole(req.Context(), models.RoleFull)
			if countErr != nil || fullAdmins <= 1 {
				respondError(w, http.StatusBadRequest, "Cannot remove the last full-access administrator")
				return
			}
		}
		user.Role = body.Role
	}

	if err := r.userRepo.UpdateAccount(req.Context(), id, user.Username, user.Role, passwordHash); err != nil {
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

	respondJSON(w, http.StatusOK, user)
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
	if err := validateProvisioningRule(body.ParameterName, body.ParameterValue, body.ParameterType, body.AddObjectPath, body.Phase, body.Tags, body.Description); err != nil {
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
	if err := validateProvisioningRule(body.ParameterName, body.ParameterValue, body.ParameterType, body.AddObjectPath, body.Phase, body.Tags, body.Description); err != nil {
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

	template := &models.ProvisioningTemplate{
		Name:         strings.TrimSpace(body.Name),
		Manufacturer: strings.ToLower(strings.TrimSpace(body.Manufacturer)),
		ProductClass: strings.ToLower(strings.TrimSpace(body.ProductClass)),
		Description:  strings.TrimSpace(body.Description),
		Variables:    body.Variables,
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

	template := &models.ProvisioningTemplate{
		ID:           id,
		Name:         strings.TrimSpace(body.Name),
		Manufacturer: strings.ToLower(strings.TrimSpace(body.Manufacturer)),
		ProductClass: strings.ToLower(strings.TrimSpace(body.ProductClass)),
		Description:  strings.TrimSpace(body.Description),
		Variables:    body.Variables,
	}
	if err := validateProvisioningVariables(template.Variables); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.provisioningRepo.UpdateTemplate(req.Context(), template); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to update template")
		return
	}
	updated, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load updated template")
		return
	}
	r.templateImageURL(updated)
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

func validateProvisioningVariables(variables []models.ProvisioningVariable) error {
	if len(variables) > 100 {
		return errors.New("a template can define at most 100 variables")
	}
	namePattern := regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	allowedSources := map[string]bool{"": true, "literal": true, "serial_number": true, "manufacturer": true, "product_class": true, "oui": true, "parameter": true}
	allowedFunctions := map[string]bool{"trim": true, "upper": true, "lower": true, "prefix": true, "suffix": true, "slice": true, "replace": true, "regex_replace": true, "pad_start": true, "pad_end": true, "default": true, "random_string": true, "sha256": true, "base64_encode": true, "base64_decode": true, "hex_encode": true, "hex_decode": true}
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
		}
	}
	return nil
}
