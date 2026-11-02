import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLanRate, formatLanSpeed, measureCounterRate, parseLanLinkState, resolveLanVisualState } from '../src/lib/ontLan.ts';

test('LAN link parser keeps missing and unfamiliar values unknown', () => {
  assert.equal(parseLanLinkState('Up'), 'up');
  assert.equal(parseLanLinkState('Connected'), 'up');
  assert.equal(parseLanLinkState('LowerLayerDown'), 'down');
  assert.equal(parseLanLinkState(''), 'unknown');
  assert.equal(parseLanLinkState('Disabled'), 'unknown');
});

test('counter rates require a positive counter delta and valid sample interval', () => {
  assert.equal(measureCounterRate(
    { value: 1000, updatedAt: '2026-11-02T12:00:00Z' },
    { value: 2000, updatedAt: '2026-11-02T12:00:01Z' },
  ), 8000);
  assert.equal(measureCounterRate(
    { value: 2000, updatedAt: '2026-11-02T12:00:00Z' },
    { value: 1000, updatedAt: '2026-11-02T12:00:01Z' },
  ), null);
});

test('unavailable or stale rates are not rendered as zero', () => {
  assert.equal(formatLanRate(null, null), 'N/A');
  assert.equal(formatLanRate(0, '2026-11-02T11:00:00Z', Date.parse('2026-11-02T12:00:00Z')), 'N/A');
  assert.equal(formatLanRate(45_200_000, '2026-11-02T12:00:00Z', Date.parse('2026-11-02T12:00:10Z')), '45.2 Mbps');
});

test('LAN speed values are shown in Mbps or Gbps when recognizable', () => {
  assert.equal(formatLanSpeed('1000'), '1 Gbps');
  assert.equal(formatLanSpeed('100'), '100 Mbps');
  assert.equal(formatLanSpeed('1000 Mbps'), '1000 Mbps');
  assert.equal(formatLanSpeed('0'), 'N/A');
});

test('visual state stays neutral for unknown and offline ports and only animates measured link-up activity', () => {
  assert.deepEqual(resolveLanVisualState('unknown', true, null, true), { connected: false, linkUp: false, activity: false });
  assert.deepEqual(resolveLanVisualState('down', true, null, false), { connected: false, linkUp: false, activity: false });
  assert.deepEqual(resolveLanVisualState('down', true, true, false), { connected: true, linkUp: false, activity: false });
  assert.deepEqual(resolveLanVisualState('up', false, null, true), { connected: false, linkUp: false, activity: false });
  assert.deepEqual(resolveLanVisualState('up', true, null, false), { connected: true, linkUp: true, activity: false });
  assert.deepEqual(resolveLanVisualState('up', true, null, true), { connected: true, linkUp: true, activity: true });
});
