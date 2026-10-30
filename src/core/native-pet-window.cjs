'use strict';

const path = require('node:path');

// A child window sits above the browser's native view while remaining attached
// to its owner. It never grants IPC access to any other renderer.
function createNativePetWindow({ owner, screen, BrowserWindow, ipcMain, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  if (!owner || !screen || !BrowserWindow || !ipcMain) throw new Error('宠物窗口配置无效。');
  let overlay = null, state = null, disposed = false, pressed = false, pressedButton = null, ignored = true, loadPromise = null, timer = null;
  function stopTimer() { if (timer !== null) clearIntervalImpl(timer); timer = null; }
  function startTimer() { if (timer === null) { timer = setIntervalImpl(updateHit, 16); timer?.unref?.(); } }
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const validRect = r => r && ['x', 'y', 'width', 'height'].every(k => finite(r[k])) && r.width > 0 && r.height > 0;
  function shown() { return !disposed && state?.visible && overlay && !overlay.isDestroyed() && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized(); }
  function geometry() {
    if (!overlay || overlay.isDestroyed() || !state || owner.isDestroyed()) return;
    const content = owner.getContentBounds(), b = state.bounds;
    overlay.setBounds({ x: Math.round(content.x + b.x), y: Math.round(content.y + b.y), width: Math.max(1, Math.ceil(b.width)), height: Math.max(1, Math.ceil(b.height)) });
    if (shown()) {
      overlay.showInactive();
      startTimer();
      if (!overlay.webContents.isLoadingMainFrame()) overlay.webContents.send('cortex:pet-native-state', state);
    } else { stopTimer(); overlay.hide(); }
  }
  function updateHit() {
    if (!shown()) return;
    const cursor = screen.getCursorScreenPoint(), rect = overlay.getBounds(), h = state.hit;
    const x = cursor.x - rect.x, y = cursor.y - rect.y;
    const inside = x >= h.x && y >= h.y && x < h.x + h.width && y < h.y + h.height;
    const next = !pressed && !inside;
    if (next !== ignored) { ignored = next; overlay.setIgnoreMouseEvents(next, { forward: true }); }
  }
  function create() {
    if (overlay && !overlay.isDestroyed()) return;
    overlay = new BrowserWindow({ parent: owner, show: false, frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, webPreferences: { preload: path.join(__dirname, '..', 'pet-native-preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    overlay.setIgnoreMouseEvents(true, { forward: true }); ignored = true;
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', event => event.preventDefault());
    overlay.webContents.on('did-finish-load', () => { if (shown()) overlay.webContents.send('cortex:pet-native-state', state); });
    overlay.on('closed', () => { stopTimer(); overlay = null; pressed = false; });
    loadPromise = overlay.loadFile(path.join(__dirname, '..', 'renderer', 'pet-native.html')).then(() => true, () => false);
  }
  function input(event, value) {
    if (!shown() || event.sender !== overlay.webContents || event.senderFrame !== overlay.webContents.mainFrame || !value || typeof value !== 'object') return;
    if (owner.webContents.isDestroyed?.() || owner.webContents.isCrashed?.()) return;
    if (!['mouseMove', 'mouseDown', 'mouseUp'].includes(value.type) || !finite(value.x) || !finite(value.y)) return;
    if (!pressed && value.type === 'mouseMove') updateHit();
    if (!pressed && (value.x < 0 || value.y < 0 || value.x > state.bounds.width || value.y > state.bounds.height)) return;
    const h = state.hit;
    if (!pressed && (value.x < h.x || value.y < h.y || value.x >= h.x + h.width || value.y >= h.y + h.height)) return;
    if (!pressed && value.type === 'mouseUp') return;
    if (Math.abs(value.x) > 10000 || Math.abs(value.y) > 10000) return;
    if (value.type !== 'mouseMove' && !['left', 'right'].includes(value.button)) return;
    if (value.type === 'mouseDown') { pressed = true; pressedButton = value.button; }
    const eventInput = { type: value.type, x: Math.round(state.bounds.x + value.x), y: Math.round(state.bounds.y + value.y),
      ...(value.type !== 'mouseMove' ? { button: value.button, clickCount: 1 } : pressed ? { modifiers: [pressedButton === 'right' ? 'rightButtonDown' : 'leftButtonDown'] } : {}) };
    try { owner.webContents.sendInputEvent(eventInput); } catch { hide(); return; }
    if (value.type === 'mouseUp') { pressed = false; pressedButton = null; updateHit(); }
  }
  ipcMain.on('cortex:pet-native-input', input);
  const refresh = () => { geometry(); updateHit(); };
  for (const event of ['move', 'resize', 'show', 'hide', 'minimize', 'restore']) owner.on(event, refresh);
  function hide() {
    state = null; pressed = false; pressedButton = null; stopTimer();
    if (overlay && !overlay.isDestroyed()) {
      overlay.setIgnoreMouseEvents(true, { forward: true }); ignored = true;
      overlay.hide();
    }
    return { visible: false };
  }
  const resetRenderer = () => { hide(); };
  owner.webContents.on('did-start-loading', resetRenderer);
  owner.webContents.on('render-process-gone', resetRenderer);
  async function update(next) {
    if (disposed || !next || typeof next.visible !== 'boolean') return hide();
    if (!next.visible) return hide();
    if (!validRect(next.bounds) || !validRect(next.hit) || next.bounds.width > 1024 || next.bounds.height > 1024
      || typeof next.fallback !== 'boolean' || typeof next.src !== 'string' || next.src.length > 8192 || !(next.src.startsWith('file:') || next.fallback && !next.src)
      || typeof next.loop !== 'boolean' || typeof next.paused !== 'boolean' || !finite(next.time) || next.time < 0
      || !(next.gazeData === null || typeof next.gazeData === 'string' && next.gazeData.startsWith('data:image/png;base64,') && next.gazeData.length < 2_000_000)) return hide();
    state = { visible: true, bounds: { ...next.bounds }, hit: { ...next.hit }, src: next.src, fallback: next.fallback, loop: next.loop, paused: next.paused, time: next.time, gazeData: next.gazeData };
    const requested = state;
    create();
    if (!await loadPromise) {
      if (state === requested) {
        hide();
        if (overlay && !overlay.isDestroyed()) overlay.destroy();
      }
      return { visible: false };
    }
    if (disposed || state !== requested || !overlay || overlay.isDestroyed()) return { visible: false };
    geometry(); updateHit();
    return { visible: Boolean(shown()) };
  }
  function dispose() {
    if (disposed) return; disposed = true; stopTimer(); ipcMain.removeListener('cortex:pet-native-input', input);
    owner.webContents.removeListener('did-start-loading', resetRenderer);
    owner.webContents.removeListener('render-process-gone', resetRenderer);
    for (const event of ['move', 'resize', 'show', 'hide', 'minimize', 'restore']) owner.removeListener(event, refresh);
    if (overlay && !overlay.isDestroyed()) overlay.destroy(); overlay = null; state = null;
  }
  owner.once('closed', dispose);
  return Object.freeze({ update, dispose });
}
module.exports = { createNativePetWindow };
