import type { Component } from 'solid-js';
import { createResource, createSignal, For, Show } from 'solid-js';
import { Download, Save } from 'lucide-solid';
import { api, type DatabaseQuerySort } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { ResourceError } from '../components/ResourceState';
import { useFeedback } from '../components/Feedback';
import SortableHeader from '../components/SortableHeader';
import type { SortDirection } from '../lib/sorting';
import ColumnFilter from '../components/ColumnFilter';
import type { ColumnFilterState } from '../lib/filters';
import { createPersistedJsonSignal } from '../lib/storage';

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
    { key: 'retention_metric_5min_days', label: '15-minute aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into 15-minute buckets.' },
    { key: 'retention_metric_1h_days', label: 'Hourly aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into hourly buckets.' },
    { key: 'retention_metric_1d_days', label: 'Daily aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into daily buckets.' },
  ] },
  { title: 'Interface metric history', fields: [
    { key: 'retention_interface_metric_days', label: 'Raw interface metric samples (days)', min: 0, max: 3650, description: 'Retention of individual per-interface samples. 0 keeps all raw samples.' },
    { key: 'retention_interface_metric_15min_days', label: '15-minute aggregates (days)', min: 0, max: 3650, description: 'Retention of per-interface values aggregated into 15-minute buckets.' },
    { key: 'retention_interface_metric_1h_days', label: 'Hourly aggregates (days)', min: 0, max: 3650, description: 'Retention of per-interface values aggregated into hourly buckets.' },
    { key: 'retention_interface_metric_1d_days', label: 'Daily aggregates (days)', min: 0, max: 3650, description: 'Retention of per-interface values aggregated into daily buckets.' },
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
    { table: 'metric_samples_15min', label: '15-minute aggregates' },
    { table: 'metric_samples_1h', label: 'Hourly aggregates' },
    { table: 'metric_samples_1d', label: 'Daily aggregates' },
  ] },
  { title: 'Interface metric history', tables: [
    { table: 'interface_metric_samples', label: 'Raw interface metric samples' },
    { table: 'interface_metric_samples_15min', label: '15-minute aggregates' },
    { table: 'interface_metric_samples_1h', label: 'Hourly aggregates' },
    { table: 'interface_metric_samples_1d', label: 'Daily aggregates' },
  ] },
];

const RetentionSettings: Component = () => {
  const { hasPermission } = useAuth();
  const { notify } = useFeedback();
  const [settings, { refetch }] = createResource(api.getSettings);
  const [tableStats, { refetch: refetchTableStats }] = createResource(api.getRetentionStats);
  const [compression, { refetch: refetchCompression }] = createResource(api.getCompressionStatus);
  const compressionState = () => compression.error ? undefined : compression();
  const canWrite = () => hasPermission('settings.write');
  const [activeTab, setActiveTab] = createSignal<'retention' | 'statistics'>('retention');
  const [querySort, setQuerySort] = createSignal<{ column: DatabaseQuerySort; direction: SortDirection }>({ column: 'total_time', direction: 'desc' });
  const [queryFilters, setQueryFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.database-query-statements', {});
  const [queryStats, { refetch: refetchQueryStats }] = createResource(
    () => activeTab() === 'statistics' && hasPermission('database.stats.read') ? { sort: querySort(), filters: queryFilters() } : undefined,
    request => request ? api.getDatabaseStatistics(request.sort.column, request.sort.direction, request.filters) : Promise.resolve(undefined),
  );
  const [draft, setDraft] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const [compressionAgeUnitOverride, setCompressionAgeUnitOverride] = createSignal<'hours' | 'days' | null>(null);
  const value = (key: string) => draft()[key] ?? settings()?.[key] ?? '';
  const update = (key: string, next: string) => setDraft(previous => ({ ...previous, [key]: next }));
  const compressionAgeUnit = () => compressionAgeUnitOverride() ?? (Number(value('compression_metric_after_days')) < 1 ? 'hours' : 'days');
  const compressionAgeDisplay = () => {
    const days = Number(value('compression_metric_after_days'));
    const amount = compressionAgeUnit() === 'hours' ? days * 24 : days;
    return Number.isFinite(amount) ? String(Number(amount.toPrecision(8))) : '';
  };
  const formatCompressionAge = (days: number) => days < 1
    ? `${Number((days * 24).toPrecision(4))} hours`
    : `${days.toLocaleString(undefined, { maximumFractionDigits: 2 })} days`;
  const handleQuerySort = (column: string) => setQuerySort(current => ({
    column: column as DatabaseQuerySort,
    direction: current.column === column && current.direction === 'desc' ? 'asc' : 'desc',
  }));
  const applyQueryFilter = (column: string, state: ColumnFilterState | null) => setQueryFilters(previous => {
    const next = { ...previous };
    if (state) next[column] = state;
    else delete next[column];
    return next;
  });
  const exportQueryStatsCSV = () => {
    const headers = ['Statement', 'Calls', 'Total ms', 'Average ms', 'Rows', 'Shared reads', 'Shared hits', 'Temp blocks'];
    const escapeCsvValue = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = (queryStats()?.queries ?? []).map(query => [
      query.query || `Query ${query.query_id} (text unavailable)`,
      query.calls,
      query.total_time_ms,
      query.mean_time_ms,
      query.rows,
      query.shared_read_blocks,
      query.shared_hit_blocks,
      query.temp_read_blocks + query.temp_write_blocks,
    ]);
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(escapeCsvValue).join(';')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'query-execution.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const values: Record<string, string> = { retention_enabled: value('retention_enabled') };
    if (compressionState()?.available) {
      const days = Number(value('compression_metric_after_days'));
      if (!Number.isFinite(days) || days < 1 / 24 || days > 3650) {
        notify({ tone: 'error', title: 'Invalid compression age', message: 'Enter between 1/24 day (one hour) and 3650 days. Fractions of a day are allowed.' });
        return;
      }
      values.compression_metric_enabled = value('compression_metric_enabled');
      values.compression_metric_after_days = String(days);
    }
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
      await refetchCompression();
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
            <input id="retention-enabled" type="checkbox" checked={value('retention_enabled') === 'true'} disabled={!canWrite() || saving()} onChange={event => update('retention_enabled', String(event.currentTarget.checked))} />
            Enable database housekeeping
          </label>
          <p class="text-xs text-muted">Set a retention period to 0 to keep that history indefinitely. Shorter periods permanently remove older records on the next cleanup. Disabling housekeeping stops future cleanup runs.</p>
          <p class="text-xs text-muted">Metrics are removed in whole TimescaleDB chunks, so actual retention can exceed the configured period. Cleanup runs have a five-minute time limit.</p>
        </div>
        <section class="card p-5 space-y-4" aria-label="History compression" aria-busy={compression.loading}>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-sm font-medium text-secondary">History compression</h2>
            <button type="button" class="btn btn-secondary text-xs" disabled={compression.loading} onClick={() => void refetchCompression()}>Refresh compression status</button>
          </div>
          <Show when={compression.error}><ResourceError title="Compression status is unavailable" description="Retry loading the database compression status." onRetry={() => void refetchCompression()} /></Show>
          <Show when={compressionState() && !compressionState()?.available}><p class="text-xs text-muted" role="status">{compressionState()?.reason}</p></Show>
          <label for="compression-metric-enabled" class="flex items-center gap-2 text-sm text-primary">
            <input id="compression-metric-enabled" type="checkbox" checked={value('compression_metric_enabled') === 'true'} disabled={!canWrite() || saving() || !compressionState()?.available} onChange={event => update('compression_metric_enabled', String(event.currentTarget.checked))} />
            Enable automatic metric history compression
          </label>
          <div class="max-w-sm">
            <label for="compression-metric-after-days" class="block text-xs text-muted mb-1.5">Compress metric data older than</label>
            <div class="flex gap-2">
              <input id="compression-metric-after-days" type="number" class="input min-w-0 flex-1" min={compressionAgeUnit() === 'hours' ? 1 : 1 / 24} max={compressionAgeUnit() === 'hours' ? 87600 : 3650} step="any" required value={compressionAgeDisplay()} disabled={!canWrite() || saving() || !compressionState()?.available} aria-describedby="compression-age-description" onInput={event => {
                const amount = Number(event.currentTarget.value);
                update('compression_metric_after_days', String(compressionAgeUnit() === 'hours' ? amount / 24 : amount));
              }} />
              <select class="input compression-age-unit" aria-label="Compression age unit" value={compressionAgeUnit()} disabled={!canWrite() || saving() || !compressionState()?.available} onChange={event => setCompressionAgeUnitOverride(event.currentTarget.value as 'hours' | 'days')}>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
            <p id="compression-age-description" class="text-xs text-muted mt-1.5">The existing default is 2 hours. Entire data chunks must be older than this age before they are compressed.</p>
          </div>
          <p class="text-xs text-muted">Applies independently of database housekeeping. Settings are applied within one minute; compression then runs in the background. Disabling it stops future compression and keeps already compressed history readable.</p>
          <p class="text-xs text-muted">Aggregates need a longer delay to preserve their refresh window: at least 8 days for 15-minute aggregates, 31 days for hourly aggregates, and 366 days for daily aggregates. History deleted sooner by retention will not be compressed.</p>
          <Show when={compressionState()?.available}>
            <div class="space-y-2" aria-label="Actual compression policies"><For each={compressionState()?.tables}>{table => <div class="flex flex-wrap justify-between gap-2 border-t border-subtle pt-2 text-xs">
              <span class="text-secondary">{table.label}</span>
              <span class="text-muted">{!table.present ? 'Not available' : table.scheduled ? `Enabled · after ${formatCompressionAge(table.after_days)}` : 'Automatic compression off'} · {table.compressed_chunks}/{table.total_chunks} chunks compressed</span>
            </div>}</For></div>
          </Show>
          <div class="border-t border-subtle pt-3 space-y-2">
            <h3 class="text-sm font-medium text-secondary">Operational history</h3>
            <p class="text-xs text-muted">PostgreSQL automatically compresses eligible large text and JSON values in the existing tables. This preserves searching and does not use an age threshold. The metric compression switch does not change operational history.</p>
            <For each={compressionState()?.operational}>{table => <p class="text-xs text-muted">{retentionTableGroups[0].tables.find(item => item.table === table.table)?.label ?? table.table}: {table.compressible_columns > 0 ? `${table.compressible_columns} columns allow automatic large-value compression` : 'No columns configured for large-value compression'}</p>}</For>
          </div>
        </section>
        <For each={groups}>{group => <section class="card p-5">
          <h2 class="text-sm font-medium text-secondary mb-4">{group.title}</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <For each={group.fields}>{field => <div>
              <label for={field.key} class="block text-xs text-muted mb-1.5">{field.label}</label>
              <input id={field.key} type="number" class="input w-full" min={field.min} max={field.max} step="1" required value={value(field.key)} disabled={!canWrite() || saving()} aria-describedby={`${field.key}-description`} onInput={event => update(field.key, event.currentTarget.value)} />
              <p id={`${field.key}-description`} class="text-xs text-muted mt-1.5">{field.description}</p>
            </div>}</For>
          </div>
        </section>}</For>
        <Show when={canWrite()}><button type="submit" class="btn btn-primary" disabled={saving()}><Save size={14} />{saving() ? 'Saving…' : 'Save retention settings'}</button></Show>
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
            <div><h2 class="text-sm font-medium text-secondary">Query execution</h2><p class="text-xs text-muted mt-1">Aggregated timings for up to 50 statements in the current database. Select a column heading to sort; select it again to reverse the order.</p></div>
            <div class="flex gap-2">
              <Show when={Object.keys(queryFilters()).length > 0}><button type="button" class="btn btn-secondary text-xs" onClick={() => setQueryFilters({})}>Clear filters</button></Show>
              <button type="button" class="btn btn-secondary text-xs" onClick={exportQueryStatsCSV} disabled={queryStats.loading || (queryStats()?.queries.length ?? 0) === 0} title="Export query execution as CSV"><Download size={14} aria-hidden="true" />Export CSV</button>
              <button type="button" class="btn btn-secondary text-xs" onClick={() => void refetchQueryStats()} disabled={queryStats.loading}>Refresh</button>
            </div>
          </div>
          <p class="text-xs text-muted">Query timings are cumulative since the last statistics reset. SQL text is normalized by PostgreSQL and may be unavailable if the database account cannot view it.</p>
          <Show when={!queryStats.error} fallback={<ResourceError title="Query statistics are unavailable" description="Check database permissions and retry." onRetry={() => void refetchQueryStats()} />}>
            <Show when={queryStats()?.available} fallback={queryStats()?.reason ? <div class="border border-subtle p-4 text-sm text-secondary" role="status"><strong>Query tracking is not enabled.</strong><p class="text-xs text-muted mt-1">{queryStats()?.reason}. Enable pg_stat_statements on the PostgreSQL server and install it in this database to view statement timings.</p></div> : <div class="skeleton h-16 w-full" />}>
              <Show when={(queryStats()?.queries.length ?? 0) > 0} fallback={<p class="text-sm text-muted">{Object.keys(queryFilters()).length > 0 ? 'No statements match the active filters.' : 'No statement statistics are available yet.'}</p>}>
                <p class="text-xs text-muted">Last reset: {queryStats()?.stats_reset ? new Date(queryStats()!.stats_reset!).toLocaleString() : 'unknown'}</p>
                <div class="overflow-x-auto border border-subtle rounded"><table class="data-table w-full text-xs text-left"><thead class="bg-surface text-muted"><tr>
                  <th scope="col" class="sticky left-0 z-10 bg-surface p-2 min-w-72"><SortableHeader column="query" label="Statement" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort}><ColumnFilter columnId="query" label="Statement" active={queryFilters().query || null} onApply={state => applyQueryFilter('query', state)} /></SortableHeader></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="calls" label="Calls" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="calls" label="Calls" numeric active={queryFilters().calls || null} onApply={state => applyQueryFilter('calls', state)} /></div></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="total_time" label="Total ms" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="total_time" label="Total ms" numeric active={queryFilters().total_time || null} onApply={state => applyQueryFilter('total_time', state)} /></div></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="mean_time" label="Average ms" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="mean_time" label="Average ms" numeric active={queryFilters().mean_time || null} onApply={state => applyQueryFilter('mean_time', state)} /></div></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="rows" label="Rows" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="rows" label="Rows" numeric active={queryFilters().rows || null} onApply={state => applyQueryFilter('rows', state)} /></div></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="shared_read_blocks" label="Shared reads" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="shared_read_blocks" label="Shared reads" numeric active={queryFilters().shared_read_blocks || null} onApply={state => applyQueryFilter('shared_read_blocks', state)} /></div></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="shared_hit_blocks" label="Shared hits" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="shared_hit_blocks" label="Shared hits" numeric active={queryFilters().shared_hit_blocks || null} onApply={state => applyQueryFilter('shared_hit_blocks', state)} /></div></th>
                  <th scope="col" class="p-2 text-right"><div class="flex items-center justify-end gap-1.5"><SortableHeader column="temp_blocks" label="Temp blocks" sortBy={querySort().column} direction={querySort().direction} onSort={handleQuerySort} /><ColumnFilter columnId="temp_blocks" label="Temp blocks" numeric active={queryFilters().temp_blocks || null} onApply={state => applyQueryFilter('temp_blocks', state)} /></div></th>
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
