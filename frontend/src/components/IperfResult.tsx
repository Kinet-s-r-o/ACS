import type { Component } from 'solid-js';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  result: Record<string, string>;
}

const IperfResult: Component<Props> = (props) => {
  const [element, setElement] = createSignal<HTMLDivElement>();
  let chart: echarts.ECharts | undefined;
  let observer: ResizeObserver | undefined;
  const field = (suffix: string) => Object.entries(props.result).find(([name]) => name.endsWith(`.${suffix}`))?.[1] || '';
  const parsed = () => {
    try { return JSON.parse(field('TestResult')); } catch { return null; }
  };
  const throughput = () => {
    const end = parsed()?.end;
    const sent = Number(end?.sum_sent?.bits_per_second ?? end?.sum?.bits_per_second ?? 0) / 1_000_000;
    const received = Number(end?.sum_received?.bits_per_second ?? 0) / 1_000_000;
    return [sent, received];
  };
  const formatRate = (value: number) => value > 0 ? `${value.toFixed(2)} Mbps` : '—';

  createEffect(() => {
    const el = element();
    const [sent, received] = throughput();
    if (!el || sent <= 0 && received <= 0) return;
    if (!chart) {
      chart = echarts.init(el);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(el);
    }
    chart.setOption({
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value: number) => `${value.toFixed(2)} Mbps` },
      grid: { left: 76, right: 24, top: 12, bottom: 24 },
      xAxis: { type: 'value', name: 'Mbps', axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(71,85,105,0.2)' } } },
      yAxis: { type: 'category', data: ['Sent', 'Received'], axisLabel: { color: '#94a3b8' } },
      series: [{ type: 'bar', data: [sent, received], barMaxWidth: 32, itemStyle: { color: '#38bdf8', borderRadius: [0, 5, 5, 0] }, label: { show: true, position: 'right', color: '#cbd5e1', formatter: ({ value }: { value: number }) => `${value.toFixed(2)} Mbps` } }],
    }, { notMerge: true });
  });

  onCleanup(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });

  return <div class="space-y-3">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="rounded bg-base px-4 py-3"><div class="text-xs text-muted">Status</div><div class="mt-1 text-sm font-semibold text-primary">{field('DiagnosticsState') || '—'}</div></div>
      <div class="rounded bg-base px-4 py-3"><div class="text-xs text-muted">Sent throughput</div><div class="mt-1 text-lg font-semibold text-primary">{formatRate(throughput()[0])}</div></div>
      <div class="rounded bg-base px-4 py-3"><div class="text-xs text-muted">Received throughput</div><div class="mt-1 text-lg font-semibold text-primary">{formatRate(throughput()[1])}</div></div>
      <Show when={field('ErrorDescription')}><div class="rounded bg-rose-500/10 px-4 py-3"><div class="text-xs text-rose-300">Error</div><div class="mt-1 text-sm text-rose-200 break-words">{field('ErrorDescription')}</div></div></Show>
    </div>
    <Show when={throughput().some(value => value > 0)}>
      <div ref={setElement} class="h-52 w-full" aria-label="iPerf sent and received throughput chart" />
    </Show>
    <Show when={field('ReportTime')}><p class="text-xs text-muted">Report time: {field('ReportTime')}</p></Show>
    <details class="rounded border border-subtle px-3 py-2">
      <summary class="cursor-pointer text-xs font-medium text-secondary">Raw result details</summary>
      <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{field('TestResult') || Object.entries(props.result).map(([name, value]) => `${name.split('.').pop()}: ${value}`).join('\n') || 'No detailed result returned.'}</pre>
    </details>
  </div>;
};

export default IperfResult;
