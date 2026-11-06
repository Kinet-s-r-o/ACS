import test from 'node:test';
import assert from 'node:assert/strict';
import { canDeleteSnapshot, defaultSnapshotSettings, validateSnapshotSettings } from '../src/lib/snapshotSchedule.ts';

test('initial snapshots require Full, normal snapshots allow Write', () => {
  assert.equal(canDeleteSnapshot('initial', true, false), false);
  assert.equal(canDeleteSnapshot('initial', true, true), true);
  assert.equal(canDeleteSnapshot('scheduled', true, false), true);
  assert.equal(canDeleteSnapshot(undefined, true, false), true);
  assert.equal(canDeleteSnapshot('manual', false, false), false);
});

test('snapshot settings default off and validate whole minute ranges', () => {
  const settings = defaultSnapshotSettings();
  assert.equal(settings.initial_enabled, false);
  assert.equal(settings.scheduled_enabled, false);
  assert.equal(validateSnapshotSettings({ ...settings, initial_enabled: true, initial_delay_minutes: 0 }), '');
  for (const patch of [{ initial_delay_minutes: NaN }, { initial_delay_minutes: -1 }, { initial_delay_minutes: 1.5 }, { scheduled_enabled: true, scheduled_interval_minutes: 0 }, { scheduled_interval_minutes: 525601 }]) assert.ok(validateSnapshotSettings({ ...settings, ...patch }));
});
