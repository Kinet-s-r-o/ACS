import test from 'node:test';
import assert from 'node:assert/strict';
import { startPointerRowReorder } from '../src/lib/pointerRowReorder.ts';

function setup() {
  const listeners = new Map();
  const emit = (type, event = {}) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  const events = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const scroller = {
    scrollTop: 100, scrollHeight: 2000, clientHeight: 400, parentElement: null,
    getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 0, right: 500 }),
  };
  const table = { parentElement: scroller, scrollHeight: 2000, clientHeight: 2000 };
  let captured = false;
  let cancelledFrame = false;
  let frame;
  let outside = false;
  const handle = {
    ...events, parentElement: table, scrollHeight: 32, clientHeight: 32,
    closest: () => table,
    focus() {},
    setPointerCapture() { captured = true; },
    hasPointerCapture() { return captured; },
    releasePointerCapture() { captured = false; },
  };
  globalThis.window = { ...events, innerHeight: 800, innerWidth: 1000 };
  globalThis.document = {
    ...events,
    elementFromPoint: () => outside ? null : {
      closest: () => ({
        dataset: { rowReorderId: scroller.scrollTop > 150 ? '3' : '2' },
        closest: () => table,
      }),
    },
  };
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' });
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { cancelledFrame = true; };
  const pointer = overrides => ({ pointerId: 7, clientX: 30, clientY: 300, button: 0, buttons: 1, preventDefault() {}, ...overrides });
  const drops = [];
  const targets = [];
  let starts = 0;
  let ends = 0;
  const cancel = startPointerRowReorder(pointer(), handle, {
    onStart: () => starts++, onTarget: id => targets.push(id), onDrop: id => drops.push(id), onEnd: () => ends++,
  });
  return {
    emit, pointer, cancel, scroller, drops, targets,
    frame: time => frame(time), outside: () => { outside = true; },
    start: () => emit('pointermove', pointer({ clientY: 310 })),
    get starts() { return starts; }, get ends() { return ends; },
    get captured() { return captured; }, get cancelledFrame() { return cancelledFrame; },
    get listeners() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

test('a click or tiny movement never reorders a row', () => {
  const state = setup();
  state.emit('pointermove', state.pointer({ clientY: 302 }));
  state.emit('pointerup', state.pointer());
  assert.equal(state.starts, 0);
  assert.deepEqual(state.drops, []);
  assert.equal(state.captured, false);
  assert.equal(state.listeners, 0);
});

test('held pointer keeps wheel events available and drops onto the row revealed by scrolling', () => {
  const state = setup();
  state.start();
  assert.equal(state.starts, 1);
  assert.equal(state.captured, true);
  assert.deepEqual(state.targets, [2]);
  let prevented = false;
  state.emit('wheel', { deltaY: 80, deltaMode: 0, preventDefault() { prevented = true; } });
  assert.equal(state.scroller.scrollTop, 180);
  assert.equal(prevented, true);
  state.emit('scroll');
  assert.equal(state.targets.at(-1), 3);
  state.emit('pointerup', state.pointer());
  assert.deepEqual(state.drops, [3]);
  assert.equal(state.ends, 1);
  assert.equal(state.captured, false);
  assert.equal(state.cancelledFrame, true);
  assert.equal(state.listeners, 0);
});

test('wheel scrolling temporarily overrides edge autoscroll in the opposite direction', () => {
  const state = setup();
  state.emit('pointermove', state.pointer({ clientY: 490 }));
  state.frame(performance.now());
  const before = state.scroller.scrollTop;
  state.emit('wheel', { deltaY: -50, deltaMode: 0, preventDefault() {} });
  state.frame(performance.now() + 16);
  assert.equal(state.scroller.scrollTop, before - 50);
  state.cancel();
});

test('foreign pointers cannot move, release or cancel the held row', () => {
  const state = setup();
  state.emit('pointermove', state.pointer({ pointerId: 8, clientY: 350 }));
  assert.equal(state.starts, 0);
  state.start();
  state.emit('pointercancel', state.pointer({ pointerId: 8 }));
  state.emit('pointerup', state.pointer({ pointerId: 8 }));
  assert.equal(state.ends, 0);
  state.cancel();
});

test('releasing outside the table does not reorder', () => {
  const state = setup();
  state.start();
  state.outside();
  state.emit('pointerup', state.pointer());
  assert.deepEqual(state.drops, []);
  assert.equal(state.listeners, 0);
});

for (const reason of ['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'unmount', 'released button']) {
  test(`${reason} cancels the move and releases scrolling and capture`, () => {
    const state = setup();
    state.start();
    if (reason === 'Escape') state.emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    else if (reason === 'unmount') state.cancel();
    else if (reason === 'released button') state.emit('pointermove', state.pointer({ buttons: 0 }));
    else state.emit(reason, state.pointer());
    state.cancel();
    assert.deepEqual(state.drops, []);
    assert.equal(state.ends, 1);
    assert.equal(state.captured, false);
    assert.equal(state.cancelledFrame, true);
    assert.equal(state.listeners, 0);
  });
}
