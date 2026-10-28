import { createSignal } from 'solid-js';
/** A single toggleable table column. */
export interface ColumnDef {
  id: string;
  label: string;
  visible: boolean;
}

/**
 * Read the stored visibility map for a table and merge it over the defaults.
 * Unknown stored ids are ignored; missing ids fall back to their default.
 */
const readStored = (key: string, defaults: ColumnDef[]): ColumnDef[] => {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnDef[];
      if (Array.isArray(parsed)) {
        return defaults.map((dc) => {
          const saved = parsed.find((p) => p.id === dc.id);
          return saved ? { ...dc, visible: saved.visible } : dc;
        });
      }
    }
  } catch { /* ignore malformed storage */ }
  return defaults.map((dc) => ({ ...dc }));
};

/**
 * Per-table column visibility persisted in the browser's localStorage.
 * Each table passes a unique `storageKey` so its layout is independent of the others.
 * `toggle` flips a column and persists immediately; `isVisible` is a reactive read.
 */
export const useColumnVisibility = (storageKey: string, defaults: ColumnDef[]) => {
  const key = `acs_columns_${storageKey}`;
  const [columns, setColumns] = createSignal<ColumnDef[]>(readStored(key, defaults));

  const toggle = (id: string) => {
    setColumns((cols) => {
      const next = cols.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c));
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage can be unavailable in private browsing. */ }
      return next;
    });
  };

  const isVisible = (id: string) => columns().find((c) => c.id === id)?.visible ?? false;

  return { columns, isVisible, toggle };
};
