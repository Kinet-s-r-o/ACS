import type { Component } from 'solid-js';
import { createEffect, createSignal, createUniqueId, Show, For, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { List, X } from 'lucide-solid';
import { floatingPanelPosition } from '../lib/floatingPanel';

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

/**
 * Right-end table control: a "three horizontal lines" button that opens a
 * fixed-position multiselect dropdown for toggling column visibility.
 * The dropdown stays open after each toggle and closes on outside click.
 */
const ColumnVisibility: Component<ColumnVisibilityProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<{ top: number; left: number } | null>(null);
  const panelId = createUniqueId();
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
    if (!open()) setPos(null);
    setOpen(!open());
  };

  const close = () => { setOpen(false); btnRef?.focus(); };

  createEffect(() => {
    if (!open()) return;
    queueMicrotask(positionPanel);
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef?.contains(event.target)) return;
      positionPanel();
    };
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', positionPanel);
    onCleanup(() => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', positionPanel);
    });
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
          aria-controls={open() ? panelId : undefined}
        >
          <List size={14} />
      </button>
      <Show when={open()}>
        <Portal>
        <div
          id={panelId}
          class="column-dropdown"
          ref={panelRef}
          data-dynamic-style="Column menu anchored to its trigger and constrained to the viewport"
          style={{ top: `${pos()?.top ?? 8}px`, left: `${pos()?.left ?? 8}px`, visibility: pos() ? 'visible' : 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="column-dropdown-header">
            <span class="column-dropdown-title">{props.title ?? 'Stĺpce'}</span>
            <button type="button" class="column-dropdown-close" onClick={close} aria-label="Zavrieť">
              <X size={12} />
            </button>
          </div>
          <div class="column-dropdown-body">
            <For each={props.columns().filter(column => column.id !== 'actions')}>
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
        </Portal>
      </Show>
    </>
  );
};

export default ColumnVisibility;
