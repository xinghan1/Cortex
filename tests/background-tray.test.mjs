import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createBackgroundTray } = createRequire(import.meta.url)('../src/core/background-tray.cjs');

function windowFixture() {
  const calls = []; let visible = true, minimized = false, destroyed = false;
  return { calls, isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized,
    hide() { calls.push('hide'); visible = false; }, show() { calls.push('show'); visible = true; },
    focus() { calls.push('focus'); }, restore() { calls.push('restore'); minimized = false; },
    minimize() { minimized = true; }, destroy() { destroyed = true; },
    model: { running: true, aborted: false }, editorDraft: 'unsaved text' };
}
function fixture({ windows = [windowFixture()], createWindow = async () => windowFixture(), onQuit = () => {} } = {}) {
  let native;
  class FakeTray extends EventEmitter {
    constructor(icon) { super(); assert.equal(icon, 'local-icon'); native = this; this.dead = false; this.destroyCalls = 0; }
    setToolTip(value) { this.tooltip = value; } setContextMenu(value) { this.menu = value; }
    isDestroyed() { return this.dead; } destroy() { this.dead = true; this.destroyCalls++; }
  }
  const controller = createBackgroundTray({ Tray: FakeTray, Menu: { buildFromTemplate: value => value },
    icon: 'local-icon', getWindows: () => windows, createWindow, onQuit });
  return { controller, native, windows };
}

test('closing hides the same window without cancelling work or discarding an editor draft', () => {
  const f = fixture(), win = f.windows[0];
  assert.equal(f.controller.hideWindow(win), true);
  assert.equal(win.isVisible(), false); assert.equal(win.isDestroyed(), false);
  assert.deepEqual(win.model, { running: true, aborted: false }); assert.equal(win.editorDraft, 'unsaved text');
  assert.deepEqual(f.controller.snapshot(), { available: true, windows: 1, hiddenWindows: 1 });
});

test('tray clicks and show menu restore the existing runtime rather than creating another window', async () => {
  let created = 0;
  const f = fixture({ createWindow: async () => { created++; } }), win = f.windows[0];
  f.controller.hideWindow(win); win.minimize(); f.native.emit('click'); await Promise.resolve();
  assert.deepEqual(win.calls.slice(-3), ['restore', 'show', 'focus']);
  f.controller.hideWindow(win); f.native.menu.find(item => item.label === '显示窗口').click(); await Promise.resolve();
  assert.equal(win.isVisible(), true); assert.equal(created, 0); assert.equal(win.model.running, true);
});

test('only the explicit quit menu invokes the application shutdown callback', () => {
  let exits = 0;
  const f = fixture({ onQuit: () => { exits++; } });
  f.controller.hideWindow(f.windows[0]); f.native.emit('double-click'); assert.equal(exits, 0);
  f.native.menu.find(item => item.label === '退出应用').click(); assert.equal(exits, 1);
});

test('a genuinely destroyed window can be recreated once across concurrent tray clicks', async () => {
  let created = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const old = windowFixture(); old.destroy();
  const f = fixture({ windows: [old], createWindow: () => { created++; return pending; } });
  const first = f.controller.show(), second = f.controller.show(); await Promise.resolve();
  assert.equal(created, 1);
  const replacement = windowFixture(); resolve({ win: replacement }); await Promise.all([first, second]);
  assert.deepEqual(replacement.calls, ['show', 'focus']);
});

test('disposed tray cannot hide windows, create new windows or request another exit', async () => {
  let exits = 0;
  const f = fixture({ onQuit: () => { exits++; } });
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.native.destroyCalls, 1); assert.equal(f.controller.hideWindow(f.windows[0]), false);
  f.native.menu.find(item => item.label === '退出应用').click(); await f.controller.show();
  assert.equal(exits, 0); assert.equal(f.windows[0].isVisible(), true);
});
