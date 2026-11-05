package api

import (
	"net/http"
	"reflect"
	"strings"

	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/models"
)

func healthMetricField(name string) bool {
	return strings.HasPrefix(name, "health") || strings.HasPrefix(name, "gauge_") || name == "display_format" || name == "warn_threshold" || name == "critical_threshold" || name == "threshold_direction" || name == "thresholds"
}

func redactMetricTabs(req *http.Request, definition *models.MetricDefinition, prefix string) {
	if !auth.OperationAuthorized(req.Context()) {
		return
	}
	value := reflect.ValueOf(definition).Elem()
	typeOf := value.Type()
	for i := 0; i < value.NumField(); i++ {
		name := strings.Split(typeOf.Field(i).Tag.Get("json"), ",")[0]
		if name == "id" || name == "name" || name == "template_id" || name == "created_at" || name == "updated_at" {
			continue
		}
		tab := "metric"
		if healthMetricField(name) {
			tab = "health"
		}
		if !requestCan(req, prefix+"."+tab, "read") {
			value.Field(i).SetZero()
		}
	}
}

// A metric and its Health tab share a record; preserve fields outside the edited tab.
func mergeMetricPermissions(req *http.Request, body, previous *models.MetricDefinition, prefix string) {
	if !auth.OperationAuthorized(req.Context()) {
		return
	}
	if previous == nil {
		previous = &models.MetricDefinition{}
	}
	current, before := reflect.ValueOf(body).Elem(), reflect.ValueOf(previous).Elem()
	typeOf := current.Type()
	for i := 0; i < current.NumField(); i++ {
		name := strings.Split(typeOf.Field(i).Tag.Get("json"), ",")[0]
		if name == "id" || name == "template_id" || name == "created_at" || name == "updated_at" || name == "device_type_match" || name == "interface_type" || name == "parameter_pattern" {
			continue
		}
		tab := "metric"
		if healthMetricField(name) {
			tab = "health"
		}
		if !requestCan(req, prefix+"."+tab, "edit") {
			current.Field(i).Set(before.Field(i))
		}
	}
}
