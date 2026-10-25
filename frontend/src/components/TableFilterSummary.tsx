import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';
import { Filter, X } from 'lucide-solid';
import type { ColumnFilterState } from '../lib/filters';

interface TableFilterSummaryProps {
  filters: Record<string, ColumnFilterState>;
  onClear: () => void;
  onRemove: (columnId: string) => void;
}

const humanize = (columnId: string) => columnId.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());

const TableFilterSummary: Component<TableFilterSummaryProps> = (props) => {
  const activeFilters = () => Object.entries(props.filters).filter(([, filter]) => filter.rules.length > 0);

  return (
    <Show when={activeFilters().length > 0}>
      <div class="table-filter-summary" aria-label="Active filters">
        <button type="button" class="table-filter-clear" onClick={props.onClear} title="Clear all filters" aria-label="Clear all filters">
          <span class="table-filter-clear-icon" aria-hidden="true"><Filter size={12} /><X size={8} /></span>
        </button>
        <div class="table-filter-chips">
          <For each={activeFilters()}>
            {([columnId, filter]) => (
              <span class="table-filter-chip">
                <span>{humanize(columnId)} ({filter.rules.length})</span>
                <button type="button" onClick={() => props.onRemove(columnId)} title={`Remove ${humanize(columnId)} filter`} aria-label={`Remove ${humanize(columnId)} filter`}>
                  <X size={10} />
                </button>
              </span>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default TableFilterSummary;
