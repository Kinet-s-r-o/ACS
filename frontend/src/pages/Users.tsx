import type { Component } from 'solid-js';
import { createResource, createSignal, createMemo, Show, For } from 'solid-js';
import { Users, ShieldCheck, Trash2, Edit2, Plus, Search, X } from 'lucide-solid';
import { api, type User } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Dialog from '../components/Dialog';
import { useFeedback } from '../components/Feedback';
import { EmptyState, ResourceError } from '../components/ResourceState';
import { useAuth } from '../lib/auth';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import { useColumnVisibility } from '../lib/useColumnVisibility';
import RolesTab from './RolesTab';
import { createPersistedJsonSignal, createPersistedSignal } from '../lib/storage';
import { formatDateTime } from '../lib/dateTime';

const UsersPage: Component = () => {
  const { hasPermission, isFullAccess } = useAuth();
  const { confirm, notify } = useFeedback();
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal<'users' | 'roles'>('users');

  const [users, { refetch: refetchUsers }] = createResource(async () => {
    if (!hasPermission('users.read')) return [];
    return api.getUsers();
  });
  const [roles, { refetch: refetchRoles }] = createResource(async () => {
    if (!hasPermission('roles.read')) return [];
    return api.getRoles();
  });

  const [showUserModal, setShowUserModal] = createSignal(false);
  const [editingUser, setEditingUser] = createSignal<User | null>(null);
  const [userForm, setUserForm] = createSignal({ username: '', firstName: '', lastName: '', email: '', password: '', role: 'read' as 'full' | 'read', roleId: '' });
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.users', {});
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.users');
  const { columns, isVisible, toggle } = useColumnVisibility('users', [
    { id: 'username', label: 'Username', visible: true },
    { id: 'first_name', label: 'First name', visible: true },
    { id: 'last_name', label: 'Last name', visible: true },
    { id: 'email', label: 'Email', visible: true },
    { id: 'role', label: 'Role', visible: true },
    { id: 'last_login', label: 'Last Login', visible: true },
  ]);
  const [userPage, setUserPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('users', 15);
  const handlePageSizeChange = (size: number) => { changePageSize(size); setUserPage(0); };

  const getFilterValue = (user: User, colId: string): string => {
    switch (colId) {
      case 'username': return user.username || '';
      case 'first_name': return user.first_name || '';
      case 'last_name': return user.last_name || '';
      case 'email': return user.email || '';
      case 'role': return roleName(user);
      case 'last_login': return user.last_login || '';
      default: return '';
    }
  };

  const filteredUsers = createMemo(() => {
    let all = users() || [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      all = all.filter(u =>
        u.username?.toLowerCase().includes(query) ||
        u.first_name?.toLowerCase().includes(query) ||
        u.last_name?.toLowerCase().includes(query) ||
        u.email?.toLowerCase().includes(query) ||
        roleName(u).toLowerCase().includes(query)
      );
    }
    return applyColumnFilters(all, columnFilters(), getFilterValue);
  });
  const pagedUsers = createMemo(() => {
    const all = filteredUsers();
    const start = userPage() * pageSize();
    return all.slice(start, start + pageSize());
  });
  const userTotalPages = createMemo(() => Math.ceil(filteredUsers().length / pageSize()));
  const roleName = (user: User) => roles()?.find(role => role.id === user.role_id)?.name ?? (user.role === 'full' ? 'admin' : 'viewer');
  const systemRoleId = (role: 'full' | 'read') => roles()?.find(item => item.name === (role === 'full' ? 'admin' : 'viewer'))?.id.toString() ?? '';
  const selectedRole = () => roles()?.find(role => role.id === Number(userForm().roleId));

  const handleCreateUser = async () => {
    if (pendingAction()) return;
    setPendingAction('create-user');
    try {
      const selected = selectedRole();
      await api.createUser({ username: userForm().username, first_name: userForm().firstName, last_name: userForm().lastName, email: userForm().email, password: userForm().password, role: selected?.name === 'admin' ? 'full' : 'read', role_id: Number(userForm().roleId) });
      notify({ tone: 'success', title: 'Operator account created', message: userForm().username });
      setShowUserModal(false);
      setUserForm({ username: '', firstName: '', lastName: '', email: '', password: '', role: 'read', roleId: '' });
      refetchUsers();
    } catch (error) { notify({ tone: 'error', title: 'Could not create operator', message: 'The operator account was not created. The entered values are preserved.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const handleUpdateUser = async () => {
    const u = editingUser();
    if (!u || pendingAction()) return;
    setPendingAction('update-user');
    const selected = selectedRole();
    const body: Partial<{ username: string; first_name: string; last_name: string; email: string; password: string; role: 'full' | 'read'; role_id: number }> = { username: userForm().username, first_name: userForm().firstName, last_name: userForm().lastName, email: userForm().email, role: selected?.name === 'admin' ? 'full' : 'read', role_id: Number(userForm().roleId) };
    if (userForm().password) body.password = userForm().password;
    try {
      await api.updateUser(u.id, body);
      notify({ tone: 'success', title: 'Operator account updated', message: userForm().username });
      setShowUserModal(false);
      setEditingUser(null);
      setUserForm({ username: '', firstName: '', lastName: '', email: '', password: '', role: 'read', roleId: '' });
      refetchUsers();
    } catch (error) { notify({ tone: 'error', title: 'Could not update operator', message: 'The existing account remains unchanged. The entered values are preserved.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const handleDeleteUser = async (id: number) => {
    if (!await confirm({ title: 'Delete operator account?', description: 'The operator will immediately lose access. Existing audit records remain attributed to the account.', confirmLabel: 'Delete operator', tone: 'danger' })) return;
    if (pendingAction()) return;
    setPendingAction(`delete-user-${id}`);
    try { await api.deleteUser(id); notify({ tone: 'success', title: 'Operator account deleted' }); refetchUsers(); }
    catch (error) { notify({ tone: 'error', title: 'Could not delete operator', message: 'The account remains active.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const openEditUser = (u: User) => {
    setEditingUser(u);
    setUserForm({ username: u.username, firstName: u.first_name || '', lastName: u.last_name || '', email: u.email || '', password: '', role: u.role, roleId: u.role_id?.toString() || systemRoleId(u.role) });
    setShowUserModal(true);
  };

  const openCreateUser = () => {
    setEditingUser(null);
    setUserForm({ username: '', firstName: '', lastName: '', email: '', password: '', role: 'read', roleId: systemRoleId('read') });
    setShowUserModal(true);
  };

  return (
    <div class="space-y-5">
      <PageHeader title="Users and Roles" description="Manage operator accounts and their access levels." />

      <div class="border-b border-subtle flex gap-1" role="tablist" aria-label="Users and roles">
        <button type="button" role="tab" aria-selected={activeTab() === 'users'} class={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 ${activeTab() === 'users' ? 'border-sky-400 text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => { setActiveTab('users'); void refetchRoles(); void refetchUsers(); }}><Users size={13} />Users</button>
        <button type="button" role="tab" aria-selected={activeTab() === 'roles'} class={`px-3 py-2 text-xs font-medium border-b-2 flex items-center gap-1.5 ${activeTab() === 'roles' ? 'border-sky-400 text-primary' : 'border-transparent text-muted hover:text-primary'}`} onClick={() => setActiveTab('roles')}><ShieldCheck size={13} />Roles</button>
      </div>

      <Show when={activeTab() === 'users'}>
      <div class="card overflow-hidden">
        <div class="table-panel-toolbar">
          <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
            <Users size={14} />
            Operator management
          </h2>
          <div class="flex items-center gap-2">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input type="text" value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)} placeholder="Search users…" class="input pl-9! w-48 text-sm" />
              <Show when={searchQuery()}>
                <button onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
              </Show>
            </div>
            <button onClick={openCreateUser} class="btn btn-primary text-xs py-1.5">
              <Plus size={12} />
              Add operator
            </button>
          </div>
        </div>

        <Show when={users.error}><ResourceError title="Operator accounts are unavailable" description="ACS could not read the account directory. Retry before changing access." onRetry={() => refetchUsers()} /></Show>
        <Show when={users.loading}><div class="space-y-3"><div class="skeleton h-8 w-full" /><div class="skeleton h-8 w-4/5" /></div></Show>
        <Show when={!users.loading && !users.error && (users()?.length ?? 0) > 0}>
          <div class="overflow-x-auto table-scroll"><table class="data-table w-full text-sm min-w-[900px]">
            <thead>
              <tr class="border-b border-subtle">
                <Show when={isVisible('username')}>
                  <th class="text-left py-2 text-xs text-muted font-medium">
                    <div class="flex items-center gap-1.5">Username
                      <ColumnFilter columnId="username" label="Username" active={columnFilters()['username'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['username'] = s; else delete n['username']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <Show when={isVisible('first_name')}><th class="text-left py-2 text-xs text-muted font-medium">First name</th></Show>
                <Show when={isVisible('last_name')}><th class="text-left py-2 text-xs text-muted font-medium">Last name</th></Show>
                <Show when={isVisible('email')}><th class="text-left py-2 text-xs text-muted font-medium">Email</th></Show>
                <Show when={isVisible('role')}>
                  <th class="text-left py-2 text-xs text-muted font-medium">
                    <div class="flex items-center gap-1.5">Role
                      <ColumnFilter columnId="role" label="Role" active={columnFilters()['role'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['role'] = s; else delete n['role']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <Show when={isVisible('last_login')}>
                  <th class="text-left py-2 text-xs text-muted font-medium">
                    <div class="flex items-center gap-1.5">Last Login
                      <ColumnFilter columnId="last_login" label="Last Login" active={columnFilters()['last_login'] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n['last_login'] = s; else delete n['last_login']; return n; }); }} />
                    </div>
                  </th>
                </Show>
                <th class="text-right py-2 text-xs text-muted font-medium">Actions</th>
                <th class="px-2 py-2"><ColumnVisibility columns={columns} onToggle={toggle} /></th>
              </tr>
            </thead>
            <tbody>
              <For each={pagedUsers()}>
                {(u) => (
                  <tr class="border-b border-subtle/50">
                    <Show when={isVisible('username')}><td class="py-2 text-primary">{u.username}</td></Show>
                    <Show when={isVisible('first_name')}><td class="py-2 text-primary">{u.first_name || '—'}</td></Show>
                    <Show when={isVisible('last_name')}><td class="py-2 text-primary">{u.last_name || '—'}</td></Show>
                    <Show when={isVisible('email')}><td class="py-2 text-secondary">{u.email || '—'}</td></Show>
                    <Show when={isVisible('role')}>
                      <td class="py-2">
                        <span class={`badge ${u.role_id?.toString() === systemRoleId('full') || (!u.role_id && u.role === 'full') ? 'badge-success' : 'badge-warning'}`}>
                          {roleName(u)}
                        </span>
                      </td>
                    </Show>
                    <Show when={isVisible('last_login')}>
                      <td class="py-2 text-muted text-xs">
                        <span title={u.last_login ? formatDateTime(u.last_login) : undefined}>{u.last_login ? formatDateTime(u.last_login) : 'Never'}</span>
                      </td>
                    </Show>
                    <td class="py-2 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button onClick={() => openEditUser(u)} class="icon-button" aria-label={`Edit operator ${u.username}`} disabled={pendingAction() !== null}>
                          <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDeleteUser(u.id)} class="icon-button" aria-label={`Delete operator ${u.username}`} disabled={pendingAction() !== null}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                    <td class="px-2 py-2"></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table></div>
          <div class="mt-3">
            <Pagination page={userPage()} totalPages={userTotalPages()} totalItems={filteredUsers().length} pageSize={pageSize()} onPageChange={setUserPage} storageKey="users" onPageSizeChange={handlePageSizeChange} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setUserPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setUserPage(0); }} />
          </div>
        </Show>
        <Show when={!users.loading && !users.error && (users()?.length ?? 0) === 0}><EmptyState compact title="No additional operators exist" description="Create a named operator account instead of sharing administrative credentials." action={<button type="button" class="btn btn-primary" onClick={openCreateUser}>Add operator</button>} /></Show>
      </div>
      </Show>

      <Show when={activeTab() === 'roles'}>
        <div class="card p-5"><RolesTab /></div>
      </Show>

      {/* User Modal */}
      <Show when={showUserModal()}>
        <Dialog title={editingUser() ? 'Edit operator' : 'Add operator'} description="Operator roles determine access to configuration and destructive CPE actions." size="small" onClose={() => { if (!pendingAction()) setShowUserModal(false); }}>
          <form class="space-y-4" onSubmit={(event) => { event.preventDefault(); void (editingUser() ? handleUpdateUser() : handleCreateUser()); }}>
            <div>
              <label for="operator-username" class="block text-xs text-muted mb-1.5">Username</label>
              <input
                id="operator-username"
                type="text"
                value={userForm().username}
                onInput={(e) => setUserForm(f => ({ ...f, username: e.currentTarget.value }))}
                class="input w-full"
                placeholder="Username"
                required
                maxlength={64}
              />
            </div>
            <div>
              <label for="operator-first-name" class="block text-xs text-muted mb-1.5">First name</label>
              <input id="operator-first-name" type="text" value={userForm().firstName} onInput={(e) => setUserForm(f => ({ ...f, firstName: e.currentTarget.value }))} class="input w-full" maxlength={100} />
            </div>
            <div>
              <label for="operator-last-name" class="block text-xs text-muted mb-1.5">Last name</label>
              <input id="operator-last-name" type="text" value={userForm().lastName} onInput={(e) => setUserForm(f => ({ ...f, lastName: e.currentTarget.value }))} class="input w-full" maxlength={100} />
            </div>
            <div>
              <label for="operator-email" class="block text-xs text-muted mb-1.5">Email</label>
              <input id="operator-email" type="email" value={userForm().email} onInput={(e) => setUserForm(f => ({ ...f, email: e.currentTarget.value }))} class="input w-full" maxlength={254} />
            </div>
            <div>
              <label for="operator-password" class="block text-xs text-muted mb-1.5">
                Password {editingUser() && '(leave blank to preserve the current password)'}
              </label>
              <input
                id="operator-password"
                type="password"
                value={userForm().password}
                onInput={(e) => setUserForm(f => ({ ...f, password: e.currentTarget.value }))}
                class="input w-full"
                placeholder="Password"
                minlength={12}
                required={!editingUser()}
              />
            </div>
            <div>
              <label for="operator-role" class="block text-xs text-muted mb-1.5">Role</label>
              <select
                id="operator-role"
                value={userForm().roleId}
                onChange={(e) => { const selected = roles()?.find(role => role.id === Number(e.currentTarget.value)); setUserForm(f => ({ ...f, roleId: e.currentTarget.value, role: selected?.name === 'admin' ? 'full' : 'read' })); }}
                class="input w-full"
                disabled={roles.loading || !!roles.error || !isFullAccess()}
                required
              >
                <option value="" disabled>Select a role</option>
                <For each={roles()}>{role => <option value={role.id}>{role.name}{role.is_system ? ' (System)' : ''}</option>}</For>
              </select>
            </div>
            <div class="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowUserModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>
                Cancel
              </button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
                {pendingAction() ? 'Saving operator…' : editingUser() ? 'Update operator' : 'Add operator'}
              </button>
            </div>
          </form>
        </Dialog>
      </Show>
    </div>
  );
};

export default UsersPage;
