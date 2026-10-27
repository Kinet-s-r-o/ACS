import type { Component } from 'solid-js';
import { createResource, createSignal, Show, For, createMemo, createEffect, onMount } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { Router as RouterIcon, X, Search, Send, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-solid';
import { api, type Device } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import DeviceTagPicker from '../components/DeviceTagPicker';
import { createPersistedJsonSignal, createPersistedSignal, readMigratedStorageValue, writeMigratedStorageValue } from '../lib/storage';
import { formatDateTime, formatRelativeTime } from '../lib/dateTime';
import { formatUptime } from '../lib/health';
import WANInterfaces from './WANInterfaces';

interface ColumnConfig {
  id: string;
  label: string;
  visible: boolean;
  order: number;
}

const defaultColumns: ColumnConfig[] = [
  { id: 'serial_number', label: 'Serial Number', visible: true, order: 0 },
  { id: 'manufacturer', label: 'Manufacturer', visible: true, order: 1 },
  { id: 'model', label: 'Model', visible: true, order: 2 },
  { id: 'product_class', label: 'Product Class', visible: false, order: 3 },
  { id: 'ip_address', label: 'IP Address', visible: true, order: 4 },
  { id: 'ppp_username', label: 'PPP Username', visible: false, order: 5 },
  { id: 'rx_power', label: 'RX Power', visible: true, order: 6 },
  { id: 'uptime', label: 'Uptime', visible: true, order: 7 },
  { id: 'status', label: 'Status', visible: true, order: 8 },
  { id: 'last_inform', label: 'Last Inform', visible: true, order: 9 },
  { id: 'tags', label: 'Tags', visible: true, order: 10 },
];

const STORAGE_KEY = 'acs_device_columns';
const LEGACY_STORAGE_KEY = 'skyacs_device_columns';
const previousDefaultColumnOrder = ['serial_number', 'manufacturer', 'model', 'product_class', 'ip_address', 'rx_power', 'uptime', 'ppp_username', 'status', 'last_inform', 'tags'];

const TableSkeleton: Component<{ cols: number }> = (props) => (
  <tr>
    <For each={Array(props.cols).fill(0)}>
      {() => <td class="px-4 py-3"><div class="skeleton h-4 w-24" /></td>}
    </For>
  </tr>
);

const TagChips: Component<{ tags: string[] }> = (props) => {
  if (props.tags.length === 0) return <span class="text-muted">—</span>;
  return (
    <div class="flex flex-wrap gap-1">
      <For each={props.tags}>
        {(tag) => (
          <span class="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 whitespace-nowrap">{tag}</span>
        )}
      </For>
    </div>
  );
};

const Devices: Component = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = () => searchParams.tab === 'wans' ? 'wans' : 'cpes';
  const [page, setPage] = createSignal(0);
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.devices');
  const [columns, setColumns] = createSignal<ColumnConfig[]>([]);
  const [summoningAll, setSummoningAll] = createSignal(false);
  const [sortBy, setSortBy] = createSignal<{ column: string; direction: 'asc' | 'desc' } | null>(null);
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.devices', {});
  const { isFullAccess, hasPermission } = useAuth();
  const { notify } = useFeedback();
  const { pageSize, changePageSize } = usePageSize('devices', 20);
  const handlePageSizeChange = (size: number) => { changePageSize(size); setPage(0); };

  onMount(() => {
    const saved = readMigratedStorageValue(localStorage, STORAGE_KEY, LEGACY_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const savedOrder = [...parsed].sort((a: ColumnConfig, b: ColumnConfig) => a.order - b.order).map((column: ColumnConfig) => column.id);
        const usesPreviousDefaultOrder = previousDefaultColumnOrder.every((id, index) => savedOrder[index] === id);
        const merged = defaultColumns.map(dc => {
          const saved = parsed.find((p: ColumnConfig) => p.id === dc.id);
          return saved ? { ...dc, visible: saved.visible, order: usesPreviousDefaultOrder ? dc.order : saved.order } : dc;
        });
        setColumns(merged.sort((a, b) => a.order - b.order));
      } catch {
        setColumns([...defaultColumns]);
      }
    } else {
      setColumns([...defaultColumns]);
    }
  });

  createEffect(() => {
    const cols = columns();
    if (cols.length > 0) {
      writeMigratedStorageValue(localStorage, STORAGE_KEY, LEGACY_STORAGE_KEY, JSON.stringify(cols));
    }
  });

  const [deviceList, { refetch }] = createResource(
    () => [page(), pageSize()],
    ([p, l]) => api.getDevices(l, p * l)
  );
  const [tagCatalog] = createResource(api.getTags);

  const getDeviceTagLabels = (device: Device) => (device.tags || []).map(id => tagCatalog()?.find(tag => tag.id === id)?.name || id).join(', ');

  const totalPages = () => Math.ceil((deviceList()?.total ?? 0) / pageSize());

  const visibleColumns = createMemo(() => 
    columns().filter(c => c.visible).sort((a, b) => a.order - b.order)
  );

  const formatDate = (dateStr: string | null) => {
    return formatRelativeTime(dateStr);
  };

  const toggleColumn = (id: string) => {
    setColumns(cols => cols.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
  };

  const getRxPower = (device: Device) => {
    const params = device.parameters || [];
    const rxParam = params.find((p: any) => 
      p.name.includes('RXPower') || 
      p.name.includes('OpticalReceivedPower') || 
      p.name.includes('TransceiverRxPower') ||
      p.name.includes('ReceivedPower') ||
      p.name.includes('X_HW_OpticalRxPower')
    );
    if (!rxParam) return { value: '-', color: 'text-muted' };
    const num = parseFloat(rxParam.value);
    if (isNaN(num)) return { value: rxParam.value, color: 'text-muted' };
    
    let val: number;
    if (num <= 0) {
      val = num;
    } else if (num > 0 && num < 10000) {
      val = 10 * Math.log10(num / 10000);
    } else if (Math.abs(num) > 100) {
      val = num / 100;
    } else {
      val = num;
    }
    
    const color = val > -20 ? 'text-emerald-400' : val > -25 ? 'text-amber-400' : 'text-rose-400';
    return { value: val.toFixed(2), color };
  };

  const getPppUsername = (device: Device) => {
    const param = device.parameters?.find((p: any) => 
      p.name.includes('WANPPPConnection') && p.name.includes('Username')
    );
    return param?.value || '-';
  };

  const getUptimeSeconds = (device: Device): number | null => {
    const value = device.parameters?.find((parameter) => parameter.name === 'InternetGatewayDevice.DeviceInfo.UpTime')?.value;
    if (value === undefined || value === '') return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  };

  const getUptime = (device: Device) => {
    const seconds = getUptimeSeconds(device);
    return seconds === null ? '-' : formatUptime(seconds);
  };

  const getCellValue = (device: Device, columnId: string) => {
    switch (columnId) {
      case 'serial_number':
        return (
          <A class="data-link font-mono text-sm" href={`/device/${encodeURIComponent(device.serial_number)}`} aria-label={`Open CPE ${device.serial_number}`}>
            {device.serial_number}
          </A>
        );
      case 'manufacturer':
        return <span class="text-secondary text-sm">{device.manufacturer || '-'}</span>;
      case 'model':
        return <span class="text-secondary text-sm">{device.model_name || device.product_class || '-'}</span>;
      case 'product_class':
        return <span class="text-secondary text-sm">{device.product_class || '-'}</span>;
      case 'ip_address':
        return <span class="text-muted font-mono text-sm">{device.ip_address || '-'}</span>;
      case 'rx_power':
        const rx = getRxPower(device);
        return <span class={`font-mono text-sm ${rx.color}`}>{rx.value}</span>;
      case 'uptime':
        return <span class="font-mono text-sm text-secondary">{getUptime(device)}</span>;
      case 'ppp_username':
        return <span class="text-secondary text-sm font-mono">{getPppUsername(device)}</span>;
      case 'status':
        return (
          <span class={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium ${
            device.online 
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' 
              : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
          }`}>
            <span class={`w-1.5 h-1.5 rounded-full ${device.online ? 'bg-emerald-400' : 'bg-rose-400'}`} aria-hidden="true" />
            {device.online ? 'Online' : 'Offline'}
          </span>
        );
      case 'last_inform':
        return <span class="text-muted text-xs" title={formatDateTime(device.last_inform)}>{formatDate(device.last_inform)}</span>;
      case 'tags':
        return <Show when={tagCatalog()} fallback={<TagChips tags={device.tags || []} />}><DeviceTagPicker device={device} tags={tagCatalog() || []} writable={hasPermission('devices.write')} onUpdated={() => { void refetch(); }} /></Show>;
      default:
        return '-';
    }
  };

  const getFilterValue = (device: Device, colId: string): string => {
    switch (colId) {
      case 'serial_number': return device.serial_number || '';
      case 'manufacturer': return device.manufacturer || '';
      case 'model': return device.model_name || device.product_class || '';
      case 'product_class': return device.product_class || '';
      case 'ip_address': return device.ip_address || '';
      case 'rx_power': {
        const rx = getRxPower(device);
        return rx.value === '-' ? '' : rx.value;
      }
      case 'uptime': {
        const uptime = getUptimeSeconds(device);
        return uptime === null ? '' : String(uptime);
      }
      case 'ppp_username': return getPppUsername(device) === '-' ? '' : getPppUsername(device);
      case 'status': return device.online ? 'Online' : 'Offline';
      case 'last_inform': return device.last_inform || '';
      case 'tags': return getDeviceTagLabels(device);
      default: return '';
    }
  };

  const filteredDevices = createMemo(() => {
    let devices = deviceList()?.devices || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      devices = devices.filter(d => {
        return (
          d.serial_number?.toLowerCase().includes(query) ||
          d.manufacturer?.toLowerCase().includes(query) ||
          d.model_name?.toLowerCase().includes(query) ||
          d.product_class?.toLowerCase().includes(query) ||
          d.ip_address?.toLowerCase().includes(query)
        );
      });
    }
    return applyColumnFilters(devices, columnFilters(), getFilterValue);
  });

  const activeFilterCount = createMemo(() => Object.keys(columnFilters()).length);
  const hasInventoryFilter = createMemo(() => Boolean(searchQuery().trim()) || activeFilterCount() > 0);

  const sortedDevices = createMemo(() => {
    const devices = [...filteredDevices()];
    const sort = sortBy();
    if (!sort) return devices;
    
    return devices.sort((a, b) => {
      let aVal: any, bVal: any;
      
      switch (sort.column) {
        case 'serial_number':
          aVal = a.serial_number || '';
          bVal = b.serial_number || '';
          break;
        case 'manufacturer':
          aVal = a.manufacturer || '';
          bVal = b.manufacturer || '';
          break;
        case 'model':
          aVal = a.model_name || a.product_class || '';
          bVal = b.model_name || b.product_class || '';
          break;
        case 'ip_address':
          aVal = a.ip_address || '';
          bVal = b.ip_address || '';
          break;
        case 'uptime':
          aVal = getUptimeSeconds(a) ?? -1;
          bVal = getUptimeSeconds(b) ?? -1;
          break;
        case 'status':
          aVal = a.online ? 1 : 0;
          bVal = b.online ? 1 : 0;
          break;
        case 'last_inform':
          aVal = a.last_inform ? new Date(a.last_inform).getTime() : 0;
          bVal = b.last_inform ? new Date(b.last_inform).getTime() : 0;
          break;
        case 'tags':
          aVal = getDeviceTagLabels(a);
          bVal = getDeviceTagLabels(b);
          break;
        default:
          return 0;
      }
      
      if (typeof aVal === 'string') {
        const comparison = aVal.localeCompare(bVal);
        return sort.direction === 'asc' ? comparison : -comparison;
      }
      
      return sort.direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
  });

  const handleSort = (columnId: string) => {
    const current = sortBy();
    if (current?.column === columnId) {
      if (current.direction === 'asc') {
        setSortBy({ column: columnId, direction: 'desc' });
      } else {
        setSortBy(null);
      }
    } else {
      setSortBy({ column: columnId, direction: 'asc' });
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="CPE inventory" description="Search, inspect, and operate registered TR-069 endpoints.">
        <div class="flex gap-2">
          <Show when={isFullAccess()}><button
            onClick={async () => {
              const list = sortedDevices();
              if (list.length === 0 || summoningAll()) return;
              setSummoningAll(true);
              try {
                const results = await Promise.all(list.map(async (device) => {
                  let taskQueued = false;
                  try {
                    let parameters = device.parameters || [];
                    try {
                      parameters = await api.getDeviceParameters(device.serial_number);
                    } catch {
                      // Use the inventory snapshot when the stored parameter tree cannot be read.
                    }
                    const hasTR181 = parameters.some(parameter => parameter.name.startsWith('Device.'));
                    await api.getParameterValues(device.serial_number, [hasTR181 ? 'Device.' : 'InternetGatewayDevice.']);
                    taskQueued = true;
                    const connectionRequest = await api.connectionRequest(device.serial_number);
                    return { taskQueued, requestAccepted: connectionRequest.status === 'success' };
                  } catch {
                    return { taskQueued, requestAccepted: false };
                  }
                }));
                const queuedCount = results.filter(result => result.taskQueued).length;
                const acceptedCount = results.filter(result => result.requestAccepted).length;
                const failureCount = list.length - queuedCount;
                notify({
                  tone: failureCount > 0 ? 'error' : 'success',
                  title: failureCount > 0 ? 'CWMP tasks partially queued' : 'CWMP tasks queued',
                  message: `${queuedCount} of ${list.length} visible CPEs have a CWMP refresh task queued. ${acceptedCount} connection request${acceptedCount === 1 ? '' : 's'} accepted.${failureCount > 0 ? ` ${failureCount} require individual review.` : ''}`,
                  persistent: failureCount > 0,
                });
                await refetch();
              } finally {
                setSummoningAll(false);
              }
            }}
            disabled={summoningAll()}
            class="btn btn-secondary"
            aria-label="Summon visible CPEs"
            title="Summon visible CPEs"
          >
            <Send size={14} class={summoningAll() ? 'animate-pulse' : ''} />
            <span class="hidden sm:inline">{summoningAll() ? 'Summoning...' : 'Summon visible CPEs'}</span>
          </button></Show>
        </div>
      </PageHeader>

      <nav role="tablist" class="tab-bar" aria-label="CPE inventory sections">
        <button type="button" role="tab" class={`tab-btn ${activeTab() === 'cpes' ? 'is-active' : ''}`} aria-selected={activeTab() === 'cpes'} onClick={() => setSearchParams({ tab: null })}>CPEs</button>
        <button type="button" role="tab" class={`tab-btn ${activeTab() === 'wans' ? 'is-active' : ''}`} aria-selected={activeTab() === 'wans'} onClick={() => setSearchParams({ tab: 'wans' })}>WANs</button>
      </nav>

      <Show when={activeTab() === 'wans'}>
        <WANInterfaces embedded />
      </Show>

      <Show when={activeTab() === 'cpes'}>
      <Show when={deviceList.error}>
        <div class="card"><ResourceError title="CPE inventory is unavailable" description="The inventory request failed. Check the API service status and retry without losing the current search or column settings." onRetry={() => refetch()} /></div>
      </Show>

      <Show when={!deviceList.error}><div class="card overflow-hidden">
        <div class="table-panel-toolbar">
          <span><strong>{filteredDevices().length}</strong> visible on this page · <strong>{deviceList()?.total ?? 0}</strong> total CPEs{activeFilterCount() > 0 ? ` · ${activeFilterCount()} column filter${activeFilterCount() === 1 ? '' : 's'}` : ''}</span>
          <div class="flex items-center gap-2">
            <Show when={hasInventoryFilter()}>
              <button type="button" onClick={() => { setSearchQuery(''); setColumnFilters({}); }}>Clear search and filters</button>
            </Show>
            <div class="relative">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input
                id="device-search"
                type="text"
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                placeholder="Search CPEs..."
                aria-label="Search CPEs by serial, model, vendor, or IP"
                class="input pl-9! w-56 text-sm"
              />
              <Show when={searchQuery()}>
                <button type="button" onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear CPE search">
                  <X size={12} />
                </button>
              </Show>
            </div>
          </div>
        </div>
        <div class="overflow-x-auto table-scroll">
          <table class="data-table w-full">
            <thead>
              <tr class="border-b border-subtle">
                <For each={visibleColumns()}>
                  {(col) => {
                    const isSortable = ['serial_number', 'manufacturer', 'model', 'ip_address', 'uptime', 'status', 'last_inform', 'tags'].includes(col.id);
                    const currentSort = sortBy();
                    const isSorted = currentSort?.column === col.id;
                    
                    return (
                      <th class="text-left whitespace-nowrap" aria-sort={isSorted ? (currentSort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <div class="flex items-center gap-1.5">
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (isSortable) handleSort(col.id);
                            }}
                            class={`flex items-center gap-1 text-xs font-medium tracking-wide transition-colors ${
                              isSorted ? 'text-sky-400' : 'text-muted'
                            } ${isSortable ? 'hover:text-primary cursor-pointer' : 'cursor-default'}`}
                            disabled={!isSortable}
                          >
                            {col.label}
                            <Show when={isSortable}>
                              {isSorted ? (
                                currentSort?.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                              ) : (
                                <ArrowUpDown size={10} class="opacity-50" />
                              )}
                            </Show>
                          </button>
                          <ColumnFilter
                            columnId={col.id}
                            label={col.label}
                            active={columnFilters()[col.id] || null}
                            onApply={(state) => {
                              setColumnFilters((prev) => {
                                const next = { ...prev };
                                if (state) next[col.id] = state;
                                else delete next[col.id];
                                return next;
                              });
                            }}
                          />
                        </div>
                      </th>
                    );
                  }}
                </For>
                <th><ColumnVisibility columns={columns} onToggle={toggleColumn} /></th>
              </tr>
            </thead>
            <tbody>
              <Show
                when={!deviceList.loading}
                fallback={<><TableSkeleton cols={visibleColumns().length + 1} /><TableSkeleton cols={visibleColumns().length + 1} /><TableSkeleton cols={visibleColumns().length + 1} /></>}
              >
                <Show
                  when={sortedDevices().length}
                  fallback={
                    <tr>
                      <td colspan={visibleColumns().length + 1} class="px-4 py-12 text-center">
                        <EmptyState
                          compact
                          icon={<RouterIcon size={22} />}
                          title={searchQuery() ? 'No CPEs match this search' : 'No CPEs have registered'}
                          description={searchQuery() ? 'Change the serial, model, vendor, or IP search to return to the current inventory.' : 'CPEs appear after their first CWMP Inform reaches ACS. Verify the published endpoint and device ACS URL.'}
                          action={searchQuery() ? <button type="button" class="btn btn-secondary" onClick={() => setSearchQuery('')}>Clear search</button> : undefined}
                        />
                      </td>
                    </tr>
                  }
                >
                  <For each={sortedDevices()}>
                    {(device, idx) => (
                      <tr class={`border-t border-subtle hover:bg-elevated transition-fast ${idx() % 2 === 1 ? 'bg-base/50' : ''}`}>
                        <For each={visibleColumns()}>
                          {(col) => (
                            <td class="px-4 py-3 whitespace-nowrap">
                              {getCellValue(device, col.id)}
                            </td>
                          )}
                        </For>
                        <td class="px-2 py-3"></td>
                      </tr>
                    )}
                  </For>
                </Show>
              </Show>
            </tbody>
          </table>
        </div>
      </div></Show>

      <Pagination page={page()} totalPages={totalPages()} totalItems={deviceList()?.total ?? 0} pageSize={pageSize()} onPageChange={setPage} storageKey="devices" onPageSizeChange={handlePageSizeChange} filters={columnFilters()} onClearFilters={() => setColumnFilters({})} onRemoveFilter={(columnId) => setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; })} />
      </Show>
    </div>
  );
};

export default Devices;
