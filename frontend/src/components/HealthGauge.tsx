import type { Component } from 'solid-js';
import { onMount, onCleanup, createEffect, Show } from 'solid-js';
import * as echarts from 'echarts/core';
import { GaugeChart } from 'echarts/charts';
import { CanvasRenderer } from 'echarts/renderers';
import { gaugeZones } from '../lib/health';
import type { Threshold } from '../lib/api';

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
  gaugeStyle?: 'basic' | 'progress' | 'ring' | 'speed' | 'temperature';
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
    else if (arc === '360') { startAngle = 90; endAngle = -270; }
    const gaugeWidth = gaugeStyle === 'ring' ? 18 : gaugeStyle === 'temperature' ? 16 : gaugeStyle === 'progress' ? 14 : 12;
    const progressColor = gaugeStyle === 'temperature' ? '#f97316' : gaugeStyle === 'progress' ? '#38bdf8' : '#6366f1';

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
          radius: '90%',
          progress: {
            show: gaugeStyle === 'progress' || gaugeStyle === 'ring' || gaugeStyle === 'temperature',
            width: gaugeWidth,
            roundCap: gaugeStyle === 'ring',
            itemStyle: { color: progressColor },
          },
          axisLine: {
            lineStyle: {
              width: gaugeWidth,
              color: gaugeStyle === 'progress' || gaugeStyle === 'ring' || gaugeStyle === 'temperature'
                ? [[1, '#263244']]
                : zones,
            },
          },
          pointer: {
            show: pointer !== false && gaugeStyle !== 'ring' && gaugeStyle !== 'temperature',
            length: '60%',
            width: 4,
            itemStyle: { color: 'auto' },
          },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          detail: {
            valueAnimation: true,
            formatter: (value: number) => props.values?.length ? props.values.find(item => item.value === value)?.centerText ?? String(value) : centerText,
            color: 'inherit',
            fontSize: 14,
            fontWeight: 'bold',
            offsetCenter: [0, '70%'],
          },
          title: {
            show: true,
            fontSize: 10,
            color: '#71717a',
            offsetCenter: [0, '95%'],
          },
          data: props.values?.length
            ? props.values.filter(item => item.value !== null).map(item => ({ value: item.value!, name: item.label }))
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
        <div ref={chartRef!} style={{ width: '100%', height: '80px' }} />
      </Show>
      <Show when={props.value === null}>
        <div class="flex items-center justify-center h-20 text-muted text-lg font-mono">-</div>
      </Show>
    </div>
  );
};

export default HealthGauge;
