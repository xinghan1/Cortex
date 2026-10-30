import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createNativePetWindow } = createRequire(import.meta.url)('../src/core/native-pet-window.cjs');

test('native pet stays attached to its owner, forwards only its own input, and disposes', async () => {
  const ipcMain = new EventEmitter(), sent = [], motions = []; let cursor = { x: 150, y: 140 }, child, timersStarted = 0, timersCleared = 0;
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {}; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    isLoadingMainFrame() { return false; }
    send(channel, state) { sent.push({ channel, state }); }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); child = this; this.options = options; this.webContents = new Contents(); this.dead = false; }
    setBounds(value) { this.bounds = value; } getBounds() { return this.bounds; }
    isDestroyed() { return this.dead; } showInactive() { this.visible = true; } hide() { this.visible = false; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(value) { this.ignored = value; }
    loadFile() { return Promise.resolve(); } destroy() { this.dead = true; this.emit('closed'); }
  }
  const owner = new EventEmitter(); let ownerVisible = true;
  owner.isDestroyed = () => false; owner.isVisible = () => ownerVisible; owner.isMinimized = () => false; owner.isFocused = () => true;
  owner.getContentBounds = () => ({ x: 100, y: 100, width: 800, height: 600 });
  owner.webContents = new EventEmitter(); owner.webContents.sendInputEvent = value => motions.push(value);
  const pet = createNativePetWindow({ owner, screen: { getCursorScreenPoint: () => cursor }, BrowserWindow: Window, ipcMain,
    setIntervalImpl: () => ++timersStarted, clearIntervalImpl: () => { timersCleared++; } });
  assert.equal(timersStarted, 0, 'Idle windows never poll the cursor');
  const state = { visible: true, bounds: { x: 20, y: 30, width: 100, height: 100 }, hit: { x: 10, y: 0, width: 70, height: 90 },
    src: 'file:///fixture.webm', fallback: false, loop: true, paused: false, time: 0, gazeData: null };
  assert.deepEqual(await pet.update(state), { visible: true });
  assert.equal(timersStarted, 1);
  assert.equal(child.options.parent, owner); assert.equal(child.options.focusable, false);
  assert.deepEqual(child.bounds, { x: 120, y: 130, width: 100, height: 100 });
  assert.equal(child.ignored, false); assert.equal(sent.at(-1).channel, 'cortex:pet-native-state');
  ipcMain.emit('cortex:pet-native-input', { sender: {}, senderFrame: child.webContents.mainFrame }, { type: 'mouseDown', x: 30, y: 10, button: 'left' });
  assert.equal(motions.length, 0);
  const sender = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  ipcMain.emit('cortex:pet-native-input', sender, { type: 'mouseDown', x: 95, y: 95, button: 'left' });
  assert.equal(motions.length, 0, 'A transparent non-hit area must not forward clicks');
  ipcMain.emit('cortex:pet-native-input', sender, { type: 'mouseDown', x: 30, y: 10, button: 'left' });
  ipcMain.emit('cortex:pet-native-input', sender, { type: 'mouseMove', x: 120, y: 110 });
  ipcMain.emit('cortex:pet-native-input', sender, { type: 'mouseUp', x: 120, y: 110, button: 'left' });
  assert.deepEqual(motions.map(value => value.type), ['mouseDown', 'mouseMove', 'mouseUp']);
  assert.deepEqual(motions[1].modifiers, ['leftButtonDown']);
  cursor = { x: 110, y: 110 }; owner.emit('move'); assert.equal(child.ignored, true);
  assert.deepEqual(await pet.update({ ...state, src: 'https://invalid.example/' }), { visible: false });
  assert.equal(child.visible, false); assert.equal(child.ignored, true); assert.equal(timersCleared, 1);
  assert.deepEqual(await pet.update(state), { visible: true });
  assert.equal(timersStarted, 2, 'Showing a pet restarts polling');
  ownerVisible = false; owner.emit('hide'); assert.equal(child.visible, false);
  assert.equal(timersCleared, 2);
  ownerVisible = true; owner.emit('show'); assert.equal(child.visible, true);
  assert.equal(timersStarted, 3);
  owner.webContents.emit('did-start-loading'); assert.equal(child.visible, false);
  assert.deepEqual(await pet.update(state), { visible: true });
  owner.webContents.emit('render-process-gone'); assert.equal(child.visible, false);
  assert.deepEqual(await pet.update(state), { visible: true });
  assert.deepEqual(await pet.update({ visible: false }), { visible: false }); assert.equal(child.visible, false);
  owner.emit('closed'); assert.equal(child.dead, true); assert.equal(ipcMain.listenerCount('cortex:pet-native-input'), 0);
  pet.dispose();
});

test('hiding while the native page loads cannot restore stale visibility', async () => {
  const ipcMain = new EventEmitter(); let resolveLoad, child;
  class Window extends EventEmitter {
    constructor() { super(); child = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {}; this.webContents.isLoadingMainFrame = () => true; this.webContents.send = () => {}; }
    setIgnoreMouseEvents() {} setBounds() {} getBounds() { return { x: 0, y: 0 }; }
    isDestroyed() { return false; } showInactive() { this.visible = true; } hide() { this.visible = false; }
    loadFile() { return new Promise(resolve => { resolveLoad = resolve; }); } destroy() {}
  }
  const owner = new EventEmitter(); owner.isDestroyed = () => false; owner.isVisible = () => true; owner.isMinimized = () => false;
  owner.getContentBounds = () => ({ x: 0, y: 0 }); owner.webContents = new EventEmitter(); owner.webContents.sendInputEvent = () => {};
  const pet = createNativePetWindow({ owner, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, BrowserWindow: Window, ipcMain });
  const pending = pet.update({ visible: true, bounds: { x: 0, y: 0, width: 30, height: 30 }, hit: { x: 0, y: 0, width: 30, height: 30 }, src: 'file:///fixture.webm', fallback: false, loop: true, paused: false, time: 0, gazeData: null });
  assert.deepEqual(await pet.update({ visible: false }), { visible: false }); resolveLoad();
  assert.deepEqual(await pending, { visible: false }); assert.equal(child.visible, false); pet.dispose();
});
