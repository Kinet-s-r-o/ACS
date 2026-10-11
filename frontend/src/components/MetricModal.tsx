import type { Component } from 'solid-js';
import { createSignal, createResource, createEffect, Show, For } from 'solid-js';
import { Plus, X } from 'lucide-solid';
import { api, type MetricDefinition } from '../lib/api';
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
  group: '',
  color: '',
  axis: 'left',
  transform: '',
  multiplier: 1,
  unit_scale: '',
  health: false,
  warn_threshold: null,
  critical_threshold: null,
  threshold_direction: 'higher_is_worse',
  display_format: 'number',
  gauge_animated: true,
  gauge_min: null,
  gauge_max: null,
  gauge_arc: '270',
  gauge_pointer: true,
  thresholds: [],
  chart_type: 'line',
};

interface MetricModalProps {
  open: boolean;
  editingMetric: MetricDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}

const MetricModal: Component<MetricModalProps> = (props) => {
  const { notify } = useFeedback();
  const [metricForm, setMetricForm] = createSignal<Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>>(EMPTY_METRIC);
  const [metricTab, setMetricTab] = createSignal<'metric' | 'health'>('metric');
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [deviceTypes] = createResource(api.getDeviceTypes);

  const initForm = (m: MetricDefinition | null) => {
    if (m) {
      setMetricForm({
        name: m.name,
        description: m.description,
        device_type_match: m.device_type_match,
        parameter_name: m.parameter_name,
        unit: m.unit,
        source: m.source,
        active: m.active,
        group: m.group,
        color: m.color,
        axis: m.axis,
        transform: m.transform,
        multiplier: m.multiplier,
        unit_scale: m.unit_scale,
        health: m.health,
        warn_threshold: m.warn_threshold,
        critical_threshold: m.critical_threshold,
        threshold_direction: m.threshold_direction,
        display_format: m.display_format,
        gauge_animated: m.gauge_animated,
        gauge_min: m.gauge_min ?? null,
        gauge_max: m.gauge_max ?? null,
        gauge_arc: m.gauge_arc || '270',
        gauge_pointer: m.gauge_pointer ?? true,
        thresholds: m.thresholds || [],
        chart_type: m.chart_type || 'line',
      });
    } else {
      setMetricForm(EMPTY_METRIC);
    }
    setMetricTab('metric');
  };

  // The modal stays mounted while the selected metric changes. Read both
  // props inside the effect so Solid re-initializes the form for every edit
  // action, including opening a different metric without unmounting first.
  createEffect(() => {
    const open = props.open;
    const metric = props.editingMetric;
    if (open) initForm(metric);
  });

  const handleSave = async () => {
    const form = metricForm();
    if (!form.name.trim() || !form.parameter_name.trim()) {
      notify({ tone: 'error', title: 'Missing fields', message: 'Name and parameter name are required.' });
      return;
    }
    setPendingAction('save-metric');
    try {
      if (props.editingMetric) {
        await api.updateMetricDefinition(props.editingMetric.id, form);
        notify({ tone: 'success', title: 'Metric updated', message: `"${form.name}" has been updated.` });
      } else {
        await api.createMetricDefinition(form);
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
        onClose={() => { if (!pendingAction()) props.onClose(); }}
      >
        <div class="space-y-4">
          <div class="flex gap-1 border-b border-zinc-800 pb-2">
            <button type="button" onClick={() => setMetricTab('metric')} class={`px-3 py-1 rounded text-xs font-medium transition-colors ${metricTab() === 'metric' ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'}`}>Metric</button>
            <button type="button" onClick={() => setMetricTab('health')} class={`px-3 py-1 rounded text-xs font-medium transition-colors ${metricTab() === 'health' ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'}`}>Health</button>
          </div>
          <Show when={metricTab() === 'metric'}>
          <div>
            <label for="metric-name" class="block text-xs text-muted mb-1.5">Name</label>
            <input id="metric-name" type="text" value={metricForm().name} onInput={(e) => setMetricForm(f => ({ ...f, name: e.currentTarget.value }))} placeholder="e.g. Uptime, CPU Load" class="input w-full" />
          </div>
          <div>
            <label for="metric-description" class="block text-xs text-muted mb-1.5">Description (optional)</label>
            <input id="metric-description" type="text" value={metricForm().description} onInput={(e) => setMetricForm(f => ({ ...f, description: e.currentTarget.value }))} placeholder="Short description" class="input w-full" />
          </div>
          <div>
            <label for="metric-parameter" class="block text-xs text-muted mb-1.5">CWMP Parameter Path</label>
            <input id="metric-parameter" type="text" value={metricForm().parameter_name} onInput={(e) => setMetricForm(f => ({ ...f, parameter_name: e.currentTarget.value }))} placeholder="e.g. Device.DeviceInfo.UpTime" class="input w-full font-mono text-xs" />
          </div>
          <div>
            <label for="metric-device-match" class="block text-xs text-muted mb-1.5">Device Type Match (glob)</label>
            <input id="metric-device-match" type="text" value={metricForm().device_type_match} onInput={(e) => setMetricForm(f => ({ ...f, device_type_match: e.currentTarget.value }))} placeholder="* (all) or Zyxel/VMG3625" class="input w-full font-mono text-xs" />
            <Show when={deviceTypes() && deviceTypes()!.length > 0}>
              <div class="flex flex-wrap gap-1 mt-1.5">
                <For each={deviceTypes()!}>
                  {(dt) => (
                    <button
                      type="button"
                      onClick={() => setMetricForm(f => ({ ...f, device_type_match: dt }))}
                      class={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${metricForm().device_type_match === dt ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'}`}
                    >
                      {dt}
                    </button>
                  )}
                </For>
              </div>
            </Show>
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
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="metric-group" class="block text-xs text-muted mb-1.5">Chart Group</label>
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
            <label class="block text-xs text-muted mb-1.5">Line Color</label>
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
            <label class="block text-xs font-medium text-secondary mb-2">Health indicator</label>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="metric-health" class="block text-xs text-muted mb-1.5">Show in Device Health</label>
                <select id="metric-health" value={metricForm().health ? 'true' : 'false'} onChange={(e) => setMetricForm(f => ({ ...f, health: e.currentTarget.value === 'true' }))} class="input w-full">
                  <option value="false">No — Metrics tab only</option>
                  <option value="true">Yes — Metrics tab + Device Health</option>
                </select>
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
                  <label for="metric-gauge-min" class="block text-xs text-muted mb-1.5">Gauge min</label>
                  <input id="metric-gauge-min" type="number" step="any" value={metricForm().gauge_min ?? ''} onInput={(e) => setMetricForm(f => ({ ...f, gauge_min: e.currentTarget.value === '' ? null : parseFloat(e.currentTarget.value) }))} placeholder="auto" class="input w-full" />
                </div>
                <div>
                  <label for="metric-gauge-max" class="block text-xs text-muted mb-1.5">Gauge max</label>
                  <input id="metric-gauge-max" type="number" step="any" value={metricForm().gauge_max ?? ''} onInput={(e) => setMetricForm(f => ({ ...f, gauge_max: e.currentTarget.value === '' ? null : parseFloat(e.currentTarget.value) }))} placeholder="auto" class="input w-full" />
                </div>
                <div>
                  <label for="metric-gauge-arc" class="block text-xs text-muted mb-1.5">Gauge arc</label>
                  <select id="metric-gauge-arc" value={metricForm().gauge_arc} onChange={(e) => setMetricForm(f => ({ ...f, gauge_arc: e.currentTarget.value as '180' | '270' | '360' }))} class="input w-full">
                    <option value="180">180° (half circle)</option>
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
                <label class="block text-xs text-muted mb-1.5">Custom threshold bands</label>
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
