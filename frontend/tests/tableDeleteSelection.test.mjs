import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteSelectedTableRecords } from '../src/lib/tableSelection.ts';

class Element {
  elements = [];
  actions = [];
  visible = true;
  table = null;
  closest(selector) {
    if (selector === 'table') return this.table;
    if (selector.startsWith('textarea')) return this.editable ? this : null;
    return this.blocked ? this : null;
  }
  getClientRects() { return this.visible ? [{}] : []; }
  contains(element) { return element === this || this.elements.includes(element); }
  querySelectorAll() { return this.actions; }
}

class Input extends Element { type = 'text'; }
class Button extends Element {
  disabled = false;
  clicks = 0;
  getAttribute(name) { return name === 'aria-controls' ? this.controls : null; }
  click() { this.clicks++; }
}

const setup = () => {
  globalThis.HTMLElement = Element;
  globalThis.HTMLInputElement = Input;
  const main = new Element();
  const table = new Element();
  const row = new Input();
  row.type = 'checkbox';
  row.table = table;
  const action = new Button();
  action.controls = 'records';
  main.actions = [action];
  main.elements = [table, action, row];
  const dialogs = [];
  const tables = new Map([['records', table]]);
  globalThis.document = { querySelector: () => main, querySelectorAll: () => dialogs, getElementById: id => tables.get(id) ?? null };
  const press = (overrides = {}) => {
    const event = { key: 'Delete', target: row, preventDefault() { this.defaultPrevented = true; }, ...overrides };
    deleteSelectedTableRecords(event);
    return event;
  };
  return { main, table, row, action, dialogs, tables, press };
};

test('Delete activates the existing bulk-delete button', () => {
  const { main, action, press } = setup();
  assert.equal(press().defaultPrevented, true);
  assert.equal(press({ target: main }).defaultPrevented, true);
  assert.equal(action.clicks, 2);
});

test('Delete preserves editing and ignores modifiers, repeats and handled events', () => {
  const { action, press } = setup();
  const editor = new Element();
  editor.editable = true;
  for (const overrides of [
    { target: new Input() }, { target: editor }, { key: 'Backspace' },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
    { repeat: true }, { isComposing: true }, { defaultPrevented: true },
  ]) press(overrides);
  assert.equal(action.clicks, 0);
});

test('Delete respects disabled, hidden, absent and disconnected controls', () => {
  const { main, table, action, press } = setup();
  action.disabled = true;
  press();
  action.disabled = false;
  action.visible = false;
  press();
  action.visible = true;
  table.visible = false;
  press();
  table.visible = true;
  action.controls = 'missing';
  press();
  action.controls = 'records';
  main.elements = [];
  press();
  main.actions = [];
  press();
  assert.equal(action.clicks, 0);
});

test('multiple delete actions require focus in the matching table', () => {
  const { main, row, action, tables, press } = setup();
  const otherTable = new Element();
  const otherAction = new Button();
  otherAction.controls = 'other';
  tables.set('other', otherTable);
  main.elements.push(otherTable, otherAction);
  main.actions.push(otherAction);
  assert.equal(press({ target: main }).defaultPrevented, undefined);
  press({ target: row });
  assert.equal(action.clicks, 1);
  assert.equal(otherAction.clicks, 0);
  row.table = otherTable;
  press();
  assert.equal(action.clicks, 1);
  assert.equal(otherAction.clicks, 1);
  main.actions = [action];
  assert.equal(press().defaultPrevented, undefined);
});

test('a modal owns Delete and protects the underlying table', () => {
  const { action, dialogs, table, press } = setup();
  const dialog = new Element();
  dialogs.push(dialog);
  assert.equal(press().defaultPrevented, undefined);
  dialog.actions = [action];
  press();
  assert.equal(action.clicks, 0);
  dialog.elements = [table, action];
  press();
  assert.equal(action.clicks, 1);
  const confirmation = new Element();
  dialogs.push(confirmation);
  press();
  assert.equal(action.clicks, 1);
});
