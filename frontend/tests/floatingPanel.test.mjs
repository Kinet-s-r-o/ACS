import test from 'node:test';
import assert from 'node:assert/strict';
import { floatingPanelPosition } from '../src/lib/floatingPanel.ts';

test('right-side table menu stays below the trigger and inside the viewport', () => {
  assert.deepEqual(floatingPanelPosition({ left: 970, right: 994, top: 80, bottom: 104 }, { width: 220, height: 360 }, { width: 1000, height: 800 }), { left: 772, top: 108 });
});

test('a menu near the bottom opens above the trigger', () => {
  assert.deepEqual(floatingPanelPosition({ left: 900, right: 924, top: 700, bottom: 724 }, { width: 220, height: 360 }, { width: 1000, height: 800 }), { left: 704, top: 336 });
});

test('short viewports and left-edge triggers retain visible margins', () => {
  assert.deepEqual(floatingPanelPosition({ left: 0, right: 24, top: 100, bottom: 124 }, { width: 220, height: 264 }, { width: 240, height: 280 }), { left: 8, top: 8 });
});
