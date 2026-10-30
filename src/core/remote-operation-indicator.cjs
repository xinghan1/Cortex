'use strict';

// Screen indicator only. The caller owns the actual operation and must stop it
// before calling hide(); the overlay never injects input or changes OS cursors.
function createRemoteOperationIndicator({ BrowserWindow, screen, onExit, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  if (!BrowserWindow || !screen || typeof onExit !== 'function') throw new Error('远程操作提示配置无效。');
  let windows = [], timer = null, running = false, closing = false, owner = null, generation = 0;
  const url = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  const page = content => url(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:system-ui,sans-serif}${content.css}</style></head><body>${content.body}</body></html>`);
  const borderPage = page({css:'body{box-sizing:border-box;border:4px solid #6198ff}',body:''});
  const cursorPage = page({css:'body{display:flex;align-items:center;justify-content:center}.mark{background:#3679ed;color:white;border:1px solid white;border-radius:50%;font-size:11px;font-weight:700;width:19px;height:19px;line-height:19px;text-align:center;box-shadow:0 1px 5px #0009}',body:'<span class="mark">AI</span>'});
  const barPage = page({css:'body{display:grid;place-items:center}.bar{display:block;color:#fff;background:#245dd4;border:1px solid #a4c6ff;border-radius:0 0 9px 9px;padding:8px 18px;text-decoration:none;font-size:14px;font-weight:600;box-shadow:0 2px 8px #0008}',body:'<a class="bar" href="https://synora.invalid/exit" title="退出当前屏幕控制，任务继续运行">退出屏幕控制</a>'});
  const hide = () => {
    if (!running && !windows.length) return;
    running = false; closing = true; generation++;
    if (timer) clearIntervalImpl(timer); timer = null;
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    windows = []; owner = null; closing = false;
  };
  function create(bounds, content, passthrough) {
    const instance = generation;
    const win = new BrowserWindow({ ...bounds, show:false, frame:false, transparent:true, resizable:false,
      movable:false, minimizable:false, maximizable:false, fullscreenable:false, skipTaskbar:true,
      focusable:false, alwaysOnTop:true, hasShadow:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} });
    windows.push(win); win.setAlwaysOnTop(true, 'screen-saver');
    if (passthrough) win.setIgnoreMouseEvents(true, { forward:true });
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.webContents.on('will-navigate', (event, target) => {
      event.preventDefault(); if (!passthrough && target === 'https://synora.invalid/exit' && running && !closing && instance === generation) onExit();
    });
    win.on('closed', () => { if (running && !closing && instance === generation) { hide(); onExit(); } });
    void win.loadURL(content).catch(() => { if (running && instance === generation) { hide(); onExit(); } });
    win.showInactive(); return win;
  }
  function show(window) {
    if (running) return;
    if (!window || window.isDestroyed()) throw new Error('操作窗口已关闭。');
    owner = window; running = true; const instance = ++generation;
    try {
      const bounds = screen.getDisplayMatching(window.getBounds()).bounds, {x,y,width,height}=bounds;
      create({x,y,width,height},borderPage,true);
      create({x:Math.round(x+(width-190)/2),y,width:190,height:42},barPage,false);
      const cursor = create({x,y,width:24,height:24},cursorPage,true);
      const move = () => {
        if (instance !== generation) return;
        if (!running || !owner || owner.isDestroyed()) { hide(); onExit(); return; }
        const p=screen.getCursorScreenPoint(), current=screen.getDisplayMatching(owner.getBounds()).bounds;
        if (current.x !== x || current.y !== y || current.width !== width || current.height !== height) {
          const currentOwner = owner; hide(); show(currentOwner); return;
        }
        const visible=p.x>=current.x&&p.y>=current.y&&p.x<current.x+current.width&&p.y<current.y+current.height;
        if (!cursor.isDestroyed()) { if (visible) { cursor.setPosition(p.x+12,p.y+12,false); cursor.showInactive(); } else cursor.hide(); }
      };
      move(); timer=setIntervalImpl(move, 50); timer?.unref?.();
    } catch (error) { hide(); throw error; }
  }
  return Object.freeze({show,hide,dispose:hide,get active(){return running;}});
}
module.exports = { createRemoteOperationIndicator };
