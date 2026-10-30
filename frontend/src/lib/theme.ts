import { createSignal } from 'solid-js';
export type ThemePreference = 'dark' | 'light' | 'system';
type ResolvedTheme = Exclude<ThemePreference, 'system'>;

const getInitialPreference = (): ThemePreference => {
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('acs-theme');
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch { /* Local storage may be unavailable. */ }
  }
  return 'system';
};

const resolveTheme = (preference: ThemePreference): ResolvedTheme => {
  if (preference !== 'system') return preference;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

const [themePreference, setThemePreferenceSignal] = createSignal<ThemePreference>(getInitialPreference());
const [theme, setThemeSignal] = createSignal<ResolvedTheme>(resolveTheme(themePreference()));

const applyTheme = (currentTheme: ResolvedTheme) => {
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentTheme === 'light' ? '#ebf2f9' : '#080f1a');
};

if (typeof document !== 'undefined') applyTheme(theme());

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
    if (themePreference() !== 'system') return;
    const nextTheme = event.matches ? 'light' : 'dark';
    setThemeSignal(nextTheme);
    applyTheme(nextTheme);
  });
}

const setTheme = (nextPreference: ThemePreference) => {
  setThemePreferenceSignal(nextPreference);
  try { localStorage.setItem('acs-theme', nextPreference); } catch { /* Local storage may be unavailable. */ }
  const nextTheme = resolveTheme(nextPreference);
  setThemeSignal(nextTheme);
  applyTheme(nextTheme);
};

export const useTheme = () => {
  return {
    theme,
    themePreference,
    setTheme,
    isDark: () => theme() === 'dark',
    isLight: () => theme() === 'light',
  };
};
