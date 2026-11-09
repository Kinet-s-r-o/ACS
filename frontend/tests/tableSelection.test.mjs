import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableRangeSelection, selectTableRecords } from '../src/lib/tableSelection.ts';

class Element {
  controls = [];
  visible = true;
  blocked = false;
  table = null;
  closest(selector) {
    if (selector === 'table') return this.table;
    if (selector.startsWith('textarea')) return this.editable ? this : null;
    return this.blocked ? this : null;
  }
  getClientRects() { return this.visible ? [{}] : []; }
  contains(element) { return element === this || this.controls.includes(element); }
  querySelectorAll() { return this.controls; }
}

class Input extends Element {
  dataset = {};
  type = 'checkbox';
  checked = false;
  disabled = false;
  clicks = 0;
  hasAttribute(name) { return name === 'data-table-select-all' && this.selectAll; }
  click() { this.checked = !this.checked; this.clicks++; this.onClick?.({ target: this }); }
}

const setup = () => {
  globalThis.HTMLElement = Element;
  globalThis.HTMLInputElement = Input;
  const main = new Element();
  const control = new Input();
  main.controls = [control];
  const dialogs = [];
  globalThis.document = { querySelector: () => main, querySelectorAll: () => dialogs };
  const press = (overrides = {}) => {
    const event = { key: 'a', ctrlKey: true, target: main, preventDefault() { this.defaultPrevented = true; }, ...overrides };
    selectTableRecords(event);
    return event;
  };
  return { main, control, dialogs, press };
};

test('Ctrl+A selects once and repeated presses preserve the selection', () => {
  const { control, press } = setup();
  assert.equal(press().defaultPrevented, true);
  press({ repeat: true });
  assert.equal(control.checked, true);
  assert.equal(control.clicks, 1);
});

test('text inputs and editable content retain native selection', () => {
  const { control, press } = setup();
  const input = new Input();
  input.type = 'search';
  const editor = new Element();
  editor.editable = true;
  for (const target of [input, editor]) assert.equal(press({ target }).defaultPrevented, undefined);
  assert.equal(control.clicks, 0);
});

test('the top dialog owns the shortcut and never selects underlying records', () => {
  const { control, dialogs, press } = setup();
  const dialog = new Element();
  dialogs.push(dialog);
  assert.equal(press().defaultPrevented, undefined);
  const dialogControl = new Input();
  dialog.controls = [dialogControl];
  press();
  assert.equal(dialogControl.checked, true);
  assert.equal(control.checked, false);
});

test('hidden and disabled selectors cannot select records', () => {
  const { control, press } = setup();
  control.disabled = true;
  assert.equal(press().defaultPrevented, undefined);
  control.disabled = false;
  control.visible = false;
  assert.equal(press().defaultPrevented, undefined);
  assert.equal(control.clicks, 0);
});

test('multiple tables require focus in the target table', () => {
  const { main, control, press } = setup();
  main.controls.push(new Input());
  assert.equal(press().defaultPrevented, undefined);
  const table = new Element();
  table.controls = [control];
  main.controls.push(table);
  control.table = table;
  press({ target: control });
  assert.equal(control.checked, true);
  assert.equal(main.controls[1].checked, false);
});

test('unmodified and already handled shortcuts retain their behavior', () => {
  const { control, press } = setup();
  for (const overrides of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true }]) press(overrides);
  assert.equal(control.clicks, 0);
  press({ ctrlKey: false, metaKey: true });
  assert.equal(control.checked, true);
});

const rangeSetup = () => {
  const { main, dialogs } = setup();
  const handlers = createTableRangeSelection();
  const table = new Element();
  const rows = Array.from({ length: 5 }, (_, index) => {
    const row = new Input();
    row.table = table;
    row.dataset.tableSelectRow = String(index);
    row.onClick = handlers.click;
    return row;
  });
  table.controls = rows;
  main.controls = [table];
  const click = (index, shiftKey = false) => {
    rows[index].checked = !rows[index].checked;
    handlers.click({ target: rows[index], shiftKey });
  };
  const press = (index, repeat = false) => {
    const event = { target: rows[index], key: ' ', shiftKey: true, repeat, preventDefault() { this.defaultPrevented = true; } };
    handlers.keyDown(event);
    return event;
  };
  return { rows, table, dialogs, click, press, handlers };
};

test('Shift+click selects an inclusive range and keeps other selections', () => {
  const { rows, click } = rangeSetup();
  rows[4].checked = true;
  click(3);
  click(1, true);
  assert.deepEqual(rows.map(row => row.checked), [false, true, true, true, true]);
  click(0, true);
  assert.deepEqual(rows.map(row => row.checked), [true, true, true, true, true]);
});

test('Shift+click on a checked endpoint clears the range and skips disabled rows', () => {
  const { rows, click } = rangeSetup();
  click(0);
  click(4, true);
  rows[2].disabled = true;
  click(3, true);
  assert.deepEqual(rows.map(row => row.checked), [false, false, true, false, true]);
});

test('Shift+Space selects the same range without toggling again on key repeat', () => {
  const { rows, click, press } = rangeSetup();
  click(1);
  assert.equal(press(4).defaultPrevented, true);
  press(4, true);
  assert.deepEqual(rows.map(row => row.checked), [false, true, true, true, true]);
});

test('a first Shift+Space selects one row and anchors the next range', () => {
  const { rows, press } = rangeSetup();
  press(2);
  press(4);
  assert.deepEqual(rows.map(row => row.checked), [false, false, true, true, true]);
});

test('a reused anchor representing another record cannot extend a stale range', () => {
  const { rows, click } = rangeSetup();
  click(0);
  rows[0].dataset.tableSelectRow = 'new-page-record';
  click(4, true);
  assert.deepEqual(rows.map(row => row.checked), [true, false, false, false, true]);
});

test('an open modal prevents keyboard range selection in the underlying table', () => {
  const { rows, dialogs, click, press } = rangeSetup();
  click(0);
  dialogs.push(new Element());
  assert.equal(press(4).defaultPrevented, undefined);
  assert.deepEqual(rows.map(row => row.checked), [true, false, false, false, false]);
});
