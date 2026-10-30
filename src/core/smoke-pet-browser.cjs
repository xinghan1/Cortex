const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { BrowserWindow, desktopCapturer, screen } = require('electron');

module.exports = async function smokePetBrowser({ win, output, dataDir }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code);
  const call = (name, value) => js(`window.forge[${JSON.stringify(name)}](${JSON.stringify(value ?? {})})`);
  const until = async (name, fn) => { for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await wait(30); } throw new Error('Pet browser smoke timeout: ' + name); };
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<style>body{background:#f6f6f6;color:#202020}</style><h1>Browser fixture</h1><button id="web-button" onclick="this.textContent=\'clicked\'">click</button>'); });
  const original = await call('petState');
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win.setOpacity(1); win.show(); win.setAlwaysOnTop(true); win.focus();
    await call('setPet', { enabled: true, x: 0.8, y: 0.2, size: 220, followCursor: false });
    await js("window.aiCodeCommands.execute('open-browser')");
    await until('browser pane', () => js("!document.getElementById('preview-panel').hidden && !document.getElementById('browser-preview').hidden"));
    await call('browserOpen', { url: `http://127.0.0.1:${server.address().port}/` });
    const mirror = await until('pet native surface', () => BrowserWindow.getAllWindows().find(w => w.getParentWindow() === win && w.webContents.getURL().includes('/pet-native.html') && w.isVisible()));
    await until('native animation ready', () => mirror.webContents.executeJavaScript("document.querySelector('video').readyState >= 2"));
    await wait(600);
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'pet-native.png'), (await mirror.webContents.capturePage()).toPNG());
    const display = screen.getDisplayMatching(win.getBounds());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
    const capture = sources.find(source => source.display_id === String(display.id));
    if (capture && !capture.thumbnail.isEmpty()) {
      const b = win.getBounds(), scale = display.scaleFactor;
      const crop = { x: Math.max(0, Math.round((b.x - display.bounds.x) * scale)), y: Math.max(0, Math.round((b.y - display.bounds.y) * scale)), width: Math.round(b.width * scale), height: Math.round(b.height * scale) };
      const size = capture.thumbnail.getSize(); crop.width = Math.min(crop.width, size.width - crop.x); crop.height = Math.min(crop.height, size.height - crop.y);
      if (crop.width > 0 && crop.height > 0) await fs.writeFile(path.join(output, 'pet-browser-screen.png'), capture.thumbnail.crop(crop).toPNG());
    }
    const bounds = await js("(()=>{const a=document.getElementById('pet-overlay').getBoundingClientRect(),h=document.getElementById('pet-overlay-hit').getBoundingClientRect();return {x:h.x-a.x+h.width/2,y:h.y-a.y+h.height/2};})()");
    const p = { x: Math.round(bounds.x), y: Math.round(bounds.y) };
    const oldPosition = await js("(()=>{const r=document.getElementById('pet-overlay').getBoundingClientRect();return {x:r.x,y:r.y};})()");
    mirror.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    mirror.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
    mirror.webContents.sendInputEvent({ type: 'mouseMove', x: p.x - 30, y: p.y + 20, modifiers: ['leftButtonDown'] });
    mirror.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: p.x - 30, y: p.y + 20 });
    await until('drag moves pet', async () => { const r = await js("(()=>{const r=document.getElementById('pet-overlay').getBoundingClientRect();return {x:r.x,y:r.y};})()"); return Math.abs(r.x - oldPosition.x) > 5; });
    await wait(400);
    await js("document.getElementById('pet-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until('drag speech dismissed', () => js("document.getElementById('pet-dialog')?.hidden !== false"));
    await until('native pet visible after drag', () => mirror.isVisible());
    mirror.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    mirror.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...p });
    mirror.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...p });
    await until('pet menu', () => js("document.getElementById('pet-overlay-menu')?.hidden === false"));
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until('pet menu closed', () => js("document.getElementById('pet-overlay-menu')?.hidden === true"));
    await until('native pet returns', () => mirror.isVisible());
    mirror.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
    mirror.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
    await until('pet chat opens through mirrored input', () => js("document.getElementById('pet-dialog')?.hidden === false || document.getElementById('pet-dialog-input-bubble')?.hidden === false"));
    const guest = win.contentView.children.find(view => view.webContents && view.webContents !== win.webContents && !view.webContents.isDestroyed());
    assert.ok(guest);
    return { status: 'completed', nativePetVisible: true, forwardedClick: true, drag: true, menu: true, screenshot: 'pet-native.png' };
  } finally { win.setAlwaysOnTop(false); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await call('setPet', {enabled:original.enabled,size:original.size,x:original.x,y:original.y,workStatus:original.workStatus,followCursor:original.followCursor,packId:original.packId}).catch(() => {}); }
};
