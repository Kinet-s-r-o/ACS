import type { Component } from 'solid-js';
import { createEffect, createResource, createSignal, Index, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { ChevronLeft } from 'lucide-solid';
import { api, type RadiusConfig, type RadiusServer } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { ResourceError } from '../components/ResourceState';
import { useFeedback } from '../components/Feedback';

const RadiusAuthenticationSettings: Component = () => {
  const { hasPermission, isFullAccess } = useAuth();
  const { notify } = useFeedback();
  const canRead = () => hasPermission('auth.settings.read');
  const canWrite = () => canRead() && hasPermission('auth.settings.write') && isFullAccess();
  const [settings, { refetch }] = createResource(canRead, () => api.getRadiusSettings());
  const [config, setConfig] = createSignal<RadiusConfig>({ enabled: false, nas_identifier: 'ACS', servers: [] });
  const [pending, setPending] = createSignal(false);
  const [testUsername, setTestUsername] = createSignal('');
  const [testPassword, setTestPassword] = createSignal('');
  createEffect(() => { const value = settings(); if (value) setConfig(value); });

  const updateServer = (index: number, patch: Partial<RadiusServer>) => setConfig(value => ({ ...value, servers: value.servers.map((server, position) => position === index ? { ...server, ...patch } : server) }));
  const addServer = () => setConfig(value => ({ ...value, servers: [...value.servers, { id: crypto.randomUUID(), address: '', transport: 'tls', timeout_seconds: 2, attempts: 1 }] }));
  const moveServer = (index: number, direction: number) => setConfig(value => {
    const servers = [...value.servers];
    [servers[index], servers[index + direction]] = [servers[index + direction], servers[index]];
    return { ...value, servers };
  });
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canWrite() || pending()) return;
    setPending(true);
    try {
      setConfig(await api.saveRadiusSettings(config()));
      notify({ tone: 'success', title: 'Authentication settings saved', message: 'The configuration applies to subsequent credential checks.' });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save authentication settings', message: 'Review the configuration and try again. Entered values are preserved.', detail: (error as Error).message, persistent: true });
    } finally { setPending(false); }
  };
  const test = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canWrite() || pending()) return;
    setPending(true);
    try {
      const result = await api.testRadius(testUsername(), testPassword());
      notify({ tone: 'success', title: 'RADIUS test passed', message: result.status });
    } catch (error) {
      notify({ tone: 'error', title: 'RADIUS test failed', message: 'Check the saved configuration and RADIUS server policy.', detail: (error as Error).message, persistent: true });
    } finally { setPending(false); setTestPassword(''); }
  };

  return (
    <div class="space-y-5">
      <A href="/settings/authentication" class="btn btn-secondary w-fit" aria-label="Back to authentication methods"><ChevronLeft size={16} aria-hidden="true" />Authentication methods</A>
      <PageHeader title="RADIUS" description="Configure RADIUS servers, transport security, and authentication tests. Roles and account access remain managed in ACS." />
      <Show when={canRead()} fallback={<p class="text-muted">You need authentication settings read permission to view this page.</p>}>
        <Show when={settings.error}><ResourceError title="Authentication settings unavailable" description="Try loading the configuration again." onRetry={() => void refetch()} /></Show>
        <Show when={settings.loading}><p class="text-muted" role="status">Loading authentication settings…</p></Show>
        <Show when={settings() && !settings.error}>
          <form class="card p-5 space-y-4" onSubmit={save}>
            <h2 class="text-base font-semibold text-primary">RADIUS module</h2>
            <p class="text-sm text-muted">Assign this module to individual accounts under Users and Roles. Keep a local administrator for recovery. ACS TOTP can provide the second factor; RADIUS challenge flows are not supported.</p>
            <fieldset disabled={!canWrite() || pending()} class="space-y-4">
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={config().enabled} onChange={event => setConfig(value => ({ ...value, enabled: event.currentTarget.checked }))} />Enable RADIUS authentication</label>
              <div>
                <label for="radius-nas" class="block text-xs text-muted mb-1.5">NAS identifier</label>
                <input id="radius-nas" class="input w-full" maxlength={253} value={config().nas_identifier} onInput={event => setConfig(value => ({ ...value, nas_identifier: event.currentTarget.value }))} />
              </div>
              <p class="text-sm text-muted">Servers are tried in order after network failures. A rejection or invalid reply ends the attempt. UDP normally uses port 1812; TLS (RadSec) uses port 2083.</p>
              <Index each={config().servers}>{(server, index) => (
                <div class="border border-subtle p-4 space-y-3">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <h3 class="text-sm font-semibold">Server {index + 1}</h3>
                    <div class="flex flex-wrap gap-2">
                      <button type="button" class="btn btn-secondary text-xs" disabled={index === 0} aria-label={`Move server ${index + 1} up`} onClick={() => moveServer(index, -1)}>Move up</button>
                      <button type="button" class="btn btn-secondary text-xs" disabled={index === config().servers.length - 1} aria-label={`Move server ${index + 1} down`} onClick={() => moveServer(index, 1)}>Move down</button>
                      <button type="button" class="btn btn-secondary text-xs" aria-label={`Remove server ${index + 1}`} onClick={() => setConfig(value => ({ ...value, servers: value.servers.filter((_, position) => position !== index) }))}>Remove</button>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div><label for={`radius-address-${index}`} class="block text-xs text-muted mb-1.5">Server address and port</label><input id={`radius-address-${index}`} class="input w-full" required placeholder="radius.example.net:2083" value={server().address} onInput={event => updateServer(index, { address: event.currentTarget.value })} /></div>
                    <div><label for={`radius-transport-${index}`} class="block text-xs text-muted mb-1.5">Transport</label><select id={`radius-transport-${index}`} class="input w-full" value={server().transport} onChange={event => updateServer(index, { transport: event.currentTarget.value as 'udp' | 'tls' })}><option value="tls">TLS (RadSec)</option><option value="udp">UDP</option></select></div>
                    <div><label for={`radius-timeout-${index}`} class="block text-xs text-muted mb-1.5">Timeout per attempt (seconds)</label><input id={`radius-timeout-${index}`} class="input w-full" type="number" min={1} max={10} required value={server().timeout_seconds} onInput={event => updateServer(index, { timeout_seconds: Number(event.currentTarget.value) })} /></div>
                    <div><label for={`radius-attempts-${index}`} class="block text-xs text-muted mb-1.5">Attempts per server</label><input id={`radius-attempts-${index}`} class="input w-full" type="number" min={1} max={2} required value={server().attempts} onInput={event => updateServer(index, { attempts: Number(event.currentTarget.value) })} /></div>
                  </div>
                  <Show when={server().transport === 'udp'}>
                    <div><label for={`radius-secret-${index}`} class="block text-xs text-muted mb-1.5">Shared secret</label><input id={`radius-secret-${index}`} class="input w-full" type="password" autocomplete="new-password" minlength={16} maxlength={253} required={!server().secret_set} placeholder={server().secret_set ? 'Stored securely; leave blank to keep' : 'At least 16 characters'} value={server().secret || ''} onInput={event => updateServer(index, { secret: event.currentTarget.value })} /></div>
                    <p class="text-xs text-muted">Use a protected network path. Message-Authenticator is required in requests and responses.</p>
                  </Show>
                  <Show when={server().transport === 'tls'}>
                    <div><label for={`radius-name-${index}`} class="block text-xs text-muted mb-1.5">TLS certificate server name (optional override)</label><input id={`radius-name-${index}`} class="input w-full" value={server().server_name || ''} onInput={event => updateServer(index, { server_name: event.currentTarget.value })} /></div>
                    <div><label for={`radius-ca-${index}`} class="block text-xs text-muted mb-1.5">Trusted CA certificates (PEM; blank uses system trust)</label><textarea id={`radius-ca-${index}`} class="input w-full font-mono" rows={3} value={server().ca_pem || ''} onInput={event => updateServer(index, { ca_pem: event.currentTarget.value })} /></div>
                    <div><label for={`radius-cert-${index}`} class="block text-xs text-muted mb-1.5">Client certificate chain (PEM; for mutual TLS)</label><textarea id={`radius-cert-${index}`} class="input w-full font-mono" rows={3} value={server().client_cert_pem || ''} onInput={event => updateServer(index, { client_cert_pem: event.currentTarget.value })} /></div>
                    <div><label for={`radius-key-${index}`} class="block text-xs text-muted mb-1.5">Client private key (PEM)</label><textarea id={`radius-key-${index}`} class="input w-full font-mono" rows={3} autocomplete="off" spellcheck={false} placeholder={server().client_key_set ? 'Stored securely; leave blank to keep' : 'Optional client private key'} value={server().client_key_pem || ''} onInput={event => updateServer(index, { client_key_pem: event.currentTarget.value })} /></div>
                    <Show when={server().client_key_set}><label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={server().client_key_set} onChange={event => updateServer(index, { client_key_set: event.currentTarget.checked })} />Keep the stored client key when left blank</label></Show>
                    <p class="text-xs text-muted">Server certificates and names are always verified. RadSec uses the protocol secret “radsec”.</p>
                  </Show>
                </div>
              )}</Index>
              <button type="button" class="btn btn-secondary" disabled={config().servers.length >= 8} onClick={addServer}>Add server</button>
            </fieldset>
            <Show when={canWrite()}><button type="submit" class="btn btn-primary" disabled={pending()}>{pending() ? 'Working…' : 'Save authentication settings'}</button></Show>
          </form>
          <Show when={canWrite()}>
            <form class="card p-5 space-y-4" onSubmit={test}>
              <h2 class="text-base font-semibold text-primary">Test saved RADIUS configuration</h2>
              <p class="text-sm text-muted">Save and enable the module before testing. This checks credentials without signing in or creating an ACS account.</p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label for="radius-test-username" class="block text-xs text-muted mb-1.5">RADIUS username</label><input id="radius-test-username" class="input w-full" required autocomplete="off" value={testUsername()} onInput={event => setTestUsername(event.currentTarget.value)} /></div>
                <div><label for="radius-test-password" class="block text-xs text-muted mb-1.5">RADIUS password</label><input id="radius-test-password" type="password" class="input w-full" required autocomplete="off" value={testPassword()} onInput={event => setTestPassword(event.currentTarget.value)} /></div>
              </div>
              <button type="submit" class="btn btn-secondary" disabled={pending()}>Test authentication</button>
            </form>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default RadiusAuthenticationSettings;
