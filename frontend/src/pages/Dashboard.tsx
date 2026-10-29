import type { Component } from 'solid-js';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { RefreshCw, Router, Settings2, Plus, Trash2 } from 'lucide-solid';
import PageHeader from '../components/PageHeader';
import { EmptyState, ResourceError } from '../components/ResourceState';
import Dialog from '../components/Dialog';
import { api, type DashboardPanelConfig, type DashboardThreshold, type DashboardThresholdColor, type DeviceGrowthInterval, type User } from '../lib/api';
import { useFeedback } from '../components/Feedback';
import { formatDateTime } from '../lib/dateTime';
import { useAuth } from '../lib/auth';
import DeviceGrowthChart from '../components/DeviceGrowthChart';

interface DistributionListProps {
  data: Record<string, number>;
  limit?: number;
  semantic?: boolean;
  colors?: Record<string, DashboardThresholdColor>;
}

interface DashboardPanelDraft extends Omit<DashboardPanelConfig, 'thresholds'> {
  thresholds: Array<Omit<DashboardThreshold, 'max'> & { max: string }>;
}

const thresholdColors: Array<{ id: DashboardThresholdColor; label: string }> = [
  { id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }, { id: 'amber', label: 'Amber' },
  { id: 'orange', label: 'Orange' }, { id: 'red', label: 'Red' }, { id: 'gray', label: 'Gray' },
];

const growthIntervals: Array<{ id: DeviceGrowthInterval; label: string }> = [
  { id: 'hourly', label: 'Hourly' }, { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' },
];

const defaultDashboardPanels: DashboardPanelConfig[] = [
  { id: 'uptime', title: 'Uptime', parameter_pattern: 'InternetGatewayDevice.*UpTime', thresholds: [
    { label: '< 1 hour', max: 3600, color: 'blue' }, { label: '1-24 hours', max: 86400, color: 'blue' },
    { label: '1-7 days', max: 604800, color: 'blue' }, { label: '1-30 days', max: 2592000, color: 'blue' }, { label: '> 1 month', max: null, color: 'blue' },
  ] },
  { id: 'temperature', title: 'Temperature', parameter_pattern: 'InternetGatewayDevice.*Temp*', thresholds: [
    { label: 'Normal (< 45)', max: 45, color: 'green' }, { label: 'Warm (45-55)', max: 55, color: 'amber' },
    { label: 'Hot (55-65)', max: 65, color: 'orange' }, { label: 'Critical (> 65)', max: null, color: 'red' },
  ] },
  { id: 'rxPower', title: 'Optical RX power', parameter_pattern: 'InternetGatewayDevice.*RxPower*', thresholds: [
    { label: 'Critical (< -29)', max: -29, color: 'red' }, { label: 'Poor (-29 to -25)', max: -25, color: 'orange' },
    { label: 'Normal (-25 to -23)', max: -23, color: 'amber' }, { label: 'Excellent (-23 to -15)', max: -15, color: 'green' }, { label: 'Above range (> -15)', max: null, color: 'blue' },
  ] },
];

const normalizeDashboardPanels = (panels: DashboardPanelConfig[]) => {
  const defaults = defaultDashboardPanels.map((fallback) => {
  const saved = Array.isArray(panels) ? panels.find((panel) => panel?.id === fallback.id) : undefined;
  return saved && Array.isArray(saved.thresholds) ? { ...fallback, ...saved, thresholds: saved.thresholds } : fallback;
  });
  const custom = Array.isArray(panels) ? panels.filter((panel) => panel?.id?.startsWith('custom-') && !defaultDashboardPanels.some((fallback) => fallback.id === panel.id)) : [];
  return [...defaults, ...custom];
};

const loadDashboardPanelConfigs = async (): Promise<DashboardPanelConfig[]> => {
  const remote = await api.getDashboardPanels();
  let legacyRaw: string | null = null;
  try { legacyRaw = localStorage.getItem('acs.dashboard.parameter-panels'); } catch { /* Local storage may be unavailable. */ }
  if (remote.length > 0 || !legacyRaw) {
    if (remote.length > 0) try { localStorage.removeItem('acs.dashboard.parameter-panels'); } catch { /* Ignore unavailable local storage. */ }
    return remote;
  }
  try {
    const legacy = JSON.parse(legacyRaw) as Array<Record<string, unknown>>;
    const converted = legacy.map((panel) => ({ ...panel, parameter_pattern: panel.parameter_pattern ?? panel.parameterPattern })) as DashboardPanelConfig[];
    const migrated = normalizeDashboardPanels(converted);
    const saved = await api.saveDashboardPanels(migrated);
    try { localStorage.removeItem('acs.dashboard.parameter-panels'); } catch { /* Ignore unavailable local storage. */ }
    return saved;
  } catch {
    return remote;
  }
};

const semanticTone = (label: string) => {
  const normalized = label.toLowerCase();
  if (normalized.includes('critical') || normalized.includes('poor')) return 'is-error';
  if (normalized.includes('warning') || normalized.includes('fair')) return 'is-warning';
  if (normalized.includes('good') || normalized.includes('normal') || normalized.includes('30 days')) return 'is-success';
  if (normalized.includes('unknown')) return 'is-muted';
  return '';
};

const DistributionList: Component<DistributionListProps> = (props) => {
  const entries = createMemo(() => Object.entries(props.data)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, props.limit ?? Number.POSITIVE_INFINITY));
  const maximum = createMemo(() => Math.max(...entries().map(([, value]) => value), 1));

  return (
    <Show when={entries().length > 0} fallback={<p class="py-5 text-center text-xs text-muted">No telemetry available.</p>}>
      <ul class="distribution-list">
        <For each={entries()}>{([label, value]) => (
          <li class="distribution-row">
            <span class="distribution-label" title={label}>{label}</span>
            <progress
              class={`distribution-progress ${props.colors?.[label] ? `distribution-progress-${props.colors[label]}` : ''} ${props.semantic ? semanticTone(label) : ''}`}
              value={value}
              max={maximum()}
              aria-label={`${label}: ${value}`}
            />
            <span class="distribution-value">{value.toLocaleString()}</span>
          </li>
        )}</For>
      </ul>
    </Show>
  );
};

const Dashboard: Component = () => {
  const { notify } = useFeedback();
  const { user, isFullAccess, hasPermission } = useAuth();
  const [savedPanelConfigs, { mutate: setSavedPanelConfigs }] = createResource(loadDashboardPanelConfigs);
  const panelConfigs = createMemo(() => normalizeDashboardPanels(savedPanelConfigs() ?? []));
  const [panelDraft, setPanelDraft] = createSignal<DashboardPanelDraft | null>(null);
  const [showCopyUsers, setShowCopyUsers] = createSignal(false);
  const [selectedRecipientIDs, setSelectedRecipientIDs] = createSignal<number[]>([]);
  const [savingPanel, setSavingPanel] = createSignal(false);
  const [growthInterval, setGrowthInterval] = createSignal<DeviceGrowthInterval>('daily');
  const [refreshKey, setRefreshKey] = createSignal(0);
  const canCopyPanels = () => isFullAccess() && hasPermission('users.read') && hasPermission('users.write');
  const [shareUsers] = createResource(showCopyUsers, (show) => show && canCopyPanels() ? api.getUsers() : Promise.resolve([] as User[]));
  const [dashboard, { refetch }] = createResource(async () => {
    const [stats, analytics] = await Promise.all([api.getDeviceStats(), api.getDeviceAnalytics()]);
    return { stats, analytics, fetchedAt: new Date() };
  });
  const [parameterDistributions] = createResource(panelConfigs, async (configs) => {
    const results = await Promise.all(configs.map(async (config) => {
      try {
        const result = await api.getDeviceParameterDistribution({
          parameter_pattern: config.parameter_pattern,
          thresholds: config.thresholds.map(({ label, max }) => ({ label, max })),
        });
        return [config.id, result.distribution] as const;
      } catch {
        return [config.id, {}] as const;
      }
    }));
    return Object.fromEntries(results) as Record<string, Record<string, number>>;
  });
  const stats = createMemo(() => dashboard()?.stats);
  const analytics = createMemo(() => dashboard()?.analytics);
  const onlinePercent = createMemo(() => {
    const total = stats()?.total ?? 0;
    return total > 0 ? Math.round(((stats()?.online ?? 0) / total) * 1000) / 10 : 0;
  });
  const panelDistribution = (id: DashboardPanelConfig['id']) => parameterDistributions()?.[id] ?? {};
  const panelColors = (config: DashboardPanelConfig) => Object.fromEntries([
    ...config.thresholds.map((threshold) => [threshold.label, threshold.color]), ['N/A', 'gray'],
  ]) as Record<string, DashboardThresholdColor>;
  const openPanelSettings = (config: DashboardPanelConfig) => {
    setShowCopyUsers(false);
    setSelectedRecipientIDs([]);
    setPanelDraft({ ...config, thresholds: config.thresholds.map((threshold) => ({ ...threshold, max: threshold.max === null ? '' : String(threshold.max) })) });
  };
  const addPanel = () => {
    if (panelConfigs().length >= 12) {
      notify({ tone: 'error', title: 'Panel limit reached', message: 'A maximum of 12 parameter panels can be shown on the dashboard.' });
      return;
    }
    const id = `custom-${crypto.randomUUID()}`;
    setShowCopyUsers(false);
    setSelectedRecipientIDs([]);
    setPanelDraft({
      id, title: 'New parameter', parameter_pattern: '',
      thresholds: [{ label: 'At most 0', max: '0', color: 'blue' }, { label: 'Above 0', max: '', color: 'gray' }],
    });
  };
  const refreshDashboard = () => { setRefreshKey((value) => value + 1); refetch(); };
  const closePanelSettings = () => { setPanelDraft(null); setShowCopyUsers(false); setSelectedRecipientIDs([]); };
  const updatePanelDraft = (update: (draft: DashboardPanelDraft) => DashboardPanelDraft) => setPanelDraft((draft) => draft ? update(draft) : draft);
  const updateThreshold = (index: number, field: 'label' | 'max', value: string) => updatePanelDraft((draft) => ({
    ...draft,
    thresholds: draft.thresholds.map((threshold, current) => current === index ? { ...threshold, [field]: value } : threshold),
  }));
  const updateThresholdColor = (index: number, value: DashboardThresholdColor) => updatePanelDraft((draft) => ({
    ...draft, thresholds: draft.thresholds.map((threshold, current) => current === index ? { ...threshold, color: value } : threshold),
  }));
  const addThreshold = () => updatePanelDraft((draft) => {
    const finite = draft.thresholds.filter((threshold) => threshold.max.trim() !== '').map((threshold) => Number(threshold.max));
    const max = finite.length ? String(finite[finite.length - 1] + 1) : '1';
    const next = [...draft.thresholds];
    next.splice(Math.max(0, next.length - 1), 0, { label: 'New threshold', max, color: 'blue' });
    return { ...draft, thresholds: next };
  });
  const removeThreshold = (index: number) => updatePanelDraft((draft) => {
    if (draft.thresholds.length <= 1) return draft;
    const next = draft.thresholds.filter((_, current) => current !== index);
    if (index === draft.thresholds.length - 1) next[next.length - 1] = { ...next[next.length - 1], max: '' };
    return { ...draft, thresholds: next };
  });
  const buildPanelConfig = (): DashboardPanelConfig | null => {
    const draft = panelDraft();
    if (!draft) return null;
    const title = draft.title.trim();
    const parameterPattern = draft.parameter_pattern.trim();
    if (!title || title.length > 48) {
      notify({ tone: 'error', title: 'Invalid panel name', message: 'Enter a panel name with up to 48 characters.' });
      return null;
    }
    if (!/^(InternetGatewayDevice|Device)\.[A-Za-z0-9_.*-]+$/.test(parameterPattern) || parameterPattern.length > 512) {
      notify({ tone: 'error', title: 'Invalid parameter pattern', message: 'Enter a Device. or InternetGatewayDevice. parameter path. Use * as a wildcard.' });
      return null;
    }
    if (draft.thresholds.length === 0 || draft.thresholds.length > 16) {
      notify({ tone: 'error', title: 'Invalid thresholds', message: 'Add between 1 and 16 threshold buckets.' });
      return null;
    }
    const thresholds: DashboardThreshold[] = [];
    let previousMax = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < draft.thresholds.length; index++) {
      const threshold = draft.thresholds[index];
      const label = threshold.label.trim();
      const max = threshold.max.trim() === '' ? null : Number(threshold.max);
      if (!label || label.length > 48 || label.toLowerCase() === 'n/a' || (max !== null && (!Number.isFinite(max) || max <= previousMax)) || (max === null && index !== draft.thresholds.length - 1)) {
        notify({ tone: 'error', title: 'Invalid thresholds', message: 'Threshold labels are required, maximums must increase, and only the last maximum can be empty.' });
        return null;
      }
      if (thresholds.some((saved) => saved.label.toLowerCase() === label.toLowerCase())) {
        notify({ tone: 'error', title: 'Duplicate threshold label', message: 'Use a different label for each threshold bucket.' });
        return null;
      }
      if (!thresholdColors.some((color) => color.id === threshold.color)) {
        notify({ tone: 'error', title: 'Invalid threshold color', message: 'Choose a supported color for each threshold.' });
        return null;
      }
      thresholds.push({ label, max, color: threshold.color });
      if (max !== null) previousMax = max;
    }
    if (thresholds[thresholds.length - 1].max !== null) {
      notify({ tone: 'error', title: 'Final threshold needs no maximum', message: 'Leave the last maximum empty so it catches all remaining values.' });
      return null;
    }
    return { id: draft.id, title, parameter_pattern: parameterPattern, thresholds };
  };
  const persistPanelConfig = async (next: DashboardPanelConfig, closeAfterSave: boolean) => {
    const current = normalizeDashboardPanels(savedPanelConfigs() ?? []);
    const panels = current.some((panel) => panel.id === next.id)
      ? current.map((panel) => panel.id === next.id ? next : panel)
      : [...current, next];
    setSavingPanel(true);
    try {
      const saved = await api.saveDashboardPanels(panels);
      setSavedPanelConfigs(saved);
      if (closeAfterSave) closePanelSettings();
      return true;
    } catch (error) {
      notify({ tone: 'error', title: 'Panel configuration was not saved', detail: (error as Error).message, persistent: true });
      return false;
    } finally {
      setSavingPanel(false);
    }
  };
  const savePanelSettings = async () => {
    const next = buildPanelConfig();
    if (next) await persistPanelConfig(next, true);
  };
  const toggleRecipient = (id: number) => setSelectedRecipientIDs((previous) => previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]);
  const copyPanelToRecipients = async () => {
    const next = buildPanelConfig();
    const recipientIDs = selectedRecipientIDs();
    if (!next || recipientIDs.length === 0) return;
    if (!await persistPanelConfig(next, false)) return;
    try {
      const result = await api.copyDashboardPanel(next, recipientIDs);
      notify({ tone: 'success', title: 'Panel copied', message: `Copied to ${result.copied_to} user${result.copied_to === 1 ? '' : 's'}.` });
      setShowCopyUsers(false);
      setSelectedRecipientIDs([]);
    } catch (error) {
      notify({ tone: 'error', title: 'Panel was saved but not copied', detail: (error as Error).message, persistent: true });
    }
  };
  return (
    <div class="space-y-4">
      <PageHeader
        title="Fleet status"
        description="Current fleet reachability, contact recency, health thresholds, and hardware mix."
        status={<span class="inline-flex items-center gap-2 text-[11px] text-muted"><span class="w-1.5 h-1.5 bg-emerald-500" aria-hidden="true" />{dashboard.loading ? 'Refreshing fleet data' : dashboard()?.fetchedAt ? `Updated ${formatDateTime(dashboard()!.fetchedAt)}` : 'Update unavailable'}</span>}
      >
        <button type="button" class="btn btn-secondary" onClick={refreshDashboard} disabled={dashboard.loading}><RefreshCw size={14} />Refresh fleet data</button>
      </PageHeader>

      <Show when={!dashboard.loading && !dashboard.error && (stats()?.total ?? 0) === 0}>
        <div class="data-panel"><EmptyState
          icon={<Router size={22} />}
          title="No CPEs have reported to ACS"
          description="The fleet register will populate after a device sends its first CWMP Inform. Verify the published CWMP endpoint and the CPE ACS URL."
          action={<A class="btn btn-secondary" href="/settings/delivery">Review CWMP connection settings</A>}
        /></div>
      </Show>

      <Show when={!dashboard.loading && !dashboard.error && (analytics()?.total ?? 0) > (analytics()?.sampled ?? 0)}>
        <div class="px-4 py-3 border border-amber-500/30 text-amber-400 text-xs">
          Analytics use the most recent {analytics()?.sampled.toLocaleString()} of {analytics()?.total.toLocaleString()} devices; fleet totals remain exact.
        </div>
      </Show>

      <Show when={dashboard.loading}>
        <div class="ops-register fleet-register" aria-label="Loading fleet status">
          <For each={[1, 2, 3, 4]}>{() => <div class="ops-register-cell"><div class="skeleton h-3 w-24" /><div class="skeleton h-7 w-16 mt-3" /><div class="skeleton h-2 w-32 mt-3" /></div>}</For>
        </div>
        <div class="data-panel"><div class="data-panel-body space-y-3"><div class="skeleton h-3 w-40" /><div class="skeleton h-5 w-full" /><div class="skeleton h-5 w-4/5" /></div></div>
      </Show>

      <Show when={dashboard.error}>
        <div class="data-panel"><ResourceError title="Fleet telemetry is unavailable" description="ACS could not read the current device statistics. Confirm the API and database are reachable, then retry." onRetry={() => refetch()} /></div>
      </Show>

      <Show when={!dashboard.loading && !dashboard.error && (stats()?.total ?? 0) > 0}>
        <dl class="ops-register fleet-register" aria-label="Fleet status register">
          <div class="ops-register-cell">
            <dt>Managed devices</dt>
            <dd>{(stats()?.total ?? 0).toLocaleString()}</dd>
            <small>Registered CPE inventory</small>
          </div>
          <div class="ops-register-cell is-online">
            <dt>Online</dt>
            <dd>{(stats()?.online ?? 0).toLocaleString()}</dd>
            <small>Reporting within threshold</small>
          </div>
          <div class="ops-register-cell is-offline">
            <dt>Offline</dt>
            <dd>{(stats()?.offline ?? 0).toLocaleString()}</dd>
            <small>Requires operator review</small>
          </div>
          <div class="ops-register-cell">
            <dt>Fleet availability</dt>
            <dd>{onlinePercent()}%</dd>
            <small>Online share of inventory</small>
          </div>
        </dl>

        <section class="data-panel">
          <div class="data-panel-header">
            <div><h2>Device growth</h2><p>Cumulative number of CPEs added to ACS, based on their registration time.</p></div>
            <div class="flex flex-wrap justify-end gap-1" role="group" aria-label="Device growth interval">
              <For each={growthIntervals}>{(option) => (
                <button
                  type="button"
                  class={`btn text-xs ${growthInterval() === option.id ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={growthInterval() === option.id}
                  onClick={() => setGrowthInterval(option.id)}
                >{option.label}</button>
              )}</For>
            </div>
          </div>
          <div class="data-panel-body"><DeviceGrowthChart interval={growthInterval()} refreshKey={refreshKey()} /></div>
        </section>

        <section class="data-panel">
          <div class="data-panel-header">
            <div><h2>Contact recency</h2><p>Time elapsed since the latest Inform received from each CPE.</p></div>
          </div>
          <div class="data-panel-body">
            <DistributionList data={analytics()?.lastInform ?? {}} semantic />
          </div>
        </section>

        <section class="data-panel">
          <div class="data-panel-header">
            <div><h2>Device health distributions</h2><p>Threshold buckets derived from the latest sampled parameter values.</p></div>
            <button type="button" class="icon-button dashboard-add-panel" aria-label="Add parameter panel" title={panelConfigs().length >= 12 ? 'Panel limit reached' : 'Add parameter panel'} disabled={panelConfigs().length >= 12 || savedPanelConfigs.loading} onClick={addPanel}><Plus size={15} /></button>
          </div>
          <div class="dashboard-health-grid">
            <For each={panelConfigs()}>{(config) => (
              <div class="data-panel-section">
                <div class="dashboard-configurable-heading">
                  <h3>{config.title}</h3>
                  <button type="button" class="icon-button" aria-label={`Configure ${config.title} panel`} title="Configure panel" disabled={savedPanelConfigs.loading} onClick={() => openPanelSettings(config)}><Settings2 size={14} /></button>
                </div>
                <DistributionList data={panelDistribution(config.id)} colors={panelColors(config)} />
              </div>
            )}</For>
          </div>
        </section>

        <section class="data-panel">
          <div class="data-panel-header">
            <div><h2>Inventory composition</h2><p>Access technology, manufacturer, and product-class concentration.</p></div>
          </div>
          <div class="inventory-grid">
            <div class="data-panel-section">
              <h3>Access type</h3>
              <DistributionList data={analytics()?.accessType ?? {}} limit={6} />
            </div>
            <div class="data-panel-section">
              <h3>Manufacturer</h3>
              <DistributionList data={analytics()?.manufacturers ?? {}} limit={6} />
            </div>
            <div class="data-panel-section">
              <h3>Product class</h3>
              <DistributionList data={analytics()?.productClasses ?? {}} limit={6} />
            </div>
          </div>
        </section>
      </Show>
      <Show when={panelDraft()}>
        <Dialog title={`Configure ${panelDraft()?.title || 'dashboard panel'}`} description="Set the panel name, CWMP parameter path, and ordered numeric thresholds with colors." size="large" onClose={closePanelSettings} actions={<><button type="button" class="btn btn-secondary" onClick={closePanelSettings}>Cancel</button><button type="button" class="btn btn-primary" disabled={savingPanel() || savedPanelConfigs.loading} onClick={() => void savePanelSettings()}>Save panel</button></>}>
          <div class="space-y-4">
            <label class="block text-xs text-muted">Panel name<input class="input mt-1 w-full" maxlength={48} value={panelDraft()?.title ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, title: event.currentTarget.value }))} /></label>
            <label class="block text-xs text-muted">Parameter path<input class="input mt-1 w-full font-mono" maxlength={512} value={panelDraft()?.parameter_pattern ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, parameter_pattern: event.currentTarget.value }))} placeholder="InternetGatewayDevice.DeviceInfo.UpTime" /><span class="mt-1 block">Use * to match dynamic path sections or parameter name variants.</span></label>
            <Show when={canCopyPanels()}>
              <section class="rounded border border-subtle p-3">
                <button type="button" class="btn btn-secondary text-xs" onClick={() => { setShowCopyUsers((value) => !value); setSelectedRecipientIDs([]); }} aria-expanded={showCopyUsers()}>Copy panel to users</button>
                <Show when={showCopyUsers()}>
                  <p class="mt-2 text-xs text-muted">Choose one or more users. Each gets an independent copy of this panel.</p>
                  <Show when={shareUsers.loading}><p class="py-3 text-xs text-muted">Loading users…</p></Show>
                  <Show when={shareUsers.error}><p class="py-3 text-xs text-rose-400">Could not load users.</p></Show>
                  <div class="mt-2 max-h-44 space-y-1 overflow-y-auto">
                    <For each={(shareUsers() ?? []).filter((recipient) => recipient.id !== user()?.id)}>{(recipient) => (
                      <label class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-primary hover:bg-elevated/50">
                        <input type="checkbox" checked={selectedRecipientIDs().includes(recipient.id)} onChange={() => toggleRecipient(recipient.id)} />
                        <span>{[recipient.first_name, recipient.last_name].filter(Boolean).join(' ') || recipient.username}</span>
                        <span class="ml-auto text-xs text-muted">{recipient.username}</span>
                      </label>
                    )}</For>
                  </div>
                  <button type="button" class="btn btn-primary mt-3 text-xs" disabled={savingPanel() || selectedRecipientIDs().length === 0} onClick={() => void copyPanelToRecipients()}>Copy to selected ({selectedRecipientIDs().length})</button>
                </Show>
              </section>
            </Show>
            <section aria-label="Thresholds">
              <div class="mb-2 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold text-primary">Thresholds and colors</h3><button type="button" class="btn btn-secondary text-xs" onClick={addThreshold}><Plus size={13} />Add threshold</button></div>
              <div class="space-y-2">
                <For each={panelDraft()?.thresholds ?? []}>{(threshold, index) => (
                  <div class="grid grid-cols-[minmax(0,1fr)_8rem_3.5rem_2rem] items-end gap-2">
                    <label class="block min-w-0 text-xs text-muted">Label<input class="input mt-1 w-full" maxlength={48} value={threshold.label} onInput={(event) => updateThreshold(index(), 'label', event.currentTarget.value)} /></label>
                    <label class="block text-xs text-muted">Maximum<input type="number" step="any" class="input mt-1 w-full" placeholder={index() === (panelDraft()?.thresholds.length ?? 1) - 1 ? 'No limit' : ''} value={threshold.max} onInput={(event) => updateThreshold(index(), 'max', event.currentTarget.value)} /></label>
                    <label class="block text-xs text-muted">Color<select class="input mt-1 w-full" value={threshold.color} aria-label={`Color for ${threshold.label}`} onChange={(event) => updateThresholdColor(index(), event.currentTarget.value as DashboardThresholdColor)}><For each={thresholdColors}>{(color) => <option value={color.id}>{color.label}</option>}</For></select></label>
                    <button type="button" class="icon-button text-rose-400" aria-label={`Remove threshold ${threshold.label}`} title="Remove threshold" disabled={(panelDraft()?.thresholds.length ?? 0) <= 1} onClick={() => removeThreshold(index())}><Trash2 size={14} /></button>
                  </div>
                )}</For>
              </div>
              <p class="mt-2 text-xs text-muted">Buckets are checked in order using value ≤ maximum. Leave the final maximum empty to include all remaining values; missing or nonnumeric values appear as N/A.</p>
            </section>
          </div>
        </Dialog>
      </Show>
    </div>
  );
};

export default Dashboard;
