const visible = (element: HTMLElement) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]');
const selectionScope = () => {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(visible);
  return dialogs.at(-1) ?? document.querySelector<HTMLElement>('main');
};

/** Reuse each table's select-all control so pagination and permissions stay authoritative. */
export const selectTableRecords = (event: KeyboardEvent) => {
  if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest('textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"]')) return;
  if (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type)) return;

  const scope = selectionScope();
  if (!scope) return;
  const focusedTable = target?.closest('table');
  const root = focusedTable && scope.contains(focusedTable) ? focusedTable : scope;
  const controls = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-table-select-all]')).filter(control => !control.disabled && visible(control));
  if (controls.length !== 1) return;
  event.preventDefault();
  if (!controls[0].checked) controls[0].click();
};

export const createTableRangeSelection = () => {
  const anchors = new WeakMap<HTMLTableElement, { control: HTMLInputElement; key: string }>();
  let applying = false;
  const rowControl = (target: EventTarget | null) => {
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox' || target.dataset.tableSelectRow === undefined || target.disabled || !visible(target)) return;
    const table = target.closest<HTMLTableElement>('table');
    if (!table || !selectionScope()?.contains(table)) return;
    return { target, table };
  };
  const applyRange = (target: HTMLInputElement, table: HTMLTableElement, checked: boolean, skipTarget: boolean) => {
    const controls = Array.from(table.querySelectorAll<HTMLInputElement>('input[data-table-select-row]'))
      .filter(control => !control.disabled && visible(control) && control.closest('table') === table);
    const anchor = anchors.get(table);
    const start = anchor && anchor.control.dataset.tableSelectRow === anchor.key ? controls.indexOf(anchor.control) : -1;
    const end = controls.indexOf(target);
    if (end < 0) return;
    const range = start < 0 ? [target] : controls.slice(Math.min(start, end), Math.max(start, end) + 1);
    applying = true;
    try {
      for (const control of range) {
        if ((!skipTarget || control !== target) && control.checked !== checked) control.click();
      }
    } finally {
      applying = false;
    }
    if (start < 0) anchors.set(table, { control: target, key: target.dataset.tableSelectRow! });
  };
  const click = (event: MouseEvent) => {
    if (applying || event.defaultPrevented) return;
    const row = rowControl(event.target);
    if (!row) {
      if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-table-select-all')) {
        const table = event.target.closest<HTMLTableElement>('table');
        if (table) anchors.delete(table);
      }
      return;
    }
    if (event.shiftKey) applyRange(row.target, row.table, row.target.checked, true);
    else anchors.set(row.table, { control: row.target, key: row.target.dataset.tableSelectRow! });
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== ' ' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const row = rowControl(event.target);
    if (!row) return;
    event.preventDefault();
    if (!event.repeat) applyRange(row.target, row.table, !row.target.checked, false);
  };
  return { click, keyDown };
};
