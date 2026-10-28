import assert from 'node:assert/strict';
import test from 'node:test';
import { usePageSize, PAGE_SIZE_OPTIONS } from '../src/lib/usePageSize.ts';

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

test('returns the default size when nothing is stored', () => {
  globalThis.localStorage = createLocalStorageMock();
  const { pageSize } = usePageSize('faults', 20);
  assert.equal(pageSize(), 20);
});

test('returns a stored size when it is a valid option', () => {
  const ls = createLocalStorageMock();
  ls.setItem('acs_page_size_faults', '50');
  globalThis.localStorage = ls;
  const { pageSize } = usePageSize('faults', 20);
  assert.equal(pageSize(), 50);
});

test('falls back to the default when the stored value is not a valid option', () => {
  const ls = createLocalStorageMock();
  ls.setItem('acs_page_size_faults', '7'); // 7 is not in PAGE_SIZE_OPTIONS
  globalThis.localStorage = ls;
  const { pageSize } = usePageSize('faults', 20);
  assert.equal(pageSize(), 20);
});

test('falls back to the default when the stored value is not a number', () => {
  const ls = createLocalStorageMock();
  ls.setItem('acs_page_size_faults', 'abc');
  globalThis.localStorage = ls;
  const { pageSize } = usePageSize('faults', 20);
  assert.equal(pageSize(), 20);
});

test('changePageSize updates the signal and persists to localStorage', () => {
  const ls = createLocalStorageMock();
  globalThis.localStorage = ls;
  const { pageSize, changePageSize } = usePageSize('devices', 20);
  changePageSize(100);
  assert.equal(pageSize(), 100);
  assert.equal(ls.getItem('acs_page_size_devices'), '100');
});

test('keeps independent sizes per storage key', () => {
  const ls = createLocalStorageMock();
  globalThis.localStorage = ls;
  const a = usePageSize('faults', 20);
  const b = usePageSize('firmwares', 15);
  assert.equal(a.pageSize(), 20);
  assert.equal(b.pageSize(), 15);
  a.changePageSize(50);
  assert.equal(a.pageSize(), 50);
  assert.equal(b.pageSize(), 15); // unchanged
});

test('exposes the standard page-size options', () => {
  assert.deepEqual(PAGE_SIZE_OPTIONS, [10, 15, 20, 50, 100]);
});
