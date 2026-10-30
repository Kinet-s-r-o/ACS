import type { Component } from 'solid-js';
import { createResource, createSignal, createMemo, Show, For } from 'solid-js';
import { Plus, Pencil, Trash2, Search, X } from 'lucide-solid';
import { api, type Role } from '../lib/api';
import Dialog from '../components/Dialog';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { useAuth } from '../lib/auth';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import SortableHeader from '../components/SortableHeader';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { sortRows, type SortDirection } from '../lib/sorting';
import { usePageSize } from '../lib/usePageSize';

const PERMISSION_GROUPS: { label: string; permissions: { key: string; label: string; description: string }[] }[] = [
  { label: 'Users', permissions: [
    { key: 'users.read', label: 'Read', description: 'View user accounts.' },
    { key: 'users.write', label: 'Write', description: 'Create, edit, and delete users.' },
    { key: 'users.tokens', label: 'Manage API tokens', description: 'Create and revoke user API tokens.' },
  ] },
  { label: 'Roles', permissions: [
    { key: 'roles.read', label: 'Read', description: 'View role definitions.' },
    { key: 'roles.write', label: 'Write', description: 'Create, edit, and delete roles.' },
  ] },
  { label: 'Devices', permissions: [
    { key: 'devices.read', label: 'Read', description: 'View devices and their operational data.' },
    { key: 'devices.write', label: 'Write (legacy bundle)', description: 'All device changes, including every focused permission below.' },
    { key: 'devices.configure', label: 'Configure', description: 'Change parameters, tags, and device advanced settings.' },
    { key: 'devices.command', label: 'Run commands', description: 'Read parameters remotely, reboot, and request a CWMP session.' },
    { key: 'devices.reset', label: 'Factory reset', description: 'Queue a factory reset.' },
    { key: 'devices.delete', label: 'Delete devices and tasks', description: 'Delete devices or pending tasks.' },
    { key: 'devices.credentials', label: 'Manage credentials', description: 'Change connection-request credentials.' },
    { key: 'devices.snapshots.write', label: 'Manage snapshots', description: 'Create, restore, and delete device snapshots.' },
    { key: 'devices.firmware', label: 'Deliver firmware', description: 'Queue firmware delivery to a device.' },
  ] },
  { label: 'Firmwares', permissions: [
    { key: 'firmwares.read', label: 'Read', description: 'View the firmware library.' },
    { key: 'firmwares.write', label: 'Write (legacy bundle)', description: 'Manage the firmware library.' },
    { key: 'firmwares.manage', label: 'Manage library', description: 'Upload and delete firmware images.' },
  ] },
  { label: 'Faults', permissions: [
    { key: 'faults.read', label: 'Read', description: 'View faults and statistics.' },
    { key: 'faults.write', label: 'Write', description: 'Resolve or delete faults.' },
  ] },
  { label: 'Provisioning', permissions: [
    { key: 'provisioning.read', label: 'Read', description: 'View provisioning rules and templates.' },
    { key: 'provisioning.write', label: 'Write (legacy bundle)', description: 'Manage both rules and templates.' },
    { key: 'provisioning.rules.write', label: 'Manage rules', description: 'Create, edit, import, reorder, and enable rules.' },
    { key: 'provisioning.templates.write', label: 'Manage templates', description: 'Create and edit templates, advanced settings, and metrics.' },
  ] },
  { label: 'Settings', permissions: [
    { key: 'settings.read', label: 'Read', description: 'View system settings.' },
    { key: 'settings.write', label: 'Write', description: 'Change system settings.' },
    { key: 'database.stats.read', label: 'Database statistics', description: 'View database query performance statistics and SQL text.' },
  ] },
  { label: 'Metrics', permissions: [
    { key: 'metrics.read', label: 'Read', description: 'View device metrics.' },
    { key: 'metrics.write', label: 'Write', description: 'Manage metric definitions.' },
  ] },
  { label: 'Security', permissions: [
    { key: 'security.read', label: 'Read', description: 'View security events and blocked devices.' },
    { key: 'security.write', label: 'Write', description: 'Manage blocked devices.' },
  ] },
];
const PERMISSION_COUNT = PERMISSION_GROUPS.reduce((count, group) => count + group.permissions.length, 0);

const RolesTab: Component = () => {
  const { hasPermission } = useAuth();
  const { confirm, notify } = useFeedback();
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);

  const [roles, { refetch: refetchRoles }] = createResource(async () => {
    if (!hasPermission('roles.read')) return [];
    return api.getRoles();
  });
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.roles', {});
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.roles');
  const [rolePage, setRolePage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('roles', 20);
  const { columns, isVisible, toggle } = useColumnVisibility('roles', [
    { id: 'name', label: 'Name', visible: true },
    { id: 'description', label: 'Description', visible: true },
    { id: 'permissions', label: 'Permissions', visible: true },
    { id: 'type', label: 'Type', visible: true },
  ]);
  const [sortState, setSortState] = createPersistedJsonSignal<{ column: string | null; direction: SortDirection }>('acs.sort.roles', { column: 'name', direction: 'asc' });
  const handleSort = (column: string) => {
    setRolePage(0);
    setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  };
  const getFilterValue = (role: Role, column: string): string => {
    switch (column) {
      case 'name': return role.name;
      case 'description': return role.description || '';
      case 'permissions': return `${role.permissions.length} / ${PERMISSION_COUNT}`;
      case 'type': return role.is_system ? 'System' : 'Custom';
      default: return '';
    }
  };
  const filteredRoles = () => {
    const query = searchQuery().toLowerCase().trim();
    let all = roles() || [];
    if (query) {
      all = all.filter(role => [
        role.name,
        role.description || '',
        role.permissions.join(' '),
        role.is_system ? 'system' : 'custom',
      ].some(value => value.toLowerCase().includes(query)));
    }
    return applyColumnFilters(all, columnFilters(), getFilterValue);
  };
  const sortedRoles = () => sortRows(filteredRoles(), sortState().column, sortState().direction, getFilterValue);
  const applyRoleFilter = (column: string, state: ColumnFilterState | null) => {
    setRolePage(0);
    setColumnFilters(previous => {
      const next = { ...previous };
      if (state) next[column] = state;
      else delete next[column];
      return next;
    });
  };
  const pagedRoles = createMemo(() => {
    const all = sortedRoles();
    const start = rolePage() * pageSize();
    return all.slice(start, start + pageSize());
  });
  const roleTotalPages = createMemo(() => Math.ceil(sortedRoles().length / pageSize()));
  const handlePageSizeChange = (size: number) => { changePageSize(size); setRolePage(0); };

  const [showRoleModal, setShowRoleModal] = createSignal(false);
  const [editingRole, setEditingRole] = createSignal<Role | null>(null);
  const [roleForm, setRoleForm] = createSignal({ name: '', description: '', permissions: [] as string[] });
  const [activePermissionGroup, setActivePermissionGroup] = createSignal('Devices');
  const selectedInGroup = (group: typeof PERMISSION_GROUPS[number]) => group.permissions.filter(permission => roleForm().permissions.includes(permission.key)).length;
  const selectGroupPermissions = (group: typeof PERMISSION_GROUPS[number], selected: boolean) => {
    const keys = group.permissions.map(permission => permission.key);
    setRoleForm(form => ({
      ...form,
      permissions: selected
        ? [...new Set([...form.permissions, ...keys])]
        : form.permissions.filter(permission => !keys.includes(permission)),
    }));
  };

  const canWrite = () => hasPermission('roles.write');

  const openCreateRole = () => {
    setEditingRole(null);
    setRoleForm({ name: '', description: '', permissions: [] });
    setActivePermissionGroup('Devices');
    setShowRoleModal(true);
  };

  const openEditRole = (role: Role) => {
    if (role.is_system) return;
    setEditingRole(role);
    setRoleForm({ name: role.name, description: role.description, permissions: [...role.permissions] });
    setActivePermissionGroup('Devices');
    setShowRoleModal(true);
  };

  const togglePermission = (perm: string) => {
    setRoleForm(f => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter(p => p !== perm)
        : [...f.permissions, perm],
    }));
  };

  const handleCreateRole = async () => {
    if (pendingAction()) return;
    setPendingAction('create-role');
    try {
      await api.createRole(roleForm());
      notify({ tone: 'success', title: 'Role created', message: roleForm().name });
      setShowRoleModal(false);
      setRoleForm({ name: '', description: '', permissions: [] });
      refetchRoles();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not create role', message: 'The role was not created.', detail: (error as Error).message });
    } finally {
      setPendingAction(null);
    }
  };

  const handleUpdateRole = async () => {
    if (pendingAction() || !editingRole()) return;
    setPendingAction('update-role');
    try {
      await api.updateRole(editingRole()!.id, roleForm());
      notify({ tone: 'success', title: 'Role updated', message: roleForm().name });
      setShowRoleModal(false);
      refetchRoles();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not update role', message: 'The role was not updated.', detail: (error as Error).message });
    } finally {
      setPendingAction(null);
    }
  };

  const handleDeleteRole = async (role: Role) => {
    const confirmed = await confirm({
      title: 'Delete role',
      description: `Delete the "${role.name}" role? Users assigned to it will lose those permissions.`,
      confirmLabel: 'Delete role',
      tone: 'danger',
    });
    if (!confirmed || pendingAction()) return;
    setPendingAction('delete-role');
    try {
      await api.deleteRole(role.id);
      notify({ tone: 'success', title: 'Role deleted', message: role.name });
      refetchRoles();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete role', message: 'The role was not deleted.', detail: (error as Error).message });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div>
      <div class="flex items-center justify-between mb-4">
        <div>
          <p class="text-sm"><strong>{pagedRoles().length}</strong> visible on this page · <strong>{roles()?.length ?? 0}</strong> total roles</p>
          <p class="text-sm text-muted mt-1">Define permission sets that can be assigned to users.</p>
        </div>
        <div class="flex items-center gap-2">
          <div class="relative">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input type="text" value={searchQuery()} onInput={(event) => { setRolePage(0); setSearchQuery(event.currentTarget.value); }} placeholder="Search roles…" aria-label="Search roles" class="input pl-9! w-48 text-sm" />
            <Show when={searchQuery()}>
              <button type="button" onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear role search"><X size={12} /></button>
            </Show>
          </div>
          <Show when={canWrite()}>
            <button type="button" class="btn btn-primary" onClick={openCreateRole}>
              <Plus size={14} /> New Role
            </button>
          </Show>
        </div>
      </div>

      <Show when={roles.error}>
        <ResourceError title="Roles are unavailable" description="ACS could not read the role definitions. Retry before managing permissions." onRetry={refetchRoles} />
      </Show>

      <Show when={!roles.loading && !roles.error}>
        <Show when={(roles()?.length ?? 0) > 0}>
        <Show when={sortedRoles().length > 0} fallback={<EmptyState compact title="No roles match these filters" description="Adjust or clear the column filters to see roles again." />}>
          <div class="overflow-x-auto table-scroll">
            <table class="data-table w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-muted/30">
                  <Show when={isVisible('name')}><th class="px-3 py-2 text-left font-medium"><SortableHeader column="name" label="Name" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="name" label="Name" active={columnFilters().name || null} onApply={state => applyRoleFilter('name', state)} /></SortableHeader></th></Show>
                  <Show when={isVisible('description')}><th class="px-3 py-2 text-left font-medium"><SortableHeader column="description" label="Description" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="description" label="Description" active={columnFilters().description || null} onApply={state => applyRoleFilter('description', state)} /></SortableHeader></th></Show>
                  <Show when={isVisible('permissions')}><th class="px-3 py-2 text-left font-medium"><SortableHeader column="permissions" label="Permissions" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="permissions" label="Permissions" active={columnFilters().permissions || null} onApply={state => applyRoleFilter('permissions', state)} /></SortableHeader></th></Show>
                  <Show when={isVisible('type')}><th class="px-3 py-2 text-left font-medium"><SortableHeader column="type" label="Type" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="type" label="Type" active={columnFilters().type || null} onApply={state => applyRoleFilter('type', state)} /></SortableHeader></th></Show>
                  <th class="px-3 py-2 text-right">Actions</th>
                  <th class="px-2 py-2"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
                </tr>
              </thead>
              <tbody>
                <For each={pagedRoles()}>
                  {(role) => (
                    <tr class="border-b border-border/50 hover:bg-muted/20">
                      <Show when={isVisible('name')}><td class="px-3 py-2 font-medium">{role.name}</td></Show>
                      <Show when={isVisible('description')}><td class="px-3 py-2 text-muted">{role.description || '—'}</td></Show>
                      <Show when={isVisible('permissions')}><td class="px-3 py-2"><span class="badge">{role.permissions.length} / {PERMISSION_COUNT}</span></td></Show>
                      <Show when={isVisible('type')}><td class="px-3 py-2">
                        <Show when={role.is_system}><span class="badge badge-info">System</span></Show>
                        <Show when={!role.is_system}><span class="badge">Custom</span></Show>
                      </td></Show>
                      <td class="px-3 py-2">
                        <div class="flex gap-1 justify-end">
                          <Show when={canWrite() && !role.is_system}>
                            <button type="button" class="btn btn-ghost btn-sm" onClick={() => openEditRole(role)} title="Edit role"><Pencil size={14} /></button>
                            <button type="button" class="btn btn-ghost btn-sm text-destructive" onClick={() => handleDeleteRole(role)} title="Delete role"><Trash2 size={14} /></button>
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
          <Pagination page={rolePage()} totalPages={roleTotalPages()} totalItems={sortedRoles().length} pageSize={pageSize()} onPageChange={setRolePage} storageKey="roles" onPageSizeChange={handlePageSizeChange} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setRolePage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setRolePage(0); }} />
        </Show>
        </Show>
        <Show when={(roles()?.length ?? 0) === 0}>
          <EmptyState compact title="No roles defined" description="Create a role to define a set of permissions." />
        </Show>
      </Show>

      <Show when={showRoleModal()}>
        <Dialog title={editingRole() ? 'Edit role' : 'New role'} description="Select the permissions this role grants." size="large" onClose={() => { if (!pendingAction()) setShowRoleModal(false); }}>
          <form class="space-y-4" onSubmit={(event) => { event.preventDefault(); void (editingRole() ? handleUpdateRole() : handleCreateRole()); }}>
            <div>
              <label for="role-name" class="block text-xs text-muted mb-1.5">Name</label>
              <input id="role-name" type="text" value={roleForm().name} onInput={(e) => setRoleForm(f => ({ ...f, name: e.currentTarget.value }))} class="input w-full" placeholder="Role name" required maxlength={64} />
            </div>
            <div>
              <label for="role-description" class="block text-xs text-muted mb-1.5">Description</label>
              <input id="role-description" type="text" value={roleForm().description} onInput={(e) => setRoleForm(f => ({ ...f, description: e.currentTarget.value }))} class="input w-full" placeholder="Optional description" maxlength={256} />
            </div>
            <div>
              <div class="flex items-center justify-between gap-3 mb-2">
                <div>
                  <div class="text-sm font-medium text-primary">Permissions</div>
                  <p class="text-xs text-muted mt-0.5">{roleForm().permissions.length} of {PERMISSION_COUNT} selected</p>
                </div>
                <span class="text-xs text-muted">Choose a section, then select its access</span>
              </div>
              <div class="flex flex-wrap gap-2 border-b border-subtle pb-3 mb-3" role="tablist" aria-label="Permission sections">
                <For each={PERMISSION_GROUPS}>{group => (
                  <button type="button" role="tab" aria-selected={activePermissionGroup() === group.label} onClick={() => setActivePermissionGroup(group.label)} class={`px-3 py-2 text-xs border rounded transition-colors ${activePermissionGroup() === group.label ? 'border-sky-500 bg-sky-500/10 text-primary' : 'border-subtle text-muted hover:text-primary hover:bg-base'}`}>
                    {group.label}<span class="ml-2 tabular-nums">{selectedInGroup(group)}/{group.permissions.length}</span>
                  </button>
                )}</For>
              </div>
              <For each={PERMISSION_GROUPS.filter(group => group.label === activePermissionGroup())}>{group => (
                <section role="tabpanel" aria-label={`${group.label} permissions`} class="rounded border border-subtle bg-base p-3 sm:p-4">
                  <div class="flex items-center justify-between gap-3 mb-3">
                    <div><h3 class="text-sm font-medium text-primary">{group.label}</h3><p class="text-xs text-muted mt-0.5">{selectedInGroup(group)} of {group.permissions.length} selected</p></div>
                    <div class="flex gap-2">
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => selectGroupPermissions(group, true)}>Select all</button>
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => selectGroupPermissions(group, false)}>Clear</button>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <For each={group.permissions}>{permission => (
                      <label class="flex items-start gap-3 rounded border border-subtle bg-elevated/40 p-3 text-sm cursor-pointer hover:bg-elevated">
                        <input type="checkbox" checked={roleForm().permissions.includes(permission.key)} onChange={() => togglePermission(permission.key)} class="checkbox mt-0.5 shrink-0" />
                        <span class="min-w-0"><span class="block font-medium text-primary">{permission.label}</span><span class="block text-xs text-muted mt-0.5 leading-relaxed">{permission.description}</span></span>
                      </label>
                    )}</For>
                  </div>
                </section>
              )}</For>
              <div class="mt-3 rounded border border-subtle px-3 py-2 text-xs text-muted">
                Legacy <span class="font-medium text-secondary">Write</span> bundles preserve broad access. Use focused permissions when a role should have only selected actions.
              </div>
            </div>
            <div class="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowRoleModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}><X size={14} /> Cancel</button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>{pendingAction() ? 'Saving…' : editingRole() ? 'Update role' : 'Create role'}</button>
            </div>
          </form>
        </Dialog>
      </Show>
    </div>
  );
};

export default RolesTab;
