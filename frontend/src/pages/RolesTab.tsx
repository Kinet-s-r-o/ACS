import type { Component } from 'solid-js';
import { createResource, createSignal, Show, For } from 'solid-js';
import { Plus, Pencil, Trash2, X } from 'lucide-solid';
import { api, type Role } from '../lib/api';
import Dialog from '../components/Dialog';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { useAuth } from '../lib/auth';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import SortableHeader from '../components/SortableHeader';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import { createPersistedJsonSignal } from '../lib/storage';
import { sortRows, type SortDirection } from '../lib/sorting';

const PERMISSION_GROUPS: { label: string; read: string; write: string }[] = [
  { label: 'Users', read: 'users.read', write: 'users.write' },
  { label: 'Roles', read: 'roles.read', write: 'roles.write' },
  { label: 'Devices', read: 'devices.read', write: 'devices.write' },
  { label: 'Firmwares', read: 'firmwares.read', write: 'firmwares.write' },
  { label: 'Faults', read: 'faults.read', write: 'faults.write' },
  { label: 'Provisioning', read: 'provisioning.read', write: 'provisioning.write' },
  { label: 'Settings', read: 'settings.read', write: 'settings.write' },
  { label: 'Metrics', read: 'metrics.read', write: 'metrics.write' },
  { label: 'Security', read: 'security.read', write: 'security.write' },
];

const RolesTab: Component = () => {
  const { hasPermission } = useAuth();
  const { confirm, notify } = useFeedback();
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);

  const [roles, { refetch: refetchRoles }] = createResource(async () => {
    if (!hasPermission('roles.read')) return [];
    return api.getRoles();
  });
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.roles', {});
  const { columns, isVisible, toggle } = useColumnVisibility('roles', [
    { id: 'name', label: 'Name', visible: true },
    { id: 'description', label: 'Description', visible: true },
    { id: 'permissions', label: 'Permissions', visible: true },
    { id: 'type', label: 'Type', visible: true },
  ]);
  const [sortState, setSortState] = createSignal<{ column: string | null; direction: SortDirection }>({ column: 'name', direction: 'asc' });
  const handleSort = (column: string) => setSortState(current => ({ column, direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc' }));
  const getFilterValue = (role: Role, column: string): string => {
    switch (column) {
      case 'name': return role.name;
      case 'description': return role.description || '';
      case 'permissions': return `${role.permissions.length} / 18`;
      case 'type': return role.is_system ? 'System' : 'Custom';
      default: return '';
    }
  };
  const filteredRoles = () => applyColumnFilters(roles() || [], columnFilters(), getFilterValue);
  const sortedRoles = () => sortRows(filteredRoles(), sortState().column, sortState().direction, getFilterValue);
  const applyRoleFilter = (column: string, state: ColumnFilterState | null) => setColumnFilters(previous => {
    const next = { ...previous };
    if (state) next[column] = state;
    else delete next[column];
    return next;
  });

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
        <p class="text-sm text-muted">Define permission sets that can be assigned to users.</p>
        <Show when={canWrite()}>
          <button type="button" class="btn btn-primary" onClick={openCreateRole}>
            <Plus size={14} /> New Role
          </button>
        </Show>
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
                  <th class="px-3 py-2"></th>
                  <th class="px-2 py-2"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
                </tr>
              </thead>
              <tbody>
                <For each={sortedRoles()}>
                  {(role) => (
                    <tr class="border-b border-border/50 hover:bg-muted/20">
                      <Show when={isVisible('name')}><td class="px-3 py-2 font-medium">{role.name}</td></Show>
                      <Show when={isVisible('description')}><td class="px-3 py-2 text-muted">{role.description || '—'}</td></Show>
                      <Show when={isVisible('permissions')}><td class="px-3 py-2"><span class="badge">{role.permissions.length} / 18</span></td></Show>
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
        </Show>
        </Show>
        <Show when={(roles()?.length ?? 0) === 0}>
          <EmptyState compact title="No roles defined" description="Create a role to define a set of permissions." />
        </Show>
      </Show>

      <Show when={showRoleModal()}>
        <Dialog title={editingRole() ? 'Edit role' : 'New role'} description="Select the permissions this role grants." size="medium" onClose={() => { if (!pendingAction()) setShowRoleModal(false); }}>
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
              <div class="block text-xs text-muted mb-2">Permissions</div>
              <div class="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                <For each={PERMISSION_GROUPS}>
                  {(group) => (
                    <div class="space-y-1">
                      <p class="text-xs font-medium text-muted">{group.label}</p>
                      <label class="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={roleForm().permissions.includes(group.read)} onChange={() => togglePermission(group.read)} class="checkbox" />
                        <span>Read</span>
                      </label>
                      <label class="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={roleForm().permissions.includes(group.write)} onChange={() => togglePermission(group.write)} class="checkbox" />
                        <span>Write</span>
                      </label>
                    </div>
                  )}
                </For>
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
