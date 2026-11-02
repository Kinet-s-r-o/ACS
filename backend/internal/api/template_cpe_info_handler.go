package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/matrix8412/acs/internal/models"
)

const maxTemplateCPEInfoFields = 64

func (r *Router) handleUpdateTemplateCPEInfo(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	var body struct {
		Fields []models.ProvisioningCPEInfoField `json:"cpe_info_fields"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid CPE info configuration")
		return
	}
	fields, err := validateTemplateCPEInfoFields(body.Fields)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := r.provisioningRepo.UpdateTemplateCPEInfo(req.Context(), id, fields); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save CPE info configuration")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	r.templateImageURL(template)
	r.templateLANVisualizationURL(template)
	redactProvisioningVariableSecrets(template.Variables)
	respondJSON(w, http.StatusOK, template)
}

func validateTemplateCPEInfoFields(fields []models.ProvisioningCPEInfoField) ([]models.ProvisioningCPEInfoField, error) {
	if len(fields) > maxTemplateCPEInfoFields {
		return nil, fmt.Errorf("too many CPE info fields (maximum %d)", maxTemplateCPEInfoFields)
	}
	validated := make([]models.ProvisioningCPEInfoField, 0, len(fields))
	for index, field := range fields {
		field.Name = strings.TrimSpace(field.Name)
		field.ParameterName = strings.TrimSpace(field.ParameterName)
		if field.Name == "" || len(field.Name) > 128 || field.ParameterName == "" || !validLANParameterPath(field.ParameterName) {
			return nil, fmt.Errorf("CPE info field %d requires a valid name and CWMP parameter name", index+1)
		}
		validated = append(validated, field)
	}
	return validated, nil
}
