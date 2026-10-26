import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function appFunction(name) {
  const match = new RegExp(`function ${name}\\(`, 'u').exec(source); assert.ok(match, name);
  const tail = source.slice(match.index), end = tail.slice(1).search(/\n(?:async )?function /u);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function fixture(authMode, { compatible = true, options = ['low', 'high'], labels = options } = {}) {
  const nodes = new Map(), node = id => {
    if (!nodes.has(id)) { const classes = new Set(); nodes.set(id, { id, value: '0', dataset: {}, title: '',
      classList: { toggle(name, force) { force ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name), remove: name => classes.delete(name) },
      setAttribute(name, value) { this[name] = value; }, closest: () => null }); }
    return nodes.get(id);
  };
  const range = node('reasoning-effort');
  const state = { settings: { provider: 'gemini', authMode, model: 'official-model' } };
  const metadata = { id: 'official-model', displayName: 'Official model', compatible, reasoningEfforts: options,
    reasoningOptions: options.map((value, i) => ({ value, label: labels[i] })) };
  const context = vm.createContext({ appState: state, $: node, window: {}, currentAuthMode: () => state.settings.authMode,
    selectedModelMetadata: () => metadata, reasoningLabels: { low: '低', high: '高', default: '默认' },
    reasoningOptions: { gemini: ['low', 'high'] }, modelControlBusy: () => false, reasoningSaving: false, modelSaving: false });
  for (const name of ['reasoningSpec', 'rangeOptions', 'officialAgentReasoning', 'reasoningAvailable', 'reasoningLabel', 'renderComposerModel', 'updateReasoningControl', 'fillReasoningOptions'])
    vm.runInContext(appFunction(name), context);
  context.fillReasoningOptions(range, 'gemini', 'default');
  return { context, node, range, state, metadata };
}

test('native agents preserve official order, raw values and labels instead of forcing common API aliases', () => {
  for (const mode of ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent']) {
    const f = fixture(mode, { options: ['adaptive:extended', 'off'], labels: ['深入思考', '关闭思考'] });
    assert.equal(f.range.disabled, false);
    assert.deepEqual(JSON.parse(f.range.dataset.options), ['adaptive:extended', 'off']);
    f.range.value = '0'; f.context.updateReasoningControl(f.range, true);
    assert.equal(f.range.dataset.effort, 'adaptive:extended');
    assert.equal(f.node('composer-reasoning-label').textContent, '深入思考');
    assert.equal(f.range['aria-valuetext'], '深入思考');
    f.range.value = '1'; f.context.updateReasoningControl(f.range, true);
    assert.equal(f.node('reasoning-value').textContent, '关闭思考');
  }
});

test('native agents with no advertised levels show managed status and cannot submit an invented choice', () => {
  for (const mode of ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent']) {
    const f = fixture(mode, { options: [] });
    assert.equal(f.range.disabled, true); assert.equal(f.node('reasoning-default').disabled, true);
    assert.equal(f.node('composer-reasoning-label').textContent, '由官方代理管理');
    assert.equal(f.range.dataset.effort, 'default');
    assert.equal(f.node('composer-reasoning-label').classList.contains('is-unavailable'), false);
  }
});

test('switching models clears a previous native level and excludes invalid values from controls', () => {
  const f = fixture('glm-agent', { options: ['off', 'deep'], labels: ['关闭', '深入'] });
  f.context.fillReasoningOptions(f.range, 'gemini', 'deep');
  f.metadata.reasoningEfforts = []; f.metadata.reasoningOptions = [];
  f.context.fillReasoningOptions(f.range, 'gemini', 'deep');
  assert.equal(f.range.disabled, true); assert.equal(f.range.dataset.effort, 'default');
  f.metadata.reasoningOptions = [{ value: 'deep\ninvalid', label: 'Invalid' }];
  f.context.fillReasoningOptions(f.range, 'gemini', 'default'); assert.equal(f.range.disabled, true);
});

test('an incompatible native model remains unavailable even when levels are advertised', () => {
  const f = fixture('glm-agent', { compatible: false });
  assert.equal(f.node('composer-reasoning-label').textContent, '不可用'); assert.equal(f.range.disabled, true);
});

test('returning to an API connection restores normal reasoning labels without a native tooltip', () => {
  const f = fixture('antigravity-agent', { options: [] }); f.state.settings.authMode = 'apiKey';
  f.metadata.reasoningEfforts = ['low', 'high']; f.context.fillReasoningOptions(f.range, 'gemini', 'low');
  assert.equal(f.range.disabled, false); assert.equal(f.node('composer-reasoning-label').textContent, '低');
  assert.equal(f.node('composer-reasoning-label').title, ''); assert.equal(f.range.title, '推理强度：低');
});
