import assert from 'node:assert/strict';
import test from 'node:test';
import { useColumnVisibility } from '../src/lib/useColumnVisibility.ts';

// In-memory localStorage mock (Node has no localStorage by default).
const createLocalStorageMock = () => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
};

const DEFAULTS = [
  { id: 'a', label: 'A', visible: true },
  { id: 'b', label: 'B', visible: false },
  { id: 'c', label: 'C', visible: true },
];

test('returns the default columns when nothing is stored', () => {
  globalThis.localStorage = createLocalStorageMock();
  const { columns, isVisible } = useColumnVisibility('faults', DEFAULTS);
  assert.equal(columns().length, 3);
  assert.equal(isVisible('a'), true);
  assert.equal(isVisible('b'), false);
  assert.equal(isVisible('c'), true);
});

test('restores stored visibility over the defaults', () => {
  const ls = createLocalStorageMock();
  ls.setItem('acs_columns_faults', JSON.stringify([
    { id: 'a', label: 'A', visible: false },
    { id: 'b', label: 'B', visible: true },
    { id: 'c', label: 'C', visible: true },
  ]));
  globalThis.localStorage = ls;
  const { isVisible } = useColumnVisibility('faults', DEFAULTS);
  assert.equal(isVisible('a'), false);
  assert.equal(isVisible('b'), true);
  assert.equal(isVisible('c'), true);
});

test('falls back to the default when a stored id is missing', () => {
  const ls = createLocalStorageMock();
  // Only "a" is stored; "b" and "c" fall back to their defaults.
  ls.setItem('acs_columns_faults', JSON.stringify([{ id: 'a', label: 'A', visible: false }]));
  globalThis.localStorage = ls;
  const { isVisible } = useColumnVisibility('faults', DEFAULTS);
  assert.equal(isVisible('a'), false);
  assert.equal(isVisible('b'), false); // default
  assert.equal(isVisible('c'), true); // default
});

test('falls back to the defaults when the stored value is malformed', () => {
  const ls = createLocalStorageMock();
  ls.setItem('acs_columns_faults', 'not-json');
  globalThis.localStorage = ls;
  const { columns, isVisible } = useColumnVisibility('faults', DEFAULTS);
  assert.equal(columns().length, 3);
  assert.equal(isVisible('a'), true);
  assert.equal(isVisible('b'), false);
});

test('toggle flips a column and persists to localStorage', () => {
  const ls = createLocalStorageMock();
  globalThis.localStorage = ls;
  const { isVisible, toggle } = useColumnVisibility('devices', DEFAULTS);
  assert.equal(isVisible('b'), false);
  toggle('b');
  assert.equal(isVisible('b'), true);
  const stored = JSON.parse(ls.getItem('acs_columns_devices'));
  assert.equal(stored.find((c) => c.id === 'b').visible, true);
  // Toggling again flips it back.
  toggle('b');
  assert.equal(isVisible('b'), false);
});

test('toggle does not affect other columns', () => {
  const ls = createLocalStorageMock();
  globalThis.localStorage = ls;
  const { isVisible, toggle } = useColumnVisibility('devices', DEFAULTS);
  toggle('a');
  assert.equal(isVisible('a'), false);
  assert.equal(isVisible('b'), false); // unchanged
  assert.equal(isVisible('c'), true); // unchanged
});

test('keeps independent state per storage key', () => {
  const ls = createLocalStorageMock();
  globalThis.localStorage = ls;
  const a = useColumnVisibility('faults', DEFAULTS);
  const b = useColumnVisibility('firmwares', DEFAULTS);
  a.toggle('a');
  assert.equal(a.isVisible('a'), false);
  assert.equal(b.isVisible('a'), true); // unchanged
});
