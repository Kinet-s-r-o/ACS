import { createSignal } from 'solid-js';
import { readMigratedStorageValue, writeMigratedStorageValue } from './storage';

type Theme = 'dark' | 'light';

const getInitialTheme = (): Theme => {
  if (typeof window !== 'undefined') {
    const stored = readMigratedStorageValue(localStorage, 'acs-theme', 'skyacs-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  }
  return 'dark';
};

const [theme, setThemeSignal] = createSignal<Theme>(getInitialTheme());

const applyTheme = (currentTheme: Theme) => {
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentTheme === 'light' ? '#ebf2f9' : '#080f1a');
  writeMigratedStorageValue(localStorage, 'acs-theme', 'skyacs-theme', currentTheme);
};

if (typeof document !== 'undefined') applyTheme(theme());

const setTheme = (nextTheme: Theme) => {
  setThemeSignal(nextTheme);
  applyTheme(nextTheme);
};

export const useTheme = () => {
  return {
    theme,
    setTheme,
    toggleTheme: () => setTheme(theme() === 'dark' ? 'light' : 'dark'),
    isDark: () => theme() === 'dark',
    isLight: () => theme() === 'light',
  };
};
