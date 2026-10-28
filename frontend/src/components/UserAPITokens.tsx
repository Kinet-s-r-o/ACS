import { createResource, createSignal, For, Show, type Component } from 'solid-js';
import { A } from '@solidjs/router';
import { Copy, KeyRound, Trash2 } from 'lucide-solid';
import { api, type APIToken, type User } from '../lib/api';
import { formatDateTime } from '../lib/dateTime';
import { useAuth } from '../lib/auth';
import Dialog from './Dialog';
import { useFeedback } from './Feedback';
import { EmptyState, ResourceError } from './ResourceState';

const UserAPITokens: Component<{ user: User; onClose: () => void }> = (props) => {
  const { hasAnyPermission } = useAuth();
  const { notify, confirm } = useFeedback();
  const [tokens, { refetch }] = createResource(() => props.user.id, api.getAPITokens);
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [days, setDays] = createSignal(90);
  const [secret, setSecret] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const createToken = async () => {
    if (pending()) return;
    setPending(true);
    try {
      const result = await api.createAPIToken(props.user.id, { name: name(), description: description(), expires_in_days: days() });
      setSecret(result.token);
      setCopied(false);
      setName('');
      setDescription('');
      void refetch();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not generate API token', message: 'Check the token list before retrying if the connection was interrupted. Revoke any token whose secret was not received.', detail: (error as Error).message, persistent: true });
      void refetch();
    } finally { setPending(false); }
  };

  const revoke = async (token: APIToken) => {
    if (pending() || !await confirm({ title: 'Revoke API token?', description: `${token.name} will lose API access. Already queued CWMP tasks will continue.`, confirmLabel: 'Revoke token', tone: 'danger' })) return;
    setPending(true);
    try {
      await api.revokeAPIToken(props.user.id, token.id);
      notify({ tone: 'success', title: 'API token revoked', message: token.name });
      void refetch();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not revoke API token', message: 'The token may still be active. Retry the request.', detail: (error as Error).message, persistent: true });
    } finally { setPending(false); }
  };

  const copySecret = async () => {
    try { await navigator.clipboard.writeText(secret()); setCopied(true); }
    catch { notify({ tone: 'error', title: 'Could not copy token', message: 'Select the token and copy it manually.' }); }
  };

  return (
    <Dialog title={`API tokens — ${props.user.username}`} description="Create a separate token for each external system. Tokens inherit this user's current permissions. They authenticate services without an interactive 2FA prompt." size="large" closeOnBackdrop={false} onClose={() => { if (!pending()) { setSecret(''); props.onClose(); } }}>
      <div class="space-y-5">
        <A href="/settings/api-docs" class="text-sky-400 text-sm" onClick={props.onClose}>Open Swagger API documentation</A>
        <Show when={secret()} fallback={hasAnyPermission('users.tokens', 'users.write') && (
          <form class="space-y-3" onSubmit={(event) => { event.preventDefault(); void createToken(); }}>
            <div><label for="api-token-name" class="block text-xs text-muted mb-1.5">External system name</label><input id="api-token-name" class="input w-full" required maxLength={128} value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Billing production" disabled={pending()} /></div>
            <div><label for="api-token-description" class="block text-xs text-muted mb-1.5">Description (optional)</label><input id="api-token-description" class="input w-full" maxLength={512} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} disabled={pending()} /></div>
            <div><label for="api-token-days" class="block text-xs text-muted mb-1.5">Expires in days (1–365)</label><input id="api-token-days" type="number" class="input w-full" required min={1} max={365} step={1} value={days()} onInput={(e) => setDays(e.currentTarget.valueAsNumber)} disabled={pending()} /></div>
            <button type="submit" class="btn btn-primary" disabled={pending()}><KeyRound size={14} />{pending() ? 'Generating…' : 'Generate token'}</button>
          </form>
        )}>
          <div class="card p-4 space-y-3" role="status">
            <p class="text-sm text-primary">Copy this token now. It will not be shown again. Store it in the external system's secret manager.</p>
            <label for="api-token-secret" class="block text-xs text-muted">New API token</label>
            <input id="api-token-secret" class="input w-full font-mono" value={secret()} readOnly autocomplete="off" spellcheck={false} onFocus={(e) => e.currentTarget.select()} />
            <div class="flex gap-2"><button type="button" class="btn btn-secondary" onClick={() => void copySecret()}><Copy size={14} />{copied() ? 'Copied' : 'Copy token'}</button><button type="button" class="btn btn-secondary" onClick={() => setSecret('')}>I have saved the token</button></div>
          </div>
        </Show>
        <Show when={tokens.loading}><p class="text-sm text-muted" role="status">Loading API tokens…</p></Show>
        <Show when={tokens.error}><ResourceError title="Could not load API tokens" description="Retry to check active and revoked tokens." onRetry={() => void refetch()} /></Show>
        <Show when={!tokens.loading && !tokens.error && tokens()?.length === 0}><EmptyState compact title="No API tokens" description="Generate a token for the billing system or another integration." /></Show>
        <ul class="space-y-2" aria-label="API tokens">
          <For each={tokens()}>{(token) => (
            <li class="border border-subtle p-3 flex items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <p class="text-sm text-primary font-medium break-words">{token.name} <span class="text-muted font-normal">· {token.revoked_at ? 'Revoked' : new Date(token.expires_at) <= new Date() ? 'Expired' : 'Active'}</span></p>
                <Show when={token.description}><p class="text-xs text-muted break-words">{token.description}</p></Show>
                <p class="text-xs text-muted"><span class="font-mono">{token.prefix}…</span> · Expires {formatDateTime(token.expires_at)}</p>
                <p class="text-xs text-muted">Created {formatDateTime(token.created_at)} · Last used {token.last_used_at ? formatDateTime(token.last_used_at) : 'Never'}</p>
              </div>
              <Show when={!token.revoked_at && hasAnyPermission('users.tokens', 'users.write')}><button type="button" class="icon-button shrink-0" title="Revoke token" aria-label={`Revoke token for ${token.name}`} disabled={pending()} onClick={() => void revoke(token)}><Trash2 size={14} /></button></Show>
            </li>
          )}</For>
        </ul>
      </div>
    </Dialog>
  );
};

export default UserAPITokens;
