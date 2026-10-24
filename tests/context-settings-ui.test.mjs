import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/context-settings.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = (modelCapacity = {}, workspaceId = 'workspace-one') => ({ workspaceId, modelCapacity: {
  scope: 'scope-one', model: 'fixture-model', capacityTokens: null, advertisedTokens: null, manualTokens: null,
  source: 'unknown', limitKind: 'total', ...modelCapacity,
} });
class Node {
  constructor(id) { this.id = id; this.value = ''; this.hidden = false; this.disabled = false; this.listeners = new Map(); this.attributes = new Map(); }
  addEventListener(type, listener) { const values = this.listeners.get(type) || []; values.push(listener); this.listeners.set(type, values); }
  fire(type, fields = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...fields }; for (const listener of this.listeners.get(type) || []) listener(event); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  contains(target) { return target === this || this.children?.includes(target); }
}
async function fixture(initial = state(), options = {}) {
  const ids = ['session-context-control', 'session-context-trigger', 'context-settings-popup', 'context-trigger-input',
    'context-trigger-error', 'context-settings-close', 'context-trigger-save', 'context-trigger-reset', 'context-capacity-source'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node(id)]));
  nodes['context-settings-popup'].hidden = true;
  nodes['session-context-control'].children = Object.values(nodes);
  const document = new Node('document'); document.getElementById = id => nodes[id];
  let listener, latest = initial; const calls = [];
  const bridge = {
    getState: () => options.initialRead || Promise.resolve(latest),
    onEvent: callback => { listener = callback; },
    setModelCapacity: async arg => {
      calls.push(arg);
      if (options.save) return options.save(arg);
      const value = arg.capacityTokens ?? latest.modelCapacity.advertisedTokens;
      latest = { ...latest, modelCapacity: { ...latest.modelCapacity, manualTokens: arg.capacityTokens,
        capacityTokens: value, source: arg.capacityTokens !== null ? 'manual' : value === null ? 'unknown' : 'catalog' } };
      return latest;
    },
  };
  const window = { forge: bridge }; vm.runInNewContext(source, { window, document });
  await tick();
  return { nodes, document, bridge, calls, api: window.ForgeContextSettings,
    update(value, type = 'state') { latest = value; listener({ type, workspaceId: value.workspaceId, state: value }); },
    edit(value) { nodes['context-trigger-input'].value = value; nodes['context-trigger-input'].fire('input'); },
  };
}

test('unknown model capacity is blank and sources follow the directory without inventing 850000 tokens', async () => {
  const h = await fixture(); h.api.open();
  assert.equal(h.nodes['context-trigger-input'].value, '');
  assert.equal(h.nodes['context-capacity-source'].textContent, '来源：未提供');
  assert.equal(h.calls.length, 0);
  h.update(state({ capacityTokens: 128000, advertisedTokens: 128000, source: 'catalog' }));
  assert.equal(h.nodes['context-trigger-input'].value, '128000');
  assert.equal(h.nodes['context-trigger-input'].max, '128000');
  assert.equal(h.nodes['context-capacity-source'].textContent, '来源：模型目录');
});

test('manual saves bind the model scope, lock duplicate actions, and reset clears only the manual capacity', async () => {
  const h = await fixture(state({ capacityTokens: 128000, advertisedTokens: 128000, source: 'catalog' }));
  h.api.open(); h.edit('64000'); h.nodes['context-trigger-save'].fire('click');
  h.nodes['context-trigger-save'].fire('click');
  assert.equal(h.nodes['context-trigger-save'].disabled, true);
  await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].scope, 'scope-one'); assert.equal(h.calls[0].capacityTokens, 64000);
  assert.equal(h.nodes['context-capacity-source'].textContent, '来源：手动设置');
  assert.equal(h.nodes['context-settings-popup'].hidden, true);
  h.api.open(); h.nodes['context-trigger-reset'].fire('click'); await tick();
  assert.equal(h.calls[1].capacityTokens, null);
  assert.equal(h.nodes['context-trigger-input'].value, '128000');
  assert.equal(h.nodes['context-capacity-source'].textContent, '来源：模型目录');
  const unknown = await fixture(); unknown.api.open(); unknown.nodes['context-trigger-reset'].fire('click'); await tick();
  assert.equal(unknown.nodes['context-trigger-input'].value, '');
  assert.equal(unknown.calls[0].capacityTokens, null);
});

test('known real upper limits and integer bounds reject invalid drafts before IPC', async () => {
  const h = await fixture(state({ capacityTokens: 128000, advertisedTokens: 128000, source: 'catalog' })); h.api.open();
  for (const draft of ['128001', '999', '16000001', '1234.5', 'Infinity']) {
    h.edit(draft); h.nodes['context-trigger-save'].fire('click'); await tick();
    assert.equal(h.calls.length, 0); assert.equal(h.nodes['context-trigger-error'].hidden, false);
  }
  assert.equal(h.nodes['context-settings-popup'].hidden, false);
  h.edit('128001'); h.nodes['context-trigger-save'].fire('click');
  assert.match(h.nodes['context-trigger-error'].textContent, /128,000/);
  h.update(state({ capacityTokens: 128000, advertisedTokens: 128000, manualTokens: 256000, source: 'manual', manualClamped: true }));
  assert.match(h.nodes['context-capacity-source'].title, /模型目录上限/);
});

test('model or connection changes discard unsaved drafts and ignore late save results and errors', async () => {
  for (const failure of [false, true]) {
    const pending = deferred(), h = await fixture(state(), { save: () => pending.promise });
    h.api.open(); h.edit('64000'); h.nodes['context-trigger-save'].fire('click');
    h.update(state({ scope: 'other-connection-same-model', capacityTokens: 256000, advertisedTokens: 256000, source: 'catalog' }));
    assert.equal(h.nodes['context-settings-popup'].hidden, true);
    assert.equal(h.nodes['context-trigger-input'].value, '256000');
    if (failure) pending.reject(new Error('Old connection error'));
    else pending.resolve(state({ capacityTokens: 64000, manualTokens: 64000, source: 'manual' }));
    await tick();
    h.api.open(); assert.equal(h.nodes['context-trigger-input'].value, '256000');
    assert.equal(h.nodes['context-trigger-error'].hidden, true);
    assert.equal(h.nodes['context-trigger-save'].disabled, false);
    h.update(state({ scope: null }));
    assert.equal(h.nodes['context-trigger-input'].disabled, true);
    assert.equal(h.nodes['context-trigger-save'].disabled, true);
  }
});

test('same-scope updates retain an active edit, and an initial stale snapshot cannot replace an event', async () => {
  const initial = deferred(), h = await fixture(state(), { initialRead: initial.promise });
  h.update(state({ scope: 'current-scope', capacityTokens: 128000, advertisedTokens: 128000, source: 'catalog' }));
  initial.resolve(state({ capacityTokens: 850000 })); await tick();
  h.api.open(); assert.equal(h.nodes['context-trigger-input'].value, '128000');
  h.edit('64000'); h.update(state({ scope: 'current-scope', capacityTokens: 128000, advertisedTokens: 128000, source: 'catalog' }));
  assert.equal(h.nodes['context-trigger-input'].value, '64000');
  h.nodes['context-trigger-save'].fire('click'); await tick();
  assert.equal(h.calls[0].scope, 'current-scope');
});

test('save failures preserve the draft and keyboard or outside dismissal keeps the popover usable', async () => {
  let failed = true;
  const h = await fixture(state(), { save: async arg => {
    if (failed) throw new Error('模型容量保存失败，请重试。');
    return state({ capacityTokens: arg.capacityTokens, manualTokens: arg.capacityTokens, source: 'manual' });
  } });
  h.api.open(); h.edit('128000'); h.nodes['context-trigger-input'].fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(h.nodes['context-trigger-input'].value, '128000'); assert.equal(h.nodes['context-trigger-error'].hidden, false);
  assert.equal(h.nodes['context-trigger-save'].disabled, false);
  failed = false; h.nodes['context-trigger-input'].fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(h.nodes['context-settings-popup'].hidden, true);
  h.api.open(); h.document.fire('keydown', { key: 'Escape' }); assert.equal(h.nodes['context-settings-popup'].hidden, true);
  h.api.open(); h.document.fire('pointerdown', { target: new Node('outside') }); assert.equal(h.nodes['context-settings-popup'].hidden, true);
});

test('markup labels the setting as model capacity and leaves unknown values blank', async () => {
  const html = await fs.readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const popup = html.slice(html.indexOf('<section id="context-settings-popup"'), html.indexOf('</section>', html.indexOf('<section id="context-settings-popup"')));
  assert.match(popup, /模型容量（Token）/); assert.match(popup, /恢复模型目录/); assert.match(popup, /context-capacity-source/);
  assert.doesNotMatch(popup, /自动压缩阈值|value="850000"|恢复默认/);
  assert.doesNotMatch(source, /setContextCompression|850000/);
});
