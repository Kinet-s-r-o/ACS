package api

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/auth"
	"github.com/skydashnet/skyacs/internal/database"
	"github.com/skydashnet/skyacs/internal/models"
	"gorm.io/gorm"
)

//go:embed openapi.json
var integrationOpenAPI []byte

func (r *Router) integrationHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/me", func(w http.ResponseWriter, req *http.Request) {
		user := auth.GetUserFromContext(req.Context())
		token := auth.GetAPITokenFromContext(req.Context())
		respondJSON(w, http.StatusOK, map[string]any{"user_id": user.UserID, "username": user.Username, "token_id": token.ID, "system": token.Name, "permissions": auth.GetPermissionsFromContext(req.Context())})
	})
	mux.HandleFunc("GET /v1/devices", auth.RequirePermission(models.PermDevicesRead)(r.integrationDevices))
	mux.HandleFunc("GET /v1/devices/{serial}", auth.RequirePermission(models.PermDevicesRead)(r.integrationDevice))
	mux.HandleFunc("GET /v1/devices/{serial}/parameters", auth.RequirePermission(models.PermDevicesRead)(r.integrationParameters))
	mux.HandleFunc("POST /v1/devices/{serial}/read", auth.RequirePermission(models.PermDevicesWrite)(r.integrationRead))
	mux.HandleFunc("POST /v1/devices/{serial}/write", auth.RequirePermission(models.PermDevicesWrite)(r.integrationWrite))
	mux.HandleFunc("GET /v1/devices/{serial}/tasks", auth.RequirePermission(models.PermDevicesRead)(r.integrationTasks))
	mux.HandleFunc("GET /v1/devices/{serial}/tasks/{taskID}", auth.RequirePermission(models.PermDevicesRead)(r.integrationTask))
	limited := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		token := auth.GetAPITokenFromContext(req.Context())
		if !r.apiTokenLimiter.Allow(strconv.FormatInt(token.ID, 10)) {
			w.Header().Set("Retry-After", "60")
			respondError(w, http.StatusTooManyRequests, "API token rate limit exceeded (120 requests/minute)")
			return
		}
		auditMiddleware(r.auditRepo, mux).ServeHTTP(w, req)
	})
	authenticated := auth.APITokenMiddleware(r.apiTokenRepo, r.userRepo, r.roleRepo, limited)
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !r.apiIPLimiter.Allow(clientIP(req)) {
			w.Header().Set("Retry-After", "60")
			respondError(w, http.StatusTooManyRequests, "API source rate limit exceeded (600 requests/minute)")
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), 15*time.Second)
		defer cancel()
		authenticated.ServeHTTP(w, req.WithContext(ctx))
	})
}

func decodeIntegrationBody(req *http.Request, target any) error {
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		if err != nil {
			return err
		}
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func respondIntegrationBodyError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		respondError(w, http.StatusRequestEntityTooLarge, "JSON body exceeds 2 MiB")
		return
	}
	respondError(w, http.StatusBadRequest, "Invalid JSON request body (one object, known fields only)")
}

func integrationPage(req *http.Request, numeric bool) (int, string, error) {
	limit := 100
	var err error
	if value := req.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
	}
	if err != nil || limit < 1 || limit > 500 {
		return 0, "", errors.New("limit must be between 1 and 500")
	}
	cursor := req.URL.Query().Get("cursor")
	if len(cursor) > 512 {
		return 0, "", errors.New("invalid cursor")
	}
	if numeric && cursor != "" {
		id, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || id < 1 {
			return 0, "", errors.New("cursor must be a positive integer")
		}
	}
	return limit, cursor, nil
}

func (r *Router) integrationDeviceLookup(w http.ResponseWriter, req *http.Request) *models.Device {
	device, err := r.parseDeviceBySerial(req)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get device")
		return nil
	}
	if device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
	}
	return device
}

func (r *Router) integrationDevice(w http.ResponseWriter, req *http.Request) {
	device := r.integrationDeviceLookup(w, req)
	if device == nil {
		return
	}
	respondJSON(w, http.StatusOK, database.IntegrationDevice{ID: device.ID, SerialNumber: device.SerialNumber, Manufacturer: device.Manufacturer, ProductClass: device.ProductClass, ModelName: device.ModelName, SoftwareVersion: device.SoftwareVersion, Online: device.Online, LastInform: device.LastInform})
}

func (r *Router) integrationDevices(w http.ResponseWriter, req *http.Request) {
	limit, cursor, err := integrationPage(req, true)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	after, _ := strconv.ParseInt(cursor, 10, 64)
	items, err := r.deviceRepo.IntegrationList(req.Context(), after, limit+1)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list devices")
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = strconv.FormatInt(items[limit-1].ID, 10)
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}

func (r *Router) integrationParameters(w http.ResponseWriter, req *http.Request) {
	limit, cursor, err := integrationPage(req, false)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	names := req.URL.Query()["name"]
	prefix := req.URL.Query().Get("prefix")
	if len(prefix) > 512 || validateParameterNames(names) != nil {
		respondError(w, http.StatusBadRequest, "Invalid parameter filter")
		return
	}
	device := r.integrationDeviceLookup(w, req)
	if device == nil {
		return
	}
	items, err := r.parameterRepo.IntegrationList(req.Context(), device.ID, cursor, prefix, names, limit+1, auth.GetUserFromContext(req.Context()).Role == models.RoleFull)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read parameters")
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = items[limit-1].Name
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}

func (r *Router) integrationRead(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Parameters []string `json:"parameters"`
	}
	if err := decodeIntegrationBody(req, &body); err != nil {
		respondIntegrationBodyError(w, err)
		return
	}
	if len(body.Parameters) == 0 {
		respondError(w, http.StatusBadRequest, "No parameters specified")
		return
	}
	if err := validateParameterNames(body.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, name := range body.Parameters {
		if strings.TrimSpace(name) != name || strings.Contains(name, "*") {
			respondError(w, http.StatusBadRequest, "Use an exact parameter path or an object path ending in a dot, without whitespace or wildcards")
			return
		}
	}
	device := r.integrationDeviceLookup(w, req)
	if device != nil {
		r.integrationQueue(w, req, device.ID, models.TaskTypeGetParameterValues, body.Parameters)
	}
}

func (r *Router) integrationWrite(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Parameters map[string]*string `json:"parameters"`
	}
	if err := decodeIntegrationBody(req, &body); err != nil {
		respondIntegrationBodyError(w, err)
		return
	}
	if len(body.Parameters) == 0 {
		respondError(w, http.StatusBadRequest, "No parameters specified")
		return
	}
	parameters := make(map[string]string, len(body.Parameters))
	for name, value := range body.Parameters {
		if value == nil {
			respondError(w, http.StatusBadRequest, "Parameter values must be strings, not null")
			return
		}
		parameters[name] = *value
	}
	if err := validateSetParameters(parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	for name := range body.Parameters {
		if strings.TrimSpace(name) != name || strings.HasSuffix(name, ".") || strings.Contains(name, "*") {
			respondError(w, http.StatusBadRequest, "Write requires exact leaf parameter paths without whitespace or wildcards")
			return
		}
	}
	device := r.integrationDeviceLookup(w, req)
	if device == nil {
		return
	}
	names := make([]string, 0, len(body.Parameters))
	for name := range body.Parameters {
		names = append(names, name)
	}
	readOnly, err := r.parameterRepo.KnownReadOnly(req.Context(), device.ID, names)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not verify parameter write access")
		return
	}
	if len(readOnly) > 0 {
		respondError(w, http.StatusBadRequest, "Read-only parameters: "+strings.Join(readOnly, ", "))
		return
	}
	r.integrationQueue(w, req, device.ID, models.TaskTypeSetParameterValues, parameters)
}

func (r *Router) integrationQueue(w http.ResponseWriter, req *http.Request, deviceID int64, kind models.TaskType, payload any) {
	key := req.Header.Get("Idempotency-Key")
	if len(req.Header.Values("Idempotency-Key")) > 1 || len(key) > 128 || strings.IndexFunc(key, func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._:-", c))
	}) >= 0 {
		respondError(w, http.StatusBadRequest, "Invalid Idempotency-Key (max 128 ASCII letters, digits, dot, underscore, colon or hyphen)")
		return
	}
	task, err := models.NewTaskWithPayload(deviceID, kind, payload)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	task.CreatedBy = auth.GetUserFromContext(req.Context()).Username
	token := auth.GetAPITokenFromContext(req.Context())
	task.APITokenID = &token.ID
	if key != "" {
		task.APIRequestKey = &key
	}
	replayed, err := r.taskRepo.CreateIntegration(req.Context(), task)
	if err != nil {
		if errors.Is(err, database.ErrIdempotencyConflict) {
			respondError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, database.ErrInactiveAPIToken) {
			respondError(w, http.StatusUnauthorized, err.Error())
			return
		}
		respondError(w, http.StatusInternalServerError, "Failed to create task")
		return
	}
	// Never echo write payloads, including credentials, in the acknowledgement.
	task.Payload = nil
	w.Header().Set("Location", "tasks/"+strconv.FormatInt(task.ID, 10))
	status := http.StatusAccepted
	if replayed {
		status = http.StatusOK
	}
	respondJSON(w, status, task)
}

func (r *Router) integrationTasks(w http.ResponseWriter, req *http.Request) {
	limit, cursor, err := integrationPage(req, true)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	device := r.integrationDeviceLookup(w, req)
	if device == nil {
		return
	}
	before, _ := strconv.ParseInt(cursor, 10, 64)
	items, err := r.taskRepo.IntegrationList(req.Context(), device.ID, before, limit+1)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to list tasks")
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = strconv.FormatInt(items[limit-1].ID, 10)
	}
	respondJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}

func (r *Router) integrationTask(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("taskID"), 10, 64)
	if err != nil || id < 1 {
		respondError(w, http.StatusBadRequest, "Invalid task ID")
		return
	}
	task, err := r.taskRepo.GetWithDevice(req.Context(), id)
	if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && task.SerialNumber != req.PathValue("serial")) {
		respondError(w, http.StatusNotFound, "Task not found for this device")
		return
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get task")
		return
	}
	respondJSON(w, http.StatusOK, task)
}
