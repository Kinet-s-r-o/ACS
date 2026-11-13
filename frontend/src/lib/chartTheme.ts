import { useTheme } from './theme';

export const useChartTheme = () => {
  const { theme } = useTheme();
  return () => {
    theme();
    const styles = getComputedStyle(document.documentElement);
    const color = (token: string) => `rgb(${styles.getPropertyValue(token).trim()})`;
    const text = color('--text-primary');
    const label = color('--text-muted');
    const border = color('--border-default');
    const surface = color('--bg-surface');
    return {
      text, label, border, surface,
      grid: color('--border-subtle'),
      track: color('--bg-elevated'),
      accent: color('--accent'),
      success: color('--success'),
      tooltip: { backgroundColor: surface, borderColor: border, textStyle: { color: text } },
    };
  };
};
