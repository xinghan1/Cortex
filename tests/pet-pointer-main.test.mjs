import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const main = await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('function startPetPointerTracking()'), main.indexOf('\nfunction pluginOwnerContext('));
function fixture() {
  let callback, now = 0, cursor = { x: 150, y: 250 }, reads = 0;
  const sent = [];
  const target = { destroyed: false, visible: true, minimized: false, focused: false, webDestroyed: false, zoom: 2,
    bounds: { x: 100, y: 200, width: 1000, height: 800 },
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    isFocused() { return this.focused; }, getContentBounds() { return this.bounds; },
  };
  target.webContents = { isDestroyed: () => target.webDestroyed, getZoomFactor: () => target.zoom,
    send: (channel, event) => sent.push({ channel, ...JSON.parse(JSON.stringify(event)) }) };
  const context = vm.createContext({ quitting: false, dshPet: { cursorTrackingEnabled: () => true },
    windows: new Map([[1, { win: target }]]), screen: { getCursorScreenPoint: () => { reads++; return cursor; } },
    Date: { now: () => now }, setInterval: operation => { callback = operation; return { unref() {} }; },
  });
  vm.runInContext(source + '\nstartPetPointerTracking();', context);
  return { target, context, sent, reads: () => reads,
    tick: (point = cursor, elapsed = 50) => { cursor = point; now += elapsed; callback(); } };
}

test('desktop cursor reaches a visible unfocused pet, including outside-window and zoomed content coordinates', () => {
  const f = fixture(); f.tick();
  assert.deepEqual(f.sent[0], { channel: 'forge:event', type: 'pet-pointer', x: 25, y: 25, inside: true });
  f.tick({ x: -100, y: 150 });
  assert.deepEqual(f.sent[1], { channel: 'forge:event', type: 'pet-pointer', x: -100, y: -25, inside: false });
  f.target.bounds = { x: -1920, y: -300, width: 1600, height: 1000 }; f.target.zoom = 1.25;
  f.tick({ x: -1820, y: -200 });
  assert.equal(f.sent[2].x, 80); assert.equal(f.sent[2].y, 80);
  assert.equal(f.target.focused, false, 'Focus is not required for a visible idle pet');
});

test('hidden, minimized, destroyed, disabled and quitting windows do not poll or publish pet pointers', () => {
  for (const field of ['destroyed', 'minimized', 'webDestroyed', 'visible']) {
    const f = fixture(); f.target[field] = field === 'visible' ? false : true; f.tick();
    assert.equal(f.sent.length, 0, field); assert.equal(f.reads(), 0, field);
  }
  const disabled = fixture(); disabled.context.dshPet.cursorTrackingEnabled = () => false; disabled.tick();
  assert.equal(disabled.reads(), 0); assert.equal(disabled.sent.length, 0);
  const quitting = fixture(); quitting.context.quitting = true; quitting.tick();
  assert.equal(quitting.reads(), 0); assert.equal(quitting.sent.length, 0);
});

test('stationary cursor broadcasts are throttled while movement updates promptly', () => {
  const f = fixture(); f.tick(); f.tick(); f.tick(); assert.equal(f.sent.length, 1);
  f.tick({ x: 151, y: 250 }); assert.equal(f.sent.length, 2);
  f.tick(undefined, 250); assert.equal(f.sent.length, 3);
});
