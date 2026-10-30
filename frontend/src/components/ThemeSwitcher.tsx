import type { Component } from 'solid-js';
import { useTheme, type ThemePreference } from '../lib/theme';

const ThemeSwitcher: Component = () => {
  const { themePreference, setTheme } = useTheme();

  return (
    <select
      class="input w-28!"
      aria-label="Color theme"
      title="Color theme"
      value={themePreference()}
      onChange={(event) => setTheme(event.currentTarget.value as ThemePreference)}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
};

export default ThemeSwitcher;
