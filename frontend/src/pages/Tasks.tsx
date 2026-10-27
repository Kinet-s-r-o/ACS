import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { Eye, RefreshCw, Search, Trash2, X } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api, type GlobalTask } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColumnFilter from '../components/ColumnFilter';
import Pagination from '../components/Pagination';
import ColumnVisibility from '../components/ColumnVisibility';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/Feedback';
import SortableHeader from '../components/SortableHeader';
import { sortRows, type SortDirection } from '../lib/sorting';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { formatDateTime } from '../lib/dateTime';
import { useColumnVisibility } from '../lib/useColumnVisibility';

const statusBadge = (status: string) => {
  switch (status) {
    case 'completed': return 'badge-success';
    case 'pending': return 'badge-warning';
    case 'sent': return 'bg-sky-500/15 text-sky-400';
    case 'failed': return 'badge-error';
    case 'deleted': return 'bg-zinc-500/15 text-zinc-400';
    default: return 'bg-zinc-700 text-secondary';
  }
};

const formatDate = (value?: string | null) => formatDateTime(value);

const Tasks: Component = () => {
  const { isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.tasks');
  const [selectedTask, setSelectedTask] = createSignal<GlobalTask | null>(null);
  const [taskDetailTab, setTaskDetailTab] = createSignal<'requested' | 'result'>('requested');
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.tasks', {});
  const [sortState, setSortState] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'created_at', direction: 'desc' });
  const handleSort = (column: string) => setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  const [taskPage, setTaskPage] = createSignal(0);
  const { columns: taskColumns, isVisible: isTaskColumnVisible, toggle: toggleTaskColumn } = useColumnVisibility('global_tasks', [
    { id: 'serial_number', label: 'Serial number', visible: true },
    { id: 'type', label: 'Type', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'created_at', label: 'Created', visible: true },
    { id: 'completed_at', label: 'Completed', visible: true },
    { id: 'created_by', label: 'Created by', visible: true },
    { id: 'deleted_by', label: 'Deleted by', visible: true },
    { id: 'error', label: 'Error', visible: true },
  ]);
  const { pageSize: taskPageSize, changePageSize: changeTaskPageSize } = usePageSize('global_tasks', 20);
  const [tasks, { refetch }] = createResource(api.getTasks);
  const [taskDetails] = createResource(() => selectedTask()?.id, (id) => api.getTask(id));
  const [deletingTask, setDeletingTask] = createSignal<number | null>(null);
  const taskCounts = createMemo(() => {
    const counts = { pending: 0, sent: 0, completed: 0, failed: 0, deleted: 0, total: 0 };
    for (const task of tasks() || []) {
      counts.total += 1;
      if (task.status in counts && task.status !== 'total') counts[task.status as keyof Omit<typeof counts, 'total'>] += 1;
    }
    return counts;
  });

  const filteredTasks = createMemo(() => {
    let all = tasks() || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      all = all.filter(task => [task.serial_number, task.type, task.status, task.created_by || '', task.deleted_by || '', task.error_message || '']
        .some(value => value.toLowerCase().includes(query)));
    }
    const filtered = applyColumnFilters(all, columnFilters(), (task, column) => {
      switch (column) {
        case 'serial_number': return task.serial_number;
        case 'type': return task.type;
        case 'status': return task.status;
        case 'created_at': return task.created_at;
        case 'completed_at': return task.completed_at || '';
        case 'created_by': return task.created_by || '';
        case 'deleted_by': return task.deleted_by || '';
        case 'error': return task.error_message || '';
        default: return '';
      }
    });
    return sortRows(filtered, sortState().column, sortState().direction, (task, column) => {
      switch (column) {
        case 'serial_number': return task.serial_number;
        case 'type': return task.type;
        case 'status': return task.status;
        case 'created_at': return task.created_at;
        case 'completed_at': return task.completed_at || '';
        case 'created_by': return task.created_by || '';
        case 'deleted_by': return task.deleted_by || '';
        case 'error': return task.error_message || '';
        default: return '';
      }
    });
  });

  const pagedTasks = createMemo(() => {
    const all = filteredTasks();
    const start = taskPage() * taskPageSize();
    return all.slice(start, start + taskPageSize());
  });

  const totalPages = createMemo(() => Math.ceil(filteredTasks().length / taskPageSize()));
  const applyFilter = (column: string, state: ColumnFilterState | null) => {
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

  return (
    <div class="space-y-5">
      <PageHeader title="CWMP tasks" description="Task history across all CPE devices.">
        <button type="button" class="btn btn-secondary" onClick={() => void refetch()} disabled={tasks.loading}>
          <RefreshCw size={14} class={tasks.loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </PageHeader>

      <dl class="ops-register task-register" aria-label="CWMP task status register" aria-busy={tasks.loading}>
        <div class="ops-register-cell is-warning"><dt>Pending</dt><dd>{taskCounts().pending}</dd><small>Waiting to be sent</small></div>
        <div class="ops-register-cell"><dt>Sent</dt><dd>{taskCounts().sent}</dd><small>Dispatched to CPE</small></div>
        <div class="ops-register-cell is-online"><dt>Completed</dt><dd>{taskCounts().completed}</dd><small>Successfully finished</small></div>
        <div class="ops-register-cell is-offline"><dt>Failed</dt><dd>{taskCounts().failed}</dd><small>Require review</small></div>
        <div class="ops-register-cell"><dt>Deleted</dt><dd>{taskCounts().deleted}</dd><small>Cancelled before dispatch</small></div>
        <div class="ops-register-cell"><dt>Total tasks</dt><dd>{taskCounts().total}</dd><small>All CWMP tasks</small></div>
      </dl>

      <div class="card overflow-hidden">
        <div class="table-panel-toolbar">
            <span><strong>{pagedTasks().length}</strong> visible on this page · <strong>{taskCounts().total}</strong> total CWMP tasks</span>
          <div class="relative">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input type="text" value={searchQuery()} onInput={(event) => { setSearchQuery(event.currentTarget.value); setTaskPage(0); }} placeholder="Search tasks…" class="input pl-9! w-56 text-sm" />
            <Show when={searchQuery()}>
              <button type="button" onClick={() => { setSearchQuery(''); setTaskPage(0); }} class="input-clear" aria-label="Clear search"><X size={12} /></button>
            </Show>
          </div>
        </div>

        <Show when={!tasks.error} fallback={<ResourceError title="CWMP tasks are unavailable" description="The global task history could not be loaded." onRetry={() => void refetch()} />}>
          <Show when={!tasks.loading} fallback={<div class="p-5 space-y-2"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /></div>}>
            <Show when={filteredTasks().length > 0} fallback={<EmptyState compact title="No CWMP tasks found" description={searchQuery() ? 'Try a different search term.' : 'Tasks will appear here after an operator creates an operation for a CPE.'} />}>
              <div class="table-scroll">
                <table class="data-table w-full text-sm min-w-[1240px]">
                  <thead class="bg-base sticky top-0 z-10">
                    <tr class="bg-base">
                      <Show when={isTaskColumnVisible('serial_number')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="serial_number" label="Serial number" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('serial_number', 'Serial number')}</SortableHeader></th></Show>
                      <Show when={isTaskColumnVisible('type')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="type" label="Type" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}>{renderFilter('type', 'Type')}</SortableHeader></th></Show>
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
                          <Show when={isTaskColumnVisible('serial_number')}><td class="px-4 py-2"><A class="data-link font-mono text-sm" href={`/device/${encodeURIComponent(task.serial_number)}?tab=tasks`} aria-label={`Open tasks for CPE ${task.serial_number}`}>{task.serial_number}</A></td></Show>
                          <Show when={isTaskColumnVisible('type')}><td class="px-4 py-2 text-primary">{task.type}</td></Show>
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
