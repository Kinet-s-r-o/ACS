import type { Component } from 'solid-js';
import { createResource, createSignal, createMemo, Show, For } from 'solid-js';
import { A } from '@solidjs/router';
import { AlertTriangle, CheckCircle, Download, RefreshCw, Search, Trash2, X } from 'lucide-solid';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import type { ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import SortableHeader from '../components/SortableHeader';
import type { SortDirection } from '../lib/sorting';
import { formatDateTime } from '../lib/dateTime';

const Faults: Component = () => {
  const { isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const [filter, setFilter] = createSignal<'all' | 'active' | 'resolved'>('active');
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.faults');
  const [pendingFault, setPendingFault] = createSignal<number | null>(null);
  const [selectedFaults, setSelectedFaults] = createSignal<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = createSignal(false);
  const [stats, { refetch: refetchStats }] = createResource(() => api.getFaultStats());
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.faults', {});
  const [sortState, setSortState] = createPersistedJsonSignal<{ column: string | null; direction: SortDirection }>('acs.sort.faults', { column: 'created_at', direction: 'desc' });
  const handleSort = (column: string) => { setFaultPage(0); setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' })); };
  const { columns, isVisible, toggle } = useColumnVisibility('faults', [
    { id: 'serial_number', label: 'Device', visible: true },
    { id: 'model_name', label: 'Model', visible: true },
    { id: 'fault_code', label: 'Code', visible: true },
    { id: 'fault_string', label: 'Message', visible: true },
    { id: 'parameter_name', label: 'Parameter', visible: true },
    { id: 'created_at', label: 'Time', visible: true },
    { id: 'resolved', label: 'Status', visible: true },
    { id: 'software_version', label: 'Software Version', visible: true },
    { id: 'hardware_version', label: 'Hardware Version', visible: true },
    { id: 'manufacturer_oui', label: 'Manufacturer OUI', visible: true },
  ]);
  const [faultPage, setFaultPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('faults', 20);
  const [faults, { refetch }] = createResource(
    () => ({ filter: filter(), page: faultPage(), size: pageSize(), search: searchQuery(), sort: sortState(), filters: columnFilters() }),
    (query) => api.getFaults(query.filter, query.size, query.page * query.size, { search: query.search, sort: query.sort, filters: query.filters })
  );
  const handlePageSizeChange = (size: number) => { changePageSize(size); setFaultPage(0); };

  const filteredFaults = createMemo(() => faults()?.faults || []);
  const pagedFaults = filteredFaults;
  const faultTotalPages = createMemo(() => Math.ceil((faults()?.total || 0) / pageSize()));

  const exportFaultsCSV = async () => {
    const firstPage = await api.getFaults(filter(), 500, 0, { search: searchQuery(), sort: sortState(), filters: columnFilters() });
    const rowsToExport = [...firstPage.faults];
    for (let offset = rowsToExport.length; offset < firstPage.total; offset += 500) {
      const nextPage = await api.getFaults(filter(), 500, offset, { search: searchQuery(), sort: sortState(), filters: columnFilters() });
      rowsToExport.push(...nextPage.faults);
      if (!nextPage.faults.length) break;
    }
    const headers = ['Device', 'Model', 'Code', 'Message', 'Parameter', 'Time', 'Status', 'Software Version', 'Hardware Version', 'Manufacturer OUI'];
    const escapeCsvValue = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = rowsToExport.map(fault => [
      fault.serial_number,
      fault.model_name || '',
      fault.fault_code,
      fault.fault_string,
      fault.parameter_name || '',
      fault.created_at,
      fault.resolved ? 'Resolved' : 'Active',
      fault.software_version || '',
      fault.hardware_version || '',
      fault.manufacturer_oui || '',
    ]);
    const csv = '\uFEFF' + [headers, ...rows]
      .map(row => row.map(escapeCsvValue).join(','))
      .join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cwmp-faults-${filter()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleResolve = async (id: number) => {
    setPendingFault(id);
    try {
      await api.resolveFault(id);
      notify({ tone: 'success', title: 'Fault marked as resolved', message: 'The audit trail and fault register have been updated.' });
      await Promise.all([refetch(), refetchStats()]);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not resolve fault', message: 'The fault remains active. Retry after checking the API service.', detail: (error as Error).message, persistent: true });
    } finally { setPendingFault(null); }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: 'Delete fault record?', description: 'This permanently removes the selected protocol fault from the operational history. This action cannot be undone.', confirmLabel: 'Delete fault', tone: 'danger' })) return;
    setPendingFault(id);
    try {
      await api.deleteFault(id);
      notify({ tone: 'success', title: 'Fault record deleted' });
      await Promise.all([refetch(), refetchStats()]);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete fault', message: 'No local state was changed. Retry after checking the API service.', detail: (error as Error).message, persistent: true });
    } finally { setPendingFault(null); }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedFaults()];
    if (ids.length === 0) return;
    if (!await confirm({ title: `Delete ${ids.length} fault record${ids.length > 1 ? 's' : ''}?`, description: 'This permanently removes the selected protocol faults from the operational history. This action cannot be undone.', confirmLabel: 'Delete faults', tone: 'danger' })) return;
    setBulkDeleting(true);
    try {
      await api.deleteFaults(ids);
      notify({ tone: 'success', title: `${ids.length} fault record${ids.length > 1 ? 's' : ''} deleted` });
      setSelectedFaults(new Set<number>());
      await Promise.all([refetch(), refetchStats()]);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete faults', message: 'No local state was changed. Retry after checking the API service.', detail: (error as Error).message, persistent: true });
    } finally { setBulkDeleting(false); }
  };

  const toggleSelect = (id: number) => {
    setSelectedFaults(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allPageSelected = createMemo(() => {
    const page = pagedFaults();
    return page.length > 0 && page.every(f => selectedFaults().has(f.id));
  });

  const toggleSelectAll = () => {
    setSelectedFaults(prev => {
      const next = new Set(prev);
      const page = pagedFaults();
      if (page.every(f => next.has(f.id))) {
        page.forEach(f => next.delete(f.id));
      } else {
        page.forEach(f => next.add(f.id));
      }
      return next;
    });
  };

  const formatDate = (date: string) => {
    return formatDateTime(date);
  };

  const getFaultColor = (code: string) => {
    const num = parseInt(code);
    if (num >= 9000) return 'text-rose-400';
    if (num >= 8000) return 'text-orange-400';
    return 'text-amber-400';
  };

  return (
    <div class="space-y-6">
      <PageHeader title="Fault center" description="Investigate and resolve device-side protocol failures.">
        <button onClick={() => { refetch(); refetchStats(); }} class="btn btn-secondary" disabled={faults.loading || stats.loading}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </PageHeader>

      <Show when={faults.error || stats.error}>
        <div class="card"><ResourceError title="Fault data is unavailable" description="ACS could not read the protocol fault register. Retry the request without changing the selected filter." onRetry={() => { refetch(); refetchStats(); }} /></div>
      </Show>

      <dl class="ops-register fault-register" aria-label="Fault status register" aria-busy={stats.loading}>
        <div class="ops-register-cell is-offline"><dt>Active faults</dt><dd>{stats()?.active ?? 0}</dd><small>Awaiting operator action</small></div>
        <div class="ops-register-cell is-online"><dt>Resolved</dt><dd>{stats()?.resolved ?? 0}</dd><small>Closed fault records</small></div>
        <div class="ops-register-cell"><dt>Total recorded</dt><dd>{stats()?.total ?? 0}</dd><small>All CWMP fault events</small></div>
      </dl>

      {/* Filter */}
      <div class="flex gap-2">
        <button 
          onClick={() => setFilter('active')}
          class={`px-4 py-2 rounded-md text-sm transition-fast ${
            filter() === 'active' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'bg-elevated text-secondary hover:bg-zinc-700'
          }`}
          aria-pressed={filter() === 'active'}
        >
          Active
        </button>
        <button 
          onClick={() => setFilter('resolved')}
          class={`px-4 py-2 rounded-md text-sm transition-fast ${
            filter() === 'resolved' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-elevated text-secondary hover:bg-zinc-700'
          }`}
          aria-pressed={filter() === 'resolved'}
        >
          Resolved
        </button>
        <button 
          onClick={() => setFilter('all')}
          class={`px-4 py-2 rounded-md text-sm transition-fast ${
            filter() === 'all' ? 'bg-zinc-600 text-primary' : 'bg-elevated text-secondary hover:bg-zinc-700'
          }`}
          aria-pressed={filter() === 'all'}
        >
          All
        </button>
      </div>

      <Show when={isFullAccess() && selectedFaults().size > 0}>
        <div class="flex justify-end">
          <button onClick={handleBulkDelete} class="btn btn-danger" disabled={bulkDeleting()}>
            <Trash2 size={14} />
            Delete selected ({selectedFaults().size})
          </button>
        </div>
      </Show>

      {/* Faults List */}
      <Show when={!faults.error}><div class="card p-0 overflow-hidden">
        <div class="table-panel-toolbar">
          <span><strong>{pagedFaults().length}</strong> visible on this page · <strong>{stats()?.total ?? 0}</strong> total CWMP faults</span>
          <div class="flex items-center gap-2">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input
                type="text"
                value={searchQuery()}
                onInput={(event) => { setSearchQuery(event.currentTarget.value); setFaultPage(0); }}
                placeholder="Search faults…"
                aria-label="Search faults by device, code, message, parameter, or status"
                class="input pl-9! w-56 text-sm"
              />
              <Show when={searchQuery()}>
                <button type="button" onClick={() => { setSearchQuery(''); setFaultPage(0); }} class="input-clear" aria-label="Clear fault search"><X size={12} /></button>
              </Show>
            </div>
            <button
              type="button"
              class="icon-button"
              onClick={exportFaultsCSV}
              disabled={faults.loading || filteredFaults().length === 0}
              title="Export filtered faults as CSV"
              aria-label={`Export ${filteredFaults().length} filtered CWMP faults as CSV`}
            >
              <Download size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <Show when={!faults.loading} fallback={
          <div class="p-4 space-y-3" aria-label="Loading fault records"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div>
        }>
          <Show when={filteredFaults().length > 0} fallback={
            <EmptyState
              icon={<AlertTriangle size={22} />}
              title={(faults()?.faults?.length ?? 0) > 0 ? 'No CWMP faults match the current filters' : filter() === 'active' ? 'No active CWMP faults require review' : `No ${filter()} fault records`}
              description={(faults()?.faults?.length ?? 0) > 0 ? 'Adjust or clear the search or a column filter to inspect more fault records.' : filter() === 'active' ? 'The current fleet has not reported an unresolved protocol failure.' : 'Change the fault filter to inspect another part of the protocol history.'}
              action={filter() !== 'all' ? <button type="button" class="btn btn-secondary" onClick={() => setFilter('all')}>Show all fault records</button> : undefined}
            />
          }>
            <div class="overflow-x-auto table-scroll">
              <table data-column-order-key="cwmp-fault-center" data-column-order-legacy-schema="actions|code|device|message|parameter|status|time" class="data-table w-full text-sm min-w-[700px]">
                <thead>
                  <tr class="border-b border-subtle bg-surface/50">
                    <Show when={isFullAccess()}>
                      <th class="px-3 py-3 w-8">
                        <input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={allPageSelected()} onChange={toggleSelectAll} aria-label="Select all faults on this page" />
                      </th>
                    </Show>
                    <Show when={isVisible('serial_number')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="serial_number" label="Device" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="serial_number" label="Device" active={columnFilters()['serial_number'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['serial_number'] = s; else delete n['serial_number']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('model_name')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="model_name" label="Model" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="model_name" label="Model" active={columnFilters()['model_name'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['model_name'] = s; else delete n['model_name']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('fault_code')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="fault_code" label="Code" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="fault_code" label="Code" numeric active={columnFilters()['fault_code'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['fault_code'] = s; else delete n['fault_code']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('fault_string')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="fault_string" label="Message" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="fault_string" label="Message" active={columnFilters()['fault_string'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['fault_string'] = s; else delete n['fault_string']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('parameter_name')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted hidden lg:table-cell">
                        <div class="flex items-center gap-1.5"><SortableHeader column="parameter_name" label="Parameter" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="parameter_name" label="Parameter" active={columnFilters()['parameter_name'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['parameter_name'] = s; else delete n['parameter_name']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('created_at')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted hidden md:table-cell">
                        <div class="flex items-center gap-1.5"><SortableHeader column="created_at" label="Time" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="created_at" label="Time" active={columnFilters()['created_at'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['created_at'] = s; else delete n['created_at']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('resolved')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="resolved" label="Status" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="resolved" label="Status" active={columnFilters()['resolved'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['resolved'] = s; else delete n['resolved']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('software_version')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="software_version" label="Software Version" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="software_version" label="Software Version" active={columnFilters()['software_version'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['software_version'] = s; else delete n['software_version']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('hardware_version')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="hardware_version" label="Hardware Version" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="hardware_version" label="Hardware Version" active={columnFilters()['hardware_version'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['hardware_version'] = s; else delete n['hardware_version']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <Show when={isVisible('manufacturer_oui')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="manufacturer_oui" label="Manufacturer OUI" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="manufacturer_oui" label="Manufacturer OUI" active={columnFilters()['manufacturer_oui'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['manufacturer_oui'] = s; else delete n['manufacturer_oui']; return n; }); }} />
                        </div>
                      </th>
                    </Show>
                    <th class="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
                    <th class="px-2 py-3"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={pagedFaults()}>
                    {(fault) => (
                      <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                        <Show when={isFullAccess()}>
                          <td class="px-3 py-3">
                            <input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={selectedFaults().has(fault.id)} onChange={() => toggleSelect(fault.id)} aria-label={`Select fault ${fault.fault_code}`} />
                          </td>
                        </Show>
                        <Show when={isVisible('serial_number')}>
                          <td data-column-order-id="device#0" class="px-4 py-3">
                            <A href={`/device/${fault.serial_number}?tab=faults`} class="text-sky-400 hover:underline font-mono text-xs">
                              {fault.serial_number}
                            </A>
                          </td>
                        </Show>
                        <Show when={isVisible('model_name')}>
                          <td data-column-order-id="model#0" class="px-4 py-3 text-secondary whitespace-nowrap">{fault.model_name || '-'}</td>
                        </Show>
                        <Show when={isVisible('fault_code')}>
                          <td data-column-order-id="code#0" class="px-4 py-3">
                            <span class={`font-mono font-semibold ${getFaultColor(fault.fault_code)}`}>
                              {fault.fault_code}
                            </span>
                          </td>
                        </Show>
                        <Show when={isVisible('fault_string')}>
                          <td data-column-order-id="message#0" class="px-4 py-3 text-secondary max-w-xs truncate" title={fault.fault_string}>
                            {fault.fault_string.length > 40 ? fault.fault_string.slice(0, 40) + '...' : fault.fault_string}
                          </td>
                        </Show>
                        <Show when={isVisible('parameter_name')}>
                          <td data-column-order-id="parameter#0" class="px-4 py-3 text-muted font-mono text-xs max-w-xs truncate hidden lg:table-cell" title={fault.parameter_name}>
                            {fault.parameter_name || '-'}
                          </td>
                        </Show>
                        <Show when={isVisible('created_at')}>
                          <td data-column-order-id="time#0" class="px-4 py-3 text-muted text-xs hidden md:table-cell">
                            {formatDate(fault.created_at)}
                          </td>
                        </Show>
                        <Show when={isVisible('resolved')}>
                          <td data-column-order-id="status#0" class="px-4 py-3">
                            <span class={`badge ${fault.resolved ? 'badge-success' : 'badge-error'}`}>
                              {fault.resolved ? 'Resolved' : 'Active'}
                            </span>
                          </td>
                        </Show>
                        <Show when={isVisible('software_version')}>
                          <td data-column-order-id="software version#0" class="px-4 py-3 text-secondary whitespace-nowrap">{fault.software_version || '-'}</td>
                        </Show>
                        <Show when={isVisible('hardware_version')}>
                          <td data-column-order-id="hardware version#0" class="px-4 py-3 text-secondary whitespace-nowrap">{fault.hardware_version || '-'}</td>
                        </Show>
                        <Show when={isVisible('manufacturer_oui')}>
                          <td data-column-order-id="manufacturer oui#0" class="px-4 py-3 text-secondary font-mono text-xs whitespace-nowrap">{fault.manufacturer_oui || '-'}</td>
                        </Show>
                        <td data-column-order-id="actions#0" class="px-4 py-3 text-right">
                          <div class="flex items-center justify-end gap-2">
                            <Show when={!fault.resolved && isFullAccess()}>
                              <button 
                                onClick={() => handleResolve(fault.id)}
                                class="icon-button hover:text-emerald-400"
                                aria-label={`Mark fault ${fault.fault_code} as resolved`}
                                disabled={pendingFault() === fault.id}
                              >
                                <CheckCircle size={14} />
                              </button>
                            </Show>
                            <Show when={isFullAccess()}><button
                              onClick={() => handleDelete(fault.id)}
                              class="icon-button hover:text-rose-400"
                              aria-label={`Delete fault ${fault.fault_code}`}
                              disabled={pendingFault() === fault.id}
                            >
                              <Trash2 size={14} />
                            </button></Show>
                          </div>
                        </td>
                        <td class="px-2 py-3"></td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </div></Show>
      <Pagination page={faultPage()} totalPages={faultTotalPages()} totalItems={filteredFaults().length} pageSize={pageSize()} onPageChange={setFaultPage} storageKey="faults" onPageSizeChange={handlePageSizeChange} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setFaultPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setFaultPage(0); }} />
    </div>
  );
};

export default Faults;
