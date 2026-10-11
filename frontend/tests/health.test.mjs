import assert from 'node:assert/strict';
import test from 'node:test';
import { findHealthValue, formatHealthValue, healthColor, formatUptime, gaugeRange, thresholdBandColor, gaugeZones, thresholdLines, computeUnitScale, effectiveUnit } from '../src/lib/health.ts';

const baseDef = {
  id: 1, name: 'RX Power', description: '', device_type_match: '*',
  parameter_name: 'InternetGatewayDevice.X_RXPower', unit: 'dBm',
  source: 'passive', active: true, group: '', color: '', axis: 'left',
  transform: '', multiplier: 1, unit_scale: '', health: true,
  warn_threshold: null, critical_threshold: null,
  threshold_direction: 'higher_is_worse', display_format: 'number',
  created_at: '', updated_at: '',
};

// findHealthValue
test('findHealthValue returns null when the parameter is missing', () => {
  assert.equal(findHealthValue([], baseDef), null);
});

test('findHealthValue parses the value and applies the multiplier', () => {
  const def = { ...baseDef, multiplier: 100 };
  assert.equal(findHealthValue([{ name: baseDef.parameter_name, value: '0.5' }], def), 50);
});

test('findHealthValue returns null for a non-numeric value', () => {
  assert.equal(findHealthValue([{ name: baseDef.parameter_name, value: 'N/A' }], baseDef), null);
});

// formatHealthValue
test('formatHealthValue returns a dash for a null value', () => {
  assert.equal(formatHealthValue(null, baseDef), '-');
});

test('formatHealthValue formats a number with its unit', () => {
  assert.equal(formatHealthValue(-20.2, baseDef), '-20.2 dBm');
});

test('formatHealthValue applies bit unit scaling', () => {
  const def = { ...baseDef, unit: 'b/s', unit_scale: 'bits' };
  assert.equal(formatHealthValue(5785963224, def), '5.8 Gb/s');
});

test('unit scaling matches metric chart unit labels', () => {
  assert.deepEqual(computeUnitScale(5785963224, 'bits'), { divisor: 1e9, suffix: 'Gb' });
  assert.equal(effectiveUnit('b/s', 'bits', 'Gb'), 'Gb/s');
});

test('formatHealthValue rounds to one decimal place', () => {
  assert.equal(formatHealthValue(20.26, baseDef), '20.3 dBm');
});

test('formatHealthValue formats uptime when display_format is uptime', () => {
  const def = { ...baseDef, display_format: 'uptime', unit: '' };
  assert.equal(formatHealthValue(90061, def), '1d 1h 1m');
});

// healthColor
test('healthColor returns muted for a null value', () => {
  assert.equal(healthColor(null, baseDef), 'text-muted');
});

test('healthColor returns neutral when no thresholds are configured', () => {
  assert.equal(healthColor(50, baseDef), 'text-secondary');
});

test('healthColor higher_is_worse: below warn is emerald', () => {
  const def = { ...baseDef, warn_threshold: 80, critical_threshold: 90 };
  assert.equal(healthColor(50, def), 'text-emerald-400');
});

test('healthColor higher_is_worse: between warn and critical is amber', () => {
  const def = { ...baseDef, warn_threshold: 80, critical_threshold: 90 };
  assert.equal(healthColor(85, def), 'text-amber-400');
});

test('healthColor higher_is_worse: at or above critical is rose', () => {
  const def = { ...baseDef, warn_threshold: 80, critical_threshold: 90 };
  assert.equal(healthColor(95, def), 'text-rose-400');
});

test('healthColor higher_is_worse: only warn set still colors correctly', () => {
  const def = { ...baseDef, warn_threshold: 80, critical_threshold: null };
  assert.equal(healthColor(95, def), 'text-amber-400');
});

test('healthColor lower_is_worse: above warn is emerald', () => {
  const def = { ...baseDef, threshold_direction: 'lower_is_worse', warn_threshold: 100, critical_threshold: 50 };
  assert.equal(healthColor(500, def), 'text-emerald-400');
});

test('healthColor lower_is_worse: between critical and warn is amber', () => {
  const def = { ...baseDef, threshold_direction: 'lower_is_worse', warn_threshold: 100, critical_threshold: 50 };
  assert.equal(healthColor(80, def), 'text-amber-400');
});

test('healthColor lower_is_worse: at or below critical is rose', () => {
  const def = { ...baseDef, threshold_direction: 'lower_is_worse', warn_threshold: 100, critical_threshold: 50 };
  assert.equal(healthColor(40, def), 'text-rose-400');
});

// formatUptime
test('formatUptime formats days, hours and minutes', () => {
  assert.equal(formatUptime(90061), '1d 1h 1m');
});

test('formatUptime formats hours and minutes only', () => {
  assert.equal(formatUptime(3661), '1h 1m');
});

test('formatUptime formats minutes only', () => {
  assert.equal(formatUptime(120), '2m');
});

test('formatUptime accepts a numeric string', () => {
  assert.equal(formatUptime('3661'), '1h 1m');
});

test('formatUptime returns a dash for non-positive values', () => {
  assert.equal(formatUptime(0), '-');
});

// gaugeRange
test('gaugeRange higher_is_worse: uses critical as max', () => {
  const def = { ...baseDef, warn_threshold: 80, critical_threshold: 100 };
  const r = gaugeRange(50, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 100);
});

test('gaugeRange higher_is_worse: falls back to warn * 1.5 when no critical', () => {
  const def = { ...baseDef, warn_threshold: 80, critical_threshold: null };
  const r = gaugeRange(50, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 120);
});

test('gaugeRange higher_is_worse: falls back to value * 1.5 when no thresholds', () => {
  const def = { ...baseDef, warn_threshold: null, critical_threshold: null };
  const r = gaugeRange(60, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 90);
});

test('gaugeRange higher_is_worse: defaults to 100 when value is 0 and no thresholds', () => {
  const def = { ...baseDef, warn_threshold: null, critical_threshold: null };
  const r = gaugeRange(0, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 100);
});

test('gaugeRange higher_is_worse: handles null value', () => {
  const def = { ...baseDef, warn_threshold: null, critical_threshold: null };
  const r = gaugeRange(null, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 100);
});

test('gaugeRange lower_is_worse: uses critical as min and warn * 2 as max', () => {
  const def = { ...baseDef, threshold_direction: 'lower_is_worse', warn_threshold: 100, critical_threshold: 50 };
  const r = gaugeRange(80, def);
  assert.equal(r.min, 50);
  assert.equal(r.max, 200);
});

test('gaugeRange lower_is_worse: falls back to warn * 0.5 for min when no critical', () => {
  const def = { ...baseDef, threshold_direction: 'lower_is_worse', warn_threshold: 100, critical_threshold: null };
  const r = gaugeRange(80, def);
  assert.equal(r.min, 50);
  assert.equal(r.max, 200);
});

test('gaugeRange lower_is_worse: falls back to value-based range when no thresholds', () => {
  const def = { ...baseDef, threshold_direction: 'lower_is_worse', warn_threshold: null, critical_threshold: null };
  const r = gaugeRange(100, def);
  assert.equal(r.min, 50);
  assert.equal(r.max, 200);
});

test('gaugeRange uses manual gauge_min and gauge_max when set', () => {
  const def = { ...baseDef, gauge_min: -50, gauge_max: 0, warn_threshold: null, critical_threshold: null };
  const r = gaugeRange(-30, def);
  assert.equal(r.min, -50);
  assert.equal(r.max, 0);
});

test('gaugeRange manual min/max takes precedence over thresholds', () => {
  const def = { ...baseDef, gauge_min: 0, gauge_max: 200, warn_threshold: 80, critical_threshold: 100 };
  const r = gaugeRange(50, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 200);
});

test('gaugeRange manual min/max: handles max <= min by adding 100', () => {
  const def = { ...baseDef, gauge_min: 100, gauge_max: 100 };
  const r = gaugeRange(50, def);
  assert.equal(r.min, 100);
  assert.equal(r.max, 200);
});

test('gaugeRange ignores manual min when max is not set', () => {
  const def = { ...baseDef, gauge_min: 0, gauge_max: null, warn_threshold: 80, critical_threshold: 100 };
  const r = gaugeRange(50, def);
  assert.equal(r.min, 0);
  assert.equal(r.max, 100);
});

// thresholdBandColor
test('thresholdBandColor returns null when no thresholds', () => {
  assert.equal(thresholdBandColor(50, []), null);
});

test('thresholdBandColor returns the first band color when value is below all thresholds', () => {
  const thresholds = [
    { value: 80, color: '#f59e0b' },
    { value: 90, color: '#ef4444' },
  ];
  assert.equal(thresholdBandColor(50, thresholds), '#f59e0b');
});

test('thresholdBandColor returns the matching band color', () => {
  const thresholds = [
    { value: 80, color: '#f59e0b' },
    { value: 90, color: '#ef4444' },
  ];
  assert.equal(thresholdBandColor(85, thresholds), '#f59e0b');
  assert.equal(thresholdBandColor(95, thresholds), '#ef4444');
});

test('thresholdBandColor handles unsorted thresholds', () => {
  const thresholds = [
    { value: 90, color: '#ef4444' },
    { value: 80, color: '#f59e0b' },
  ];
  assert.equal(thresholdBandColor(85, thresholds), '#f59e0b');
});

test('thresholdBandColor returns the last band color when value exceeds all thresholds', () => {
  const thresholds = [
    { value: 80, color: '#f59e0b' },
    { value: 90, color: '#ef4444' },
  ];
  assert.equal(thresholdBandColor(95, thresholds), '#ef4444');
});

// gaugeZones
test('gaugeZones returns empty array when no thresholds', () => {
  assert.deepEqual(gaugeZones([], 0, 100), []);
});

test('gaugeZones creates zones from thresholds', () => {
  const thresholds = [
    { value: 80, color: '#f59e0b' },
    { value: 90, color: '#ef4444' },
  ];
  const zones = gaugeZones(thresholds, 0, 100);
  assert.equal(zones.length, 4);
  assert.deepEqual(zones[0], [0, '#f59e0b']);
  assert.deepEqual(zones[1], [0.8, '#f59e0b']);
  assert.deepEqual(zones[2], [0.9, '#ef4444']);
  assert.deepEqual(zones[3], [1, '#ef4444']);
});

test('gaugeZones handles unsorted thresholds', () => {
  const thresholds = [
    { value: 90, color: '#ef4444' },
    { value: 80, color: '#f59e0b' },
  ];
  const zones = gaugeZones(thresholds, 0, 100);
  assert.equal(zones.length, 4);
  assert.deepEqual(zones[0], [0, '#f59e0b']);
  assert.deepEqual(zones[1], [0.8, '#f59e0b']);
  assert.deepEqual(zones[2], [0.9, '#ef4444']);
  assert.deepEqual(zones[3], [1, '#ef4444']);
});

test('gaugeZones clamps to min/max range', () => {
  const thresholds = [
    { value: 20, color: '#10b981' },
    { value: 50, color: '#f59e0b' },
    { value: 80, color: '#ef4444' },
  ];
  const zones = gaugeZones(thresholds, 30, 70);
  // 20 is below min (30), so it's clamped out; 50 and 80 are in range
  // 50 -> (50-30)/40 = 0.5, 80 -> (80-30)/40 = 1.25 -> clamped out (>1)
  assert.equal(zones.length, 3);
  assert.deepEqual(zones[0], [0, '#f59e0b']);
  assert.deepEqual(zones[1], [0.5, '#f59e0b']);
  assert.deepEqual(zones[2], [1, '#f59e0b']);
});

// thresholdLines
test('thresholdLines returns empty array when no thresholds or warn/critical', () => {
  const def = { ...baseDef, thresholds: [], warn_threshold: null, critical_threshold: null };
  assert.deepEqual(thresholdLines(def), []);
});

test('thresholdLines creates lines from custom thresholds', () => {
  const def = { ...baseDef, thresholds: [
    { value: 80, color: '#f59e0b' },
    { value: 90, color: '#ef4444' },
  ]};
  const lines = thresholdLines(def);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].value, 80);
  assert.equal(lines[0].color, '#f59e0b');
  assert.equal(lines[1].value, 90);
  assert.equal(lines[1].color, '#ef4444');
});

test('thresholdLines falls back to warn/critical when no custom thresholds', () => {
  const def = { ...baseDef, thresholds: [], warn_threshold: 80, critical_threshold: 90 };
  const lines = thresholdLines(def);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].value, 80);
  assert.equal(lines[0].color, '#f59e0b');
  assert.equal(lines[1].value, 90);
  assert.equal(lines[1].color, '#f43f5e');
});

test('thresholdLines prefers custom thresholds over warn/critical', () => {
  const def = { ...baseDef, thresholds: [
    { value: 50, color: '#10b981' },
  ], warn_threshold: 80, critical_threshold: 90 };
  const lines = thresholdLines(def);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, 50);
  assert.equal(lines[0].color, '#10b981');
});
