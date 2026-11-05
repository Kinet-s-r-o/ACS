import assert from 'node:assert/strict';
import test from 'node:test';
import { canSection, canVisitSection, legacyPermission, PERMISSION_ACTIONS, SECTION_ACTIONS } from '../src/lib/permissions.ts';

const grants = (section, ...actions) => actions.map(action => `access.${section}.${action}`);

test('operator catalog advertises only the specified actions per section', () => {
  assert.deepEqual(PERMISSION_ACTIONS, ['full', 'add', 'read', 'write', 'edit', 'delete', 'remove', 'import', 'export']);
  assert.deepEqual(SECTION_ACTIONS.fleet, ['full', 'add', 'read', 'edit', 'delete']);
  assert.deepEqual(SECTION_ACTIONS.inventory, ['full', 'add', 'read', 'write', 'export']);
  assert.deepEqual(SECTION_ACTIONS['security.audit'], ['read']);
  assert.deepEqual(SECTION_ACTIONS['settings.users'], ['full', 'read', 'write', 'delete', 'import', 'export']);
});

test('section permissions cover all existing and future subtabs', () => {
  const permissions = grants('inventory', 'read');
  for (const section of ['inventory', 'inventory.cpes', 'inventory.wans', 'inventory.future']) assert.equal(canVisitSection(permissions, section), true);
  assert.equal(canVisitSection(permissions, 'inventory.cpes.overview'), false);
  assert.equal(canVisitSection(permissions, 'cpe'), false);
  const settings = grants('settings.database', 'full');
  for (const section of ['settings.database.indexes', 'settings.database.retention', 'settings.database.statistics', 'settings.database.future']) assert.equal(canSection(settings, section, 'edit'), true);
  assert.equal(canSection(settings, 'settings.general', 'write'), false);
});

test('independent mutation actions require Read and cannot escalate', () => {
  for (const section of ['inventory', 'cpe', 'faults', 'settings.users', 'security.blocklist']) {
    const actions = SECTION_ACTIONS[section].filter(action => action !== 'read' && action !== 'full');
    for (const selected of actions) {
      assert.equal(canSection(grants(section, selected), section, selected), false);
      for (const action of actions) assert.equal(canSection(grants(section, 'read', selected), section, action), action === selected);
    }
  }
});

test('unsupported actions require Full and stale fine-grained grants grant nothing', () => {
  assert.equal(canSection(grants('settings.provisioning', 'read', 'write'), 'settings.provisioning', 'import'), false);
  assert.equal(canSection(grants('settings.provisioning', 'full'), 'settings.provisioning', 'import'), true);
  assert.equal(canSection(grants('security.audit', 'full'), 'security.audit', 'read'), false);
  assert.equal(canVisitSection(grants('settings.users.roles', 'full'), 'settings.users'), false);
});

test('legacy component adapters enforce the new operation boundaries', () => {
  assert.equal(legacyPermission(grants('inventory', 'read', 'add'), 'devices.create', 'inventory.cpes'), true);
  assert.equal(legacyPermission(grants('inventory', 'read', 'write'), 'devices.create', 'inventory.cpes'), false);
  assert.equal(legacyPermission(grants('cpe', 'read', 'write'), 'devices.reset', 'inventory.cpes.maintenance.diagnostic'), true);
  assert.equal(canSection(grants('cpe', 'read', 'write'), 'inventory.cpes', 'delete'), false);
  assert.equal(canSection(grants('tasks', 'read', 'delete'), 'inventory.cpes.tasks', 'delete'), true);
  assert.equal(canSection(grants('settings.provisioning', 'read', 'write'), 'settings.metrics.health', 'edit'), true);
});
