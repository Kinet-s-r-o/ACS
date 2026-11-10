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
  const listeners = new Map();
  let cancelled;
  const container = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0, parentElement: null, getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 0, right: 500 }) };
  globalThis.window = { innerHeight: 800 };
  globalThis.document = {
    elementFromPoint: () => container,
    addEventListener: (name, callback) => { listeners.set(name, callback); },
    removeEventListener: (name, callback) => { assert.equal(callback, listeners.get(name)); listeners.delete(name); },
  };
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' });
  globalThis.requestAnimationFrame = callback => { tick = callback; return 7; };
  globalThis.cancelAnimationFrame = id => { cancelled = id; };
  const stop = startDragAutoScroll({ clientX: 30, clientY: 490 }, container);
  tick(100);
  const first = container.scrollTop;
  tick(116);
  assert.ok(container.scrollTop > first && first > 0);
  listeners.get('pointermove')({ clientX: 30, clientY: 110 });
  const beforeUp = container.scrollTop;
  tick(132);
  assert.ok(container.scrollTop < beforeUp);
  stop();
  assert.equal(cancelled, 7);
  assert.equal(listeners.size, 0);
});

function setupScroll() {
  let tick;
  const listeners = new Map();
  const root = { scrollHeight: 3000, clientHeight: 800, scrollTop: 100, parentElement: null };
  let position = 100;
  const table = {
    scrollHeight: 2000, clientHeight: 400, parentElement: root,
    get scrollTop() { return position; },
    set scrollTop(value) { position = Math.max(0, Math.min(1600, value)); },
    getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 0, right: 500 }),
  };
  globalThis.window = { innerHeight: 800, innerWidth: 1000 };
  globalThis.document = {
    scrollingElement: root,
    // Outside the table, hit testing no longer finds its scroll container.
    elementFromPoint: () => root,
    addEventListener: (name, callback) => { listeners.set(name, callback); },
    removeEventListener: name => { listeners.delete(name); },
  };
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' });
  globalThis.requestAnimationFrame = callback => { tick = callback; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const row = { scrollHeight: 40, clientHeight: 40, parentElement: table };
  const stop = startDragAutoScroll({ clientX: 30, clientY: 490 }, row);
  return { table, root, listeners, stop, frame: time => tick(time) };
}

test('keeps scrolling the source table after the pointer leaves its bottom edge', () => {
  const state = setupScroll();
  try {
    state.listeners.get('pointermove')({ clientX: 30, clientY: 540 });
    state.frame(100);
    assert.ok(state.table.scrollTop > 100);
    state.listeners.get('pointermove')({ clientX: 30, clientY: 70 });
    const before = state.table.scrollTop;
    state.frame(116);
    assert.ok(state.table.scrollTop < before);
  } finally { state.stop(); }
});

test('wheel scrolls the source table during dragging and bubbles remaining distance to the page', () => {
  const state = setupScroll();
  const wheel = (deltaY, deltaMode = 0) => {
    const event = { deltaY, deltaMode, preventDefault() { this.prevented = true; } };
    state.listeners.get('wheel')(event);
    assert.equal(event.prevented, true);
  };
  try {
    wheel(80);
    assert.equal(state.table.scrollTop, 180);
    wheel(-2, 1);
    assert.equal(state.table.scrollTop, 148);
    state.table.scrollTop = 1590;
    wheel(50);
    assert.equal(state.table.scrollTop, 1600);
    assert.equal(state.root.scrollTop, 140);
  } finally { state.stop(); }
});

test('moves the page when the source table has reached its end near the viewport edge', () => {
  const state = setupScroll();
  try {
    state.table.scrollTop = 1600;
    state.listeners.get('pointermove')({ clientX: 30, clientY: 790 });
    state.frame(100);
    assert.ok(state.root.scrollTop > 100);
  } finally { state.stop(); }
});
