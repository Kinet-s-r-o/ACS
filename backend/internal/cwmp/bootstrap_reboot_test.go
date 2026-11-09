package cwmp

import (
	"context"
	"errors"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestBootstrapRebootRequiresOptInAndBootstrapEvent(t *testing.T) {
	for _, tc := range []struct {
		name     string
		event    string
		template *models.ProvisioningTemplate
		want     bool
	}{
		{"existing template", EventBootstrap, &models.ProvisioningTemplate{}, false},
		{"no template", EventBootstrap, nil, false},
		{"opted in", EventBootstrap, &models.ProvisioningTemplate{RebootAfterBootstrap: true}, true},
		{"ordinary boot", "1 BOOT", &models.ProvisioningTemplate{RebootAfterBootstrap: true}, false},
		{"periodic inform", "2 PERIODIC", &models.ProvisioningTemplate{RebootAfterBootstrap: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inform := &Inform{Event: EventList{Events: []EventStruct{{EventCode: tc.event}}}}
			if got := bootstrapRebootForInform(inform, tc.template); got.Enabled != tc.want {
				t.Fatalf("enabled=%v, want %v", got.Enabled, tc.want)
			}
		})
	}
}

func bootstrapRebootSession(h *Handler) *Session {
	s := h.sessions.GetOrCreate("bootstrap-reboot", "BOOTSTRAP-TEST")
	s.DeviceID = 1
	s.State = StateProcessingTasks
	s.BootstrapReboot = bootstrapRebootState{Enabled: true, RuleIDs: map[int64]bool{10: true, 11: true}}
	s.ProvisioningRules = []models.ProvisioningApplication{{RuleID: 10, RuleVersion: 1}}
	s.PendingSetParameters = []ParameterValueStruct{{Name: "Device.Test.Mode", Value: "new", Type: "string"}}
	return s
}

func TestBootstrapRebootWaitsForConfirmedParametersIncludingDeferredStatus(t *testing.T) {
	for _, status := range []int{0, 1, 2} {
		h := NewHandler(nil)
		s := bootstrapRebootSession(h)
		if s.bootstrapRebootReady() {
			t.Fatal("reboot ready before SetParameterValuesResponse")
		}
		if _, err := h.handleSetParameterValuesResponse(context.Background(), &SetParameterValuesResp{Status: status}, s.ID); err != nil {
			t.Fatal(err)
		}
		if s.bootstrapRebootReady() != (status == 0 || status == 1) {
			t.Fatalf("status=%d: unexpected reboot readiness", status)
		}
	}
}

func TestBootstrapRebootWaitsForConditionalWrites(t *testing.T) {
	h := NewHandler(nil)
	s := bootstrapRebootSession(h)
	cond, err := ParseCondition(`Device.Test.Ready == 'yes'`)
	if err != nil {
		t.Fatal(err)
	}
	s.PendingConditionalConds = []*Condition{cond}
	s.PendingConditionalRules = []models.ProvisioningApplication{{RuleID: 11, RuleVersion: 1}}
	s.PendingConditionalData = []*models.ProvisioningRule{{ID: 11, ParameterName: "Device.Test.Second", ParameterValue: "new", ParameterType: "string"}}
	s.ConditionalFetchActive = true
	if _, err := h.handleSetParameterValuesResponse(context.Background(), &SetParameterValuesResp{Status: 0}, s.ID); err != nil {
		t.Fatal(err)
	}
	if s.bootstrapRebootReady() {
		t.Fatal("reboot ready before conditional phase")
	}
	h.evaluateConditionalRules(s, map[string]string{"Device.Test.Ready": "yes"})
	if s.bootstrapRebootReady() {
		t.Fatal("reboot ready before conditional write response")
	}
	request, _, err := h.handleEmptyPost(context.Background(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := request.(*SetParameterValues); !ok {
		t.Fatalf("expected conditional SPV, got %T", request)
	}
	if _, err := h.handleSetParameterValuesResponse(context.Background(), &SetParameterValuesResp{Status: 1}, s.ID); err != nil {
		t.Fatal(err)
	}
	if !s.bootstrapRebootReady() {
		t.Fatal("reboot not ready after both write responses")
	}
}

func TestBootstrapRebootRequiresAnAppliedBootstrapRule(t *testing.T) {
	h := NewHandler(nil)
	s := bootstrapRebootSession(h)
	s.ProvisioningRules[0].RuleID = 99 // Only a default-phase rule was applied.
	if _, err := h.handleSetParameterValuesResponse(context.Background(), &SetParameterValuesResp{Status: 0}, s.ID); err != nil {
		t.Fatal(err)
	}
	if s.bootstrapRebootReady() {
		t.Fatal("default-only writes must not trigger bootstrap reboot")
	}
}

func TestBootstrapRebootWaitsForEveryProvisioningStage(t *testing.T) {
	for name, pending := range map[string]func(*Session){
		"write":                   func(s *Session) { s.Provisioning = &SetParameterValues{} },
		"unconfirmed write":       func(s *Session) { s.PendingSetParameters = []ParameterValueStruct{{Name: "Device.Test"}} },
		"unrecorded application":  func(s *Session) { s.ProvisioningRules = []models.ProvisioningApplication{{RuleID: 10}} },
		"object creation":         func(s *Session) { s.AddObjectQueue = []*AddObject{{ObjectName: "Device.Test."}} },
		"conditional phase":       func(s *Session) { s.ConditionalFetchActive = true },
		"pending condition":       func(s *Session) { s.PendingConditionalRules = []models.ProvisioningApplication{{RuleID: 11}} },
		"pending existence probe": func(s *Session) { s.ConditionalExistsPaths = []string{"Device.Test."} },
		"active existence probe":  func(s *Session) { s.ConditionalExistsCurrent = "Device.Test." },
		"active task":             func(s *Session) { s.CurrentTaskID = 42 },
		"factory reset":           func(s *Session) { s.AutoFactoryResetSessionFinished = true },
	} {
		t.Run(name, func(t *testing.T) {
			s := &Session{BootstrapReboot: bootstrapRebootState{Enabled: true, Applied: true}}
			pending(s)
			if s.bootstrapRebootReady() {
				t.Fatal("reboot ready while provisioning is unfinished")
			}
		})
	}
}

func TestBootstrapRebootFalseConditionDoesNotPreventConfirmedBootstrap(t *testing.T) {
	h := NewHandler(nil)
	s := prepareExistsSession(t, h, `exists('Device.Test.')`, false)
	s.BootstrapReboot = bootstrapRebootState{Enabled: true, Applied: true}
	s.ConditionalExistsPaths = nil
	s.ConditionalExistsResults[conditionExistsKey("Device.Test")] = "false"
	if _, _, err := h.handleEmptyPost(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	if !s.bootstrapRebootReady() {
		t.Fatal("a false condition blocked a previously successful bootstrap")
	}
}

func TestBootstrapRebootSuppressedAfterProvisioningFault(t *testing.T) {
	h := NewHandler(nil)
	s := bootstrapRebootSession(h)
	if _, err := h.handleFault(context.Background(), &SOAPFault{FaultCode: "9007", FaultString: "Invalid value"}, s.ID); err != nil {
		t.Fatal(err)
	}
	if !s.BootstrapReboot.Failed {
		t.Fatal("provisioning fault did not inhibit reboot")
	}
	s.ProvisioningRules = nil
	s.PendingSetParameters = nil
	s.BootstrapReboot.Applied = true
	if s.bootstrapRebootReady() {
		t.Fatal("a failed bootstrap became eligible again")
	}
}

func TestBootstrapRebootAfterAddObjectOnly(t *testing.T) {
	h := NewHandler(nil)
	s := bootstrapRebootSession(h)
	s.PendingSetParameters = nil
	s.AddObjectQueue = []*AddObject{{ObjectName: "Device.Test.Objects."}}
	request, err := h.handleAddObjectResponse(context.Background(), &AddObjectResponse{InstanceNumber: "2", Status: 1}, s.ID)
	if err != nil || request != nil || !s.bootstrapRebootReady() {
		t.Fatalf("AddObject-only bootstrap: request=%T ready=%v err=%v", request, s.bootstrapRebootReady(), err)
	}
}

func TestBootstrapRebootUnknownConditionInhibitsReboot(t *testing.T) {
	h := NewHandler(nil)
	s := prepareExistsSession(t, h, `exists('Device.Test.')`, false)
	s.BootstrapReboot = bootstrapRebootState{Enabled: true, Applied: true}
	if _, _, err := h.handleEmptyPost(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.handleFault(context.Background(), &SOAPFault{FaultCode: "9002"}, s.ID); err != nil {
		t.Fatal(err)
	}
	if !s.BootstrapReboot.Failed || s.bootstrapRebootReady() {
		t.Fatal("unknown condition allowed a reboot")
	}
}

func TestBootstrapRebootQueueIsRecordedOnceAndRetriesFailedPersistence(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=localhost user=test dbname=test"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, SkipDefaultTransaction: true})
	if err != nil {
		t.Fatal(err)
	}
	var queued []*models.Task
	fail := true
	if err := db.Callback().Create().Before("gorm:create").Register("test:bootstrap-reboot", func(tx *gorm.DB) {
		if fail {
			tx.AddError(errors.New("storage unavailable"))
			return
		}
		task := tx.Statement.Dest.(*models.Task)
		queued = append(queued, task)
	}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(nil)
	h.taskRepo = database.NewTaskRepository(db)
	s := &Session{DeviceID: 1, BootstrapReboot: bootstrapRebootState{Enabled: true, Applied: true}}
	if err := h.queueBootstrapReboot(context.Background(), s); err == nil || s.BootstrapReboot.Queued {
		t.Fatal("failed persistence marked the reboot queued")
	}
	fail = false
	for range 2 {
		if err := h.queueBootstrapReboot(context.Background(), s); err != nil {
			t.Fatal(err)
		}
	}
	if len(queued) != 1 || queued[0].Type != models.TaskTypeReboot || queued[0].CreatedBy != "bootstrap provisioning" || queued[0].Status != models.TaskStatusPending {
		t.Fatalf("unexpected reboot task history: %#v", queued)
	}
}
