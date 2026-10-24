import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog, deriveModelCapabilities } from '../src/core/model-catalog.mjs';

const show = extra => ({ capabilities: ['completion', 'tools', 'vision', 'thinking'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 131072, 'qwen3.vision.context_length': 999999 },
  parameters: 'temperature 0.7\nnum_ctx 2048', thinking: { values: [false, true], default: true }, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('native catalog loads tags and show without a key and preserves accurate coding, text-only and embedding capabilities', async () => {
  const calls = [], catalog = new ModelCatalog();
  const fetchImpl = async (url, init) => {
    calls.push([url, init]); assert.equal(init.redirect, 'error'); assert.equal(Object.hasOwn(init.headers, 'Authorization'), false);
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'coder:latest' }, { name: 'chat:latest' }, { name: 'embed:latest' }] });
    assert.equal(init.method, 'POST'); const { model, verbose } = JSON.parse(init.body); assert.equal(verbose, false);
    return json(show({ capabilities: model.startsWith('coder') ? ['completion', 'tools', 'vision'] : model.startsWith('chat') ? ['completion'] : ['embedding'] }));
  };
  const result = await catalog.list({ provider: 'ollama', fetchImpl, contextWindowTokens: 8192 });
  assert.equal(calls.length, 4); assert.equal(calls[0][0], 'http://localhost:11434/api/tags');
  assert.deepEqual(result.models.map(model => [model.id, model.compatible, model.textCompatible]), [
    ['coder:latest', true, true], ['chat:latest', false, true], ['embed:latest', false, false],
  ]);
  const coder = result.models[0]; assert.equal(coder.contextWindow, 8192); assert.equal(coder.trainingContextWindow, 131072);
  assert.equal(coder.contextWindowOrigin, 'ollama');
  assert.equal(coder.modelDefaultContextWindow, 2048, 'A Modelfile default must not prevent explicit runtime overrides');
  assert.deepEqual(coder.reasoningEfforts, ['none', 'enabled']); assert.equal(coder.defaultReasoningEffort, 'enabled');
  assert.equal(coder.supportsImages, true);
  const again = deriveModelCapabilities('ollama', coder.id, { ...coder, contextWindowTokens: 65536 });
  assert.equal(again.contextWindow, 65536); assert.equal(again.trainingContextWindow, 131072); assert.deepEqual(again.reasoningEfforts, ['none', 'enabled']);
  assert.deepEqual(deriveModelCapabilities('ollama', coder.id, again), again);
});

test('context windows clamp only to exact architecture training metadata and thinking levels require explicit advertised values', () => {
  assert.equal(deriveModelCapabilities('ollama', 'a', { ...show(), contextWindowTokens: 262144 }).contextWindow, 131072);
  const unknown = deriveModelCapabilities('ollama', 'a', show({ model_info: { 'vision.context_length': 8 } }));
  assert.equal(unknown.contextWindow, 32768); assert.equal(Object.hasOwn(unknown, 'trainingContextWindow'), false);
  const named = deriveModelCapabilities('ollama', 'a', show({ thinking: { values: ['low', 'medium', 'high'], default: 'medium' } }));
  assert.deepEqual(named.reasoningEfforts, ['low', 'medium', 'high']); assert.equal(named.defaultReasoningEffort, 'medium');
  assert.deepEqual(deriveModelCapabilities('ollama', 'a', show({ thinking: undefined })).reasoningEfforts, []);
  assert.deepEqual(deriveModelCapabilities('ollama', 'a', show({ thinking: { values: [false], default: false } })).reasoningEfforts, ['none']);
});

test('catalog cache separates endpoints, credentials and configured context windows and failed refresh does not resurrect stale data', async () => {
  const catalog = new ModelCatalog(), calls = [];
  let failed = false;
  const fetchImpl = async (url, init) => { calls.push(url); if (failed) return json({ error: 'unavailable' }, 503);
    return url.endsWith('/tags') ? json({ models: [{ name: 'fixture' }] }) : json(show()); };
  const input = { provider: 'ollama', baseUrl: 'http://host.company.test:11434', fetchImpl };
  await catalog.list(input); await catalog.list(input); assert.equal(calls.length, 2);
  await catalog.list({ ...input, contextWindowTokens: 8192 }); assert.equal(calls.length, 4);
  await catalog.list({ ...input, apiKey: 'optional-key' }); assert.equal(calls.length, 6);
  failed = true;
  await assert.rejects(catalog.list({ ...input, force: true }), { code: 'CATALOG_HTTP_503' });
  await assert.rejects(catalog.list(input), { code: 'CATALOG_HTTP_503' });
  assert.equal(calls.length, 8);
});

test('native directory requests are bounded, cancellable and do not surface credential echoes', async () => {
  await assert.rejects(new ModelCatalog({ maxResponseBytes: 20 }).list({ provider: 'ollama', fetchImpl: async () => json({ models: [{ name: 'too-large' }] }) }), { code: 'CATALOG_RESPONSE_TOO_LARGE' });
  await assert.rejects(new ModelCatalog({ maxModels: 1 }).list({ provider: 'ollama', fetchImpl: async () => json({ models: [{ name: 'a' }, { name: 'b' }] }) }), { code: 'CATALOG_RESPONSE_TOO_LARGE' });
  const key = 'private-ollama-credential';
  await assert.rejects(new ModelCatalog().list({ provider: 'ollama', apiKey: key, fetchImpl: async () => json({ models: [{ name: key }] }) }), error => {
    assert.equal(error.code, 'CATALOG_UNSAFE_RESPONSE'); assert.equal(error.message.includes(key), false); return true;
  });
  await assert.rejects(new ModelCatalog({ timeoutMs: 25 }).list({ provider: 'ollama', fetchImpl: async () => new Promise(() => {}) }), { code: 'CATALOG_TIMEOUT' });
  const controller = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = new ModelCatalog().list({ provider: 'ollama', signal: controller.signal, fetchImpl: async () => { entered(); return new Promise(() => {}); } });
  await ready; controller.abort(); await assert.rejects(pending, { code: 'CATALOG_CANCELLED' });
});

test('optional bearer headers and strict invalid settings are applied to all native catalog requests', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => { calls++; assert.equal(init.headers.Authorization, 'Bearer optional-fixture');
    return url.endsWith('/tags') ? json({ models: [{ name: 'a' }] }) : json(show()); };
  await new ModelCatalog().list({ provider: 'ollama', apiKey: 'optional-fixture', fetchImpl }); assert.equal(calls, 2);
  for (const contextWindowTokens of [0, 4095, 2097153, 8192.5, '8192']) await assert.rejects(new ModelCatalog().list({ provider: 'ollama', contextWindowTokens, fetchImpl }), { code: 'CATALOG_INVALID_CONFIG' });
  for (const baseUrl of ['http://name:password@host', 'http://host?key=x', 'http://host/v1']) await assert.rejects(new ModelCatalog().list({ provider: 'ollama', baseUrl, fetchImpl }), { code: 'CATALOG_INVALID_URL' });
});
