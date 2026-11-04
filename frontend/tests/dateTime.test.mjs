import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime, formatParameterDateTime, setDateTimeFormat } from '../src/lib/dateTime.ts';

test('date and time formats use explicit ordering and preserve seconds', () => {
  const value = new Date(2026, 10, 6, 14, 5, 9);
  assert.equal(formatDateTime(value, 'dmy'), '06.11.2026 14:05:09');
  assert.equal(formatDateTime(value, 'ymd'), '2026-11-06 14:05:09');
  assert.equal(formatDateTime(value, 'mdy'), '11/06/2026 02:05:09 PM');
  assert.equal(formatDateTime(new Date(2026, 0, 1, 0, 0, 0), 'mdy'), '01/01/2026 12:00:00 AM');
  assert.equal(formatDateTime('2026-11-06T14:05:09+02:00', 'iso'), '2026-11-06T12:05:09.000Z');
});

test('missing and invalid timestamps have a placeholder; Unix epoch zero is valid', () => {
  for (const value of [undefined, null, '', 'not-a-date']) assert.equal(formatDateTime(value), '—');
  assert.equal(formatDateTime(0, 'iso'), '1970-01-01T00:00:00.000Z');
});

test('typed dateTime values follow settings while numeric counters remain untouched', () => {
  setDateTimeFormat('iso');
  for (const type of ['dateTime', 'xsd:dateTime', 'xs:dateTime']) {
    assert.equal(formatParameterDateTime('2026-11-06T14:05:09Z', type), '2026-11-06T14:05:09.000Z');
  }
  for (const type of ['unsignedInt', 'xsd:unsignedInt', 'string', undefined]) assert.equal(formatParameterDateTime('1793973909', type), '1793973909');
  setDateTimeFormat('invalid-format');
  assert.equal(formatDateTime('2026-11-06T14:05:09Z'), formatDateTime('2026-11-06T14:05:09Z', 'locale'));
});
