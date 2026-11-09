package cwmp

import (
	"context"
	"fmt"

	"github.com/matrix8412/acs/internal/models"
)

type bootstrapRebootState struct {
	Enabled bool
	Failed  bool
	Applied bool
	Queued  bool
	RuleIDs map[int64]bool
}

func bootstrapRebootForInform(inform *Inform, template *models.ProvisioningTemplate) bootstrapRebootState {
	return bootstrapRebootState{
		Enabled: hasEvent(inform, EventBootstrap) && template != nil && template.RebootAfterBootstrap,
		RuleIDs: make(map[int64]bool),
	}
}

func (s *Session) confirmBootstrapProvisioning() {
	for _, application := range s.ProvisioningRules {
		if s.BootstrapReboot.RuleIDs[application.RuleID] {
			s.BootstrapReboot.Applied = true
		}
	}
}

func (s *Session) bootstrapRebootReady() bool {
	state := s.BootstrapReboot
	return state.Enabled && !state.Failed && state.Applied && !state.Queued &&
		s.CurrentTaskID == 0 && !s.AutomaticFactoryResetActive && !s.AutoFactoryResetSessionFinished &&
		s.Provisioning == nil && len(s.ProvisioningRules) == 0 && len(s.PendingSetParameters) == 0 &&
		len(s.AddObjectQueue) == 0 && !s.ConditionalFetchActive &&
		len(s.PendingConditionalRules) == 0 && len(s.ConditionalExistsPaths) == 0 && s.ConditionalExistsCurrent == ""
}

func (h *Handler) queueBootstrapReboot(ctx context.Context, session *Session) error {
	if !session.bootstrapRebootReady() {
		return nil
	}
	task, err := models.NewTaskWithPayload(session.DeviceID, models.TaskTypeReboot, nil)
	if err != nil {
		return err
	}
	task.CreatedBy = "bootstrap provisioning"
	if err := h.taskRepo.Create(ctx, task); err != nil {
		return fmt.Errorf("queue reboot after bootstrap: %w", err)
	}
	session.BootstrapReboot.Queued = true
	logCWMPSession(session.SerialNumber, session.ID, "Queued reboot after successful bootstrap (task %d)", task.ID)
	return nil
}
