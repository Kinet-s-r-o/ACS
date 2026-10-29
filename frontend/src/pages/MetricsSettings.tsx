import type { Component } from 'solid-js';
import { createSignal, createResource, createMemo, Show, For } from 'solid-js';
import { Plus, Edit, Trash2, Activity, Search, X, Copy, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-solid';
import { api, type GaugeStyle, type MetricDefinition } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColorSwatch from '../components/ColorSwatch';
import { useFeedback } from '../components/Feedback';
import { useAuth } from '../lib/auth';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import { ECHARTS_TYPES } from '../lib/echartsTypes';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';

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
  gauge_style: 'basic',
  thresholds: [],
  chart_type: 'line',
};

const MetricsSettings: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify, confirm } = useFeedback();
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);

  const [metrics, { refetch: refetchMetrics }] = createResource(api.getMetricDefinitions);
  const [deviceTypes] = createResource(api.getDeviceTypes);
  const [editingMetric, setEditingMetric] = createSignal<MetricDefinition | null>(null);
  const [showMetricModal, setShowMetricModal] = createSignal(false);
  const [metricForm, setMetricForm] = createSignal<Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>>(EMPTY_METRIC);
  const [metricTab, setMetricTab] = createSignal<'metric' | 'health'>('metric');
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.metrics', {});
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.metrics');
  const [sortBy, setSortBy] = createSignal<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const { columns, isVisible, toggle } = useColumnVisibility('metrics', [
    { id: 'name', label: 'Name', visible: true },
    { id: 'parameter_name', label: 'Parameter', visible: true },
    { id: 'device_type_match', label: 'Device Match', visible: true },
    { id: 'source', label: 'Source', visible: true },
    { id: 'unit', label: 'Unit', visible: true },
    { id: 'group', label: 'Group', visible: true },
    { id: 'active', label: 'Active', visible: true },
  ]);
  const [metricPage, setMetricPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('metrics', 20);
  const handlePageSizeChange = (size: number) => { changePageSize(size); setMetricPage(0); };

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
    let all = metrics() || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      all = all.filter(m =>
        m.name?.toLowerCase().includes(query) ||
        m.parameter_name?.toLowerCase().includes(query) ||
        m.device_type_match?.toLowerCase().includes(query) ||
        m.source?.toLowerCase().includes(query) ||
        m.unit?.toLowerCase().includes(query) ||
        m.group?.toLowerCase().includes(query) ||
        m.description?.toLowerCase().includes(query)
      );
    }
    return applyColumnFilters(all, columnFilters(), getFilterValue);
  });
  const sortedMetrics = createMemo(() => {
    const all = [...filteredMetrics()];
    const sort = sortBy();
    if (!sort) return all;
    return all.sort((a, b) => {
      const aVal = getFilterValue(a, sort.column);
      const bVal = getFilterValue(b, sort.column);
      const comparison = aVal.localeCompare(bVal);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  });
  const handleSort = (columnId: string) => {
    const current = sortBy();
    if (current?.column === columnId) {
      if (current.direction === 'asc') {
        setSortBy({ column: columnId, direction: 'desc' });
      } else {
        setSortBy(null);
      }
    } else {
      setSortBy({ column: columnId, direction: 'asc' });
    }
  };
  const pagedMetrics = createMemo(() => {
    const all = sortedMetrics();
    const start = metricPage() * pageSize();
    return all.slice(start, start + pageSize());
  });
  const metricTotalPages = createMemo(() => Math.ceil(filteredMetrics().length / pageSize()));

  const openCreateMetric = () => {
    setEditingMetric(null);
    setMetricForm(EMPTY_METRIC);
    setMetricTab('metric');
    setShowMetricModal(true);
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
      min_sample_interval_seconds: def.min_sample_interval_seconds ?? 0,
      gpv_poll_interval_seconds: def.gpv_poll_interval_seconds ?? 0,
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
    setMetricTab('metric');
    setShowMetricModal(true);
  };

  const openCopyMetric = (def: MetricDefinition) => {
    setEditingMetric(null);
    setMetricForm({
      name: def.name,
      description: def.description,
      device_type_match: def.device_type_match,
      parameter_name: def.parameter_name,
      unit: def.unit,
      source: def.source,
      active: def.active,
      min_sample_interval_seconds: def.min_sample_interval_seconds ?? 0,
      gpv_poll_interval_seconds: def.gpv_poll_interval_seconds ?? 0,
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

  const renderSortHeader = (colId: string, label: string, align: 'left' | 'center' = 'left') => (
    <th class={`${align === 'center' ? 'text-center' : 'text-left'} px-3 py-2.5 font-semibold text-primary`}>
      <div class={`flex items-center gap-1.5 ${align === 'center' ? 'justify-center' : ''}`}>
        <button
          onClick={() => handleSort(colId)}
          class={`flex items-center gap-1 text-xs font-medium tracking-wide transition-colors ${
            sortBy()?.column === colId ? 'text-sky-400' : 'text-muted hover:text-primary'
          } cursor-pointer`}
        >
          {label}
          <Show when={sortBy()?.column === colId}>
            {sortBy()?.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          </Show>
          <Show when={sortBy()?.column !== colId}>
            <ArrowUpDown size={10} class="opacity-50" />
          </Show>
        </button>
        <ColumnFilter columnId={colId} label={label} active={columnFilters()[colId] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n[colId] = s; else delete n[colId]; return n; }); }} />
      </div>
    </th>
  );

  return (
    <div class="space-y-5">
      <PageHeader title="Monitored Metrics" description="Define which CPE parameters to collect as time-series data." />

      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
            <Activity size={14} />
            Metric Definitions
          </h2>
          <div class="flex items-center gap-2">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input type="text" value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)} placeholder="Search metrics…" class="input pl-9! w-56 text-sm" />
              <Show when={searchQuery()}>
                <button onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
              </Show>
            </div>
            <Show when={isFullAccess()}>
              <button onClick={openCreateMetric} class="btn btn-primary text-xs">
                <Plus size={12} />
                Add metric
              </button>
            </Show>
          </div>
        </div>
        <Show when={metrics.loading}>
          <div class="skeleton h-16 w-full" />
        </Show>
        <Show when={!metrics.loading && (metrics() || []).length === 0}>
          <p class="text-sm text-muted">No metric definitions. Add a metric to start collecting time-series data from CPEs.</p>
        </Show>
        <Show when={!metrics.loading && (metrics() || []).length > 0}>
          <div class="overflow-x-auto table-scroll">
            <table class="data-table w-full text-sm">
              <thead class="sticky top-0 bg-base z-10">
                <tr class="border-b-2 border-subtle bg-base">
                  <Show when={isVisible('name')}>
                    {renderSortHeader('name', 'Name')}
                  </Show>
                  <Show when={isVisible('parameter_name')}>
                    {renderSortHeader('parameter_name', 'Parameter')}
                  </Show>
                  <Show when={isVisible('device_type_match')}>
                    {renderSortHeader('device_type_match', 'Device Match')}
                  </Show>
                  <Show when={isVisible('source')}>
                    {renderSortHeader('source', 'Source')}
                  </Show>
                  <Show when={isVisible('unit')}>
                    {renderSortHeader('unit', 'Unit')}
                  </Show>
                  <Show when={isVisible('group')}>
                    {renderSortHeader('group', 'Group')}
                  </Show>
                  <Show when={isVisible('active')}>
                    {renderSortHeader('active', 'Active', 'center')}
                  </Show>
                  <Show when={isFullAccess()}>
                    <th class="text-right px-3 py-2.5 font-semibold text-primary"></th>
                  </Show>
                  <th class="px-2 py-2.5"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
                </tr>
              </thead>
              <tbody>
                <For each={pagedMetrics()}>
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
                      <Show when={isVisible('unit')}><td class="px-3 py-2.5 text-secondary">{def.unit || '—'}</td></Show>
                      <Show when={isVisible('group')}>
                        <td class="px-3 py-2.5 text-secondary">
                          <div class="flex items-center gap-1.5">
                            <span class="chart-color-swatch w-2.5 h-2.5 rounded-[2px]" data-dynamic-style="chart-color" style={{ '--chart-color': def.color || '#475569' } as any} />
                            <span class="text-xs">{def.group || '—'}</span>
                          </div>
                        </td>
                      </Show>
                      <Show when={isVisible('active')}>
                        <td class="px-3 py-2.5 text-center">
                          <span class={`badge ${def.active ? 'badge-success' : 'badge-muted'}`}>{def.active ? 'Yes' : 'No'}</span>
                        </td>
                      </Show>
                      <Show when={isFullAccess()}>
                        <td class="px-3 py-2.5 text-right">
                          <div class="flex justify-end gap-1">
                            <button onClick={() => openEditMetric(def)} class="btn btn-ghost text-xs" title="Edit">
                              <Edit size={12} />
                            </button>
                            <button onClick={() => openCopyMetric(def)} class="btn btn-ghost text-xs" title="Copy">
                              <Copy size={12} />
                            </button>
                            <button onClick={() => handleDeleteMetric(def)} class="btn btn-ghost text-xs text-red-400" title="Delete">
                              <Trash2 size={12} />
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
      <Pagination page={metricPage()} totalPages={metricTotalPages()} totalItems={filteredMetrics().length} pageSize={pageSize()} onPageChange={setMetricPage} storageKey="metrics" onPageSizeChange={handlePageSizeChange} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setMetricPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setMetricPage(0); }} />

      {/* Metric Modal */}
      <Show when={showMetricModal()}>
        <Dialog
          title={editingMetric() ? 'Edit metric' : 'Add metric'}
          description="Define a CWMP parameter to collect as a time-series metric."
          onClose={() => { if (!pendingAction()) setShowMetricModal(false); }}
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
                  <option value="">None (raw)</option>
                  <option value="auto">Auto (K/M/G/T)</option>
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
                  <div class="block text-xs text-muted mb-1.5">Gauge style (ECharts)</div>
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
            <button type="button" onClick={() => setShowMetricModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>Cancel</button>
            <button type="button" onClick={handleSaveMetric} class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
              {pendingAction() === 'save-metric' ? 'Saving…' : editingMetric() ? 'Save changes' : 'Create metric'}
            </button>
          </div>
        </Dialog>
      </Show>
    </div>
  );
};

export default MetricsSettings;

