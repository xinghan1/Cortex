import test from 'node:test';
import assert from 'node:assert/strict';
import { officialReasoningMetadata, acpModelsWithReasoning, updateAcpConfig, setAcpReasoning } from '../src/core/official-agent-reasoning.mjs';

const config = (model = 'a', value = 'native/deep') => [
  { id: 'models', category: 'model', type: 'select', currentValue: model, options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] },
  { id: 'provider.budget', category: 'thought_level', type: 'select', currentValue: value, options: [{ value: 'native/deep', name: 'Deep' }, { value: 'native/auto', name: 'Auto' }] },
];
const session = () => ({ id: 'native-session', configOptions: config(), models: [{ id: 'a' }, { id: 'b' }] });

test('official reasoning menus reject duplicate values and never infer a default from current selection', () => {
  const metadata = officialReasoningMetadata([{ value: 'anything/64k', label: 'Original label' }], { currentValue: 'anything/64k' });
  assert.deepEqual(metadata.reasoningEfforts, ['anything/64k']); assert.equal(metadata.defaultReasoningEffort, undefined);
  assert.equal(metadata.currentReasoningEffort, 'anything/64k');
  assert.throws(() => officialReasoningMetadata([{ value: 'x' }, { value: 'x' }]));
  assert.throws(() => officialReasoningMetadata([{ value: 'bad\nvalue' }]));
});

test('complete config replacement clears all previous-model reasoning labels, defaults and current selections', () => {
  const state = session(); state.configOptions[1].defaultValue = 'native/auto'; state.models = acpModelsWithReasoning(state.models, state);
  assert.equal(state.models[0].defaultReasoningEffort, 'native/auto');
  updateAcpConfig(state, config('b'));
  assert.deepEqual(state.models[0], { id: 'a', reasoningEfforts: [], reasoningOptions: [] });
  assert.equal(state.models[1].currentReasoningEffort, 'native/deep'); assert.equal(state.models[1].reasoningModelId, 'b');
});

test('a native rejection or a clamped effort is a task failure and cannot silently continue with another level', async () => {
  const unavailable = () => Object.assign(new Error('Unsupported effort'), { code: 'OFFICIAL_REASONING_UNAVAILABLE' });
  const state = session(), calls = [];
  const client = { request: async (method, params) => { calls.push({ method, params }); return { configOptions: config('a', 'native/auto') }; } };
  await assert.rejects(setAcpReasoning({ client, session: state, effort: 'native/deep', options: {}, collectors: new Set(), unavailable }), { code: 'OFFICIAL_REASONING_UNAVAILABLE' });
  assert.deepEqual(calls[0], { method: 'session/set_config_option', params: { sessionId: 'native-session', configId: 'provider.budget', value: 'native/deep' } });
  await assert.rejects(setAcpReasoning({ client: { request: async () => { throw Object.assign(new Error('Native rejection'), { code: 'NATIVE_REJECTED' }); } }, session: session(), effort: 'native/deep', options: {}, collectors: new Set(), unavailable }), { code: 'NATIVE_REJECTED' });
});
