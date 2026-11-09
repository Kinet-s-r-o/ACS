import type { Component } from 'solid-js';
import { createEffect, createSignal, Show, For, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Filter, Plus, X } from 'lucide-solid';
import { floatingPanelPosition } from '../lib/floatingPanel';
import {
  type ColumnFilterState,
  type FilterOperator,
  type FilterLogic,
  OPERATOR_LABELS,
  LOGIC_LABELS,
} from '../lib/filters';

interface ColumnFilterProps {
  columnId: string;
  label: string;
  numeric?: boolean;
  active: ColumnFilterState | null;
  onApply: (state: ColumnFilterState | null) => void;
}

const ColumnFilter: Component<ColumnFilterProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<{ top: number; left: number } | null>(null);
  const [logic, setLogic] = createSignal<FilterLogic>(props.active?.logic ?? 'all');
  const [rules, setRules] = createSignal<{ operator: FilterOperator; value: string }[]>(
    props.active?.rules?.length ? props.active.rules : [{ operator: 'contains', value: '' }]
  );
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;

  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (panelRef && !panelRef.contains(target) && btnRef && !btnRef.contains(target)) {
      setOpen(false);
    }
  };

  const positionPanel = () => {
    if (!open() || !btnRef || !panelRef) return;
    const anchor = btnRef.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > window.innerHeight || anchor.right < 0 || anchor.left > window.innerWidth) {
      setOpen(false);
      return;
    }
    setPos(floatingPanelPosition(anchor, panelRef.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
  };

  const toggle = () => {
    if (!open()) {
      setPos(null);
      setLogic(props.active?.logic ?? 'all');
      setRules(props.active?.rules?.length ? props.active.rules : [{ operator: 'contains', value: '' }]);
    }
    setOpen(!open());
  };

  const addRule = () => {
    setRules((r) => [...r, { operator: 'contains', value: '' }]);
  };

  const removeRule = (index: number) => {
    setRules((r) => r.filter((_, i) => i !== index));
  };

  const mutateRule = (index: number, field: 'operator' | 'value', val: string) => {
    // Mutate in place to avoid triggering For re-render (prevents cursor jump)
    const r = rules();
    if (field === 'operator') {
      r[index].operator = val as FilterOperator;
    } else {
      r[index].value = val;
    }
  };

  const handleApply = () => {
    const validRules = rules().filter((r) => r.value.trim() !== '');
    if (validRules.length === 0) {
      props.onApply(null);
    } else {
      props.onApply({ logic: logic(), rules: validRules });
    }
    setOpen(false);
  };

  const handleClear = () => {
    props.onApply(null);
    setLogic('all');
    setRules([{ operator: 'contains', value: '' }]);
    setOpen(false);
  };

  const close = () => { setOpen(false); btnRef?.focus(); };

  createEffect(() => {
    if (!open()) return;
    let active = true;
    const observer = new ResizeObserver(positionPanel);
    // Portal refs run before insertion; measure only after the panel is mounted.
    queueMicrotask(() => {
      if (!active || !open() || !panelRef) return;
      positionPanel();
      observer.observe(panelRef);
    });
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef?.contains(event.target)) return;
      positionPanel();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', positionPanel);
    onCleanup(() => {
      active = false;
      observer.disconnect();
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('resize', positionPanel);
    });
  });

  return (
    <>
      <button
        type="button"
        class={`filter-toggle ${props.active ? 'filter-toggle-active' : ''}`}
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        aria-label={`Filter ${props.label}`}
        aria-expanded={open()}
      >
        <Filter size={11} />
        <Show when={props.active}>
          <span class="filter-badge">{props.active!.rules.length}</span>
        </Show>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            class="filter-dropdown"
            ref={panelRef}
            data-dynamic-style="Filter menu anchored to its trigger and constrained to the viewport"
            style={{ top: `${pos()?.top ?? 8}px`, left: `${pos()?.left ?? 8}px`, visibility: pos() ? 'visible' : 'hidden' }}
          >
            <div class="filter-dropdown-header">
              <span class="filter-dropdown-title">{props.label}</span>
              <button type="button" class="filter-dropdown-close" onClick={close} aria-label="Close filter">
                <X size={12} />
              </button>
            </div>
            <div class="filter-dropdown-body">
              <div class="filter-dropdown-label">Logic</div>
              <select
                class="filter-dropdown-select"
                value={logic()}
                onChange={(e) => setLogic(e.currentTarget.value as FilterLogic)}
              >
                <For each={Object.entries(LOGIC_LABELS)}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </select>
              <div class="filter-rules">
                <For each={rules()}>
                  {(rule, idx) => (
                    <div class="filter-rule">
                      <select
                        class="filter-dropdown-select filter-rule-op"
                        value={rule.operator}
                        onChange={(e) => mutateRule(idx(), 'operator', e.currentTarget.value)}
                      >
                        <For each={Object.entries(OPERATOR_LABELS).filter(([value]) => props.numeric || !value.startsWith('greater_than') && !value.startsWith('less_than'))}>
                          {([value, label]) => <option value={value}>{label}</option>}
                        </For>
                      </select>
                      <input
                        type="text"
                        class="filter-rule-input"
                        value={rule.value}
                        onInput={(e) => mutateRule(idx(), 'value', e.currentTarget.value)}
                        placeholder="Value…"
                      />
                      <Show when={rules().length > 1}>
                        <button type="button" class="filter-rule-remove" onClick={() => removeRule(idx())} aria-label="Remove rule">
                          <X size={10} />
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <button type="button" class="filter-add-rule" onClick={addRule}>
                <Plus size={11} />
                Add rule
              </button>
            </div>
            <div class="filter-dropdown-footer">
              <button type="button" class="filter-btn-clear" onClick={handleClear}>
                Clear
              </button>
              <button type="button" class="filter-btn-apply" onClick={handleApply}>
                Apply
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
};

export default ColumnFilter;
