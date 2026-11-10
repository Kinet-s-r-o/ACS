import { createMemo, createSignal, createUniqueId, For, Show, type Component } from 'solid-js';

const commonCodes: Record<string, string> = {
  '9000': 'Method not supported',
  '9001': 'Request denied',
  '9002': 'Internal error',
  '9003': 'Invalid arguments',
  '9004': 'Resources exceeded',
  '9005': 'Invalid parameter name',
};

const DynamicBranchFaultCodes: Component<{
  label: string;
  codes: string[];
  disabled?: boolean;
  onChange: (codes: string[]) => void;
}> = props => {
  const id = createUniqueId();
  const [query, setQuery] = createSignal('');
  let details!: HTMLDetailsElement;
  let summary!: HTMLElement;
  const matches = createMemo(() => {
    const search = query().trim().toLowerCase();
    const options = search ? Array.from({ length: 1000 }, (_, index) => String(9000 + index)) : [...new Set([...Object.keys(commonCodes), ...props.codes])].sort();
    return options.filter(code => `${code} ${commonCodes[code] || ''}`.toLowerCase().includes(search));
  });
  const toggle = (code: string) => props.onChange(props.codes.includes(code) ? props.codes.filter(item => item !== code) : [...props.codes, code].sort());
  return <details ref={details} class="min-w-0 rounded border border-subtle" on:keydown={event => {
    if (event.key === 'Escape' && details.open) { event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus(); }
  }}>
    <summary ref={summary} class="cursor-pointer px-3 py-2 text-xs text-secondary [overflow-wrap:anywhere]" aria-label={props.label}>
      Suppressed faults: {props.codes.length ? props.codes.join(', ') : 'None'}
    </summary>
    <div class="space-y-2 border-t border-subtle p-2">
      <label for={`${id}-search`} class="block text-xs text-muted">Search error code (9000–9999)</label>
      <input id={`${id}-search`} type="search" inputmode="numeric" class="input w-full" placeholder="e.g. 9005" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
      <div class="max-h-40 overflow-y-auto" role="group" aria-label={props.label}>
        <For each={matches().slice(0, 100)}>{code => <label class="flex min-h-10 cursor-pointer items-center gap-2 px-2 py-1 text-xs text-secondary">
          <input type="checkbox" class="shrink-0" checked={props.codes.includes(code)} disabled={props.disabled || (!props.codes.includes(code) && props.codes.length >= 32)} onChange={() => toggle(code)} />
          <span class="[overflow-wrap:anywhere]"><span class="font-mono">{code}</span>{commonCodes[code] ? ` — ${commonCodes[code]}` : ''}</span>
        </label>}</For>
        <Show when={!matches().length}><p class="px-2 py-2 text-xs text-muted">No matching CPE fault codes.</p></Show>
      </div>
      <p class="text-xs text-muted" role="status">{matches().length > 100 ? 'Showing the first 100 matches. Enter more digits to narrow the list. ' : ''}{props.codes.length}/32 selected. Empty selection records all faults. Applies to parameter reads only.</p>
    </div>
  </details>;
};

export default DynamicBranchFaultCodes;
