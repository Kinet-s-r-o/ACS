import { createMemo, createSignal, For, Show, type Component } from 'solid-js';
import { Check, Save, Send } from 'lucide-solid';
import { api, type DeviceParameter } from '../lib/api';
import { useFeedback } from './Feedback';
import Dialog from './Dialog';

interface LanNetworkSettingsModalProps {
  parameters: DeviceParameter[];
  serial: string;
  onClose: () => void;
  onSaved: () => void;
}

interface LanNetworkField {
  name: string;
  label: string;
  section: 'DHCP server' | 'LAN IP interfaces';
  type: 'text' | 'number' | 'toggle';
  placeholder?: string;
}

const PREFIX = 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.';
const IPV4_FIELDS: Array<{ suffix: string; label: string; section: LanNetworkField['section']; type?: LanNetworkField['type']; placeholder?: string }> = [
  { suffix: 'DHCPServerEnable', label: 'DHCP server', section: 'DHCP server', type: 'toggle' },
  { suffix: 'DHCPServerConfigurable', label: 'DHCP server configurable', section: 'DHCP server', type: 'toggle' },
  { suffix: 'MinAddress', label: 'First leased address', section: 'DHCP server', placeholder: '192.168.1.100' },
  { suffix: 'MaxAddress', label: 'Last leased address', section: 'DHCP server', placeholder: '192.168.1.200' },
  { suffix: 'SubnetMask', label: 'DHCP subnet mask', section: 'DHCP server', placeholder: '255.255.255.0' },
  { suffix: 'DHCPLeaseTime', label: 'Lease time (seconds)', section: 'DHCP server', type: 'number', placeholder: '3600' },
  { suffix: 'IPRouters', label: 'Router', section: 'DHCP server', placeholder: '192.168.1.1' },
  { suffix: 'DNSServers', label: 'DNS servers', section: 'DHCP server', placeholder: '192.168.1.1' },
  { suffix: 'DomainName', label: 'Domain name', section: 'DHCP server', placeholder: 'home' },
];

const isIPv4 = (value: string): boolean => {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

const LanNetworkSettingsModal: Component<LanNetworkSettingsModalProps> = (props) => {
  const { notify } = useFeedback();
  const [edits, setEdits] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [summoning, setSummoning] = createSignal(false);
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const byName = new Map(props.parameters.map(parameter => [parameter.name, parameter]));

  const fields = createMemo<LanNetworkField[]>(() => {
    const result = IPV4_FIELDS
      .map(field => ({ ...field, name: PREFIX + field.suffix, type: field.type || 'text' } as LanNetworkField))
      .filter(field => byName.has(field.name));
    const indexes = new Set(props.parameters.flatMap(parameter => {
      const match = parameter.name.match(/^InternetGatewayDevice\.LANDevice\.1\.LANHostConfigManagement\.IPInterface\.(\d+)\./);
      return match ? [Number(match[1])] : [];
    }));
    for (const index of [...indexes].sort((a, b) => a - b)) {
      const interfacePrefix = `${PREFIX}IPInterface.${index}.`;
      for (const [suffix, label, type] of [
        ['Enable', 'Enabled', 'toggle'],
        ['IPInterfaceIPAddress', 'IP address', 'text'],
        ['IPInterfaceSubnetMask', 'Subnet mask', 'text'],
      ] as const) {
        const name = interfacePrefix + suffix;
        if (byName.has(name)) result.push({ name, label: `Interface ${index} · ${label}`, section: 'LAN IP interfaces', type, placeholder: suffix === 'IPInterfaceIPAddress' ? '192.168.1.1' : suffix === 'IPInterfaceSubnetMask' ? '255.255.255.0' : undefined });
      }
    }
    return result;
  });

  const getValue = (field: LanNetworkField) => edits()[field.name] ?? byName.get(field.name)?.value ?? '';
  const changed = createMemo(() => Object.fromEntries(fields()
    .filter(field => byName.get(field.name)?.writable !== false && edits()[field.name] !== undefined && edits()[field.name] !== byName.get(field.name)?.value)
    .map(field => [field.name, edits()[field.name]])));

  const validate = () => {
    const next: Record<string, string> = {};
    for (const field of fields()) {
      if (field.type === 'toggle' || !edits()[field.name]) continue;
      const value = edits()[field.name];
      if (['MinAddress', 'MaxAddress', 'SubnetMask', 'IPRouters', 'DNSServers'].some(suffix => field.name === PREFIX + suffix)
        || field.name.endsWith('.IPInterfaceIPAddress') || field.name.endsWith('.IPInterfaceSubnetMask')) {
        if (!value.split(',').every(address => isIPv4(address.trim()))) next[field.name] = 'Enter a valid IPv4 address.';
      }
      if (field.name === PREFIX + 'DHCPLeaseTime' && (!/^\d+$/.test(value) || Number(value) < 1)) next[field.name] = 'Lease time must be a positive number of seconds.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSave = async () => {
    if (!validate() || Object.keys(changed()).length === 0) return;
    setSaving(true);
    try {
      await api.setParameterValues(props.serial, changed());
      setSaved(true);
      props.onSaved();
    } catch (error) {
      notify({ tone: 'error', title: 'LAN configuration update failed', detail: (error as Error).message, persistent: true });
    } finally { setSaving(false); }
  };

  const handleSummon = async () => {
    setSummoning(true);
    try {
      const result = await api.connectionRequest(props.serial);
      notify({ tone: 'success', title: 'Device summoned', message: result.message });
    } catch (error) {
      notify({ tone: 'error', title: 'Summon failed', detail: (error as Error).message, persistent: true });
    } finally { setSummoning(false); }
  };

  const sections: LanNetworkField['section'][] = ['DHCP server', 'LAN IP interfaces'];
  return (
    <Dialog
      title="LAN IP and DHCP settings"
      description="Changes are queued as a configuration task and applied when the CPE next connects. Changing the LAN address may interrupt access to the device."
      size="large"
      onClose={props.onClose}
      actions={<Show when={saved()} fallback={<div class="flex items-center gap-2"><button onClick={props.onClose} class="btn btn-secondary">Cancel</button><button onClick={handleSave} disabled={Object.keys(changed()).length === 0 || saving()} class="btn btn-primary"><Save size={14} />{saving() ? 'Saving…' : 'Save changes'}</button></div>}>
        <div class="flex items-center gap-2"><span class="flex items-center gap-1 text-xs text-emerald-400"><Check size={14} /> Task created</span><button onClick={handleSummon} disabled={summoning()} class="btn btn-primary"><Send size={14} />{summoning() ? 'Summoning…' : 'Summon device'}</button><button onClick={props.onClose} class="btn btn-secondary">Close</button></div>
      </Show>}
    >
      <div class="space-y-5 max-h-[65vh] overflow-y-auto pr-1">
        <For each={sections}>{section => {
          const sectionFields = () => fields().filter(field => field.section === section);
          return <Show when={sectionFields().length > 0}><section><h3 class="text-xs font-medium text-muted mb-3">{section}</h3><div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <For each={sectionFields()}>{field => {
              const parameter = byName.get(field.name)!;
              const writable = parameter.writable !== false;
              const value = getValue(field);
              return <div class="flex flex-col gap-1"><label class="text-xs text-muted" for={`lan-network-${field.name}`}>{field.label}</label>
                <Show when={field.type === 'toggle'} fallback={<input id={`lan-network-${field.name}`} type={field.type === 'number' ? 'number' : 'text'} value={value} placeholder={field.placeholder} disabled={!writable} onInput={event => setEdits(previous => ({ ...previous, [field.name]: event.currentTarget.value }))} class={`input py-1.5 px-2 text-sm ${errors()[field.name] ? 'border-red-500' : ''}`} />}>
                  <button id={`lan-network-${field.name}`} type="button" disabled={!writable} aria-pressed={value === '1' || value === 'true'} onClick={() => setEdits(previous => ({ ...previous, [field.name]: value === '1' || value === 'true' ? '0' : '1' }))} class={`badge w-fit cursor-pointer ${value === '1' || value === 'true' ? 'badge-success' : 'badge-error'}`}>{value === '1' || value === 'true' ? 'Enabled' : 'Disabled'}</button>
                </Show>
                <Show when={errors()[field.name]}><span class="text-xs text-red-400">{errors()[field.name]}</span></Show>
                <Show when={!writable}><span class="text-[10px] text-muted">Read-only on this device</span></Show>
              </div>;
            }}</For>
          </div></section></Show>;
        }}</For>
        <Show when={fields().length === 0}><p class="text-sm text-muted">This device has not reported any supported LAN IP or DHCP parameters.</p></Show>
      </div>
    </Dialog>
  );
};

export default LanNetworkSettingsModal;
