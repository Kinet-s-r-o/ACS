import { createSignal, createEffect, createMemo, createResource, onMount, onCleanup, Show, For, Index, type Component } from 'solid-js';
import { Activity, Copy, Download, Edit, Edit2, GripVertical, Image as ImageIcon, MoreVertical, Plus, Save, Search, Settings as SettingsIcon, Trash2, Upload, X, ChevronLeft } from 'lucide-solid';
import { api, type InterfaceMetricDefinition, type MetricDefinition, type ProvisioningRule, type ProvisioningTemplate, type ProvisioningVariable, type ProvisioningTransform } from '../lib/api';
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
import { metricsForTemplate } from '../lib/metricViews';
import MetricModal from '../components/MetricModal';
import ColorSwatch from '../components/ColorSwatch';
import { ECHARTS_TYPES } from '../lib/echartsTypes';
import { readMigratedStorageValue, writeMigratedStorageValue } from '../lib/storage';

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
  { id: 'status', label: 'Status', visible: true, order: 5 },
];

const PROV_STORAGE_KEY = 'acs-prov-columns';
const LEGACY_PROV_STORAGE_KEY = 'skyacs-prov-columns';

const Provisioning: Component = () => {
  const { isFullAccess } = useAuth();
  const { notify, confirm } = useFeedback();

  const [provRules, setProvRules] = createSignal<Awaited<ReturnType<typeof api.getProvisioningRules>> | null>(null);
  const [provTemplates, setProvTemplates] = createSignal<ProvisioningTemplate[] | null>(null);
  const [selectedTemplate, setSelectedTemplate] = createSignal<ProvisioningTemplate | null>(null);
  const [provError, setProvError] = createSignal<Error | null>(null);
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [showSettingsMenu, setShowSettingsMenu] = createSignal(false);
  const [showSettingsModal, setShowSettingsModal] = createSignal(false);
  const [settingsLoading, setSettingsLoading] = createSignal(false);
  const [settingsSaving, setSettingsSaving] = createSignal(false);
  const [refreshSettings, setRefreshSettings] = createSignal({ overview: '15m', full: '6h' });
  let settingsMenu: HTMLDivElement | undefined;
  const [showProvModal, setShowProvModal] = createSignal(false);
  const [editingProv, setEditingProv] = createSignal<ProvisioningRule | null>(null);
  const emptyProvisioningRule = { template_id: 0, parameter_name: '', parameter_value: '', parameter_type: 'string', phase: 'bootstrap', tags: [] as string[], enabled: true, description: '', add_object_path: '', order: 0, condition: '' };
  const [provForm, setProvForm] = createSignal({ ...emptyProvisioningRule });
  const [isAddObjectRule, setIsAddObjectRule] = createSignal(false);
  const [copyingProv, setCopyingProv] = createSignal(false);
  const [showTemplateModal, setShowTemplateModal] = createSignal(false);
  const [editingTemplate, setEditingTemplate] = createSignal<ProvisioningTemplate | null>(null);
  const [templateForm, setTemplateForm] = createSignal({ name: '', manufacturer: '', product_class: '', description: '' });
  const [templateImageUrl, setTemplateImageUrl] = createSignal<string | null>(null);
  const [templateImageUploading, setTemplateImageUploading] = createSignal(false);
  let templateImageInput: HTMLInputElement | undefined;
  let templateImageObjectUrl: string | null = null;
  const [templateTab, setTemplateTab] = createSignal<'rules' | 'variables' | 'metrics' | 'features'>('rules');
  const [templateVariables, setTemplateVariables] = createSignal<ProvisioningVariable[]>([]);
  const [variablesSaving, setVariablesSaving] = createSignal(false);
  const [featureName, setFeatureName] = createSignal('');
  const [featureCSV, setFeatureCSV] = createSignal('key,label,type,parameter,enabled_value,disabled_value,group,description\nftp_lan,FTP LAN,boolean,InternetGatewayDevice.X_HW_Security.AclServices.FTPLanEnable,1,0,LAN,Allow FTP from LAN\naccess_control_list,Access control list,object,InternetGatewayDevice.X_HW_Security.AclServices.AccessControl.List.,,,,');
  const [featureSaving, setFeatureSaving] = createSignal(false);
  const [metrics, { refetch: refetchMetrics }] = createResource(api.getMetricDefinitions);
  const [editingMetric, setEditingMetric] = createSignal<MetricDefinition | null>(null);
  const [showMetricModal, setShowMetricModal] = createSignal(false);
  const [interfaceMetrics, { refetch: refetchInterfaceMetrics }] = createResource(() => selectedTemplate()?.id, (id) => api.getInterfaceMetrics(id!));
  const [editingInterfaceMetric, setEditingInterfaceMetric] = createSignal<InterfaceMetricDefinition | null>(null);
  const [showInterfaceMetricModal, setShowInterfaceMetricModal] = createSignal(false);
  const [interfaceMetricForm, setInterfaceMetricForm] = createSignal({ name: '', description: '', interface_type: 'wan' as 'wan' | 'lan', parameter_pattern: '', unit: 'bytes', source: 'active' as 'passive' | 'active' | 'universal', unit_scale: '', color: '', group: '', chart_type: 'line', transform: '', multiplier: 1, active: true });

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
      if (stored) return JSON.parse(stored) as ProvColumnConfig[];
    } catch { /* ignore */ }
    return defaultProvColumns;
  })());
  const [provDraggedRow, setProvDraggedRow] = createSignal<number | null>(null);
  const [columnFilters, setColumnFilters] = createSignal<Record<string, ColumnFilterState>>({});
  const [searchQuery, setSearchQuery] = createSignal('');

  const getFilterValue = (rule: ProvisioningRule, colId: string): string => {
    switch (colId) {
      case 'parameter': return rule.add_object_path || rule.parameter_name || '';
      case 'value': return rule.add_object_path ? '' : rule.parameter_value || '';
      case 'parameter_type': return rule.parameter_type || '';
      case 'tags': return (rule.tags || []).join(', ');
      case 'phase': return rule.phase || '';
      case 'status': return rule.enabled ? 'Active' : 'Disabled';
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
        (r.tags || []).some(t => t.toLowerCase().includes(query)) ||
        r.phase?.toLowerCase().includes(query) ||
        r.description?.toLowerCase().includes(query) ||
        r.add_object_path?.toLowerCase().includes(query)
      );
    }
    return applyColumnFilters(all, columnFilters(), getFilterValue);
  });
  const [provPage, setProvPage] = createSignal(0);
  const { pageSize, changePageSize } = usePageSize('provisioning', 15);
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
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowSettingsMenu(false);
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
    const template = selectedTemplate();
    if (!file || !template) return;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      notify({ tone: 'error', title: 'Invalid device image', message: 'Use a JPEG, PNG, GIF, or WebP image up to 5 MB.' });
      if (templateImageInput) templateImageInput.value = '';
      return;
    }
    setTemplateImageUploading(true);
    try {
      const updated = await api.uploadProvisioningTemplateImage(template.id, file);
      setSelectedTemplate(updated);
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
    const template = selectedTemplate();
    if (!template || !template.image_url || !await confirm({ title: 'Remove device image?', description: 'The image will be removed from this provisioning template.', confirmLabel: 'Remove image', tone: 'danger' })) return;
    setTemplateImageUploading(true);
    try {
      await api.deleteProvisioningTemplateImage(template.id);
      setSelectedTemplate({ ...template, image_url: undefined });
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
      setShowSettingsModal(false);
      notify({ tone: 'success', title: 'Provisioning settings saved' });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save provisioning settings', detail: (error as Error).message, persistent: true });
    } finally {
      setSettingsSaving(false);
    }
  };

  createEffect(() => {
    const cols = provColumns();
    writeMigratedStorageValue(localStorage, PROV_STORAGE_KEY, LEGACY_PROV_STORAGE_KEY, JSON.stringify(cols));
  });

  const visibleProvColumns = () => provColumns().filter(c => c.visible).sort((a, b) => a.order - b.order);

  const toggleProvColumn = (id: string) => {
    setProvColumns(cols => cols.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
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
    setEditingProv(p);
    setCopyingProv(false);
    setIsAddObjectRule(Boolean(p.add_object_path));
    setProvForm({ template_id: p.template_id, parameter_name: p.add_object_path || p.parameter_name, parameter_value: p.parameter_value, parameter_type: p.parameter_type, phase: p.phase || 'bootstrap', tags: p.tags || [], enabled: p.enabled, description: p.description, add_object_path: p.add_object_path || '', order: p.order, condition: p.condition || '' });
    setShowProvModal(true);
  };

  const openCreateProv = () => {
    setEditingProv(null);
    setCopyingProv(false);
    setIsAddObjectRule(false);
    setProvForm({ ...emptyProvisioningRule, template_id: selectedTemplate()?.id || 0 });
    setShowProvModal(true);
  };

  const openCopyProv = (p: ProvisioningRule) => {
    setEditingProv(null);
    setCopyingProv(true);
    setIsAddObjectRule(Boolean(p.add_object_path));
    setProvForm({ template_id: p.template_id, parameter_name: p.add_object_path || p.parameter_name, parameter_value: p.parameter_value, parameter_type: p.parameter_type, phase: p.phase || 'bootstrap', tags: p.tags || [], enabled: p.enabled, description: p.description, add_object_path: p.add_object_path || '', order: p.order, condition: p.condition || '' });
    setShowProvModal(true);
  };

  const openCreateTemplate = () => {
    setEditingTemplate(null);
    setTemplateForm({ name: '', manufacturer: '', product_class: '', description: '' });
    setShowTemplateModal(true);
  };

  const openEditTemplate = (t: ProvisioningTemplate) => {
    setEditingTemplate(t);
    setTemplateForm({ name: t.name, manufacturer: t.manufacturer || '', product_class: t.product_class || '', description: t.description || '' });
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

  const importTemplateFeature = async () => {
    const template = selectedTemplate();
    if (!template || !featureName().trim() || featureSaving()) return;
    setFeatureSaving(true);
    try {
      const feature = await api.importTemplateFeature(template.id, featureName().trim(), featureCSV());
      setSelectedTemplate({ ...template, features: [...(template.features || []), feature] });
      setFeatureName('');
      await loadProvTemplates();
      notify({ tone: 'success', title: 'Feature added', message: `${feature.name} is available to devices matching ${template.name}.` });
    } catch (error) {
      notify({ tone: 'error', title: 'Could not import feature CSV', detail: (error as Error).message, persistent: true });
    } finally { setFeatureSaving(false); }
  };

  const downloadFeatureCSVTemplate = () => {
    const blob = new Blob(['key,label,type,parameter,options,enabled_value,disabled_value,group,description\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'feature-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const deleteTemplateFeature = async (featureID: string) => {
    const template = selectedTemplate();
    const feature = template?.features?.find(item => item.id === featureID);
    if (!template || !feature || !await confirm({ title: `Delete ${feature.name}?`, description: 'Devices matching this template will no longer show this feature.', confirmLabel: 'Delete feature', tone: 'danger' })) return;
    try {
      await api.deleteTemplateFeature(template.id, featureID);
      setSelectedTemplate({ ...template, features: template.features!.filter(item => item.id !== featureID) });
      await loadProvTemplates();
      notify({ tone: 'success', title: 'Feature deleted' });
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

  // Metrics tab: show every metric that applies to the selected template's
  // device scope (global / manufacturer / product class / concrete).
  const templateMetrics = createMemo(() => {
    const t = selectedTemplate();
    if (!t) return [];
    return metricsForTemplate(metrics() || [], t.manufacturer, t.product_class);
  });

  const openCreateMetric = () => {
    setEditingMetric(null);
    setShowMetricModal(true);
  };

  const openEditMetric = (def: MetricDefinition) => {
    setEditingMetric(def);
    setShowMetricModal(true);
  };

  const openInterfaceMetric = (def: InterfaceMetricDefinition | null = null) => {
    setEditingInterfaceMetric(def);
    setInterfaceMetricForm(def ? { name: def.name, description: def.description || '', interface_type: def.interface_type, parameter_pattern: def.parameter_pattern, unit: def.unit || '', source: def.source || 'active', unit_scale: def.unit_scale || '', color: def.color || '', group: def.group || '', chart_type: def.chart_type || 'line', transform: def.transform || '', multiplier: def.multiplier || 1, active: def.active } : { name: '', description: '', interface_type: 'wan', parameter_pattern: '', unit: 'bytes', source: 'active', unit_scale: '', color: '', group: '', chart_type: 'line', transform: '', multiplier: 1, active: true });
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
      await api.deleteMetricDefinition(def.id);
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
              <button onClick={openCreateTemplate} class="btn btn-primary text-xs py-1.5">
                <Plus size={12} />
                Add template
              </button>
            </div>
            <Show when={provError()}>
              <ResourceError title="Templates are unavailable" description="The provisioning templates could not be loaded." onRetry={loadProvTemplates} />
            </Show>
            <Show when={!provError() && provTemplates() !== null}>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <For each={provTemplates()}>
                  {(t) => (
                    <div class="rounded border border-subtle p-4 hover:border-primary/30 transition-colors cursor-pointer" onClick={() => selectTemplate(t)}>
                      <div class="flex items-start justify-between">
                        <div class="min-w-0">
                          <h3 class="text-sm font-medium text-primary truncate">{t.name}</h3>
                          <p class="text-xs text-muted mt-1">
                            {t.manufacturer || t.product_class
                              ? [t.manufacturer, t.product_class].filter(Boolean).join(' / ')
                              : 'Global (all devices)'}
                          </p>
                          <Show when={t.description}>
                            <p class="text-xs text-muted mt-1 truncate">{t.description}</p>
                          </Show>
                        </div>
                        <div class="flex items-center gap-1 shrink-0 ml-2">
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
                <div class="h-12 w-16 shrink-0 overflow-hidden rounded border border-subtle bg-elevated grid place-items-center">
                  <Show when={templateImageUrl()} fallback={<ImageIcon size={18} class="text-muted" />}>
                    <img src={templateImageUrl()!} alt={`Device image for ${selectedTemplate()!.name}`} class="h-full w-full object-cover" />
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
              <div class="flex items-center gap-2">
                <input id="template-device-image" ref={(element) => { templateImageInput = element; }} type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="sr-only" onChange={(event) => void handleTemplateImageSelected(event)} disabled={templateImageUploading()} />
                <label for="template-device-image" class="btn btn-secondary text-xs py-1.5 cursor-pointer" aria-disabled={templateImageUploading()}>
                  <Upload size={12} />
                  {templateImageUploading() ? 'Uploading…' : 'Device photo'}
                </label>
                <Show when={selectedTemplate()!.image_url}>
                  <button type="button" class="btn btn-ghost text-xs" onClick={() => void handleDeleteTemplateImage()} disabled={templateImageUploading()}>Remove photo</button>
                </Show>
                <Show when={templateTab() === 'rules'}>
                  <div class="relative">
                    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                    <input type="text" value={searchQuery()} onInput={(e) => setSearchQuery(e.currentTarget.value)} placeholder="Search rules…" class="input pl-9! w-56 text-sm" />
                    <Show when={searchQuery()}>
                      <button onClick={() => setSearchQuery('')} class="input-clear" aria-label="Clear search"><X size={12} /></button>
                    </Show>
                  </div>
                  <button onClick={openCreateProv} class="btn btn-primary text-xs py-1.5">
                    <Plus size={12} />
                    Add rule
                  </button>
                </Show>
                <Show when={templateTab() === 'metrics'}>
                  <button onClick={openCreateMetric} class="btn btn-primary text-xs py-1.5">
                    <Plus size={12} />
                    Add metric
                  </button>
                  <button onClick={() => openInterfaceMetric()} class="btn btn-secondary text-xs py-1.5">
                    <Plus size={12} />
                    Add WAN/LAN metric
                  </button>
                </Show>
                <Show when={templateTab() === 'variables'}>
                  <button onClick={addTemplateVariable} class="btn btn-secondary text-xs py-1.5"><Plus size={12} />Add variable</button>
                  <button onClick={() => void saveTemplateVariables()} class="btn btn-primary text-xs py-1.5" disabled={variablesSaving()}><Save size={12} />{variablesSaving() ? 'Saving…' : 'Save variables'}</button>
                </Show>
              </div>
            </div>

            <div class="flex gap-1 border-b border-subtle mb-4">
              <button type="button" onClick={() => setTemplateTab('rules')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'rules' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>Rules</button>
              <button type="button" onClick={() => setTemplateTab('variables')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'variables' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>Variables</button>
              <button type="button" onClick={() => setTemplateTab('metrics')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'metrics' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>
                <span class="flex items-center gap-1.5"><Activity size={12} />Metrics</span>
              </button>
              <button type="button" onClick={() => setTemplateTab('features')} class={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${templateTab() === 'features' ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-primary'}`}>Features</button>
            </div>

          <Show when={templateTab() === 'features'}>
            <div class="space-y-4">
              <div class="rounded border border-subtle bg-elevated/30 p-3 text-xs text-secondary">
                Define model-specific controls with CSV. Supported types are <code>boolean</code>, <code>string</code>, <code>int</code>, <code>unsignedInt</code>, and <code>object</code>; string controls may use pipe-separated values in <code>options</code>, and object paths must end in a dot.
                Required columns: <code>key,label,type,parameter</code>. Optional columns: <code>options,enabled_value,disabled_value,group,description</code>.
              </div>
              <div class="grid gap-3 lg:grid-cols-2">
                <label class="block text-xs text-muted">Feature name
                  <input class="input mt-1 w-full" maxlength="128" value={featureName()} onInput={event => setFeatureName(event.currentTarget.value)} placeholder="Services" />
                </label>
                <div class="flex items-end text-xs text-muted">This feature is scoped to <strong class="ml-1 text-secondary">{selectedTemplate()!.name}</strong>.</div>
              </div>
              <div class="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
                <label class="block text-xs text-muted">Load CSV file
                  <input class="input mt-1 w-full" type="file" accept=".csv,text/csv" onChange={async event => { const file = event.currentTarget.files?.[0]; if (file) setFeatureCSV(await file.text()); }} />
                </label>
                <button type="button" class="btn btn-secondary text-xs" onClick={downloadFeatureCSVTemplate}><Download size={13} />Download CSV template</button>
              </div>
              <label class="block text-xs text-muted">CSV definition
                <textarea class="input mt-1 min-h-40 w-full font-mono text-xs" spellcheck={false} value={featureCSV()} onInput={event => setFeatureCSV(event.currentTarget.value)} />
              </label>
              <div class="flex justify-end"><button type="button" class="btn btn-primary text-xs" disabled={!featureName().trim() || featureSaving()} onClick={() => void importTemplateFeature()}><Upload size={13} />{featureSaving() ? 'Importing…' : 'Import feature'}</button></div>
              <Show when={(selectedTemplate()?.features?.length || 0) > 0} fallback={<EmptyState compact title="No template features yet" description="Imported feature definitions will appear on matching devices." />}>
                <div class="space-y-3">
                  <For each={selectedTemplate()?.features || []}>{feature => <section class="card p-4 space-y-3">
                    <div class="flex items-center justify-between"><div><h3 class="text-sm font-medium text-primary">{feature.name}</h3><p class="text-xs text-muted">{feature.controls.length} controls</p></div><button type="button" class="btn btn-ghost text-xs text-rose-400" onClick={() => void deleteTemplateFeature(feature.id)}><Trash2 size={13} />Delete</button></div>
                    <div class="overflow-x-auto"><table class="data-table w-full text-xs"><thead><tr><th class="text-left">Label</th><th class="text-left">Type</th><th class="text-left">CWMP path</th><th class="text-left">Group</th></tr></thead><tbody><For each={feature.controls}>{control => <tr><td>{control.label}</td><td>{control.type}</td><td class="font-mono">{control.parameter}</td><td>{control.group || '—'}</td></tr>}</For></tbody></table></div>
                  </section>}</For>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={templateTab() === 'rules'}>
          <Show when={provError()}>
            <ResourceError title="Provisioning rules are unavailable" description="The current provisioning policy could not be loaded. Retry before changing a device rollout." onRetry={loadProvRules} />
          </Show>

          <Show when={!provError() && provRules() !== null}>
            <div class="overflow-x-auto table-scroll">
              <table class="w-full text-left">
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
                          <td class="py-2 pr-4">
                            <span class="text-secondary text-xs font-mono">{p.add_object_path || p.parameter_name}</span>
                            <Show when={p.add_object_path}>
                              <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 ml-1.5">AddObject</span>
                            </Show>
                            <Show when={p.condition}>
                              <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 ml-1.5">Conditional</span>
                            </Show>
                            <Show when={p.description}>
                              <p class="text-muted text-xs">{p.description}</p>
                            </Show>
                          </td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'value')}>
                          <td class="py-2 text-secondary text-xs font-mono max-w-xs truncate">{p.add_object_path ? '—' : p.parameter_value}</td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'parameter_type')}>
                          <td class="py-2 text-secondary text-xs">{p.add_object_path ? '—' : (p.parameter_type || '—')}</td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'tags')}>
                          <td class="py-2 text-secondary text-xs">
                            {(p.tags && p.tags.length > 0) ? (
                              <span class="flex flex-wrap gap-1">
                                <For each={p.tags}>
                                  {(tag) => <span class="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">{tag}</span>}
                                </For>
                              </span>
                            ) : '—'}
                          </td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'phase')}>
                          <td class="py-2">
                            <span class={`text-xs px-1.5 py-0.5 rounded ${p.phase === 'default' ? 'bg-blue-500/10 text-blue-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{p.phase || 'bootstrap'}</span>
                          </td>
                        </Show>
                        <Show when={visibleProvColumns().some(c => c.id === 'status')}>
                          <td class="py-2">
                            <button
                              onClick={() => handleToggleProv(p.id, !p.enabled)}
                              class={`btn ${p.enabled ? 'btn-secondary' : 'btn-danger'}`}
                              aria-pressed={p.enabled}
                              disabled={pendingAction() !== null}
                            >
                              {pendingAction() === `toggle-provisioning-${p.id}` ? 'Updating…' : p.enabled ? 'Active' : 'Disabled'}
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
            <div class="px-4 py-3">
              <Pagination page={provPage()} totalPages={provTotalPages()} totalItems={filteredProvRules().length} pageSize={pageSize()} onPageChange={setProvPage} storageKey="provisioning" onPageSizeChange={handlePageSizeChange} />
            </div>
          </Show>

          <Show when={!provError() && provRules() !== null && (provRules()?.length ?? 0) === 0}>
            <EmptyState compact title="No provisioning rules exist" description="Add a rule to this template to start provisioning." action={<button type="button" class="btn btn-primary" onClick={openCreateProv}>Add rule</button>} />
          </Show>
          </Show>

          <Show when={templateTab() === 'variables'}>
            <div class="space-y-4">
              <div class="rounded border border-subtle bg-base p-3 text-xs text-muted">
                Define reusable values for this template. Sources may be device identity, a literal, or a parameter reported in Inform. Leave the source empty to start with an empty value, then use a transformation such as Random string. Use <code class="text-primary">{'{{variable_name}}'}</code> in provisioning rule values. Transformations run in order.
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
                        <label class="block text-xs text-muted md:col-span-3">Transformation<select class="input mt-1 w-full" value={step().function} onChange={event => { const fn = event.currentTarget.value; updateVariableTransform(variableIndex, stepIndex, { function: fn, args: fn === 'random_string' ? { length: '12', charset: 'alphanumeric' } : {} }); }}>
                          <option value="trim">Trim whitespace</option><option value="upper">Uppercase</option><option value="lower">Lowercase</option><option value="prefix">Add prefix</option><option value="suffix">Add suffix</option><option value="slice">Slice by indexes</option><option value="replace">Replace text</option><option value="regex_replace">Replace by regex</option><option value="pad_start">Pad at start</option><option value="pad_end">Pad at end</option><option value="default">Fallback if empty</option><option value="random_string">Generate random string</option><option value="sha256">SHA-256 hash</option><option value="base64_encode">Base64 encode</option><option value="base64_decode">Base64 decode</option><option value="hex_encode">Hex encode</option><option value="hex_decode">Hex decode</option>
                        </select></label>
                        <For each={argumentFields[step().function] || []}>{([key, label]) => <label class="block text-xs text-muted md:col-span-2">{label}<input class="input mt-1 w-full" value={step().args?.[key] || (step().function === 'random_string' && key === 'charset' ? 'alphanumeric' : '')} onInput={event => updateVariableTransform(variableIndex, stepIndex, { args: { ...step().args, [key]: event.currentTarget.value } })} /></label>}</For>
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
                <table class="w-full text-left">
                  <thead>
                    <tr class="border-b border-subtle">
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Name</th>
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Parameter</th>
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Device Match</th>
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Source</th>
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Unit</th>
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Group</th>
                      <th class="py-2 pr-4 text-xs font-medium text-muted uppercase tracking-wide">Active</th>
                      <th class="py-2 text-right text-xs font-medium text-muted uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={templateMetrics()}>
                      {(def) => (
                        <tr class="border-t border-subtle hover:bg-elevated/30 transition-colors">
                          <td class="px-3 py-2.5 text-primary font-medium">
                            {def.name}
                            <Show when={def.description}>
                              <div class="text-[10px] text-muted mt-0.5">{def.description}</div>
                            </Show>
                          </td>
                          <td class="px-3 py-2.5 text-secondary font-mono text-xs">{def.parameter_name}</td>
                          <td class="px-3 py-2.5 text-secondary font-mono text-xs">{def.device_type_match}</td>
                          <td class="px-3 py-2.5">
                            <span class={`badge ${def.source === 'active' ? 'badge-warning' : def.source === 'universal' ? 'badge-success' : ''}`}>{def.source}</span>
                          </td>
                          <td class="px-3 py-2.5 text-secondary">{def.unit || '—'}</td>
                          <td class="px-3 py-2.5 text-secondary">
                            <div class="flex items-center gap-1.5">
                              <span class="w-2.5 h-2.5 rounded-[2px] inline-block" style={{ background: def.color || '#475569' }} />
                              <span class="text-xs">{def.group || '—'}</span>
                            </div>
                          </td>
                          <td class="px-3 py-2.5 text-center">
                            <span class={`badge ${def.active ? 'badge-success' : 'badge-muted'}`}>{def.active ? 'Yes' : 'No'}</span>
                          </td>
                          <td class="px-3 py-2.5 text-right">
                            <div class="flex justify-end gap-1">
                              <button onClick={() => openEditMetric(def)} class="btn btn-ghost text-xs" title="Edit">
                                <Edit size={12} />
                              </button>
                              <button onClick={() => handleDeleteMetric(def)} class="btn btn-ghost text-xs text-red-400" title="Delete">
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </td>
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
              <h3 class="text-sm font-semibold text-primary mb-3">Per-interface WAN/LAN metrics</h3>
              <Show when={interfaceMetrics()?.length} fallback={<p class="text-xs text-muted">No per-interface metrics configured for this template.</p>}>
                <div class="overflow-x-auto table-scroll"><table class="w-full text-left"><thead><tr class="border-b border-subtle text-xs text-muted uppercase"><th class="py-2 pr-3">Name</th><th class="py-2 pr-3">Type</th><th class="py-2 pr-3">Source</th><th class="py-2 pr-3">Parameter pattern</th><th class="py-2 pr-3">Color</th><th class="py-2 pr-3">Chart</th><th class="py-2 pr-3">Group</th><th class="py-2 pr-3">Transform</th><th class="py-2 pr-3">Multiplier</th><th class="py-2 pr-3">Unit scale</th><th class="py-2 text-right">Actions</th></tr></thead>
                  <tbody><For each={interfaceMetrics() || []}>{(def) => <tr class="border-b border-subtle/50 text-xs"><td class="py-2 pr-3 text-primary">{def.name}</td><td class="py-2 pr-3 uppercase">{def.interface_type}</td><td class="py-2 pr-3"><span class={`badge ${def.source === 'active' ? 'badge-warning' : def.source === 'universal' ? 'badge-success' : ''}`}>{def.source}</span></td><td class="py-2 pr-3 font-mono break-all">{def.parameter_pattern}</td><td class="py-2 pr-3"><span class="inline-block h-3 w-6 rounded-sm" style={{ background: def.color || '#38bdf8' }} title={def.color || 'Default'} /></td><td class="py-2 pr-3">{def.chart_type || 'line'}</td><td class="py-2 pr-3">{def.group || '—'}</td><td class="py-2 pr-3">{def.transform || 'raw'}</td><td class="py-2 pr-3">{def.multiplier}</td><td class="py-2 pr-3">{def.unit_scale || 'none'}</td><td class="py-2 text-right"><button class="btn btn-ghost text-xs" onClick={() => openInterfaceMetric(def)}><Edit size={12} /></button><button class="btn btn-ghost text-xs text-red-400" onClick={() => void deleteInterfaceMetric(def)}><Trash2 size={12} /></button></td></tr>}</For></tbody></table></div>
              </Show>
            </section>
          </Show>
          </div>
        </Show>
      </Show>

      {/* Provisioning Modal */}
      <Show when={showSettingsModal()}>
        <Dialog title="Provisioning settings" description="Refresh intervals are checked whenever the CPE sends an Inform." onClose={() => setShowSettingsModal(false)} actions={<>
          <button type="button" class="btn btn-secondary" onClick={() => setShowSettingsModal(false)} disabled={settingsSaving()}>Cancel</button>
          <Show when={isFullAccess()}><button type="submit" form="provisioning-settings-form" class="btn btn-primary" disabled={settingsSaving()}>{settingsSaving() ? 'Saving…' : 'Save settings'}</button></Show>
        </>}>
          <form id="provisioning-settings-form" class="space-y-4" onSubmit={(event) => { event.preventDefault(); void saveRefreshSettings(); }}>
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
          onClose={() => setShowProvModal(false)}
        >
          <form onSubmit={(e) => { e.preventDefault(); editingProv() ? handleUpdateProv() : handleCreateProv(); }} class="space-y-4">
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
              <label class="block text-xs text-muted mb-1.5">Tags (optional)</label>
              <div class="flex flex-wrap gap-1.5 mb-1.5">
                <For each={provForm().tags}>
                  {(tag) => (
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 text-xs">
                      {tag}
                      <button type="button" class="hover:text-amber-100" onClick={() => setProvForm(f => ({ ...f, tags: f.tags.filter(x => x !== tag) }))} aria-label={`Remove tag ${tag}`}>
                        <X size={10} />
                      </button>
                    </span>
                  )}
                </For>
              </div>
              <input
                id="provisioning-tags"
                type="text"
                class="input w-full"
                placeholder="branch-a (press Enter to add)"
                value={provForm().tags.length > 0 ? '' : ''}
                onInput={(e) => {
                  const val = e.currentTarget.value;
                  setProvForm(f => ({ ...f, _tagInput: val } as any));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = (e.currentTarget.value || '').trim().toLowerCase();
                    if (val && !provForm().tags.includes(val)) {
                      setProvForm(f => ({ ...f, tags: [...f.tags, val] }));
                    }
                    (e.currentTarget as HTMLInputElement).value = '';
                  }
                }}
              />
              <p class="text-xs text-muted mt-1">Rule applies only to CPEs carrying at least one of these tags. Leave empty to apply to all devices in this template.</p>
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
              <button type="button" onClick={() => setShowProvModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>Cancel</button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
                {pendingAction() ? 'Saving rule…' : editingProv() ? 'Update rule' : 'Add rule'}
              </button>
            </div>
          </form>
        </Dialog>
      </Show>
      <Show when={showTemplateModal()}>
        <Dialog
          title={editingTemplate() ? 'Edit template' : 'Add template'}
          onClose={() => setShowTemplateModal(false)}
        >
          <form onSubmit={(e) => { e.preventDefault(); editingTemplate() ? handleUpdateTemplate() : handleCreateTemplate(); }} class="space-y-4">
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
            <p class="text-xs text-muted">Specificity: both fields set = most specific (score 2), one field = partial (score 1), neither = global fallback (score 0). The most specific matching template wins.</p>
            <div class="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowTemplateModal(false)} class="btn btn-secondary flex-1" disabled={pendingAction() !== null}>Cancel</button>
              <button type="submit" class="btn btn-primary flex-1" disabled={pendingAction() !== null}>
                {pendingAction() ? 'Saving…' : editingTemplate() ? 'Update template' : 'Add template'}
              </button>
            </div>
          </form>
        </Dialog>
      </Show>

      {/* Metric Modal */}
      <Show when={showInterfaceMetricModal()}>
        <Dialog title={editingInterfaceMetric() ? 'Edit WAN/LAN metric' : 'Add WAN/LAN metric'} description="Use * for each dynamic index in the CWMP parameter path." onClose={() => setShowInterfaceMetricModal(false)} actions={<><button type="button" class="btn btn-secondary" onClick={() => setShowInterfaceMetricModal(false)}>Cancel</button><button type="submit" form="interface-metric-form" class="btn btn-primary">Save metric</button></>}>
          <form id="interface-metric-form" class="space-y-3" onSubmit={(event) => void saveInterfaceMetric(event)}>
            <label class="block text-xs text-muted">Name<input required class="input mt-1 w-full" value={interfaceMetricForm().name} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, name: e.currentTarget.value }))} /></label>
            <label class="block text-xs text-muted">Interface<select class="input mt-1 w-full" value={interfaceMetricForm().interface_type} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, interface_type: e.currentTarget.value as 'wan' | 'lan' }))}><option value="wan">WAN</option><option value="lan">LAN</option></select></label>
            <label for="interface-metric-source" class="block text-xs text-muted">Source<select id="interface-metric-source" class="input mt-1 w-full" value={interfaceMetricForm().source} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, source: e.currentTarget.value as 'passive' | 'active' | 'universal' }))}><option value="passive">Passive (from Inform)</option><option value="active">Active (polled via GPV)</option><option value="universal">Universal (both)</option></select></label>
            <label class="block text-xs text-muted">Parameter path pattern<input required class="input mt-1 w-full font-mono text-xs" placeholder="InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.Stats.EthernetBytesReceived" value={interfaceMetricForm().parameter_pattern} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, parameter_pattern: e.currentTarget.value }))} /></label>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4"><label class="block text-xs text-muted">Unit<input class="input mt-1 w-full" value={interfaceMetricForm().unit} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, unit: e.currentTarget.value }))} /></label><label class="block text-xs text-muted">Transform<select class="input mt-1 w-full" value={interfaceMetricForm().transform} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, transform: e.currentTarget.value }))}><option value="">Raw value</option><option value="rate">Rate</option></select></label><label class="block text-xs text-muted">Multiplier<input type="number" min="0" step="any" class="input mt-1 w-full" value={interfaceMetricForm().multiplier} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, multiplier: Number(e.currentTarget.value) }))} /></label><label class="block text-xs text-muted">Unit Scale<select class="input mt-1 w-full" value={interfaceMetricForm().unit_scale} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, unit_scale: e.currentTarget.value }))}><option value="">None</option><option value="bytes">Bytes (KB/MB/GB/TB)</option><option value="bits">Bits (Kb/Mb/Gb/Tb)</option><option value="pps">Packets per second (pps/Kpps/Mpps/Gpps)</option></select></label></div>
            <label class="block text-xs text-muted">Line color<ColorSwatch value={interfaceMetricForm().color} onChange={(color) => setInterfaceMetricForm(f => ({ ...f, color }))} /></label>
            <div class="grid grid-cols-2 gap-3"><label class="block text-xs text-muted">ECharts visualization<select class="input mt-1 w-full" value={interfaceMetricForm().chart_type} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, chart_type: e.currentTarget.value }))}><For each={ECHARTS_TYPES.filter(type => type.timeSeries)}>{(type) => <option value={type.value}>{type.label}</option>}</For></select></label><label class="block text-xs text-muted">Graph group<input class="input mt-1 w-full" maxLength={64} value={interfaceMetricForm().group} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, group: e.currentTarget.value }))} placeholder="e.g. WAN traffic" /></label></div>
            <p class="text-xs text-muted">Metrics with the same group name and chart type can be plotted together, such as received and sent bytes.</p>
            <label class="block text-xs text-muted">Description<input class="input mt-1 w-full" value={interfaceMetricForm().description} onInput={(e) => setInterfaceMetricForm(f => ({ ...f, description: e.currentTarget.value }))} /></label>
            <label class="flex items-center gap-2 text-xs text-secondary"><input type="checkbox" checked={interfaceMetricForm().active} onChange={(e) => setInterfaceMetricForm(f => ({ ...f, active: e.currentTarget.checked }))} />Active</label>
          </form>
        </Dialog>
      </Show>
      <MetricModal
        open={showMetricModal()}
        editingMetric={editingMetric()}
        onClose={() => setShowMetricModal(false)}
        onSaved={() => refetchMetrics()}
      />
    </div>
  );
};

export default Provisioning;
