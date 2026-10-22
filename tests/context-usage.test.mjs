import test from 'node:test';
import assert from 'node:assert/strict';
import { captureContextMeasurement, contextMeasurementMatchesConfig, estimateRequestTokens, getContextMeasurementTokens } from '../src/core/context-usage.mjs';

const config = { provider: 'ollama', model: 'fixture', baseUrl: 'http://localhost:11434', apiKey: 'PRIVATE_KEY',
  connectionKey: 'connection', modelCapabilities: { contextWindow: 32768 } };
const tools = [{ name: 'read_file', parameters: { type: 'object' } }];
const messages = [{ id: 'ui-user', createdAt: '2026-01-01', role: 'user', content: 'Inspect this image.', attachments: [
  { id: 'image-id', name: 'fixture.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' },
] }, { id: 'ui-assistant', role: 'assistant', content: 'Reading.', toolCalls: [
  { id: 'call-one', name: 'read_file', arguments: { path: 'fixture.txt' } },
], providerState: { message: { thinking: 'PRIVATE_THINKING' } } }];
const capture = () => captureContextMeasurement({ config, messages, tools, inputTokens: 1200, outputTokens: 30 });

test('a measured complete prefix calibrates only newly estimated growth and never stores private content', () => {
  const measurement = capture();
  assert.deepEqual(getContextMeasurementTokens(messages, tools, measurement), { tokens: 1230,
    basis: 'reported-context-plus-estimated-growth', reportedTokens: 1230, estimatedDeltaTokens: 0 });
  const grown = [...messages, { role: 'tool', toolCallId: 'call-one', content: 'x'.repeat(800) }];
  const delta = estimateRequestTokens(grown, tools) - estimateRequestTokens(messages, tools);
  assert.equal(getContextMeasurementTokens(grown, tools, measurement).tokens, 1230 + delta);
  assert.equal(JSON.stringify(measurement).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(measurement).includes('fixture'), false);
  assert.equal(estimateRequestTokens(messages, tools) > estimateRequestTokens(messages.map(({ providerState, ...message }) => message), tools), true);
});

test('semantic hashes ignore UI noise but bind tool IDs, native state, image bytes, content and tool schemas', () => {
  const measurement = capture(), uiChanges = structuredClone(messages);
  uiChanges[0].id = 'different'; uiChanges[0].createdAt = 'later'; uiChanges[0].attachments[0].id = 'different-image';
  assert.equal(getContextMeasurementTokens(uiChanges, tools, measurement).basis, 'reported-context-plus-estimated-growth');
  for (const mutate of [value => { value[0].content += '!'; }, value => { value[1].toolCalls[0].id = 'call-other'; },
    value => { value[1].providerState.message.thinking += '!'; },
    value => { value[0].attachments[0].dataUrl = 'data:image/png;base64,b3RoZXI='; }]) {
    const changed = structuredClone(messages); mutate(changed);
    assert.equal(getContextMeasurementTokens(changed, tools, measurement).basis, 'estimated-request-input');
  }
  assert.equal(getContextMeasurementTokens(messages, [{ ...tools[0], description: 'changed' }], measurement).basis, 'estimated-request-input');
  assert.equal(getContextMeasurementTokens(messages.slice(1), tools, measurement).basis, 'estimated-request-input');
});

test('configuration bindings invalidate different accounts, models, endpoints, protocols and runtime windows', () => {
  const measurement = capture();
  assert.equal(contextMeasurementMatchesConfig(measurement, { ...config, configRevision: 9, permissionMode: 'full' }), true);
  for (const change of [{ provider: 'relay' }, { model: 'other' }, { apiKey: 'other-secret' }, { baseUrl: 'http://other:11434' },
    { connectionKey: 'other' }, { authMode: 'chatgpt' }, { apiProtocol: 'responses' }, { reasoningEffort: 'enabled' }, { modelCapabilities: { contextWindow: 8192 } }])
    assert.equal(contextMeasurementMatchesConfig(measurement, { ...config, ...change }), false);
  assert.equal(captureContextMeasurement({ config, messages, tools, inputTokens: 1 }), null);
  assert.equal(getContextMeasurementTokens(messages, tools, { ...measurement, measuredTokens: -1 }).basis, 'estimated-request-input');
});
