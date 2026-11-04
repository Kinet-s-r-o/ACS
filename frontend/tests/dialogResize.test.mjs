import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDialogRect, moveDialogRect } from '../src/lib/dialogResize.ts';

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

test('moving preserves compact dialog dimensions and applies pointer displacement', () => {
  assert.deepEqual(moveDialogRect({ left: 100, top: 80, width: 280, height: 150 }, 50, 30, 1200, 900), { left: 150, top: 110, width: 280, height: 150 });
});

test('moving stops at all viewport edges while keeping the whole dialog reachable', () => {
  const rect = { left: 100, top: 80, width: 500, height: 400 };
  assert.deepEqual(moveDialogRect(rect, -2000, -2000, 1200, 900), { left: 16, top: 16, width: 500, height: 400 });
  assert.deepEqual(moveDialogRect(rect, 2000, 2000, 1200, 900), { left: 684, top: 484, width: 500, height: 400 });
});

test('a moved dialog fits after viewport shrink and remains inside mobile margins', () => {
  assert.deepEqual(moveDialogRect({ left: 600, top: 400, width: 900, height: 700 }, 0, 0, 390, 600), { left: 8, top: 8, width: 374, height: 584 });
});
