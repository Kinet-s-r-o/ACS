import { createEffect, createMemo, createResource, createSignal, For, Index, onCleanup, onMount, Show, type Component, type JSX } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { RefreshCw, Router, Settings2, Plus, Trash2, GripVertical, MoreVertical } from 'lucide-solid';
import { EmptyState, ResourceError } from '../components/ResourceState';
import Dialog from '../components/Dialog';
import { api, type DashboardAggregationOption, type DashboardPanelConfig, type DashboardPanelLayout, type DashboardThreshold, type DashboardThresholdColor, type DeviceGrowthInterval, type User } from '../lib/api';
import { useFeedback } from '../components/Feedback';
import { formatDateTime } from '../lib/dateTime';
import { useAuth } from '../lib/auth';
import DeviceGrowthChart from '../components/DeviceGrowthChart';
import ColorSwatch from '../components/ColorSwatch';

interface DistributionListProps {
  data: Record<string, number>;
  limit?: number;
  colors?: Record<string, DashboardThresholdColor>;
  order?: string[];
  sortByCount?: boolean;
  sortDirection?: 'asc' | 'desc';
  excludeNA?: boolean;
}

interface DashboardPanelDraft extends Omit<DashboardPanelConfig, 'thresholds'> {
  thresholds: Array<Omit<DashboardThreshold, 'max'> & { max: string }>;
}

type FleetPanelLayout = DashboardPanelLayout;
type FleetLayout = Record<string, FleetPanelLayout>;
const defaultFleetLayout: FleetLayout = {
  growth: { order: 0, width: 60, height: 2, interval: 'daily' },
};



const normalizeFleetLayout = (layout: FleetLayout): FleetLayout => Object.fromEntries(
  Object.entries(layout).filter((entry): entry is [string, FleetPanelLayout] => {
    const item = entry[1] as FleetPanelLayout | undefined;
    return (entry[0] === 'growth' || /^custom-[a-zA-Z0-9-]{1,64}$/.test(entry[0])) && !!item && Number.isFinite(item.order) && Number.isFinite(item.width) && Number.isFinite(item.height);
  }).map(([id, item]) => [id, {
    ...item,
    width: Math.max(30, Math.min(120, item.width <= 12 ? item.width * 10 : item.width)),
    height: item.height > 5 ? item.height : 0,
  }]),
);



const readUserFleetLayout = (userID: string): FleetLayout => {
  try {
    const saved = localStorage.getItem(`acs.dashboard.fleet-layout:${userID}`);
    if (!saved) return defaultFleetLayout;
    const parsed: unknown = JSON.parse(saved);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as FleetLayout : defaultFleetLayout;
  } catch { return defaultFleetLayout; }
};

const FleetPanelFrame: Component<{
  id: string;
  layout: FleetPanelLayout;
  editable?: boolean;
  onMove: (source: string, target: string, after: boolean) => void;
  onResize?: (id: string, width: number, height?: number) => void;
  children: JSX.Element;
}> = (props) => {
  const [dragging, setDragging] = createSignal(false);
  const [panelHeight, setPanelHeight] = createSignal(0);
  let shell!: HTMLDivElement;
  onMount(() => {
    const observer = new ResizeObserver(() => setPanelHeight(shell.getBoundingClientRect().height));
    observer.observe(shell);
    setPanelHeight(shell.getBoundingClientRect().height);
    onCleanup(() => observer.disconnect());
  });
  let startWidth = props.layout.width <= 12 ? props.layout.width * 10 : props.layout.width;
  const resizeStart = (event: PointerEvent, axis: 'x' | 'y') => {
    if (!props.onResize) return;
    event.preventDefault();
    event.stopPropagation();
    const startPointer = axis === 'x' ? event.clientX : event.clientY;
    startWidth = axis === 'x' ? (props.layout.width <= 12 ? props.layout.width * 10 : props.layout.width) : ((event.currentTarget as HTMLElement).closest('.fleet-panel-shell')?.getBoundingClientRect().height ?? 0);
    const grid = (event.currentTarget as HTMLElement).closest('.fleet-dashboard-grid');
    const columnStep = grid ? grid.getBoundingClientRect().width / 120 : 10;
    let currentWidth = startWidth;
    grid?.classList.add('is-resizing');
    const move = (current: PointerEvent) => {
      const delta = (axis === 'x' ? current.clientX : current.clientY) - startPointer;
      currentWidth = axis === 'x' ? Math.max(30, Math.min(120, startWidth + delta / Math.max(1, columnStep))) : Math.max(80, startWidth + delta);
      if (axis === 'x') props.onResize?.(props.id, currentWidth);
      else props.onResize?.(props.id, props.layout.width, currentWidth);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      grid?.classList.remove('is-resizing');
      if (axis === 'x') props.onResize?.(props.id, Math.max(30, Math.min(120, Math.round(currentWidth))));
      else props.onResize?.(props.id, props.layout.width, Math.max(80, Math.round(currentWidth / 12) * 12));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
  };
  const dragStart = (event: PointerEvent) => {
    if (!props.editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
    const source = (event.currentTarget as HTMLElement).closest<HTMLElement>('.fleet-layout-panel');
    if (!source) return;
    const rect = source.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.classList.add('fleet-panel-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      margin: '0', zIndex: '10000', pointerEvents: 'none', opacity: '.92', boxShadow: '0 14px 36px rgb(0 0 0 / .38)',
      transform: 'none', transition: 'none',
    });
    document.body.append(ghost);
    let previousPosition = '';
    const move = (current: PointerEvent) => {
      ghost.style.left = `${current.clientX - offsetX}px`;
      ghost.style.top = `${current.clientY - offsetY}px`;
      const grid = source.closest('.fleet-dashboard-grid');
      const hit = document.elementFromPoint(current.clientX, current.clientY);
      const hitPanel = hit?.closest<HTMLElement>('.fleet-layout-panel');
      let target = hitPanel && hitPanel !== source ? hitPanel : null;
      if (!hitPanel && grid && hit && grid.contains(hit)) {
        const candidates = Array.from(grid.querySelectorAll<HTMLElement>('.fleet-layout-panel')).filter((panel) => panel !== source);
        target = candidates.reduce<HTMLElement | null>((closest, panel) => {
          if (!closest) return panel;
          const distance = (candidate: HTMLElement) => {
            const bounds = candidate.getBoundingClientRect();
            const dx = Math.max(bounds.left - current.clientX, 0, current.clientX - bounds.right);
            const dy = Math.max(bounds.top - current.clientY, 0, current.clientY - bounds.bottom);
            return dx * dx + dy * dy;
          };
          return distance(panel) < distance(closest) ? panel : closest;
        }, null);
      }
      const targetID = target?.dataset.fleetPanelId ?? '';
      const after = target ? current.clientX >= target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2 : false;
      const position = targetID ? `${targetID}:${after}` : '';
      document.querySelectorAll('.fleet-layout-panel.is-drop-target').forEach((panel) => panel.classList.remove('is-drop-target'));
      if (targetID && target) {
        target.classList.add('is-drop-target');
        if (position !== previousPosition) props.onMove(props.id, targetID, after);
      }
      previousPosition = position;
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      ghost.remove();
      document.querySelectorAll('.fleet-layout-panel.is-drop-target').forEach((panel) => panel.classList.remove('is-drop-target'));
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
  };
  const width = () => Math.max(30, Math.min(120, props.layout.width <= 12 ? props.layout.width * 10 : props.layout.width));
  const occupiedColumns = () => Math.ceil(width());
  const occupiedRows = () => Math.max(1, Math.ceil((panelHeight() + 16) / 8));
  const savedHeight = () => props.layout.height > 5 ? props.layout.height : 0;
  return <div
    class={`fleet-layout-panel ${dragging() ? 'is-dragging' : ''}`}
    data-fleet-panel-id={props.id}
    data-dynamic-style
    style={`order:${props.layout.order};grid-column:span ${occupiedColumns()};grid-row:span ${occupiedRows()};width:calc(${(width() / occupiedColumns()) * 100}% - var(--fleet-grid-line));--fleet-panel-height:${savedHeight()}px`}
  >
    <div class="fleet-panel-shell" ref={shell}>
      {props.children}
      <Show when={props.editable}><button type="button" class="fleet-panel-drag-handle" aria-label="Move panel" title="Drag to move panel" onPointerDown={dragStart}><GripVertical size={14} aria-hidden="true" /></button></Show>
      <Show when={props.onResize}><button type="button" class="fleet-panel-resize-x" aria-label="Resize panel width" title="Drag right edge to resize width" onPointerDown={(event) => resizeStart(event, 'x')} />
      <button type="button" class="fleet-panel-resize-y" aria-label="Resize panel height" title="Drag bottom edge to resize height" onPointerDown={(event) => resizeStart(event, 'y')} /></Show>
    </div>
  </div>;
};

const legacyThresholdColorHex: Record<string, string> = {
  blue: '#0ea5e9', green: '#22c55e', amber: '#f59e0b', orange: '#f97316', red: '#ef4444', gray: '#94a3b8',
};
const isDashboardThresholdColor = (color: string): color is DashboardThresholdColor =>
  Object.hasOwn(legacyThresholdColorHex, color) || /^#[0-9a-fA-F]{6}$/.test(color);

const growthIntervals: Array<{ id: DeviceGrowthInterval; label: string }> = [
  { id: 'hourly', label: 'Hourly' }, { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' },
];

const normalizeDashboardPanels = (panels: DashboardPanelConfig[]) => Array.isArray(panels)
  ? panels.filter((panel) => /^custom-[a-zA-Z0-9-]{1,64}$/.test(panel.id) && (!panel.kind || panel.kind === 'parameter' || panel.kind === 'category'))
  : [];

const loadDashboardPanelConfigs = async (): Promise<DashboardPanelConfig[]> => {
  try { localStorage.removeItem('acs.dashboard.parameter-panels'); } catch { /* Local storage may be unavailable. */ }
  return normalizeDashboardPanels(await api.getDashboardPanels());
};

const DistributionList: Component<DistributionListProps> = (props) => {
  const entries = createMemo(() => {
    const order = new Map((props.order ?? []).map((label, index) => [label, index]));
    return Object.entries(props.data)
      .filter(([label, value]) => value > 0 && !(props.excludeNA && label === 'N/A'))
      .sort((a, b) => {
        if (props.sortByCount ?? true) return props.sortDirection === 'asc' ? a[1] - b[1] : b[1] - a[1];
        return (order.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (order.get(b[0]) ?? Number.MAX_SAFE_INTEGER);
      })
      .slice(0, props.limit ?? Number.POSITIVE_INFINITY);
  });
  const maximum = createMemo(() => Math.max(...entries().map(([, value]) => value), 1));

  return (
    <Show when={entries().length > 0} fallback={<p class="py-5 text-center text-xs text-muted">No telemetry available.</p>}>
      <ul class="distribution-list">
        <For each={entries()}>{([label, value]) => (
          <li class="distribution-row">
            <span class="distribution-label" title={label}>{label}</span>
            <progress
              class={`distribution-progress ${legacyThresholdColorHex[props.colors?.[label] ?? ''] ? `distribution-progress-${props.colors?.[label]}` : ''}`}
              data-dynamic-style={props.colors?.[label]?.startsWith('#') ? 'distribution-progress-color' : undefined}
              style={props.colors?.[label]?.startsWith('#') ? { '--distribution-progress-color': props.colors[label] } as any : undefined}
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
      <DistributionList
        data={result()?.data?.distribution ?? {}}
        colors={colors()}
        order={props.config.thresholds.map((threshold, index) => ({ label: threshold.label, order: threshold.order ?? index })).sort((a, b) => a.order - b.order).map(({ label }) => label)}
        sortByCount={props.config.sort_by_count ?? true}
        sortDirection={props.config.sort_direction ?? 'desc'}
        excludeNA={props.config.exclude_na ?? false}
      />
    </Show>
  </Show>;
};

const Dashboard: Component = () => {
  const { confirm, notify } = useFeedback();
  const { user, isFullAccess, hasPermission, can } = useAuth();
  const [searchParams] = useSearchParams();
  const dashboardTargetUserID = () => {
    const id = Number(searchParams.dashboardUserId);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  };
  const targetDashboardKey = () => dashboardTargetUserID() ?? 0;
  const managingOtherDashboard = () => targetDashboardKey() > 0;
  const targetDashboardName = () => typeof searchParams.dashboardUserName === 'string' ? searchParams.dashboardUserName : `user #${targetDashboardKey()}`;
  const canAddPanel = () => managingOtherDashboard() ? can('settings.users', 'write') : can('fleet', 'add');
  const canEditPanel = () => managingOtherDashboard() ? can('settings.users', 'write') : can('fleet', 'edit');
  const canRemovePanel = () => managingOtherDashboard() ? can('settings.users', 'write') : can('fleet', 'delete');
  const existingDraft = () => panelConfigs().some(panel => panel.id === panelDraft()?.id);
  const canSaveDraft = () => existingDraft() ? canEditPanel() : canAddPanel();

  const [savedPanelConfigs, { mutate: setSavedPanelConfigs, refetch: refetchPanelConfigs }] = createResource(targetDashboardKey, (targetID) => targetID ? api.getUserDashboardPanels(targetID) : loadDashboardPanelConfigs());
  const [loadedAggregationOptions] = createResource(api.getDashboardAggregationOptions);
  const aggregationOptions = (): DashboardAggregationOption[] => loadedAggregationOptions() ?? [];
  const panelConfigs = createMemo(() => normalizeDashboardPanels(savedPanelConfigs.error ? [] : savedPanelConfigs() ?? []));
  const [panelDraft, setPanelDraft] = createSignal<DashboardPanelDraft | null>(null);
  const [showCopyUsers, setShowCopyUsers] = createSignal(false);
  const [selectedRecipientIDs, setSelectedRecipientIDs] = createSignal<number[]>([]);
  const [savingPanel, setSavingPanel] = createSignal(false);
  const [showPanelActionsMenu, setShowPanelActionsMenu] = createSignal(false);
  let panelActionsMenu: HTMLDivElement | undefined;
  const growthInterval = () => {
    const interval = fleetLayout().growth?.interval;
    return growthIntervals.some(({ id }) => id === interval) ? interval as DeviceGrowthInterval : 'daily';
  };
  const [refreshKey, setRefreshKey] = createSignal(0);
  const userID = user()?.id ?? 'unknown';
  const [fleetLayout, setFleetLayout] = createSignal<FleetLayout>(readUserFleetLayout(String(userID)));
  const [savedFleetLayout] = createResource(targetDashboardKey, (targetID) => targetID ? api.getUserDashboardLayout(targetID) : api.getDashboardLayout());
  const [fleetLayoutReady, setFleetLayoutReady] = createSignal(false);
  createEffect(() => {
    targetDashboardKey();
    setFleetLayoutReady(false);
  });
  createEffect(() => {
    const remote = savedFleetLayout();
    if (savedFleetLayout.loading || savedFleetLayout.error || !remote) return;
    const initial = Object.keys(remote).length > 0 ? { ...defaultFleetLayout, ...remote } : managingOtherDashboard() ? { ...defaultFleetLayout } : { ...defaultFleetLayout, ...readUserFleetLayout(String(userID)) };
    if (!growthIntervals.some(({ id }) => id === initial.growth?.interval)) {
      initial.growth = { ...defaultFleetLayout.growth, ...initial.growth, interval: 'daily' };
    }
    setFleetLayout(normalizeFleetLayout(initial));
    setFleetLayoutReady(true);
    try { localStorage.removeItem('acs.dashboard.fleet-layout'); } catch { /* Ignore unavailable local storage. */ }
  });
  createEffect(() => {
    if (!fleetLayoutReady() || !canEditPanel()) return;
    const snapshot = normalizeFleetLayout(fleetLayout());
    const timer = window.setTimeout(() => {
      const targetID = dashboardTargetUserID();
      const save = targetID ? api.saveUserDashboardLayout(targetID, snapshot) : api.saveDashboardLayout(snapshot);
      void save.then(() => {
        if (!targetID) try {
          localStorage.setItem(`acs.dashboard.fleet-layout:${userID}`, JSON.stringify(snapshot));
          localStorage.removeItem('acs.dashboard.growth-interval');
        } catch { /* Storage can be unavailable in private browsing. */ }
      }).catch((error) => notify({ tone: 'error', title: 'Dashboard layout was not synced', detail: (error as Error).message }));
    }, 500);
    onCleanup(() => window.clearTimeout(timer));
  });
  const canCopyPanels = () => !managingOtherDashboard() && isFullAccess() && hasPermission('users.read') && hasPermission('users.write');
  const [shareUsers] = createResource(showCopyUsers, (show) => show && canCopyPanels() ? api.getUsers() : Promise.resolve([] as User[]));
  const [dashboard, { refetch }] = createResource(() => loadFleetData(api.getDeviceStats));
  const analyticsPanels = createMemo(() => panelConfigs().filter((panel) => !panel.hidden && panel.kind === 'category'));
  const [panelAnalytics, { refetch: refetchPanelAnalytics }] = createResource(
    () => !savedPanelConfigs.loading && !savedPanelConfigs.error && analyticsPanels().length > 0 ? analyticsPanels() : undefined,
    (panels) => loadFleetData(() => api.getDashboardPanelAnalytics(panels)),
  );
  const renderAnalytics = (id: string, options: Omit<DistributionListProps, 'data'> = {}) => (
    <Show when={!panelAnalytics.loading} fallback={<p class="py-4 text-xs text-muted" role="status">Loading distribution…</p>}>
      <Show when={!panelAnalytics()?.error} fallback={<ResourceError title="Distribution is unavailable" description="ACS could not load this panel's data. Retry the request." onRetry={() => refetchPanelAnalytics()} />}>
        <DistributionList data={panelAnalytics()?.data?.panels[id] ?? {}} {...options} />
      </Show>
    </Show>
  );
  const stats = createMemo(() => dashboard()?.data);
  const onlinePercent = createMemo(() => {
    const total = stats()?.total ?? 0;
    return total > 0 ? Math.round(((stats()?.online ?? 0) / total) * 1000) / 10 : 0;
  });
  const categoryPanelEntries = () => {
    return analyticsPanels().filter((config) => config.kind === 'category').map((config) => ({
      id: config.id, label: config.title, limit: config.limit ?? 6,
    }));
  };
  const savePanelConfigs = (panels: DashboardPanelConfig[]) => {
    const targetID = dashboardTargetUserID();
    return targetID ? api.saveUserDashboardPanels(targetID, panels) : api.saveDashboardPanels(panels);
  };
  const openPanelSettings = (config: DashboardPanelConfig) => {
    setShowCopyUsers(false);
    setSelectedRecipientIDs([]);
    const thresholds = config.thresholds.map((threshold, index) => ({ ...threshold, order: threshold.order ?? index, max: threshold.max === null ? '' : String(threshold.max) }));
    setPanelDraft({ ...config, sort_by_count: config.sort_by_count ?? true, sort_direction: config.sort_direction ?? 'desc', thresholds: thresholds.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) });
  };
  const addPanel = () => {
    if (!canAddPanel()) return;
    if (panelConfigs().length >= 12) {
      notify({ tone: 'error', title: 'Panel limit reached', message: 'A maximum of 12 user panels can be shown on the dashboard.' });
      return;
    }
    const id = `custom-${crypto.randomUUID()}`;
    setShowCopyUsers(false);
    setSelectedRecipientIDs([]);
    setPanelDraft({
      id, title: 'New panel', parameter_pattern: '', sort_by_count: false, sort_direction: 'desc', exclude_na: false,
      thresholds: [{ label: 'At most 0', max: '0', color: 'blue' }, { label: 'Above 0', max: '', color: 'gray' }],
    });
  };
  const refreshDashboard = () => { setRefreshKey((value) => value + 1); refetch(); if (analyticsPanels().length > 0) refetchPanelAnalytics(); };
  onMount(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!panelActionsMenu?.contains(event.target as Node)) setShowPanelActionsMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowPanelActionsMenu(false);
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    onCleanup(() => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    });
  });
  const layoutFor = (id: string, fallbackOrder = 100): FleetPanelLayout => {
    const saved = fleetLayout()[id] ?? { order: fallbackOrder, width: 40, height: 2 };
    if (id === 'growth') return { order: saved.order, width: 60, height: 2 };
    return { ...saved, width: Math.max(30, Math.min(120, saved.width <= 12 ? saved.width * 10 : saved.width)), height: saved.height > 5 ? saved.height : 0 };
  };
  const panelFallbackOrder = (id: string) => Math.max(1, panelConfigs().findIndex((panel) => panel.id === id) + 1);
  const resizePanel = (id: string, width: number, height?: number) => setFleetLayout((current) => {
    const saved = current[id] ?? layoutFor(id);
    return { ...current, [id]: { ...saved, width, ...(height === undefined ? {} : { height }) } };
  });
  const movePanel = (source: string, target: string, after: boolean) => setFleetLayout((current) => {
    const layouts: FleetLayout = { ...defaultFleetLayout, ...current };
    panelConfigs().forEach((panel, index) => {
      if (!layouts[panel.id]) layouts[panel.id] = layoutFor(panel.id, 2 + index);
    });
    if (!layouts[source]) layouts[source] = layoutFor(source);
    if (!layouts[target]) layouts[target] = layoutFor(target);
    const ordered = Object.entries(layouts).sort((a, b) => a[1].order - b[1].order);
    const sourceEntry = ordered.findIndex(([id]) => id === source);
    const [moving] = ordered.splice(sourceEntry, 1);
    const targetIndex = ordered.findIndex(([id]) => id === target);
    ordered.splice(Math.max(0, targetIndex + (after ? 1 : 0)), 0, moving);
    return Object.fromEntries(ordered.map(([id, layout], order) => [id, { ...layout, order }])) as FleetLayout;
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
  const moveThreshold = (from: number, to: number) => updatePanelDraft((draft) => {
    if (from === to || from < 0 || to < 0 || from >= draft.thresholds.length || to >= draft.thresholds.length) return draft;
    const thresholds = [...draft.thresholds];
    const [moving] = thresholds.splice(from, 1);
    thresholds.splice(to, 0, moving);
    return { ...draft, thresholds: thresholds.map((threshold, order) => ({ ...threshold, order })) };
  });
  const addThreshold = () => updatePanelDraft((draft) => {
    const finite = draft.thresholds.filter((threshold) => threshold.max.trim() !== '').map((threshold) => Number(threshold.max));
    const max = finite.length ? String(Math.max(...finite) + 1) : '1';
    const next = [...draft.thresholds];
    const unboundedIndex = next.findIndex((threshold) => threshold.max.trim() === '');
    next.splice(unboundedIndex < 0 ? next.length : unboundedIndex, 0, { label: 'New threshold', max, color: 'blue' });
    return { ...draft, thresholds: next.map((threshold, order) => ({ ...threshold, order })) };
  });
  const removeThreshold = (index: number) => updatePanelDraft((draft) => {
    if (draft.thresholds.length <= 1) return draft;
    const next = draft.thresholds.filter((_, current) => current !== index);
    if (draft.thresholds[index].max.trim() === '') {
      const highest = next.reduce((best, threshold, current) => Number(threshold.max) > Number(next[best].max) ? current : best, 0);
      next[highest] = { ...next[highest], max: '' };
    }
    return { ...draft, thresholds: next.map((threshold, order) => ({ ...threshold, order })) };
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
      if (kind === 'category' && !['configured_option', 'custom_parameter', 'access_type', 'manufacturer', 'product_class'].includes(draft.source ?? '')) {
        notify({ tone: 'error', title: 'Invalid panel source', message: 'Choose a supported category source.' });
        return null;
      }
      if (kind === 'category' && draft.source === 'configured_option' && (!draft.aggregation_option_id || !aggregationOptions().some((option) => option.id === draft.aggregation_option_id))) {
        notify({ tone: 'error', title: 'Invalid aggregation option', message: 'Choose an aggregation source currently configured by an administrator.' });
        return null;
      }
      if (kind === 'category' && draft.source === 'custom_parameter' && (!/^(InternetGatewayDevice|Device)\.[A-Za-z0-9_.*-]+$/.test(draft.parameter_pattern.trim()) || draft.parameter_pattern.length > 512)) {
        notify({ tone: 'error', title: 'Invalid parameter path', message: 'Enter a Device. or InternetGatewayDevice. parameter path. Use * for dynamic path sections.' });
        return null;
      }

      if (draft.source === 'custom_parameter') {
        return { id: draft.id, title, kind, source: 'custom_parameter', parameter_pattern: draft.parameter_pattern.trim(), limit: draft.limit ?? 6, thresholds: [] };
      }
      const aggregationOptionID = draft.source === 'configured_option' ? draft.aggregation_option_id : undefined;
      const configuredOption = aggregationOptions().find((option) => option.id === aggregationOptionID);
      return {
        id: draft.id, title, kind,
        source: configuredOption ? 'configured_option' : draft.source,
        aggregation_option_id: aggregationOptionID,
        limit: draft.limit ?? 6,
        parameter_pattern: configuredOption?.source === 'parameter' ? configuredOption.parameter_pattern : '',
        thresholds: [],
      };
    }
    if (!/^(InternetGatewayDevice|Device)\.[A-Za-z0-9_.*-]+$/.test(parameterPattern) || parameterPattern.length > 512) {
      notify({ tone: 'error', title: 'Invalid parameter pattern', message: 'Enter a Device. or InternetGatewayDevice. parameter path. Use * as a wildcard.' });
      return null;
    }
    if (draft.thresholds.length === 0 || draft.thresholds.length > 16) {
      notify({ tone: 'error', title: 'Invalid thresholds', message: 'Add between 1 and 16 threshold buckets.' });
      return null;
    }
    const thresholdsInDisplayOrder: DashboardThreshold[] = [];
    for (let index = 0; index < draft.thresholds.length; index++) {
      const threshold = draft.thresholds[index];
      const label = threshold.label.trim();
      const max = threshold.max.trim() === '' ? null : Number(threshold.max);
      if (!label || label.length > 48 || label.toLowerCase() === 'n/a' || max !== null && !Number.isFinite(max)) {
        notify({ tone: 'error', title: 'Invalid thresholds', message: 'Threshold labels are required and maximums must be finite numbers.' });
        return null;
      }
      if (thresholdsInDisplayOrder.some((saved) => saved.label.toLowerCase() === label.toLowerCase())) {
        notify({ tone: 'error', title: 'Duplicate threshold label', message: 'Use a different label for each threshold bucket.' });
        return null;
      }
      if (!isDashboardThresholdColor(threshold.color)) {
        notify({ tone: 'error', title: 'Invalid threshold color', message: 'Choose a supported color for each threshold.' });
        return null;
      }
      thresholdsInDisplayOrder.push({ label, max, color: threshold.color, order: index });
    }
    const thresholds = [...thresholdsInDisplayOrder].sort((a, b) => a.max === null ? 1 : b.max === null ? -1 : a.max - b.max);
    const invalidMaximumOrder = thresholds.some((threshold, index) => {
      const previous = thresholds[index - 1];
      return !!previous && threshold.max !== null && previous.max !== null && threshold.max <= previous.max;
    });
    if (thresholds.filter((threshold) => threshold.max === null).length !== 1 || invalidMaximumOrder) {
      notify({ tone: 'error', title: 'Invalid thresholds', message: 'Use unique maximum values and leave one final bucket without a maximum.' });
      return null;
    }
    if (thresholds[thresholds.length - 1].max !== null) {
      notify({ tone: 'error', title: 'Final threshold needs no maximum', message: 'Leave the last maximum empty so it catches all remaining values.' });
      return null;
    }
    return {
      id: draft.id, title, kind: 'parameter', parameter_pattern: parameterPattern, thresholds,
      sort_by_count: draft.sort_by_count ?? false, sort_direction: draft.sort_direction ?? 'desc', exclude_na: draft.exclude_na ?? false,
    };
  };
  const persistPanelConfig = async (next: DashboardPanelConfig, closeAfterSave: boolean) => {
    const current = normalizeDashboardPanels(savedPanelConfigs() ?? []);
    const panels = current.some((panel) => panel.id === next.id)
      ? current.map((panel) => panel.id === next.id ? next : panel)
      : [...current, next];
    setSavingPanel(true);
    try {
      const saved = await savePanelConfigs(panels);
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
    if (!canSaveDraft()) return;
    const next = buildPanelConfig();
    if (next) await persistPanelConfig(next, true);
  };
  const deletePanel = async () => {
    if (!canRemovePanel() || !existingDraft()) return;
    const panel = panelDraft();
    const isCustom = panel !== null;
    if (!panel) return;
    if (!await confirm({
      title: `Remove “${panel.title}” panel?`,
      description: 'This removes the panel and its saved layout from your Fleet dashboard. Copies already shared with other users stay on their dashboards.',
      confirmLabel: 'Remove panel',
      tone: 'danger',
    })) return;
    setSavingPanel(true);
    try {
      const panels = normalizeDashboardPanels(savedPanelConfigs() ?? []).filter((item) => item.id !== panel.id);
      const saved = await savePanelConfigs(panels);
      setSavedPanelConfigs(saved);
      setFleetLayout((current) => {
          const next = { ...current };
          delete next[panel.id];
          return next;
        });
      closePanelSettings();
      notify({ tone: 'success', title: isCustom ? 'Custom panel removed' : 'Built-in panel hidden', message: `“${panel.title}” is no longer shown on your Fleet dashboard.` });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not remove panel', message: 'The panel remains on your Fleet dashboard.', detail: (error as Error).message, persistent: true });
    } finally {
      setSavingPanel(false);
    }
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
      <header aria-label="Fleet dashboard actions" class="flex min-h-0 flex-wrap items-center justify-between gap-3 border-b border-subtle pb-2">
        <Show when={managingOtherDashboard()}>
          <div class="flex flex-wrap items-center gap-3" role="status">
            <span class="text-sm font-medium text-primary">Editing Fleet dashboard for {targetDashboardName()}</span>
            <A class="btn btn-secondary text-xs" href="/settings/users">Back to users</A>
          </div>
        </Show>
        <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span class="inline-flex items-center gap-2 text-[11px] text-muted"><span class="w-1.5 h-1.5 bg-emerald-500" aria-hidden="true" />{dashboard.loading || panelAnalytics.loading ? 'Refreshing fleet data' : dashboard()?.fetchedAt ? `Updated ${formatDateTime(dashboard()!.fetchedAt)}` : 'Update unavailable'}</span>
          <button type="button" class="icon-button" onClick={refreshDashboard} disabled={dashboard.loading || panelAnalytics.loading} aria-label="Refresh fleet data" title="Refresh fleet data"><RefreshCw size={16} /></button>
          <Show when={canAddPanel()}><div class="relative" ref={panelActionsMenu}>
            <button type="button" class="icon-button" aria-label="Fleet panel actions" aria-haspopup="menu" aria-expanded={showPanelActionsMenu()} onClick={() => setShowPanelActionsMenu((visible) => !visible)}>
              <MoreVertical size={18} />
            </button>
            <Show when={showPanelActionsMenu()}>
              <div class="absolute right-0 top-full z-50 mt-2 min-w-48 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu">
                <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-primary hover:bg-base disabled:opacity-50" onClick={() => { setShowPanelActionsMenu(false); addPanel(); }} disabled={panelConfigs().length >= 12 || savedPanelConfigs.loading}>
                  <Plus size={14} />Add panel
                </button>
              </div>
            </Show>
          </div></Show>
        </div>
      </header>

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
            <small>{stats()?.waiting ? `${stats()!.waiting} waiting for first Inform` : 'Registered CPE inventory'}</small>
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

        <div class="fleet-dashboard-grid" aria-label="Fleet dashboard panels">
        <FleetPanelFrame id="growth" layout={layoutFor('growth')} editable={canEditPanel()} onMove={movePanel}>
        <section class="data-panel fleet-content-panel">
          <div class="data-panel-header">
            <div><h2>Device growth</h2><p>Active CPE count at the end of each period, including registrations and deletions.</p></div>
            <div class="flex flex-wrap justify-end gap-1" role="group" aria-label="Device growth interval">
              <For each={growthIntervals}>{(option) => (
                <button
                  type="button"
                  class={`btn text-xs ${growthInterval() === option.id ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={growthInterval() === option.id}
                  onClick={() => setFleetLayout((current) => ({ ...current, growth: { ...defaultFleetLayout.growth, ...current.growth, interval: option.id } }))}
                >{option.label}</button>
              )}</For>
            </div>
          </div>
          <div class="data-panel-body"><DeviceGrowthChart interval={growthInterval()} refreshKey={refreshKey()} /></div>
        </section>
        </FleetPanelFrame>



        <Show when={savedPanelConfigs.loading}><div class="fleet-layout-status" role="status">Loading dashboard panels…</div></Show>
        <Show when={savedPanelConfigs.error}><div class="fleet-layout-status"><ResourceError title="Panel settings are unavailable" description="Retry loading the saved dashboard panels." onRetry={() => refetchPanelConfigs()} /></div></Show>
        <Show when={!savedPanelConfigs.loading && !savedPanelConfigs.error}>
          <For each={panelConfigs().filter((config) => (config.kind ?? 'parameter') === 'parameter' && !config.hidden)}>{(config) => (
            <FleetPanelFrame id={config.id} layout={layoutFor(config.id, panelFallbackOrder(config.id))} editable={canEditPanel()} onMove={movePanel} onResize={canEditPanel() ? resizePanel : undefined}>
              <section class="data-panel fleet-content-panel">
                <div class="dashboard-configurable-heading"><h3>{config.title}</h3><Show when={canEditPanel() || canRemovePanel()}><button type="button" class="icon-button" aria-label={`Configure ${config.title} panel`} title="Configure panel" onClick={() => openPanelSettings(config)}><Settings2 size={14} /></button></Show></div>
                <div class="data-panel-body"><ParameterDistribution config={config} refreshKey={refreshKey()} /></div>
              </section>
            </FleetPanelFrame>
          )}</For>
        </Show>

        <Show when={!savedPanelConfigs.loading && !savedPanelConfigs.error}>
          <For each={categoryPanelEntries()}>{(panel) => {
            const config = () => panelConfigs().find((item) => item.id === panel.id);
            return <FleetPanelFrame id={panel.id} layout={layoutFor(panel.id, panelFallbackOrder(panel.id))} editable={canEditPanel()} onMove={movePanel} onResize={canEditPanel() ? resizePanel : undefined}>
              <section class="data-panel data-panel-section fleet-content-panel">
                <div class="dashboard-configurable-heading"><h3>{config()?.title ?? panel.label}</h3><Show when={canEditPanel() || canRemovePanel()}><button type="button" class="icon-button" aria-label={`Configure ${panel.label} panel`} title="Configure panel" onClick={() => config() && openPanelSettings(config()!)}><Settings2 size={14} /></button></Show></div>
                <Show when={(config()?.source === 'configured_option' || config()?.source === 'custom_parameter' && !!config()?.aggregation_option_id) && !aggregationOptions().some((option) => option.id === config()?.aggregation_option_id)} fallback={renderAnalytics(panel.id, { limit: panel.limit })}>
                  <p class="py-4 text-center text-xs text-muted">This aggregation option is no longer configured. Choose an available option in panel settings.</p>
                </Show>
              </section>
            </FleetPanelFrame>;
          }}</For>
        </Show>

        </div>
      </Show>
      <Show when={panelDraft()}>
        <Dialog title={`Configure ${panelDraft()?.title || 'dashboard panel'}`} description="Set the panel name, data source, and aggregation or threshold settings." size="large" onClose={closePanelSettings} actions={<div class="flex items-center justify-between gap-3"><Show when={canRemovePanel() && existingDraft()}><button type="button" class="btn btn-danger" disabled={savingPanel() || savedPanelConfigs.loading} onClick={() => void deletePanel()}><Trash2 size={14} />Remove panel</button></Show><div class="ml-auto flex items-center gap-2"><button type="button" class="btn btn-secondary" onClick={closePanelSettings}>Cancel</button><button type="button" class="btn btn-primary" disabled={!canSaveDraft() || savingPanel() || savedPanelConfigs.loading} onClick={() => void savePanelSettings()}>Save panel</button></div></div>}>
          <fieldset disabled={!canSaveDraft()} class="space-y-4">
            <label class="block text-xs text-muted">Panel name<input class="input mt-1 w-full" maxlength={48} value={panelDraft()?.title ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, title: event.currentTarget.value }))} /></label>
              <label class="block text-xs text-muted">Panel type<select class="input mt-1 w-full" value={(panelDraft()?.kind ?? 'parameter')} onChange={(event) => updatePanelDraft((draft) => {
                const kind = event.currentTarget.value as 'parameter' | 'category';
                return { ...draft, kind, source: undefined, aggregation_option_id: undefined, parameter_pattern: '', thresholds: kind === 'parameter' && draft.thresholds.length === 0 ? [{ label: 'At most 0', max: '0', color: 'blue' }, { label: 'Above 0', max: '', color: 'gray' }] : kind === 'parameter' ? draft.thresholds : [] };
              })}><option value="parameter">Parameter thresholds</option><option value="category">Aggregation</option></select></label>
              <Show when={(panelDraft()?.kind ?? 'parameter') === 'parameter'}>
              <label class="block text-xs text-muted">Parameter path<input class="input mt-1 w-full font-mono" maxlength={512} value={panelDraft()?.parameter_pattern ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, parameter_pattern: event.currentTarget.value }))} placeholder="InternetGatewayDevice.DeviceInfo.UpTime" /><span class="mt-1 block">Use * to match dynamic path sections or parameter name variants.</span></label>
            </Show>
            <Show when={panelDraft()?.kind === 'category'}>
              <label class="block text-xs text-muted">Aggregation source<select class="input mt-1 w-full" value={panelDraft()?.source === 'custom_parameter' && !panelDraft()?.aggregation_option_id ? 'custom_parameter' : panelDraft()?.aggregation_option_id && panelDraft()?.source === 'configured_option' ? `aggregation:${panelDraft()?.aggregation_option_id}` : panelDraft()?.source ?? ''} onChange={(event) => updatePanelDraft((draft) => {
                const selected = event.currentTarget.value;
                if (selected === 'custom_parameter') return { ...draft, source: 'custom_parameter', aggregation_option_id: undefined, parameter_pattern: '' };
                if (selected.startsWith('aggregation:')) {
                  const option = aggregationOptions().find((item) => item.id === selected.slice('aggregation:'.length));
                  return { ...draft, source: 'configured_option', aggregation_option_id: option?.id, parameter_pattern: option?.source === 'parameter' ? option.parameter_pattern : '' };
                }
                return { ...draft, source: selected as DashboardPanelConfig['source'], aggregation_option_id: undefined, parameter_pattern: '' };
              })}>
                <option value="">Select an aggregation source</option>
                <option value="access_type">Access type</option><option value="manufacturer">Manufacturer</option><option value="product_class">Product class</option>
                <For each={aggregationOptions()}>{(option) => <option value={`aggregation:${option.id}`}>{option.title}</option>}</For>
                <option value="custom_parameter">CWMP parameter path…</option>
              </select><span class="mt-1 block">Use a shared option or define a CWMP path for this panel.</span></label><Show when={aggregationOptions().length === 0}><p class="text-xs text-muted">No shared sources are configured; you can still enter a CWMP parameter path.</p></Show>
              <Show when={panelDraft()?.source === 'custom_parameter' && !panelDraft()?.aggregation_option_id}><label class="block text-xs text-muted">CWMP parameter path<input class="input mt-1 w-full font-mono" maxlength={512} value={panelDraft()?.parameter_pattern ?? ''} onInput={(event) => updatePanelDraft((draft) => ({ ...draft, parameter_pattern: event.currentTarget.value }))} placeholder="Device.DeviceInfo.X_VENDOR.Region" /><span class="mt-1 block">Use * for dynamic path sections. Sensitive parameters are excluded.</span></label></Show>
              <Show when={panelDraft()?.kind === 'category' && panelDraft()?.source === 'configured_option'}><p class="text-xs text-muted">Each CPE contributes its latest matching value; SQL groups and counts the results. Sensitive parameters are excluded.</p></Show>
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
              <div class="mb-4 grid gap-3 border-b border-subtle pb-3 sm:grid-cols-2">
                <label class="flex items-center gap-2 text-xs text-primary"><input type="checkbox" checked={panelDraft()?.sort_by_count ?? true} onChange={(event) => updatePanelDraft((draft) => ({ ...draft, sort_by_count: event.currentTarget.checked }))} />Ignore manual order and sort by count</label>
                <Show when={panelDraft()?.sort_by_count ?? true}><label class="flex items-center gap-2 text-xs text-muted">Count direction<select class="input w-24" value={panelDraft()?.sort_direction ?? 'desc'} onChange={(event) => updatePanelDraft((draft) => ({ ...draft, sort_direction: event.currentTarget.value as 'asc' | 'desc' }))}><option value="asc">ASC</option><option value="desc">DESC</option></select></label></Show>
                <label class="flex items-center gap-2 text-xs text-primary"><input type="checkbox" checked={panelDraft()?.exclude_na ?? false} onChange={(event) => updatePanelDraft((draft) => ({ ...draft, exclude_na: event.currentTarget.checked }))} />Exclude N/A from the panel</label>
              </div>
              <div class="space-y-2">
                <Index each={panelDraft()?.thresholds ?? []}>{(threshold, index) => (
                  <div class="grid grid-cols-[2rem_minmax(0,1fr)_8rem_3.5rem_2rem] items-end gap-2" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const from = Number(event.dataTransfer?.getData('text/plain')); if (Number.isInteger(from)) moveThreshold(from, index); }}>
                    <button type="button" draggable="true" class="icon-button" aria-label={`Reorder ${threshold().label}; use arrow keys to move`} title="Drag to reorder, or use Up/Down arrows" onDragStart={(event) => { event.dataTransfer?.setData('text/plain', String(index)); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }} onKeyDown={(event) => { if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); moveThreshold(index, index - 1); } else if (event.key === 'ArrowDown' && index < (panelDraft()?.thresholds.length ?? 1) - 1) { event.preventDefault(); moveThreshold(index, index + 1); } }}><GripVertical size={14} /></button>
                    <label class="block min-w-0 text-xs text-muted">Label<input class="input mt-1 w-full" maxlength={48} value={threshold().label} onInput={(event) => updateThreshold(index, 'label', event.currentTarget.value)} /></label>
                    <label class="block text-xs text-muted">Maximum<input type="number" step="any" class="input mt-1 w-full" placeholder={index === (panelDraft()?.thresholds.length ?? 1) - 1 ? 'No limit' : ''} value={threshold().max} onInput={(event) => updateThreshold(index, 'max', event.currentTarget.value)} /></label>
                    <div class="block text-xs text-muted">Color<div class="mt-1"><ColorSwatch compact clearable={false} ariaLabel={`Choose color for ${threshold().label}`} value={legacyThresholdColorHex[threshold().color] ?? threshold().color} onChange={(color) => updateThresholdColor(index, color as DashboardThresholdColor)} /></div></div>
                    <button type="button" class="icon-button text-rose-400" aria-label={`Remove threshold ${threshold().label}`} title="Remove threshold" disabled={(panelDraft()?.thresholds.length ?? 0) <= 1} onClick={() => removeThreshold(index)}><Trash2 size={14} /></button>
                  </div>
                )}</Index>
              </div>
              <p class="mt-2 text-xs text-muted">Buckets are checked in order using value ≤ maximum. Leave the final maximum empty to include all remaining values; missing or nonnumeric values appear as N/A.</p>
            </section></Show>
          </fieldset>
        </Dialog>
      </Show>
    </div>
  );
};

export default Dashboard;
