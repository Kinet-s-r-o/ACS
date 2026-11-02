import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERAL_FIELDS, ADVANCED_FIELDS, ALL_FIELDS, LAN_PREFIX, resolveSuffix, getChangedParams, validateChangedFields, validateFields } from '../src/lib/lanFields.ts';

const prefix = LAN_PREFIX(1);

const makeParams = (entries) =>
  Object.entries(entries).map(([name, value]) => ({ name: prefix + name, value }));

test('LAN_PREFIX generates correct path for index 1', () => {
  assert.equal(prefix, 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.');
});

test('LAN_PREFIX generates correct path for index 4', () => {
  assert.equal(LAN_PREFIX(4), 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.');
});

test('resolveSuffix finds first matching suffix', () => {
  const params = [{ name: prefix + 'Name', value: 'LAN1' }];
  assert.equal(resolveSuffix(params, prefix, ['Name']), 'Name');
});

test('resolveSuffix falls back to second suffix', () => {
  const params = [{ name: prefix + 'X_HW_VLAN', value: '100' }];
  assert.equal(resolveSuffix(params, prefix, ['X_HW_VLAN', 'VLANID']), 'X_HW_VLAN');
});

test('resolveSuffix returns null when no suffix matches', () => {
  const params = [{ name: prefix + 'Name', value: 'LAN1' }];
  assert.equal(resolveSuffix(params, prefix, ['X_HW_VLAN', 'VLANID']), null);
});

test('getChangedParams returns empty when no edits', () => {
  const params = makeParams({ Name: 'LAN1', Enable: '1', X_HW_Speed: 'Auto' });
  const changed = getChangedParams(params, prefix, {});
  assert.deepEqual(changed, {});
});

test('getChangedParams detects single field change', () => {
  const params = makeParams({ Name: 'LAN1', Enable: '1' });
  const changed = getChangedParams(params, prefix, { [prefix + 'Name']: 'LAN2' });
  assert.deepEqual(changed, { [prefix + 'Name']: 'LAN2' });
});

test('getChangedParams detects multiple field changes', () => {
  const params = makeParams({ Name: 'LAN1', Enable: '1', X_HW_Speed: 'Auto' });
  const changed = getChangedParams(params, prefix, {
    [prefix + 'Name']: 'LAN2',
    [prefix + 'X_HW_Speed']: '1000M',
  });
  assert.deepEqual(changed, {
    [prefix + 'Name']: 'LAN2',
    [prefix + 'X_HW_Speed']: '1000M',
  });
});

test('validateFields returns empty when all valid', () => {
  const params = makeParams({ X_HW_VLAN: '100', X_HW_PVID: '200' });
  const errors = validateFields(params, prefix, {});
  assert.deepEqual(errors, {});
});

test('validateFields detects invalid VLAN (0)', () => {
  const params = makeParams({ X_HW_VLAN: '0' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'X_HW_VLAN']);
});

test('validateFields detects invalid VLAN (4095)', () => {
  const params = makeParams({ X_HW_VLAN: '4095' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'X_HW_VLAN']);
});

test('validateFields detects invalid PVID (non-numeric)', () => {
  const params = makeParams({ X_HW_PVID: 'abc' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'X_HW_PVID']);
});

test('validateFields uses edited value over original', () => {
  const params = makeParams({ X_HW_VLAN: '100' });
  const errors = validateFields(params, prefix, { [prefix + 'X_HW_VLAN']: '9999' });
  assert.ok(errors[prefix + 'X_HW_VLAN']);
});

test('validateChangedFields ignores invalid untouched values but validates edited values', () => {
  const params = makeParams({ Name: 'LAN1', X_HW_VLAN: '0', X_HW_PVID: 'abc' });
  assert.deepEqual(validateChangedFields(params, prefix, { [prefix + 'Name']: 'LAN2' }), {});
  assert.ok(validateChangedFields(params, prefix, { [prefix + 'X_HW_VLAN']: '4095' })[prefix + 'X_HW_VLAN']);
});

test('ALL_FIELDS contains all general and advanced fields', () => {
  assert.equal(ALL_FIELDS.length, GENERAL_FIELDS.length + ADVANCED_FIELDS.length);
});

test('GENERAL_FIELDS has 5 fields', () => {
  assert.equal(GENERAL_FIELDS.length, 5);
});

test('ADVANCED_FIELDS has 8 fields', () => {
  assert.equal(ADVANCED_FIELDS.length, 8);
});
