import type { Component } from 'solid-js';
import { createResource, createSignal, createMemo, Show, For } from 'solid-js';
import { A } from '@solidjs/router';
import { AlertTriangle, CheckCircle, Trash2, RefreshCw } from 'lucide-solid';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { createPersistedJsonSignal } from '../lib/storage';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import SortableHeader from '../components/SortableHeader';
import { sortRows, type SortDirection } from '../lib/sorting';
import { formatDateTime } from '../lib/dateTime';

const Faults: Component = () => {
  const { isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const [filter, setFilter] = createSignal<'all' | 'active' | 'resolved'>('active');
  const [pendingFault, setPendingFault] = createSignal<number | null>(null);
  const [selectedFaults, setSelectedFaults] = createSignal<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = createSignal(false);
  const [faults, { refetch }] = createResource(
    () => filter(),
    (selected) => api.getFaults(selected)
  );

  const [stats, { refetch: refetchStats }] = createResource(() => api.getFaultStats());
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.faults', {});
  const [sortState, setSortState] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'created_at', direction: 'desc' });
  const handleSort = (column: string) => setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  const { columns, isVisible, toggle } = useColumnVisibility('faults', [
    { id: 'serial_number', label: 'Device', visible: true },
    { id: 'fault_code', label: 'Code', visible: true },
    { id: 'fault_string', label: 'Message', visible: true },
    { id: 'parameter_name', label: 'Parameter', visible: true },
    { id: 'created_at', label: 'Time', visible: true },
    { id: 'resolved', label: 'Status', visible: true },
  ]);
  const [faultPage, setFaultPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('faults', 20);
  const handlePageSizeChange = (size: number) => { changePageSize(size); setFaultPage(0); };

  const getFilterValue = (fault: { serial_number: string; fault_code: string; fault_string: string; parameter_name: string; created_at: string; resolved: boolean }, colId: string): string => {
    switch (colId) {
      case 'serial_number': return fault.serial_number || '';
      case 'fault_code': return fault.fault_code || '';
      case 'fault_string': return fault.fault_string || '';
      case 'parameter_name': return fault.parameter_name || '';
      case 'created_at': return fault.created_at || '';
      case 'resolved': return fault.resolved ? 'Resolved' : 'Active';
      default: return '';
    }
  };

  const filteredFaults = createMemo(() => {
    const all = faults()?.faults || [];
    return sortRows(applyColumnFilters(all, columnFilters(), getFilterValue), sortState().column, sortState().direction, getFilterValue);
  });
  const pagedFaults = createMemo(() => {
    const all = filteredFaults();
    const start = faultPage() * pageSize();
    return all.slice(start, start + pageSize());
  });
  const faultTotalPages = createMemo(() => Math.ceil(filteredFaults().length / pageSize()));

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
        <Show when={isFullAccess() && selectedFaults().size > 0}>
          <button onClick={handleBulkDelete} class="btn btn-danger" disabled={bulkDeleting()}>
            <Trash2 size={14} />
            Delete selected ({selectedFaults().size})
          </button>
        </Show>
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

      {/* Faults List */}
      <Show when={!faults.error}><div class="card p-0 overflow-hidden">
        <Show when={!faults.loading} fallback={
          <div class="p-4 space-y-3" aria-label="Loading fault records"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div>
        }>
          <Show when={(faults()?.faults?.length ?? 0) > 0} fallback={
            <EmptyState
              icon={<AlertTriangle size={22} />}
              title={filter() === 'active' ? 'No active CWMP faults require review' : `No ${filter()} fault records`}
              description={filter() === 'active' ? 'The current fleet has not reported an unresolved protocol failure.' : 'Change the fault filter to inspect another part of the protocol history.'}
              action={filter() !== 'all' ? <button type="button" class="btn btn-secondary" onClick={() => setFilter('all')}>Show all fault records</button> : undefined}
            />
          }>
            <div class="overflow-x-auto table-scroll">
              <table class="data-table w-full text-sm min-w-[700px]">
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
                    <Show when={isVisible('fault_code')}>
                      <th class="text-left px-4 py-3 text-xs font-medium text-muted">
                        <div class="flex items-center gap-1.5"><SortableHeader column="fault_code" label="Code" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort} />
                          <ColumnFilter columnId="fault_code" label="Code" active={columnFilters()['fault_code'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['fault_code'] = s; else delete n['fault_code']; return n; }); }} />
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
                          <td class="px-4 py-3">
                            <A href={`/device/${fault.serial_number}?tab=faults`} class="text-sky-400 hover:underline font-mono text-xs">
                              {fault.serial_number}
                            </A>
                          </td>
                        </Show>
                        <Show when={isVisible('fault_code')}>
                          <td class="px-4 py-3">
                            <span class={`font-mono font-semibold ${getFaultColor(fault.fault_code)}`}>
                              {fault.fault_code}
                            </span>
                          </td>
                        </Show>
                        <Show when={isVisible('fault_string')}>
                          <td class="px-4 py-3 text-secondary max-w-xs truncate" title={fault.fault_string}>
                            {fault.fault_string.length > 40 ? fault.fault_string.slice(0, 40) + '...' : fault.fault_string}
                          </td>
                        </Show>
                        <Show when={isVisible('parameter_name')}>
                          <td class="px-4 py-3 text-muted font-mono text-xs max-w-xs truncate hidden lg:table-cell" title={fault.parameter_name}>
                            {fault.parameter_name || '-'}
                          </td>
                        </Show>
                        <Show when={isVisible('created_at')}>
                          <td class="px-4 py-3 text-muted text-xs hidden md:table-cell">
                            {formatDate(fault.created_at)}
                          </td>
                        </Show>
                        <Show when={isVisible('resolved')}>
                          <td class="px-4 py-3">
                            <span class={`badge ${fault.resolved ? 'badge-success' : 'badge-error'}`}>
                              {fault.resolved ? 'Resolved' : 'Active'}
                            </span>
                          </td>
                        </Show>
                        <td class="px-4 py-3 text-right">
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
