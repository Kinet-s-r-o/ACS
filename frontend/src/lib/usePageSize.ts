import { createSignal } from 'solid-js';
import { readMigratedStorageValue, writeMigratedStorageValue } from './storage.ts';

/** Standard page-size choices offered in each table's paginator. */
export const PAGE_SIZE_OPTIONS = [10, 15, 20, 50, 100];

/**
 * Per-table page size persisted in the browser's localStorage.
 * Each table passes a unique `storageKey` so its size is independent of the others.
 */
export const usePageSize = (storageKey: string, defaultSize: number) => {
  const key = `acs_page_size_${storageKey}`;
  const legacyKey = `skyacs_page_size_${storageKey}`;

  const readStored = (): number => {
    try {
      const stored = readMigratedStorageValue(localStorage, key, legacyKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && PAGE_SIZE_OPTIONS.includes(parsed)) return parsed;
      }
    } catch { /* ignore */ }
    return defaultSize;
  };

  const [pageSize, setPageSize] = createSignal<number>(readStored());

  const changePageSize = (size: number) => {
    setPageSize(size);
    writeMigratedStorageValue(localStorage, key, legacyKey, String(size));
  };

  return { pageSize, changePageSize, options: PAGE_SIZE_OPTIONS };
};
