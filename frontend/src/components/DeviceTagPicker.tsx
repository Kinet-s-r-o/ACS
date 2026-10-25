import type { Component } from 'solid-js';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { A } from '@solidjs/router';
import { Check, Plus, Search } from 'lucide-solid';
import { api, type Device, type TagDefinition } from '../lib/api';
import { useFeedback } from './Feedback';

interface DeviceTagPickerProps {
  device: Device;
  tags: TagDefinition[];
  writable: boolean;
  onUpdated: () => void;
}

const DeviceTagPicker: Component<DeviceTagPickerProps> = (props) => {
  const { notify } = useFeedback();
  const [selected, setSelected] = createSignal<string[]>(props.device.tags || []);
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [position, setPosition] = createSignal({ top: 0, left: 0, width: 280 });
  let trigger: HTMLButtonElement | undefined;

  createEffect(() => setSelected([...(props.device.tags || [])]));
  const filteredTags = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();
    return text ? props.tags.filter(tag => tag.name.toLocaleLowerCase().includes(text)) : props.tags;
  });
  const definition = (id: string) => props.tags.find(tag => tag.id === id);

  const openPicker = () => {
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(280, window.innerWidth - 16);
    const height = Math.min(360, window.innerHeight - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
    setPosition({ top, left, width });
    setQuery('');
    setOpen(true);
  };

  const close = () => setOpen(false);
  onMount(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', closeOnEscape);
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape));
  });

  const toggleTag = async (tagId: string) => {
    if (saving()) return;
    const before = selected();
    const next = before.includes(tagId) ? before.filter(id => id !== tagId) : [...before, tagId];
    setSelected(next);
    setSaving(true);
    try {
      await api.setDeviceTags(props.device.serial_number, next);
      props.onUpdated();
    } catch (error) {
      setSelected(before);
      notify({ tone: 'error', title: 'Device tags were not updated', detail: (error as Error).message, persistent: true });
    } finally { setSaving(false); }
  };

  return (
    <div class="flex flex-wrap items-center gap-1.5 min-w-0">
      <For each={selected()}>{id => {
        const tag = () => definition(id);
        return <span class="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-elevated text-primary whitespace-nowrap"><span class="tag-color-swatch" data-dynamic-style="tag-color" style={{ '--tag-color': tag()?.color || '#64748b' } as any} />{tag()?.name || id}</span>;
      }}</For>
      <Show when={props.writable}>
        <button ref={trigger} type="button" onClick={() => open() ? close() : openPicker()} class="inline-flex items-center gap-1 rounded-full border border-subtle px-2 py-1 text-[11px] text-secondary hover:text-primary hover:bg-elevated whitespace-nowrap" aria-haspopup="dialog" aria-expanded={open()}>
          <Plus size={12} />Tag
        </button>
      </Show>
      <Show when={open()}>
        <Portal>
          <button type="button" class="fixed inset-0 z-[80] border-0 bg-transparent" aria-label="Close tag picker" onClick={close} />
          <div class="fixed z-[81] rounded-lg border border-subtle bg-elevated shadow-2xl p-2 overflow-y-auto" data-dynamic-style="tag-picker-position" style={{ top: `${position().top}px`, left: `${position().left}px`, width: `${position().width}px`, 'max-height': `${Math.min(360, window.innerHeight - 16)}px` }} role="dialog" aria-label={`Assign tags to ${props.device.serial_number}`}>
            <div class="relative mb-2"><Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" /><input autofocus class="input w-full pl-9! py-2 text-sm" placeholder="Search tags…" aria-label="Search tags" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></div>
            <div class="max-h-64 overflow-y-auto rounded border border-subtle bg-base p-1">
              <Show when={filteredTags().length > 0} fallback={<div class="px-3 py-4 text-center text-xs text-muted">No matching tags</div>}>
                <For each={filteredTags()}>{tag => {
                  const checked = () => selected().includes(tag.id);
                  return <button type="button" role="menuitemcheckbox" aria-checked={checked()} onClick={() => void toggleTag(tag.id)} disabled={saving()} class="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-primary hover:bg-elevated disabled:opacity-50">
                    <span class="tag-color-swatch tag-color-swatch-large" data-dynamic-style="tag-color" style={{ '--tag-color': tag.color } as any} /><span class="flex-1 truncate">{tag.name}</span><Show when={checked()}><Check size={14} class="text-sky-400" /></Show>
                  </button>;
                }}</For>
              </Show>
            </div>
            <A href="/settings/dictionaries" onClick={close} class="mt-2 flex items-center gap-2 border-t border-subtle px-2 py-2 text-sm text-primary hover:text-sky-400"><Plus size={15} />New tag</A>
          </div>
        </Portal>
      </Show>
    </div>
  );
};

export default DeviceTagPicker;
