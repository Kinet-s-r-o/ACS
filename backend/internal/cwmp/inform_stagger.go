package cwmp

import (
	"crypto/sha256"
	"encoding/binary"
	"strconv"
	"strings"
	"time"

	"github.com/matrix8412/acs/internal/models"
)

const (
	periodicInformIntervalSuffix = "ManagementServer.PeriodicInformInterval"
	periodicInformTimeSuffix     = "ManagementServer.PeriodicInformTime"
)

type informStaggerPlan struct {
	ParameterName string
	Value         string
	Interval      int64
}

// planInformStagger assigns a deterministic phase to a CPE without changing
// its configured interval. The Unix-time anchor keeps the phase stable across
// ACS restarts and distributes devices with the same interval evenly.
func planInformStagger(inform *Inform, cached []models.DeviceParameter, now time.Time) (informStaggerPlan, bool) {
	values := make(map[string]string, len(cached)+len(inform.ParameterList.Parameters))
	for _, parameter := range cached {
		values[parameter.Name] = parameter.Value
	}
	for _, parameter := range inform.ParameterList.Parameters {
		values[parameter.Name] = parameter.Value
	}

	var intervalName, intervalValue string
	for _, root := range []string{"InternetGatewayDevice.", "Device."} {
		name := root + periodicInformIntervalSuffix
		if value := strings.TrimSpace(values[name]); value != "" {
			intervalName, intervalValue = name, value
			break
		}
	}
	if intervalName == "" {
		return informStaggerPlan{}, false
	}
	interval, err := strconv.ParseInt(intervalValue, 10, 64)
	if err != nil || interval <= 0 {
		return informStaggerPlan{}, false
	}

	root := strings.TrimSuffix(intervalName, periodicInformIntervalSuffix)
	phaseHash := sha256.Sum256([]byte(inform.DeviceId.OUI + "\x00" + inform.DeviceId.SerialNumber))
	phase := int64(binary.BigEndian.Uint64(phaseHash[:8]) % uint64(interval))
	anchor := now.UTC().Unix() / interval * interval
	next := time.Unix(anchor+phase, 0).UTC()
	if !next.After(now.UTC()) {
		next = next.Add(time.Duration(interval) * time.Second)
	}

	return informStaggerPlan{
		ParameterName: root + periodicInformTimeSuffix,
		Value:         next.Format(time.RFC3339),
		Interval:      interval,
	}, true
}
