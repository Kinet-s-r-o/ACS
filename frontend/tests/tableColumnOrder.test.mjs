import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTableColumns } from '../src/lib/tableColumnOrder.ts';

const name = { id: 'name#0' };
const value = { id: 'value#0' };
const actions = { id: 'actions#0', fixed: 'actions' };
const visibility = { id: '__visibility#0', fixed: 'visibility' };
const ids = columns => columns.map(column => column.id);

test('legacy preferences cannot place actions or visibility among data columns', () => {
  const result = orderTableColumns([name, actions, value, visibility], ['actions#0', '__visibility#0', 'value#0', 'name#0']);
  assert.deepEqual(ids(result), ['value#0', 'name#0', 'actions#0', '__visibility#0']);
});

test('default and partially saved orders always end with the two fixed columns', () => {
  const columns = [visibility, name, actions, value];
  assert.deepEqual(ids(orderTableColumns(columns, [])), ['name#0', 'value#0', 'actions#0', '__visibility#0']);
  assert.deepEqual(ids(orderTableColumns(columns, ['removed#0', 'value#0'])), ['value#0', 'name#0', 'actions#0', '__visibility#0']);
  assert.deepEqual(columns, [visibility, name, actions, value]);
});

test('hiding and restoring data columns keeps the fixed suffix and cell identities', () => {
  const order = ['value#0', 'name#0'];
  assert.deepEqual(ids(orderTableColumns([name, actions, visibility], order)), ['name#0', 'actions#0', '__visibility#0']);
  const restored = orderTableColumns([name, value, actions, visibility], order);
  assert.equal(restored[0], value);
  assert.equal(restored[1], name);
  assert.equal(restored[2], actions);
  assert.equal(restored[3], visibility);
});

test('a table with no Actions column keeps visibility at the far right', () => {
  assert.deepEqual(ids(orderTableColumns([visibility, name, value], ['value#0'])), ['value#0', 'name#0', '__visibility#0']);
});
