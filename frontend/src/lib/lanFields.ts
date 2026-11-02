export interface LanFieldDef {
  label: string;
  suffixes: string[];
  type: 'text' | 'password' | 'select' | 'number' | 'toggle';
  options?: string[];
  placeholder?: string;
  validate?: (value: string) => string | null;
}

export const GENERAL_FIELDS: LanFieldDef[] = [
  { label: 'Name', suffixes: ['Name'], type: 'text', placeholder: 'Interface name' },
  { label: 'Enable', suffixes: ['Enable'], type: 'toggle' },
  { label: 'Speed', suffixes: ['X_HW_Speed'], type: 'select', options: ['Auto', '10M', '100M', '1000M'] },
  { label: 'Duplex', suffixes: ['X_HW_DuplexMode'], type: 'select', options: ['Auto', 'Half', 'Full'] },
  { label: 'L3 Enable', suffixes: ['X_HW_L3Enable'], type: 'toggle' },
];

export const ADVANCED_FIELDS: LanFieldDef[] = [
  { label: 'VLAN', suffixes: ['X_HW_VLAN', 'VLANID'], type: 'number', placeholder: '1–4094', validate: (v) => { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 4094) return 'VLAN must be 1–4094'; return null; } },
  { label: 'PVID', suffixes: ['X_HW_PVID'], type: 'number', placeholder: '1–4094', validate: (v) => { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 4094) return 'PVID must be 1–4094'; return null; } },
  { label: 'Auto-Negotiation', suffixes: ['X_HW_AutoNegotiation'], type: 'toggle' },
  { label: 'Flow Control', suffixes: ['X_HW_FlowControl'], type: 'toggle' },
  { label: 'Energy Efficient Ethernet', suffixes: ['X_HW_EnergyEfficientEthernet'], type: 'toggle' },
  { label: 'Port Mapping', suffixes: ['X_HW_PortMapping'], type: 'text', placeholder: 'e.g. 1,2,3' },
  { label: 'Link Mode', suffixes: ['X_HW_LinkMode'], type: 'select', options: ['Auto', '10Base-T', '100Base-TX', '1000Base-T'] },
  { label: '802.1X', suffixes: ['X_HW_802_1X'], type: 'toggle' },
];

export const ALL_FIELDS = [...GENERAL_FIELDS, ...ADVANCED_FIELDS];

export const LAN_PREFIX = (index: number) => `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${index}.`;

export function resolveSuffix(parameters: { name: string }[], prefix: string, suffixes: string[]): string | null {
  for (const s of suffixes) {
    if (parameters.some(p => p.name === prefix + s)) return s;
  }
  return null;
}

export function getChangedParams(
  parameters: { name: string; value: string }[],
  prefix: string,
  edits: Record<string, string>,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const field of ALL_FIELDS) {
    const suffix = resolveSuffix(parameters, prefix, field.suffixes);
    if (!suffix) continue;
    const key = prefix + suffix;
    const original = parameters.find(p => p.name === key)?.value ?? '';
    const current = edits[key] ?? original;
    if (current !== original) changed[key] = current;
  }
  return changed;
}

export function validateFields(
  parameters: { name: string; value: string }[],
  prefix: string,
  edits: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of ALL_FIELDS) {
    if (!field.validate) continue;
    const suffix = resolveSuffix(parameters, prefix, field.suffixes);
    if (!suffix) continue;
    const key = prefix + suffix;
    const value = edits[key] ?? parameters.find(p => p.name === key)?.value ?? '';
    const error = field.validate(value);
    if (error) errors[key] = error;
  }
  return errors;
}

export function validateChangedFields(
  parameters: { name: string; value: string }[],
  prefix: string,
  edits: Record<string, string>,
): Record<string, string> {
  const changedKeys = new Set(Object.keys(getChangedParams(parameters, prefix, edits)));
  return Object.fromEntries(Object.entries(validateFields(parameters, prefix, edits)).filter(([key]) => changedKeys.has(key)));
}

export function statusBadgeClass(status: string): string {
  const s = status.trim().toLowerCase();
  if (s === 'up' || s === 'linkup' || s === 'connected' || s === 'enabled') return 'badge-success';
  if (s === 'nolink' || s === 'linkdown' || s === 'down' || s === 'disabled') return 'badge-error';
  if (s === '-' || s === '') return 'badge-warning';
  return 'badge-error';
}
