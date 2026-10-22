import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';
import { runAgent } from '../src/core/agent.mjs';
import { ollamaEndpoint } from '../src/core/ollama-endpoint.mjs';

const tools = [{ name: 'read_file', description: 'Read fixture', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const options = extra => ({ provider: 'ollama', model: 'fixture:latest', messages: [{ role: 'user', content: 'Read fixture.' }], tools, ...extra });
const complete = extra => ({ message: { role: 'assistant', content: 'Done.' }, done: true, prompt_eval_count: 17, eval_count: 8, ...extra });
const stream = (frames, bytes = 0) => {
  const data = new TextEncoder().encode(frames.map(value => JSON.stringify(value)).join('\r\n') + '\n');
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === data.length) { controller.close(); return; }
    const size = bytes || data.length;
    controller.enqueue(data.slice(offset, offset + size)); offset = Math.min(data.length, offset + size);
  } }), { headers: { 'content-type': 'application/x-ndjson' } });
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('native NDJSON works without a key, decodes fragmented UTF-8, separates thinking and reports exact final usage', async () => {
  const text = [], progress = [];
  const reply = await requestModel(options({ onTextDelta: value => text.push(value), onProgress: value => progress.push(value),
    modelCapabilities: { contextWindow: 8192, supportsTools: true, ollamaThinkingValues: [false, true], reasoningEfforts: ['none', 'enabled'] },
    reasoningEffort: 'enabled', fetchImpl: async (url, init) => {
      assert.equal(url, 'http://localhost:11434/api/chat'); assert.equal(init.redirect, 'error');
      assert.equal(Object.hasOwn(init.headers, 'Authorization'), false);
      const body = JSON.parse(init.body);
      assert.equal(body.think, true); assert.equal(body.options.num_ctx, 8192);
      assert.equal(body.tools[0].function.name, 'read_file'); assert.equal(body.stream, true);
      return stream([{ message: { role: 'assistant', thinking: 'PRIVATE_THINKING' }, done: false },
        { message: { role: 'assistant', content: '你好 🌿' }, done: false }, complete({ message: { role: 'assistant', content: '' }, prompt_eval_cached_count: 5 })], 1);
    },
  }));
  assert.equal(text.join(''), '你好 🌿'); assert.equal(JSON.stringify(text).includes('PRIVATE_THINKING'), false);
  assert.equal(reply.message.providerState.message.thinking, 'PRIVATE_THINKING');
  assert.deepEqual(reply.usage, { inputTokens: 17, outputTokens: 8, cachedInputTokens: 5 }); assert.equal(reply.usageReported, true);
  assert.ok(progress.some(value => value.phase === 'thinking')); assert.equal(progress.at(-1).usage.outputTokens, 8);
});

test('native tool IDs correlate with tool_name replay, object arguments, private thinking and images', async () => {
  const first = await requestModel(options({ fetchImpl: async () => stream([
    { message: { role: 'assistant', thinking: 'private continuation', tool_calls: [{ type: 'function', function: { index: 0, name: 'read_file', arguments: { path: 'a.txt' } } }] }, done: false },
    complete({ message: { role: 'assistant', content: '' } }),
  ]) }));
  const call = first.message.toolCalls[0]; assert.match(call.id, /^ollama-/);
  const messages = [{ role: 'user', content: 'Inspect image.', attachments: [{ id: 'image', name: 'a.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` }] },
    first.message, { role: 'tool', content: 'contents', toolCallId: call.id }];
  const original = structuredClone(messages);
  await requestModel(options({ messages, apiKey: 'optional-fixture-credential', baseUrl: 'http://ollama.company.example:11434/proxy',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://ollama.company.example:11434/proxy/api/chat'); assert.equal(init.headers.Authorization, 'Bearer optional-fixture-credential');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.messages[0].images, [png]);
      assert.equal(body.messages[1].thinking, undefined, 'A different endpoint cannot replay old thinking');
      assert.deepEqual(body.messages[1].tool_calls[0].function.arguments, { path: 'a.txt' });
      assert.deepEqual(body.messages[2], { role: 'tool', tool_name: 'read_file', content: 'contents' });
      return json(complete());
    },
  }));
  await requestModel(options({ messages, fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).messages[1].thinking, 'private continuation'); return json(complete());
  } }));
  assert.deepEqual(messages, original);
});

test('thinking values require explicit capability metadata and use exact boolean or named controls', async () => {
  for (const [effort, values, expected] of [['none', [false, true], false], ['enabled', [false, true], true], ['high', ['low', 'high'], 'high']]) {
    await requestModel(options({ reasoningEffort: effort, modelCapabilities: { ollamaThinkingValues: values }, fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).think, expected); return json(complete());
    } }));
  }
  await requestModel(options({ fetchImpl: async (_url, init) => { assert.equal(Object.hasOwn(JSON.parse(init.body), 'think'), false); return json(complete()); } }));
  await assert.rejects(requestModel(options({ reasoningEffort: 'enabled', fetchImpl: () => assert.fail('No unsupported request') })), { code: 'INVALID_REASONING_EFFORT' });
});

test('chat-only models can serve text requests but embedding and no-tool models cannot enter the coding tool loop', async () => {
  const capabilities = { compatible: false, textCompatible: true, supportsTools: false, reasoningEfforts: [] };
  await requestModel(options({ tools: [], modelCapabilities: capabilities, fetchImpl: async () => json(complete()) }));
  await assert.rejects(requestModel(options({ modelCapabilities: capabilities, fetchImpl: () => assert.fail('Cannot send tools') })), { code: 'MODEL_INCOMPATIBLE' });
  await assert.rejects(requestModel(options({ tools: [], modelCapabilities: { ...capabilities, textCompatible: false }, fetchImpl: () => assert.fail('No embeddings chat') })), { code: 'MODEL_INCOMPATIBLE' });
});

test('missing usage remains null and truncated or length-limited streams do not yield executable tool calls', async () => {
  const unknown = await requestModel(options({ fetchImpl: async () => json({ message: { role: 'assistant', content: 'ok' }, done: true }) }));
  assert.equal(unknown.usageReported, false); assert.deepEqual(unknown.usage, { inputTokens: null, outputTokens: null });
  await assert.rejects(requestModel(options({ fetchImpl: async () => stream([{ message: { role: 'assistant', content: 'partial' }, done: false }]) })), { code: 'PROVIDER_INCOMPLETE_STREAM' });
  await assert.rejects(requestModel(options({ fetchImpl: async () => json(complete({ done_reason: 'length' })) })), { code: 'PROVIDER_INCOMPLETE_RESPONSE' });
});

test('invalid arguments anywhere in a native batch fail before any workspace tool is executed', async () => {
  let executions = 0;
  await assert.rejects(runAgent({ config: { provider: 'ollama', model: 'fixture' }, messages: [{ role: 'user', content: 'Inspect.' }],
    workspace: { root: 'C:/fixture', execute: async () => { executions++; } }, toolDefinitions: tools,
    signal: new AbortController().signal, emit: () => {}, requestModel: value => requestModel({ ...value, fetchImpl: async () => json(complete({
      message: { role: 'assistant', tool_calls: [
        { function: { name: 'read_file', arguments: { path: 'valid.txt' } } },
        { function: { name: 'read_file', arguments: '{invalid JSON' } },
      ] },
    })) }),
  }), { code: 'INVALID_TOOL_ARGUMENTS' });
  assert.equal(executions, 0);
});

test('response, event and generated-payload limits apply to native streams', async () => {
  for (const [limits, code] of [[{ maxResponseBytes: 20 }, 'PROVIDER_RESPONSE_TOO_LARGE'], [{ maxEventBytes: 20 }, 'PROVIDER_EVENT_TOO_LARGE'],
    [{ maxModelPayloadBytes: 70 }, 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE']]) {
    await assert.rejects(requestModel(options({ ...limits, fetchImpl: async () => stream([complete({ message: { role: 'assistant', content: 'X'.repeat(300) } })]) })), { code });
  }
});

test('native request cancellation and idle timeout also stop stalled transports', async () => {
  let signal;
  await assert.rejects(requestModel(options({ timeoutMs: 25, fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } })), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(signal.aborted, true);
  const controller = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = requestModel(options({ signal: controller.signal, fetchImpl: async () => { entered(); return new Promise(() => {}); } }));
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

test('HTTP and NDJSON errors provide bounded sanitized Ollama diagnostics without leaking optional credentials', async () => {
  const key = 'ollama-synthetic-secret';
  for (const response of [() => json({ error: `model does not support tools; key=${key}` }, 400),
    () => stream([{ error: `model not found key=${key}`, done: true }])]) {
    await assert.rejects(requestModel(options({ apiKey: key, fetchImpl: async () => response() })), error => {
      assert.match(error.message, /does not support tools|model not found/); assert.equal(error.message.includes(key), false); return true;
    });
  }
  await assert.rejects(requestModel(options({ apiKey: key, fetchImpl: async () => json(complete({ message: { role: 'assistant', content: key } })) })), { code: 'PROVIDER_SECRET_IN_RESPONSE' });
});

test('Ollama URLs allow explicitly configured HTTP hosts while rejecting ambiguous or credential-bearing addresses', async () => {
  assert.equal(ollamaEndpoint().href, 'http://localhost:11434/api/chat');
  for (const address of ['http://192.168.1.20:11434', 'http://ollama.company.example:11434', 'http://[fd00::1]:11434/api', 'https://example.test/proxy/api/chat'])
    assert.match(ollamaEndpoint(address, 'tags').href, /\/api\/tags$/);
  for (const address of ['ftp://localhost', 'http://user:pass@localhost', 'http://localhost?key=x', 'http://localhost/#x',
    'http://localhost/../x', 'http://localhost/%2e%2e/x', 'http://localhost/%2fkey', 'http://localhost\n', 'http://localhost/v1', 'http:\\localhost'])
    assert.throws(() => ollamaEndpoint(address), { code: 'INVALID_BASE_URL' });
  await assert.rejects(requestModel({ ...options({}), provider: 'relay', apiKey: 'fixture', baseUrl: 'http://ollama.company.example', fetchImpl: () => assert.fail('Other providers stay strict') }), { code: 'INVALID_BASE_URL' });
});
