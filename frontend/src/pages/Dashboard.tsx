import { createMemo, createResource, createSignal, For, onCleanup, Show, type Component, type JSX } from 'solid-js';
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
import { createPersistedJsonSignal } from '../lib/storage';

interface DistributionListProps {
  data: Record<string, number>;
  limit?: number;
  semantic?: boolean;
  colors?: Record<string, DashboardThresholdColor>;
}

interface DashboardPanelDraft extends Omit<DashboardPanelConfig, 'thresholds'> {
  thresholds: Array<Omit<DashboardThreshold, 'max'> & { max: string }>;
}

interface FleetPanelLayout { order: number; width: number; height: number }
type FleetLayout = Record<string, FleetPanelLayout>;

const defaultFleetLayout: FleetLayout = {
  growth: { order: 0, width: 6, height: 2 }, contactRecency: { order: 1, width: 6, height: 2 },
  uptime: { order: 2, width: 4, height: 2 }, temperature: { order: 3, width: 4, height: 2 }, rxPower: { order: 4, width: 4, height: 2 },
  accessType: { order: 5, width: 4, height: 2 }, manufacturer: { order: 6, width: 4, height: 2 }, productClass: { order: 7, width: 4, height: 2 },
};

const FleetPanelFrame: Component<{
  id: string;
  layout: FleetPanelLayout;
  onMove: (source: string, target: string) => void;
  onResize: (id: string, width: number, height: number) => void;
  children: JSX.Element;
}> = (props) => {
  let startX = 0;
  let startY = 0;
  let startWidth = props.layout.width;
  let startHeight = props.layout.height;
  const resizeStart = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    startX = event.clientX; startY = event.clientY;
    startWidth = props.layout.width; startHeight = props.layout.height;
    const move = (current: PointerEvent) => props.onResize(props.id, Math.max(3, Math.min(12, startWidth + Math.round((current.clientX - startX) / 180))), Math.max(1, Math.min(5, startHeight + Math.round((current.clientY - startY) / 180))));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true });
  };
  return <div
    class="fleet-layout-panel"
    draggable
    style={`order:${props.layout.order};grid-column:span ${props.layout.width};grid-row:span ${props.layout.height}`}
    onDragStart={(event) => { event.dataTransfer?.setData('text/plain', props.id); event.dataTransfer!.effectAllowed = 'move'; }}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer?.getData('text/plain'); if (source && source !== props.id) props.onMove(source, props.id); }}
  >
    {props.children}
    <span class="fleet-panel-resize" role="button" tabIndex={0} aria-label="Resize panel" title="Drag to resize" onPointerDown={resizeStart} />
  </div>;
};

const thresholdColors: Array<{ id: DashboardThresholdColor; label: string }> = [
  { id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }, { id: 'amber', label: 'Amber' },
  { id: 'orange', label: 'Orange' }, { id: 'red', label: 'Red' }, { id: 'gray', label: 'Gray' },
];

const growthIntervals: Array<{ id: DeviceGrowthInterval; label: string }> = [
  { id: 'hourly', label: 'Hourly' }, { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' },
];

const defaultDashboardPanels: DashboardPanelConfig[] = [
  { id: 'contactRecency', title: 'Contact recency', kind: 'recency', source: 'last_inform', parameter_pattern: '', thresholds: [] },
  { id: 'accessType', title: 'Access type', kind: 'category', source: 'access_type', limit: 6, parameter_pattern: '', thresholds: [] },
  { id: 'manufacturer', title: 'Manufacturer', kind: 'category', source: 'manufacturer', limit: 6, parameter_pattern: '', thresholds: [] },
  { id: 'productClass', title: 'Product class', kind: 'category', source: 'product_class', limit: 6, parameter_pattern: '', thresholds: [] },
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

async function loadFleetData<T>(fetcher: () => Promise<T>) {
  try {
    return { data: await fetcher(), fetchedAt: new Date(), error: undefined };
  } catch (error) {
    return { data: undefined, fetchedAt: undefined, error: error instanceof Error ? error.message : 'The request failed. Retry loading the data.' };
  }
}

const ParameterDistribution: Component<{ config: DashboardPanelConfig; refreshKey: number }> = (props) => {
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  const [result, { refetch }] = createResource(
    () => ({ config: props.config, refreshKey: props.refreshKey }),
    ({ config }) => {
      controller?.abort();
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      return loadFleetData(() => api.getDeviceParameterDistribution({
        parameter_pattern: config.parameter_pattern,
        thresholds: config.thresholds.map(({ label, max }) => ({ label, max })),
      }, signal));
    },
  );
  const colors = () => Object.fromEntries([
    ...props.config.thresholds.map((threshold) => [threshold.label, threshold.color]), ['N/A', 'gray'],
  ]) as Record<string, DashboardThresholdColor>;
  return <Show when={!result.loading} fallback={<p class="py-4 text-xs text-muted" role="status">Loading distribution…</p>}>
    <Show when={!result()?.error} fallback={<ResourceError title="Distribution is unavailable" description={result()?.error ?? 'Retry loading this panel.'} onRetry={() => refetch()} />}>
      <DistributionList data={result()?.data?.distribution ?? {}} colors={colors()} />
    </Show>
  </Show>;
};

const Dashboard: Component = () => {
  const { notify } = useFeedback();
  const { user, isFullAccess, hasPermission } = useAuth();
  const [savedPanelConfigs, { mutate: setSavedPanelConfigs, refetch: refetchPanelConfigs }] = createResource(loadDashboardPanelConfigs);
  const panelConfigs = createMemo(() => normalizeDashboardPanels(savedPanelConfigs.error ? [] : savedPanelConfigs() ?? []));
  const [panelDraft, setPanelDraft] = createSignal<DashboardPanelDraft | null>(null);
  const [showCopyUsers, setShowCopyUsers] = createSignal(false);
  const [selectedRecipientIDs, setSelectedRecipientIDs] = createSignal<number[]>([]);
  const [savingPanel, setSavingPanel] = createSignal(false);
  const [growthInterval, setGrowthInterval] = createSignal<DeviceGrowthInterval>('daily');
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [fleetLayout, setFleetLayout] = createPersistedJsonSignal<FleetLayout>('acs.dashboard.fleet-layout', defaultFleetLayout);
  const canCopyPanels = () => isFullAccess() && hasPermission('users.read') && hasPermission('users.write');
  const [shareUsers] = createResource(showCopyUsers, (show) => show && canCopyPanels() ? api.getUsers() : Promise.resolve([] as User[]));
  const [dashboard, { refetch }] = createResource(() => loadFleetData(api.getDeviceStats));
  const [panelAnalytics, { refetch: refetchPanelAnalytics }] = createResource(
    () => savedPanelConfigs() ? normalizeDashboardPanels(savedPanelConfigs() ?? []) : undefined,
    (panels) => loadFleetData(() => api.getDashboardPanelAnalytics(panels)),
  );
  const stats = createMemo(() => dashboard()?.data);
  const onlinePercent = createMemo(() => {
    const total = stats()?.total ?? 0;
    return total > 0 ? Math.round(((stats()?.online ?? 0) / total) * 1000) / 10 : 0;
  });
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
  const refreshDashboard = () => { setRefreshKey((value) => value + 1); refetch(); refetchPanelAnalytics(); };
  const layoutFor = (id: string, fallbackOrder = 100): FleetPanelLayout => fleetLayout()[id] ?? { order: fallbackOrder, width: 4, height: 2 };
  const resizePanel = (id: string, width: number, height: number) => setFleetLayout((current) => ({ ...current, [id]: { ...layoutFor(id), width, height } }));
  const movePanel = (source: string, target: string) => setFleetLayout((current) => {
    const sourceLayout = current[source] ?? layoutFor(source);
    const targetLayout = current[target] ?? layoutFor(target);
    return { ...current, [source]: { ...sourceLayout, order: targetLayout.order }, [target]: { ...targetLayout, order: sourceLayout.order } };
  });
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
    const kind = draft.kind ?? 'parameter';
    const parameterPattern = draft.parameter_pattern.trim();
    if (!title || title.length > 48) {
      notify({ tone: 'error', title: 'Invalid panel name', message: 'Enter a panel name with up to 48 characters.' });
      return null;
    }
    if (kind !== 'parameter') {
      if (kind === 'category' && !['access_type', 'manufacturer', 'product_class'].includes(draft.source ?? '')) {
        notify({ tone: 'error', title: 'Invalid panel source', message: 'Choose a supported category source.' });
        return null;
      }
      if (kind === 'recency' && draft.source !== 'last_inform') {
        notify({ tone: 'error', title: 'Invalid panel source', message: 'Contact recency must use Last Inform.' });
        return null;
      }
      return { id: draft.id, title, kind, source: draft.source, limit: draft.limit ?? 6, parameter_pattern: '', thresholds: [] };
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
    return { id: draft.id, title, kind: 'parameter', parameter_pattern: parameterPattern, thresholds };
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
        status={<span class="inline-flex items-center gap-2 text-[11px] text-muted"><span class="w-1.5 h-1.5 bg-emerald-500" aria-hidden="true" />{dashboard.loading || panelAnalytics.loading ? 'Refreshing fleet data' : dashboard()?.fetchedAt ? `Updated ${formatDateTime(dashboard()!.fetchedAt)}` : 'Update unavailable'}</span>}
      >
        <button type="button" class="btn btn-secondary" onClick={refreshDashboard} disabled={dashboard.loading || panelAnalytics.loading}><RefreshCw size={14} />Refresh fleet data</button>
      </PageHeader>

      <Show when={!dashboard.loading && !dashboard()?.error && (stats()?.total ?? 0) === 0}>
        <div class="data-panel"><EmptyState
          icon={<Router size={22} />}
          title="No CPEs have reported to ACS"
          description="The fleet register will populate after a device sends its first CWMP Inform. Verify the published CWMP endpoint and the CPE ACS URL."
          action={<A class="btn btn-secondary" href="/settings/delivery">Review CWMP connection settings</A>}
        /></div>
      </Show>

      <Show when={dashboard.loading}>
        <div class="ops-register fleet-register" aria-label="Loading fleet status">
          <For each={[1, 2, 3, 4]}>{() => <div class="ops-register-cell"><div class="skeleton h-3 w-24" /><div class="skeleton h-7 w-16 mt-3" /><div class="skeleton h-2 w-32 mt-3" /></div>}</For>
        </div>
        <div class="data-panel"><div class="data-panel-body space-y-3"><div class="skeleton h-3 w-40" /><div class="skeleton h-5 w-full" /><div class="skeleton h-5 w-4/5" /></div></div>
      </Show>

      <Show when={dashboard()?.error}>
        <div class="data-panel"><ResourceError title="Fleet telemetry is unavailable" description="ACS could not read the current device statistics. Confirm the API and database are reachable, then retry." onRetry={() => refetch()} /></div>
      </Show>

      <Show when={(stats()?.total ?? 0) > 0}>
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

        <Show when={panelAnalytics.loading}><p class="text-xs text-muted" role="status">Loading fleet analytics…</p></Show>
        <Show when={panelAnalytics()?.error}>
          <div class="data-panel"><ResourceError title="Fleet analytics are unavailable" description={panelAnalytics()?.error ?? 'Retry loading fleet analytics.'} onRetry={() => refetchPanelAnalytics()} /></div>
        </Show>

        <div class="fleet-dashboard-grid" aria-label="Fleet dashboard panels">
        <FleetPanelFrame id="growth" layout={layoutFor('growth')} onMove={movePanel} onResize={resizePanel}>
        <section class="data-panel">
          <div class="data-panel-header">
            <div><h2>Device growth</h2><p>Active CPE count at the end of each period, including registrations and deletions.</p></div>
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
        </FleetPanelFrame>

        <Show when={panelAnalytics()?.data}><FleetPanelFrame id="contactRecency" layout={layoutFor('contactRecency')} onMove={movePanel} onResize={resizePanel}><section class="data-panel">
          <div class="data-panel-header">
            <div><h2>{panelConfigs().find((config) => config.id === 'contactRecency')?.title ?? 'Contact recency'}</h2><p>Time elapsed since the latest Inform received from each CPE.</p></div>
            <button type="button" class="icon-button" aria-label="Configure contact recency panel" title="Configure panel" onClick={() => { const config = panelConfigs().find((item) => item.id === 'contactRecency'); if (config) openPanelSettings(config); }}><Settings2 size={14} /></button>
          </div>
          <div class="data-panel-body">
            <Show when={panelAnalytics()?.data?.panels.contactRecency} fallback={<p class="text-xs text-muted">Loading distribution…</p>}>
              <DistributionList data={panelAnalytics()!.data!.panels.contactRecency} semantic />
            </Show>
          </div>
        </section></FleetPanelFrame></Show>

        <section class="fleet-panel-health-group">
          <div class="data-panel-header">
            <div><h2>Device health distributions</h2><p>Threshold buckets derived from the latest sampled parameter values.</p></div>
            <button type="button" class="icon-button dashboard-add-panel" aria-label="Add parameter panel" title={panelConfigs().length >= 12 ? 'Panel limit reached' : 'Add parameter panel'} disabled={panelConfigs().length >= 12 || savedPanelConfigs.loading} onClick={addPanel}><Plus size={15} /></button>
          </div>
          <Show when={savedPanelConfigs.loading}><p class="data-panel-body text-xs text-muted" role="status">Loading panel settings…</p></Show>
          <Show when={savedPanelConfigs.error}><ResourceError title="Panel settings are unavailable" description="Retry loading the saved dashboard panels." onRetry={() => refetchPanelConfigs()} /></Show>
          <Show when={!savedPanelConfigs.loading && !savedPanelConfigs.error}>
          <div class="dashboard-health-grid">
            <For each={panelConfigs().filter((config) => (config.kind ?? 'parameter') === 'parameter')}>{(config, index) => (
              <FleetPanelFrame id={config.id} layout={layoutFor(config.id, 8 + index())} onMove={movePanel} onResize={resizePanel}>
              <section class="data-panel fleet-content-panel">
                <div class="dashboard-configurable-heading">
                  <h3>{config.title}</h3>
                  <button type="button" class="icon-button" aria-label={`Configure ${config.title} panel`} title="Configure panel" disabled={savedPanelConfigs.loading} onClick={() => openPanelSettings(config)}><Settings2 size={14} /></button>
                </div>
                <div class="data-panel-body"><ParameterDistribution config={config} refreshKey={refreshKey()} /></div>
              </section>
              </FleetPanelFrame>
            )}</For>
          </div>
          </Show>
        </section>

        <Show when={panelAnalytics()?.data}><section class="fleet-panel-inventory-group">
          <div class="data-panel-header">
            <div><h2>Inventory composition</h2><p>Access technology, manufacturer, and product-class concentration.</p></div>
          </div>
          <div class="inventory-grid">
            <FleetPanelFrame id="accessType" layout={layoutFor('accessType')} onMove={movePanel} onResize={resizePanel}><div class="data-panel data-panel-section fleet-content-panel">
              <div class="dashboard-configurable-heading"><h3>{panelConfigs().find((config) => config.id === 'accessType')?.title ?? 'Access type'}</h3><button type="button" class="icon-button" aria-label="Configure access type panel" title="Configure panel" onClick={() => { const config = panelConfigs().find((item) => item.id === 'accessType'); if (config) openPanelSettings(config); }}><Settings2 size={14} /></button></div>
              <DistributionList data={panelAnalytics()!.data!.panels.accessType ?? {}} limit={panelConfigs().find((config) => config.id === 'accessType')?.limit ?? 6} />
            </div></FleetPanelFrame>
            <FleetPanelFrame id="manufacturer" layout={layoutFor('manufacturer')} onMove={movePanel} onResize={resizePanel}><div class="data-panel data-panel-section fleet-content-panel">
              <div class="dashboard-configurable-heading"><h3>{panelConfigs().find((config) => config.id === 'manufacturer')?.title ?? 'Manufacturer'}</h3><button type="button" class="icon-button" aria-label="Configure manufacturer panel" title="Configure panel" onClick={() => { const config = panelConfigs().find((item) => item.id === 'manufacturer'); if (config) openPanelSettings(config); }}><Settings2 size={14} /></button></div>
              <DistributionList data={panelAnalytics()!.data!.panels.manufacturer ?? {}} limit={panelConfigs().find((config) => config.id === 'manufacturer')?.limit ?? 6} />
            </div></FleetPanelFrame>
            <FleetPanelFrame id="productClass" layout={layoutFor('productClass')} onMove={movePanel} onResize={resizePanel}><div class="data-panel data-panel-section fleet-content-panel">
              <div class="dashboard-configurable-heading"><h3>{panelConfigs().find((config) => config.id === 'productClass')?.title ?? 'Product class'}</h3><button type="button" class="icon-button" aria-label="Configure product class panel" title="Configure panel" onClick={() => { const config = panelConfigs().find((item) => item.id === 'productClass'); if (config) openPanelSettings(config); }}><Settings2 size={14} /></button></div>
              <DistributionList data={panelAnalytics()!.data!.panels.productClass ?? {}} limit={panelConfigs().find((config) => config.id === 'productClass')?.limit ?? 6} />
            </div></FleetPanelFrame>
          </div>
        </section></Show>
        </div>
      </Show>
      <Show when={panelDraft()}>
        <Dialog title={`Configure ${panelDraft()?.title || 'dashboard panel'}`} description="Set the panel name, CWMP parameter path, and ordered numeric thresholds with colors." size="large" onClose={closePanelSettings} actions={<><button type="button" class="btn btn-secondary" onClick={closePanelSettings}>Cancel</button><button type="button" class="btn btn-primary" disabled={savingPanel() || savedPanelConfigs.loading} onClick={() => void savePanelSettings()}>Save panel</button></>}>
          <div class="space-y-4">
            <label class="block text-xs text-muted">Panel name<input class="input mt-1 w-full" maxlength={48} value={panelDraft()?.title ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, title: event.currentTarget.value }))} /></label>
            <Show when={(panelDraft()?.kind ?? 'parameter') === 'parameter'}>
              <label class="block text-xs text-muted">Parameter path<input class="input mt-1 w-full font-mono" maxlength={512} value={panelDraft()?.parameter_pattern ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, parameter_pattern: event.currentTarget.value }))} placeholder="InternetGatewayDevice.DeviceInfo.UpTime" /><span class="mt-1 block">Use * to match dynamic path sections or parameter name variants.</span></label>
            </Show>
            <Show when={(panelDraft()?.kind ?? 'parameter') !== 'parameter'}>
              <label class="block text-xs text-muted">Aggregation source<select class="input mt-1 w-full" value={panelDraft()?.source ?? ''} onChange={(event) => updatePanelDraft((draft) => ({ ...draft, source: event.currentTarget.value as DashboardPanelConfig['source'] }))}>
                <Show when={panelDraft()?.kind === 'category'}><option value="access_type">Access type</option><option value="manufacturer">Manufacturer</option><option value="product_class">Product class</option></Show>
                <Show when={panelDraft()?.kind === 'recency'}><option value="last_inform">Last Inform</option></Show>
              </select><span class="mt-1 block">Values are grouped and counted by the SQL backend.</span></label>
              <Show when={panelDraft()?.kind === 'category'}>
                <label class="block text-xs text-muted">Maximum categories<input type="number" min="1" max="100" class="input mt-1 w-full" value={panelDraft()?.limit ?? 6} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, limit: Number(event.currentTarget.value) }))} /></label>
              </Show>
            </Show>
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
            <Show when={(panelDraft()?.kind ?? 'parameter') === 'parameter'}><section aria-label="Thresholds">
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
            </section></Show>
          </div>
        </Dialog>
      </Show>
    </div>
  );
};

export default Dashboard;
