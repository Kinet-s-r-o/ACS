import type { Component } from 'solid-js';
import { createResource, createSignal, Show, For, createEffect, createMemo, onCleanup, onMount } from 'solid-js';
import { useParams, A, useNavigate, useSearchParams } from '@solidjs/router';
import { ArrowLeft, RefreshCw, Trash2, Server, Network, Radio, Users, Zap, Edit, Save, X, HeartPulse, Key, Eye, EyeOff, Plus, Minus, Activity, AlertTriangle, Check, Download, Search, MoreVertical, ExternalLink, ChevronDown, ChevronRight } from 'lucide-solid';
import { api, type DeviceSnapshot, type MetricDefinition, type SnapshotParameter, type Task } from '../lib/api';
import { formatUptime, findHealthValue, formatHealthValue, healthColor, gaugeRange, type HealthTileGroup } from '../lib/health';
import { metricsTabMetrics, healthPanelMetrics } from '../lib/metricViews';
import { useAuth } from '../lib/auth';
import Dialog from '../components/Dialog';
import HealthGauge from '../components/HealthGauge';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import MetricChart from '../components/MetricChart';
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

interface HostColumnConfig {
  id: string;
  label: string;
  visible: boolean;
}

const HOST_COLUMNS_STORAGE_KEY = 'skyacs_connected_hosts_columns';
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
  testMode: 'UPLOAD' | 'DOWNLOAD';
  protocolType: 'TCP' | 'UDP';
  maxTime: string;
  parallel: string;
  bandwidth: string;
}

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
const NSLOOKUP_ROOTS = ['InternetGatewayDevice.DNS.Diagnostics.NSLookupDiagnostics.', 'Device.DNS.Diagnostics.NSLookupDiagnostics.'];
const IPPING_ROOTS = ['InternetGatewayDevice.IPPingDiagnostics.', 'Device.IP.Diagnostics.IPPing.'];
const TRACEROUTE_ROOTS = ['InternetGatewayDevice.TraceRouteDiagnostics.', 'Device.IP.Diagnostics.TraceRoute.'];

const PARAM_COLUMNS_STORAGE_KEY = 'skyacs_all_params_columns';
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
  const activeTab = () => searchParams.tab === 'metrics' || searchParams.tab === 'tasks' || searchParams.tab === 'snapshots' || searchParams.tab === 'credentials' || searchParams.tab === 'hosts' || searchParams.tab === 'faults' || searchParams.tab === 'diagnostic' ? searchParams.tab : 'overview';

  const [device, { refetch: refetchDevice }] = createResource(serial, api.getDevice);
  const [tagCatalog] = createResource(api.getTags);
  const [parameters, { refetch: refetchParams }] = createResource(serial, api.getDeviceParameters);
  const [tasks, { refetch: refetchTasks }] = createResource(serial, api.getDeviceTasks);
  const [snapshots, { refetch: refetchSnapshots }] = createResource(serial, api.getDeviceSnapshots);
  const [deviceFaults, { refetch: refetchDeviceFaults }] = createResource(serial, api.getDeviceFaults);
  const [metricDefs] = createResource(api.getMetricDefinitions);
  const [taskPage, setTaskPage] = createSignal(0);
  const [selectedTask, setSelectedTask] = createSignal<Task | null>(null);
  const [taskDetailTab, setTaskDetailTab] = createSignal<'requested' | 'result'>('requested');
  const { pageSize: taskPageSize, changePageSize: changeTaskPageSize } = usePageSize('device_tasks', 10);
  const handleTaskPageSizeChange = (size: number) => { changeTaskPageSize(size); setTaskPage(0); };
  const [taskColumnFilters, setTaskColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [deviceFaultColumnFilters, setDeviceFaultColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [taskSearch, setTaskSearch] = createSignal('');
  const [faultSearch, setFaultSearch] = createSignal('');
  const [hostSearch, setHostSearch] = createSignal('');
  const filteredTasks = createMemo(() => {
    let all = tasks() || [];
    const query = taskSearch().toLowerCase().trim();
    if (query) {
      all = all.filter(t =>
        t.type?.toLowerCase().includes(query) ||
        t.status?.toLowerCase().includes(query) ||
        t.created_by?.toLowerCase().includes(query) ||
        t.error_message?.toLowerCase().includes(query)
      );
    }
    return applyColumnFilters(all, taskColumnFilters(), (t, colId) => {
      switch (colId) {
        case 'type': return t.type || '';
        case 'status': return t.status || '';
        case 'created_at': return t.created_at || '';
        case 'completed_at': return t.completed_at || '';
        case 'created_by': return t.created_by || '';
        case 'error': return t.error_message || '';
        default: return '';
      }
    });
  });
  const pagedTasks = createMemo(() => {
    const all = filteredTasks();
    const start = taskPage() * taskPageSize();
    return all.slice(start, start + taskPageSize());
  });
  const taskTotalPages = createMemo(() => Math.ceil(filteredTasks().length / taskPageSize()));
  const [faultPage, setFaultPage] = createSignal(0);
  const { pageSize: faultPageSize, changePageSize: changeFaultPageSize } = usePageSize('device_faults', 10);
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
    return applyColumnFilters(all, deviceFaultColumnFilters(), (f, colId) => {
      switch (colId) {
        case 'code': return f.fault_code || '';
        case 'message': return f.fault_string || '';
        case 'parameter': return f.parameter_name || '';
        case 'time': return f.created_at || '';
        case 'status': return f.resolved ? 'Resolved' : 'Active';
        default: return '';
      }
    });
  });
  const pagedDeviceFaults = createMemo(() => {
    const all = filteredDeviceFaults();
    const start = faultPage() * faultPageSize();
    return all.slice(start, start + faultPageSize());
  });
  const deviceFaultTotalPages = createMemo(() => Math.ceil(filteredDeviceFaults().length / faultPageSize()));
  const unresolvedFaultCount = createMemo(() => (deviceFaults() || []).filter(f => !f.resolved).length);
  const pendingTaskCount = createMemo(() => (tasks() || []).filter(t => t.status !== 'completed').length);
  const [pendingFault, setPendingFault] = createSignal<number | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = createSignal<DeviceSnapshot | null>(null);
  const [snapshotSelection, setSnapshotSelection] = createSignal<string[]>([]);
  const [snapshotName, setSnapshotName] = createSignal('');
  const [snapshotLoading, setSnapshotLoading] = createSignal<string | null>(null);
  const [collapsedSnapshotPaths, setCollapsedSnapshotPaths] = createSignal<Set<string>>(new Set());

  const snapshotRows = createMemo<SnapshotTreeRow[]>(() => {
    const snapshot = selectedSnapshot();
    if (!snapshot?.parameters) return [];
    const current = new Map((parameters() || []).map(parameter => [parameter.name, parameter.value]));
    const changed = snapshot.parameters.filter(parameter => current.get(parameter.name) !== parameter.value);
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
        currentValue: node.parameter ? current.get(node.parameter.name) : undefined,
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
      const current = new Map((parameters() || []).map(parameter => [parameter.name, parameter.value]));
      setSnapshotSelection((detail.parameters || []).filter(parameter => current.get(parameter.name) !== parameter.value).map(parameter => parameter.name));
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
  const [paramFilter, setParamFilter] = createSignal('');
  const [wifiModalIndex, setWifiModalIndex] = createSignal<number | null>(null);
  const [lanModalIndex, setLanModalIndex] = createSignal<number | null>(null);
  const [showLanNetworkModal, setShowLanNetworkModal] = createSignal(false);
  const [wanModalPath, setWanModalPath] = createSignal<string | null>(null);

  const [selectedParam, setSelectedParam] = createSignal<{ name: string; value: string } | null>(null);
  const [editingModemCreds, setEditingModemCreds] = createSignal(false);
  const [showSensitive, setShowSensitive] = createSignal(false);
  const [modemCredsEdits, setModemCredsEdits] = createSignal<Record<string, string>>({});
  const [showFactoryResetModal, setShowFactoryResetModal] = createSignal(false);
  const [factoryResetPassword, setFactoryResetPassword] = createSignal('');
  const [paramColumnFilters, setParamColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [hostColumnFilters, setHostColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [hostColumns, setHostColumns] = createSignal<HostColumnConfig[]>([]);
  const [paramColumns, setParamColumns] = createSignal<ParamColumnConfig[]>([]);
  const [editingConnCreds, setEditingConnCreds] = createSignal(false);
  const [connCredMode, setConnCredMode] = createSignal('inherit');
  const [connCredUsername, setConnCredUsername] = createSignal('');
  const [connCredPassword, setConnCredPassword] = createSignal('');
  const [generatedCred, setGeneratedCred] = createSignal<{ username: string; password: string } | null>(null);
  const [iperfRunning, setIperfRunning] = createSignal(false);
  const [iperfForm, setIperfForm] = createSignal<IperfForm>({ serverAddr: '', port: '5201', testMode: 'UPLOAD', protocolType: 'TCP', maxTime: '10', parallel: '1', bandwidth: '0' });
  const [iperfResult, setIperfResult] = createSignal<Record<string, string> | null>(null);
  const [nsLookupHost, setNsLookupHost] = createSignal('');
  const [nsLookupServer, setNsLookupServer] = createSignal('');
  const [nsLookupInterface, setNsLookupInterface] = createSignal('');
  const [nsLookupRepetitions, setNsLookupRepetitions] = createSignal('5');
  const [nsLookupTimeout, setNsLookupTimeout] = createSignal('5000');
  const [nsLookupRunning, setNsLookupRunning] = createSignal(false);
  const [nsLookupResult, setNsLookupResult] = createSignal<Record<string, string> | null>(null);
  const [ipPingHost, setIpPingHost] = createSignal('');
  const [ipPingInterface, setIpPingInterface] = createSignal('');
  const [ipPingRepetitions, setIpPingRepetitions] = createSignal('4');
  const [ipPingTimeout, setIpPingTimeout] = createSignal('10000');
  const [ipPingDataBlockSize, setIpPingDataBlockSize] = createSignal('56');
  const [ipPingDscp, setIpPingDscp] = createSignal('0');
  const [ipPingRunning, setIpPingRunning] = createSignal(false);
  const [ipPingResult, setIpPingResult] = createSignal<Record<string, string> | null>(null);
  const [traceRouteHost, setTraceRouteHost] = createSignal('');
  const [traceRouteInterface, setTraceRouteInterface] = createSignal('');
  const [traceRouteMaxHops, setTraceRouteMaxHops] = createSignal('30');
  const [traceRouteTries, setTraceRouteTries] = createSignal('3');
  const [traceRouteTimeout, setTraceRouteTimeout] = createSignal('120000');
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
      testMode: iperfParameter('TestMode') === 'DOWNLOAD' ? 'DOWNLOAD' : 'UPLOAD',
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
    const rows = filteredParams().map(param => {
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


  const matchingMetrics = createMemo(() => {
    const defs = metricDefs() || [];
    const d = device();
    if (!d) return [];
    const deviceType = `${d.manufacturer || ''}/${d.product_class || ''}`;
    return defs.filter((def) => {
      if (!def.active) return false;
      if (def.device_type_match === '' || def.device_type_match === '*') return true;
      // Simple glob: support * wildcard (case-insensitive, to stay consistent
      // with the backend's case-insensitive metric matching).
      const pattern = def.device_type_match.replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`, 'i').test(deviceType);
    });
  });

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
    if (!await confirm({ title: `Reboot CPE ${serial()}?`, description: 'SKYACS will queue a reboot task for the next available CWMP session. Service may be interrupted while the CPE restarts.', confirmLabel: 'Queue reboot' })) return;
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
      const configTask = await api.setParameterValues(serial(), {
        [prefix + 'ServerAddr']: form.serverAddr.trim(),
        [prefix + 'Port']: String(port),
        [prefix + 'TestMode']: form.testMode,
        [prefix + 'ProtocolType']: form.protocolType,
        [prefix + 'MaxTime']: String(maxTime),
        [prefix + 'Parallel']: String(parallel),
        [prefix + 'Bandwidth']: String(bandwidth),
      });
      await requestIperfSession();
      await waitForTask(configTask.id, 'iPerf configuration');

      const startTask = await api.setParameterValues(serial(), { [prefix + 'DiagnosticsState']: 'Requested' });
      await requestIperfSession();
      await waitForTask(startTask.id, 'iPerf start');

      const deadline = Date.now() + Math.max(60_000, maxTime * 1000 + 45_000);
      let finalValues: Record<string, string> | null = null;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 2000));
        const readTask = await api.getParameterValues(serial(), [
          prefix + 'DiagnosticsState',
          prefix + 'TestResult',
          prefix + 'Result',
          prefix + 'ReportTime',
          prefix + 'ErrorDescription',
        ]);
        await requestIperfSession();
        const completedRead = await waitForTask(readTask.id, 'iPerf result read');
        const values = (completedRead.result || {}) as Record<string, string>;
        finalValues = values;
        const state = (values[prefix + 'DiagnosticsState'] || '').toLowerCase();
        if (state.includes('complete') || state.includes('error') || values[prefix + 'ErrorDescription']) break;
      }
      if (!finalValues) throw new Error('The CPE did not return an iPerf result.');
      setIperfResult(finalValues);
      const error = finalValues[prefix + 'ErrorDescription'];
      if (error) showMessage('error', 'iPerf test completed with a CPE error.', error);
      else showMessage('success', 'iPerf test completed.');
      await refetchParams();
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
      await refetchParams();
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
      await refetchParams();
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
      await refetchParams();
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

  const getModemCredentials = () => {
    const params = parameters() || [];
    const findParam = (patterns: string[]) => {
      for (const p of params) {
        for (const pattern of patterns) {
          if (p.name.includes(pattern)) return p.value;
        }
      }
      return '-';
    };

    return {
      adminUser: findParam([
        'X_HW_WebUserInfo.2.UserName',
        'X_CMCC_TeleComAccount.Username',
        'X_CT-COM_TeleComAccount.Username',
        'X_ZTE_COM_TeleComAccount.Username',
        'X_FH_WebUserInfo.UserName',
        'Users.User.1.Username',
      ]),
      adminPass: findParam([
        'X_HW_WebUserInfo.2.Password',
        'X_CMCC_TeleComAccount.Password',
        'X_CT-COM_TeleComAccount.Password',
        'X_ZTE_COM_TeleComAccount.Password',
        'X_FH_WebUserInfo.Password',
        'Users.User.1.Password',
      ]),
      userUser: findParam([
        'X_HW_WebUserInfo.1.UserName',
        'Users.User.2.Username',
      ]),
      userPass: findParam([
        'X_HW_WebUserInfo.1.Password',
        'Users.User.2.Password',
      ]),
    };
  };

  const handleEditModemCreds = () => {
    const creds = getModemCredentials();
    setModemCredsEdits({
      adminUser: creds.adminUser !== '-' ? creds.adminUser : '',
      adminPass: '',
      userUser: creds.userUser !== '-' ? creds.userUser : '',
      userPass: '',
    });
    setEditingModemCreds(true);
  };

  const handleCancelModemCreds = () => {
    setEditingModemCreds(false);
    setModemCredsEdits({});
  };

  const handleSaveModemCreds = async () => {
    const edits = modemCredsEdits();
    setActionLoading('modem-creds');
    try {
      const params: Record<string, string> = {};

      let adminUserPath = '', adminPassPath = '', userUserPath = '', userPassPath = '';

      const allParams = parameters() || [];
      const detectVendor = () => {
        for (const p of allParams) {
          if (p.name.includes('X_HW_WebUserInfo')) return 'huawei';
          if (p.name.includes('X_CMCC_TeleComAccount')) return 'cmcc';
          if (p.name.includes('X_CT-COM_TeleComAccount')) return 'ctcom';
          if (p.name.includes('X_ZTE_COM_TeleComAccount')) return 'zte';
          if (p.name.includes('X_FH_WebUserInfo')) return 'fiberhome';
          if (p.name.includes('Device.Users.User')) return 'tr181';
        }
        return 'huawei';
      };
      const vendor = detectVendor();
      switch (vendor) {
        case 'huawei':
          adminUserPath = 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.UserName';
          adminPassPath = 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.2.Password';
          userUserPath = 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.UserName';
          userPassPath = 'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Password';
          break;
        case 'cmcc':
          adminUserPath = 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Username';
          adminPassPath = 'InternetGatewayDevice.DeviceInfo.X_CMCC_TeleComAccount.Password';
          break;
        case 'ctcom':
          adminUserPath = 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Username';
          adminPassPath = 'InternetGatewayDevice.DeviceInfo.X_CT-COM_TeleComAccount.Password';
          break;
        case 'zte':
          adminUserPath = 'InternetGatewayDevice.DeviceInfo.X_ZTE_COM_TeleComAccount.Username';
          adminPassPath = 'InternetGatewayDevice.DeviceInfo.X_ZTE_COM_TeleComAccount.Password';
          break;
        case 'fiberhome':
          adminUserPath = 'InternetGatewayDevice.DeviceInfo.X_FH_Account.X_FH_WebUserInfo.UserName';
          adminPassPath = 'InternetGatewayDevice.DeviceInfo.X_FH_Account.X_FH_WebUserInfo.Password';
          break;
        case 'tr181':
          adminUserPath = 'Device.Users.User.1.Username';
          adminPassPath = 'Device.Users.User.1.Password';
          userUserPath = 'Device.Users.User.2.Username';
          userPassPath = 'Device.Users.User.2.Password';
          break;
      }

      if (edits.adminUser && adminUserPath) params[adminUserPath] = edits.adminUser;
      if (edits.adminPass && adminPassPath) params[adminPassPath] = edits.adminPass;
      if (edits.userUser && userUserPath) params[userUserPath] = edits.userUser;
      if (edits.userPass && userPassPath) params[userPassPath] = edits.userPass;

      if (Object.keys(params).length === 0) {
        handleCancelModemCreds();
        return;
      }

      await api.setParameterValues(serial(), params);
      showMessage('success', 'CPE web-interface credential update task created.');
      refetchTasks();
      handleCancelModemCreds();
    } catch (err) {
      showMessage('error', 'CPE credential update was not queued. The entered values are preserved; retry after checking the CPE session.', (err as Error).message);
    }
    setActionLoading(null);
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

  const refreshAll = () => { refetchDevice(); refetchParams(); refetchTasks(); refetchSnapshots(); };

  const formatDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('id-ID');
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

  const getHosts = () => {
    const params = parameters() || [];
    const hosts: Array<{ index: number; hostname: string; ip: string; ipv6: string; mac: string; negRate: string; interface: string; rssi?: string; uptime?: string }> = [];
    
    const hostIndices = [...new Set(params.filter(p => p.name.includes('Hosts.Host.')).map(p => {
      const match = p.name.match(/Host\.(\d+)\./);
      return match ? parseInt(match[1]) : 0;
    }))].filter(i => i > 0);
    
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
        const wlanMatch = layer2.match(/WLANConfiguration\.(\d+)/);
        if (wlanMatch) {
          const ssidIdx = parseInt(wlanMatch[1]);
          interfaceType = `WiFi ${getWifiBand(ssidIdx)}`;
        } else if (layer2.includes('Ethernet') || layer2.includes('LANEthernet')) {
          interfaceType = 'Ethernet';
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
              interface: `WiFi ${getWifiBand(ssidIdx)}`,
              rssi: getVal('X_HW_RSSI'),
              uptime: getVal('X_HW_Uptime'),
            });
          }
        }
      });
    }
    return hosts;
  };

  const filteredParams = () => {
    let params = parameters() || [];
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
      default: return 'bg-zinc-700 text-secondary';
    }
  };

  return (
    <div class="space-y-5">
      {/* Header - More prominent serial/status */}
      <div class="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
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
          <button onClick={refreshAll} disabled={device.loading || parameters.loading || tasks.loading || snapshots.loading} class="btn btn-secondary text-xs sm:text-sm">
            <RefreshCw size={14} />
            <span class="hidden sm:inline">Refresh</span>
          </button>
          <Show when={isFullAccess()}>
            <div class="relative" ref={actionsMenu}>
              <button type="button" class="icon-button" aria-label="Device actions" aria-haspopup="menu" aria-expanded={showActionsMenu()} onClick={() => setShowActionsMenu(value => !value)}>
                <MoreVertical size={18} />
              </button>
              <Show when={showActionsMenu()}>
                <div class="absolute right-0 top-full z-50 mt-2 min-w-44 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu">
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
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <nav role="tablist" class="tab-bar" aria-label="Device detail sections">
        <button role="tab" class={`tab-btn ${activeTab() === 'overview' ? 'is-active' : ''}`} aria-selected={activeTab() === 'overview'} onClick={() => setSearchParams({ tab: null })}>Overview</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'metrics' ? 'is-active' : ''}`} aria-selected={activeTab() === 'metrics'} onClick={() => setSearchParams({ tab: 'metrics' })}>Metrics</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'snapshots' ? 'is-active' : ''}`} aria-selected={activeTab() === 'snapshots'} onClick={() => setSearchParams({ tab: 'snapshots' })}>Snapshots</button>
        <button role="tab" class={`tab-btn ${activeTab() === 'tasks' ? 'is-active' : ''}`} aria-selected={activeTab() === 'tasks'} onClick={() => setSearchParams({ tab: 'tasks' })}>
          Tasks
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
        <button role="tab" class={`tab-btn ${activeTab() === 'hosts' ? 'is-active' : ''}`} aria-selected={activeTab() === 'hosts'} onClick={() => setSearchParams({ tab: 'hosts' })}>
          Connected Hosts
        </button>
        <button role="tab" class={`tab-btn ${activeTab() === 'diagnostic' ? 'is-active' : ''}`} aria-selected={activeTab() === 'diagnostic'} onClick={() => setSearchParams({ tab: 'diagnostic', diagnosticTab: 'diagnostic' })}>Maintenance</button>
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
      <Show when={device.loading}>
        <div class="card p-6">
          <div class="skeleton h-6 w-48 mb-4" />
          <div class="grid grid-cols-2 gap-4">
            <div class="skeleton h-4 w-32" />
            <div class="skeleton h-4 w-32" />
          </div>
        </div>
      </Show>
      <Show when={!device.loading && !device.error && device()}>
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
                <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div><span class="text-muted">Serial:</span> <span class="text-primary font-mono">{d().serial_number}</span></div>
                  <div><span class="text-muted">OUI:</span> <span class="text-primary">{d().oui}</span></div>
                  <div><span class="text-muted">Manufacturer:</span> <span class="text-primary">{d().manufacturer || '-'}</span></div>
                  <div><span class="text-muted">Product:</span> <span class="text-primary">{d().product_class || '-'}</span></div>
                  <div><span class="text-muted">Model:</span> <span class="text-primary">{d().model_name || getParamValue(['ModelName', 'X_HW_ModelName', 'DeviceInfo.ModelName']) || '-'}</span></div>
                  <div><span class="text-muted">HW Version:</span> <span class="text-primary">{d().hardware_version || '-'}</span></div>
                  <div><span class="text-muted">SW Version:</span> <span class="text-primary">{d().software_version || '-'}</span></div>
                  <div><span class="text-muted">IP Address:</span> <span class="text-primary font-mono">{d().ip_address || getParamValue(['ExternalIPAddress', 'IPAddress']) || '-'}</span></div>
                  <div><span class="text-muted">Last inform:</span> <span class="text-primary">{formatDate(d().last_inform)}</span></div>
                  <div><span class="text-muted">Overview refreshed:</span> <span class="text-primary">{formatDate(d().last_overview_refresh)}</span></div>
                  <div><span class="text-muted">Full tree refreshed:</span> <span class="text-primary">{formatDate(d().last_full_refresh)}</span></div>
                </div>

              </div>

              {/* Device Health - Compact Horizontal */}
              <div class="card p-4 lg:col-span-7">
                <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
                  <HeartPulse size={14} />
                  Device Health
                </h2>
                <div class="grid grid-cols-6 gap-3 text-center">
                  <For each={healthTileGroups()}>
                    {(group) => (
                      <div class={group.size === 'large' ? 'col-span-6' : group.size === 'medium' ? 'col-span-6 sm:col-span-3' : 'col-span-6 sm:col-span-2'}>
                        <Show when={group.label}>
                          <div class="text-[10px] font-medium text-muted uppercase tracking-wide mb-1">{group.label}</div>
                        </Show>
                        <div class={group.tiles.length > 1 ? 'grid grid-cols-1 sm:grid-cols-2 gap-2' : ''}>
                          <For each={group.tiles}>
                            {(tile) => (
                              <div>
                                <Show when={tile.format === 'gauge'}>
                                  <HealthGauge
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
                                  />
                                </Show>
                                <Show when={tile.format !== 'gauge'}>
                                  <div
                                    class={`text-lg font-bold font-mono ${tile.color.startsWith('#') ? '' : tile.color}`}
                                    style={tile.color.startsWith('#') ? { color: tile.color } : {}}
                                  >
                                    {tile.value}
                                  </div>
                                  <div class="text-[10px] text-muted mt-0.5">{tile.label}</div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>

            </Show>

            <Show when={activeTab() === 'diagnostic'}>
              <div class="space-y-4">
                <nav role="tablist" class="tab-bar" aria-label="Diagnostic sections">
                  <button role="tab" class="tab-btn is-active" aria-selected="true" onClick={() => setSearchParams({ diagnosticTab: 'diagnostic' })}>Diagnostic</button>
                </nav>
                <Show when={searchParams.diagnosticTab === undefined || searchParams.diagnosticTab === 'speedtest' || searchParams.diagnosticTab === 'diagnostic'}>
                  <div class="space-y-4">
                  <details class="card group" open>
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><h2 class="text-sm font-medium text-secondary">Speedtest</h2><p class="text-xs text-muted mt-1">Run an iPerf speed test from this CPE.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                    <Show when={iperfSupported()} fallback={<p class="text-xs text-muted">iPerf testing is not available for this device.</p>}>
                      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <label class="text-xs text-muted md:col-span-2">iPerf server address<input class="input w-full mt-1 font-mono" value={iperfForm().serverAddr} onInput={event => setIperfForm(form => ({ ...form, serverAddr: event.currentTarget.value }))} placeholder="192.0.2.10 or iperf.example.net" disabled={iperfRunning()} /></label>
                        <label class="text-xs text-muted">Port<input class="input w-full mt-1" type="number" min="1" max="65535" value={iperfForm().port} onInput={event => setIperfForm(form => ({ ...form, port: event.currentTarget.value }))} disabled={iperfRunning()} /></label>
                        <label class="text-xs text-muted">Test mode<select class="input w-full mt-1" value={iperfForm().testMode} onChange={event => setIperfForm(form => ({ ...form, testMode: event.currentTarget.value as IperfForm['testMode'] }))} disabled={iperfRunning()}><option value="UPLOAD">Upload — CPE to server</option><option value="DOWNLOAD">Download — server to CPE</option></select></label>
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
                        <h3 class="text-xs font-medium text-secondary mb-2">Latest iPerf result</h3>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2"><For each={Object.entries(iperfResult()!)}>{([key, value]) => <div class="rounded bg-base px-3 py-2"><div class="text-[10px] text-muted">{key.split('.').pop()}</div><div class="text-sm text-primary font-mono break-all">{value || '-'}</div></div>}</For></div>
                      </div>
                    </Show>
                    </div>
                  </details>
                  <details class="card group" open>
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><h2 class="text-sm font-medium text-secondary">NS lookup</h2><p class="text-xs text-muted mt-1">Resolve a hostname from the CPE using its DNS diagnostics.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                    <Show when={nsLookupRoot()} fallback={<p class="text-xs text-muted">NS lookup is not available for this device.</p>}>
                      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <label class="text-xs text-muted">Host name<input class="input w-full mt-1" value={nsLookupHost()} onInput={event => setNsLookupHost(event.currentTarget.value)} placeholder="example.com" disabled={nsLookupRunning()} /></label>
                        <label class="text-xs text-muted">DNS server (optional)<input class="input w-full mt-1 font-mono" value={nsLookupServer()} onInput={event => setNsLookupServer(event.currentTarget.value)} placeholder="Use device default" disabled={nsLookupRunning()} /></label>
                        <label class="text-xs text-muted">Interface (optional)<input class="input w-full mt-1" value={nsLookupInterface()} onInput={event => setNsLookupInterface(event.currentTarget.value)} placeholder="Default interface" disabled={nsLookupRunning()} /></label>
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
                  <details class="card group" open>
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><h2 class="text-sm font-medium text-secondary">IP ping</h2><p class="text-xs text-muted mt-1">Send ICMP echo requests from the CPE and review packet loss and response times.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                    <Show when={ipPingRoot()} fallback={<p class="text-xs text-muted">IP ping is not available for this device.</p>}>
                      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <label class="text-xs text-muted md:col-span-2">Host or IP address<input class="input w-full mt-1 font-mono" value={ipPingHost()} onInput={event => setIpPingHost(event.currentTarget.value)} placeholder="192.0.2.1 or example.com" disabled={ipPingRunning()} /></label>
                        <label class="text-xs text-muted">Interface (optional)<input class="input w-full mt-1" value={ipPingInterface()} onInput={event => setIpPingInterface(event.currentTarget.value)} placeholder="Default interface" disabled={ipPingRunning()} /></label>
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
                          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">{rows.map(([name, value]) => <div class="rounded bg-base px-3 py-2"><div class="text-[10px] text-muted">{name === 'SuccessCount' ? 'Successful packets' : name === 'FailureCount' ? 'Failed packets' : name === 'MinimumResponseTime' ? 'Min. response (ms)' : name === 'AverageResponseTime' ? 'Avg. response (ms)' : name === 'MaximumResponseTime' ? 'Max. response (ms)' : 'State'}</div><div class="text-sm text-primary font-mono break-all">{value}</div></div>)}</div>
                          <Show when={rows.length === 0}><p class="text-xs text-muted">No result values were returned.</p></Show>
                        </div>;
                      }}
                    </Show>
                    </div>
                  </details>
                  <details class="card group" open>
                    <summary class="cursor-pointer list-none p-5 flex items-center justify-between gap-3">
                      <div><h2 class="text-sm font-medium text-secondary">Traceroute</h2><p class="text-xs text-muted mt-1">Show the network hops from the CPE to a destination.</p></div>
                      <ChevronDown size={16} class="shrink-0 transition-transform group-open:rotate-180" />
                    </summary>
                    <div class="px-5 pb-5 space-y-4">
                      <Show when={traceRouteRoot()} fallback={<p class="text-xs text-muted">Traceroute is not available for this device.</p>}>
                        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                          <label class="text-xs text-muted md:col-span-2">Destination host or IP<input class="input w-full mt-1 font-mono" value={traceRouteHost()} onInput={event => setTraceRouteHost(event.currentTarget.value)} placeholder="192.0.2.1 or example.com" disabled={traceRouteRunning()} /></label>
                          <label class="text-xs text-muted">Interface (optional)<input class="input w-full mt-1" value={traceRouteInterface()} onInput={event => setTraceRouteInterface(event.currentTarget.value)} placeholder="Default interface" disabled={traceRouteRunning()} /></label>
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
                          const rows = Object.entries(result()).filter(([name, value]) => name.startsWith(root) && value !== '' && (name.endsWith('DiagnosticsState') || name.endsWith('ResponseTime') || name.endsWith('RouteHopsNumberOfEntries') || name.includes('.RouteHops.')));
                          return <div class="border-t border-subtle pt-3">
                            <h3 class="text-xs font-medium text-secondary mb-2">Route results</h3>
                            <div class="space-y-1">{rows.map(([name, value]) => <div class="grid grid-cols-[minmax(130px,0.5fr)_minmax(0,1fr)] gap-3 rounded bg-base px-3 py-2 text-xs"><span class="text-muted font-mono break-all">{name.slice(root.length)}</span><span class="text-primary font-mono break-all">{value}</span></div>)}</div>
                            <Show when={rows.length === 0}><p class="text-xs text-muted">No route hops were returned.</p></Show>
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
                      <p class="text-xs text-muted mt-1">Stored from the parameters currently cached by SKYACS.</p>
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
                  <Show when={(snapshots() || []).length > 0} fallback={<EmptyState title="No snapshots" description="Create a snapshot to preserve the current cached CPE configuration." />}>
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
                        <Show when={snapshotRows().length > 0} fallback={<EmptyState title="No differences" description="The selected snapshot matches the cached current parameters." />}>
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
                                      <div style={{ 'padding-left': `${row.depth * 16}px` }} class="flex items-center gap-2 min-w-0">
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
              <Show when={matchingMetrics().length > 0} fallback={<EmptyState title="No metrics available" description="No active metric definitions match this device type. Configure metric definitions in the admin panel to enable monitoring." />}>
              <div class="card p-5">
                <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
                  <Activity size={14} />
                  Metrics
                </h2>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <For each={groupedMetrics()}>
                    {(group) => (
                      <MetricChart serial={serial()} metrics={group} />
                    )}
                  </For>
                </div>
              </div>
              </Show>
            </Show>

            <Show when={activeTab() === 'credentials'}>
            {/* Row 1.5: Modem Credentials */}
            <div class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                  <Key size={14} />
                  Modem Credentials
                </h2>
                <div class="flex items-center gap-1"><Show when={!editingModemCreds() && isFullAccess()}>
                  <button
                    onClick={handleEditModemCreds}
                    disabled={actionLoading() !== null}
                    class="icon-button"
                    aria-label="Edit CPE web-interface credentials"
                  >
                    <Edit size={14} />
                  </button>
                </Show><button onClick={() => setShowSensitive(!showSensitive())} class="icon-button" aria-label={showSensitive() ? 'Hide sensitive values' : 'Reveal sensitive values'} aria-pressed={showSensitive()}>{showSensitive() ? <EyeOff size={13} /> : <Eye size={13} />}</button></div>
              </div>
              <Show when={editingModemCreds()} fallback={
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div class="text-muted text-xs mb-1">Admin Username</div>
                    <div class="text-primary font-mono">{getModemCredentials().adminUser}</div>
                  </div>
                  <div>
                    <div class="text-muted text-xs mb-1">Admin Password</div>
                    <div class="text-primary font-mono">{showSensitive() ? getModemCredentials().adminPass : '••••••••'}</div>
                  </div>
                  <div>
                    <div class="text-muted text-xs mb-1">User Username</div>
                    <div class="text-primary font-mono">{getModemCredentials().userUser}</div>
                  </div>
                  <div>
                    <div class="text-muted text-xs mb-1">User Password</div>
                    <div class="text-primary font-mono">{showSensitive() ? getModemCredentials().userPass : '••••••••'}</div>
                  </div>
                </div>
              }>
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                  <div>
                    <label for="cpe-admin-username" class="text-muted text-xs mb-1 block">Administrator username</label>
                    <input
                      id="cpe-admin-username"
                      type="text"
                      value={modemCredsEdits().adminUser || ''}
                      onInput={(e) => setModemCredsEdits({ ...modemCredsEdits(), adminUser: e.currentTarget.value })}
                      class="input w-full py-1.5 text-sm font-mono"
                      placeholder="admin"
                    />
                  </div>
                  <div>
                    <label for="cpe-admin-password" class="text-muted text-xs mb-1 block">Administrator password</label>
                    <input
                      id="cpe-admin-password"
                      type="password"
                      value={modemCredsEdits().adminPass || ''}
                      onInput={(e) => setModemCredsEdits({ ...modemCredsEdits(), adminPass: e.currentTarget.value })}
                      class="input w-full py-1.5 text-sm font-mono"
                      placeholder="New password"
                    />
                  </div>
                  <div>
                    <label for="cpe-user-username" class="text-muted text-xs mb-1 block">User username</label>
                    <input
                      id="cpe-user-username"
                      type="text"
                      value={modemCredsEdits().userUser || ''}
                      onInput={(e) => setModemCredsEdits({ ...modemCredsEdits(), userUser: e.currentTarget.value })}
                      class="input w-full py-1.5 text-sm font-mono"
                      placeholder="user"
                    />
                  </div>
                  <div>
                    <label for="cpe-user-password" class="text-muted text-xs mb-1 block">User password</label>
                    <input
                      id="cpe-user-password"
                      type="password"
                      value={modemCredsEdits().userPass || ''}
                      onInput={(e) => setModemCredsEdits({ ...modemCredsEdits(), userPass: e.currentTarget.value })}
                      class="input w-full py-1.5 text-sm font-mono"
                      placeholder="New password"
                    />
                  </div>
                </div>
                <div class="flex gap-2 mt-4 justify-end">
                  <button
                    onClick={handleCancelModemCreds}
                    disabled={actionLoading() !== null}
                    class="btn btn-secondary text-sm py-1.5"
                  >
                    <X size={14} />
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveModemCreds}
                    disabled={actionLoading() === 'modem-creds'}
                    class="btn btn-primary text-sm py-1.5"
                  >
                    <Save size={14} />
                    {actionLoading() === 'modem-creds' ? 'Queuing update…' : 'Queue credential update'}
                  </button>
                </div>
              </Show>
            </div>

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
                    <label class="block text-xs text-muted mb-1.5">Credential mode</label>
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
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Enable</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Uptime</th>
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
                        <th class="text-left px-3 py-2.5 font-semibold text-primary"></th>
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
                            <td class="px-3 py-2.5 text-secondary">{formatUptime(wan.uptime)}</td>
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
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">Enable</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">MAC Address</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Duplex</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary">Speed</th>
                        <th class="text-center px-2 py-2.5 font-semibold text-primary">L3</th>
                        <th class="text-left px-3 py-2.5 font-semibold text-primary"></th>
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
              <h2 class="text-xs font-medium text-muted mb-4 flex items-center gap-2">
                <Radio size={14} />
                Wi-Fi configuration
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
                        <th class="text-left px-2 py-2 font-medium text-secondary">On</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Status</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">SSID Name</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Security</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Band</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Ch</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Max Rate</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary">Password</th>
                        <th class="text-left px-2 py-2 font-medium text-secondary"></th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={getWlanConfigs()}>
                        {(wlan, i) => (
                          <tr class={`border-t border-subtle/30 hover:bg-elevated/50 transition-colors ${i() % 2 === 1 ? 'bg-elevated/20' : ''}`}>
                            <td class="px-3 py-2 text-secondary">SSID{wlan.index}</td>
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
                              <span class={`badge ${statusBadgeClass(wlan.status)}`}>{wlan.status}</span>
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
            <div class="card overflow-hidden">
              <div class="p-5 border-b border-subtle flex items-center justify-between">
                <h2 class="text-sm font-medium text-secondary">Task History ({tasks()?.length || 0})</h2>
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
                  <table class="data-table w-full text-sm min-w-[900px]">
                    <thead class="bg-base sticky top-0 z-10">
                      <tr class="bg-base">
                        <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Type
                            <ColumnFilter columnId="type" label="Type" active={taskColumnFilters()['type'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['type'] = s; else delete n['type']; return n; }); }} />
                          </div>
                        </th>
                        <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Status
                            <ColumnFilter columnId="status" label="Status" active={taskColumnFilters()['status'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['status'] = s; else delete n['status']; return n; }); }} />
                          </div>
                        </th>
                        <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Created
                            <ColumnFilter columnId="created_at" label="Created" active={taskColumnFilters()['created_at'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['created_at'] = s; else delete n['created_at']; return n; }); }} />
                          </div>
                        </th>
                        <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Completed
                            <ColumnFilter columnId="completed_at" label="Completed" active={taskColumnFilters()['completed_at'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['completed_at'] = s; else delete n['completed_at']; return n; }); }} />
                          </div>
                        </th>
                        <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">User
                            <ColumnFilter columnId="created_by" label="User" active={taskColumnFilters()['created_by'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['created_by'] = s; else delete n['created_by']; return n; }); }} />
                          </div>
                        </th>
                        <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                          <div class="flex items-center gap-1.5">Error
                            <ColumnFilter columnId="error" label="Error" active={taskColumnFilters()['error'] || null} onApply={(s) => { setTaskColumnFilters((prev) => { const n = { ...prev }; if (s) n['error'] = s; else delete n['error']; return n; }); }} />
                          </div>
                        </th>
                        <th class="text-right px-4 py-2 text-xs font-medium text-muted">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={pagedTasks()}>
                        {(task) => (
                          <tr class="border-t border-subtle/50 hover:bg-elevated/30">
                            <td class="px-4 py-2 text-primary">{task.type}</td>
                            <td class="px-4 py-2"><span class={`badge ${getStatusBadge(task.status)}`}>{task.status}</span></td>
                            <td class="px-4 py-2 text-muted text-xs">{formatDate(task.created_at)}</td>
                            <td class="px-4 py-2 text-muted text-xs">{formatDate(task.completed_at)}</td>
                            <td class="px-4 py-2 text-muted text-xs">{task.created_by || '-'}</td>
                            <td class="px-4 py-2 text-rose-400 text-xs">{task.error_message || '-'}</td>
                            <td class="px-4 py-2 text-right">
                              <button
                                class="btn btn-ghost btn-xs"
                                onClick={() => { setSelectedTask(task); setTaskDetailTab('requested'); }}
                              >
                                <Eye size={13} />
                                Details
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <div class="px-4 py-3">
                  <Pagination page={taskPage()} totalPages={taskTotalPages()} totalItems={filteredTasks().length} pageSize={taskPageSize()} onPageChange={setTaskPage} storageKey="device_tasks" onPageSizeChange={handleTaskPageSizeChange} />
                </div>
              </Show>
              </Show>
            </div>
            </Show>

            {/* Task Detail Dialog */}
            <Show when={selectedTask()}>
              <Dialog title={`Task #${selectedTask()!.id} — ${selectedTask()!.type}`} size="large" onClose={() => setSelectedTask(null)}>
                <div class="space-y-4">
                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div><span class="text-muted text-xs">Status</span><div class="mt-0.5"><span class={`badge ${getStatusBadge(selectedTask()!.status)}`}>{selectedTask()!.status}</span></div></div>
                    <div><span class="text-muted text-xs">User</span><div class="mt-0.5 text-primary">{selectedTask()!.created_by || '-'}</div></div>
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
                          <Show when={isFullAccess()}>
                            <th class="px-3 py-2 w-8">
                              <input type="checkbox" class="accent-emerald-500 w-3.5 h-3.5 cursor-pointer" checked={allDeviceFaultsSelected()} onChange={toggleSelectAllDeviceFaults} aria-label="Select all faults on this page" />
                            </th>
                          </Show>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5">Code
                              <ColumnFilter columnId="code" label="Code" active={deviceFaultColumnFilters()['code'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['code'] = s; else delete n['code']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5">Message
                              <ColumnFilter columnId="message" label="Message" active={deviceFaultColumnFilters()['message'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['message'] = s; else delete n['message']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5">Parameter
                              <ColumnFilter columnId="parameter" label="Parameter" active={deviceFaultColumnFilters()['parameter'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['parameter'] = s; else delete n['parameter']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5">Time
                              <ColumnFilter columnId="time" label="Time" active={deviceFaultColumnFilters()['time'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['time'] = s; else delete n['time']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-left px-4 py-2 text-xs font-medium text-muted">
                            <div class="flex items-center gap-1.5">Status
                              <ColumnFilter columnId="status" label="Status" active={deviceFaultColumnFilters()['status'] || null} onApply={(s) => { setDeviceFaultColumnFilters((prev) => { const n = { ...prev }; if (s) n['status'] = s; else delete n['status']; return n; }); }} />
                            </div>
                          </th>
                          <th class="text-right px-4 py-2 text-xs font-medium text-muted">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={pagedDeviceFaults()}>
                          {(fault) => (
                            <tr class="border-t border-subtle/50 hover:bg-elevated/30">
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
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                  <div class="px-4 py-3">
                    <Pagination page={faultPage()} totalPages={deviceFaultTotalPages()} totalItems={filteredDeviceFaults().length} pageSize={faultPageSize()} onPageChange={setFaultPage} storageKey="device_faults" onPageSizeChange={handleFaultPageSizeChange} />
                  </div>
                </Show>
              }>
                <div class="p-5 space-y-2" aria-label="Loading CWMP faults"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-full" /></div>
              </Show>
            </div>
            </Show>

            <Show when={activeTab() === 'overview'}>
            {/* Row 6: All Parameters */}
            <div class="card overflow-hidden">
              <div class="p-5 border-b border-subtle flex items-center justify-between gap-4">
                <h2 class="text-sm font-medium text-secondary whitespace-nowrap">All Parameters ({filteredParams().length})</h2>
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
                    class="btn btn-secondary text-xs"
                    onClick={exportParamsCSV}
                    disabled={filteredParams().length === 0}
                  >
                    <Download size={14} />
                    Export CSV
                  </button>
                </div>
              </div>
              <Show when={filteredParams().length > 0} fallback={
                <div class="p-8 text-center">
                  <p class="text-muted text-sm">No parameters loaded yet. Click Summon to fetch.</p>
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
                      <For each={filteredParams()}>
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

		  {/* Factory reset step-up confirmation */}
		  <Show when={showFactoryResetModal()}>
			<Dialog title={`Factory reset ${serial()}?`} description="All CPE configuration will be erased and service may not recover automatically. This operation cannot be undone." size="small" closeOnBackdrop={false} onClose={closeFactoryResetModal} actions={<><button onClick={closeFactoryResetModal} class="btn btn-secondary">Cancel</button><button onClick={handleFactoryReset} disabled={!factoryResetPassword() || actionLoading() !== null} class="btn btn-danger">Confirm factory reset</button></>}>
				<label for="factory-reset-password" class="block text-xs text-muted mb-1.5">Current SKYACS account password</label>
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
                <div class="space-y-1">
                  <For each={Object.entries(iperfResult()!) }>
                    {([key, value]) => <div class="flex gap-3 text-xs"><span class="text-muted font-mono break-all">{key.split('.').pop()}</span><span class="text-primary font-mono break-all">{value || '-'}</span></div>}
                  </For>
                </div>
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
          onSaved={() => { refetchParams(); refetchTasks(); }}
        />
      </Show>

      <Show when={lanModalIndex() !== null && parameters()}>
        <LanSettingsModal
          lanIndex={lanModalIndex()!}
          parameters={parameters()!}
          serial={serial()}
          isFullAccess={isFullAccess()}
          onClose={() => setLanModalIndex(null)}
          onSaved={() => { refetchParams(); refetchTasks(); }}
        />
      </Show>

      <Show when={showLanNetworkModal() && parameters()}>
        <LanNetworkSettingsModal
          parameters={parameters()!}
          serial={serial()}
          onClose={() => setShowLanNetworkModal(false)}
          onSaved={() => { refetchParams(); refetchTasks(); }}
        />
      </Show>

      <Show when={wanModalPath() !== null && parameters()}>
        <WanSettingsModal
          wanPath={wanModalPath()!}
          parameters={parameters()!}
          serial={serial()}
          isFullAccess={isFullAccess()}
          onClose={() => setWanModalPath(null)}
          onSaved={() => { refetchParams(); refetchTasks(); }}
        />
      </Show>

    </div>
  );
};

export default DeviceDetail;
