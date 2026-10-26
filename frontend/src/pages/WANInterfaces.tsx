import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Network, Search } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { statusBadgeClass } from '../lib/lanFields';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { usePageSize } from '../lib/usePageSize';
import { useColumnVisibility } from '../lib/useColumnVisibility';

const cpeWebUiUrl = (address: string): string | null => {
  const value = address.trim();
  if (!value || value === '-') return null;
  const octets = value.split('.');
  if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return `http://${value}`;
  if (value.includes(':')) {
    try { new URL(`http://[${value}]/`); return `http://[${value}]`; } catch { return null; }
  }
  return null;
};

interface WANInterfacesProps {
  embedded?: boolean;
}

export const WANInterfaces: Component<WANInterfacesProps> = (props) => {
  const [page, setPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('wan-interfaces', 20);
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.wan-interfaces');
  const [sortBy, setSortBy] = createSignal<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const { columns, isVisible, toggle } = useColumnVisibility('wan-interfaces', [
    { id: 'serial_number', label: 'Serial number', visible: true },
    { id: 'name', label: 'Name', visible: true },
    { id: 'type', label: 'Type', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'ip_address', label: 'IP address', visible: true },
    { id: 'mac_address', label: 'MAC address', visible: true },
  ]);
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.wan-interfaces', {});
  const [interfaces, { refetch }] = createResource(api.getWANInterfaces);

  const filteredInterfaces = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    let rows = interfaces() || [];
    if (query) {
      rows = rows.filter(row => [row.serial_number, row.name, row.type, row.status, row.ip_address, row.mac_address]
        .some(value => value.toLowerCase().includes(query)));
    }
    return applyColumnFilters(rows, columnFilters(), (row, columnId) => row[columnId as keyof typeof row] || '');
  });

  const sortedInterfaces = createMemo(() => {
    const rows = [...filteredInterfaces()];
    const sort = sortBy();
    if (!sort) return rows;
    return rows.sort((a, b) => {
      const aValue = a[sort.column as keyof typeof a] || '';
      const bValue = b[sort.column as keyof typeof b] || '';
      const comparison = aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' });
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  });

  const handleSort = (column: string) => {
    setPage(0);
    const current = sortBy();
    if (current?.column === column) {
      setSortBy(current.direction === 'asc' ? { column, direction: 'desc' } : null);
    } else {
      setSortBy({ column, direction: 'asc' });
    }
  };

  const pagedInterfaces = createMemo(() => sortedInterfaces().slice(page() * pageSize(), (page() + 1) * pageSize()));
  const totalPages = createMemo(() => Math.ceil(sortedInterfaces().length / pageSize()));

  return (
    <div class="space-y-5">
      <Show when={!props.embedded}>
        <PageHeader
          title="WAN Interfaces"
          description="WAN interfaces collected from all CPE devices. Values are based on the latest stored parameter tree."
        >
        </PageHeader>
      </Show>

      <div class="card p-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-2 text-sm text-secondary">
            <Network size={16} />
            <span><strong>{pagedInterfaces().length}</strong> visible on this page · <strong>{interfaces()?.length ?? 0}</strong> total WANs</span>
          </div>
          <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <label class="relative block w-full sm:w-72">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input class="input w-full pl-9!" value={searchQuery()} onInput={(event) => { setPage(0); setSearchQuery(event.currentTarget.value); }} placeholder="Search WAN interfaces" aria-label="Search WAN interfaces" />
            </label>
          </div>
        </div>
      </div>

      <Show when={!interfaces.error} fallback={<div class="card"><ResourceError title="WAN interfaces are unavailable" description="The aggregated WAN interface list could not be loaded." onRetry={() => void refetch()} /></div>}>
        <Show when={!interfaces.loading} fallback={<div class="card p-6"><div class="skeleton h-6 w-48 mb-4" /><div class="skeleton h-10 w-full" /></div>}>
          <Show when={filteredInterfaces().length > 0} fallback={<div class="card"><EmptyState icon={<Network size={22} />} title="No WAN interfaces found" description={searchQuery() ? 'Try a different search term.' : 'No stored WAN interface data is available for the CPE inventory.'} /></div>}>
            <div class="card overflow-hidden">
              <div class="overflow-x-auto">
                <table class="data-table w-full min-w-[760px] text-sm">
                  <thead>
                    <tr class="border-b-2 border-subtle bg-base">
                      <For each={columns()}>
                        {(column) => {
                          const isSorted = () => sortBy()?.column === column.id;
                          return (
                            <Show when={column.visible}><th class="text-left px-4 py-3 whitespace-nowrap" aria-sort={isSorted() ? (sortBy()?.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                              <div class="flex items-center gap-1.5">
                                <button type="button" class={`flex items-center gap-1 text-xs font-medium tracking-wide transition-colors ${isSorted() ? 'text-sky-400' : 'text-muted'} hover:text-primary`} onClick={() => handleSort(column.id)}>
                                  {column.label}
                                  <Show when={isSorted()} fallback={<ArrowUpDown size={10} class="opacity-50" />}>
                                    <Show when={sortBy()?.direction === 'asc'} fallback={<ArrowDown size={12} />}><ArrowUp size={12} /></Show>
                                  </Show>
                                </button>
                                <ColumnFilter
                                  columnId={column.id}
                                  label={column.label}
                                  active={columnFilters()[column.id] || null}
                                  onApply={(state) => {
                                    setPage(0);
                                    setColumnFilters((previous) => {
                                      const next = { ...previous };
                                      if (state) next[column.id] = state;
                                      else delete next[column.id];
                                      return next;
                                    });
                                  }}
                                />
                              </div>
                            </th></Show>
                          );
                        }}
                      </For>
                      <th class="px-2 py-3"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={pagedInterfaces()}>
                      {(row) => {
                        const webUrl = () => cpeWebUiUrl(row.ip_address);
                        return (
                          <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                            <Show when={isVisible('serial_number')}><td class="px-4 py-3">
                              <A class="data-link font-mono text-sm" href={`/device/${encodeURIComponent(row.serial_number)}`} aria-label={`Open CPE ${row.serial_number}`}>
                                {row.serial_number}
                              </A>
                            </td></Show>
                            <Show when={isVisible('name')}><td class="px-4 py-3 text-primary">{row.name}</td></Show>
                            <Show when={isVisible('type')}><td class="px-4 py-3 text-secondary">{row.type || '-'}</td></Show>
                            <Show when={isVisible('status')}><td class="px-4 py-3"><span class={`badge ${statusBadgeClass(row.status)}`}>{row.status}</span></td></Show>
                            <Show when={isVisible('ip_address')}><td class="px-4 py-3 text-primary font-mono">
                              <div class="flex items-center gap-1.5">
                                <span>{row.ip_address}</span>
                                <Show when={webUrl()}>
                                  {(url) => <a href={url()} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center rounded p-1 text-muted hover:text-primary hover:bg-elevated" aria-label={`Open CPE web interface at ${row.ip_address}`} title="Open CPE web interface in a new tab"><ExternalLink size={13} /></a>}
                                </Show>
                              </div>
                            </td></Show>
                            <Show when={isVisible('mac_address')}><td class="px-4 py-3 text-secondary font-mono">{row.mac_address}</td></Show>
                            <td></td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
            <Pagination page={page()} totalPages={totalPages()} totalItems={sortedInterfaces().length} pageSize={pageSize()} onPageChange={setPage} storageKey="wan-interfaces" onPageSizeChange={(size) => { changePageSize(size); setPage(0); }} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setPage(0); }} />
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default WANInterfaces;
