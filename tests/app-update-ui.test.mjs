import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/app-update.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'button', ownerDocument) {
    this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.open = false; this.showCalls = 0;
    this.hidden = false; this.disabled = false; this.attributes = {}; this.dataset = {}; this.textContent = ''; this.listeners = new Map();
  }
  set id(value) { this._id = value; this.ownerDocument?.elements.set(value, this); }
  get id() { return this._id; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; }
  append(...nodes) { this.children.push(...nodes); }
  showModal() { this.open = true; this.showCalls++; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  click() { return this.listeners.get('click')?.(); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
}
const initial = { status: 'idle', enabled: true, currentVersion: '0.18.2', version: '', progress: 0 };
function fixture(methods = {}, initialValue = initial) {
  const document = { elements: new Map(), createElement(tag) { return new Element(tag, document); } };
  document.body = new Element('body', document);
  const context = vm.createContext({ document }); vm.runInContext(source, context);
  const button = new Element('button', document), label = new Element(), progress = new Element(), ring = new Element(), notices = [], calls = [];
  button.querySelector = selector => selector === '.app-update-ring-value' ? ring : null;
  let callback, busy = false, unsubscribed = false, currentNotice = null;
  const showNotice = (...args) => {
    notices.push(args); currentNotice = args;
    return () => { if (currentNotice === args) currentNotice = null; };
  };
  const bridge = { onEvent: listener => { callback = listener; return () => { unsubscribed = true; }; } };
  for (const method of ['getAppUpdate', 'checkAppUpdate', 'downloadAppUpdate', 'installAppUpdate']) {
    bridge[method] = (...args) => { calls.push({ method, args }); return methods[method]?.(...args) ?? initialValue; };
  }
  const ui = context.ForgeAppUpdate.create({ bridge, button, label, progress, notice: showNotice, isBusy: () => busy });
  return { ui, button, label, progress, ring, notices, calls, node: id => document.elements.get(id),
    emit: update => callback({ type: 'app-update', update, workspaceId: 'another-project' }),
    emitOther: event => callback(event),
    setBusy(value) { busy = value; ui.sync(); },
    noticeOther: showNotice, get currentNotice() { return currentNotice; }, get unsubscribed() { return unsubscribed; },
  };
}

test('startup reads state without checking, opening a page or downloading and global events control visibility', async () => {
  const f = fixture(); await f.ui.ready;
  assert.equal(f.button.hidden, true); assert.deepEqual(f.calls.map(call => call.method), ['getAppUpdate']);
  assert.equal(f.notices.length, 0);
  f.emit({ ...initial, status: 'checking' }); assert.equal(f.button.hidden, true);
  f.emit({ ...initial, status: 'error', error: '暂时离线' }); assert.equal(f.button.hidden, true, 'An automatic check failure does not imply a new release exists');
  f.emit({ ...initial, status: 'current' }); assert.equal(f.button.hidden, true);
  f.emit({ ...initial, status: 'available', version: '0.18.3' });
  assert.equal(f.button.hidden, false); assert.equal(f.button.disabled, false); assert.match(f.button.title, /0\.18\.3/u);
  f.emitOther({ type: 'state', update: { ...initial, status: 'current' } });
  assert.equal(f.button.hidden, false, 'Project state cannot hide a global app update');
  f.emit({ ...initial, enabled: false, status: 'available', version: '0.18.3' });
  assert.equal(f.button.hidden, true); await f.button.click();
  assert.equal(f.calls.length, 1, 'Portable and development builds cannot download or install through the hidden control');
});

test('download progress and a second explicit click drive download then install using argument-free bridge methods', async () => {
  const download = deferred(), install = deferred();
  const f = fixture({ downloadAppUpdate: () => download.promise, installAppUpdate: () => install.promise }); await f.ui.ready;
  f.emit({ ...initial, status: 'available', version: '0.18.3' });
  const downloading = f.button.click();
  assert.equal(f.button.disabled, false); await f.button.click();
  assert.equal(f.calls.filter(call => call.method === 'downloadAppUpdate').length, 1);
  f.emit({ ...initial, status: 'downloading', version: '0.18.3', progress: 37.8 });
  assert.match(f.label.textContent, /37%/u); assert.equal(f.progress.value, 37); assert.equal(f.progress.hidden, false);
  assert.equal(f.ring.attributes['stroke-dashoffset'], '63');
  assert.equal(f.button.attributes['aria-label'], '下载更新 37%');
  assert.equal(f.progress.attributes['aria-valuenow'], '37');
  assert.equal(f.button.attributes['aria-busy'], 'true');
  f.emit({ ...initial, status: 'downloaded', version: '0.18.3', progress: 100 });
  download.resolve({ ...initial, status: 'downloading', version: '0.18.3', progress: 0 }); await downloading;
  assert.equal(f.button.dataset.status, 'downloaded', 'A late IPC result cannot rewind newer progress events');
  assert.equal(f.label.textContent, '重启更新'); assert.equal(f.progress.hidden, true); assert.equal(f.button.disabled, false);
  assert.equal(f.ring.attributes['stroke-dashoffset'], '0');
  assert.equal(f.calls.filter(call => call.method === 'installAppUpdate').length, 0, 'Finishing the download never starts installation automatically');
  const installing = f.button.click();
  f.emit({ ...initial, status: 'installing', version: '0.18.3' });
  assert.equal(f.button.disabled, true); assert.equal(f.label.textContent, '正在重启…');
  install.resolve({ ...initial, status: 'installing', version: '0.18.3' }); await installing;
  assert.deepEqual(f.calls.map(call => call.method), ['getAppUpdate', 'downloadAppUpdate', 'installAppUpdate']);
  assert.ok(f.calls.every(call => call.args.length === 0), 'The renderer sends no URL, path or installation arguments');
});

test('help check reports current, available, failed and unsupported states without downloading', async () => {
  for (const [result, message] of [
    [{ ...initial, status: 'current' }, /当前已是最新版本 v0\.18\.2/u],
    [{ ...initial, status: 'available', version: '0.18.3' }, /发现新版本 v0\.18\.3/u],
    [{ ...initial, status: 'error', error: '网络暂不可用' }, /检查更新失败：网络暂不可用/u],
    [{ ...initial, enabled: false }, /此版本请从 GitHub Releases 下载新版；安装版支持应用内更新/u],
  ]) {
    const f = fixture({ checkAppUpdate: () => result }); await f.ui.ready;
    await f.ui.check();
    assert.match(f.notices.at(-1)[0], message);
    assert.deepEqual(f.calls.map(call => call.method), ['getAppUpdate', 'checkAppUpdate']);
  }
});

test('failed downloads retry from the title bar while failed version checks remain hidden and retry through Help', async () => {
  const f = fixture({ downloadAppUpdate: () => ({ ...initial, status: 'downloaded', version: '0.18.3' }),
    checkAppUpdate: () => ({ ...initial, status: 'current' }) }); await f.ui.ready;
  f.emit({ ...initial, status: 'error', version: '0.18.3', error: '下载中断' });
  assert.equal(f.button.hidden, false); assert.equal(f.label.textContent, '更新失败 · 重试');
  await f.button.click(); assert.equal(f.button.dataset.status, 'downloaded');
  f.emit({ ...initial, status: 'error', error: '暂时离线' });
  assert.equal(f.button.hidden, true); await f.button.click();
  assert.equal(f.calls.length, 2, 'A hidden title-bar control cannot initiate a retry');
  await f.ui.check();
  assert.equal(f.button.hidden, true);
  assert.deepEqual(f.calls.map(call => call.method), ['getAppUpdate', 'downloadAppUpdate', 'checkAppUpdate']);
});

test('busy work blocks installation and an installation failure retains a usable restart retry', async () => {
  let attempts = 0;
  const f = fixture({ installAppUpdate: () => { if (++attempts === 1) throw new Error('无法启动安装程序'); return { ...initial, status: 'installing', version: '0.18.3' }; } });
  await f.ui.ready; f.emit({ ...initial, status: 'downloaded', version: '0.18.3' });
  f.setBusy(true); assert.equal(f.button.disabled, true); assert.match(f.label.textContent, /任务结束/u);
  await f.button.click(); assert.equal(attempts, 0);
  f.setBusy(false); await f.button.click();
  assert.equal(attempts, 1); assert.equal(f.button.disabled, false); assert.equal(f.label.textContent, '重启更新');
  assert.match(f.notices.at(-1)[0], /无法启动安装程序/u);
  await f.button.click(); assert.equal(attempts, 2); assert.equal(f.button.dataset.status, 'installing');
});

test('initial read cannot hide a newer update event and disposed controls stop applying updates', async () => {
  const read = deferred(), f = fixture({ getAppUpdate: () => read.promise });
  f.emit({ ...initial, status: 'available', version: '0.18.3' });
  read.resolve(initial); await f.ui.ready;
  assert.equal(f.button.hidden, false); assert.match(f.button.title, /0\.18\.3/u);
  f.ui.destroy(); f.emit({ ...initial, status: 'current' });
  assert.equal(f.button.hidden, false); assert.equal(f.unsubscribed, true);
  await f.button.click(); assert.equal(f.calls.length, 1);
});

test('preload update methods discard caller-supplied paths and URLs at the IPC boundary', async () => {
  const preload = await fs.readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), calls = [];
  let exposed;
  const context = vm.createContext({ require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (key, api) => { assert.equal(key, 'forge'); exposed = api; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } };
  } });
  vm.runInContext(preload, context);
  for (const method of ['getAppUpdate', 'checkAppUpdate', 'downloadAppUpdate', 'installAppUpdate']) {
    await exposed[method]({ url: 'https://untrusted.example/installer.exe', path: 'C:\\arbitrary.exe' });
    assert.deepEqual(calls.at(-1), [`forge:${method}`, undefined]);
  }
});

test('download errors stay readable while retry and completion use dialog progress without duplicate notices', async () => {
  const retry = deferred(); let attempts = 0;
  const f = fixture({ downloadAppUpdate: () => {
    if (++attempts === 1) throw new Error("Error invoking remote method 'forge:downloadAppUpdate': Error: 下载中断，请重试。");
    return retry.promise;
  } });
  await f.ui.ready; f.emit({ ...initial, status: 'available', version: '0.18.3' });
  await f.button.click();
  assert.equal(f.notices.at(-1)[0], '下载更新失败：下载中断，请重试。'); assert.equal(f.notices.at(-1)[1], true);
  assert.ok(f.currentNotice);
  f.emit({ ...initial, status: 'error', version: '0.18.3', error: '下载中断，请重试。' });
  const noticeCount = f.notices.length;
  const downloading = f.button.click();
  assert.equal(f.notices.length, noticeCount);
  assert.equal(f.currentNotice, null, 'Retry dismisses only its own stale update error');
  assert.equal(f.node('app-update-dialog-error').hidden, true);
  retry.resolve({ ...initial, status: 'downloaded', version: '0.18.3', progress: 100 }); await downloading;
  assert.equal(f.notices.length, noticeCount);
  assert.equal(f.label.textContent, '重启更新');
});

test('clicking download opens a modal whose progress stays live while hidden and can be reopened without restarting download', async () => {
  const download = deferred(), f = fixture({ downloadAppUpdate: () => download.promise });
  await f.ui.ready;
  const dialog = f.node('app-update-dialog');
  assert.equal(dialog.open, false);
  f.emit({ ...initial, status: 'available', version: '0.19.3', totalBytes: 8 * 1024 * 1024 });
  assert.equal(dialog.open, false, 'Automatic discovery never opens a modal');
  const downloading = f.button.click();
  assert.equal(dialog.open, true); assert.equal(dialog.showCalls, 1);
  assert.equal(f.node('app-update-dialog-primary').disabled, true);
  f.emit({ ...initial, status: 'downloading', version: '0.19.3', progress: 25, downloadedBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
  assert.equal(f.node('app-update-dialog-title').textContent, '正在下载更新');
  assert.equal(f.node('app-update-dialog-status').hidden, true);
  assert.equal(f.node('app-update-dialog-status').textContent, '');
  assert.equal(f.node('app-update-dialog-percent').textContent, '25%');
  assert.equal(f.node('app-update-dialog-progress').attributes['aria-valuenow'], '25');
  assert.equal(f.node('app-update-dialog-progress').attributes.role, 'progressbar');
  assert.equal(f.node('app-update-dialog-percent').attributes['aria-live'], 'polite');
  assert.equal(f.node('app-update-dialog-bytes').textContent, '已下载 2 MB / 总大小 8 MB');
  await f.node('app-update-dialog-background').click();
  assert.equal(dialog.open, false);
  f.emit({ ...initial, status: 'downloading', version: '0.19.3', progress: 50, downloadedBytes: 4 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
  assert.equal(dialog.open, false); assert.equal(f.ring.attributes['stroke-dashoffset'], '50');
  assert.equal(f.node('app-update-dialog-bytes').textContent, '已下载 4 MB / 总大小 8 MB');
  await f.button.click(); assert.equal(dialog.open, true); assert.equal(dialog.showCalls, 2);
  assert.equal(f.calls.filter(call => call.method === 'downloadAppUpdate').length, 1);
  let prevented = false;
  dialog.listeners.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(dialog.open, false);
  f.emit({ ...initial, status: 'downloaded', version: '0.19.3', progress: 100, downloadedBytes: 8 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
  download.resolve({ ...initial, status: 'available', version: '0.19.3' }); await downloading;
  assert.equal(dialog.open, false, 'Finishing a background download does not reopen it');
  assert.equal(f.node('app-update-dialog-title').textContent, '更新已准备就绪');
  assert.equal(f.node('app-update-dialog-status').hidden, true);
  assert.equal(f.node('app-update-dialog-status').textContent, '');
  assert.equal(f.node('app-update-dialog-primary').textContent, '重启更新');
  assert.equal(f.calls.filter(call => call.method === 'installAppUpdate').length, 0);
});

test('the dialog restart action respects busy protection, prevents duplicate installs and recovers after failure', async () => {
  const install = deferred(); let attempts = 0;
  const f = fixture({ downloadAppUpdate: () => ({ ...initial, status: 'downloaded', version: '0.19.3', progress: 100 }),
    installAppUpdate: () => { attempts++; return attempts === 1 ? Promise.reject(new Error("Error invoking remote method 'forge:installAppUpdate': Error: 安装程序暂不可用")) : install.promise; } });
  await f.ui.ready; f.emit({ ...initial, status: 'available', version: '0.19.3' }); await f.button.click();
  const primary = f.node('app-update-dialog-primary');
  f.setBusy(true); assert.equal(primary.disabled, true); await primary.click(); assert.equal(attempts, 0);
  assert.equal(f.node('app-update-dialog-status').hidden, false);
  assert.match(f.node('app-update-dialog-status').textContent, /请等待当前任务/u);
  assert.equal(f.node('app-update-dialog').attributes['aria-describedby'], 'app-update-dialog-status');
  f.setBusy(false); await primary.click();
  assert.equal(f.node('app-update-dialog-status').hidden, true);
  assert.equal(f.node('app-update-dialog').attributes['aria-describedby'], undefined);
  assert.equal(attempts, 1); assert.equal(primary.disabled, false); assert.equal(primary.textContent, '重启更新');
  assert.equal(f.node('app-update-dialog-error').textContent, '安装程序暂不可用');
  const installing = primary.click(); await primary.click();
  assert.equal(attempts, 2); assert.equal(primary.disabled, true);
  assert.equal(f.node('app-update-dialog-error').hidden, true);
  install.resolve({ ...initial, status: 'installing', version: '0.19.3' }); await installing;
  assert.equal(f.node('app-update-dialog').dataset.status, 'installing');
});

test('dialog download errors stay readable and retry through the same guarded download method', async () => {
  let attempts = 0;
  const retry = deferred(), f = fixture({ downloadAppUpdate: () => {
    attempts++; if (attempts === 1) throw new Error("Error invoking remote method 'forge:downloadAppUpdate': Error: 网络连接中断");
    return retry.promise;
  } });
  await f.ui.ready; f.emit({ ...initial, status: 'available', version: '0.19.3' }); await f.button.click();
  assert.equal(f.node('app-update-dialog-error').textContent, '网络连接中断');
  const primary = f.node('app-update-dialog-primary');
  assert.equal(primary.textContent, '重试下载'); assert.equal(primary.disabled, false);
  f.noticeOther('下载更新失败：网络连接中断', true);
  const otherNotice = f.currentNotice;
  const retrying = primary.click(); await primary.click();
  assert.equal(attempts, 2); assert.equal(f.node('app-update-dialog-error').hidden, true);
  assert.equal(f.currentNotice, otherNotice, 'Retry cannot dismiss a later notification, even one with identical text');
  retry.resolve({ ...initial, status: 'downloaded', version: '0.19.3', progress: 100 }); await retrying;
  assert.equal(primary.textContent, '重启更新');
  const dialog = f.node('app-update-dialog'); f.ui.destroy();
  assert.equal(dialog.open, false); assert.equal(dialog.removed, true);
});

test('dialog progress uses percentages or byte ratios and becomes indeterminate only when neither is available', async () => {
  const f = fixture(); await f.ui.ready;
  const progress = f.node('app-update-dialog-progress');
  f.emit({ enabled: true, status: 'downloading', version: '0.19.3', downloadedBytes: 512 });
  assert.equal(progress.attributes['aria-valuenow'], undefined);
  assert.equal(progress.value, undefined);
  assert.equal(f.node('app-update-dialog-bytes').textContent, '已下载 0.5 KB · 总大小未知');
  f.emit({ enabled: true, status: 'downloading', version: '0.19.3', progress: 37 });
  assert.equal(progress.attributes['aria-valuenow'], '37');
  f.emit({ enabled: true, status: 'downloading', version: '0.19.3', downloadedBytes: 2048, totalBytes: 4096 });
  assert.equal(progress.attributes['aria-valuenow'], '50');
  assert.equal(f.node('app-update-dialog-percent').textContent, '50%');
  f.emit({ enabled: true, status: 'downloading', version: '0.19.3', progress: -50, downloadedBytes: -1, totalBytes: '4096' });
  assert.equal(progress.attributes['aria-valuenow'], '0');
  assert.equal(f.node('app-update-dialog-bytes').textContent, '已下载 0 KB · 总大小未知');
});

test('byte sizes use 1024-based KB, MB and GB without displaying bytes or non-finite values', async () => {
  const f = fixture(); await f.ui.ready;
  for (const [bytes, formatted] of [[0, '0 KB'], [1, '0.001 KB'], [1023, '0.999 KB'], [1024, '1 KB'],
    [1536, '1.5 KB'], [1024 ** 2, '1 MB'], [1.5 * 1024 ** 2, '1.5 MB'], [1024 ** 3, '1 GB']]) {
    f.emit({ ...initial, status: 'downloading', version: '0.19.3', downloadedBytes: bytes, totalBytes: 1024 ** 3 });
    assert.equal(f.node('app-update-dialog-bytes').textContent, `已下载 ${formatted} / 总大小 1 GB`);
  }
  f.emit({ ...initial, status: 'downloading', version: '0.19.3', downloadedBytes: Infinity, totalBytes: NaN });
  assert.equal(f.node('app-update-dialog-bytes').textContent, '已下载 0 KB · 总大小未知');
});
