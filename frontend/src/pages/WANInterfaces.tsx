import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Network, RefreshCw, Search } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import TableFilterSummary from '../components/TableFilterSummary';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { statusBadgeClass } from '../lib/lanFields';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';

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

const WANInterfaces: Component = () => {
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.wan-interfaces');
  const [sortBy, setSortBy] = createSignal<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.wan-interfaces', {});
  const [interfaces, { refetch }] = createResource(api.getWANInterfaces);

  const filteredInterfaces = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    let rows = interfaces() || [];
    if (query) {
      rows = rows.filter(row => [row.serial_number, row.name, row.status, row.ip_address, row.mac_address]
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
    const current = sortBy();
    if (current?.column === column) {
      setSortBy(current.direction === 'asc' ? { column, direction: 'desc' } : null);
    } else {
      setSortBy({ column, direction: 'asc' });
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader
        title="WAN Interfaces"
        description="WAN interfaces collected from all CPE devices. Values are based on the latest stored parameter tree."
      >
        <button type="button" class="btn btn-secondary" onClick={() => void refetch()} disabled={interfaces.loading}>
          <RefreshCw size={14} class={interfaces.loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </PageHeader>

      <div class="card p-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-2 text-sm text-secondary">
            <Network size={16} />
            <span>{sortedInterfaces().length} interface{sortedInterfaces().length === 1 ? '' : 's'}</span>
          </div>
          <label class="relative block w-full sm:w-72">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input class="input w-full pl-9!" value={searchQuery()} onInput={(event) => setSearchQuery(event.currentTarget.value)} placeholder="Search WAN interfaces" aria-label="Search WAN interfaces" />
          </label>
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
                      <For each={[['serial_number', 'Serial number'], ['name', 'Name'], ['status', 'Status'], ['ip_address', 'IP address'], ['mac_address', 'MAC address']] as const}>
                        {(column) => {
                          const isSorted = () => sortBy()?.column === column[0];
                          return (
                            <th class="text-left px-4 py-3 whitespace-nowrap" aria-sort={isSorted() ? (sortBy()?.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                              <div class="flex items-center gap-1.5">
                                <button type="button" class={`flex items-center gap-1 text-xs font-medium tracking-wide transition-colors ${isSorted() ? 'text-sky-400' : 'text-muted'} hover:text-primary`} onClick={() => handleSort(column[0])}>
                                  {column[1]}
                                  <Show when={isSorted()} fallback={<ArrowUpDown size={10} class="opacity-50" />}>
                                    <Show when={sortBy()?.direction === 'asc'} fallback={<ArrowDown size={12} />}><ArrowUp size={12} /></Show>
                                  </Show>
                                </button>
                                <ColumnFilter
                                  columnId={column[0]}
                                  label={column[1]}
                                  active={columnFilters()[column[0]] || null}
                                  onApply={(state) => setColumnFilters((previous) => {
                                    const next = { ...previous };
                                    if (state) next[column[0]] = state;
                                    else delete next[column[0]];
                                    return next;
                                  })}
                                />
                              </div>
                            </th>
                          );
                        }}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={sortedInterfaces()}>
                      {(row) => {
                        const webUrl = () => cpeWebUiUrl(row.ip_address);
                        return (
                          <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                            <td class="px-4 py-3">
                              <A class="data-link font-mono text-sm" href={`/device/${encodeURIComponent(row.serial_number)}`} aria-label={`Open CPE ${row.serial_number}`}>
                                {row.serial_number}
                              </A>
                            </td>
                            <td class="px-4 py-3 text-primary">{row.name}</td>
                            <td class="px-4 py-3"><span class={`badge ${statusBadgeClass(row.status)}`}>{row.status}</span></td>
                            <td class="px-4 py-3 text-primary font-mono">
                              <div class="flex items-center gap-1.5">
                                <span>{row.ip_address}</span>
                                <Show when={webUrl()}>
                                  {(url) => <a href={url()} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center rounded p-1 text-muted hover:text-primary hover:bg-elevated" aria-label={`Open CPE web interface at ${row.ip_address}`} title="Open CPE web interface in a new tab"><ExternalLink size={13} /></a>}
                                </Show>
                              </div>
                            </td>
                            <td class="px-4 py-3 text-secondary font-mono">{row.mac_address}</td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
                <div class="table-footer px-4 py-3"><TableFilterSummary filters={columnFilters()} onClear={() => setColumnFilters({})} onRemove={(columnId) => setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; })} /></div>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default WANInterfaces;
