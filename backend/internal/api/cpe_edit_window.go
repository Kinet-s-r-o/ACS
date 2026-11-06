package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

var editBindingPath = regexp.MustCompile(`^(InternetGatewayDevice\.(?:LANDevice\.[0-9]+\.(WLANConfiguration|LANEthernetInterfaceConfig)\.[0-9]+|WANDevice\.[0-9]+\.WANConnectionDevice\.[0-9]+\.(WANIPConnection|WANPPPConnection)\.[0-9]+)|Device\.(WiFi\.SSID|Ethernet\.Interface|IP\.Interface|PPP\.Interface)\.[0-9]+)\.(.+)$`)
var editSuffix = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`)
var editID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func parseEditBinding(path string) (target, pattern, suffix string) {
	m := editBindingPath.FindStringSubmatch(path)
	if m == nil {
		return "", "", ""
	}
	target = "wan_ip"
	switch {
	case m[2] == "WLANConfiguration" || m[4] == "WiFi.SSID":
		target = "wifi"
	case m[2] == "LANEthernetInterfaceConfig" || m[4] == "Ethernet.Interface":
		target = "lan"
	case m[3] == "WANPPPConnection" || m[4] == "PPP.Interface":
		target = "wan_ppp"
	}
	base := m[1] + "."
	// Replace complete numeric segments, including consecutive instance segments.
	parts := strings.Split(base, ".")
	for i, part := range parts {
		if _, err := strconv.ParseUint(part, 10, 32); err == nil {
			parts[i] = "*"
		}
	}
	return target, strings.Join(parts, "."), m[5]
}

func editBaseMatches(window models.CPEEditWindow, prefix string) bool {
	target, pattern, suffix := parseEditBinding(prefix + "ACSBindingProbe")
	return target == window.Target && pattern == window.BasePattern && suffix == "ACSBindingProbe"
}

func normalizeEditType(value string) string { return strings.TrimPrefix(value, "xsd:") }

func validateEditValue(kind, value string) error {
	switch normalizeEditType(kind) {
	case "string":
		return nil
	case "int":
		if _, err := strconv.ParseInt(value, 10, 32); err == nil {
			return nil
		}
	case "unsignedInt":
		if _, err := strconv.ParseUint(value, 10, 32); err == nil {
			return nil
		}
	case "boolean":
		if value == "true" || value == "false" || value == "1" || value == "0" {
			return nil
		}
	}
	return fmt.Errorf("invalid %s value", kind)
}

func validateEditWindows(windows []models.CPEEditWindow) error {
	if len(windows) > 4 {
		return errors.New("at most four edit windows are supported")
	}
	targets := map[string]bool{}
	for _, window := range windows {
		if window.Version != 1 || targets[window.Target] || (window.Target != "wifi" && window.Target != "lan" && window.Target != "wan_ip" && window.Target != "wan_ppp") {
			return errors.New("invalid edit window version or duplicate/unsupported target")
		}
		targets[window.Target] = true
		if len(window.Tabs) > 8 || (window.Enabled && len(window.Tabs) == 0) {
			return errors.New("an enabled edit window needs 1–8 tabs")
		}
		ids, paths := map[string]bool{}, map[string]bool{}
		count := 0
		for _, tab := range window.Tabs {
			if !editID.MatchString(tab.ID) || ids[tab.ID] || strings.TrimSpace(tab.Name) == "" || len(tab.Name) > 80 || strings.IndexFunc(tab.Name, unicode.IsControl) >= 0 || tab.Columns < 1 || tab.Columns > 4 {
				return errors.New("invalid tab ID, name or column count")
			}
			ids[tab.ID] = true
			for _, field := range tab.Fields {
				count++
				if count > 128 || !editID.MatchString(field.ID) || ids[field.ID] || paths[field.Parameter] || strings.TrimSpace(field.Name) == "" || len(field.Name) > 80 || strings.IndexFunc(field.Name, unicode.IsControl) >= 0 || len(field.Help) > 1024 || len(field.Parameter) > 512 || !editSuffix.MatchString(field.Parameter) || field.Span < 1 || field.Span > tab.Columns {
					return errors.New("invalid or duplicate field, parameter or layout")
				}
				ids[field.ID], paths[field.Parameter] = true, true
				switch field.Type {
				case "string", "int", "unsignedInt", "boolean":
				default:
					return errors.New("unsupported field type")
				}
				if field.Input != "auto" && field.Input != "select" {
					return errors.New("choose automatic input or custom select")
				}
				if field.Input == "auto" && len(field.Options) != 0 {
					return errors.New("automatic fields cannot contain select options")
				}
				if field.Input == "select" {
					if len(field.Options) < 1 || len(field.Options) > 64 || database.IsSensitiveParameterName("."+field.Parameter) {
						return errors.New("custom select needs 1–64 options and cannot contain sensitive values")
					}
					values := map[string]bool{}
					for _, option := range field.Options {
						if strings.TrimSpace(option.Label) == "" || len(option.Label) > 128 || strings.IndexFunc(option.Label, unicode.IsControl) >= 0 || len(option.Value) > 1024 || values[option.Value] || validateEditValue(field.Type, option.Value) != nil {
							return errors.New("select options need distinct, correctly typed values and non-empty labels")
						}
						values[option.Value] = true
					}
				}
			}
		}
		if window.Enabled && count == 0 {
			return errors.New("an enabled edit window needs at least one field")
		}
		if count > 0 || window.Enabled {
			probe := strings.ReplaceAll(window.BasePattern, "*", "1")
			if !editBaseMatches(window, probe) {
				return errors.New("invalid interface base pattern")
			}
		}
	}
	return nil
}

func (r *Router) templateForEditDevice(req *http.Request, device *models.Device) (*models.ProvisioningTemplate, error) {
	m, p := "", ""
	if device.Manufacturer != nil {
		m = *device.Manufacturer
	}
	if device.ProductClass != nil {
		p = *device.ProductClass
	}
	return r.provisioningRepo.ResolveTemplateForDevice(req.Context(), m, p)
}

func (r *Router) editReference(w http.ResponseWriter, req *http.Request, serial string, templateID int64) (*models.Device, bool) {
	if !requestCan(req, "cpe", "read") {
		respondError(w, http.StatusForbidden, "CPE overview Read is required to browse reference parameters")
		return nil, false
	}
	device, err := r.deviceRepo.GetBySerial(req.Context(), serial)
	if err != nil || device == nil || !device.Online {
		respondError(w, http.StatusBadRequest, "Choose an online reference CPE")
		return nil, false
	}
	template, err := r.templateForEditDevice(req, device)
	if err != nil || template == nil || template.ID != templateID {
		respondError(w, http.StatusBadRequest, "Reference CPE must use this template")
		return nil, false
	}
	return device, true
}

type editParameterMetadata struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Target      string `json:"target"`
	BasePattern string `json:"base_pattern"`
	Parameter   string `json:"parameter"`
}

func (r *Router) handleEditWindowReferences(w http.ResponseWriter, req *http.Request) {
	if !requestCan(req, "cpe", "read") {
		respondError(w, http.StatusForbidden, "CPE overview Read is required")
		return
	}
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	query := r.db.WithContext(req.Context()).Model(&models.Device{}).Select("id", "serial_number", "manufacturer", "product_class", "online").Where("online = ?", true)
	if template.Manufacturer != "" {
		query = query.Where("LOWER(manufacturer) = LOWER(?)", template.Manufacturer)
	}
	if template.ProductClass != "" {
		query = query.Where("LOWER(product_class) = LOWER(?)", template.ProductClass)
	}
	if search := req.URL.Query().Get("search"); search != "" {
		query = query.Where("serial_number ILIKE ? ESCAPE '!'", "%"+strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(search)+"%")
	}
	var devices []models.Device
	if err := query.Order("serial_number").Limit(200).Find(&devices).Error; err != nil {
		respondError(w, http.StatusServiceUnavailable, "Reference CPE list is unavailable")
		return
	}
	templates, err := r.provisioningRepo.ListTemplates(req.Context())
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "Template matching is unavailable")
		return
	}
	result := []map[string]string{}
	for _, device := range devices {
		m, p := "", ""
		if device.Manufacturer != nil {
			m = *device.Manufacturer
		}
		if device.ProductClass != nil {
			p = *device.ProductClass
		}
		if matched := database.SelectProvisioningTemplate(templates, m, p); matched != nil && matched.ID == id {
			result = append(result, map[string]string{"serial": device.SerialNumber})
		}
	}
	respondJSON(w, http.StatusOK, result)
}

func (r *Router) handleEditWindowParameters(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	device, ok := r.editReference(w, req, req.URL.Query().Get("serial"), id)
	if !ok {
		return
	}
	var parameters []models.DeviceParameter
	if err := r.db.WithContext(req.Context()).Select("name", "value_type").Where("device_id = ? AND writable = ?", device.ID, true).Order("name").Find(&parameters).Error; err != nil {
		respondError(w, http.StatusServiceUnavailable, "Parameter metadata is unavailable")
		return
	}
	result := []editParameterMetadata{}
	for _, parameter := range parameters {
		target, base, suffix := parseEditBinding(parameter.Name)
		kind := normalizeEditType(parameter.ValueType)
		if target == "" || (kind != "string" && kind != "int" && kind != "unsignedInt" && kind != "boolean") {
			continue
		}
		result = append(result, editParameterMetadata{Name: parameter.Name, Type: kind, Target: target, BasePattern: base, Parameter: suffix})
	}
	respondJSON(w, http.StatusOK, result)
}

func decodeEditBody(w http.ResponseWriter, req *http.Request, body any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid edit window request")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		respondError(w, http.StatusBadRequest, "Provide exactly one request body")
		return false
	}
	return true
}

func (r *Router) handleSaveEditWindows(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var body struct {
		ReferenceSerial string                 `json:"reference_serial"`
		Windows         []models.CPEEditWindow `json:"windows"`
	}
	if !decodeEditBody(w, req, &body) {
		return
	}
	if err := validateEditWindows(body.Windows); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := r.provisioningRepo.GetTemplate(req.Context(), id); err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	if len(body.Windows) > 0 {
		device, ok := r.editReference(w, req, body.ReferenceSerial, id)
		if !ok {
			return
		}
		var parameters []models.DeviceParameter
		if err := r.db.WithContext(req.Context()).Select("name", "value_type", "writable").Where("device_id = ? AND writable = ?", device.ID, true).Find(&parameters).Error; err != nil {
			respondError(w, http.StatusServiceUnavailable, "Cannot verify reference parameters")
			return
		}
		for _, window := range body.Windows {
			for _, tab := range window.Tabs {
				for _, field := range tab.Fields {
					found := false
					for _, parameter := range parameters {
						target, base, suffix := parseEditBinding(parameter.Name)
						if target == window.Target && base == window.BasePattern && suffix == field.Parameter && normalizeEditType(parameter.ValueType) == field.Type {
							found = true
							break
						}
					}
					if !found {
						respondError(w, http.StatusBadRequest, "Every field must match a writable reference parameter and its actual type: "+field.Name)
						return
					}
				}
			}
		}
	}
	template := models.ProvisioningTemplate{ID: id, CPEEditWindows: body.Windows}
	if err := r.db.WithContext(req.Context()).Model(&template).Select("cpe_edit_windows").Updates(&template).Error; err != nil {
		respondError(w, http.StatusInternalServerError, "Could not save edit windows")
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"cpe_edit_windows": body.Windows})
}

type editWindowState struct {
	Window     *models.CPEEditWindow    `json:"window"`
	Parameters []models.DeviceParameter `json:"parameters"`
}

func (r *Router) loadEditWindow(req *http.Request, target, prefix string) (*models.Device, editWindowState, error) {
	state := editWindowState{Parameters: []models.DeviceParameter{}}
	device, err := r.parseDeviceBySerial(req)
	if err != nil || device == nil {
		return nil, state, gorm.ErrRecordNotFound
	}
	template, err := r.templateForEditDevice(req, device)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return device, state, nil
	}
	if err != nil {
		return device, state, err
	}
	for i := range template.CPEEditWindows {
		window := &template.CPEEditWindows[i]
		if window.Target == target && window.Enabled {
			if err := validateEditWindows([]models.CPEEditWindow{*window}); err != nil {
				return device, state, err
			}
			if !editBaseMatches(*window, prefix) {
				return device, state, errors.New("This editor does not match the selected interface path")
			}
			state.Window = window
			break
		}
	}
	if state.Window == nil {
		return device, state, nil
	}
	names := []string{}
	for _, tab := range state.Window.Tabs {
		for _, field := range tab.Fields {
			names = append(names, prefix+field.Parameter)
		}
	}
	if err := r.db.WithContext(req.Context()).Where("device_id = ? AND name IN ?", device.ID, names).Find(&state.Parameters).Error; err != nil {
		return device, state, err
	}
	return device, state, nil
}

func (r *Router) handleGetEditWindow(w http.ResponseWriter, req *http.Request) {
	_, state, err := r.loadEditWindow(req, req.URL.Query().Get("target"), req.URL.Query().Get("prefix"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "Cannot load the editor for this interface")
		return
	}
	// Stored sensitive values are never returned by the custom editor, even to admins.
	for i := range state.Parameters {
		if database.IsSensitiveParameterName(state.Parameters[i].Name) {
			state.Parameters[i].Value = ""
		}
	}
	respondJSON(w, http.StatusOK, state)
}

func (r *Router) handleApplyEditWindow(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Target     string            `json:"target"`
		Prefix     string            `json:"prefix"`
		Parameters map[string]string `json:"parameters"`
	}
	if !decodeEditBody(w, req, &body) {
		return
	}
	_, state, err := r.loadEditWindow(req, body.Target, body.Prefix)
	if err != nil || state.Window == nil {
		respondError(w, http.StatusBadRequest, "No matching custom edit window")
		return
	}
	if err := validateEditWindowChanges(*state.Window, body.Prefix, state.Parameters, body.Parameters); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	encoded, _ := json.Marshal(map[string]any{"parameters": body.Parameters})
	req.Body = io.NopCloser(bytes.NewReader(encoded))
	r.handleSetParameterValuesBySerial(w, req)
}

func validateEditWindowChanges(window models.CPEEditWindow, prefix string, parameters []models.DeviceParameter, changes map[string]string) error {
	if len(changes) == 0 || len(changes) > 128 {
		return errors.New("provide 1–128 changed fields")
	}
	allowed := map[string]models.CPEEditField{}
	for _, tab := range window.Tabs {
		for _, field := range tab.Fields {
			allowed[prefix+field.Parameter] = field
		}
	}
	current := map[string]models.DeviceParameter{}
	for _, parameter := range parameters {
		current[parameter.Name] = parameter
	}
	for name, value := range changes {
		field, exists := allowed[name]
		parameter, present := current[name]
		if !exists || !present || parameter.Writable == nil || !*parameter.Writable || normalizeEditType(parameter.ValueType) != field.Type || validateEditValue(field.Type, value) != nil {
			return fmt.Errorf("parameter is unavailable, read-only or has an incompatible value/type: %s", name)
		}
		if field.Input == "select" {
			found := false
			for _, option := range field.Options {
				if option.Value == value {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("value is not an allowed select option: %s", name)
			}
		}
	}
	return nil
}
