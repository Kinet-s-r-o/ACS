import type { Component } from 'solid-js';
import { createEffect, createResource, createSignal, onCleanup, Show } from 'solid-js';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api, type DeviceGrowthInterval } from '../lib/api';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  interval: DeviceGrowthInterval;
  refreshKey?: number;
}

const DeviceGrowthChart: Component<Props> = (props) => {
  const [element, setElement] = createSignal<HTMLDivElement>();
  const [themeMode, setThemeMode] = createSignal(document.documentElement.getAttribute('data-theme'));
  let chart: echarts.ECharts | undefined;
  let observer: ResizeObserver | undefined;
  let themeObserver: MutationObserver | undefined;
  let chartElement: HTMLDivElement | undefined;
  const [growth] = createResource(
    () => ({ interval: props.interval, refreshKey: props.refreshKey ?? 0 }),
    ({ interval }) => api.getDeviceGrowth(interval),
  );

  createEffect(() => {
    const el = element();
    themeMode();
    const points = growth()?.points ?? [];
    if (!el || points.length === 0) {
      observer?.disconnect();
      themeObserver?.disconnect();
      chart?.dispose();
      observer = undefined;
      themeObserver = undefined;
      chart = undefined;
      chartElement = undefined;
      return;
    }
    if (chartElement && chartElement !== el) {
      observer?.disconnect();
      themeObserver?.disconnect();
      chart?.dispose();
      observer = undefined;
      themeObserver = undefined;
      chart = undefined;
      chartElement = undefined;
    }
    if (!chart) {
      chart = echarts.init(el);
      chartElement = el;
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(el);
      themeObserver = new MutationObserver(() => setThemeMode(document.documentElement.getAttribute('data-theme')));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    const styles = getComputedStyle(document.documentElement);
    const textColor = styles.getPropertyValue('--text-muted').trim();
    const borderColor = styles.getPropertyValue('--border-subtle').trim();
    const lineColor = styles.getPropertyValue('--accent').trim();
    const onlineLineColor = styles.getPropertyValue('--success').trim();
    const isDark = themeMode() !== 'light';
    const axisColor = isDark ? '#ffffff' : textColor ? `rgb(${textColor})` : '#64748b';
    const gridColor = isDark ? 'rgba(148,163,184,0.18)' : borderColor ? `rgb(${borderColor})` : 'rgba(100,116,139,0.2)';
    const seriesColor = lineColor ? `rgb(${lineColor})` : '#0ea5e9';
    const onlineColor = onlineLineColor ? `rgb(${onlineLineColor})` : '#22c55e';
    chart.setOption({
      animation: false,
      legend: { top: 0, right: 12, textStyle: { color: axisColor, fontSize: 12 } },
      grid: { left: 52, right: 18, top: 32, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const points = Array.isArray(params) ? params : [params];
          if (!points.length) return '';
          return [new Date(points[0].value[0]).toLocaleString(), ...points.map((point) => `${point.marker}${point.seriesName}: <strong>${Number(point.value[1]).toLocaleString()}</strong>`)].join('<br/>');
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: axisColor, fontSize: 12 },
        axisLine: { lineStyle: { color: gridColor } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        minInterval: 1,
        axisLabel: { color: axisColor, fontSize: 12, formatter: (value: number) => value.toLocaleString() },
        splitLine: { lineStyle: { color: gridColor } },
      },
      series: [
        {
          name: 'All devices',
          type: 'line',
          smooth: true,
          showSymbol: points.length < 40,
          symbolSize: 6,
          itemStyle: { color: seriesColor },
          lineStyle: { color: seriesColor, width: 2 },
          areaStyle: { color: seriesColor, opacity: 0.08 },
          emphasis: { disabled: true },
          data: points.map((point) => [new Date(point.timestamp).getTime(), point.count]),
        },
        {
          name: 'Online devices',
          type: 'line',
          smooth: true,
          showSymbol: points.length < 40,
          symbolSize: 6,
          itemStyle: { color: onlineColor },
          lineStyle: { color: onlineColor, width: 2 },
          emphasis: { disabled: true },
          data: points.map((point) => [new Date(point.timestamp).getTime(), point.online]),
        },
      ],
    }, { notMerge: true });
  });

  onCleanup(() => {
    observer?.disconnect();
    chart?.dispose();
  });

  return (
    <div class="device-growth-chart" aria-label="Device and online count chart">
      <Show when={!growth.loading && !growth.error && (growth()?.points.length ?? 0) > 0} fallback={<div class="flex h-56 items-center justify-center text-xs text-muted">{growth.loading ? 'Loading device history…' : 'No device history available.'}</div>}>
        <div ref={setElement} class="h-56 w-full" />
      </Show>
      <Show when={growth.error}><p class="py-5 text-center text-xs text-rose-400">Device history is unavailable.</p></Show>
    </div>
  );
};

export default DeviceGrowthChart;
