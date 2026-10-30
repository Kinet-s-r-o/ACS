import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, ExternalLink, Network, Search } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import type { ColumnFilterState } from '../lib/filters';
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
  const [sortBy, setSortBy] = createPersistedJsonSignal<{ column: string; direction: 'asc' | 'desc' } | null>('acs.sort.wan-interfaces', null);
  const { columns, isVisible, toggle } = useColumnVisibility('wan-interfaces', [
    { id: 'serial_number', label: 'Serial number', visible: true },
    { id: 'name', label: 'Name', visible: true },
    { id: 'type', label: 'Type', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'ip_address', label: 'IP address', visible: true },
    { id: 'mac_address', label: 'MAC address', visible: true },
  ]);
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.wan-interfaces', {});
  const [interfaces, { refetch }] = createResource(
    () => ({ page: page(), size: pageSize(), search: searchQuery(), sort: sortBy(), filters: columnFilters() }),
    (query) => api.getWANInterfaces(query.size, query.page * query.size, { search: query.search, sort: query.sort, filters: query.filters })
  );
  const poll = window.setInterval(() => { if (interfaces()?.preparing) void refetch(); }, 5000);
  onCleanup(() => window.clearInterval(poll));
  const filteredInterfaces = createMemo(() => interfaces()?.items || []);
  const sortedInterfaces = filteredInterfaces;

  const handleSort = (column: string) => {
    setPage(0);
    const current = sortBy();
    if (current?.column === column) {
      setSortBy(current.direction === 'asc' ? { column, direction: 'desc' } : null);
    } else {
      setSortBy({ column, direction: 'asc' });
    }
  };

  const pagedInterfaces = filteredInterfaces;
  const totalPages = createMemo(() => Math.ceil((interfaces()?.total || 0) / pageSize()));

  const exportInterfacesCSV = async () => {
    const firstPage = await api.getWANInterfaces(500, 0, { search: searchQuery(), sort: sortBy(), filters: columnFilters() });
    const rowsToExport = [...firstPage.items];
    for (let offset = rowsToExport.length; offset < firstPage.total; offset += 500) {
      const nextPage = await api.getWANInterfaces(500, offset, { search: searchQuery(), sort: sortBy(), filters: columnFilters() });
      rowsToExport.push(...nextPage.items);
      if (!nextPage.items.length) break;
    }
    const exportColumns = columns().filter(column => column.visible);
    const escapeCsvValue = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csvRows = rowsToExport.map(row => exportColumns.map(column => row[column.id as keyof typeof row] || ''));
    const csv = '\uFEFF' + [exportColumns.map(column => column.label), ...csvRows]
      .map(row => row.map(escapeCsvValue).join(','))
      .join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'wan-interfaces.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="space-y-5">
      <Show when={!props.embedded}>
        <PageHeader
          title="WAN Interfaces"
          description="WAN interfaces collected from all CPE devices. Values are based on the latest stored parameter tree."
        >
        </PageHeader>
      </Show>

      <div class="card overflow-hidden">
        <div class="table-panel-toolbar">
          <div class="flex items-center gap-2 text-sm text-secondary">
            <Network size={16} />
            <Show when={!interfaces()?.preparing} fallback={<span>Preparing WAN inventory…</span>}>
              <span><strong>{pagedInterfaces().length}</strong> visible on this page · <strong>{interfaces()?.total ?? 0}</strong> total WANs</span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <label class="relative block w-full sm:w-72">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input class="input w-full pl-9!" value={searchQuery()} onInput={(event) => { setPage(0); setSearchQuery(event.currentTarget.value); }} placeholder="Search WAN interfaces" aria-label="Search WAN interfaces" />
            </label>
            <button
              type="button"
              class="icon-button"
              onClick={exportInterfacesCSV}
              disabled={interfaces.loading || sortedInterfaces().length === 0}
              title="Export filtered WAN interfaces as CSV"
              aria-label={`Export ${sortedInterfaces().length} filtered WAN interfaces as CSV`}
            >
              <Download size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <Show when={!interfaces.error} fallback={<div class="p-4"><ResourceError title="WAN interfaces are unavailable" description="The aggregated WAN interface list could not be loaded." onRetry={() => void refetch()} /></div>}>
          <Show when={!interfaces.loading} fallback={<div class="p-6"><div class="skeleton h-6 w-48 mb-4" /><div class="skeleton h-10 w-full" /></div>}>
            <Show when={!interfaces()?.preparing && filteredInterfaces().length > 0} fallback={<div class="p-6"><Show when={interfaces()?.preparing} fallback={<EmptyState icon={<Network size={22} />} title="No WAN interfaces found" description={searchQuery() ? 'Try a different search term.' : 'No stored WAN interface data is available for the CPE inventory.'} />}><div class="text-sm text-secondary" role="status">Existing WAN interfaces are being prepared. This page will update automatically.</div></Show></div>}>
              <div class="overflow-x-auto table-scroll">
                <table class="data-table w-full min-w-[760px] text-sm">
                  <thead class="opaque-table-header">
                    <tr class="border-b border-subtle">
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
              <Pagination page={page()} totalPages={totalPages()} totalItems={interfaces()?.total || 0} pageSize={pageSize()} onPageChange={setPage} storageKey="wan-interfaces" onPageSizeChange={(size) => { changePageSize(size); setPage(0); }} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setPage(0); }} />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default WANInterfaces;
