import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, createEffect, onCleanup, Show } from 'solid-js';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PictorialBarChart, ScatterChart, EffectScatterChart, CandlestickChart, BoxplotChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api, type InterfaceMetricDefinition } from '../lib/api';

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
  const series = createMemo(() => {
    const values = results();
    if (!values) return [];
    return values.flatMap((result, index) => {
      const request = requests()[index];
      return result.samples?.length ? [{
        name: request.def.name,
        type: request.def.chart_type || 'line',
        showSymbol: false,
        itemStyle: { color: request.def.color || '#38bdf8' },
        lineStyle: { color: request.def.color || '#38bdf8' },
        data: result.samples.map(sample => [new Date(sample.timestamp).getTime(), sample.value]),
      }] : [];
    });
  });

  createEffect(() => {
    const el = element();
    const data = series();
    if (!el || data.length === 0) return;
    if (!chart) {
      chart = echarts.init(el);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(el);
    }
    chart.setOption({
      animation: false,
      color: props.definitions.map(def => def.color || '#38bdf8'),
      tooltip: { trigger: 'axis' },
      legend: { textStyle: { color: '#a1a1aa', fontSize: 10 } },
      grid: { left: 52, right: 18, top: 34, bottom: 48 },
      xAxis: { type: 'time', axisLabel: { color: '#71717a', fontSize: 10 }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: '#71717a', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(71,85,105,0.15)' } } },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }],
      series: data,
    }, { notMerge: true });
  });

  onCleanup(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });

  return <div class="space-y-2">
    <Show when={results.loading}><div class="skeleton h-56 w-full" /></Show>
    <Show when={!results.loading && results.error}><p class="h-56 flex items-center justify-center text-sm text-rose-400">Could not load interface statistics.</p></Show>
    <Show when={!results.loading && !results.error && requests().length === 0}><p class="h-56 flex items-center justify-center text-sm text-muted">No configured metrics match this interface.</p></Show>
    <Show when={!results.loading && !results.error && requests().length > 0 && series().length === 0}><p class="h-56 flex items-center justify-center text-sm text-muted">No samples yet. The next device metric poll will collect matching parameters.</p></Show>
    <Show when={!results.loading && !results.error && series().length > 0}><div ref={setElement} class="h-64 w-full" /></Show>
  </div>;
};

export default InterfaceMetricChart;
