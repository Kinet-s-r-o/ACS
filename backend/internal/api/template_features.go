package api

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/skydashnet/skyacs/internal/auth"
	"github.com/skydashnet/skyacs/internal/models"
)

var featureKeyPattern = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)
var featureIDPattern = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)

func (r *Router) handleSaveTemplateFeatures(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	templateID, err := parsePositivePathID(req, "id")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var body struct {
		Features []models.ProvisioningFeature `json:"features"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body.Features == nil || len(body.Features) > 50 {
		respondError(w, http.StatusBadRequest, "Invalid feature definitions")
		return
	}
	if err := validateProvisioningFeatures(body.Features); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := r.provisioningRepo.GetTemplate(req.Context(), templateID); err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	if err := r.provisioningRepo.UpdateTemplateFeatures(req.Context(), templateID, body.Features); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save feature definitions")
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{"features": body.Features})
}

func validateProvisioningFeatures(features []models.ProvisioningFeature) error {
	featureIDs := make(map[string]bool, len(features))
	for featureIndex := range features {
		feature := &features[featureIndex]
		feature.ID = strings.TrimSpace(feature.ID)
		feature.Name = strings.TrimSpace(feature.Name)
		feature.Description = strings.TrimSpace(feature.Description)
		if !featureIDPattern.MatchString(feature.ID) || feature.Name == "" || len(feature.Name) > 128 || len(feature.Description) > 512 {
			return fmt.Errorf("section %d has an invalid ID, name, or description", featureIndex+1)
		}
		if featureIDs[feature.ID] {
			return fmt.Errorf("section IDs must be unique")
		}
		featureIDs[feature.ID] = true
		if len(feature.Controls) > 100 {
			return fmt.Errorf("section %q may contain at most 100 fields", feature.Name)
		}
		keys, parameters := make(map[string]bool, len(feature.Controls)), make(map[string]bool, len(feature.Controls))
		for controlIndex := range feature.Controls {
			control := &feature.Controls[controlIndex]
			control.Key = strings.ToLower(strings.TrimSpace(control.Key))
			control.Label = strings.TrimSpace(control.Label)
			control.Type = strings.TrimSpace(control.Type)
			control.Parameter = strings.TrimSpace(control.Parameter)
			control.Description = strings.TrimSpace(control.Description)
			control.Group = strings.TrimSpace(control.Group)
			if control.Type == "unsignedint" {
				control.Type = "unsignedInt"
			}
			if !featureKeyPattern.MatchString(control.Key) || control.Label == "" || len(control.Label) > 128 {
				return fmt.Errorf("field %d in %q has an invalid key or label", controlIndex+1, feature.Name)
			}
			if keys[control.Key] || parameters[control.Parameter] {
				return fmt.Errorf("field keys and CWMP paths must be unique in %q", feature.Name)
			}
			if err := validateParameterNames([]string{control.Parameter}); err != nil {
				return fmt.Errorf("field %q: %w", control.Label, err)
			}
			if control.Type != "boolean" && control.Type != "object" && control.Type != "string" && control.Type != "int" && control.Type != "unsignedInt" {
				return fmt.Errorf("field %q has an unsupported type", control.Label)
			}
			if len(control.Description) > 512 || len(control.Group) > 128 || len(control.Options) > 100 {
				return fmt.Errorf("field %q has a value that is too long", control.Label)
			}
			if control.Type == "object" {
				if !strings.HasSuffix(control.Parameter, ".") {
					return fmt.Errorf("object field %q must use an object path ending in a dot", control.Label)
				}
				control.Options = nil
				control.EnabledValue, control.DisabledValue = "", ""
			} else {
				if strings.HasSuffix(control.Parameter, ".") {
					return fmt.Errorf("scalar field %q cannot use an object path", control.Label)
				}
				if control.Type == "boolean" {
					if len(control.Options) > 0 {
						return fmt.Errorf("boolean field %q cannot use select options", control.Label)
					}
					if control.EnabledValue == "" {
						control.EnabledValue = "1"
					}
					if control.DisabledValue == "" {
						control.DisabledValue = "0"
					}
					if control.EnabledValue == control.DisabledValue || len(control.EnabledValue) > 64 || len(control.DisabledValue) > 64 {
						return fmt.Errorf("boolean field %q needs distinct enabled and disabled values", control.Label)
					}
				} else {
					control.EnabledValue, control.DisabledValue = "", ""
				}
			}
			optionValues := make(map[string]bool, len(control.Options))
			for optionIndex, option := range control.Options {
				option = strings.TrimSpace(option)
				control.Options[optionIndex] = option
				if option == "" || len(option) > 256 || optionValues[option] {
					return fmt.Errorf("field %q has an empty, duplicate, or oversized option", control.Label)
				}
				if control.Type == "int" {
					if _, err := strconv.ParseInt(option, 10, 32); err != nil {
						return fmt.Errorf("options for %q must be signed 32-bit integers", control.Label)
					}
				} else if control.Type == "unsignedInt" {
					if _, err := strconv.ParseUint(option, 10, 32); err != nil {
						return fmt.Errorf("options for %q must be unsigned 32-bit integers", control.Label)
					}
				}
				optionValues[option] = true
			}
			keys[control.Key], parameters[control.Parameter] = true, true
		}
	}
	return nil
}

func (r *Router) handleImportTemplateFeature(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	templateID, err := parsePositivePathID(req, "id")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var body struct {
		Name string `json:"name"`
		CSV  string `json:"csv"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid feature import")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len(name) > 128 {
		respondError(w, http.StatusBadRequest, "Feature name must contain 1–128 characters")
		return
	}
	featureID := featureSlug(name)
	if !featureIDPattern.MatchString(featureID) {
		respondError(w, http.StatusBadRequest, "Feature name must include at least one English letter or number")
		return
	}
	controls, err := parseFeatureCSV(body.CSV)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), templateID)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	for _, feature := range template.Features {
		if feature.ID == featureID {
			respondError(w, http.StatusConflict, "A feature with this name already exists in the template")
			return
		}
	}
	template.Features = append(template.Features, models.ProvisioningFeature{ID: featureID, Name: name, Controls: controls})
	if err := r.provisioningRepo.UpdateTemplateFeatures(req.Context(), templateID, template.Features); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save feature")
		return
	}
	respondJSON(w, http.StatusCreated, template.Features[len(template.Features)-1])
}

func (r *Router) handleDeleteTemplateFeature(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	if claims == nil || claims.Role != models.RoleFull {
		respondError(w, http.StatusForbidden, "Full access required")
		return
	}
	templateID, err := parsePositivePathID(req, "id")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	featureID := req.PathValue("featureID")
	if !featureIDPattern.MatchString(featureID) {
		respondError(w, http.StatusBadRequest, "Invalid feature ID")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), templateID)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	features := make([]models.ProvisioningFeature, 0, len(template.Features))
	found := false
	for _, feature := range template.Features {
		if feature.ID == featureID {
			found = true
			continue
		}
		features = append(features, feature)
	}
	if !found {
		respondError(w, http.StatusNotFound, "Feature not found")
		return
	}
	if err := r.provisioningRepo.UpdateTemplateFeatures(req.Context(), templateID, features); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete feature")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func parseFeatureCSV(content string) ([]models.ProvisioningFeatureControl, error) {
	if strings.TrimSpace(content) == "" || len(content) > 1<<20 {
		return nil, fmt.Errorf("CSV must contain data and be smaller than 1 MB")
	}
	reader := csv.NewReader(strings.NewReader(content))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("could not read CSV header")
	}
	columns := make(map[string]int, len(header))
	for i, item := range header {
		columns[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(item, "\ufeff")))] = i
	}
	featureFormat := true
	for _, required := range []string{"key", "label", "type", "parameter"} {
		if _, ok := columns[required]; !ok {
			featureFormat = false
		}
	}
	if !featureFormat {
		for _, required := range []string{"name", "writable", "value type"} {
			if _, ok := columns[required]; !ok {
				return nil, fmt.Errorf("CSV must contain either key/label/type/parameter columns or Name/Writable/Value type columns")
			}
		}
	}
	get := func(row []string, key string) string {
		index, ok := columns[key]
		if !ok || index >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[index])
	}
	controls := make([]models.ProvisioningFeatureControl, 0)
	keys, parameters := make(map[string]bool), make(map[string]bool)
	line := 1
	for {
		row, readErr := reader.Read()
		if readErr == io.EOF {
			break
		}
		line++
		if readErr != nil {
			return nil, fmt.Errorf("CSV line %d: invalid row", line)
		}
		if len(row) == 1 && strings.TrimSpace(row[0]) == "" {
			continue
		}
		control := models.ProvisioningFeatureControl{}
		if featureFormat {
			control = models.ProvisioningFeatureControl{
				Key: strings.ToLower(get(row, "key")), Label: get(row, "label"), Type: strings.ToLower(get(row, "type")),
				Parameter: get(row, "parameter"), Options: parseFeatureOptions(get(row, "options")), EnabledValue: get(row, "enabled_value"), DisabledValue: get(row, "disabled_value"),
				Group: get(row, "group"), Description: get(row, "description"),
			}
			if control.Type == "unsignedint" {
				control.Type = "unsignedInt"
			}
		} else {
			parameter := get(row, "name")
			writable := strings.ToLower(get(row, "writable"))
			valueType := strings.ToLower(get(row, "value type"))
			if writable != "yes" && writable != "true" && writable != "1" {
				continue
			}
			switch {
			case (valueType == "boolean" || valueType == "int" || valueType == "unsignedint") && !strings.HasSuffix(parameter, "."):
				control.Type = valueType
				if control.Type == "unsignedint" {
					control.Type = "unsignedInt"
				}
			case valueType == "string" && !strings.HasSuffix(parameter, "."):
				control.Type = "string"
			case valueType == "" && strings.HasSuffix(parameter, "."):
				control.Type = "object"
			default:
				continue
			}
			label := strings.TrimSuffix(parameter, ".")
			if dot := strings.LastIndex(label, "."); dot >= 0 {
				label = label[dot+1:]
			}
			control.Key = featureSlug(label)
			if control.Key == "" {
				continue
			}
			baseKey := control.Key
			for suffix := 2; keys[control.Key]; suffix++ {
				control.Key = fmt.Sprintf("%.59s-%d", baseKey, suffix)
			}
			control.Label = label
			control.Parameter = parameter
			control.Options = parseFeatureOptions(get(row, "options"))
		}
		if !featureKeyPattern.MatchString(control.Key) || control.Label == "" || len(control.Label) > 128 {
			return nil, fmt.Errorf("CSV line %d: key or label is invalid", line)
		}
		if keys[control.Key] || parameters[control.Parameter] {
			return nil, fmt.Errorf("CSV line %d: duplicate key or parameter", line)
		}
		if control.Type != "boolean" && control.Type != "object" && control.Type != "string" && control.Type != "int" && control.Type != "unsignedInt" {
			return nil, fmt.Errorf("CSV line %d: type must be boolean, string, int, unsignedInt, or object", line)
		}
		if err := validateParameterNames([]string{control.Parameter}); err != nil {
			return nil, fmt.Errorf("CSV line %d: %w", line, err)
		}
		if control.Type == "boolean" {
			if strings.HasSuffix(control.Parameter, ".") {
				return nil, fmt.Errorf("CSV line %d: boolean parameter cannot end in a dot", line)
			}
			if control.EnabledValue == "" {
				control.EnabledValue = "1"
			}
			if control.DisabledValue == "" {
				control.DisabledValue = "0"
			}
			if control.EnabledValue == control.DisabledValue {
				return nil, fmt.Errorf("CSV line %d: enabled_value and disabled_value must differ", line)
			}
			if len(control.EnabledValue) > 64 || len(control.DisabledValue) > 64 {
				return nil, fmt.Errorf("CSV line %d: enabled/disabled values exceed 64 characters", line)
			}
		} else if control.Type == "object" {
			if !strings.HasSuffix(control.Parameter, ".") {
				return nil, fmt.Errorf("CSV line %d: object parameter must end with a dot", line)
			}
			control.EnabledValue, control.DisabledValue = "", ""
		} else {
			if strings.HasSuffix(control.Parameter, ".") {
				return nil, fmt.Errorf("CSV line %d: scalar controls cannot use an object parameter", line)
			}
			if len(control.EnabledValue) > 0 || len(control.DisabledValue) > 0 {
				return nil, fmt.Errorf("CSV line %d: scalar controls use the options column, not enabled_value/disabled_value", line)
			}
		}
		if len(control.Group) > 128 || len(control.Description) > 512 {
			return nil, fmt.Errorf("CSV line %d: group or description is too long", line)
		}
		keys[control.Key], parameters[control.Parameter] = true, true
		controls = append(controls, control)
		if len(controls) > 100 {
			return nil, fmt.Errorf("CSV may define at most 100 controls")
		}
	}
	if len(controls) == 0 {
		return nil, fmt.Errorf("CSV contains no controls")
	}
	return controls, nil
}

func parseFeatureOptions(raw string) []string {
	parts := strings.Split(raw, "|")
	options := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		option := strings.TrimSpace(part)
		if option == "" || seen[option] {
			continue
		}
		seen[option] = true
		options = append(options, option)
	}
	return options
}

func featureSlug(name string) string {
	name = strings.ToLower(name)
	var b strings.Builder
	separator := false
	for _, char := range name {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			b.WriteRune(char)
			separator = false
		} else if !separator && b.Len() > 0 {
			b.WriteByte('-')
			separator = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func parsePositivePathID(req *http.Request, key string) (int64, error) {
	id, err := strconv.ParseInt(req.PathValue(key), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid ID")
	}
	return id, nil
}

func (r *Router) featureControlForDevice(req *http.Request, device *models.Device) (*models.ProvisioningFeatureControl, error) {
	manufacturer, productClass := "", ""
	if device.Manufacturer != nil {
		manufacturer = *device.Manufacturer
	}
	if device.ProductClass != nil {
		productClass = *device.ProductClass
	}
	template, err := r.provisioningRepo.ResolveTemplateForDevice(req.Context(), manufacturer, productClass)
	if err != nil {
		return nil, fmt.Errorf("no matching template")
	}
	featureID, key := req.PathValue("featureID"), req.PathValue("key")
	for _, feature := range template.Features {
		if feature.ID != featureID {
			continue
		}
		for i := range feature.Controls {
			if feature.Controls[i].Key == key {
				return &feature.Controls[i], nil
			}
		}
	}
	return nil, fmt.Errorf("feature control not found")
}

func (r *Router) handleSetFeatureControl(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	control, err := r.featureControlForDevice(req, device)
	if err != nil || (control.Type != "boolean" && control.Type != "string" && control.Type != "int" && control.Type != "unsignedInt") {
		respondError(w, http.StatusNotFound, "Feature control not found")
		return
	}
	var body struct {
		Enabled *bool   `json:"enabled"`
		Value   *string `json:"value"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || (control.Type == "boolean" && body.Enabled == nil) || (control.Type != "boolean" && body.Value == nil) {
		respondError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	params, err := r.parameterRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load device parameters")
		return
	}
	writable := false
	for _, parameter := range params {
		if parameter.Name == control.Parameter && parameter.Writable != nil && *parameter.Writable {
			writable = true
			break
		}
	}
	if !writable {
		respondError(w, http.StatusConflict, "Device does not report this parameter as writable")
		return
	}
	value := ""
	if control.Type == "boolean" {
		value = control.DisabledValue
		if *body.Enabled {
			value = control.EnabledValue
		}
	} else {
		value = *body.Value
		if len(control.Options) > 0 {
			allowed := false
			for _, option := range control.Options {
				if value == option {
					allowed = true
					break
				}
			}
			if !allowed {
				respondError(w, http.StatusBadRequest, "Value is not an allowed option")
				return
			}
		}
		if control.Type == "int" {
			if _, err := strconv.ParseInt(value, 10, 32); err != nil {
				respondError(w, http.StatusBadRequest, "Value must be a signed 32-bit integer")
				return
			}
		}
		if control.Type == "unsignedInt" {
			if _, err := strconv.ParseUint(value, 10, 32); err != nil {
				respondError(w, http.StatusBadRequest, "Value must be an unsigned 32-bit integer")
				return
			}
		}
	}
	setTask, err := models.NewTaskWithPayload(device.ID, models.TaskTypeSetParameterValues, map[string]string{control.Parameter: value})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		setTask.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), setTask); err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create task")
		return
	}
	refreshTask, err := models.NewTaskWithPayload(device.ID, models.TaskTypeGetParameterValues, []string{control.Parameter})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create verification task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		refreshTask.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), refreshTask); err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create verification task")
		return
	}
	respondJSON(w, http.StatusCreated, map[string]interface{}{"task": setTask, "refresh_task": refreshTask})
}

func (r *Router) handleAddFeatureObject(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	control, err := r.featureControlForDevice(req, device)
	if err != nil || control.Type != "object" {
		respondError(w, http.StatusNotFound, "Feature object not found")
		return
	}
	params, err := r.parameterRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load device parameters")
		return
	}
	writable := false
	for _, parameter := range params {
		if parameter.Name == control.Parameter && parameter.Writable != nil && *parameter.Writable {
			writable = true
			break
		}
	}
	if !writable {
		respondError(w, http.StatusConflict, "Device does not report this object as writable")
		return
	}
	task, err := models.NewTaskWithPayload(device.ID, models.TaskTypeAddObject, map[string]string{"object_name": control.Parameter})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		task.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), task); err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create task")
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

func (r *Router) handleSetFeatureObjectParameter(w http.ResponseWriter, req *http.Request) {
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	control, err := r.featureControlForDevice(req, device)
	if err != nil || control.Type != "object" {
		respondError(w, http.StatusNotFound, "Feature object not found")
		return
	}
	instance := req.PathValue("instance")
	if number, err := strconv.ParseUint(instance, 10, 32); err != nil || number == 0 {
		respondError(w, http.StatusBadRequest, "Invalid object instance")
		return
	}
	var body struct {
		Parameter string `json:"parameter"`
		Value     string `json:"value"`
	}
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || strings.TrimSpace(body.Parameter) == "" || len(body.Parameter) > 512 || len(body.Value) > 4096 {
		respondError(w, http.StatusBadRequest, "Invalid parameter value")
		return
	}
	parameterName := control.Parameter + instance + "." + body.Parameter
	if !strings.HasPrefix(parameterName, control.Parameter+instance+".") || strings.HasSuffix(body.Parameter, ".") || strings.Contains(body.Parameter, "..") {
		respondError(w, http.StatusBadRequest, "Invalid object parameter path")
		return
	}
	params, err := r.parameterRepo.GetByDeviceID(req.Context(), device.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load device parameters")
		return
	}
	writable := false
	for _, parameter := range params {
		if parameter.Name == parameterName && parameter.Writable != nil && *parameter.Writable {
			writable = true
			break
		}
	}
	if !writable {
		respondError(w, http.StatusConflict, "Device does not report this parameter as writable")
		return
	}
	setTask, err := models.NewTaskWithPayload(device.ID, models.TaskTypeSetParameterValues, map[string]string{parameterName: body.Value})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		setTask.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), setTask); err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create task")
		return
	}
	refreshTask, err := models.NewTaskWithPayload(device.ID, models.TaskTypeGetParameterValues, []string{parameterName})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create verification task")
		return
	}
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		refreshTask.CreatedBy = claims.Username
	}
	if err := r.taskRepo.Create(req.Context(), refreshTask); err != nil {
		respondError(w, http.StatusInternalServerError, "Could not create verification task")
		return
	}
	respondJSON(w, http.StatusCreated, map[string]interface{}{"task": setTask, "refresh_task": refreshTask})
}
