import type { Component } from 'solid-js';
import { createResource, createSignal, For, Show } from 'solid-js';
import { Edit, Plus, Save, Tags, Trash2 } from 'lucide-solid';
import { api, type TagDefinition } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/Feedback';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import ColorSwatch from '../components/ColorSwatch';
import { EmptyState, ResourceError } from '../components/ResourceState';

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
          <Show when={canManageTags()}><button type="button" onClick={openCreate} class="btn btn-primary text-xs"><Plus size={13} />New tag</button></Show>
        </div>
        <Show when={tags.error}><ResourceError title="Tag catalog is unavailable" description="Retry loading the tag dictionary." onRetry={() => refetch()} /></Show>
        <Show when={tags.loading}><div class="skeleton h-12 w-full" /></Show>
        <Show when={!tags.loading && !tags.error && (tags() || []).length === 0}>
          <EmptyState compact title="No tags defined" description="Create a tag here, then assign it to devices from the CPE inventory." action={canManageTags() ? <button type="button" onClick={openCreate} class="btn btn-secondary text-xs"><Plus size={12} />New tag</button> : undefined} />
        </Show>
        <Show when={!tags.loading && !tags.error && (tags() || []).length > 0}>
          <div class="overflow-x-auto"><table class="data-table w-full text-sm">
            <thead><tr class="border-b-2 border-subtle bg-base"><th class="text-left px-3 py-2.5 font-semibold text-primary">Tag</th><th class="text-left px-3 py-2.5 font-semibold text-primary">Description</th><th class="text-left px-3 py-2.5 font-semibold text-primary">Color</th><Show when={canManageTags()}><th class="w-20" /></Show></tr></thead>
            <tbody><For each={tags()}>{tag => <tr class="border-t border-subtle hover:bg-elevated/30">
              <td class="px-3 py-2.5"><div class="flex items-center gap-2"><span class="tag-color-swatch tag-color-swatch-large" data-dynamic-style="tag-color" style={{ '--tag-color': tag.color } as any} /><span class="text-primary">{tag.name}</span></div></td>
              <td class="px-3 py-2.5 text-secondary">{tag.description || <span class="text-muted">—</span>}</td>
              <td class="px-3 py-2.5 font-mono text-xs text-secondary">{tag.color}</td>
              <Show when={canManageTags()}><td class="px-2 py-2"><div class="flex justify-end gap-1"><button type="button" onClick={() => openEdit(tag)} class="icon-button" aria-label={`Edit tag ${tag.name}`}><Edit size={13} /></button><button type="button" onClick={() => void deleteTag(tag)} disabled={deleting() === tag.id} class="icon-button hover:text-rose-400" aria-label={`Delete tag ${tag.name}`}><Trash2 size={13} /></button></div></td></Show>
            </tr>}</For></tbody>
          </table></div>
        </Show>
      </div>
      <Show when={showModal()}><Dialog title={editing() ? `Edit tag: ${editing()!.name}` : 'New tag'} description="Tags are shared in the device inventory and provisioning rules." size="small" onClose={() => setShowModal(false)} actions={<><button type="button" onClick={() => setShowModal(false)} class="btn btn-secondary">Cancel</button><button type="button" onClick={() => void saveTag()} disabled={saving()} class="btn btn-primary"><Save size={13} />{saving() ? 'Saving…' : 'Save tag'}</button></>}>
        <div class="space-y-4"><div><label class="block text-xs text-muted mb-1.5" for="tag-name">Name</label><input id="tag-name" class="input w-full" value={name()} onInput={event => setName(event.currentTarget.value)} disabled={saving()} maxLength={64} placeholder="e.g. Active" /></div><div><label class="block text-xs text-muted mb-1.5" for="tag-description">Description <span class="text-muted">(optional)</span></label><textarea id="tag-description" class="input w-full min-h-20 resize-y" value={description()} onInput={event => setDescription(event.currentTarget.value)} disabled={saving()} maxLength={500} placeholder="Describe how this tag is used" /></div><div><div class="text-xs text-muted mb-2">Color</div><ColorSwatch value={color()} onChange={setColor} /></div></div>
      </Dialog></Show>
    </div>
  );
};

export default Dictionaries;
