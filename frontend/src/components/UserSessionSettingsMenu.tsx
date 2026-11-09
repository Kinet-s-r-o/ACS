import { createEffect, createResource, createSignal, onCleanup, Show, type Component } from 'solid-js';
import { Clock, MoreVertical } from 'lucide-solid';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Dialog from './Dialog';
import { useFeedback } from './Feedback';
import { ResourceError } from './ResourceState';

const UserSessionSettingsMenu: Component = () => {
  const { can } = useAuth();
  const { notify } = useFeedback();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [localMinutes, setLocalMinutes] = createSignal('1440');
  const [externalMinutes, setExternalMinutes] = createSignal('60');
  const [settings, { refetch }] = createResource(() => dialogOpen() && can('settings.users', 'read'), () => api.getUserSessionSettings());
  let menuRoot: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let item: HTMLButtonElement | undefined;
  const canWrite = () => can('settings.users', 'write');
  const closeMenu = (restoreFocus = false) => { setMenuOpen(false); if (restoreFocus) trigger?.focus(); };

  createEffect(() => {
    if (settings.loading || settings.error) return;
    const value = settings();
    if (!value) return;
    setLocalMinutes(String(value.local_minutes));
    setExternalMinutes(String(value.external_minutes));
  });

  createEffect(() => {
    if (!menuOpen()) return;
    queueMicrotask(() => { if (menuOpen()) item?.focus(); });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRoot?.contains(event.target)) closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    });
  });

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canWrite() || saving() || settings.loading || settings.error || !settings()) return;
    const local = Number(localMinutes());
    const external = Number(externalMinutes());
    if (![local, external].every(value => Number.isInteger(value) && value >= 5 && value <= 43200)) {
      notify({ tone: 'error', title: 'Invalid session duration', message: 'Enter whole minutes between 5 and 43200.' });
      return;
    }
    setSaving(true);
    try {
      await api.updateUserSessionSettings({ local_minutes: local, external_minutes: external });
      notify({ tone: 'success', title: 'Session settings saved', message: 'The new durations apply to future sign-ins. Existing sessions keep their current expiration.' });
      setDialogOpen(false);
    } catch (error) {
      notify({ tone: 'error', title: 'Session settings were not saved', message: 'Your entered values are preserved. Retry saving.', detail: (error as Error).message, persistent: true });
    } finally { setSaving(false); }
  };

  return <>
    <div class="relative" ref={menuRoot}>
      <button type="button" class="icon-button" ref={trigger} aria-label="Users actions" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen(value => !value)}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true); } }}>
        <MoreVertical size={18} />
      </button>
      <Show when={menuOpen()}>
        <div class="absolute right-0 top-full z-50 mt-2 min-w-48 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu" aria-label="Users actions"
          onKeyDown={event => { if (event.key === 'Tab') closeMenu(true); else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); item?.focus(); } }}>
          <button type="button" role="menuitem" ref={item} class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-primary hover:bg-base"
            onClick={() => { closeMenu(true); setDialogOpen(true); }}><Clock size={14} />Session settings</button>
        </div>
      </Show>
    </div>
    <Show when={dialogOpen()}>
      <Dialog title="Session settings" description="Set how long operator sign-ins remain valid." size="small" onClose={() => { if (!saving()) setDialogOpen(false); }}>
        <Show when={settings.error}><ResourceError title="Session settings are unavailable" description="Retry loading before changing session durations." onRetry={() => void refetch()} /></Show>
        <Show when={settings.loading}><p class="text-xs text-muted" role="status">Loading session settings…</p></Show>
        <Show when={!settings.loading && !settings.error && settings()}>
          <form class="space-y-4" onSubmit={event => void save(event)}>
            <div>
              <label for="session-local-minutes" class="block text-xs text-muted mb-1.5">Local accounts (minutes)</label>
              <input id="session-local-minutes" type="number" min={5} max={43200} step={1} required class="input w-full" value={localMinutes()} onInput={event => setLocalMinutes(event.currentTarget.value)} disabled={!canWrite() || saving()} aria-describedby="session-duration-help" />
            </div>
            <div>
              <label for="session-external-minutes" class="block text-xs text-muted mb-1.5">External accounts, including RADIUS (minutes)</label>
              <input id="session-external-minutes" type="number" min={5} max={43200} step={1} required class="input w-full" value={externalMinutes()} onInput={event => setExternalMinutes(event.currentTarget.value)} disabled={!canWrite() || saving()} aria-describedby="session-duration-help" />
            </div>
            <p id="session-duration-help" class="text-xs text-muted">Use 5–43200 whole minutes (up to 30 days). Defaults: local 1440 minutes (24 hours), external 60 minutes.</p>
            <p class="text-xs text-muted">Changes apply at the next sign-in. Activity does not extend a session, and existing sessions keep their current expiration.</p>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" disabled={saving()} onClick={() => setDialogOpen(false)}>Close</button>
              <Show when={canWrite()}><button type="submit" class="btn btn-primary" disabled={saving()}>{saving() ? 'Saving…' : 'Save'}</button></Show>
            </div>
          </form>
        </Show>
      </Dialog>
    </Show>
  </>;
};

export default UserSessionSettingsMenu;
