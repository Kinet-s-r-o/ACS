package cwmp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestPartialRefreshSavesGoodValuesWithoutPurgingOrMarkingFullRefresh(t *testing.T) {
	for _, scenario := range []string{"queued", "automatic", "missing value", "all unreadable", "bad last"} {
		t.Run(scenario, func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotInformConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			cache := map[string]string{"Device.Test.A": "old-A", "Device.Test.B": "old-B", "Device.Test.C": "old-C", "Device.Test.Stale": "retain"}
			faults := []models.Fault{}
			var taskResult map[string]string
			var status models.TaskStatus
			var warning string
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				if _, ok := tx.Statement.Dest.(*models.Task); !ok {
					t.Fatalf("unexpected query: %T", tx.Statement.Dest)
				}
				tx.AddError(gorm.ErrRecordNotFound)
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *[]models.DeviceParameter:
					for _, parameter := range *dest {
						cache[parameter.Name] = parameter.Value
					}
				case *models.Fault:
					faults = append(faults, *dest)
				default:
					t.Fatalf("unexpected insert: %T", dest)
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Delete().Replace("gorm:delete", func(tx *gorm.DB) { t.Fatal("partial refresh purged cached parameters") }); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) {
				if tx.Statement.Table != "tasks" {
					t.Fatalf("partial refresh marked device freshness: %s", tx.Statement.Table)
				}
				fields := tx.Statement.Dest.(map[string]interface{})
				status = fields["status"].(models.TaskStatus)
				warning = fields["error_message"].(string)
				if err := json.Unmarshal(fields["result"].([]byte), &taskResult); err != nil {
					t.Error(err)
				}
			}); err != nil {
				t.Fatal(err)
			}
			h := NewHandler(nil)
			h.parameterRepo = database.NewParameterRepository(db)
			h.deviceRepo = database.NewDeviceRepository(db)
			h.taskRepo = database.NewTaskRepository(db)
			h.faultRepo = database.NewFaultRepository(db)
			s := h.sessions.GetOrCreate("partial", "TEST")
			s.DeviceID, s.State, s.DataModelRoot = 1, StateProcessingTasks, "Device."
			if scenario == "automatic" {
				s.AutoFetchPhase = 1
			} else {
				s.CurrentTaskID, s.CurrentFullTreeFetch = 42, true
			}
			read := &fullTreeRead{root: "Device.", names: []string{"Device.Test.A", "Device.Test.B", "Device.Test.C"}}
			s.FullTreeRead = read
			var request interface{} = read.next()
			for calls := 0; request != nil; calls++ {
				if calls > 20 {
					t.Fatal("partial refresh did not finish")
				}
				gpv, ok := request.(*GetParameterValues)
				if !ok {
					if scenario == "automatic" && s.AutoFetchPhase == 2 {
						break
					}
					t.Fatalf("unexpected request: %T", request)
				}
				h.rememberSentRequest(s.ID, request)
				response := &GetParameterValuesResp{}
				code := ""
				for _, name := range gpv.ParameterNames {
					bad := name == "Device.Test.B" || scenario == "all unreadable" || (scenario == "bad last" && name == "Device.Test.C")
					if bad {
						code = "9005"
						continue
					}
					response.ParameterList.Parameters = append(response.ParameterList.Parameters, ParameterValueStruct{Name: name, Value: "new"})
				}
				if code != "" && scenario != "missing value" {
					request, err = h.handleFault(context.Background(), &SOAPFault{FaultCode: code, FaultString: "Invalid parameter name"}, s.ID)
				} else {
					request, err = h.handleGetParameterValuesResponse(context.Background(), response, s.ID)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			wantRead, wantSkipped := 2, 1
			if scenario == "all unreadable" {
				wantRead, wantSkipped = 0, 3
			} else if scenario == "bad last" {
				wantRead, wantSkipped = 1, 2
			}
			if len(read.values) != wantRead || len(faults) != wantSkipped || cache["Device.Test.B"] != "old-B" || cache["Device.Test.Stale"] != "retain" {
				t.Fatalf("read=%d faults=%d cache=%v", len(read.values), len(faults), cache)
			}
			if wantRead > 0 && cache["Device.Test.A"] != "new" {
				t.Fatal("successful values were not refreshed")
			}
			if scenario != "automatic" {
				wantStatus := models.TaskStatusCompleted
				if wantRead == 0 {
					wantStatus = models.TaskStatusFailed
				}
				if status != wantStatus || !strings.HasPrefix(warning, "Partial parameter refresh:") || len(taskResult) != wantRead {
					t.Fatalf("status=%s warning=%q result=%v", status, warning, taskResult)
				}
			}
		})
	}
}

func TestPartialRefreshWorkerPreservesWarningAndRejectsSnapshot(t *testing.T) {
	for _, kind := range []string{"", "manual", "initial", "scheduled"} {
		t.Run("kind="+kind, func(t *testing.T) {
			db, err := gorm.Open(postgres.New(postgres.Config{Conn: snapshotInformConnection{}}), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
			if err != nil {
				t.Fatal(err)
			}
			id := int64(42)
			job := models.SystemTask{ID: 1, DeviceID: 1, CWMPTaskID: &id, Status: models.SystemTaskStatusWaiting, SnapshotKind: kind}
			warning := "Partial parameter refresh: read 2 parameters; skipped 1 unreadable parameters (see CWMP faults)"
			listed := false
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				switch dest := tx.Statement.Dest.(type) {
				case *[]database.Setting:
				case *[]models.SystemTask:
					if !listed {
						*dest = []models.SystemTask{job}
						listed = true
					}
				case *models.Task:
					*dest = models.Task{ID: id, Status: models.TaskStatusCompleted, ErrorMessage: warning}
				case *models.SystemTask:
					*dest = job
				default:
					t.Fatalf("unexpected query: %T", dest)
				}
			}); err != nil {
				t.Fatal(err)
			}
			updates := 0
			if err := db.Callback().Update().Replace("gorm:update", func(tx *gorm.DB) {
				updates++
				fields := tx.Statement.Dest.(map[string]interface{})
				want := models.SystemTaskStatusCompleted
				if kind != "" {
					want = models.SystemTaskStatusFailed
				}
				if fields["status"] != want || !strings.Contains(fields["error_message"].(string), warning) {
					t.Fatalf("unexpected completion: %v", fields)
				}
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Callback().Create().Replace("gorm:create", func(tx *gorm.DB) { t.Fatal("partial refresh created a snapshot") }); err != nil {
				t.Fatal(err)
			}
			if err := NewSystemTaskWorker(db).reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			if updates != 1 {
				t.Fatalf("completed %d jobs", updates)
			}
		})
	}
}
