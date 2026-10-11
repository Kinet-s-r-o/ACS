import assert from 'node:assert/strict';
import test from 'node:test';
import { metricsTabMetrics, healthPanelMetrics, globMatch, metricsForTemplate } from '../src/lib/metricViews.ts';

const baseDef = {
  id: 1, name: 'CPU Load', description: '', device_type_match: '*',
  parameter_name: 'InternetGatewayDevice.X_CPU', unit: '%',
  source: 'passive', active: true, group: '', color: '', axis: 'left',
  transform: '', multiplier: 1, unit_scale: '', health: false,
  warn_threshold: null, critical_threshold: null,
  threshold_direction: 'higher_is_worse', display_format: 'number',
  chart_type: 'line', created_at: '', updated_at: '',
};

// A metric enabled for the Health panel must ALSO remain in the Metrics tab.
test('health-enabled metric appears in BOTH the Metrics tab and the Health panel', () => {
  const defs = [{ ...baseDef, health: true, display_format: 'gauge' }];
  const tab = metricsTabMetrics(defs);
  const panel = healthPanelMetrics(defs);
  assert.ok(tab.some(m => m.name === 'CPU Load'), 'health metric must appear in the Metrics tab');
  assert.ok(panel.some(m => m.name === 'CPU Load'), 'health metric must appear in the Health panel');
});

test('non-health metric appears only in the Metrics tab', () => {
  const defs = [{ ...baseDef, health: false }];
  const tab = metricsTabMetrics(defs);
  const panel = healthPanelMetrics(defs);
  assert.ok(tab.some(m => m.name === 'CPU Load'), 'non-health metric must appear in the Metrics tab');
  assert.equal(panel.length, 0, 'non-health metric must NOT appear in the Health panel');
});

test('Metrics tab is no longer mutually exclusive with the Health panel', () => {
  const defs = [
    { ...baseDef, id: 1, name: 'CPU', health: true, display_format: 'gauge' },
    { ...baseDef, id: 2, name: 'Temp', health: false, display_format: 'number' },
  ];
  const tab = metricsTabMetrics(defs);
  const panel = healthPanelMetrics(defs);
  assert.equal(tab.length, 2, 'both metrics show in the Metrics tab (no exclusion)');
  assert.equal(panel.length, 1, 'only the health metric shows in the Health panel');
  assert.equal(panel[0].name, 'CPU');
});

test('Health panel metrics use configured order while preserving ties', () => {
  const defs = [
    { ...baseDef, id: 1, name: 'Downstream', health: true, health_order: 20 },
    { ...baseDef, id: 2, name: 'Temperature', health: true, health_order: 10 },
    { ...baseDef, id: 3, name: 'Uptime', health: true, health_order: 20 },
  ];
  assert.deepEqual(healthPanelMetrics(defs).map(m => m.name), ['Temperature', 'Downstream', 'Uptime']);
});

test('empty input yields empty views', () => {
  assert.deepEqual(metricsTabMetrics([]), []);
  assert.deepEqual(healthPanelMetrics([]), []);
});

// --- globMatch (Go path.Match semantics) -----------------------------------

test('globMatch: empty pattern and bare * match everything', () => {
  assert.equal(globMatch('', 'Zyxel/VMG3625'), true);
  assert.equal(globMatch('*', 'Zyxel/VMG3625'), true);
  assert.equal(globMatch('*', 'anything/else'), true);
});

test('globMatch: * does not cross / (path.Match semantics)', () => {
  // `*` alone is special-cased to match all, but `*/*` must not span more
  // than one slash.
  assert.equal(globMatch('*/*', 'Zyxel/VMG3625'), true);
  assert.equal(globMatch('*/*', 'a/b/c'), false);
  assert.equal(globMatch('Zyxel/*', 'Zyxel/VMG3625'), true);
  assert.equal(globMatch('Zyxel/*', 'Zyxel/VMG3625/extra'), false);
});

test('globMatch: exact and prefix patterns', () => {
  assert.equal(globMatch('Zyxel/VMG3625', 'Zyxel/VMG3625'), true);
  assert.equal(globMatch('Zyxel/VMG3625', 'Zyxel/VMG3626'), false);
  assert.equal(globMatch('Zyxel/VMG*', 'Zyxel/VMG3625'), true);
  assert.equal(globMatch('Zyxel/VMG*', 'Zyxel/VMG'), true);
  assert.equal(globMatch('Zyxel/VMG*', 'Huawei/VMG3625'), false);
});

test('globMatch: ? matches exactly one non-/ character', () => {
  assert.equal(globMatch('Zyxel/VMG?', 'Zyxel/VMG3'), true);
  assert.equal(globMatch('Zyxel/VMG?', 'Zyxel/VMG36'), false);
  assert.equal(globMatch('Zyxel/VMG?', 'Zyxel/VMG/'), false);
});

test('globMatch: character classes and ranges', () => {
  assert.equal(globMatch('Zyxel/[0-9]*', 'Zyxel/12345'), true);
  assert.equal(globMatch('Zyxel/[0-9]*', 'Zyxel/abc'), false);
  assert.equal(globMatch('Zyxel/VMG[0-9]', 'Zyxel/VMG5'), true);
  assert.equal(globMatch('Zyxel/VMG[0-9]', 'Zyxel/VMGx'), false);
  // negation uses ^ (Go path.Match)
  assert.equal(globMatch('Zyxel/[^0-9]*', 'Zyxel/abc'), true);
  assert.equal(globMatch('Zyxel/[^0-9]*', 'Zyxel/12345'), false);
});

test('globMatch: empty value and non-matching', () => {
  assert.equal(globMatch('Zyxel/*', ''), false);
  assert.equal(globMatch('Zyxel/*', 'Huawei/AR600'), false);
});

test('globMatch: matching is case-insensitive', () => {
  // Template scopes are stored lowercased by the backend, while device types
  // keep their original case — matching must ignore case on both sides.
  const deviceType = 'Huawei Technologies Co., Ltd/EG8145X6-10';
  const templateScope = 'huawei technologies co., ltd/eg8145x6-10';
  assert.equal(globMatch('Huawei Technologies Co., Ltd/EG8145X6-10', templateScope), true);
  assert.equal(globMatch(templateScope, deviceType), true);
  assert.equal(globMatch('Huawei*/EG8145X6-10', templateScope), true);
  assert.equal(globMatch('Zyxel/VMG3625', templateScope), false);
  // character classes are case-insensitive too
  assert.equal(globMatch('Zyxel/[0-9]*', 'zyxel/12345'), true);
});

// --- metricsForTemplate (scope resolution) ---------------------------------

const mkDef = (id, name, match) => ({ ...baseDef, id, name, device_type_match: match });

test('metricsForTemplate: global scope returns every metric', () => {
  const defs = [
    mkDef(1, 'Uptime', '*'),
    mkDef(2, 'CPU', 'Zyxel/*'),
    mkDef(3, 'Temp', 'Zyxel/VMG3625'),
  ];
  const result = metricsForTemplate(defs, '', '');
  assert.equal(result.length, 3, 'global template shows all metrics');
});

test('metricsForTemplate: concrete scope matches only that device type', () => {
  const defs = [
    mkDef(1, 'Uptime', '*'),
    mkDef(2, 'CPU', 'Zyxel/*'),
    mkDef(3, 'Temp', 'Zyxel/VMG3625'),
    mkDef(4, 'HW', 'Huawei/*'),
  ];
  const result = metricsForTemplate(defs, 'Zyxel', 'VMG3625');
  const names = result.map(d => d.name).sort();
  assert.deepEqual(names, ['CPU', 'Temp', 'Uptime'], 'concrete scope shows global + manufacturer + exact metrics');
});

test('metricsForTemplate: manufacturer scope shows all metrics for that manufacturer', () => {
  const defs = [
    mkDef(1, 'Uptime', '*'),
    mkDef(2, 'CPU', 'Zyxel/*'),
    mkDef(3, 'Temp', 'Zyxel/VMG3625'),
    mkDef(4, 'HW', 'Huawei/*'),
  ];
  const result = metricsForTemplate(defs, 'Zyxel', '');
  const names = result.map(d => d.name).sort();
  assert.deepEqual(names, ['CPU', 'Temp', 'Uptime'], 'manufacturer scope shows all Zyxel metrics, not just Uptime');
});

test('metricsForTemplate: product-class scope shows metrics for that product class', () => {
  const defs = [
    mkDef(1, 'Uptime', '*'),
    mkDef(2, 'CPU', 'Zyxel/*'),
    mkDef(3, 'Temp', 'Zyxel/VMG3625'),
    mkDef(4, 'Other', 'Huawei/AR600'),
  ];
  const result = metricsForTemplate(defs, '', 'VMG3625');
  const names = result.map(d => d.name).sort();
  // Uptime (*) applies; CPU (Zyxel/*) and Temp (Zyxel/VMG3625) both cover a
  // VMG3625 device; Other (Huawei/AR600) pins a different product class.
  assert.deepEqual(names, ['CPU', 'Temp', 'Uptime']);
});

test('metricsForTemplate: empty defs yields empty result', () => {
  assert.deepEqual(metricsForTemplate([], '', ''), []);
  assert.deepEqual(metricsForTemplate([], 'Zyxel', 'VMG3625'), []);
});

test('metricsForTemplate: scope matching is case-insensitive', () => {
  const defs = [
    mkDef(1, 'Uptime', '*'),
    mkDef(2, 'CPU', 'Huawei Technologies Co., Ltd/EG8145X6-10'),
    mkDef(3, 'Other', 'Zyxel/VMG3625'),
  ];
  // Template scope is stored lowercased by the backend.
  const result = metricsForTemplate(defs, 'huawei technologies co., ltd', 'eg8145x6-10');
  const names = result.map(d => d.name).sort();
  // Uptime (*) and CPU (exact, case-insensitive) apply; Other (Zyxel) does not.
  assert.deepEqual(names, ['CPU', 'Uptime']);
});
