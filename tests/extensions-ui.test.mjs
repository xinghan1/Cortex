import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/extensions.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag, document) {
    this.tag = tag; this.document = document; this.children = []; this.listeners = new Map(); this.attributes = {};
    this.dataset = {}; this.hidden = false; this.disabled = false; this.open = false; this.checked = false; this.textContent = ''; this.value = '';
  }
  set id(value) { this._id = value; if (value) this.document.elements.set(value, this); }
  get id() { return this._id; }
  set innerHTML(_) { throw new Error('Plugin data must never be parsed as HTML'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  scrollIntoView() { this.scrolled = true; }
  click() { return !this.disabled && this.listeners.get('click')?.(); }
  emit(type) { return !this.disabled && this.listeners.get(type)?.(); }
  get text() { return this.textContent + this.children.map(node => node.text).join(' '); }
}
function deferred() { let resolve, reject; const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; }); return { promise, resolve, reject }; }
const petState = overrides => ({ enabled: true, size: 220, x: 1, y: 1, workStatus: true, packId: 'dsh-pet',
  packs: [{ id: 'dsh-pet', name: '帝师猴', license: 'GPL-3.0', animations: {} }], ...overrides });
const plugin = overrides => ({ id: 'hello-plugin', name: '示例 <script>', version: '1.0.0', description: '<img src=x onerror=alert(1)>',
  enabled: false, permissions: ['project.read', 'notifications'], commands: [{ id: 'hello', title: '检查项目' }], ...overrides });
const state = overrides => ({ plugins: [plugin()], pet: petState(), ...overrides });
function fixture(methods = {}, initial = state(), pet) {
  const document = { elements: new Map(), createElement(tag) { return new Element(tag, document); } }; document.body = new Element('body', document);
  const context = vm.createContext({ document }); vm.runInContext(source, context);
  const calls = [], notices = []; const subscribers = new Set();
  const bridge = { onEvent(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } };
  for (const name of ['getExtensions', 'installExtension', 'setExtensionEnabled', 'removeExtension', 'openExtension', 'runExtensionCommand', 'createExtensionExample', 'openExtensionGuide', 'petImport', 'setPet']) {
    bridge[name] = (...args) => { calls.push([name, plain(args)]); return methods[name] ? methods[name](...args) : initial; };
  }
  const ui = context.ForgeExtensions.create({ document, bridge, pet, notice: (...args) => notices.push(args) });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  return { ui, calls, notices, subscribers, node: id => document.elements.get(id),
    action: (name, id = 'hello-plugin') => find(document.elements.get('extensions-list'), item => item.dataset.action === name && find(document.elements.get('extensions-list'), row => row.dataset.extensionId === id)?.children.some(child => find(child, value => value === item))),
    command: id => find(document.elements.get('extensions-list'), item => item.dataset.command === id),
    emit: event => { for (const subscriber of subscribers) subscriber(event); },
    text: () => document.body.text,
  };
}

test('local plugin manager reads state without enabling code and treats plugin labels as text', async () => {
  const f = fixture(); await f.ui.ready;
  assert.deepEqual(f.calls, [['getExtensions', []]]);
  assert.equal(f.node('extensions-dialog').open, false);
  f.ui.open(); assert.equal(f.node('extensions-dialog').open, true);
  assert.match(f.text(), /示例 <script>/u); assert.match(f.text(), /<img src=x onerror=alert\(1\)>/u);
  assert.match(f.text(), /读取项目文件、显示通知/u); assert.match(f.text(), /未启用/u);
  assert.equal(f.action('open').disabled, true); assert.equal(f.command('hello').disabled, true);
});

test('install delegates to a native picker without accepting a path and locks duplicate mutations', async () => {
  const result = deferred(), f = fixture({ installExtension: () => result.promise }, state({ plugins: [] })); await f.ui.ready;
  const installing = f.node('extensions-install').click(); await f.node('extensions-install').click();
  assert.equal(f.node('extensions-install').disabled, true);
  assert.deepEqual(f.calls, [['getExtensions', []], ['installExtension', []]]);
  result.resolve(state()); await installing;
  assert.match(f.node('extensions-status').textContent, /安装.*启用/u); assert.equal(f.command('hello').disabled, true);
  assert.equal(f.calls.some(([name]) => name === 'setExtensionEnabled'), false);
});

test('enable, open and commands use only declared plugin identities and are available after explicit enable', async () => {
  const enabled = state({ plugins: [plugin({ enabled: true })] });
  const f = fixture({ setExtensionEnabled: () => enabled, openExtension: () => null, runExtensionCommand: () => null }); await f.ui.ready;
  await f.action('enable').click(); assert.equal(f.command('hello').disabled, false);
  await f.action('open').click(); await f.command('hello').click();
  assert.deepEqual(f.calls.slice(1), [
    ['setExtensionEnabled', [{ id: 'hello-plugin', enabled: true }]], ['openExtension', [{ id: 'hello-plugin' }]],
    ['runExtensionCommand', [{ id: 'hello-plugin', command: 'hello' }]],
  ]);
});

test('removing a plugin needs its own explicit confirmation and retains the original folder explanation', async () => {
  const f = fixture({ removeExtension: () => state({ plugins: [] }) }); await f.ui.ready;
  await f.action('remove').click();
  assert.equal(f.calls.length, 1); assert.match(f.text(), /原始文件夹不受影响/u);
  await f.action('cancel-remove').click(); assert.equal(f.action('confirm-remove'), undefined);
  await f.action('remove').click(); await f.action('confirm-remove').click();
  assert.deepEqual(f.calls.at(-1), ['removeExtension', [{ id: 'hello-plugin' }]]);
  assert.match(f.node('extensions-empty').textContent, /尚未安装/u);
});

test('new global plugin events supersede old reads and pet-only events do not discard the plugin list', async () => {
  const read = deferred(), f = fixture({ getExtensions: () => read.promise });
  f.emit({ type: 'extensions', extensions: state({ plugins: [plugin({ enabled: true })] }) });
  read.resolve(state()); await f.ui.ready; assert.equal(f.command('hello').disabled, false);
  const otherRead = deferred(), other = fixture({ getExtensions: () => otherRead.promise });
  other.emit({ type: 'pet-state', pet: petState({ size: 400 }) });
  otherRead.resolve(state()); await other.ui.ready;
  assert.match(other.text(), /示例/u); assert.equal(other.node('extensions-pet-size').value, '400');
});

test('developer example and guide use native actions and never implicitly install or enable a plugin', async () => {
  const f = fixture({ createExtensionExample: () => ({ path: 'D:\\开发\\hello-plugin' }), openExtensionGuide: () => true }); await f.ui.ready;
  await f.node('extensions-example').click(); await f.node('extensions-guide').click();
  assert.deepEqual(f.calls.slice(1), [['createExtensionExample', []], ['openExtensionGuide', []]]);
  assert.match(f.notices[0][0], /D:\\开发\\hello-plugin/u);
  assert.equal(f.calls.some(([name]) => name === 'installExtension'), false);
});

test('pet settings persist explicit changes, commit range only on change and import with a native picker', async () => {
  const changes = [], f = fixture({ setPet: patch => { changes.push(plain(patch)); return petState(patch); }, petImport: () => petState({ packId: 'imported', packs: [{ id: 'imported', name: '新宠物' }] }) }); await f.ui.ready;
  f.ui.open({ section: 'pet' }); assert.equal(f.node('extensions-pet-section').scrolled, true);
  f.node('extensions-pet-enabled').checked = false; await f.node('extensions-pet-enabled').emit('change');
  f.node('extensions-pet-work').checked = false; await f.node('extensions-pet-work').emit('change');
  f.node('extensions-pet-size').value = '300'; await f.node('extensions-pet-size').emit('input');
  assert.equal(changes.length, 2); assert.equal(f.node('extensions-pet-size-value').textContent, '300 px');
  await f.node('extensions-pet-size').emit('change');
  assert.deepEqual(changes, [{ enabled: false }, { workStatus: false }, { size: 300 }]);
  await f.node('extensions-pet-import').click(); assert.deepEqual(f.calls.at(-1), ['petImport', []]);
  assert.equal(f.node('extensions-pet-pack').value, 'imported');
});

test('failed mutations leave the plugin state usable and disposing ignores in-flight results and unsubscribes', async () => {
  const f = fixture({ setExtensionEnabled: () => { throw new Error("Error invoking remote method 'forge:setExtensionEnabled': Error: 保存失败"); } }); await f.ui.ready;
  await f.action('enable').click();
  assert.equal(f.node('extensions-error').textContent, '保存失败'); assert.equal(f.node('extensions-error').hidden, false);
  assert.equal(f.command('hello').disabled, true); assert.equal(f.action('enable').disabled, false);
  const result = deferred(), late = fixture({ installExtension: () => result.promise }); await late.ui.ready;
  const installing = late.node('extensions-install').click(); late.ui.destroy();
  assert.equal(late.subscribers.size, 0); assert.equal(late.node('extensions-dialog').removed, true);
  result.resolve(state({ plugins: [] })); await installing;
  assert.match(late.text(), /示例/u);
});

test('a damaged plugin registry remains visibly read-only across reopening and pet changes until a valid snapshot clears it', async () => {
  const message = '插件列表文件已损坏，已保留原文件。插件管理暂为只读，请修复后重启。';
  const f = fixture({ setPet: patch => petState(patch) }, state({ plugins: [], pluginError: message })); await f.ui.ready;
  assert.equal(f.node('extensions-error').hidden, false);
  assert.equal(f.node('extensions-error').textContent, message);
  assert.equal(f.node('extensions-pet-section').hidden, false);
  assert.equal(f.node('extensions-pet-enabled').disabled, false, 'Broken plugin storage does not block pet settings');
  f.ui.open(); await f.node('extensions-close').click(); f.ui.open({ section: 'pet' });
  assert.equal(f.node('extensions-error').textContent, message);
  f.node('extensions-pet-enabled').checked = false; await f.node('extensions-pet-enabled').emit('change');
  assert.equal(f.node('extensions-error').textContent, message);
  assert.equal(f.node('extensions-error').hidden, false);
  f.ui.update({ plugins: [], pet: petState(), pluginError: null });
  assert.equal(f.node('extensions-error').hidden, true); assert.equal(f.node('extensions-error').textContent, '');
});
