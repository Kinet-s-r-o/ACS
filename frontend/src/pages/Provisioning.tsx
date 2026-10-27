import { createSignal, createEffect, createMemo, createResource, onMount, onCleanup, Show, For, Index, type Component } from 'solid-js';
import { Activity, Copy, Download, Edit, Edit2, GripVertical, Image as ImageIcon, ListChecks, MoreVertical, Plus, Save, Search, Settings as SettingsIcon, SlidersHorizontal, Trash2, Upload, Variable, X, ChevronLeft } from 'lucide-solid';
import { api, type InterfaceMetricDefinition, type MetricDefinition, type ProvisioningFeature, type ProvisioningFeatureControl, type ProvisioningObjectField, type ProvisioningRule, type ProvisioningTemplate, type ProvisioningVariable, type ProvisioningTransform } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFeedback } from '../components/Feedback';
import Dialog from '../components/Dialog';
import PageHeader from '../components/PageHeader';
import { EmptyState, ResourceError } from '../components/ResourceState';
import ColumnFilter from '../components/ColumnFilter';
import ColumnVisibility from '../components/ColumnVisibility';
import Pagination from '../components/Pagination';
import { applyColumnFilters, type ColumnFilterState } from '../lib/filters';
import { usePageSize } from '../lib/usePageSize';
import MetricModal from '../components/MetricModal';
import ColorSwatch from '../components/ColorSwatch';
import { ECHARTS_TYPES } from '../lib/echartsTypes';
import { createPersistedJsonSignal, createPersistedSignal, readMigratedStorageValue, writeMigratedStorageValue } from '../lib/storage';
import { useColumnVisibility } from '../lib/useColumnVisibility';

interface ProvColumnConfig {
  id: string;
  label: string;
  visible: boolean;
  order: number;
}

const defaultProvColumns: ProvColumnConfig[] = [
  { id: 'parameter', label: 'CWMP path', visible: true, order: 0 },
  { id: 'value', label: 'Value', visible: true, order: 1 },
  { id: 'parameter_type', label: 'Value type', visible: true, order: 2 },
  { id: 'tags', label: 'Tags', visible: true, order: 3 },
  { id: 'phase', label: 'Phase', visible: true, order: 4 },
  { id: 'status', label: 'Active', visible: true, order: 5 },
];

const metricTableColumns = [
  { id: 'name', label: 'Name', visible: true },
  { id: 'parameter', label: 'Parameter', visible: true },
  { id: 'source', label: 'Source', visible: true },
  { id: 'group', label: 'Group', visible: true },
  { id: 'active', label: 'Active', visible: true },
  { id: 'device_match', label: 'Device Match', visible: false },
  { id: 'unit', label: 'Unit', visible: false },
];
const interfaceMetricTableColumns = [
  { id: 'name', label: 'Name', visible: true },
  { id: 'parameter', label: 'Parameter pattern', visible: true },
  { id: 'type', label: 'Type', visible: true },
  { id: 'source', label: 'Source', visible: true },
  { id: 'unit_scale', label: 'Unit scale', visible: true },
  { id: 'group', label: 'Group + color', visible: true },
  { id: 'active', label: 'Active', visible: true },
  { id: 'chart', label: 'Chart', visible: true },
  { id: 'transform', label: 'Transform', visible: true },
  { id: 'multiplier', label: 'Multiplier', visible: true },
];
const featureTableColumns = [
  { id: 'label', label: 'Label', visible: true },
  { id: 'type', label: 'Type', visible: true },
  { id: 'parameter', label: 'CWMP parameter', visible: true },
  { id: 'input', label: 'Input', visible: true },
  { id: 'group', label: 'Collapsible box', visible: true },
];

const PROV_STORAGE_KEY = 'acs-prov-columns';
const LEGACY_PROV_STORAGE_KEY = 'skyacs-prov-columns';
type FeatureControlDraft = Omit<ProvisioningFeatureControl, 'options' | 'object_fields'> & { optionsText: string; objectFieldsText: string };
const featureSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
const parseObjectFieldOptions = (text: string): { options: string[]; option_labels?: Record<string, string> } => {
  const trimmed = text.trim();
  const equalsIndex = trimmed.indexOf('=');
  const isSingleCommaValue = equalsIndex > 0 && equalsIndex === trimmed.lastIndexOf('=') && trimmed.slice(0, equalsIndex).includes(',');
  const entries = trimmed.includes(';')
    ? trimmed.split(';').map(value => value.trim()).filter(Boolean)
    : isSingleCommaValue ? [trimmed] : trimmed.split(',').map(value => value.trim()).filter(Boolean);
  const optionLabels: Record<string, string> = {};
  const options = entries.map(option => {
    const separator = option.indexOf('=');
    if (separator < 0) return option;
    const value = option.slice(0, separator).trim();
    const label = option.slice(separator + 1).trim();
    if (value && label) optionLabels[value] = label;
    return value;
  }).filter(Boolean);
  return { options, option_labels: Object.keys(optionLabels).length ? optionLabels : undefined };
};

const Provisioning: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify, confirm } = useFeedback();
  const metricColumns = useColumnVisibility('provisioning-metrics', metricTableColumns);
  const interfaceMetricColumns = useColumnVisibility('provisioning-interface-metrics', interfaceMetricTableColumns);
  const featureColumns = useColumnVisibility('provisioning-features', featureTableColumns);

  const [provRules, setProvRules] = createSignal<Awaited<ReturnType<typeof api.getProvisioningRules>> | null>(null);
  const [provTemplates, setProvTemplates] = createSignal<ProvisioningTemplate[] | null>(null);
  const [selectedTemplate, setSelectedTemplate] = createSignal<ProvisioningTemplate | null>(null);
  const [provError, setProvError] = createSignal<Error | null>(null);
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [showSettingsMenu, setShowSettingsMenu] = createSignal(false);
  const [showFeatureMenu, setShowFeatureMenu] = createSignal(false);
  const [showSettingsModal, setShowSettingsModal] = createSignal(false);
  const [settingsLoading, setSettingsLoading] = createSignal(false);
  const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [refreshSettings, setRefreshSettings] = createSignal({ overview: '15m', full: '6h' });
  const [settingsInitialSnapshot, setSettingsInitialSnapshot] = createSignal('');
  let settingsMenu: HTMLDivElement | undefined;
  let featureMenu: HTMLDivElement | undefined;
  let provisioningImportInput: HTMLInputElement | undefined;
  const [showProvModal, setShowProvModal] = createSignal(false);
  const [editingProv, setEditingProv] = createSignal<ProvisioningRule | null>(null);
  const emptyProvisioningRule = { template_id: 0, parameter_name: '', parameter_value: '', parameter_type: 'string', phase: 'bootstrap', tags: [] as string[], excluded_tags: [] as string[], enabled: true, description: '', add_object_path: '', order: 0, condition: '' };
  const [provForm, setProvForm] = createSignal({ ...emptyProvisioningRule });
  const [provInitialSnapshot, setProvInitialSnapshot] = createSignal('');
  const [tagInput, setTagInput] = createSignal('');
  const [tagMode, setTagMode] = createSignal<'tags' | 'excluded_tags'>('tags');
  const addRuleTag = () => {
    const tag = tagInput().trim().toLowerCase();
    if (!tag) return;
    const mode = tagMode();
    const other = mode === 'tags' ? 'excluded_tags' : 'tags';
    setProvForm(f => ({ ...f, [mode]: [...new Set([...f[mode], tag])], [other]: f[other].filter(value => value !== tag) }));
    setTagInput('');
  };
  const [isAddObjectRule, setIsAddObjectRule] = createSignal(false);
  const [copyingProv, setCopyingProv] = createSignal(false);
  const [showTemplateModal, setShowTemplateModal] = createSignal(false);
  const [editingTemplate, setEditingTemplate] = createSignal<ProvisioningTemplate | null>(null);
  const [cloningTemplate, setCloningTemplate] = createSignal<ProvisioningTemplate | null>(null);
  const [templateForm, setTemplateForm] = createSignal({ name: '', manufacturer: '', product_class: '', description: '' });
  const [templateInitialSnapshot, setTemplateInitialSnapshot] = createSignal('');
  const [templateImageUrl, setTemplateImageUrl] = createSignal<string | null>(null);
  const [templateImageUploading, setTemplateImageUploading] = createSignal(false);
  let templateImageInput: HTMLInputElement | undefined;
  let templateImageObjectUrl: string | null = null;
  const [templateTab, setTemplateTab] = createSignal<'rules' | 'variables' | 'metrics' | 'features'>('rules');
  const [templateVariables, setTemplateVariables] = createSignal<ProvisioningVariable[]>([]);
  const [variablesSaving, setVariablesSaving] = createSignal(false);
  const [activeFeatureID, setActiveFeatureID] = createSignal('');
  const [featureEditorOpen, setFeatureEditorOpen] = createSignal(false);
  const [featureEditorPage, setFeatureEditorPage] = createSignal<'section' | 'control'>('section');
  const [editingFeatureID, setEditingFeatureID] = createSignal<string | null>(null);
  const [featureDraft, setFeatureDraft] = createSignal<ProvisioningFeature>({ id: '', name: '', description: '', controls: [] });
  const [featureInitialSnapshot, setFeatureInitialSnapshot] = createSignal('');
  const [featureDraggedControl, setFeatureDraggedControl] = createSignal<string | null>(null);
  const [featureEditorDraggedControl, setFeatureEditorDraggedControl] = createSignal<string | null>(null);
  const emptyControlDraft = (): FeatureControlDraft => ({ key: '', label: '', type: 'string', parameter: '', optionsText: '', objectFieldsText: '', enabled_value: '1', disabled_value: '0', group: '', description: '' });
  const [controlDraft, setControlDraft] = createSignal<FeatureControlDraft>(emptyControlDraft());
  const [controlInitialSnapshot, setControlInitialSnapshot] = createSignal('');
  const [editingControlKey, setEditingControlKey] = createSignal<string | null>(null);
  const [featuresSaving, setFeaturesSaving] = createSignal(false);
  createEffect(() => {
    const features = selectedTemplate()?.features || [];
    if (!features.some(feature => feature.id === activeFeatureID())) setActiveFeatureID(features[0]?.id || '');
  });
  const activeFeature = () => selectedTemplate()?.features?.find(feature => feature.id === activeFeatureID()) || selectedTemplate()?.features?.[0] || null;
  const [selectedFeatureControlKeys, setSelectedFeatureControlKeys] = createSignal<string[]>([]);
  const [selectionFeatureID, setSelectionFeatureID] = createSignal('');
  createEffect(() => {
    const featureID = `${selectedTemplate()?.id || ''}:${activeFeature()?.id || ''}`;
    if (featureID !== selectionFeatureID()) {
      setSelectionFeatureID(featureID);
      setSelectedFeatureControlKeys([]);
    }
  });
  const toggleFeatureControlSelection = (key: string) => setSelectedFeatureControlKeys(keys => keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key]);
  const selectAllFeatureControls = (feature: ProvisioningFeature, checked: boolean) => setSelectedFeatureControlKeys(checked ? feature.controls.map(control => control.key) : []);
  const [metrics, { refetch: refetchMetrics }] = createResource(() => selectedTemplate()?.id, (id) => api.getTemplateMetrics(id!));
  const [editingMetric, setEditingMetric] = createSignal<MetricDefinition | null>(null);
  const [copyingMetric, setCopyingMetric] = createSignal<MetricDefinition | null>(null);
  const [showMetricModal, setShowMetricModal] = createSignal(false);
  const [interfaceMetrics, { refetch: refetchInterfaceMetrics }] = createResource(() => selectedTemplate()?.id, (id) => api.getInterfaceMetrics(id!));
  const [editingInterfaceMetric, setEditingInterfaceMetric] = createSignal<InterfaceMetricDefinition | null>(null);
  const [showInterfaceMetricModal, setShowInterfaceMetricModal] = createSignal(false);
  const [interfaceMetricForm, setInterfaceMetricForm] = createSignal({ name: '', description: '', interface_type: 'wan' as 'wan' | 'lan', parameter_pattern: '', unit: 'bytes', source: 'active' as 'passive' | 'active' | 'universal', unit_scale: '', color: '', group: '', chart_type: 'line', transform: '', multiplier: 1, active: true });
  const [interfaceMetricInitialSnapshot, setInterfaceMetricInitialSnapshot] = createSignal('');

  const settingsDirty = () => settingsInitialSnapshot() !== '' && JSON.stringify(refreshSettings()) !== settingsInitialSnapshot();
  const provFormDirty = () => provInitialSnapshot() !== '' && JSON.stringify(provForm()) !== provInitialSnapshot();
  const templateFormDirty = () => templateInitialSnapshot() !== '' && JSON.stringify(templateForm()) !== templateInitialSnapshot();
  const featureDraftDirty = () => featureInitialSnapshot() !== '' && JSON.stringify(featureDraft()) !== featureInitialSnapshot();
  const controlDraftDirty = () => controlInitialSnapshot() !== '' && JSON.stringify(controlDraft()) !== controlInitialSnapshot();
  const featureEditorDirty = () => featureDraftDirty() || controlDraftDirty();
  const interfaceMetricDirty = () => interfaceMetricInitialSnapshot() !== '' && JSON.stringify(interfaceMetricForm()) !== interfaceMetricInitialSnapshot();

  const closeWithDirtyCheck = async (dirty: () => boolean, close: () => void, subject: string) => {
    if (dirty() && !await confirm({ title: `Discard unsaved ${subject} changes?`, description: 'The entered values have not been saved.', confirmLabel: 'Discard changes', tone: 'primary' })) return;
    close();
  };

  const exportProvisioningBackup = async () => {
    try {
      const blob = await api.exportProvisioning();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'acs-backup.json';
      link.click();
      URL.revokeObjectURL(url);
      notify({ tone: 'success', title: 'JSON backup exported' });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not export JSON backup', detail: (error as Error).message, persistent: true });
    }
  };

  const importProvisioningBackup = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text()) as Record<string, unknown>;
      const templates = Array.isArray(backup.templates) ? backup.templates.length : 0;
      if (!await confirm({ title: 'Import ACS JSON backup?', description: `The backup contains ${templates} template(s). Existing data will remain and imported templates will be added.`, confirmLabel: 'Import backup', tone: 'primary' })) return;
      setPendingAction('import-provisioning');
      const result = await api.importProvisioning(backup, 'append');
      await loadProvTemplates();
      notify({ tone: 'success', title: 'JSON backup imported', detail: `${result.templates} template(s) imported.` });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not import JSON backup', detail: (error as Error).message, persistent: true });
    } finally {
      setPendingAction(null);
    }
  };

  const provisioningPayload = (form: typeof emptyProvisioningRule) => {
    const base = isAddObjectRule()
      ? { ...form, parameter_name: '', parameter_value: '', parameter_type: 'string', add_object_path: form.parameter_name.trim() }
      : { ...form, add_object_path: '' };
    return base;
  };

  // Provisioning column visibility
  const [provColumns, setProvColumns] = createSignal<ProvColumnConfig[]>((() => {
    try {
      const stored = readMigratedStorageValue(localStorage, PROV_STORAGE_KEY, LEGACY_PROV_STORAGE_KEY);
      if (stored) {
        const saved = JSON.parse(stored) as Array<Partial<ProvColumnConfig>>;
        if (Array.isArray(saved)) {
          return defaultProvColumns.map(column => ({
            ...column,
            visible: typeof saved.find(item => item?.id === column.id)?.visible === 'boolean'
              ? saved.find(item => item?.id === column.id)!.visible!
              : column.visible,
          }));
        }
      }
    } catch { /* ignore */ }
    return [...defaultProvColumns];
  })());
  const [provDraggedRow, setProvDraggedRow] = createSignal<number | null>(null);
  const [columnFilters, setColumnFilters] = createPersistedJsonSignal<Record<string, ColumnFilterState>>('acs.filters.provisioning', {});
  const [searchQuery, setSearchQuery] = createPersistedSignal('acs.search.provisioning.rules');

  const getFilterValue = (rule: ProvisioningRule, colId: string): string => {
    switch (colId) {
      case 'parameter': return rule.add_object_path || rule.parameter_name || '';
      case 'value': return rule.add_object_path ? '' : rule.parameter_value || '';
      case 'parameter_type': return rule.parameter_type || '';
      case 'tags': return [...(rule.tags || []).map(tag => `contain: ${tag}`), ...(rule.excluded_tags || []).map(tag => `not-contain: ${tag}`)].join(', ');
      case 'phase': return rule.phase || '';
      case 'status': return rule.enabled ? 'Yes' : 'No';
      default: return '';
    }
  };

  const filteredProvRules = createMemo(() => {
    let all = provRules() ?? [];
    const query = searchQuery().toLowerCase().trim();
    if (query) {
      all = all.filter(r =>
        r.parameter_name?.toLowerCase().includes(query) ||
        r.parameter_value?.toLowerCase().includes(query) ||
        r.parameter_type?.toLowerCase().includes(query) ||
        [...(r.tags || []), ...(r.excluded_tags || [])].some(t => t.toLowerCase().includes(query)) ||
        r.phase?.toLowerCase().includes(query) ||
        r.description?.toLowerCase().includes(query) ||
        r.add_object_path?.toLowerCase().includes(query)
      );
    }
    return applyColumnFilters(all, columnFilters(), getFilterValue);
  });
  const [provPage, setProvPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('provisioning', 20);
  const handlePageSizeChange = (size: number) => { changePageSize(size); setProvPage(0); };
  const pagedProvRules = createMemo(() => {
    const all = filteredProvRules();
    const start = provPage() * pageSize();
    return all.slice(start, start + pageSize());
  });
  const provTotalPages = createMemo(() => Math.ceil(filteredProvRules().length / pageSize()));
  const provDragEnabled = createMemo(() => Object.keys(columnFilters()).length === 0);

  onMount(() => {
    loadProvTemplates();
    const closeMenu = (event: MouseEvent) => {
      if (!settingsMenu?.contains(event.target as Node)) setShowSettingsMenu(false);
      if (!featureMenu?.contains(event.target as Node)) setShowFeatureMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSettingsMenu(false);
        setShowFeatureMenu(false);
      }
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    onCleanup(() => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
      clearTemplateImagePreview();
    });
  });

  const loadProvTemplates = async () => {
    try {
      const templates = await api.getProvisioningTemplates();
      setProvTemplates(templates);
    } catch (error) {
      setProvError(error as Error);
    }
  };

  const loadProvRules = async () => {
    const templateId = selectedTemplate()?.id;
    try {
      const rules = await api.getProvisioningRules(templateId);
      setProvRules(rules);
    } catch (error) {
      setProvError(error as Error);
    }
  };

  const clearTemplateImagePreview = () => {
    if (templateImageObjectUrl) URL.revokeObjectURL(templateImageObjectUrl);
    templateImageObjectUrl = null;
    setTemplateImageUrl(null);
  };

  const loadTemplateImage = async (template: ProvisioningTemplate) => {
    clearTemplateImagePreview();
    if (!template.image_url) return;
    try {
      const blob = await api.getProvisioningTemplateImage(template.id);
      templateImageObjectUrl = URL.createObjectURL(blob);
      setTemplateImageUrl(templateImageObjectUrl);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not load device image', detail: (error as Error).message });
    }
  };

  const refetchProvRules = async () => {
    await loadProvRules();
  };

  const selectTemplate = (template: ProvisioningTemplate) => {
    setSelectedTemplate(template);
    setTemplateVariables(template.variables || []);
    setProvRules(null);
    setProvError(null);
    loadProvRules();
    void loadTemplateImage(template);
  };

  const backToTemplates = () => {
    clearTemplateImagePreview();
    setSelectedTemplate(null);
    setTemplateVariables([]);
    setProvRules(null);
    setProvError(null);
  };

  const handleTemplateImageSelected = async (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    const template = editingTemplate() || selectedTemplate();
    if (!file || !template) return;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      notify({ tone: 'error', title: 'Invalid device image', message: 'Use a JPEG, PNG, GIF, or WebP image up to 5 MB.' });
      if (templateImageInput) templateImageInput.value = '';
      return;
    }
    setTemplateImageUploading(true);
    try {
      const updated = await api.uploadProvisioningTemplateImage(template.id, file);
      setEditingTemplate(current => current?.id === updated.id ? updated : current);
      setSelectedTemplate(current => current?.id === updated.id ? updated : current);
      await loadTemplateImage(updated);
      await loadProvTemplates();
      notify({ tone: 'success', title: 'Device image uploaded' });
    } catch (error) {
      notify({ tone: 'error', title: 'Device image upload failed', detail: (error as Error).message, persistent: true });
    } finally {
      setTemplateImageUploading(false);
      if (templateImageInput) templateImageInput.value = '';
    }
  };

  const handleDeleteTemplateImage = async () => {
    const template = editingTemplate() || selectedTemplate();
    if (!template || !template.image_url || !await confirm({ title: 'Remove device image?', description: 'The image will be removed from this provisioning template.', confirmLabel: 'Remove image', tone: 'danger' })) return;
    setTemplateImageUploading(true);
    try {
      await api.deleteProvisioningTemplateImage(template.id);
      setEditingTemplate(current => current?.id === template.id ? { ...current, image_url: undefined } : current);
      setSelectedTemplate(current => current?.id === template.id ? { ...current, image_url: undefined } : current);
      clearTemplateImagePreview();
      await loadProvTemplates();
      notify({ tone: 'success', title: 'Device image removed' });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not remove device image', detail: (error as Error).message, persistent: true });
    } finally {
      setTemplateImageUploading(false);
    }
  };

  const openRefreshSettings = async () => {
    setShowSettingsMenu(false);
    setSettingsLoading(true);
    try {
      const settings = await api.getSettings();
      setRefreshSettings({
        overview: settings.overview_poll_interval || '15m',
        full: settings.full_tree_poll_interval || '6h',
      });
      setSettingsInitialSnapshot(JSON.stringify({ overview: settings.overview_poll_interval || '15m', full: settings.full_tree_poll_interval || '6h' }));
      setShowSettingsModal(true);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not load provisioning settings', detail: (error as Error).message, persistent: true });
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveRefreshSettings = async () => {
    if (settingsSaving()) return;
    setSettingsSaving(true);
    try {
      await api.updateSettings({
        overview_poll_interval: refreshSettings().overview.trim(),
        full_tree_poll_interval: refreshSettings().full.trim(),
      });
      setSettingsInitialSnapshot(JSON.stringify(refreshSettings()));
      setShowSettingsModal(false);
      notify({ tone: 'success', title: 'Provisioning settings saved' });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save provisioning settings', detail: (error as Error).message, persistent: true });
    } finally {
      setSettingsSaving(false);
    }
  };

  const closeSettingsModal = () => void closeWithDirtyCheck(settingsDirty, () => setShowSettingsModal(false), 'provisioning settings');

  createEffect(() => {
    const cols = provColumns();
    writeMigratedStorageValue(localStorage, PROV_STORAGE_KEY, LEGACY_PROV_STORAGE_KEY, JSON.stringify(cols));
  });

  const visibleProvColumns = () => provColumns().filter(c => c.visible).sort((a, b) => a.order - b.order);
  const closeProvModal = () => void closeWithDirtyCheck(provFormDirty, () => setShowProvModal(false), 'provisioning rule');
  const closeTemplateModal = () => void closeWithDirtyCheck(templateFormDirty, () => { setShowTemplateModal(false); setCloningTemplate(null); }, 'template');
  const closeFeatureEditor = () => void closeWithDirtyCheck(featureEditorDirty, () => setFeatureEditorOpen(false), 'feature');
  const closeInterfaceMetricModal = () => void closeWithDirtyCheck(interfaceMetricDirty, () => setShowInterfaceMetricModal(false), 'interface metric');

  const toggleProvColumn = (id: string) => {
    setProvColumns(cols => cols.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
  };

  const interfaceMetricCell = (def: InterfaceMetricDefinition, id: string) => {
    switch (id) {
      case 'name': return <td class="py-2 pr-3 text-primary">{def.name}</td>;
      case 'parameter': return <td class="w-[45%] py-2 pr-3 font-mono break-words [overflow-wrap:anywhere]">{def.parameter_pattern}</td>;
      case 'type': return <td class="py-2 pr-3 uppercase">{def.interface_type}</td>;
      case 'source': return <td class="py-2 pr-3"><span class={`badge ${def.source === 'active' ? 'badge-warning' : def.source === 'universal' ? 'badge-success' : ''}`}>{def.source}</span></td>;
      case 'unit_scale': return <td class="py-2 pr-3">{def.unit_scale || 'none'}</td>;
      case 'group': return <td class="py-2 pr-3"><div class="flex items-center gap-1.5"><span class="chart-color-swatch inline-block h-3 w-6 shrink-0 rounded-sm" data-dynamic-style="chart-color" style={{ '--chart-color': def.color || '#38bdf8' } as any} title={def.color || 'Default'} /><span>{def.group || '—'}</span></div></td>;
      case 'active': return <td class="py-2 pr-3 text-center"><span class={`badge ${def.active ? 'badge-success' : 'badge-muted'}`}>{def.active ? 'Yes' : 'No'}</span></td>;
      case 'chart': return <td class="py-2 pr-3">{def.chart_type || 'line'}</td>;
      case 'transform': return <td class="py-2 pr-3">{def.transform || 'raw'}</td>;
      case 'multiplier': return <td class="py-2 pr-3">{def.multiplier}</td>;
      default: return null;
    }
  };

  const handleRowDragStart = (e: DragEvent, id: number) => {
    setProvDraggedRow(id);
    e.dataTransfer?.setData('text/plain', String(id));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };

  const handleRowDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };

  const handleRowDrop = async (e: DragEvent, targetId: number) => {
    e.preventDefault();
    const sourceId = provDraggedRow();
    setProvDraggedRow(null);
    if (!sourceId || sourceId === targetId) return;
    const rules = provRules() ?? [];
    const sourceIdx = rules.findIndex(r => r.id === sourceId);
    const targetIdx = rules.findIndex(r => r.id === targetId);
    if (sourceIdx === -1 || targetIdx === -1) return;
    const reordered = [...rules];
    const [moved] = reordered.splice(sourceIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    setProvRules(reordered.map((r, i) => ({ ...r, order: i })));
    try {
      await api.reorderProvisioningRules(selectedTemplate()!.id, reordered.map(r => r.id));
      notify({ tone: 'success', title: 'Rules reordered' });
    } catch (error) {
      notify({ tone: 'error', title: 'Reorder failed', detail: (error as Error).message, persistent: true });
      refetchProvRules();
    }
  };

  // Provisioning handlers
  const handleCreateProv = async () => {
    if (pendingAction()) return;
    addRuleTag();
    const form = provForm();
    if (!form.parameter_name.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'CWMP path is required.' }); return; }
    if (!isAddObjectRule() && !form.parameter_value.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'Parameter value is required for parameter rules.' }); return; }
    setPendingAction('create-provisioning');
    try {
      const payload = provisioningPayload(form);
      await api.createProvisioningRule(payload);
      notify({ tone: 'success', title: 'Provisioning rule created', message: payload.add_object_path || payload.parameter_name });
      setShowProvModal(false);
      setProvForm({ ...emptyProvisioningRule });
      setIsAddObjectRule(false);
      setCopyingProv(false);
      refetchProvRules();
    } catch (error) { notify({ tone: 'error', title: 'Could not create provisioning rule', message: 'No rule was added. The entered values are preserved.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const handleUpdateProv = async () => {
    const p = editingProv();
    if (!p || pendingAction()) return;
    addRuleTag();
    const form = provForm();
    if (!form.parameter_name.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'CWMP path is required.' }); return; }
    if (!isAddObjectRule() && !form.parameter_value.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'Parameter value is required for parameter rules.' }); return; }
    setPendingAction('update-provisioning');
    try {
      const payload = provisioningPayload(form);
      await api.updateProvisioningRule(p.id, payload);
      notify({ tone: 'success', title: 'Provisioning rule updated', message: payload.add_object_path || payload.parameter_name });
      setShowProvModal(false);
      setEditingProv(null);
      refetchProvRules();
    } catch (error) { notify({ tone: 'error', title: 'Could not update provisioning rule', message: 'The existing rule remains unchanged. The entered values are preserved.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const handleDeleteProv = async (id: number) => {
    if (!await confirm({ title: 'Delete provisioning rule?', description: 'The rule will no longer run for future BOOTSTRAP sessions. Previously applied device values are not reverted.', confirmLabel: 'Delete rule', tone: 'danger' })) return;
    if (pendingAction()) return;
    setPendingAction(`delete-provisioning-${id}`);
    try { await api.deleteProvisioningRule(id); notify({ tone: 'success', title: 'Provisioning rule deleted' }); refetchProvRules(); }
    catch (error) { notify({ tone: 'error', title: 'Could not delete provisioning rule', message: 'The rule remains active.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const handleToggleProv = async (id: number, enabled: boolean) => {
    if (pendingAction()) return;
    setPendingAction(`toggle-provisioning-${id}`);
    try { await api.toggleProvisioningRule(id, enabled); notify({ tone: 'success', title: `Provisioning rule ${enabled ? 'enabled' : 'disabled'}` }); refetchProvRules(); }
    catch (error) { notify({ tone: 'error', title: 'Could not change rule state', message: 'The previous provisioning state remains active.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const openEditProv = (p: ProvisioningRule) => {
    setTagInput('');
    setTagMode('tags');
    setEditingProv(p);
    setCopyingProv(false);
    setIsAddObjectRule(Boolean(p.add_object_path));
    const next = { template_id: p.template_id, parameter_name: p.add_object_path || p.parameter_name, parameter_value: p.parameter_value, parameter_type: p.parameter_type, phase: p.phase || 'bootstrap', tags: p.tags || [], excluded_tags: p.excluded_tags || [], enabled: p.enabled, description: p.description || '', add_object_path: p.add_object_path || '', order: p.order, condition: p.condition || '' };
    setProvForm(next);
    setProvInitialSnapshot(JSON.stringify(next));
    setShowProvModal(true);
  };

  const openCreateProv = () => {
    setTagInput('');
    setTagMode('tags');
    setEditingProv(null);
    setCopyingProv(false);
    setIsAddObjectRule(false);
    const next = { ...emptyProvisioningRule, template_id: selectedTemplate()?.id || 0 };
    setProvForm(next);
    setProvInitialSnapshot(JSON.stringify(next));
    setShowProvModal(true);
  };

  const openCopyProv = (p: ProvisioningRule) => {
    setTagInput('');
    setTagMode('tags');
    setEditingProv(null);
    setCopyingProv(true);
    setIsAddObjectRule(Boolean(p.add_object_path));
    const next = { template_id: p.template_id, parameter_name: p.add_object_path || p.parameter_name, parameter_value: p.parameter_value, parameter_type: p.parameter_type, phase: p.phase || 'bootstrap', tags: p.tags || [], excluded_tags: p.excluded_tags || [], enabled: p.enabled, description: p.description || '', add_object_path: p.add_object_path || '', order: p.order, condition: p.condition || '' };
    setProvForm(next);
    setProvInitialSnapshot(JSON.stringify(next));
    setShowProvModal(true);
  };

  const openCreateTemplate = () => {
    setEditingTemplate(null);
    setCloningTemplate(null);
    const next = { name: '', manufacturer: '', product_class: '', description: '' };
    setTemplateForm(next);
    setTemplateInitialSnapshot(JSON.stringify(next));
    clearTemplateImagePreview();
    setShowTemplateModal(true);
  };

  const openEditTemplate = (t: ProvisioningTemplate) => {
    setCloningTemplate(null);
    setEditingTemplate(t);
    const next = { name: t.name, manufacturer: t.manufacturer || '', product_class: t.product_class || '', description: t.description || '' };
    setTemplateForm(next);
    setTemplateInitialSnapshot(JSON.stringify(next));
    void loadTemplateImage(t);
    setShowTemplateModal(true);
  };

  const openCloneTemplate = (template: ProvisioningTemplate) => {
    setEditingTemplate(null);
    setCloningTemplate(template);
    const next = { name: `${template.name} copy`, manufacturer: template.manufacturer || '', product_class: template.product_class || '', description: template.description || '' };
    setTemplateForm(next);
    setTemplateInitialSnapshot(JSON.stringify(next));
    clearTemplateImagePreview();
    setShowTemplateModal(true);
  };

  const handleCreateTemplate = async () => {
    if (pendingAction()) return;
    const form = templateForm();
    if (!form.name.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'Template name is required.' }); return; }
    setPendingAction('create-template');
    try {
      await api.createProvisioningTemplate({ name: form.name.trim(), manufacturer: form.manufacturer.trim(), product_class: form.product_class.trim(), description: form.description.trim() });
      notify({ tone: 'success', title: 'Template created', message: form.name.trim() });
      setShowTemplateModal(false);
      await loadProvTemplates();
    } catch (error) { notify({ tone: 'error', title: 'Could not create template', message: 'No template was added.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const handleCloneTemplate = async () => {
    const source = cloningTemplate();
    const form = templateForm();
    if (!source || pendingAction()) return;
    if (!form.name.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'Template name is required.' }); return; }
    setPendingAction('clone-template');
    try {
      const cloned = await api.cloneProvisioningTemplate(source.id, { name: form.name.trim(), manufacturer: form.manufacturer.trim(), product_class: form.product_class.trim(), description: form.description.trim() });
      notify({ tone: 'success', title: 'Template duplicated', message: `${source.name} was copied with its rules, metrics, features, variables, and device photo.` });
      setShowTemplateModal(false);
      setCloningTemplate(null);
      await loadProvTemplates();
      await refetchMetrics();
      selectTemplate(cloned);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not duplicate template', message: 'The source template was not changed.', detail: (error as Error).message, persistent: true });
    } finally { setPendingAction(null); }
  };

  const handleUpdateTemplate = async () => {
    const t = editingTemplate();
    if (!t || pendingAction()) return;
    const form = templateForm();
    if (!form.name.trim()) { notify({ tone: 'error', title: 'Missing field', message: 'Template name is required.' }); return; }
    setPendingAction('update-template');
    try {
      await api.updateProvisioningTemplate(t.id, { name: form.name.trim(), manufacturer: form.manufacturer.trim(), product_class: form.product_class.trim(), description: form.description.trim() });
      notify({ tone: 'success', title: 'Template updated', message: form.name.trim() });
      setShowTemplateModal(false);
      await loadProvTemplates();
    } catch (error) { notify({ tone: 'error', title: 'Could not update template', message: 'The template remains unchanged.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const updateTemplateVariable = (index: number, patch: Partial<ProvisioningVariable>) => {
    setTemplateVariables(previous => previous.map((variable, current) => current === index ? { ...variable, ...patch } : variable));
  };

  const updateVariableTransform = (variableIndex: number, stepIndex: number, patch: Partial<ProvisioningTransform>) => {
    setTemplateVariables(previous => previous.map((variable, current) => current !== variableIndex ? variable : {
      ...variable,
      steps: variable.steps.map((step, index) => index === stepIndex ? { ...step, ...patch } : step),
    }));
  };

  const setVariableHmacKeySource = (variableIndex: number, stepIndex: number, keySource: string) => {
    const step = templateVariables()[variableIndex]?.steps[stepIndex];
    const args: Record<string, string> = { ...step?.args, key_source: keySource };
    delete args.key_secret;
    updateVariableTransform(variableIndex, stepIndex, { args, key_configured: keySource === 'custom' ? step?.key_configured : false });
  };

  const addTemplateVariable = () => setTemplateVariables(previous => [...previous, { name: `variable_${previous.length + 1}`, source: '', steps: [] }]);

  const addVariableTransform = (variableIndex: number) => {
    setTemplateVariables(previous => previous.map((variable, current) => current === variableIndex
      ? { ...variable, steps: [...variable.steps, { function: 'trim', args: {} }] }
      : variable));
  };

  const saveTemplateVariables = async () => {
    const template = selectedTemplate();
    if (!template || variablesSaving()) return;
    setVariablesSaving(true);
    try {
      const updated = await api.updateProvisioningTemplate(template.id, {
        name: template.name,
        manufacturer: template.manufacturer,
        product_class: template.product_class,
        description: template.description || '',
        variables: templateVariables(),
      });
      setSelectedTemplate(updated);
      setTemplateVariables(updated.variables || []);
      await loadProvTemplates();
      notify({ tone: 'success', title: 'Variables saved', message: `Variables updated for ${template.name}.` });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save variables', detail: (error as Error).message, persistent: true });
    } finally { setVariablesSaving(false); }
  };

  const saveTemplateFeatures = async (features: ProvisioningFeature[]) => {
    const template = selectedTemplate();
    if (!template || featuresSaving()) return false;
    setFeaturesSaving(true);
    try {
      const result = await api.saveTemplateFeatures(template.id, features);
      setSelectedTemplate(current => current?.id === template.id ? { ...current, features: result.features } : current);
      setProvTemplates(current => current?.map(item => item.id === template.id ? { ...item, features: result.features } : item) || null);
      return true;
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save Features', detail: (error as Error).message, persistent: true });
      return false;
    } finally { setFeaturesSaving(false); }
  };

  const reorderFeatureControl = async (feature: ProvisioningFeature, targetKey: string) => {
    const sourceKey = featureDraggedControl();
    setFeatureDraggedControl(null);
    if (!sourceKey || sourceKey === targetKey) return;
    const controls = [...feature.controls];
    const sourceIndex = controls.findIndex(control => control.key === sourceKey);
    const targetIndex = controls.findIndex(control => control.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = controls.splice(sourceIndex, 1);
    controls.splice(targetIndex, 0, moved);
    if (await saveTemplateFeatures((selectedTemplate()?.features || []).map(item => item.id === feature.id ? { ...item, controls } : item))) {
      notify({ tone: 'success', title: 'Fields reordered' });
    }
  };

  const reorderFeatureDraftControl = (targetKey: string) => {
    const sourceKey = featureEditorDraggedControl();
    setFeatureEditorDraggedControl(null);
    if (!sourceKey || sourceKey === targetKey) return;
    setFeatureDraft(current => {
      const controls = [...current.controls];
      const sourceIndex = controls.findIndex(control => control.key === sourceKey);
      const targetIndex = controls.findIndex(control => control.key === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const [moved] = controls.splice(sourceIndex, 1);
      controls.splice(targetIndex, 0, moved);
      return { ...current, controls };
    });
  };

  const openFeatureEditor = (feature?: ProvisioningFeature, control?: ProvisioningFeatureControl, page: 'section' | 'control' = 'section') => {
    const next = feature ? { ...feature, controls: feature.controls.map(item => ({ ...item, options: [...(item.options || [])] })) } : { id: '', name: '', description: '', controls: [] };
    setEditingFeatureID(feature?.id || null);
    setFeatureDraft(next);
    setFeatureEditorPage(control || page === 'control' ? 'control' : 'section');
    setEditingControlKey(control?.key || null);
    const nextControl = control ? { ...control, optionsText: (control.options || []).join('\n'), objectFieldsText: (control.object_fields || []).map(field => [field.name, field.label, field.type, field.input, (field.options || []).map(option => `${option}=${field.option_labels?.[option] || option}`).join(';'), field.help || ''].join('|')).join('\n') } : emptyControlDraft();
    setControlEditorDraft(nextControl);
    setFeatureInitialSnapshot(JSON.stringify(next));
    setFeatureEditorOpen(true);
  };

  const setControlEditorDraft = (draft: FeatureControlDraft) => {
    setControlDraft(draft);
    setControlInitialSnapshot(JSON.stringify(draft));
  };

  const saveFeatureControlDraft = () => {
    const draft = controlDraft();
    const label = draft.label.trim();
    const parameter = draft.parameter.trim();
    if (!label || !parameter) {
      notify({ tone: 'error', title: 'Field name and CWMP parameter are required' });
      return;
    }
    const controls = featureDraft().controls;
    let key = editingControlKey() || featureSlug(label);
    if (!key) {
      notify({ tone: 'error', title: 'Field name must contain an English letter or number' });
      return;
    }
    const existingKeys = new Set(controls.filter(item => item.key !== editingControlKey()).map(item => item.key));
    const baseKey = key;
    for (let suffix = 2; existingKeys.has(key); suffix++) key = `${baseKey.slice(0, 60)}-${suffix}`;
    const options = draft.type === 'boolean' || draft.type === 'object' ? [] : draft.optionsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    let object_fields: ProvisioningObjectField[] | undefined;
    if (draft.type === 'object') {
      object_fields = draft.objectFieldsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const parts = line.split('|');
        const [name = '', fieldLabel = '', fieldType = 'string', input = 'input', optionText = ''] = parts;
        const help = parts.slice(5).join('|');
        const parsedOptions = parseObjectFieldOptions(optionText);
        return { name: name.trim(), label: fieldLabel.trim(), type: fieldType.trim() as ProvisioningObjectField['type'], input: input.trim() as ProvisioningObjectField['input'], help: help.trim() || undefined, ...parsedOptions };
      });
    }
    const next: ProvisioningFeatureControl = {
      key,
      label,
      type: draft.type,
      parameter,
      options,
      enabled_value: draft.type === 'boolean' ? ((draft.enabled_value || '').trim() || '1') : '',
      disabled_value: draft.type === 'boolean' ? ((draft.disabled_value || '').trim() || '0') : '',
      group: (draft.group || '').trim(),
      description: (draft.description || '').trim(),
      object_fields,
    };
    setFeatureDraft(current => ({ ...current, controls: editingControlKey() ? current.controls.map(item => item.key === editingControlKey() ? next : item) : [...current.controls, next] }));
    setFeatureEditorPage('section');
    setEditingControlKey(null);
  };

  const saveFeatureDraft = async (event: SubmitEvent) => {
    event.preventDefault();
    if (featureEditorPage() === 'control') {
      saveFeatureControlDraft();
      return;
    }
    const template = selectedTemplate();
    const draft = featureDraft();
    const name = draft.name.trim();
    const id = editingFeatureID() || featureSlug(name);
    if (!template || !name || !id) {
      notify({ tone: 'error', title: 'Enter a section name using English letters or numbers' });
      return;
    }
    if (!editingFeatureID() && (template.features || []).some(feature => feature.id === id)) {
      notify({ tone: 'error', title: 'A section with this name already exists' });
      return;
    }
    const feature = { ...draft, id, name, description: draft.description?.trim() || '' };
    const features = editingFeatureID()
      ? (template.features || []).map(item => item.id === editingFeatureID() ? feature : item)
      : [...(template.features || []), feature];
    if (await saveTemplateFeatures(features)) {
      setActiveFeatureID(id);
      setFeatureEditorOpen(false);
      notify({ tone: 'success', title: editingFeatureID() ? 'Feature section updated' : 'Feature section added' });
    }
  };

  const deleteFeatureControl = async (feature: ProvisioningFeature, key: string) => {
    if (await saveTemplateFeatures((selectedTemplate()?.features || []).map(item => item.id === feature.id ? { ...item, controls: item.controls.filter(control => control.key !== key) } : item))) {
      notify({ tone: 'success', title: 'Feature field deleted' });
    }
  };

  const deleteSelectedFeatureControls = async (feature: ProvisioningFeature) => {
    const selected = new Set(selectedFeatureControlKeys());
    const count = feature.controls.filter(control => selected.has(control.key)).length;
    if (!count || !await confirm({ title: `Delete ${count} selected fields?`, description: `These fields will be removed from the ${feature.name} section.`, confirmLabel: `Delete ${count} fields`, tone: 'danger' })) return;
    const controls = feature.controls.filter(control => !selected.has(control.key));
    if (await saveTemplateFeatures((selectedTemplate()?.features || []).map(item => item.id === feature.id ? { ...item, controls } : item))) {
      setSelectedFeatureControlKeys([]);
      notify({ tone: 'success', title: 'Selected fields deleted', message: `${count} fields removed from ${feature.name}.` });
    }
  };

  const copyFeatureControl = (feature: ProvisioningFeature, control: ProvisioningFeatureControl) => {
    const existingLabels = new Set(feature.controls.map(item => item.label.toLowerCase()));
    const baseLabel = `${control.label.slice(0, 118)} copy`;
    let label = baseLabel;
    for (let suffix = 2; existingLabels.has(label.toLowerCase()); suffix++) label = `${control.label.slice(0, 114)} copy ${suffix}`;
    openFeatureEditor(feature);
    setEditingControlKey(null);
    setControlDraft({
      ...control,
      key: '',
      label,
      parameter: '',
      optionsText: (control.options || []).join('\n'),
      objectFieldsText: (control.object_fields || []).map(field => [field.name, field.label, field.type, field.input, (field.options || []).map(option => `${option}=${field.option_labels?.[option] || option}`).join(';'), field.help || ''].join('|')).join('\n'),
    });
    setFeatureEditorPage('control');
    notify({ tone: 'info', title: 'Field copied', message: 'Enter a unique CWMP parameter path before saving.' });
  };

  const deleteTemplateFeature = async (featureID: string) => {
    const template = selectedTemplate();
    const feature = template?.features?.find(item => item.id === featureID);
    if (!template || !feature || !await confirm({ title: `Delete ${feature.name}?`, description: 'Devices matching this template will no longer show this feature.', confirmLabel: 'Delete feature', tone: 'danger' })) return;
    try {
      if (await saveTemplateFeatures(template.features!.filter(item => item.id !== featureID))) {
        setActiveFeatureID(template.features!.find(item => item.id !== featureID)?.id || '');
        notify({ tone: 'success', title: 'Feature section deleted' });
      }
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete feature', detail: (error as Error).message, persistent: true });
    }
  };

  const handleDeleteTemplate = async (id: number) => {
    if (!await confirm({ title: 'Delete provisioning template?', description: 'All rules in this template will be permanently deleted.', confirmLabel: 'Delete template', tone: 'danger' })) return;
    if (pendingAction()) return;
    setPendingAction(`delete-template-${id}`);
    try { await api.deleteProvisioningTemplate(id); notify({ tone: 'success', title: 'Template deleted' }); await loadProvTemplates(); if (selectedTemplate()?.id === id) backToTemplates(); }
    catch (error) { notify({ tone: 'error', title: 'Could not delete template', message: 'The template remains active.', detail: (error as Error).message, persistent: true }); }
    finally { setPendingAction(null); }
  };

  const templateMetrics = createMemo(() => metrics() || []);

  const openCreateMetric = () => {
    setEditingMetric(null);
    setCopyingMetric(null);
    setShowMetricModal(true);
  };

  const openEditMetric = (def: MetricDefinition) => {
    setCopyingMetric(null);
    setEditingMetric(def);
    setShowMetricModal(true);
  };

  const openCopyMetric = (def: MetricDefinition) => {
    setEditingMetric(null);
    setCopyingMetric(def);
    setShowMetricModal(true);
  };

  const openInterfaceMetric = (def: InterfaceMetricDefinition | null = null) => {
    setEditingInterfaceMetric(def);
    const next = def ? { name: def.name, description: def.description || '', interface_type: def.interface_type, parameter_pattern: def.parameter_pattern, unit: def.unit || '', source: def.source || 'active', unit_scale: def.unit_scale || '', color: def.color || '', group: def.group || '', chart_type: def.chart_type || 'line', transform: def.transform || '', multiplier: def.multiplier || 1, active: def.active } : { name: '', description: '', interface_type: 'wan' as 'wan' | 'lan', parameter_pattern: '', unit: 'bytes', source: 'active' as 'passive' | 'active' | 'universal', unit_scale: '', color: '', group: '', chart_type: 'line', transform: '', multiplier: 1, active: true };
    setInterfaceMetricForm(next);
    setInterfaceMetricInitialSnapshot(JSON.stringify(next));
    setShowInterfaceMetricModal(true);
  };

  const copyInterfaceMetric = (def: InterfaceMetricDefinition) => {
    setEditingInterfaceMetric(null);
    const next = { name: `${def.name} copy`, description: def.description || '', interface_type: def.interface_type, parameter_pattern: def.parameter_pattern, unit: def.unit || '', source: def.source || 'active', unit_scale: def.unit_scale || '', color: def.color || '', group: def.group || '', chart_type: def.chart_type || 'line', transform: def.transform || '', multiplier: def.multiplier || 1, active: def.active };
    setInterfaceMetricForm(next);
    setInterfaceMetricInitialSnapshot(JSON.stringify(next));
    setShowInterfaceMetricModal(true);
  };

  const saveInterfaceMetric = async (event: SubmitEvent) => {
    event.preventDefault();
    const template = selectedTemplate();
    if (!template) return;
    try {
      const form = interfaceMetricForm();
      const payload = { ...form, name: form.name.trim(), parameter_pattern: form.parameter_pattern.trim() };
      const editing = editingInterfaceMetric();
      if (editing) await api.updateInterfaceMetric(template.id, editing.id, payload);
      else await api.createInterfaceMetric(template.id, payload);
      setShowInterfaceMetricModal(false);
      refetchInterfaceMetrics();
      notify({ tone: 'success', title: editing ? 'Interface metric updated' : 'Interface metric created' });
    } catch (error) { notify({ tone: 'error', title: 'Could not save interface metric', message: (error as Error).message, persistent: true }); }
  };

  const deleteInterfaceMetric = async (def: InterfaceMetricDefinition) => {
    const template = selectedTemplate();
    if (!template || !await confirm({ title: `Delete ${def.name}?`, description: 'Historical samples remain in storage.', confirmLabel: 'Delete metric', tone: 'danger' })) return;
    try { await api.deleteInterfaceMetric(template.id, def.id); refetchInterfaceMetrics(); }
    catch (error) { notify({ tone: 'error', title: 'Could not delete interface metric', message: (error as Error).message, persistent: true }); }
  };

  const handleDeleteMetric = async (def: MetricDefinition) => {
    if (!await confirm({ title: `Delete metric "${def.name}"?`, description: 'Historical samples remain but will no longer be collected.', confirmLabel: 'Delete metric', tone: 'danger' })) return;
    if (pendingAction()) return;
    setPendingAction(`delete-metric-${def.id}`);
    try {
      const template = selectedTemplate();
      if (!template) return;
      await api.deleteTemplateMetric(template.id, def.id);
      notify({ tone: 'success', title: 'Metric deleted', message: `"${def.name}" has been removed.` });
      refetchMetrics();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete metric', message: 'The metric remains active.', detail: (error as Error).message, persistent: true });
    } finally { setPendingAction(null); }
  };

  return (
    <div class="page">
      <PageHeader
        title="Provisioning"
        description="Controlled CWMP parameters applied automatically to matching CPEs based on trigger phase."
      >
        <div class="relative" ref={settingsMenu}>
          <button type="button" class="icon-button" aria-label="Provisioning menu" aria-haspopup="menu" aria-expanded={showSettingsMenu()} onClick={() => setShowSettingsMenu(value => !value)}>
            <MoreVertical size={18} />
          </button>
          <Show when={showSettingsMenu()}>
            <div class="absolute right-0 top-full z-50 mt-2 min-w-40 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu">
              <button type="button" role="menuitem" class="w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-base disabled:opacity-50" disabled={settingsLoading()} onClick={openRefreshSettings}>
                Settings
              </button>
            </div>
          </Show>
        </div>
      </PageHeader>

      <Show when={isFullAccess()}>
        <Show when={!selectedTemplate()}>
          <div class="card p-5">
            <div class="flex items-center justify-between mb-4">
              <div>
                <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                  <SettingsIcon size={14} />
                  Provisioning Templates
                </h2>
                <p class="text-muted text-xs mt-1">Select a template to view and manage its rules. The most specific template matching a device wins.</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <input ref={(element) => { provisioningImportInput = element; }} type="file" accept="application/json,.json" class="sr-only" onChange={(event) => void importProvisioningBackup(event)} />
                <button type="button" onClick={() => provisioningImportInput?.click()} class="btn btn-secondary text-xs py-1.5" disabled={pendingAction() === 'import-provisioning'}>
                  <Upload size={12} />Import JSON
                </button>
                <button type="button" onClick={() => void exportProvisioningBackup()} class="btn btn-secondary text-xs py-1.5">
                  <Download size={12} />Export JSON
                </button>
                <button onClick={openCreateTemplate} class="btn btn-primary text-xs py-1.5">
                  <Plus size={12} />Add template
                </button>
              </div>
            </div>
            <Show when={provError()}>
              <ResourceError title="Templates are unavailable" description="The provisioning templates could not be loaded." onRetry={loadProvTemplates} />
            </Show>
            <Show when={!provError() && provTemplates() !== null}>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <For each={provTemplates()}>
                  {(t) => (
                      <div class="rounded border border-subtle p-4 hover:border-primary/30 transition-colors">
                      <div class="flex items-start justify-between">
                        <button type="button" class="min-w-0 flex-1 text-left" onClick={() => selectTemplate(t)} aria-label={`Select provisioning template ${t.name}`}>
                          <h3 class="text-sm font-medium text-primary truncate">{t.name}</h3>
                          <p class="text-xs text-muted mt-1">
                            {t.manufacturer || t.product_class
                              ? [t.manufacturer, t.product_class].filter(Boolean).join(' / ')
                              : 'Global (all devices)'}
                          </p>
                          <Show when={t.description}>
                            <p class="text-xs text-muted mt-1 truncate">{t.description}</p>
                          </Show>
                        </button>
                        <div class="flex items-center gap-1 shrink-0 ml-2">
                          <button onClick={(e) => { e.stopPropagation(); openCloneTemplate(t); }} class="icon-button" aria-label={`Duplicate template ${t.name}`} title="Duplicate template">
                            <Copy size={13} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); openEditTemplate(t); }} class="icon-button" aria-label={`Edit template ${t.name}`}>
                            <Edit2 size={13} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(t.id); }} class="icon-button" aria-label={`Delete template ${t.name}`}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      </div>
                  )}
                </For>
              </div>
              <Show when={(provTemplates()?.length ?? 0) === 0}>
                <EmptyState compact title="No templates exist" description="Create a template to start provisioning rules for a device type." action={<button type="button" class="btn btn-primary" onClick={openCreateTemplate}>Add template</button>} />
              </Show>
            </Show>
          </div>
        </Show>
        <Show when={selectedTemplate()}>
          <div class="card p-5">
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-3">
                <button onClick={backToTemplates} class="icon-button" aria-label="Back to templates">
                  <ChevronLeft size={16} />
                </button>
                <div class="relative z-10 h-20 w-28 shrink-0 overflow-hidden rounded border border-subtle bg-elevated grid place-items-center p-1">
                  <Show when={templateImageUrl()} fallback={<ImageIcon size={18} class="text-muted" />}>
                    <img src={templateImageUrl()!} alt={`Device image for ${selectedTemplate()!.name}`} class="template-image-preview" />
                  </Show>
                </div>
                <div>
                  <h2 class="text-sm font-medium text-secondary flex items-center gap-2">
                    <SettingsIcon size={14} />
                    {selectedTemplate()!.name}
                  </h2>
                  <p class="text-muted text-xs mt-1">
                    {selectedTemplate()!.manufacturer || selectedTemplate()!.product_class
                      ? [selectedTemplate()!.manufacturer, selectedTemplate()!.product_class].filter(Boolean).join(' / ')
                      : 'Global (all devices)'}
                  </p>
                </div>
              </div>
            </div>

            <div class="flex gap-1 border-b border-subtle mb-4">
              <button type="button" onClick={() => setTemplateTab('rules')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'rules' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}><span class="flex items-center gap-1.5"><ListChecks size={12} />Rules</span></button>
              <button type="button" onClick={() => setTemplateTab('variables')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'variables' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}><span class="flex items-center gap-1.5"><Variable size={12} />Variables</span></button>
              <button type="button" onClick={() => setTemplateTab('metrics')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'metrics' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>
                <span class="flex items-center gap-1.5"><Activity size={12} />Metrics</span>
              </button>
              <button type="button" onClick={() => setTemplateTab('features')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'features' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}><span class="flex items-center gap-1.5"><SlidersHorizontal size={12} />Features</span></button>
            </div>

            <Show when={templateTab() === 'rules'}>
              <div class="mb-4 flex flex-wrap items-center justify-end gap-2">
                <div class="relative">
                  <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                  <input type="text" value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)} placeholder="Search rules…" class="input pl-9! w-56 text-sm" />
                  <Show when={searchQuery()}><button onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear search"><X size={12} /></button></Show>
                </div>
                <button onClick={openCreateProv} class="btn btn-primary text-xs py-1.5"><Plus size={12} />Add rule</button>
              </div>
            </Show>
            <Show when={templateTab() === 'metrics'}>
              <div class="mb-4 flex flex-wrap justify-end gap-2">
                <button onClick={openCreateMetric} class="btn btn-primary text-xs py-1.5"><Plus size={12} />Add metric</button>
              </div>
            </Show>
            <Show when={templateTab() === 'variables'}>
              <div class="mb-4 flex justify-end gap-2">
                <button onClick={addTemplateVariable} class="btn btn-secondary text-xs py-1.5"><Plus size={12} />Add variable</button>
                <button onClick={() => void saveTemplateVariables()} class="btn btn-primary text-xs py-1.5" disabled={variablesSaving()}><Save size={12} />{variablesSaving() ? 'Saving…' : 'Save variables'}</button>
              </div>
            </Show>

          <Show when={templateTab() === 'features'}>
            <div class="space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <p class="text-xs text-muted">Build device controls for {selectedTemplate()!.name}. Sections appear as tabs on matching device pages.</p>
                <button type="button" onClick={() => openFeatureEditor()} class="btn btn-primary text-xs py-1.5"><Plus size={12} />Add section</button>
              </div>
              <Show when={(selectedTemplate()?.features?.length || 0) > 0} fallback={<EmptyState compact title="No feature sections yet" description="Add a section, then add fields with their CWMP parameter paths and value types." />}>
                <div class="flex gap-1 overflow-x-auto border-b border-subtle" role="tablist" aria-label="Feature sections">
                  <For each={selectedTemplate()?.features || []}>{feature => <button type="button" role="tab" aria-selected={activeFeature()?.id === feature.id} onClick={() => setActiveFeatureID(feature.id)} class={`shrink-0 rounded-t px-3 py-2 text-xs font-medium ${activeFeature()?.id === feature.id ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>{feature.name}</button>}</For>
                </div>
                <Show when={activeFeature()}>{feature => <section class="card p-4 space-y-4">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div><h3 class="text-sm font-medium text-primary">{feature().name}</h3><p class="mt-1 text-xs text-muted">{feature().description || `${feature().controls.length} fields`}</p></div>
                    <div class="flex flex-wrap gap-2"><Show when={selectedFeatureControlKeys().length > 0}><button type="button" class="btn btn-ghost text-xs text-rose-400" disabled={featuresSaving()} onClick={() => void deleteSelectedFeatureControls(feature())}><Trash2 size={13} />Delete selected ({selectedFeatureControlKeys().length})</button></Show><button type="button" class="btn btn-primary text-xs" onClick={() => openFeatureEditor(feature(), undefined, 'control')}><Plus size={13} />Add field</button><div class="relative" ref={featureMenu}><button type="button" class="icon-button" aria-label={`Actions for feature section ${feature().name}`} aria-haspopup="menu" aria-expanded={showFeatureMenu()} onClick={() => setShowFeatureMenu(value => !value)}><MoreVertical size={18} /></button><Show when={showFeatureMenu()}><div class="absolute right-0 top-full z-50 mt-2 min-w-40 rounded border border-subtle bg-elevated p-1 shadow-xl" role="menu"><button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-primary hover:bg-base" onClick={() => { setShowFeatureMenu(false); openFeatureEditor(feature()); }}><Edit2 size={14} />Edit section</button><button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-rose-400 hover:bg-base" onClick={() => { setShowFeatureMenu(false); void deleteTemplateFeature(feature().id); }}><Trash2 size={14} />Delete</button></div></Show></div></div>
                  </div>
                  <Show when={feature().controls.length > 0} fallback={<p class="rounded border border-dashed border-subtle p-5 text-center text-xs text-muted">No fields in this section yet.</p>}>
                    <div class="overflow-x-auto"><table class="data-table w-full min-w-[820px] text-xs"><thead><tr><th class="w-8 whitespace-nowrap"><input type="checkbox" aria-label="Select all fields" checked={feature().controls.length > 0 && feature().controls.every(control => selectedFeatureControlKeys().includes(control.key))} onChange={event => selectAllFeatureControls(feature(), event.currentTarget.checked)} /></th><th class="w-8 whitespace-nowrap"></th><For each={featureTableColumns}>{column => <Show when={featureColumns.isVisible(column.id)}><th class="text-left whitespace-nowrap">{column.label}</th></Show>}</For><th class="text-right whitespace-nowrap">Actions</th><th class="py-2 pr-2 whitespace-nowrap"><ColumnVisibility columns={featureColumns.columns} onToggle={featureColumns.toggle} /></th></tr></thead><tbody>
                      <For each={feature().controls}>{control => <tr class={`border-t border-subtle/50 ${featureDraggedControl() === control.key ? 'opacity-50' : ''}`} draggable={!featuresSaving()} onDragStart={event => { setFeatureDraggedControl(control.key); event.dataTransfer?.setData('text/plain', control.key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); void reorderFeatureControl(feature(), control.key); }} onDragEnd={() => setFeatureDraggedControl(null)}><td class="py-2 pr-2 text-center whitespace-nowrap"><input type="checkbox" aria-label={`Select ${control.label}`} checked={selectedFeatureControlKeys().includes(control.key)} onChange={() => toggleFeatureControlSelection(control.key)} /></td><td class="py-2 pr-2 cursor-grab active:cursor-grabbing text-muted whitespace-nowrap" aria-label={`Reorder ${control.label}`} title="Drag to reorder"><GripVertical size={13} /></td><Show when={featureColumns.isVisible('label')}><td class="py-2 pr-3 whitespace-nowrap"><span class="font-medium text-primary">{control.label}</span><Show when={control.description}><span class="mt-0.5 block text-muted">{control.description}</span></Show></td></Show><Show when={featureColumns.isVisible('type')}><td class="py-2 pr-3 whitespace-nowrap">{control.type}</td></Show><Show when={featureColumns.isVisible('parameter')}><td class="py-2 pr-3 font-mono text-muted break-words [overflow-wrap:anywhere]">{control.parameter}</td></Show><Show when={featureColumns.isVisible('input')}><td class="py-2 pr-3 whitespace-nowrap">{control.type === 'boolean' ? 'Toggle' : control.type === 'object' ? 'Add object' : control.options?.length ? `Select · ${control.options.length} options` : 'Input'}</td></Show><Show when={featureColumns.isVisible('group')}><td class="py-2 pr-3 whitespace-nowrap">{control.group || '—'}</td></Show><td class="py-2 text-right whitespace-nowrap"><div class="inline-flex gap-1"><button type="button" class="icon-button" aria-label={`Edit ${control.label}`} onClick={() => openFeatureEditor(feature(), control)}><Edit2 size={13} /></button><button type="button" class="icon-button" aria-label={`Copy ${control.label}`} title="Copy field" disabled={featuresSaving()} onClick={() => void copyFeatureControl(feature(), control)}><Copy size={13} /></button><button type="button" class="icon-button text-rose-400" aria-label={`Delete ${control.label}`} onClick={() => void deleteFeatureControl(feature(), control.key)}><Trash2 size={13} /></button></div></td><td class="px-2 py-2 whitespace-nowrap"></td></tr>}</For>
                    </tbody></table></div>
                  </Show>
                </section>}</Show>
              </Show>
            </div>
          </Show>

          <Show when={templateTab() === 'rules'}>
          <Show when={provError()}>
            <ResourceError title="Provisioning rules are unavailable" description="The current provisioning policy could not be loaded. Retry before changing a device rollout." onRetry={loadProvRules} />
          </Show>

          <Show when={!provError() && provRules() !== null}>
            <div class="overflow-x-auto table-scroll">
              <table class="data-table w-full text-left">
                <thead>
                  <tr class="border-b border-subtle">
                    <th class="py-2 pr-2 w-8 text-xs font-medium text-muted uppercase tracking-wide">#</th>
                    <For each={visibleProvColumns()}>
                      {(col) => (
                        <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">
                          <div class="flex items-center gap-1.5">{col.id === 'parameter' ? 'CWMP path' : col.label}
                            <ColumnFilter columnId={col.id} label={col.label} active={columnFilters()[col.id] || null} onApply={(s) => { setColumnFilters((prev) => { const n = { ...prev }; if (s) n[col.id] = s; else delete n[col.id]; return n; }); }} />
                          </div>
                        </th>
                      )}
                    </For>
                    <th class="py-2 text-right text-xs font-medium text-muted uppercase tracking-wide">Actions</th>
                    <th class="py-2 pr-2"><ColumnVisibility columns={provColumns} onToggle={toggleProvColumn} /></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={pagedProvRules()}>
                    {(p) => (
                      <tr
                        class={`border-b border-subtle/50 hover:bg-elevated/40 transition-colors ${provDraggedRow() === p.id ? 'opacity-50' : ''}`}
                        draggable={provDragEnabled()}
                        onDragStart={(e) => handleRowDragStart(e, p.id)}
                        onDragOver={handleRowDragOver}
                        onDrop={(e) => handleRowDrop(e, p.id)}
                      >
                        <td class="py-2 pr-2 cursor-grab active:cursor-grabbing select-none">
                          <span class="flex items-center gap-1 text-muted">
                            <GripVertical size={12} />
                            <span class="text-xs">{p.order}</span>
                          </span>
                        </td>
                        <Show when={visibleProvColumns().some(c => c.id === 'parameter')}>
                          <td class="py-2 pr-4 break-words [overflow-wrap:anywhere]">
                            <span class="text-secondary text-xs font-mono">{p.add_object_path || p.parameter_name}</span>
                            <Show when={p.add_object_path}>
                              <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 ml-1.5">AddObject</span>
                            </Show>
                            <Show when={p.condition}>
                              <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 ml-1.5">Conditional</span>
                            </Show>
                            <Show when={p.description}>
                              <p class="text-muted text-xs">{p.description}</p>
                            </Show>
                          </td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'value')}>
                          <td class="py-2 text-secondary text-xs font-mono max-w-xs truncate whitespace-nowrap">{p.add_object_path ? '—' : p.parameter_value}</td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'parameter_type')}>
                          <td class="py-2 text-secondary text-xs whitespace-nowrap">{p.add_object_path ? '—' : (p.parameter_type || '—')}</td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'tags')}>
                          <td class="py-2 text-secondary text-xs whitespace-nowrap">
                            {((p.tags?.length || 0) + (p.excluded_tags?.length || 0) > 0) ? (
                              <span class="flex flex-nowrap gap-1">
                                <For each={p.tags}>
                                  {(tag) => <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">contain: {tag}</span>}
                                </For>
                                <For each={p.excluded_tags}>
                                  {(tag) => <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400">not-contain: {tag}</span>}
                                </For>
                              </span>
                            ) : '—'}
                          </td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'phase')}>
                          <td class="py-2 whitespace-nowrap">
                            <span class={`text-xs px-1.5 py-0.5 rounded ${p.phase === 'default' ? 'bg-blue-500/10 text-blue-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{p.phase || 'bootstrap'}</span>
                          </td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'status')}>
                          <td class="py-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleToggleProv(p.id, !p.enabled)}
                              class={`badge cursor-pointer hover:opacity-80 ${p.enabled ? 'badge-success' : 'border-subtle bg-elevated text-muted'}`}
                              aria-pressed={p.enabled}
                              aria-label={`${p.enabled ? 'Disable' : 'Enable'} provisioning rule ${p.parameter_name}`}
                              title={p.enabled ? 'Click to disable' : 'Click to enable'}
                              disabled={pendingAction() !== null}
                            >
                              {pendingAction() === `toggle-provisioning-${p.id}` ? 'Updating…' : p.enabled ? 'Yes' : 'No'}
                            </button>
                          </td>
                        </Show>
                        <td class="py-2 text-right">
                          <div class="flex items-center justify-end gap-1">
                            <button onClick={() => openEditProv(p)} class="icon-button" aria-label={`Edit provisioning rule ${p.parameter_name}`} disabled={pendingAction() !== null}>
                              <Edit2 size={14} />
                            </button>
                            <button onClick={() => openCopyProv(p)} class="icon-button" aria-label={`Copy provisioning rule ${p.parameter_name}`} disabled={pendingAction() !== null}>
                              <Copy size={14} />
                            </button>
                            <button onClick={() => handleDeleteProv(p.id)} class="icon-button" aria-label={`Delete provisioning rule ${p.parameter_name}`} disabled={pendingAction() !== null}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                        <td class="py-2 pr-2"></td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>

          <Show when={!provError() && provRules() !== null && (provRules()?.length ?? 0) === 0}>
            <EmptyState compact title="No provisioning rules exist" description="Add a rule to this template to start provisioning." />
          </Show>
          </Show>

          <Show when={templateTab() === 'variables'}>
            <div class="space-y-4">
              <div class="rounded border border-subtle bg-base p-3 text-xs text-muted">
                Define reusable values for this template. Sources may be device identity, a literal, or a parameter reported in Inform. Leave the source empty to start with an empty value, then use a transformation such as Random string. HMAC-SHA256 can use the application connection-request master secret or a custom secret. Use <code class="text-primary">{'{{variable_name}}'}</code> in provisioning rule values. Transformations run in order.
              </div>
              <Show when={templateVariables().length > 0} fallback={<p class="py-8 text-center text-sm text-muted">No template variables defined yet.</p>}>
                <Index each={templateVariables()}>{(variable, variableIndex) => <section class="card p-4 space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <h3 class="text-sm font-medium text-primary">Variable {variableIndex + 1}</h3>
                    <button type="button" class="btn btn-ghost text-xs text-rose-400" onClick={() => setTemplateVariables(previous => previous.filter((_, index) => index !== variableIndex))} aria-label={`Remove variable ${variable().name}`}><Trash2 size={13} />Remove</button>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <label class="block text-xs text-muted">Variable name<input class="input mt-1 w-full font-mono" value={variable().name} onInput={event => updateTemplateVariable(variableIndex, { name: event.currentTarget.value })} placeholder="serial_suffix" /></label>
                    <label class="block text-xs text-muted">Source<select class="input mt-1 w-full" value={variable().source} onChange={event => updateTemplateVariable(variableIndex, { source: event.currentTarget.value })}>
                      <option value="">No source</option><option value="literal">Literal value</option><option value="serial_number">Device serial number</option><option value="manufacturer">Manufacturer</option><option value="product_class">Product class</option><option value="oui">OUI</option><option value="parameter">CWMP parameter from Inform</option>
                    </select></label>
                    <Show when={variable().source === 'literal' || variable().source === 'parameter'}>
                      <label class="block text-xs text-muted">{variable().source === 'literal' ? 'Literal value' : 'Parameter path'}<input class="input mt-1 w-full font-mono text-xs" value={variable().value || ''} onInput={event => updateTemplateVariable(variableIndex, { value: event.currentTarget.value })} placeholder={variable().source === 'parameter' ? 'InternetGatewayDevice.DeviceInfo.SerialNumber' : 'Enter a starting value'} /></label>
                    </Show>
                  </div>
                  <div class="space-y-2">
                    <Index each={variable().steps}>{(step, stepIndex) => {
                      const argumentFields: Record<string, Array<[string, string]>> = {
                        prefix: [['text', 'Prefix']], suffix: [['text', 'Suffix']],
                        slice: [['start', 'Start index'], ['end', 'End index (optional)']],
                        replace: [['search', 'Find'], ['replace', 'Replace with']],
                        regex_replace: [['pattern', 'Regular expression'], ['replace', 'Replace with']],
                        pad_start: [['length', 'Final length'], ['text', 'Padding characters']],
                        pad_end: [['length', 'Final length'], ['text', 'Padding characters']],
                        default: [['value', 'Fallback value']],
                        random_string: [['length', 'Length'], ['charset', 'Character set (alphanumeric, digits, lowercase, uppercase, hex)']],
                      };
                      return <div class="grid grid-cols-1 md:grid-cols-12 items-end gap-2 rounded bg-base p-3">
                        <label class="block text-xs text-muted md:col-span-3">Transformation<select class="input mt-1 w-full" value={step().function} onChange={event => { const fn = event.currentTarget.value; updateVariableTransform(variableIndex, stepIndex, { function: fn, args: fn === 'random_string' ? { length: '12', charset: 'alphanumeric' } : fn === 'hmac_sha256' ? { key_source: 'application', encoding: 'connection_request' } : {}, key_configured: false }); }}>
                          <option value="trim">Trim whitespace</option><option value="upper">Uppercase</option><option value="lower">Lowercase</option><option value="prefix">Add prefix</option><option value="suffix">Add suffix</option><option value="slice">Slice by indexes</option><option value="replace">Replace text</option><option value="regex_replace">Replace by regex</option><option value="pad_start">Pad at start</option><option value="pad_end">Pad at end</option><option value="default">Fallback if empty</option><option value="random_string">Generate random string</option><option value="sha256">SHA-256 hash</option><option value="hmac_sha256">HMAC-SHA256</option><option value="base64_encode">Base64 encode</option><option value="base64_decode">Base64 decode</option><option value="hex_encode">Hex encode</option><option value="hex_decode">Hex decode</option>
                        </select></label>
                        <For each={argumentFields[step().function] || []}>{([key, label]) => <label class="block text-xs text-muted md:col-span-2">{label}<input class="input mt-1 w-full" value={step().args?.[key] || (step().function === 'random_string' && key === 'charset' ? 'alphanumeric' : '')} onInput={event => updateVariableTransform(variableIndex, stepIndex, { args: { ...step().args, [key]: event.currentTarget.value } })} /></label>}</For>
                        <Show when={step().function === 'hmac_sha256'}>
                          <label class="block text-xs text-muted md:col-span-3">HMAC key source<select class="input mt-1 w-full" value={step().args?.key_source || 'application'} onChange={event => setVariableHmacKeySource(variableIndex, stepIndex, event.currentTarget.value)}><option value="application">Connection-request master secret</option><option value="custom">Custom secret</option></select></label>
                          <Show when={step().args?.key_source === 'custom'}>
                            <label class="block text-xs text-muted md:col-span-4">Custom HMAC secret<input type="password" class="input mt-1 w-full" value={step().args?.key_secret || ''} onInput={event => updateVariableTransform(variableIndex, stepIndex, { args: { ...step().args, key_secret: event.currentTarget.value } })} placeholder={step().key_configured ? 'Saved secret — leave blank to keep it' : 'At least 16 characters'} />{step().key_configured && <span class="block mt-1 text-muted">A secret is saved; leave this blank to keep it unchanged.</span>}</label>
                          </Show>
                          <label class="block text-xs text-muted md:col-span-3">Output format<select class="input mt-1 w-full" value={step().args?.encoding || 'connection_request'} onChange={event => updateVariableTransform(variableIndex, stepIndex, { args: { ...step().args, encoding: event.currentTarget.value } })}><option value="connection_request">Connection request (18-byte Base64URL)</option><option value="base64url">Full digest (Base64URL)</option><option value="hex">Full digest (hex)</option></select></label>
                          <p class="text-xs text-muted md:col-span-12">The input variable is the HMAC message. Custom secrets are encrypted in the database and never returned by the API.</p>
                        </Show>
                        <button type="button" class="btn btn-ghost text-rose-400 md:col-span-1" onClick={() => updateTemplateVariable(variableIndex, { steps: variable().steps.filter((_, index) => index !== stepIndex) })} aria-label="Remove transformation"><Trash2 size={13} /></button>
                      </div>;
                    }}</Index>
                    <button type="button" class="btn btn-secondary text-xs" onClick={() => addVariableTransform(variableIndex)}><Plus size={12} />Add transformation</button>
                  </div>
                </section>}</Index>
              </Show>
              <p class="text-xs text-muted">Slice indexes are zero-based. Start 10 removes the first 10 characters; start -10 selects from the last 10 characters. Random strings use cryptographically secure randomness. Each variable is resolved once per device session and can be referenced by later variables.</p>
            </div>
          </Show>

          <Show when={templateTab() === 'metrics'}>
            <Show when={metrics() !== undefined}>
              <div class="overflow-x-auto table-scroll">
                <table class="data-table w-full min-w-[95rem] table-fixed text-left">
                  <thead>
                    <tr class="border-b border-subtle">
                      <For each={metricTableColumns}>{column => <Show when={metricColumns.isVisible(column.id)}><th class={`py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide ${column.id === 'parameter' ? 'w-[45%]' : ''}`}>{column.label}</th></Show>}</For>
                      <th class="py-2 text-right text-xs font-medium text-muted uppercase tracking-wide">Actions</th>
                      <th class="py-2 pr-2"><ColumnVisibility columns={metricColumns.columns} onToggle={metricColumns.toggle} /></th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={templateMetrics()}>
                      {(def) => (
                        <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                          <Show when={metricColumns.isVisible('name')}><td class="px-3 py-2.5 text-primary font-medium whitespace-nowrap">
                            {def.name}
                            <Show when={def.description}>
                              <div class="text-[10px] text-muted mt-0.5">{def.description}</div>
                            </Show>
                          </td></Show>
                          <Show when={metricColumns.isVisible('parameter')}><td class="w-[45%] px-3 py-2.5 text-secondary font-mono text-xs break-words [overflow-wrap:anywhere]">{def.parameter_name}</td></Show>
                          <Show when={metricColumns.isVisible('source')}><td class="px-3 py-2.5 whitespace-nowrap">
                            <span class={`badge ${def.source === 'active' ? 'badge-warning' : def.source === 'universal' ? 'badge-success' : ''}`}>{def.source}</span>
                          </td></Show>
                          <Show when={metricColumns.isVisible('group')}><td class="px-3 py-2.5 text-secondary whitespace-nowrap">
                            <div class="flex items-center gap-1.5 whitespace-nowrap">
                              <span class="chart-color-swatch w-2.5 h-2.5 rounded-[2px]" data-dynamic-style="chart-color" style={{ '--chart-color': def.color || '#475569' } as any} />
                              <span class="text-xs">{def.group || '—'}</span>
                            </div>
                          </td></Show>
                          <Show when={metricColumns.isVisible('active')}><td class="px-3 py-2.5 text-center whitespace-nowrap">
                            <span class={`badge ${def.active ? 'badge-success' : 'badge-muted'}`}>{def.active ? 'Yes' : 'No'}</span>
                          </td></Show>
                          <Show when={metricColumns.isVisible('device_match')}><td class="px-3 py-2.5 text-secondary font-mono text-xs whitespace-nowrap">{def.device_type_match}</td></Show>
                          <Show when={metricColumns.isVisible('unit')}><td class="px-3 py-2.5 text-secondary whitespace-nowrap">{def.unit || '—'}</td></Show>
                          <td class="px-3 py-2.5 text-right whitespace-nowrap">
                            <div class="flex justify-end gap-1">
                              <button type="button" onClick={() => openEditMetric(def)} class="icon-button" title="Edit metric" aria-label={`Edit ${def.name}`}>
                                <Edit size={14} />
                              </button>
                              <button type="button" onClick={() => openCopyMetric(def)} class="icon-button" title="Copy metric" aria-label={`Copy ${def.name}`}>
                                <Copy size={14} />
                              </button>
                              <button type="button" onClick={() => handleDeleteMetric(def)} class="icon-button text-red-400" title="Delete metric" aria-label={`Delete ${def.name}`}>
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td><td class="px-2 py-2"></td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <Show when={(templateMetrics()?.length ?? 0) === 0}>
                <EmptyState compact title="No metrics match this template" description="Add a metric to start collecting time-series data for this device type." action={<button type="button" class="btn btn-primary" onClick={openCreateMetric}>Add metric</button>} />
              </Show>
            </Show>
            <section class="mt-6 border-t border-subtle pt-4">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 class="text-sm font-semibold text-primary">Per-interface WAN/LAN metrics</h3>
                <button onClick={() => openInterfaceMetric()} class="btn btn-primary text-xs py-1.5"><Plus size={12} />Add WAN/LAN metric</button>
              </div>
              <Show when={interfaceMetrics()?.length} fallback={<p class="text-xs text-muted">No per-interface metrics configured for this template.</p>}>
                <div class="overflow-x-auto table-scroll"><table class="data-table w-full min-w-[95rem] table-fixed text-left"><thead><tr class="border-b border-subtle text-xs text-muted uppercase"><For each={interfaceMetricTableColumns}>{column => <Show when={interfaceMetricColumns.isVisible(column.id)}><th class={`py-2 pr-3 ${column.id === 'parameter' ? 'w-[45%]' : ''}`}>{column.label}</th></Show>}</For><th class="py-2 text-right">Actions</th><th class="py-2 pr-2"><ColumnVisibility columns={interfaceMetricColumns.columns} onToggle={interfaceMetricColumns.toggle} /></th></tr></thead><tbody><For each={interfaceMetrics() || []}>{def => <tr class="border-b border-subtle/50 text-xs"><For each={interfaceMetricColumns.columns().filter(column => column.visible)}>{column => interfaceMetricCell(def, column.id)}</For><td class="py-2 text-right"><div class="flex justify-end gap-1"><button type="button" class="icon-button" onClick={() => openInterfaceMetric(def)} title="Edit metric" aria-label={`Edit ${def.name}`}><Edit size={14} /></button><button type="button" class="icon-button" onClick={() => copyInterfaceMetric(def)} title="Copy metric" aria-label={`Copy ${def.name}`}><Copy size={14} /></button><button type="button" class="icon-button text-red-400" onClick={() => void deleteInterfaceMetric(def)} title="Delete metric" aria-label={`Delete ${def.name}`}><Trash2 size={14} /></button></div></td><td class="px-2 py-2"></td></tr>}</For></tbody></table></div>
              </Show>
            </section>
          </Show>
          </div>
        </Show>
        <Show when={selectedTemplate() && templateTab() === 'rules'}><Pagination page={provPage()} totalPages={provTotalPages()} totalItems={filteredProvRules().length} pageSize={pageSize()} onPageChange={setProvPage} storageKey="provisioning" onPageSizeChange={handlePageSizeChange} filters={columnFilters()} onClearFilters={() => { setColumnFilters({}); setProvPage(0); }} onRemoveFilter={(columnId) => { setColumnFilters((previous) => { const next = { ...previous }; delete next[columnId]; return next; }); setProvPage(0); }} /></Show>
      </Show>

      {/* Provisioning Modal */}
      <Show when={showSettingsModal()}>
        <Dialog title="Provisioning settings" description="Refresh intervals are checked whenever the CPE sends an Inform." onClose={closeSettingsModal} actions={<>
          <button type="button" class="btn btn-secondary" onClick={closeSettingsModal} disabled={settingsSaving()}>Cancel</button>
          <Show when={isFullAccess()}><button type="submit" form="provisioning-settings-form" class="btn btn-primary" disabled={settingsSaving()}>{settingsSaving() ? 'Saving…' : 'Save settings'}</button></Show>
        </>}>
          <form id="provisioning-settings-form" class="space-y-4" onSubmit={(event) => { event.preventDefault(); void saveRefreshSettings(); }}>
            <Show when={settingsDirty()}><div class="form-dirty-banner" role="status">Unsaved changes will be lost if this dialog is closed.</div></Show>
            <div>
              <label for="overview-poll-interval" class="block text-xs text-muted mb-1.5">Overview refresh interval</label>
              <input id="overview-poll-interval" type="text" class="input w-full" value={refreshSettings().overview} onInput={(event) => setRefreshSettings(settings => ({ ...settings, overview: event.currentTarget.value }))} disabled={!isFullAccess()} required />
              <p class="text-xs text-muted mt-1">Use m or h, from 1m to 24h. Example: 15m.</p>
            </div>
            <div>
              <label for="full-tree-poll-interval" class="block text-xs text-muted mb-1.5">Full parameter tree refresh interval</label>
              <input id="full-tree-poll-interval" type="text" class="input w-full" value={refreshSettings().full} onInput={(event) => setRefreshSettings(settings => ({ ...settings, full: event.currentTarget.value }))} disabled={!isFullAccess()} required />
              <p class="text-xs text-muted mt-1">Use m or h, from 15m to 168h. Example: 6h.</p>
            </div>
          </form>
        </Dialog>
      </Show>
      <Show when={showProvModal()}>
        <Dialog
          title={editingProv() ? 'Edit provisioning rule' : copyingProv() ? 'Duplicate provisioning rule' : 'Add provisioning rule'}
          onClose={closeProvModal}
        >
          <form onSubmit={(e) => { e.preventDefault(); editingProv() ? handleUpdateProv() : handleCreateProv(); }} class="space-y-4">
            <Show when={provFormDirty()}><div class="form-dirty-banner" role="status">Unsaved changes will be lost if this dialog is closed.</div></Show>
            <div>
              <label for="provisioning-parameter" class="block text-xs text-muted mb-1.5">{isAddObjectRule() ? 'CWMP object path' : 'CWMP parameter name'}</label>
              <input id="provisioning-parameter" type="text" value={provForm().parameter_name} onInput={(e) => setProvForm(f => ({ ...f, parameter_name: e.currentTarget.value }))} class="input w-full" placeholder={isAddObjectRule() ? 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection' : 'Path to a writable CWMP parameter'} />
            </div>
            <div>
              <label for="provisioning-add-object" class="flex items-center gap-2 text-sm text-secondary">
                <input id="provisioning-add-object" type="checkbox" checked={isAddObjectRule()} onChange={(e) => setIsAddObjectRule(e.currentTarget.checked)} class="rounded" />
                AddObject: create a new object instance
              </label>
              <Show when={isAddObjectRule()}>
                <p class="text-xs text-muted mt-1">The path above identifies the object collection. No parameter value is sent. In later rules, use <code class="text-amber-400">{'{prev}'}</code> for the latest AddObject instance, or <code class="text-amber-400">{'{prev1}'}</code>, <code class="text-amber-400">{'{prev2}'}</code> for the first and second created instances.</p>
              </Show>
            </div>
            <Show when={!isAddObjectRule()}>
              <div>
                <label for="provisioning-value" class="block text-xs text-muted mb-1.5">Parameter value</label>
                <input id="provisioning-value" type="text" value={provForm().parameter_value} onInput={(e) => setProvForm(f => ({ ...f, parameter_value: e.currentTarget.value }))} class="input w-full" placeholder="Enter the parameter value" />
                <Show when={selectedTemplate()?.variables?.length}>
                  <p class="text-xs text-muted mt-1">Use <code class="text-primary">{'{{variable_name}}'}</code> to substitute a template variable. Available: {selectedTemplate()!.variables!.map(variable => variable.name).join(', ')}</p>
                </Show>
              </div>
            </Show>
            <div>
              <label for="provisioning-order" class="block text-xs text-muted mb-1.5">Order</label>
              <input id="provisioning-order" type="number" min="0" value={provForm().order} onInput={(e) => setProvForm(f => ({ ...f, order: Number(e.currentTarget.value) || 0 }))} class="input w-full" />
              <p class="text-xs text-muted mt-1">Lower values execute first. Use drag-and-drop in the table or set explicit order here.</p>
            </div>
            <div>
              <label for="provisioning-tags" class="block text-xs text-muted mb-1.5">Tags (optional)</label>
              <div class="flex flex-wrap gap-1.5 mb-1.5">
                <For each={['tags', 'excluded_tags'] as const}>{mode =>
                  <For each={provForm()[mode]}>{tag =>
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 text-xs">
                      {mode === 'tags' ? 'contain' : 'not-contain'}: {tag}
                      <button type="button" onClick={() => setProvForm(f => ({ ...f, [mode]: f[mode].filter(value => value !== tag) }))} aria-label={`Remove ${mode === 'tags' ? 'contain' : 'not-contain'} tag ${tag}`}><X size={10} /></button>
                    </span>
                  }</For>
                }</For>
              </div>
              <div class="flex gap-2">
                <select aria-label="Tag condition" class="input" value={tagMode()} onChange={e => setTagMode(e.currentTarget.value as 'tags' | 'excluded_tags')}>
                  <option value="tags">contain</option>
                  <option value="excluded_tags">not-contain</option>
                </select>
                <input id="provisioning-tags" type="text" class="input w-full" placeholder="branch-a (press Enter to add)" value={tagInput()} onInput={e => setTagInput(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRuleTag(); } }} />
                <button type="button" class="btn btn-secondary" onClick={addRuleTag} disabled={!tagInput().trim()}>Add</button>
              </div>
              <p class="text-xs text-muted mt-1">Contain: CPE must have at least one listed tag. Not-contain: CPE must have none of the listed tags. Both conditions apply. Leave empty to apply to all devices in this template.</p>
            </div>
            <Show when={!isAddObjectRule()}>
              <div>
                <label for="provisioning-type" class="block text-xs text-muted mb-1.5">CWMP value type</label>
                <select id="provisioning-type" value={provForm().parameter_type} onChange={(e) => setProvForm(f => ({ ...f, parameter_type: e.currentTarget.value }))} class="input w-full">
                  <option value="string">string</option>
                  <option value="boolean">boolean</option>
                  <option value="int">int</option>
                  <option value="unsignedInt">unsignedInt</option>
                  <option value="dateTime">dateTime</option>
                </select>
              </div>
            </Show>
            <div>
              <label for="provisioning-phase" class="block text-xs text-muted mb-1.5">Trigger phase</label>
              <select id="provisioning-phase" value={provForm().phase} onChange={(e) => setProvForm(f => ({ ...f, phase: e.currentTarget.value }))} class="input w-full">
                <option value="bootstrap">Bootstrap — applied once on first CPE connection</option>
                <option value="default">Default — re-applied on every inform when rule changes</option>
              </select>
              <p class="text-xs text-muted mt-1">Bootstrap rules run once during BOOTSTRAP. Default rules enforce ongoing configuration and re-apply when the rule is updated.</p>
            </div>
            <div>
              <label for="provisioning-description" class="block text-xs text-muted mb-1.5">Operational description (optional)</label>
              <input id="provisioning-description" type="text" value={provForm().description} onInput={(e) => setProvForm(f => ({ ...f, description: e.currentTarget.value }))} class="input w-full" placeholder="Migrate the ACS URL" />
            </div>
            <div>
              <label for="provisioning-condition" class="block text-xs text-muted mb-1.5">Condition (optional)</label>
              <textarea id="provisioning-condition" rows={2} value={provForm().condition} onInput={(e) => setProvForm(f => ({ ...f, condition: e.currentTarget.value }))} class="input w-full font-mono text-xs" placeholder="InternetGatewayDevice.DeviceInfo.Manufacturer == 'SkyDash' AND Device.Model contains 'AC1000'" />
              <p class="text-xs text-muted mt-1">Rule applies only when the condition is true. Operators: <code>==</code> <code>!=</code> <code>&gt;</code> <code>&lt;</code> <code>&gt;=</code> <code>&lt;=</code> <code>contains</code> <code>matches</code>. Device functions: <code>hasTag('…')</code> <code>notHasTag('…')</code>. Combine with <code>AND</code>, <code>OR</code>, <code>NOT</code> and parentheses. Leave empty to always apply.</p>
            </div>
            <div class="flex items-center gap-2">
              <input id="provisioning-enabled" type="checkbox" checked={provForm().enabled} onChange={(e) => setProvForm(f => ({ ...f, enabled: e.currentTarget.checked }))} class="rounded" />
              <label for="provisioning-enabled" class="text-sm text-secondary">Enable this rule</label>
            </div>
            <div class="flex gap-2 pt-2">
              <button type="button" onClick={closeProvModal} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>Cancel</button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
                {pendingAction() ? 'Saving rule…' : editingProv() ? 'Update rule' : 'Add rule'}
              </button>
            </div>
          </form>
        </Dialog>
      </Show>
      <Show when={featureEditorOpen()}>
        <Dialog title={featureEditorPage() === 'control' ? (editingControlKey() ? 'Edit feature field' : 'Add feature field') : (editingFeatureID() ? 'Edit feature section' : 'Add feature section')} size="large" onClose={closeFeatureEditor}>
          <form class="space-y-4" onSubmit={saveFeatureDraft}>
            <Show when={featureEditorPage() === 'section'} fallback={
              <div class="space-y-4">
                <Show when={featureEditorDirty()}><div class="form-dirty-banner" role="status">Unsaved changes will be lost if this dialog is closed.</div></Show>
                <p class="text-xs text-muted">Define one device control and the CWMP parameter it writes.</p>
                <label class="block text-xs text-muted">Field label<input class="input mt-1 w-full" maxlength={128} required value={controlDraft().label} onInput={event => setControlDraft(current => ({ ...current, label: event.currentTarget.value }))} placeholder="Wi-Fi radio" /></label>
                <label class="block text-xs text-muted">CWMP parameter path<input class="input mt-1 w-full font-mono text-xs" required value={controlDraft().parameter} onInput={event => setControlDraft(current => ({ ...current, parameter: event.currentTarget.value }))} placeholder="InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable" /></label>
                <label class="block text-xs text-muted">Value type<select class="input mt-1 w-full" value={controlDraft().type} onChange={event => setControlDraft(current => ({ ...current, type: event.currentTarget.value as ProvisioningFeatureControl['type'] }))}><option value="boolean">Boolean (toggle)</option><option value="string">String</option><option value="int">Integer</option><option value="unsignedInt">Unsigned integer</option><option value="object">Object (add instance)</option></select></label>
                <label class="block text-xs text-muted">Collapsible box (optional)<input class="input mt-1 w-full" maxlength={128} value={controlDraft().group || ''} onInput={event => setControlDraft(current => ({ ...current, group: event.currentTarget.value }))} placeholder="Access rules" /></label>
                <Show when={controlDraft().type === 'boolean'}>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2"><label class="block text-xs text-muted">Enabled value<input class="input mt-1 w-full" value={controlDraft().enabled_value || ''} onInput={event => setControlDraft(current => ({ ...current, enabled_value: event.currentTarget.value }))} /></label><label class="block text-xs text-muted">Disabled value<input class="input mt-1 w-full" value={controlDraft().disabled_value || ''} onInput={event => setControlDraft(current => ({ ...current, disabled_value: event.currentTarget.value }))} /></label></div>
                </Show>
                <Show when={controlDraft().type === 'string' || controlDraft().type === 'int' || controlDraft().type === 'unsignedInt'}>
                  <label class="block text-xs text-muted">Select options (optional, one value per line)<textarea class="input mt-1 min-h-24 w-full font-mono text-xs" value={controlDraft().optionsText} onInput={event => setControlDraft(current => ({ ...current, optionsText: event.currentTarget.value }))} placeholder={controlDraft().type === 'int' || controlDraft().type === 'unsignedInt' ? '0\n1\n2' : 'Auto\nPPPoE\nIP_Routed'} /></label>
                </Show>
                <Show when={controlDraft().type === 'object'}>
                  <label class="block text-xs text-muted">Object form fields (one per line: <code>name|label|type|input|options|help</code>)<textarea class="input mt-1 min-h-32 w-full font-mono text-xs" value={controlDraft().objectFieldsText} onInput={event => setControlDraft(current => ({ ...current, objectFieldsText: event.currentTarget.value }))} placeholder={'Enable|Enable|boolean|boolean||Enable or disable this rule\nMode|Mode|string|select|auto=Automatic;pppoe=PPPoE|Select the access mode\nVLAN ID|VLAN ID|unsignedInt|input||Numeric VLAN identifier'} /></label>
                  <p class="text-[10px] text-muted">Input can be input, select, or boolean. Select options use semicolons as separators: <code>value=label</code>. For example: <code>value1,value2,value3=ALL;value1=label1;value2=label2;value3=label3</code>. The value on the left is sent to the CPE.</p>
                </Show>
                <label class="block text-xs text-muted">Description (optional)<input class="input mt-1 w-full" maxlength={512} value={controlDraft().description || ''} onInput={event => setControlDraft(current => ({ ...current, description: event.currentTarget.value }))} /></label>
                <div class="flex gap-2 pt-2"><button type="button" class="btn btn-secondary flex-1" onClick={() => { setFeatureEditorPage('section'); setEditingControlKey(null); }}>Back to section</button><button type="submit" class="btn btn-primary flex-1">Save field</button></div>
              </div>
            }>
              <div class="space-y-4">
                <label class="block text-xs text-muted">Section name<input class="input mt-1 w-full" maxlength={128} required value={featureDraft().name} onInput={event => setFeatureDraft(current => ({ ...current, name: event.currentTarget.value }))} placeholder="Internet settings" /></label>
                <label class="block text-xs text-muted">Description (optional)<textarea class="input mt-1 w-full" rows={2} maxlength={512} value={featureDraft().description || ''} onInput={event => setFeatureDraft(current => ({ ...current, description: event.currentTarget.value }))} /></label>
                <div class="space-y-2">
                <div class="flex items-center justify-between"><h3 class="text-xs font-medium text-secondary">Fields ({featureDraft().controls.length})</h3><button type="button" class="btn btn-secondary text-xs" onClick={() => { setControlEditorDraft(emptyControlDraft()); setEditingControlKey(null); setFeatureEditorPage('control'); }}><Plus size={13} />Add field</button></div>
                  <Show when={featureDraft().controls.length > 0} fallback={<p class="rounded border border-dashed border-subtle p-4 text-center text-xs text-muted">Fields added here will be available to supported devices.</p>}>
                    <div class="max-h-64 space-y-2 overflow-y-auto"><For each={featureDraft().controls}>{control => <div draggable onDragStart={event => { setFeatureEditorDraggedControl(control.key); event.dataTransfer?.setData('text/plain', control.key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); reorderFeatureDraftControl(control.key); }} onDragEnd={() => setFeatureEditorDraggedControl(null)} class={`flex items-center justify-between gap-3 rounded border border-subtle p-3 cursor-grab active:cursor-grabbing ${featureEditorDraggedControl() === control.key ? 'opacity-50' : ''}`}>
                      <div class="flex min-w-0 items-center gap-2"><GripVertical size={14} class="shrink-0 text-muted" /><div class="min-w-0"><p class="truncate text-xs font-medium text-primary">{control.label} <span class="font-normal text-muted">· {control.type}</span></p><p class="truncate font-mono text-[10px] text-muted">{control.parameter}</p><Show when={control.options?.length}><p class="mt-1 text-[10px] text-muted">Select: {control.options!.join(', ')}</p></Show><Show when={control.object_fields?.length}><p class="mt-1 text-[10px] text-muted">Object form: {control.object_fields!.length} fields</p></Show></div></div>
                      <div class="flex shrink-0 gap-1"><button type="button" class="icon-button" aria-label={`Edit ${control.label}`} onClick={() => { setEditingControlKey(control.key); setControlEditorDraft({ ...control, optionsText: (control.options || []).join('\n'), objectFieldsText: (control.object_fields || []).map(field => [field.name, field.label, field.type, field.input, (field.options || []).map(option => `${option}=${field.option_labels?.[option] || option}`).join(';'), field.help || ''].join('|')).join('\n') }); setFeatureEditorPage('control'); }}><Edit2 size={13} /></button><button type="button" class="icon-button" aria-label={`Copy ${control.label}`} title="Copy field" onClick={() => { setEditingControlKey(null); setControlEditorDraft({ ...control, key: '', label: `${control.label} copy`, parameter: '', optionsText: (control.options || []).join('\n'), objectFieldsText: (control.object_fields || []).map(field => [field.name, field.label, field.type, field.input, (field.options || []).map(option => `${option}=${field.option_labels?.[option] || option}`).join(';'), field.help || ''].join('|')).join('\n') }); setFeatureEditorPage('control'); }}><Copy size={13} /></button><button type="button" class="icon-button text-rose-400" aria-label={`Remove ${control.label}`} onClick={() => setFeatureDraft(current => ({ ...current, controls: current.controls.filter(item => item.key !== control.key) }))}><Trash2 size={13} /></button></div>
                    </div>}</For></div>
                  </Show>
                </div>
                <div class="flex gap-2 pt-2"><button type="button" class="btn btn-secondary flex-1" onClick={closeFeatureEditor} disabled={featuresSaving()}>Cancel</button><button type="submit" class="btn btn-primary flex-1" disabled={featuresSaving()}><Save size={13} />{featuresSaving() ? 'Saving…' : editingFeatureID() ? 'Save section' : 'Create section'}</button></div>
              </div>
            </Show>
          </form>
        </Dialog>
      </Show>
      <Show when={showTemplateModal()}>
        <Dialog
          title={editingTemplate() ? 'Edit template' : cloningTemplate() ? 'Duplicate template' : 'Add template'}
          onClose={closeTemplateModal}
        >
          <form onSubmit={(e) => { e.preventDefault(); editingTemplate() ? handleUpdateTemplate() : cloningTemplate() ? handleCloneTemplate() : handleCreateTemplate(); }} class="space-y-4">
            <Show when={templateFormDirty()}><div class="form-dirty-banner" role="status">Unsaved changes will be lost if this dialog is closed.</div></Show>
            <div>
              <label for="template-name" class="block text-xs text-muted mb-1.5">Name</label>
              <input id="template-name" type="text" value={templateForm().name} onInput={(e) => setTemplateForm(f => ({ ...f, name: e.currentTarget.value }))} class="input w-full" placeholder="e.g. SkyDash AC1000" required />
            </div>
            <div>
              <label for="template-manufacturer" class="block text-xs text-muted mb-1.5">Manufacturer (optional)</label>
              <input id="template-manufacturer" type="text" value={templateForm().manufacturer} onInput={(e) => setTemplateForm(f => ({ ...f, manufacturer: e.currentTarget.value }))} class="input w-full" placeholder="Leave empty to match all manufacturers" />
            </div>
            <div>
              <label for="template-product-class" class="block text-xs text-muted mb-1.5">Product class (optional)</label>
              <input id="template-product-class" type="text" value={templateForm().product_class} onInput={(e) => setTemplateForm(f => ({ ...f, product_class: e.currentTarget.value }))} class="input w-full" placeholder="Leave empty to match all product classes" />
            </div>
            <div>
              <label for="template-description" class="block text-xs text-muted mb-1.5">Description (optional)</label>
              <input id="template-description" type="text" value={templateForm().description} onInput={(e) => setTemplateForm(f => ({ ...f, description: e.currentTarget.value }))} class="input w-full" placeholder="e.g. Rules for SkyDash AC1000 devices" />
            </div>
            <Show when={cloningTemplate()}><p class="text-xs text-muted">All rules, matching metrics, interface metrics, variables, features, and the device photo will be copied. Set the identity for the new device type.</p></Show>
            <Show when={editingTemplate()}>
              <div class="space-y-2">
                <span class="block text-xs text-muted">Device photo (optional)</span>
                <div class="flex items-center gap-3">
                  <div class="h-16 w-20 shrink-0 overflow-hidden rounded border border-subtle bg-elevated grid place-items-center">
                    <Show when={templateImageUrl()} fallback={<ImageIcon size={18} class="text-muted" />}>
                      <img src={templateImageUrl()!} alt={`Device photo for ${editingTemplate()!.name}`} class="h-auto w-auto max-h-full max-w-full object-contain" />
                    </Show>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <input id="template-device-image" ref={(element) => { templateImageInput = element; }} type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="sr-only" onChange={(event) => void handleTemplateImageSelected(event)} disabled={templateImageUploading()} />
                    <label for="template-device-image" class="btn btn-secondary text-xs cursor-pointer" aria-disabled={templateImageUploading()}>
                      <Upload size={12} />
                      {templateImageUploading() ? 'Uploading…' : editingTemplate()!.image_url ? 'Change photo' : 'Add photo'}
                    </label>
                    <Show when={editingTemplate()!.image_url}>
                      <button type="button" class="btn btn-ghost text-xs" onClick={() => void handleDeleteTemplateImage()} disabled={templateImageUploading()}>Remove photo</button>
                    </Show>
                  </div>
                </div>
                <p class="text-xs text-muted">JPEG, PNG, GIF or WebP, up to 5 MB.</p>
              </div>
            </Show>
            <p class="text-xs text-muted">Specificity: both fields set = most specific (score 2), one field = partial (score 1), neither = global fallback (score 0). The most specific matching template wins.</p>
            <div class="flex gap-2 pt-2">
              <button type="button" onClick={closeTemplateModal} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>Cancel</button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
                {pendingAction() ? 'Saving…' : editingTemplate() ? 'Update template' : cloningTemplate() ? 'Duplicate template' : 'Add template'}
              </button>
            </div>
          </form>
        </Dialog>
      </Show>

      {/* Metric Modal */}
      <Show when={showInterfaceMetricModal()}>
        <Dialog title={editingInterfaceMetric() ? 'Edit WAN/LAN metric' : 'Add WAN/LAN metric'} description="Use * for each dynamic index in the CWMP parameter path." headerBadge={<Show when={interfaceMetricDirty()}><span class="dialog-header-badge" role="status">Unsaved</span></Show>} onClose={closeInterfaceMetricModal} actions={<><button type="button" class="btn btn-secondary" onClick={closeInterfaceMetricModal}>Cancel</button><button type="submit" form="interface-metric-form" class="btn btn-primary">Save metric</button></>}>
          <form id="interface-metric-form" class="space-y-3" onSubmit={(event) => void saveInterfaceMetric(event)}>
            <label class="block text-xs text-muted">Name<input required class="input mt-1 w-full" value={interfaceMetricForm().name} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, name: e.currentTarget.value }))} /></label>
            <label class="block text-xs text-muted">Interface<select class="input mt-1 w-full" value={interfaceMetricForm().interface_type} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, interface_type: e.currentTarget.value as 'wan' | 'lan' }))}><option value="wan">WAN</option><option value="lan">LAN</option></select></label>
            <label for="interface-metric-source" class="block text-xs text-muted">Source<select id="interface-metric-source" class="input mt-1 w-full" value={interfaceMetricForm().source} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, source: e.currentTarget.value as 'passive' | 'active' | 'universal' }))}><option value="passive">Passive (from Inform)</option><option value="active">Active (polled via GPV)</option><option value="universal">Universal (both)</option></select></label>
            <label class="block text-xs text-muted">Parameter path pattern<input required class="input mt-1 w-full font-mono text-xs" placeholder="InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.Stats.EthernetBytesReceived" value={interfaceMetricForm().parameter_pattern} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, parameter_pattern: e.currentTarget.value }))} /></label>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4"><label class="block text-xs text-muted">Unit<input class="input mt-1 w-full" value={interfaceMetricForm().unit} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, unit: e.currentTarget.value }))} /></label><label class="block text-xs text-muted">Transform<select class="input mt-1 w-full" value={interfaceMetricForm().transform} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, transform: e.currentTarget.value }))}><option value="">Raw value</option><option value="rate">Rate</option></select></label><label class="block text-xs text-muted">Multiplier<input type="number" min="0" step="any" class="input mt-1 w-full" value={interfaceMetricForm().multiplier} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, multiplier: Number(e.currentTarget.value) }))} /></label><label class="block text-xs text-muted">Unit Scale<select class="input mt-1 w-full" value={interfaceMetricForm().unit_scale} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, unit_scale: e.currentTarget.value }))}><option value="">None</option><option value="bytes">Bytes (KB/MB/GB/TB)</option><option value="bits">Bits (Kb/Mb/Gb/Tb)</option><option value="pps">Packets per second (pps/Kpps/Mpps/Gpps)</option></select></label></div>
            <div class="block text-xs text-muted">Line color<ColorSwatch value={interfaceMetricForm().color} onChange={(color) => setInterfaceMetricForm(f => ({ ...f, color }))} /></div>
            <div class="grid grid-cols-2 gap-3"><label class="block text-xs text-muted">ECharts visualization<select class="input mt-1 w-full" value={interfaceMetricForm().chart_type} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, chart_type: e.currentTarget.value }))}><For each={ECHARTS_TYPES.filter(type => type.timeSeries)}>{(type) => <option value={type.value}>{type.label}</option>}</For></select></label><label class="block text-xs text-muted">Graph group<input class="input mt-1 w-full" maxLength={64} value={interfaceMetricForm().group} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, group: e.currentTarget.value }))} placeholder="e.g. WAN traffic" /></label></div>
            <p class="text-xs text-muted">Metrics with the same group name and chart type can be plotted together, such as received and sent bytes.</p>
            <label class="block text-xs text-muted">Description<input class="input mt-1 w-full" value={interfaceMetricForm().description} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, description: e.currentTarget.value }))} /></label>
            <label class="flex items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={interfaceMetricForm().active} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, active: e.currentTarget.checked }))} />Active</label>
          </form>
        </Dialog>
      </Show>
      <MetricModal
        templateId={selectedTemplate()?.id}
        open={showMetricModal()}
        editingMetric={editingMetric()}
        copyingMetric={copyingMetric()}
        onClose={() => { setShowMetricModal(false); setCopyingMetric(null); }}
        onSaved={() => refetchMetrics()}
      />
    </div>
  );
};

export default Provisioning;
