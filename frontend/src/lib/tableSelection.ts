/** Reuse each table's select-all control so pagination and permissions stay authoritative. */
export const selectTableRecords = (event: KeyboardEvent) => {
  if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest('textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"]')) return;
  if (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type)) return;

  const visible = (element: HTMLElement) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]');
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(visible);
  const scope = dialogs.at(-1) ?? document.querySelector<HTMLElement>('main');
  if (!scope) return;
  const focusedTable = target?.closest('table');
  const root = focusedTable && scope.contains(focusedTable) ? focusedTable : scope;
  const controls = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-table-select-all]')).filter(control => !control.disabled && visible(control));
  if (controls.length !== 1) return;
  event.preventDefault();
  if (!controls[0].checked) controls[0].click();
};
