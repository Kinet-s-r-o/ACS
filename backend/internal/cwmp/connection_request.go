package cwmp

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"github.com/matrix8412/acs/internal/netutil"
)

type ConnectionRequestResult struct {
	Status  string `json:"status"`
	URL     string `json:"url"`
	Message string `json:"message"`
}

type ConnectionRequestError struct {
	StatusCode int
	Message    string
}

func (e *ConnectionRequestError) Error() string { return e.Message }

func SendConnectionRequest(ctx context.Context, device *models.Device, settingsRepo *database.SettingsRepository) (ConnectionRequestResult, error) {
	if device.ConnectionRequestURL == nil || *device.ConnectionRequestURL == "" {
		return ConnectionRequestResult{}, &ConnectionRequestError{StatusCode: http.StatusBadRequest, Message: "Device has no connection request URL"}
	}
	connReqURL := *device.ConnectionRequestURL
	settings, err := settingsRepo.GetAll(ctx)
	if err != nil {
		return ConnectionRequestResult{}, &ConnectionRequestError{StatusCode: http.StatusInternalServerError, Message: "Failed to load connection request settings"}
	}
	globalUsername, globalPassword, useAuto := "", "", false
	for _, setting := range settings {
		switch setting.Key {
		case "connection_request_username":
			globalUsername = setting.Value
		case "connection_request_password":
			globalPassword = setting.Value
		case "use_auto_conn_credentials":
			useAuto = setting.Value == "true"
		}
	}
	perDeviceMode, perDeviceUsername, perDevicePassword := "", "", ""
	if device.ConnCredMode != nil {
		perDeviceMode = *device.ConnCredMode
	}
	if device.ConnCredUsername != nil {
		perDeviceUsername = *device.ConnCredUsername
	}
	if device.ConnCredPassword != nil && *device.ConnCredPassword != "" {
		perDevicePassword, err = database.DecryptValue(*device.ConnCredPassword)
		if err != nil {
			return ConnectionRequestResult{}, &ConnectionRequestError{StatusCode: http.StatusInternalServerError, Message: "Failed to decrypt device credentials"}
		}
	}
	username, password, err := netutil.ResolveConnCredentials(device.SerialNumber, perDeviceMode, perDeviceUsername, perDevicePassword, globalUsername, globalPassword, useAuto)
	if err != nil {
		return ConnectionRequestResult{}, &ConnectionRequestError{StatusCode: http.StatusBadRequest, Message: err.Error()}
	}
	client, err := netutil.NewDeviceHTTPClient(connReqURL, username, password, 10*time.Second)
	if err != nil {
		return ConnectionRequestResult{}, &ConnectionRequestError{StatusCode: http.StatusBadRequest, Message: "Unsafe connection request URL: " + err.Error()}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, connReqURL, nil)
	if err != nil {
		return ConnectionRequestResult{}, &ConnectionRequestError{StatusCode: http.StatusInternalServerError, Message: "Failed to create connection request"}
	}
	response, err := client.Do(request)
	if err != nil {
		return ConnectionRequestResult{Status: "failed", URL: connReqURL, Message: "Device unreachable: " + err.Error()}, nil
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return ConnectionRequestResult{Status: "success", URL: connReqURL, Message: "Device will send Inform in a few seconds"}, nil
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return ConnectionRequestResult{Status: "auth_failed", URL: connReqURL, Message: "Connection request credentials were rejected by the device"}, nil
	default:
		return ConnectionRequestResult{Status: "unknown", URL: connReqURL, Message: fmt.Sprintf("Device responded with status %s", response.Status)}, nil
	}
}
