import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLanSpeed, parseLanLinkState, resolveLanVisualState } from '../src/lib/ontLan.ts';

test('LAN link parser keeps missing and unfamiliar values unknown', () => {
  assert.equal(parseLanLinkState('Up'), 'up');
  assert.equal(parseLanLinkState('Connected'), 'up');
  assert.equal(parseLanLinkState('LowerLayerDown'), 'down');
  assert.equal(parseLanLinkState(''), 'unknown');
  assert.equal(parseLanLinkState('Disabled'), 'unknown');
});

test('LAN speed values are shown in Mbps or Gbps when recognizable', () => {
  assert.equal(formatLanSpeed('1000'), '1 Gbps');
  assert.equal(formatLanSpeed('100'), '100 Mbps');
  assert.equal(formatLanSpeed('1000 Mbps'), '1000 Mbps');
  assert.equal(formatLanSpeed('0'), 'N/A');
});

test('visual state stays neutral for unknown and offline ports', () => {
  assert.deepEqual(resolveLanVisualState('unknown', true, null), { connected: false, linkUp: false });
  assert.deepEqual(resolveLanVisualState('down', true, null), { connected: false, linkUp: false });
  assert.deepEqual(resolveLanVisualState('down', true, true), { connected: true, linkUp: false });
  assert.deepEqual(resolveLanVisualState('up', false, null), { connected: false, linkUp: false });
  assert.deepEqual(resolveLanVisualState('up', true, null), { connected: true, linkUp: true });
});
