package cwmp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestFullTree9002FallsBackToBatchedLeafReads(t *testing.T) {
	for _, root := range []string{"InternetGatewayDevice.", "Device."} {
		for _, automatic := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/automatic=%v", root, automatic), func(t *testing.T) {
				h, faults := diagnostic9005TestHandler(t, nil)
				s := h.sessions.GetOrCreate("full-read", "TEST")
				s.DeviceID, s.State, s.DataModelRoot = 1, StateProcessingTasks, root
				if automatic {
					s.AutoFetchPhase = 1
				} else {
					s.CurrentTaskID, s.CurrentFullTreeFetch = 42, true
				}
				h.rememberSentRequest(s.ID, &GetParameterValues{ParameterNames: []string{root}})
				request, err := h.handleFault(context.Background(), &SOAPFault{FaultCode: "9002", FaultString: "Internal error"}, s.ID)
				gpn, ok := request.(*GetParameterNames)
				if err != nil || !ok || gpn.ParameterPath != root || gpn.NextLevel || len(*faults) != 0 {
					t.Fatalf("fallback discovery: request=%#v error=%v faults=%v", request, err, *faults)
				}
				h.rememberSentRequest(s.ID, request)
				names := &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{{Name: root}, {Name: root + "Test."}, {Name: "Other.Value"}}}
				for index := 0; index < 130; index++ {
					names.ParameterList = append(names.ParameterList, ParameterInfoStruct{Name: fmt.Sprintf("%sTest.Value%d", root, index)})
				}
				names.ParameterList = append(names.ParameterList, names.ParameterList[3])
				request, err = h.handleGetParameterNamesResponse(context.Background(), names, s.ID)
				for batch, size := range []int{64, 64, 2} {
					gpv, ok := request.(*GetParameterValues)
					if err != nil || !ok || len(gpv.ParameterNames) != size {
						t.Fatalf("batch %d: request=%#v error=%v", batch, request, err)
					}
					if s.State != StateProcessingTasks || s.FullTreeRead == nil || len(s.FullTreeRead.values) != batch*64 {
						t.Fatal("refresh completed before all batches were read")
					}
					h.rememberSentRequest(s.ID, request)
					response := &GetParameterValuesResp{}
					for _, name := range gpv.ParameterNames {
						response.ParameterList.Parameters = append(response.ParameterList.Parameters, ParameterValueStruct{Name: name, Value: "test"})
					}
					request, err = h.handleGetParameterValuesResponse(context.Background(), response, s.ID)
				}
				if err != nil || s.FullTreeRead != nil || len(*faults) != 0 {
					t.Fatalf("refresh did not finish cleanly: error=%v faults=%v", err, *faults)
				}
				if automatic {
					if _, ok := request.(*GetParameterNames); !ok || s.AutoFetchPhase != 2 {
						t.Fatal("automatic refresh did not continue to writable metadata")
					}
				} else if request != nil || s.State != StateIdle {
					t.Fatal("queued refresh did not finish")
				}
			})
		}
	}
}

func TestFullTreeReadCompletesTaskOnceWithAllBatches(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{
		DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	updates := 0
	var result map[string]string
	if err := db.Callback().Update().Before("gorm:update").Register("test:full-tree-result", func(tx *gorm.DB) {
		updates++
		fields := tx.Statement.Dest.(map[string]interface{})
		if fields["status"] != models.TaskStatusCompleted {
			t.Errorf("task status=%v", fields["status"])
		}
		if err := json.Unmarshal(fields["result"].([]byte), &result); err != nil {
			t.Error(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(nil)
	h.taskRepo = database.NewTaskRepository(db)
	s := h.sessions.GetOrCreate("queued-batches", "TEST")
	// No device ID prevents unrelated next-task queries after completion.
	s.State, s.CurrentTaskID = StateProcessingTasks, 42
	s.FullTreeRead = &fullTreeRead{root: "Device."}
	for index := 0; index < 65; index++ {
		s.FullTreeRead.names = append(s.FullTreeRead.names, fmt.Sprintf("Device.Test.Value%d", index))
	}
	s.FullTreeRead.names = append(s.FullTreeRead.names, "Device.Test.Password")
	var request interface{} = s.FullTreeRead.next()
	for batch := 0; request != nil; batch++ {
		if updates != 0 || s.CurrentTaskID != 42 {
			t.Fatal("task completed before the final batch")
		}
		gpv := request.(*GetParameterValues)
		response := &GetParameterValuesResp{}
		for _, name := range gpv.ParameterNames {
			response.ParameterList.Parameters = append(response.ParameterList.Parameters, ParameterValueStruct{Name: name, Value: "test"})
		}
		request, err = h.handleGetParameterValuesResponse(context.Background(), response, s.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	if updates != 1 || len(result) != 66 || result["Device.Test.Password"] != "[REDACTED]" || s.CurrentTaskID != 0 {
		t.Fatalf("updates=%d parameters=%d task=%d", updates, len(result), s.CurrentTaskID)
	}
}

func TestFullTree9002FallbackFailureIsNotRetriedOrHidden(t *testing.T) {
	for _, stage := range []string{"discovery", "batch", "empty discovery", "incomplete batch"} {
		t.Run(stage, func(t *testing.T) {
			h, faults := diagnostic9005TestHandler(t, nil)
			s := h.sessions.GetOrCreate("failed-read", "TEST")
			s.DeviceID, s.State, s.CurrentTaskID, s.CurrentFullTreeFetch = 1, StateProcessingTasks, 42, true
			h.rememberSentRequest(s.ID, &GetParameterValues{ParameterNames: []string{"Device."}})
			request, err := h.handleFault(context.Background(), &SOAPFault{FaultCode: "9002"}, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			h.rememberSentRequest(s.ID, request)
			if stage == "empty discovery" {
				request, err = h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{}, s.ID)
			} else {
				if stage == "batch" || stage == "incomplete batch" {
					request, err = h.handleGetParameterNamesResponse(context.Background(), &GetParameterNamesResp{ParameterList: []ParameterInfoStruct{{Name: "Device.Test.Value"}}}, s.ID)
					if err != nil {
						t.Fatal(err)
					}
					h.rememberSentRequest(s.ID, request)
				}
				if stage == "incomplete batch" {
					request, err = h.handleGetParameterValuesResponse(context.Background(), &GetParameterValuesResp{}, s.ID)
				} else {
					request, err = h.handleFault(context.Background(), &SOAPFault{FaultCode: "9002", FaultString: "Internal error"}, s.ID)
				}
			}
			if err != nil || request != nil || s.FullTreeRead != nil || s.CurrentFullTreeFetch || len(*faults) != 1 {
				t.Fatalf("failed fallback: request=%#v error=%v faults=%v", request, err, *faults)
			}
		})
	}
}
