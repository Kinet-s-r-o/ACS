import type { Component } from 'solid-js';
import { createSignal } from 'solid-js';
import { Download, Upload } from 'lucide-solid';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeedback } from './Feedback';

const AccountTransferActions: Component<{
  kind: 'users' | 'roles';
  ids: number[];
  loading: boolean;
  onImported: () => unknown | Promise<unknown>;
}> = props => {
  const { can } = useAuth();
  const { confirm, notify } = useFeedback();
  const [busy, setBusy] = createSignal(false);
  const section = () => `settings.users.${props.kind}`;
  let input: HTMLInputElement | undefined;

  const exportAccounts = async () => {
    if (busy() || props.loading || !props.ids.length || !can(section(), 'export')) return;
    setBusy(true);
    try {
      const blob = await api.exportAccounts(props.kind, props.ids);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `acs-${props.kind}.json`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
    } catch (error) {
      notify({ tone: 'error', title: `Could not export ${props.kind}`, detail: (error as Error).message, persistent: true });
    } finally { setBusy(false); }
  };

  const importAccounts = async (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    target.value = '';
    if (!file || busy() || !can(section(), 'import')) return;
    setBusy(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Select a JSON file up to 5 MB.');
      const backup: unknown = JSON.parse(await file.text());
      if (!backup || typeof backup !== 'object') throw new Error('Select an ACS JSON export.');
      const data = backup as Record<string, unknown>;
      const rows = data[props.kind];
      if (data.format !== `acs-${props.kind}` || data.version !== 1 || !Array.isArray(rows) || !rows.length || rows.length > 10000) {
        throw new Error(`Select an ACS ${props.kind} JSON export (version 1, 1–10000 records).`);
      }
      const details = props.kind === 'users'
        ? 'New accounts will be inactive. Set a password for local accounts before activating them. Roles are matched by name; import missing roles first. Passwords, authenticator pairings and API tokens are not transferred.'
        : 'New custom roles will be added with their permissions. Built-in roles remain unchanged.';
      if (!await confirm({ title: `Import ${props.kind}?`, description: `The file contains ${rows.length} ${props.kind}. Existing names will be skipped. ${details}`, confirmLabel: `Import ${props.kind}`, tone: 'primary' })) return;
      const result = await api.importAccounts(props.kind, backup);
      notify({ tone: 'success', title: `${props.kind === 'users' ? 'Users' : 'Roles'} imported`, message: `${result.created} created · ${result.skipped} skipped` });
      try { await props.onImported(); } catch {
        notify({ tone: 'error', title: 'Import completed, but the list could not be refreshed', message: 'Reload the list to see the imported records.', persistent: true });
      }
    } catch (error) {
      notify({ tone: 'error', title: `Could not import ${props.kind}`, detail: (error as Error).message, persistent: true });
    } finally { setBusy(false); }
  };

  return <>
    <input ref={input} type="file" accept="application/json,.json" class="sr-only" tabIndex={-1} aria-label={`Select ${props.kind} JSON file`} onChange={event => void importAccounts(event)} disabled={busy() || !can(section(), 'import')} />
    <button type="button" class="icon-button" title={`Import ${props.kind} from JSON`} aria-label={`Import ${props.kind} from JSON`} aria-busy={busy()} disabled={busy() || !can(section(), 'import')} onClick={() => input?.click()}><Upload size={15} aria-hidden="true" /></button>
    <button type="button" class="icon-button" title={`Export filtered ${props.kind} as JSON`} aria-label={`Export filtered ${props.kind} as JSON`} aria-busy={busy()} disabled={busy() || props.loading || !props.ids.length || !can(section(), 'export')} onClick={() => void exportAccounts()}><Download size={15} aria-hidden="true" /></button>
  </>;
};

export default AccountTransferActions;
