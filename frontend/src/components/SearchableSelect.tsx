import { createEffect, createMemo, createSignal, createUniqueId, Index, onCleanup, Show, type Component } from 'solid-js';
import { ChevronDown } from 'lucide-solid';

interface Option { value: string; label: string }

const SearchableSelect: Component<{
  label: string; placeholder: string; value: string; options: Option[];
  disabled?: boolean; onChange: (value: string) => void;
}> = props => {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [active, setActive] = createSignal(0);
  const matches = createMemo(() => {
    const terms = search().toLowerCase().trim().split(/\s+/).filter(Boolean);
    return props.options.filter(option => terms.every(term => option.label.toLowerCase().includes(term)));
  });
  const visible = () => matches().slice(0, 200);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let input: HTMLInputElement | undefined;
  const close = (restore = false) => { setOpen(false); if (restore) trigger.focus(); };
  const show = () => { if (props.disabled) return; setSearch(''); setActive(0); setOpen(true); queueMicrotask(() => { if (open()) input?.focus(); }); };
  const choose = (value: string) => { props.onChange(value); close(true); };
  createEffect(() => { if (props.disabled) close(); });
  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    onCleanup(() => document.removeEventListener('pointerdown', outside));
  });
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => Math.max(0, Math.min(visible().length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
      document.getElementById(`${id}-option-${active()}`)?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter') { event.preventDefault(); const option = visible()[active()]; if (option) choose(option.value); }
  };
  return <div ref={root} class="relative min-w-0" onFocusOut={event => { if (!root.contains(event.relatedTarget as Node | null)) close(); }}>
    <label for={`${id}-trigger`} class="block text-xs text-muted mb-1">{props.label}</label>
    <button ref={trigger} id={`${id}-trigger`} type="button" class="input w-full flex items-center justify-between gap-2 text-left" disabled={props.disabled} aria-haspopup="listbox" aria-expanded={open()} aria-controls={`${id}-list`} onClick={() => open() ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>
      <span class="min-w-0 truncate font-mono">{props.options.find(option => option.value === props.value)?.label || props.value || props.placeholder}</span><ChevronDown size={14} class="shrink-0" aria-hidden="true" />
    </button>
    <Show when={open()}><div class="absolute z-10 left-0 right-0 mt-1 border border-default bg-surface shadow-lg p-2">
      <input ref={input} type="search" class="input w-full mb-2" role="combobox" aria-label={`Search ${props.label}`} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={visible().length ? `${id}-option-${active()}` : undefined} placeholder="Search parameter path or type…" autocomplete="off" value={search()} onInput={event => { setSearch(event.currentTarget.value); setActive(0); }} onKeyDown={keydown} />
      <div id={`${id}-list`} role="listbox" aria-label={props.label} class="max-h-56 overflow-y-auto">
        <Index each={visible()}>{(option, index) => <div id={`${id}-option-${index}`} role="option" aria-selected={option().value === props.value} class={`cursor-pointer break-all px-2 py-2 text-xs font-mono ${active() === index ? 'bg-elevated text-primary' : 'text-secondary hover:bg-elevated'}`} onPointerMove={() => setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(option().value)}>{option().label}</div>}</Index>
        <Show when={!matches().length}><p class="text-xs text-muted px-2 py-3">No matching parameters.</p></Show>
      </div>
      <p class="text-xs text-muted mt-2" role="status">{matches().length} matching parameters{matches().length > 200 ? '; first 200 shown. Refine your search.' : ''}</p>
    </div></Show>
  </div>;
};

export default SearchableSelect;
