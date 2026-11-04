export function floatingPanelPosition(
  anchor: { left: number; right: number; top: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const padding = 8;
  const gap = 4;
  const maxLeft = Math.max(padding, viewport.width - panel.width - padding);
  const maxTop = Math.max(padding, viewport.height - panel.height - padding);
  const below = anchor.bottom + gap;
  const preferredTop = below + panel.height <= viewport.height - padding ? below : anchor.top - panel.height - gap;
  return {
    left: Math.max(padding, Math.min(anchor.right - panel.width, maxLeft)),
    top: Math.max(padding, Math.min(preferredTop, maxTop)),
  };
}
