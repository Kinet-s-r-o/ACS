import test from 'node:test';
import assert from 'node:assert/strict';
import { booleanChangePrompt, confirmBooleanChange } from '../src/lib/booleanConfirmation.ts';

test('both boolean directions show the target and its old/new values', () => {
  for (const current of [true, false]) {
    const prompt = booleanChangePrompt('Active for metric Signal', current);
    assert.ok(prompt.description.includes('Active for metric Signal'));
    assert.ok(prompt.description.includes(current ? 'from Yes to No' : 'from No to Yes'));
  }
});

test('no change occurs while confirmation is pending or after cancellation', async () => {
  let resolve;
  let applied = 0;
  const result = confirmBooleanChange(() => new Promise(done => { resolve = done; }), booleanChangePrompt('WAN', true), () => applied++);
  assert.equal(applied, 0);
  resolve(false);
  assert.equal(await result, false);
  assert.equal(applied, 0);
});

test('confirmation applies exactly one change and waits for it to finish', async () => {
  let applied = 0;
  let finish;
  const result = confirmBooleanChange(async () => true, booleanChangePrompt('Active', false), async () => { applied++; await new Promise(done => { finish = done; }); });
  await Promise.resolve();
  assert.equal(applied, 1);
  finish();
  assert.equal(await result, true);
  assert.equal(applied, 1);
});
