const STORAGE_PREFIX = 'acs_table_column_order_';

interface ReorderableHeader {
  id: string;
  cell: HTMLTableCellElement;
  index: number;
}

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const headerLabel = (cell: HTMLTableCellElement) => {
  const sortableLabel = cell.querySelector<HTMLButtonElement>('button[aria-label^="Sort by "]')?.textContent;
  if (sortableLabel) return normalize(sortableLabel);
  const clone = cell.cloneNode(true) as HTMLTableCellElement;
  clone.querySelectorAll('.filter-dropdown, .filter-toggle, .column-toggle, [aria-hidden="true"]').forEach((element) => element.remove());
  return normalize(clone.textContent || '');
};

const getHeaders = (table: HTMLTableElement): ReorderableHeader[] => {
  const row = table.tHead?.rows[0];
  if (!row) return [];
  const occurrences = new Map<string, number>();
  return Array.from(row.cells).flatMap((cell, index) => {
    const label = headerLabel(cell);
    if (!label || cell.querySelector('.column-toggle')) return [];
    const occurrence = occurrences.get(label) ?? 0;
    occurrences.set(label, occurrence + 1);
    const id = `${label}#${occurrence}`;
    cell.dataset.columnOrderId = id;
    cell.draggable = true;
    cell.tabIndex = 0;
    cell.setAttribute('aria-description', 'Drag to reorder. Use Alt+Left or Alt+Right to move this column.');
    cell.title = 'Drag to reorder · Alt+←/→ to move';
    cell.classList.add('column-reorderable');
    return [{ id, cell, index }];
  });
};

const readOrder = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${key}`) || '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const applyOrder = (table: HTMLTableElement, key: string) => {
  const headers = getHeaders(table);
  const order = readOrder(key);
  if (headers.length < 2 || order.length === 0) return;
  const rank = new Map(order.map((id, index) => [id, index]));
  const desired = [...headers].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  if (desired.every((header, index) => header.id === headers[index].id)) return;

  const slots = headers.map((header) => header.index);
  for (const row of Array.from(table.rows)) {
    if (row.cells.length !== table.tHead?.rows[0]?.cells.length || Array.from(row.cells).some((cell) => cell.colSpan !== 1)) continue;
    const cells = Array.from(row.cells);
    const dataCells = new Map(headers.map((header) => [header.id, cells[header.index]]));
    const nextCells = [...cells];
    desired.forEach((header, index) => { nextCells[slots[index]] = dataCells.get(header.id)!; });
    if (nextCells.some((cell, index) => cell !== cells[index])) row.replaceChildren(...nextCells);
  }
};

const moveColumn = (table: HTMLTableElement, key: string, fromId: string, toId: string) => {
  const headers = getHeaders(table);
  const from = headers.findIndex((header) => header.id === fromId);
  const to = headers.findIndex((header) => header.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const next = headers.map((header) => header.id);
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const previous = readOrder(key);
  const complete = [...next, ...previous.filter((id) => !next.includes(id))];
  try { localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(complete)); } catch { /* Browser storage can be unavailable. */ }
  applyOrder(table, key);
};

const makeTableKey = (table: HTMLTableElement, route: string, occurrence: number) => {
  const card = table.closest('.card');
  const title = card?.querySelector('h1, h2, h3, h4')?.textContent || '';
  const schema = getHeaders(table).map((header) => header.id.split('#')[0]).sort().join('|');
  const scope = normalize(title) || schema || 'table';
  return `${route.replace(/^\/device\/[^/]+/, '/device/:serial')}::${scope}::${occurrence}`;
};

export const enableTableColumnReordering = (getRoute: () => string) => {
  const tableKeys = new WeakMap<HTMLTableElement, string>();
  let scheduled = false;
  let draggedTable: HTMLTableElement | null = null;

  const refresh = () => {
    const occurrences = new Map<string, number>();
    for (const table of Array.from(document.querySelectorAll<HTMLTableElement>('table.data-table'))) {
      const signature = normalize(table.closest('.card')?.querySelector('h1, h2, h3, h4')?.textContent || '')
        || getHeaders(table).map((header) => header.id.split('#')[0]).sort().join('|') || 'table';
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      if (!tableKeys.has(table)) tableKeys.set(table, makeTableKey(table, getRoute(), occurrence));
      applyOrder(table, tableKeys.get(table)!);
    }
  };

  const scheduleRefresh = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; refresh(); });
  };

  const headerFrom = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLTableCellElement>('th[data-column-order-id]') : null;
  const dragStart = (event: DragEvent) => {
    const header = headerFrom(event.target);
    const table = header?.closest<HTMLTableElement>('table.data-table');
    const key = table && tableKeys.get(table);
    if (!header || !table || !key) return;
    draggedTable = table;
    event.dataTransfer?.setData('text/plain', header.dataset.columnOrderId || '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    header.classList.add('is-column-dragging');
  };
  const dragOver = (event: DragEvent) => {
    const header = headerFrom(event.target);
    if (!header || !event.dataTransfer?.types.includes('text/plain')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const drop = (event: DragEvent) => {
    const header = headerFrom(event.target);
    const table = header?.closest<HTMLTableElement>('table.data-table');
    const key = table && tableKeys.get(table);
    const fromId = event.dataTransfer?.getData('text/plain');
    const toId = header?.dataset.columnOrderId;
    if (!table || table !== draggedTable || !key || !fromId || !toId || header?.closest('table') !== table) return;
    event.preventDefault();
    moveColumn(table, key, fromId, toId);
  };
  const dragEnd = () => {
    draggedTable = null;
    document.querySelectorAll('.is-column-dragging').forEach((cell) => cell.classList.remove('is-column-dragging'));
  };
  const keyDown = (event: KeyboardEvent) => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const header = headerFrom(event.target);
    const table = header?.closest<HTMLTableElement>('table.data-table');
    const key = table && tableKeys.get(table);
    if (!header || !table || !key) return;
    const headers = getHeaders(table);
    const index = headers.findIndex((column) => column.cell === header);
    const next = headers[index + (event.key === 'ArrowLeft' ? -1 : 1)];
    if (!next) return;
    event.preventDefault();
    moveColumn(table, key, header.dataset.columnOrderId || '', next.id);
    table.querySelector<HTMLTableCellElement>(`th[data-column-order-id="${CSS.escape(next.id)}"]`)?.focus();
  };

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('dragstart', dragStart);
  document.addEventListener('dragover', dragOver);
  document.addEventListener('drop', drop);
  document.addEventListener('dragend', dragEnd);
  document.addEventListener('keydown', keyDown);
  refresh();

  return () => {
    observer.disconnect();
    document.removeEventListener('dragstart', dragStart);
    document.removeEventListener('dragover', dragOver);
    document.removeEventListener('drop', drop);
    document.removeEventListener('dragend', dragEnd);
    document.removeEventListener('keydown', keyDown);
  };
};
