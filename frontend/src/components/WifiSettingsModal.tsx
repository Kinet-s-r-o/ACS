import { createSignal, createMemo, createEffect, Show, For, type Component } from 'solid-js';
import { api, type DeviceParameter } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeedback } from './Feedback';
import Dialog from './Dialog';
import { Save, Send, Check } from 'lucide-solid';
import { ALL_FIELDS, GENERAL_FIELDS, SECURITY_FIELDS, ADVANCED_FIELDS, WLAN_PREFIX, resolveSuffix, getChangedParams, validateFields, type WifiFieldDef } from '../lib/wifiFields';

interface WifiSettingsModalProps {
  wlanIndex: number;
  interfacePrefix?: string;
  parameters: DeviceParameter[];
  serial: string;
  isFullAccess: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type TabId = 'general' | 'security' | 'advanced';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'security', label: 'Security' },
  { id: 'advanced', label: 'Advanced' },
];

const WifiSettingsModal: Component<WifiSettingsModalProps> = (props) => {
  const { notify } = useFeedback();
  const [activeTab, setActiveTab] = createSignal<TabId>('general');
  const { can } = useAuth();
  const section = (tab: TabId) => `inventory.cpes.overview.wifi.${tab}`;
  const canEditTab = () => can(section(activeTab()), 'edit');
  createEffect(() => {
    if (!can(section(activeTab()), 'read')) {
      const first = TABS.find(tab => can(section(tab.id), 'read'));
      if (first) setActiveTab(first.id);
    }
  });
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [summoning, setSummoning] = createSignal(false);
  const [errors, setErrors] = createSignal<Record<string, string>>({});

  const prefix = props.interfacePrefix ?? WLAN_PREFIX(props.wlanIndex);

  const resolveFieldSuffix = (suffixes: string[]): string | null => resolveSuffix(props.parameters, prefix, suffixes);

  const getOriginalValue = (field: WifiFieldDef): string => {
    const suffix = resolveFieldSuffix(field.suffixes);
    if (!suffix) return '';
    return props.parameters.find(p => p.name === prefix + suffix)?.value ?? '';
  };

  const isWritable = (field: WifiFieldDef): boolean => {
    const suffix = resolveFieldSuffix(field.suffixes);
    if (!suffix) return false;
    const param = props.parameters.find(p => p.name === prefix + suffix);
    if (!param) return false;
    return param.writable !== false;
  };

  const [edits, setEdits] = createSignal<Record<string, string>>({});

  const getValue = (field: WifiFieldDef): string => {
    const suffix = resolveFieldSuffix(field.suffixes);
    if (!suffix) return '';
    const key = prefix + suffix;
    return edits()[key] ?? getOriginalValue(field);
  };

  const setValue = (field: WifiFieldDef, value: string) => {
    const suffix = resolveFieldSuffix(field.suffixes);
    if (!suffix) return;
    const key = prefix + suffix;
    setEdits({ ...edits(), [key]: value });
    const newErrors = { ...errors() };
    delete newErrors[key];
    setErrors(newErrors);
  };

  const hasChanges = createMemo(() => Object.keys(getChangedParams(props.parameters, prefix, edits())).length > 0);

  const knownSuffixes = new Set(ALL_FIELDS.flatMap(f => f.suffixes));
  const genericParams = createMemo(() => {
    return props.parameters
      .filter(p => p.name.startsWith(prefix) && !knownSuffixes.has(p.name.slice(prefix.length)))
      .filter(p => p.writable !== false);
  });

  const [genericEdits, setGenericEdits] = createSignal<Record<string, string>>({});

  const getGenericChanged = (): Record<string, string> => {
    const changed: Record<string, string> = {};
    for (const p of genericParams()) {
      const current = genericEdits()[p.name] ?? p.value;
      if (current !== p.value) changed[p.name] = current;
    }
    return changed;
  };

  const hasGenericChanges = createMemo(() => Object.keys(getGenericChanged()).length > 0);

  const validate = (): boolean => {
    const newErrors = validateFields(props.parameters, prefix, edits());
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    const changed = { ...getChangedParams(props.parameters, prefix, edits()), ...getGenericChanged() };
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    try {
      await api.setParameterValues(props.serial, changed);
      setSaved(true);
      props.onSaved();
    } catch (err) {
      notify({ tone: 'error', title: 'Wi-Fi update failed', detail: (err as Error).message, persistent: true });
    }
    setSaving(false);
  };

  const handleSummon = async () => {
    setSummoning(true);
    try {
      await api.createSystemSummon(props.serial);
      notify({ tone: 'info', title: 'Summon queued', message: 'The system task processor will contact the CPE shortly.' });
    } catch (err) {
      notify({ tone: 'error', title: 'Summon failed', detail: (err as Error).message, persistent: true });
    }
    setSummoning(false);
  };
  const renderField = (field: WifiFieldDef) => {
    const suffix = resolveFieldSuffix(field.suffixes);
    if (!suffix) return null;
    const key = prefix + suffix;
    const value = getValue(field);
    const writable = isWritable(field);
    const error = errors()[key];

    return (
      <div class="flex flex-col gap-1">
        <label class="text-xs text-muted" for={`wifi-${props.wlanIndex}-${key}`}>{field.label}</label>
        <Show when={field.type === 'toggle'}>
          <button
            id={`wifi-${props.wlanIndex}-${key}`}
            type="button"
            disabled={!writable || !canEditTab()}
            onClick={() => setValue(field, value === '1' || value === 'true' ? '0' : '1')}
            class={`badge cursor-pointer ${value === '1' || value === 'true' ? 'badge-success' : 'badge-error'}`}
            aria-pressed={value === '1' || value === 'true'}
          >
            {value === '1' || value === 'true' ? 'Enabled' : 'Disabled'}
          </button>
        </Show>
        <Show when={field.type === 'select'}>
          <select
            id={`wifi-${props.wlanIndex}-${key}`}
            value={value}
            disabled={!writable || !canEditTab()}
            onChange={(e) => setValue(field, e.currentTarget.value)}
            class="input py-1.5 px-2 text-sm"
          >
            <option value="">{value || '—'}</option>
            <For each={field.options}>{(opt) => <option value={opt}>{opt}</option>}</For>
          </select>
        </Show>
        <Show when={field.type === 'text' || field.type === 'number' || field.type === 'password'}>
          <input
            id={`wifi-${props.wlanIndex}-${key}`}
            type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
            value={value}
            disabled={!writable || !canEditTab()}
            onInput={(e) => setValue(field, e.currentTarget.value)}
            placeholder={field.placeholder}
            class={`input py-1.5 px-2 text-sm ${error ? 'border-red-500' : ''}`}
          />
        </Show>
        <Show when={error}><span class="text-xs text-red-400">{error}</span></Show>
        <Show when={!writable && canEditTab()}><span class="text-[10px] text-muted">Read-only on this device</span></Show>
      </div>
    );
  };

  const fieldsForTab = (tab: TabId) => {
    if (tab === 'general') return GENERAL_FIELDS;
    if (tab === 'security') return SECURITY_FIELDS;
    return ADVANCED_FIELDS;
  };

  return (
    <Dialog
      title={`Wi-Fi SSID${props.wlanIndex} settings`}
      description={`Configure wireless parameters for SSID${props.wlanIndex}. Changes are queued as a task and applied when the CPE next connects.`}
      size="large"
      onClose={props.onClose}
      actions={
        <Show when={saved()} fallback={
          <div class="flex items-center gap-2">
            <button onClick={props.onClose} class="btn btn-secondary">Cancel</button>
            <button onClick={handleSave} disabled={!canEditTab() || (!hasChanges() && !hasGenericChanges()) || saving()} class="btn btn-primary">
              <Save size={14} />
              {saving() ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        }>
          <div class="flex items-center gap-2">
            <span class="flex items-center gap-1 text-xs text-emerald-400"><Check size={14} /> Task created</span>
            <button onClick={handleSummon} disabled={!can('inventory.cpes.overview', 'edit') || summoning()} class="btn btn-primary">
              <Send size={14} />
              {summoning() ? 'Summoning…' : 'Summon device'}
            </button>
            <button onClick={props.onClose} class="btn btn-secondary">Close</button>
          </div>
        </Show>
      }
    >
      <div class="flex gap-1 mb-4 border-b border-subtle pb-2">
        <For each={TABS.filter(tab => can(section(tab.id), 'read'))}>{(tab) => (
          <button
            type="button"
            onClick={() => setActiveTab(tab.id)}
            class={`px-3 py-1.5 text-xs rounded-md transition-colors ${activeTab() === tab.id ? 'bg-elevated text-primary font-medium' : 'text-secondary hover:text-primary'}`}
          >
            {tab.label}
          </button>
        )}</For>
      </div>

      <div class="space-y-4 max-h-80 overflow-y-auto pr-1">
        <Show when={can(section('general'), 'read') && activeTab() === 'general'}>
          <div class="grid grid-cols-2 gap-4">
            <For each={fieldsForTab('general')}>{(field) => renderField(field)}</For>
          </div>
        </Show>
        <Show when={can(section('security'), 'read') && activeTab() === 'security'}>
          <div class="grid grid-cols-2 gap-4">
            <For each={fieldsForTab('security')}>{(field) => renderField(field)}</For>
          </div>
        </Show>
        <Show when={can(section('advanced'), 'read') && activeTab() === 'advanced'}>
          <div class="grid grid-cols-2 gap-4">
            <For each={fieldsForTab('advanced')}>{(field) => renderField(field)}</For>
          </div>
          <Show when={genericParams().length > 0}>
            <div class="mt-4 pt-4 border-t border-subtle">
              <h4 class="text-xs font-medium text-muted mb-3">Other writable parameters</h4>
              <div class="space-y-3">
                <For each={genericParams()}>
                  {(p) => (
                    <div class="flex flex-col gap-1">
                      <label class="text-xs text-muted font-mono" for={`wifi-generic-${props.wlanIndex}-${p.name}`}>
                        {p.name.slice(prefix.length)}
                      </label>
                      <input
                        id={`wifi-generic-${props.wlanIndex}-${p.name}`}
                        type="text"
                        value={genericEdits()[p.name] ?? p.value}
                        disabled={!canEditTab()}
                        onInput={(e) => setGenericEdits({ ...genericEdits(), [p.name]: e.currentTarget.value })}
                        class="input py-1.5 px-2 text-sm font-mono"
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  );
};

export default WifiSettingsModal;

