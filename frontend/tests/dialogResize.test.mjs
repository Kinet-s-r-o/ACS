import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDialogRect } from '../src/lib/dialogResize.ts';

test('dialog remains reachable after shrinking the viewport', () => {
  const rect = fitDialogRect({ left: 600, top: 300, width: 900, height: 700 }, 390, 600);
  assert.deepEqual(rect, { left: 8, top: 8, width: 374, height: 584 });
});

test('resize keeps its anchor while there is room and prevents collapsing controls', () => {
  assert.deepEqual(fitDialogRect({ left: 100, top: 80, width: 500, height: 400 }, 1200, 900), { left: 100, top: 80, width: 500, height: 400 });
  assert.deepEqual(fitDialogRect({ left: -50, top: -80, width: -10, height: 1 }, 1200, 900), { left: 16, top: 16, width: 320, height: 180 });
});

test('help panel has enough width without overflowing small screens', () => {
  assert.equal(fitDialogRect({ left: 0, top: 0, width: 400, height: 400 }, 1200, 900, 800).width, 800);
  const rect = fitDialogRect({ left: 0, top: 0, width: 800, height: 400 }, 300, 160, 800);
  assert.deepEqual(rect, { left: 8, top: 8, width: 284, height: 144 });
});
