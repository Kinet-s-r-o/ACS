import type { Component } from 'solid-js';
import { createSignal, Show, For, onCleanup } from 'solid-js';
import { Filter, Plus, X } from 'lucide-solid';
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

  const positionPanel = (panel: HTMLDivElement) => {
    if (!btnRef) return;

    const viewportPadding = 8;
    const buttonRect = btnRef.getBoundingClientRect();

    // Start below the trigger so the panel can be measured before choosing
    // whether it needs to open left-aligned or above the trigger.
    panel.style.top = `${buttonRect.bottom + 4}px`;
    panel.style.left = `${buttonRect.left}px`;

    const panelRect = panel.getBoundingClientRect();
    const maxLeft = Math.max(viewportPadding, window.innerWidth - panelRect.width - viewportPadding);
    const left = Math.min(buttonRect.left, maxLeft);
    const opensBelow = buttonRect.bottom + 4 + panelRect.height <= window.innerHeight - viewportPadding;
    const preferredTop = opensBelow ? buttonRect.bottom + 4 : buttonRect.top - panelRect.height - 4;
    const maxTop = Math.max(viewportPadding, window.innerHeight - panelRect.height - viewportPadding);
    const top = Math.min(Math.max(viewportPadding, preferredTop), maxTop);

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  };

  const toggle = () => {
    if (!open()) {
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

  onCleanup(() => {
    document.removeEventListener('click', handleClickOutside);
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
        <div
          class="filter-dropdown"
          ref={(el) => {
            panelRef = el;
            el.style.position = 'fixed';
            positionPanel(el);
            if (el) document.addEventListener('click', handleClickOutside);
          }}
          onClick={(e) => e.stopPropagation()}
        >
            <div class="filter-dropdown-header">
              <span class="filter-dropdown-title">{props.label}</span>
              <button type="button" class="filter-dropdown-close" onClick={() => setOpen(false)} aria-label="Close filter">
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
      </Show>
    </>
  );
};

export default ColumnFilter;
