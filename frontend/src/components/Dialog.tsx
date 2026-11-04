import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, Show, type JSX, type ParentComponent } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Maximize2, X } from 'lucide-solid';
import { fitDialogRect, moveDialogRect, type DialogRect } from '../lib/dialogResize';

interface DialogProps {
  title: string;
  description?: string;
  headerBadge?: JSX.Element;
  actions?: JSX.Element;
  sidePanel?: JSX.Element;
  size?: 'small' | 'medium' | 'large';
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  onClose: () => void;
}

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const Dialog: ParentComponent<DialogProps> = (props) => {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const sidePanel = createMemo(() => props.sidePanel);
  const [userRect, setUserRect] = createSignal<DialogRect>();
  const [sizeControlsOpen, setSizeControlsOpen] = createSignal(false);
  const [viewport, setViewport] = createSignal({ width: window.innerWidth, height: window.innerHeight });
  const resizeHintId = createUniqueId();
  const sizeControlsId = createUniqueId();
  const moveHintId = createUniqueId();
  const availableSize = createMemo(() => {
    const margin = viewport().width < 640 ? 16 : 32;
    return { width: Math.max(1, viewport().width - margin), height: Math.max(1, viewport().height - margin) };
  });
  let suppressResizeClick = false;
  let drag: { pointerId: number; x: number; y: number; rect: DialogRect } | undefined;
  let resizeHandle: HTMLButtonElement | undefined;
  let titleBar: HTMLElement | undefined;
  let moveDrag: { pointerId: number; x: number; y: number; rect: DialogRect } | undefined;
  let panel: HTMLDivElement | undefined;
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const currentRect = (): DialogRect => {
    const rect = userRect() ?? panel!.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const resizeTo = (rect: DialogRect) => setUserRect(fitDialogRect(rect, viewport().width, viewport().height, sidePanel() ? 800 : 320));
  const moveTo = (rect: DialogRect, dx = 0, dy = 0) => setUserRect(moveDialogRect(rect, dx, dy, viewport().width, viewport().height));
  const stopMove = () => {
    const previous = moveDrag;
    moveDrag = undefined;
    if (previous && titleBar?.hasPointerCapture(previous.pointerId)) titleBar.releasePointerCapture(previous.pointerId);
  };
  const stopResize = () => {
    if (drag && resizeHandle?.hasPointerCapture(drag.pointerId)) resizeHandle.releasePointerCapture(drag.pointerId);
    drag = undefined;
  };
  const resetSize = () => { stopMove(); stopResize(); setUserRect(undefined); };
  // Help expansion retains the form DOM while restoring its intended width.
  createEffect(() => { sidePanel(); resetSize(); });

  const handleResizeKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 10;
    const changes: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (event.key === 'Home') { event.preventDefault(); resetSize(); return; }
    const change = changes[event.key];
    if (!change) return;
    event.preventDefault();
    const rect = currentRect();
    resizeTo({ ...rect, width: rect.width + change[0], height: rect.height + change[1] });
  };

  const focusableElements = () => Array.from(panel?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);

  const handleKeyDown = (event: KeyboardEvent) => {
    const dialogs = document.querySelectorAll('.dialog-panel');
    if (dialogs[dialogs.length - 1] !== panel) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (sizeControlsOpen()) {
        setSizeControlsOpen(false);
        resizeHandle?.focus();
        return;
      }
      props.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusableElements();
    if (elements.length === 0) {
      event.preventDefault();
      panel?.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  onMount(() => {
    const updateViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      stopMove();
      if (userRect()) moveTo(userRect()!);
    };
    window.addEventListener('resize', updateViewport);
    onCleanup(() => { window.removeEventListener('resize', updateViewport); stopMove(); stopResize(); });
    const previousPanels = Array.from(document.querySelectorAll<HTMLElement>('.dialog-panel'))
      .filter((element) => element !== panel)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of previousPanels) element.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    queueMicrotask(() => {
      const preferred = panel?.querySelector<HTMLElement>('[autofocus]');
      (preferred ?? focusableElements().find(element => element !== titleBar) ?? panel)?.focus();
    });
    onCleanup(() => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      for (const { element, inert } of previousPanels) element.inert = inert;
      previouslyFocused?.focus();
    });
  });

  return (
    <Portal>
      <div
        class="dialog-backdrop"
        onMouseDown={(event) => {
          if (props.closeOnBackdrop !== false && event.target === event.currentTarget) props.onClose();
        }}
      >
        <div
          ref={panel}
          class={`dialog-panel dialog-${props.size ?? 'medium'}${sidePanel() ? ' dialog-with-side-panel' : ''}`}
          classList={{ 'dialog-user-sized': !!userRect() }}
          data-dynamic-style="User-selected dialog dimensions and position, constrained to the viewport"
          style={userRect() ? { width: `${userRect()!.width}px`, height: `${userRect()!.height}px`, left: `${userRect()!.left}px`, top: `${userRect()!.top}px` } : undefined}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={props.description ? descriptionId : undefined}
          tabindex="-1"
        >
          <header ref={titleBar} class="dialog-header dialog-move-header" tabindex="0" role="group" aria-label={`Move ${props.title}`} aria-describedby={moveHintId}
            onPointerDown={(event) => {
              if (event.button !== 0 || moveDrag || drag || (event.target as Element).closest('button, a, input, select, textarea, summary, [role="button"], [contenteditable="true"]')) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              moveDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: currentRect() };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!moveDrag || event.pointerId !== moveDrag.pointerId) return;
              const dx = event.clientX - moveDrag.x, dy = event.clientY - moveDrag.y;
              if (Math.abs(dx) + Math.abs(dy) < 4) return;
              moveTo(moveDrag.rect, dx, dy);
            }}
            onPointerUp={(event) => { if (event.pointerId === moveDrag?.pointerId) stopMove(); }}
            onPointerCancel={(event) => { if (event.pointerId === moveDrag?.pointerId) stopMove(); }}
            onLostPointerCapture={stopMove}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Home') { event.preventDefault(); resetSize(); return; }
              const step = event.shiftKey ? 40 : 10;
              const changes: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const change = changes[event.key];
              if (!change) return;
              event.preventDefault();
              moveTo(currentRect(), change[0], change[1]);
            }}>
            <div class="dialog-header-content">
              <h2 id={titleId}>{props.title}</h2>
              {props.description && <p id={descriptionId}>{props.description}</p>}
            </div>
            {props.headerBadge}
            <button type="button" class="icon-button" onClick={props.onClose} aria-label={props.closeLabel ?? 'Close dialog'}>
              <X size={17} />
            </button>
          </header>
          <div class="dialog-content">
            <div class="dialog-body">{props.children}</div>
            {sidePanel()}
          </div>
          {props.actions && <footer class="dialog-actions">{props.actions}</footer>}
          <div class="dialog-resize-bar">
            <span id={moveHintId} class="sr-only">Drag the title bar to move this dialog. When focused, use arrow keys to move, Shift for larger steps, or Home to restore default size and position. Position sliders are available in the resize controls.</span>
            <span id={resizeHintId} class="sr-only">Drag to resize. Arrow keys change width or height; Shift uses larger steps. Home restores the default size. Click for size controls.</span>
            <Show when={sizeControlsOpen()}>
              <div id={sizeControlsId} class="dialog-size-controls" role="group" aria-label="Dialog size and position">
                <label>Width<input type="range" min={Math.min(sidePanel() ? 800 : 320, availableSize().width)} max={availableSize().width} value={Math.round(userRect()?.width ?? panel?.clientWidth ?? 560)} onInput={(event) => resizeTo({ ...currentRect(), width: Number(event.currentTarget.value) })} /></label>
                <label>Height<input type="range" min={Math.min(180, availableSize().height)} max={availableSize().height} value={Math.round(userRect()?.height ?? panel?.clientHeight ?? 400)} onInput={(event) => resizeTo({ ...currentRect(), height: Number(event.currentTarget.value) })} /></label>
                <label>Horizontal position<input type="range" min={viewport().width < 640 ? 8 : 16} max={Math.max(viewport().width < 640 ? 8 : 16, viewport().width - currentRect().width - (viewport().width < 640 ? 8 : 16))} value={Math.round(currentRect().left)} onInput={(event) => moveTo({ ...currentRect(), left: Number(event.currentTarget.value) })} /></label>
                <label>Vertical position<input type="range" min={viewport().width < 640 ? 8 : 16} max={Math.max(viewport().width < 640 ? 8 : 16, viewport().height - currentRect().height - (viewport().width < 640 ? 8 : 16))} value={Math.round(currentRect().top)} onInput={(event) => moveTo({ ...currentRect(), top: Number(event.currentTarget.value) })} /></label>
                <button type="button" class="btn btn-secondary" onClick={resetSize}>Reset size and position</button>
              </div>
            </Show>
            <button ref={resizeHandle} type="button" class="dialog-resize-handle" aria-label="Resize dialog" aria-describedby={resizeHintId} aria-controls={sizeControlsOpen() ? sizeControlsId : undefined} aria-expanded={sizeControlsOpen()} title="Drag to resize or click for size controls"
              onKeyDown={handleResizeKey}
              onClick={(event) => {
                if (suppressResizeClick && event.detail !== 0) { suppressResizeClick = false; return; }
                suppressResizeClick = false;
                setSizeControlsOpen(open => !open);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                suppressResizeClick = false;
                drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: currentRect() };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!drag || event.pointerId !== drag.pointerId) return;
                const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
                if (Math.abs(dx) + Math.abs(dy) < 4) return;
                resizeTo({ ...drag.rect, width: drag.rect.width + dx, height: drag.rect.height + dy });
              }}
              onPointerUp={(event) => {
                const moved = drag && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) >= 4;
                suppressResizeClick = !!moved;
                stopResize();
              }}
              onPointerCancel={stopResize} onLostPointerCapture={stopResize}>
              <Maximize2 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default Dialog;
