import type { Component } from 'solid-js';
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { ChevronDown, ChevronRight, RefreshCw, RotateCw, Search, Settings, Trash2, X } from 'lucide-solid';
import { api, type BulkSummonSettings, type SystemTask, type SystemTaskStatus, type SystemTaskSummary, type SystemTaskType } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/Feedback';
import Dialog from '../components/Dialog';
import PageHeader from '../components/PageHeader';
import Pagination from '../components/Pagination';
import ColumnFilter from '../components/ColumnFilter';
import type { ColumnFilterState } from '../lib/filters';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { usePageSize } from '../lib/usePageSize';
import { formatDateTime } from '../lib/dateTime';

const taskGroups: { type: SystemTaskType; label: string; description: string }[] = [
  { type: 'summon_from_cpe', label: 'Summon from CPE', description: 'Individual Summon requests started from a CPE record.' },
  { type: 'bulk_summon', label: 'Bulk Summon', description: 'Summon requests processed with the configured concurrency and interval.' },
  { type: 'bulk_restart', label: 'Bulk Restart', description: 'Restart requests processed with the configured concurrency and interval.' },
];

const statusLabels: SystemTaskStatus[] = ['pending', 'processing', 'waiting', 'completed', 'failed'];

const taskColumns = [
  { id: 'id', label: 'ID', numeric: true },
  { id: 'serial_number', label: 'CPE' },
  { id: 'status', label: 'Status' },
  { id: 'attempts', label: 'Attempts', numeric: true },
  { id: 'created_at', label: 'Created' },
  { id: 'created_by', label: 'Username' },
  { id: 'cwmp_task_id', label: 'CWMP task', numeric: true },
  { id: 'error', label: 'Error' },
];

const statusClass = (status: SystemTaskStatus) => {
  switch (status) {
    case 'completed': return 'badge-success';
    case 'failed': return 'badge-error';
    case 'pending': return 'badge-warning';
    case 'processing': return 'badge-warning';
    case 'waiting': return '';
  }
};

const SystemTasks: Component = () => {
  const { can } = useAuth();
  const { notify } = useFeedback();
  const canConfigure = () => can(`settings.system_tasks.${settingsType()}`, 'edit');
  const canManageTasks = () => expandedType() !== null && can(`settings.system_tasks.${expandedType()}`, 'edit');
  const canClearTasks = (type: SystemTaskType) => can(`settings.system_tasks.${type}`, 'delete');
  const [expandedType, setExpandedType] = createSignal<SystemTaskType | null>(null);
  const [taskSearch, setTaskSearch] = createSignal('');
  const [taskPage, setTaskPage] = createSignal(0);
  const [groupFilters, setGroupFilters] = createSignal<Partial<Record<SystemTaskType, Record<string, ColumnFilterState>>>>({});
  const columnFilters = createMemo(() => groupFilters()[expandedType()!] ?? {});
  const updateFilter = (column: string, state: ColumnFilterState | null) => {
    const type = expandedType();
    if (!type) return;
    setTaskPage(0);
    setGroupFilters(previous => {
      const filters = { ...previous[type] };
      if (state) filters[column] = state;
      else delete filters[column];
      return { ...previous, [type]: filters };
    });
  };
  const clearFilters = () => {
    const type = expandedType();
    if (!type) return;
    setTaskPage(0);
    setGroupFilters(previous => ({ ...previous, [type]: {} }));
  };
  const hasFilters = () => taskSearch().trim() !== '' || Object.keys(columnFilters()).length > 0;
  const { pageSize, changePageSize } = usePageSize('system_tasks', 20);
  const [summary, { refetch: refetchSummary }] = createResource<SystemTaskSummary>(() => api.getSystemTaskSummary());
  const [tasks, { refetch: refetchTasks }] = createResource(
    () => expandedType() ? ({ type: expandedType()!, page: taskPage(), size: pageSize(), search: taskSearch(), filters: columnFilters() }) : false,
    query => api.getSystemTasks(query.type, query.size, query.page * query.size, query.search, 'created_at', 'desc', query.filters),
  );
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsType, setSettingsType] = createSignal<'bulk_summon' | 'bulk_restart'>('bulk_summon');
  const settingsLabel = () => settingsType() === 'bulk_restart' ? 'Bulk Restart' : 'Bulk Summon';
  const [settings, { refetch: refetchSettings }] = createResource(() => settingsOpen() && canConfigure() ? settingsType() : false, type => type === 'bulk_restart' ? api.getBulkRestartSettings() : api.getBulkSummonSettings());
  const [settingsForm, setSettingsForm] = createSignal<BulkSummonSettings>({ max_in_flight: 2, interval_seconds: 5, contact_timeout_seconds: 120 });
  const [savingSettings, setSavingSettings] = createSignal(false);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [clearType, setClearType] = createSignal<SystemTaskType | null>(null);
  const [clearStatuses, setClearStatuses] = createSignal<SystemTaskStatus[]>(['completed', 'failed']);
  const clearLabel = () => taskGroups.find(group => group.type === clearType())?.label ?? 'system';
  const clearCount = () => clearStatuses().reduce((sum, status) => sum + countFor(summaryCounts(clearType()!), status), 0);
  const closeClearDialog = () => { if (!busyAction()) setClearType(null); };

  const taskData = createMemo((previous: { tasks: SystemTask[]; total: number } | undefined) => tasks.error ? previous : tasks.latest);
  const pageTotal = createMemo(() => taskData()?.total ?? 0);
  const totalPages = createMemo(() => Math.ceil(pageTotal() / pageSize()));
  const rows = createMemo(() => taskData()?.tasks ?? []);

  const summaryCounts = (type: SystemTaskType) => summary()?.[type] ?? {};
  const countFor = (counts: Partial<Record<SystemTaskStatus, number>>, status: SystemTaskStatus) => counts[status] ?? 0;
  const groupTotal = (counts: Partial<Record<SystemTaskStatus, number>>) => statusLabels.reduce((sum, status) => sum + countFor(counts, status), 0);

  const openGroup = (type: SystemTaskType) => {
    if (expandedType() === type) {
      setExpandedType(null);
      return;
    }
    setExpandedType(type);
    setTaskPage(0);
    setTaskSearch('');
  };

  const refreshGroup = async () => {
    await Promise.all([refetchSummary(), ...(expandedType() ? [refetchTasks()] : [])]);
  };

  onMount(() => {
    const timer = window.setInterval(() => { void refreshGroup(); }, 5000);
    onCleanup(() => window.clearInterval(timer));
  });

  createEffect(() => {
    const current = settings();
    if (current) setSettingsForm(current);
  });

  const openSettings = async (type: 'bulk_summon' | 'bulk_restart') => {
    setSettingsType(type);
    setSettingsOpen(true);
    try {
      const current = type === 'bulk_restart' ? await api.getBulkRestartSettings() : await api.getBulkSummonSettings();
      if (current) setSettingsForm(current);
    } catch {
      // The resource error state exposes a retry action in the modal.
    }
  };

  const saveSettings = async () => {
    const value = settingsForm();
    if (!Number.isInteger(value.max_in_flight) || value.max_in_flight < 1 || value.max_in_flight > 20) {
      notify({ tone: 'error', title: 'Invalid concurrency', message: 'Choose between 1 and 20 CPEs in flight.' });
      return;
    }
    if (!Number.isInteger(value.interval_seconds) || value.interval_seconds < 1 || value.interval_seconds > 300) {
      notify({ tone: 'error', title: 'Invalid interval', message: 'Choose an interval from 1 to 300 seconds.' });
      return;
    }
    if (!Number.isInteger(value.contact_timeout_seconds) || value.contact_timeout_seconds < 10 || value.contact_timeout_seconds > 3600) {
      notify({ tone: 'error', title: 'Invalid CPE contact timeout', message: 'Choose a timeout from 10 to 3600 seconds.' });
      return;
    }
    setSavingSettings(true);
    try {
      const saved = settingsType() === 'bulk_restart' ? await api.saveBulkRestartSettings(value) : await api.saveBulkSummonSettings(value);
      setSettingsForm(saved);
      setSettingsOpen(false);
      notify({ tone: 'success', title: `${settingsLabel()} settings saved`, message: 'The worker will use the new limits for subsequent dispatches.' });
    } catch (error) {
      notify({ tone: 'error', title: `Could not save ${settingsLabel()} settings`, detail: (error as Error).message, persistent: true });
    } finally {
      setSavingSettings(false);
    }
  };

  const retryTask = async (task: SystemTask) => {
    setBusyAction(`retry-${task.id}`);
    try {
      await api.retrySystemTask(task.id);
      notify({ tone: 'info', title: `${task.type === 'bulk_restart' ? 'Restart' : 'Summon'} task queued for retry`, message: `${task.serial_number} will be processed again.` });
      await refreshGroup();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not retry system task', detail: (error as Error).message, persistent: true });
    } finally {
      setBusyAction(null);
    }
  };

  const clearSelectedTasks = async () => {
    const type = clearType();
    if (!type || !canClearTasks(type) || busyAction() || clearStatuses().length === 0) return;
    setBusyAction(`clear-${type}`);
    try {
      const result = await api.clearSystemTasks(type, clearStatuses());
      setClearType(null);
      setTaskPage(0);
      notify({ tone: 'success', title: 'Selected tasks cleared', message: `${result.deleted} records deleted.${result.skipped ? ` ${result.skipped} tasks already sent to CPEs were kept.` : ''}` });
      await refreshGroup();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not clear selected tasks', detail: (error as Error).message, persistent: true });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="System tasks" description="Monitor individual Summon requests and bulk Summon or Restart operations processed by the ACS worker." />

      <Show when={summary.error}>
        <div class="card"><ResourceError title="System task queue is unavailable" description="ACS could not load system task counts. Retry without changing the queue." onRetry={() => void refetchSummary()} /></div>
      </Show>

      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-2.5 bg-elevated text-xs font-semibold text-secondary">Queue</div>
        <For each={taskGroups.filter(group => can(`settings.system_tasks.${group.type}`, 'read'))}>{(group) => {
          const counts = () => summaryCounts(group.type);
          const expanded = () => expandedType() === group.type;
          return (
            <section class="system-task-group">
              <div class="system-task-group-header">
                <button type="button" class="system-task-group-toggle" onClick={() => openGroup(group.type)} aria-expanded={expanded()}>
                  {expanded() ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                  <span class="system-task-group-title">{group.label}</span>
                  <div class="system-task-counts" aria-label={`${groupTotal(counts())} ${group.label} tasks`}>
                    <For each={statusLabels.filter(status => countFor(counts(), status) > 0)}>{status => (
                      <span class={`badge ${statusClass(status)}`}>{status}: {countFor(counts(), status)}</span>
                    )}</For>
                    <Show when={groupTotal(counts()) === 0}><span class="text-muted text-xs">No tasks yet</span></Show>
                  </div>
                </button>
                <div class="system-task-group-actions">
                  <button type="button" class="icon-button" onClick={() => void refreshGroup()} title={`Refresh ${group.label} queue`} aria-label={`Refresh ${group.label} queue`}>
                    <RefreshCw size={14} aria-hidden="true" />
                  </button>
                  <Show when={(group.type === 'bulk_summon' || group.type === 'bulk_restart') && can(`settings.system_tasks.${group.type}`, 'edit')}>
                    <button type="button" class="icon-button" onClick={() => void openSettings(group.type as 'bulk_summon' | 'bulk_restart')} title={`${group.label} settings`} aria-label={`${group.label} settings`}>
                      <Settings size={14} aria-hidden="true" />
                    </button>
                  </Show>
                  <Show when={canClearTasks(group.type)}>
                    <button type="button" class="icon-button text-error" onClick={() => { setClearStatuses(['completed', 'failed']); setClearType(group.type); }} disabled={busyAction() !== null} title={`Clear ${group.label} tasks`} aria-label={`Clear ${group.label} tasks`}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </Show>
                </div>
              </div>

              <Show when={expanded()}>
                <div class="system-task-group-description">{group.description}</div>
                <div class="table-panel-toolbar">
                  <span><strong>{rows().length}</strong> visible · <strong>{pageTotal()}</strong> {group.label} tasks</span>
                  <div class="relative w-full sm:w-72">
                    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                    <input
                      type="text"
                      value={taskSearch()}
                      onInput={event => { setTaskSearch(event.currentTarget.value); setTaskPage(0); }}
                      placeholder="Search serial, username, or error…"
                      aria-label={`Search ${group.label} tasks`}
                      class="input w-full pl-9!"
                    />
                    <Show when={taskSearch()}><button type="button" class="input-clear" onClick={() => { setTaskSearch(''); setTaskPage(0); }} aria-label="Clear system task search"><X size={12} /></button></Show>
                  </div>
                </div>
                <Show when={tasks.error}>
                  <div class="p-4"><ResourceError title="System task records are unavailable" description="Retry the list request. The queue continues processing in the background." onRetry={() => void refetchTasks()} /></div>
                </Show>
                <Show when={taskData() !== undefined}>
                    <div class="overflow-x-auto table-scroll">
                      <table class="data-table w-full text-sm min-w-[950px]">
                        <thead><tr class="border-b border-subtle bg-surface/50">
                          <For each={taskColumns}>{column => (
                            <th data-column-order-id={`${column.label.toLowerCase()}#0`} class="text-left px-3 py-2.5 text-xs font-medium text-muted">
                              <div class="flex items-center gap-1.5">
                                <span>{column.label}</span>
                                <ColumnFilter columnId={column.id} label={column.label} numeric={column.numeric} active={columnFilters()[column.id] ?? null} onApply={state => updateFilter(column.id, state)} />
                              </div>
                            </th>
                          )}</For>
                          <th data-column-order-id="actions#0" data-column-fixed="actions" class="text-right px-3 py-2.5 text-xs font-medium text-muted">Actions</th>
                        <th data-column-fixed="visibility" data-column-order-id="__visibility#0" class="px-2 py-2" aria-label="Column visibility"></th></tr></thead>
                        <tbody>
                          <Show when={rows().length === 0}>
                            <tr><td colspan={taskColumns.length + 2} class="p-4">
                              <EmptyState title={hasFilters() ? 'No system tasks match these filters' : `No ${group.label} tasks`} description={hasFilters() ? 'Change or clear the search and column filters to see matching tasks.' : 'Tasks created from CPE actions will appear here.'} action={hasFilters() ? <button type="button" class="btn btn-secondary" onClick={() => { setTaskSearch(''); clearFilters(); }}>Clear search and filters</button> : undefined} />
                            </td></tr>
                          </Show>
                          <For each={rows()}>{task => (
                            <tr class="border-b border-subtle">
                              <td data-column-order-id="id#0" class="px-3 py-2.5 font-mono text-xs text-secondary">{task.id}</td>
                              <td data-column-order-id="cpe#0" class="px-3 py-2.5"><A class="text-accent hover:underline font-mono text-xs" href={`/device/${encodeURIComponent(task.serial_number)}`}>{task.serial_number}</A></td>
                              <td data-column-order-id="status#0" class="px-3 py-2.5"><span class={`badge ${statusClass(task.status)}`}>{task.status}</span></td>
                              <td data-column-order-id="attempts#0" class="px-3 py-2.5 font-mono text-xs">{task.attempts}</td>
                              <td data-column-order-id="created#0" class="px-3 py-2.5 text-xs text-secondary whitespace-nowrap">{formatDateTime(task.created_at)}</td>
                              <td data-column-order-id="username#0" class="px-3 py-2.5 text-xs text-secondary">{task.created_by || '—'}</td>
                              <td data-column-order-id="cwmp task#0" class="px-3 py-2.5 font-mono text-xs">{task.cwmp_task_id ?? '—'}</td>
                              <td data-column-order-id="error#0" class="px-3 py-2.5 text-xs text-error max-w-[280px] truncate" title={task.error_message}>{task.error_message || '—'}</td>
                              <td data-column-fixed="actions" data-column-order-id="actions#0" class="px-3 py-2.5 text-right">
                                <Show when={task.status === 'failed' && canManageTasks()}>
                                  <button type="button" class="icon-button" onClick={() => void retryTask(task)} disabled={busyAction() === `retry-${task.id}`} title={`Retry failed ${group.type === 'bulk_restart' ? 'Restart' : 'Summon'}`} aria-label={`Retry ${group.type === 'bulk_restart' ? 'Restart' : 'Summon'} for ${task.serial_number}`}><RotateCw size={14} aria-hidden="true" /></button>
                                </Show>
                              </td>
                            <td data-column-fixed="visibility" data-column-order-id="__visibility#0" class="px-2 py-2"></td></tr>
                          )}</For>
                        </tbody>
                      </table>
                    </div>
                    <Pagination page={taskPage()} totalPages={totalPages()} totalItems={pageTotal()} pageSize={pageSize()} onPageChange={setTaskPage} storageKey="system_tasks" onPageSizeChange={size => { changePageSize(size); setTaskPage(0); }} filters={columnFilters()} onClearFilters={clearFilters} onRemoveFilter={column => updateFilter(column, null)} />
                </Show>
                <Show when={tasks.loading && taskData() === undefined}><div class="p-4 space-y-3"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div></Show>
              </Show>
            </section>
          );
        }}</For>
      </div>

      <Show when={clearType()}>
        <Dialog title={`Clear ${clearLabel()} tasks?`} description="Choose which task statuses to delete from this queue. This applies to the whole group, including records outside the current page or search." onClose={closeClearDialog} size="small" actions={<>
          <button type="button" class="btn btn-secondary" onClick={closeClearDialog} disabled={busyAction() !== null}>Cancel</button>
          <button type="button" class="btn btn-danger" onClick={() => void clearSelectedTasks()} disabled={busyAction() !== null || clearStatuses().length === 0 || !canClearTasks(clearType()!)}>{busyAction() ? 'Deleting…' : `Delete selected tasks (${clearCount()})`}</button>
        </>}>
          <fieldset class="space-y-3" disabled={busyAction() !== null}>
            <legend class="mb-3 text-sm font-medium text-secondary">Task statuses</legend>
            <For each={['pending', 'completed', 'failed'] as SystemTaskStatus[]}>{status => <label class="flex items-center gap-3 text-sm text-secondary">
              <input type="checkbox" checked={clearStatuses().includes(status)} onChange={event => setClearStatuses(current => event.currentTarget.checked ? [...current, status] : current.filter(value => value !== status))} />
              <span class="capitalize">{status}</span><span class="text-muted">({countFor(summaryCounts(clearType()!), status)})</span>
            </label>}</For>
          </fieldset>
          <p class="mt-4 text-xs text-muted">Processing and Waiting tasks are kept because they may already be running on a CPE.</p>
          <Show when={clearStatuses().includes('pending')}><p class="mt-3 text-sm text-warning">Pending tasks will be cancelled and deleted, including linked CWMP requests that have not been sent. Automatic snapshots can queue new tasks while their schedule is enabled.</p></Show>
          <p class="mt-3 text-xs text-error">Deletion is permanent. Existing snapshots are kept.</p>
        </Dialog>
      </Show>

      <Show when={settingsOpen()}>
        <Dialog title={`${settingsLabel()} settings`} description="Control dispatch pacing, concurrent CPEs, and how long each task waits for its CPE to connect." onClose={() => setSettingsOpen(false)} size="small" actions={<>
          <button type="button" class="btn btn-secondary" onClick={() => setSettingsOpen(false)} disabled={savingSettings()}>Cancel</button>
          <button type="button" class="btn btn-primary" onClick={() => void saveSettings()} disabled={savingSettings() || settings.loading}>{savingSettings() ? 'Saving…' : 'Save settings'}</button>
        </>}>
          <Show when={settings.error}><ResourceError title={`${settingsLabel()} settings are unavailable`} description="Retry loading the current processor limits." onRetry={() => void refetchSettings()} /></Show>
          <Show when={!settings.error}>
            <div class="space-y-4">
              <label class="block text-xs text-secondary" for="bulk-summon-max-in-flight">Maximum CPEs in flight
                <input id="bulk-summon-max-in-flight" type="number" min="1" max="20" step="1" class="input mt-1.5" value={settingsForm().max_in_flight} onInput={event => setSettingsForm(value => ({ ...value, max_in_flight: Number(event.currentTarget.value) }))} disabled={savingSettings()} />
                <span class="block mt-1 text-muted">1–20 CPEs may be waiting for their CWMP task at the same time.</span>
              </label>
              <label class="block text-xs text-secondary" for="bulk-summon-interval">Interval between CPEs (seconds)
                <input id="bulk-summon-interval" type="number" min="1" max="300" step="1" class="input mt-1.5" value={settingsForm().interval_seconds} onInput={event => setSettingsForm(value => ({ ...value, interval_seconds: Number(event.currentTarget.value) }))} disabled={savingSettings()} />
                <span class="block mt-1 text-muted">1–300 seconds between {settingsLabel()} dispatches. Defaults: 2 in flight, 5 seconds apart.</span>
              </label>
              <label class="block text-xs text-secondary" for="bulk-summon-contact-timeout">Wait for CPE contact (seconds)
                <input id="bulk-summon-contact-timeout" type="number" min="10" max="3600" step="1" class="input mt-1.5" value={settingsForm().contact_timeout_seconds} onInput={event => setSettingsForm(value => ({ ...value, contact_timeout_seconds: Number(event.currentTarget.value) }))} disabled={savingSettings()} />
                <span class="block mt-1 text-muted">10–3600 seconds. If no Inform arrives in time, the task fails and its pending CWMP task is cancelled. Default: 120 seconds.</span>
              </label>
            </div>
          </Show>
        </Dialog>
      </Show>
    </div>
  );
};

export default SystemTasks;
