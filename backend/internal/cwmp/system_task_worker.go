package cwmp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/cwmpcontrol"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

const systemSummonTimeout = 120 * time.Second

type SystemTaskWorker struct {
	communication  *cwmpcontrol.Controller
	deviceRepo     *database.DeviceRepository
	parameterRepo  *database.ParameterRepository
	taskRepo       *database.TaskRepository
	systemTaskRepo *database.SystemTaskRepository
	settingsRepo   *database.SettingsRepository
}

func NewSystemTaskWorker(db *gorm.DB, controls ...*cwmpcontrol.Controller) *SystemTaskWorker {
	return &SystemTaskWorker{
		communication:  communicationControl(controls),
		deviceRepo:     database.NewDeviceRepository(db),
		parameterRepo:  database.NewParameterRepository(db),
		taskRepo:       database.NewTaskRepository(db),
		systemTaskRepo: database.NewSystemTaskRepository(db),
		settingsRepo:   database.NewSettingsRepository(db),
	}
}

func (w *SystemTaskWorker) Start(ctx context.Context) {
	if err := w.systemTaskRepo.RecoverProcessing(ctx); err != nil {
		log.Printf("System task recovery failed: %v", err)
	}
	if err := w.reconcile(ctx); err != nil {
		log.Printf("System task reconciliation failed: %v", err)
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !w.communication.Enabled() {
				continue
			}
			if err := w.reconcile(ctx); err != nil {
				log.Printf("System task reconciliation failed: %v", err)
			}
			w.dispatchSingle(ctx)
			w.dispatchBulk(ctx, models.SystemTaskTypeBulkSummon)
			w.dispatchBulk(ctx, models.SystemTaskTypeBulkRestart)
		}
	}
}

func (w *SystemTaskWorker) dispatchSingle(ctx context.Context) {
	if !w.communication.Enabled() {
		return
	}
	active, err := w.systemTaskRepo.CountActive(ctx, models.SystemTaskTypeSummonFromCPE)
	if err != nil || active > 0 {
		if err != nil {
			log.Printf("System summon queue count failed: %v", err)
		}
		return
	}
	w.dispatchOne(ctx, models.SystemTaskTypeSummonFromCPE)
}

func (w *SystemTaskWorker) dispatchBulk(ctx context.Context, taskType models.SystemTaskType) {
	if !w.communication.Enabled() {
		return
	}
	var maxInFlight, intervalSeconds int
	var err error
	if taskType == models.SystemTaskTypeBulkRestart {
		var settings database.BulkRestartSettings
		settings, err = w.settingsRepo.GetBulkRestartSettings(ctx)
		maxInFlight, intervalSeconds = settings.MaxInFlight, settings.IntervalSeconds
	} else {
		var settings database.BulkSummonSettings
		settings, err = w.settingsRepo.GetBulkSummonSettings(ctx)
		maxInFlight, intervalSeconds = settings.MaxInFlight, settings.IntervalSeconds
	}
	if err != nil {
		log.Printf("%s settings unavailable: %v", taskType, err)
		return
	}
	active, err := w.systemTaskRepo.CountActive(ctx, taskType)
	if err != nil || active >= int64(maxInFlight) {
		if err != nil {
			log.Printf("%s queue count failed: %v", taskType, err)
		}
		return
	}
	lastStarted, err := w.systemTaskRepo.LastStartedAt(ctx, taskType)
	if err != nil {
		log.Printf("%s dispatch time unavailable: %v", taskType, err)
		return
	}
	if lastStarted != nil && time.Since(*lastStarted) < time.Duration(intervalSeconds)*time.Second {
		return
	}
	w.dispatchOne(ctx, taskType)
}

func (w *SystemTaskWorker) dispatchOne(ctx context.Context, taskType models.SystemTaskType) {
	if !w.communication.Enabled() {
		return
	}
	task, err := w.systemTaskRepo.ClaimNext(ctx, taskType)
	if err != nil {
		log.Printf("Could not claim %s system task: %v", taskType, err)
		return
	}
	if task == nil {
		return
	}
	go w.process(ctx, task)
}

func (w *SystemTaskWorker) process(ctx context.Context, systemTask *models.SystemTask) {
	if !w.communication.Enabled() {
		_ = w.systemTaskRepo.RequeuePaused(ctx, systemTask.ID)
		return
	}
	device, err := w.deviceRepo.GetByID(ctx, systemTask.DeviceID)
	if err != nil || device == nil {
		message := "CPE no longer exists"
		if err != nil {
			message = "Could not load CPE: " + err.Error()
		}
		_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, message)
		return
	}
	if systemTask.SnapshotKind != "" && !device.Online {
		message := database.ErrSnapshotDeviceOffline.Error()
		if systemTask.CWMPTaskID != nil {
			_, _ = w.taskRepo.FailPending(ctx, *systemTask.CWMPTaskID, message)
		}
		_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, message)
		return
	}
	if device.ConnectionRequestURL == nil || strings.TrimSpace(*device.ConnectionRequestURL) == "" {
		_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "CPE has no connection request URL")
		return
	}

	var cwmpTaskID *int64
	if systemTask.CWMPTaskID != nil {
		cwmpTaskID = systemTask.CWMPTaskID
	} else if systemTask.Type == models.SystemTaskTypeBulkRestart {
		cwmpTask, err := models.NewTaskWithPayload(device.ID, models.TaskTypeReboot, nil)
		if err != nil {
			_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Could not create CWMP restart task: "+err.Error())
			return
		}
		cwmpTask.CreatedBy = systemTask.CreatedBy
		if err := w.taskRepo.CreateForSystemTask(ctx, systemTask.ID, cwmpTask); err != nil {
			_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Could not store CWMP restart task: "+err.Error())
			return
		}
		cwmpTaskID = &cwmpTask.ID
	} else if systemTask.RefreshParameters {
		deviceModelRoot := "InternetGatewayDevice."
		deviceRootParams, err := w.parameterRepo.GetByDeviceIDMatching(ctx, device.ID, []string{"Device."}, nil)
		if err != nil {
			_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Could not inspect stored CPE parameter model: "+err.Error())
			return
		}
		if len(deviceRootParams) > 0 {
			deviceModelRoot = "Device."
		}
		cwmpTask, err := models.NewTaskWithPayload(device.ID, models.TaskTypeGetParameterValues, []string{deviceModelRoot})
		if err != nil {
			_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Could not create CWMP refresh task: "+err.Error())
			return
		}
		cwmpTask.CreatedBy = systemTask.CreatedBy
		if err := w.taskRepo.CreateForSystemTask(ctx, systemTask.ID, cwmpTask); err != nil {
			_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Could not store CWMP refresh task: "+err.Error())
			return
		}
		cwmpTaskID = &cwmpTask.ID
	}

	result, err := SendConnectionRequest(ctx, device, w.settingsRepo, w.communication)
	if err != nil {
		if errors.Is(err, cwmpcontrol.ErrPaused) {
			_ = w.systemTaskRepo.RequeuePaused(ctx, systemTask.ID)
			return
		}
		if cwmpTaskID != nil {
			_, _ = w.taskRepo.FailPending(ctx, *cwmpTaskID, err.Error())
		}
		_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, err.Error())
		return
	}
	if result.Status != "success" {
		if cwmpTaskID != nil {
			_, _ = w.taskRepo.FailPending(ctx, *cwmpTaskID, result.Message)
		}
		_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, result.Message)
		return
	}
	if err := w.systemTaskRepo.MarkWaiting(ctx, systemTask.ID, cwmpTaskID, device.LastInform); err != nil {
		log.Printf("Could not mark system task %d as waiting: %v", systemTask.ID, err)
		return
	}
	log.Printf("System task %d sent a connection request to CPE %s", systemTask.ID, device.SerialNumber)
}

func (w *SystemTaskWorker) reconcile(ctx context.Context) error {
	if !w.communication.Enabled() {
		return nil
	}
	bulkSummonSettings, bulkSummonSettingsErr := w.settingsRepo.GetBulkSummonSettings(ctx)
	bulkRestartSettings, bulkRestartSettingsErr := w.settingsRepo.GetBulkRestartSettings(ctx)
	for _, taskType := range []models.SystemTaskType{models.SystemTaskTypeSummonFromCPE, models.SystemTaskTypeBulkSummon, models.SystemTaskTypeBulkRestart} {
		tasks, err := w.systemTaskRepo.Active(ctx, taskType)
		if err != nil {
			return err
		}
		for _, systemTask := range tasks {
			if !w.communication.Enabled() {
				return nil
			}
			if systemTask.Status != models.SystemTaskStatusWaiting {
				continue
			}
			if systemTask.CWMPTaskID == nil {
				device, err := w.deviceRepo.GetByID(ctx, systemTask.DeviceID)
				if err != nil {
					return err
				}
				if device != nil && device.LastInform != nil && (systemTask.LastInformBefore == nil || device.LastInform.After(*systemTask.LastInformBefore)) {
					if err := w.systemTaskRepo.MarkCompleted(ctx, systemTask.ID); err != nil {
						return err
					}
					continue
				}
				if systemTaskTimedOut(systemTask, systemSummonTimeout) {
					if err := w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "CPE did not send an Inform within 120 seconds"); err != nil {
						return err
					}
				}
				continue
			}
			status, message, err := w.taskRepo.GetStatusAndError(ctx, *systemTask.CWMPTaskID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				_ = w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Linked CWMP task no longer exists")
				continue
			}
			if err != nil {
				return err
			}
			switch status {
			case models.TaskStatusCompleted:
				if systemTask.SnapshotKind != "" && strings.TrimSpace(message) != "" {
					if err := w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, "Snapshot requires a complete parameter refresh: "+message); err != nil {
						return err
					}
					continue
				}
				if err := w.systemTaskRepo.MarkCompleted(ctx, systemTask.ID, message); err != nil {
					if errors.Is(err, database.ErrNoWritableSnapshotParameters) || errors.Is(err, database.ErrSnapshotDeviceOffline) {
						if failErr := w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, err.Error()); failErr != nil {
							return failErr
						}
						continue
					}
					return err
				}
			case models.TaskStatusFailed, models.TaskStatusDeleted:
				if strings.TrimSpace(message) == "" {
					message = fmt.Sprintf("CWMP task %s", status)
				}
				if err := w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, message); err != nil {
					return err
				}
			case models.TaskStatusPending, models.TaskStatusSent:
				if status == models.TaskStatusPending {
					timeout := systemSummonTimeout
					if taskType == models.SystemTaskTypeBulkSummon || taskType == models.SystemTaskTypeBulkRestart {
						if taskType == models.SystemTaskTypeBulkSummon {
							if bulkSummonSettingsErr != nil {
								continue
							}
							timeout = time.Duration(bulkSummonSettings.ContactTimeoutSeconds) * time.Second
						} else {
							if bulkRestartSettingsErr != nil {
								continue
							}
							timeout = time.Duration(bulkRestartSettings.ContactTimeoutSeconds) * time.Second
						}
					}
					if !systemTaskTimedOut(systemTask, timeout) {
						continue
					}
					message = fmt.Sprintf("CPE did not send an Inform within %d seconds", int(timeout/time.Second))
					failedPending, err := w.taskRepo.FailPending(ctx, *systemTask.CWMPTaskID, message)
					if err != nil {
						return err
					}
					if !failedPending {
						continue
					}
				} else {
					if !systemTaskTimedOut(systemTask, systemSummonTimeout) {
						continue
					}
					message = "CPE did not complete the CWMP task within 120 seconds"
				}
				if err := w.systemTaskRepo.MarkFailed(ctx, systemTask.ID, message); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func systemTaskTimedOut(task models.SystemTask, timeout time.Duration) bool {
	started := task.DispatchedAt
	if started == nil {
		started = task.StartedAt
	}
	return started != nil && time.Since(*started) >= timeout
}
