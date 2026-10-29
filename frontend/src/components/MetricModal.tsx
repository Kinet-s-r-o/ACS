import type { Component } from 'solid-js';
import { createSignal, createEffect, Show, For } from 'solid-js';
import { Plus, X } from 'lucide-solid';
import { api, type GaugeStyle, type MetricDefinition } from '../lib/api';
import Dialog from './Dialog';
import ColorSwatch from './ColorSwatch';
import { useFeedback } from './Feedback';
import { ECHARTS_TYPES } from '../lib/echartsTypes';

const CHART_TYPE_GROUPS: { category: string; types: typeof ECHARTS_TYPES }[] = (() => {
  const map = new Map<string, typeof ECHARTS_TYPES>();
  for (const t of ECHARTS_TYPES) {
    const arr = map.get(t.category) || [];
    arr.push(t);
    map.set(t.category, arr);
  }
  return [...map.entries()].map(([category, types]) => ({ category, types }));
})();

const EMPTY_METRIC: Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'> = {
  name: '',
  description: '',
  device_type_match: '*',
  parameter_name: '',
  unit: '',
  source: 'passive',
  active: true,
  min_sample_interval_seconds: 0,
  gpv_poll_interval_seconds: 0,
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
  gauge_style: 'basic' as const,
  thresholds: [],
  chart_type: 'line',
};

interface MetricModalProps {
  templateId?: number;
  open: boolean;
  editingMetric: MetricDefinition | null;
  copyingMetric?: MetricDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}

const MetricModal: Component<MetricModalProps> = (props) => {
  const { notify, confirm } = useFeedback();
  const [metricForm, setMetricForm] = createSignal<Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>>(EMPTY_METRIC);
  const [metricTab, setMetricTab] = createSignal<'metric' | 'health'>('metric');
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [initialSnapshot, setInitialSnapshot] = createSignal('');
  const isDirty = () => initialSnapshot() !== '' && JSON.stringify(metricForm()) !== initialSnapshot();
  const closeModal = async () => {
    if (pendingAction()) return;
    if (isDirty() && !await confirm({ title: 'Discard unsaved metric changes?', description: 'The changes in this metric form have not been saved.', confirmLabel: 'Discard changes', tone: 'primary' })) return;
    props.onClose();
  };

  const initForm = (m: MetricDefinition | null) => {
    const next = m ? {
      name: m.name,
      description: m.description,
      device_type_match: m.device_type_match,
      parameter_name: m.parameter_name,
      unit: m.unit,
      source: m.source,
      active: m.active,
      min_sample_interval_seconds: m.min_sample_interval_seconds ?? 0,
      gpv_poll_interval_seconds: m.gpv_poll_interval_seconds ?? 0,
      store_history: m.store_history !== false,
      group: m.group,
      color: m.color,
      axis: m.axis,
      transform: m.transform,
      multiplier: m.multiplier,
      unit_scale: m.unit_scale,
      health: m.health,
      health_order: m.health_order ?? 0,
      health_size: m.health_size || 'small',
      warn_threshold: m.warn_threshold,
      critical_threshold: m.critical_threshold,
      threshold_direction: m.threshold_direction,
      display_format: m.display_format,
      gauge_animated: m.gauge_animated,
      gauge_min: m.gauge_min ?? null,
      gauge_max: m.gauge_max ?? null,
      gauge_arc: m.gauge_arc || '270',
      gauge_pointer: m.gauge_pointer ?? true,
      gauge_style: m.gauge_style || 'basic',
      thresholds: m.thresholds || [],
      chart_type: m.chart_type || 'line',
    } : { ...EMPTY_METRIC };
    setMetricForm(next);
    setMetricTab('metric');
    return next;
  };

  // The modal stays mounted while the selected metric changes. Read both
  // props inside the effect so Solid re-initializes the form for every edit
  // action, including opening a different metric without unmounting first.
  createEffect(() => {
    const open = props.open;
    const metric = props.editingMetric;
    const copying = props.copyingMetric;
    if (open) {
      const initial = initForm(metric || copying || null);
      const next = !metric && copying ? { ...initial, name: `${Array.from(copying.name).slice(0, 15).join('')} copy` } : initial;
      if (next !== initial) setMetricForm(next);
      setInitialSnapshot(JSON.stringify(next));
    }
  });

  const handleSave = async () => {
    const form = metricForm();
    if (!form.name.trim() || !form.parameter_name.trim()) {
      notify({ tone: 'error', title: 'Missing fields', message: 'Name and parameter name are required.' });
      return;
    }
    if (Array.from(form.name).length > 20) {
      notify({ tone: 'error', title: 'Name is too long', message: 'Metric names can contain at most 20 characters.' });
      return;
    }
    setPendingAction('save-metric');
    try {
      const templateId = props.templateId;
      if (templateId === undefined) throw new Error('Select a provisioning template first.');
      if (props.editingMetric) {
        await api.updateTemplateMetric(templateId, props.editingMetric.id, form);
        notify({ tone: 'success', title: 'Metric updated', message: `"${form.name}" has been updated.` });
      } else {
        await api.createTemplateMetric(templateId, form);
        notify({ tone: 'success', title: 'Metric created', message: `"${form.name}" is now active.` });
      }
      props.onSaved();
      props.onClose();
    } catch (err) {
      notify({ tone: 'error', title: 'Metric save failed', message: (err as Error).message, persistent: true });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Show when={props.open}>
      <Dialog
        title={props.editingMetric ? 'Edit metric' : 'Add metric'}
        description="Define a CWMP parameter to collect as a time-series metric."
        headerBadge={<Show when={isDirty()}><span class="dialog-header-badge" role="status">Unsaved</span></Show>}
        onClose={() => void closeModal()}
      >
        <div class="space-y-4">
          <div class="flex gap-1 border-b border-zinc-800 pb-2">
            <button type="button" onClick={() => setMetricTab('metric')} class={`px-3 py-1 rounded text-xs font-medium transition-colors ${metricTab() === 'metric' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>Metric</button>
            <button type="button" onClick={() => setMetricTab('health')} class={`px-3 py-1 rounded text-xs font-medium transition-colors ${metricTab() === 'health' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>Health</button>
          </div>
          <Show when={metricTab() === 'metric'}>
          <div>
            <label for="metric-name" class="block text-xs text-muted mb-1.5">Name (max 20 characters)</label>
            <input id="metric-name" type="text" maxlength={20} value={metricForm().name} onInput={(e) => setMetricForm(f => ({ ...f, name: e.currentTarget.value }))} placeholder="e.g. Uptime, CPU Load" class="input w-full" />
          </div>
          <div>
            <label for="metric-description" class="block text-xs text-muted mb-1.5">Description (optional)</label>
            <input id="metric-description" type="text" value={metricForm().description} onInput={(e) => setMetricForm(f => ({ ...f, description: e.currentTarget.value }))} placeholder="Short description" class="input w-full" />
          </div>
          <div>
            <label for="metric-parameter" class="block text-xs text-muted mb-1.5">CWMP Parameter Path</label>
            <input id="metric-parameter" type="text" value={metricForm().parameter_name} onInput={(e) => setMetricForm(f => ({ ...f, parameter_name: e.currentTarget.value }))} placeholder="e.g. Device.DeviceInfo.UpTime" class="input w-full font-mono text-xs" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="metric-unit" class="block text-xs text-muted mb-1.5">Unit</label>
              <input id="metric-unit" type="text" value={metricForm().unit} onInput={(e) => setMetricForm(f => ({ ...f, unit: e.currentTarget.value }))} placeholder="s, %, MB/s" class="input w-full" />
            </div>
            <div>
              <label for="metric-source" class="block text-xs text-muted mb-1.5">Source</label>
              <select id="metric-source" value={metricForm().source} onChange={(e) => setMetricForm(f => ({ ...f, source: e.currentTarget.value as 'passive' | 'active' | 'universal' }))} class="input w-full">
                <option value="passive">Passive (from Inform)</option>
                <option value="active">Active (polled via GPV)</option>
                <option value="universal">Universal (both)</option>
              </select>
            </div>
          </div>
          <div>
            <label for="metric-active" class="block text-xs text-muted mb-1.5">Active</label>
            <select id="metric-active" value={metricForm().active ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, active: e.currentTarget.value === 'true' }))} class="input w-full">
              <option value="true">Yes — collect this metric</option>
              <option value="false">No — paused</option>
            </select>
          </div>
          <div>
            <label for="metric-min-sample-interval" class="block text-xs text-muted mb-1.5">Minimum sample interval (seconds)</label>
            <input id="metric-min-sample-interval" type="number" min="0" max="31536000" step="1" value={metricForm().min_sample_interval_seconds} onInput={(e) => setMetricForm(f => ({ ...f, min_sample_interval_seconds: Math.max(0, parseInt(e.currentTarget.value, 10) || 0) }))} class="input w-full" />
            <p class="text-xs text-muted mt-1">0 saves every reading; 300 saves at most one sample every 5 minutes per CPE.</p>
          </div>
          <div>
            <label for="metric-gpv-poll-interval" class="block text-xs text-muted mb-1.5">GPV poll interval (seconds)</label>
            <input id="metric-gpv-poll-interval" type="number" min="0" max="31536000" step="1" value={metricForm().gpv_poll_interval_seconds} onInput={(e) => setMetricForm(f => ({ ...f, gpv_poll_interval_seconds: Math.max(0, parseInt(e.currentTarget.value, 10) || 0) }))} class="input w-full" />
            <p class="text-xs text-muted mt-1">Active and Universal only. 0 uses the server interval (15 minutes by default); GPV waits for a CWMP session.</p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
                <label for="metric-group" class="block text-xs text-muted mb-1.5">Chart / Health Group</label>
                <input id="metric-group" type="text" value={metricForm().group} onInput={(e) => setMetricForm(f => ({ ...f, group: e.currentTarget.value }))} placeholder="e.g. throughput (optional)" class="input w-full" />
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
          <div class="grid grid-cols-2 gap-3">
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
                <option value="">None</option>
                <option value="bytes">Bytes (KB/MB/GB/TB)</option>
                <option value="bits">Bits (Kb/Mb/Gb/Tb)</option>
                <option value="pps">Packets per second (pps/Kpps/Mpps/Gpps)</option>
              </select>
            </div>
            <div>
              <label for="metric-chart-type" class="block text-xs text-muted mb-1.5">Chart Type</label>
              <select id="metric-chart-type" value={metricForm().chart_type} onChange={(e) => setMetricForm(f => ({ ...f, chart_type: e.currentTarget.value }))} class="input w-full">
                <For each={CHART_TYPE_GROUPS}>
                  {(g) => (
                    <optgroup label={g.category}>
                      <For each={g.types}>
                        {(t) => <option value={t.value}>{t.label}</option>}
                      </For>
                    </optgroup>
                  )}
                </For>
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
              <Show when={metricForm().display_format === 'gauge'}>
                <div>
                  <label for="metric-gauge-style" class="block text-xs text-muted mb-1.5">Gauge style (ECharts)</label>
                  <select id="metric-gauge-style" value={metricForm().gauge_style} onChange={(e) => { const style = e.currentTarget.value as GaugeStyle; setMetricForm(f => ({ ...f, gauge_style: style, gauge_arc: style === 'ring' ? '360' : style === 'temperature' ? '220' : ['speed', 'stage', 'grade', 'barometer'].includes(style) ? '180' : '270' })); }} class="input w-full">
                    <option value="basic">Gauge Basic</option><option value="simple">Simple Gauge</option><option value="speed">Speed Gauge</option><option value="progress">Progress Gauge</option><option value="stage">Stage Speed Gauge</option><option value="grade">Grade Gauge</option><option value="multi">Multi Title Gauge</option><option value="temperature">Temperature Gauge</option><option value="ring">Ring Gauge</option><option value="barometer">Gauge Barometer</option>
                  </select>
                </div>
                <div>
                  <label for="metric-gauge-min" class="block text-xs text-muted mb-1.5">Gauge min</label>
                  <input id="metric-gauge-min" type="number" step="any" value={metricForm().gauge_min ?? ''} onInput={(e) => setMetricForm(f => ({ ...f, gauge_min: e.currentTarget.value === '' ? null : parseFloat(e.currentTarget.value) }))} placeholder="auto" class="input w-full" />
                </div>
                <div>
                  <label for="metric-gauge-max" class="block text-xs text-muted mb-1.5">Gauge max</label>
                  <input id="metric-gauge-max" type="number" step="any" value={metricForm().gauge_max ?? ''} onInput={(e) => setMetricForm(f => ({ ...f, gauge_max: e.currentTarget.value === '' ? null : parseFloat(e.currentTarget.value) }))} placeholder="auto" class="input w-full" />
                </div>
                <div>
                  <label for="metric-gauge-arc" class="block text-xs text-muted mb-1.5">Gauge arc</label>
                  <select id="metric-gauge-arc" value={metricForm().gauge_arc} onChange={(e) => setMetricForm(f => ({ ...f, gauge_arc: e.currentTarget.value as '180' | '220' | '270' | '360' }))} class="input w-full">
                    <option value="180">180° (half circle)</option>
                    <option value="220">220° (temperature gauge)</option>
                    <option value="270">270° (3/4 circle)</option>
                    <option value="360">360° (full circle)</option>
                  </select>
                </div>
                <div>
                  <label for="metric-gauge-pointer" class="block text-xs text-muted mb-1.5">Show pointer</label>
                  <select id="metric-gauge-pointer" value={metricForm().gauge_pointer ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, gauge_pointer: e.currentTarget.value === 'true' }))} class="input w-full">
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
              </Show>
              <div class="col-span-2">
                <div class="block text-xs text-muted mb-1.5">Custom threshold bands</div>
                <div class="space-y-1.5">
                  <For each={metricForm().thresholds}>
                    {(t, i) => (
                      <div class="flex items-center gap-2">
                        <input
                          type="number"
                          step="any"
                          value={t.value}
                          onInput={(e) => setMetricForm(f => {
                            const thresholds = [...f.thresholds];
                            thresholds[i()].value = parseFloat(e.currentTarget.value) || 0;
                            return { ...f, thresholds };
                          })}
                          placeholder="Value"
                          class="input flex-1"
                        />
                        <ColorSwatch value={t.color} onChange={(c) => setMetricForm(f => {
                          const thresholds = [...f.thresholds];
                          thresholds[i()].color = c;
                          return { ...f, thresholds };
                        })} />
                        <button
                          type="button"
                          onClick={() => setMetricForm(f => ({ ...f, thresholds: f.thresholds.filter((_, j) => j !== i()) }))}
                          class="btn btn-ghost text-xs text-red-400"
                          title="Remove"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </For>
                  <button
                    type="button"
                    onClick={() => setMetricForm(f => ({ ...f, thresholds: [...f.thresholds, { value: 0, color: '#10b981' }] }))}
                    class="btn btn-ghost text-xs"
                  >
                    <Plus size={12} />
                    Add threshold
                  </button>
                </div>
                <p class="text-[10px] text-muted mt-1">Each threshold marks the start of a color band. Sorted by value.</p>
              </div>
            </div>
          </div>
          </Show>
        </div>
        <div class="flex gap-2 pt-4">
          <button type="button" onClick={props.onClose} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>Cancel</button>
          <button type="button" onClick={handleSave} class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
            {pendingAction() === 'save-metric' ? 'Saving…' : props.editingMetric ? 'Save changes' : 'Create metric'}
          </button>
        </div>
      </Dialog>
    </Show>
  );
};

export default MetricModal;
