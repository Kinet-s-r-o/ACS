package database

import (
	"fmt"
	"slices"
	"strings"

	"github.com/matrix8412/acs/internal/models"
)

type IndexTable struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
}

// Only non-secret query fields are exposed to the definition builder.
var indexTables = []IndexTable{
	{Name: "devices", Columns: []string{"id", "online", "last_inform", "last_bootstrap", "last_boot", "created_at", "updated_at"}},
	{Name: "device_parameters", Columns: []string{"id", "device_id", "name", "updated_at", "writable"}},
}

func resolveIndexRecipe(spec IndexSpec) (IndexRecipe, error) {
	if spec.Recipe != "custom" {
		if spec.Definition != nil {
			return IndexRecipe{}, fmt.Errorf("%w: structured definition requires the custom recipe", ErrIndexPolicy)
		}
		if recipe, ok := findIndexRecipe(spec.Recipe); ok {
			return recipe, nil
		}
		return IndexRecipe{}, fmt.Errorf("%w: choose a B-tree preset or a structured custom definition", ErrIndexPolicy)
	}
	d := spec.Definition
	if d == nil || len(d.Columns) < 1 || len(d.Columns) > 4 || len(d.IncludeColumns) > 4 {
		return IndexRecipe{}, fmt.Errorf("%w: custom indexes need 1–4 key columns and at most 4 INCLUDE columns", ErrIndexPolicy)
	}
	var allowed []string
	for _, table := range indexTables {
		if table.Name == d.TableName {
			allowed = table.Columns
		}
	}
	if allowed == nil || (spec.ParameterPath != "" && d.TableName != "device_parameters") {
		return IndexRecipe{}, fmt.Errorf("%w: choose a supported table; parameter filters require device_parameters", ErrIndexPolicy)
	}
	recipe := IndexRecipe{ID: "custom", TableName: d.TableName, RequiresParameterPath: spec.ParameterPath != "", IncludeColumns: d.IncludeColumns}
	seen := map[string]bool{}
	for _, column := range d.Columns {
		if !slices.Contains(allowed, column.Name) || seen[column.Name] ||
			(column.Direction != "" && column.Direction != "ASC" && column.Direction != "DESC") ||
			(column.Nulls != "" && column.Nulls != "FIRST" && column.Nulls != "LAST") {
			return IndexRecipe{}, fmt.Errorf("%w: invalid or repeated key column, direction or NULL ordering", ErrIndexPolicy)
		}
		seen[column.Name] = true
		key := column.Name
		if column.Direction == "DESC" {
			key += " DESC"
		}
		// Match PostgreSQL's catalog output: omit default ASC and NULL ordering.
		if column.Nulls == "FIRST" && column.Direction != "DESC" {
			key += " NULLS FIRST"
		} else if column.Nulls == "LAST" && column.Direction == "DESC" {
			key += " NULLS LAST"
		}
		recipe.Columns = append(recipe.Columns, key)
	}
	for _, column := range d.IncludeColumns {
		if !slices.Contains(allowed, column) || seen[column] {
			return IndexRecipe{}, fmt.Errorf("%w: invalid INCLUDE column or overlap with key/INCLUDE columns", ErrIndexPolicy)
		}
		seen[column] = true
	}
	return recipe, nil
}

func storedIndexSpec(m models.ManagedDatabaseIndex) IndexSpec {
	return IndexSpec{Label: m.Label, Purpose: m.Purpose, Recipe: m.Recipe, ParameterPath: m.ParameterPath, Definition: m.Definition}
}

func sameIndexDefinition(a, b IndexSpec) bool {
	left, err := resolveIndexRecipe(a)
	if err != nil {
		return false
	}
	right, err := resolveIndexRecipe(b)
	if err != nil {
		return false
	}
	return a.ParameterPath == b.ParameterPath && left.TableName == right.TableName &&
		strings.Join(left.Columns, ",") == strings.Join(right.Columns, ",") &&
		slices.Equal(left.IncludeColumns, right.IncludeColumns)
}

func customIndexRowBytes(d *models.DatabaseIndexDefinition, nameWidth int64) float64 {
	// Tuple/header/alignment overhead plus conservative fixed-width keys.
	width := float64(64 + 24*(len(d.Columns)+len(d.IncludeColumns)))
	if nameWidth <= 0 {
		nameWidth = 256
	}
	for _, column := range d.Columns {
		if column.Name == "name" {
			width += float64(nameWidth)
		}
	}
	if slices.Contains(d.IncludeColumns, "name") {
		width += float64(nameWidth)
	}
	return width
}
