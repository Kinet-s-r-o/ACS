const STORAGE_PREFIX = 'acs_table_column_order_';

interface ReorderableHeader {
  id: string;
  cell: HTMLTableCellElement;
  index: number;
}

interface DefaultColumnOrder {
  route: string;
  matches: string[];
  order: string[];
}

const DEFAULT_COLUMN_ORDERS: DefaultColumnOrder[] = [
  { route: '/settings/provisioning', matches: ['parameter pattern'], order: ['name', 'parameter pattern', 'source', 'group + color', 'active', 'type', 'unit scale', 'chart', 'transform', 'multiplier', 'actions'] },
  { route: '/settings/provisioning', matches: ['group'], order: ['name', 'parameter', 'source', 'group', 'active', 'device match', 'unit', 'actions'] },
  { route: '/settings/provisioning', matches: ['#'], order: ['#', 'cwmp path', 'active', 'phase', 'value type', 'value', 'tags', 'actions'] },
  { route: '/settings/users', matches: ['username'], order: ['username', 'first name', 'last name', 'email', 'required 2fa', 'authenticator', 'role', 'last login', 'actions'] },
  { route: '/settings/users', matches: ['permissions'], order: ['name', 'description', 'permissions', 'type', 'actions'] },
  { route: '/settings/dictionaries', matches: ['tag'], order: ['tag', 'description', 'color', 'actions'] },
  { route: '/security', matches: ['actor'], order: ['time', 'actor', 'action', 'resource', 'source', 'http status'] },
  { route: '/tasks', matches: ['created by'], order: ['serial number', 'type', 'status', 'created', 'created by', 'completed', 'deleted by', 'error', 'actions'] },
  { route: '/devices', matches: ['last inform'], order: ['serial number', 'manufacturer', 'model', 'product class', 'ip address', 'ppp username', 'rx power', 'uptime', 'status', 'last inform', 'tags'] },
  { route: '/devices', matches: ['serial number', 'mac address', 'type'], order: ['serial number', 'name', 'type', 'status', 'ip address', 'mac address'] },
  { route: '/device/:serial', matches: ['vlan'], order: ['name', 'adm. status', 'status', 'type', 'vlan', 'ip address', 'service', 'nat', 'l1', 'l2', 'l3', 'l4', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'actions'] },
  { route: '/device/:serial', matches: ['duplex', 'speed', 'l3'], order: ['name', 'adm. status', 'status', 'mac address', 'duplex', 'speed', 'l3', 'actions'] },
  { route: '/device/:serial', matches: ['ssid name', 'security', 'ch'], order: ['index', 'adm. status', 'status', 'ssid name', 'security', 'band', 'ch', 'max rate', 'password', 'actions'] },
  { route: '/device/:serial', matches: ['writable'], order: ['name', 'writable', 'value type', 'value'] },
  { route: '/device/:serial', matches: ['hostname'], order: ['hostname', 'ip address', 'mac address', 'interface', 'signal', 'neg. rate', 'uptime'] },
  { route: '/device/:serial', matches: ['created by'], order: ['type', 'status', 'created', 'created by', 'completed', 'deleted by', 'error', 'actions'] },
  { route: '/device/:serial', matches: ['severity'], order: ['time', 'severity', 'message'] },
];

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const stableHeading = (value: string) => normalize(value.replace(/\s*\(\s*[\d,.\s]+\s*\)\s*$/, ''));

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

const defaultOrder = (route: string, headers: ReorderableHeader[]) => {
  const normalizedRoute = route.replace(/^\/device\/[^/]+/, '/device/:serial');
  const labels = headers.map((header) => header.id.split('#')[0]);
  const config = DEFAULT_COLUMN_ORDERS.find((candidate) => candidate.route === normalizedRoute && candidate.matches.some((label) => labels.includes(label)));
  if (!config) return [];
  const preferred = config.order.flatMap((label) => headers.filter((header) => header.id.split('#')[0] === label).map((header) => header.id));
  return [...preferred, ...headers.filter((header) => !preferred.includes(header.id)).map((header) => header.id)];
};

const applyOrder = (table: HTMLTableElement, key: string, route: string) => {
  const headers = getHeaders(table);
  const order = readOrder(key);
  const desiredOrder = order.length ? order : defaultOrder(route, headers);
  if (headers.length < 2 || desiredOrder.length === 0) return;
  const rank = new Map(desiredOrder.map((id, index) => [id, index]));
  const desired = [...headers].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const slots = headers.map((header) => header.index);
  for (const row of Array.from(table.rows)) {
    if (row.cells.length !== table.tHead?.rows[0]?.cells.length || Array.from(row.cells).some((cell) => cell.colSpan !== 1)) continue;
    const cells = Array.from(row.cells);
    const taggedCells = new Map(cells.filter((cell) => cell.dataset.columnOrderId).map((cell) => [cell.dataset.columnOrderId!, cell]));
    const dataCells = new Map(headers.map((header) => [header.id, taggedCells.get(header.id) ?? cells[header.index]]));
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
  applyOrder(table, key, window.location.pathname);
};

const tableHeading = (table: HTMLTableElement) => table.closest('.card')?.querySelector('h1, h2, h3, h4')?.textContent || '';

const tableSchema = (table: HTMLTableElement) => getHeaders(table).map((header) => header.id.split('#')[0]).sort().join('|');

const makeTableKey = (table: HTMLTableElement, route: string, occurrence: number) => {
  const heading = stableHeading(tableHeading(table));
  const schema = tableSchema(table);
  const scope = `${heading || 'table'}::${schema || 'columns'}`;
  return `${route.replace(/^\/device\/[^/]+/, '/device/:serial')}::${scope}::${occurrence}`;
};

const makeLegacyTableKey = (table: HTMLTableElement, route: string, occurrence: number) => {
  const card = table.closest('.card');
  const title = card?.querySelector('h1, h2, h3, h4')?.textContent || '';
  const schema = tableSchema(table);
  const scope = normalize(title) || schema || 'table';
  return `${route.replace(/^\/device\/[^/]+/, '/device/:serial')}::${scope}::${occurrence}`;
};

const migrateStoredOrder = (key: string, legacyKey: string, route: string, heading: string, occurrence: number) => {
  try {
    const storageKey = `${STORAGE_PREFIX}${key}`;
    if (localStorage.getItem(storageKey)) return;
    let saved = localStorage.getItem(`${STORAGE_PREFIX}${legacyKey}`);
    if (!saved && heading) {
      const prefix = `${STORAGE_PREFIX}${route.replace(/^\/device\/[^/]+/, '/device/:serial')}::`;
      for (let index = 0; index < localStorage.length; index++) {
        const candidateKey = localStorage.key(index);
        if (!candidateKey?.startsWith(prefix)) continue;
        const parts = candidateKey.slice(prefix.length).split('::');
        if (parts.length < 2 || parts[parts.length - 1] !== String(occurrence) || stableHeading(parts.slice(0, -1).join('::')) !== heading) continue;
        saved = localStorage.getItem(candidateKey);
        if (saved) break;
      }
    }
    if (saved) localStorage.setItem(storageKey, saved);
  } catch { /* Browser storage can be unavailable. */ }
};

export const enableTableColumnReordering = (getRoute: () => string) => {
  const tableKeys = new WeakMap<HTMLTableElement, string>();
  let scheduled = false;
  let draggedTable: HTMLTableElement | null = null;

  const refresh = () => {
    const occurrences = new Map<string, number>();
    const route = getRoute();
    for (const table of Array.from(document.querySelectorAll<HTMLTableElement>('table.data-table'))) {
      const heading = stableHeading(tableHeading(table));
      const schema = tableSchema(table);
      const signature = `${heading || 'table'}::${schema || 'columns'}`;
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      if (!tableKeys.has(table)) {
        const key = makeTableKey(table, route, occurrence);
        migrateStoredOrder(key, makeLegacyTableKey(table, route, occurrence), route, heading, occurrence);
        tableKeys.set(table, key);
      }
      applyOrder(table, tableKeys.get(table)!, route);
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
