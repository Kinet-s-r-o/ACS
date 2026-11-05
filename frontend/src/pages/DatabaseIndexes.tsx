import { createMemo, createResource, createSignal, Index, onCleanup, onMount, Show, type Component } from 'solid-js';
import { Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-solid';
import { formatDateTime } from '../lib/dateTime';
import { api, type DatabaseIndexPreview, type DatabaseIndexSpec, type ManagedDatabaseIndex } from '../lib/api';
import { useAuth } from '../lib/auth';
import Dialog from '../components/Dialog';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import Pagination from '../components/Pagination';

const formatBytes = (bytes: number) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`
  : `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
const pending = (index: ManagedDatabaseIndex) => ['queued', 'building', 'deleting'].includes(index.status) || index.cleanup_pending;
const emptySpec = (): DatabaseIndexSpec => ({ label: '', purpose: '', recipe: 'parameter_presence', parameter_path: '' });

const DatabaseIndexes: Component = () => {
  const { hasPermission, can } = useAuth();
  const { notify, confirm } = useFeedback();
  const canWrite = () => hasPermission('database.indexes.write');

  const [data, { refetch }] = createResource(api.getDatabaseIndexes);
  const [dialog, setDialog] = createSignal<{ id?: number } | null>(null);
  const [form, setForm] = createSignal<DatabaseIndexSpec>(emptySpec());
  const [preview, setPreview] = createSignal<DatabaseIndexPreview>();
  const [formError, setFormError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [actionID, setActionID] = createSignal<number | null>(null);
  const [catalogSearch, setCatalogSearch] = createSignal('');
  const [catalogPage, setCatalogPage] = createSignal(0);
  const [catalogPageSize, setCatalogPageSize] = createSignal(20);
  const catalog = createMemo(() => {
    const query = catalogSearch().trim().toLowerCase();
    return (data.latest?.catalog ?? []).filter(index => `${index.name} ${index.table_name} ${index.method}`.toLowerCase().includes(query));
  });
  const page = () => Math.min(catalogPage(), Math.max(0, Math.ceil(catalog().length / catalogPageSize()) - 1));
  const catalogRows = () => catalog().slice(page() * catalogPageSize(), (page() + 1) * catalogPageSize());
  const isManaged = (name: string) => data.latest?.managed.some(index => index.active_name === name && index.owned);
  const recipeLabel = (recipe: string) => data.latest?.recipes.find(item => item.id === recipe)?.label ?? recipe;
  onMount(() => {
    const timer = window.setInterval(() => { if (!document.hidden && !data.loading) void refetch(); }, 5000);
    onCleanup(() => window.clearInterval(timer));
  });

  const openEditor = (index?: ManagedDatabaseIndex) => {
    setForm(index ? { label: index.label, purpose: index.purpose, recipe: index.recipe, parameter_path: index.parameter_path } : emptySpec());
    setPreview(undefined); setFormError(''); setDialog(index ? { id: index.id } : {});
  };
  const change = <K extends keyof DatabaseIndexSpec>(key: K, value: DatabaseIndexSpec[K]) => {
    setForm(current => ({ ...current, [key]: value })); setPreview(undefined); setFormError('');
  };
  const inspect = async (event: SubmitEvent) => {
    event.preventDefault(); setBusy(true); setFormError('');
    try { setPreview(await api.previewDatabaseIndex(form(), dialog()?.id)); }
    catch (error) { setFormError((error as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview() || busy()) return;
    setBusy(true); setFormError('');
    try {
      const id = dialog()?.id;
      if (id) await api.updateDatabaseIndex(id, form()); else await api.createDatabaseIndex(form());
      setDialog(null);
      notify({ tone: 'success', title: id ? 'Index replacement queued' : 'Index creation queued', message: 'Follow the status in UI-managed indexes. The server rechecks storage limits during construction.' });
      await refetch();
    } catch (error) { setFormError((error as Error).message); setPreview(undefined); }
    finally { setBusy(false); }
  };
  const act = async (index: ManagedDatabaseIndex, action: 'delete' | 'cancel') => {
    if (action === 'delete' && !await confirm({ title: `Delete ${index.label}?`, description: 'This removes the UI definition and its index from PostgreSQL. Parameter data is preserved. Queries that used this index may become slower.', confirmLabel: 'Delete index', tone: 'danger' })) return;
    setActionID(index.id);
    try {
      if (action === 'delete') await api.deleteDatabaseIndex(index.id); else await api.cancelDatabaseIndex(index.id);
      notify({ tone: 'info', title: action === 'delete' ? 'Index deletion queued' : 'Cancellation requested', message: action === 'delete' ? 'The row disappears after PostgreSQL confirms the index has been removed.' : 'The unfinished index will be removed; an existing index is retained during a cancelled replacement.' });
      await refetch();
    } catch (error) { notify({ tone: 'error', title: 'Index operation failed', message: (error as Error).message }); }
    finally { setActionID(null); }
  };

  return <section class="space-y-5" aria-label="DB indexes" aria-busy={data.loading}>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div><h2 class="text-sm font-medium text-primary">DB indexes</h2><p class="text-xs text-muted mt-1">Create small indexes for specific parameter queries and inspect PostgreSQL storage. Status refreshes every five seconds.</p></div>
      <div class="flex items-center gap-2">
        <button type="button" class="icon-button" aria-label="Refresh DB indexes" disabled={data.loading} onClick={() => void refetch()}><RefreshCw size={16} /></button>
        <Show when={canWrite()}><button type="button" class="btn btn-primary" disabled={!data.latest?.budget.can_create || !!data.error} onClick={() => openEditor()}><Plus size={15} aria-hidden="true" />Create index</button></Show>
      </div>
    </div>
    <Show when={data.error}><ResourceError title="DB indexes are unavailable" description="Retry loading PostgreSQL index ownership and storage information." onRetry={() => void refetch()} /></Show>
    <Show when={data.latest} fallback={!data.error ? <div class="skeleton h-32 w-full" /> : undefined}>{current => <>
      <section class="card p-4 space-y-3" aria-label="Index storage policy">
        <dl class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 text-xs">
          <div><dt class="text-muted">UI index storage</dt><dd class="font-mono text-primary mt-1">{formatBytes(current().budget.managed_bytes)} / {formatBytes(current().budget.max_total_bytes)}</dd></div>
          <div><dt class="text-muted">Limit per index</dt><dd class="font-mono text-primary mt-1">{formatBytes(current().budget.max_index_bytes)} · {current().managed.length}/{current().budget.max_count} definitions</dd></div>
          <div><dt class="text-muted">PostgreSQL disk available</dt><dd class="font-mono text-primary mt-1">{current().budget.probe_fresh ? formatBytes(current().budget.free_bytes) : 'Measurement unavailable'}</dd></div>
          <div><dt class="text-muted">Protected disk reserve</dt><dd class="font-mono text-primary mt-1">{formatBytes(current().budget.reserve_bytes)} minimum</dd></div>
        </dl>
        <p class="text-xs text-muted">Only approved B-tree indexes for one exact, non-sensitive parameter path are allowed. GIN, wildcards, raw SQL and included values are prohibited. Existing database indexes are protected.</p>
        <p class="text-xs text-muted">UI indexes exceeding a size limit or the disk reserve are automatically removed. PostgreSQL checks run every two seconds; limits are monitored budgets, not filesystem quotas. Index use depends on matching query predicates and the query planner.</p>
        <Show when={current().budget.reserved_bytes > 0}><p class="text-xs text-secondary">Queued construction reserve: {formatBytes(current().budget.reserved_bytes)}.</p></Show>
        <Show when={!current().budget.can_create}><p class="text-xs text-warning" role="status">{current().budget.reason}</p></Show>
        <Show when={current().budget.probe_fresh}><p class="text-xs text-muted">Disk measured: {formatDateTime(current().budget.measured_at)}.</p></Show>
      </section>

      <section class="card p-4 space-y-3" aria-label="UI-managed indexes">
        <h3 class="text-sm font-medium text-secondary">UI-managed indexes</h3>
        <Show when={current().managed.length > 0} fallback={<EmptyState title="No UI-managed indexes" description="Create an index for a specific query after reviewing its estimate. Existing PostgreSQL indexes remain protected." />}>
          <div class="overflow-x-auto"><table class="data-table w-full text-xs" data-column-order-key="database-managed-indexes">
            <thead><tr><th data-column-order-id="label">Name and purpose</th><th data-column-order-id="path">Parameter and recipe</th><th data-column-order-id="status">Status</th><th data-column-order-id="size">Size / scans</th><th data-column-fixed="actions" data-column-order-id="actions">Actions</th><th data-column-fixed="visibility" data-column-order-id="__visibility#0" class="px-2 py-2" aria-label="Column visibility"></th></tr></thead>
            <tbody><Index each={current().managed}>{index => <tr class="align-top border-t border-subtle">
              <td data-column-order-id="label"><span class="font-medium text-primary">{index().label}</span><p class="text-muted mt-1 max-w-xs break-words">{index().purpose}</p></td>
              <td data-column-order-id="path"><span class="font-mono break-all">{index().parameter_path}</span><p class="text-muted mt-1">{recipeLabel(index().recipe)}</p></td>
              <td data-column-order-id="status"><span class={index().status === 'ready' && index().valid && index().owned ? 'text-success' : 'text-secondary'}>{index().cancel_requested ? 'Cancellation requested' : index().status === 'ready' && (!index().valid || !index().owned) ? 'Needs attention' : index().status}</span><p class="text-muted mt-1 max-w-sm break-words">{index().message}</p>
                <Show when={index().phase}><p class="text-muted mt-1">{index().phase}{index().blocks_total > 0 ? ` · ${index().blocks_done.toLocaleString()} / ${index().blocks_total.toLocaleString()} blocks` : ''}</p></Show>
                <Show when={index().active_name && ['queued', 'building', 'failed'].includes(index().status)}><p class="text-muted mt-1">Previous index retained; its current definition is in the catalog.</p></Show>
                <Show when={!index().owned}><p class="text-warning mt-1">Ownership verification failed. Changes are blocked.</p></Show>
              </td>
              <td data-column-order-id="size" class="font-mono whitespace-nowrap">{formatBytes(index().size_bytes)}<p class="text-muted mt-1">{index().scans.toLocaleString()} scans</p></td>
              <td data-column-order-id="actions"><Show when={canWrite() || can('settings.database.indexes', 'delete')} fallback={<span class="text-muted">Read only</span>}><div class="flex gap-1">
                <Show when={!pending(index()) && index().owned}>
                  <button type="button" class="icon-button" aria-label={`Edit ${index().label}`} disabled={!canWrite() || actionID() !== null || !!data.error} onClick={() => openEditor(index())}><Pencil size={15} /></button>
                  <button type="button" class="icon-button text-error" aria-label={`Delete ${index().label}`} disabled={!can('settings.database.indexes', 'delete') || actionID() !== null || !!data.error} onClick={() => void act(index(), 'delete')}><Trash2 size={15} /></button>
                </Show>
                <Show when={['queued', 'building'].includes(index().status)}><button type="button" class="icon-button" aria-label={`Cancel build of ${index().label}`} disabled={!canWrite() || index().cancel_requested || actionID() !== null || !!data.error} onClick={() => void act(index(), 'cancel')}><X size={15} /></button></Show>
              </div></Show></td>
            <td data-column-fixed="visibility" data-column-order-id="__visibility#0" class="px-2 py-2"></td></tr>}</Index></tbody>
          </table></div>
        </Show>
      </section>

      <section class="card p-4 space-y-3" aria-label="PostgreSQL index catalog">
        <div class="flex flex-wrap items-end justify-between gap-3"><div><h3 class="text-sm font-medium text-secondary">PostgreSQL index catalog</h3><p class="text-xs text-muted mt-1">Current application schema, largest first. Scan counts are cumulative since statistics were reset.</p></div>
          <div><label for="db-index-search" class="text-xs text-muted block mb-1">Filter index catalog</label><input id="db-index-search" type="search" class="input w-full" value={catalogSearch()} onInput={event => { setCatalogSearch(event.currentTarget.value); setCatalogPage(0); }} /></div>
        </div>
        <Show when={catalog().length} fallback={<p class="text-sm text-muted">No indexes match this filter.</p>}>
          <div class="overflow-x-auto"><table class="data-table w-full text-xs" data-column-order-key="database-index-catalog">
            <thead><tr><th data-column-order-id="name">Index / table</th><th data-column-order-id="method">Method</th><th data-column-order-id="size">Size</th><th data-column-order-id="scans">Scans</th><th data-column-order-id="ownership">Protection</th></tr></thead>
            <tbody><Index each={catalogRows()}>{index => <tr class="align-top border-t border-subtle">
              <td data-column-order-id="name"><span class="font-mono break-all">{index().name}</span><p class="text-muted mt-1">{index().schema}.{index().table_name}</p><details class="mt-1"><summary class="cursor-pointer text-muted">Definition</summary><pre class="text-xs whitespace-pre-wrap break-all mt-2">{index().definition}</pre></details></td>
              <td data-column-order-id="method">{index().method}<Show when={!index().valid}><p class="text-warning mt-1">Invalid</p></Show></td>
              <td data-column-order-id="size" class="font-mono whitespace-nowrap">{formatBytes(index().size_bytes)}</td>
              <td data-column-order-id="scans" class="font-mono">{index().scans.toLocaleString()}</td>
              <td data-column-order-id="ownership">{isManaged(index().name) ? 'UI managed' : index().primary ? 'Protected primary key' : index().unique || index().constraint ? 'Protected constraint' : 'Protected existing index'}</td>
            </tr>}</Index></tbody>
          </table></div>
          <Pagination page={page()} pageSize={catalogPageSize()} totalItems={catalog().length} totalPages={Math.ceil(catalog().length / catalogPageSize())} storageKey="database-index-catalog" onPageChange={setCatalogPage} onPageSizeChange={size => { setCatalogPageSize(size); setCatalogPage(0); }} />
        </Show>
      </section>
    </>}</Show>

    <Show when={dialog()}>{editing => <Dialog title={editing().id ? 'Edit UI index' : 'Create DB index'} description="The server permits only approved B-tree recipes and rechecks storage before executing PostgreSQL DDL." onClose={() => { if (!busy()) setDialog(null); }} size="medium" actions={<>
      <button type="button" class="btn btn-secondary" disabled={busy()} onClick={() => setDialog(null)}>Cancel</button>
      <Show when={preview()} fallback={<button type="submit" form="db-index-form" class="btn btn-primary" disabled={busy()}>{busy() ? 'Checking…' : 'Review estimate'}</button>}><button type="button" class="btn btn-primary" disabled={busy()} onClick={() => void save()}>{busy() ? 'Queuing…' : editing().id ? 'Queue replacement' : 'Queue creation'}</button></Show>
    </>}>
      <form id="db-index-form" class="space-y-4" onSubmit={inspect}>
        <div><label for="db-index-label" class="block text-xs text-muted mb-1">Name</label><input id="db-index-label" class="input w-full" required minlength={3} maxlength={80} autofocus value={form().label} disabled={busy()} onInput={event => change('label', event.currentTarget.value)} /></div>
        <div><label for="db-index-purpose" class="block text-xs text-muted mb-1">Query or purpose</label><textarea id="db-index-purpose" class="input w-full" required minlength={8} maxlength={256} rows={2} value={form().purpose} disabled={busy()} onInput={event => change('purpose', event.currentTarget.value)} /></div>
        <div><label for="db-index-recipe" class="block text-xs text-muted mb-1">Approved recipe</label><select id="db-index-recipe" class="input w-full" value={form().recipe} disabled={busy()} onChange={event => change('recipe', event.currentTarget.value as DatabaseIndexSpec['recipe'])}><Index each={data.latest?.recipes}>{recipe => <option value={recipe().id}>{recipe().label}</option>}</Index></select><p class="text-xs text-muted mt-1">{data.latest?.recipes.find(recipe => recipe.id === form().recipe)?.description}</p></div>
        <div><label for="db-index-path" class="block text-xs text-muted mb-1">Exact parameter path</label><input id="db-index-path" class="input w-full font-mono" required maxlength={256} value={form().parameter_path} disabled={busy()} aria-describedby="db-index-path-help" placeholder="InternetGatewayDevice.DeviceInfo.UpTime" onInput={event => change('parameter_path', event.currentTarget.value)} /><p id="db-index-path-help" class="text-xs text-muted mt-1">Use a complete leaf path beginning with InternetGatewayDevice. or Device. Instance numbers must be explicit. Passwords, credentials, wildcards and object branches are rejected.</p></div>
        <Show when={editing().id}><p class="text-xs text-muted">Editing builds a replacement first and removes the previous UI index only after the replacement is verified. Extra construction space is required.</p></Show>
        <Show when={preview()}>{estimate => <div class="border border-subtle p-3 text-xs space-y-2" role="status"><p class="text-primary">Conservative estimate: {formatBytes(estimate().estimated_bytes)} for {estimate().estimated_rows.toLocaleString()} rows.</p><p class="text-muted">Current query plan: {estimate().plan}. This estimate does not guarantee index usage or final size. Construction and future growth are monitored.</p></div>}</Show>
        <Show when={formError()}><p class="text-xs text-error" role="alert">{formError()}</p></Show>
      </form>
    </Dialog>}</Show>
  </section>;
};

export default DatabaseIndexes;
