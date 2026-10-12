import type { MetricDefinition, Threshold } from './api';

export interface HealthTile {
  label: string;
  value: string;
  color: string;
  raw?: number | null;
  format?: string;
  min?: number;
  max?: number;
  animated?: boolean;
  thresholds?: Threshold[];
  arc?: string;
  pointer?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export interface HealthTileGroup {
  label?: string;
  tiles: HealthTile[];
  size: 'small' | 'medium' | 'large';
}

export interface UnitScale {
  divisor: number;
  suffix: string;
}

export function computeUnitScale(value: number | null, mode: string): UnitScale {
  const max = Math.max(0, value ?? 0);
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
  } else if (mode === 'bytes') {
    if (max >= 1024 ** 4) return { divisor: 1024 ** 4, suffix: 'TB' };
    if (max >= 1024 ** 3) return { divisor: 1024 ** 3, suffix: 'GB' };
    if (max >= 1024 ** 2) return { divisor: 1024 ** 2, suffix: 'MB' };
    if (max >= 1024) return { divisor: 1024, suffix: 'KB' };
    return { divisor: 1, suffix: 'B' };
  } else if (mode === 'bits') {
    if (max >= 1e12) return { divisor: 1e12, suffix: 'Tb' };
    if (max >= 1e9) return { divisor: 1e9, suffix: 'Gb' };
    if (max >= 1e6) return { divisor: 1e6, suffix: 'Mb' };
    if (max >= 1e3) return { divisor: 1e3, suffix: 'Kb' };
    return { divisor: 1, suffix: 'b' };
  }
  return { divisor: 1, suffix: '' };
}

export function effectiveUnit(unit: string, scaleMode: string, suffix: string): string {
  if (scaleMode === 'pps') return suffix || 'pps';
  if (!suffix) return unit;
  if (scaleMode === 'auto') return suffix + unit;
  if (scaleMode === 'bytes' || scaleMode === 'bits') {
    const separator = unit.endsWith('/s') ? '/s' : '';
    return separator ? `${suffix}${separator}` : suffix;
  }
  return unit;
}

export function formatUptime(seconds: number | string): string {
  const secs = typeof seconds === 'string' ? parseInt(seconds) : seconds;
  if (isNaN(secs) || secs <= 0) return '-';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function findHealthValue(params: { name: string; value: string }[], def: MetricDefinition): number | null {
  const p = params.find(p => p.name === def.parameter_name);
  if (!p) return null;
  const num = parseFloat(p.value);
  if (isNaN(num)) return null;
  return num * (def.multiplier || 1);
}

export function formatHealthValue(v: number | null, def: MetricDefinition): string {
  if (v === null) return '-';
  if (def.display_format === 'uptime') return formatUptime(v);
  const scale = computeUnitScale(v, def.unit_scale);
  const unit = effectiveUnit(def.unit, def.unit_scale, scale.suffix);
  return `${(v / scale.divisor).toFixed(1)}${unit ? ` ${unit}` : ''}`;
}

/**
 * Returns the color of the threshold band that contains the given value.
 * Thresholds are sorted by value; each threshold marks the start of a band.
 * Returns null when no thresholds are configured.
 */
export function thresholdBandColor(v: number, thresholds: Threshold[]): string | null {
  if (!thresholds || thresholds.length === 0) return null;
  const sorted = [...thresholds].sort((a, b) => a.value - b.value);
  let band = sorted[0];
  for (const t of sorted) {
    if (v >= t.value) band = t;
  }
  return band.color;
}

export function healthColor(v: number | null, def: MetricDefinition): string {
  if (v === null) return 'text-muted';
  if (def.thresholds && def.thresholds.length > 0) {
    const c = thresholdBandColor(v, def.thresholds);
    if (c) return c;
  }
  const warn = def.warn_threshold;
  const crit = def.critical_threshold;
  if (warn === null && crit === null) return 'text-secondary';
  if (def.threshold_direction === 'lower_is_worse') {
    if (crit !== null && v <= crit) return 'text-rose-400';
    if (warn !== null && v <= warn) return 'text-amber-400';
    return 'text-emerald-400';
  }
  if (crit !== null && v >= crit) return 'text-rose-400';
  if (warn !== null && v >= warn) return 'text-amber-400';
  return 'text-emerald-400';
}

export function gaugeRange(v: number | null, def: MetricDefinition): { min: number; max: number } {
  if (def.gauge_min != null && def.gauge_max != null) {
    return { min: def.gauge_min, max: def.gauge_max > def.gauge_min ? def.gauge_max : def.gauge_min + 100 };
  }
  if (def.thresholds && def.thresholds.length > 0) {
    const values = def.thresholds.map(t => t.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max: max > min ? max : min + 100 };
  }
  const warn = def.warn_threshold;
  const crit = def.critical_threshold;
  const val = v ?? 0;

  if (def.threshold_direction === 'lower_is_worse') {
    const min = crit ?? (warn !== null ? warn * 0.5 : Math.max(0, val * 0.5));
    const max = warn !== null ? warn * 2 : (crit !== null ? crit * 2 : (val !== 0 ? val * 2 : 100));
    return { min, max: max > min ? max : min + 100 };
  }

  // higher_is_worse (default)
  const min = 0;
  const max = crit ?? (warn !== null ? warn * 1.5 : (val > 0 ? val * 1.5 : 100));
  return { min, max: max > 0 ? max : 100 };
}

/**
 * Builds ECharts gauge zones from a list of thresholds.
 * Each threshold marks the start of a band; the band runs until the next threshold.
 * Returns [[fraction, color], ...] sorted by fraction, covering 0..1.
 */
export function gaugeZones(thresholds: Threshold[], min: number, max: number): [number, string][] {
  if (!thresholds || thresholds.length === 0) return [];
  const sorted = [...thresholds].sort((a, b) => a.value - b.value);
  const range = max - min || 1;
  const zones: [number, string][] = [];
  for (const t of sorted) {
    const frac = Number(((t.value - min) / range).toFixed(4));
    if (frac >= 0 && frac <= 1) zones.push([frac, t.color]);
  }
  if (zones.length === 0) return [];
  if (zones[0][0] > 0) zones.unshift([0, zones[0][1]]);
  if (zones[zones.length - 1][0] < 1) zones.push([1, zones[zones.length - 1][1]]);
  return zones;
}

/**
 * Returns the threshold lines to draw as reference lines on a chart.
 * Falls back to warn/critical when no custom thresholds are set.
 */
export function thresholdLines(def: MetricDefinition): { value: number; color: string }[] {
  if (def.thresholds && def.thresholds.length > 0) {
    return def.thresholds.map(t => ({ value: t.value, color: t.color }));
  }
  const lines: { value: number; color: string }[] = [];
  if (def.warn_threshold != null) lines.push({ value: def.warn_threshold, color: '#f59e0b' });
  if (def.critical_threshold != null) lines.push({ value: def.critical_threshold, color: '#f43f5e' });
  return lines;
}
