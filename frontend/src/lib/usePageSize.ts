import { createSignal } from 'solid-js';
import { readMigratedStorageValue, writeMigratedStorageValue } from './storage.ts';

/** Standard page-size choices offered in each table's paginator. */
export const PAGE_SIZE_OPTIONS = [10, 15, 20, 50, 100];
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Shared page size persisted in localStorage. The table key supports migration
 * from previously saved per-table preferences.
 */
export const usePageSize = (storageKey: string, defaultSize: number) => {
  const key = 'acs_page_size';
  const legacyKey = 'skyacs_page_size';

  const readStored = (): number => {
    try {
      const stored = readMigratedStorageValue(localStorage, key, legacyKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && PAGE_SIZE_OPTIONS.includes(parsed)) return parsed;
      }
      const perTableStored = localStorage.getItem(`acs_page_size_${storageKey}`) ?? localStorage.getItem(`skyacs_page_size_${storageKey}`);
      if (perTableStored) {
        const parsed = parseInt(perTableStored, 10);
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
