package api

import (
	"encoding/json"
	"net/http"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
)

func (r *Router) handleClearSystemTasks(w http.ResponseWriter, req *http.Request) {
	taskType := models.SystemTaskType(req.PathValue("type"))
	if taskType != models.SystemTaskTypeSummonFromCPE && taskType != models.SystemTaskTypeBulkSummon && taskType != models.SystemTaskTypeBulkRestart {
		respondError(w, http.StatusBadRequest, "Invalid system task type")
		return
	}
	if !requestCan(req, "settings.system_tasks."+string(taskType), "delete") {
		respondError(w, http.StatusForbidden, "System task type delete permission required")
		return
	}
	var body struct {
		Statuses []models.SystemTaskStatus `json:"statuses"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid task statuses")
		return
	}
	if err := database.ValidateSystemTaskClearStatuses(body.Statuses); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	actor := "system task cleanup"
	if claims := auth.GetUserFromContext(req.Context()); claims != nil {
		actor = claims.Username
	}
	result, err := r.systemTaskRepo.ClearStatuses(req.Context(), taskType, body.Statuses, actor)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to clear selected system tasks")
		return
	}
	respondJSON(w, http.StatusOK, result)
}
