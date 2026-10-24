const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { PLUGIN_LIMITS, isPluginRelativePath } = require('./plugin-manager.cjs');

const CHANNEL = 'synora-plugin:invoke';
const COMMAND_CHANNEL = 'synora-plugin:command';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const methods = new Set(['app.info', 'project.info', 'project.listFiles', 'project.readText', 'project.writeText', 'notify']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const invalid = () => { throw new Error('插件请求参数无效。'); };
const within = (root, target) => { const value = path.relative(root, target); return value && value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value); };
const string = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
function validatePluginCall(method, args) {
  if (!methods.has(method) || !plain(args)) invalid();
  const allowed = method === 'project.writeText' ? ['path', 'content', 'expectedVersion']
    : method === 'project.readText' || method === 'project.listFiles' ? ['path'] : method === 'notify' ? ['message'] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid();
  if (['project.readText', 'project.writeText'].includes(method) && !isPluginRelativePath(args.path)) invalid();
  if (method === 'project.listFiles' && args.path !== undefined && args.path !== '' && !isPluginRelativePath(args.path)) invalid();
  if (method === 'project.writeText' && (!string(args.content, PLUGIN_LIMITS.textBytes) || Buffer.byteLength(args.content) > PLUGIN_LIMITS.textBytes
      || !(args.expectedVersion === null || typeof args.expectedVersion === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(args.expectedVersion)))) invalid();
  if (method === 'notify' && (!string(args.message, 500) || !args.message.trim())) invalid();
  return args;
}

function pluginResourceAllowed(root, address, resourceType = 'other') {
  if (address === 'about:blank') return resourceType === 'mainFrame';
  if (address.startsWith('data:')) return resourceType === 'image';
  try { const url = new URL(address); return url.protocol === 'file:' && !url.hostname && !url.search && !url.hash && Boolean(within(root, fileURLToPath(url))); }
  catch { return false; }
}

function createPluginRuntime({ BrowserWindow, session, ipcMain, manager, getOwnerWindow = () => null,
  getAppInfo = () => ({ name: 'Synora code', version: '', apiVersion: 1 }), getProjectInfo = () => null,
  listFiles, readText, writeText, notify = () => {}, onError = () => {} } = {}) {
  if (typeof BrowserWindow !== 'function' || !session?.fromPartition || !ipcMain?.handle || !manager?.get
      || [getOwnerWindow, getAppInfo, getProjectInfo, notify, onError].some(value => typeof value !== 'function')) throw new Error('插件运行环境配置无效。');
  const panels = new Map(), senders = new Map(); let disposed = false;
  const safeError = error => {
    const message = error instanceof Error ? error.message : '';
    return new Error(message && !error.code && !/(?:[A-Za-z]:[\\/]|file:\/\/|api[_-]?key|access[_-]?token|refresh[_-]?token|Bearer\s)/iu.test(message)
      ? message.slice(0, 300) : '插件操作失败，请检查文件和当前项目后重试。');
  };
  const publicPlugin = manifest => ({ id: manifest.id, name: manifest.name, version: manifest.version, permissions: [...manifest.permissions] });
  const usable = record => !disposed && panels.get(record.key) === record && !record.controller.signal.aborted
    && record.ownerWindow && !record.ownerWindow.isDestroyed() && record.window && !record.window.isDestroyed() && !record.window.webContents.isDestroyed();
  const context = record => ({ plugin: publicPlugin(record.manifest), ownerWindow: record.ownerWindow, project: record.project ? { ...record.project } : null, signal: record.controller.signal });
  const closeRecord = record => {
    if (record.closed) return;
    record.closed = true;
    if (panels.get(record.key) === record) panels.delete(record.key);
    // Electron may emit `closed` from destroy() before isDestroyed() changes.
    // Detach the record first so reentrant events and abort callbacks are inert.
    const window = record.window, browserSession = record.session;
    record.window = null; record.session = null;
    if (record.senderId !== undefined) senders.delete(record.senderId);
    record.ownerWindow?.removeListener?.('closed', record.ownerClosed);
    record.controller.abort(new DOMException('插件窗口已关闭。', 'AbortError'));
    if (window && !window.isDestroyed()) window.destroy();
    try { Promise.resolve(browserSession?.clearStorageData()).catch(() => {}); } catch {}
  };
  const reconcile = plugins => {
    const enabled = new Set(plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id));
    for (const record of [...panels.values()]) if (!enabled.has(record.manifest.id)) closeRecord(record);
  };
  const unsubscribe = manager.subscribe(reconcile);
  async function check(record, project = false) {
    if (!usable(record)) throw new Error('插件已停用或窗口已关闭。');
    const latest = await manager.get(record.manifest.id);
    if (!usable(record) || !latest.enabled) throw new Error('插件已停用或窗口已关闭。');
    if (project) {
      const current = await getProjectInfo(context(record));
      if (!usable(record) || !record.project?.root || !current?.root || record.project.root !== current.root
          || record.project.workspaceId !== current.workspaceId) throw new Error('当前项目已变化，请重新打开插件窗口。');
    }
  }
  async function invoke(event, input) {
    const record = senders.get(event.sender?.id);
    if (!record || event.sender !== record.window?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('插件调用来源无效。');
    try {
      if (!plain(input) || Object.keys(input).some(key => !['method', 'args'].includes(key))) invalid();
      const args = validatePluginCall(input.method, input.args ?? {});
      if (record.pending >= 12) throw new Error('插件请求过于频繁，请稍后重试。');
      record.pending++;
      try {
        await check(record);
        const needs = input.method.startsWith('project.') && input.method !== 'project.info' ? input.method === 'project.writeText' ? 'project.write' : 'project.read' : input.method === 'notify' ? 'notifications' : null;
        if (needs && !record.manifest.permissions.includes(needs)) throw new Error('插件未申请此操作权限，请检查插件清单。');
        if (input.method.startsWith('project.')) await check(record, true);
        let result;
        if (input.method === 'app.info') {
          const value = await getAppInfo(context(record));
          result = { name: String(value?.name ?? 'Synora code').slice(0, 100), version: String(value?.version ?? '').slice(0, 64), apiVersion: 1 };
        } else if (input.method === 'project.info') result = { root: record.project.root, name: String(record.project.name ?? path.basename(record.project.root)).slice(0, 200) };
        else if (input.method === 'notify') { await notify({ ...context(record), message: args.message }); result = null; }
        else {
          const operation = input.method === 'project.listFiles' ? listFiles : input.method === 'project.readText' ? readText : writeText;
          if (typeof operation !== 'function') throw new Error('当前版本未提供此插件功能。');
          result = await operation({ ...context(record), ...args });
          if (input.method === 'project.listFiles') {
            if (!Array.isArray(result) || result.length > PLUGIN_LIMITS.listEntries || result.some(item => !plain(item) || !isPluginRelativePath(item.path) || !['file', 'directory'].includes(item.type))) throw new Error('插件文件列表返回值无效。');
            result = result.map(item => ({ path: item.path, type: item.type }));
          } else {
            if (!plain(result) || !isPluginRelativePath(result.path) || !string(result.content, PLUGIN_LIMITS.textBytes)
                || Buffer.byteLength(result.content) > PLUGIN_LIMITS.textBytes || !(result.version === null || typeof result.version === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(result.version))) throw new Error('插件文本文件返回值无效。');
            result = { path: result.path, content: result.content, version: result.version };
          }
        }
        await check(record, input.method.startsWith('project.')); return result;
      } finally { record.pending--; }
    } catch (error) { throw safeError(error); }
  }
  ipcMain.handle(CHANNEL, invoke);
  const open = async (id, commandId = null, ownerWindow = null) => {
    if (disposed) throw new Error('插件运行环境已关闭。');
    const item = await manager.get(id);
    if (!item.enabled) throw new Error('请先启用此插件。');
    if (commandId !== null && !item.manifest.commands.some(command => command.id === commandId)) throw new Error('插件命令不存在。');
    ownerWindow ??= getOwnerWindow();
    if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('请从软件窗口打开插件。');
    const key = `${id}:${ownerWindow.id}`;
    let record = panels.get(key);
    if (record) {
      await record.ready; await check(record);
      const currentProject = await getProjectInfo(context(record));
      if (record.project?.root !== currentProject?.root || record.project?.workspaceId !== currentProject?.workspaceId) {
        // Explicitly reopening after a project switch creates a fresh binding.
        // The old page and its pending callbacks cannot migrate to that project.
        closeRecord(record); record = null;
      }
    }
    if (!record) {
      record = { key, manifest: item.manifest, root: item.root, ownerWindow, project: null, controller: new AbortController(), pending: 0, window: null, ready: null };
      panels.set(key, record);
      record.ownerClosed = () => closeRecord(record); ownerWindow.once('closed', record.ownerClosed);
      record.ready = (async () => {
        record.project = await getProjectInfo(context(record));
        const latest = await manager.get(id);
        if (disposed || panels.get(key) !== record || record.controller.signal.aborted || ownerWindow.isDestroyed() || !latest.enabled) throw new Error('插件已停用或窗口已关闭。');
        const browserSession = record.session = session.fromPartition('synora-plugin-' + randomUUID(), { cache: false });
        browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        browserSession.setPermissionCheckHandler(() => false); browserSession.setDevicePermissionHandler(() => false);
        browserSession.on('will-download', (event, download) => { event.preventDefault(); download.cancel(); });
        browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !pluginResourceAllowed(item.root, details.url, details.resourceType) }));
        browserSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } }));
        const window = record.window = new BrowserWindow({ width: 820, height: 620, minWidth: 420, minHeight: 320, show: false, parent: ownerWindow,
          title: item.manifest.name + ' · Synora code 插件', autoHideMenuBar: true, backgroundColor: '#20252a',
          webPreferences: { preload: path.join(__dirname, 'plugin-preload.cjs'), session: browserSession, sandbox: true, contextIsolation: true,
            nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
            navigateOnDragDrop: false, spellcheck: false, devTools: false, disableDialogs: true, disableHtmlFullscreenWindowResize: true,
            ...(ownerWindow.webContents?.isOffscreen?.() ? { offscreen: true } : {}) } });
        const contents = window.webContents; record.senderId = contents.id; senders.set(record.senderId, record);
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) contents.on(name, event => event.preventDefault());
        contents.on('render-process-gone', () => { closeRecord(record); try { onError({ plugin: publicPlugin(item.manifest), ownerWindow, message: '插件窗口已退出，请重新打开。' }); } catch {} });
        window.once('closed', () => closeRecord(record));
        await window.loadFile(path.join(item.root, ...item.manifest.entry.split('/')));
        await check(record); if (!ownerWindow.webContents?.isOffscreen?.()) window.show(); return record;
      })().catch(error => { closeRecord(record); throw safeError(error); });
    }
    await record.ready; await check(record);
    if (commandId !== null) record.window.webContents.send(COMMAND_CHANNEL, { id: commandId });
    if (!ownerWindow.webContents?.isOffscreen?.()) { record.window.show(); record.window.focus(); }
    return { id, opened: true };
  };
  return {
    open,
    close(id) { for (const record of [...panels.values()]) if (record.manifest.id === id) closeRecord(record); },
    closeOwner(ownerWindow) { for (const record of [...panels.values()]) if (record.ownerWindow === ownerWindow) closeRecord(record); },
    closeAll() { for (const record of [...panels.values()]) closeRecord(record); },
    windows() { return [...panels.values()].filter(usable).map(record => ({ id: record.manifest.id, window: record.window, ownerWindow: record.ownerWindow })); },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); for (const record of [...panels.values()]) closeRecord(record); ipcMain.removeHandler(CHANNEL); },
  };
}

module.exports = { createPluginRuntime, validatePluginCall, pluginResourceAllowed, PLUGIN_CHANNEL: CHANNEL, PLUGIN_COMMAND_CHANNEL: COMMAND_CHANNEL };
