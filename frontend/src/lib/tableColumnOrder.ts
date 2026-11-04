export interface TableColumnOrder {
  id: string;
  fixed?: 'actions' | 'visibility';
}

export function orderTableColumns<T extends TableColumnOrder>(columns: T[], preference: string[]): T[] {
  const rank = new Map(preference.map((id, index) => [id, index]));
  const data = columns.filter(column => !column.fixed);
  data.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  return [...data, ...columns.filter(column => column.fixed === 'actions'), ...columns.filter(column => column.fixed === 'visibility')];
}
