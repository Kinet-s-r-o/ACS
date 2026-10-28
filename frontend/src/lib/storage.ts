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
export const createPersistedJsonSignal = <T>(key: string, initialValue: T) => {
  let savedValue = initialValue;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) savedValue = JSON.parse(raw) as T;
  } catch { /* Storage can be unavailable or contain malformed data. */ }

  const [value, setValue] = createSignal<T>(savedValue);
  const setPersistedValue = (nextValue: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof nextValue === 'function'
        ? (nextValue as (previous: T) => T)(previous)
        : nextValue;
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* Storage can be unavailable in private browsing. */ }
      return resolved;
    });
  };
  return [value, setPersistedValue] as const;
};
