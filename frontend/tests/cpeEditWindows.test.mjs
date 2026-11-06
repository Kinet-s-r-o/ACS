import test from 'node:test';
import assert from 'node:assert/strict';
import { editFieldSensitive, renderCPEEditHelp, validateCPEEditChanges, validateCPEEditValue } from '../src/lib/cpeEditWindows.ts';

const prefix = 'InternetGatewayDevice.LANDevice.7.WLANConfiguration.25.';
const field = { id: 'ssid', name: 'SSID', parameter: 'SSID', type: 'string', input: 'select', options: [{ label: 'Home network', value: 'home' }] };
const window = { tabs: [{ fields: [field] }] };
const parameter = { name: prefix + 'SSID', value: 'legacy', value_type: 'xsd:string', writable: true };

test('help reads stored values from the opened instance and exact global paths, including read-only data', () => {
  const parameters = [
    { name: prefix + 'Channel', value: '0', writable: false },
    { name: 'InternetGatewayDevice.DeviceInfo.ModelName', value: '<ONT & model>' },
    { name: prefix.replace('.25.', '.1.') + 'Channel', value: '36' },
  ];
  assert.equal(renderCPEEditHelp('Channel: {{param:Channel}}; model: {{param:InternetGatewayDevice.DeviceInfo.ModelName}}', prefix, parameters), 'Channel: 0; model: <ONT & model>');
  assert.equal(renderCPEEditHelp('{{param:Missing}} / {{param:Empty}}', prefix, [{ name: prefix + 'Empty', value: '' }]), '— / —');
  assert.equal(renderCPEEditHelp('{{param:Channel}}', prefix, parameters, true), '[Channel]');
  assert.equal(renderCPEEditHelp('{{param:Username}}', prefix, [{ name: prefix + 'Username', value: 'hidden' }]), '[protected]');
  assert.equal(renderCPEEditHelp('Unchanged help', prefix, []), 'Unchanged help');
});

test('select queues exact values for the opened instance, preserving unchanged legacy values', () => {
  assert.deepEqual(validateCPEEditChanges(window, prefix, [parameter], { [parameter.name]: 'home' }), { changes: { [parameter.name]: 'home' }, errors: {} });
  assert.deepEqual(validateCPEEditChanges(window, prefix, [parameter], { [parameter.name]: 'legacy' }), { changes: {}, errors: {} });
  assert.ok(validateCPEEditChanges(window, prefix, [parameter], { [parameter.name]: 'Home network' }).errors[parameter.name]);
  assert.ok(validateCPEEditChanges(window, prefix, [parameter], { [prefix + 'Enable']: 'home' }).errors[prefix + 'Enable']);
});

test('missing, read-only, unknown write access and incompatible types reject changes', () => {
  for (const parameters of [[], [{ ...parameter, writable: false }], [{ ...parameter, writable: null }], [{ ...parameter, value_type: 'boolean' }]]) {
    assert.ok(validateCPEEditChanges(window, prefix, parameters, { [parameter.name]: 'home' }).errors[parameter.name]);
  }
});

test('CWMP numeric ranges and sensitive relative names are respected', () => {
  for (const [type, value] of [['int', '2147483648'], ['unsignedInt', '-1'], ['unsignedInt', '4294967296'], ['int', '1.5'], ['boolean', 'yes']]) assert.ok(validateCPEEditValue(type, value));
  for (const [type, value] of [['int', '-2147483648'], ['unsignedInt', '4294967295'], ['boolean', 'false']]) assert.equal(validateCPEEditValue(type, value), '');
  assert.equal(editFieldSensitive('Username'), true);
  assert.equal(editFieldSensitive('PreSharedKey.1.KeyPassphrase'), true);
  assert.equal(editFieldSensitive('SSID'), false);
});
