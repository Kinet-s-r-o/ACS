import assert from 'node:assert/strict';
import test from 'node:test';
import { applyColumnFilters, matchesValue } from '../src/lib/filters.ts';

const rows = [
  { type: 'reboot', status: 'pending', created_at: '2026-01-01', error: '' },
  { type: 'firmware', status: 'completed', created_at: '2026-02-15', error: 'timeout' },
  { type: 'reboot', status: 'failed', created_at: '2026-03-20', error: 'no response' },
];

test('returns all items when there are no active filters', () => {
  const result = applyColumnFilters(rows, {}, () => '');
  assert.equal(result.length, rows.length);
});

test('returns all items when a filter has no rules', () => {
  const result = applyColumnFilters(rows, { type: { logic: 'all', rules: [] } }, (r, c) => r[c]);
  assert.equal(result.length, rows.length);
});

test('filters by a single contains rule', () => {
  const result = applyColumnFilters(
    rows,
    { type: { logic: 'all', rules: [{ operator: 'contains', value: 'reboot' }] } },
    (r, c) => r[c]
  );
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.type === 'reboot'));
});

test('matching is case-insensitive', () => {
  const result = applyColumnFilters(
    rows,
    { type: { logic: 'all', rules: [{ operator: 'contains', value: 'REBOOT' }] } },
    (r, c) => r[c]
  );
  assert.equal(result.length, 2);
});

test('all logic requires every rule to match the same field', () => {
  // No row is both 'reboot' and 'firmware', so 'all' yields nothing.
  const result = applyColumnFilters(
    rows,
    { type: { logic: 'all', rules: [{ operator: 'equals', value: 'reboot' }, { operator: 'equals', value: 'firmware' }] } },
    (r) => r.type
  );
  assert.equal(result.length, 0);
});

test('any logic matches if at least one rule matches the same field', () => {
  // Every row is either 'reboot' or 'firmware', so 'any' yields all of them.
  const result = applyColumnFilters(
    rows,
    { type: { logic: 'any', rules: [{ operator: 'equals', value: 'reboot' }, { operator: 'equals', value: 'firmware' }] } },
    (r) => r.type
  );
  assert.equal(result.length, 3);
});

test('multiple columns are combined with AND', () => {
  const result = applyColumnFilters(
    rows,
    {
      type: { logic: 'all', rules: [{ operator: 'equals', value: 'reboot' }] },
      status: { logic: 'all', rules: [{ operator: 'equals', value: 'pending' }] },
    },
    (r, c) => r[c]
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].created_at, '2026-01-01');
});

test('supports not_contains, starts_with, ends_with and equals operators', () => {
  const base = (op, value) => applyColumnFilters(
    rows,
    { type: { logic: 'all', rules: [{ operator: op, value }] } },
    (r) => r.type
  );
  assert.equal(base('not_contains', 'reboot').length, 1);
  assert.equal(base('starts_with', 'firm').length, 1);
  assert.equal(base('ends_with', 'boot').length, 2);
  assert.equal(base('equals', 'reboot').length, 2);
});

test('matchesValue handles each operator independently', () => {
  assert.equal(matchesValue('Hello World', { operator: 'contains', value: 'world' }), true);
  assert.equal(matchesValue('Hello World', { operator: 'not_contains', value: 'mars' }), true);
  assert.equal(matchesValue('Hello World', { operator: 'starts_with', value: 'hello' }), true);
  assert.equal(matchesValue('Hello World', { operator: 'ends_with', value: 'WORLD' }), true);
  assert.equal(matchesValue('Hello World', { operator: 'equals', value: 'hello world' }), true);
  assert.equal(matchesValue('Hello World', { operator: 'equals', value: 'hello' }), false);
});

test('matchesValue supports numeric comparisons', () => {
  assert.equal(matchesValue('42', { operator: 'greater_than', value: '40' }), true);
  assert.equal(matchesValue('42', { operator: 'greater_than_or_equal', value: '42' }), true);
  assert.equal(matchesValue('42', { operator: 'less_than', value: '50' }), true);
  assert.equal(matchesValue('42', { operator: 'less_than_or_equal', value: '42' }), true);
  assert.equal(matchesValue('42', { operator: 'less_than', value: '40' }), false);
  assert.equal(matchesValue('not-a-number', { operator: 'greater_than', value: '1' }), false);
});
