import test from 'node:test';
import assert from 'node:assert/strict';
import { featureParameterUnavailableReason } from '../src/lib/featureParameterState.ts';

test('missing parameters and unknown write metadata have distinct explanations', () => {
  assert.match(featureParameterUnavailableReason(), /Parameter has not been reported/);
  assert.match(featureParameterUnavailableReason({}), /Write access has not been reported/);
  assert.match(featureParameterUnavailableReason({ writable: null }), /Write access has not been reported/);
});

test('only an explicit writable flag permits changes regardless of the current value', () => {
  for (const value of ['', '0', '1', 'false', 'true']) {
    assert.equal(featureParameterUnavailableReason({ writable: true, value }), '');
    assert.match(featureParameterUnavailableReason({ writable: false, value }), /read-only/);
  }
});
