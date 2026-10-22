import type { Component } from 'solid-js';
import { createResource, createSignal, Show, For } from 'solid-js';
import { Save, Settings as SettingsIcon, Info, RefreshCw } from 'lucide-solid';
import { api } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { ResourceError } from '../components/ResourceState';
import { useAuth } from '../lib/auth';

interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number';
  placeholder?: string;
}

const settingFields: SettingField[] = [
  { key: 'firmware_base_url', label: 'Firmware base URL', type: 'text', placeholder: 'https://acs.example.com' },
];

const Delivery: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify } = useFeedback();
  const [settings, { refetch }] = createResource(() => api.getSettings());
  const [formData, setFormData] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);

  const handleChange = (key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateSettings(formData());
      notify({ tone: 'success', title: 'Settings saved', message: 'Connection and delivery settings saved.' });
      refetch();
      setFormData({});
    } catch (err) {
      notify({ tone: 'error', title: 'Settings were not saved', message: 'The previous connection and delivery configuration remains active. Review the fields and retry.', detail: (err as Error).message, persistent: true });
    } finally {
      setSaving(false);
    }
  };

  const getValue = (key: string) => {
    return formData()[key] ?? settings()?.[key] ?? '';
  };

  const generatePassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    const password: string[] = [];
    const bytes = new Uint8Array(32);
    try {
      while (password.length < 24) {
        window.crypto.getRandomValues(bytes);
        for (const byte of bytes) {
          if (byte < limit) password.push(alphabet[byte % alphabet.length]);
          if (password.length === 24) break;
        }
      }
      handleChange('connection_request_password', password.join(''));
    } catch {
      notify({ tone: 'error', title: 'Password generation failed', message: 'Secure password generation is unavailable in this browser.' });
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="Delivery & Connection Request" description="Firmware delivery endpoint and credentials used when ACS contacts a CPE." />

      <div class="card p-5">
        <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
          <SettingsIcon size={14} />
          Delivery & Connection Request
        </h2>
        <p class="text-muted text-xs mb-4">
          Firmware delivery endpoint and credentials used when ACS contacts a CPE.
        </p>

        <Show when={settings.error}><ResourceError title="Connection settings are unavailable" description="ACS could not read the current firmware and connection-request configuration. Retry before changing deployment settings." onRetry={() => refetch()} /></Show>
        <Show when={!settings.loading && !settings.error} fallback={settings.loading ?
          <div class="space-y-4">
            <div class="skeleton h-10 w-full" />
            <div class="skeleton h-10 w-full" />
            <div class="skeleton h-10 w-full" />
          </div> : undefined
        }>
          <div class="space-y-4">
            <For each={settingFields}>
              {(field) => (
                <div>
                  <label for={`setting-${field.key}`} class="block text-xs text-muted mb-1.5">
                    {field.label}
                  </label>
                  <input
                    id={`setting-${field.key}`}
                    type={field.type}
                    value={getValue(field.key)}
                    onInput={(e) => handleChange(field.key, e.currentTarget.value)}
                    placeholder={field.placeholder}
                    class="input"
                    disabled={!isFullAccess()}
                  />
                </div>
              )}
            </For>

            {/* Connection Request Credentials Section */}
            <div class="pt-4 border-t border-subtle">
              <div class="flex items-center justify-between mb-3">
                <div>
                  <span class="block text-xs text-muted">Connection-request credential mode</span>
                  <p class="text-xs text-muted mt-0.5">Choose how ACS authenticates outbound connection requests to each CPE.</p>
                </div>
                <button
                  onClick={() => handleChange('use_auto_conn_credentials', getValue('use_auto_conn_credentials') === 'true' ? 'false' : 'true')}
                  class={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    getValue('use_auto_conn_credentials') === 'true'
                      ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                      : 'bg-zinc-700 text-secondary border border-zinc-600'
                  }`}
                  disabled={!isFullAccess()}
                  aria-pressed={getValue('use_auto_conn_credentials') === 'true'}
                >
                  {getValue('use_auto_conn_credentials') === 'true' ? 'Auto (Serial Number)' : 'Custom'}
                </button>
              </div>

              <Show when={getValue('use_auto_conn_credentials') !== 'true'}>
                <div class="space-y-3 pt-3 border-t border-subtle">
                  <div>
                    <label for="connection-request-username" class="block text-xs text-muted mb-1.5">Connection-request username</label>
                    <input
                      id="connection-request-username"
                      type="text"
                      value={getValue('connection_request_username')}
                      onInput={(e) => handleChange('connection_request_username', e.currentTarget.value)}
                      placeholder="admin"
                      class="input"
                      disabled={!isFullAccess()}
                    />
                  </div>
                  <div>
                    <div class="flex items-center justify-between gap-3 mb-1.5">
                      <label for="connection-request-password" class="block text-xs text-muted">Connection-request password</label>
                      <button type="button" class="btn btn-secondary text-xs" onClick={generatePassword} disabled={!isFullAccess()}>
                        <RefreshCw size={13} /> Generate password
                      </button>
                    </div>
                    <input
                      id="connection-request-password"
                      type="password"
                      value={getValue('connection_request_password')}
                      onInput={(e) => handleChange('connection_request_password', e.currentTarget.value)}
                      placeholder="Optional"
                      class="input"
                      disabled={!isFullAccess()}
                    />
                  </div>
                </div>
              </Show>

              <Show when={getValue('use_auto_conn_credentials') === 'true'}>
                <div class="space-y-3 pt-3 border-t border-subtle">
                  <div>
                    <label for="connection-request-secret" class="block text-xs text-muted mb-1.5">Connection-request master secret</label>
                    <input
                      id="connection-request-secret"
                      type="password"
                      value={getValue('connection_request_password')}
                      onInput={(e) => handleChange('connection_request_password', e.currentTarget.value)}
                      placeholder="Minimum 16 characters"
                      class="input"
                      disabled={!isFullAccess()}
                    />
                  </div>
                  <div class="p-3 bg-sky-500/10 border border-sky-500/20 text-xs text-sky-400">
                    <p><strong>Username:</strong> CPE serial number</p>
                    <p><strong>Password:</strong> unique HMAC-SHA256 value derived for each CPE</p>
                  </div>
                </div>
              </Show>
            </div>
          </div>

          <div class="mt-6 pt-4 border-t border-subtle">
            <Show when={isFullAccess()}><button
              onClick={handleSave}
              disabled={saving()}
              class="btn btn-primary"
            >
              <Save size={14} />
              {saving() ? 'Saving settings\u2026' : 'Save connection settings'}
            </button></Show>
          </div>
        </Show>
      </div>

      <div class="card p-5">
        <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
          <Info size={14} />
          CPE Configuration Guide
        </h2>
        <div class="text-muted text-xs space-y-2">
          <p>To connect a CPE to ACS:</p>
          <ol class="list-decimal list-inside space-y-1 ml-2">
            <li>Sign in to the CPE management interface.</li>
            <li>Open its TR-069 or CWMP settings.</li>
            <li>Set the ACS URL to the published CWMP endpoint, for example <code class="bg-elevated px-2 py-0.5 rounded text-sky-400">https://cwmp.example.com/</code>.</li>
            <li>Configure <code>CWMP_USERNAME</code> and <code>CWMP_PASSWORD</code> when endpoint authentication is enabled.</li>
            <li>Save the configuration and verify that an Inform reaches ACS.</li>
          </ol>
        </div>
      </div>
    </div>
  );
};

export default Delivery;
