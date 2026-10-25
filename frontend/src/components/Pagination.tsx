import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';
import { ChevronLeft, ChevronRight } from 'lucide-solid';
import { PAGE_SIZE_OPTIONS } from '../lib/usePageSize';
import TableFilterSummary from './TableFilterSummary';
import type { ColumnFilterState } from '../lib/filters';

interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** When provided, a per-table page-size selector is shown and persisted in localStorage. */
  storageKey?: string;
  onPageSizeChange?: (size: number) => void;
  filters?: Record<string, ColumnFilterState>;
  onClearFilters?: () => void;
  onRemoveFilter?: (columnId: string) => void;
}

const Pagination: Component<PaginationProps> = (props) => {
  const start = () => props.page * props.pageSize + 1;
  const end = () => Math.min((props.page + 1) * props.pageSize, props.totalItems);

  return (
    <Show when={props.totalItems > 0 || (props.filters && Object.keys(props.filters).length > 0)}>
      <div class="table-footer text-sm">
        <Show when={props.filters && props.onClearFilters && props.onRemoveFilter}>
          <TableFilterSummary filters={props.filters!} onClear={props.onClearFilters!} onRemove={props.onRemoveFilter!} />
        </Show>
        <Show when={props.totalItems > 0}>
          <div class="flex items-center justify-between flex-1 min-w-0">
            <p class="text-muted">Showing {start()} - {end()} of {props.totalItems}</p>
            <div class="flex items-center gap-2">
              <Show when={props.storageKey}>
                <select value={String(props.pageSize)} onChange={(e) => props.onPageSizeChange?.(parseInt(e.currentTarget.value, 10))} class="input text-xs py-1.5 w-auto" aria-label="Rows per page">
                  <For each={PAGE_SIZE_OPTIONS}>{(opt) => <option value={opt}>{opt}</option>}</For>
                </select>
              </Show>
              <Show when={props.totalPages > 1}>
                <button onClick={() => props.onPageChange(Math.max(0, props.page - 1))} disabled={props.page === 0} class="btn btn-secondary py-1.5 px-3"><ChevronLeft size={14} />Previous</button>
                <button onClick={() => props.onPageChange(Math.min(props.totalPages - 1, props.page + 1))} disabled={props.page >= props.totalPages - 1} class="btn btn-secondary py-1.5 px-3">Next<ChevronRight size={14} /></button>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default Pagination;
