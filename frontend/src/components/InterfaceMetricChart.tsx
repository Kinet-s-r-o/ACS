import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PictorialBarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, ToolboxComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api, type InterfaceMetricDefinition } from '../lib/api';
import { computeUnitScale, effectiveUnit } from '../lib/health';

echarts.use([LineChart, BarChart, PictorialBarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, ToolboxComponent, CanvasRenderer]);

interface Props {
  serial: string;
  definitions: InterfaceMetricDefinition[];
  interfacePath: string;
  parameterNames: string[];
  refreshKey?: number;
}

const BUCKET_OPTIONS: Array<{ label: string; value: string; hours: number }> = [
  { label: '1h', value: '15min', hours: 1 },
  { label: '6h', value: '15min', hours: 6 },
  { label: '24h', value: '15min', hours: 24 },
  { label: '7d', value: '1h', hours: 168 },
  { label: '30d', value: '1d', hours: 720 },
  { label: '365d', value: '1d', hours: 8760 },
];

const readStoredBucket = (serial: string, interfacePath: string) => {
  try {
    const label = localStorage.getItem(`acs_interface_metric_interval_${serial}_${interfacePath}`);
    return BUCKET_OPTIONS.find(option => option.label === label) ?? BUCKET_OPTIONS[2];
  } catch { return BUCKET_OPTIONS[2]; }
};

const matches = (pattern: string, name: string) => {
  const p = pattern.split('.');
  const n = name.split('.');
  return p.length === n.length && p.every((segment, index) => segment === '*' || segment === n[index]);
};

const InterfaceMetricChart: Component<Props> = (props) => {
  const [element, setElement] = createSignal<HTMLDivElement>();
  const [selectedSeriesKey, setSelectedSeriesKey] = createSignal<string | null>(null);
  const [bucket, setBucket] = createSignal(readStoredBucket(props.serial, props.interfacePath));
  let chart: echarts.ECharts | undefined;
  let observer: ResizeObserver | undefined;
  const requests = createMemo(() => props.definitions.flatMap(def =>
    props.parameterNames.filter(name => name.startsWith(props.interfacePath) && matches(def.parameter_pattern, name))
      .map(parameterName => ({ def, parameterName }))));
  const [results] = createResource(
    () => ({ serial: props.serial, hours: bucket().hours, bucket: bucket().value, requests: requests().map(item => `${item.def.id}:${item.parameterName}`).join('|'), refreshKey: props.refreshKey ?? 0 }),
    async query => Promise.all(requests().map(async item => {
      const result = await api.getDeviceInterfaceMetric(query.serial, item.def.id, item.parameterName, query.hours, query.bucket);
      if (query.bucket === 'raw' || !result.aggregates?.length) return result;
      const tailHours = query.bucket === '15min' ? 0.25 : query.bucket === '1h' ? 6 : 24;
      try {
        const recent = await api.getDeviceInterfaceMetric(query.serial, item.def.id, item.parameterName, tailHours, 'raw');
        return { ...result, samples: recent.samples ?? [] };
      } catch { return result; }
    })),
  );
  const chartData = createMemo(() => {
    const values = results();
    if (!values) return { series: [], summaries: [] as { key: string; name: string; color: string; unit: string; min: number; avg: number; max: number }[] };
    const summaries: { key: string; name: string; color: string; unit: string; min: number; avg: number; max: number }[] = [];
    const series = values.flatMap((result, index) => {
      const request = requests()[index];
      const aggregates = result.aggregates ?? [];
      const samples = result.samples ?? [];
      if (aggregates.length === 0 && samples.length === 0) return [];
      const key = `${request.def.id}:${request.parameterName}`;
      const max = Math.max(0, ...aggregates.flatMap(sample => [Math.abs(sample.min), Math.abs(sample.max)]), ...samples.map(sample => Math.abs(sample.value)));
      const scale = computeUnitScale(max, request.def.unit_scale);
      const unit = effectiveUnit(request.def.unit, request.def.unit_scale, scale.suffix);
      const displayUnit = request.def.transform === 'rate' && request.def.unit_scale !== 'pps' && unit && !unit.endsWith('/s') ? `${unit}/s` : unit;
      const bucketMs = bucket().value === '1h' ? 60 * 60_000 : bucket().value === '1d' ? 24 * 60 * 60_000 : 15 * 60_000;
      const lastAggregateEnd = aggregates.length > 0
        ? Math.max(...aggregates.map(sample => new Date(sample.timestamp).getTime())) + bucketMs
        : Number.NEGATIVE_INFINITY;
      const points = [
        ...aggregates.map(sample => ({ timestamp: sample.timestamp, value: sample.avg, min: sample.min, max: sample.max, count: sample.count })),
        ...samples.filter(sample => new Date(sample.timestamp).getTime() >= lastAggregateEnd).map(sample => ({ timestamp: sample.timestamp, value: sample.value, min: sample.value, max: sample.value, count: 1 })),
      ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const totalCount = points.reduce((sum, point) => sum + point.count, 0);
      summaries.push({
        key,
        name: request.def.name,
        color: request.def.color || '#38bdf8',
        unit: displayUnit,
        min: Math.min(...points.map(point => point.min)) / scale.divisor,
        avg: points.reduce((sum, point) => sum + point.value * point.count, 0) / Math.max(totalCount, 1) / scale.divisor,
        max: Math.max(...points.map(point => point.max)) / scale.divisor,
      });
      return [{
        id: key,
        name: request.def.name,
        type: request.def.chart_type || 'line',
        showSymbol: false,
        itemStyle: { color: summaries[summaries.length - 1].color },
        lineStyle: { color: summaries[summaries.length - 1].color },
        data: points.map(point => [new Date(point.timestamp).getTime(), point.value / scale.divisor]),
      }];
    });
    return { series, summaries };
  });
  const formatValue = (value: number) => Number(value).toFixed(2);
  const visibleChartData = createMemo(() => {
    const { series, summaries } = chartData();
    const selected = selectedSeriesKey();
    if (!selected) return { series, summaries };
    return { series: series.filter(item => item.id === selected), summaries: summaries.filter(item => item.key === selected) };
  });
  const unitLabel = createMemo(() => [...new Set(visibleChartData().summaries.map(item => item.unit).filter(Boolean))].join(' / '));
  const changeBucket = (option: typeof BUCKET_OPTIONS[number]) => {
    setBucket(option);
    try { localStorage.setItem(`acs_interface_metric_interval_${props.serial}_${props.interfacePath}`, option.label); } catch { /* Ignore unavailable local storage. */ }
  };

  createEffect(() => {
    const el = element();
    const { series: data, summaries } = visibleChartData();
    if (!el || data.length === 0) return;
    if (!chart) {
      chart = echarts.init(el);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(el);
    }
    chart.setOption({
      animation: false,
      color: data.map(item => item.itemStyle.color),
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const points = Array.isArray(params) ? params : [params];
          const heading = points.length ? new Date(points[0].value[0]).toLocaleString() : '';
          return [heading, ...points.map(point => {
            const summary = summaries[point.seriesIndex];
            return `${point.seriesName}: ${formatValue(point.value[1])}${summary?.unit ? ` ${summary.unit}` : ''}`;
          })].join('<br/>');
        },
      },
      toolbox: {
        top: 0,
        right: 8,
        itemSize: 14,
        feature: {
          dataZoom: {
            yAxisIndex: 'none',
            title: { zoom: 'Drag to select a time range', back: 'Undo zoom' },
          },
        },
      },
      grid: { left: 60, right: 18, top: 34, bottom: 48 },
      xAxis: { type: 'time', axisLabel: { color: '#71717a', fontSize: 10 }, splitLine: { show: false } },
      yAxis: { type: 'value', name: unitLabel(), nameTextStyle: { color: '#71717a', fontSize: 10 }, axisLabel: { color: '#71717a', fontSize: 10, formatter: (value: number) => formatValue(value) }, splitLine: { lineStyle: { color: 'rgba(71,85,105,0.15)' } } },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }],
      series: data,
    }, { notMerge: true });
  });

  onCleanup(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });

  return <div class="space-y-2">
    <div class="flex justify-end gap-1" role="group" aria-label="Interface metric history range">
      <For each={BUCKET_OPTIONS}>{option => <button type="button" class={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${bucket().label === option.label ? 'bg-sky-500/20 text-sky-400' : 'text-muted hover:text-secondary'}`} aria-pressed={bucket().label === option.label} onClick={() => changeBucket(option)}>{option.label}</button>}</For>
    </div>
    <Show when={results.loading}><div class="skeleton h-56 w-full" /></Show>
    <Show when={!results.loading && results.error}><p class="h-56 flex items-center justify-center text-sm text-rose-400">Could not load interface statistics.</p></Show>
    <Show when={!results.loading && !results.error && requests().length === 0}><p class="h-56 flex items-center justify-center text-sm text-muted">No configured metrics match this interface.</p></Show>
    <Show when={!results.loading && !results.error && requests().length > 0 && chartData().series.length === 0}><p class="h-56 flex items-center justify-center text-sm text-muted">No samples yet. The next device metric poll will collect matching parameters.</p></Show>
    <Show when={!results.loading && !results.error && chartData().series.length > 0}>
      <div ref={setElement} class="h-64 w-full" />
      <div class="space-y-1 px-2 text-xs text-muted">
        <For each={chartData().summaries}>{item => <button type="button" class={`flex w-full items-center gap-2 rounded text-left transition-opacity ${selectedSeriesKey() !== null && selectedSeriesKey() !== item.key ? 'opacity-40' : 'hover:bg-elevated/50'}`} aria-pressed={selectedSeriesKey() === item.key} onClick={() => setSelectedSeriesKey(current => current === item.key ? null : item.key)}>
          <span class="chart-color-swatch h-2 w-2 rounded-full" data-dynamic-style="chart-color" style={{ '--chart-color': item.color } as any} />
          <span class="min-w-0 flex-1 truncate font-medium text-foreground">{item.name}</span>
          <span class="shrink-0 text-right">Min {formatValue(item.min)}{item.unit ? ` ${item.unit}` : ''} · Avg {formatValue(item.avg)}{item.unit ? ` ${item.unit}` : ''} · Max {formatValue(item.max)}{item.unit ? ` ${item.unit}` : ''}</span>
        </button>}</For>
      </div>
    </Show>
  </div>;
};

export default InterfaceMetricChart;
