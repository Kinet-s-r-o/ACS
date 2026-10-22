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
  ] },
  { title: 'Metric history', fields: [
    { key: 'retention_metric_hours', label: 'Raw metric samples (hours)', min: 0, max: 87600, description: 'Retention of individual device metric samples.' },
    { key: 'retention_interface_metric_days', label: 'Interface metric samples (days)', min: 0, max: 3650, description: 'Retention of per-interface samples. Default: keep all samples.' },
    { key: 'retention_metric_5min_days', label: '5-minute aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into 5-minute buckets.' },
    { key: 'retention_metric_1h_days', label: 'Hourly aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into hourly buckets.' },
    { key: 'retention_metric_1d_days', label: 'Daily aggregates (days)', min: 0, max: 3650, description: 'Retention of metric values aggregated into daily buckets.' },
  ] },
];

const RetentionSettings: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify } = useFeedback();
  const [settings, { refetch }] = createResource(api.getSettings);
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
    <PageHeader title="DB retention" description="Control automatic cleanup of database history." />
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
  </div>;
};

export default RetentionSettings;
