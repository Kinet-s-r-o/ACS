import test from 'node:test';
import assert from 'node:assert/strict';
import { dragScrollSpeed, startDragAutoScroll } from '../src/lib/dragAutoScroll.ts';

test('scrolls in both directions near edges, stays still in the center and outside', () => {
  assert.equal(dragScrollSpeed(100, 100, 500), -720);
  assert.equal(dragScrollSpeed(500, 100, 500), 720);
  assert.equal(dragScrollSpeed(300, 100, 500), 0);
  assert.equal(dragScrollSpeed(99, 100, 500), 0);
  assert.equal(dragScrollSpeed(501, 100, 500), 0);
  assert.ok(dragScrollSpeed(480, 100, 500) > dragScrollSpeed(450, 100, 500));
});

test('continues scrolling with a stationary pointer and releases the frame and listener', () => {
  let tick;
  let listener;
  let cancelled;
  const container = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0, parentElement: null, getBoundingClientRect: () => ({ top: 100, bottom: 500 }) };
  globalThis.window = { innerHeight: 800 };
  globalThis.document = {
    elementFromPoint: () => container,
    addEventListener: (_, callback) => { listener = callback; },
    removeEventListener: (_, callback) => { assert.equal(callback, listener); listener = null; },
  };
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' });
  globalThis.requestAnimationFrame = callback => { tick = callback; return 7; };
  globalThis.cancelAnimationFrame = id => { cancelled = id; };
  const stop = startDragAutoScroll({ clientX: 30, clientY: 490 });
  tick(100);
  const first = container.scrollTop;
  tick(116);
  assert.ok(container.scrollTop > first && first > 0);
  listener({ clientX: 30, clientY: 110 });
  const beforeUp = container.scrollTop;
  tick(132);
  assert.ok(container.scrollTop < beforeUp);
  stop();
  assert.equal(cancelled, 7);
  assert.equal(listener, null);
});
