import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createPluginRuntime, validatePluginCall, pluginResourceAllowed, PLUGIN_CHANNEL, PLUGIN_COMMAND_CHANNEL } = createRequire(import.meta.url)('../src/core/plugin-runtime.cjs');
let nextId = 0;
class Contents extends EventEmitter {
  constructor() { super(); this.id = ++nextId; this.mainFrame = {}; this.destroyed = false; this.messages = []; }
  isDestroyed() { return this.destroyed; }
  isOffscreen() { return true; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  send(...args) { this.messages.push(args); }
}
class Window extends EventEmitter {
  constructor(options = {}) { super(); this.id = ++nextId; this.options = options; this.webContents = new Contents(); this.destroyed = false; }
  isDestroyed() { return this.destroyed; }
  async loadFile(file) { this.file = file; }
  show() {}
  focus() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyCalls = (this.destroyCalls || 0) + 1;
    this.emit('closed'); // Match Electron: closed may precede isDestroyed().
    this.destroyed = true; this.webContents.destroyed = true;
  }
}
function fixture(t, overrides = {}) {
  const owner = new Window(), handlers = new Map(), sessions = [], listeners = new Set();
  let enabled = true, project = { root: path.resolve('tests/.tmp/project'), name: 'Project', workspaceId: 'workspace-1' };
  const entry = { root: path.resolve('tests/.tmp/plugin-demo'), enabled, manifest: { id: 'demo.hello', name: 'Demo', version: '1.0.0', entry: 'index.html',
    permissions: ['project.read', 'project.write', 'notifications'], commands: [{ id: 'hello', title: 'Hello' }] } };
  const manager = { get: async id => { assert.equal(id, 'demo.hello'); return { ...entry, enabled, manifest: structuredClone(entry.manifest) }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const session = { fromPartition(partition, options) {
    const current = new EventEmitter(); Object.assign(current, { partition, options, webRequest: {
      onBeforeRequest(handler) { current.before = handler; }, onHeadersReceived(handler) { current.headers = handler; } },
      setPermissionRequestHandler(handler) { current.permission = handler; }, setPermissionCheckHandler(handler) { current.check = handler; },
      setDevicePermissionHandler(handler) { current.device = handler; }, async clearStorageData() { current.cleared = true; current.clearCalls = (current.clearCalls || 0) + 1; } });
    sessions.push(current); return current;
  } };
  const calls = [];
  const runtime = createPluginRuntime({ BrowserWindow: Window, session, manager, ipcMain: {
    handle(channel, handler) { assert.ok(!handlers.has(channel)); handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    getOwnerWindow: () => owner, getProjectInfo: () => project,
    getAppInfo: () => ({ name: 'Cortex', version: '0.19.3', apiKey: 'SECRET' }),
    listFiles: async value => { calls.push(value); return [{ path: 'README.md', type: 'file', hidden: 'no' }]; },
    readText: async value => { calls.push(value); return { path: value.path, content: 'hello', version: 'sha123', apiKey: 'SECRET' }; },
    writeText: async value => { calls.push(value); return { path: value.path, content: value.content, version: 'sha456' }; },
    notify: async value => { calls.push(value); }, ...overrides });
  t.after(() => runtime.dispose());
  return { runtime, owner, entry, sessions, calls, handlers,
    setProject(value) { project = value; }, disable() { enabled = false; for (const listener of listeners) listener([{ id: entry.manifest.id, enabled: false }]); },
    async call(method, args = {}, customEvent = null) { const contents = runtime.windows()[0]?.window.webContents;
      return handlers.get(PLUGIN_CHANNEL)(customEvent ?? { sender: contents, senderFrame: contents?.mainFrame }, { method, args }); },
  };
}
test('plugin calls accept only bounded relative text operations and declared methods', () => {
  validatePluginCall('project.writeText', { path: 'src/a.js', content: 'new', expectedVersion: 'sha123' });
  for (const [method, args] of [['shell.run', {}], ['app.info', { key: true }], ['project.readText', { path: '../secret' }],
    ['project.readText', { path: 'C:/secret' }], ['project.writeText', { path: 'a', content: 'new' }],
    ['project.writeText', { path: 'a', content: 'new', expectedVersion: 'invalid hash' }], ['notify', { message: '' }]]) assert.throws(() => validatePluginCall(method, args));
});
test('plugin resource guard blocks network, sibling files, encoded traversal, frames and non-image data', () => {
  const root = path.resolve('tests/.tmp/plugin-demo');
  assert.equal(pluginResourceAllowed(root, pathToFileURL(path.join(root, 'index.html')).href, 'mainFrame'), true);
  assert.equal(pluginResourceAllowed(root, pathToFileURL(path.join(root, 'main.js')).href, 'script'), true);
  assert.equal(pluginResourceAllowed(root, 'data:image/png;base64,AAA', 'image'), true);
  for (const address of ['https://example.com', 'http://localhost:3000', 'ws://localhost:3000', pathToFileURL(path.resolve(root, '../secret.txt')).href,
    pathToFileURL(path.join(root, 'index.html')).href + '?x', 'data:text/html,<script>alert(1)</script>', 'javascript:alert(1)']) assert.equal(pluginResourceAllowed(root, address, 'script'), false);
});
test('plugin windows are sandboxed with independent sessions and no navigation, downloads or grants', async t => {
  const f = fixture(t); await f.runtime.open('demo.hello', 'hello', f.owner);
  const { window } = f.runtime.windows()[0], preferences = window.options.webPreferences, browserSession = f.sessions[0];
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false); assert.equal(preferences.webviewTag, false); assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.devTools, false); assert.match(preferences.preload, /plugin-preload\.cjs$/u); assert.equal(window.options.parent, f.owner);
  assert.match(browserSession.partition, /^synora-plugin-/u); assert.ok(!browserSession.partition.startsWith('persist:'));
  assert.deepEqual(window.webContents.openHandler(), { action: 'deny' }); assert.equal(browserSession.check(), false); assert.equal(browserSession.device(), false);
  let granted; browserSession.permission(null, 'media', value => { granted = value; }); assert.equal(granted, false);
  let cancelled; browserSession.before({ url: 'https://example.com', resourceType: 'fetch' }, value => { cancelled = value.cancel; }); assert.equal(cancelled, true);
  let policy; browserSession.headers({ responseHeaders: {} }, value => { policy = value.responseHeaders['Content-Security-Policy'][0]; }); assert.match(policy, /connect-src 'none'/u);
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false; window.webContents.emit(eventName, { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  let prevented = false, stopped = false; browserSession.emit('will-download', { preventDefault() { prevented = true; } }, { cancel() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.deepEqual(window.webContents.messages, [[PLUGIN_COMMAND_CHANNEL, { id: 'hello' }]]);
});
test('narrow APIs strip extra fields and bind file operations to the captured project', async t => {
  const f = fixture(t); await f.runtime.open('demo.hello');
  assert.deepEqual(await f.call('app.info'), { name: 'Cortex', version: '0.19.3', apiVersion: 1 });
  assert.deepEqual(await f.call('project.listFiles'), [{ path: 'README.md', type: 'file' }]);
  assert.deepEqual(await f.call('project.readText', { path: 'README.md' }), { path: 'README.md', content: 'hello', version: 'sha123' });
  assert.deepEqual(await f.call('project.writeText', { path: 'README.md', content: 'changed', expectedVersion: 'sha123' }), { path: 'README.md', content: 'changed', version: 'sha456' });
  assert.equal(f.calls.at(-1).project.workspaceId, 'workspace-1'); assert.equal(f.calls.at(-1).ownerWindow, f.owner); assert.ok(f.calls.at(-1).signal instanceof AbortSignal);
  assert.equal(JSON.stringify(await f.call('app.info')).includes('SECRET'), false);
  f.setProject({ root: path.resolve('tests/.tmp/other'), workspaceId: 'workspace-2' });
  const before = f.calls.length; await assert.rejects(f.call('project.readText', { path: 'README.md' }), /项目已变化/); assert.equal(f.calls.length, before);
});
test('subframes, another sender and missing manifest permissions cannot call host operations', async t => {
  const f = fixture(t); f.entry.manifest.permissions = []; await f.runtime.open('demo.hello');
  const contents = f.runtime.windows()[0].window.webContents;
  await assert.rejects(f.call('app.info', {}, { sender: contents, senderFrame: {} }), /来源无效/);
  await assert.rejects(f.call('app.info', {}, { sender: new Contents(), senderFrame: contents.mainFrame }), /来源无效/);
  await assert.rejects(f.call('project.readText', { path: 'README.md' }), /未申请/);
  await assert.rejects(f.call('notify', { message: 'hi' }), /未申请/); assert.equal(f.calls.length, 0);
});
test('disable aborts in-flight callbacks, closes windows and prevents late results or reopening', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let callbackSignal;
  const f = fixture(t, { readText: async value => { callbackSignal = value.signal; entered(); await gate; return { path: value.path, content: 'late', version: 'sha123' }; } });
  await f.runtime.open('demo.hello'); const window = f.runtime.windows()[0].window;
  const pending = f.call('project.readText', { path: 'README.md' }); await started; f.disable();
  assert.equal(callbackSignal.aborted, true); assert.equal(window.isDestroyed(), true); assert.deepEqual(f.runtime.windows(), []);
  release(); await assert.rejects(pending, /停用|关闭/); await assert.rejects(f.runtime.open('demo.hello'), /启用/);
});
test('owner-window closure destroys plugins and removes IPC on dispose', async t => {
  const f = fixture(t); await f.runtime.open('demo.hello'); const window = f.runtime.windows()[0].window;
  f.owner.destroy(); assert.equal(window.isDestroyed(), true); assert.deepEqual(f.runtime.windows(), []);
  f.runtime.dispose(); assert.equal(f.handlers.has(PLUGIN_CHANNEL), false); await assert.rejects(f.runtime.open('demo.hello'), /已关闭/);
});
test('each owner gets a distinct captured plugin window, and repeated commands reuse only that owner', async t => {
  const f = fixture(t), other = new Window(); await f.runtime.open('demo.hello', 'hello', f.owner); await f.runtime.open('demo.hello', 'hello', other);
  assert.equal(f.runtime.windows().length, 2); await f.runtime.open('demo.hello', 'hello', f.owner); assert.equal(f.runtime.windows().length, 2);
  assert.equal(f.runtime.windows().find(value => value.ownerWindow === f.owner).window.webContents.messages.length, 2);
  f.runtime.closeOwner(f.owner); assert.equal(f.runtime.windows().length, 1); assert.equal(f.runtime.windows()[0].ownerWindow, other);
  f.runtime.close('demo.hello'); assert.deepEqual(f.runtime.windows(), []);
});
test('explicit reopen after project switching aborts the old binding and creates a usable fresh window', async t => {
  const f = fixture(t); await f.runtime.open('demo.hello', 'hello', f.owner);
  const originalWindow = f.runtime.windows()[0].window;
  await f.call('project.readText', { path: 'README.md' }); const oldSignal = f.calls.at(-1).signal;
  f.setProject({ root: path.resolve('tests/.tmp/second-project'), name: 'Second', workspaceId: 'workspace-2' });
  await assert.rejects(f.call('project.readText', { path: 'README.md' }), /项目已变化/u);
  await f.runtime.open('demo.hello', 'hello', f.owner);
  assert.equal(originalWindow.isDestroyed(), true); assert.equal(oldSignal.aborted, true);
  assert.equal(f.runtime.windows().length, 1); assert.notEqual(f.runtime.windows()[0].window, originalWindow);
  await f.call('project.readText', { path: 'README.md' }); assert.equal(f.calls.at(-1).project.workspaceId, 'workspace-2');
  assert.equal(f.calls.at(-1).signal.aborted, false);
  assert.deepEqual(f.runtime.windows()[0].window.webContents.messages, [[PLUGIN_COMMAND_CHANNEL, { id: 'hello' }]]);
});
test('reentrant native closed events destroy a plugin window and clear its session exactly once', async t => {
  const f = fixture(t); await f.runtime.open('demo.hello', null, f.owner);
  const window = f.runtime.windows()[0].window, browserSession = f.sessions[0];
  f.runtime.close('demo.hello'); f.runtime.close('demo.hello'); f.runtime.closeOwner(f.owner); f.runtime.closeAll(); f.runtime.dispose();
  assert.equal(window.destroyCalls, 1); assert.equal(window.isDestroyed(), true); assert.equal(browserSession.clearCalls, 1);
  assert.deepEqual(f.runtime.windows(), []); assert.equal(f.owner.listenerCount('closed'), 0);
});
