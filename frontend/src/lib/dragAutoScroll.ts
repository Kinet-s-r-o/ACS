// Native drag events do not continuously fire while the pointer is stationary.
export function startDragAutoScroll(initial: DragEvent, source: HTMLElement): () => void {
  let x = initial.clientX;
  let y = initial.clientY;
  let frame = 0;
  let previous = 0;
  const containers: Element[] = [];
  for (let element: Element | null = source; element; element = element.parentElement) {
    containers.push(element);
  }
  const root = document.scrollingElement;
  if (root && !containers.includes(root)) containers.push(root);
  const scrollable = (element: Element) => element.scrollHeight > element.clientHeight
    && (element === root || /auto|scroll/.test(getComputedStyle(element).overflowY));
  const track = (event: DragEvent) => {
    x = event.clientX;
    y = event.clientY;
  };
  const tick = (time: number) => {
    const elapsed = previous ? Math.min(time - previous, 40) : 16;
    previous = time;
    for (const element of containers) {
      if (!scrollable(element)) continue;
      const bounds = element === root
        ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
        : element.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      if (bottom <= top || x < bounds.left || x > bounds.right) continue;
      // Retain the source scroller even when the pointer crosses its edge.
      const speed = dragScrollSpeed(Math.max(top, Math.min(y, bottom)), top, bottom);
      const before = element.scrollTop;
      element.scrollTop += speed * elapsed / 1000;
      if (element.scrollTop !== before) break;
    }
    frame = requestAnimationFrame(tick);
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || !event.deltaY) return;
    let remaining = event.deltaY;
    if (event.deltaMode === 1) remaining *= 16;
    if (event.deltaMode === 2) remaining *= containers.find(scrollable)?.clientHeight || window.innerHeight;
    let moved = false;
    for (const element of containers) {
      if (!scrollable(element)) continue;
      const before = element.scrollTop;
      element.scrollTop += remaining;
      const distance = element.scrollTop - before;
      moved ||= distance !== 0;
      remaining -= distance;
      if (Math.abs(remaining) < 1) break;
    }
    if (moved) event.preventDefault();
  };
  document.addEventListener('dragover', track, true);
  document.addEventListener('wheel', wheel, { capture: true, passive: false });
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('dragover', track, true);
    document.removeEventListener('wheel', wheel, true);
  };
}

export function dragScrollSpeed(y: number, top: number, bottom: number): number {
  const edge = Math.min(64, (bottom - top) / 3);
  if (edge <= 0 || y < top || y > bottom) return 0;
  if (y < top + edge) return -720 * (1 - (y - top) / edge);
  if (y > bottom - edge) return 720 * (1 - (bottom - y) / edge);
  return 0;
}
