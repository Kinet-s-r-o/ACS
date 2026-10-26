import type { Component } from 'solid-js';
import { createEffect, createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { Edit, Plus, Save, Search, Tags, Trash2, X } from 'lucide-solid';
import { api, type TagDefinition } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/Feedback';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColorSwatch from '../components/ColorSwatch';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import SortableHeader from '../components/SortableHeader';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { sortRows, type SortDirection } from '../lib/sorting';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import Pagination from '../components/Pagination';
import { usePageSize } from '../lib/usePageSize';

const Dictionaries: Component = () => {
  const { hasPermission } = useAuth();
  const canManageTags = () => hasPermission('settings.write');
  const { notify, confirm } = useFeedback();
  const [tags, { refetch }] = createResource(api.getTags);
  const [editing, setEditing] = createSignal<TagDefinition | null>(null);
  const [showModal, setShowModal] = createSignal(false);
  const [name, setName] = createSignal('');
  const [color, setColor] = createSignal('#38bdf8');
  const [description, setDescription] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [deleting, setDeleting] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.tags');
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.tags', {});
  const [sortState, setSortState] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'name', direction: 'asc' });
  const [tagsPage, setTagsPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('tags', 20);
  const handleSort = (column: string) => setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  const { columns, isVisible, toggle } = useColumnVisibility('tags', [
    { id: 'name', label: 'Tag', visible: true },
    { id: 'description', label: 'Description', visible: true },
    { id: 'color', label: 'Color', visible: true },
  ]);
  const filteredTags = createMemo(() => {
    let all = tags() || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) all = all.filter(tag => [tag.name, tag.description || '', tag.color].some(value => value.toLowerCase().includes(query)));
    const value = (tag: TagDefinition, column: string) => column === 'name' ? tag.name : column === 'description' ? tag.description || '' : column === 'color' ? tag.color : '';
    return sortRows(applyColumnFilters(all, columnFilters(), value), sortState().column, sortState().direction, value);
  });
  const pagedTags = createMemo(() => filteredTags().slice(tagsPage() * pageSize(), (tagsPage() + 1) * pageSize()));
  createEffect(() => {
    const lastPage = Math.max(0, Math.ceil(filteredTags().length / pageSize()) - 1);
    if (tagsPage() > lastPage) setTagsPage(lastPage);
  });
  const applyFilter = (column: string, state: ColumnFilterState | null) => setColumnFilters(previous => {
    const next = { ...previous };
    if (state) next[column] = state;
    else delete next[column];
    setTagsPage(0);
    return next;
  });

  const openCreate = () => {
    setEditing(null);
    setName('');
    setColor('#38bdf8');
    setDescription('');
    setShowModal(true);
  };

  const openEdit = (tag: TagDefinition) => {
    setEditing(tag);
    setName(tag.name);
    setColor(tag.color);
    setDescription(tag.description || '');
    setShowModal(true);
  };

  const saveTag = async () => {
    const tagName = name().trim();
    if (!tagName || tagName.length > 64) {
      notify({ tone: 'error', title: 'Invalid tag name', message: 'Enter a name with 1 to 64 characters.' });
      return;
    }
    setSaving(true);
    try {
      if (editing()) await api.updateTag(editing()!.id, { name: tagName, color: color(), description: description().trim() });
      else await api.createTag({ name: tagName, color: color(), description: description().trim() });
      setShowModal(false);
      await refetch();
      notify({ tone: 'success', title: editing() ? 'Tag updated' : 'Tag created' });
    } catch (error) {
      notify({ tone: 'error', title: 'Tag was not saved', detail: (error as Error).message, persistent: true });
    } finally { setSaving(false); }
  };

  const deleteTag = async (tag: TagDefinition) => {
    if (!await confirm({ title: `Delete tag “${tag.name}”?`, description: 'Tags assigned to devices or provisioning rules must be removed before this tag can be deleted.', confirmLabel: 'Delete tag', tone: 'danger' })) return;
    setDeleting(tag.id);
    try {
      await api.deleteTag(tag.id);
      await refetch();
      notify({ tone: 'success', title: 'Tag deleted' });
    } catch (error) {
      notify({ tone: 'error', title: 'Tag was not deleted', detail: (error as Error).message, persistent: true });
    } finally { setDeleting(null); }
  };

  return (
    <div class="page">
      <PageHeader title="Dictionaries" description="Manage shared values used across device operations." />
      <div class="border-b border-subtle flex gap-1" role="tablist" aria-label="Dictionaries">
        <button type="button" role="tab" aria-selected="true" class="px-3 py-2 text-xs font-medium border-b-2 border-sky-400 text-primary flex items-center gap-1.5"><Tags size={13} />Tags</button>
      </div>
      <div class="card p-5">
        <div class="flex items-center justify-between gap-3 mb-4">
          <h2 class="text-sm font-medium text-secondary">Tags</h2>
          <div class="flex items-center gap-2">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input type="text" value={searchQuery()} onInput={event => { setSearchQuery(event.currentTarget.value); setTagsPage(0); }} placeholder="Search tags..." aria-label="Search tags" class="input pl-9! w-56 text-sm" />
              <Show when={searchQuery()}><button type="button" onClick={() => { setSearchQuery(''); setTagsPage(0); }} class="input-clear" aria-label="Clear search"><X size={12} /></button></Show>
            </div>
            <Show when={canManageTags()}><button type="button" onClick={openCreate} class="btn btn-primary text-xs"><Plus size={13} />New tag</button></Show>
          </div>
        </div>
        <Show when={tags.error}><ResourceError title="Tag catalog is unavailable" description="Retry loading the tag dictionary." onRetry={() => refetch()} /></Show>
        <Show when={tags.loading}><div class="skeleton h-12 w-full" /></Show>
        <Show when={!tags.loading && !tags.error && (tags() || []).length === 0}>
          <EmptyState compact title="No tags defined" description="Create a tag here, then assign it to devices from the CPE inventory." action={canManageTags() ? <button type="button" onClick={openCreate} class="btn btn-secondary text-xs"><Plus size={12} />New tag</button> : undefined} />
        </Show>
        <Show when={!tags.loading && !tags.error && (tags() || []).length > 0}>
          <div class="table-panel-toolbar">
            <h2 class="text-sm font-medium text-secondary">Tags ({filteredTags().length})</h2>
          </div>
          <Show when={filteredTags().length > 0} fallback={<EmptyState compact title="No matching tags" description="Try a different search term or clear the column filters." />}>
          <div class="overflow-x-auto"><table class="data-table w-full text-sm">
            <thead><tr class="border-b-2 border-subtle bg-base">
              <Show when={isVisible('name')}><th class="text-left px-3 py-2.5 font-semibold text-primary"><SortableHeader column="name" label="Tag" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="name" label="Tag" active={columnFilters().name || null} onApply={state => applyFilter('name', state)} /></SortableHeader></th></Show>
              <Show when={isVisible('description')}><th class="text-left px-3 py-2.5 font-semibold text-primary"><SortableHeader column="description" label="Description" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="description" label="Description" active={columnFilters().description || null} onApply={state => applyFilter('description', state)} /></SortableHeader></th></Show>
              <Show when={isVisible('color')}><th class="text-left px-3 py-2.5 font-semibold text-primary"><SortableHeader column="color" label="Color" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="color" label="Color" active={columnFilters().color || null} onApply={state => applyFilter('color', state)} /></SortableHeader></th></Show>
              <Show when={canManageTags()}><th class="px-3 py-2 text-left font-semibold text-primary">Actions</th></Show><th class="px-2 py-2"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
            </tr></thead>
            <tbody><For each={pagedTags()}>{tag => <tr class="border-t border-subtle hover:bg-elevated/30">
              <Show when={isVisible('name')}><td class="px-3 py-2.5"><div class="flex items-center gap-2"><span class="tag-color-swatch tag-color-swatch-large" data-dynamic-style="tag-color" style={{ '--tag-color': tag.color } as any} /><span class="text-primary">{tag.name}</span></div></td></Show>
              <Show when={isVisible('description')}><td class="px-3 py-2.5 text-secondary">{tag.description || <span class="text-muted">—</span>}</td></Show>
              <Show when={isVisible('color')}><td class="px-3 py-2.5 font-mono text-xs text-secondary">{tag.color}</td></Show>
              <Show when={canManageTags()}><td class="px-2 py-2"><div class="flex justify-end gap-1"><button type="button" onClick={() => openEdit(tag)} class="icon-button" aria-label={`Edit tag ${tag.name}`}><Edit size={13} /></button><button type="button" onClick={() => void deleteTag(tag)} disabled={deleting() === tag.id} class="icon-button hover:text-rose-400" aria-label={`Delete tag ${tag.name}`}><Trash2 size={13} /></button></div></td></Show><td />
            </tr>}</For></tbody>
          </table></div>
          </Show>
        </Show>
      </div>
      <Show when={showModal()}><Dialog title={editing() ? `Edit tag: ${editing()!.name}` : 'New tag'} description="Tags are shared in the device inventory and provisioning rules." size="small" onClose={() => setShowModal(false)} actions={<><button type="button" onClick={() => setShowModal(false)} class="btn btn-secondary">Cancel</button><button type="button" onClick={() => void saveTag()} disabled={saving()} class="btn btn-primary"><Save size={13} />{saving() ? 'Saving…' : 'Save tag'}</button></>}>
        <div class="space-y-4"><div><label class="block text-xs text-muted mb-1.5" for="tag-name">Name</label><input id="tag-name" class="input w-full" value={name()} onInput={event => setName(event.currentTarget.value)} disabled={saving()} maxLength={64} placeholder="e.g. Active" /></div><div><label class="block text-xs text-muted mb-1.5" for="tag-description">Description <span class="text-muted">(optional)</span></label><textarea id="tag-description" class="input w-full min-h-20 resize-y" value={description()} onInput={event => setDescription(event.currentTarget.value)} disabled={saving()} maxLength={500} placeholder="Describe how this tag is used" /></div><div><div class="text-xs text-muted mb-2">Color</div><ColorSwatch value={color()} onChange={setColor} /></div></div>
      </Dialog></Show>
      <Pagination page={tagsPage()} totalPages={Math.ceil(filteredTags().length / pageSize())} totalItems={filteredTags().length} pageSize={pageSize()} onPageChange={setTagsPage} storageKey="tags" onPageSizeChange={size => { changePageSize(size); setTagsPage(0); }} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setTagsPage(0); }} onRemoveFilter={column => { setColumnFilters(previous => { const next = { ...previous }; delete next[column]; return next; }); setTagsPage(0); }} />
    </div>
  );
};

export default Dictionaries;
