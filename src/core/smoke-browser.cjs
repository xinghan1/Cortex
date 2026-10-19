// A real WebContentsView and DOM interaction against isolated loopback fixtures.
// No user profile, system clipboard, external account or external website is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, session } = require('electron');
const { BrowserPanel, BROWSER_TOOL_DEFINITIONS } = require('./browser-panel.cjs');

module.exports = async function smokeBrowser({ win, output, dataDir }) {
  const fixture = path.join(dataDir, 'browser-fixture-' + randomUUID());
  const project = path.join(fixture, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(project, 'preview.html'), '<!doctype html><title>Local project preview</title><style>body{background:#152039;color:white;font:24px sans-serif;padding:30px}</style><h1>Local project preview</h1><button id="local">Project button</button>');
  await fs.writeFile(path.join(project, '.env'), 'BROWSER_SECRET_NEVER_READ');
  const approvals = [], states = [], captures = [];
  let approval = true, downloadRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/download') { downloadRequests++; response.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture.txt"', 'Content-Type': 'application/octet-stream' }); response.end('must not be downloaded'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${request.url === '/second' ? 'Second fixture' : 'Browser fixture'}</title><style>body{background:#15171c;color:#eee;font:18px sans-serif;padding:24px}button,input{padding:10px;margin:8px}#space{height:1800px}h1{color:#8cb2ff}</style></head><body><h1>Browser fixture</h1>
      <p>Loopback-only page to verify actual browser controls.</p><form id="form"><input id="name" placeholder="Name"><input id="password" type="password" value="PRIVATE_PASSWORD_VALUE"><button id="submit">Submit fixture</button></form>
      <p id="status">Waiting for input</p><button id="change" onclick="document.getElementById('status').textContent='Button clicked'">Change status</button><a id="next" href="/second">Second page</a><a id="download" href="/download">Download fixture</a><a id="blocked" href="file:///C:/Windows/win.ini">Blocked file link</a><div id="space"></div><p>Bottom of fixture</p>
      <script>document.getElementById('name').addEventListener('input',()=>document.getElementById('status').textContent='Typing: '+document.getElementById('name').value);document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();document.getElementById('status').textContent='Submitted: '+document.getElementById('name').value});</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const host = new BrowserWindow({ width: 1000, height: 720, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  let panel;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => { for (let count = 0; count < 160; count++) { const value = await predicate(); if (value) return value; await wait(25); } throw new Error('Browser smoke timeout: ' + label); };
  try {
    assert.equal(host.webContents.isOffscreen(), true, 'smoke must not display an interactive window');
    await host.loadURL('data:text/html,<body style="background:%230d0d0d;color:white;font:18px sans-serif">Synora code browser fixture</body>');
    panel = new BrowserPanel({ window: host, getWorkspaceRoot: () => project,
      onState: value => states.push(value), approve: async value => { approvals.push(value); return approval; },
      captureDir: path.join(fixture, 'captures'), onCapture: value => captures.push(value) });
    panel.setLayout({ bounds: { x: 360, y: 80, width: 620, height: 600 }, visible: true });
    assert.deepEqual(BROWSER_TOOL_DEFINITIONS.map(tool => tool.name), ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_screenshot']);
    const navigation = JSON.parse(await panel.execute('browser_navigate', { url: origin + '/' }));
    assert.equal(navigation.title, 'Browser fixture'); assert.equal(approvals[0].kind, 'browser'); assert.equal(approvals[0].action, 'navigate');
    const contents = panel.view.webContents;
    const preferences = contents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.webviewTag, false); assert.equal(preferences.preload, undefined);
    assert.notEqual(contents.session, session.defaultSession);
    assert.deepEqual(await contents.executeJavaScript('({forge:typeof window.forge,require:typeof require,process:typeof process})'), { forge: 'undefined', require: 'undefined', process: 'undefined' });
    assert.equal(contents.session.isPersistent(), false);
    const snapshot = JSON.parse(await panel.execute('browser_snapshot'));
    assert.match(snapshot.text, /Loopback-only/); assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_PASSWORD_VALUE/);
    assert.ok(snapshot.elements.some(element => element.selector === '#name'));
    assert.equal(approvals.length, 1, 'reading snapshot must not request action approval');
    await panel.execute('browser_type', { selector: '#name', text: 'Synora code smoke' });
    assert.equal(await contents.executeJavaScript("document.getElementById('status').textContent"), 'Typing: Synora code smoke');
    await panel.execute('browser_click', { selector: '#submit' });
    assert.equal(await contents.executeJavaScript("document.getElementById('status').textContent"), 'Submitted: Synora code smoke');
    approval = false;
    await assert.rejects(panel.execute('browser_click', { selector: '#change' }), /未批准/);
    assert.equal(await contents.executeJavaScript("document.getElementById('status').textContent"), 'Submitted: Synora code smoke');
    approval = true;
    await assert.rejects(panel.execute('browser_type', { selector: '#password', text: 'no' }), /密码/);
    await assert.rejects(panel.execute('browser_click', { selector: 'button' }), /唯一/);
    await assert.rejects(panel.execute('browser_navigate', { url: 'javascript:alert(1)' }), /HTTP/);
    await panel.execute('browser_click', { selector: '#next' });
    await until('link navigation', () => panel.state().title === 'Second fixture' && !panel.state().loading);
    assert.equal(panel.state().canGoBack, true);
    panel.back(); await until('back', () => panel.state().url === origin + '/' && !panel.state().loading);
    panel.forward(); await until('forward', () => panel.state().title === 'Second fixture' && !panel.state().loading);
    panel.reload(); await until('reload', () => !panel.state().loading);
    const count = BrowserWindow.getAllWindows().length;
    await contents.executeJavaScript(`window.open(${JSON.stringify(origin + '/second')});null`);
    await wait(80); assert.equal(BrowserWindow.getAllWindows().length, count);
    await panel.execute('browser_click', { selector: '#blocked' }); await wait(100);
    assert.ok(panel.state().url.startsWith(origin), 'file navigation escaped sandbox');
    await panel.execute('browser_click', { selector: '#download' });
    await until('download cancelled', () => downloadRequests === 1 && /下载/.test(panel.state().error || ''));
    panel.setLayout({ overlayHidden: true }); assert.equal(panel.view.getVisible(), false);
    assert.equal(panel.state().url.startsWith(origin), true);
    panel.setLayout({ overlayHidden: false }); assert.equal(panel.view.getVisible(), true);
    panel.setLayout({ visible: false }); assert.equal(panel.view.getVisible(), false);
    panel.setLayout({ visible: true, bounds: { x: -300, y: -20, width: 5000, height: 5000 } });
    const [contentWidth, contentHeight] = host.getContentSize();
    assert.deepEqual(panel.view.getBounds(), { x: 0, y: 44, width: contentWidth, height: contentHeight - 44 });
    panel.setLayout({ bounds: { x: 360, y: 80, width: 620, height: 600 } });
    await panel.execute('browser_scroll', { y: 600 });
    assert.ok(JSON.parse(await panel.execute('browser_snapshot')).viewport.scrollY > 0);
    await panel.execute('browser_scroll', { y: -600 });
    await wait(160);
    const screenshot = JSON.parse(await panel.execute('browser_screenshot'));
    assert.ok(screenshot.width > 0 && screenshot.height > 0); assert.equal(captures.length, 1);
    assert.match(screenshot.note, /未将图像发送给模型/);
    const image = await fs.readFile(screenshot.path); assert.equal(image.subarray(1, 4).toString(), 'PNG');
    await fs.writeFile(path.join(output, 'embedded-browser.png'), image);
    await panel.execute('browser_navigate', { path: 'preview.html' });
    assert.equal(panel.state().title, 'Local project preview');
    assert.equal(approvals.at(-1).local, true);
    const oldLocalURL = panel.state().url;
    await assert.rejects(panel.open({ path: '../outside.html' }));
    const localSnapshot = JSON.parse(await panel.execute('browser_snapshot')); assert.match(localSnapshot.text, /Project button/);
    const permission = await contents.executeJavaScript("typeof Notification==='undefined'?'unsupported':Notification.requestPermission()");
    assert.ok(['denied', 'unsupported'].includes(permission));
    panel.resetWorkspace();
    await until('old browser contents destroyed', () => contents.isDestroyed());
    assert.equal(panel.state().exists, false); assert.equal(panel.state().visible, false);
    await assert.rejects(fetch(oldLocalURL));
    await panel.open({ url: origin + '/' });
    const busy = panel.view.webContents;
    await busy.executeJavaScript('setTimeout(()=>{while(true){}},0);true');
    await wait(50);
    const controller = new AbortController();
    const pendingSnapshot = panel.execute('browser_snapshot', {}, { signal: controller.signal });
    const abortTimer = setTimeout(() => controller.abort(new Error('Browser smoke Stop')), 80);
    await assert.rejects(pendingSnapshot, /Browser smoke Stop/); clearTimeout(abortTimer);
    await until('busy renderer destroyed after Stop', () => busy.isDestroyed());
    assert.equal(panel.state().exists, false);
    assert.ok(states.some(state => state.loading)); assert.ok(states.some(state => state.title === 'Browser fixture'));
    const ui = win ? await require('./smoke-browser-ui.cjs')({ win, output, dataDir }) : null;
    return { status: 'completed', realWebContentsView: true, localPreview: true, domActions: ['snapshot', 'click', 'type', 'scroll'], approvals: approvals.length, screenshot: { width: screenshot.width, height: screenshot.height }, isolation: true, downloadBlocked: true, projectReset: true, busyPageStop: true, ...(ui ? { ui } : {}) };
  } finally {
    panel?.destroy();
    if (!host.isDestroyed()) host.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
};
