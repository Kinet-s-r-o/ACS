import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { Download, Eye, RefreshCw, Search, Trash2, X } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api, type GlobalTask } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColumnFilter from '../components/ColumnFilter';
import Pagination from '../components/Pagination';
import ColumnVisibility from '../components/ColumnVisibility';
import { EmptyState, ResourceError } from '../components/ResourceState';
import type { ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/Feedback';
import SortableHeader from '../components/SortableHeader';
import type { SortDirection } from '../lib/sorting';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { formatDateTime } from '../lib/dateTime';
import { useColumnVisibility } from '../lib/useColumnVisibility';

const statusBadge = (status: string) => {
  switch (status) {
    case 'completed': return 'badge-success';
    case 'pending': return 'badge-warning';
    case 'sent': return 'bg-sky-500/15 text-sky-400';
    case 'failed': return 'badge-error';
    case 'deleted': return 'bg-elevated text-muted';
    default: return 'bg-zinc-700 text-secondary';
  }
};

const formatDate = (value?: string | null) => formatDateTime(value);
const formatTriggerEvents = (events?: string[]) => events?.length ? events.join(', ') : '-';

const Tasks: Component = () => {
  const { isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.tasks');
  const [selectedTask, setSelectedTask] = createSignal<GlobalTask | null>(null);
  const [selectedTasks, setSelectedTasks] = createSignal<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = createSignal(false);
  const [taskDetailTab, setTaskDetailTab] = createSignal<'requested' | 'result'>('requested');
  const [statusFilter, setStatusFilter] = createSignal<string | 'all' | 'column'>('all');
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.tasks', {});
  const [sortState, setSortState] = createPersistedJsonSignal<{ column: string | null; direction: SortDirection }>('acs.sort.tasks', { column: 'created_at', direction: 'desc' });
  const handleSort = (column: string) => { setTaskPage(0); setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' })); };
  const [taskPage, setTaskPage] = createSignal(0);
  const { columns: taskColumns, isVisible: isTaskColumnVisible, toggle: toggleTaskColumn } = useColumnVisibility('global_tasks', [
    { id: 'serial_number', label: 'Serial number', visible: true },
    { id: 'type', label: 'Type', visible: true },
    { id: 'trigger_event', label: 'Trigger event', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'created_at', label: 'Created', visible: true },
    { id: 'completed_at', label: 'Completed', visible: true },
    { id: 'created_by', label: 'Created by', visible: true },
    { id: 'deleted_by', label: 'Deleted by', visible: true },
    { id: 'error', label: 'Error', visible: true },
  ]);
  const { pageSize: taskPageSize, changePageSize: changeTaskPageSize } = usePageSize('global_tasks', 20);
  const [tasks, { refetch }] = createResource(
    () => ({ page: taskPage(), size: taskPageSize(), search: searchQuery(), sort: sortState(), filters: effectiveFilters() }),
    (query) => api.getTasks(query.size, query.page * query.size, { search: query.search, sort: query.sort, filters: query.filters })
  );
  const [taskDetails] = createResource(() => selectedTask()?.id, (id) => api.getTask(id));
  const [deletingTask, setDeletingTask] = createSignal<number | null>(null);
  const taskCounts = createMemo(() => {
    const counts = { pending: 0, sent: 0, completed: 0, failed: 0, deleted: 0, total: 0 };
    const values = tasks()?.counts || {};
    for (const key of ['pending', 'sent', 'completed', 'failed', 'deleted'] as const) counts[key] = values[key] || 0;
    counts.total = counts.pending + counts.sent + counts.completed + counts.failed + counts.deleted;
    return counts;
  });

  function effectiveFilters(): Record<string, ColumnFilterState> {
    const filters = { ...columnFilters() };
    if (statusFilter() === 'all') {
      delete filters.status;
      return filters;
    }
    if (statusFilter() === 'column') return filters;
    filters.status = { logic: 'all', rules: [{ operator: 'equals', value: statusFilter() }] };
    return filters;
  }

  const filteredTasks = createMemo(() => tasks()?.tasks || []);
  const pagedTasks = filteredTasks;
  const totalPages = createMemo(() => Math.ceil((tasks()?.total || 0) / taskPageSize()));
  const selectableTasks = createMemo(() => pagedTasks().filter(task => task.status === 'pending'));
  const allPageSelected = createMemo(() => {
    const page = selectableTasks();
    return page.length > 0 && page.every(task => selectedTasks().has(task.id));
  });

  const exportTasksCSV = async () => {
    const filters = effectiveFilters();
    const firstPage = await api.getTasks(500, 0, { search: searchQuery(), sort: sortState(), filters });
    const rowsToExport = [...firstPage.tasks];
    for (let offset = rowsToExport.length; offset < firstPage.total; offset += 500) {
      const nextPage = await api.getTasks(500, offset, { search: searchQuery(), sort: sortState(), filters });
      rowsToExport.push(...nextPage.tasks);
      if (!nextPage.tasks.length) break;
    }
    const headers = ['Serial number', 'Type', 'Trigger event', 'Status', 'Created', 'Completed', 'Created by', 'Deleted by', 'Error'];
    const escapeCsvValue = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = rowsToExport.map(task => [
      task.serial_number,
      task.type,
      formatTriggerEvents(task.trigger_events),
      task.status,
      task.created_at,
      task.completed_at || '',
      task.created_by || '',
      task.deleted_by || '',
      task.error_message || '',
    ]);
    const csv = '\uFEFF' + [headers, ...rows]
      .map(row => row.map(escapeCsvValue).join(','))
      .join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cwmp-tasks.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const applyFilter = (column: string, state: ColumnFilterState | null) => {
    if (column === 'status') setStatusFilter('column');
    setColumnFilters(previous => {
      const next = { ...previous };
      if (state) next[column] = state;
      else delete next[column];
      return next;
    });
    setTaskPage(0);
  };

  const renderFilter = (column: string, label: string) => (
    <ColumnFilter columnId={column} label={label} active={columnFilters()[column] || null} onApply={(state) => applyFilter(column, state)} />
  );

  const deletePendingTask = async (task: GlobalTask) => {
    if (task.status !== 'pending' || !isFullAccess()) return;
    if (!await confirm({ title: `Delete pending task #${task.id}?`, description: `The ${task.type} task for ${task.serial_number} will be marked deleted and will not be sent to the CPE.`, confirmLabel: 'Delete task', tone: 'danger' })) return;
    setDeletingTask(task.id);
    try {
      await api.deletePendingTask(task.id);
      if (selectedTask()?.id === task.id) setSelectedTask(null);
      notify({ tone: 'success', title: 'Pending task deleted' });
      await refetch();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete task', message: 'The task may already have been sent to the CPE.', detail: (error as Error).message, persistent: true });
      await refetch();
    } finally {
      setDeletingTask(null);
    }
  };

  const toggleTaskSelection = (id: number) => {
    setSelectedTasks(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePageTaskSelection = () => {
    setSelectedTasks(previous => {
      const next = new Set(previous);
      const page = selectableTasks();
      if (page.every(task => next.has(task.id))) page.forEach(task => next.delete(task.id));
      else page.forEach(task => next.add(task.id));
      return next;
    });
  };

  const deleteSelectedTasks = async () => {
    const ids = [...selectedTasks()];
    if (ids.length === 0) return;
    if (!await confirm({ title: `Delete ${ids.length} pending task${ids.length > 1 ? 's' : ''}?`, description: 'The selected tasks will be marked deleted and will not be sent to the CPE. Tasks already sent or completed are not affected.', confirmLabel: 'Delete tasks', tone: 'danger' })) return;
    setBulkDeleting(true);
    try {
      const result = await api.deletePendingTasks(ids);
      setSelectedTasks(new Set<number>());
      notify({ tone: 'success', title: `${result.deleted} pending task${result.deleted === 1 ? '' : 's'} deleted` });
      await refetch();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete tasks', message: 'Some tasks may already have been sent to the CPE.', detail: (error as Error).message, persistent: true });
      await refetch();
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="CWMP tasks" description="Task history across all CPE devices." />

      <dl class="ops-register task-register" aria-label="CWMP task status filters" aria-busy={tasks.loading}>
        <button type="button" class="ops-register-cell task-filter-card is-warning" onClick={() => { setStatusFilter('pending'); setTaskPage(0); }} aria-pressed={statusFilter() === 'pending'}><span class="task-filter-label">Pending</span><strong class="task-filter-count">{taskCounts().pending}</strong><span class="task-filter-description">Waiting to be sent</span></button>
        <button type="button" class="ops-register-cell task-filter-card" onClick={() => { setStatusFilter('sent'); setTaskPage(0); }} aria-pressed={statusFilter() === 'sent'}><span class="task-filter-label">Sent</span><strong class="task-filter-count">{taskCounts().sent}</strong><span class="task-filter-description">Dispatched to CPE</span></button>
        <button type="button" class="ops-register-cell task-filter-card is-online" onClick={() => { setStatusFilter('completed'); setTaskPage(0); }} aria-pressed={statusFilter() === 'completed'}><span class="task-filter-label">Completed</span><strong class="task-filter-count">{taskCounts().completed}</strong><span class="task-filter-description">Successfully finished</span></button>
        <button type="button" class="ops-register-cell task-filter-card is-offline" onClick={() => { setStatusFilter('failed'); setTaskPage(0); }} aria-pressed={statusFilter() === 'failed'}><span class="task-filter-label">Failed</span><strong class="task-filter-count">{taskCounts().failed}</strong><span class="task-filter-description">Require review</span></button>
        <button type="button" class="ops-register-cell task-filter-card" onClick={() => { setStatusFilter('deleted'); setTaskPage(0); }} aria-pressed={statusFilter() === 'deleted'}><span class="task-filter-label">Deleted</span><strong class="task-filter-count">{taskCounts().deleted}</strong><span class="task-filter-description">Cancelled before dispatch</span></button>
        <button type="button" class="ops-register-cell task-filter-card" onClick={() => { setStatusFilter('all'); setTaskPage(0); }} aria-pressed={statusFilter() === 'all'}><span class="task-filter-label">Total tasks</span><strong class="task-filter-count">{taskCounts().total}</strong><span class="task-filter-description">All CWMP tasks</span></button>
      </dl>

      <Show when={isFullAccess() && selectedTasks().size > 0}>
        <div class="flex justify-end">
          <button type="button" onClick={() => void deleteSelectedTasks()} class="btn btn-danger" disabled={bulkDeleting()}>
            <Trash2 size={14} />
            Delete selected ({selectedTasks().size})
          </button>
        </div>
      </Show>

      <div class="card overflow-hidden">
        <div class="table-panel-toolbar">
            <span><strong>{pagedTasks().length}</strong> visible on this page · <strong>{taskCounts().total}</strong> total CWMP tasks</span>
          <div class="flex items-center gap-2">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input type="text" value={searchQuery()} onInput={(event) => { setSearchQuery(event.currentTarget.value); setTaskPage(0); }} placeholder="Search tasks…" class="input pl-9! sm:w-72 text-sm" />
              <Show when={searchQuery()}>
                <button type="button" onClick={() => { setSearchQuery(''); setTaskPage(0); }} class="input-clear" aria-label="Clear search"><X size={12} /></button>
              </Show>
            </div>
            <button type="button" class="icon-button" onClick={() => void refetch()} disabled={tasks.loading} title="Refresh CWMP tasks" aria-label="Refresh CWMP tasks">
              <RefreshCw size={15} class={tasks.loading ? 'animate-spin' : ''} aria-hidden="true" />
            </button>
            <button
              type="button"
              class="icon-button"
              onClick={exportTasksCSV}
              disabled={tasks.loading || filteredTasks().length === 0}
              title="Export filtered tasks as CSV"
              aria-label={`Export ${filteredTasks().length} filtered CWMP tasks as CSV`}
            >
              <Download size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <Show when={!tasks.error} fallback={<ResourceError title="CWMP tasks are unavailable" description="The global task history could not be loaded." onRetry={() => void refetch()} />}>
          <Show when={!tasks.loading} fallback={<div class="p-5 space-y-2"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /></div>}>
            <Show when={filteredTasks().length > 0} fallback={<EmptyState compact title="No CWMP tasks found" description={searchQuery() ? 'Try a different search term.' : 'Tasks will appear here after an operator creates an operation for a CPE.'} />}>
              <div class="table-scroll">
                <table class="data-table w-full text-sm min-w-[1240px]">
                  <thead class="bg-base sticky top-0 z-10">
                    <tr class="bg-base">
                      <Show when={isFullAccess()}><th class="px-3 py-2 w-8"><input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={allPageSelected()} onChange={togglePageTaskSelection} aria-label="Select all pending tasks on this page" /></th></Show>
                      <Show when={isTaskColumnVisible('serial_number')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="serial_number" label="Serial number" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('serial_number', 'Serial number')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('type')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="type" label="Type" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('type', 'Type')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('trigger_event')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="trigger_event" label="Trigger event" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('trigger_event', 'Trigger event')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('status')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="status" label="Status" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('status', 'Status')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('created_at')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="created_at" label="Created" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('created_at', 'Created')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('completed_at')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="completed_at" label="Completed" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('completed_at', 'Completed')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('created_by')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="created_by" label="Created by" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('created_by', 'Created by')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('deleted_by')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="deleted_by" label="Deleted by" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('deleted_by', 'Deleted by')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('error')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="error" label="Error" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('error', 'Error')}</SortableHeader></th></Show>
                      <th class="text-right px-4 py-2 text-xs font-medium text-muted">Actions</th>
                      <th class="px-2 py-2"><ColumnVisibility columns={taskColumns} onToggle={toggleTaskColumn} /></th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={pagedTasks()}>
                      {(task) => (
                        <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                          <Show when={isFullAccess()}><td class="px-3 py-2">{task.status === 'pending' ? <input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={selectedTasks().has(task.id)} onChange={() => toggleTaskSelection(task.id)} aria-label={`Select pending task ${task.id}`} /> : null}</td></Show>
                          <Show when={isTaskColumnVisible('serial_number')}><td class="px-4 py-2"><A class="data-link font-mono text-sm" href={`/device/${encodeURIComponent(task.serial_number)}?tab=tasks`} aria-label={`Open tasks for CPE ${task.serial_number}`}>{task.serial_number}</A></td></Show>
                          <Show when={isTaskColumnVisible('type')}><td class="px-4 py-2 text-primary">{task.type}</td></Show>
                          <Show when={isTaskColumnVisible('trigger_event')}><td class="px-4 py-2 text-secondary text-xs">{formatTriggerEvents(task.trigger_events)}</td></Show>
                          <Show when={isTaskColumnVisible('status')}><td class="px-4 py-2"><span class={`badge ${statusBadge(task.status)}`}>{task.status}</span></td></Show>
                          <Show when={isTaskColumnVisible('created_at')}><td class="px-4 py-2 text-muted text-xs">{formatDate(task.created_at)}</td></Show>
                          <Show when={isTaskColumnVisible('completed_at')}><td class="px-4 py-2 text-muted text-xs">{formatDate(task.completed_at)}</td></Show>
                          <Show when={isTaskColumnVisible('created_by')}><td class="px-4 py-2 text-muted text-xs">{task.created_by || '-'}</td></Show>
                          <Show when={isTaskColumnVisible('deleted_by')}><td class="px-4 py-2 text-muted text-xs">{task.deleted_by || '-'}</td></Show>
                          <Show when={isTaskColumnVisible('error')}><td class="px-4 py-2 text-rose-400 text-xs">{task.error_message || '-'}</td></Show>
                          <td class="px-4 py-2 text-right"><div class="inline-flex items-center gap-1"><button type="button" class="btn btn-ghost btn-xs" onClick={() => { setSelectedTask(task); setTaskDetailTab('requested'); }}><Eye size={13} />Details</button><Show when={task.status === 'pending' && isFullAccess()}><button type="button" class="btn btn-ghost btn-xs text-rose-400" disabled={deletingTask() === task.id} onClick={() => void deletePendingTask(task)} aria-label={`Delete pending task ${task.id}`} title="Delete pending task"><Trash2 size={13} /></button></Show></div></td>
                          <td></td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
      <Pagination page={taskPage()} totalPages={totalPages()} totalItems={filteredTasks().length} pageSize={taskPageSize()} onPageChange={setTaskPage} storageKey="global_tasks" onPageSizeChange={(size) => { changeTaskPageSize(size); setTaskPage(0); }} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setTaskPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setTaskPage(0); }} />

      <Show when={selectedTask()}>
        <Dialog title={`Task #${selectedTask()!.id} — ${selectedTask()!.type}`} size="large" onClose={() => setSelectedTask(null)}>
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div><span class="text-muted text-xs">CPE</span><div class="mt-0.5"><A class="data-link font-mono" href={`/device/${encodeURIComponent(selectedTask()!.serial_number)}?tab=tasks`}>{selectedTask()!.serial_number}</A></div></div>
              <div><span class="text-muted text-xs">Status</span><div class="mt-0.5"><span class={`badge ${statusBadge(selectedTask()!.status)}`}>{selectedTask()!.status}</span></div></div>
              <div><span class="text-muted text-xs">Trigger event</span><div class="mt-0.5 text-primary">{formatTriggerEvents(selectedTask()!.trigger_events)}</div></div>
              <div><span class="text-muted text-xs">Created by</span><div class="mt-0.5 text-primary">{selectedTask()!.created_by || '-'}</div></div>
              <Show when={selectedTask()!.deleted_by}><div><span class="text-muted text-xs">Deleted by</span><div class="mt-0.5 text-primary">{selectedTask()!.deleted_by}</div></div></Show>
              <div><span class="text-muted text-xs">Created</span><div class="mt-0.5 text-primary">{formatDate(selectedTask()!.created_at)}</div></div>
              <div><span class="text-muted text-xs">Completed</span><div class="mt-0.5 text-primary">{formatDate(selectedTask()!.completed_at)}</div></div>
            </div>
            <Show when={selectedTask()!.error_message}><div class="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{selectedTask()!.error_message}</div></Show>
            <div class="border-b border-subtle flex gap-0">
              <button type="button" class={`px-4 py-2 text-sm font-medium border-b-2 ${taskDetailTab() === 'requested' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setTaskDetailTab('requested')}>Requested</button>
              <button type="button" class={`px-4 py-2 text-sm font-medium border-b-2 ${taskDetailTab() === 'result' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setTaskDetailTab('result')}>Result</button>
            </div>
            <Show when={taskDetailTab() === 'requested'}>
              <Show when={taskDetails()?.payload != null} fallback={<p class="text-sm text-muted">{taskDetails.loading ? 'Loading task details…' : 'No payload for this task type.'}</p>}>
                <Show when={Array.isArray(taskDetails()?.payload)} fallback={<div class="overflow-x-auto"><table class="data-table w-full text-sm"><thead><tr><th class="text-left px-3 py-2 text-xs font-medium text-muted">Key</th><th class="text-left px-3 py-2 text-xs font-medium text-muted">Value</th></tr></thead><tbody><For each={Object.entries(taskDetails()?.payload as Record<string, unknown>)}>{([key, value]) => <tr class="border-t border-subtle/50"><td class="px-3 py-1.5 font-mono text-xs text-primary">{key}</td><td class="px-3 py-1.5 text-xs">{typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}</td></tr>}</For></tbody></table></div>}>
                  <div class="space-y-1"><For each={taskDetails()?.payload as string[]}>{(param) => <div class="font-mono text-xs text-primary px-3 py-1.5 bg-elevated/50 rounded">{param}</div>}</For></div>
                </Show>
              </Show>
            </Show>
            <Show when={taskDetailTab() === 'result'}>
              <Show when={taskDetails()?.result != null} fallback={<p class="text-sm text-muted">{taskDetails.loading ? 'Loading task details…' : 'No result yet — task may still be pending.'}</p>}>
                <pre class="text-xs font-mono bg-elevated/50 rounded p-3 overflow-x-auto">{JSON.stringify(taskDetails()?.result, null, 2)}</pre>
              </Show>
            </Show>
          </div>
        </Dialog>
      </Show>
    </div>
  );
};

export default Tasks;
