import type { Component } from 'solid-js';
import { createSignal, createResource, createEffect, createMemo, onCleanup, Show, For } from 'solid-js';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api, type MetricDefinition } from '../lib/api';
import { readMigratedStorageValue, writeMigratedStorageValue } from '../lib/storage';
import { thresholdLines, effectiveUnit } from '../lib/health';
import { isTimeSeriesType } from '../lib/echartsTypes';

echarts.use([
  LineChart, BarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart,
  GridComponent, TooltipComponent, MarkLineComponent,
  CanvasRenderer,
]);

interface MetricChartProps {
  serial: string;
  metrics: MetricDefinition[];
  hours?: number;
}

const DEFAULT_PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#fb923c'];

const BUCKET_OPTIONS: Array<{ label: string; value: string; hours: number }> = [
  { label: '1h', value: '5min', hours: 1 },
  { label: '6h', value: '5min', hours: 6 },
  { label: '24h', value: '5min', hours: 24 },
  { label: '7d', value: '1h', hours: 168 },
  { label: '30d', value: '1d', hours: 720 },
  { label: '365d', value: '1d', hours: 8760 },
];

const getStoredBucket = (serial: string): typeof BUCKET_OPTIONS[number] => {
  try {
    const stored = readMigratedStorageValue(localStorage, `acs_metric_interval_${serial}`, `skyacs_metric_interval_${serial}`);
    if (stored) {
      const found = BUCKET_OPTIONS.find((o) => o.label === stored);
      if (found) return found;
    }
  } catch { /* ignore */ }
  return BUCKET_OPTIONS[2];
};

const hexToRgba = (hex: string, alpha: number): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

interface UnitScale { divisor: number; suffix: string }

const computeUnitScale = (values: number[], mode: string): UnitScale => {
  const max = Math.max(0, ...values.filter((v) => v != null));
  if (mode === 'pps') {
    if (max >= 1e9) return { divisor: 1e9, suffix: 'Gpps' };
    if (max >= 1e6) return { divisor: 1e6, suffix: 'Mpps' };
    if (max >= 1e3) return { divisor: 1e3, suffix: 'Kpps' };
    return { divisor: 1, suffix: 'pps' };
  }
  if (max === 0) return { divisor: 1, suffix: '' };

  if (mode === 'auto') {
    if (max >= 1e12) return { divisor: 1e12, suffix: 'T' };
    if (max >= 1e9) return { divisor: 1e9, suffix: 'G' };
    if (max >= 1e6) return { divisor: 1e6, suffix: 'M' };
    if (max >= 1e3) return { divisor: 1e3, suffix: 'K' };
    return { divisor: 1, suffix: '' };
  }
  if (mode === 'bytes') {
    const kb = 1024, mb = 1024 ** 2, gb = 1024 ** 3, tb = 1024 ** 4;
    if (max >= tb) return { divisor: tb, suffix: 'TB' };
    if (max >= gb) return { divisor: gb, suffix: 'GB' };
    if (max >= mb) return { divisor: mb, suffix: 'MB' };
    if (max >= kb) return { divisor: kb, suffix: 'KB' };
    return { divisor: 1, suffix: 'B' };
  }
  if (mode === 'bits') {
    if (max >= 1e12) return { divisor: 1e12, suffix: 'Tb' };
    if (max >= 1e9) return { divisor: 1e9, suffix: 'Gb' };
    if (max >= 1e6) return { divisor: 1e6, suffix: 'Mb' };
    if (max >= 1e3) return { divisor: 1e3, suffix: 'Kb' };
    return { divisor: 1, suffix: 'b' };
  }
  return { divisor: 1, suffix: '' };
};

const fmtVal = (v: number | null): string => (v == null ? '—' : v.toFixed(2));

const MONO_FONT = '"IBM Plex Mono", monospace';
const AXIS_COLOR = '#475569';
const LABEL_COLOR = '#71717a';
const GRID_COLOR = 'rgba(71,85,105,0.15)';

const MetricChart: Component<MetricChartProps> = (props) => {
  const [bucket, setBucket] = createSignal(getStoredBucket(props.serial));
  const [chartEl, setChartEl] = createSignal<HTMLElement>();
  let chart: echarts.ECharts | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let chartBoundEl: HTMLElement | null = null;

  const [settings] = createResource(() => api.getSettings());
  const chartShowPoints = createMemo(() => settings()?.['chart_show_points'] !== 'false');

  const [data] = createResource(
    () => ({ serial: props.serial, ids: props.metrics.map((m) => m.id), bucket: bucket().value, hours: bucket().hours }),
    async (q) => {
      const results = await Promise.all(
        q.ids.map((id) => api.getDeviceMetrics(q.serial, id, q.bucket, q.hours)),
      );
      return results;
    },
  );

  const hasRightAxis = createMemo(() => props.metrics.some((m) => m.axis === 'right'));

  const chartType = createMemo(() => {
    const t = props.metrics[0]?.chart_type || 'line';
    return isTimeSeriesType(t) ? t : 'line';
  });

  const seriesData = createMemo(() => {
    const results = data();
    if (!results) return null;

    let baseTimes: number[] | null = null;

    for (const r of results) {
      if (r.aggregates && r.aggregates.length > 0) {
        baseTimes = r.aggregates.map((a) => new Date(a.timestamp).getTime());
        break;
      }
      if (r.samples && r.samples.length > 0) {
        baseTimes = r.samples.map((s) => new Date(s.timestamp).getTime());
        break;
      }
    }
    if (!baseTimes) return null;

    const series: (number | null)[][] = [];
    const seriesTimes: number[][] = [];
    const suffixes: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const m = props.metrics[i];
      const scale = m.unit_scale ? computeUnitScale(
        (r.aggregates?.map((a) => a.avg) ?? r.samples?.map((s) => s.value) ?? []),
        m.unit_scale
      ) : { divisor: 1, suffix: '' };
      suffixes.push(scale.suffix);

      if (r.aggregates && r.aggregates.length > 0) {
        series.push(r.aggregates.map((a) => a.avg / scale.divisor));
        seriesTimes.push(r.aggregates.map((a) => new Date(a.timestamp).getTime()));
      } else if (r.samples && r.samples.length > 0) {
        series.push(r.samples.map((s) => s.value / scale.divisor));
        seriesTimes.push(r.samples.map((s) => new Date(s.timestamp).getTime()));
      } else {
        series.push(baseTimes.map(() => null));
        seriesTimes.push(baseTimes);
      }
    }

    return { baseTimes, series, seriesTimes, suffixes };
  });

  const chartTitle = createMemo(() => {
    if (props.metrics.length === 1) {
      const m = props.metrics[0];
      return m.name + (m.unit ? ` (${m.unit})` : '');
    }
    const group = props.metrics[0].group;
    if (group) return group;
    return props.metrics.map((m) => m.name).join(' / ');
  });

  const legendStats = createMemo(() => {
    const results = data();
    if (!results) return null;
    return results.map((r, i) => {
      const m = props.metrics[i];
      const color = m.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      const values = r.aggregates?.map((a) => a.avg) ?? r.samples?.map((s) => s.value) ?? [];
      const scale = m.unit_scale ? computeUnitScale(values, m.unit_scale) : { divisor: 1, suffix: '' };
      const unit = effectiveUnit(m.unit, m.unit_scale, scale.suffix);
      let min: number | null = null;
      let max: number | null = null;
      let avg: number | null = null;
      if (r.aggregates && r.aggregates.length > 0) {
        min = Math.min(...r.aggregates.map((a) => a.min)) / scale.divisor;
        max = Math.max(...r.aggregates.map((a) => a.max)) / scale.divisor;
        avg = r.aggregates.reduce((s, a) => s + a.avg, 0) / r.aggregates.length / scale.divisor;
      } else if (r.samples && r.samples.length > 0) {
        const vals = r.samples.map((s) => s.value);
        min = Math.min(...vals) / scale.divisor;
        max = Math.max(...vals) / scale.divisor;
        avg = vals.reduce((s, v) => s + v, 0) / vals.length / scale.divisor;
      }
      return { name: m.name, color, unit, min, avg, max };
    });
  });
  const buildOption = (): echarts.EChartsCoreOption => {
    const s = seriesData();
    if (!s) return {};

    const metrics = props.metrics;
    const showPoints = chartShowPoints();
    const type = chartType();

    const axisUnitLabel = (side: 'left' | 'right'): string => {
      const units: string[] = [];
      for (let i = 0; i < metrics.length; i++) {
        const isRight = metrics[i].axis === 'right';
        if (side === 'right' ? !isRight : isRight) continue;
        const u = effectiveUnit(metrics[i].unit, metrics[i].unit_scale, s.suffixes[i]);
        if (u && !units.includes(u)) units.push(u);
      }
      return units.join(' / ');
    };

    const yAxis: any[] = [{
      type: 'value',
      name: axisUnitLabel('left'),
      nameTextStyle: { color: LABEL_COLOR, fontSize: 10, align: 'left' },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: LABEL_COLOR, fontSize: 10, fontFamily: MONO_FONT },
      splitLine: { lineStyle: { color: GRID_COLOR } },
    }];
    if (hasRightAxis()) {
      yAxis.push({
        type: 'value',
        name: axisUnitLabel('right'),
        nameTextStyle: { color: LABEL_COLOR, fontSize: 10, align: 'right' },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: LABEL_COLOR, fontSize: 10, fontFamily: MONO_FONT },
        splitLine: { show: false },
      });
    }

    const series: any[] = [];
    for (let i = 0; i < metrics.length; i++) {
      const m = metrics[i];
      const color = m.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      const unit = effectiveUnit(m.unit, m.unit_scale, s.suffixes[i]);
      const label = m.name + (unit ? ` (${unit})` : '');
      const yAxisIndex = m.axis === 'right' ? 1 : 0;

      const dataPoints: [number, number | null][] = s.seriesTimes[i].map((t, j) => [t, s.series[i][j]]);

      const tLines = thresholdLines(m);
      const markLine = tLines.length > 0 ? {
        silent: true,
        symbol: 'none',
        lineStyle: { type: 'dashed' as const, width: 1 },
        label: { show: false },
        data: tLines.map((tl) => ({
          yAxis: tl.value,
          lineStyle: { color: tl.color, type: 'dashed' as const },
        })),
      } : undefined;

      const base: any = {
        name: label,
        type: type as any,
        yAxisIndex,
        data: dataPoints,
        markLine,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
      };

      if (type === 'line') {
        base.smooth = false;
        base.symbol = showPoints ? 'circle' : 'none';
        base.symbolSize = 4;
        base.areaStyle = { color: hexToRgba(color, 0.06) };
      } else if (type === 'bar') {
        base.barMaxWidth = 8;
      } else if (type === 'scatter' || type === 'effectScatter') {
        base.symbolSize = showPoints ? 6 : 4;
      }

      series.push(base);
    }

    return {
      animation: false,
      grid: {
        left: 40,
        right: hasRightAxis() ? 40 : 10,
        top: 20,
        bottom: 20,
        containLabel: false,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(15,23,42,0.9)',
        borderColor: 'transparent',
        padding: [4, 8],
        textStyle: { color: '#e2e8f0', fontSize: 11, fontFamily: MONO_FONT },
        axisPointer: { type: 'line', lineStyle: { color: AXIS_COLOR } },
        formatter: (params: any) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const ts = params[0].value[0];
          const date = new Date(ts);
          const timeStr = date.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
          const dateStr = date.toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' });
          let html = `<div style="margin-bottom:3px;opacity:0.7">${dateStr} ${timeStr}</div>`;
          let hasVal = false;
          for (const p of params) {
            if (p.value == null || p.value[1] == null) continue;
            hasVal = true;
            const idx = p.seriesIndex;
            const m = metrics[idx];
            const effUnit = effectiveUnit(m.unit, m.unit_scale, s.suffixes[idx]);
            const unit = effUnit ? ` ${effUnit}` : '';
            html += `<div style="display:flex;align-items:center;gap:4px;margin-top:2px"><span style="width:8px;height:8px;border-radius:2px;background:${p.color};display:inline-block"></span><span>${p.seriesName}: ${typeof p.value[1] === 'number' ? p.value[1].toFixed(2) : p.value[1]}${unit}</span></div>`;
          }
          return hasVal ? html : '';
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: AXIS_COLOR } },
        axisTick: { show: false },
        axisLabel: { color: LABEL_COLOR, fontSize: 10, fontFamily: MONO_FONT },
        splitLine: { show: false },
      },
      yAxis,
      series,
    };
  };
  const renderChart = () => {
    const el = chartEl();
    if (!el) return;
    const s = seriesData();
    if (!s) {
      if (chart) { chart.dispose(); chart = null; chartBoundEl = null; }
      return;
    }

    if (!chart || chartBoundEl !== el) {
      if (chart) { chart.dispose(); }
      if (resizeObserver) { resizeObserver.disconnect(); }
      chart = echarts.init(el, null, { renderer: 'canvas' });
      chartBoundEl = el;
      resizeObserver = new ResizeObserver(() => {
        if (chart) chart.resize();
      });
      resizeObserver.observe(el);
    }
    chart.setOption(buildOption() as any, { notMerge: true });
  };

  createEffect(() => {
    const el = chartEl();
    const s = seriesData();
    if (!el || !s) return;
    renderChart();
  });

  onCleanup(() => {
    if (resizeObserver) resizeObserver.disconnect();
    if (chart) { chart.dispose(); chart = null; }
    chartBoundEl = null;
  });

  const handleBucketChange = (opt: typeof BUCKET_OPTIONS[number]) => {
    setBucket(opt);
    writeMigratedStorageValue(localStorage, `acs_metric_interval_${props.serial}`, `skyacs_metric_interval_${props.serial}`, opt.label);
  };

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-secondary">{chartTitle()}</span>
        </div>
        <div class="flex gap-1">
          {BUCKET_OPTIONS.map((opt) => (
            <button
              onClick={() => handleBucketChange(opt)}
              class={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${bucket().value === opt.value && bucket().hours === opt.hours ? 'bg-sky-500/20 text-sky-400' : 'text-muted hover:text-secondary'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <Show when={data.loading}>
        <div class="skeleton h-[200px] w-full" />
      </Show>
      <Show when={!data.loading && data.error}>
        <div class="text-xs text-rose-400 h-[200px] flex items-center justify-center">
          Failed to load metric data
        </div>
      </Show>
      <Show when={!data.loading && !data.error && seriesData()}>
        <div ref={setChartEl} class="w-full h-[200px] relative overflow-hidden" />
        <Show when={legendStats()}>
          <div class="flex flex-col gap-0.5 pt-1">
            <For each={legendStats()!}>
              {(s) => (
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-1.5">
                    <span class="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ background: s.color }} />
                    <span class="text-xs text-secondary">{s.name}</span>
                  </div>
                  <span class="text-[10px] text-muted font-mono">
                    min {fmtVal(s.min)} · avg {fmtVal(s.avg)} · max {fmtVal(s.max)}{s.unit ? ` ${s.unit}` : ''}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={!data.loading && !data.error && !seriesData()}>
        <div class="text-xs text-muted h-[200px] flex flex-col items-center justify-center gap-1">
          <span>No data collected yet</span>
          <span class="text-[10px] opacity-60">Waiting for device Inform with matching parameters</span>
        </div>
      </Show>
    </div>
  );
};

export default MetricChart;
