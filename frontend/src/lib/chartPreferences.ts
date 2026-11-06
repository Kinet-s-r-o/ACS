export async function loadChartPreferences(fetchMeta: () => Promise<{ chart_show_points?: string; auto_refresh_interval?: string }>) {
  try {
    const meta = await fetchMeta();
    const interval = Number(meta.auto_refresh_interval ?? 30);
    return {
      showPoints: meta.chart_show_points !== 'false',
      autoRefreshInterval: Number.isInteger(interval) && (interval === 0 || (interval >= 15 && interval <= 3600)) ? interval : 30,
    };
  } catch {
    return { showPoints: true, autoRefreshInterval: 30 };
  }
}
