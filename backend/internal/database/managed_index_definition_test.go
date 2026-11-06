package database

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/matrix8412/acs/internal/models"
)

func customTestIndexSpec() IndexSpec {
	return IndexSpec{Label: "Custom freshness", Purpose: "Find newest parameter updates", Recipe: "custom", ParameterPath: "Device.DeviceInfo.UpTime",
		Definition: &models.DatabaseIndexDefinition{TableName: "device_parameters",
			Columns:        []models.DatabaseIndexColumn{{Name: "updated_at", Direction: "DESC", Nulls: "LAST"}, {Name: "device_id", Direction: "ASC"}},
			IncludeColumns: []string{"writable"}}}
}

func TestManagedIndexCustomDefinition(t *testing.T) {
	spec := customTestIndexSpec()
	name := "acs_ui_idx_0123456789abcdef0123456789abcdef"
	ddl, err := indexDDL("app", name, spec)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, `ON "app"."device_parameters" USING btree (updated_at DESC NULLS LAST, device_id) INCLUDE (writable)`) || !strings.HasSuffix(ddl, " WHERE name = 'Device.DeviceInfo.UpTime'") {
		t.Fatalf("unexpected DDL: %s", ddl)
	}
	query := indexPlanQuery("app", spec)
	if strings.Contains(query, "ANALYZE") || strings.Contains(query, " LIMIT ") || !strings.Contains(query, "WHERE name='Device.DeviceInfo.UpTime' ORDER BY updated_at DESC NULLS LAST, device_id") {
		t.Fatalf("unsafe or incomplete estimate: %s", query)
	}
	m := models.ManagedDatabaseIndex{Label: spec.Label, Purpose: spec.Purpose, Recipe: spec.Recipe, ParameterPath: spec.ParameterPath, Definition: spec.Definition, CandidateName: name}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var restored models.ManagedDatabaseIndex
	if err := json.Unmarshal(raw, &restored); err != nil || !sameIndexDefinition(spec, storedIndexSpec(restored)) {
		t.Fatalf("definition lost in round trip: %v", err)
	}
	// Candidate identity is private API metadata, persisted separately by GORM.
	restored.CandidateName = name
	c := IndexCatalogEntry{OID: 42, Name: name, TableName: "device_parameters", Method: "btree", DefaultStorage: true,
		Definition: "CREATE INDEX " + name + " ON app.device_parameters USING btree (updated_at DESC NULLS LAST, device_id) INCLUDE (writable) WITH (fillfactor='90') WHERE (name = 'Device.DeviceInfo.UpTime'::text)"}
	if !candidateMatches(c, restored) {
		t.Fatal("custom candidate cannot be recovered")
	}
	c.Definition = strings.Replace(c.Definition, "INCLUDE (writable)", "INCLUDE (value)", 1)
	if candidateMatches(c, restored) {
		t.Fatal("altered candidate adopted")
	}
	if ManagedIndexMaxBytes != 1<<30 || ManagedIndexTotalBytes != 5<<30 {
		t.Fatal("unexpected storage budgets")
	}
}

func TestManagedIndexCustomPolicy(t *testing.T) {
	for _, mutate := range []func(*IndexSpec){
		func(s *IndexSpec) { s.Definition = nil },
		func(s *IndexSpec) { s.Recipe = "parameter_freshness" },
		func(s *IndexSpec) { s.Definition.TableName = "users" },
		func(s *IndexSpec) { s.Definition.TableName = "devices" },
		func(s *IndexSpec) { s.Definition.Columns = nil },
		func(s *IndexSpec) { s.Definition.Columns[0].Name = "value" },
		func(s *IndexSpec) { s.Definition.Columns[0].Name = "updated_at); DROP TABLE devices;--" },
		func(s *IndexSpec) { s.Definition.Columns[0].Direction = "DESC; SELECT 1" },
		func(s *IndexSpec) { s.Definition.Columns[0].Nulls = "LAST; SELECT 1" },
		func(s *IndexSpec) { s.Definition.Columns[1].Name = "updated_at" },
		func(s *IndexSpec) { s.Definition.IncludeColumns = []string{"value"} },
		func(s *IndexSpec) { s.Definition.IncludeColumns = []string{"device_id"} },
		func(s *IndexSpec) { s.Definition.IncludeColumns = []string{"name", "name"} },
		func(s *IndexSpec) {
			s.Definition.Columns = append(s.Definition.Columns, s.Definition.Columns[0], s.Definition.Columns[0], s.Definition.Columns[0])
		},
		func(s *IndexSpec) {
			s.Definition.IncludeColumns = []string{"id", "name", "writable", "device_id", "updated_at"}
		},
		func(s *IndexSpec) { s.ParameterPath = "Device.Test.Password" },
		func(s *IndexSpec) { s.ParameterPath = "Device.Test.*" },
	} {
		spec := customTestIndexSpec()
		mutate(&spec)
		if !errors.Is(ValidateIndexSpec(spec), ErrIndexPolicy) {
			t.Fatalf("unsafe custom definition accepted: %+v", spec)
		}
	}
	for _, table := range indexTables {
		for _, column := range table.Columns {
			spec := IndexSpec{Label: "Custom index", Purpose: "Test supported key fields", Recipe: "custom", Definition: &models.DatabaseIndexDefinition{TableName: table.Name, Columns: []models.DatabaseIndexColumn{{Name: column}}}}
			if err := ValidateIndexSpec(spec); err != nil {
				t.Fatalf("supported field rejected: %s.%s: %v", table.Name, column, err)
			}
		}
	}
}

func TestManagedIndexCustomEquivalentAndEstimate(t *testing.T) {
	spec := customTestIndexSpec()
	spec.Definition.Columns[0].Nulls = "FIRST" // Default for DESC.
	spec.Definition.IncludeColumns = nil
	preset := testIndexSpec()
	preset.Recipe = "parameter_freshness"
	preset.ParameterPath = spec.ParameterPath
	if !sameIndexDefinition(spec, preset) {
		t.Fatal("custom equivalent can bypass preset duplicate detection")
	}
	spec.Definition.IncludeColumns = []string{"name"}
	_, narrow, err := estimateIndexStorage(spec, 100_000, 10_000, 32)
	if err != nil {
		t.Fatal(err)
	}
	_, wide, err := estimateIndexStorage(spec, 100_000, 10_000, 512)
	if err != nil || wide <= narrow {
		t.Fatal("custom INCLUDE name width was ignored")
	}
}
