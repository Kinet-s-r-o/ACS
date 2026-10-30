import type { Component } from 'solid-js';
import { createResource, createSignal, For, Show } from 'solid-js';
import { Save } from 'lucide-solid';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { ResourceError } from '../components/ResourceState';
import { useFeedback } from '../components/Feedback';

const groups = [
  { title: 'Housekeeping', fields: [
    { key: 'retention_interval_hours', label: 'Run interval (hours)', min: 1, max: 168, description: 'Time between cleanup runs. Updated settings are applied within one minute.' },
    { key: 'retention_batch_size', label: 'Rows per batch', min: 100, max: 10000, description: 'Maximum rows deleted in one statement for audit, faults, tasks and snapshots.' },
    { key: 'retention_max_batches', label: 'Maximum batches per rule', min: 1, max: 1000, description: 'Limits each cleanup run; remaining expired rows are handled by later runs.' },
  ] },
  { title: 'Operational history', fields: [
    { key: 'retention_audit_days', label: 'Audit logs (days)', min: 0, max: 3650, description: 'Age since the audit event was created.' },
    { key: 'retention_resolved_fault_days', label: 'Resolved CWMP faults (days)', min: 0, max: 3650, description: 'Age since resolution. Active faults are retained.' },
    { key: 'retention_completed_task_days', label: 'Completed CWMP tasks (days)', min: 0, max: 3650, description: 'Age since completion. Pending and sent tasks are retained.' },
    { key: 'retention_failed_task_days', label: 'Failed CWMP tasks (days)', min: 0, max: 3650, description: 'Age since the task was marked completed with a failure.' },
    { key: 'retention_snapshot_days', label: 'Configuration snapshots (days)', min: 0, max: 3650, description: 'Age since snapshot creation. Default: keep all snapshots.' },
    { key: 'retention_device_log_days', label: 'Device logs (days)', min: 0, max: 3650, description: 'Age since a log entry was first received. Default: 30 days.' },
  ] },
  { title: 'Metric history', fields: [
    { key: 'retention_metric_hours', label: 'Raw metric samples (hours)', min: 0, max: 87600, description: 'Retention of individual device metric samples.' },
    { key: 'retention_interface_metric_days', label: 'Interface metric samples (days)', min: 0, max: 3650, description: 'Retention of per-interface samples. Default: keep all samples.' },
    { key: 'retention_metric_5min_days', label: '5-minute aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into 5-minute buckets.' },
    { key: 'retention_metric_1h_days', label: 'Hourly aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into hourly buckets.' },
    { key: 'retention_metric_1d_days', label: 'Daily aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into daily buckets.' },
  ] },
];

const retentionTableGroups = [
  { title: 'Operational history', tables: [
    { table: 'audit_logs', label: 'Audit logs' },
    { table: 'faults', label: 'CWMP faults' },
    { table: 'tasks', label: 'CWMP tasks' },
    { table: 'device_snapshots', label: 'Configuration snapshots' },
    { table: 'device_logs', label: 'Device logs' },
  ] },
  { title: 'Metric history', tables: [
    { table: 'metric_samples', label: 'Raw metric samples' },
    { table: 'interface_metric_samples', label: 'Interface metric samples' },
    { table: 'metric_samples_5min', label: '5-minute aggregates' },
    { table: 'metric_samples_1h', label: 'Hourly aggregates' },
    { table: 'metric_samples_1d', label: 'Daily aggregates' },
  ] },
];

const RetentionSettings: Component = () => {
  const { isFullAccess, hasPermission } = useAuth();
  const { notify } = useFeedback();
  const [settings, { refetch }] = createResource(api.getSettings);
  const [tableStats, { refetch: refetchTableStats }] = createResource(api.getRetentionStats);
  const [activeTab, setActiveTab] = createSignal<'retention' | 'statistics'>('retention');
  const [querySort, setQuerySort] = createSignal<'total_time' | 'mean_time' | 'calls'>('total_time');
  const [queryStats, { refetch: refetchQueryStats }] = createResource(
    () => activeTab() === 'statistics' && hasPermission('database.stats.read') ? querySort() : undefined,
    sort => sort ? api.getDatabaseStatistics(sort) : Promise.resolve(undefined),
  );
  const [draft, setDraft] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const value = (key: string) => draft()[key] ?? settings()?.[key] ?? '';
  const update = (key: string, next: string) => setDraft(previous => ({ ...previous, [key]: next }));
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const values: Record<string, string> = { retention_enabled: value('retention_enabled') };
    for (const field of groups.flatMap(group => group.fields)) {
      const raw = value(field.key);
      const number = Number(raw);
      if (!raw.trim() || !Number.isInteger(number) || number < field.min || number > field.max) {
        notify({ tone: 'error', title: 'Invalid retention value', message: `${field.label}: enter an integer from ${field.min} to ${field.max}.` });
        return;
      }
      values[field.key] = String(number);
    }
    setSaving(true);
    try {
      await api.updateSettings(values);
      await refetch();
      setDraft({});
      notify({ tone: 'success', title: 'DB retention saved', message: 'Housekeeping will apply the settings within one minute.' });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save retention settings', detail: (error as Error).message, persistent: true });
    } finally {
      setSaving(false);
    }
  };

  return <div class="space-y-5">
    <PageHeader title="DB retention" description="Manage database cleanup and inspect query performance." />
    <div class="flex gap-1 border-b border-subtle">
      <button type="button" aria-pressed={activeTab() === 'retention'} class={`px-3 py-2 text-sm border-b-2 ${activeTab() === 'retention' ? 'border-action-primary text-primary' : 'border-transparent text-muted'}`} onClick={() => setActiveTab('retention')}>Retention</button>
      <button type="button" aria-pressed={activeTab() === 'statistics'} class={`px-3 py-2 text-sm border-b-2 ${activeTab() === 'statistics' ? 'border-action-primary text-primary' : 'border-transparent text-muted'}`} onClick={() => setActiveTab('statistics')}>Statistics</button>
    </div>
    <Show when={activeTab() === 'retention'}>
    <div class="space-y-5">
    <Show when={settings.error}><div class="card p-5"><ResourceError title="Retention settings are unavailable" description="Retry loading the configuration." onRetry={() => refetch()} /></div></Show>
    <Show when={!settings.loading && !settings.error} fallback={settings.loading ? <div class="skeleton h-24 w-full" /> : undefined}>
      <form class="space-y-5" onSubmit={save}>
        <div class="card p-5 space-y-3">
          <label for="retention-enabled" class="flex items-center gap-2 text-sm text-primary">
            <input id="retention-enabled" type="checkbox" checked={value('retention_enabled') === 'true'} disabled={!isFullAccess() || saving()} onChange={event => update('retention_enabled', String(event.currentTarget.checked))} />
            Enable database housekeeping
          </label>
          <p class="text-xs text-muted">Set a retention period to 0 to keep that history indefinitely. Shorter periods permanently remove older records on the next cleanup. Disabling housekeeping stops future cleanup runs.</p>
          <p class="text-xs text-muted">Metrics are removed in whole TimescaleDB chunks, so actual retention can exceed the configured period. Cleanup runs have a five-minute time limit.</p>
        </div>
        <For each={groups}>{group => <section class="card p-5">
          <h2 class="text-sm font-medium text-secondary mb-4">{group.title}</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <For each={group.fields}>{field => <div>
              <label for={field.key} class="block text-xs text-muted mb-1.5">{field.label}</label>
              <input id={field.key} type="number" class="input w-full" min={field.min} max={field.max} step="1" required value={value(field.key)} disabled={!isFullAccess() || saving()} aria-describedby={`${field.key}-description`} onInput={event => update(field.key, event.currentTarget.value)} />
              <p id={`${field.key}-description`} class="text-xs text-muted mt-1.5">{field.description}</p>
            </div>}</For>
          </div>
        </section>}</For>
        <Show when={isFullAccess()}><button type="submit" class="btn btn-primary" disabled={saving()}><Save size={14} />{saving() ? 'Saving…' : 'Save retention settings'}</button></Show>
      </form>
    </Show>
    </div>
    </Show>
    <Show when={activeTab() === 'statistics'}>
      <section class="space-y-5" aria-busy={queryStats.loading}>
        <section class="card p-5 space-y-4" aria-busy={tableStats.loading}>
          <div class="flex items-center justify-between gap-3">
            <div><h2 class="text-sm font-medium text-secondary">Database and table usage</h2><p class="text-xs text-muted mt-1">Estimated row counts and on-disk sizes, including indexes.</p></div>
            <button type="button" class="btn btn-secondary text-xs" onClick={() => void refetchTableStats()} disabled={tableStats.loading}>Refresh</button>
          </div>
          <Show when={!tableStats.error} fallback={<ResourceError title="Database usage is unavailable" description="Retry to load current table sizes." onRetry={() => void refetchTableStats()} />}>
            <div class="space-y-5"><For each={retentionTableGroups}>{group => <section aria-label={group.title} class="space-y-3">
              <h3 class="text-sm font-medium text-secondary">{group.title}</h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-px rounded border border-subtle bg-subtle overflow-hidden"><For each={group.tables}>{item => {
                const stats = () => tableStats()?.find(table => table.table === item.table);
                return <div class="bg-surface p-4 min-w-0"><h4 class="text-xs text-muted truncate" title={item.label}>{item.label}</h4>
                  <Show when={stats()} fallback={<div class="text-xs text-muted mt-3">{tableStats.loading ? 'Loading…' : 'No statistics available'}</div>}>{current => <>
                    <div class="text-xl font-semibold font-mono text-primary mt-2 tabular-nums">{current().records.toLocaleString()}</div>
                    <div class="text-xs text-muted mt-1">{(current().size_bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB</div>
                  </>}</Show>
                </div>;
              }}</For></div>
            </section>}</For></div>
          </Show>
        </section>
        <Show when={hasPermission('database.stats.read')}>
        <section class="card p-5 space-y-4">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div><h2 class="text-sm font-medium text-secondary">Query execution</h2><p class="text-xs text-muted mt-1">Aggregated timings for up to 50 statements in the current database.</p></div>
            <div class="flex items-end gap-2">
              <label class="text-xs text-muted">Order by<select class="input mt-1 block" value={querySort()} onChange={event => setQuerySort(event.currentTarget.value as 'total_time' | 'mean_time' | 'calls')}>
                <option value="total_time">Total execution time</option><option value="mean_time">Average execution time</option><option value="calls">Call count</option>
              </select></label>
              <button type="button" class="btn btn-secondary text-xs" onClick={() => void refetchQueryStats()} disabled={queryStats.loading}>Refresh</button>
            </div>
          </div>
          <p class="text-xs text-muted">Query timings are cumulative since the last statistics reset. SQL text is normalized by PostgreSQL and may be unavailable if the database account cannot view it.</p>
          <Show when={!queryStats.error} fallback={<ResourceError title="Query statistics are unavailable" description="Check database permissions and retry." onRetry={() => void refetchQueryStats()} />}>
            <Show when={queryStats()?.available} fallback={queryStats()?.reason ? <div class="border border-subtle p-4 text-sm text-secondary" role="status"><strong>Query tracking is not enabled.</strong><p class="text-xs text-muted mt-1">{queryStats()?.reason}. Enable pg_stat_statements on the PostgreSQL server and install it in this database to view statement timings.</p></div> : <div class="skeleton h-16 w-full" />}>
              <Show when={(queryStats()?.queries.length ?? 0) > 0} fallback={<p class="text-sm text-muted">No statement statistics are available yet.</p>}>
                <p class="text-xs text-muted">Last reset: {queryStats()?.stats_reset ? new Date(queryStats()!.stats_reset!).toLocaleString() : 'unknown'}</p>
                <div class="overflow-x-auto border border-subtle rounded"><table class="w-full text-xs text-left"><thead class="bg-surface text-muted"><tr>
                  <th class="sticky left-0 z-10 bg-surface p-2 min-w-72">Statement</th><th class="p-2 text-right">Calls</th><th class="p-2 text-right">Total ms</th><th class="p-2 text-right">Average ms</th><th class="p-2 text-right">Rows</th><th class="p-2 text-right">Shared reads</th><th class="p-2 text-right">Shared hits</th><th class="p-2 text-right">Temp blocks</th>
                </tr></thead><tbody><For each={queryStats()?.queries}>{query => <tr class="border-t border-subtle align-top">
                  <td class="sticky left-0 z-10 bg-surface p-2 min-w-72"><details><summary class="cursor-pointer text-primary">{query.query ? query.query.slice(0, 160) : `Query ${query.query_id} (text unavailable)`}</summary><pre class="mt-2 max-w-[70vw] overflow-x-auto whitespace-pre-wrap break-all font-mono text-muted">{query.query || 'SQL text is not available to the application database role.'}</pre></details></td>
                  <td class="p-2 text-right font-mono tabular-nums">{query.calls.toLocaleString()}</td><td class="p-2 text-right font-mono tabular-nums">{query.total_time_ms.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td><td class="p-2 text-right font-mono tabular-nums">{query.mean_time_ms.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="p-2 text-right font-mono tabular-nums">{query.rows.toLocaleString()}</td><td class="p-2 text-right font-mono tabular-nums">{query.shared_read_blocks.toLocaleString()}</td><td class="p-2 text-right font-mono tabular-nums">{query.shared_hit_blocks.toLocaleString()}</td><td class="p-2 text-right font-mono tabular-nums">{(query.temp_read_blocks + query.temp_write_blocks).toLocaleString()}</td>
                </tr>}</For></tbody></table></div>
              </Show>
            </Show>
          </Show>
        </section>
        </Show>
      </section>
    </Show>
  </div>;
};

export default RetentionSettings;
