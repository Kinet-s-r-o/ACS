export type FilterOperator = 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'equals' | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal';
export type FilterLogic = 'all' | 'any';

export interface FilterRule {
  operator: FilterOperator;
  value: string;
}

export interface ColumnFilterState {
  logic: FilterLogic;
  rules: FilterRule[];
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: 'Contains',
  not_contains: 'Does not contain',
  starts_with: 'Starts with',
  ends_with: 'Ends with',
  equals: 'Equals',
  greater_than: 'Greater than',
  greater_than_or_equal: 'Greater than or equal to',
  less_than: 'Less than',
  less_than_or_equal: 'Less than or equal to',
};

export const LOGIC_LABELS: Record<FilterLogic, string> = {
  all: 'Matches all',
  any: 'Matches any',
};

export function matchesValue(value: string, rule: FilterRule): boolean {
  const v = value.toLowerCase();
  const target = rule.value.toLowerCase();
  switch (rule.operator) {
    case 'contains': return v.includes(target);
    case 'not_contains': return !v.includes(target);
    case 'starts_with': return v.startsWith(target);
    case 'ends_with': return v.endsWith(target);
    case 'equals': return v === target;
    case 'greater_than': return numericComparison(value, rule.value, (left, right) => left > right);
    case 'greater_than_or_equal': return numericComparison(value, rule.value, (left, right) => left >= right);
    case 'less_than': return numericComparison(value, rule.value, (left, right) => left < right);
    case 'less_than_or_equal': return numericComparison(value, rule.value, (left, right) => left <= right);
    default: return true;
  }
}

const numericComparison = (value: string, target: string, compare: (value: number, target: number) => boolean) => {
  const left = Number(value.trim());
  const right = Number(target.trim());
  return Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
};

export function applyColumnFilters<T>(
  items: T[],
  filters: Record<string, ColumnFilterState>,
  getValue: (item: T, colId: string) => string
): T[] {
  const activeCols = Object.entries(filters).filter(([, f]) => f.rules.length > 0);
  if (activeCols.length === 0) return items;

  return items.filter((item) => {
    return activeCols.every(([colId, filter]) => {
      const val = getValue(item, colId);
      if (filter.logic === 'all') {
        return filter.rules.every((rule) => matchesValue(val, rule));
      }
      return filter.rules.some((rule) => matchesValue(val, rule));
    });
  });
}

