import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { Eye, RefreshCw, Search, X } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api, type GlobalTask } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColumnFilter from '../components/ColumnFilter';
import Pagination from '../components/Pagination';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';

const statusBadge = (status: string) => {
  switch (status) {
    case 'completed': return 'badge-success';
    case 'pending': return 'badge-warning';
    case 'sent': return 'bg-sky-500/15 text-sky-400';
    case 'failed': return 'badge-error';
    default: return 'bg-zinc-700 text-secondary';
  }
};

const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString('id-ID') : '-';

const Tasks: Component = () => {
  const [searchQuery, setSearchQuery] = createSignal('');
  const [selectedTask, setSelectedTask] = createSignal<GlobalTask | null>(null);
  const [taskDetailTab, setTaskDetailTab] = createSignal<'requested' | 'result'>('requested');
  const [columnFilters, setColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [taskPage, setTaskPage] = createSignal(0);
  const { pageSize: taskPageSize, changePageSize: changeTaskPageSize } = usePageSize('global_tasks', 20);
  const [tasks, { refetch }] = createResource(api.getTasks);

  const filteredTasks = createMemo(() => {
    let all = tasks() || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      all = all.filter(task => [task.serial_number, task.type, task.status, task.created_by || '', task.error_message || '']
        .some(value => value.toLowerCase().includes(query)));
    }
    return applyColumnFilters(all, columnFilters(), (task, column) => {
      switch (column) {
        case 'serial_number': return task.serial_number;
        case 'type': return task.type;
        case 'status': return task.status;
        case 'created_at': return task.created_at;
        case 'completed_at': return task.completed_at || '';
        case 'created_by': return task.created_by || '';
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

  return (
    <div class="space-y-5">
      <PageHeader title="CWMP tasks" description="Task history across all CPE devices.">
        <button type="button" class="btn btn-secondary" onClick={() => void refetch()} disabled={tasks.loading}>
          <RefreshCw size={14} class={tasks.loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </PageHeader>

      <div class="card overflow-hidden">
        <div class="p-5 border-b border-subtle flex items-center justify-between">
          <h2 class="text-sm font-medium text-secondary">Task History ({filteredTasks().length})</h2>
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
                <table class="data-table w-full text-sm min-w-[1120px]">
                  <thead class="bg-base sticky top-0 z-10">
                    <tr class="bg-base">
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">Serial number{renderFilter('serial_number', 'Serial number')}</div></th>
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">Type{renderFilter('type', 'Type')}</div></th>
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">Status{renderFilter('status', 'Status')}</div></th>
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">Created{renderFilter('created_at', 'Created')}</div></th>
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">Completed{renderFilter('completed_at', 'Completed')}</div></th>
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">User{renderFilter('created_by', 'User')}</div></th>
                      <th class="text-left px-4 py-2 text-xs font-medium text-muted"><div class="flex items-center gap-1.5">Error{renderFilter('error', 'Error')}</div></th>
                      <th class="text-right px-4 py-2 text-xs font-medium text-muted">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={pagedTasks()}>
                      {(task) => (
                        <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                          <td class="px-4 py-2"><A class="data-link font-mono text-sm" href={`/device/${encodeURIComponent(task.serial_number)}?tab=tasks`} aria-label={`Open tasks for CPE ${task.serial_number}`}>{task.serial_number}</A></td>
                          <td class="px-4 py-2 text-primary">{task.type}</td>
                          <td class="px-4 py-2"><span class={`badge ${statusBadge(task.status)}`}>{task.status}</span></td>
                          <td class="px-4 py-2 text-muted text-xs">{formatDate(task.created_at)}</td>
                          <td class="px-4 py-2 text-muted text-xs">{formatDate(task.completed_at)}</td>
                          <td class="px-4 py-2 text-muted text-xs">{task.created_by || '-'}</td>
                          <td class="px-4 py-2 text-rose-400 text-xs">{task.error_message || '-'}</td>
                          <td class="px-4 py-2 text-right"><button type="button" class="btn btn-ghost btn-xs" onClick={() => { setSelectedTask(task); setTaskDetailTab('requested'); }}><Eye size={13} />Details</button></td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <div class="px-4 py-3"><Pagination page={taskPage()} totalPages={totalPages()} totalItems={filteredTasks().length} pageSize={taskPageSize()} onPageChange={setTaskPage} storageKey="global_tasks" onPageSizeChange={(size) => { changeTaskPageSize(size); setTaskPage(0); }} /></div>
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={selectedTask()}>
        <Dialog title={`Task #${selectedTask()!.id} — ${selectedTask()!.type}`} size="large" onClose={() => setSelectedTask(null)}>
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div><span class="text-muted text-xs">CPE</span><div class="mt-0.5"><A class="data-link font-mono" href={`/device/${encodeURIComponent(selectedTask()!.serial_number)}?tab=tasks`}>{selectedTask()!.serial_number}</A></div></div>
              <div><span class="text-muted text-xs">Status</span><div class="mt-0.5"><span class={`badge ${statusBadge(selectedTask()!.status)}`}>{selectedTask()!.status}</span></div></div>
              <div><span class="text-muted text-xs">User</span><div class="mt-0.5 text-primary">{selectedTask()!.created_by || '-'}</div></div>
              <div><span class="text-muted text-xs">Created</span><div class="mt-0.5 text-primary">{formatDate(selectedTask()!.created_at)}</div></div>
              <div><span class="text-muted text-xs">Completed</span><div class="mt-0.5 text-primary">{formatDate(selectedTask()!.completed_at)}</div></div>
            </div>
            <Show when={selectedTask()!.error_message}><div class="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{selectedTask()!.error_message}</div></Show>
            <div class="border-b border-subtle flex gap-0">
              <button type="button" class={`px-4 py-2 text-sm font-medium border-b-2 ${taskDetailTab() === 'requested' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setTaskDetailTab('requested')}>Requested</button>
              <button type="button" class={`px-4 py-2 text-sm font-medium border-b-2 ${taskDetailTab() === 'result' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setTaskDetailTab('result')}>Result</button>
            </div>
            <Show when={taskDetailTab() === 'requested'}>
              <Show when={selectedTask()!.payload != null} fallback={<p class="text-sm text-muted">No payload for this task type.</p>}>
                <Show when={Array.isArray(selectedTask()!.payload)} fallback={<div class="overflow-x-auto"><table class="data-table w-full text-sm"><thead><tr><th class="text-left px-3 py-2 text-xs font-medium text-muted">Key</th><th class="text-left px-3 py-2 text-xs font-medium text-muted">Value</th></tr></thead><tbody><For each={Object.entries(selectedTask()!.payload as Record<string, unknown>)}>{([key, value]) => <tr class="border-t border-subtle/50"><td class="px-3 py-1.5 font-mono text-xs text-primary">{key}</td><td class="px-3 py-1.5 text-xs">{typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}</td></tr>}</For></tbody></table></div>}>
                  <div class="space-y-1"><For each={selectedTask()!.payload as string[]}>{(param) => <div class="font-mono text-xs text-primary px-3 py-1.5 bg-elevated/50 rounded">{param}</div>}</For></div>
                </Show>
              </Show>
            </Show>
            <Show when={taskDetailTab() === 'result'}>
              <Show when={selectedTask()!.result != null} fallback={<p class="text-sm text-muted">No result yet — task may still be pending.</p>}>
                <pre class="text-xs font-mono bg-elevated/50 rounded p-3 overflow-x-auto">{JSON.stringify(selectedTask()!.result, null, 2)}</pre>
              </Show>
            </Show>
          </div>
        </Dialog>
      </Show>
    </div>
  );
};

export default Tasks;
