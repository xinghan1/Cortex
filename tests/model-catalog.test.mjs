import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog, deriveModelCapabilities } from '../src/core/model-catalog.mjs';

const json = (data, options) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' }, ...options });
const entry = (id, extra = {}) => ({ id, object: 'model', ...extra });
const args = overrides => ({ provider: 'openai', baseUrl: 'https://models.example/v1', apiKey: 'private-test-key', ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('OpenAI catalog uses GET, bearer header, no redirects and preserves unknown model IDs', async () => {
  const requests = [];
  const catalog = new ModelCatalog();
  const result = await catalog.list(args({ baseUrl: 'https://models.example/v1/responses', fetchImpl: async (url, init) => {
    requests.push({ url, init }); return json({ object: 'list', data: [entry('future-unknown-model')] });
  } }));
  assert.equal(requests[0].url, 'https://models.example/v1/models');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer private-test-key');
  assert.equal(requests[0].init.headers['x-api-key'], undefined);
  assert.deepEqual(result.models, [{ id: 'future-unknown-model', displayName: 'future-unknown-model' }]);
  assert.equal(result.source, 'api');
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('relay catalog accepts mixed model names without Anthropic pagination and stays separate from OpenAI', async () => {
  const catalog = new ModelCatalog();
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, 'https://models.example/v1/models');
    assert.equal(init.headers.Authorization, 'Bearer private-test-key');
    assert.equal(init.headers['x-api-key'], undefined);
    return json({ data: [entry('gemini-compatible'), entry('claude-compatible'), entry('gpt-compatible')] });
  };
  const result = await catalog.list(args({ provider: 'relay', baseUrl: 'https://models.example/v1/chat/completions', fetchImpl }));
  assert.deepEqual(result.models.map(model => model.id), ['gemini-compatible', 'claude-compatible', 'gpt-compatible']);
  assert.ok(result.models.every(model => model.reasoningEfforts === undefined));
  await catalog.list(args({ provider: 'relay', fetchImpl }));
  assert.equal(calls, 1);
  await catalog.list(args({ provider: 'openai', fetchImpl }));
  assert.equal(calls, 2, 'Relay and official-provider catalogs must not share a cache entry');
});

test('relay catalog requires an explicit base URL before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Must not make a request'); };
  for (const baseUrl of ['', undefined]) {
    await assert.rejects(new ModelCatalog().list(args({ provider: 'relay', baseUrl, fetchImpl })), { code: 'CATALOG_INVALID_URL' });
  }
  assert.equal(calls, 0);
});

test('DeepSeek official rich metadata supplies names, supported thinking levels and default', async () => {
  const catalog = new ModelCatalog();
  const result = await catalog.list(args({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/chat/completions', fetchImpl: async url => {
    assert.equal(url, 'https://api.deepseek.com/models');
    return json({ object: 'list', data: [entry('deepseek-flash', {
      name: 'DeepSeek-V4.1-Flash', input_modalities: ['text', 'image'], output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
    })] });
  } }));
  assert.equal(result.models[0].displayName, 'DeepSeek-V4.1-Flash');
  assert.deepEqual(result.models[0].reasoningEfforts, ['none', 'low', 'high', 'max']);
  assert.equal(result.models[0].defaultReasoningEffort, 'high');
  assert.equal(result.models[0].supportsTools, undefined, 'system prompt update capability is not a tool permission');
  assert.equal(result.models[0].supportsImages, true);
});

test('Anthropic catalog follows has_more/last_id pagination and reads capability metadata', async () => {
  const seen = [];
  const catalog = new ModelCatalog();
  const result = await catalog.list(args({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', fetchImpl: async (url, init) => {
    const parsed = new URL(url); seen.push(parsed);
    assert.equal(parsed.pathname, '/v1/models');
    assert.equal(parsed.searchParams.get('limit'), '1000');
    assert.equal(init.headers['x-api-key'], 'private-test-key');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers.Authorization, undefined);
    if (seen.length === 1) return json({ data: [entry('claude-capable', {
      display_name: 'Claude from API', capabilities: { effort: { supported: true,
        low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: false },
      } },
    })], has_more: true, last_id: 'claude-capable' });
    assert.equal(parsed.searchParams.get('after_id'), 'claude-capable');
    return json({ data: [entry('claude-capable'), entry('claude-basic', { display_name: 'Basic', capabilities: { effort: { supported: false } } })], has_more: false, last_id: 'claude-basic' });
  } }));
  assert.equal(seen.length, 2);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].displayName, 'Claude from API');
  assert.deepEqual(result.models[0].reasoningEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(result.models[1].reasoningEfforts, []);
});

test('five minute cache is endpoint-normalized, returns copies, and force refreshes', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z'), calls = 0;
  const catalog = new ModelCatalog({ clock: () => now });
  const fetchImpl = async () => { calls++; return json({ data: [entry(`model-${calls}`)] }); };
  const first = await catalog.list(args({ baseUrl: 'https://MODELS.example:443/v1/responses/', fetchImpl }));
  first.models[0].displayName = 'mutated';
  now += 299999;
  const second = await catalog.list(args({ baseUrl: 'https://models.example/v1/models/', fetchImpl }));
  assert.equal(calls, 1);
  assert.equal(second.models[0].displayName, 'model-1');
  now += 2;
  assert.equal((await catalog.list(args({ fetchImpl }))).models[0].id, 'model-2');
  await catalog.list(args({ fetchImpl, force: true }));
  assert.equal(calls, 3);
});

test('cache isolation includes credential, provider and normalized endpoint', async () => {
  const catalog = new ModelCatalog(); let calls = 0;
  const fetchImpl = async () => json({ data: [entry(`model-${++calls}`)] });
  assert.equal((await catalog.list(args({ apiKey: 'account-a', fetchImpl }))).models[0].id, 'model-1');
  assert.equal((await catalog.list(args({ apiKey: 'account-b', fetchImpl }))).models[0].id, 'model-2');
  assert.equal((await catalog.list(args({ provider: 'deepseek', apiKey: 'account-a', fetchImpl }))).models[0].id, 'model-3');
  assert.equal((await catalog.list(args({ baseUrl: 'https://other.example/v1', apiKey: 'account-a', fetchImpl }))).models[0].id, 'model-4');
  assert.equal((await catalog.list(args({ apiKey: 'account-a', fetchImpl }))).models[0].id, 'model-1');
  assert.doesNotMatch(JSON.stringify(catalog), /account-a|account-b/);
});

test('directory failure never substitutes a previous account catalog', async () => {
  const catalog = new ModelCatalog();
  await catalog.list(args({ apiKey: 'account-a', fetchImpl: async () => json({ data: [entry('alpha-model')] }) }));
  await assert.rejects(catalog.list(args({ apiKey: 'account-b', fetchImpl: async () => json({ error: { message: 'account-b private-test-key' } }, { status: 401 }) })), error => {
    assert.equal(error.status, 401); assert.doesNotMatch(error.message, /account-b|private-test-key|alpha-model/); return true;
  });
});

test('invalid addresses and credential-bearing URLs are rejected before any network access', async () => {
  const catalog = new ModelCatalog(); let calls = 0;
  for (const baseUrl of ['http://remote.example/v1', 'https://user:private-test-key@example.com',
    'https://@example.com', 'https://example.com/v1?key=private-test-key', 'https://example.com/v1?',
    'https://example.com/v1#', 'file:///C:/private-test-key', 'not a URL']) {
    await assert.rejects(catalog.list(args({ baseUrl, fetchImpl: async () => { calls++; } })), error => {
      assert.match(error.code, /INVALID_URL/); assert.doesNotMatch(error.message, /private-test-key/); return true;
    });
  }
  assert.equal(calls, 0);
});

test('loopback HTTP is supported and complete message/chat endpoints normalize to models', async () => {
  const catalog = new ModelCatalog();
  for (const [provider, baseUrl, expected] of [
    ['openai', 'http://127.0.0.1:19000/v1/responses', 'http://127.0.0.1:19000/v1/models'],
    ['deepseek', 'http://localhost:19000/api/chat/completions', 'http://localhost:19000/api/models'],
    ['anthropic', 'http://[::1]:19000/v1/messages', 'http://[::1]:19000/v1/models?limit=1000'],
  ]) {
    await catalog.list(args({ provider, baseUrl, fetchImpl: async url => { assert.equal(url, expected); return json({ data: [], ...(provider === 'anthropic' ? { has_more: false } : {}) }); } }));
  }
});

test('malformed catalog structures, IDs and UTF-8 return safe errors', async () => {
  const cases = [json({ models: [] }), json({ data: {} }), json({ data: [null] }), json({ data: [entry('')] }),
    new Response('{"data":['), new Response(new Uint8Array([0xff, 0xfe]))];
  for (const response of cases) {
    await assert.rejects(new ModelCatalog().list(args({ fetchImpl: async () => response })), { code: 'CATALOG_INVALID_RESPONSE' });
  }
});

test('response bytes, row counts and page counts are bounded without returning partial lists', async () => {
  await assert.rejects(new ModelCatalog({ maxResponseBytes: 32 }).list(args({ fetchImpl: async () => json({ data: [entry('x'.repeat(100))] }) })), { code: 'CATALOG_RESPONSE_TOO_LARGE' });
  await assert.rejects(new ModelCatalog({ maxModels: 1 }).list(args({ fetchImpl: async () => json({ data: [entry('one'), entry('two')] }) })), { code: 'CATALOG_RESPONSE_TOO_LARGE' });
  await assert.rejects(new ModelCatalog({ maxPages: 1 }).list(args({ provider: 'anthropic', fetchImpl: async () => json({ data: [entry('one')], has_more: true, last_id: 'one' }) })), { code: 'CATALOG_RESPONSE_TOO_LARGE' });
});

test('Anthropic malformed and repeated pagination cursors cannot loop indefinitely', async () => {
  await assert.rejects(new ModelCatalog().list(args({ provider: 'anthropic', fetchImpl: async () => json({ data: [], has_more: true, last_id: 'one' }) })), { code: 'CATALOG_INVALID_RESPONSE' });
  let calls = 0;
  await assert.rejects(new ModelCatalog().list(args({ provider: 'anthropic', fetchImpl: async () => { calls++; return json({ data: [entry('one')], has_more: true, last_id: 'one' }); } })), { code: 'CATALOG_INVALID_RESPONSE' });
  assert.equal(calls, 2);
});

test('AbortSignal cancels stalled fetches and suppresses secret-bearing abort reasons', async () => {
  const controller = new AbortController();
  const pending = new ModelCatalog().list(args({ signal: controller.signal, fetchImpl: () => new Promise(() => {}) }));
  await tick(); controller.abort(new Error('private-test-key'));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('private-test-key'));
  let calls = 0;
  await assert.rejects(new ModelCatalog().list(args({ signal: controller.signal, fetchImpl: async () => { calls++; } })), { code: 'CATALOG_CANCELLED' });
  assert.equal(calls, 0);
});

test('timeout covers a stalled fetch and a body that stops sending data', async () => {
  await assert.rejects(new ModelCatalog({ timeoutMs: 5 }).list(args({ fetchImpl: () => new Promise(() => {}) })), { code: 'CATALOG_TIMEOUT' });
  let bodyCancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); }, cancel() { bodyCancelled = true; } });
  await assert.rejects(new ModelCatalog({ timeoutMs: 5 }).list(args({ fetchImpl: async () => new Response(stream) })), { code: 'CATALOG_TIMEOUT' });
  assert.equal(bodyCancelled, true);
});

test('transport errors, response error bodies and redirects cannot expose credentials', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('transport echoed private-test-key'); },
    async () => json({ error: { message: 'private-test-key' } }, { status: 403 }),
    async (url, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('redirect private-test-key'); },
  ]) await assert.rejects(new ModelCatalog().list(args({ fetchImpl })), error => !JSON.stringify({ message: error.message, cause: error.cause }).includes('private-test-key'));
});

test('raw and encoded credential echoes are rejected in every public model field', async () => {
  const key = 'sk-test:/secret-token';
  const variants = [key, encodeURIComponent(key), encodeURIComponent(encodeURIComponent(key)), Buffer.from(key).toString('base64')];
  for (const value of variants) {
    for (const item of [entry(value), entry('safe-id', { display_name: value }), entry('safe-id', { compatibilityReason: value })]) {
      await assert.rejects(new ModelCatalog().list(args({ apiKey: key, fetchImpl: async () => json({ data: [item] }) })), error => {
        assert.equal(error.code, 'CATALOG_UNSAFE_RESPONSE'); assert.ok(!error.message.includes(value)); return true;
      });
    }
  }
});

test('a failed forced refresh invalidates the old same-account cache', async () => {
  const catalog = new ModelCatalog(); let calls = 0;
  const fetchImpl = async () => { calls++; return json({ data: [entry(`fresh-${calls}`)] }); };
  await catalog.list(args({ fetchImpl }));
  await assert.rejects(catalog.list(args({ force: true, fetchImpl: async () => json({}, { status: 503 }) })), { code: 'CATALOG_HTTP_503' });
  assert.equal((await catalog.list(args({ fetchImpl }))).models[0].id, 'fresh-2');
  assert.equal(calls, 2);
});

test('capabilities use explicit metadata and do not assign official families to proxies', async () => {
  assert.deepEqual(deriveModelCapabilities('openai', 'future-gpt-10'), {});
  assert.deepEqual(deriveModelCapabilities('openai', 'gpt-6.1-sol'), {});
  assert.deepEqual(deriveModelCapabilities('openai', 'gpt-6.1-sol', { officialSource: true }).reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(deriveModelCapabilities('deepseek', 'smoke-basic', { reasoningEfforts: [], supportsTools: true }), { reasoningEfforts: [], supportsTools: true });
  const proxy = await new ModelCatalog().list(args({ fetchImpl: async () => json({ data: [entry('gpt-6.1-sol', { officialSource: true })] }) }));
  assert.equal(proxy.models[0].reasoningEfforts, undefined, 'server metadata cannot counterfeit trusted endpoint provenance');
});

test('known specialized models remain visible but are marked incompatible with the coding tool loop', async () => {
  const result = await new ModelCatalog().list(args({ baseUrl: 'https://api.openai.com/v1', fetchImpl: async () => json({ data: [
    entry('text-embedding-3-small'), entry('whisper-1'), entry('gpt-image-1'), entry('future-unknown'),
  ] }) }));
  assert.equal(result.models.length, 4);
  for (const model of result.models.slice(0, 3)) { assert.equal(model.compatible, false); assert.equal(model.supportsTools, false); assert.ok(model.compatibilityReason); }
  assert.equal(result.models[3].supportsTools, undefined);
  assert.equal(deriveModelCapabilities('anthropic', 'retired', { lifecycle: 'retired' }).compatible, false);
  assert.equal(deriveModelCapabilities('deepseek', 'image-only', { output_modalities: ['image'] }).supportsTools, false);
});

test('image capabilities follow explicit metadata without guessing official or proxy model names', async () => {
  assert.equal(deriveModelCapabilities('deepseek', 'vision-name-is-not-proof').supportsImages, undefined);
  assert.equal(deriveModelCapabilities('openai', 'gpt-6-astra', { officialSource: true }).supportsImages, undefined);
  assert.equal(deriveModelCapabilities('deepseek', 'declared-text', { input_modalities: ['text'] }).supportsImages, false);
  assert.equal(deriveModelCapabilities('deepseek', 'declared-image', { input_modalities: ['text', 'image'] }).supportsImages, true);
  assert.equal(deriveModelCapabilities('openai', 'explicit-wins', { supportsImages: false, input_modalities: ['text', 'image'] }).supportsImages, false);
  assert.equal(deriveModelCapabilities('anthropic', 'explicit-wins', { supportsImages: true, input_modalities: ['text'] }).supportsImages, true);
  for (const input_modalities of [[], 'text', ['text', null], [''], [42]]) {
    assert.equal(deriveModelCapabilities('deepseek', 'invalid-modalities', { input_modalities }).supportsImages, undefined);
  }
  const result = await new ModelCatalog().list(args({ fetchImpl: async () => json({ data: [
    entry('text-only', { input_modalities: ['text'] }), entry('with-images', { supportsImages: true }), entry('unknown'),
  ] }) }));
  assert.deepEqual(result.models.map(model => model.supportsImages), [false, true, undefined]);
});

test('relay reasoning levels follow explicit camel/snake metadata and preserve model IDs', async () => {
  const declarations = [
    { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high' },
    { supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { supported_reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high' },
    { supportedReasoningLevels: ['low', 'high'], defaultReasoningEffort: 'high' },
    { supported_reasoning_levels: ['low', 'high'], default_reasoning_effort: 'high' },
    { reasoning: { supported: true, supported_levels: ['low', 'high'], default_level: 'high' } },
    { capabilities: { reasoning: { supportedLevels: ['low', 'high'], defaultLevel: 'high' } } },
    { effort: { supported_levels: ['low', 'high'], default_level: 'high' } },
    { capabilities: { effort: { supportedLevels: ['low', 'high'], defaultEffort: 'high' } } },
    { capabilities: { effort: { low: { supported: true }, high: { supported: true }, max: { supported: false } } }, default_reasoning_effort: 'high' },
  ];
  const models = declarations.map((metadata, index) => entry(`gemini-4-argon-high-${index}`, metadata));
  let calls = 0;
  const result = await new ModelCatalog().list(args({ provider: 'relay', fetchImpl: async () => {
    calls++; return json({ data: models });
  } }));
  assert.equal(calls, 1, 'Discovery never probes a billed model endpoint');
  assert.deepEqual(result.models.map(model => model.id), models.map(model => model.id));
  for (const model of result.models) {
    assert.deepEqual(model.reasoningEfforts, ['low', 'high']);
    assert.equal(model.defaultReasoningEffort, 'high');
  }
  assert.deepEqual(deriveModelCapabilities('relay', 'deduplicated', { supported_reasoning_efforts: ['high', 'low', 'high'] }).reasoningEfforts, ['high', 'low']);
});

test('reasoning capability denials override positive lists and cannot enable a slider', () => {
  const denials = [
    { supportsReasoning: false }, { supports_reasoning: false }, { reasoning: false },
    { reasoning: { supported: false } }, { effort: { supported: false } },
    { capabilities: { supports_reasoning: false } }, { capabilities: { reasoning: false } },
    { capabilities: { reasoning: { supported: false } } }, { capabilities: { effort: { supported: false } } },
  ];
  for (const denial of denials) {
    assert.deepEqual(deriveModelCapabilities('relay', 'gemini-4-argon-high', {
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', ...denial,
    }), { reasoningEfforts: [] });
  }
  assert.deepEqual(deriveModelCapabilities('openai', 'gpt-6.1-sol', { officialSource: true, supports_reasoning: false }).reasoningEfforts, []);
});

test('missing, malformed and unsupported effort metadata never derives capabilities from suffixes', () => {
  const unknown = [{}, { supportsReasoning: true }, { supports_reasoning: true },
    { reasoningEfforts: 'high' }, { reasoning_efforts: null }, { supported_reasoning_efforts: ['high', 'ultra'] },
    { supportedReasoningLevels: ['low', 4] }, { reasoning: { supported: true } },
    { reasoning: { supported_levels: ['default'] } }, { effort: { supported_levels: ['HIGH'] } },
    { capabilities: { reasoning: { levels: [null] } } }, { capabilities: { effort: { high: { supported: 'true' } } } },
  ];
  for (const id of ['gemini-4-argon-high', 'gemini-4-argon-low', 'gpt-6.1-sol', 'claude-with-max']) {
    for (const metadata of unknown) assert.deepEqual(deriveModelCapabilities('relay', id, metadata), {});
  }
  assert.deepEqual(deriveModelCapabilities('relay', 'declared-empty', { supported_reasoning_efforts: [] }), { reasoningEfforts: [] });
  const official = deriveModelCapabilities('openai', 'gpt-6.1-sol', { officialSource: true, default_reasoning_effort: 'high' });
  assert.deepEqual(official.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(official.defaultReasoningEffort, 'high');
});

test('catalog HTTP 524 reports Cloudflare upstream timeout once without paid probes or body disclosure', async () => {
  let calls = 0;
  await assert.rejects(new ModelCatalog().list(args({ provider: 'relay', fetchImpl: async () => {
    calls++;
    return new Response('<html>private-test-key upstream timeout</html>', { status: 524 });
  } })), error => {
    assert.equal(error.code, 'CATALOG_HTTP_524');
    assert.equal(error.status, 524);
    assert.match(error.message, /Cloudflare.*上游.*超时/u);
    assert.doesNotMatch(error.message, /模型不存在|推理强度|private-test-key|<html>/u);
    return true;
  });
  assert.equal(calls, 1);
});
