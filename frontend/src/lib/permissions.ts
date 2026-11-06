export type PermissionAction = 'full' | 'add' | 'read' | 'write' | 'edit' | 'delete' | 'remove' | 'import' | 'export';
export interface PermissionSection { id: string; label: string; parent?: string; path?: string; actions: PermissionAction[] }
export interface PermissionCatalog { actions: PermissionAction[]; sections: PermissionSection[] }
export const PERMISSION_ACTIONS: PermissionAction[] = ['full', 'add', 'read', 'write', 'edit', 'delete', 'remove', 'import', 'export'];
export const SECTION_ACTIONS: Record<string, PermissionAction[]> = {
 fleet: ['full', 'add', 'read', 'edit', 'delete'],
 inventory: ['full', 'add', 'read', 'write', 'export'],
 cpe: ['full', 'read', 'write', 'delete', 'export'],
 tasks: ['full', 'read', 'delete', 'export'],
 faults: ['full', 'read', 'write', 'delete', 'export'],
 firmwares: ['full', 'read', 'write', 'delete'],
 security: [], 'security.blocklist': ['full', 'read', 'add', 'remove'], 'security.audit': ['read'], settings: [],
 'settings.general': ['full', 'read', 'write'],
 'settings.system_tasks': ['full', 'read', 'write', 'delete'],
 'settings.database': ['full', 'read', 'write', 'delete'],
 'settings.dictionaries': ['full', 'read', 'write', 'delete', 'export'],
 'settings.users': ['full', 'read', 'write', 'delete', 'import', 'export'],
 'settings.authentication': ['full', 'read', 'write'],
 'settings.delivery': ['full', 'read', 'write'],
 'settings.provisioning': ['full', 'read', 'write', 'delete'],
 'settings.api_docs': ['full', 'read', 'write'],
};
export const DEVICE_TAB_SECTIONS: Record<string, string> = { overview: 'inventory.cpes.overview', hosts: 'inventory.cpes.hosts', metrics: 'inventory.cpes.metrics', features: 'inventory.cpes.features', snapshots: 'inventory.cpes.snapshots', tasks: 'inventory.cpes.tasks', faults: 'inventory.cpes.faults', credentials: 'inventory.cpes.credentials', diagnostic: 'inventory.cpes.maintenance.diagnostic', log: 'inventory.cpes.log' };

export const canonicalPermission = (section: string, action: PermissionAction): [string, PermissionAction] => {
 const original = section;
 if (section.startsWith('inventory.cpes.')) section = 'cpe';
 else if (section === 'inventory' || section.startsWith('inventory.')) section = 'inventory';
 else if (section.startsWith('tasks.')) section = 'tasks';
 else if (section.startsWith('settings.metrics')) section = 'settings.provisioning';
 else {
  const parent = ['fleet', 'cpe', 'faults', 'firmwares', 'security.blocklist', 'security.audit', 'settings.general', 'settings.system_tasks', 'settings.database', 'settings.dictionaries', 'settings.users', 'settings.authentication', 'settings.delivery', 'settings.provisioning', 'settings.api_docs'].find(parent => section.startsWith(parent + '.'));
  if (parent) section = parent;
 }
 if (action === 'edit' && section !== 'fleet') action = 'write';
 if (section === 'security.blocklist') {
  if (action === 'write') action = 'add';
  if (action === 'delete') action = 'remove';
 }
 if (original === 'inventory.cpes' && action === 'delete') section = 'cpe';
 if (original.startsWith('inventory.cpes.tasks') && action === 'delete') section = 'tasks';
 if (original.startsWith('inventory.cpes.faults') && action !== 'read') section = 'faults';
 if (original === 'inventory.cpes.snapshots' && action === 'delete') action = 'write';
 return [section, action];
};

export const canSection = (permissions: string[], section: string, action: PermissionAction): boolean => {
 [section, action] = canonicalPermission(section, action);
 if (section === 'security' && action === 'read') return canSection(permissions, 'security.blocklist', 'read') || canSection(permissions, 'security.audit', 'read');
 const actions = SECTION_ACTIONS[section] ?? [];
 const key = `access.${section}.`;
 if (actions.includes('full') && permissions.includes(`${key}full`)) return true;
 return actions.includes(action) && permissions.includes(`${key}${action}`) && (action === 'read' || permissions.includes(`${key}read`));
};
export const canVisitSection = (permissions: string[], section: string): boolean => {
 [section] = canonicalPermission(section, 'read');
 return canSection(permissions, section, 'read') || Object.keys(SECTION_ACTIONS).some(id => id.startsWith(section + '.') && canSection(permissions, id, 'read'));
};

// Internal adapters for established components; saved roles contain only access.* keys.
const LEGACY_SCOPES: Record<string, [string[], PermissionAction]> = {
  'devices.read': [['fleet', 'inventory', 'inventory.cpes', 'inventory.wans', 'inventory.cpes.overview', 'inventory.cpes.hosts', 'inventory.cpes.metrics', 'inventory.cpes.features', 'inventory.cpes.snapshots', 'inventory.cpes.tasks', 'inventory.cpes.faults', 'inventory.cpes.credentials', 'inventory.cpes.maintenance.diagnostic', 'inventory.cpes.log'], 'read'],
  'devices.write': [['inventory.cpes', 'inventory.cpes.overview', 'inventory.cpes.features', 'inventory.cpes.maintenance.diagnostic'], 'edit'],
  'devices.create': [['inventory'], 'add'],
  'devices.configure': [['inventory.cpes.overview', 'inventory.cpes.features'], 'edit'],
  'devices.command': [['inventory.cpes.overview', 'inventory.cpes.maintenance.diagnostic'], 'edit'],
  'devices.reset': [['cpe'], 'write'],
  'devices.delete': [['inventory.cpes', 'tasks', 'inventory.cpes.tasks'], 'delete'],
  'devices.credentials': [['inventory.cpes.credentials'], 'edit'],
  'devices.snapshots.write': [['inventory.cpes.snapshots'], 'edit'],
  'devices.firmware': [['inventory.cpes.maintenance.diagnostic'], 'edit'],
  'firmwares.read': [['firmwares'], 'read'], 'firmwares.write': [['firmwares'], 'edit'], 'firmwares.manage': [['firmwares'], 'edit'],
  'faults.read': [['faults', 'inventory.cpes.faults'], 'read'], 'faults.write': [['faults', 'inventory.cpes.faults'], 'edit'],
  'settings.read': [['settings.general.general', 'settings.general.ui', 'settings.general.aggregations', 'settings.database.retention', 'settings.delivery'], 'read'],
  'settings.write': [['settings.general.general', 'settings.general.ui', 'settings.general.aggregations', 'settings.database.retention', 'settings.delivery', 'settings.dictionaries.tags'], 'edit'],
  'database.stats.read': [['settings.database.statistics'], 'read'],
  'database.indexes.read': [['settings.database.indexes'], 'read'], 'database.indexes.write': [['settings.database.indexes'], 'edit'],
  'users.read': [['settings.users.users'], 'read'], 'users.write': [['settings.users.users'], 'edit'],
  'users.tokens': [['settings.users.users.tokens'], 'edit'], 'users.dashboards': [['settings.users.users.dashboards'], 'edit'],
  'roles.read': [['settings.users.roles'], 'read'], 'roles.write': [['settings.users.roles'], 'edit'],
  'auth.settings.read': [['settings.authentication.radius'], 'read'], 'auth.settings.write': [['settings.authentication.radius'], 'edit'],
  'security.read': [['security', 'security.audit', 'security.blocklist'], 'read'], 'security.write': [['security.blocklist'], 'edit'],
  'metrics.read': [['inventory.cpes.metrics', 'settings.metrics.metric', 'settings.metrics.health'], 'read'],
  'metrics.write': [['settings.metrics.metric', 'settings.metrics.health'], 'edit'],
  'provisioning.read': [['settings.provisioning.templates', 'settings.provisioning.rules', 'settings.provisioning.variables', 'settings.provisioning.metrics.general', 'settings.provisioning.metrics.general.metric', 'settings.provisioning.metrics.general.health', 'settings.provisioning.metrics.interface', 'settings.provisioning.metrics.polling', 'settings.provisioning.features', 'settings.provisioning.cpe_detail.lan', 'settings.provisioning.cpe_detail.info'], 'read'],
  'provisioning.write': [['settings.provisioning.templates', 'settings.provisioning.rules', 'settings.provisioning.variables', 'settings.provisioning.metrics.general', 'settings.provisioning.metrics.general.metric', 'settings.provisioning.metrics.general.health', 'settings.provisioning.metrics.interface', 'settings.provisioning.metrics.polling', 'settings.provisioning.features', 'settings.provisioning.cpe_detail.lan', 'settings.provisioning.cpe_detail.info'], 'edit'],
  'provisioning.rules.write': [['settings.provisioning.rules'], 'edit'],
  'provisioning.templates.write': [['settings.provisioning.templates', 'settings.provisioning.variables', 'settings.provisioning.metrics.general', 'settings.provisioning.metrics.general.metric', 'settings.provisioning.metrics.general.health', 'settings.provisioning.metrics.interface', 'settings.provisioning.metrics.polling', 'settings.provisioning.features', 'settings.provisioning.cpe_detail.lan', 'settings.provisioning.cpe_detail.info'], 'edit'],
  'cwmp.control': [['settings.provisioning'], 'edit'],
};
export const legacyPermission = (permissions: string[], key: string, currentSection: string): boolean => {
 if (key.startsWith('access.')) return canSection(permissions, key.slice(7, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1) as PermissionAction);
 const rule = LEGACY_SCOPES[key];
 if (!rule) return false;
 const [scopes, action] = rule;
 const [current] = canonicalPermission(currentSection, 'read');
 const matching = scopes.filter(scope => canonicalPermission(scope, action)[0] === current);
 return (matching.length ? matching : scopes).some(scope => canSection(permissions, scope, action));
};
