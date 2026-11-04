import test from 'node:test';
import assert from 'node:assert/strict';
import { metricActiveRequest } from '../src/lib/metricActiveRequest.ts';

test('toggling a template metric preserves collection, thresholds and display settings', () => {
  const definition = { id: 7, template_id: 3, created_at: 'created', updated_at: 'updated', name: 'RX', active: true, parameter_name: 'Device.Test.RX', parameter_pattern: '', source: 'passive', min_sample_interval_seconds: 50, gpv_poll_interval_seconds: 300, store_history: false, multiplier: 0.01, thresholds: [{ label: 'warning', max: -20 }], gauge_pointer: false };
  const previous = structuredClone(definition);
  const result = metricActiveRequest(definition, false);
  assert.equal(result.endpoint, '/provisioning/templates/3/metrics/7');
  const { id, created_at, updated_at, ...expected } = definition;
  assert.deepEqual(result.body, { ...expected, active: false });
  assert.deepEqual(definition, previous);
});

test('interface metrics use their template interface endpoint and preserve polling intervals', () => {
  const result = metricActiveRequest({ id: 9, template_id: 4, active: false, interface_type: 'wan', parameter_pattern: 'Device.WAN.*.Bytes', min_sample_interval_seconds: 30, gpv_poll_interval_seconds: 120 }, true);
  assert.equal(result.endpoint, '/provisioning/templates/4/interface-metrics/9');
  assert.equal(result.body.active, true);
  assert.equal(result.body.min_sample_interval_seconds, 30);
  assert.equal(result.body.gpv_poll_interval_seconds, 120);
});

test('a metric without template ownership never falls back to the disabled global write endpoint', () => {
  for (const template_id of [undefined, null, 0]) assert.throws(() => metricActiveRequest({ id: 1, template_id, active: true }, false), /provisioning template/);
});
