import type { Component } from 'solid-js';
import { Monitor, Moon, Sun } from 'lucide-solid';
import { useTheme, type ThemePreference } from '../lib/theme';

const ThemeSwitcher: Component = () => {
  const { themePreference, setTheme } = useTheme();
  const preferenceLabel = (preference: ThemePreference) => ({ dark: 'Dark', light: 'Light', system: 'System' })[preference];
  const nextPreference = () => {
    switch (themePreference()) {
      case 'dark': return 'light';
      case 'light': return 'system';
      case 'system': return 'dark';
    }
  };
  return (
    <button
      type="button"
      class="icon-button"
      aria-label={`Current theme ${preferenceLabel(themePreference())}. Switch to ${preferenceLabel(nextPreference())}`}
      title={`Current theme: ${preferenceLabel(themePreference())}. Switch to ${preferenceLabel(nextPreference())}`}
      onClick={() => setTheme(nextPreference())}
    >
      {nextPreference() === 'light' ? <Sun size={17} /> : nextPreference() === 'dark' ? <Moon size={17} /> : <Monitor size={17} />}
    </button>
  );
};

export default ThemeSwitcher;
