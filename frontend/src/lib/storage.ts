import { createSignal } from 'solid-js';

export const createPersistedSignal = (key: string, initialValue = '') => {
  let savedValue = initialValue;
  try { savedValue = localStorage.getItem(key) ?? initialValue; } catch { /* Storage can be unavailable in private browsing. */ }
  const [value, setValue] = createSignal(savedValue);
  const setPersistedValue = (nextValue: string) => {
    setValue(nextValue);
    try { localStorage.setItem(key, nextValue); } catch { /* Storage can be unavailable in private browsing. */ }
  };
  return [value, setPersistedValue] as const;
};

export const readMigratedStorageValue = (storage: Storage, key: string, legacyKey: string): string | null => {
  try {
    const current = storage.getItem(key);
    if (current !== null) return current;
    const legacy = storage.getItem(legacyKey);
    if (legacy !== null) {
      storage.setItem(key, legacy);
      storage.removeItem(legacyKey);
    }
    return legacy;
  } catch {
    return null;
  }
};

export const writeMigratedStorageValue = (storage: Storage, key: string, legacyKey: string, value: string): void => {
  try {
    storage.setItem(key, value);
    storage.removeItem(legacyKey);
  } catch { /* Storage can be unavailable in private browsing. */ }
};

export const removeMigratedStorageValue = (storage: Storage, key: string, legacyKey: string): void => {
  try {
    storage.removeItem(key);
    storage.removeItem(legacyKey);
  } catch { /* Storage can be unavailable in private browsing. */ }
};
