import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/pet-settings.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag, document) { this.tag = tag; this.document = document; this.children = []; this.listeners = new Map(); this.attributes = {}; this.hidden = false; this.disabled = false; this.open = false; this.checked = false; this.textContent = ''; this.value = ''; }
  set id(value) { this._id = value; if (value) this.document.elements.set(value, this); }
  get id() { return this._id; }
  set innerHTML(_) { throw new Error('Pet labels must never be parsed as HTML'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  click() { return !this.disabled && this.listeners.get('click')?.(); }
  emit(type) { return !this.disabled && this.listeners.get(type)?.(); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; }); return { promise, resolve, reject }; };
const state = overrides => ({ enabled: true, size: 220, x: 1, y: 1, workStatus: true, followCursor: true, packId: 'dsh-pet',
  packs: [{ id: 'dsh-pet', name: '帝师猴 <script>', license: 'GPL-3.0', animations: {} }], ...overrides });
function fixture(methods = {}, initial = state(), pet) {
  const document = { elements: new Map(), createElement(tag) { return new Element(tag, document); } }; document.body = new Element('body', document);
  const context = vm.createContext({ document }); vm.runInContext(source, context);
  const calls = [], notices = [], events = new Set(); let current = initial;
  const bridge = { onEvent(listener) { events.add(listener); return () => events.delete(listener); },
    petState(...args) { calls.push(['petState', plain(args)]); return methods.petState ? methods.petState() : current; },
    setPet(patch) { calls.push(['setPet', plain(patch)]); if (methods.setPet) return methods.setPet(patch); current = { ...current, ...patch }; return current; },
    petImport(...args) { calls.push(['petImport', plain(args)]); return methods.petImport ? methods.petImport() : current; },
  };
  const ui = context.ForgePetSettings.create({ document, bridge, pet, notice: (...args) => notices.push(args) });
  return { ui, calls, notices, events, node: id => document.elements.get(id), emit: event => { for (const listener of events) listener(event); } };
}

test('pet settings create their own dialog and read only the independent pet bridge', async () => {
  const f = fixture(); await f.ui.ready;
  assert.deepEqual(f.calls, [['petState', []]]);
  assert.equal(f.node('pet-settings-dialog').open, false); assert.equal(f.node('extensions-dialog'), undefined);
  assert.equal(f.node('pet-settings-title').textContent, '宠物');
  assert.equal(f.node('pet-settings-pack').children[0].textContent, '帝师猴 <script>');
  f.ui.open(); assert.equal(f.node('pet-settings-dialog').open, true);
  f.node('pet-settings-close').click(); assert.equal(f.node('pet-settings-dialog').open, false);
});

test('pet switches, mouse tracking and size persist independently while range input commits only on change', async () => {
  const f = fixture(); await f.ui.ready;
  f.node('pet-settings-enabled').checked = false; await f.node('pet-settings-enabled').emit('change');
  f.node('pet-settings-work').checked = false; await f.node('pet-settings-work').emit('change');
  f.node('pet-settings-follow').checked = false; await f.node('pet-settings-follow').emit('change');
  f.node('pet-settings-size').value = '300'; await f.node('pet-settings-size').emit('input');
  assert.equal(f.calls.length, 4); assert.equal(f.node('pet-settings-size-value').textContent, '300 px');
  await f.node('pet-settings-size').emit('change'); await f.node('pet-settings-reset').click();
  assert.deepEqual(f.calls.slice(1), [['setPet', { enabled: false }], ['setPet', { workStatus: false }], ['setPet', { followCursor: false }], ['setPet', { size: 300 }], ['setPet', { x: 1, y: 1 }]]);
});

test('old settings default mouse tracking on and packs without eye positioning cannot enable the unsupported control', async () => {
  const old = state(); delete old.followCursor;
  const f = fixture({}, old); await f.ui.ready;
  assert.equal(f.node('pet-settings-follow').checked, true); assert.equal(f.node('pet-settings-follow').disabled, false);
  f.emit({ type: 'pet-state', pet: state({ packId: 'custom', packs: [{ id: 'custom', name: '其他宠物' }] }) });
  assert.equal(f.node('pet-settings-follow').disabled, true); assert.equal(f.node('pet-settings-follow').title, '此宠物包未提供眼睛定位');
  f.emit({ type: 'pet-state', pet: state({ followCursor: false }) });
  assert.equal(f.node('pet-settings-follow').disabled, false); assert.equal(f.node('pet-settings-follow').checked, false);
});

test('native import takes no renderer path, prevents duplicate actions and updates the chosen pet pack', async () => {
  const result = deferred(), f = fixture({ petImport: () => result.promise }); await f.ui.ready;
  const importing = f.node('pet-settings-import').click(); await f.node('pet-settings-import').click();
  assert.equal(f.node('pet-settings-enabled').disabled, true); assert.deepEqual(f.calls.at(-1), ['petImport', []]);
  assert.equal(f.calls.filter(([name]) => name === 'petImport').length, 1);
  result.resolve(state({ packId: 'imported', packs: [{ id: 'imported', name: '新宠物' }] })); await importing;
  assert.equal(f.node('pet-settings-pack').value, 'imported'); assert.equal(f.node('pet-settings-status').textContent, '宠物已导入。');
});

test('pet events defeat stale reads and responses while plugin errors or plugin updates have no effect', async () => {
  const read = deferred(), f = fixture({ petState: () => read.promise });
  f.emit({ type: 'pet-state', pet: state({ enabled: false, size: 400 }) }); read.resolve(state()); await f.ui.ready;
  assert.equal(f.node('pet-settings-enabled').checked, false); assert.equal(f.node('pet-settings-size').value, '400');
  f.emit({ type: 'extensions', extensions: { plugins: [], pluginError: '插件列表损坏' } });
  assert.equal(f.node('pet-settings-error').hidden, true); assert.equal(f.node('pet-settings-size').value, '400');
  const change = deferred(), late = fixture({ setPet: () => change.promise }); await late.ui.ready;
  late.node('pet-settings-enabled').checked = false; const saving = late.node('pet-settings-enabled').emit('change');
  late.emit({ type: 'pet-state', pet: state({ enabled: true, size: 350 }) });
  change.resolve(state({ enabled: false })); await saving;
  assert.equal(late.node('pet-settings-enabled').checked, true); assert.equal(late.node('pet-settings-size').value, '350');
});

test('overlay subscription updates the dialog and setting changes go through its ordered persistence helper', async () => {
  const listeners = new Set(), patches = [];
  const pet = { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(patch) { patches.push(plain(patch)); const next = state(patch); for (const listener of listeners) listener(next); return next; }, update() {} };
  const f = fixture({}, state(), pet); await f.ui.ready;
  f.node('pet-settings-work').checked = false; await f.node('pet-settings-work').emit('change');
  assert.deepEqual(patches, [{ workStatus: false }]); assert.equal(f.calls.length, 1); assert.equal(f.node('pet-settings-work').checked, false);
  f.ui.destroy(); assert.equal(listeners.size, 0);
});

test('failed changes show a readable error and cleanup ignores late state without invoking plugin APIs', async () => {
  const f = fixture({ setPet: () => { throw new Error("Error invoking remote method 'forge:setPet': Error: 保存失败"); } }); await f.ui.ready;
  f.node('pet-settings-enabled').checked = false; await f.node('pet-settings-enabled').emit('change');
  assert.equal(f.node('pet-settings-error').textContent, '保存失败'); assert.equal(f.node('pet-settings-error').hidden, false);
  assert.equal(f.node('pet-settings-enabled').disabled, false); assert.equal(f.node('pet-settings-enabled').checked, true);
  const read = deferred(), late = fixture({ petState: () => read.promise }); late.ui.destroy(); read.resolve(state()); await late.ui.ready;
  assert.equal(late.events.size, 0); assert.equal(late.node('pet-settings-dialog').removed, true);
});
