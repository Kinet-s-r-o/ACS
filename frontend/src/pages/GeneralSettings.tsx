import type { Component } from 'solid-js';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import { Plus, Save, Settings as SettingsIcon, Trash2 } from 'lucide-solid';
import { api, type DashboardAggregationOption } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { useFeedback } from '../components/Feedback';
import { ResourceError } from '../components/ResourceState';
import { useAuth } from '../lib/auth';
import { initAppName } from '../lib/appName';
import { updateUITransitionSettings, type UITransitionStyle } from '../lib/uiTransitions';

const GeneralSettings: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify } = useFeedback();
  const [settings, { refetch }] = createResource(() => api.getSettings());
  const [formData, setFormData] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const [activeSection, setActiveSection] = createSignal<'general' | 'ui' | 'aggregations'>('general');
  const [aggregationOptions, setAggregationOptions] = createSignal<DashboardAggregationOption[]>([]);

  createEffect(() => {
    const raw = settings()?.fleet_aggregation_options;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as DashboardAggregationOption[];
      setAggregationOptions(Array.isArray(parsed) ? parsed : []);
    } catch {
      setAggregationOptions([]);
    }
  });

  const getValue = (key: string) => {
    const defaults: Record<string, string> = { ui_transitions_enabled: 'false', ui_transition_style: 'fade-slide', ui_transition_duration: '250' };
    return formData()[key] ?? settings()?.[key] ?? defaults[key] ?? '';
  };

  const handleLogoUpload = async (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      notify({ tone: 'error', title: 'Unsupported logo', message: 'Choose a PNG, JPEG, or WebP image smaller than 10 MiB.' });
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(320 / bitmap.width, 96 / bitmap.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing is not available in this browser.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const logo = canvas.toDataURL('image/webp', 0.85);
      const size = Math.ceil((logo.length - logo.indexOf(',') - 1) * 0.75);
      if (size > 128 * 1024) throw new Error('The resized logo exceeds the 128 KiB limit. Choose a simpler or smaller image.');
      setFormData(previous => ({ ...previous, app_logo: logo }));
    } catch (error) {
      notify({ tone: 'error', title: 'Logo could not be processed', message: (error as Error).message });
    }
  };

  const handleSave = async () => {
    const pageSize = parseInt(getValue('default_page_size'), 10);
    if (isNaN(pageSize) || pageSize < 5 || pageSize > 500) {
      notify({ tone: 'error', title: 'Invalid value', message: 'Default page size must be between 5 and 500.' });
      return;
    }
    const appName = getValue('app_name').trim();
    if (!appName || appName.length > 64) {
      notify({ tone: 'error', title: 'Invalid value', message: 'Application name must be 1–64 characters.' });
      return;
    }
    const autoRefreshInterval = parseInt(getValue('auto_refresh_interval') || '30', 10);
    if (isNaN(autoRefreshInterval) || (autoRefreshInterval !== 0 && (autoRefreshInterval < 15 || autoRefreshInterval > 3600))) {
      notify({ tone: 'error', title: 'Invalid value', message: 'Automatic refresh must be disabled or between 15 seconds and 60 minutes.' });
      return;
    }
    const showPoints = getValue('chart_show_points') !== 'false' ? 'true' : 'false';
    setSaving(true);
    try {
      await api.updateSettings({ default_page_size: String(pageSize), chart_show_points: showPoints, app_name: appName, app_logo: getValue('app_logo'), auto_refresh_interval: String(autoRefreshInterval) });
      initAppName();
      notify({ tone: 'success', title: 'Settings saved', message: 'General settings have been updated.' });
      refetch();
      setFormData(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key.startsWith('ui_'))));
    } catch (err) {
      notify({ tone: 'error', title: 'Settings were not saved', message: 'The previous configuration remains active. Review the fields and retry.', detail: (err as Error).message, persistent: true });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveUISettings = async () => {
    const enabled = getValue('ui_transitions_enabled') === 'true';
    const style = getValue('ui_transition_style');
    const duration = getValue('ui_transition_duration');
    setSaving(true);
    try {
      await api.updateSettings({ ui_transitions_enabled: String(enabled), ui_transition_style: style, ui_transition_duration: duration });
      updateUITransitionSettings({ enabled, style: style as UITransitionStyle, duration: Number(duration) });
      notify({ tone: 'success', title: 'UI settings saved', message: 'Animated transitions have been updated.' });
      refetch();
      setFormData(previous => {
        const next = { ...previous };
        delete next.ui_transitions_enabled;
        delete next.ui_transition_style;
        delete next.ui_transition_duration;
        return next;
      });
    } catch (err) {
      notify({ tone: 'error', title: 'UI settings were not saved', message: 'The previous animation settings remain active. Review the fields and retry.', detail: (err as Error).message, persistent: true });
    } finally {
      setSaving(false);
    }
  };

  const addAggregationOption = () => setAggregationOptions((current) => [...current, {
    id: `aggregation-${crypto.randomUUID()}`,
    title: '',
    parameter_pattern: '',
  }]);

  const updateAggregationOption = (id: string, field: 'title' | 'parameter_pattern', value: string) => setAggregationOptions((current) => current.map((option) => option.id === id ? { ...option, [field]: value } : option));

  const saveAggregationOptions = async () => {
    const options = aggregationOptions().map((option) => ({ ...option, title: option.title.trim(), parameter_pattern: option.parameter_pattern.trim() }));
    if (options.some((option) => !option.title || !option.parameter_pattern)) {
      notify({ tone: 'error', title: 'Complete each aggregation option', message: 'Every option needs a name and a CWMP parameter path.' });
      return;
    }
    setSaving(true);
    try {
      await api.updateSettings({ fleet_aggregation_options: JSON.stringify(options) });
      setAggregationOptions(options);
      refetch();
      notify({ tone: 'success', title: 'Aggregation options saved', message: 'Operators can now select these options when creating Fleet panels.' });
    } catch (error) {
      notify({ tone: 'error', title: 'Aggregation options were not saved', message: 'The previous options remain active.', detail: (error as Error).message, persistent: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="space-y-5">
      <PageHeader title="General" description="System-wide defaults and general configuration." />

      <div class="card p-5">
        <div class="mb-5 flex gap-1 border-b border-subtle" role="tablist" aria-label="General settings sections">
          <button type="button" role="tab" aria-selected={activeSection() === 'general'} onClick={() => setActiveSection('general')} class={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeSection() === 'general' ? 'border-sky-400 text-sky-300' : 'border-transparent text-muted hover:text-primary'}`}>General</button>
          <button type="button" role="tab" aria-selected={activeSection() === 'ui'} onClick={() => setActiveSection('ui')} class={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeSection() === 'ui' ? 'border-sky-400 text-sky-300' : 'border-transparent text-muted hover:text-primary'}`}>UI settings</button>
          <button type="button" role="tab" aria-selected={activeSection() === 'aggregations'} onClick={() => setActiveSection('aggregations')} class={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeSection() === 'aggregations' ? 'border-sky-400 text-sky-300' : 'border-transparent text-muted hover:text-primary'}`}>Fleet aggregations</button>
        </div>
        <Show when={activeSection() === 'general'}>
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
            <div>
              <label for="app-logo" class="block text-xs text-muted mb-1.5">Application logo</label>
              <div class="flex flex-wrap items-center gap-3">
                <Show when={getValue('app_logo')} fallback={<span class="text-xs text-muted">Using the default logo.</span>}>
                  <img src={getValue('app_logo')} alt="Application logo preview" class="max-h-12 max-w-40 object-contain" />
                </Show>
                <input id="app-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoUpload} class="input max-w-xs text-xs" disabled={!isFullAccess()} />
                <Show when={getValue('app_logo')}>
                  <button type="button" class="btn btn-secondary text-xs" onClick={() => setFormData(previous => ({ ...previous, app_logo: '' }))} disabled={!isFullAccess()}>Remove logo</button>
                </Show>
              </div>
              <p class="text-[11px] text-muted mt-1">PNG, JPEG, or WebP. The logo is resized to at most 320 × 96 px and 128 KiB for the navigation menu.</p>
            </div>
            <div>
              <label for="default-page-size" class="block text-xs text-muted mb-1.5">Default pagination (rows per page)</label>
              <input
                id="default-page-size"
                type="number"
                min={5}
                max={500}
                value={getValue('default_page_size') || '20'}
                onInput={(e) => setFormData((prev) => ({ ...prev, default_page_size: e.currentTarget.value }))}
                placeholder="20"
                class="input w-32"
                disabled={!isFullAccess()}
              />
              <p class="text-[11px] text-muted mt-1">Applies to device lists, fault tables, provisioning rules, and other paginated views.</p>
            </div>
            <div>
              <label for="auto-refresh-interval" class="block text-xs text-muted mb-1.5">Device page automatic refresh</label>
              <select
                id="auto-refresh-interval"
                value={getValue('auto_refresh_interval') || '30'}
                onChange={(e) => setFormData((prev) => ({ ...prev, auto_refresh_interval: e.currentTarget.value }))}
                class="input w-48"
                disabled={!isFullAccess()}
              >
                <option value="0">Off</option>
                <option value="15">Every 15 seconds</option>
                <option value="30">Every 30 seconds</option>
                <option value="60">Every minute</option>
                <option value="120">Every 2 minutes</option>
                <option value="300">Every 5 minutes</option>
              </select>
              <p class="text-[11px] text-muted mt-1">Refreshes the open device page without reloading it, including its CWMP task badge.</p>
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
        </Show>
        <Show when={activeSection() === 'ui'}>
          <h2 class="text-sm font-medium text-secondary mb-2 flex items-center gap-2"><SettingsIcon size={14} />UI settings</h2>
          <p class="text-muted text-xs mb-4">Configure animated transitions between application pages and sections.</p>
          <Show when={settings.error}><ResourceError title="UI settings are unavailable" description="ACS could not read the current interface preferences. Retry before making changes." onRetry={() => refetch()} /></Show>
          <Show when={!settings.loading && !settings.error} fallback={settings.loading ? <div class="skeleton h-10 w-full" /> : undefined}>
            <div class="max-w-2xl space-y-5">
              <label class="flex items-start gap-3 rounded border border-subtle p-3">
                <input type="checkbox" class="mt-0.5" checked={getValue('ui_transitions_enabled') === 'true'} onChange={event => setFormData(previous => ({ ...previous, ui_transitions_enabled: String(event.currentTarget.checked) }))} disabled={!isFullAccess()} />
                <span><span class="block text-sm text-primary">Animated transitions</span><span class="mt-1 block text-xs text-muted">Animate navigation between application pages and tabbed sections.</span></span>
              </label>
              <div class="grid gap-4 sm:grid-cols-2">
                <label for="ui-transition-style" class="block text-xs text-muted">Transition style
                  <select id="ui-transition-style" class="input mt-1 w-full" value={getValue('ui_transition_style')} onChange={event => setFormData(previous => ({ ...previous, ui_transition_style: event.currentTarget.value }))} disabled={!isFullAccess() || getValue('ui_transitions_enabled') !== 'true'}>
                    <option value="fade">Fade</option><option value="slide">Slide</option><option value="fade-slide">Fade and slide</option>
                  </select>
                </label>
                <label for="ui-transition-duration" class="block text-xs text-muted">Transition duration
                  <select id="ui-transition-duration" class="input mt-1 w-full" value={getValue('ui_transition_duration')} onChange={event => setFormData(previous => ({ ...previous, ui_transition_duration: event.currentTarget.value }))} disabled={!isFullAccess() || getValue('ui_transitions_enabled') !== 'true'}>
                    <option value="150">Fast — 150 ms</option><option value="250">Standard — 250 ms</option><option value="400">Relaxed — 400 ms</option><option value="600">Slow — 600 ms</option>
                  </select>
                </label>
              </div>
              <div class="border-t border-subtle pt-4"><button type="button" onClick={() => void handleSaveUISettings()} disabled={saving() || !isFullAccess()} class="btn btn-primary"><Save size={14} />{saving() ? 'Saving settings…' : 'Save UI settings'}</button></div>
            </div>
          </Show>
        </Show>
        <Show when={activeSection() === 'aggregations'}>
          <h2 class="text-sm font-medium text-secondary mb-2 flex items-center gap-2"><SettingsIcon size={14} />Fleet aggregation options</h2>
          <p class="text-muted text-xs mb-4">Define named CWMP parameter dimensions. Fleet panels group the latest matching value per CPE and count each group in SQL. Existing panels keep their saved parameter path if an option is later changed or removed.</p>
          <Show when={settings.error}><ResourceError title="Aggregation settings are unavailable" description="ACS could not read the current Fleet aggregation options. Retry before making changes." onRetry={() => refetch()} /></Show>
          <Show when={!settings.loading && !settings.error} fallback={settings.loading ? <div class="skeleton h-10 w-full" /> : undefined}>
            <div class="space-y-3">
              <Show when={aggregationOptions().length === 0}><p class="rounded border border-subtle p-3 text-xs text-muted">No custom aggregation options are configured. The built-in manufacturer, product class, and access type options remain available.</p></Show>
              <For each={aggregationOptions()}>{(option) => <div class="grid gap-3 rounded border border-subtle p-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(18rem,2fr)_auto] sm:items-end">
                <label class="block text-xs text-muted">Option name<input class="input mt-1 w-full" maxlength={48} value={option.title} onInput={(event) => updateAggregationOption(option.id, 'title', event.currentTarget.value)} disabled={!isFullAccess()} placeholder="Region" /></label>
                <label class="block text-xs text-muted">CWMP parameter path<input class="input mt-1 w-full font-mono" maxlength={512} value={option.parameter_pattern} onInput={(event) => updateAggregationOption(option.id, 'parameter_pattern', event.currentTarget.value)} disabled={!isFullAccess()} placeholder="Device.DeviceInfo.X_VENDOR.Region" /><span class="mt-1 block">Use * for dynamic sections. Sensitive parameter names are excluded.</span></label>
                <button type="button" class="btn btn-secondary text-rose-400" onClick={() => setAggregationOptions((current) => current.filter((item) => item.id !== option.id))} disabled={!isFullAccess()} aria-label={`Remove ${option.title || 'unnamed'} aggregation option`}><Trash2 size={14} />Remove</button>
              </div>}</For>
              <div class="flex flex-wrap gap-2 pt-2">
                <button type="button" class="btn btn-secondary" onClick={addAggregationOption} disabled={!isFullAccess() || aggregationOptions().length >= 30}><Plus size={14} />Add aggregation option</button>
                <button type="button" class="btn btn-primary" onClick={() => void saveAggregationOptions()} disabled={!isFullAccess() || saving()}><Save size={14} />{saving() ? 'Saving…' : 'Save aggregation options'}</button>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default GeneralSettings;
