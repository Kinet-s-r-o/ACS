import assert from 'node:assert/strict';
import test from 'node:test';
import { loadChartPreferences } from '../src/lib/chartPreferences.ts';

test('charts honor public preferences without access to system settings', async () => {
  for (const [value, expected] of [['false', false], ['true', true], [undefined, true]]) {
    const preferences = await loadChartPreferences(async () => ({ chart_show_points: value }));
    assert.equal(preferences.showPoints, expected);
  }
});

test('unavailable preferences do not reject chart rendering', async () => {
  const preferences = await loadChartPreferences(async () => { throw new Error('Metadata unavailable'); });
  assert.deepEqual(preferences, { showPoints: true, autoRefreshInterval: 30 });
});

test('read-only CPE refresh honors the public interval including disabled refresh', async () => {
  for (const [value, expected] of [['0', 0], ['15', 15], ['3600', 3600], ['-1', 30], ['bad', 30], [undefined, 30]]) {
    const preferences = await loadChartPreferences(async () => ({ auto_refresh_interval: value }));
    assert.equal(preferences.autoRefreshInterval, expected);
  }
});
