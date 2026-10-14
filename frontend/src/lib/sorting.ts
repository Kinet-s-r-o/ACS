export type SortDirection = 'asc' | 'desc';

export function sortRows<T>(rows: T[], key: string | null, direction: SortDirection, value: (row: T, key: string) => string | number | null | undefined): T[] {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const left = value(a, key);
    const right = value(b, key);
    const leftNumber = typeof left === 'number' ? left : typeof left === 'string' && /^\d{4}-\d{2}-\d{2}/.test(left) ? Date.parse(left) : NaN;
    const rightNumber = typeof right === 'number' ? right : typeof right === 'string' && /^\d{4}-\d{2}-\d{2}/.test(right) ? Date.parse(right) : NaN;
    const comparison = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      ? leftNumber - rightNumber
      : String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'asc' ? comparison : -comparison;
  });
}
