import type { Component } from 'solid-js';
import { createSignal, Show, For, onCleanup } from 'solid-js';
import { List, X } from 'lucide-solid';

export interface ColumnOption {
  id: string;
  label: string;
  visible: boolean;
}

interface ColumnVisibilityProps {
  /** Getter returning the full column list (visible + hidden), in display order. */
  columns: () => ColumnOption[];
  /** Called with a column id when the user toggles it. The dropdown stays open. */
  onToggle: (id: string) => void;
  /** Dropdown title. Defaults to the Slovak "Stĺpce". */
  title?: string;
}

const DROPDOWN_WIDTH = 220;

/**
 * Right-end table control: a "three horizontal lines" button that opens a
 * fixed-position multiselect dropdown for toggling column visibility.
 * The dropdown stays open after each toggle and closes on outside click.
 */
const ColumnVisibility: Component<ColumnVisibilityProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 });
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;

  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (panelRef && !panelRef.contains(target) && btnRef && !btnRef.contains(target)) {
      setOpen(false);
    }
  };

  const toggle = () => {
    if (!open() && btnRef) {
      const rect = btnRef.getBoundingClientRect();
      let left = rect.right + 4;
      if (left + DROPDOWN_WIDTH > window.innerWidth) left = Math.max(8, rect.left - DROPDOWN_WIDTH - 4);
      setPos({ top: rect.bottom + 4, left });
    }
    setOpen(!open());
  };

  onCleanup(() => {
    document.removeEventListener('click', handleClickOutside);
  });

  return (
    <>
      <button
        type="button"
        class="column-toggle"
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        aria-label="Stĺpce"
        aria-expanded={open()}
      >
        <List size={14} />
      </button>
      <Show when={open()}>
        <div
          class="column-dropdown"
          ref={(el) => {
            panelRef = el;
            el.style.position = 'fixed';
            el.style.top = `${pos().top}px`;
            el.style.left = `${pos().left}px`;
            if (el) document.addEventListener('click', handleClickOutside);
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="column-dropdown-header">
            <span class="column-dropdown-title">{props.title ?? 'Stĺpce'}</span>
            <button type="button" class="column-dropdown-close" onClick={() => setOpen(false)} aria-label="Zavrieť">
              <X size={12} />
            </button>
          </div>
          <div class="column-dropdown-body">
            <For each={props.columns()}>
              {(col) => (
                <label class="column-toggle-row">
                  <input
                    type="checkbox"
                    checked={col.visible}
                    onChange={() => props.onToggle(col.id)}
                    class="column-toggle-checkbox"
                  />
                  <span class="column-toggle-label">{col.label}</span>
                </label>
              )}
            </For>
          </div>
        </div>
      </Show>
    </>
  );
};

export default ColumnVisibility;
