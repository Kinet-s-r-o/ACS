import type { Component } from 'solid-js';
import { onMount, onCleanup, createEffect, Show } from 'solid-js';
import * as echarts from 'echarts/core';
import { GaugeChart } from 'echarts/charts';
import { CanvasRenderer } from 'echarts/renderers';
import { gaugeZones } from '../lib/health';
import type { Threshold } from '../lib/api';
import type { GaugeStyle } from '../lib/api';

echarts.use([GaugeChart, CanvasRenderer]);

interface HealthGaugeProps {
  value: number | null;
  min: number;
  max: number;
  color: string;
  label: string;
  centerText: string;
  animated: boolean;
  thresholds?: Threshold[];
  warn?: number | null;
  critical?: number | null;
  direction?: 'higher_is_worse' | 'lower_is_worse';
  arc?: string;
  pointer?: boolean;
  values?: { value: number | null; label: string; centerText: string }[];
  gaugeStyle?: GaugeStyle;
}

const HealthGauge: Component<HealthGaugeProps> = (props) => {
  let chartRef: HTMLDivElement | undefined;
  let chart: echarts.ECharts | null = null;

  const buildOption = () => {
    const { value, min, max, centerText, animated, warn, critical, direction, thresholds, arc, pointer, gaugeStyle } = props;
    const safeVal = value ?? min;
    const range = max - min || 1;

    // Build color zones. Custom thresholds take precedence over legacy warn/critical.
    let zones: [number, string][];
    if (thresholds && thresholds.length > 0) {
      zones = gaugeZones(thresholds, min, max);
    } else if (direction === 'lower_is_worse') {
      zones = [];
      if (critical != null && critical > min) {
        zones.push([Number(((critical - min) / range).toFixed(4)), '#f43f5e']);
      }
      if (warn != null && warn > min) {
        zones.push([Number(((warn - min) / range).toFixed(4)), '#f59e0b']);
      }
      zones.push([1, '#10b981']);
    } else if (gaugeStyle === 'speed') {
      zones = [[0.65, '#22c55e'], [0.85, '#f59e0b'], [1, '#f43f5e']];
    } else if (gaugeStyle === 'stage') {
      zones = [[0.78, '#41d3e8'], [0.9, '#41d3e8'], [1, '#f43f5e']];
    } else if (gaugeStyle === 'grade') {
      zones = [[0.2, '#fb7185'], [0.4, '#fbbf24'], [0.6, '#fde047'], [0.8, '#38bdf8'], [1, '#4ade80']];
    } else if (gaugeStyle === 'barometer') {
      zones = [[0.25, '#38bdf8'], [0.5, '#34d399'], [0.75, '#fbbf24'], [1, '#fb7185']];
    } else if (gaugeStyle === 'temperature') {
      zones = [[0.55, '#38bdf8'], [0.8, '#f59e0b'], [1, '#f97316']];
    } else {
      zones = [];
      if (warn != null && warn < max) {
        zones.push([Number(((warn - min) / range).toFixed(4)), '#10b981']);
      }
      if (critical != null && critical < max) {
        zones.push([Number(((critical - min) / range).toFixed(4)), '#f59e0b']);
      }
      zones.push([1, '#f43f5e']);
    }

    // Arc angle is set by the selected style and remains user-adjustable.
    let startAngle = 200;
    let endAngle = -20;
    if (arc === '180') { startAngle = 180; endAngle = 0; }
    else if (arc === '220') { startAngle = 200; endAngle = -20; }
    else if (arc === '360') { startAngle = 90; endAngle = -270; }
    const gaugeWidth = gaugeStyle === 'ring' ? 18 : gaugeStyle === 'temperature' ? 22 : gaugeStyle === 'progress' ? 18 : 12;
    const progressColor = gaugeStyle === 'temperature' ? '#ffab91' : gaugeStyle === 'stage' ? '#41d3e8' : gaugeStyle === 'speed' ? '#58d9f9' : '#38bdf8';
    const showScale = ['speed', 'temperature', 'stage', 'grade', 'barometer'].includes(gaugeStyle || '');
    const showPointer = pointer !== false && ['basic', 'simple', 'speed', 'barometer'].includes(gaugeStyle || '');
    const labelOffset = gaugeStyle === 'ring' || gaugeStyle === 'multi' ? '0%' : gaugeStyle === 'progress' ? '68%' : gaugeStyle === 'temperature' ? '-15%' : '35%';
    const showProgress = ['simple', 'speed', 'progress', 'stage', 'temperature', 'ring'].includes(gaugeStyle || '');

    return {
      animation: animated,
      animationDuration: 600,
      animationEasing: 'cubicOut' as const,
      series: [
        {
          type: 'gauge' as const,
          min,
          max,
          startAngle,
          endAngle,
          radius: gaugeStyle === 'ring' ? '82%' : '90%',
          splitNumber: gaugeStyle === 'speed' ? 12 : gaugeStyle === 'grade' ? 4 : 10,
          progress: {
            show: showProgress,
            width: gaugeWidth,
            overlap: gaugeStyle === 'ring' || gaugeStyle === 'multi' ? false : undefined,
            roundCap: ['ring', 'speed', 'simple'].includes(gaugeStyle || ''),
            itemStyle: { color: progressColor },
          },
          axisLine: {
            roundCap: ['ring', 'speed', 'simple'].includes(gaugeStyle || ''),
            lineStyle: {
              width: gaugeWidth,
              color: gaugeStyle === 'progress' || gaugeStyle === 'ring' || gaugeStyle === 'multi'
                ? [[1, '#263244']]
                : zones,
            },
          },
          pointer: {
            show: showPointer,
            length: '60%',
            width: 4,
            itemStyle: { color: 'auto' },
          },
          axisTick: { show: showScale, splitNumber: gaugeStyle === 'temperature' ? 5 : 2, distance: gaugeStyle === 'temperature' ? -gaugeWidth - 8 : -gaugeWidth - 2, length: gaugeStyle === 'barometer' ? 5 : 4, lineStyle: { color: gaugeStyle === 'grade' ? 'auto' : '#94a3b8', width: 1 } },
          splitLine: { show: showScale, distance: gaugeStyle === 'temperature' ? -gaugeWidth - 14 : -gaugeWidth - 4, length: gaugeStyle === 'barometer' ? 12 : 8, lineStyle: { color: gaugeStyle === 'grade' ? 'auto' : '#cbd5e1', width: 2 } },
          axisLabel: { show: showScale, distance: gaugeStyle === 'temperature' ? -gaugeWidth + 2 : 12, color: gaugeStyle === 'grade' ? 'auto' : '#94a3b8', fontSize: gaugeStyle === 'barometer' ? 9 : 8 },
          detail: {
            valueAnimation: true,
            formatter: (value: number) => props.values?.length ? props.values.find(item => item.value === value)?.centerText ?? String(value) : centerText,
            color: gaugeStyle === 'temperature' ? '#ffab91' : 'inherit',
            backgroundColor: gaugeStyle === 'speed' ? '#fff' : undefined,
            borderColor: gaugeStyle === 'speed' ? '#999' : undefined,
            borderWidth: gaugeStyle === 'speed' ? 1 : 0,
            borderRadius: gaugeStyle === 'speed' ? 4 : 0,
            fontSize: gaugeStyle === 'ring' || gaugeStyle === 'progress' ? 18 : gaugeStyle === 'temperature' ? 16 : 14,
            fontWeight: 'bold',
            offsetCenter: [0, labelOffset],
          },
          title: {
            show: gaugeStyle !== 'ring' && gaugeStyle !== 'progress',
            fontSize: 10,
            color: '#71717a',
            offsetCenter: [0, gaugeStyle === 'temperature' ? '88%' : '95%'],
          },
          data: props.values?.length
            ? props.values.filter(item => item.value !== null).map((item, index, items) => ({
              value: item.value!,
              name: item.label,
              ...(gaugeStyle === 'multi' ? {
                title: { offsetCenter: [0, `${-24 + index * (48 / Math.max(1, items.length - 1))}%`] },
                detail: { offsetCenter: [0, `${-12 + index * (48 / Math.max(1, items.length - 1))}%`], formatter: () => item.centerText },
              } : {}),
            }))
            : [{ value: safeVal, name: props.label }],
        },
      ],
    };
  };

  onMount(() => {
    if (chartRef) {
      chart = echarts.init(chartRef, null, { renderer: 'canvas' });
      chart.setOption(buildOption() as any);
    }
  });

  createEffect(() => {
    if (chart) {
      chart.setOption(buildOption() as any, { notMerge: true });
    }
  });

  onCleanup(() => {
    if (chart) {
      chart.dispose();
      chart = null;
    }
  });

  return (
    <div>
      <Show when={props.value !== null}>
        <div ref={chartRef!} class={`w-full ${props.gaugeStyle === 'ring' ? 'h-[108px]' : 'h-[96px]'}`} />
      </Show>
      <Show when={props.value === null}>
        <div class="flex items-center justify-center h-20 text-muted text-lg font-mono">-</div>
      </Show>
    </div>
  );
};

export default HealthGauge;
