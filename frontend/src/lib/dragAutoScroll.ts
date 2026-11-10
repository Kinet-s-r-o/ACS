// Native drag events do not continuously fire while the pointer is stationary.
export function startDragAutoScroll(initial: DragEvent): () => void {
  let x = initial.clientX;
  let y = initial.clientY;
  let frame = 0;
  let previous = 0;
  const track = (event: DragEvent) => {
    x = event.clientX;
    y = event.clientY;
  };
  const tick = (time: number) => {
    const elapsed = previous ? Math.min(time - previous, 40) : 16;
    previous = time;
    let element = document.elementFromPoint(x, y);
    while (element) {
      const root = element === document.scrollingElement;
      const bounds = root ? { top: 0, bottom: window.innerHeight } : element.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const overflow = getComputedStyle(element).overflowY;
      if (element.scrollHeight > element.clientHeight && (root || /auto|scroll/.test(overflow))) {
        const speed = dragScrollSpeed(y, top, bottom);
        const before = element.scrollTop;
        element.scrollTop += speed * elapsed / 1000;
        if (element.scrollTop !== before) break;
      }
      element = element.parentElement;
    }
    frame = requestAnimationFrame(tick);
  };
  document.addEventListener('dragover', track, true);
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('dragover', track, true);
  };
}

export function dragScrollSpeed(y: number, top: number, bottom: number): number {
  const edge = Math.min(64, (bottom - top) / 3);
  if (edge <= 0 || y < top || y > bottom) return 0;
  if (y < top + edge) return -720 * (1 - (y - top) / edge);
  if (y > bottom - edge) return 720 * (1 - (bottom - y) / edge);
  return 0;
}
