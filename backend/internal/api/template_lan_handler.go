package api

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

const maxTemplateLANPorts = 32

var svgURLReference = regexp.MustCompile(`(?i)url\(\s*['"]?([^)'"\s]+)['"]?\s*\)`)

var safeTemplateSVGElements = map[string]bool{
	"svg": true, "g": true, "title": true, "desc": true, "defs": true,
	"path": true, "rect": true, "circle": true, "ellipse": true, "line": true,
	"polyline": true, "polygon": true, "text": true, "tspan": true,
	"lineargradient": true, "radialgradient": true, "stop": true, "clippath": true,
	"mask": true, "filter": true, "fegaussianblur": true, "feoffset": true,
	"fecolormatrix": true, "fecomponenttransfer": true, "fefunca": true,
	"fefuncr": true, "fefuncg": true, "fefuncb": true, "femerge": true,
	"femergenode": true, "pattern": true, "marker": true, "use": true,
}

func (r *Router) templateLANVisualizationURL(template *models.ProvisioningTemplate) {
	if template != nil && template.LANVisualizationPath != "" {
		template.LANVisualizationURL = "/provisioning/templates/" + strconv.FormatInt(template.ID, 10) + "/lan-visualization"
	} else if template != nil {
		template.LANVisualizationURL = ""
	}
}

func (r *Router) handleUpdateTemplateLANConfiguration(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var body struct {
		PortCount int                                 `json:"lan_port_count"`
		Mappings  []models.ProvisioningLANPortMapping `json:"lan_port_mappings"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid LAN port configuration")
		return
	}
	mappings, err := validateTemplateLANConfiguration(body.PortCount, body.Mappings)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.provisioningRepo.UpdateTemplateLANConfiguration(req.Context(), id, body.PortCount, mappings); err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	r.templateLANVisualizationURL(template)
	redactProvisioningVariableSecrets(template.Variables)
	respondJSON(w, http.StatusOK, template)
}

func validateTemplateLANConfiguration(portCount int, mappings []models.ProvisioningLANPortMapping) ([]models.ProvisioningLANPortMapping, error) {
	if portCount < 1 || portCount > maxTemplateLANPorts {
		return nil, fmt.Errorf("LAN port count must be between 1 and %d", maxTemplateLANPorts)
	}
	byPort := make(map[int]models.ProvisioningLANPortMapping, len(mappings))
	for _, mapping := range mappings {
		if mapping.Port < 1 || mapping.Port > portCount {
			return nil, fmt.Errorf("LAN mapping port must be between 1 and %d", portCount)
		}
		if _, exists := byPort[mapping.Port]; exists {
			return nil, fmt.Errorf("LAN port %d has duplicate mappings", mapping.Port)
		}
		for _, parameter := range []*string{&mapping.StatusParameter, &mapping.SpeedParameter, &mapping.DuplexParameter, &mapping.RXBytesParameter, &mapping.TXBytesParameter} {
			*parameter = strings.TrimSpace(*parameter)
			if !validLANParameterPath(*parameter) {
				return nil, fmt.Errorf("LAN port %d contains an invalid CWMP parameter path", mapping.Port)
			}
		}
		byPort[mapping.Port] = mapping
	}
	normalized := make([]models.ProvisioningLANPortMapping, portCount)
	for port := 1; port <= portCount; port++ {
		mapping, exists := byPort[port]
		if !exists {
			mapping.Port = port
		}
		normalized[port-1] = mapping
	}
	return normalized, nil
}

func validLANParameterPath(path string) bool {
	if path == "" {
		return true
	}
	if len(path) > 512 || strings.HasPrefix(path, ".") || strings.HasSuffix(path, ".") || strings.Contains(path, "..") {
		return false
	}
	for _, char := range path {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '.' || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func (r *Router) handleGetTemplateLANVisualization(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil || template.LANVisualizationPath == "" {
		respondError(w, http.StatusNotFound, "LAN visualization not found")
		return
	}
	path, err := secureTemplateImagePath(r.templateImageDir, template.LANVisualizationPath)
	if err != nil {
		respondError(w, http.StatusNotFound, "LAN visualization not found")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		respondError(w, http.StatusNotFound, "LAN visualization not found")
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", "inline; filename=lan-visualization.svg")
	_, _ = w.Write(data)
}

func (r *Router) handleUploadTemplateLANVisualization(w http.ResponseWriter, req *http.Request) {
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
	if r.templateImageInitErr != nil {
		respondError(w, http.StatusServiceUnavailable, "Template image storage unavailable")
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, maxTemplateImageSize+(64<<10))
	if err := req.ParseMultipartForm(maxTemplateImageSize); err != nil {
		respondError(w, http.StatusBadRequest, "SVG is too large or the form is invalid")
		return
	}
	portCount := template.LANPortCount
	if rawCount := req.FormValue("port_count"); rawCount != "" {
		requestedCount, parseErr := strconv.Atoi(rawCount)
		if parseErr != nil || requestedCount != portCount {
			respondError(w, http.StatusBadRequest, "Invalid LAN port count")
			return
		}
	}
	if portCount < 1 || portCount > maxTemplateLANPorts {
		respondError(w, http.StatusBadRequest, "Set a LAN port count between 1 and 32 before uploading an SVG")
		return
	}
	file, _, err := req.FormFile("file")
	if err != nil {
		respondError(w, http.StatusBadRequest, "No SVG uploaded")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxTemplateImageSize+1))
	if err != nil || len(data) == 0 {
		respondError(w, http.StatusBadRequest, "Failed to read SVG")
		return
	}
	if len(data) > maxTemplateImageSize {
		respondError(w, http.StatusBadRequest, "SVG exceeds the 5 MB limit")
		return
	}
	sanitized, err := sanitizeTemplateLANVisualization(data, portCount)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	tempFile, err := os.CreateTemp(r.templateImageDir, ".template-lan-*.svg")
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save SVG")
		return
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)
	if _, err := tempFile.Write(sanitized); err != nil {
		_ = tempFile.Close()
		respondError(w, http.StatusInternalServerError, "Failed to save SVG")
		return
	}
	if err := tempFile.Close(); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save SVG")
		return
	}
	if err := os.Chmod(tempPath, 0600); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to secure SVG")
		return
	}
	visualizationPath := filepath.Join(r.templateImageDir, strconv.FormatInt(id, 10)+"-lan-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".svg")
	if err := os.Rename(tempPath, visualizationPath); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to finalize SVG")
		return
	}
	if err := r.provisioningRepo.UpdateTemplateLANVisualization(req.Context(), id, visualizationPath); err != nil {
		_ = os.Remove(visualizationPath)
		respondError(w, http.StatusInternalServerError, "Failed to save SVG")
		return
	}
	if template.LANVisualizationPath != "" {
		if oldPath, pathErr := secureTemplateImagePath(r.templateImageDir, template.LANVisualizationPath); pathErr == nil {
			_ = os.Remove(oldPath)
		}
	}
	template.LANVisualizationPath = visualizationPath
	r.templateLANVisualizationURL(template)
	redactProvisioningVariableSecrets(template.Variables)
	respondJSON(w, http.StatusOK, template)
}

func (r *Router) handleDeleteTemplateLANVisualization(w http.ResponseWriter, req *http.Request) {
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
	if err := r.provisioningRepo.UpdateTemplateLANVisualization(req.Context(), id, ""); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to remove SVG")
		return
	}
	if template.LANVisualizationPath != "" {
		if path, pathErr := secureTemplateImagePath(r.templateImageDir, template.LANVisualizationPath); pathErr == nil {
			_ = os.Remove(path)
		}
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func sanitizeTemplateLANVisualization(data []byte, portCount int) ([]byte, error) {
	if portCount < 1 || portCount > maxTemplateLANPorts {
		return nil, errors.New("LAN port count must be between 1 and 32")
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	output := &bytes.Buffer{}
	encoder := xml.NewEncoder(output)
	rootSeen, viewBoxSeen := false, false
	skipDepth := 0
	portScopes := make([]int, 0, portCount)
	portGroups, portIndicators, portCables := map[int]bool{}, map[int]bool{}, map[int]bool{}
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errors.New("Invalid SVG XML")
		}
		switch value := token.(type) {
		case xml.StartElement:
			name := strings.ToLower(value.Name.Local)
			if skipDepth > 0 {
				skipDepth++
				continue
			}
			if name == "style" || name == "script" {
				skipDepth = 1
				continue
			}
			if !safeTemplateSVGElements[name] {
				return nil, fmt.Errorf("SVG element %q is not allowed", value.Name.Local)
			}
			if !rootSeen {
				if name != "svg" {
					return nil, errors.New("SVG root element is required")
				}
				rootSeen = true
			}
			attrs := make([]xml.Attr, 0, len(value.Attr))
			id, className := "", ""
			for _, attr := range value.Attr {
				attrName := strings.ToLower(attr.Name.Local)
				if attrName == "style" {
					continue
				}
				if strings.HasPrefix(attrName, "on") || strings.Contains(strings.ToLower(attr.Value), "javascript:") || strings.Contains(strings.ToLower(attr.Value), "expression(") {
					return nil, fmt.Errorf("SVG attribute %q is not allowed", attr.Name.Local)
				}
				if attrName == "href" && !strings.HasPrefix(strings.TrimSpace(attr.Value), "#") {
					return nil, errors.New("SVG links must refer to an element in the same file")
				}
				for _, match := range svgURLReference.FindAllStringSubmatch(attr.Value, -1) {
					if len(match) < 2 || !strings.HasPrefix(strings.TrimSpace(match[1]), "#") {
						return nil, errors.New("SVG resources must refer to elements in the same file")
					}
				}
				if attrName == "id" {
					id = attr.Value
				}
				if attrName == "class" {
					className = attr.Value
				}
				if name == "svg" && strings.EqualFold(attr.Name.Local, "viewBox") {
					parts := strings.Fields(strings.ReplaceAll(attr.Value, ",", " "))
					if len(parts) != 4 {
						return nil, errors.New("SVG viewBox must contain four numbers")
					}
					viewBox := make([]float64, 4)
					for index, part := range parts {
						viewBox[index], err = strconv.ParseFloat(part, 64)
						if err != nil || math.IsInf(viewBox[index], 0) || math.IsNaN(viewBox[index]) {
							return nil, errors.New("SVG viewBox must contain finite numbers")
						}
					}
					if viewBox[2] <= 0 || viewBox[3] <= 0 {
						return nil, errors.New("SVG viewBox width and height must be positive")
					}
					viewBoxSeen = true
				}
				attrs = append(attrs, attr)
			}
			value.Attr = attrs
			if name == "g" {
				port := 0
				if strings.HasPrefix(id, "lan") {
					if number, parseErr := strconv.Atoi(strings.TrimPrefix(id, "lan")); parseErr == nil && number >= 1 && number <= maxTemplateLANPorts {
						if number > portCount {
							return nil, fmt.Errorf("SVG contains LAN%d but the template is configured for %d ports", number, portCount)
						}
						port = number
						if portGroups[port] {
							return nil, fmt.Errorf("SVG contains duplicate group id lan%d", port)
						}
						portGroups[port] = true
					}
				}
				portScopes = append(portScopes, port)
			}
			activePort := 0
			for index := len(portScopes) - 1; index >= 0; index-- {
				if portScopes[index] != 0 {
					activePort = portScopes[index]
					break
				}
			}
			if activePort != 0 {
				for _, class := range strings.Fields(className) {
					if class == "port-led" {
						portIndicators[activePort] = true
					}
					if class == "cable-system" {
						portCables[activePort] = true
					}
				}
			}
			if err := encoder.EncodeToken(value); err != nil {
				return nil, err
			}
		case xml.EndElement:
			if skipDepth > 0 {
				skipDepth--
				continue
			}
			if strings.EqualFold(value.Name.Local, "g") && len(portScopes) > 0 {
				portScopes = portScopes[:len(portScopes)-1]
			}
			if err := encoder.EncodeToken(value); err != nil {
				return nil, err
			}
		case xml.CharData:
			if skipDepth == 0 {
				if err := encoder.EncodeToken(value); err != nil {
					return nil, err
				}
			}
		case xml.ProcInst:
			if !strings.EqualFold(value.Target, "xml") {
				return nil, errors.New("SVG processing instructions are not allowed")
			}
		case xml.Directive:
			if skipDepth == 0 {
				return nil, errors.New("SVG document directives are not allowed")
			}
		}
	}
	if !rootSeen || !viewBoxSeen {
		return nil, errors.New("SVG must define a viewBox")
	}
	for port := 1; port <= portCount; port++ {
		if !portGroups[port] || !portIndicators[port] || !portCables[port] {
			return nil, fmt.Errorf("SVG port %d must be a <g id=\"lan%d\"> with .port-led and .cable-system elements", port, port)
		}
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
