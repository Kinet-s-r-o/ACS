import type { Component } from 'solid-js';
import { createResource, createSignal, Show } from 'solid-js';
import { Save, Settings as SettingsIcon } from 'lucide-solid';
import { api } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { ResourceError } from '../components/ResourceState';
import { useAuth } from '../lib/auth';

const GeneralSettings: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify } = useFeedback();
  const [settings, { refetch }] = createResource(() => api.getSettings());
  const [formData, setFormData] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);

  const getValue = (key: string) => {
    return formData()[key] ?? settings()?.[key] ?? '';
  };

  const handleSave = async () => {
    const pageSize = parseInt(getValue('default_page_size'), 10);
    if (isNaN(pageSize) || pageSize < 5 || pageSize > 100) {
      notify({ tone: 'error', title: 'Invalid value', message: 'Default page size must be between 5 and 100.' });
      return;
    }
    const appName = getValue('app_name').trim();
    if (!appName || appName.length > 64) {
      notify({ tone: 'error', title: 'Invalid value', message: 'Application name must be 1–64 characters.' });
      return;
    }
    const showPoints = getValue('chart_show_points') !== 'false' ? 'true' : 'false';
    setSaving(true);
    try {
      await api.updateSettings({ default_page_size: String(pageSize), chart_show_points: showPoints, app_name: appName });
      notify({ tone: 'success', title: 'Settings saved', message: 'General settings have been updated.' });
      refetch();
      setFormData({});
    } catch (err) {
      notify({ tone: 'error', title: 'Settings were not saved', message: 'The previous configuration remains active. Review the fields and retry.', detail: (err as Error).message, persistent: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="General" description="System-wide defaults and general configuration." />

      <div class="card p-5">
        <h2 class="text-sm font-medium text-secondary mb-4 flex items-center gap-2">
          <SettingsIcon size={14} />
          General
        </h2>
        <p class="text-muted text-xs mb-4">
          System-wide defaults applied across all list views.
        </p>

        <Show when={settings.error}>
          <ResourceError title="Settings are unavailable" description="ACS could not read the current general configuration. Retry before making changes." onRetry={() => refetch()} />
        </Show>

        <Show when={!settings.loading && !settings.error} fallback={settings.loading ? <div class="skeleton h-10 w-full" /> : undefined}>
          <div class="space-y-4">
            <div>
              <label for="default-page-size" class="block text-xs text-muted mb-1.5">Default pagination (rows per page)</label>
              <input
                id="default-page-size"
                type="number"
                min={5}
                max={100}
                value={getValue('default_page_size') || '20'}
                onInput={(e) => setFormData((prev) => ({ ...prev, default_page_size: e.currentTarget.value }))}
                placeholder="20"
                class="input w-32"
                disabled={!isFullAccess()}
              />
              <p class="text-[11px] text-muted mt-1">Applies to device lists, fault tables, provisioning rules, and other paginated views.</p>
            </div>
            <div>
              <label for="app-name" class="block text-xs text-muted mb-1.5">Application name</label>
              <input
                id="app-name"
                type="text"
                value={getValue('app_name') || 'ACS'}
                onInput={(e) => setFormData((prev) => ({ ...prev, app_name: e.currentTarget.value }))}
                placeholder="ACS"
                maxlength={64}
                class="input w-48"
                disabled={!isFullAccess()}
              />
              <p class="text-[11px] text-muted mt-1">Brand name shown in the header, footer, login page, and browser tab.</p>
            </div>
            <div class="flex items-center justify-between pt-4 border-t border-subtle">
              <div>
                <span class="block text-xs text-muted">Show data points in charts</span>
                <p class="text-xs text-muted mt-0.5">Display markers on metric chart lines. Turn off for a line-only view.</p>
              </div>
              <button
                onClick={() => setFormData((prev) => ({ ...prev, chart_show_points: getValue('chart_show_points') !== 'false' ? 'false' : 'true' }))}
                class={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  getValue('chart_show_points') !== 'false'
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                    : 'bg-zinc-700 text-secondary border border-zinc-600'
                }`}
                disabled={!isFullAccess()}
                aria-pressed={getValue('chart_show_points') !== 'false'}
              >
                {getValue('chart_show_points') !== 'false' ? 'On' : 'Off'}
              </button>
            </div>
          </div>

          <div class="mt-6 pt-4 border-t border-subtle">
            <button
              onClick={handleSave}
              disabled={saving() || !isFullAccess()}
              class="btn btn-primary"
            >
              <Save size={14} />
              {saving() ? 'Saving settings\u2026' : 'Save general settings'}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default GeneralSettings;
