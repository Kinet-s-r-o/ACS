export interface WanFieldDef {
  label: string;
  suffixes: string[];
  type: 'text' | 'password' | 'select' | 'number' | 'toggle';
  options?: string[];
  placeholder?: string;
  validate?: (value: string) => string | null;
  section?: string;
  visibleWhen?: (getVal: (suffixes: string[]) => string) => boolean;
  labelWhen?: (getVal: (suffixes: string[]) => string) => string;
}

const isRouted = (getVal: (suffixes: string[]) => string) => getVal(['ConnectionType']) === 'IP_Routed';
const isPPPoE = (getVal: (suffixes: string[]) => string) => getVal(['AddressingType']) === 'PPPoE';
const isDHCP = (getVal: (suffixes: string[]) => string) => getVal(['AddressingType']) === 'DHCP';
const isIPv6 = (getVal: (suffixes: string[]) => string) => getVal(['X_HW_LowerLayers']) === 'IPv6';
const isNATEnabled = (getVal: (suffixes: string[]) => string) => {
  const v = getVal(['NATEnabled']);
  return v === '1' || v === 'true';
};

export const GENERAL_FIELDS: WanFieldDef[] = [
  { label: 'Name', suffixes: ['Name'], type: 'text', placeholder: 'Connection name' },
  { label: 'Enable WAN', suffixes: ['Enable'], type: 'toggle' },
  { label: 'WAN Mode', suffixes: ['ConnectionType'], type: 'select', options: ['IP_Routed', 'IP_Bridged'] },
  { label: 'Encapsulation Mode', suffixes: ['AddressingType'], type: 'select', options: ['IP', 'DHCP', 'PPPoE', 'None'], visibleWhen: isRouted },
  { label: 'Protocol Type', suffixes: ['X_HW_LowerLayers'], type: 'select', options: ['IPv4', 'IPv6', 'IPv4/IPv6'] },
  { label: 'Service Type', suffixes: ['X_HW_SERVICELIST'], type: 'text', placeholder: 'e.g. 832' },
  { label: 'VLAN ID', suffixes: ['X_HW_VLAN'], type: 'number', placeholder: '0–4096 (0 = disabled)', validate: (v) => { if (!v) return null; const n = parseInt(v, 10); if (isNaN(n) || n < 0 || n > 4096) return 'VLAN must be 0–4096'; return null; } },
  { label: '802.1p Policy', suffixes: ['X_HW_PriPolicy'], type: 'select', options: ['Use the specified value', 'Use the default value'] },
  { label: '802.1p', suffixes: ['X_HW_PRI'], type: 'select', options: ['0', '1', '2', '3', '4', '5', '6', '7'] },
  { label: 'MTU / MRU', suffixes: ['MaxMTUSize', 'X_HW_MTU'], type: 'number', placeholder: '1280–1500', validate: (v) => { if (!v) return null; const n = parseInt(v, 10); if (isNaN(n) || n < 1280 || n > 1500) return 'MTU must be 1280–1500'; return null; } },
  { label: 'User Name', suffixes: ['Username'], type: 'text', placeholder: 'PPPoE username', visibleWhen: isPPPoE },
  { label: 'Password', suffixes: ['Password'], type: 'password', placeholder: 'PPPoE password', visibleWhen: isPPPoE },
  { label: 'Enable passthrough', suffixes: ['X_HW_Passthrough', 'PassthroughEnable'], type: 'toggle', visibleWhen: isPPPoE },
  { label: 'Enable LCP Detection', suffixes: ['X_HW_LCPDetection', 'LCPDetection'], type: 'toggle', visibleWhen: isPPPoE },
];

export const BINDING_FIELDS: WanFieldDef[] = [
  { label: 'LAN1', suffixes: ['X_HW_LANBIND.Lan1Enable'], type: 'toggle', section: 'binding' },
  { label: 'LAN2', suffixes: ['X_HW_LANBIND.Lan2Enable'], type: 'toggle', section: 'binding' },
  { label: 'LAN3', suffixes: ['X_HW_LANBIND.Lan3Enable'], type: 'toggle', section: 'binding' },
  { label: 'LAN4', suffixes: ['X_HW_LANBIND.Lan4Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID1', suffixes: ['X_HW_LANBIND.SSID1Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID2', suffixes: ['X_HW_LANBIND.SSID2Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID3', suffixes: ['X_HW_LANBIND.SSID3Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID4', suffixes: ['X_HW_LANBIND.SSID4Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID5', suffixes: ['X_HW_LANBIND.SSID5Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID6', suffixes: ['X_HW_LANBIND.SSID6Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID7', suffixes: ['X_HW_LANBIND.SSID7Enable'], type: 'toggle', section: 'binding' },
  { label: 'SSID8', suffixes: ['X_HW_LANBIND.SSID8Enable'], type: 'toggle', section: 'binding' },
];

export const IPV4_FIELDS: WanFieldDef[] = [
  { label: 'IP Acquisition Mode', suffixes: ['X_HW_IPv4AcqMode', 'IPv4AddressingType'], type: 'select', options: ['IP', 'DHCP', 'PPPoE', 'None'], visibleWhen: isRouted },
  { label: 'Enable NAT', suffixes: ['NATEnabled'], type: 'toggle', visibleWhen: isRouted },
  { label: 'NAT type', suffixes: ['X_HW_NatType'], type: 'select', options: ['0', '1', '2', '3'], visibleWhen: isNATEnabled },
  { label: 'Vendor ID', suffixes: ['X_HW_VenderClassID'], type: 'text', placeholder: '0–64 chars', visibleWhen: isDHCP },
  { label: 'User ID', suffixes: ['X_HW_ClientID'], type: 'text', placeholder: '0–64 chars', visibleWhen: isDHCP },
  { label: 'Dialing Method', suffixes: ['X_HW_DialingMethod', 'DialingMethod'], type: 'select', options: ['Auto', 'Manual'], visibleWhen: isPPPoE },
  { label: 'Multicast VLAN ID', suffixes: ['X_HW_MultiCastVLAN'], type: 'number', placeholder: '0–4094', validate: (v) => { if (!v) return null; const n = parseInt(v, 10); if (isNaN(n) || n < 0 || n > 4094) return 'Must be 0–4094'; return null; }, visibleWhen: isRouted },
];

export const IPV6_FIELDS: WanFieldDef[] = [
  { label: 'Prefix Acquisition Mode', suffixes: ['X_HW_IPv6PrefixAcqMode', 'X_HW_PrefixAcqMode'], type: 'select', options: ['DHCPv6', 'RA', 'Static'], visibleWhen: isRouted },
  { label: 'IP Acquisition Mode', suffixes: ['X_HW_IPv6AcqMode', 'X_HW_IPv6AddressingMode'], type: 'select', options: ['DHCPv6', 'RA', 'Static', 'None'], visibleWhen: isRouted },
  { label: 'Prefix Mask', suffixes: ['X_HW_IPv6PrefixMask', 'X_HW_PrefixMask'], type: 'text', placeholder: 'e.g. 64' },
  { label: 'Multicast VLAN ID', suffixes: ['X_HW_IPv6MultiCastVLAN'], type: 'number', placeholder: '0–4094', validate: (v) => { if (!v) return null; const n = parseInt(v, 10); if (isNaN(n) || n < 0 || n > 4094) return 'Must be 0–4094'; return null; }, visibleWhen: isRouted },
  { label: 'DS-Lite Working Mode', suffixes: ['X_HW_6RDTunnel.Mode', 'X_HW_DSLiteMode'], type: 'select', options: ['Disabled', 'Static', 'Dynamic'], visibleWhen: isIPv6 },
  { label: 'AFTR Name', suffixes: ['X_HW_6RDTunnel.AFTRName', 'X_HW_AFTRName'], type: 'text', placeholder: 'AFTR hostname or IP' },
  { label: 'Enable NPTv6', suffixes: ['X_HW_NPTv6Enable'], type: 'toggle', visibleWhen: isRouted },
];

export const ADVANCED_FIELDS: WanFieldDef[] = [
  { label: 'Connection Trigger', suffixes: ['ConnectionTrigger'], type: 'select', options: ['Auto', 'Manual', 'Schedule'] },
  { label: 'Auto Disconnect', suffixes: ['AutoDisconnectTime'], type: 'number', placeholder: 'seconds (0 = never)' },
  { label: 'Idle Disconnect', suffixes: ['IdleDisconnectTime'], type: 'number', placeholder: 'seconds (0 = never)' },
  { label: 'Warn Disconnect Delay', suffixes: ['WarnDisconnectDelay'], type: 'number', placeholder: 'seconds' },
  { label: 'Shaping Rate', suffixes: ['ShapingRate'], type: 'number', placeholder: 'bps' },
  { label: 'Shaping Burst Size', suffixes: ['ShapingBurstSize'], type: 'number', placeholder: 'bytes' },
  { label: 'Route Protocol Rx', suffixes: ['RouteProtocolRx'], type: 'select', options: ['Static', 'DHCP', 'BGP', 'OSPF'] },
];

export const ALL_FIELDS = [...GENERAL_FIELDS, ...BINDING_FIELDS, ...IPV4_FIELDS, ...IPV6_FIELDS, ...ADVANCED_FIELDS];

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
