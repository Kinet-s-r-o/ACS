package database

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"gorm.io/gorm"
)

func applySearchTerms(query *gorm.DB, search string, expressions []string) *gorm.DB {
	search = strings.TrimSpace(search)
	if search == "" {
		return query
	}
	parts := make([]string, 0, len(expressions))
	args := make([]interface{}, 0, len(expressions))
	for _, expression := range expressions {
		parts = append(parts, "STRPOS(LOWER(COALESCE(("+expression+")::text, '')), LOWER(?)) > 0")
		args = append(args, search)
	}
	if len(parts) > 0 {
		query = query.Where("("+strings.Join(parts, " OR ")+")", args...)
	}
	return query
}

type TableFilterRule struct {
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type TableColumnFilter struct {
	Logic string            `json:"logic"`
	Rules []TableFilterRule `json:"rules"`
}

func ParseTableColumnFilters(raw string, allowedColumns []string) (map[string]TableColumnFilter, error) {
	filters := make(map[string]TableColumnFilter)
	if raw == "" {
		return filters, nil
	}
	if len(raw) > 16*1024 {
		return nil, fmt.Errorf("filters are too large")
	}
	if err := json.Unmarshal([]byte(raw), &filters); err != nil {
		return nil, err
	}
	allowed := make(map[string]bool, len(allowedColumns))
	for _, column := range allowedColumns {
		allowed[column] = true
	}
	operators := map[string]bool{
		"contains": true, "not_contains": true, "starts_with": true, "ends_with": true,
		"equals": true, "greater_than": true, "greater_than_or_equal": true,
		"less_than": true, "less_than_or_equal": true,
	}
	for column, filter := range filters {
		if !allowed[column] || (filter.Logic != "all" && filter.Logic != "any") || len(filter.Rules) > 10 {
			return nil, fmt.Errorf("invalid table filter")
		}
		for _, rule := range filter.Rules {
			if !operators[rule.Operator] || strings.TrimSpace(rule.Value) == "" || len(rule.Value) > 256 {
				return nil, fmt.Errorf("invalid table filter rule")
			}
		}
	}
	return filters, nil
}

func ApplyTableColumnFilters(query *gorm.DB, filters map[string]TableColumnFilter, expressions, numericExpressions map[string]string) (*gorm.DB, error) {
	for column, filter := range filters {
		if len(filter.Rules) == 0 {
			continue
		}
		expression, ok := expressions[column]
		if !ok {
			return nil, fmt.Errorf("invalid table filter column")
		}
		parts := make([]string, 0, len(filter.Rules))
		args := make([]interface{}, 0, len(filter.Rules)*2)
		for _, rule := range filter.Rules {
			if strings.HasPrefix(rule.Operator, "greater_than") || strings.HasPrefix(rule.Operator, "less_than") {
				numericExpression, supported := numericExpressions[column]
				if !supported {
					return nil, fmt.Errorf("numeric filter is not supported for this column")
				}
				value, err := strconv.ParseFloat(rule.Value, 64)
				if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
					parts = append(parts, "FALSE")
					continue
				}
				op := map[string]string{"greater_than": ">", "greater_than_or_equal": ">=", "less_than": "<", "less_than_or_equal": "<="}[rule.Operator]
				parts = append(parts, "("+numericExpression+") "+op+" ?")
				args = append(args, value)
				continue
			}
			text := "LOWER(COALESCE((" + expression + ")::text, ''))"
			target := strings.ToLower(rule.Value)
			switch rule.Operator {
			case "contains":
				parts = append(parts, "STRPOS("+text+", LOWER(?)) > 0")
				args = append(args, target)
			case "not_contains":
				parts = append(parts, "STRPOS("+text+", LOWER(?)) = 0")
				args = append(args, target)
			case "starts_with":
				parts = append(parts, "LEFT("+text+", LENGTH(?)) = LOWER(?)")
				args = append(args, rule.Value, target)
			case "ends_with":
				parts = append(parts, "RIGHT("+text+", LENGTH(?)) = LOWER(?)")
				args = append(args, rule.Value, target)
			case "equals":
				parts = append(parts, text+" = LOWER(?)")
				args = append(args, target)
			}
		}
		if len(parts) == 0 {
			continue
		}
		logic := " AND "
		if filter.Logic == "any" {
			logic = " OR "
		}
		query = query.Where("("+strings.Join(parts, logic)+")", args...)
	}
	return query, nil
}
