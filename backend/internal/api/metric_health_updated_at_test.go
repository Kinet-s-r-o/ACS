package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
)

func TestMetricHealthUpdatedAtPostgres(t *testing.T) {
	db := accountTransferTestDatabase(t)
	// Build the legacy table without indexes, then exercise the new column migration.
	statement := &gorm.Statement{DB: db}
	if err := statement.Parse(&models.MetricDefinition{}); err != nil {
		t.Fatal(err)
	}
	var columns []string
	for _, field := range statement.Schema.Fields {
		if field.DBName != "" && field.DBName != "health_show_updated_at" {
			columns = append(columns, fmt.Sprintf("%q %s", field.DBName, db.Migrator().FullDataTypeOf(field).SQL))
		}
	}
	for _, sql := range []string{
		`CREATE TABLE provisioning_templates (id bigint, name text, manufacturer text, product_class text)`,
		`INSERT INTO provisioning_templates VALUES (1, 'Fixture', 'Test', 'Fixture')`,
		"CREATE TABLE metric_definitions (" + strings.Join(columns, ", ") + ")",
		`INSERT INTO metric_definitions (name, parameter_name) VALUES ('Existing', 'Device.Existing')`,
	} {
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Migrator().AddColumn(&models.MetricDefinition{}, "HealthShowUpdatedAt"); err != nil {
		t.Fatal(err)
	}
	var existing models.MetricDefinition
	if err := db.First(&existing).Error; err != nil || existing.HealthShowUpdatedAt {
		t.Fatalf("existing metric did not default to hidden timestamp: %v", err)
	}
	r := &Router{db: db, metricRepo: database.NewMetricRepository(db)}
	mux := newPermissionMux()
	mux.HandleFunc("POST /provisioning/templates/{id}/metrics", r.handleSaveTemplateMetric)
	mux.HandleFunc("PUT /provisioning/templates/{id}/metrics/{metricID}", r.handleSaveTemplateMetric)
	mux.HandleFunc("GET /provisioning/templates/{id}/metrics", r.handleTemplateMetricDefinitions)
	grants := []string{"access.settings.provisioning.read", "access.settings.provisioning.write"}
	id := int64(0)
	for _, enabled := range []bool{true, false, true} {
		body := fmt.Sprintf(`{"name":"Temperature","parameter_name":"Device.Temperature","health":true,"health_show_updated_at":%t}`, enabled)
		method, path, status := http.MethodPost, "/provisioning/templates/1/metrics", http.StatusCreated
		if id != 0 {
			method, path, status = http.MethodPut, fmt.Sprintf("%s/%d", path, id), http.StatusOK
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, scopedRequest(method, path, grants, body))
		if response.Code != status {
			t.Fatalf("save metric: %d: %s", response.Code, response.Body.String())
		}
		var saved models.MetricDefinition
		if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		id = saved.ID
		response = httptest.NewRecorder()
		mux.ServeHTTP(response, scopedRequest(http.MethodGet, "/provisioning/templates/1/metrics", grants[:1], ""))
		var definitions []models.MetricDefinition
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &definitions) != nil || len(definitions) != 1 || definitions[0].HealthShowUpdatedAt != enabled {
			t.Fatalf("timestamp setting did not persist as %t: %s", enabled, response.Body.String())
		}
	}
}
