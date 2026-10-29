import type { Component } from 'solid-js';
import { createResource, createSignal, Show, For, Suspense, createEffect, createMemo, lazy, onCleanup, onMount } from 'solid-js';
import { useParams, A, useNavigate, useSearchParams } from '@solidjs/router';
import { ArrowLeft, RefreshCw, Trash2, Server, Network, Radio, Users, Zap, Edit, Save, X, HeartPulse, Eye, EyeOff, Plus, Minus, Activity, AlertTriangle, Check, Download, Search, MoreVertical, ExternalLink, ChevronDown, ChevronRight, ClipboardList, ScrollText } from 'lucide-solid';
import { api, type DeviceParameter, type DeviceSnapshot, type InterfaceMetricDefinition, type MetricDefinition, type ProvisioningFeature, type SnapshotParameter, type Task } from '../lib/api';
import { formatUptime, findHealthValue, formatHealthValue, healthColor, gaugeRange, type HealthTileGroup } from '../lib/health';
import { metricsTabMetrics, healthPanelMetrics } from '../lib/metricViews';
import { useAuth } from '../lib/auth';
import Dialog from '../components/Dialog';
const HealthGauge = lazy(() => import('../components/HealthGauge'));
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
const MetricChart = lazy(() => import('../components/MetricChart'));
const InterfaceMetricChart = lazy(() => import('../components/InterfaceMetricChart'));
const IperfResult = lazy(() => import('../components/IperfResult'));
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { getWanProfiles, buildExclusiveTieParams, type WanProfile } from '../lib/wanProfiles';
import { statusBadgeClass } from '../lib/lanFields';
import { usePageSize } from '../lib/usePageSize';
import { appName } from '../lib/appName';
import WifiSettingsModal from '../components/WifiSettingsModal';
import LanSettingsModal from '../components/LanSettingsModal';
import LanNetworkSettingsModal from '../components/LanNetworkSettingsModal';
import WanSettingsModal from '../components/WanSettingsModal';
import DeviceTagPicker from '../components/DeviceTagPicker';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import SortableHeader from '../components/SortableHeader';
import { sortRows, type SortDirection } from '../lib/sorting';
import { formatDateTime } from '../lib/dateTime';
import { useColumnVisibility } from '../lib/useColumnVisibility';

interface HostColumnConfig {
  id: string;
  label: string;
  visible: boolean;
}

const HOST_COLUMNS_STORAGE_KEY = 'acs_connected_hosts_columns';
const defaultHostColumns: HostColumnConfig[] = [
  { id: 'hostname', label: 'Hostname', visible: true },
  { id: 'ip', label: 'IP address', visible: true },
  { id: 'ipv6', label: 'IPv6 address', visible: true },
  { id: 'mac', label: 'MAC address', visible: true },
  { id: 'negRate', label: 'Neg. rate', visible: true },
  { id: 'interface', label: 'Interface', visible: true },
  { id: 'rssi', label: 'Signal', visible: true },
  { id: 'uptime', label: 'Uptime', visible: true },
];

interface ParamColumnConfig {
  id: string;
  label: string;
  visible: boolean;
}

interface IperfForm {
  serverAddr: string;
  port: string;
  testMode: 'UPLOAD' | 'DOWNLOAD' | 'BOTH';
  protocolType: 'TCP' | 'UDP';
  maxTime: string;
  parallel: string;
  bandwidth: string;
}

interface IperfRunResult { mode: 'UPLOAD' | 'DOWNLOAD'; values: Record<string, string> }

const formatTaskTriggerEvents = (events?: string[]) => events?.length ? events.join(', ') : '-';
interface FeatureObjectEditor { featureID: string; key: string; label: string; instance: string; fields: { name: string; label: string; value: string; writable: boolean; type: 'boolean' | 'string' | 'int' | 'unsignedInt'; input: 'input' | 'select' | 'boolean'; help?: string; options?: string[]; option_labels?: Record<string, string>; enabled_value?: string; disabled_value?: string }[] }

interface SnapshotTreeRow {
  path: string;
  label: string;
  depth: number;
  parameter?: SnapshotParameter;
  currentValue?: string;
  descendants: string[];
  hasChildren: boolean;
}

const IPERF_CLIENT_ROOT = 'InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.';
const DEVICE_LOG_PARAMETER = 'InternetGatewayDevice.DeviceInfo.DeviceLog';
const NSLOOKUP_ROOTS = ['InternetGatewayDevice.DNS.Diagnostics.NSLookupDiagnostics.', 'Device.DNS.Diagnostics.NSLookupDiagnostics.'];
const IPPING_ROOTS = ['InternetGatewayDevice.IPPingDiagnostics.', 'Device.IP.Diagnostics.IPPing.'];
const TRACEROUTE_ROOTS = ['InternetGatewayDevice.TraceRouteDiagnostics.', 'Device.IP.Diagnostics.TraceRoute.'];

const PARAM_COLUMNS_STORAGE_KEY = 'acs_all_params_columns';
const defaultParamColumns: ParamColumnConfig[] = [
  { id: 'object', label: 'Object', visible: false },
  { id: 'name', label: 'Name', visible: true },
  { id: 'writable', label: 'Writable', visible: false },
  { id: 'value_type', label: 'Value type', visible: false },
  { id: 'value', label: 'Value', visible: true },
];

const cpeWebUiUrl = (address: string): string | null => {
  const value = address.trim();
  if (!value || value === '-') return null;
  const octets = value.split('.');
  if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return `http://${value}`;
  if (value.includes(':')) {
    try { new URL(`http://[${value}]/`); return `http://[${value}]`; } catch { return null; }
  }
  return null;
};

const DeviceDetail: Component = () => {
  const params = useParams<{ serial: string }>();
  const navigate = useNavigate();
  const { isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const serial = () => params.serial || '';
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = () => searchParams.tab === 'metrics' || searchParams.tab === 'tasks' || searchParams.tab === 'snapshots' || searchParams.tab === 'credentials' || searchParams.tab === 'hosts' || searchParams.tab === 'faults' || searchParams.tab === 'diagnostic' || searchParams.tab === 'features' || searchParams.tab === 'log' ? searchParams.tab : 'overview';

  const [device, { refetch: refetchDevice }] = createResource(serial, api.getDevice);
  const [featureRefreshTaskID, setFeatureRefreshTaskID] = createSignal<number | null>(null);
  const taskSource = () => activeTab() === 'tasks' || featureRefreshTaskID() !== null ? serial() : false;
  const [systemSettings] = createResource(api.getSettings);
  const [provisioningTemplates] = createResource(api.getProvisioningTemplates);
  const [tagCatalog] = createResource(api.getTags);
  const [tasks, { refetch: refetchTaskRows }] = createResource(taskSource, api.getDeviceTasks);
  const [deviceTaskCounts, { refetch: refetchDeviceTaskCounts }] = createResource(serial, api.getDeviceTaskCounts);
  const refetchTasks = async () => {
    const [taskRows] = await Promise.all([refetchTaskRows(), refetchDeviceTaskCounts()]);
    return taskRows;
  };
  const [snapshots, { refetch: refetchSnapshots }] = createResource(() => activeTab() === 'snapshots' ? serial() : false, api.getDeviceSnapshots);
  const [deviceFaults, { refetch: refetchFaultRows }] = createResource(() => activeTab() === 'faults' ? serial() : false, api.getDeviceFaults);
  const [deviceFaultCounts, { refetch: refetchFaultCounts }] = createResource(serial, api.getDeviceFaultCounts);
  const refetchDeviceFaults = async () => {
    const [faultRows] = await Promise.all([refetchFaultRows(), refetchFaultCounts()]);
    return faultRows;
  };
  const [metricDefs] = createResource(serial, api.getDeviceMetricDefinitions);
  const parameterViewFilters = (tab: string): { prefixes?: string[]; names?: string[]; contains?: string[] } => {
    const names = metricDefs()?.filter(def => def.active).map(def => def.parameter_name).filter(Boolean) || [];
    if (tab === 'overview') return { names };
    if (tab === 'hosts') return { prefixes: ['InternetGatewayDevice.LANDevice.1.Hosts.Host.', 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.', 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.'] };
    if (tab === 'diagnostic') return { prefixes: ['InternetGatewayDevice.WANDevice.', 'InternetGatewayDevice.X_HW_IperfSpeedTest.IperfClient.', 'InternetGatewayDevice.DNS.Diagnostics.NSLookupDiagnostics.', 'Device.DNS.Diagnostics.NSLookupDiagnostics.', 'InternetGatewayDevice.IPPingDiagnostics.', 'Device.IP.Diagnostics.IPPing.', 'InternetGatewayDevice.TraceRouteDiagnostics.', 'Device.IP.Diagnostics.TraceRoute.'] };
    if (tab === 'metrics') return { names };
    if (tab === 'features') {
      const current = device();
      const manufacturer = (current?.manufacturer || '').toLowerCase();
      const productClass = (current?.product_class || '').toLowerCase();
      const template = (provisioningTemplates() || []).filter(item => (!item.manufacturer || item.manufacturer.toLowerCase() === manufacturer) && (!item.product_class || item.product_class.toLowerCase() === productClass)).sort((a, b) => (Number(Boolean(b.manufacturer)) + Number(Boolean(b.product_class))) - (Number(Boolean(a.manufacturer)) + Number(Boolean(a.product_class))) || a.id - b.id)[0];
      const controls = template?.features?.flatMap(feature => feature.controls) || [];
      return { names: controls.filter(control => control.type !== 'object').map(control => control.parameter), prefixes: controls.filter(control => control.type === 'object').map(control => control.parameter.endsWith('.') ? control.parameter : `${control.parameter}.`) };
    }
    return { names: [] };
  };
  const parameterViewSource = () => JSON.stringify({ serial: serial(), tab: activeTab(), names: metricDefs()?.filter(def => def.active).map(def => def.parameter_name) || [], templateReady: activeTab() === 'features' ? Boolean(provisioningTemplates()) : true, manufacturer: device()?.manufacturer, productClass: device()?.product_class });
  const [parameters, { refetch: refetchParams }] = createResource(parameterViewSource, async key => {
    const source = JSON.parse(key) as { serial: string; tab: string; templateReady: boolean };
    if (!source.serial || !['overview', 'hosts', 'diagnostic', 'metrics', 'features'].includes(source.tab)) return [];
    if (source.tab === 'features' && !source.templateReady) return [];
    const filters = parameterViewFilters(source.tab);
    if (source.tab === 'overview') return api.getDeviceOverviewParameters(source.serial, filters.names);
    if (!filters.prefixes?.length && !filters.names?.length && !filters.contains?.length) return [];
    return api.getDeviceParameterView(source.serial, filters);
  });
  const loadDeviceParameters = () => refetchParams();
  const [allParametersRequested, setAllParametersRequested] = createSignal(false);
  const [allParameters, { refetch: refetchAllParameters }] = createResource(() => allParametersRequested() ? serial() : false, api.getDeviceParameters);
  const loadAllParameters = () => {
    if (!allParametersRequested()) {
      setAllParametersRequested(true);
      return;
    }
    return refetchAllParameters();
  };
  const [featureAction, setFeatureAction] = createSignal<string | null>(null);
  const [featureObjectEditor, setFeatureObjectEditor] = createSignal<FeatureObjectEditor | null>(null);
  const [featureObjectDraft, setFeatureObjectDraft] = createSignal<Record<string, string>>({});
  const [activeDeviceFeatureID, setActiveDeviceFeatureID] = createSignal('');
  const matchingProvisioningTemplate = createMemo(() => {
    const current = device();
    if (!current) return null;
    const manufacturer = (current.manufacturer || '').toLowerCase();
    const productClass = (current.product_class || '').toLowerCase();
    return (provisioningTemplates() || [])
      .filter(template => (!template.manufacturer || template.manufacturer.toLowerCase() === manufacturer) && (!template.product_class || template.product_class.toLowerCase() === productClass))
      .sort((a, b) => {
        const score = (template: typeof a) => Number(Boolean(template.manufacturer)) + Number(Boolean(template.product_class));
        return score(b) - score(a) || a.id - b.id;
      })[0] || null;
  });
  const activeDeviceFeature = () => {
    const features = matchingProvisioningTemplate()?.features || [];
    return features.find(feature => feature.id === activeDeviceFeatureID()) || features[0] || null;
  };
  const featureObjectInstances = (path: string) => {
    const ids = new Set<string>();
    for (const parameter of parameters() || []) {
      if (!parameter.name.startsWith(path)) continue;
      const tail = parameter.name.slice(path.length);
      const instance = tail.split('.')[0];
      if (/^\d+$/.test(instance)) ids.add(instance);
    }
    return [...ids].sort((a, b) => Number(a) - Number(b));
  };
  const featureObjectColumns = (path: string) => {
    const columns = new Set<string>();
    for (const instance of featureObjectInstances(path)) {
      const prefix = `${path}${instance}.`;
      for (const parameter of parameters() || []) {
        if (!parameter.name.startsWith(prefix)) continue;
        const leaf = parameter.name.slice(prefix.length);
        if (leaf && !leaf.endsWith('.')) columns.add(leaf);
      }
    }
    return [...columns].sort();
  };
  createEffect(() => {
    const taskID = featureRefreshTaskID();
    if (taskID === null) return;
    const refresh = async () => {
      const [rows] = await Promise.all([refetchTasks(), loadDeviceParameters()]);
      const status = rows?.find(task => task.id === taskID)?.status;
      if (status === 'completed' || status === 'failed') setFeatureRefreshTaskID(null);
    };
    const interval = window.setInterval(() => void refresh(), 4000);
    const timeout = window.setTimeout(() => setFeatureRefreshTaskID(null), 5 * 60 * 1000);
    onCleanup(() => { window.clearInterval(interval); window.clearTimeout(timeout); });
  });
  const [templateImageBlob] = createResource(() => matchingProvisioningTemplate()?.image_url ? matchingProvisioningTemplate()!.id : undefined, (id) => api.getProvisioningTemplateImage(id));
  const [templateImageUrl, setTemplateImageUrl] = createSignal<string | null>(null);
  let templateImageObjectUrl: string | null = null;
  createEffect(() => {
    const blob = templateImageBlob();
    if (templateImageObjectUrl) URL.revokeObjectURL(templateImageObjectUrl);
    templateImageObjectUrl = blob ? URL.createObjectURL(blob) : null;
    setTemplateImageUrl(templateImageObjectUrl);
  });
  onCleanup(() => {
    if (templateImageObjectUrl) URL.revokeObjectURL(templateImageObjectUrl);
  });
  const [statsInterface, setStatsInterface] = createSignal<{ type: 'wan' | 'lan'; name: string; path: string } | null>(null);
  const [interfaceMetricDefs] = createResource(() => statsInterface() ? serial() : false, api.getDeviceInterfaceMetricDefinitions);
  const [taskPage, setTaskPage] = createSignal(0);
  const [selectedTask, setSelectedTask] = createSignal<Task | null>(null);
  const [taskDetailTab, setTaskDetailTab] = createSignal<'requested' | 'result'>('requested');
  const { pageSize: taskPageSize, changePageSize: changeTaskPageSize } = usePageSize('device_tasks', 20);
  const handleTaskPageSizeChange = (size: number) => { changeTaskPageSize(size); setTaskPage(0); };
  const [taskColumnFilters, setTaskColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>(`acs.filters.device.${encodeURIComponent(serial())}.tasks`, {});
  const { columns: deviceTaskColumns, isVisible: isDeviceTaskColumnVisible, toggle: toggleDeviceTaskColumn } = useColumnVisibility('device_tasks', [
    { id: 'type', label: 'Type', visible: true },
    { id: 'trigger_event', label: 'Trigger event', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'created_at', label: 'Created', visible: true },
    { id: 'completed_at', label: 'Completed', visible: true },
    { id: 'created_by', label: 'Created by', visible: true },
    { id: 'deleted_by', label: 'Deleted by', visible: true },
    { id: 'error', label: 'Error', visible: true },
  ]);
  const [deviceFaultColumnFilters, setDeviceFaultColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>(`acs.filters.device.${encodeURIComponent(serial())}.faults`, {});
  const [taskSort, setTaskSort] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'created_at', direction: 'desc' });
  const [faultSort, setFaultSort] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'created_at', direction: 'desc' });
  const toggleSort = (setSort: typeof setTaskSort) => (column: string) => setSort(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  const [taskSearch, setTaskSearch] = createPersistedSignal(`acs.search.device.${encodeURIComponent(serial())}.tasks`);
  const [faultSearch, setFaultSearch] = createPersistedSignal(`acs.search.device.${encodeURIComponent(serial())}.faults`);
  const [hostSearch, setHostSearch] = createPersistedSignal(`acs.search.device.${encodeURIComponent(serial())}.hosts`);
  const filteredTasks = createMemo(() => {
    let all = tasks() || [];
    const query = taskSearch().toLowerCase().trim();
    if (query) {
      all = all.filter(t =>
        t.type?.toLowerCase().includes(query) ||
        formatTaskTriggerEvents(t.trigger_events).toLowerCase().includes(query) ||
        t.status?.toLowerCase().includes(query) ||
        t.created_by?.toLowerCase().includes(query) ||
        t.error_message?.toLowerCase().includes(query)
      );
    }
    const filtered = applyColumnFilters(all, taskColumnFilters(), (t, colId) => {
      switch (colId) {
        case 'type': return t.type || '';
        case 'trigger_event': return formatTaskTriggerEvents(t.trigger_events);
        case 'status': return t.status || '';
        case 'created_at': return t.created_at || '';
        case 'completed_at': return t.completed_at || '';
        case 'created_by': return t.created_by || '';
        case 'error': return t.error_message || '';
        default: return '';
      }
    });
    return sortRows(filtered, taskSort().column, taskSort().direction, (t, key) => key === 'type' ? t.type : key === 'trigger_event' ? formatTaskTriggerEvents(t.trigger_events) : key === 'status' ? t.status : key === 'created_at' ? t.created_at : key === 'completed_at' ? t.completed_at || '' : key === 'created_by' ? t.created_by || '' : key === 'error' ? t.error_message || '' : t.deleted_by || '');
  });
  const pagedTasks = createMemo(() => {
    const all = filteredTasks();
    const start = taskPage() * taskPageSize();
    return all.slice(start, start + taskPageSize());
  });
  const taskTotalPages = createMemo(() => Math.ceil(filteredTasks().length / taskPageSize()));
  const [faultPage, setFaultPage] = createSignal(0);
  const { pageSize: faultPageSize, changePageSize: changeFaultPageSize } = usePageSize('device_faults', 20);
  const handleFaultPageSizeChange = (size: number) => { changeFaultPageSize(size); setFaultPage(0); };
  const filteredDeviceFaults = createMemo(() => {
    let all = deviceFaults() || [];
    const query = faultSearch().toLowerCase().trim();
    if (query) {
      all = all.filter(f =>
        f.fault_code?.toLowerCase().includes(query) ||
        f.fault_string?.toLowerCase().includes(query) ||
        f.parameter_name?.toLowerCase().includes(query)
      );
    }
    const filtered = applyColumnFilters(all, deviceFaultColumnFilters(), (f, colId) => {
      switch (colId) {
        case 'code': return f.fault_code || '';
        case 'message': return f.fault_string || '';
        case 'parameter': return f.parameter_name || '';
        case 'time': return f.created_at || '';
        case 'status': return f.resolved ? 'Resolved' : 'Active';
        default: return '';
      }
    });
    return sortRows(filtered, faultSort().column, faultSort().direction, (f, key) => key === 'code' ? f.fault_code : key === 'message' ? f.fault_string : key === 'parameter' ? f.parameter_name : key === 'time' ? f.created_at : key === 'status' ? (f.resolved ? 'Resolved' : 'Active') : '');
  });
  const pagedDeviceFaults = createMemo(() => {
    const all = filteredDeviceFaults();
    const start = faultPage() * faultPageSize();
    return all.slice(start, start + faultPageSize());
  });
  const deviceFaultTotalPages = createMemo(() => Math.ceil(filteredDeviceFaults().length / faultPageSize()));
  const unresolvedFaultCount = createMemo(() => deviceFaultCounts()?.active || 0);
  const pendingTaskCount = createMemo(() => (deviceTaskCounts()?.pending || 0) + (deviceTaskCounts()?.sent || 0));
  const [autoRefreshTick, setAutoRefreshTick] = createSignal(0);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = createPersistedSignal('acs.device.autoRefresh', 'true');
  const [autoRefreshRunning, setAutoRefreshRunning] = createSignal(false);
  const [deletingTask, setDeletingTask] = createSignal<number | null>(null);
  const [pendingFault, setPendingFault] = createSignal<number | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = createSignal<DeviceSnapshot | null>(null);
  const [snapshotSelection, setSnapshotSelection] = createSignal<string[]>([]);
  const [snapshotName, setSnapshotName] = createSignal('');
  const [snapshotSearch, setSnapshotSearch] = createSignal('');
  const [snapshotLoading, setSnapshotLoading] = createSignal<string | null>(null);
  const [collapsedSnapshotPaths, setCollapsedSnapshotPaths] = createSignal<Set<string>>(new Set());

  const snapshotRows = createMemo<SnapshotTreeRow[]>(() => {
    const snapshot = selectedSnapshot();
    if (!snapshot?.parameters) return [];
    const current = new Map((parameters() || []).map(parameter => [parameter.name, parameter]));
    const query = snapshotSearch().trim().toLowerCase();
    const changed = snapshot.parameters.filter(parameter => current.get(parameter.name)?.writable === true && current.get(parameter.name)?.value !== parameter.value && parameter.name.toLowerCase().includes(query));
    const nodes = new Map<string, { parameter?: SnapshotParameter; descendants: string[] }>();
    for (const parameter of changed) {
      const parts = parameter.name.split('.');
      for (let index = 0; index < parts.length; index++) {
        const path = parts.slice(0, index + 1).join('.');
        const node = nodes.get(path) || { descendants: [] };
        node.descendants = [...new Set([...node.descendants, parameter.name])];
        if (index === parts.length - 1) node.parameter = parameter;
        nodes.set(path, node);
      }
    }
    const rows = [...nodes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, node]) => ({
        path,
        label: path.substring(path.lastIndexOf('.') + 1),
        depth: path.split('.').length - 1,
        parameter: node.parameter,
        currentValue: node.parameter ? current.get(node.parameter.name)?.value : undefined,
        descendants: node.descendants,
        hasChildren: [...nodes.keys()].some(candidate => candidate.startsWith(`${path}.`)),
      }));
    const collapsed = collapsedSnapshotPaths();
    return rows.filter(row => {
      const parts = row.path.split('.');
      return !parts.slice(1).some((_, index) => collapsed.has(parts.slice(0, index + 1).join('.')));
    });
  });

  const toggleSnapshotBranch = (path: string) => {
    setCollapsedSnapshotPaths(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleSnapshotPath = (row: SnapshotTreeRow) => {
    const selected = new Set(snapshotSelection());
    const allSelected = row.descendants.every(name => selected.has(name));
    row.descendants.forEach(name => allSelected ? selected.delete(name) : selected.add(name));
    setSnapshotSelection([...selected]);
  };

  const openSnapshot = async (snapshot: DeviceSnapshot) => {
    setSnapshotLoading(`open-${snapshot.id}`);
    try {
      const detail = await api.getDeviceSnapshot(serial(), snapshot.id);
      setSelectedSnapshot(detail);
      setCollapsedSnapshotPaths(new Set<string>());
      const current = new Map((parameters() || []).map(parameter => [parameter.name, parameter]));
      setSnapshotSelection((detail.parameters || []).filter(parameter => current.get(parameter.name)?.writable === true && current.get(parameter.name)?.value !== parameter.value).map(parameter => parameter.name));
    } catch (error) {
      notify({ tone: 'error', title: 'Could not open snapshot', detail: (error as Error).message, persistent: true });
    } finally { setSnapshotLoading(null); }
  };

  const createSnapshot = async () => {
    setSnapshotLoading('create');
    try {
      await api.createDeviceSnapshot(serial(), snapshotName().trim() || undefined);
      setSnapshotName('');
      notify({ tone: 'success', title: 'Snapshot created from cached parameters' });
      await refetchSnapshots();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not create snapshot', detail: (error as Error).message, persistent: true });
    } finally { setSnapshotLoading(null); }
  };

  const restoreSnapshot = async () => {
    const snapshot = selectedSnapshot();
    const selected = snapshotSelection();
    if (!snapshot || selected.length === 0) return;
    if (!await confirm({ title: 'Restore selected snapshot parameters?', description: `${selected.length} selected parameter(s) will be sent to the CPE as a configuration task.`, confirmLabel: 'Create restore task', tone: 'danger' })) return;
    setSnapshotLoading(`restore-${snapshot.id}`);
    try {
      const result = await api.restoreDeviceSnapshot(serial(), snapshot.id, selected);
      notify({ tone: 'success', title: 'Restore task created', detail: `${result.restored} writable parameter(s) queued.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not restore snapshot', detail: (error as Error).message, persistent: true });
    } finally { setSnapshotLoading(null); }
  };

  const deleteSnapshot = async (snapshot: DeviceSnapshot) => {
    if (!await confirm({ title: 'Delete snapshot?', description: `This permanently removes “${snapshot.name}”.`, confirmLabel: 'Delete snapshot', tone: 'danger' })) return;
    setSnapshotLoading(`delete-${snapshot.id}`);
    try {
      await api.deleteDeviceSnapshot(serial(), snapshot.id);
      if (selectedSnapshot()?.id === snapshot.id) { setSelectedSnapshot(null); setSnapshotSelection([]); }
      await refetchSnapshots();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete snapshot', detail: (error as Error).message, persistent: true });
    } finally { setSnapshotLoading(null); }
  };

  const handleResolveFault = async (id: number) => {
    setPendingFault(id);
    try {
      await api.resolveFault(id);
      notify({ tone: 'success', title: 'Fault marked as resolved' });
      await refetchDeviceFaults();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not resolve fault', detail: (error as Error).message, persistent: true });
    } finally { setPendingFault(null); }
  };

  const handleDeleteFault = async (id: number) => {
    if (!await confirm({ title: 'Delete fault record?', description: 'This permanently removes the selected protocol fault from the operational history. This action cannot be undone.', confirmLabel: 'Delete fault', tone: 'danger' })) return;
    setPendingFault(id);
    try {
      await api.deleteFault(id);
      notify({ tone: 'success', title: 'Fault record deleted' });
      await refetchDeviceFaults();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete fault', detail: (error as Error).message, persistent: true });
    } finally { setPendingFault(null); }
  };

  const toggleTemplateFeature = async (featureID: string, key: string, label: string, group: string | undefined, enabled: boolean) => {
    if (!isFullAccess() || featureAction()) return;
    if (!enabled && /wan/i.test(`${group || ''} ${label}`) && !await confirm({ title: `Disable ${label}?`, description: 'This may remove remote access to the ONT. Continue only if you have another way to manage it.', confirmLabel: 'Disable service', tone: 'danger' })) return;
    const actionKey = `${featureID}:${key}`;
    setFeatureAction(actionKey);
    try {
      const tasks = await api.setTemplateFeatureControl(serial(), featureID, key, enabled);
      setFeatureRefreshTaskID(tasks.refresh_task.id);
      notify({ tone: 'success', title: `${label} change queued`, detail: `CWMP task #${tasks.task.id} will apply at the next device session.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: `Could not change ${label}`, detail: (error as Error).message, persistent: true });
    } finally { setFeatureAction(null); }
  };

  const setTemplateFeatureString = async (featureID: string, key: string, label: string, value: string) => {
    if (!isFullAccess() || featureAction()) return;
    const actionKey = `${featureID}:${key}`;
    setFeatureAction(actionKey);
    try {
      const tasks = await api.setTemplateFeatureStringControl(serial(), featureID, key, value);
      setFeatureRefreshTaskID(tasks.refresh_task.id);
      notify({ tone: 'success', title: `${label} change queued`, detail: `CWMP task #${tasks.task.id} will apply at the next device session.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: `Could not change ${label}`, detail: (error as Error).message, persistent: true });
    } finally { setFeatureAction(null); }
  };

  const openFeatureObjectEditor = (featureID: string, key: string, label: string, path: string, instance: string, configuredFields?: FeatureObjectEditor['fields']) => {
    const prefix = `${path}${instance}.`;
    const discovered = (parameters() || []).filter(parameter => parameter.name.startsWith(prefix) && !parameter.name.endsWith('.'));
    const fields = configuredFields?.length ? configuredFields.map(field => {
      const parameter = discovered.find(item => item.name === `${prefix}${field.name}`);
      return { ...field, value: parameter?.value || '', writable: parameter?.writable === true };
    }).filter(field => discovered.some(parameter => parameter.name === `${prefix}${field.name}`)) : discovered.map(parameter => {
      const name = parameter.name.slice(prefix.length);
      return { name, label: name.split('.').at(-1) || name, value: parameter.value, writable: parameter.writable === true, type: 'string' as const, input: 'input' as const };
    }).sort((a, b) => a.name.localeCompare(b.name));
    setFeatureObjectDraft(Object.fromEntries(fields.map(field => [field.name, field.value])));
    setFeatureObjectEditor({ featureID, key, label, instance, fields });
  };

  const saveFeatureObjectParameters = async (event: SubmitEvent) => {
    event.preventDefault();
    const editor = featureObjectEditor();
    if (!editor || !isFullAccess() || featureAction()) return;
    const values = Object.fromEntries(editor.fields.filter(field => field.writable && featureObjectDraft()[field.name] !== field.value).map(field => [field.name, featureObjectDraft()[field.name] || '']));
    if (Object.keys(values).length === 0) { setFeatureObjectEditor(null); return; }
    const actionKey = `${editor.featureID}:${editor.key}:${editor.instance}`;
    setFeatureAction(actionKey);
    try {
      const tasks = await api.setTemplateFeatureObjectParameters(serial(), editor.featureID, editor.key, editor.instance, values);
      setFeatureRefreshTaskID(tasks.refresh_task.id);
      setFeatureObjectEditor(null);
      notify({ tone: 'success', title: `${editor.label} updated`, detail: `CWMP task #${tasks.task.id} will apply at the next device session.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: `Could not update ${editor.label}`, detail: (error as Error).message, persistent: true });
    } finally { setFeatureAction(null); }
  };

  const deleteFeatureObject = async (featureID: string, key: string, label: string, instance: string) => {
    if (!isFullAccess() || featureAction() || !await confirm({ title: `Delete ${label} ${instance}?`, description: 'This removes the object and all of its settings from the device.', confirmLabel: 'Delete object', tone: 'danger' })) return;
    const actionKey = `${featureID}:${key}:${instance}`;
    setFeatureAction(actionKey);
    try {
      const task = await api.deleteTemplateFeatureObject(serial(), featureID, key, instance);
      setFeatureRefreshTaskID(task.id);
      notify({ tone: 'success', title: `${label} ${instance} deletion queued`, detail: `CWMP task #${task.id} will run at the next device session.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: `Could not delete ${label} ${instance}`, detail: (error as Error).message, persistent: true });
    } finally { setFeatureAction(null); }
  };

  const addTemplateFeatureObject = async (featureID: string, key: string, label: string) => {
    if (!isFullAccess() || featureAction()) return;
    const actionKey = `${featureID}:${key}`;
    setFeatureAction(actionKey);
    try {
      const task = await api.addTemplateFeatureObject(serial(), featureID, key);
      setFeatureRefreshTaskID(task.id);
      notify({ tone: 'success', title: `${label} creation queued`, detail: `CWMP task #${task.id} will create and discover the object at the next device session.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: `Could not create ${label}`, detail: (error as Error).message, persistent: true });
    } finally { setFeatureAction(null); }
  };

  const [selectedDeviceFaults, setSelectedDeviceFaults] = createSignal<Set<number>>(new Set());
  const [bulkDeletingFaults, setBulkDeletingFaults] = createSignal(false);

  const handleBulkDeleteFaults = async () => {
    const ids = [...selectedDeviceFaults()];
    if (ids.length === 0) return;
    if (!await confirm({ title: `Delete ${ids.length} fault record${ids.length > 1 ? 's' : ''}?`, description: 'This permanently removes the selected protocol faults from the operational history. This action cannot be undone.', confirmLabel: 'Delete faults', tone: 'danger' })) return;
    setBulkDeletingFaults(true);
    try {
      await api.deleteFaults(ids);
      notify({ tone: 'success', title: `${ids.length} fault record${ids.length > 1 ? 's' : ''} deleted` });
      setSelectedDeviceFaults(new Set<number>());
      await refetchDeviceFaults();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete faults', detail: (error as Error).message, persistent: true });
    } finally { setBulkDeletingFaults(false); }
  };

  const toggleSelectDeviceFault = (id: number) => {
    setSelectedDeviceFaults(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allDeviceFaultsSelected = createMemo(() => {
    const page = pagedDeviceFaults();
    return page.length > 0 && page.every(f => selectedDeviceFaults().has(f.id));
  });

  const toggleSelectAllDeviceFaults = () => {
    setSelectedDeviceFaults(prev => {
      const next = new Set(prev);
      const page = pagedDeviceFaults();
      if (page.every(f => next.has(f.id))) {
        page.forEach(f => next.delete(f.id));
      } else {
        page.forEach(f => next.add(f.id));
      }
      return next;
    });
  };

  const [actionLoading, setActionLoading] = createSignal<string | null>(null);
  const [showActionsMenu, setShowActionsMenu] = createSignal(false);
  let actionsMenu: HTMLDivElement | undefined;
  const [showLanContextMenu, setShowLanContextMenu] = createSignal(false);
  let lanContextMenu: HTMLDivElement | undefined;
  const [expandedWanPaths, setExpandedWanPaths] = createSignal<Set<string>>(new Set());
  const [message, setMessage] = createSignal<{ type: 'success' | 'error'; text: string; detail?: string } | null>(null);
  const [paramFilter, setParamFilter] = createPersistedSignal(`acs.search.device.${encodeURIComponent(serial())}.parameters`);
  const [deviceLogFilter, setDeviceLogFilter] = createSignal('');
  const [deviceLogColumnFilters, setDeviceLogColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>(`acs.filters.device.${encodeURIComponent(serial())}.log`, {});
  const { columns: deviceLogColumns, isVisible: isDeviceLogColumnVisible, toggle: toggleDeviceLogColumn } = useColumnVisibility('device_log', [
    { id: 'time', label: 'Time', visible: true },
    { id: 'severity', label: 'Severity', visible: true },
    { id: 'message', label: 'Message', visible: true },
  ]);
  const [deviceLogSort, setDeviceLogSort] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'time', direction: 'desc' });
  const [deviceLogPage, setDeviceLogPage] = createSignal(0);
  const { pageSize: deviceLogPageSize, changePageSize: changeDeviceLogPageSize } = usePageSize('device_logs', 20);
  const changeDeviceLogPageSizeAndReset = (size: number) => { changeDeviceLogPageSize(size); setDeviceLogPage(0); };
  const toggleDeviceLogSort = (column: string) => {
    setDeviceLogSort(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
    setDeviceLogPage(0);
  };
  const updateDeviceLogColumnFilter = (column: string, state: ColumnFilterState | null) => {
    setDeviceLogColumnFilters(previous => { const next = { ...previous }; if (state) next[column] = state; else delete next[column]; return next; });
    setDeviceLogPage(0);
  };
  const deviceLogQuery = createMemo(() => activeTab() === 'log' ? {
    serial: serial(), limit: deviceLogPageSize(), offset: deviceLogPage() * deviceLogPageSize(), search: deviceLogFilter(),
    filters: deviceLogColumnFilters(), sort: deviceLogSort().column || 'time', direction: deviceLogSort().direction,
  } : false);
  const [deviceLogPageData, { refetch: refetchDeviceLog }] = createResource(deviceLogQuery, query => api.getDeviceLogs(query));
  const filteredDeviceLog = () => deviceLogPageData()?.items || [];
  const [wifiModalIndex, setWifiModalIndex] = createSignal<number | null>(null);
  const [lanModalIndex, setLanModalIndex] = createSignal<number | null>(null);
  const [showLanNetworkModal, setShowLanNetworkModal] = createSignal(false);
  const [wanModalPath, setWanModalPath] = createSignal<string | null>(null);

  const [selectedParam, setSelectedParam] = createSignal<{ name: string; value: string } | null>(null);
  const [showSensitive, setShowSensitive] = createSignal(false);
  const [showFactoryResetModal, setShowFactoryResetModal] = createSignal(false);
  const [factoryResetPassword, setFactoryResetPassword] = createSignal('');
  const [paramColumnFilters, setParamColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>(`acs.filters.device.${encodeURIComponent(serial())}.parameters`, {});
  const [hostColumnFilters, setHostColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>(`acs.filters.device.${encodeURIComponent(serial())}.hosts`, {});
  const [hostColumns, setHostColumns] = createSignal<HostColumnConfig[]>([]);
  const [paramColumns, setParamColumns] = createSignal<ParamColumnConfig[]>([]);
  const [editingConnCreds, setEditingConnCreds] = createSignal(false);
  const [connCredMode, setConnCredMode] = createSignal('inherit');
  const [connCredUsername, setConnCredUsername] = createSignal('');
  const [connCredPassword, setConnCredPassword] = createSignal('');
  const [generatedCred, setGeneratedCred] = createSignal<{ username: string; password: string } | null>(null);
  const [iperfRunning, setIperfRunning] = createSignal(false);
  const [iperfForm, setIperfForm] = createSignal<IperfForm>({ serverAddr: '', port: '5201', testMode: 'UPLOAD', protocolType: 'TCP', maxTime: '10', parallel: '1', bandwidth: '0' });
  const [iperfResult, setIperfResult] = createSignal<IperfRunResult[] | null>(null);
  const [nsLookupHost, setNsLookupHost] = createSignal('');
  const [nsLookupServer, setNsLookupServer] = createSignal('');
  const [nsLookupInterface, setNsLookupInterface] = createSignal('');
  const [nsLookupRepetitions, setNsLookupRepetitions] = createSignal('1');
  const [nsLookupTimeout, setNsLookupTimeout] = createSignal('5000');
  const [nsLookupRunning, setNsLookupRunning] = createSignal(false);
  const [nsLookupResult, setNsLookupResult] = createSignal<Record<string, string> | null>(null);
  const [ipPingHost, setIpPingHost] = createSignal('');
  const [ipPingInterface, setIpPingInterface] = createSignal('');
  const [ipPingRepetitions, setIpPingRepetitions] = createSignal('4');
  const [ipPingTimeout, setIpPingTimeout] = createSignal('2000');
  const [ipPingDataBlockSize, setIpPingDataBlockSize] = createSignal('56');
  const [ipPingDscp, setIpPingDscp] = createSignal('0');
  const [ipPingRunning, setIpPingRunning] = createSignal(false);
  const [ipPingResult, setIpPingResult] = createSignal<Record<string, string> | null>(null);
  const [traceRouteHost, setTraceRouteHost] = createSignal('');
  const [traceRouteInterface, setTraceRouteInterface] = createSignal('');
  const [traceRouteMaxHops, setTraceRouteMaxHops] = createSignal('30');
  const [traceRouteTries, setTraceRouteTries] = createSignal('3');
  const [traceRouteTimeout, setTraceRouteTimeout] = createSignal('5000');
  const [traceRouteDataBlockSize, setTraceRouteDataBlockSize] = createSignal('38');
  const [traceRouteDscp, setTraceRouteDscp] = createSignal('0');
  const [traceRouteRunning, setTraceRouteRunning] = createSignal(false);
  const [traceRouteResult, setTraceRouteResult] = createSignal<Record<string, string> | null>(null);

  const iperfSupported = createMemo(() => (parameters() || []).some(p => p.name.startsWith(IPERF_CLIENT_ROOT)));
  const nsLookupRoot = createMemo(() => NSLOOKUP_ROOTS.find(root => (parameters() || []).some(parameter => parameter.name.startsWith(root))) || '');
  const ipPingRoot = createMemo(() => IPPING_ROOTS.find(root => (parameters() || []).some(parameter => parameter.name.startsWith(root))) || '');
  const traceRouteRoot = createMemo(() => TRACEROUTE_ROOTS.find(root => (parameters() || []).some(parameter => parameter.name.startsWith(root))) || '');
  const iperfParameter = (suffix: string) => (parameters() || []).find(p => p.name === IPERF_CLIENT_ROOT + suffix)?.value || '';

  createEffect(() => {
    if (!iperfSupported() || iperfForm().serverAddr) return;
    setIperfForm({
      serverAddr: iperfParameter('ServerAddr'),
      port: iperfParameter('Port') || '5201',
      testMode: iperfParameter('TestMode') === 'DOWNLOAD' ? 'DOWNLOAD' : iperfParameter('TestMode') === 'BOTH' ? 'BOTH' : 'UPLOAD',
      protocolType: iperfParameter('ProtocolType') === 'UDP' ? 'UDP' : 'TCP',
      maxTime: iperfParameter('MaxTime') || '10',
      parallel: iperfParameter('Parallel') || '1',
      bandwidth: iperfParameter('Bandwidth') || '0',
    });
  });

  onMount(() => {
    const saved = localStorage.getItem(HOST_COLUMNS_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as HostColumnConfig[];
        setHostColumns(defaultHostColumns.map(column => {
          const stored = parsed.find(item => item.id === column.id);
          return stored ? { ...column, visible: stored.visible } : column;
        }));
      } catch {
        setHostColumns([...defaultHostColumns]);
      }
    } else {
      setHostColumns([...defaultHostColumns]);
    }
  });

  onMount(() => {
    const closeMenu = (event: MouseEvent) => {
      if (!lanContextMenu?.contains(event.target as Node)) setShowLanContextMenu(false);
    };
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowLanContextMenu(false);
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', closeMenuOnEscape);
    onCleanup(() => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', closeMenuOnEscape);
    });
  });

  onMount(() => {
    const closeActionsMenu = (event: MouseEvent) => {
      if (!actionsMenu?.contains(event.target as Node)) setShowActionsMenu(false);
    };
    const closeActionsMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowActionsMenu(false);
    };
    document.addEventListener('click', closeActionsMenu);
    document.addEventListener('keydown', closeActionsMenuOnEscape);
    onCleanup(() => {
      document.removeEventListener('click', closeActionsMenu);
      document.removeEventListener('keydown', closeActionsMenuOnEscape);
    });
  });

  createEffect(() => {
    const columns = hostColumns();
    if (columns.length > 0) {
      localStorage.setItem(HOST_COLUMNS_STORAGE_KEY, JSON.stringify(columns));
    }
  });

  onMount(() => {
    const saved = localStorage.getItem(PARAM_COLUMNS_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as ParamColumnConfig[];
        setParamColumns(defaultParamColumns.map(column => {
          const stored = parsed.find(item => item.id === column.id);
          return stored ? { ...column, visible: stored.visible } : column;
        }));
      } catch {
        setParamColumns([...defaultParamColumns]);
      }
    } else {
      setParamColumns([...defaultParamColumns]);
    }
  });

  createEffect(() => {
    const columns = paramColumns();
    if (columns.length > 0) {
      localStorage.setItem(PARAM_COLUMNS_STORAGE_KEY, JSON.stringify(columns));
    }
  });

  const toggleParamColumn = (id: string) => {
    setParamColumns(columns => columns.map(column => column.id === id ? { ...column, visible: !column.visible } : column));
  };

  const exportParamsCSV = () => {
    const visibleCols = paramColumns().filter(c => c.visible);
    if (visibleCols.length === 0) return;
    const headers = visibleCols.map(c => c.label);
    const rows = filteredAllParams().map(param => {
      const objPath = param.name.includes('.') ? param.name.substring(0, param.name.lastIndexOf('.')) : '';
      return visibleCols.map(col => {
        switch (col.id) {
          case 'object': return objPath;
          case 'name': return param.name;
          case 'writable': return param.writable ? 'yes' : 'no';
          case 'value_type': return param.value_type || '';
          case 'value': return displayParameterValue(param.name, param.value);
          default: return '';
        }
      });
    });
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `parameters_${device()?.serial_number || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };


  const matchingMetrics = createMemo(() => (metricDefs() || []).filter(def => def.active));

  const rateMetricValues = createResource(
    () => {
      const ids = healthPanelMetrics(matchingMetrics()).filter(m => m.transform === 'rate').map(m => m.id);
      return `${serial()}|${ids.join(',')}`;
    },
    async (key) => {
      const [deviceSerial, idsValue] = key.split('|');
      const ids = idsValue ? idsValue.split(',').map(Number) : [];
      const values = await Promise.all(ids.map(async (id) => {
        const result = await api.getDeviceMetrics(deviceSerial, id, 'raw', 24);
        const sample = result.samples?.[result.samples.length - 1];
        return [id, sample?.value ?? null] as const;
      }));
      return new Map(values);
    },
  )[0];

  const groupedMetrics = createMemo(() => {
    const metrics = metricsTabMetrics(matchingMetrics());
    const groups: MetricDefinition[][] = [];
    const groupMap = new Map<string, MetricDefinition[]>();

    for (const m of metrics) {
      if (m.group) {
        const key = m.group;
        if (!groupMap.has(key)) {
          groupMap.set(key, []);
        }
        groupMap.get(key)!.push(m);
      } else {
        groups.push([m]);
      }
    }
    for (const arr of groupMap.values()) {
      groups.push(arr);
    }
    return groups;
  });

  const interfaceMetricGroups = createMemo(() => {
    const target = statsInterface();
    if (!target) return [] as InterfaceMetricDefinition[][];
    const names = (parameters() || []).map(parameter => parameter.name);
    const matching = (interfaceMetricDefs() || []).filter(def => def.active && def.interface_type === target.type && names.some(name => {
      const pattern = def.parameter_pattern.split('.');
      const path = name.split('.');
      return name.startsWith(target.path) && pattern.length === path.length && pattern.every((part, index) => part === '*' || part === path[index]);
    }));
    const grouped = new Map<string, InterfaceMetricDefinition[]>();
    for (const def of matching) {
      const key = def.group?.trim() || `metric-${def.id}`;
      const group = grouped.get(key) || [];
      group.push(def);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  });

  let messageTimeout: number | undefined;
  const closeFactoryResetModal = () => {
    setShowFactoryResetModal(false);
    setFactoryResetPassword('');
  };

  createEffect(() => {
    const s = serial();
    document.title = s ? `${s} - ${appName()}` : appName();
    onCleanup(() => { document.title = appName(); });
  });

  const showMessage = (type: 'success' | 'error', text: string, detail?: string) => {
    if (messageTimeout) window.clearTimeout(messageTimeout);
    setMessage({ type, text, detail });
    if (type === 'success') messageTimeout = window.setTimeout(() => setMessage(null), 5000);
  };
  onCleanup(() => {
    if (messageTimeout) window.clearTimeout(messageTimeout);
  });

  const handleReboot = async () => {
    if (!await confirm({ title: `Reboot CPE ${serial()}?`, description: 'ACS will queue a reboot task for the next available CWMP session. Service may be interrupted while the CPE restarts.', confirmLabel: 'Queue reboot' })) return;
    setActionLoading('reboot');
    try {
      await api.rebootDevice(serial());
      showMessage('success', 'Reboot task created.');
      refetchTasks();
    } catch (err) {
      showMessage('error', 'Reboot task was not created. Retry after checking the CPE session and API status.', (err as Error).message);
    }
    setActionLoading(null);
  };

  const handleFactoryReset = async () => {
    if (!factoryResetPassword()) return;
    setActionLoading('factory-reset');
    try {
      await api.factoryResetDevice(serial(), factoryResetPassword());
      closeFactoryResetModal();
      showMessage('success', 'Factory reset task created. Track its state in the task register.');
      refetchTasks();
    } catch (err) {
      showMessage('error', 'Factory reset task was rejected. Verify the account password and retry.', (err as Error).message);
    }
    setActionLoading(null);
  };

  const handleDelete = async () => {
    if (!await confirm({ title: `Delete CPE ${serial()}?`, description: 'This permanently removes the CPE record and its local operational history. A future Inform may register the device again.', confirmLabel: 'Delete CPE record', tone: 'danger' })) return;
    setActionLoading('delete');
    try {
      await api.deleteDevice(serial());
      navigate('/devices');
    } catch (err) {
      showMessage('error', 'The CPE record was not deleted. Retry after checking your permission and the API status.', (err as Error).message);
      setActionLoading(null);
    }
  };

  const deletePendingTask = async (task: Task) => {
    if (task.status !== 'pending' || !isFullAccess()) return;
    if (!await confirm({ title: `Delete pending task #${task.id}?`, description: `The ${task.type} task will be marked deleted and will not be sent to this CPE.`, confirmLabel: 'Delete task', tone: 'danger' })) return;
    setDeletingTask(task.id);
    try {
      await api.deletePendingTask(task.id);
      showMessage('success', 'Pending task deleted.');
      await refetchTasks();
    } catch (err) {
      showMessage('error', 'Could not delete the task. It may already have been sent to the CPE.', (err as Error).message);
      await refetchTasks();
    } finally {
      setDeletingTask(null);
    }
  };

  const handleSummon = async () => {
    setActionLoading('summon');
    try {
      const result = await api.connectionRequest(serial());
      showMessage('success', result.message);
      
      const hasTR181 = (parameters() || []).some(parameter => parameter.name.startsWith('Device.'));
      await api.getParameterValues(serial(), [hasTR181 ? 'Device.' : 'InternetGatewayDevice.']);
    } catch (err) {
      showMessage('error', 'Connection request failed. Verify reachability and credentials, then retry.', (err as Error).message);
    }
    setActionLoading(null);
  };

  const handleDeviceLogRefresh = async () => {
    if (!isFullAccess() || actionLoading() !== null) return;
    setActionLoading('device-log-refresh');
    try {
      const task = await api.getParameterValues(serial(), [DEVICE_LOG_PARAMETER]);
      await api.connectionRequest(serial());
      await waitForTask(task.id, 'Device log refresh');
      setDeviceLogPage(0);
      await refetchDeviceLog();
      showMessage('success', 'Device log updated from the CPE.');
    } catch (error) {
      showMessage('error', 'Could not update the device log from the CPE.', (error as Error).message);
      void refetchTasks();
    } finally {
      setActionLoading(null);
    }
  };

  const waitForTask = async (taskId: number, label: string, timeoutMs = 120_000): Promise<Task> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = (await api.getDeviceTasks(serial())).find(task => task.id === taskId);
      if (current?.status === 'completed') return current;
      if (current?.status === 'failed') throw new Error(current.error_message || `${label} failed.`);
      await new Promise(resolve => window.setTimeout(resolve, 1500));
    }
    throw new Error(`${label} timed out while waiting for the CPE session.`);
  };

  const handleRunIperf = async () => {
    const form = iperfForm();
    const port = Number(form.port);
    const maxTime = Number(form.maxTime);
    const parallel = Number(form.parallel);
    const bandwidth = Number(form.bandwidth);
    if (!form.serverAddr.trim()) {
      showMessage('error', 'Enter an iPerf server address.');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(maxTime) || maxTime < 1 || maxTime > 1800 || !Number.isInteger(parallel) || parallel < 1 || parallel > 32 || !Number.isFinite(bandwidth) || bandwidth < 0) {
      showMessage('error', 'Check the iPerf values: port 1–65535, duration 1–1800 s, parallel streams 1–32, bandwidth 0 or greater.');
      return;
    }

    setIperfRunning(true);
    setActionLoading('iperf');
    setIperfResult(null);
    const prefix = IPERF_CLIENT_ROOT;
    const requestIperfSession = async () => {
      try { await api.connectionRequest(serial()); } catch { /* The CPE may already have an active CWMP session. */ }
    };
    try {
      const runTest = async (mode: 'UPLOAD' | 'DOWNLOAD'): Promise<IperfRunResult> => {
        const configTask = await api.setParameterValues(serial(), {
          [prefix + 'ServerAddr']: form.serverAddr.trim(),
          [prefix + 'Port']: String(port),
          [prefix + 'TestMode']: mode,
          [prefix + 'ProtocolType']: form.protocolType,
          [prefix + 'MaxTime']: String(maxTime),
          [prefix + 'Parallel']: String(parallel),
          [prefix + 'Bandwidth']: String(bandwidth),
        });
        await requestIperfSession();
        await waitForTask(configTask.id, `${mode.toLowerCase()} iPerf configuration`);

        const startTask = await api.setParameterValues(serial(), { [prefix + 'DiagnosticsState']: 'Requested' });
        await requestIperfSession();
        await waitForTask(startTask.id, `${mode.toLowerCase()} iPerf start`);

        const deadline = Date.now() + Math.max(60_000, maxTime * 1000 + 45_000);
        let finalValues: Record<string, string> | null = null;
        while (Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 2000));
          const readTask = await api.getParameterValues(serial(), [
            prefix + 'DiagnosticsState', prefix + 'TestResult', prefix + 'Result',
            prefix + 'ReportTime', prefix + 'ErrorDescription',
          ]);
          await requestIperfSession();
          const completedRead = await waitForTask(readTask.id, `${mode.toLowerCase()} iPerf result read`);
          finalValues = (completedRead.result || {}) as Record<string, string>;
          const state = (finalValues[prefix + 'DiagnosticsState'] || '').toLowerCase();
          if (state.includes('complete') || state.includes('error') || finalValues[prefix + 'ErrorDescription']) break;
        }
        if (!finalValues) throw new Error(`The CPE did not return an iPerf ${mode.toLowerCase()} result.`);
        return { mode, values: finalValues };
      };
      const modes: Array<'UPLOAD' | 'DOWNLOAD'> = form.testMode === 'BOTH' ? ['UPLOAD', 'DOWNLOAD'] : [form.testMode];
      const results: IperfRunResult[] = [];
      for (const mode of modes) results.push(await runTest(mode));
      setIperfResult(results);
      const hasError = results.some(result => result.values[prefix + 'ErrorDescription']);
      if (hasError) showMessage('error', 'iPerf test completed with a CPE error.');
      else showMessage('success', form.testMode === 'BOTH' ? 'Upload and download tests completed.' : 'iPerf test completed.');
      await loadDeviceParameters();
      await refetchTasks();
    } catch (err) {
      showMessage('error', 'iPerf test was not completed.', (err as Error).message);
    } finally {
      setIperfRunning(false);
      setActionLoading(null);
    }
  };

  const handleRunNsLookup = async () => {
    const root = nsLookupRoot();
    const host = nsLookupHost().trim();
    const repetitions = Number(nsLookupRepetitions());
    const timeout = Number(nsLookupTimeout());
    if (!host) { showMessage('error', 'Enter a hostname to look up.'); return; }
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100 || !Number.isInteger(timeout) || timeout < 1 || timeout > 300000) {
      showMessage('error', 'Repetitions must be 1–100 and timeout must be 1–300000 ms.');
      return;
    }

    setNsLookupRunning(true);
    setActionLoading('nslookup');
    setNsLookupResult(null);
    const requestLookupSession = async () => {
      try { await api.connectionRequest(serial()); } catch { /* The CPE may already have an active CWMP session. */ }
    };
    try {
      const values: Record<string, string> = {
        [root + 'HostName']: host,
        [root + 'NumberOfRepetitions']: String(repetitions),
        [root + 'Timeout']: String(timeout),
      };
      if (nsLookupServer().trim()) values[root + 'DNSServer'] = nsLookupServer().trim();
      if (nsLookupInterface().trim()) values[root + 'Interface'] = nsLookupInterface().trim();
      const configTask = await api.setParameterValues(serial(), values);
      await requestLookupSession();
      await waitForTask(configTask.id, 'NS lookup configuration');

      const startTask = await api.setParameterValues(serial(), { [root + 'DiagnosticsState']: 'Requested' });
      await requestLookupSession();
      await waitForTask(startTask.id, 'NS lookup start');

      const deadline = Date.now() + Math.max(120_000, timeout + 60_000);
      let finalValues: Record<string, string> | null = null;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 2000));
        const readTask = await api.getParameterValues(serial(), [root]);
        await requestLookupSession();
        const completedRead = await waitForTask(readTask.id, 'NS lookup result read');
        finalValues = (completedRead.result || {}) as Record<string, string>;
        const state = (finalValues[root + 'DiagnosticsState'] || '').toLowerCase();
        if (state.includes('complete') || state.includes('error')) break;
      }
      if (!finalValues) throw new Error('The CPE did not return an NS lookup result.');
      setNsLookupResult(finalValues);
      const state = (finalValues[root + 'DiagnosticsState'] || '').toLowerCase();
      if (state.includes('error')) showMessage('error', 'NS lookup completed with a CPE error.', state);
      else if (state.includes('complete')) showMessage('success', 'NS lookup completed.');
      else showMessage('error', 'NS lookup timed out before the CPE completed it.');
      await loadDeviceParameters();
      await refetchTasks();
    } catch (error) {
      showMessage('error', 'NS lookup was not completed.', (error as Error).message);
    } finally {
      setNsLookupRunning(false);
      setActionLoading(null);
    }
  };

  const handleRunIpPing = async () => {
    const root = ipPingRoot();
    const host = ipPingHost().trim();
    const repetitions = Number(ipPingRepetitions());
    const timeout = Number(ipPingTimeout());
    const dataBlockSize = Number(ipPingDataBlockSize());
    const dscp = Number(ipPingDscp());
    if (!host) { showMessage('error', 'Enter an IP address or hostname to ping.'); return; }
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50 || !Number.isInteger(timeout) || timeout < 1 || timeout > 60000 || !Number.isInteger(dataBlockSize) || dataBlockSize < 1 || dataBlockSize > 65500 || !Number.isInteger(dscp) || dscp < 0 || dscp > 63) {
      showMessage('error', 'Check the ping values: repetitions 1–50, timeout 1–60000 ms, packet size 1–65500 bytes and DSCP 0–63.');
      return;
    }

    setIpPingRunning(true);
    setActionLoading('ipping');
    setIpPingResult(null);
    const requestPingSession = async () => {
      try { await api.connectionRequest(serial()); } catch { /* The CPE may already have an active CWMP session. */ }
    };
    try {
      const values: Record<string, string> = {
        [root + 'Host']: host,
        [root + 'NumberOfRepetitions']: String(repetitions),
        [root + 'Timeout']: String(timeout),
        [root + 'DataBlockSize']: String(dataBlockSize),
        [root + 'DSCP']: String(dscp),
      };
      if (ipPingInterface().trim()) values[root + 'Interface'] = ipPingInterface().trim();
      const configTask = await api.setParameterValues(serial(), values);
      await requestPingSession();
      await waitForTask(configTask.id, 'IP ping configuration');

      const startTask = await api.setParameterValues(serial(), { [root + 'DiagnosticsState']: 'Requested' });
      await requestPingSession();
      await waitForTask(startTask.id, 'IP ping start');

      const deadline = Date.now() + Math.min(300_000, Math.max(60_000, timeout * repetitions + 45_000));
      let finalValues: Record<string, string> | null = null;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 2000));
        const readTask = await api.getParameterValues(serial(), [root]);
        await requestPingSession();
        const completedRead = await waitForTask(readTask.id, 'IP ping result read');
        finalValues = (completedRead.result || {}) as Record<string, string>;
        const state = (finalValues[root + 'DiagnosticsState'] || '').toLowerCase();
        if (state.includes('complete') || state.startsWith('error')) break;
      }
      if (!finalValues) throw new Error('The CPE did not return an IP ping result.');
      setIpPingResult(finalValues);
      const state = (finalValues[root + 'DiagnosticsState'] || '').toLowerCase();
      if (state.startsWith('error')) showMessage('error', 'IP ping completed with a CPE error.', state);
      else if (state.includes('complete')) showMessage('success', 'IP ping completed.');
      else showMessage('error', 'IP ping timed out before the CPE completed it.');
      await loadDeviceParameters();
      await refetchTasks();
    } catch (error) {
      showMessage('error', 'IP ping was not completed.', (error as Error).message);
    } finally {
      setIpPingRunning(false);
      setActionLoading(null);
    }
  };

  const handleRunTraceRoute = async () => {
    const root = traceRouteRoot();
    const host = traceRouteHost().trim();
    const maxHops = Number(traceRouteMaxHops());
    const tries = Number(traceRouteTries());
    const timeout = Number(traceRouteTimeout());
    const dataBlockSize = Number(traceRouteDataBlockSize());
    const dscp = Number(traceRouteDscp());
    if (!host) { showMessage('error', 'Enter a destination IP address or hostname.'); return; }
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 64 || !Number.isInteger(tries) || tries < 1 || tries > 10 || !Number.isInteger(timeout) || timeout < 1 || timeout > 120000 || !Number.isInteger(dataBlockSize) || dataBlockSize < 1 || dataBlockSize > 65500 || !Number.isInteger(dscp) || dscp < 0 || dscp > 63) {
      showMessage('error', 'Check the traceroute values: hops 1–64, tries 1–10, timeout 1–120000 ms, packet size 1–65500 bytes and DSCP 0–63.');
      return;
    }

    setTraceRouteRunning(true);
    setActionLoading('traceroute');
    setTraceRouteResult(null);
    const requestTraceRouteSession = async () => {
      try { await api.connectionRequest(serial()); } catch { /* The CPE may already have an active CWMP session. */ }
    };
    try {
      const values: Record<string, string> = {
        [root + 'Host']: host,
        [root + 'MaxHopCount']: String(maxHops),
        [root + 'NumberOfTries']: String(tries),
        [root + 'Timeout']: String(timeout),
        [root + 'DataBlockSize']: String(dataBlockSize),
        [root + 'DSCP']: String(dscp),
      };
      if (traceRouteInterface().trim()) values[root + 'Interface'] = traceRouteInterface().trim();
      const configTask = await api.setParameterValues(serial(), values);
      await requestTraceRouteSession();
      await waitForTask(configTask.id, 'Traceroute configuration');

      const startTask = await api.setParameterValues(serial(), { [root + 'DiagnosticsState']: 'Requested' });
      await requestTraceRouteSession();
      await waitForTask(startTask.id, 'Traceroute start');

      const deadline = Date.now() + Math.min(600_000, Math.max(120_000, timeout * maxHops + 60_000));
      let finalValues: Record<string, string> | null = null;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 2500));
        const readTask = await api.getParameterValues(serial(), [root]);
        await requestTraceRouteSession();
        const completedRead = await waitForTask(readTask.id, 'Traceroute result read');
        finalValues = (completedRead.result || {}) as Record<string, string>;
        const state = (finalValues[root + 'DiagnosticsState'] || '').toLowerCase();
        if (state.includes('complete') || state.startsWith('error')) break;
      }
      if (!finalValues) throw new Error('The CPE did not return a traceroute result.');
      setTraceRouteResult(finalValues);
      const state = (finalValues[root + 'DiagnosticsState'] || '').toLowerCase();
      if (state.startsWith('error')) showMessage('error', 'Traceroute completed with a CPE error.', state);
      else if (state.includes('complete')) showMessage('success', 'Traceroute completed.');
      else showMessage('error', 'Traceroute timed out before the CPE completed it.');
      await loadDeviceParameters();
      await refetchTasks();
    } catch (error) {
      showMessage('error', 'Traceroute was not completed.', (error as Error).message);
    } finally {
      setTraceRouteRunning(false);
      setActionLoading(null);
    }
  };

  const handleSetWifiEnabled = async (index: number, enabled: boolean) => {
    if (!await confirm({ title: `${enabled ? 'Enable' : 'Disable'} SSID${index}?`, description: `${enabled ? 'Wireless clients may reconnect when the task completes.' : 'Connected clients on this SSID will lose network access when the task completes.'}`, confirmLabel: `${enabled ? 'Enable' : 'Disable'} SSID${index}`, tone: enabled ? 'primary' : 'danger' })) return;
    
    setActionLoading(`wifi-enable-${index}`);
    try {
      const prefix = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.`;
      await api.setParameterValues(serial(), {
        [prefix + 'Enable']: enabled ? '1' : '0'
      });
      showMessage('success', `SSID${index} ${enabled ? 'enabled' : 'disabled'} task created.`);
      refetchTasks();
    } catch (err) {
      showMessage('error', `SSID${index} state was not changed. Check the CPE session and retry.`, (err as Error).message);
    }
    setActionLoading(null);
  };

  const handleDeleteWifiSSID = async (index: number, ssid: string) => {
    if (!isFullAccess() || actionLoading() || !await confirm({ title: `Delete SSID${index}?`, description: `This permanently removes the Wi-Fi object "${ssid}" and its settings from the device. Connected clients will lose access.`, confirmLabel: 'Delete SSID', tone: 'danger' })) return;
    setActionLoading(`wifi-delete-${index}`);
    try {
      const task = await api.deleteWifiSSID(serial(), index);
      setFeatureRefreshTaskID(task.id);
      notify({ tone: 'success', title: `SSID${index} deletion queued`, detail: `CWMP task #${task.id} will remove the Wi-Fi object at the next device session.` });
      await refetchTasks();
    } catch (error) {
      notify({ tone: 'error', title: `Could not delete SSID${index}`, detail: (error as Error).message, persistent: true });
    } finally {
      setActionLoading(null);
    }
  };

  const handleSetWifiRadioEnabled = async (radio: WifiRadio, enabled: boolean) => {
    const label = `Radio ${radio.index}`;
    if (!await confirm({ title: `${enabled ? 'Enable' : 'Disable'} ${label}?`, description: `${enabled ? 'Wireless service may become available when the task completes.' : 'Wireless service on this radio will be disabled when the task completes.'}`, confirmLabel: `${enabled ? 'Enable' : 'Disable'} ${label}`, tone: enabled ? 'primary' : 'danger' })) return;

    setActionLoading(`wifi-radio-enable-${radio.index}`);
    try {
      await api.setParameterValues(serial(), { [radio.enablePath]: enabled ? '1' : '0' });
      showMessage('success', `${label} ${enabled ? 'enabled' : 'disabled'} task created.`);
      refetchTasks();
    } catch (err) {
      showMessage('error', `${label} state was not changed. Check the CPE session and retry.`, (err as Error).message);
    }
    setActionLoading(null);
  };

  const toggleParam = async (paramPath: string, value: string, successMsg: string) => {
    const key = `toggle-${paramPath}`;
    setActionLoading(key);
    try {
      await api.setParameterValues(serial(), { [paramPath]: value });
      showMessage('success', `${successMsg} task created.`);
      refetchTasks();
    } catch (err) {
      showMessage('error', `${successMsg} was not applied. Check the CPE session and retry.`, (err as Error).message);
    }
    setActionLoading(null);
  };

  const handleWanEnable = async (wan: WanProfile, enable: boolean) => {
    await toggleParam(wan.path + 'Enable', enable ? '1' : '0', `WAN ${wan.name} ${enable ? 'enabled' : 'disabled'}`);
  };

  const handleWanTie = async (wan: WanProfile, portNumber: number, kind: 'lan' | 'ssid', check: boolean) => {
    if (!wan.portParams) {
      showMessage('error', 'This CPE does not expose a supported WAN port binding parameter.');
      return;
    }
    const key = `wan-tie-${wan.path}-${kind}${portNumber}`;
    setActionLoading(key);
    try {
      const params = buildExclusiveTieParams(wanProfiles(), wan, portNumber, kind, check);
      if (Object.keys(params).length === 0) {
        showMessage('error', 'This CPE does not expose a supported WAN port binding parameter.');
        setActionLoading(null);
        return;
      }
      await api.setParameterValues(serial(), params);
      const portLabel = kind === 'lan' ? `L${portNumber}` : `S${portNumber}`;
      showMessage('success', `WAN tie ${portLabel} ${check ? 'assigned to' : 'removed from'} ${wan.name} task created.`);
      refetchTasks();
      setActionLoading(null);
    } catch (err) {
      showMessage('error', 'WAN tie change was not applied. Check the CPE session and retry.', (err as Error).message);
      setActionLoading(null);
    }
  };

  const handleLanEnable = async (index: number, enable: boolean) => {
    const prefix = `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${index}.`;
    await toggleParam(prefix + 'Enable', enable ? '1' : '0', `LAN${index} ${enable ? 'enabled' : 'disabled'}`);
  };

  const handleLanL3 = async (index: number, enable: boolean) => {
    const prefix = `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${index}.`;
    await toggleParam(prefix + 'X_HW_L3Enable', enable ? '1' : '0', `LAN${index} L3 ${enable ? 'enabled' : 'disabled'}`);
  };

  const handleEditConnCreds = () => {
    const d = device();
    if (!d) return;
    setConnCredMode(d.conn_cred_mode || 'inherit');
    setConnCredUsername(d.conn_cred_username || '');
    setConnCredPassword('');
    setEditingConnCreds(true);
  };

  const handleCancelConnCreds = () => {
    setEditingConnCreds(false);
    setConnCredMode('inherit');
    setConnCredUsername('');
    setConnCredPassword('');
  };

  const handleSaveConnCreds = async () => {
    setActionLoading('conn-creds');
    try {
      const body: { mode: string; username?: string; password?: string } = { mode: connCredMode() };
      if (connCredMode() === 'custom') {
        body.username = connCredUsername();
        body.password = connCredPassword();
      }
      await api.updateConnCredentials(serial(), body);
      showMessage('success', 'Connection-request credentials updated.');
      refetchDevice();
      handleCancelConnCreds();
    } catch (err) {
      showMessage('error', 'Connection-request credentials were not saved.', (err as Error).message);
    }
    setActionLoading(null);
  };

  const handleGenerateConnCreds = async () => {
    setActionLoading('conn-creds-gen');
    try {
      const result = await api.generateConnCredentials(serial());
      setGeneratedCred({ username: result.username, password: result.password });
      refetchDevice();
    } catch (err) {
      showMessage('error', 'Failed to generate credentials.', (err as Error).message);
    }
    setActionLoading(null);
  };

  const refreshAll = () => { refetchDevice(); loadDeviceParameters(); refetchTasks(); refetchSnapshots(); if (activeTab() === 'log') void refetchDeviceLog(); };

  createEffect(() => {
    if (autoRefreshEnabled() !== 'true') return;
    const interval = Number(systemSettings()?.auto_refresh_interval ?? 30);
    if (!Number.isFinite(interval) || interval <= 0) return;
    const timer = window.setInterval(() => {
      if (autoRefreshRunning() || document.visibilityState !== 'visible') return;
      setAutoRefreshRunning(true);
      const requests: Promise<unknown>[] = [Promise.resolve(refetchDevice()), Promise.resolve(refetchDeviceTaskCounts()), Promise.resolve(refetchFaultCounts())];
      switch (activeTab()) {
        case 'overview':
        case 'features':
        case 'hosts':
        case 'credentials':
        case 'diagnostic':
          requests.push(Promise.resolve(loadDeviceParameters()));
          break;
        case 'tasks':
          requests.push(Promise.resolve(refetchTaskRows()));
          break;
        case 'faults':
          requests.push(Promise.resolve(refetchFaultRows()));
          break;
        case 'snapshots':
          requests.push(Promise.resolve(refetchSnapshots()), Promise.resolve(loadDeviceParameters()));
          break;
        case 'metrics':
          setAutoRefreshTick(value => value + 1);
          break;
      }
      if (statsInterface()) setAutoRefreshTick(value => value + 1);
      void Promise.allSettled(requests).finally(() => setAutoRefreshRunning(false));
    }, interval * 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  const formatDate = (dateStr: string | null | undefined) => {
    return formatDateTime(dateStr);
  };

  const getDeviceUptime = () => {
    const params = parameters() || [];
    const uptimeParam = params.find(p => p.name.endsWith('DeviceInfo.UpTime'));
    return uptimeParam?.value || null;
  };

  const getParamValue = (keywords: string[]) => {
    const params = parameters() || [];
    for (const kw of keywords) {
      const found = params.find(p => p.name.toLowerCase().includes(kw.toLowerCase()));
      if (found) return found.value;
    }
    return '-';
  };

  const getRxPower = () => {
    const val = getParamValue(['RXPower', 'RxPower', 'OpticalPower']);
    if (val === '-') return '-';
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    if (num <= 0) return val;
    if (num > 0 && num < 10000) {
      const dBm = 10 * Math.log10(num / 10000);
      return dBm.toFixed(2);
    }
    if (Math.abs(num) > 100) return (num / 100).toFixed(2);
    return num.toFixed(2);
  };

  const getTemperature = () => {
    const val = getParamValue(['TransceiverTemperature', 'TemperatureStatus.TemperatureSensor.1.Value', 'OpticalTemperature', 'Temperature']);
    if (val === '-') return '-';
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    if (num > 1000) return (num / 256).toFixed(1);
    if (num > 100) return (num / 10).toFixed(1);
    return num.toFixed(1);
  };

  const getTempColor = () => {
    const temp = parseFloat(getTemperature());
    if (isNaN(temp)) return 'text-muted';
    if (temp < 40) return 'text-emerald-400';
    if (temp < 55) return 'text-amber-400';
    return 'text-rose-400';
  };

  const getRxPowerColor = () => {
    const rx = parseFloat(getRxPower());
    if (isNaN(rx)) return 'text-muted';
    if (rx > -20) return 'text-emerald-400';
    if (rx > -25) return 'text-amber-400';
    return 'text-rose-400';
  };

  const getUptimeColor = () => {
    const uptime = getDeviceUptime();
    if (!uptime) return 'text-muted';
    const secs = parseInt(uptime);
    if (secs > 86400 * 7) return 'text-emerald-400';
    if (secs > 86400) return 'text-sky-400';
    return 'text-amber-400';
  };

  const healthTileGroups = createMemo<HealthTileGroup[]>(() => {
    const defs = healthPanelMetrics(matchingMetrics());
    if (defs.length > 0) {
      const tiles = defs.map(def => {
        const rateValue = def.transform === 'rate' ? rateMetricValues()?.get(def.id) : undefined;
        const v = rateValue ?? findHealthValue(parameters() || [], def);
        const range = def.display_format === 'gauge' ? gaugeRange(v, def) : undefined;
        return {
          label: def.name,
          value: formatHealthValue(v, def),
          color: healthColor(v, def),
          raw: v,
          format: def.display_format,
          min: range?.min,
          max: range?.max,
          animated: def.gauge_animated,
          thresholds: def.thresholds,
          arc: def.gauge_arc,
          pointer: def.gauge_pointer,
          gaugeStyle: def.gauge_style || 'basic',
          size: def.health_size || 'small',
        };
      });
      const groups: HealthTileGroup[] = [];
      defs.forEach((def, index) => {
        const groupName = def.group?.trim() || '';
        const existing = groupName ? groups.find(g => g.label === groupName) : undefined;
        if (existing) {
          existing.tiles.push(tiles[index]);
          if (tiles[index].size === 'large' || (tiles[index].size === 'medium' && existing.size === 'small')) existing.size = tiles[index].size;
        } else {
          groups.push({ label: groupName || undefined, tiles: [tiles[index]], size: tiles[index].size || 'small' });
        }
      });
      return groups;
    }
    return [
      { tiles: [{ label: 'Uptime', value: getDeviceUptime() ? formatUptime(getDeviceUptime()!) : '-', color: getUptimeColor(), format: 'number', size: 'small' }], size: 'small' },
      { tiles: [{ label: 'RX dBm', value: getRxPower(), color: getRxPowerColor(), format: 'number', size: 'small' }], size: 'small' },
      { tiles: [{ label: 'Temperature', value: `${getTemperature()}°`, color: getTempColor(), format: 'number', size: 'small' }], size: 'small' },
    ];
  });

  const wanProfiles = createMemo(() => getWanProfiles(parameters() || []));
  const diagnosticInterfaces = createMemo(() => wanProfiles().map(wan => ({ path: wan.path, name: wan.name })));

  const getLanInterfaces = () => {
    const params = parameters() || [];
    const lans: Array<{
      index: number;
      name: string;
      mac: string;
      status: string;
      duplex: string;
      speed: string;
      l3Enable: string;
      enabled: boolean;
    }> = [];

    for (let i = 1; i <= 8; i++) {
      const prefix = `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.`;
      const getVal = (suffix: string) => params.find(p => p.name === prefix + suffix)?.value;

      const name = getVal('Name');
      const mac = getVal('MACAddress');
      const status = getVal('Status');
      const enable = getVal('Enable');

      if (!name && !mac && !status) continue;

      lans.push({
        index: i,
        name: name || `LAN${i}`,
        mac: mac || '-',
        status: status || '-',
        duplex: getVal('X_HW_DuplexMode') || '-',
        speed: getVal('X_HW_Speed') || '-',
        l3Enable: getVal('X_HW_L3Enable') || '-',
        enabled: enable === '1' || enable === 'true',
      });
    }
    return lans;
  };

  const getWlanConfigs = () => {
    const params = parameters() || [];
    const wlans: Array<{
      index: number;
      enabled: boolean;
      status: string;
      ssid: string;
      security: string;
      password: string;
      frequency: string;
      channel: string;
      maxBitrate: string;
    }> = [];
    
    for (let i = 1; i <= 8; i++) {
      const prefix = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.`;
      const getVal = (suffix: string) => params.find(p => p.name === prefix + suffix)?.value;
      
      const enabled = getVal('Enable');
      const ssid = getVal('SSID');
      
      if (ssid || enabled) {
        wlans.push({
          index: i,
          enabled: enabled === '1' || enabled === 'true',
          status: getVal('Status') || (enabled === '1' ? 'Up' : 'Down'),
          ssid: ssid || '-',
          security: getVal('BeaconType') || getVal('WPAEncryptionModes') || '-',
          password: getVal('PreSharedKey.1.KeyPassphrase') || getVal('KeyPassphrase') || getVal('X_HW_WPAKey') || '******',
          frequency: getVal('OperatingFrequencyBand') || (i <= 4 ? '2.4GHz' : '5GHz'),
          channel: getVal('Channel') || 'Auto',
          maxBitrate: getVal('MaxBitRate') || getVal('X_HW_MaxBitRate') || '-',
        });
      }
    }
    return wlans;
  };

  type WifiRadio = {
    index: number;
    enabled: boolean;
    frequency: string;
    enablePath: string;
  };

  const getWifiRadios = (): WifiRadio[] => {
    const radios = new Map<number, { enable?: DeviceParameter; frequency?: DeviceParameter }>();
    for (const parameter of parameters() || []) {
      const match = parameter.name.match(/^InternetGatewayDevice\.LANDevice\.1\.WiFi\.Radio\.(\d+)\.(Enable|OperatingFrequencyBand)$/);
      if (!match) continue;
      const index = Number(match[1]);
      const radio = radios.get(index) || {};
      if (match[2] === 'Enable') radio.enable = parameter;
      else radio.frequency = parameter;
      radios.set(index, radio);
    }

    return [...radios.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, radio]) => radio.enable)
      .map(([index, radio]) => ({
        index,
        enabled: radio.enable!.value === '1' || radio.enable!.value === 'true',
        frequency: radio.frequency?.value || '—',
        enablePath: radio.enable!.name,
      }));
  };

  const getHosts = () => {
    const params = parameters() || [];
    const hosts: Array<{ index: number; hostname: string; ip: string; ipv6: string; mac: string; negRate: string; interface: string; rssi?: string; uptime?: string }> = [];
    
    const hostIndices = [...new Set(params.filter(p => p.name.includes('Hosts.Host.')).map(p => {
      const match = p.name.match(/Host\.(\d+)\./);
      return match ? parseInt(match[1]) : 0;
    }))].filter(i => i > 0);

    const getInterfaceName = (path: string) => {
      const prefix = path.replace(/\.+$/, '');
      return params.find(parameter => parameter.name === `${prefix}.Name`)?.value?.trim() || '';
    };
    
    const getWifiBand = (ssidIdx: number): string => {
      const wlanPrefix = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${ssidIdx}.`;
      const channel = params.find(p => p.name === wlanPrefix + 'Channel')?.value;
      const standard = params.find(p => p.name === wlanPrefix + 'Standard')?.value;
      const freq = params.find(p => p.name === wlanPrefix + 'X_HW_FrequencyBand')?.value;
      
      if (freq) {
        if (freq.includes('5') || freq.includes('5GHz')) return '5GHz';
        if (freq.includes('2.4') || freq.includes('2.4GHz')) return '2.4GHz';
      }
      
      if (channel) {
        const ch = parseInt(channel);
        if (ch >= 36 && ch <= 177) return '5GHz';
        if (ch >= 1 && ch <= 14) return '2.4GHz';
      }
      
      if (standard) {
        if (standard.includes('ac') || standard.includes('ax')) return '5GHz';
        if (standard.includes('n') || standard.includes('g') || standard.includes('b')) return '2.4GHz';
      }
      
      return ssidIdx >= 5 ? '5GHz' : '2.4GHz';
    };

    hostIndices.forEach(i => {
      const prefix = `InternetGatewayDevice.LANDevice.1.Hosts.Host.${i}.`;
      const getVal = (suffix: string) => params.find(p => p.name === prefix + suffix)?.value || '-';
      
      let interfaceType = 'LAN';
      const layer2 = getVal('Layer2Interface');
      const intfType = getVal('InterfaceType');
      
      if (layer2 && layer2 !== '-') {
        const interfaceName = getInterfaceName(layer2);
        const wlanMatch = layer2.match(/WLANConfiguration\.(\d+)/);
        if (wlanMatch) {
          const ssidIdx = parseInt(wlanMatch[1]);
          interfaceType = `WiFi ${getWifiBand(ssidIdx)}${interfaceName ? ` · ${interfaceName}` : ''}`;
        } else if (layer2.includes('Ethernet') || layer2.includes('LANEthernet')) {
          interfaceType = `Ethernet${interfaceName ? ` · ${interfaceName}` : ''}`;
        } else if (interfaceName) {
          interfaceType = interfaceName;
        }
      } else if (intfType && intfType !== '-') {
        if (intfType === 'Ethernet' || intfType === 'LAN') {
          interfaceType = 'Ethernet';
        } else if (intfType === 'WiFi' || intfType === 'WLAN' || intfType === '802.11') {
          interfaceType = 'WiFi';
        } else if (intfType !== 'Unknown') {
          interfaceType = intfType;
        }
      }
      
      hosts.push({
        index: i,
        hostname: getVal('HostName'),
        ip: getVal('IPAddress'),
        ipv6: getVal('IPv6Address'),
        mac: getVal('MACAddress'),
        negRate: getVal('X_HW_NegotiatedRate'),
        interface: interfaceType,
      });
    });

    for (let ssidIdx = 1; ssidIdx <= 8; ssidIdx++) {
      const assocIndices = [...new Set(params.filter(p => 
        p.name.includes(`WLANConfiguration.${ssidIdx}.AssociatedDevice.`)
      ).map(p => {
        const match = p.name.match(/AssociatedDevice\.(\d+)\./);
        return match ? parseInt(match[1]) : 0;
      }))].filter(i => i > 0);

      assocIndices.forEach(i => {
        const prefix = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${ssidIdx}.AssociatedDevice.${i}.`;
        const getVal = (suffix: string) => params.find(p => p.name === prefix + suffix)?.value || '-';
        
        const mac = getVal('AssociatedDeviceMACAddress');
        if (mac && mac !== '-') {
          const exists = hosts.some(h => h.mac.toLowerCase() === mac.toLowerCase());
          if (!exists) {
            hosts.push({
              index: 100 + ssidIdx * 10 + i,
              hostname: getVal('X_HW_AssociatedDevicedescriptions') || '-',
              ip: getVal('AssociatedDeviceIPAddress'),
              ipv6: '-',
              mac: mac,
              negRate: '-',
              interface: `WiFi ${getWifiBand(ssidIdx)}${getInterfaceName(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${ssidIdx}`) ? ` · ${getInterfaceName(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${ssidIdx}`)}` : ''}`,
              rssi: getVal('X_HW_RSSI'),
              uptime: getVal('X_HW_Uptime'),
            });
          }
        }
      });
    }
    return hosts;
  };

  const filteredAllParams = () => {
    let params = allParameters() || [];
    const filter = paramFilter().toLowerCase();
    if (filter) {
      params = params.filter(p => 
        p.name.toLowerCase().includes(filter) || p.value.toLowerCase().includes(filter)
      );
    }
    return applyColumnFilters(params, paramColumnFilters(), (p, colId) => {
      switch (colId) {
        case 'object': return p.name.includes('.') ? p.name.substring(0, p.name.lastIndexOf('.')) : '';
        case 'name': return p.name || '';
        case 'writable': return p.writable ? 'yes' : 'no';
        case 'value_type': return p.value_type || '';
        case 'value': return p.value || '';
        default: return '';
      }
    });
  };

  const filteredHosts = () => {
    let hosts = getHosts();
    const query = hostSearch().toLowerCase().trim();
    if (query) {
      hosts = hosts.filter(h =>
        h.hostname?.toLowerCase().includes(query) ||
        h.ip?.toLowerCase().includes(query) ||
        h.mac?.toLowerCase().includes(query) ||
        h.interface?.toLowerCase().includes(query)
      );
    }
    return applyColumnFilters(hosts, hostColumnFilters(), (h, colId) => {
      switch (colId) {
        case 'hostname': return h.hostname || '';
        case 'ip': return h.ip || '';
        case 'ipv6': return h.ipv6 || '';
        case 'mac': return h.mac || '';
        case 'negRate': return h.negRate || '';
        case 'interface': return h.interface || '';
        case 'rssi': return h.rssi || '';
        case 'uptime': return h.uptime || '';
        default: return '';
      }
    });
  };

  const toggleHostColumn = (id: string) => {
    setHostColumns(columns => columns.map(column => column.id === id ? { ...column, visible: !column.visible } : column));
  };

  const isSensitiveParameter = (name: string) => /password|passphrase|presharedkey|privatekey|secret/i.test(name);
  const displayParameterValue = (name: string, value: string) => isSensitiveParameter(name) && !showSensitive() ? '••••••••' : value;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed': return 'badge-success';
      case 'pending': return 'badge-warning';
      case 'sent': return 'bg-sky-500/15 text-sky-400';
      case 'failed': return 'badge-error';
      case 'deleted': return 'bg-zinc-500/15 text-zinc-400';
      default: return 'bg-zinc-700 text-secondary';
    }
  };

  const featureControlGroups = (controls: ProvisioningFeature['controls']) => {
    const grouped = new Map<string, typeof controls>();
    for (const control of controls) {
      const name = control.group?.trim() || '';
      const current = grouped.get(name) || [];
      current.push(control);
      grouped.set(name, current);
    }
    return [...grouped.entries()].sort(([firstName], [secondName]) => Number(Boolean(firstName)) - Number(Boolean(secondName))).map(([name, groupControls]) => ({ name, controls: groupControls }));
  };

  const renderFeatureControls = (feature: ProvisioningFeature, controls: ProvisioningFeature['controls']) => <For each={controls}>{control => {
    const parameter = () => (parameters() || []).find(item => item.name === control.parameter);
    const description = () => control.description?.trim();
    return <Show when={control.type === 'boolean'} fallback={
      <Show when={control.type === 'string' || control.type === 'int' || control.type === 'unsignedInt'} fallback={
        <Show when={parameter()?.writable === true}>
          <div class="rounded border border-subtle p-4 lg:col-span-2">
            <div class="mb-3 flex items-center justify-between gap-3"><div><h3 class="text-sm font-medium text-primary">{control.label}</h3><p class="font-mono text-[10px] text-muted">{control.parameter}</p><Show when={description()}><p class="mt-1 text-xs text-secondary">{description()}</p></Show></div><button type="button" class="btn btn-secondary text-xs" disabled={!isFullAccess() || featureAction() !== null} onClick={() => void addTemplateFeatureObject(feature.id, control.key, control.label)}><Plus size={13} />Add object</button></div>
            <Show when={featureObjectInstances(control.parameter).length > 0} fallback={<div class="py-3 text-xs text-muted">No objects exist yet. Create one to discover its parameters.</div>}>
              <div class="overflow-x-auto"><table class="data-table w-full min-w-max text-xs"><thead><tr><th class="text-left">Instance</th><For each={featureObjectColumns(control.parameter)}>{column => <th class="text-left">{control.object_fields?.find(field => field.name === column)?.label || column}</th>}</For><th class="text-right">Actions</th></tr></thead><tbody><For each={featureObjectInstances(control.parameter)}>{instance => <tr><td class="font-mono">{instance}</td><For each={featureObjectColumns(control.parameter)}>{column => {
                const path = `${control.parameter}${instance}.${column}`;
                const value = () => (parameters() || []).find(item => item.name === path)?.value || '—';
                return <td class="max-w-64 truncate">{value()}</td>;
              }}</For><td class="whitespace-nowrap text-right"><button type="button" class="icon-button" aria-label={`Edit ${control.label} ${instance}`} title="Edit object parameters" disabled={!isFullAccess() || featureAction() !== null} onClick={() => openFeatureObjectEditor(feature.id, control.key, control.label, control.parameter, instance, control.object_fields?.map(field => ({ ...field, value: '', writable: false })))}><Edit size={13} /></button><button type="button" class="icon-button text-rose-400" aria-label={`Delete ${control.label} ${instance}`} title="Delete object" disabled={!isFullAccess() || featureAction() !== null} onClick={() => void deleteFeatureObject(feature.id, control.key, control.label, instance)}><Trash2 size={13} /></button></td></tr>}</For></tbody></table></div>
            </Show>
          </div>
        </Show>
      }>
        <Show when={parameter()?.writable === true}>
          <label class="block rounded border border-subtle p-4">
            <span class="mb-2 block text-sm font-medium text-primary">{control.label}</span>
            <span class="mb-2 block truncate font-mono text-[10px] text-muted" title={control.parameter}>{control.parameter}</span>
            <Show when={description()}><p class="mb-2 text-xs text-secondary">{description()}</p></Show>
            <Show when={(control.options?.length || 0) > 0} fallback={<input class="input w-full" type={control.type === 'string' ? 'text' : 'number'} step={control.type === 'string' ? undefined : '1'} min={control.type === 'unsignedInt' ? '0' : undefined} value={parameter()?.value || ''} disabled={!isFullAccess() || featureAction() !== null} onChange={event => void setTemplateFeatureString(feature.id, control.key, control.label, event.currentTarget.value)} />}>
              <select class="input w-full" value={parameter()?.value || ''} disabled={!isFullAccess() || featureAction() !== null} onChange={event => void setTemplateFeatureString(feature.id, control.key, control.label, event.currentTarget.value)}><Show when={!control.options?.includes(parameter()?.value || '')}><option value={parameter()?.value || ''}>{parameter()?.value || 'Select a value'}</option></Show><For each={control.options || []}>{option => <option value={option}>{option}</option>}</For></select>
            </Show>
          </label>
        </Show>
      </Show>
    }>
      <Show when={parameter()?.writable === true}>
        <label class="flex items-center justify-between gap-3 rounded border border-subtle p-4">
          <span class="min-w-0"><span class="block text-sm font-medium text-primary">{control.label}</span><span class="block truncate font-mono text-[10px] text-muted" title={control.parameter}>{control.parameter}</span><Show when={description()}><span class="mt-1 block text-xs text-secondary">{description()}</span></Show></span>
          <input type="checkbox" class="h-4 w-4 accent-sky-500" checked={parameter()?.value.toLowerCase() === (control.enabled_value || '1').toLowerCase()} disabled={!isFullAccess() || featureAction() !== null} onChange={event => void toggleTemplateFeature(feature.id, control.key, control.label, control.group, event.currentTarget.checked)} />
        </label>
      </Show>
    </Show>;
  }}</For>;

  return (
    <div class="space-y-5">
      {/* Header - More prominent serial/status */}
      <div class="device-detail-header flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
        <div class="flex-1">
          <div class="flex items-center gap-3 mb-1">
            <A href="/devices" class="icon-button" aria-label="Back to CPE inventory">
              <ArrowLeft size={18} />
            </A>
            <Show when={device()}>
              <span class={`px-2.5 py-1 rounded-md text-xs font-medium ${device()?.online ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'}`}>
                {device()?.online ? 'Online' : 'Offline'}
              </span>
            </Show>
          </div>
          <Show when={device()}>
            <h1 class="text-xl sm:text-2xl font-bold text-primary font-mono tracking-tight">{device()?.serial_number}</h1>
            <p class="text-sm text-muted mt-0.5">{device()?.manufacturer} {device()?.product_class}</p>
          </Show>
        </div>
        <div class="flex gap-2 items-center">
          <Show when={device()}>
            <DeviceTagPicker device={device()!} tags={tagCatalog() || []} writable={isFullAccess()} onUpdated={() => { void refetchDevice(); }} />
          </Show>
          <Show when={isFullAccess()}><button onClick={handleSummon} disabled={actionLoading() !== null} class="btn btn-primary text-xs sm:text-sm">
            <Zap size={14} />
            <span class="hidden sm:inline">{actionLoading() === 'summon' ? '...' : 'Summon'}</span>
          </button></Show>
            <div class="relative" ref={actionsMenu}>
              <button type="button" class="icon-button" aria-label="Device actions" aria-haspopup="menu" aria-expanded={showActionsMenu()} onClick={() => setShowActionsMenu(value => !value)}>
                <MoreVertical size={18} />
              </button>
              <Show when={showActionsMenu()}>
                <div class="absolute right-0 top-full z-50 mt-2 min-w-44 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu">
                  <button type="button" role="menuitemcheckbox" aria-checked={autoRefreshEnabled() === 'true'} class="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-primary hover:bg-base" onClick={() => { setAutoRefreshEnabled(autoRefreshEnabled() === 'true' ? 'false' : 'true'); setShowActionsMenu(false); }}>
                    Auto-refresh
                    <span class={autoRefreshEnabled() === 'true' ? 'text-emerald-400' : 'text-rose-400'}>{autoRefreshEnabled() === 'true' ? 'On' : 'Off'}</span>
                  </button>
                  <Show when={isFullAccess()}>
                  <div class="my-1 border-t border-subtle" role="separator"></div>
                  <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-base disabled:opacity-50" disabled={actionLoading() !== null} onClick={() => { setShowActionsMenu(false); void handleReboot(); }}>
                    Reboot
                  </button>
                  <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-base disabled:opacity-50" disabled={actionLoading() !== null} onClick={() => { setShowActionsMenu(false); setShowFactoryResetModal(true); }}>
                    Factory reset
                  </button>
                  <div class="my-1 border-t border-subtle" role="separator"></div>
                  <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-sm text-rose-400 hover:bg-rose-500/10 disabled:opacity-50" disabled={actionLoading() !== null} onClick={() => { setShowActionsMenu(false); void handleDelete(); }}>
                    Delete CPE
                  </button>
                  </Show>
                </div>
              </Show>
            </div>
        </div>
      </div>

      <nav role="tablist" class="tab-bar device-detail-tabs" aria-label="Device detail sections">
        <button role="tab" class={`tab-btn ${activeTab() === 'overview' ? 'is-active' : ''}`} aria-selected={activeTab() === 'overview'} onClick={() => setSearchParams({ tab: null })}>Overview</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'hosts' ? 'is-active' : ''}`} aria-selected={activeTab() === 'hosts'} onClick={() => setSearchParams({ tab: 'hosts' })}>Connected Hosts</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'metrics' ? 'is-active' : ''}`} aria-selected={activeTab() === 'metrics'} onClick={() => setSearchParams({ tab: 'metrics' })}>Metrics</button>
        <Show when={(matchingProvisioningTemplate()?.features?.length || 0) > 0}><button role="tab" class={`tab-btn ${activeTab() === 'features' ? 'is-active' : ''}`} aria-selected={activeTab() === 'features'} onClick={() => setSearchParams({ tab: 'features' })}>Advanced settings</button></Show>
        <button role="tab" class={`tab-btn ${activeTab() === 'snapshots' ? 'is-active' : ''}`} aria-selected={activeTab() === 'snapshots'} onClick={() => setSearchParams({ tab: 'snapshots' })}>Snapshots</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'tasks' ? 'is-active' : ''}`} aria-selected={activeTab() === 'tasks'} onClick={() => setSearchParams({ tab: 'tasks' })}>
          CWMP tasks
          <Show when={pendingTaskCount() > 0}>
            <span class="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none">{pendingTaskCount()}</span>
          </Show>
        </button>
        <button role="tab" class={`tab-btn ${activeTab() === 'faults' ? 'is-active' : ''}`} aria-selected={activeTab() === 'faults'} onClick={() => setSearchParams({ tab: 'faults' })}>
          CWMP Faults
          <Show when={unresolvedFaultCount() > 0}>
            <span class="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none">{unresolvedFaultCount()}</span>
          </Show>
        </button>
        <button role="tab" class={`tab-btn ${activeTab() === 'credentials' ? 'is-active' : ''}`} aria-selected={activeTab() === 'credentials'} onClick={() => setSearchParams({ tab: 'credentials' })}>Credentials</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'diagnostic' ? 'is-active' : ''}`} aria-selected={activeTab() === 'diagnostic'} onClick={() => setSearchParams({ tab: 'diagnostic', diagnosticTab: 'diagnostic' })}>Maintenance</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'log' ? 'is-active' : ''}`} aria-selected={activeTab() === 'log'} onClick={() => setSearchParams({ tab: 'log' })}>Device log</button>
      </nav>

      <Show when={message()}>
        <div role={message()?.type === 'error' ? 'alert' : 'status'} class={`p-3 rounded-md text-sm ${message()?.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
          <p>{message()?.text}</p>
          <Show when={message()?.detail}>
            <details class="mt-2 text-xs">
              <summary class="cursor-pointer">Technical details</summary>
              <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words font-mono">{message()?.detail}</pre>
            </details>
          </Show>
        </div>
      </Show>

      <Show when={device.error}>
        <div class="card"><ResourceError title="CPE record is unavailable" description="The device record could not be loaded. Return to the inventory or retry this request." onRetry={() => refetchDevice()} /></div>
      </Show>
      <Show when={!device.error && (parameters.error || tasks.error)}>
        <div class="card"><ResourceError title="CPE detail is incomplete" description="The device record loaded, but parameters or task history are unavailable. Retry before issuing a configuration action." onRetry={refreshAll} /></div>
      </Show>
      <Show when={device.loading && !device()}>
        <div class="card p-6" role="status" aria-label="Loading device details" aria-busy="true">
          <div class="skeleton h-6 w-48 mb-4" />
          <div class="grid grid-cols-2 gap-4">
            <div class="skeleton h-4 w-32" />
            <div class="skeleton h-4 w-32" />
          </div>
        </div>
      </Show>
      <Show when={!device.error && device()}>
        {(d) => (
          <>
            <Show when={activeTab() === 'overview'}>
            {/* Row 1: ONT Info + Device Health + Actions */}
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* ONT Information Card */}
              <div class="card p-5 lg:col-span-5">
                <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
                  <Server size={14} />
                  ONT Information
                </h2>
                <div class="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
                  <div class="space-y-2">
                    <div><span class="text-muted">Serial:</span> <span class="text-primary font-mono">{d().serial_number}</span></div>
                    <div><span class="text-muted">Manufacturer:</span> <span class="text-primary">{d().manufacturer || '-'}</span></div>
                    <div><span class="text-muted">Product:</span> <span class="text-primary">{d().product_class || '-'}</span></div>
                    <div><span class="text-muted">OUI:</span> <span class="text-primary">{d().oui}</span></div>
                    <div><span class="text-muted">Full tree refreshed:</span> <span class="text-primary">{formatDate(d().last_full_refresh)}</span></div>
                    <div><span class="text-muted">Overview refreshed:</span> <span class="text-primary">{formatDate(d().last_overview_refresh)}</span></div>
                    <div><span class="text-muted">Last inform:</span> <span class="text-primary">{formatDate(d().last_inform)}</span></div>
                  </div>
                  <div class="space-y-2 lg:-mt-8">
                    <div class="h-32 w-full overflow-hidden" aria-hidden={!templateImageUrl()}>
                      <Show when={templateImageUrl()}>
                        <img src={templateImageUrl()!} alt={`Device image for ${d().product_class || d().serial_number}`} class="h-full w-full object-contain object-center" />
                      </Show>
                    </div>
                    <div class="space-y-2 text-sm mt-4">
                      <div><span class="text-muted">HW Version:</span> <span class="text-primary">{d().hardware_version || '-'}</span></div>
                      <div><span class="text-muted">SW Version:</span> <span class="text-primary">{d().software_version || '-'}</span></div>
                    </div>
                  </div>
                </div>

              </div>

              {/* Device Health */}
              <section class="card device-health-card p-4 lg:col-span-7" aria-labelledby="device-health-title">
                <div class="device-health-header">
                  <div>
                    <h2 id="device-health-title"><HeartPulse size={14} />Device health</h2>
                    <p>Latest readings from this CPE</p>
                  </div>
                </div>
                <div class="device-health-grid">
                  <For each={healthTileGroups()}>
                    {(group) => (
                      <div class={`health-metric-card ${group.size === 'large' ? 'is-large' : group.size === 'medium' ? 'is-medium' : ''}`}>
                        <Show when={group.label || (group.tiles.length === 1 && ['ring', 'progress'].includes(group.tiles[0].gaugeStyle || ''))}>
                          <h3>{group.label || group.tiles[0].label}</h3>
                        </Show>
                        <Show when={group.tiles.length > 1 && group.tiles.every(tile => tile.format === 'gauge')} fallback={<div class={group.tiles.length > 1 ? 'health-mixed-tiles' : 'health-single-tile'}>
                          <For each={group.tiles}>
                            {(tile) => (
                              <div class={tile.format === 'gauge' ? 'health-gauge-tile' : 'health-value-tile'}>
                                <Show when={tile.format === 'gauge'}>
                                  <Suspense fallback={<div class="skeleton h-28 w-full" />}><HealthGauge
                                    value={tile.raw ?? null}
                                    min={tile.min ?? 0}
                                    max={tile.max ?? 100}
                                    color={tile.color}
                                    label={tile.label}
                                    centerText={tile.value}
                                    animated={tile.animated ?? true}
                                    thresholds={tile.thresholds}
                                    arc={tile.arc}
                                    pointer={tile.pointer}
                                    gaugeStyle={tile.gaugeStyle}
                                  /></Suspense>
                                </Show>
                                <Show when={tile.format !== 'gauge'}>
                                  <span class="health-value-label">{tile.label}</span>
                                  <strong
                                    class={`health-value ${tile.color.startsWith('#') ? '' : tile.color}`}
                                    data-dynamic-style="health-value-color"
                                    style={tile.color.startsWith('#') ? { color: tile.color } : {}}
                                  >{tile.value}</strong>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>}>
                          <Suspense fallback={<div class="skeleton h-28 w-full" />}><HealthGauge
                            value={group.tiles[0].raw ?? null}
                            min={group.tiles[0].min ?? 0}
                            max={group.tiles[0].max ?? 100}
                            color={group.tiles[0].color}
                            label={group.tiles[0].label}
                            centerText={group.tiles[0].value}
                            animated={group.tiles[0].animated ?? true}
                            thresholds={group.tiles[0].thresholds}
                            arc={group.tiles[0].arc}
                            pointer={group.tiles[0].pointer}
                            gaugeStyle={group.tiles[0].gaugeStyle}
                            values={group.tiles.map(tile => ({ value: tile.raw ?? null, label: tile.label, centerText: tile.value }))}
                          /></Suspense>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </div>

            </Show>

            <Show when={activeTab() === 'diagnostic'}>
              <div class="space-y-4">
                <nav role="tablist" class="tab-bar" aria-label="Diagnostic sections">
                  <button role="tab" class="tab-btn is-active" aria-selected="true" onClick={() => setSearchParams({ diagnosticTab: 'diagnostic' })}>Diagnostic</button>
                </nav>
                <Show when={searchParams.diagnosticTab === undefined || searchParams.diagnosticTab === 'speedtest' || searchParams.diagnosticTab === 'diagnostic'}>
                  <div class="space-y-4">
                  <details class="card group">
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><div class="flex items-center gap-2"><Activity size={14} class="section-title-icon" /><h2 class="text-sm font-medium text-secondary">Speedtest</h2></div><p class="text-xs text-muted mt-1">Run an iPerf speed test from this CPE.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                    <Show when={iperfSupported()} fallback={<p class="text-xs text-muted">iPerf testing is not available for this device.</p>}>
                      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <label class="text-xs text-muted md:col-span-2">iPerf server address<input class="input w-full mt-1 font-mono" value={iperfForm().serverAddr} onInput={event => setIperfForm(form => ({ ...form, serverAddr: event.currentTarget.value }))} placeholder="192.0.2.10 or iperf.example.net" disabled={iperfRunning()} /></label>
                        <label class="text-xs text-muted">Port<input class="input w-full mt-1" type="number" min="1" max="65535" value={iperfForm().port} onInput={event => setIperfForm(form => ({ ...form, port: event.currentTarget.value }))} disabled={iperfRunning()} /></label>
                        <label class="text-xs text-muted">Test mode<select class="input w-full mt-1" value={iperfForm().testMode} onChange={event => setIperfForm(form => ({ ...form, testMode: event.currentTarget.value as IperfForm['testMode'] }))} disabled={iperfRunning()}><option value="UPLOAD">Upload — CPE to server</option><option value="DOWNLOAD">Download — server to CPE</option><option value="BOTH">Both — upload and download</option></select></label>
                        <label class="text-xs text-muted">Protocol<select class="input w-full mt-1" value={iperfForm().protocolType} onChange={event => setIperfForm(form => ({ ...form, protocolType: event.currentTarget.value as IperfForm['protocolType'] }))} disabled={iperfRunning()}><option value="TCP">TCP</option><option value="UDP">UDP</option></select></label>
                        <label class="text-xs text-muted">Duration (seconds)<input class="input w-full mt-1" type="number" min="1" max="1800" value={iperfForm().maxTime} onInput={event => setIperfForm(form => ({ ...form, maxTime: event.currentTarget.value }))} disabled={iperfRunning()} /></label>
                        <label class="text-xs text-muted">Parallel streams<input class="input w-full mt-1" type="number" min="1" max="32" value={iperfForm().parallel} onInput={event => setIperfForm(form => ({ ...form, parallel: event.currentTarget.value }))} disabled={iperfRunning()} /></label>
                        <label class="text-xs text-muted">Bandwidth (UDP, 0 = CPE default)<input class="input w-full mt-1" type="number" min="0" step="1" value={iperfForm().bandwidth} onInput={event => setIperfForm(form => ({ ...form, bandwidth: event.currentTarget.value }))} disabled={iperfRunning()} /></label>
                      </div>
                      <p class="text-xs text-muted">The iPerf server must listen on the selected port and be reachable from the CPE network.</p>
                      <div class="flex justify-end"><button type="button" onClick={() => void handleRunIperf()} class="btn btn-primary text-sm" disabled={!isFullAccess() || iperfRunning() || actionLoading() !== null}><Activity size={14} />{iperfRunning() ? 'Running iPerf…' : 'Start speedtest'}</button></div>
                    </Show>
                    <Show when={iperfResult()}>
                      <div class="border-t border-subtle pt-3">
                        <h3 class="text-sm font-medium text-secondary mb-3">Latest speedtest result</h3>
                        <Suspense fallback={<div class="skeleton h-40 w-full" />}><IperfResult runs={iperfResult()!} /></Suspense>
                      </div>
                    </Show>
                    </div>
                  </details>
                  <details class="card group">
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><div class="flex items-center gap-2"><Search size={14} class="section-title-icon" /><h2 class="text-sm font-medium text-secondary">NS lookup</h2></div><p class="text-xs text-muted mt-1">Resolve a hostname from the CPE using its DNS diagnostics.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                    <Show when={nsLookupRoot()} fallback={<p class="text-xs text-muted">NS lookup is not available for this device.</p>}>
                      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <label class="text-xs text-muted">Host name<input class="input w-full mt-1" value={nsLookupHost()} onInput={event => setNsLookupHost(event.currentTarget.value)} placeholder="example.com" disabled={nsLookupRunning()} /></label>
                        <label class="text-xs text-muted">DNS server (optional)<input class="input w-full mt-1 font-mono" value={nsLookupServer()} onInput={event => setNsLookupServer(event.currentTarget.value)} placeholder="Use device default" disabled={nsLookupRunning()} /></label>
                        <label class="text-xs text-muted">Interface<select class="input w-full mt-1" value={nsLookupInterface()} onChange={event => setNsLookupInterface(event.currentTarget.value)} disabled={nsLookupRunning()}><option value="">Default interface</option><For each={diagnosticInterfaces()}>{(iface) => <option value={iface.path}>{iface.name}</option>}</For></select></label>
                        <label class="text-xs text-muted">Repetitions<input class="input w-full mt-1" type="number" min="1" max="100" value={nsLookupRepetitions()} onInput={event => setNsLookupRepetitions(event.currentTarget.value)} disabled={nsLookupRunning()} /></label>
                        <label class="text-xs text-muted">Timeout (ms)<input class="input w-full mt-1" type="number" min="1" max="300000" value={nsLookupTimeout()} onInput={event => setNsLookupTimeout(event.currentTarget.value)} disabled={nsLookupRunning()} /></label>
                      </div>
                      <div class="flex justify-end"><button type="button" class="btn btn-primary text-sm" onClick={() => void handleRunNsLookup()} disabled={!isFullAccess() || nsLookupRunning() || actionLoading() !== null}>{nsLookupRunning() ? 'Looking up…' : 'Start NS lookup'}</button></div>
                    </Show>
                    <Show when={nsLookupResult()}>
                      {(result) => {
                        const root = nsLookupRoot();
                        const rows = Object.entries(result()).filter(([name, value]) => name.startsWith(root) && value !== '' && (name.includes('.Result.') || name.endsWith('SuccessCount') || name.endsWith('ResultNumberOfEntries') || name.endsWith('DiagnosticsState')));
                        return <div class="border-t border-subtle pt-3">
                          <h3 class="text-xs font-medium text-secondary mb-2">Latest result</h3>
                          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">{rows.map(([name, value]) => <div class="rounded bg-base px-3 py-2"><div class="text-[10px] text-muted break-all">{name.slice(root.length)}</div><div class="text-sm text-primary font-mono break-all">{value}</div></div>)}</div>
                          <Show when={rows.length === 0}><p class="text-xs text-muted">No result records were returned.</p></Show>
                        </div>;
                      }}
                    </Show>
                    </div>
                  </details>
                  <details class="card group">
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><div class="flex items-center gap-2"><Radio size={14} class="section-title-icon" /><h2 class="text-sm font-medium text-secondary">IP ping</h2></div><p class="text-xs text-muted mt-1">Send ICMP echo requests from the CPE and review packet loss and response times.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                    <Show when={ipPingRoot()} fallback={<p class="text-xs text-muted">IP ping is not available for this device.</p>}>
                      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <label class="text-xs text-muted md:col-span-2">Host or IP address<input class="input w-full mt-1 font-mono" value={ipPingHost()} onInput={event => setIpPingHost(event.currentTarget.value)} placeholder="192.0.2.1 or example.com" disabled={ipPingRunning()} /></label>
                        <label class="text-xs text-muted">Interface<select class="input w-full mt-1" value={ipPingInterface()} onChange={event => setIpPingInterface(event.currentTarget.value)} disabled={ipPingRunning()}><option value="">Default interface</option><For each={diagnosticInterfaces()}>{(iface) => <option value={iface.path}>{iface.name}</option>}</For></select></label>
                        <label class="text-xs text-muted">Repetitions<input class="input w-full mt-1" type="number" min="1" max="50" value={ipPingRepetitions()} onInput={event => setIpPingRepetitions(event.currentTarget.value)} disabled={ipPingRunning()} /></label>
                        <label class="text-xs text-muted">Timeout (ms)<input class="input w-full mt-1" type="number" min="1" max="60000" value={ipPingTimeout()} onInput={event => setIpPingTimeout(event.currentTarget.value)} disabled={ipPingRunning()} /></label>
                        <label class="text-xs text-muted">Packet size (bytes)<input class="input w-full mt-1" type="number" min="1" max="65500" value={ipPingDataBlockSize()} onInput={event => setIpPingDataBlockSize(event.currentTarget.value)} disabled={ipPingRunning()} /></label>
                        <label class="text-xs text-muted">DSCP (0–63)<input class="input w-full mt-1" type="number" min="0" max="63" value={ipPingDscp()} onInput={event => setIpPingDscp(event.currentTarget.value)} disabled={ipPingRunning()} /></label>
                      </div>
                      <div class="flex justify-end"><button type="button" class="btn btn-primary text-sm" onClick={() => void handleRunIpPing()} disabled={!isFullAccess() || ipPingRunning() || actionLoading() !== null}>{ipPingRunning() ? 'Pinging…' : 'Start IP ping'}</button></div>
                    </Show>
                    <Show when={ipPingResult()}>
                      {(result) => {
                        const root = ipPingRoot();
                        const fields = ['DiagnosticsState', 'SuccessCount', 'FailureCount', 'MinimumResponseTime', 'AverageResponseTime', 'MaximumResponseTime'];
                        const rows = fields.map(field => [field, result()[root + field] || '']).filter(([, value]) => value !== '');
                        return <div class="border-t border-subtle pt-3">
                          <h3 class="text-xs font-medium text-secondary mb-2">Latest result</h3>
                          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">{rows.map(([name, value]) => <div class={`rounded px-3 py-2 ${name === 'SuccessCount' ? 'diagnostic-result-success' : name === 'FailureCount' ? 'diagnostic-result-failure' : 'bg-base'}`}><div class="text-[10px]">{name === 'SuccessCount' ? 'Successful packets' : name === 'FailureCount' ? 'Failed packets' : name === 'MinimumResponseTime' ? 'Min. response (ms)' : name === 'AverageResponseTime' ? 'Avg. response (ms)' : name === 'MaximumResponseTime' ? 'Max. response (ms)' : 'State'}</div><div class="text-sm font-mono break-all">{value}</div></div>)}</div>
                          <Show when={rows.length === 0}><p class="text-xs text-muted">No result values were returned.</p></Show>
                        </div>;
                      }}
                    </Show>
                    </div>
                  </details>
                  <details class="card group">
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><div class="flex items-center gap-2"><Network size={14} class="section-title-icon" /><h2 class="text-sm font-medium text-secondary">Traceroute</h2></div><p class="text-xs text-muted mt-1">Show the network hops from the CPE to a destination.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                      <Show when={traceRouteRoot()} fallback={<p class="text-xs text-muted">Traceroute is not available for this device.</p>}>
                        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                          <label class="text-xs text-muted md:col-span-2">Destination host or IP<input class="input w-full mt-1 font-mono" value={traceRouteHost()} onInput={event => setTraceRouteHost(event.currentTarget.value)} placeholder="192.0.2.1 or example.com" disabled={traceRouteRunning()} /></label>
                          <label class="text-xs text-muted">Interface<select class="input w-full mt-1" value={traceRouteInterface()} onChange={event => setTraceRouteInterface(event.currentTarget.value)} disabled={traceRouteRunning()}><option value="">Default interface</option><For each={diagnosticInterfaces()}>{(iface) => <option value={iface.path}>{iface.name}</option>}</For></select></label>
                          <label class="text-xs text-muted">Maximum hops<input class="input w-full mt-1" type="number" min="1" max="64" value={traceRouteMaxHops()} onInput={event => setTraceRouteMaxHops(event.currentTarget.value)} disabled={traceRouteRunning()} /></label>
                          <label class="text-xs text-muted">Tries per hop<input class="input w-full mt-1" type="number" min="1" max="10" value={traceRouteTries()} onInput={event => setTraceRouteTries(event.currentTarget.value)} disabled={traceRouteRunning()} /></label>
                          <label class="text-xs text-muted">Timeout (ms)<input class="input w-full mt-1" type="number" min="1" max="120000" value={traceRouteTimeout()} onInput={event => setTraceRouteTimeout(event.currentTarget.value)} disabled={traceRouteRunning()} /></label>
                          <label class="text-xs text-muted">Packet size (bytes)<input class="input w-full mt-1" type="number" min="1" max="65500" value={traceRouteDataBlockSize()} onInput={event => setTraceRouteDataBlockSize(event.currentTarget.value)} disabled={traceRouteRunning()} /></label>
                          <label class="text-xs text-muted">DSCP (0–63)<input class="input w-full mt-1" type="number" min="0" max="63" value={traceRouteDscp()} onInput={event => setTraceRouteDscp(event.currentTarget.value)} disabled={traceRouteRunning()} /></label>
                        </div>
                        <div class="flex justify-end"><button type="button" class="btn btn-primary text-sm" onClick={() => void handleRunTraceRoute()} disabled={!isFullAccess() || traceRouteRunning() || actionLoading() !== null}>{traceRouteRunning() ? 'Tracing route…' : 'Start traceroute'}</button></div>
                      </Show>
                      <Show when={traceRouteResult()}>
                        {(result) => {
                          const root = traceRouteRoot();
                          const hops = new Map<number, { hop: number; hopRTTimes: string; hopHost: string; hopHostAddress: string }>();
                          for (const [name, value] of Object.entries(result())) {
                            if (!name.startsWith(root) || value === '') continue;
                            const match = name.slice(root.length).match(/^RouteHops\.(\d+)\.(HopRTTimes|HopHost|HopHostAddress)$/);
                            if (!match) continue;
                            const hop = Number(match[1]);
                            const row = hops.get(hop) || { hop, hopRTTimes: '-', hopHost: '-', hopHostAddress: '-' };
                            if (match[2] === 'HopRTTimes') row.hopRTTimes = value;
                            if (match[2] === 'HopHost') row.hopHost = value;
                            if (match[2] === 'HopHostAddress') row.hopHostAddress = value;
                            hops.set(hop, row);
                          }
                          const rows = [...hops.values()].sort((a, b) => a.hop - b.hop);
                          return <div class="border-t border-subtle pt-3">
                            <h3 class="text-xs font-medium text-secondary mb-2">Route results</h3>
                            <Show when={rows.length > 0} fallback={<p class="text-xs text-muted">No route hops were returned.</p>}>
                              <div class="overflow-x-auto">
                                <table class="data-table w-full text-xs min-w-[620px]">
                                  <thead>
                                    <tr class="border-b border-subtle">
                                      <th class="text-left px-3 py-2 font-medium text-muted">Hop</th>
                                      <th class="text-left px-3 py-2 font-medium text-muted">HopRTTimes</th>
                                      <th class="text-left px-3 py-2 font-medium text-muted">HopHost</th>
                                      <th class="text-left px-3 py-2 font-medium text-muted">HopHostAddress</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <For each={rows}>
                                      {(row) => (
                                        <tr class="border-t border-subtle/50">
                                          <td class="px-3 py-2 text-primary font-mono">{row.hop}</td>
                                          <td class="px-3 py-2 text-primary font-mono">{row.hopRTTimes}</td>
                                          <td class="px-3 py-2 text-primary">{row.hopHost}</td>
                                          <td class="px-3 py-2 text-primary font-mono">{row.hopHostAddress}</td>
                                        </tr>
                                      )}
                                    </For>
                                  </tbody>
                                </table>
                              </div>
                            </Show>
                          </div>;
                        }}
                      </Show>
                    </div>
                  </details>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={activeTab() === 'snapshots'}>
              <div class="grid grid-cols-1 xl:grid-cols-5 gap-4">
                <div class="card p-4 xl:col-span-2">
                  <div class="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <h2 class="text-sm font-medium text-secondary">Configuration Snapshots</h2>
                      <p class="text-xs text-muted mt-1">Stored from the parameters currently cached by ACS.</p>
                    </div>
                    <span class="text-xs text-muted">{snapshots()?.length || 0}</span>
                  </div>
                  <Show when={isFullAccess()}>
                    <div class="flex gap-2 mb-4">
                      <input class="input flex-1 text-sm" value={snapshotName()} onInput={(event) => setSnapshotName(event.currentTarget.value)} placeholder="Snapshot name (optional)" disabled={snapshotLoading() === 'create'} />
                      <button type="button" class="btn btn-primary text-xs" onClick={() => void createSnapshot()} disabled={snapshotLoading() !== null}>
                        <Save size={14} /> Create
                      </button>
                    </div>
                  </Show>
                  <Show when={(snapshots() || []).length > 0} fallback={<Show when={!snapshots.loading} fallback={<div class="skeleton h-24 w-full" aria-label="Loading snapshots" />}><EmptyState title="No snapshots" description="Create a snapshot to preserve the current cached CPE configuration." /></Show>}>
                    <div class="space-y-2">
                      <For each={snapshots()}>
                        {(snapshot) => (
                          <div class={`rounded border p-3 ${selectedSnapshot()?.id === snapshot.id ? 'border-primary bg-primary/5' : 'border-subtle'}`}>
                            <div class="flex items-center justify-between gap-3">
                              <button type="button" class="text-left min-w-0 flex-1" onClick={() => void openSnapshot(snapshot)} disabled={snapshotLoading() !== null}>
                                <div class="text-sm text-primary truncate">{snapshot.name}</div>
                                <div class="text-xs text-muted mt-1">{formatDate(snapshot.created_at)} · {snapshot.parameter_count} parameters</div>
                              </button>
                              <Show when={isFullAccess()}>
                                <button type="button" class="icon-button text-muted hover:text-rose-400" aria-label={`Delete snapshot ${snapshot.name}`} onClick={() => void deleteSnapshot(snapshot)} disabled={snapshotLoading() !== null}><Trash2 size={14} /></button>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <div class="card p-4 xl:col-span-3">
                  <Show when={selectedSnapshot()} fallback={<div class="h-full min-h-56 flex items-center justify-center text-sm text-muted">Select a snapshot to inspect its tree diff.</div>}>
                    {(snapshot) => (
                      <>
                        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
                          <div>
                            <h2 class="text-sm font-medium text-secondary">Diff: {snapshot().name}</h2>
                            <p class="text-xs text-muted mt-1">Select a branch to select all writable parameters below it.</p>
                          </div>
                          <Show when={isFullAccess()}>
                            <button type="button" class="btn btn-primary text-xs" onClick={() => void restoreSnapshot()} disabled={snapshotLoading() !== null || snapshotSelection().length === 0}>
                              <RefreshCw size={14} /> Restore {snapshotSelection().length || ''}
                            </button>
                          </Show>
                        </div>
                        <div class="relative mb-3">
                          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                          <input type="search" class="input pl-9! w-full text-sm" aria-label="Search snapshot parameter names" placeholder="Search parameter names…" value={snapshotSearch()} onInput={(event) => { setSnapshotSearch(event.currentTarget.value); setCollapsedSnapshotPaths(new Set<string>()); }} />
                        </div>
                        <Show when={snapshotRows().length > 0} fallback={<EmptyState title={snapshotSearch().trim() ? 'No matching parameters' : 'No writable differences'} description={snapshotSearch().trim() ? 'No changed writable parameter names match your search.' : 'No currently writable parameters differ from the selected snapshot.'} />}>
                          <div class="border border-subtle rounded overflow-auto max-h-[600px]">
                            <div class="min-w-[680px]">
                              <div class="grid grid-cols-[minmax(280px,1fr)_minmax(140px,1fr)_minmax(140px,1fr)] gap-3 px-3 py-2 bg-elevated text-[10px] text-muted uppercase tracking-wide">
                                <div>Parameter tree</div><div>Snapshot</div><div>Current</div>
                              </div>
                              <For each={snapshotRows()}>
                                {(row) => {
                                  const selectedCount = () => row.descendants.filter(name => snapshotSelection().includes(name)).length;
                                  const isBranch = row.hasChildren;
                                  return (
                                    <div class="grid grid-cols-[minmax(280px,1fr)_minmax(140px,1fr)_minmax(140px,1fr)] gap-3 items-center border-t border-subtle/60 px-3 py-2 text-xs">
                                      <div class="flex items-center gap-2 min-w-0" data-dynamic-style="snapshot-indent" style={{ 'padding-left': `${row.depth * 16}px` } as any}>
                                        <Show when={row.hasChildren} fallback={<span class="w-4 shrink-0" />}>
                                          <button type="button" class="icon-button w-4 h-4 shrink-0" aria-label={`${collapsedSnapshotPaths().has(row.path) ? 'Expand' : 'Collapse'} ${row.path}`} onClick={() => toggleSnapshotBranch(row.path)}>
                                            <Show when={collapsedSnapshotPaths().has(row.path)} fallback={<Minus size={12} />}><Plus size={12} /></Show>
                                          </button>
                                        </Show>
                                        <input type="checkbox" checked={selectedCount() === row.descendants.length} ref={(element) => { element.indeterminate = selectedCount() > 0 && selectedCount() < row.descendants.length; }} onChange={() => toggleSnapshotPath(row)} disabled={!isFullAccess()} />
                                        <span class={isBranch ? 'text-secondary font-medium' : 'text-primary font-mono truncate'} title={row.path}>{row.label}</span>
                                      </div>
                                      <span class="font-mono text-secondary truncate" title={row.parameter?.value}>{row.parameter?.value || ''}</span>
                                      <span class="font-mono text-muted truncate" title={row.currentValue}>{row.currentValue || ''}</span>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            </Show>

            {/* Row 1.2: Metrics */}
            <Show when={activeTab() === 'metrics'}>
              <Show when={matchingMetrics().length > 0} fallback={<EmptyState title="No metrics available" description="Configure metrics in the matching provisioning template to enable monitoring." />}>
              <div class="card p-5">
                <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
                  <Activity size={14} />
                  Metrics
                </h2>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <For each={groupedMetrics()}>
                    {(group) => (
                      <Suspense fallback={<div class="skeleton h-72 w-full" />}><MetricChart serial={serial()} metrics={group} refreshKey={autoRefreshTick()} /></Suspense>
                    )}
                  </For>
                </div>
              </div>
              </Show>
            </Show>

            <Show when={activeTab() === 'features' && (matchingProvisioningTemplate()?.features?.length || 0) > 0}>
              <div class="space-y-4">
                <div class="flex justify-end"><button type="button" class="btn btn-secondary text-xs" onClick={() => void loadDeviceParameters()} disabled={parameters.loading}><RefreshCw size={13} class={parameters.loading ? 'animate-spin' : ''} />Refresh device parameters</button></div>
                <div class="flex gap-1 overflow-x-auto border-b border-subtle" role="tablist" aria-label="Device Advanced settings sections"><For each={matchingProvisioningTemplate()?.features || []}>{feature => <button type="button" role="tab" aria-selected={activeDeviceFeature()?.id === feature.id} onClick={() => setActiveDeviceFeatureID(feature.id)} class={`shrink-0 rounded-t px-3 py-2 text-xs font-medium ${activeDeviceFeature()?.id === feature.id ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>{feature.name}</button>}</For></div>
                <Show when={activeDeviceFeature()} keyed>{feature => <section class="card p-5 space-y-4">
                  <div><h2 class="text-sm font-medium text-secondary">{feature.name}</h2><p class="mt-1 text-xs text-muted">Advanced settings from template {matchingProvisioningTemplate()?.name}. Changes are sent to the device as CWMP tasks.</p></div>
                  <For each={featureControlGroups(feature.controls)}>{group => <Show when={group.name} fallback={<div class="grid gap-3 lg:grid-cols-2">{renderFeatureControls(feature, group.controls)}</div>}>
                    <details class="rounded border border-subtle overflow-hidden group/feature-box">
                      <summary class="flex cursor-pointer list-none items-center justify-between gap-3 bg-elevated/40 px-4 py-3 text-sm font-medium text-secondary"><span>{group.name}</span><ChevronDown size={15} class="shrink-0 transition-transform group-open/feature-box:rotate-180" /></summary>
                      <div class="grid gap-3 p-3 lg:grid-cols-2">{renderFeatureControls(feature, group.controls)}</div>
                    </details>
                  </Show>}</For>
                  <Show when={parameters.loading}><p class="text-xs text-muted">Refreshing device parameters…</p></Show>
                </section>}</Show>
              </div>
            </Show>

            <Show when={activeTab() === 'credentials'}>
            <div class="flex justify-end"><button type="button" onClick={() => setShowSensitive(!showSensitive())} class="btn btn-secondary text-xs" aria-pressed={showSensitive()}>{showSensitive() ? <EyeOff size={13} /> : <Eye size={13} />}{showSensitive() ? 'Hide sensitive values' : 'Reveal sensitive values'}</button></div>
            {/* Connection Request Credentials */}
            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                  <Radio size={14} />
                  Connection-Request Credentials
                </h2>
                <div class="flex items-center gap-1">
                  <Show when={!editingConnCreds() && isFullAccess()}>
                    <button onClick={handleEditConnCreds} disabled={actionLoading() !== null} class="icon-button" aria-label="Edit connection-request credentials">
                      <Edit size={14} />
                    </button>
                  </Show>
                  <Show when={isFullAccess()}>
                    <button onClick={handleGenerateConnCreds} disabled={actionLoading() === 'conn-creds-gen'} class="icon-button" aria-label="Generate per-device credentials">
                      <Zap size={14} />
                    </button>
                  </Show>
                </div>
              </div>
              <Show when={editingConnCreds()} fallback={
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div class="text-muted text-xs mb-1">Mode</div>
                    <div class="text-primary font-mono">{device()?.conn_cred_mode || 'inherit'}</div>
                  </div>
                  <div>
                    <div class="text-muted text-xs mb-1">Username</div>
                    <div class="text-primary font-mono">{device()?.conn_cred_mode === 'custom' ? (device()?.conn_cred_username || '—') : (device()?.conn_cred_mode === 'auto' ? device()?.serial_number : 'global setting')}</div>
                  </div>
                  <div>
                    <div class="text-muted text-xs mb-1">Password</div>
                    <div class="text-primary font-mono">{device()?.conn_cred_mode === 'custom' ? (device()?.conn_cred_password || '••••••••') : (device()?.conn_cred_mode === 'auto' ? 'derived (HMAC-SHA256)' : 'global setting')}</div>
                  </div>
                </div>
              }>
                <div class="space-y-3">
                  <div>
                    <div class="block text-xs text-muted mb-1.5">Credential mode</div>
                    <div class="flex gap-2">
                      {(['inherit', 'auto', 'custom'] as const).map((mode) => (
                        <button
                          onClick={() => setConnCredMode(mode)}
                          class={`px-3 py-1.5 text-xs font-medium transition-colors ${connCredMode() === mode ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-zinc-700 text-secondary border border-zinc-600'}`}
                          aria-pressed={connCredMode() === mode}
                        >
                          {mode === 'inherit' ? 'Inherit (global)' : mode === 'auto' ? 'Auto (derived)' : 'Custom'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Show when={connCredMode() === 'custom'}>
                    <div class="grid grid-cols-2 gap-4">
                      <div>
                        <label for="conn-cred-username" class="block text-xs text-muted mb-1.5">Username</label>
                        <input id="conn-cred-username" type="text" value={connCredUsername()} onInput={(e) => setConnCredUsername(e.currentTarget.value)} class="input w-full py-1.5 text-sm font-mono" placeholder="Device serial number" />
                      </div>
                      <div>
                        <label for="conn-cred-password" class="block text-xs text-muted mb-1.5">Password</label>
                        <input id="conn-cred-password" type="password" value={connCredPassword()} onInput={(e) => setConnCredPassword(e.currentTarget.value)} class="input w-full py-1.5 text-sm font-mono" placeholder="New password" />
                      </div>
                    </div>
                  </Show>
                  <Show when={connCredMode() === 'auto'}>
                    <div class="p-3 bg-sky-500/10 border border-sky-500/20 text-xs text-sky-400">
                      <p><strong>Username:</strong> device serial number</p>
                      <p><strong>Password:</strong> HMAC-SHA256 derived from global master secret</p>
                    </div>
                  </Show>
                  <div class="flex gap-2 mt-4 justify-end">
                    <button onClick={handleCancelConnCreds} disabled={actionLoading() !== null} class="btn btn-secondary text-sm py-1.5">
                      <X size={14} />
                      Cancel
                    </button>
                    <button onClick={handleSaveConnCreds} disabled={actionLoading() === 'conn-creds'} class="btn btn-primary text-sm py-1.5">
                      <Save size={14} />
                      {actionLoading() === 'conn-creds' ? 'Saving…' : 'Save credentials'}
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={generatedCred()}>
                <div class="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400">
                  <p class="font-medium mb-1">Generated credentials (shown once — store them now):</p>
                  <p><strong>Username:</strong> <code class="font-mono">{generatedCred()!.username}</code></p>
                  <p><strong>Password:</strong> <code class="font-mono">{generatedCred()!.password}</code></p>
                  <button onClick={() => setGeneratedCred(null)} class="mt-2 text-emerald-300 underline">Dismiss</button>
                </div>
              </Show>
            </div>
            </Show>

            <Show when={activeTab() === 'overview'}>
            {/* Row 2: WAN Information */}
            <div class="card p-5">
              <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
                <Network size={14} />
                WAN Connections
              </h2>
              <Show when={wanProfiles().length > 0} fallback={
                <p class="text-muted text-sm">No WAN configuration data. Click Summon to fetch.</p>
              }>
                <div class="overflow-x-auto">
                  <table class="data-table w-full text-sm min-w-[1260px]">
                    <thead class="sticky top-0 bg-base z-10">
                      <tr class="border-b-2 border-subtle bg-base">
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Name</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Status</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Adm. status</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Type</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">VLAN</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">IP Address</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Service</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">NAT</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">L1</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">L2</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">L3</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">L4</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S1</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S2</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S3</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S4</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S5</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S6</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S7</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">S8</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={wanProfiles()}>
                        {(wan) => {
                          const getWanDetail = (suffix: string) => parameters()?.find(parameter => parameter.name === wan.path + suffix)?.value || '-';
                          const expanded = () => expandedWanPaths().has(wan.path);
                          const toggleExpanded = () => setExpandedWanPaths(previous => {
                            const next = new Set(previous);
                            if (next.has(wan.path)) next.delete(wan.path); else next.add(wan.path);
                            return next;
                          });
                          const dmzEnabled = () => ['1', 'true', 'enabled'].includes(getWanDetail('X_HW_DMZ.DMZEnable').toLowerCase());
                          return <>
                          <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                            <td class="px-3 py-2.5 text-primary font-medium">
                              <div class="flex items-center gap-1.5" title={wan.path}>
                                <button type="button" class="icon-button w-6 h-6 shrink-0" aria-label={`${expanded() ? 'Collapse' : 'Expand'} WAN ${wan.name}`} aria-expanded={expanded()} onClick={toggleExpanded}>
                                  <Show when={expanded()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show>
                                </button>
                                <span>{wan.name}</span>
                              </div>
                            </td>
                            <td class="px-3 py-2.5">
                              <span class={`badge ${statusBadgeClass(wan.status)}`}>{wan.status}</span>
                            </td>
                            <td class="px-3 py-2.5">
                              <Show when={isFullAccess()} fallback={<span class={`badge ${wan.enable === 'Enabled' ? 'badge-success' : wan.enable === '-' ? 'badge-warning' : 'badge-error'}`}>{wan.enable}</span>}>
                                <button
                                  onClick={() => handleWanEnable(wan, wan.enable !== 'Enabled')}
                                  disabled={actionLoading() !== null}
                                  class={`badge cursor-pointer ${wan.enable === 'Enabled' ? 'badge-success' : 'badge-error'}`}
                                  aria-label={`${wan.enable === 'Enabled' ? 'Disable' : 'Enable'} WAN ${wan.name}`}
                                >
                                  {wan.enable === 'Enabled' ? 'Enabled' : 'Disabled'}
                                </button>
                              </Show>
                            </td>
                            <td class="px-3 py-2.5 text-secondary">{wan.type}</td>
                            <td class="px-3 py-2.5 text-primary font-mono">{wan.vlan}</td>
                            <td class="px-3 py-2.5 text-primary font-mono">
                              <div class="flex items-center gap-1.5">
                                <span>{wan.ipAddress}</span>
                                <Show when={cpeWebUiUrl(wan.ipAddress)}>
                                  {(url) => <a href={url()} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center rounded p-1 text-muted hover:text-primary hover:bg-elevated" aria-label={`Open CPE web interface at ${wan.ipAddress}`} title="Open CPE web interface in a new tab"><ExternalLink size={13} /></a>}
                                </Show>
                              </div>
                            </td>
                            <td class="px-3 py-2.5 text-secondary">{wan.service}</td>
                            <td class="px-3 py-2.5"><span class={`badge ${wan.nat === 'Enabled' ? 'badge-success' : wan.nat === '-' ? 'badge-warning' : 'badge-error'}`}>{wan.nat}</span></td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.lan1} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.lan1} onChange={() => handleWanTie(wan, 1, 'lan', !wan.lan1)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind L1 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.lan2} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.lan2} onChange={() => handleWanTie(wan, 2, 'lan', !wan.lan2)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind L2 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.lan3} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.lan3} onChange={() => handleWanTie(wan, 3, 'lan', !wan.lan3)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind L3 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.lan4} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.lan4} onChange={() => handleWanTie(wan, 4, 'lan', !wan.lan4)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind L4 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid1} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid1} onChange={() => handleWanTie(wan, 1, 'ssid', !wan.ssid1)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S1 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid2} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid2} onChange={() => handleWanTie(wan, 2, 'ssid', !wan.ssid2)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S2 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid3} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid3} onChange={() => handleWanTie(wan, 3, 'ssid', !wan.ssid3)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S3 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid4} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid4} onChange={() => handleWanTie(wan, 4, 'ssid', !wan.ssid4)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S4 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid5} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid5} onChange={() => handleWanTie(wan, 5, 'ssid', !wan.ssid5)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S5 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid6} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid6} onChange={() => handleWanTie(wan, 6, 'ssid', !wan.ssid6)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S6 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid7} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid7} onChange={() => handleWanTie(wan, 7, 'ssid', !wan.ssid7)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S7 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess() && wan.portParams} fallback={<input type="checkbox" checked={wan.ssid8} disabled class="accent-emerald-500 w-3.5 h-3.5 cursor-default" />}>
                                <input type="checkbox" checked={wan.ssid8} onChange={() => handleWanTie(wan, 8, 'ssid', !wan.ssid8)} disabled={actionLoading() !== null} class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" aria-label={`Bind S8 to ${wan.name}`} />
                              </Show>
                            </td>
                            <td class="px-2 py-2">
                              <button
                                onClick={() => setStatsInterface({ type: 'wan', name: wan.name, path: wan.path })}
                                class="icon-button"
                                aria-label={`Show statistics for WAN ${wan.name}`}
                                title="Interface statistics"
                              >
                                <Activity size={14} />
                              </button>
                              <Show when={isFullAccess()} fallback={<span class="text-muted text-xs">-</span>}>
                                <button
                                  onClick={() => setWanModalPath(wan.path)}
                                  class="icon-button"
                                  aria-label={`Edit WAN connection ${wan.name}`}
                                >
                                  <Edit size={14} />
                                </button>
                              </Show>
                            </td>
                          </tr>
                          <Show when={expanded()}>
                            <tr class="border-t border-subtle/60 bg-elevated/20">
                              <td colspan={22} class="px-5 py-3">
                                <div class="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
                                  <div><div class="text-[10px] uppercase tracking-wide text-muted">IP Address</div><div class="mt-1 text-xs font-mono text-primary break-all">{getWanDetail('ExternalIPAddress') !== '-' ? getWanDetail('ExternalIPAddress') : getWanDetail('IPAddress')}</div></div>
                                  <div><div class="text-[10px] uppercase tracking-wide text-muted">Subnet Mask</div><div class="mt-1 text-xs font-mono text-primary">{getWanDetail('SubnetMask')}</div></div>
                                  <div><div class="text-[10px] uppercase tracking-wide text-muted">Default Gateway</div><div class="mt-1 text-xs font-mono text-primary">{getWanDetail('DefaultGateway')}</div></div>
                                  <div><div class="text-[10px] uppercase tracking-wide text-muted">DNS Servers</div><div class="mt-1 text-xs font-mono text-primary break-all">{getWanDetail('DNSServers')}</div></div>
                                  <div><div class="text-[10px] uppercase tracking-wide text-muted">DMZ</div><div class={`mt-1 text-xs ${getWanDetail('X_HW_DMZ.DMZEnable') === '-' ? 'text-muted' : dmzEnabled() ? 'text-emerald-400' : 'text-secondary'}`}>{getWanDetail('X_HW_DMZ.DMZEnable') === '-' ? '-' : dmzEnabled() ? 'Enabled' : 'Disabled'}</div></div>
                                  <div><div class="text-[10px] uppercase tracking-wide text-muted">DMZ Host IP</div><div class="mt-1 text-xs font-mono text-primary">{getWanDetail('X_HW_DMZ.DMZHostIPAddress')}</div></div>
                                </div>
                              </td>
                            </tr>
                          </Show>
                          </>;
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>

            {/* Row 2.5: LAN Interfaces */}
            <div class="card p-5">
              <div class="flex items-center justify-between gap-3 mb-4">
                <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                  <Network size={14} />
                  LAN Interfaces ({getLanInterfaces().length})
                </h2>
                <Show when={isFullAccess()}>
                  <div class="relative" ref={lanContextMenu}>
                    <button type="button" class="icon-button" aria-label="LAN Interfaces menu" aria-haspopup="menu" aria-expanded={showLanContextMenu()} onClick={() => setShowLanContextMenu(value => !value)}>
                      <MoreVertical size={18} />
                    </button>
                    <Show when={showLanContextMenu()}>
                      <div class="absolute right-0 top-full z-50 mt-2 min-w-48 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu">
                        <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-base" onClick={() => { setShowLanContextMenu(false); setShowLanNetworkModal(true); }}>
                          LAN IP and DHCP
                        </button>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
              <Show when={getLanInterfaces().length > 0} fallback={
                <p class="text-muted text-sm">No LAN interface data. Click Summon to fetch.</p>
              }>
                <div class="overflow-x-auto">
                  <table class="data-table w-full text-sm min-w-[720px]">
                    <thead class="sticky top-0 bg-base z-10">
                      <tr class="border-b-2 border-subtle bg-base">
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Name</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Status</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">Adm. status</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">MAC Address</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Duplex</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Speed</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">L3</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={getLanInterfaces()}>
                        {(lan) => (
                          <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                            <td class="px-3 py-2.5 text-primary font-medium">{lan.name}</td>
                            <td class="px-3 py-2.5">
                              <span class={`badge ${statusBadgeClass(lan.status)}`}>{lan.status}</span>
                            </td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess()} fallback={<span class={lan.enabled ? 'text-emerald-400' : 'text-muted'}>{lan.enabled ? 'Y' : '-'}</span>}>
                                <button
                                  onClick={() => handleLanEnable(lan.index, !lan.enabled)}
                                  disabled={actionLoading() !== null}
                                  class={`badge cursor-pointer ${lan.enabled ? 'badge-success' : 'badge-error'}`}
                                  aria-label={`${lan.enabled ? 'Disable' : 'Enable'} ${lan.name}`}
                                >
                                  {lan.enabled ? 'Yes' : 'No'}
                                </button>
                              </Show>
                            </td>
                            <td class="px-3 py-2.5 text-primary font-mono">{lan.mac}</td>
                            <td class="px-3 py-2.5 text-secondary">{lan.duplex}</td>
                            <td class="px-3 py-2.5 text-secondary">{lan.speed}</td>
                            <td class="px-2 py-2.5 text-center">
                              <Show when={isFullAccess()} fallback={<span class={lan.l3Enable === '1' || lan.l3Enable === 'true' ? 'text-emerald-400' : 'text-muted'}>{lan.l3Enable === '1' || lan.l3Enable === 'true' ? 'Y' : '-'}</span>}>
                                <button
                                  onClick={() => handleLanL3(lan.index, lan.l3Enable !== '1' && lan.l3Enable !== 'true')}
                                  disabled={actionLoading() !== null}
                                  class={`badge cursor-pointer ${lan.l3Enable === '1' || lan.l3Enable === 'true' ? 'badge-success' : 'badge-error'}`}
                                  aria-label={`${lan.l3Enable === '1' || lan.l3Enable === 'true' ? 'Disable' : 'Enable'} L3 on ${lan.name}`}
                                >
                                  {lan.l3Enable === '1' || lan.l3Enable === 'true' ? 'Yes' : 'No'}
                                </button>
                              </Show>
                            </td>
                            <td class="px-2 py-2">
                              <button
                                onClick={() => setStatsInterface({ type: 'lan', name: lan.name, path: `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${lan.index}.` })}
                                class="icon-button"
                                aria-label={`Show statistics for ${lan.name}`}
                                title="Interface statistics"
                              >
                                <Activity size={14} />
                              </button>
                              <Show when={isFullAccess()} fallback={<span class="text-muted text-xs">-</span>}>
                                <button
                                  onClick={() => setLanModalIndex(lan.index)}
                                  class="icon-button"
                                  aria-label={`Edit LAN interface ${lan.name}`}
                                >
                                  <Edit size={14} />
                                </button>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>

            {/* Row 3: Wi-Fi information */}
            <div class="card p-5">
              <h2 class="text-xs font-medium text-muted mb-4 flex items-center justify-start gap-4 flex-wrap">
                <span class="flex items-center gap-2">
                  <Radio size={14} />
                  Wi-Fi configuration
                </span>
                <Show when={getWifiRadios().length > 0}>
                  <div class="flex flex-wrap items-center justify-start gap-2" aria-label="Wi-Fi radio states">
                    <For each={getWifiRadios()}>
                      {(radio) => (
                        <div class="flex items-center gap-2 rounded-md border border-subtle px-2.5 py-1.5">
                          <Show when={isFullAccess()} fallback={<span class={`badge ${radio.enabled ? 'badge-success' : 'badge-error'}`}>{radio.enabled ? 'Enabled' : 'Disabled'}</span>}>
                            <button
                              type="button"
                              onClick={() => handleSetWifiRadioEnabled(radio, !radio.enabled)}
                              disabled={actionLoading() !== null}
                              class={`badge cursor-pointer ${radio.enabled ? 'badge-success' : 'badge-error'}`}
                              aria-label={`${radio.enabled ? 'Disable' : 'Enable'} radio ${radio.index}`}
                              aria-pressed={radio.enabled}
                            >
                              {radio.enabled ? 'Enabled' : 'Disabled'}
                            </button>
                          </Show>
                          <span class="text-xs text-secondary">Radio {radio.index} · {radio.frequency}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </h2>
              <Show when={!parameters.loading || (parameters()?.length ?? 0) > 0} fallback={<div class="space-y-2" aria-label="Loading Wi-Fi configuration"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-3/4" /></div>}>
                <Show when={getWlanConfigs().length > 0} fallback={
                  <EmptyState compact title="No Wi-Fi configuration is stored" description="This CPE has not reported WLAN parameters. Send a connection request with Summon, then refresh the record." />
                }>
                  <div class="overflow-x-auto">
                  <table class="data-table w-full text-xs min-w-[860px]">
                    <thead class="sticky top-0 bg-base z-10">
                      <tr class="border-b border-subtle bg-base">
                        <th class="text-left px-2 py-2 font-medium text-secondary">Index</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Status</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Adm. status</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">SSID Name</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Security</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Band</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Ch</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Max Rate</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Password</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={getWlanConfigs()}>
                        {(wlan, i) => (
                          <tr class={`border-t border-subtle/30 hover:bg-elevated/50 transition-colors ${i() % 2 === 1 ? 'bg-elevated/20' : ''}`}>
                            <td class="px-3 py-2 text-secondary">SSID{wlan.index}</td>
                            <td class="px-3 py-2">
                              <span class={`badge ${statusBadgeClass(wlan.status)}`}>{wlan.status}</span>
                            </td>
                            <td class="px-3 py-2">
                              <Show when={isFullAccess()} fallback={<span class={`badge ${wlan.enabled ? 'badge-success' : 'badge-error'}`}>{wlan.enabled ? 'Yes' : 'No'}</span>}><button
                                onClick={() => handleSetWifiEnabled(wlan.index, !wlan.enabled)}
                                disabled={actionLoading() !== null}
                                class={`badge cursor-pointer ${wlan.enabled ? 'badge-success' : 'badge-error'}`}
                                aria-label={`${wlan.enabled ? 'Disable' : 'Enable'} SSID${wlan.index}`}
                              >
                                {wlan.enabled ? 'Yes' : 'No'}
                              </button></Show>
                            </td>
                            <td class="px-3 py-2">
                              <span class="text-primary font-medium">{wlan.ssid}</span>
                            </td>
                            <td class="px-3 py-2 text-secondary">{wlan.security}</td>
                            <td class="px-3 py-2 text-secondary">{wlan.frequency}</td>
                            <td class="px-3 py-2 text-secondary">{wlan.channel}</td>
                            <td class="px-3 py-2 text-secondary">{wlan.maxBitrate}</td>
                            <td class="px-3 py-2">
                              <span class="text-muted font-mono text-xs">{showSensitive() ? wlan.password : '••••••••'}</span>
                            </td>
                            <td class="px-3 py-2">
                              <Show when={isFullAccess()}>
                                <button
                                  onClick={() => setWifiModalIndex(wlan.index)}
                                  class="icon-button"
                                  aria-label={`Edit Wi-Fi SSID${wlan.index}`}
                                >
                                  <Edit size={14} />
                                </button>
                                <button
                                  onClick={() => void handleDeleteWifiSSID(wlan.index, wlan.ssid)}
                                  disabled={actionLoading() !== null}
                                  class="icon-button text-rose-400"
                                  aria-label={`Delete Wi-Fi SSID${wlan.index}`}
                                  title="Delete SSID object"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  </div>
                </Show>
              </Show>
            </div>
            </Show>

            <Show when={activeTab() === 'hosts'}>
            {/* Row 4: Connected Hosts */}
            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                  <Users size={14} />
                  Connected Hosts ({filteredHosts().length})
                </h2>
                <div class="relative">
                  <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                  <input type="text" value={hostSearch()} onInput={(e) => setHostSearch(e.currentTarget.value)} placeholder="Search hosts…" class="input pl-9! w-48 text-sm" />
                  <Show when={hostSearch()}>
                    <button onClick={() => setHostSearch('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
                  </Show>
                </div>
              </div>
              <Show when={!parameters.loading || (parameters()?.length ?? 0) > 0} fallback={<div class="space-y-2" aria-label="Loading connected hosts"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-2/3" /></div>}>
                <Show when={filteredHosts().length > 0} fallback={
                  <EmptyState compact title="No connected hosts are reported" description="The stored parameter set contains no active LAN or Wi-Fi clients. Send a connection request with Summon to request current host data." />
                }>
                <div class="overflow-x-auto">
                  <table class="data-table w-full text-sm min-w-[960px]">
                    <thead class="sticky top-0 bg-base z-10">
                      <tr class="border-b border-subtle bg-base">
                        <Show when={hostColumns().find(column => column.id === 'hostname')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Hostname
                            <ColumnFilter columnId="hostname" label="Hostname" active={hostColumnFilters()['hostname'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['hostname'] = s; else delete n['hostname']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'ip')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">IP address
                            <ColumnFilter columnId="ip" label="IP address" active={hostColumnFilters()['ip'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['ip'] = s; else delete n['ip']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'ipv6')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">IPv6 address
                            <ColumnFilter columnId="ipv6" label="IPv6 address" active={hostColumnFilters()['ipv6'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['ipv6'] = s; else delete n['ipv6']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'mac')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">MAC address
                            <ColumnFilter columnId="mac" label="MAC address" active={hostColumnFilters()['mac'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['mac'] = s; else delete n['mac']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'negRate')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Neg. rate
                            <ColumnFilter columnId="negRate" label="Neg. rate" active={hostColumnFilters()['negRate'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['negRate'] = s; else delete n['negRate']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'interface')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Interface
                            <ColumnFilter columnId="interface" label="Interface" active={hostColumnFilters()['interface'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['interface'] = s; else delete n['interface']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'rssi')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Signal
                            <ColumnFilter columnId="rssi" label="Signal" active={hostColumnFilters()['rssi'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['rssi'] = s; else delete n['rssi']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={hostColumns().find(column => column.id === 'uptime')?.visible}><th class="text-left px-3 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Uptime
                            <ColumnFilter columnId="uptime" label="Uptime" active={hostColumnFilters()['uptime'] || null} onApply={(s) => { setHostColumnFilters((prev) => { const n = { ...prev }; if (s) n['uptime'] = s; else delete n['uptime']; return n; }); }} />
                          </div>
                        </th></Show>
                        <th class="px-2 py-2"><ColumnVisibility columns={hostColumns} onToggle={toggleHostColumn} /></th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={filteredHosts()}>
                        {(host) => (
                          <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                            <Show when={hostColumns().find(column => column.id === 'hostname')?.visible}><td class="px-3 py-2 text-primary">{host.hostname}</td></Show>
                            <Show when={hostColumns().find(column => column.id === 'ip')?.visible}><td class="px-3 py-2 text-primary font-mono">{host.ip}</td></Show>
                            <Show when={hostColumns().find(column => column.id === 'ipv6')?.visible}><td class="px-3 py-2 text-primary font-mono">{host.ipv6}</td></Show>
                            <Show when={hostColumns().find(column => column.id === 'mac')?.visible}><td class="px-3 py-2 text-secondary font-mono text-xs">{host.mac}</td></Show>
                            <Show when={hostColumns().find(column => column.id === 'negRate')?.visible}><td class="px-3 py-2 text-secondary">{host.negRate}</td></Show>
                            <Show when={hostColumns().find(column => column.id === 'interface')?.visible}><td class="px-3 py-2">
                              <span class={`px-2 py-0.5 rounded text-xs ${
                                host.interface.startsWith('WiFi') || host.interface.startsWith('SSID')
                                  ? 'bg-sky-500/20 text-sky-400'
                                  : host.interface === 'Ethernet' 
                                    ? 'bg-blue-500/20 text-blue-400'
                                    : 'bg-zinc-700 text-secondary'
                              }`}>
                                {host.interface}
                              </span>
                            </td></Show>
                            <Show when={hostColumns().find(column => column.id === 'rssi')?.visible}><td class="px-3 py-2 text-secondary">
                              {host.rssi && host.rssi !== '-' ? `${host.rssi} dBm` : '-'}
                            </td></Show>
                            <Show when={hostColumns().find(column => column.id === 'uptime')?.visible}><td class="px-3 py-2 text-secondary text-xs">
                              {host.uptime ? formatUptime(host.uptime) : '-'}
                            </td></Show>
                            <td class="px-2 py-2"></td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                </Show>
              </Show>
            </div>
            </Show>

            {/* Row 5: Task History */}
            <Show when={activeTab() === 'tasks'}>
            <dl class="ops-register task-register" aria-label="Device CWMP task status register" aria-busy={deviceTaskCounts.loading}>
              <div class="ops-register-cell is-warning"><dt>Pending</dt><dd>{deviceTaskCounts()?.pending ?? 0}</dd><small>Waiting to be sent</small></div>
              <div class="ops-register-cell"><dt>Sent</dt><dd>{deviceTaskCounts()?.sent ?? 0}</dd><small>Dispatched to CPE</small></div>
              <div class="ops-register-cell is-online"><dt>Completed</dt><dd>{deviceTaskCounts()?.completed ?? 0}</dd><small>Successfully finished</small></div>
              <div class="ops-register-cell is-offline"><dt>Failed</dt><dd>{deviceTaskCounts()?.failed ?? 0}</dd><small>Require review</small></div>
              <div class="ops-register-cell"><dt>Deleted</dt><dd>{deviceTaskCounts()?.deleted ?? 0}</dd><small>Cancelled before dispatch</small></div>
              <div class="ops-register-cell"><dt>Total tasks</dt><dd>{deviceTaskCounts()?.total ?? 0}</dd><small>All tasks for this CPE</small></div>
            </dl>
            <div class="card overflow-hidden">
              <div class="p-5 border-b border-subtle flex items-center justify-between">
                <h2 class="flex items-center gap-2 text-sm font-medium text-secondary"><ClipboardList size={16} class="text-sky-400" />CWMP tasks ({tasks()?.length || 0})</h2>
                <div class="relative">
                  <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                  <input type="text" value={taskSearch()} onInput={(e) => setTaskSearch(e.currentTarget.value)} placeholder="Search tasks…" class="input pl-9! w-48 text-sm" />
                  <Show when={taskSearch()}>
                    <button onClick={() => setTaskSearch('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
                  </Show>
                </div>
              </div>
              <Show when={!tasks.loading} fallback={<div class="p-5 space-y-2" aria-label="Loading CPE task history"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /></div>}>
              <Show when={(tasks()?.length || 0) > 0} fallback={<EmptyState compact title="No remote tasks have been queued" description="Reboot, parameter, firmware, and connection-request operations will appear here after an operator creates them." />}>
                <div class="table-scroll">
                  <table class="data-table w-full text-sm min-w-[980px]">
                    <thead class="bg-base sticky top-0 z-10">
                      <tr class="bg-base">
                        <Show when={isDeviceTaskColumnVisible('type')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="type" label="Type" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="type" label="Type" active={taskColumnFilters()['type'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['type'] = s; else delete n['type']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={isDeviceTaskColumnVisible('trigger_event')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="trigger_event" label="Trigger event" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="trigger_event" label="Trigger event" active={taskColumnFilters()['trigger_event'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['trigger_event'] = s; else delete n['trigger_event']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={isDeviceTaskColumnVisible('status')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="status" label="Status" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="status" label="Status" active={taskColumnFilters()['status'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['status'] = s; else delete n['status']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={isDeviceTaskColumnVisible('created_at')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="created_at" label="Created" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="created_at" label="Created" active={taskColumnFilters()['created_at'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['created_at'] = s; else delete n['created_at']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={isDeviceTaskColumnVisible('completed_at')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="completed_at" label="Completed" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="completed_at" label="Completed" active={taskColumnFilters()['completed_at'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['completed_at'] = s; else delete n['completed_at']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={isDeviceTaskColumnVisible('created_by')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="created_by" label="Created by" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="created_by" label="Created by" active={taskColumnFilters()['created_by'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['created_by'] = s; else delete n['created_by']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={isDeviceTaskColumnVisible('deleted_by')}><th class="text-left px-4 py-2 text-xs font-medium text-muted"><SortableHeader column="deleted_by" label="Deleted by" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} /></th></Show>
                        <Show when={isDeviceTaskColumnVisible('error')}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5"><SortableHeader column="error" label="Error" sortBy={taskSort().column} direction={taskSort().direction} onSort={toggleSort(setTaskSort)} />
                            <ColumnFilter columnId="error" label="Error" active={taskColumnFilters()['error'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['error'] = s; else delete n['error']; return n; }); }} />
                          </div>
                        </th></Show>
                        <th class="text-right px-4 py-2 text-xs font-medium text-muted">Actions</th>
                        <th class="px-2 py-2"><ColumnVisibility columns={deviceTaskColumns} onToggle={toggleDeviceTaskColumn} /></th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={pagedTasks()}>
                        {(task) => (
                          <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                            <Show when={isDeviceTaskColumnVisible('type')}><td class="px-4 py-2 text-primary">{task.type}</td></Show>
                            <Show when={isDeviceTaskColumnVisible('trigger_event')}><td class="px-4 py-2 text-secondary text-xs">{formatTaskTriggerEvents(task.trigger_events)}</td></Show>
                            <Show when={isDeviceTaskColumnVisible('status')}><td class="px-4 py-2"><span class={`badge ${getStatusBadge(task.status)}`}>{task.status}</span></td></Show>
                            <Show when={isDeviceTaskColumnVisible('created_at')}><td class="px-4 py-2 text-muted text-xs">{formatDate(task.created_at)}</td></Show>
                            <Show when={isDeviceTaskColumnVisible('completed_at')}><td class="px-4 py-2 text-muted text-xs">{formatDate(task.completed_at)}</td></Show>
                            <Show when={isDeviceTaskColumnVisible('created_by')}><td class="px-4 py-2 text-muted text-xs">{task.created_by || '-'}</td></Show>
                            <Show when={isDeviceTaskColumnVisible('deleted_by')}><td class="px-4 py-2 text-muted text-xs">{task.deleted_by || '-'}</td></Show>
                            <Show when={isDeviceTaskColumnVisible('error')}><td class="px-4 py-2 text-rose-400 text-xs">{task.error_message || '-'}</td></Show>
                            <td class="px-4 py-2 text-right">
                              <div class="inline-flex items-center gap-1">
                                <button
                                  class="btn btn-ghost btn-xs"
                                  onClick={() => { setSelectedTask(task); setTaskDetailTab('requested'); }}
                                >
                                  <Eye size={13} />
                                  Details
                                </button>
                                <Show when={task.status === 'pending' && isFullAccess()}>
                                  <button type="button" class="btn btn-ghost btn-xs text-rose-400" disabled={deletingTask() === task.id} onClick={() => void deletePendingTask(task)} aria-label={`Delete pending task ${task.id}`} title="Delete pending task"><Trash2 size={13} /></button>
                                </Show>
                              </div>
                            </td>
                            <td></td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              </Show>
            </div>
            <Pagination page={taskPage()} totalPages={taskTotalPages()} totalItems={filteredTasks().length} pageSize={taskPageSize()} onPageChange={setTaskPage} storageKey="device_tasks" onPageSizeChange={handleTaskPageSizeChange} filters={taskColumnFilters()} onClearFilters={() => { setTaskColumnFilters({}); setTaskPage(0); }} onRemoveFilter={(columnId) => { setTaskColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setTaskPage(0); }} />
            </Show>

            {/* Task Detail Dialog */}
            <Show when={selectedTask()}>
              <Dialog title={`Task #${selectedTask()!.id} — ${selectedTask()!.type}`} size="large" onClose={() => setSelectedTask(null)}>
                <div class="space-y-4">
                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div><span class="text-muted text-xs">Status</span><div class="mt-0.5"><span class={`badge ${getStatusBadge(selectedTask()!.status)}`}>{selectedTask()!.status}</span></div></div>
                    <div><span class="text-muted text-xs">Trigger event</span><div class="mt-0.5 text-primary">{formatTaskTriggerEvents(selectedTask()!.trigger_events)}</div></div>
                    <div><span class="text-muted text-xs">Created by</span><div class="mt-0.5 text-primary">{selectedTask()!.created_by || '-'}</div></div>
                    <Show when={selectedTask()!.deleted_by}><div><span class="text-muted text-xs">Deleted by</span><div class="mt-0.5 text-primary">{selectedTask()!.deleted_by}</div></div></Show>
                    <div><span class="text-muted text-xs">Created</span><div class="mt-0.5 text-primary">{formatDate(selectedTask()!.created_at)}</div></div>
                    <div><span class="text-muted text-xs">Completed</span><div class="mt-0.5 text-primary">{formatDate(selectedTask()!.completed_at)}</div></div>
                  </div>
                  <Show when={selectedTask()!.error_message}>
                    <div class="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{selectedTask()!.error_message}</div>
                  </Show>
                  <div class="border-b border-subtle flex gap-0">
                    <button class={`px-4 py-2 text-sm font-medium border-b-2 ${taskDetailTab() === 'requested' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setTaskDetailTab('requested')}>Requested</button>
                    <button class={`px-4 py-2 text-sm font-medium border-b-2 ${taskDetailTab() === 'result' ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setTaskDetailTab('result')}>Result</button>
                  </div>
                  <Show when={taskDetailTab() === 'requested'}>
                    <Show when={selectedTask()!.payload != null} fallback={<p class="text-sm text-muted">No payload for this task type.</p>}>
                      <Show when={Array.isArray(selectedTask()!.payload)} fallback={
                        <div class="overflow-x-auto"><table class="data-table w-full text-sm"><thead><tr><th class="text-left px-3 py-2 text-xs font-medium text-muted">Key</th><th class="text-left px-3 py-2 text-xs font-medium text-muted">Value</th></tr></thead><tbody>
                          <For each={Object.entries(selectedTask()!.payload as Record<string, unknown>)}>
                            {([key, value]) => (<tr class="border-t border-subtle/50"><td class="px-3 py-1.5 font-mono text-xs text-primary">{key}</td><td class="px-3 py-1.5 text-xs">{typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}</td></tr>)}
                          </For>
                        </tbody></table></div>
                      }>
                        <div class="space-y-1">
                          <For each={selectedTask()!.payload as string[]}>
                            {(param) => (<div class="font-mono text-xs text-primary px-3 py-1.5 bg-elevated/50 rounded">{param}</div>)}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </Show>
                  <Show when={taskDetailTab() === 'result'}>
                    <Show when={selectedTask()!.result != null} fallback={<p class="text-sm text-muted">No result yet — task may still be pending.</p>}>
                      <Show when={typeof selectedTask()!.result === 'object' && !Array.isArray(selectedTask()!.result) && selectedTask()!.result !== null} fallback={
                        <pre class="text-xs font-mono bg-elevated/50 rounded p-3 overflow-x-auto">{JSON.stringify(selectedTask()!.result, null, 2)}</pre>
                      }>
                        <div class="overflow-x-auto"><table class="data-table w-full text-sm"><thead><tr><th class="text-left px-3 py-2 text-xs font-medium text-muted">Key</th><th class="text-left px-3 py-2 text-xs font-medium text-muted">Value</th></tr></thead><tbody>
                          <For each={Object.entries(selectedTask()!.result as Record<string, unknown>)}>
                            {([key, value]) => (<tr class="border-t border-subtle/50"><td class="px-3 py-1.5 font-mono text-xs text-primary">{key}</td><td class="px-3 py-1.5 text-xs">{typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}</td></tr>)}
                          </For>
                        </tbody></table></div>
                      </Show>
                    </Show>
                  </Show>
                </div>
              </Dialog>
            </Show>

            <Show when={activeTab() === 'faults'}>
            {/* Row 5.5: CWMP Faults */}
            <dl class="ops-register fault-register mb-4" aria-label="Fault status register" aria-busy={deviceFaultCounts.loading}>
              <div class="ops-register-cell is-offline"><dt>Active faults</dt><dd>{deviceFaultCounts()?.active ?? 0}</dd><small>Awaiting operator action</small></div>
              <div class="ops-register-cell is-online"><dt>Resolved</dt><dd>{deviceFaultCounts()?.resolved ?? 0}</dd><small>Closed fault records</small></div>
              <div class="ops-register-cell"><dt>Total recorded</dt><dd>{deviceFaultCounts()?.total ?? 0}</dd><small>All CWMP fault events</small></div>
            </dl>
            <div class="card overflow-hidden">
              <div class="p-5 border-b border-subtle flex items-center justify-between">
                <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                  <AlertTriangle size={14} />
                  CWMP Faults ({deviceFaults()?.length || 0})
                </h2>
                <div class="flex items-center gap-3">
                  <Show when={isFullAccess() && selectedDeviceFaults().size > 0}>
                    <button onClick={handleBulkDeleteFaults} class="btn btn-danger" disabled={bulkDeletingFaults()}>
                      <Trash2 size={14} />
                      Delete selected ({selectedDeviceFaults().size})
                    </button>
                  </Show>
                  <div class="relative">
                    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                    <input type="text" value={faultSearch()} onInput={(e) => setFaultSearch(e.currentTarget.value)} placeholder="Search faults…" class="input pl-9! w-48 text-sm" />
                    <Show when={faultSearch()}>
                      <button onClick={() => setFaultSearch('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
                    </Show>
                  </div>
                </div>
              </div>
              <Show when={deviceFaults.loading} fallback={
                <Show when={(deviceFaults()?.length || 0) > 0} fallback={
                  <EmptyState compact icon={<AlertTriangle size={22} />} title="No CWMP faults recorded for this device" description="Protocol faults will appear here when the device reports a CWMP error during a session." />
                }>
                  <div class="table-scroll">
                    <table class="data-table w-full text-sm min-w-[680px]">
                      <thead class="bg-base sticky top-0 z-10">
                        <tr class="bg-base">
                          <th class="px-3 py-2 w-8" aria-label="Fault details" />
                          <Show when={isFullAccess()}>
                            <th class="px-3 py-2 w-8">
                              <input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={allDeviceFaultsSelected()} onChange={toggleSelectAllDeviceFaults} aria-label="Select all faults on this page" />
                            </th>
                          </Show>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5"><SortableHeader column="code" label="Code" sortBy={faultSort().column} direction={faultSort().direction} onSort={toggleSort(setFaultSort)} />
                              <ColumnFilter columnId="code" label="Code" active={deviceFaultColumnFilters()['code'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['code'] = s; else delete n['code']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5"><SortableHeader column="message" label="Message" sortBy={faultSort().column} direction={faultSort().direction} onSort={toggleSort(setFaultSort)} />
                              <ColumnFilter columnId="message" label="Message" active={deviceFaultColumnFilters()['message'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['message'] = s; else delete n['message']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5"><SortableHeader column="parameter" label="Parameter" sortBy={faultSort().column} direction={faultSort().direction} onSort={toggleSort(setFaultSort)} />
                              <ColumnFilter columnId="parameter" label="Parameter" active={deviceFaultColumnFilters()['parameter'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['parameter'] = s; else delete n['parameter']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5"><SortableHeader column="time" label="Time" sortBy={faultSort().column} direction={faultSort().direction} onSort={toggleSort(setFaultSort)} />
                              <ColumnFilter columnId="time" label="Time" active={deviceFaultColumnFilters()['time'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['time'] = s; else delete n['time']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5"><SortableHeader column="status" label="Status" sortBy={faultSort().column} direction={faultSort().direction} onSort={toggleSort(setFaultSort)} />
                              <ColumnFilter columnId="status" label="Status" active={deviceFaultColumnFilters()['status'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['status'] = s; else delete n['status']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-right px-4 py-2 text-xs font-medium text-muted">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={pagedDeviceFaults()}>
                          {(fault) => {
                            const [expanded, setExpanded] = createSignal(false);
                            return <>
                            <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                              <td class="px-3 py-2">
                                <button type="button" class="icon-button" aria-label={`${expanded() ? 'Collapse' : 'Expand'} fault ${fault.id}`} aria-expanded={expanded()} aria-controls={`fault-details-${fault.id}`} onClick={() => setExpanded(value => !value)}>
                                  <Show when={expanded()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show>
                                </button>
                              </td>
                              <Show when={isFullAccess()}>
                                <td class="px-3 py-2">
                                  <input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={selectedDeviceFaults().has(fault.id)} onChange={() => toggleSelectDeviceFault(fault.id)} aria-label={`Select fault ${fault.fault_code}`} />
                                </td>
                              </Show>
                              <td class="px-4 py-2">
                                <span class={`font-mono font-semibold ${parseInt(fault.fault_code) >= 9000 ? 'text-rose-400' : parseInt(fault.fault_code) >= 8000 ? 'text-amber-400' : 'text-sky-400'}`}>
                                  {fault.fault_code}
                                </span>
                              </td>
                              <td class="px-4 py-2 text-secondary max-w-xs truncate" title={fault.fault_string}>
                                {fault.fault_string.length > 50 ? fault.fault_string.slice(0, 50) + '...' : fault.fault_string}
                              </td>
                              <td class="px-4 py-2 text-muted font-mono text-xs max-w-xs truncate" title={fault.parameter_name}>
                                {fault.parameter_name || '-'}
                              </td>
                              <td class="px-4 py-2 text-muted text-xs">{formatDate(fault.created_at)}</td>
                              <td class="px-4 py-2">
                                <span class={`badge ${fault.resolved ? 'badge-success' : 'badge-error'}`}>
                                  {fault.resolved ? 'Resolved' : 'Active'}
                                </span>
                              </td>
                              <td class="px-4 py-2 text-right">
                                <div class="flex items-center justify-end gap-2">
                                  <Show when={!fault.resolved && isFullAccess()}>
                                    <button
                                      onClick={() => handleResolveFault(fault.id)}
                                      class="icon-button hover:text-emerald-400"
                                      aria-label={`Mark fault ${fault.fault_code} as resolved`}
                                      disabled={pendingFault() === fault.id}
                                    >
                                      <Check size={14} />
                                    </button>
                                  </Show>
                                  <Show when={isFullAccess()}>
                                    <button
                                      onClick={() => handleDeleteFault(fault.id)}
                                      class="icon-button hover:text-rose-400"
                                      aria-label={`Delete fault ${fault.fault_code}`}
                                      disabled={pendingFault() === fault.id}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </Show>
                                </div>
                              </td>
                            </tr>
                            <Show when={expanded()}>
                              <tr id={`fault-details-${fault.id}`} class="border-t border-subtle/50 bg-elevated/30">
                                <td colSpan={isFullAccess() ? 8 : 7} class="px-4 py-4">
                                  <dl class="grid grid-cols-1 gap-3 text-sm">
                                    <For each={[
                                      ['ID', String(fault.id)],
                                      ['Device ID', String(fault.device_id)],
                                      ['Serial number', fault.serial_number || serial()],
                                      ['Code', fault.fault_code],
                                      ['Message', fault.fault_string || '-'],
                                      ['Parameter', fault.parameter_name || '-'],
                                      ['Time', formatDate(fault.created_at)],
                                      ['Status', fault.resolved ? 'Resolved' : 'Active'],
                                      ['Resolved at', fault.resolved_at ? formatDate(fault.resolved_at) : '-'],
                                    ]}>
                                      {([label, value]) => <div class="min-w-0">
                                        <dt class="text-xs text-muted mb-1">{label}</dt>
                                        <dd class="text-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd>
                                      </div>}
                                    </For>
                                  </dl>
                                </td>
                              </tr>
                            </Show>
                            </>;
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              }>
                <div class="p-5 space-y-2" aria-label="Loading CWMP faults"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /></div>
              </Show>
            </div>
            <Pagination page={faultPage()} totalPages={deviceFaultTotalPages()} totalItems={filteredDeviceFaults().length} pageSize={faultPageSize()} onPageChange={setFaultPage} storageKey="device_faults" onPageSizeChange={handleFaultPageSizeChange} filters={deviceFaultColumnFilters()} onClearFilters={() => { setDeviceFaultColumnFilters({}); setFaultPage(0); }} onRemoveFilter={(columnId) => { setDeviceFaultColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setFaultPage(0); }} />
            </Show>

            <Show when={activeTab() === 'log'}>
            <section class="card overflow-hidden" aria-labelledby="device-log-title">
              <div class="p-5 border-b border-subtle flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 id="device-log-title" class="flex items-center gap-2 text-sm font-medium text-secondary"><ScrollText size={16} class="text-sky-400" />Device log</h2>
                  <p class="mt-1 text-xs text-muted">From InternetGatewayDevice.DeviceInfo.DeviceLog · {deviceLogPageData()?.total ?? 0} entries</p>
                </div>
                <div class="flex w-full sm:w-auto items-center gap-2">
                  <label class="sr-only" for="device-log-filter">Search device log</label>
                  <input id="device-log-filter" type="search" class="input min-w-0 flex-1 sm:w-72 py-1.5 text-sm" placeholder="Search log entries…" value={deviceLogFilter()} onInput={event => { setDeviceLogFilter(event.currentTarget.value); setDeviceLogPage(0); }} />
                  <Show when={isFullAccess()}><button type="button" class="btn btn-secondary whitespace-nowrap" onClick={() => void handleDeviceLogRefresh()} disabled={actionLoading() !== null} title="Request the current DeviceLog value from the CPE"><RefreshCw size={14} class={actionLoading() === 'device-log-refresh' ? 'animate-spin' : ''} />{actionLoading() === 'device-log-refresh' ? 'Updating…' : 'Refresh'}</button></Show>
                </div>
              </div>
              <Show when={deviceLogPageData.error}><div class="p-5"><ResourceError title="Device logs are unavailable" description="The stored CPE log history could not be loaded. Retry the request." onRetry={() => void refetchDeviceLog()} /></div></Show>
              <Show when={!deviceLogPageData.error}>
                <Show when={deviceLogPageData.loading && !deviceLogPageData()} fallback={
                  <Show when={Boolean(deviceLogPageData()?.total || deviceLogFilter() || Object.keys(deviceLogColumnFilters()).length)} fallback={<div class="p-5 text-sm text-muted">This CPE has not reported any log entries.</div>}>
                    <Show when={deviceLogPageData()?.items.length} fallback={<div class="p-5 text-sm text-muted">No log entries match the current search or filters.</div>}>
                    <div class="max-h-[36rem] overflow-auto">
                      <table class="data-table w-full text-sm">
                        <thead class="sticky top-0 z-10 bg-base"><tr>
                          <Show when={isDeviceLogColumnVisible('time')}><th scope="col" class="px-4 py-2 text-left text-xs font-medium text-muted"><SortableHeader column="time" label="Time" sortBy={deviceLogSort().column} direction={deviceLogSort().direction} onSort={toggleDeviceLogSort}><ColumnFilter columnId="time" label="Time" active={deviceLogColumnFilters().time || null} onApply={state => updateDeviceLogColumnFilter('time', state)} /></SortableHeader></th></Show>
                          <Show when={isDeviceLogColumnVisible('severity')}><th scope="col" class="px-4 py-2 text-left text-xs font-medium text-muted"><SortableHeader column="severity" label="Severity" sortBy={deviceLogSort().column} direction={deviceLogSort().direction} onSort={toggleDeviceLogSort}><ColumnFilter columnId="severity" label="Severity" active={deviceLogColumnFilters().severity || null} onApply={state => updateDeviceLogColumnFilter('severity', state)} /></SortableHeader></th></Show>
                          <Show when={isDeviceLogColumnVisible('message')}><th scope="col" class="px-4 py-2 text-left text-xs font-medium text-muted"><SortableHeader column="message" label="Message" sortBy={deviceLogSort().column} direction={deviceLogSort().direction} onSort={toggleDeviceLogSort}><ColumnFilter columnId="message" label="Message" active={deviceLogColumnFilters().message || null} onApply={state => updateDeviceLogColumnFilter('message', state)} /></SortableHeader></th></Show>
                          <th class="px-2 py-2"><ColumnVisibility columns={deviceLogColumns} onToggle={toggleDeviceLogColumn} /></th>
                        </tr></thead>
                        <tbody><For each={filteredDeviceLog()}>{entry => {
                          const severity = entry.severity.toLowerCase();
                          const badgeClass = severity === 'critical' || severity === 'error' ? 'badge-error' : severity === 'warning' ? 'badge-warning' : 'badge-info';
                          return <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                            <Show when={isDeviceLogColumnVisible('time')}><td class="whitespace-nowrap px-4 py-2 font-mono text-xs text-muted">{entry.timestamp || '—'}</td></Show>
                            <Show when={isDeviceLogColumnVisible('severity')}><td class="px-4 py-2">{entry.severity ? <span class={`badge ${badgeClass}`}>{entry.severity}</span> : <span class="text-muted">—</span>}</td></Show>
                            <Show when={isDeviceLogColumnVisible('message')}><td class="px-4 py-2 font-mono text-xs text-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.message}</td></Show>
                            <td class="px-2 py-2"></td>
                          </tr>;
                        }}</For></tbody>
                      </table>
                    </div>
                    <Pagination page={deviceLogPage()} totalPages={Math.max(1, Math.ceil((deviceLogPageData()?.total || 0) / deviceLogPageSize()))} totalItems={deviceLogPageData()?.total || 0} pageSize={deviceLogPageSize()} onPageChange={setDeviceLogPage} storageKey="device_logs" onPageSizeChange={changeDeviceLogPageSizeAndReset} filters={deviceLogColumnFilters()} onClearFilters={() => { setDeviceLogColumnFilters({}); setDeviceLogPage(0); }} onRemoveFilter={column => { updateDeviceLogColumnFilter(column, null); }} />
                    </Show>
                  </Show>
                }><div class="p-5 space-y-2" aria-label="Loading device log"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /></div></Show>
              </Show>
            </section>
            </Show>
            <Show when={activeTab() === 'overview'}>
            {/* Row 6: All Parameters */}
            <div class="card overflow-hidden">
              <div class="p-5 border-b border-subtle flex items-center justify-between gap-4">
                <h2 class="text-sm font-medium text-secondary whitespace-nowrap">All Parameters ({filteredAllParams().length})</h2>
                <div class="flex items-center gap-2">
                  <input
                    id="parameter-filter"
                    type="search"
                    value={paramFilter()}
                    onInput={(e) => setParamFilter(e.currentTarget.value)}
                    placeholder="Filter parameter path…"
                    class="input w-96 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    class="icon-button"
                    onClick={() => void loadAllParameters()}
                    disabled={allParameters.loading}
                    title="Load or refresh parameters"
                    aria-label="Load or refresh parameters"
                  >
                    <RefreshCw size={14} class={allParameters.loading ? 'animate-spin' : ''} />
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    onClick={exportParamsCSV}
                    disabled={filteredAllParams().length === 0}
                    title="Export CSV"
                    aria-label="Export parameters as CSV"
                  >
                    <Download size={14} />
                  </button>
                </div>
              </div>
              <Show when={filteredAllParams().length > 0} fallback={
                <div class="p-8 text-center">
                  <p class="text-muted text-sm">{allParameters.loading ? 'Loading all parameters from the database…' : allParameters.error ? 'Could not load parameters. Use refresh to retry.' : allParametersRequested() ? 'No parameters are stored for this CPE.' : 'Click refresh to load all parameters from the database.'}</p>
                </div>
              }>
                <div class="max-h-96 overflow-auto">
                  <table class="data-table w-full text-sm">
                    <thead class="bg-base sticky top-0 z-10">
                      <tr class="bg-base">
                        <Show when={paramColumns().find(c => c.id === 'object')?.visible}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Object
                            <ColumnFilter columnId="object" label="Object" active={paramColumnFilters()['object'] || null} onApply={(s) => { setParamColumnFilters((prev) => { const n = { ...prev }; if (s) n['object'] = s; else delete n['object']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={paramColumns().find(c => c.id === 'name')?.visible}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Name
                            <ColumnFilter columnId="name" label="Name" active={paramColumnFilters()['name'] || null} onApply={(s) => { setParamColumnFilters((prev) => { const n = { ...prev }; if (s) n['name'] = s; else delete n['name']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={paramColumns().find(c => c.id === 'writable')?.visible}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Writable
                            <ColumnFilter columnId="writable" label="Writable" active={paramColumnFilters()['writable'] || null} onApply={(s) => { setParamColumnFilters((prev) => { const n = { ...prev }; if (s) n['writable'] = s; else delete n['writable']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={paramColumns().find(c => c.id === 'value_type')?.visible}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Value type
                            <ColumnFilter columnId="value_type" label="Value type" active={paramColumnFilters()['value_type'] || null} onApply={(s) => { setParamColumnFilters((prev) => { const n = { ...prev }; if (s) n['value_type'] = s; else delete n['value_type']; return n; }); }} />
                          </div>
                        </th></Show>
                        <Show when={paramColumns().find(c => c.id === 'value')?.visible}><th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Value
                            <ColumnFilter columnId="value" label="Value" active={paramColumnFilters()['value'] || null} onApply={(s) => { setParamColumnFilters((prev) => { const n = { ...prev }; if (s) n['value'] = s; else delete n['value']; return n; }); }} />
                          </div>
                        </th></Show>
                        <th class="px-2 py-2"><ColumnVisibility columns={paramColumns} onToggle={toggleParamColumn} /></th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={filteredAllParams()}>
                        {(param) => (
                          <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                            <Show when={paramColumns().find(c => c.id === 'object')?.visible}><td class="px-4 py-2 text-muted font-mono text-xs truncate" title={param.name.includes('.') ? param.name.substring(0, param.name.lastIndexOf('.')) : ''}>{param.name.includes('.') ? param.name.substring(0, param.name.lastIndexOf('.')) : ''}</td></Show>
                            <Show when={paramColumns().find(c => c.id === 'name')?.visible}><td class="px-4 py-2 text-secondary font-mono text-xs truncate" title={param.name}><button type="button" class="data-link font-mono text-left" onClick={() => setSelectedParam(param)}>{param.name}</button></td></Show>
                            <Show when={paramColumns().find(c => c.id === 'writable')?.visible}><td class="px-4 py-2 text-xs">
                              <Show when={param.writable}><span class="text-emerald-400">✓</span></Show>
                              <Show when={!param.writable}><span class="text-muted">—</span></Show>
                            </td></Show>
                            <Show when={paramColumns().find(c => c.id === 'value_type')?.visible}><td class="px-4 py-2 text-muted text-xs">{param.value_type || '—'}</td></Show>
                            <Show when={paramColumns().find(c => c.id === 'value')?.visible}><td class="px-4 py-2 text-primary text-xs truncate max-w-xs">
                              {displayParameterValue(param.name, param.value).length > 100 ? displayParameterValue(param.name, param.value).slice(0, 100) + '...' : displayParameterValue(param.name, param.value)}
                            </td></Show>
                            <td class="px-2 py-2"></td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>
            </Show>
          </>
        )}
      </Show>

		  <Show when={featureObjectEditor()}>
			<Dialog title={`Edit ${featureObjectEditor()?.label} ${featureObjectEditor()?.instance}`} description="Update writable parameters for this object instance." size="large" onClose={() => setFeatureObjectEditor(null)} actions={<><button type="button" class="btn btn-secondary" onClick={() => setFeatureObjectEditor(null)} disabled={featureAction() !== null}>Cancel</button><button type="submit" form="feature-object-editor-form" class="btn btn-primary" disabled={featureAction() !== null}>{featureAction() ? 'Saving…' : 'Save changes'}</button></>}>
			  <form id="feature-object-editor-form" class="space-y-3" onSubmit={saveFeatureObjectParameters}>
				<For each={featureObjectEditor()?.fields || []}>{field => <label class="block text-xs text-muted"><span class="mb-1 block">{field.label} <Show when={!field.writable}><span class="text-muted">(read only)</span></Show></span><Show when={field.help}><span class="mb-2 block text-[11px] text-secondary">{field.help}</span></Show><Show when={field.input === 'boolean'} fallback={<Show when={field.input === 'select'} fallback={<input class="input w-full font-mono text-xs" type={field.type === 'string' ? 'text' : 'number'} min={field.type === 'unsignedInt' ? '0' : undefined} value={featureObjectDraft()[field.name] || ''} disabled={!field.writable || !isFullAccess() || featureAction() !== null} onInput={event => setFeatureObjectDraft(current => ({ ...current, [field.name]: event.currentTarget.value }))} />}><select class="input w-full" value={featureObjectDraft()[field.name] || ''} disabled={!field.writable || !isFullAccess() || featureAction() !== null} onChange={event => setFeatureObjectDraft(current => ({ ...current, [field.name]: event.currentTarget.value }))}><Show when={!field.options?.includes(featureObjectDraft()[field.name] || '')}><option value={featureObjectDraft()[field.name] || ''}>{featureObjectDraft()[field.name] || 'Select a value'}</option></Show><For each={field.options || []}>{option => <option value={option}>{field.option_labels?.[option] || option}</option>}</For></select></Show>}><input type="checkbox" class="h-4 w-4 accent-sky-500" checked={(featureObjectDraft()[field.name] || '').toLowerCase() === (field.enabled_value || '1').toLowerCase()} disabled={!field.writable || !isFullAccess() || featureAction() !== null} onChange={event => setFeatureObjectDraft(current => ({ ...current, [field.name]: event.currentTarget.checked ? (field.enabled_value || '1') : (field.disabled_value || '0') }))} /></Show></label>}</For>
				<Show when={(featureObjectEditor()?.fields.length || 0) === 0}><p class="text-sm text-muted">No parameters were discovered for this object. Refresh device parameters and try again.</p></Show>
			  </form>
			</Dialog>
		  </Show>

		  {/* Factory reset step-up confirmation */}
		  <Show when={showFactoryResetModal()}>
			<Dialog title={`Factory reset ${serial()}?`} description="All CPE configuration will be erased and service may not recover automatically. This operation cannot be undone." size="small" closeOnBackdrop={false} onClose={closeFactoryResetModal} actions={<><button onClick={closeFactoryResetModal} class="btn btn-secondary">Cancel</button><button onClick={handleFactoryReset} disabled={!factoryResetPassword() || actionLoading() !== null} class="btn btn-danger">Confirm factory reset</button></>}>
				<label for="factory-reset-password" class="block text-xs text-muted mb-1.5">Current ACS account password</label>
				<input
				  id="factory-reset-password"
			  type="password"
			  value={factoryResetPassword()}
			  onInput={(e) => setFactoryResetPassword(e.currentTarget.value)}
			  onKeyDown={(e) => { if (e.key === 'Enter') void handleFactoryReset(); }}
			  class="input w-full"
			  autocomplete="current-password"
			  autofocus
			/>
			</Dialog>
		  </Show>

      <Show when={false}>
        <Dialog
          title="Run iPerf test"
          description="The Huawei iPerf client will connect to the configured server through CWMP. The CPE must be online and able to reach the server."
          size="large"
          onClose={() => {}}
        >
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-3">
              <div class="col-span-2">
                <label for="iperf-server" class="block text-xs text-muted mb-1.5">iPerf server address</label>
                <input id="iperf-server" type="text" value={iperfForm().serverAddr} onInput={(e) => setIperfForm(f => ({ ...f, serverAddr: e.currentTarget.value }))} placeholder="192.0.2.10 or iperf.example.net" class="input w-full font-mono text-xs" disabled={iperfRunning()} />
              </div>
              <div>
                <label for="iperf-port" class="block text-xs text-muted mb-1.5">Port</label>
                <input id="iperf-port" type="number" min="1" max="65535" value={iperfForm().port} onInput={(e) => setIperfForm(f => ({ ...f, port: e.currentTarget.value }))} class="input w-full" disabled={iperfRunning()} />
              </div>
              <div>
                <label for="iperf-mode" class="block text-xs text-muted mb-1.5">Test mode</label>
                <select id="iperf-mode" value={iperfForm().testMode} onChange={(e) => setIperfForm(f => ({ ...f, testMode: e.currentTarget.value as IperfForm['testMode'] }))} class="input w-full" disabled={iperfRunning()}>
                  <option value="UPLOAD">Upload — CPE to server</option>
                  <option value="DOWNLOAD">Download — server to CPE</option>
                  <option value="BOTH">Both — upload and download</option>
                </select>
              </div>
              <div>
                <label for="iperf-protocol" class="block text-xs text-muted mb-1.5">Protocol</label>
                <select id="iperf-protocol" value={iperfForm().protocolType} onChange={(e) => setIperfForm(f => ({ ...f, protocolType: e.currentTarget.value as IperfForm['protocolType'] }))} class="input w-full" disabled={iperfRunning()}>
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                </select>
              </div>
              <div>
                <label for="iperf-duration" class="block text-xs text-muted mb-1.5">Duration (seconds)</label>
                <input id="iperf-duration" type="number" min="1" max="1800" value={iperfForm().maxTime} onInput={(e) => setIperfForm(f => ({ ...f, maxTime: e.currentTarget.value }))} class="input w-full" disabled={iperfRunning()} />
              </div>
              <div>
                <label for="iperf-parallel" class="block text-xs text-muted mb-1.5">Parallel streams</label>
                <input id="iperf-parallel" type="number" min="1" max="32" value={iperfForm().parallel} onInput={(e) => setIperfForm(f => ({ ...f, parallel: e.currentTarget.value }))} class="input w-full" disabled={iperfRunning()} />
              </div>
              <div>
                <label for="iperf-bandwidth" class="block text-xs text-muted mb-1.5">Bandwidth (UDP, 0 = CPE default)</label>
                <input id="iperf-bandwidth" type="number" min="0" step="1" value={iperfForm().bandwidth} onInput={(e) => setIperfForm(f => ({ ...f, bandwidth: e.currentTarget.value }))} class="input w-full" disabled={iperfRunning()} />
              </div>
            </div>
            <p class="text-xs text-muted">The iPerf server must listen on the selected port and be reachable from the CPE network. Use an allowlisted test server only.</p>
            <Show when={iperfResult()}>
              <div class="border border-subtle rounded-md p-3">
                <h3 class="text-sm font-medium text-secondary mb-2">Latest iPerf response</h3>
                <Suspense fallback={<div class="skeleton h-40 w-full" />}><IperfResult runs={iperfResult()!} /></Suspense>
              </div>
            </Show>
            <div class="flex gap-2 pt-2">
              <button type="button" class="btn btn-secondary flex-1" disabled={iperfRunning()}>Close</button>
              <button type="button" onClick={handleRunIperf} class="btn btn-primary flex-1" disabled={iperfRunning()}>
                {iperfRunning() ? 'Running iPerf…' : 'Start test'}
              </button>
            </div>
          </div>
        </Dialog>
      </Show>

      <Show when={statsInterface()}>
        <Dialog title={`${statsInterface()?.type.toUpperCase()} statistics — ${statsInterface()?.name}`} description="Charts show metrics configured for this interface in its provisioning template." size="large" onClose={() => setStatsInterface(null)} actions={<button type="button" class="btn btn-secondary" onClick={() => setStatsInterface(null)}>Close</button>}>
          <Show when={interfaceMetricDefs.loading || parameters.loading}>
            <div class="skeleton h-56 w-full" />
          </Show>
          <Show when={!interfaceMetricDefs.loading && !parameters.loading && interfaceMetricGroups().length === 0}>
            <EmptyState compact title="No metrics configured for this interface" description="Add an active WAN/LAN metric to the device type template. Matching paths must exist in the stored parameter tree." />
          </Show>
          <div class="space-y-5">
            <For each={interfaceMetricGroups()}>{(group) => <section class="rounded border border-subtle p-3">
              <h3 class="mb-2 text-xs font-medium text-secondary">{group[0].group || group[0].name}</h3>
              <Suspense fallback={<div class="skeleton h-72 w-full" />}><InterfaceMetricChart serial={serial()} definitions={group} interfacePath={statsInterface()!.path} parameterNames={(parameters() || []).map(parameter => parameter.name)} refreshKey={autoRefreshTick()} /></Suspense>
            </section>}</For>
          </div>
        </Dialog>
      </Show>

      {/* Parameter Detail Modal */}
      <Show when={selectedParam()}>
        <Dialog title="CWMP parameter detail" description="Full parameter path and the latest value stored from this CPE." size="large" onClose={() => setSelectedParam(null)} actions={<button onClick={() => setSelectedParam(null)} class="btn btn-secondary">Close parameter detail</button>}>
            <div class="mb-3">
              <span class="text-xs text-muted">Parameter path</span>
              <p class="text-sky-400 font-mono text-sm break-all">{selectedParam()?.name}</p>
            </div>
            <div class="flex-1 overflow-auto">
              <span class="text-xs text-muted">Stored value</span>
              <pre class="mt-1 p-3 bg-elevated/50 rounded-lg text-primary text-sm font-mono whitespace-pre-wrap break-all overflow-auto max-h-96">{selectedParam() ? displayParameterValue(selectedParam()!.name, selectedParam()!.value) : ''}</pre>
            </div>
        </Dialog>
      </Show>

      <Show when={wifiModalIndex() !== null && parameters()}>
        <WifiSettingsModal
          wlanIndex={wifiModalIndex()!}
          parameters={parameters()!}
          serial={serial()}
          isFullAccess={isFullAccess()}
          onClose={() => setWifiModalIndex(null)}
          onSaved={() => { loadDeviceParameters(); refetchTasks(); }}
        />
      </Show>

      <Show when={lanModalIndex() !== null && parameters()}>
        <LanSettingsModal
          lanIndex={lanModalIndex()!}
          parameters={parameters()!}
          serial={serial()}
          isFullAccess={isFullAccess()}
          onClose={() => setLanModalIndex(null)}
          onSaved={() => { loadDeviceParameters(); refetchTasks(); }}
        />
      </Show>

      <Show when={showLanNetworkModal() && parameters()}>
        <LanNetworkSettingsModal
          parameters={parameters()!}
          serial={serial()}
          onClose={() => setShowLanNetworkModal(false)}
          onSaved={() => { loadDeviceParameters(); refetchTasks(); }}
        />
      </Show>

      <Show when={wanModalPath() !== null && parameters()}>
        <WanSettingsModal
          wanPath={wanModalPath()!}
          parameters={parameters()!}
          serial={serial()}
          isFullAccess={isFullAccess()}
          onClose={() => setWanModalPath(null)}
          onSaved={() => { loadDeviceParameters(); refetchTasks(); }}
        />
      </Show>

    </div>
  );
};

export default DeviceDetail;
