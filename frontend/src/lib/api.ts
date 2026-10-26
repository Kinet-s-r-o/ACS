export const API_BASE = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:7548`;

export interface Device {
  id: number;
  serial_number: string;
  oui: string;
  manufacturer: string | null;
  product_class: string | null;
  model_name: string | null;
  hardware_version: string | null;
  software_version: string | null;
  ip_address: string | null;
  connection_request_url: string | null;
  conn_cred_mode: string | null;
  conn_cred_username: string | null;
  conn_cred_password: string | null;
  tags: string[] | null;
  last_inform: string | null;
  last_overview_refresh: string | null;
  last_full_refresh: string | null;
  online: boolean;
  created_at: string;
  updated_at: string;
  parameters?: DeviceParameter[];
}

export interface DeviceStats { total: number; online: number; offline: number }
export interface DeviceListResponse { devices: Device[]; total: number; limit: number; offset: number }
export interface DeviceParameter { id: number; device_id: number; name: string; value: string; value_type?: string; writable?: boolean; updated_at: string }
export interface WANInterface { serial_number: string; name: string; status: string; ip_address: string; mac_address: string }
export interface Task { id: number; device_id: number; type: string; payload?: unknown; status: string; result?: unknown; error_message?: string; created_at: string; sent_at?: string; completed_at?: string; created_by?: string; deleted_by?: string }
export interface GlobalTask extends Task { serial_number: string }
export interface DeviceTaskCounts { pending: number; sent: number; completed: number; failed: number; deleted: number; total: number }
export interface SnapshotParameter { name: string; value: string; value_type?: string; writable?: boolean }
export interface DeviceSnapshot { id: number; device_id: number; name: string; manufacturer?: string | null; product_class?: string | null; software_version?: string | null; parameter_count: number; parameters?: SnapshotParameter[]; created_by?: string; created_at: string }
export interface Firmware { id: number; filename: string; version: string; manufacturer?: string; product_class?: string; file_size: number; checksum?: string; description?: string; created_at: string; updated_at: string }
export interface Fault { id: number; device_id: number; serial_number: string; fault_code: string; fault_string: string; parameter_name: string; resolved: boolean; created_at: string; resolved_at: string | null }
export interface FaultCounts { active: number; resolved: number; total: number }
export interface User { id: number; username: string; first_name: string; last_name: string; email: string; required_2fa: boolean; two_factor_configured: boolean; role: 'full' | 'read'; role_id: number | null; created_at: string; last_login: string | null }
export interface TagDefinition { id: string; name: string; color: string; description?: string; created_at: string; updated_at: string }
export interface Role { id: number; name: string; description: string; permissions: string[]; is_system: boolean; created_at: string; updated_at: string }
export interface ProvisioningTransform { function: string; args?: Record<string, string> }
export interface ProvisioningVariable { name: string; source: string; value?: string; steps: ProvisioningTransform[] }
export interface ProvisioningObjectField { name: string; label: string; type: 'boolean' | 'string' | 'int' | 'unsignedInt'; input: 'input' | 'select' | 'boolean'; help?: string; options?: string[]; option_labels?: Record<string, string>; enabled_value?: string; disabled_value?: string }
export interface ProvisioningFeatureControl { key: string; label: string; type: 'boolean' | 'string' | 'int' | 'unsignedInt' | 'object'; parameter: string; options?: string[]; enabled_value?: string; disabled_value?: string; group?: string; description?: string; object_fields?: ProvisioningObjectField[] }
export interface ProvisioningFeature { id: string; name: string; description?: string; controls: ProvisioningFeatureControl[] }
export interface ProvisioningTemplate { id: number; name: string; manufacturer: string; product_class: string; description?: string; variables?: ProvisioningVariable[]; features?: ProvisioningFeature[]; image_url?: string; created_at: string; updated_at: string }
export type InterfaceMetricDefinition = MetricDefinition & Required<Pick<MetricDefinition, 'template_id' | 'interface_type' | 'parameter_pattern'>>;
export interface InterfaceMetricSample { device_id: number; metric_id: number; parameter_name: string; value: number; timestamp: string }
export interface ProvisioningRule { id: number; template_id: number; parameter_name: string; parameter_value: string; parameter_type: string; phase: string; tags?: string[]; excluded_tags?: string[]; enabled: boolean; description: string; add_object_path?: string; order: number; condition?: string }
export interface AuditLog { id: number; user_id?: number; username: string; action: string; resource: string; status: number; ip_address: string; user_agent?: string; created_at: string }
export interface BlockedDevice { id: number; serial_number: string; reason: string; created_by: string; created_at: string }
export interface Threshold {
  value: number;
  color: string;
}

export type GaugeStyle = 'basic' | 'simple' | 'speed' | 'progress' | 'stage' | 'grade' | 'multi' | 'temperature' | 'ring' | 'barometer';
export interface MetricDefinition { id: number; name: string; description: string; device_type_match: string; template_id?: number | null; interface_type?: 'wan' | 'lan'; parameter_pattern?: string; parameter_name: string; unit: string; source: 'passive' | 'active' | 'universal'; active: boolean; store_history: boolean; group: string; color: string; axis: 'left' | 'right'; transform: string; multiplier: number; unit_scale: string; health: boolean; health_order: number; health_size: 'small' | 'medium' | 'large'; warn_threshold: number | null; critical_threshold: number | null; threshold_direction: 'higher_is_worse' | 'lower_is_worse'; display_format: 'number' | 'uptime' | 'gauge'; gauge_animated: boolean; gauge_min: number | null; gauge_max: number | null; gauge_arc: '180' | '220' | '270' | '360'; gauge_pointer: boolean; gauge_style: GaugeStyle; thresholds: Threshold[]; chart_type: string; created_at: string; updated_at: string }
export interface MetricSample { device_id: number; metric_id: number; value: number; timestamp: string }
export interface AggregatedMetric { timestamp: string; avg: number; min: number; max: number; count: number }

import { removeMigratedStorageValue } from './storage';

export const clearStoredSession = () => {
  removeMigratedStorageValue(sessionStorage, 'acs_token', 'skyacs_token');
  localStorage.removeItem('token');
};

const getCookie = (name: string): string | null => {
	const prefix = `${name}=`;
	const value = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));
	return value ? decodeURIComponent(value.slice(prefix.length)) : null;
};

const addCsrfHeader = (headers: Headers, method?: string) => {
	if (!['GET', 'HEAD', 'OPTIONS'].includes((method ?? 'GET').toUpperCase())) {
		const csrfToken = getCookie('acs_csrf');
		if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
	}
};

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
	addCsrfHeader(headers, options.method);

	const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    if (response.status === 401) {
      clearStoredSession();
      if (window.location.pathname !== '/login') window.location.assign('/login');
    }
    const error = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function requestBlob(endpoint: string, options: RequestInit = {}): Promise<Blob> {
  const headers = new Headers(options.headers);
	addCsrfHeader(headers, options.method);
	const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    if (response.status === 401) {
      clearStoredSession();
      if (window.location.pathname !== '/login') window.location.assign('/login');
    }
    const error = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.blob();
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  getDevices: (limit = 50, offset = 0) => request<DeviceListResponse>(`/devices?limit=${limit}&offset=${offset}`),
  getWANInterfaces: () => request<WANInterface[]>('/wan-interfaces'),
  getTasks: () => request<GlobalTask[]>('/tasks'),
  getTask: (id: number) => request<GlobalTask>(`/tasks/${id}`),
  deletePendingTask: (id: number) => request<{ status: string }>(`/tasks/${id}`, { method: 'DELETE' }),
  getDevice: (serial: string) => request<Device>(`/device/${encodeURIComponent(serial)}`),
  setDeviceTags: (serial: string, tags: string[]) => request<{ status: string; tags: string[] }>(`/device/${encodeURIComponent(serial)}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) }),
  getTags: () => request<TagDefinition[]>('/tags'),
  createTag: (body: { name: string; color: string; description?: string }) => request<TagDefinition>('/tags', { method: 'POST', body: JSON.stringify(body) }),
  updateTag: (id: string, body: { name: string; color: string; description?: string }) => request<TagDefinition>(`/tags/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTag: (id: string) => request<{ status: string }>(`/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getDeviceStats: () => request<DeviceStats>('/devices/stats'),
  getDeviceAnalytics: () => request<{ rxPower: Record<string, number>; temperature: Record<string, number>; uptime: Record<string, number>; accessType: Record<string, number>; lastInform: Record<string, number>; wifiStations: Record<string, number>; manufacturers: Record<string, number>; productClasses: Record<string, number>; sampled: number; total: number }>('/devices/analytics'),
  getDeviceTypes: () => request<string[]>('/devices/device-types'),
  getDeviceParameters: (serial: string) => request<DeviceParameter[]>(`/device/${encodeURIComponent(serial)}/parameters`),
  getDeviceTasks: (serial: string) => request<Task[]>(`/device/${encodeURIComponent(serial)}/tasks`),
  getDeviceTaskCounts: (serial: string) => request<DeviceTaskCounts>(`/device/${encodeURIComponent(serial)}/task-counts`),
  getDeviceSnapshots: (serial: string) => request<DeviceSnapshot[]>(`/device/${encodeURIComponent(serial)}/snapshots`),
  getDeviceSnapshot: (serial: string, id: number) => request<DeviceSnapshot>(`/device/${encodeURIComponent(serial)}/snapshots/${id}`),
  createDeviceSnapshot: (serial: string, name?: string) => request<DeviceSnapshot>(`/device/${encodeURIComponent(serial)}/snapshots`, { method: 'POST', body: JSON.stringify({ name }) }),
  restoreDeviceSnapshot: (serial: string, id: number, parameters?: string[]) => request<{ task: Task; restored: number }>(`/device/${encodeURIComponent(serial)}/snapshots/${id}/restore`, { method: 'POST', body: JSON.stringify({ parameters }) }),
  deleteDeviceSnapshot: (serial: string, id: number) => request<{ status: string }>(`/device/${encodeURIComponent(serial)}/snapshots/${id}`, { method: 'DELETE' }),
  getDeviceFaults: (serial: string) => request<Fault[]>(`/device/${encodeURIComponent(serial)}/faults`),
  getDeviceFaultCounts: (serial: string) => request<FaultCounts>(`/device/${encodeURIComponent(serial)}/fault-counts`),
  getParameterValues: (serial: string, parameters: string[]) => request<Task>(`/device/${encodeURIComponent(serial)}/get-parameters`, { method: 'POST', body: JSON.stringify({ parameters }) }),
  setParameterValues: (serial: string, parameters: Record<string, string>) => request<Task>(`/device/${encodeURIComponent(serial)}/set-parameters`, { method: 'POST', body: JSON.stringify({ parameters }) }),
  rebootDevice: (serial: string) => request<Task>(`/device/${encodeURIComponent(serial)}/reboot`, { method: 'POST' }),
  factoryResetDevice: (serial: string, currentPassword: string) => request<Task>(`/device/${encodeURIComponent(serial)}/factory-reset`, { method: 'POST', body: JSON.stringify({ current_password: currentPassword }) }),
  deleteDevice: (serial: string) => request<{ status: string }>(`/device/${encodeURIComponent(serial)}`, { method: 'DELETE' }),
  connectionRequest: (serial: string) => request<{ status: string; url: string; message: string }>(`/device/${encodeURIComponent(serial)}/connection-request`, { method: 'POST' }),
  downloadFirmware: (serial: string, firmwareId: number, fileType?: string) => request<Task>(`/device/${encodeURIComponent(serial)}/download-firmware`, { method: 'POST', body: JSON.stringify({ firmware_id: firmwareId, file_type: fileType }) }),
  updateConnCredentials: (serial: string, body: { mode: string; username?: string; password?: string }) => request<{ status: string; mode: string }>(`/device/${encodeURIComponent(serial)}/conn-credentials`, { method: 'PATCH', body: JSON.stringify(body) }),
  generateConnCredentials: (serial: string) => request<{ status: string; mode: string; username: string; password: string }>(`/device/${encodeURIComponent(serial)}/conn-credentials/generate`, { method: 'POST' }),

  getFirmwares: () => request<Firmware[]>('/firmwares'),
  uploadFirmware: (file: File, version: string, manufacturer?: string, productClass?: string, description?: string) => {
    const body = new FormData();
    body.append('file', file);
    body.append('version', version);
    if (manufacturer) body.append('manufacturer', manufacturer);
    if (productClass) body.append('product_class', productClass);
    if (description) body.append('description', description);
    return request<Firmware>('/firmwares', { method: 'POST', body });
  },
  deleteFirmware: (id: number) => request<{ status: string }>(`/firmwares/${id}`, { method: 'DELETE' }),

  getFaults: (filter: 'all' | 'active' | 'resolved' = 'active') => {
    const resolved = filter === 'all' ? '' : `&resolved=${filter === 'resolved'}`;
    return request<{ faults: Fault[]; total: number; limit: number; offset: number }>(`/faults?limit=100${resolved}`);
  },
  getFaultStats: () => request<{ total: number; active: number; resolved: number }>('/faults/stats'),
  resolveFault: (id: number) => request<{ status: string }>(`/faults/${id}/resolve`, { method: 'POST' }),
  deleteFault: (id: number) => request<{ status: string }>(`/faults/${id}`, { method: 'DELETE' }),
  deleteFaults: (ids: number[]) => request<{ deleted: number }>('/faults/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  getMeta: () => request<{ app_name: string; app_logo?: string }>('/meta'),
  getSettings: () => request<Record<string, string>>('/settings'),
  getRetentionStats: () => request<{ table: string; records: number; size_bytes: number }[]>('/settings/retention/stats'),
  updateSettings: (settings: Record<string, string>) => request<{ status: string }>('/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  getUsers: () => request<User[]>('/users'),
  createUser: (body: { username: string; first_name: string; last_name: string; email: string; required_2fa: boolean; password: string; role: 'full' | 'read'; role_id?: number }) => request<User>('/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: Partial<{ username: string; first_name: string; last_name: string; email: string; required_2fa: boolean; reset_2fa: boolean; password: string; role: 'full' | 'read'; role_id: number }>) => request<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request<{ status: string }>(`/users/${id}`, { method: 'DELETE' }),
  getRoles: () => request<Role[]>('/roles'),
  createRole: (body: { name: string; description: string; permissions: string[] }) => request<Role>('/roles', { method: 'POST', body: JSON.stringify(body) }),
  updateRole: (id: number, body: Partial<{ name: string; description: string; permissions: string[] }>) => request<Role>(`/roles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteRole: (id: number) => request<{ status: string }>(`/roles/${id}`, { method: 'DELETE' }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ status: string }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),
  getProvisioningRules: (templateId?: number) => request<ProvisioningRule[]>(`/provisioning${templateId ? `?template_id=${templateId}` : ''}`),
  exportProvisioning: () => requestBlob('/provisioning/export'),
  importProvisioning: (backup: unknown, mode: 'append' | 'replace' = 'append') => request<{ status: string; mode: string; templates: number }>('/provisioning/import', { method: 'POST', body: JSON.stringify({ ...(backup as Record<string, unknown>), mode }) }),
  createProvisioningRule: (body: Omit<ProvisioningRule, 'id'>) => request<ProvisioningRule>('/provisioning', { method: 'POST', body: JSON.stringify(body) }),
  updateProvisioningRule: (id: number, body: Omit<ProvisioningRule, 'id'>) => request<ProvisioningRule>(`/provisioning/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProvisioningRule: (id: number) => request<{ status: string }>(`/provisioning/${id}`, { method: 'DELETE' }),
  toggleProvisioningRule: (id: number, enabled: boolean) => request<{ status: string }>(`/provisioning/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  reorderProvisioningRules: (templateId: number, ids: number[]) => request<{ status: string }>('/provisioning/reorder', { method: 'POST', body: JSON.stringify({ template_id: templateId, ids }) }),
  getProvisioningTemplates: () => request<ProvisioningTemplate[]>('/provisioning/templates'),
  createProvisioningTemplate: (body: { name: string; manufacturer?: string; product_class?: string; description?: string }) => request<ProvisioningTemplate>('/provisioning/templates', { method: 'POST', body: JSON.stringify(body) }),
  cloneProvisioningTemplate: (id: number, body: { name: string; manufacturer?: string; product_class?: string; description?: string }) => request<ProvisioningTemplate>(`/provisioning/templates/${id}/clone`, { method: 'POST', body: JSON.stringify(body) }),
  updateProvisioningTemplate: (id: number, body: { name: string; manufacturer?: string; product_class?: string; description?: string; variables?: ProvisioningVariable[] }) => request<ProvisioningTemplate>(`/provisioning/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProvisioningTemplate: (id: number) => request<{ status: string }>(`/provisioning/templates/${id}`, { method: 'DELETE' }),
  getProvisioningTemplateImage: (id: number) => requestBlob(`/provisioning/templates/${id}/image`),
  uploadProvisioningTemplateImage: (id: number, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<ProvisioningTemplate>(`/provisioning/templates/${id}/image`, { method: 'POST', body });
  },
  deleteProvisioningTemplateImage: (id: number) => request<{ status: string }>(`/provisioning/templates/${id}/image`, { method: 'DELETE' }),
  importTemplateFeature: (templateId: number, name: string, csv: string) => request<ProvisioningFeature>(`/provisioning/templates/${templateId}/features/import`, { method: 'POST', body: JSON.stringify({ name, csv }) }),
  saveTemplateFeatures: (templateId: number, features: ProvisioningFeature[]) => request<{ features: ProvisioningFeature[] }>(`/provisioning/templates/${templateId}/features`, { method: 'PUT', body: JSON.stringify({ features }) }),
  deleteTemplateFeature: (templateId: number, featureId: string) => request<{ status: string }>(`/provisioning/templates/${templateId}/features/${encodeURIComponent(featureId)}`, { method: 'DELETE' }),
  setTemplateFeatureControl: (serial: string, featureId: string, key: string, enabled: boolean) => request<{ task: Task; refresh_task: Task }>(`/device/${encodeURIComponent(serial)}/features/${encodeURIComponent(featureId)}/controls/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  setTemplateFeatureStringControl: (serial: string, featureId: string, key: string, value: string) => request<{ task: Task; refresh_task: Task }>(`/device/${encodeURIComponent(serial)}/features/${encodeURIComponent(featureId)}/controls/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ value }) }),
  addTemplateFeatureObject: (serial: string, featureId: string, key: string) => request<Task>(`/device/${encodeURIComponent(serial)}/features/${encodeURIComponent(featureId)}/objects/${encodeURIComponent(key)}`, { method: 'POST' }),
  setTemplateFeatureObjectParameters: (serial: string, featureId: string, key: string, instance: string, values: Record<string, string>) => request<{ task: Task; refresh_task: Task }>(`/device/${encodeURIComponent(serial)}/features/${encodeURIComponent(featureId)}/objects/${encodeURIComponent(key)}/instances/${encodeURIComponent(instance)}/parameters`, { method: 'POST', body: JSON.stringify({ values }) }),
  deleteTemplateFeatureObject: (serial: string, featureId: string, key: string, instance: string) => request<Task>(`/device/${encodeURIComponent(serial)}/features/${encodeURIComponent(featureId)}/objects/${encodeURIComponent(key)}/instances/${encodeURIComponent(instance)}`, { method: 'DELETE' }),
  deleteWifiSSID: (serial: string, instance: number) => request<Task>(`/device/${encodeURIComponent(serial)}/wifi/ssids/${instance}`, { method: 'DELETE' }),
  getInterfaceMetrics: (templateId: number) => request<InterfaceMetricDefinition[]>(`/provisioning/templates/${templateId}/interface-metrics`),
  getDeviceInterfaceMetricDefinitions: (serial: string) => request<InterfaceMetricDefinition[]>(`/device/${encodeURIComponent(serial)}/interface-metric-definitions`),
  createInterfaceMetric: (templateId: number, body: Pick<InterfaceMetricDefinition, 'name' | 'description' | 'interface_type' | 'parameter_pattern' | 'unit' | 'source' | 'unit_scale' | 'color' | 'group' | 'chart_type' | 'transform' | 'multiplier' | 'active'>) => request<InterfaceMetricDefinition>(`/provisioning/templates/${templateId}/interface-metrics`, { method: 'POST', body: JSON.stringify(body) }),
  updateInterfaceMetric: (templateId: number, id: number, body: Pick<InterfaceMetricDefinition, 'name' | 'description' | 'interface_type' | 'parameter_pattern' | 'unit' | 'source' | 'unit_scale' | 'color' | 'group' | 'chart_type' | 'transform' | 'multiplier' | 'active'>) => request<InterfaceMetricDefinition>(`/provisioning/templates/${templateId}/interface-metrics/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteInterfaceMetric: (templateId: number, id: number) => request<{ status: string }>(`/provisioning/templates/${templateId}/interface-metrics/${id}`, { method: 'DELETE' }),
  getDeviceInterfaceMetric: (serial: string, metricId: number, parameterName: string, hours = 24) => {
    const from = new Date(Date.now() - hours * 3600_000).toISOString();
    return request<{ samples: InterfaceMetricSample[] }>(`/device/${encodeURIComponent(serial)}/interface-metrics?metric_id=${metricId}&parameter_name=${encodeURIComponent(parameterName)}&from=${from}`);
  },

  getSecurityOverview: () => request<{ total_users: number; full_access_admins: number; recorded_failures: number; jwt_configured: boolean; login_rate_limit_enabled: boolean; cors_restricted: boolean; audit_logging_enabled: boolean }>('/security/overview'),
  getAuditLogs: (limit = 100, offset = 0) => request<{ entries: AuditLog[]; total: number; limit: number; offset: number }>(`/audit-logs?limit=${limit}&offset=${offset}`),
  getBlockedDevices: () => request<BlockedDevice[]>('/blocked-devices'),
  blockDevice: (serialNumber: string, reason: string) => request<BlockedDevice>('/blocked-devices', { method: 'POST', body: JSON.stringify({ serial_number: serialNumber, reason }) }),
  unblockDevice: (serialNumber: string) => request<{ status: string }>(`/blocked-devices/${encodeURIComponent(serialNumber)}`, { method: 'DELETE' }),

  getMetricDefinitions: () => request<MetricDefinition[]>('/metrics/definitions'),
  getTemplateMetrics: (templateId: number) => request<MetricDefinition[]>(`/provisioning/templates/${templateId}/metrics`),
  createTemplateMetric: (templateId: number, body: Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>) => request<MetricDefinition>(`/provisioning/templates/${templateId}/metrics`, { method: 'POST', body: JSON.stringify(body) }),
  updateTemplateMetric: (templateId: number, id: number, body: Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>) => request<MetricDefinition>(`/provisioning/templates/${templateId}/metrics/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTemplateMetric: (templateId: number, id: number) => request<{ status: string }>(`/provisioning/templates/${templateId}/metrics/${id}`, { method: 'DELETE' }),
  getDeviceMetricDefinitions: (serial: string) => request<MetricDefinition[]>(`/device/${encodeURIComponent(serial)}/metric-definitions`),
  createMetricDefinition: (body: Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>) => request<MetricDefinition>('/metrics/definitions', { method: 'POST', body: JSON.stringify(body) }),
  updateMetricDefinition: (id: number, body: Omit<MetricDefinition, 'id' | 'created_at' | 'updated_at'>) => request<MetricDefinition>(`/metrics/definitions/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMetricDefinition: (id: number) => request<{ status: string }>(`/metrics/definitions/${id}`, { method: 'DELETE' }),
  getDeviceMetrics: (serial: string, metricId: number, bucket = '5min', hours = 24) => {
    const from = new Date(Date.now() - hours * 3600_000).toISOString();
    return request<{ samples?: MetricSample[]; aggregates?: AggregatedMetric[] }>(`/device/${encodeURIComponent(serial)}/metrics?metric_id=${metricId}&bucket=${bucket}&from=${from}`);
  },
};
