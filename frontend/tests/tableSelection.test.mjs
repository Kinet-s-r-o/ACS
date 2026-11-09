import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTableRecords } from '../src/lib/tableSelection.ts';

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
  type = 'checkbox';
  checked = false;
  disabled = false;
  clicks = 0;
  click() { this.checked = !this.checked; this.clicks++; }
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
