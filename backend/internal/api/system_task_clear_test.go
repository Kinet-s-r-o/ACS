package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func TestSystemTaskClearRejectsUnauthorizedOrUnsafeSelections(t *testing.T) {
	for _, tc := range []struct {
		name, action, taskType, body string
		status                       int
	}{
		{"read only", "read", "bulk_summon", `{"statuses":["pending"]}`, 403},
		{"write cannot delete", "write", "bulk_summon", `{"statuses":["pending"]}`, 403},
		{"invalid type", "delete", "unknown", `{"statuses":["pending"]}`, 400},
		{"empty", "delete", "bulk_summon", `{"statuses":[]}`, 400},
		{"processing", "delete", "bulk_summon", `{"statuses":["processing"]}`, 400},
		{"waiting", "delete", "bulk_summon", `{"statuses":["pending","waiting"]}`, 400},
		{"unknown status", "delete", "bulk_summon", `{"statuses":["unknown"]}`, 400},
		{"unknown field", "delete", "bulk_summon", `{"statuses":["pending"],"all":true}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mux := newPermissionMux()
			mux.HandleFunc("DELETE /system-tasks/{type}", (&Router{}).handleClearSystemTasks)
			req := scopedRequest(http.MethodDelete, "/system-tasks/"+tc.taskType, []string{models.PermissionKey("settings.system_tasks", "read"), models.PermissionKey("settings.system_tasks", tc.action)}, tc.body)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, req)
			if response.Code != tc.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}
