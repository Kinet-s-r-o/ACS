package cwmp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func diagnostic9005TestHandler(t *testing.T, tags []string, createErrors ...error) (*Handler, *[]models.Fault) {
	t.Helper()
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{
		DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().After("gorm:query").Register("test:diagnostic-device", func(tx *gorm.DB) {
		if device, ok := tx.Statement.Dest.(*models.Device); ok {
			*device = models.Device{ID: 1, Tags: tags}
		}
	}); err != nil {
		t.Fatal(err)
	}
	faults := &[]models.Fault{}
	if err := db.Callback().Create().Before("gorm:create").Register("test:diagnostic-fault", func(tx *gorm.DB) {
		if fault, ok := tx.Statement.Dest.(*models.Fault); ok {
			if len(createErrors) > 0 {
				tx.AddError(createErrors[0])
				return
			}
			*faults = append(*faults, *fault)
		}
	}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(nil)
	h.deviceRepo = database.NewDeviceRepository(db)
	h.faultRepo = database.NewFaultRepository(db)
	return h, faults
}

func diagnostic9005Fault() *SOAPFault {
	return &SOAPFault{Detail: FaultDetail{CWMPFault: &CWMPFault{
		FaultCode: "9005", FaultString: "Invalid parameter name",
	}}}
}

func Test9005DiagnosticLargeOverview(t *testing.T) {
	for _, size := range []int{2, 512, 513, 4096} {
		for _, badIndex := range []int{0, size - 1} {
			t.Run(fmt.Sprintf("%d-parameters-bad-%d", size, badIndex), func(t *testing.T) {
				h, faults := diagnostic9005TestHandler(t, []string{diagnostic9005Tag})
				s := h.sessions.GetOrCreate("diagnostic", "TEST")
				s.DeviceID, s.State, s.OverviewFetchActive = 1, StateProcessingTasks, true
				for index := 0; index < size; index++ {
					s.LastSentParameters = append(s.LastSentParameters, fmt.Sprintf("Device.Test.Value%d", index))
				}
				s.LastSentContext = strings.Join(s.LastSentParameters, ", ")
				bad := s.LastSentParameters[badIndex]
				request, err := h.handleFault(context.Background(), diagnostic9005Fault(), s.ID)
				calls := 0
				for request != nil && err == nil {
					gpv, ok := request.(*GetParameterValues)
					if !ok || len(gpv.ParameterNames) > diagnostic9005MaxParams {
						t.Fatalf("unexpected diagnostic request: %#v", request)
					}
					calls++
					if calls > diagnostic9005MaxCalls {
						t.Fatal("diagnostic exceeded its request budget")
					}
					rejected := false
					for _, name := range gpv.ParameterNames {
						rejected = rejected || name == bad
					}
					if rejected {
						request, err = h.handleFault(context.Background(), diagnostic9005Fault(), s.ID)
					} else {
						request, err = h.handleGetParameterValuesResponse(context.Background(), &GetParameterValuesResp{}, s.ID)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				if calls == 0 || len(*faults) != 1 || (*faults)[0].ParameterName != bad || !strings.Contains((*faults)[0].FaultString, "isolated by diagnostic mode") {
					t.Fatalf("failed to isolate %s: calls=%d faults=%d", bad, calls, len(*faults))
				}
				if s.Diagnostic9005Active || s.OverviewFetchActive || len(h.diagnosticSlots) != 0 {
					t.Fatal("diagnostic retained active state or a concurrency slot")
				}
			})
		}
	}
}

func Test9005DiagnosticRemainsTagGated(t *testing.T) {
	for _, scenario := range []struct {
		name string
		tags []string
		want bool
	}{
		{name: "no tags"},
		{name: "different tag", tags: []string{"cwmp-9005-diagnostics-other"}},
		{name: "diagnostic tag", tags: []string{diagnostic9005Tag}, want: true},
		{name: "case and whitespace", tags: []string{" CWMP-9005-DIAGNOSTICS "}, want: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			h, _ := diagnostic9005TestHandler(t, scenario.tags)
			s := h.sessions.GetOrCreate("tag-gate", "TEST")
			s.DeviceID, s.State = 1, StateProcessingTasks
			s.LastSentParameters = []string{"Device.Test.A", "Device.Test.B"}
			request, err := h.handleFault(context.Background(), diagnostic9005Fault(), s.ID)
			if err != nil || (request != nil) != scenario.want || s.Diagnostic9005Active != scenario.want {
				t.Fatalf("request=%T active=%v err=%v; want diagnostic=%v", request, s.Diagnostic9005Active, err, scenario.want)
			}
			h.clear9005Diagnostic(s)
		})
	}
}

func Test9005DiagnosticRequestLimitDoesNotAccuseUntestedParameters(t *testing.T) {
	h, faults := diagnostic9005TestHandler(t, []string{diagnostic9005Tag})
	s := h.sessions.GetOrCreate("budget", "TEST")
	s.DeviceID, s.State = 1, StateProcessingTasks
	for index := 0; index < 512; index++ {
		s.LastSentParameters = append(s.LastSentParameters, fmt.Sprintf("Device.Test.Value%d", index))
	}
	confirmed := make(map[string]bool)
	request, err := h.handleFault(context.Background(), diagnostic9005Fault(), s.ID)
	calls := 0
	for request != nil && err == nil {
		gpv := request.(*GetParameterValues)
		calls++
		if calls > diagnostic9005MaxCalls {
			t.Fatal("request budget exceeded")
		}
		if len(gpv.ParameterNames) == 1 {
			confirmed[gpv.ParameterNames[0]] = true
		}
		request, err = h.handleFault(context.Background(), diagnostic9005Fault(), s.ID)
	}
	if err != nil || calls != diagnostic9005MaxCalls {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	unresolved := 0
	for _, fault := range *faults {
		if strings.Contains(fault.FaultString, "isolated by diagnostic mode") {
			if !confirmed[fault.ParameterName] {
				t.Fatalf("accused an unconfirmed parameter: %s", fault.ParameterName)
			}
			delete(confirmed, fault.ParameterName)
		} else if strings.Contains(fault.FaultString, "request limit reached") {
			unresolved += len(strings.Split(fault.ParameterName, ", "))
		}
	}
	if len(confirmed) != 0 || unresolved == 0 || unresolved+len(*faults)-1 != 512 || len(h.diagnosticSlots) != 0 {
		t.Fatalf("missing confirmed=%d unresolved=%d slots=%d", len(confirmed), unresolved, len(h.diagnosticSlots))
	}
}

func Test9005DiagnosticReleasesSlotOnPersistenceError(t *testing.T) {
	failure := errors.New("database unavailable")
	h, _ := diagnostic9005TestHandler(t, []string{diagnostic9005Tag}, failure)
	s := h.sessions.GetOrCreate("persist-error", "TEST")
	s.DeviceID = 1
	s.LastSentParameters = []string{"Device.Test.A", "Device.Test.B"}
	if _, started, err := h.start9005Diagnostic(context.Background(), s); err != nil || !started {
		t.Fatalf("start=%v err=%v", started, err)
	}
	cancel := s.Diagnostic9005Cancel
	if _, err := h.finish9005Diagnostic(context.Background(), s); !errors.Is(err, failure) {
		t.Fatal("expected persistence error")
	}
	if s.Diagnostic9005Active || len(h.diagnosticSlots) != 0 {
		t.Fatal("persistence failure leaked a diagnostic slot")
	}
	// Simulate the old session's timeout callback after a different run acquired a slot.
	if !h.acquire9005DiagnosticSlot() {
		t.Fatal("could not acquire replacement slot")
	}
	cancel()
	if len(h.diagnosticSlots) != 1 {
		t.Fatal("old timeout released another diagnostic's slot")
	}
	h.release9005DiagnosticSlot()
}
