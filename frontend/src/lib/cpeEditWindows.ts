import type { CPEEditField, CPEEditTarget, CPEEditType, CPEEditWindow, DeviceParameter } from './api';

export const editWindowTargets: { value: CPEEditTarget; label: string }[] = [
  { value: 'wifi', label: 'Wi-Fi' }, { value: 'lan', label: 'LAN' }, { value: 'wan_ip', label: 'WAN IP' }, { value: 'wan_ppp', label: 'WAN PPP' },
];

export const editFieldSensitive = (parameter: string) => /password|passphrase|presharedkey|pre_shared_key|privatekey|secret|connectionrequestusername|\.username$/i.test('.' + parameter);
export const editFieldInput = (field: CPEEditField) => field.input === 'select' ? 'select' : field.type === 'boolean' ? 'checkbox' : field.type === 'string' ? editFieldSensitive(field.parameter) ? 'password' : 'text' : 'number';
export const editFieldTypeMatches = (field: CPEEditField, parameter?: DeviceParameter) => parameter?.value_type?.replace(/^xsd:/, '') === field.type;
export const editFieldUnavailable = (field: CPEEditField, parameter?: DeviceParameter) => !parameter ? 'Parameter is missing on this CPE.' : !editFieldTypeMatches(field, parameter) ? 'Parameter type differs from the template.' : parameter.writable !== true ? 'The CPE has not confirmed write access.' : '';

export function validateCPEEditValue(type: CPEEditType, value: string): string {
  if (type === 'string') return '';
  if (type === 'boolean') return ['true', 'false', '1', '0'].includes(value) ? '' : 'Choose true or false.';
  if (!(type === 'int' ? /^-?\d+$/ : /^\d+$/).test(value)) return type === 'int' ? 'Enter a whole number.' : 'Enter a non-negative whole number.';
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= (type === 'int' ? -2147483648 : 0) && number <= (type === 'int' ? 2147483647 : 4294967295) ? '' : 'Number is outside the CWMP type range.';
}

export function validateCPEEditChanges(window: CPEEditWindow, prefix: string, parameters: DeviceParameter[], edits: Record<string, string>) {
  const changes: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const fields = new Map(window.tabs.flatMap(tab => tab.fields.map(field => [prefix + field.parameter, field] as const)));
  for (const [name, value] of Object.entries(edits)) {
    const field = fields.get(name);
    const parameter = parameters.find(item => item.name === name);
    if (!field) { errors[name] = 'Unknown field.'; continue; }
    if (value === parameter?.value && !editFieldSensitive(name)) continue;
    const error = editFieldUnavailable(field, parameter) || validateCPEEditValue(field.type, value) || (field.input === 'select' && !field.options.some(option => option.value === value) ? 'Choose a configured option.' : '');
    if (error) errors[name] = error; else changes[name] = value;
  }
  return { changes, errors };
}

export const newCPEEditWindow = (target: CPEEditTarget): CPEEditWindow => ({ version: 1, target, enabled: false, base_pattern: '', tabs: [{ id: crypto.randomUUID(), name: 'General', columns: 2, fields: [] }] });
