import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PictorialBarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api, type InterfaceMetricDefinition } from '../lib/api';
import { computeUnitScale, effectiveUnit } from '../lib/health';

echarts.use([LineChart, BarChart, PictorialBarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface Props {
  serial: string;
  definitions: InterfaceMetricDefinition[];
  interfacePath: string;
  parameterNames: string[];
}

const matches = (pattern: string, name: string) => {
  const p = pattern.split('.');
  const n = name.split('.');
  return p.length === n.length && p.every((segment, index) => segment === '*' || segment === n[index]);
};

const InterfaceMetricChart: Component<Props> = (props) => {
  const [element, setElement] = createSignal<HTMLDivElement>();
  let chart: echarts.ECharts | undefined;
  let observer: ResizeObserver | undefined;
  const requests = createMemo(() => props.definitions.flatMap(def =>
    props.parameterNames.filter(name => name.startsWith(props.interfacePath) && matches(def.parameter_pattern, name))
      .map(parameterName => ({ def, parameterName }))));
  const [results] = createResource(
    () => ({ serial: props.serial, requests: requests().map(item => `${item.def.id}:${item.parameterName}`).join('|') }),
    async () => Promise.all(requests().map(item => api.getDeviceInterfaceMetric(props.serial, item.def.id, item.parameterName, 24))),
  );
  const chartData = createMemo(() => {
    const values = results();
    if (!values) return { series: [], summaries: [] as { name: string; color: string; unit: string; min: number; avg: number; max: number }[] };
    const summaries: { name: string; color: string; unit: string; min: number; avg: number; max: number }[] = [];
    const series = values.flatMap((result, index) => {
      const request = requests()[index];
      if (!result.samples?.length) return [];
      const max = Math.max(...result.samples.map(sample => Math.abs(sample.value)));
      const scale = computeUnitScale(max, request.def.unit_scale);
      const unit = effectiveUnit(request.def.unit, request.def.unit_scale, scale.suffix);
      const displayUnit = request.def.transform === 'rate' && unit && !unit.endsWith('/s') ? `${unit}/s` : unit;
      const scaledValues = result.samples.map(sample => sample.value / scale.divisor);
      summaries.push({
        name: request.def.name,
        color: request.def.color || '#38bdf8',
        unit: displayUnit,
        min: Math.min(...scaledValues),
        avg: scaledValues.reduce((sum, value) => sum + value, 0) / scaledValues.length,
        max: Math.max(...scaledValues),
      });
      return [{
        name: request.def.name,
        type: request.def.chart_type || 'line',
        showSymbol: false,
        itemStyle: { color: summaries[summaries.length - 1].color },
        lineStyle: { color: summaries[summaries.length - 1].color },
        data: result.samples.map((sample, sampleIndex) => [new Date(sample.timestamp).getTime(), scaledValues[sampleIndex]]),
      }];
    });
    return { series, summaries };
  });
  const formatValue = (value: number) => Number(value).toFixed(2);
  const unitLabel = createMemo(() => [...new Set(chartData().summaries.map(item => item.unit).filter(Boolean))].join(' / '));

  createEffect(() => {
    const el = element();
    const { series: data, summaries } = chartData();
    if (!el || data.length === 0) return;
    if (!chart) {
      chart = echarts.init(el);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(el);
    }
    chart.setOption({
      animation: false,
      color: props.definitions.map(def => def.color || '#38bdf8'),
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
      grid: { left: 60, right: 18, top: 34, bottom: 48 },
      xAxis: { type: 'time', axisLabel: { color: '#71717a', fontSize: 10 }, splitLine: { show: false } },
      yAxis: { type: 'value', name: unitLabel(), nameTextStyle: { color: '#71717a', fontSize: 10 }, axisLabel: { color: '#71717a', fontSize: 10, formatter: (value: number) => formatValue(value) }, splitLine: { lineStyle: { color: 'rgba(71,85,105,0.15)' } } },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }],
      series: data,
    }, { notMerge: true });
  });

  onCleanup(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });

  return <div class="space-y-2">
    <Show when={results.loading}><div class="skeleton h-56 w-full" /></Show>
    <Show when={!results.loading && results.error}><p class="h-56 flex items-center justify-center text-sm text-rose-400">Could not load interface statistics.</p></Show>
    <Show when={!results.loading && !results.error && requests().length === 0}><p class="h-56 flex items-center justify-center text-sm text-muted">No configured metrics match this interface.</p></Show>
    <Show when={!results.loading && !results.error && requests().length > 0 && chartData().series.length === 0}><p class="h-56 flex items-center justify-center text-sm text-muted">No samples yet. The next device metric poll will collect matching parameters.</p></Show>
    <Show when={!results.loading && !results.error && chartData().series.length > 0}>
      <div ref={setElement} class="h-64 w-full" />
      <div class="space-y-1 px-2 text-xs text-muted">
        <For each={chartData().summaries}>{item => <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="inline-block h-2 w-2 rounded-full" style={{ 'background-color': item.color }} />
          <span class="font-medium text-foreground">{item.name}</span>
          <span>Min {formatValue(item.min)}{item.unit ? ` ${item.unit}` : ''} · Avg {formatValue(item.avg)}{item.unit ? ` ${item.unit}` : ''} · Max {formatValue(item.max)}{item.unit ? ` ${item.unit}` : ''}</span>
        </div>}</For>
      </div>
    </Show>
  </div>;
};

export default InterfaceMetricChart;
