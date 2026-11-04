import test from 'node:test';
import assert from 'node:assert/strict';
import { hostParameterUpdates, latestParameterTimestamp } from '../src/lib/parameterFreshness.ts';

test('latest timestamp compares instants rather than text and ignores missing values', () => {
  assert.equal(latestParameterTimestamp('invalid', null, undefined), null);
  assert.equal(latestParameterTimestamp('2026-11-06T14:00:00+02:00', '2026-11-06T13:00:00Z'), '2026-11-06T13:00:00Z');
});

test('host freshness combines its parameters without matching sibling instances', () => {
  const root = 'InternetGatewayDevice.LANDevice.1.';
  const host = root + 'Hosts.Host.1.';
  const association = root + 'WLANConfiguration.1.AssociatedDevice.3.';
  const updates = hostParameterUpdates([
    { name: host + 'HostName', updated_at: '2026-11-06T10:00:00Z' },
    { name: host + 'IPAddress', updated_at: '2026-11-06T11:00:00Z' },
    { name: root + 'Hosts.Host.10.HostName', updated_at: '2026-11-06T12:00:00Z' },
    { name: association + 'AssociatedDeviceMACAddress', updated_at: '2026-11-06T11:30:00Z' },
    { name: host + 'Empty', updated_at: 'invalid' },
  ]);
  assert.equal(updates.get(host), '2026-11-06T11:00:00Z');
  assert.equal(latestParameterTimestamp(updates.get(host), updates.get(association)), '2026-11-06T11:30:00Z');
});
