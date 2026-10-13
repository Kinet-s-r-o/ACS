import type { Component } from 'solid-js';
import { createEffect, createSignal, onCleanup, Show, For } from 'solid-js';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  runs: Array<{ mode: 'UPLOAD' | 'DOWNLOAD'; values: Record<string, string> }>;
}

const IperfResult: Component<Props> = (props) => {
  const [element, setElement] = createSignal<HTMLDivElement>();
  let chart: echarts.ECharts | undefined;
  let observer: ResizeObserver | undefined;
  const field = (run: Props['runs'][number], suffix: string) => Object.entries(run.values).find(([name]) => name.endsWith(`.${suffix}`))?.[1] || '';
  const runData = (run: Props['runs'][number]) => {
    let parsed: any = null;
    try { parsed = JSON.parse(field(run, 'TestResult')); } catch { /* Raw result may be plain text on some firmware. */ }
    const end = parsed?.end;
    const bps = run.mode === 'UPLOAD'
      ? Number(end?.sum_sent?.bits_per_second ?? end?.sum?.bits_per_second ?? 0)
      : Number(end?.sum_received?.bits_per_second ?? end?.sum?.bits_per_second ?? 0);
    return { rate: bps / 1_000_000, parsed };
  };
  const formatRate = (value: number) => value > 0 ? `${value.toFixed(2)} Mbps` : '—';

  createEffect(() => {
    const el = element();
    const rates = props.runs.map(run => runData(run).rate);
    if (!el || !rates.some(rate => rate > 0)) return;
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
      yAxis: { type: 'category', data: props.runs.map(run => run.mode === 'UPLOAD' ? 'Upload' : 'Download'), axisLabel: { color: '#94a3b8' } },
      series: [{ type: 'bar', data: rates, barMaxWidth: 32, itemStyle: { color: '#38bdf8', borderRadius: [0, 5, 5, 0] }, label: { show: true, position: 'right', color: '#cbd5e1', formatter: ({ value }: { value: number }) => `${value.toFixed(2)} Mbps` } }],
    }, { notMerge: true });
  });

  onCleanup(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });

  return <div class="space-y-3">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {props.runs.map(run => <div class="rounded bg-base px-4 py-3">
        <div class="text-xs text-muted">{run.mode === 'UPLOAD' ? 'Upload' : 'Download'} throughput</div>
        <div class="mt-1 text-lg font-semibold text-primary">{formatRate(runData(run).rate)}</div>
        <div class="mt-1 text-xs text-muted">Status: {field(run, 'DiagnosticsState') || '—'}</div>
        <Show when={field(run, 'ErrorDescription')}><div class="mt-1 text-xs text-rose-400 break-words">{field(run, 'ErrorDescription')}</div></Show>
      </div>)}
    </div>
    <Show when={props.runs.some(run => runData(run).rate > 0)}>
      <div ref={setElement} class="h-52 w-full" aria-label="iPerf upload and download throughput chart" />
    </Show>
    <For each={props.runs}>{(run) => <details class="rounded border border-subtle px-3 py-2">
      <summary class="cursor-pointer text-xs font-medium text-secondary">{run.mode === 'UPLOAD' ? 'Upload' : 'Download'} raw result</summary>
      <Show when={field(run, 'ReportTime')}><p class="mt-2 text-xs text-muted">Report time: {field(run, 'ReportTime')}</p></Show>
      <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{field(run, 'TestResult') || Object.entries(run.values).map(([name, value]) => `${name.split('.').pop()}: ${value}`).join('\n') || 'No detailed result returned.'}</pre>
    </details>}</For>
  </div>;
};

export default IperfResult;
