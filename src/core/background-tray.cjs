'use strict';

// Window close keeps the same runtimes alive. Only an explicit quit follows
// the application's existing shutdown/save/cancellation path.
function createBackgroundTray({ Tray, Menu, icon, getWindows, createWindow, onQuit }) {
  const tray = new Tray(icon);
  let disposed = false, opening = null;
  const alive = () => !disposed && !tray.isDestroyed();
  const windows = () => [...new Set(getWindows())].filter(win => win && !win.isDestroyed());
  function showWindow(win) {
    if (!alive() || !win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus(); return true;
  }
  async function show() {
    if (!alive()) return;
    const existing = windows()[0];
    if (existing) { showWindow(existing); return; }
    // Repeated clicks while recreating a genuinely destroyed window share one
    // creation, rather than replacing or duplicating a hidden task runtime.
    if (!opening) opening = Promise.resolve().then(createWindow).then(value => {
      const win = value?.win || value;
      if (alive()) showWindow(win);
    }).finally(() => { opening = null; });
    return opening;
  }
  const open = () => { void show().catch(error => console.error('无法恢复 Cortex 窗口：', error.message)); };
  const quit = () => {
    if (!alive()) return;
    // The application callback restores any dirty editor before its existing
    // save/discard prompt, and shuts down running work only on explicit exit.
    onQuit();
  };
  tray.setToolTip('Cortex · 关闭窗口后继续在后台运行');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: open },
    { type: 'separator' },
    { label: '退出应用', click: quit },
  ]));
  tray.on('click', open);
  tray.on('double-click', open);
  return Object.freeze({
    show, showWindow,
    hideWindow(win) {
      if (!alive() || !win || win.isDestroyed()) return false;
      win.hide(); return true;
    },
    snapshot: () => ({ available: alive(), windows: windows().length,
      hiddenWindows: windows().filter(win => !win.isVisible()).length }),
    dispose() { if (disposed) return; disposed = true; if (!tray.isDestroyed()) tray.destroy(); },
  });
}

module.exports = { createBackgroundTray };
