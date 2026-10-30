import type { ParentComponent } from 'solid-js';
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import {
  Activity, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, HardDrive, LayoutDashboard, LogOut,
  Menu, Router, Settings, ShieldCheck, X,
} from 'lucide-solid';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { APP_VERSION } from '../lib/version';
import { appName, appLogo } from '../lib/appName';
import ThemeSwitcher from './ThemeSwitcher';
import { enableTableColumnReordering } from '../lib/tableColumnReorder';
import { playUITransition, transitionSettingsFromAPI, updateUITransitionSettings } from '../lib/uiTransitions';

const navigation = [
  { section: 'Monitor', items: [
    { href: '/', label: 'Fleet status', icon: LayoutDashboard },
    { href: '/devices', label: 'CPE inventory', icon: Router },
    { href: '/tasks', label: 'CWMP tasks', icon: Activity },
    { href: '/faults', label: 'CWMP faults', icon: AlertTriangle },
  ] },
  { section: 'Control', items: [
    { href: '/firmwares', label: 'Firmware library', icon: HardDrive },
    { href: '/security', label: 'Access controls', icon: ShieldCheck, fullOnly: true },
    { href: '/settings', label: 'System settings', icon: Settings, children: [
      { href: '/settings/general', label: 'General' },
      { href: '/settings/retention', label: 'DB retention' },
      { href: '/settings/dictionaries', label: 'Dictionaries' },
      { href: '/settings/users', label: 'Users and Roles' },
      { href: '/settings/api-docs', label: 'API documentation' },
      { href: '/settings/delivery', label: 'Delivery & Connection' },
      { href: '/settings/provisioning', label: 'Provisioning' },
    ] },
  ] },
];

const pageNames: Record<string, string> = {
  '/': 'Fleet status',
  '/devices': 'CPE inventory',
  '/tasks': 'CWMP tasks',
  '/faults': 'Fault center',
  '/firmwares': 'Firmware library',
  '/security': 'Security center',
  '/settings': 'System settings',
  '/settings/general': 'General',
  '/settings/retention': 'DB retention',
  '/settings/dictionaries': 'Dictionaries',
  '/settings/users': 'Users and Roles',
  '/settings/api-docs': 'API documentation',
  '/settings/delivery': 'Delivery & Connection Request',
  '/settings/provisioning': 'Provisioning',
};

const Brand = () => (
  <div class="brand-lockup">
    <Show when={appLogo()} fallback={<div class="brand-mark" aria-hidden="true"><span /><span /><span /></div>}>
      <img class="brand-logo" src={appLogo()} alt="" />
    </Show>
    <div>
      <div class="brand-name">{appName()}</div>
      <div class="brand-subtitle">Independent CWMP control plane</div>
    </div>
  </div>
);

const Layout: ParentComponent = (props) => {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(localStorage.getItem('sidebar-collapsed') === 'true');
  const [desktopViewport, setDesktopViewport] = createSignal(window.matchMedia('(min-width: 1024px)').matches);
  const [apiOnline, setAPIOnline] = createSignal<boolean | null>(null);
  const [settingsExpanded, setSettingsExpanded] = createSignal(false);
  const [inventoryExpanded, setInventoryExpanded] = createSignal(false);
  const { user, logout, isFullAccess } = useAuth();
  let menuButton: HTMLButtonElement | undefined;
  let previousContentLocation = `${location.pathname}${location.search}`;

  createEffect(() => {
    const current = `${location.pathname}${location.search}`;
    if (current === previousContentLocation) return;
    previousContentLocation = current;
    requestAnimationFrame(playUITransition);
  });

  const checkHealth = async () => {
    try { await api.health(); setAPIOnline(true); } catch { setAPIOnline(false); }
  };
  onMount(() => {
    const disableTableColumnReordering = enableTableColumnReordering(() => location.pathname);
    void api.getSettings().then(values => updateUITransitionSettings(transitionSettingsFromAPI(values))).catch(() => {});
    const media = window.matchMedia('(min-width: 1024px)');
    const updateViewport = () => setDesktopViewport(media.matches);
    media.addEventListener('change', updateViewport);
    checkHealth();
    const timer = window.setInterval(checkHealth, 30_000);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && sidebarOpen()) {
        setSidebarOpen(false);
        menuButton?.focus();
      }
    };
    const animateSectionSwitch = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('button[role="tab"], .tab-btn, [data-ui-section]')) {
        window.setTimeout(() => requestAnimationFrame(playUITransition), 0);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('click', animateSectionSwitch);
    onCleanup(() => { disableTableColumnReordering(); window.clearInterval(timer); document.removeEventListener('keydown', closeOnEscape); document.removeEventListener('click', animateSectionSwitch); media.removeEventListener('change', updateViewport); });
  });

  const isSidebarCollapsed = () => sidebarCollapsed() && desktopViewport();
  const isActive = (href: string) => href === '/' ? location.pathname === '/' : location.pathname.startsWith(href);
  const operatorName = () => {
    const firstName = user()?.first_name?.trim();
    const lastName = user()?.last_name?.trim();
    return firstName && lastName ? `${firstName} ${lastName}` : user()?.username || '';
  };
  const operatorInitials = () => {
    const firstName = user()?.first_name?.trim();
    const lastName = user()?.last_name?.trim();
    return firstName && lastName
      ? `${firstName[0]}${lastName[0]}`.toUpperCase()
      : user()?.username?.slice(0, 2).toUpperCase() || '';
  };
  const pageTitle = () => location.pathname.startsWith('/device/') ? 'CPE record' : pageNames[location.pathname] || 'Control plane';

  return (
    <div class={`app-shell ${isSidebarCollapsed() ? 'is-sidebar-collapsed' : ''}`}>
      <Show when={sidebarOpen()}>
        <button class="sidebar-scrim lg:hidden" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      </Show>

      <aside class={`app-sidebar ${sidebarOpen() ? 'is-open' : ''} ${isSidebarCollapsed() ? 'is-collapsed' : ''}`}>
        <div class="sidebar-brand">
          <Brand />
          <button class="icon-button sidebar-collapse-toggle" aria-label={sidebarCollapsed() ? 'Expand navigation' : 'Collapse navigation'} title={sidebarCollapsed() ? 'Expand navigation' : 'Collapse navigation'} onClick={() => { const collapsed = !sidebarCollapsed(); setSidebarCollapsed(collapsed); localStorage.setItem('sidebar-collapsed', String(collapsed)); }}>{sidebarCollapsed() ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button>
          <button class="icon-button lg:hidden" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>

        <nav class="sidebar-nav" aria-label="Primary navigation">
          <For each={navigation}>
            {(group) => (
              <div class="nav-group">
                <p class="nav-section">{group.section}</p>
                <For each={group.items.filter((item) => !item.fullOnly || isFullAccess())}>
                  {(item) => (
                    <div>
                      <Show when={item.children}>
                          <Show when={!isSidebarCollapsed()} fallback={<A href={item.href} onClick={() => setSidebarOpen(false)} class={`nav-link nav-icon-link ${isActive(item.href) ? 'is-active' : ''}`} aria-label={item.label} title={item.label} aria-current={isActive(item.href) ? 'page' : undefined}><item.icon size={17} stroke-width={1.7} /></A>}>
                          <button
                          class={`nav-link nav-toggle ${isActive(item.href) ? 'is-active' : ''}`}
                          onClick={() => item.href === '/devices' ? setInventoryExpanded(!inventoryExpanded()) : setSettingsExpanded(!settingsExpanded())}
                          aria-expanded={item.href === '/devices' ? inventoryExpanded() : settingsExpanded()}
                        >
                          <item.icon size={17} stroke-width={1.7} />
                          <span>{item.label}</span>
                          <ChevronDown size={13} class={`nav-chevron-down ${(item.href === '/devices' ? inventoryExpanded() : settingsExpanded()) ? 'is-expanded' : ''}`} />
                        </button>
                        </Show>
                        <Show when={item.href === '/devices' ? inventoryExpanded() : settingsExpanded()}>
                          <div class="nav-submenu">
                            <For each={item.children ?? []}>
                              {(child) => (
                                <A href={child.href} onClick={() => setSidebarOpen(false)} class={`nav-link nav-link-sub ${isActive(child.href) ? 'is-active' : ''}`} aria-current={isActive(child.href) ? 'page' : undefined}>
                                  <span>{child.label}</span>
                                </A>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
                      <Show when={!item.children}>
                        <A href={item.href} onClick={() => setSidebarOpen(false)} class={`nav-link ${isSidebarCollapsed() ? 'nav-icon-link' : ''} ${isActive(item.href) ? 'is-active' : ''}`} aria-label={isSidebarCollapsed() ? item.label : undefined} title={isSidebarCollapsed() ? item.label : undefined} aria-current={isActive(item.href) ? 'page' : undefined}>
                          <item.icon size={17} stroke-width={1.7} />
                          <span>{item.label}</span>
                          <Show when={isActive(item.href)}><ChevronRight size={13} class="nav-chevron" /></Show>
                        </A>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </nav>

        <div class="sidebar-footer">
          <div class="operator-card">
            <div class="operator-avatar">{operatorInitials()}</div>
            <div class="operator-copy">
              <strong>{operatorName()}</strong>
              <span>{isFullAccess() ? 'Full access' : 'Read only'}</span>
            </div>
            <button class="icon-button" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
          </div>
          <div class="sidebar-meta"><span>{appName()}</span><span>v{APP_VERSION}</span></div>
        </div>
      </aside>

      <div class="app-main">
        <header class="topbar">
          <div class="topbar-title">
            <button ref={menuButton} class="icon-button lg:hidden" aria-label="Open navigation" aria-expanded={sidebarOpen()} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
            <div>
              <p>{appName()} <span>/</span></p>
              <h1>{pageTitle()}</h1>
            </div>
          </div>
          <div class="topbar-actions">
            <button type="button" class={`service-state ${apiOnline() === false ? 'is-down' : ''}`} onClick={checkHealth} aria-live="polite" aria-label="Refresh API service status">
              <Activity size={14} />
              <span>{apiOnline() === null ? 'Checking API' : apiOnline() ? 'API operational' : 'API unavailable'}</span>
            </button>
            <ThemeSwitcher />
          </div>
        </header>

        <main class="content-area">{props.children}</main>
      </div>
    </div>
  );
};

export default Layout;
