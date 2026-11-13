import type { Component } from 'solid-js';
import { createResource, createSignal, createMemo, For, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { Ban, RefreshCw, Trash2, Search, X } from 'lucide-solid';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { useAuth, usePermissionSection } from '../lib/auth';
import { api } from '../lib/api';
import ColumnFilter from '../components/ColumnFilter';
import Pagination from '../components/Pagination';
import ColumnVisibility from '../components/ColumnVisibility';
import type { ColumnFilterState } from '../lib/filters';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import SortableHeader from '../components/SortableHeader';
import type { SortDirection } from '../lib/sorting';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { formatDateTime } from '../lib/dateTime';
import { usePageSize } from '../lib/usePageSize';

const Security: Component = () => {
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = () => {
    const requested = searchParams.tab === 'audit' ? 'audit' : 'blocklist';
    return can(`security.${requested}`, 'read') ? requested : can('security.blocklist', 'read') ? 'blocklist' : 'audit';
  };
  usePermissionSection(() => `security.${activeTab()}`);
  const { confirm, notify } = useFeedback();
  const [overview, { refetch: refetchOverview }] = createResource(() => can('security', 'read'), () => api.getSecurityOverview());
  const [auditPage, setAuditPage] = createSignal(0);
  const { pageSize: auditPageSize, changePageSize: changeAuditPageSize } = usePageSize('security_audit', 20);
  const [blocked, { refetch: refetchBlocked }] = createResource(() => can('security.blocklist', 'read'), () => api.getBlockedDevices());
  const [serial, setSerial] = createSignal('');
  const [reason, setReason] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [pendingUnblock, setPendingUnblock] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.security', {});
  const [auditSearch, setAuditSearch] = createPersistedSignal('acs.search.security.audit');
  const [auditSort, setAuditSort] = createPersistedJsonSignal<{ column: string | null; direction: SortDirection }>('acs.sort.security-audit', { column: 'created_at', direction: 'desc' });
  const [audit, { refetch: refetchAudit }] = createResource(
    () => can('security.audit', 'read') ? ({ page: auditPage(), size: auditPageSize(), search: auditSearch(), sort: auditSort(), filters: columnFilters() }) : false,
    (query) => api.getAuditLogs(query.size, query.page * query.size, { search: query.search, sort: query.sort, filters: query.filters })
  );
  const handleAuditSort = (column: string) => { setAuditPage(0); setAuditSort(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' })); };
  const updateAuditFilter = (columnId: string, state: ColumnFilterState | null) => {
    setAuditPage(0);
    setColumnFilters((previous) => {
      const next = { ...previous };
      if (state) next[columnId] = state;
      else delete next[columnId];
      return next;
    });
  };
  const { columns, isVisible, toggle } = useColumnVisibility('security', [
    { id: 'created_at', label: 'Time', visible: true },
    { id: 'username', label: 'Actor', visible: true },
    { id: 'action', label: 'Action', visible: true },
    { id: 'resource', label: 'Resource', visible: true },
    { id: 'ip_address', label: 'Source', visible: true },
    { id: 'status', label: 'HTTP status', visible: true },
  ]);

  const overviewData = () => overview.error ? undefined : overview();
  const auditData = () => audit.error ? undefined : audit();
  const blockedData = () => blocked.error ? undefined : blocked();
  const filteredAudit = createMemo(() => auditData()?.entries || []);
  const pagedAudit = filteredAudit;
  const auditTotalPages = createMemo(() => Math.ceil((auditData()?.total || 0) / auditPageSize()));

  const refreshOverview = () => { if (can('security', 'read')) void refetchOverview(); };
  const refreshBlocklist = () => { refreshOverview(); void refetchBlocked(); };
  const refreshAudit = () => { refreshOverview(); void refetchAudit(); };
  const handleTabKeyDown = (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  const blockDevice = async (event: SubmitEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api.blockDevice(serial().trim(), reason().trim());
      setSerial(''); setReason('');
      setMessage({ type: 'success', text: 'Device admission blocked.' });
      refetchBlocked(); refetchAudit();
    } catch (error) {
      notify({ tone: 'error', title: 'CPE was not added to the blocklist', message: 'The serial and reason are preserved. Review the input and retry.', detail: (error as Error).message, persistent: true });
    } finally { setSaving(false); }
  };
  const unblock = async (serialNumber: string) => {
    if (!await confirm({ title: `Allow ${serialNumber} to reconnect?`, description: 'The CPE will be admitted again when its next CWMP session reaches ACS. The unblock event remains in the audit trail.', confirmLabel: 'Unblock CPE' })) return;
    if (pendingUnblock()) return;
    setPendingUnblock(serialNumber);
    try {
      await api.unblockDevice(serialNumber);
      notify({ tone: 'success', title: 'CPE removed from admission blocklist', message: serialNumber });
      refetchBlocked(); refetchAudit();
    } catch (error) { notify({ tone: 'error', title: 'Could not unblock CPE', message: 'The admission rule remains unchanged.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingUnblock(null); }
  };
  const formatDate = (value: string) => formatDateTime(value);

  return (
    <div class="space-y-5">
      <PageHeader title="Security center" description="Authentication posture, device admission, and operator audit trail." />

      <Show when={overview.error}>
        <div class="card"><ResourceError title="Security posture is unavailable" description="The security summary could not be loaded. Retry to refresh the posture register." onRetry={refreshOverview} /></div>
      </Show>

      <Show when={can('security', 'read')}><dl class="ops-register security-register" aria-label="Security posture register">
        <div class="ops-register-cell"><dt>Operators</dt><dd>{overviewData()?.total_users ?? '—'}</dd><small>{overviewData()?.full_access_admins ?? 0} full-access admins</small></div>
        <div class="ops-register-cell"><dt>Failed events</dt><dd>{overviewData()?.recorded_failures ?? '—'}</dd><small>Recorded in audit trail</small></div>
        <div class={`ops-register-cell is-text ${overviewData() && !overviewData()?.jwt_configured ? 'is-warning' : ''}`}><dt>JWT signing</dt><dd>{overviewData() ? overviewData()?.jwt_configured ? 'Configured' : 'Review required' : '—'}</dd><small>{overviewData()?.jwt_configured ? 'Signing secret is active' : 'Verify the signing-secret configuration'}</small></div>
        <div class={`ops-register-cell is-text ${overviewData() && (!overviewData()?.cors_restricted || !overviewData()?.login_rate_limit_enabled) ? 'is-warning' : ''}`}><dt>API controls</dt><dd>{overviewData() ? overviewData()?.cors_restricted && overviewData()?.login_rate_limit_enabled ? 'Restricted' : 'Review required' : '—'}</dd><small>{overviewData()?.cors_restricted && overviewData()?.login_rate_limit_enabled ? 'CORS and login throttling active' : 'Verify CORS and login throttling'}</small></div>
      </dl></Show>

      <nav role="tablist" class="tab-bar" aria-label="Access controls sections" onKeyDown={handleTabKeyDown}>
        <Show when={can('security.blocklist', 'read')}><button id="security-blocklist-tab" type="button" role="tab" class={`tab-btn ${activeTab() === 'blocklist' ? 'is-active' : ''}`} aria-selected={activeTab() === 'blocklist'} aria-controls="security-blocklist-panel" tabIndex={activeTab() === 'blocklist' ? 0 : -1} onClick={() => setSearchParams({ tab: null })}>Device block list</button></Show>
        <Show when={can('security.audit', 'read')}><button id="security-audit-tab" type="button" role="tab" class={`tab-btn ${activeTab() === 'audit' ? 'is-active' : ''}`} aria-selected={activeTab() === 'audit'} aria-controls="security-audit-panel" tabIndex={activeTab() === 'audit' ? 0 : -1} onClick={() => setSearchParams({ tab: 'audit' })}>Operator audit</button></Show>
      </nav>

        <Show when={can('security.blocklist', 'read') && activeTab() === 'blocklist'}><div id="security-blocklist-panel" role="tabpanel" aria-labelledby="security-blocklist-tab" tabIndex={0} class="space-y-4">
          <Show when={message()}><div role={message()!.type === 'error' ? 'alert' : 'status'} class={`px-3 py-2.5 border rounded-[3px] text-xs ${message()!.type === 'success' ? 'border-success/25 bg-success/8 text-success-text' : 'border-error/25 bg-error/8 text-error-text'}`}>{message()!.text}</div></Show>
          <section class="data-panel overflow-hidden">
          <div class="table-panel-toolbar"><div><h3>Device admission blocklist</h3><p>Blocked serials are rejected before registration or parameter processing.</p></div><button type="button" class="icon-button" onClick={refreshBlocklist} disabled={blocked.loading || overview.loading} title="Refresh device block list" aria-label="Refresh device block list"><RefreshCw size={15} class={blocked.loading ? 'animate-spin' : ''} aria-hidden="true" /></button></div>
          <Show when={blocked.error}><ResourceError title="Device block list is unavailable" description="Blocked CPE identities could not be loaded. Retry before making an admission decision." onRetry={refreshBlocklist} /></Show>
          <Show when={can('security.blocklist', 'edit')}><form onSubmit={blockDevice} class="p-4 grid sm:grid-cols-2 gap-3 border-b border-subtle bg-elevated/20">
            <div><label for="block-serial" class="block text-[11px] text-muted mb-1.5">CPE serial number</label><input id="block-serial" class="input" value={serial()} onInput={(event) => setSerial(event.currentTarget.value)} required maxlength={128} placeholder="48575443…" /></div>
            <div><label for="block-reason" class="block text-[11px] text-muted mb-1.5">Admission reason</label><input id="block-reason" class="input" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} maxlength={512} placeholder="Unrecognized deployment inventory" /></div>
            <button class="btn btn-danger sm:col-span-2" disabled={saving()}><Ban size={14} />{saving() ? 'Blocking…' : 'Block device'}</button>
          </form></Show>
          <Show when={blocked.loading}><div class="p-4 space-y-3"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div></Show>
          <Show when={!blocked.loading && !blocked.error && (blockedData()?.length ?? 0) > 0} fallback={!blocked.loading && !blocked.error ? <EmptyState compact title="Admission blocklist is empty" description="No CPE serial numbers are currently denied by an operator rule." /> : undefined}>
            <div class="max-h-80 overflow-auto"><For each={blockedData()}>{(device) => <div class="flex items-center gap-3 px-4 py-3 border-b border-subtle last:border-0"><Ban size={14} class="text-error-text shrink-0" /><div class="min-w-0 flex-1"><strong class="block font-mono text-xs truncate">{device.serial_number}</strong><span class="block text-[10px] text-muted truncate">{device.reason || 'No reason recorded'} · {device.created_by}</span></div><button class="icon-button" aria-label={`Unblock CPE ${device.serial_number}`} onClick={() => unblock(device.serial_number)} disabled={!can('security.blocklist', 'delete') || pendingUnblock() !== null}><Trash2 size={14} /></button></div>}</For></div>
          </Show>
        </section></div></Show>

        <Show when={can('security.audit', 'read') && activeTab() === 'audit'}><div id="security-audit-panel" role="tabpanel" aria-labelledby="security-audit-tab" tabIndex={0} class="space-y-4"><section class="data-panel overflow-hidden">
          <div class="table-panel-toolbar"><div><h3>Operator audit trail</h3><p>Append-only record of login and mutation activity.</p></div><div class="flex items-center gap-2"><div class="relative"><Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" /><input type="text" value={auditSearch()} onInput={(e) => { setAuditPage(0); setAuditSearch(e.currentTarget.value); }} placeholder="Search events…" class="input pl-9! w-48 text-sm" /><Show when={auditSearch()}><button onClick={() => { setAuditPage(0); setAuditSearch(''); }} class="input-clear" aria-label="Clear search"><X size={12} /></button></Show></div><span class="badge badge-success">{auditData()?.total ?? 0} events</span><button type="button" class="icon-button" onClick={refreshAudit} disabled={audit.loading || overview.loading} title="Refresh operator audit" aria-label="Refresh operator audit"><RefreshCw size={15} class={audit.loading ? 'animate-spin' : ''} aria-hidden="true" /></button></div></div>
          <Show when={audit.error}><ResourceError title="Operator audit is unavailable" description="Operator security events could not be loaded. Retry to refresh the audit trail." onRetry={refreshAudit} /></Show>
          <div class="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table class="data-table min-w-[720px]"><thead class="sticky top-0 opaque-table-header"><tr>
                <Show when={isVisible('created_at')}><th data-column-order-id="time#0" class="text-left px-4 py-2.5"><div class="flex items-center gap-1.5"><SortableHeader column="created_at" label="Time" sortBy={auditSort().column} direction={auditSort().direction} onSort={handleAuditSort} /><ColumnFilter columnId="created_at" label="Time" active={columnFilters()['created_at'] || null} onApply={(s) => updateAuditFilter('created_at', s)} /></div></th></Show>
                <Show when={isVisible('username')}><th data-column-order-id="actor#0" class="text-left px-4 py-2.5"><div class="flex items-center gap-1.5"><SortableHeader column="username" label="Actor" sortBy={auditSort().column} direction={auditSort().direction} onSort={handleAuditSort} /><ColumnFilter columnId="username" label="Actor" active={columnFilters()['username'] || null} onApply={(s) => updateAuditFilter('username', s)} /></div></th></Show>
                <Show when={isVisible('action')}><th data-column-order-id="action#0" class="text-left px-4 py-2.5"><div class="flex items-center gap-1.5"><SortableHeader column="action" label="Action" sortBy={auditSort().column} direction={auditSort().direction} onSort={handleAuditSort} /><ColumnFilter columnId="action" label="Action" active={columnFilters()['action'] || null} onApply={(s) => updateAuditFilter('action', s)} /></div></th></Show>
                <Show when={isVisible('resource')}><th data-column-order-id="resource#0" class="text-left px-4 py-2.5"><div class="flex items-center gap-1.5"><SortableHeader column="resource" label="Resource" sortBy={auditSort().column} direction={auditSort().direction} onSort={handleAuditSort} /><ColumnFilter columnId="resource" label="Resource" active={columnFilters()['resource'] || null} onApply={(s) => updateAuditFilter('resource', s)} /></div></th></Show>
                <Show when={isVisible('ip_address')}><th data-column-order-id="source#0" class="text-left px-4 py-2.5"><div class="flex items-center gap-1.5"><SortableHeader column="ip_address" label="Source" sortBy={auditSort().column} direction={auditSort().direction} onSort={handleAuditSort} /><ColumnFilter columnId="ip_address" label="Source" active={columnFilters()['ip_address'] || null} onApply={(s) => updateAuditFilter('ip_address', s)} /></div></th></Show>
                <Show when={isVisible('status')}><th data-column-order-id="http status#0" class="text-right px-4 py-2.5"><div class="flex items-center gap-1.5"><SortableHeader column="status" label="HTTP status" sortBy={auditSort().column} direction={auditSort().direction} onSort={handleAuditSort} /><ColumnFilter columnId="status" label="HTTP status" numeric active={columnFilters()['status'] || null} onApply={(s) => updateAuditFilter('status', s)} /></div></th></Show>
                <th data-column-order-id="__visibility#0" data-column-fixed="visibility" class="px-2 py-2.5"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
              </tr></thead>
              <tbody><For each={pagedAudit()}>{(entry) => <tr class="border-t border-subtle"><Show when={isVisible('created_at')}><td data-column-order-id="time#0" class="px-4 py-2.5 whitespace-nowrap text-[10px] text-muted">{formatDate(entry.created_at)}</td></Show><Show when={isVisible('username')}><td data-column-order-id="actor#0" class="px-4 py-2.5 text-xs">{entry.username || 'unknown'}</td></Show><Show when={isVisible('action')}><td data-column-order-id="action#0" class="px-4 py-2.5"><span class="font-mono text-[10px] text-accent">{entry.action}</span></td></Show><Show when={isVisible('resource')}><td data-column-order-id="resource#0" class="px-4 py-2.5 font-mono text-[10px] text-secondary max-w-[210px] truncate" title={entry.resource}>{entry.resource}</td></Show><Show when={isVisible('ip_address')}><td data-column-order-id="source#0" class="px-4 py-2.5 font-mono text-[10px] text-muted">{entry.ip_address || '—'}</td></Show><Show when={isVisible('status')}><td data-column-order-id="http status#0" class="px-4 py-2.5 text-right"><span class={`badge ${entry.status >= 400 ? 'badge-error' : 'badge-success'}`}>{entry.status}</span></td></Show><td data-column-fixed="visibility" data-column-order-id="__visibility#0" class="px-2 py-2.5"></td></tr>}</For></tbody>
            </table>
            <Show when={audit.loading}><div class="p-4 space-y-3"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div></Show>
            <Show when={!audit.loading && !audit.error && (auditData()?.total ?? 0) === 0}><EmptyState compact title="No operator security events are recorded" description="Authentication and mutation events will appear after operators begin using this deployment." /></Show>
          </div>
        </section>
        <Pagination page={auditPage()} totalPages={auditTotalPages()} totalItems={filteredAudit().length} pageSize={auditPageSize()} onPageChange={setAuditPage} storageKey="security_audit" onPageSizeChange={(size) => { changeAuditPageSize(size); setAuditPage(0); }} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setAuditPage(0); }} onRemoveFilter={(columnId) => { updateAuditFilter(columnId, null); }} />
        </div></Show>
    </div>
  );
};

export default Security;
