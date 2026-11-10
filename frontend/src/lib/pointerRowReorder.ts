import { startDragAutoScroll } from './dragAutoScroll.ts';

interface RowReorderCallbacks {
  onStart: () => void;
  onTarget: (id: number | null) => void;
  onDrop: (id: number) => void;
  onEnd: () => void;
}

export function startPointerRowReorder(initial: PointerEvent, handle: HTMLElement, callbacks: RowReorderCallbacks): () => void {
  const table = handle.closest('table');
  let x = initial.clientX;
  let y = initial.clientY;
  let active = false;
  let stopped = false;
  let stopScroll: (() => void) | undefined;
  const target = () => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('tr[data-row-reorder-id]');
    if (!row || row.closest('table') !== table) return null;
    const id = Number(row.dataset.rowReorderId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const refreshTarget = () => { if (active) callbacks.onTarget(target()); };
  const finish = (commit = false) => {
    if (stopped) return;
    stopped = true;
    const id = active && commit ? target() : null;
    stopScroll?.();
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', cancelPointer, true);
    document.removeEventListener('scroll', refreshTarget, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', cancel);
    handle.removeEventListener('lostpointercapture', cancelPointer);
    if (handle.hasPointerCapture(initial.pointerId)) handle.releasePointerCapture(initial.pointerId);
    callbacks.onEnd();
    if (id !== null) callbacks.onDrop(id);
  };
  const cancel = () => finish();
  const cancelPointer = (event: PointerEvent) => { if (event.pointerId === initial.pointerId) cancel(); };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== initial.pointerId) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    x = event.clientX;
    y = event.clientY;
    if (!active && Math.hypot(x - initial.clientX, y - initial.clientY) >= 4) {
      active = true;
      callbacks.onStart();
      stopScroll = startDragAutoScroll(event, handle);
    }
    refreshTarget();
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== initial.pointerId) return;
    x = event.clientX;
    y = event.clientY;
    finish(true);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  initial.preventDefault();
  handle.focus({ preventScroll: true });
  handle.setPointerCapture(initial.pointerId);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', cancelPointer, true);
  document.addEventListener('scroll', refreshTarget, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  handle.addEventListener('lostpointercapture', cancelPointer);
  return cancel;
}
