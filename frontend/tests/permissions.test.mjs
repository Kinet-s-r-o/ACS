import assert from 'node:assert/strict';
import test from 'node:test';
import { canSection, canVisitSection, legacyPermission, PERMISSION_ACTIONS } from '../src/lib/permissions.ts';

test('permission types are the six requested actions', () => {
  assert.deepEqual(PERMISSION_ACTIONS, ['full', 'read', 'edit', 'delete', 'import', 'export']);
});

test('Full grants the current row without granting parents, descendants or siblings', () => {
  const permissions = ['access.settings.database.full'];
  for (const action of PERMISSION_ACTIONS) assert.equal(canSection(permissions, 'settings.database', action), true);
  for (const section of ['settings', 'settings.database.indexes', 'settings.database.retention', 'settings.authentication.radius']) {
    for (const action of PERMISSION_ACTIONS) assert.equal(canSection(permissions, section, action), false);
  }
});

test('a readable child makes its menu containers navigable without granting their actions', () => {
  const permissions = ['access.settings.authentication.radius.read'];
  assert.equal(canVisitSection(permissions, 'settings'), true);
  assert.equal(canVisitSection(permissions, 'settings.authentication'), true);
  assert.equal(canSection(permissions, 'settings.authentication', 'edit'), false);
  assert.equal(canVisitSection(permissions, 'settings.database'), false);
});

test('Edit, Delete, Import and Export are independent and require Read', () => {
  for (const selected of ['edit', 'delete', 'import', 'export']) {
    assert.equal(canSection([`access.firmwares.${selected}`], 'firmwares', selected), false);
    const permissions = ['access.firmwares.read', `access.firmwares.${selected}`];
    for (const action of ['edit', 'delete', 'import', 'export', 'full']) assert.equal(canSection(permissions, 'firmwares', action), action === selected);
  }
});

test('legacy component adapters cannot grant cross-tab write access', () => {
  const permissions = ['access.settings.general.ui.full'];
  assert.equal(legacyPermission(permissions, 'settings.write', 'settings.general.ui'), true);
  assert.equal(legacyPermission(permissions, 'settings.write', 'settings.database.retention'), false);
  assert.equal(legacyPermission(permissions, 'devices.reset', 'inventory.cpes.maintenance.diagnostic'), false);
});
