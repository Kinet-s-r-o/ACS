export interface DialogRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function fitDialogRect(rect: DialogRect, viewportWidth: number, viewportHeight: number, minimumWidth = 320): DialogRect {
  const padding = viewportWidth < 640 ? 8 : 16;
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const width = Math.min(availableWidth, Math.max(Math.min(minimumWidth, availableWidth), rect.width));
  const height = Math.min(availableHeight, Math.max(Math.min(180, availableHeight), rect.height));
  return {
    width, height,
    left: Math.max(padding, Math.min(rect.left, viewportWidth - padding - width)),
    top: Math.max(padding, Math.min(rect.top, viewportHeight - padding - height)),
  };
}
