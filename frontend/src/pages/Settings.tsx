import type { Component } from 'solid-js';
import { createSignal, createResource, createMemo, Show, For } from 'solid-js';
import { Key, LogOut, Edit, Trash2, Save, Activity } from 'lucide-solid';
import { api, type GaugeStyle, type MetricDefinition } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColorSwatch from '../components/ColorSwatch';
import { useFeedback } from '../components/Feedback';
import { useAuth } from '../lib/auth';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { useColumnVisibility } from '../lib/useColumnVisibility';

const EMPTY_METRIC: Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'> = {
  name: '',
  description: '',
  device_type_match: '*',
  parameter_name: '',
  unit: '',
  source: 'passive',
  active: true,
  store_history: true,
  group: '',
  color: '',
  axis: 'left',
  transform: '',
  multiplier: 1,
  unit_scale: '',
  health: false,
  health_order: 0,
  health_size: 'small',
  warn_threshold: null,
  critical_threshold: null,
  threshold_direction: 'higher_is_worse',
  display_format: 'number',
  gauge_animated: true,
  gauge_min: null,
  gauge_max: null,
  gauge_arc: '270',
  gauge_pointer: true,
  gauge_style: 'basic',
  thresholds: [],
  chart_type: 'line',
};

const Settings: Component = () => {
  const { user, isFullAccess, logout } = useAuth();
  const { notify, confirm } = useFeedback();
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);

  // Change password
  const [showPasswordModal, setShowPasswordModal] = createSignal(false);
  const [passwordForm, setPasswordForm] = createSignal({ current: '', newPass: '', confirm: '' });

  // Metrics CRUD
  const [metrics, { refetch: refetchMetrics }] = createResource(api.getMetricDefinitions);
  const [editingMetric, setEditingMetric] = createSignal<MetricDefinition | null>(null);
  const [showMetricModal, setShowMetricModal] = createSignal(false);
  const [metricForm, setMetricForm] = createSignal<Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>>(EMPTY_METRIC);
  const [metricInitialSnapshot, setMetricInitialSnapshot] = createSignal('');
  const [metricTab, setMetricTab] = createSignal<'metric' | 'health'>('metric');
  const [columnFilters, setColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const { columns, isVisible, toggle } = useColumnVisibility('settings', [
    { id: 'name', label: 'Name', visible: true },
    { id: 'parameter_name', label: 'Parameter', visible: true },
    { id: 'device_type_match', label: 'Device Match', visible: true },
    { id: 'source', label: 'Source', visible: true },
    { id: 'unit', label: 'Unit', visible: true },
    { id: 'group', label: 'Group', visible: true },
    { id: 'active', label: 'Active', visible: true },
  ]);

  const getFilterValue = (def: MetricDefinition, colId: string): string => {
    switch (colId) {
      case 'name': return def.name || '';
      case 'parameter_name': return def.parameter_name || '';
      case 'device_type_match': return def.device_type_match || '';
      case 'source': return def.source || '';
      case 'unit': return def.unit || '';
      case 'group': return def.group || '';
      case 'active': return def.active ? 'Yes' : 'No';
      default: return '';
    }
  };

  const filteredMetrics = createMemo(() => {
    const all = metrics() || [];
    return applyColumnFilters(all, columnFilters(), getFilterValue);
  });

  const metricFormDirty = () => metricInitialSnapshot() !== '' && JSON.stringify(metricForm()) !== metricInitialSnapshot();
  const closeMetricModal = async () => {
    if (metricFormDirty() && !await confirm({ title: 'Discard unsaved metric changes?', description: 'The changes in this metric form have not been saved.', confirmLabel: 'Discard changes', tone: 'primary' })) return;
    setShowMetricModal(false);
  };

  const openEditMetric = (def: MetricDefinition) => {
    setEditingMetric(def);
    setMetricForm({
      name: def.name,
      description: def.description,
      device_type_match: def.device_type_match,
      parameter_name: def.parameter_name,
      unit: def.unit,
      source: def.source,
      active: def.active,
      store_history: def.store_history !== false,
      group: def.group,
      color: def.color,
      axis: def.axis,
      transform: def.transform,
      multiplier: def.multiplier,
      unit_scale: def.unit_scale,
      health: def.health,
      health_order: def.health_order ?? 0,
      health_size: def.health_size || 'small',
      warn_threshold: def.warn_threshold,
      critical_threshold: def.critical_threshold,
      threshold_direction: def.threshold_direction,
      display_format: def.display_format,
      gauge_animated: def.gauge_animated,
      gauge_min: def.gauge_min ?? null,
      gauge_max: def.gauge_max ?? null,
      gauge_arc: def.gauge_arc || '270',
      gauge_pointer: def.gauge_pointer ?? true,
      gauge_style: def.gauge_style || 'basic',
      thresholds: def.thresholds || [],
      chart_type: def.chart_type || 'line',
    });
    setMetricInitialSnapshot(JSON.stringify(metricForm()));
    setMetricTab('metric');
    setShowMetricModal(true);
  };

  const handleSaveMetric = async () => {
    const form = metricForm();
    if (!form.name.trim() || !form.parameter_name.trim()) {
      notify({ tone: 'error', title: 'Missing fields', message: 'Name and parameter name are required.' });
      return;
    }
    setPendingAction('save-metric');
    try {
      if (editingMetric()) {
        await api.updateMetricDefinition(editingMetric()!.id, form);
        notify({ tone: 'success', title: 'Metric updated', message: `"${form.name}" has been updated.` });
      } else {
        await api.createMetricDefinition(form);
        notify({ tone: 'success', title: 'Metric created', message: `"${form.name}" is now active.` });
      }
      setShowMetricModal(false);
      refetchMetrics();
    } catch (err) {
      notify({ tone: 'error', title: 'Metric save failed', message: (err as Error).message, persistent: true });
    } finally {
      setPendingAction(null);
    }
  };

  const handleDeleteMetric = async (def: MetricDefinition) => {
    if (!await confirm({ title: `Delete metric "${def.name}"?`, description: 'Historical samples remain but will no longer be collected.', confirmLabel: 'Delete metric', tone: 'danger' })) return;
    setPendingAction(`delete-metric-${def.id}`);
    try {
      await api.deleteMetricDefinition(def.id);
      notify({ tone: 'success', title: 'Metric deleted', message: `"${def.name}" has been removed.` });
      refetchMetrics();
    } catch (err) {
      notify({ tone: 'error', title: 'Delete failed', message: (err as Error).message, persistent: true });
    } finally {
      setPendingAction(null);
    }
  };

  const handleChangePassword = async () => {
    if (passwordForm().newPass !== passwordForm().confirm) {
      notify({ tone: 'error', title: 'Passwords do not match', message: 'The new password and confirmation are different. The current password is unchanged.', persistent: true });
      return;
    }
    if (pendingAction()) return;
    setPendingAction('change-password');
    try {
      await api.changePassword(passwordForm().current, passwordForm().newPass);
      notify({ tone: 'success', title: 'Password changed', message: 'Sign in again with the new password.' });
      setShowPasswordModal(false);
      setPasswordForm({ current: '', newPass: '', confirm: '' });
      logout();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not change password', message: 'The current password remains active. Check the current password and try again.', detail: (error as Error).message, persistent: true });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="System Settings" description="Account, operator access, and CWMP connection configuration." />

      {/* Account Section */}
      <div class="card p-5">
        <h2 class="text-sm font-medium text-secondary mb-4">Account</h2>
        <div class="space-y-4">
          <div>
            <div class="block text-xs text-muted mb-1.5">Username</div>
            <div class="text-sm text-primary">{user()?.username}</div>
          </div>
          <div>
            <div class="block text-xs text-muted mb-1.5">Role</div>
            <span class={`badge ${isFullAccess() ? 'badge-success' : 'badge-warning'}`}>
              {isFullAccess() ? 'Full Access' : 'Read Only'}
            </span>
          </div>
          <div class="flex items-center gap-3 pt-2">
            <button
              onClick={() => setShowPasswordModal(true)}
              class="btn btn-secondary text-xs"
              disabled={pendingAction() !== null}
            >
              <Key size={12} />
              Change password
            </button>
            <button
              onClick={logout}
              class="btn btn-ghost text-xs text-red-400"
            >
              <LogOut size={12} />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Metrics Section */}
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
            <Activity size={14} />
            Metric Definitions
          </h2>
          <a href="/settings/provisioning" class="btn btn-primary text-xs">Manage metrics by template</a>
        </div>
        <Show when={metrics.loading}>
          <div class="skeleton h-16 w-full" />
        </Show>
        <Show when={!metrics.loading && (metrics() || []).length === 0}>
          <p class="text-sm text-muted">Metrics are configured separately for each provisioning template.</p>
        </Show>
        <Show when={!metrics.loading && (metrics() || []).length > 0}>
          <div class="overflow-x-auto">
            <table class="data-table w-full text-sm">
              <thead class="sticky top-0 bg-base z-10">
                <tr class="border-b-2 border-subtle bg-base">
                  <Show when={isVisible('name')}>
                    <th class="text-left px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Name
                        <ColumnFilter columnId="name" label="Name" active={columnFilters()['name'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['name'] = s; else delete n['name']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isVisible('parameter_name')}>
                    <th class="text-left px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Parameter
                        <ColumnFilter columnId="parameter_name" label="Parameter" active={columnFilters()['parameter_name'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['parameter_name'] = s; else delete n['parameter_name']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isVisible('device_type_match')}>
                    <th class="text-left px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Device Match
                        <ColumnFilter columnId="device_type_match" label="Device Match" active={columnFilters()['device_type_match'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['device_type_match'] = s; else delete n['device_type_match']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isVisible('source')}>
                    <th class="text-left px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Source
                        <ColumnFilter columnId="source" label="Source" active={columnFilters()['source'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['source'] = s; else delete n['source']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isVisible('unit')}>
                    <th class="text-left px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Unit
                        <ColumnFilter columnId="unit" label="Unit" active={columnFilters()['unit'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['unit'] = s; else delete n['unit']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isVisible('group')}>
                    <th class="text-left px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Group
                        <ColumnFilter columnId="group" label="Group" active={columnFilters()['group'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['group'] = s; else delete n['group']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isVisible('active')}>
                    <th class="text-center px-3 py-2.5 font-semibold text-primary">
                      <div class="flex items-center gap-1.5">Active
                        <ColumnFilter columnId="active" label="Active" active={columnFilters()['active'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['active'] = s; else delete n['active']; return n; }); }} />
                      </div>
                    </th>
                  </Show>
                  <Show when={isFullAccess()}>
                    <th class="text-right px-3 py-2.5 font-semibold text-primary"></th>
                  </Show>
                  <th class="px-2 py-2.5"><ColumnVisibility columns={columns} onToggle={toggle} activeFilterCount={Object.keys(columnFilters()).length} onClearFilters={() => setColumnFilters({})} /></th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredMetrics()}>
                  {(def) => (
                    <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                      <Show when={isVisible('name')}>
                        <td class="px-3 py-2.5 text-primary font-medium">
                          {def.name}
                          <Show when={def.description}>
                            <div class="text-[10px] text-muted mt-0.5">{def.description}</div>
                          </Show>
                        </td>
                      </Show>
                      <Show when={isVisible('parameter_name')}><td class="px-3 py-2.5 text-secondary font-mono text-xs">{def.parameter_name}</td></Show>
                      <Show when={isVisible('device_type_match')}><td class="px-3 py-2.5 text-secondary font-mono text-xs">{def.device_type_match}</td></Show>
                      <Show when={isVisible('source')}>
                        <td class="px-3 py-2.5">
                          <span class={`badge ${def.source === 'active' ? 'badge-warning' : def.source === 'universal' ? 'badge-success' : ''}`}>{def.source}</span>
                        </td>
                      </Show>
                      <Show when={isVisible('unit')}><td class="px-3 py-2.5 text-secondary">{def.unit || '-'}</td></Show>
                      <Show when={isVisible('group')}>
                        <td class="px-3 py-2.5 text-secondary">
                          <div class="flex items-center gap-1.5">
                            <span class="chart-color-swatch w-2.5 h-2.5 rounded-[2px]" data-dynamic-style="chart-color" style={{ '--chart-color': def.color || '#475569' } as any} />
                            <span class="text-xs">{def.group || '-'}</span>
                          </div>
                        </td>
                      </Show>
                      <Show when={isVisible('active')}>
                        <td class="px-3 py-2.5 text-center">
                          <span class={`badge ${def.active ? 'badge-success' : 'badge-error'}`}>{def.active ? 'Yes' : 'No'}</span>
                        </td>
                      </Show>
                      <Show when={isFullAccess()}>
                        <td class="px-3 py-2.5 text-right">
                          <div class="flex gap-1 justify-end">
                            <button onClick={() => openEditMetric(def)} class="icon-button" aria-label={`Edit ${def.name}`}>
                              <Edit size={13} />
                            </button>
                            <button onClick={() => void handleDeleteMetric(def)} disabled={pendingAction() === `delete-metric-${def.id}`} class="icon-button hover:text-rose-400" aria-label={`Delete ${def.name}`}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </Show>
                      <td class="px-2 py-2.5"></td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>

      {/* Metric Modal */}
      <Show when={showMetricModal()}>
        <Dialog
          title={editingMetric() ? `Edit metric: ${editingMetric()!.name}` : 'New metric definition'}
          description="Defines a CWMP parameter to collect as a time-series metric. Device match uses glob patterns (e.g. 'Huawei/*'). Source: passive = from Inform, active = polled via GPV, universal = both."
          size="large"
          headerBadge={<Show when={metricFormDirty()}><span class="dialog-header-badge" role="status">Unsaved</span></Show>}
          onClose={() => void closeMetricModal()}
          actions={
            <>
              <button onClick={() => void closeMetricModal()} class="btn btn-secondary">Cancel</button>
              <button onClick={() => void handleSaveMetric()} disabled={pendingAction() === 'save-metric'} class="btn btn-primary">
                <Save size={14} />
                {pendingAction() === 'save-metric' ? 'Saving…' : 'Save metric'}
              </button>
            </>
          }
        >
          <div class="space-y-4">
            <div class="flex gap-1 border-b border-zinc-800 pb-2">
              <button type="button" onClick={() => setMetricTab('metric')} class={`px-3 py-1 rounded text-xs font-medium transition-colors ${metricTab() === 'metric' ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'}`}>Metric</button>
              <button type="button" onClick={() => setMetricTab('health')} class={`px-3 py-1 rounded text-xs font-medium transition-colors ${metricTab() === 'health' ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'}`}>Health</button>
            </div>
            <Show when={metricTab() === 'metric'}>
            <div>
              <label for="metric-name" class="block text-xs text-muted mb-1.5">Name</label>
              <input id="metric-name" type="text" value={metricForm().name} onInput={(e) => setMetricForm(f => ({ ...f, name: e.currentTarget.value }))} class="input w-full" placeholder="e.g. CPU Usage" required />
            </div>
            <div>
              <label for="metric-description" class="block text-xs text-muted mb-1.5">Description</label>
              <input id="metric-description" type="text" value={metricForm().description} onInput={(e) => setMetricForm(f => ({ ...f, description: e.currentTarget.value }))} class="input w-full" placeholder="Optional description" />
            </div>
            <div>
              <label for="metric-param" class="block text-xs text-muted mb-1.5">CWMP Parameter Name</label>
              <input id="metric-param" type="text" value={metricForm().parameter_name} onInput={(e) => setMetricForm(f => ({ ...f, parameter_name: e.currentTarget.value }))} class="input w-full font-mono text-xs" placeholder="e.g. InternetGatewayDevice.DeviceInfo.X_HW_CPUUsage" required />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="metric-device-match" class="block text-xs text-muted mb-1.5">Device Type Match</label>
                <input id="metric-device-match" type="text" value={metricForm().device_type_match} onInput={(e) => setMetricForm(f => ({ ...f, device_type_match: e.currentTarget.value }))} class="input w-full font-mono text-xs" placeholder="* (all devices)" />
              </div>
              <div>
                <label for="metric-unit" class="block text-xs text-muted mb-1.5">Unit</label>
                <input id="metric-unit" type="text" value={metricForm().unit} onInput={(e) => setMetricForm(f => ({ ...f, unit: e.currentTarget.value }))} class="input w-full" placeholder="e.g. %, °C, dBm" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="metric-source" class="block text-xs text-muted mb-1.5">Collection Source</label>
                <select id="metric-source" value={metricForm().source} onChange={(e) => setMetricForm(f => ({ ...f, source: e.currentTarget.value as 'passive' | 'active' | 'universal' }))} class="input w-full">
                  <option value="passive">Passive (from Inform)</option>
                  <option value="active">Active (polled via GPV)</option>
                  <option value="universal">Universal (both)</option>
                </select>
              </div>
              <div>
                <label for="metric-active" class="block text-xs text-muted mb-1.5">Active</label>
                <select id="metric-active" value={metricForm().active ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, active: e.currentTarget.value === 'true' }))} class="input w-full">
                  <option value="true">Yes — collect this metric</option>
                  <option value="false">No — paused</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="metric-group" class="block text-xs text-muted mb-1.5">Chart / Health Group</label>
                <input id="metric-group" type="text" value={metricForm().group} onInput={(e) => setMetricForm(f => ({ ...f, group: e.currentTarget.value }))} class="input w-full" placeholder="e.g. throughput (optional)" />
              </div>
              <div>
                <label for="metric-axis" class="block text-xs text-muted mb-1.5">Y-Axis</label>
                <select id="metric-axis" value={metricForm().axis} onChange={(e) => setMetricForm(f => ({ ...f, axis: e.currentTarget.value as 'left' | 'right' }))} class="input w-full">
                  <option value="left">Left (default)</option>
                  <option value="right">Right (secondary)</option>
                </select>
              </div>
            </div>
            <div>
              <div class="block text-xs text-muted mb-1.5">Line Color</div>
              <ColorSwatch value={metricForm().color} onChange={(c) => setMetricForm(f => ({ ...f, color: c }))} />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="metric-transform" class="block text-xs text-muted mb-1.5">Transform</label>
                <select id="metric-transform" value={metricForm().transform} onChange={(e) => setMetricForm(f => ({ ...f, transform: e.currentTarget.value }))} class="input w-full">
                  <option value="">None (raw value)</option>
                  <option value="rate">Rate (delta / time)</option>
                </select>
              </div>
              <div>
                <label for="metric-multiplier" class="block text-xs text-muted mb-1.5">Multiplier</label>
                <input id="metric-multiplier" type="number" min="0" step="any" value={metricForm().multiplier} onInput={(e) => setMetricForm(f => ({ ...f, multiplier: parseFloat(e.currentTarget.value) || 0 }))} placeholder="1" class="input w-full" />
              </div>
              <div>
                <label for="metric-unit-scale" class="block text-xs text-muted mb-1.5">Unit Scale</label>
                <select id="metric-unit-scale" value={metricForm().unit_scale} onChange={(e) => setMetricForm(f => ({ ...f, unit_scale: e.currentTarget.value }))} class="input w-full">
                  <option value="">None (raw)</option>
                  <option value="auto">Auto (K/M/G/T)</option>
                  <option value="bytes">Bytes (KB/MB/GB/TB)</option>
                  <option value="bits">Bits (Kb/Mb/Gb/Tb)</option>
                  <option value="pps">Packets per second (pps/Kpps/Mpps/Gpps)</option>
                </select>
              </div>
            </div>
            </Show>
            <Show when={metricTab() === 'health'}>
            <div>
              <div class="block text-xs font-medium text-secondary mb-2">Health indicator</div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label for="metric-health" class="block text-xs text-muted mb-1.5">Show in Device Health</label>
                  <select id="metric-health" value={metricForm().health ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, health: e.currentTarget.value === 'true' }))} class="input w-full">
                    <option value="false">No — Metrics tab only</option>
                    <option value="true">Yes — Metrics tab + Device Health</option>
                  </select>
                </div>
                <div>
                  <label for="metric-store-history" class="block text-xs text-muted mb-1.5">Store metric history</label>
                  <select id="metric-store-history" value={metricForm().store_history ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, store_history: e.currentTarget.value === 'true', transform: e.currentTarget.value === 'false' ? '' : f.transform }))} class="input w-full">
                    <option value="true">Yes — include in Metrics charts</option>
                    <option value="false">No — current value only</option>
                  </select>
                  <p class="text-xs text-muted mt-1">Current-only metrics use the latest device parameter and are not saved as time-series samples.</p>
                </div>
                <div>
                  <label for="metric-display-format" class="block text-xs text-muted mb-1.5">Display format</label>
                  <select id="metric-display-format" value={metricForm().display_format} onChange={(e) => setMetricForm(f => ({ ...f, display_format: e.currentTarget.value as 'number' | 'uptime' | 'gauge' }))} class="input w-full">
                    <option value="number">Number</option>
                    <option value="uptime">Uptime (d h m s)</option>
                    <option value="gauge">Gauge graph</option>
                  </select>
                </div>
              <div>
                <label for="metric-health-order" class="block text-xs text-muted mb-1.5">Display order</label>
                <input id="metric-health-order" type="number" min="0" step="1" value={metricForm().health_order} onInput={(e) => setMetricForm(f => ({ ...f, health_order: Math.max(0, parseInt(e.currentTarget.value, 10) || 0) }))} placeholder="0" class="input w-full" />
              </div>
              <div>
                <label for="metric-health-size" class="block text-xs text-muted mb-1.5">Element size</label>
                <select id="metric-health-size" value={metricForm().health_size} onChange={(e) => setMetricForm(f => ({ ...f, health_size: e.currentTarget.value as 'small' | 'medium' | 'large' }))} class="input w-full">
                  <option value="small">Small (1/3 width)</option>
                  <option value="medium">Medium (1/2 width)</option>
                  <option value="large">Large (full width)</option>
                </select>
              </div>
                <div>
                  <label for="metric-warn" class="block text-xs text-muted mb-1.5">Warn threshold</label>
                  <input id="metric-warn" type="number" step="any" value={metricForm().warn_threshold ?? ''} onInput={(e) => setMetricForm(f => ({ ...f, warn_threshold: e.currentTarget.value === '' ? null : parseFloat(e.currentTarget.value) }))} placeholder="optional" class="input w-full" />
                </div>
                <div>
                  <label for="metric-critical" class="block text-xs text-muted mb-1.5">Critical threshold</label>
                  <input id="metric-critical" type="number" step="any" value={metricForm().critical_threshold ?? ''} onInput={(e) => setMetricForm(f => ({ ...f, critical_threshold: e.currentTarget.value === '' ? null : parseFloat(e.currentTarget.value) }))} placeholder="optional" class="input w-full" />
                </div>
                <div>
                  <label for="metric-threshold-dir" class="block text-xs text-muted mb-1.5">Worse when</label>
                  <select id="metric-threshold-dir" value={metricForm().threshold_direction} onChange={(e) => setMetricForm(f => ({ ...f, threshold_direction: e.currentTarget.value as 'higher_is_worse' | 'lower_is_worse' }))} class="input w-full">
                    <option value="higher_is_worse">Value is higher</option>
                    <option value="lower_is_worse">Value is lower</option>
                  </select>
                </div>
                <div>
                  <label for="metric-gauge-animated" class="block text-xs text-muted mb-1.5">Animate gauge</label>
                  <select id="metric-gauge-animated" value={metricForm().gauge_animated ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, gauge_animated: e.currentTarget.value === 'true' }))} class="input w-full">
                    <option value="true">Yes — animate on load</option>
                    <option value="false">No — static</option>
                  </select>
                </div>
                <div>
                  <div class="block text-xs text-muted mb-1.5">Gauge style (ECharts)</div>
                  <select value={metricForm().gauge_style} onChange={(e) => { const style = e.currentTarget.value as GaugeStyle; setMetricForm(f => ({ ...f, gauge_style: style, gauge_arc: style === 'ring' ? '360' : style === 'temperature' ? '220' : ['speed', 'stage', 'grade', 'barometer'].includes(style) ? '180' : '270' })); }} class="input w-full">
                    <option value="basic">Gauge Basic</option><option value="simple">Simple Gauge</option><option value="speed">Speed Gauge</option><option value="progress">Progress Gauge</option><option value="stage">Stage Speed Gauge</option><option value="grade">Grade Gauge</option><option value="multi">Multi Title Gauge</option><option value="temperature">Temperature Gauge</option><option value="ring">Ring Gauge</option><option value="barometer">Gauge Barometer</option>
                  </select>
                </div>
              </div>
            </div>
            </Show>
          </div>
        </Dialog>
      </Show>

      {/* Password Modal */}
      <Show when={showPasswordModal()}>
        <Dialog title="Change operator password" description="Changing the password ends the current session and requires a new sign-in." size="small" onClose={() => { if (!pendingAction()) setShowPasswordModal(false); }}>
            <form class="space-y-4" onSubmit={(event) => { event.preventDefault(); void handleChangePassword(); }}>
              <div>
                <label for="current-password" class="block text-xs text-muted mb-1.5">Current password</label>
                <input
                  id="current-password"
                  type="password"
                  value={passwordForm().current}
                  onInput={(e) => setPasswordForm(f => ({ ...f, current: e.currentTarget.value }))}
                  class="input w-full"
                  minlength={12}
                  required
                />
              </div>
              <div>
                <label for="new-password" class="block text-xs text-muted mb-1.5">New password</label>
                <input
                  id="new-password"
                  type="password"
                  value={passwordForm().newPass}
                  onInput={(e) => setPasswordForm(f => ({ ...f, newPass: e.currentTarget.value }))}
                  class="input w-full"
                  minlength={12}
                  required
                />
              </div>
              <div>
                <label for="confirm-password" class="block text-xs text-muted mb-1.5">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={passwordForm().confirm}
                  onInput={(e) => setPasswordForm(f => ({ ...f, confirm: e.currentTarget.value }))}
                  class="input w-full"
                  minlength={12}
                  required
                />
              </div>
              <div class="flex gap-2 pt-2">
                <button type="button" onClick={() => setShowPasswordModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>
                  Cancel
                </button>
                <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
                  {pendingAction() === 'change-password' ? 'Changing password\u2026' : 'Change password'}
                </button>
              </div>
            </form>
        </Dialog>
      </Show>
    </div>
  );
};

export default Settings;
