import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGeminiModel } from '../src/core/gemini-provider.mjs';

const secret = 'gemini-fixture-secret-1234';
const model = 'gemini-3.8-flash';
const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } },
  required: ['path'], additionalProperties: false } }, { name: 'search_files', description: 'Search', parameters: { type: 'object', properties: {} } }];
const prompt = [{ role: 'system', content: 'Chinese instructions.' }, { role: 'user', content: 'Read one.txt.' }];
const options = extra => ({ provider: 'gemini', apiKey: secret, model, messages: prompt, tools, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const answer = (parts = [{ text: 'Hello 世界' }], extra = {}) => ({ candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 10, thoughtsTokenCount: 5 }, ...extra });
const sse = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
function streamResponse(events, { sizes = [1, 2, 3, 5, 11], ending = '', onCancel } = {}) {
  const data = Buffer.from(events.map(value => typeof value === 'string' ? value : sse(value)).join('') + ending);
  let index = 0, step = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index >= data.length) { controller.close(); return; }
    const end = Math.min(data.length, index + sizes[step++ % sizes.length]); controller.enqueue(data.subarray(index, end)); index = end;
  }, cancel: onCancel }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function fixture(extra = {}, response = () => Response.json(answer())) {
  const calls = [], deltas = [], progress = [];
  return { calls, deltas, progress, request: value => requestGeminiModel(options({
    fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return response(url, init); },
    onTextDelta: value => deltas.push(value), onProgress: value => progress.push(value), ...extra, ...value })) };
}

test('the native endpoint keeps credentials in the API-key header, emits system instructions and preserves full JSON schemas', async () => {
  const f = fixture(), result = await f.request();
  const sent = f.calls[0];
  assert.equal(sent.url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`);
  assert.equal(sent.init.redirect, 'error'); assert.equal(sent.init.headers['x-goog-api-key'], secret);
  assert.equal(Object.hasOwn(sent.init.headers, 'Authorization'), false); assert.doesNotMatch(sent.url, /key=|secret/);
  assert.deepEqual(sent.body.systemInstruction, { parts: [{ text: 'Chinese instructions.' }] });
  assert.deepEqual(sent.body.contents, [{ role: 'user', parts: [{ text: 'Read one.txt.' }] }]);
  assert.deepEqual(sent.body.tools[0].functionDeclarations[0], { name: 'read_file', description: tools[0].description, parametersJsonSchema: tools[0].parameters });
  assert.equal(Object.hasOwn(sent.body.tools[0].functionDeclarations[0], 'parameters'), false);
  assert.equal(Object.hasOwn(sent.body, 'generationConfig'), false, 'Do not invent an unrelated default output cutoff');
  assert.equal(result.message.content, 'Hello 世界'); assert.deepEqual(result.message.toolCalls, []);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 15, cachedInputTokens: 30 });
  assert.equal(result.usageReported, true); assert.deepEqual(result.contextUsage, { inputTokens: 100, outputTokens: 15, complete: true });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('non-streaming generateContent, native base paths and a models/ model name use the same canonical native state scope', async () => {
  for (const baseUrl of [undefined, 'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta/', 'https://generativelanguage.googleapis.com/v1beta/models']) {
    const f = fixture({ stream: false, model: `models/${model}`, baseUrl }); await f.request();
    assert.equal(f.calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  }
  const local = fixture({ baseUrl: 'http://127.0.0.1:8080/custom/v1beta' }); await local.request();
  assert.match(local.calls[0].url, /^http:\/\/127\.0\.0\.1:8080\/custom\/v1beta\/models\//u);
});

test('parallel calls and their signed native parts round-trip in order, including an optional Gemini function call ID', async () => {
  const native = [{ text: '读取两个文件。' }, { functionCall: { id: 'server-call-1', name: 'read_file', args: { path: 'one.txt' } }, thoughtSignature: 'signature-one==' },
    { functionCall: { name: 'search_files', args: { query: '你好' } } }];
  let index = 0;
  const f = fixture({}, () => Response.json(answer(index++ === 0 ? native : [{ text: '已读取。' }])));
  const first = await f.request();
  assert.equal(first.message.toolCalls[0].id, 'server-call-1'); assert.match(first.message.toolCalls[1].id, /^gemini-[a-f\d-]{36}$/u);
  const messages = [...prompt, first.message, ...first.message.toolCalls.map(call => ({ role: 'tool', toolCallId: call.id, content: `result-${call.name}` }))];
  const before = structuredClone(messages); await f.request({ messages });
  assert.deepEqual(messages, before, 'No mutation of the persisted message or signatures');
  assert.deepEqual(f.calls[1].body.contents[1], { role: 'model', parts: native });
  assert.deepEqual(f.calls[1].body.contents[2], { role: 'user', parts: [
    { functionResponse: { id: 'server-call-1', name: 'read_file', response: { output: 'result-read_file' } } },
    { functionResponse: { name: 'search_files', response: { output: 'result-search_files' } } },
  ] });
  assert.equal(f.calls[1].body.contents[1].parts[1].thoughtSignature, native[1].thoughtSignature);
  assert.equal(Object.hasOwn(f.calls[1].body.contents[1].parts[2], 'thoughtSignature'), false);
});

test('arbitrarily split UTF-8/SSE chunks retain private thought parts and standalone empty-text signature carriers without exposing thoughts', async () => {
  const chunks = [': heartbeat\r\n\r\n', { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'PRIVATE_THOUGHT', thought: true, thoughtSignature: 'thought-signature' }] } }] },
    { candidates: [{ content: { parts: [{ text: '你好' }] } }] }, { candidates: [{ content: { parts: [{ text: '🌊世界' }] } }] },
    { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'empty-carrier-signature' }] }, finishReason: 'STOP' }] },
    { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, thoughtsTokenCount: 12, cachedContentTokenCount: 10 } }];
  const f = fixture({}, () => streamResponse(chunks));
  const result = await f.request();
  assert.equal(result.message.content, '你好🌊世界'); assert.equal(f.deltas.join(''), result.message.content);
  assert.doesNotMatch(f.deltas.join(''), /PRIVATE_THOUGHT/);
  assert.deepEqual(result.message.providerState.content.parts, [
    { text: 'PRIVATE_THOUGHT', thought: true, thoughtSignature: 'thought-signature' }, { text: '你好' }, { text: '🌊世界' },
    { text: '', thoughtSignature: 'empty-carrier-signature' },
  ]);
  assert.ok(f.progress.some(value => value.phase === 'thinking'));
  assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 20, cachedInputTokens: 10 });
  const next = fixture(); await next.request({ messages: [...prompt, result.message, { role: 'user', content: '继续' }] });
  assert.deepEqual(next.calls[0].body.contents[1].parts, result.message.providerState.content.parts);
});

test('tool calls are withheld until a genuine successful terminal event and cannot execute after MAX_TOKENS or another incomplete ending', async () => {
  for (const reason of ['MAX_TOKENS', 'CONTINUATION', 'MALFORMED_FUNCTION_CALL', 'MISSING_THOUGHT_SIGNATURE', 'SAFETY', null]) {
    const f = fixture({}, () => streamResponse([{ usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 3, thoughtsTokenCount: 6 },
      candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'one.txt' } }, thoughtSignature: 'signature' }] },
        ...(reason ? { finishReason: reason } : {}) }] }]));
    await assert.rejects(f.request(), { code: ['MAX_TOKENS', 'CONTINUATION'].includes(reason) ? 'PROVIDER_TRUNCATED' : reason ? 'PROVIDER_CONTENT_BLOCKED' : 'PROVIDER_INCOMPLETE_STREAM' });
    assert.ok(f.progress.some(sample => sample.usage?.inputTokens === 18 && sample.usage?.outputTokens === 9));
  }
});

test('usage samples replace cumulative counts and never double-count cached inputs or thoughts', async () => {
  const f = fixture({}, () => streamResponse([
    { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2, thoughtsTokenCount: 5, cachedContentTokenCount: 40 }, candidates: [{ content: { parts: [{ text: 'A' }] } }] },
    { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 12, cachedContentTokenCount: 40 }, candidates: [{ content: { parts: [{ text: 'B' }] }, finishReason: 'STOP' }] },
  ]));
  const result = await f.request(); assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 19, cachedInputTokens: 40 });
  assert.deepEqual(result.contextUsage, { inputTokens: 100, outputTokens: 19, complete: true });
  for (const [usageMetadata, expectedReported, expectedOutput] of [[undefined, false, null], [{}, false, null],
    [{ promptTokenCount: 5 }, false, null], [{ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 }, true, 0],
    [{ promptTokenCount: 3, thoughtsTokenCount: 8 }, true, 8]]) {
    const sample = fixture({}, () => Response.json(answer(undefined, { usageMetadata }))), value = await sample.request();
    assert.equal(value.usageReported, expectedReported); assert.equal(value.usage.outputTokens, expectedOutput);
  }
  const builtin = fixture({}, () => Response.json(answer(undefined, { usageMetadata: {
    promptTokenCount: 30, toolUsePromptTokenCount: 7, cachedContentTokenCount: 10, thoughtsTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 48,
  } })));
  assert.deepEqual((await builtin.request()).usage, { inputTokens: 37, outputTokens: 11, cachedInputTokens: 10 });
});

test('inline image inputs use normalized MIME/data only and preserve attachments in local history', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
  const attachments = [{ id: 'image-1', name: 'one.png', dataUrl: `data:image/png;base64,${png}`, extra: 'LOCAL_ONLY' }];
  const messages = [{ role: 'user', content: '看图', attachments }], before = structuredClone(messages);
  const f = fixture(); await f.request({ messages });
  assert.deepEqual(f.calls[0].body.contents[0].parts, [{ text: '看图' }, { inlineData: { mimeType: 'image/png', data: png } }]);
  assert.deepEqual(messages, before); assert.doesNotMatch(f.calls[0].init.body, /image-1|one\.png|LOCAL_ONLY/);
  await assert.rejects(f.request({ messages, modelCapabilities: { supportsImages: false } }), { code: 'MODEL_IMAGES_UNSUPPORTED' });
  assert.equal(f.calls.length, 1);
});

test('native parts cannot be replayed across a key, profile, connection, model, endpoint or authentication mode change', async () => {
  const f = fixture({ connectionKey: 'scope-a', geminiProfileId: 'profile-a' });
  const first = await f.request();
  for (const patch of [{ apiKey: 'another-private-key' }, { geminiProfileId: 'profile-b' }, { connectionKey: 'scope-b' }, { model: 'gemini-other' },
    { baseUrl: 'https://relay.example/v1beta' }, { authMode: 'google-oauth', googleProjectId: 'project-test' }]) {
    await assert.rejects(f.request({ ...patch, messages: [...prompt, first.message, { role: 'user', content: 'next' }] }), { code: 'GEMINI_NATIVE_STATE_MISMATCH' });
  }
  assert.equal(f.calls.length, 1);
});

test('mutating a native visible projection, function argument or binding is rejected before sending a forged signed replay', async () => {
  const f = fixture({}, () => Response.json(answer([{ text: '读取。' }, { functionCall: { id: 'native-id', name: 'read_file', args: { path: 'one.txt' } }, thoughtSignature: 'opaque-signature' }])));
  const first = await f.request();
  for (const mutate of [message => { message.content = 'changed'; }, message => { message.toolCalls[0].arguments.path = 'other.txt'; },
    message => { message.providerState.binding = 'forged'; }, message => { message.providerState.toolBindings[0].partIndex = 0; },
    message => { message.providerState.content.parts[1].functionCall.id = 'other-id'; }]) {
    const message = structuredClone(first.message); mutate(message);
    await assert.rejects(f.request({ messages: [...prompt, message, { role: 'tool', toolCallId: message.toolCalls[0].id, content: 'result' }] }), { code: 'GEMINI_NATIVE_STATE_MISMATCH' });
  }
  assert.equal(f.calls.length, 1);
});

test('unsigned legacy internal calls can be projected but no signatures are invented or copied from another provider', async () => {
  const f = fixture(); await f.request({ messages: [...prompt,
    { role: 'assistant', content: '', toolCalls: [{ id: 'local-id', name: 'read_file', arguments: { path: 'one.txt' } }],
      providerState: { provider: 'anthropic', content: [{ type: 'thinking', signature: 'OTHER_PROVIDER_SIGNATURE' }] } },
    { role: 'tool', toolCallId: 'local-id', content: '{"ok":true}' }] });
  assert.deepEqual(f.calls[0].body.contents[1], { role: 'model', parts: [{ functionCall: { id: 'local-id', name: 'read_file', args: { path: 'one.txt' } } }] });
  assert.deepEqual(f.calls[0].body.contents[2].parts[0].functionResponse.response, { output: '{"ok":true}' });
  assert.doesNotMatch(f.calls[0].init.body, /OTHER_PROVIDER_SIGNATURE|skip_thought_signature_validator/);
});

test('invalid and incomplete parallel tool histories fail before any network dispatch', async () => {
  const f = fixture(), assistant = { role: 'assistant', content: '', toolCalls: [
    { id: 'one', name: 'read_file', arguments: {} }, { id: 'two', name: 'search_files', arguments: {} }] };
  for (const suffix of [[{ role: 'tool', toolCallId: 'unknown', content: 'x' }], [assistant],
    [assistant, { role: 'tool', toolCallId: 'one', content: 'x' }, { role: 'user', content: 'interrupt' }],
    [assistant, { role: 'tool', toolCallId: 'one', content: 'x' }, { role: 'tool', toolCallId: 'one', content: 'duplicate' }]]) {
    await assert.rejects(f.request({ messages: [...prompt, ...suffix] }), { code: 'INVALID_MODEL_INPUT' });
  }
  assert.equal(f.calls.length, 0);
});

test('unregistered, duplicate, malformed or partially streamed function arguments never become executable calls', async () => {
  for (const parts of [[{ functionCall: { name: 'not_provided', args: {} } }], [{ functionCall: { name: 'read_file', args: '{"path":' } }],
    [{ functionCall: { id: 'same', name: 'read_file', args: {} } }, { functionCall: { id: 'same', name: 'read_file', args: {} } }],
    [{ functionCall: { name: 'read_file', args: [] } }], [{ functionCall: { name: 'read_file', args: {}, partialArgs: [] } }]]) {
    const f = fixture({}, () => Response.json(answer(parts))); await assert.rejects(f.request(), { code: 'INVALID_TOOL_CALL' });
  }
});

test('output limits use explicit caller budget clamped to catalog capacity while thinking overrides require verified metadata', async () => {
  const f = fixture({ maxOutputTokens: 5000, modelCapabilities: { maxOutputTokens: 2048, geminiThinkingLevels: ['low', 'high'] }, reasoningEffort: 'low' });
  await f.request(); assert.deepEqual(f.calls[0].body.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
  for (const reasoningEffort of ['none', 'max', 'invented', 'medium']) await assert.rejects(f.request({ reasoningEffort }), { code: 'INVALID_REASONING_EFFORT' });
  const unknown = fixture({ reasoningEffort: 'high' }); await assert.rejects(unknown.request(), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(unknown.calls.length, 0);
  await f.request({ reasoningEffort: 'default', maxOutputTokens: 256 }); assert.deepEqual(f.calls[1].body.generationConfig, { maxOutputTokens: 256 });
});

test('optional API OAuth bearer/quota headers are isolated from API keys and forbidden on a custom endpoint', async () => {
  const f = fixture({ authMode: 'google-oauth', googleProjectId: 'my-project-123', geminiProfileId: 'account-a' }); await f.request();
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${secret}`); assert.equal(f.calls[0].init.headers['x-goog-user-project'], 'my-project-123');
  assert.equal(Object.hasOwn(f.calls[0].init.headers, 'x-goog-api-key'), false);
  await assert.rejects(f.request({ baseUrl: 'https://relay.example/v1beta' }), { code: 'INVALID_GEMINI_ACCOUNT_BASE_URL' });
  await assert.rejects(f.request({ googleProjectId: 'project\r\nX-Secret: leak' }), { code: 'INVALID_MODEL_CONFIG' });
  await assert.rejects(f.request({ authMode: 'gemini-account' }), { code: 'INVALID_AUTH_MODE' });
  assert.equal(f.calls.length, 1);
});

test('sensitive HTTP/network details and callback errors never reflect credentials or arbitrary provider payloads', async () => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    let cancelled = false;
    const f = fixture({}, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('RAW_PRIVATE_BODY ' + secret)); }, cancel() { cancelled = true; } }),
      { status, headers: { 'retry-after': '3' } }));
    await assert.rejects(f.request(), error => {
      assert.equal(error.code, `PROVIDER_HTTP_${status}`); assert.equal(error.retryAfterMs, 3000);
      assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /RAW_PRIVATE_BODY|gemini-fixture-secret/); return true;
    }); await tick(); assert.equal(cancelled, true);
  }
  const f = fixture({ fetchImpl: () => { throw new Error('NETWORK_PRIVATE ' + secret); } });
  await assert.rejects(f.request(), error => error.code === 'PROVIDER_NETWORK_ERROR' && !error.message.includes(secret));
  const callback = fixture({ onTextDelta: () => { throw new Error('CALLBACK_PRIVATE ' + secret); } });
  await assert.rejects(callback.request(), error => error.code === 'PROVIDER_CALLBACK_ERROR' && error.retryable === false && !error.message.includes(secret));
});

test('credential echoes split across arbitrary text fragments never enter visible deltas or persisted native state', async () => {
  const f = fixture({}, () => streamResponse([
    { candidates: [{ content: { parts: [{ text: 'prefix: ' + secret.slice(0, 10) }] } }] },
    { candidates: [{ content: { parts: [{ text: secret.slice(10) }] }, finishReason: 'STOP' }] },
  ]));
  await assert.rejects(f.request(), { code: 'PROVIDER_SECRET_IN_RESPONSE' });
  assert.equal(f.deltas.join(''), 'prefix: '); assert.doesNotMatch(f.deltas.join(''), /gemini-fixt/);
  const privateThought = fixture({}, () => Response.json(answer([{ text: secret.slice(0, 9), thought: true }, { text: secret.slice(9), thought: true }])));
  await assert.rejects(privateThought.request(), { code: 'PROVIDER_SECRET_IN_RESPONSE' }); assert.deepEqual(privateThought.deltas, []);
});

test('a cancelled fetch that ignores abort settles promptly and cancels its eventual late response without emitting text', async () => {
  const held = deferred(), controller = new AbortController(); let requestSignal, cancelled = false;
  const f = fixture({ signal: controller.signal, fetchImpl: (_url, init) => { requestSignal = init.signal; return held.promise; } });
  const pending = f.request(), rejected = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' }); await tick(); controller.abort(); await rejected;
  assert.equal(requestSignal.aborted, true);
  held.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }))); await tick();
  assert.equal(cancelled, true); assert.deepEqual(f.deltas, []);
});

test('idle timeouts and cancellation interrupt a hanging body read without awaiting stuck cancel cleanup', async () => {
  for (const kind of ['timeout', 'stop']) {
    const parent = new AbortController(); let cancelled = false;
    const f = fixture({ signal: parent.signal, timeoutMs: kind === 'timeout' ? 10 : 1000 }, () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(': heartbeat\n\n')); }, cancel() { cancelled = true; return new Promise(() => {}); },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const pending = f.request(); const rejected = assert.rejects(pending, kind === 'timeout' ? { code: 'PROVIDER_TIMEOUT' } : { name: 'AbortError' });
    if (kind === 'stop') { await tick(); parent.abort(); } await rejected;
    assert.equal(cancelled, true); assert.deepEqual(f.deltas, []);
  }
});

test('real wire heartbeats refresh inactivity timeouts without being misreported as generated text or billable usage', async () => {
  const f = fixture({ timeoutMs: 40 }, () => {
    let index = 0, timer;
    return new Response(new ReadableStream({ start(controller) {
      timer = setInterval(() => {
        if (index++ < 4) controller.enqueue(Buffer.from(': still connected\n\n'));
        else { clearInterval(timer); controller.enqueue(Buffer.from(sse(answer()))); controller.close(); }
      }, 15);
    }, cancel() { clearInterval(timer); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const result = await f.request(); assert.equal(result.message.content, 'Hello 世界');
  assert.equal(f.deltas.join(''), result.message.content); assert.equal(result.usage.inputTokens, 100);
});

test('JSON/SSE wire bytes, event lines, retained native parts and malformed encodings are independently bounded', async () => {
  for (const [extra, response, code] of [
    [{ maxResponseBytes: 80 }, () => Response.json(answer([{ text: 'x'.repeat(500) }])), 'PROVIDER_RESPONSE_TOO_LARGE'],
    [{ maxEventBytes: 80 }, () => streamResponse([answer([{ text: 'x'.repeat(500) }])]), 'PROVIDER_EVENT_TOO_LARGE'],
    [{ maxModelPayloadBytes: 100 }, () => Response.json(answer([{ text: 'x'.repeat(500) }])), 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE'],
    [{}, () => new Response('data: {invalid}\n\n', { headers: { 'content-type': 'text/event-stream' } }), 'PROVIDER_INVALID_JSON'],
    [{}, () => new Response(Buffer.from([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }), 'PROVIDER_INVALID_ENCODING'],
  ]) {
    const f = fixture(extra, response); await assert.rejects(f.request(), { code });
  }
});

test('unsafe URLs, path-injecting model identifiers and malformed capability/input shapes fail before dispatch', async () => {
  const f = fixture();
  for (const baseUrl of ['https://user:password@example.com/v1beta', 'http://remote.example/v1beta', 'https://example.com/v1beta?key=secret',
    'https://example.com/v1beta#fragment', 'https://example.com/v1beta/models/x:generateContent', 'https://example.com/%2fother'])
    await assert.rejects(f.request({ baseUrl }), { code: 'INVALID_BASE_URL' });
  for (const patch of [{ model: '../evil?key=x' }, { apiKey: 'key\nheader' }, { timeoutMs: 0 }, { maxResponseBytes: Infinity }, { stream: 'yes' }])
    await assert.rejects(f.request(patch), { code: 'INVALID_MODEL_CONFIG' });
  await assert.rejects(f.request({ tools: [tools[0], tools[0]] }), { code: 'INVALID_MODEL_INPUT' });
  await assert.rejects(f.request({ tools: 'invalid' }), { code: 'INVALID_MODEL_INPUT' });
  await assert.rejects(f.request({ modelCapabilities: { supportsTools: false } }), { code: 'MODEL_TOOLS_UNSUPPORTED' });
  for (const modelCapabilities of [{ supportsImages: 'yes' }, { maxOutputTokens: -1 }, { geminiThinkingLevels: 'high' }, { geminiThinkingLevels: ['invented'] }])
    await assert.rejects(f.request({ modelCapabilities }), { code: 'INVALID_MODEL_CONFIG' });
  assert.equal(f.calls.length, 0);
});
