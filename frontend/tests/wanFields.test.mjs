import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERAL_FIELDS, BINDING_FIELDS, IPV4_FIELDS, IPV6_FIELDS, ADVANCED_FIELDS, ALL_FIELDS, resolveSuffix, getChangedParams, validateChangedFields, validateFields } from '../src/lib/wanFields.ts';

const prefix = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.';

const makeParams = (entries) =>
  Object.entries(entries).map(([name, value]) => ({ name: prefix + name, value }));

test('resolveSuffix finds first matching suffix', () => {
  const params = [{ name: prefix + 'Name', value: 'WAN1' }];
  assert.equal(resolveSuffix(params, prefix, ['Name']), 'Name');
});

test('resolveSuffix finds X_HW_VLAN', () => {
  const params = [{ name: prefix + 'X_HW_VLAN', value: '832' }];
  assert.equal(resolveSuffix(params, prefix, ['X_HW_VLAN']), 'X_HW_VLAN');
});

test('resolveSuffix finds MaxMTUSize', () => {
  const params = [{ name: prefix + 'MaxMTUSize', value: '1500' }];
  assert.equal(resolveSuffix(params, prefix, ['MaxMTUSize', 'X_HW_MTU']), 'MaxMTUSize');
});

test('resolveSuffix falls back to X_HW_MTU', () => {
  const params = [{ name: prefix + 'X_HW_MTU', value: '1492' }];
  assert.equal(resolveSuffix(params, prefix, ['MaxMTUSize', 'X_HW_MTU']), 'X_HW_MTU');
});

test('resolveSuffix finds X_HW_LowerLayers', () => {
  const params = [{ name: prefix + 'X_HW_LowerLayers', value: 'IPv4' }];
  assert.equal(resolveSuffix(params, prefix, ['X_HW_LowerLayers']), 'X_HW_LowerLayers');
});

test('resolveSuffix finds X_HW_LANBIND.Lan1Enable', () => {
  const params = [{ name: prefix + 'X_HW_LANBIND.Lan1Enable', value: '1' }];
  assert.equal(resolveSuffix(params, prefix, ['X_HW_LANBIND.Lan1Enable']), 'X_HW_LANBIND.Lan1Enable');
});

test('resolveSuffix returns null when no suffix matches', () => {
  const params = [{ name: prefix + 'Name', value: 'WAN1' }];
  assert.equal(resolveSuffix(params, prefix, ['Username', 'Password']), null);
});

test('getChangedParams returns empty when no edits', () => {
  const params = makeParams({ Name: 'WAN1', Enable: '1', ConnectionType: 'IP_Routed' });
  const changed = getChangedParams(params, prefix, {});
  assert.deepEqual(changed, {});
});

test('getChangedParams detects single field change', () => {
  const params = makeParams({ Name: 'WAN1', Enable: '1' });
  const changed = getChangedParams(params, prefix, { [prefix + 'Name']: 'WAN2' });
  assert.deepEqual(changed, { [prefix + 'Name']: 'WAN2' });
});

test('getChangedParams detects IPv4 field change', () => {
  const params = makeParams({ NATEnabled: '1', X_HW_NatType: '0' });
  const changed = getChangedParams(params, prefix, { [prefix + 'NATEnabled']: '0' });
  assert.deepEqual(changed, { [prefix + 'NATEnabled']: '0' });
});

test('getChangedParams detects IPv6 field change', () => {
  const params = makeParams({ X_HW_NPTv6Enable: '0' });
  const changed = getChangedParams(params, prefix, { [prefix + 'X_HW_NPTv6Enable']: '1' });
  assert.deepEqual(changed, { [prefix + 'X_HW_NPTv6Enable']: '1' });
});

test('getChangedParams detects binding field change', () => {
  const params = makeParams({ 'X_HW_LANBIND.Lan1Enable': '0' });
  const changed = getChangedParams(params, prefix, { [prefix + 'X_HW_LANBIND.Lan1Enable']: '1' });
  assert.deepEqual(changed, { [prefix + 'X_HW_LANBIND.Lan1Enable']: '1' });
});

test('getChangedParams detects multiple field changes', () => {
  const params = makeParams({ Name: 'WAN1', Enable: '1', MaxMTUSize: '1492' });
  const changed = getChangedParams(params, prefix, {
    [prefix + 'Name']: 'WAN2',
    [prefix + 'MaxMTUSize']: '1500',
  });
  assert.deepEqual(changed, {
    [prefix + 'Name']: 'WAN2',
    [prefix + 'MaxMTUSize']: '1500',
  });
});

test('validateFields returns empty when all valid', () => {
  const params = makeParams({ X_HW_VLAN: '100', MaxMTUSize: '1500' });
  const errors = validateFields(params, prefix, {});
  assert.deepEqual(errors, {});
});

test('validateFields allows VLAN 0 (disabled)', () => {
  const params = makeParams({ X_HW_VLAN: '0' });
  const errors = validateFields(params, prefix, {});
  assert.deepEqual(errors, {});
});

test('validateFields detects invalid VLAN (4097)', () => {
  const params = makeParams({ X_HW_VLAN: '4097' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'X_HW_VLAN']);
});

test('validateFields detects invalid MTU (too small)', () => {
  const params = makeParams({ MaxMTUSize: '1000' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'MaxMTUSize']);
});

test('validateFields detects invalid MTU (too large)', () => {
  const params = makeParams({ MaxMTUSize: '2000' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'MaxMTUSize']);
});

test('validateFields detects invalid Multicast VLAN (too large)', () => {
  const params = makeParams({ X_HW_MultiCastVLAN: '5000' });
  const errors = validateFields(params, prefix, {});
  assert.ok(errors[prefix + 'X_HW_MultiCastVLAN']);
});

test('validateFields allows empty Multicast VLAN', () => {
  const params = makeParams({ X_HW_MultiCastVLAN: '' });
  const errors = validateFields(params, prefix, {});
  assert.equal(errors[prefix + 'X_HW_MultiCastVLAN'], undefined);
});

test('validateFields allows empty VLAN ID', () => {
  const params = makeParams({ X_HW_VLAN: '' });
  const errors = validateFields(params, prefix, {});
  assert.equal(errors[prefix + 'X_HW_VLAN'], undefined);
});

test('validateFields allows empty MTU', () => {
  const params = makeParams({ MaxMTUSize: '' });
  const errors = validateFields(params, prefix, {});
  assert.equal(errors[prefix + 'MaxMTUSize'], undefined);
});

test('validateFields uses edited value over original', () => {
  const params = makeParams({ MaxMTUSize: '1492' });
  const errors = validateFields(params, prefix, { [prefix + 'MaxMTUSize']: '100' });
  assert.ok(errors[prefix + 'MaxMTUSize']);
});

test('validateChangedFields ignores invalid untouched parameters but validates edited values', () => {
  const params = makeParams({ Name: 'WAN1', X_HW_VLAN: '5000', MaxMTUSize: '4294967295' });
  assert.deepEqual(validateChangedFields(params, prefix, { [prefix + 'Name']: 'WAN2' }), {});
  assert.ok(validateChangedFields(params, prefix, { [prefix + 'X_HW_VLAN']: '5001' })[prefix + 'X_HW_VLAN']);
});

test('visibleWhen: isRouted hides field when bridged', () => {
  const field = GENERAL_FIELDS.find(f => f.label === 'Encapsulation Mode');
  assert.ok(field.visibleWhen);
  const getValBridged = (suffixes) => suffixes.includes('ConnectionType') ? 'IP_Bridged' : '';
  const getValRouted = (suffixes) => suffixes.includes('ConnectionType') ? 'IP_Routed' : '';
  assert.equal(field.visibleWhen(getValBridged), false);
  assert.equal(field.visibleWhen(getValRouted), true);
});

test('visibleWhen: isPPPoE hides field when DHCP', () => {
  const field = GENERAL_FIELDS.find(f => f.label === 'User Name');
  assert.ok(field.visibleWhen);
  const getValDHCP = (suffixes) => suffixes.includes('AddressingType') ? 'DHCP' : '';
  const getValPPPoE = (suffixes) => suffixes.includes('AddressingType') ? 'PPPoE' : '';
  assert.equal(field.visibleWhen(getValDHCP), false);
  assert.equal(field.visibleWhen(getValPPPoE), true);
});

test('visibleWhen: isNATEnabled hides NAT type when NAT off', () => {
  const field = IPV4_FIELDS.find(f => f.label === 'NAT type');
  assert.ok(field.visibleWhen);
  const getValNATOff = (suffixes) => suffixes.includes('NATEnabled') ? '0' : '';
  const getValNATOn = (suffixes) => suffixes.includes('NATEnabled') ? '1' : '';
  assert.equal(field.visibleWhen(getValNATOff), false);
  assert.equal(field.visibleWhen(getValNATOn), true);
});

test('ALL_FIELDS contains all field arrays', () => {
  assert.equal(ALL_FIELDS.length, GENERAL_FIELDS.length + BINDING_FIELDS.length + IPV4_FIELDS.length + IPV6_FIELDS.length + ADVANCED_FIELDS.length);
});

test('GENERAL_FIELDS has 14 fields', () => {
  assert.equal(GENERAL_FIELDS.length, 14);
});

test('BINDING_FIELDS has 12 fields', () => {
  assert.equal(BINDING_FIELDS.length, 12);
});

test('IPV4_FIELDS has 7 fields', () => {
  assert.equal(IPV4_FIELDS.length, 7);
});

test('IPV6_FIELDS has 7 fields', () => {
  assert.equal(IPV6_FIELDS.length, 7);
});

test('ADVANCED_FIELDS has 7 fields', () => {
  assert.equal(ADVANCED_FIELDS.length, 7);
});

test('ALL_FIELDS includes binding fields', () => {
  const bindingLabels = BINDING_FIELDS.map(f => f.label);
  const allLabels = ALL_FIELDS.map(f => f.label);
  for (const label of bindingLabels) {
    assert.ok(allLabels.includes(label), `Missing binding field: ${label}`);
  }
});
