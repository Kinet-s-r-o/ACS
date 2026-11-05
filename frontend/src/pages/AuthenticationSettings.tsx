import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { ChevronRight, Network } from 'lucide-solid';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../lib/auth';

const AUTHENTICATION_MODULES = [
  {
    id: 'radius',
    name: 'RADIUS',
    description: 'Verify operator credentials through external RADIUS servers with redundancy.',
    protocols: 'UDP · TLS (RadSec)',
    href: '/settings/authentication/radius',
    section: 'settings.authentication.radius',
    icon: Network,
  },
];

const AuthenticationSettings: Component = () => {
  const { canVisit } = useAuth();

  return (
    <div class="space-y-5">
      <PageHeader title="Authentication" description="Choose how ACS verifies operator credentials. Roles and account access remain managed in ACS." />
      <Show when={canVisit('settings.authentication')} fallback={<p class="text-muted">You need authentication settings read permission to view this page.</p>}>
        <div class="card p-5">
          <h2 class="text-sm font-medium text-secondary">Authentication methods</h2>
          <p class="text-muted text-xs mt-1 mb-4">Select a method to view and manage its configuration.</p>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <For each={AUTHENTICATION_MODULES.filter(module => canVisit(module.section))}>{module => (
              <A href={module.href} class="rounded border border-subtle p-4 hover:border-primary/30 transition-colors flex flex-col gap-3" aria-labelledby={`authentication-${module.id}`}>
                <div class="flex items-center gap-2">
                  <module.icon size={16} class="text-secondary shrink-0" aria-hidden="true" />
                  <h3 id={`authentication-${module.id}`} class="text-sm font-medium text-primary">{module.name}</h3>
                </div>
                <p class="text-xs text-muted">{module.description}</p>
                <p class="text-xs text-secondary">{module.protocols}</p>
                <span class="flex items-center justify-between gap-2 text-xs text-primary mt-auto">Open settings<ChevronRight size={14} aria-hidden="true" /></span>
              </A>
            )}</For>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default AuthenticationSettings;
