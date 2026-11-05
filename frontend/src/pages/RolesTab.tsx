import type { Component } from 'solid-js';
import { PERMISSION_ACTIONS, canSection, type PermissionAction } from '../lib/permissions';
import { createResource, createSignal, createMemo, Show, For } from 'solid-js';
import { Plus, Pencil, Trash2, Search, X } from 'lucide-solid';
import { api, type Role } from '../lib/api';
import Dialog from '../components/Dialog';
import AccountTransferActions from '../components/AccountTransferActions';
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

const RolesTab: Component = () => {
  const { hasPermission, can } = useAuth();
  const [catalog] = createResource(api.getPermissionCatalog);
  const sections = () => catalog()?.sections ?? [];
  const permissionCount = () => sections().reduce((total, section) => total + section.actions.length, 0);
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
      case 'permissions': return `${role.permissions.length} / ${permissionCount()}`;
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
  const canWrite = () => hasPermission('roles.write');

  const openCreateRole = () => {
    setEditingRole(null);
    setRoleForm({ name: '', description: '', permissions: [] });
    setShowRoleModal(true);
  };

  const openEditRole = (role: Role) => {
    if (role.is_system) return;
    setEditingRole(role);
    setRoleForm({ name: role.name, description: role.description, permissions: [...role.permissions] });
    setShowRoleModal(true);
  };

  const togglePermission = (section: string, action: PermissionAction) => {
    const prefix = `access.${section}.`;
    const key = `${prefix}${action}`;
    setRoleForm(form => {
      const selected = form.permissions.includes(key);
      let permissions = form.permissions.filter(value => value !== key);
      if (action === 'full' || (action === 'read' && selected)) permissions = permissions.filter(value => !value.startsWith(prefix));
      if (!selected) {
        permissions.push(key);
        if (action !== 'full' && action !== 'read') permissions = [...new Set([...permissions, `${prefix}read`])];
      }
      return { ...form, permissions };
    });
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
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <p class="text-sm"><strong>{pagedRoles().length}</strong> visible on this page · <strong>{roles()?.length ?? 0}</strong> total roles</p>
          <p class="text-sm text-muted mt-1">Define permission sets that can be assigned to users.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative block w-full sm:w-72">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input type="text" value={searchQuery()} onInput={(event) => { setRolePage(0); setSearchQuery(event.currentTarget.value); }} placeholder="Search roles…" aria-label="Search roles" class="input w-full pl-9! text-sm" />
            <Show when={searchQuery()}>
              <button type="button" onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear role search"><X size={12} /></button>
            </Show>
          </div>
          <AccountTransferActions kind="roles" ids={sortedRoles().map(role => role.id)} loading={roles.loading || !!roles.error} onImported={() => refetchRoles()} />
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
                  <Show when={isVisible('name')}><th data-column-order-id="name#0" class="px-3 py-2 text-left font-medium"><SortableHeader column="name" label="Name" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="name" label="Name" active={columnFilters().name || null} onApply={state => applyRoleFilter('name', state)} /></SortableHeader></th></Show>
                  <Show when={isVisible('description')}><th data-column-order-id="description#0" class="px-3 py-2 text-left font-medium"><SortableHeader column="description" label="Description" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="description" label="Description" active={columnFilters().description || null} onApply={state => applyRoleFilter('description', state)} /></SortableHeader></th></Show>
                  <Show when={isVisible('permissions')}><th data-column-order-id="permissions#0" class="px-3 py-2 text-left font-medium"><SortableHeader column="permissions" label="Permissions" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="permissions" label="Permissions" active={columnFilters().permissions || null} onApply={state => applyRoleFilter('permissions', state)} /></SortableHeader></th></Show>
                  <Show when={isVisible('type')}><th data-column-order-id="type#0" class="px-3 py-2 text-left font-medium"><SortableHeader column="type" label="Type" sortBy={sortState().column} direction={sortState().direction} onSort={handleSort}><ColumnFilter columnId="type" label="Type" active={columnFilters().type || null} onApply={state => applyRoleFilter('type', state)} /></SortableHeader></th></Show>
                  <th data-column-order-id="actions#0" data-column-fixed="actions" class="px-3 py-2 text-right">Actions</th>
                  <th data-column-order-id="__visibility#0" data-column-fixed="visibility" class="px-2 py-2"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
                </tr>
              </thead>
              <tbody>
                <For each={pagedRoles()}>
                  {(role) => (
                    <tr class="border-b border-border/50 hover:bg-muted/20">
                      <Show when={isVisible('name')}><td data-column-order-id="name#0" class="px-3 py-2 font-medium">{role.name}</td></Show>
                      <Show when={isVisible('description')}><td data-column-order-id="description#0" class="px-3 py-2 text-muted">{role.description || '—'}</td></Show>
                      <Show when={isVisible('permissions')}><td data-column-order-id="permissions#0" class="px-3 py-2"><span class="badge">{role.permissions.length} / {permissionCount()}</span></td></Show>
                      <Show when={isVisible('type')}><td data-column-order-id="type#0" class="px-3 py-2">
                        <Show when={role.is_system}><span class="badge badge-info">System</span></Show>
                        <Show when={!role.is_system}><span class="badge">Custom</span></Show>
                      </td></Show>
                      <td data-column-fixed="actions" data-column-order-id="actions#0" class="px-3 py-2">
                        <div class="flex gap-1 justify-end">
                          <Show when={!role.is_system}>
                            <Show when={canWrite()}><button type="button" class="btn btn-ghost btn-sm" onClick={() => openEditRole(role)} title="Edit role"><Pencil size={14} /></button></Show>
                            <Show when={can('settings.users.roles', 'delete')}><button type="button" class="btn btn-ghost btn-sm text-destructive" onClick={() => handleDeleteRole(role)} title="Delete role"><Trash2 size={14} /></button></Show>
                          </Show>
                        </div>
                      </td>
                      <td data-column-fixed="visibility" data-column-order-id="__visibility#0"></td>
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
                  <p class="text-xs text-muted mt-0.5">{roleForm().permissions.length} of {permissionCount()} selected</p>
                </div>
                <span class="text-xs text-muted">Choose a section, then select its access</span>
              </div>
              <Show when={catalog.error}><ResourceError title="Permission catalog unavailable" description="Retry loading the role editor." /></Show>
              <p class="text-xs text-muted mb-3">Permissions apply to the entire named section and its subtabs. CPE overview is independent of CPE inventory. Full grants every operation in its section; other actions require Read.</p>
              <div class="overflow-x-auto max-h-[55vh]">
                <table data-column-order-key="role-permissions" data-column-order-legacy-schema="table::delete|edit|export|full|import|read|section / tab" class="data-table w-full text-sm">
                  <thead class="sticky top-0 opaque-table-header"><tr>
                    <th data-column-order-id="section#0" class="text-left p-3">Section / tab</th>
                    <For each={PERMISSION_ACTIONS}>{action => <th data-column-order-id={`${action}#0`} class="text-center p-3">{action[0].toUpperCase() + action.slice(1)}</th>}</For>
                  </tr></thead>
                  <tbody><For each={sections()}>{section => <tr class="border-b border-subtle">
                    <td data-column-order-id="section#0" class="p-3"><span class={section.parent ? 'text-secondary' : 'font-semibold text-primary'}>{section.label}</span><Show when={section.parent}><span class="block text-xs text-muted">{section.parent?.split('.').map((_, index, parts) => sections().find(item => item.id === parts.slice(0, index + 1).join('.'))?.label).filter(Boolean).join(' / ')}</span></Show></td>
                    <For each={PERMISSION_ACTIONS}>{action => <td data-column-order-id={`${action}#0`} class="p-3 text-center">
                      <Show when={section.actions.includes(action)} fallback={<span class="text-muted" aria-label="Not applicable">—</span>}><input type="checkbox" class="checkbox" aria-label={`${section.label} (${section.id}): ${action}`} checked={canSection(roleForm().permissions, section.id, action)} disabled={pendingAction() !== null || catalog.loading || !can(section.id, action) || (action !== 'full' && roleForm().permissions.includes(`access.${section.id}.full`))} onChange={() => togglePermission(section.id, action)} /></Show>
                    </td>}</For>
                  </tr>}</For></tbody>
                </table>
              </div>
            </div>
            <div class="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowRoleModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}><X size={14} /> Cancel</button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null || catalog.loading || !!catalog.error}>{pendingAction() ? 'Saving…' : editingRole() ? 'Update role' : 'Create role'}</button>
            </div>
          </form>
        </Dialog>
      </Show>
    </div>
  );
};

export default RolesTab;
