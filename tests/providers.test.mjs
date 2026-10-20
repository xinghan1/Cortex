import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { requestModel } from '../src/core/providers.mjs';
import { ModelCatalog, deriveModelCapabilities } from '../src/core/model-catalog.mjs';

const model = 'user-selected-model';
const apiKey = 'test-secret-key-do-not-print';
const tools = [{ name: 'read_file', description: 'Read a project file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} }];
const history = [
  { role: 'system', content: 'Act as a project assistant.' },
  { role: 'user', content: 'Read hello.txt' },
  { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'previous-call', name: 'read_file', arguments: { path: 'hello.txt' } }] },
  { role: 'tool', content: 'hello', toolCallId: 'previous-call' },
  { role: 'user', content: 'Now read next.txt' },
];

async function localServer(t, handler) {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    try { await handler({ request, response, body: JSON.parse(raw) }); }
    catch (error) { response.destroy(error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function sse(data, eventName, separator = '\n') {
  return `${eventName ? `event: ${eventName}${separator}` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}${separator}${separator}`;
}

async function sendFragments(response, source, sizes = [1, 2, 5, 3, 11]) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const bytes = Buffer.from(source);
  let offset = 0;
  let index = 0;
  while (offset < bytes.length && !response.destroyed) {
    const size = sizes[index++ % sizes.length];
    response.write(bytes.subarray(offset, offset + size));
    offset += size;
    await new Promise(resolve => setImmediate(resolve));
  }
  response.end();
}

function options(baseUrl, extra = {}) {
  return { provider: 'openai', apiKey, model, baseUrl, messages: history, tools, ...extra };
}

test('Responses cache details remain an input subset and reasoning output is not added twice', async t => {
  const base = await localServer(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 15 } } }));
  });
  const result = await requestModel(options(base));
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
});

test('Chat Completions accepts nested cache details and rejects invalid cache counters', async t => {
  for (const cached of [0, 40, 101, -1, '40']) {
    const base = await localServer(t, ({ response }) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: cached } } }));
    });
    const result = await requestModel(options(base, { apiProtocol: 'chat-completions' }));
    assert.equal(result.usage.cachedInputTokens, [0, 40].includes(cached) ? cached : undefined);
  }
});

test('OpenAI maps history and assembles UTF-8/CRLF SSE fragments', async t => {
  let captured;
  const base = await localServer(t, async input => {
    captured = input;
    const events = [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' 👋' },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc-internal-id', type: 'function_call', call_id: 'call-public-id', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc-internal-id', delta: '{"pa' },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc-internal-id', delta: 'th":"next.txt"}' },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"next.txt"}' },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'fc-internal-id', type: 'function_call', call_id: 'call-public-id', name: 'read_file', arguments: '{"path":"next.txt"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 42, output_tokens: 9 }, output: [
        { type: 'message', content: [{ type: 'output_text', text: '你好 👋' }] },
        { type: 'function_call', call_id: 'call-public-id', name: 'read_file', arguments: '{"path":"next.txt"}' },
      ] } },
    ];
    await sendFragments(input.response, ': keep alive\r\n\r\n' + events.map(event => sse(event, event.type, '\r\n')).join(''));
  });
  const deltas = [];
  const result = await requestModel(options(`${base}/proxy/v1/`, { onTextDelta: delta => deltas.push(delta) }));
  assert.equal(captured.request.url, '/proxy/v1/responses');
  assert.equal(captured.request.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(captured.body.model, model);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.store, false);
  assert.deepEqual(captured.body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(captured.body.input[3], { type: 'function_call', call_id: 'previous-call', name: 'read_file', arguments: '{"path":"hello.txt"}' });
  assert.deepEqual(captured.body.input[4], { type: 'function_call_output', call_id: 'previous-call', output: 'hello' });
  assert.deepEqual(captured.body.tools[0], { type: 'function', ...tools[0], strict: false });
  assert.equal(result.message.content, '你好 👋');
  assert.deepEqual(deltas, ['你好', ' 👋']);
  assert.deepEqual(result.message.toolCalls, [{ id: 'call-public-id', name: 'read_file', arguments: { path: 'next.txt' } }]);
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 9 });
});

test('DeepSeek maps tool history and merges interleaved call fragments', async t => {
  let captured;
  const base = await localServer(t, async input => {
    captured = input;
    const chunks = [
      { choices: [{ index: 0, delta: { content: 'Reading', reasoning_content: 'private thinking' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
        { index: 1, id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"two' } },
      ] } }] },
      { choices: [{ index: 0, delta: { content: ' files', tool_calls: [
        { index: 1, function: { arguments: '.txt"}' } }, { index: 0, function: { arguments: '"one.txt"}' } },
      ] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 10 } },
    ];
    await sendFragments(input.response, chunks.map(value => sse(value)).join('') + sse('[DONE]'));
  });
  const deltas = [];
  const result = await requestModel(options(`${base}/v1/chat/completions`, { provider: 'deepseek', onTextDelta: value => deltas.push(value) }));
  assert.equal(captured.request.url, '/v1/chat/completions');
  assert.deepEqual(captured.body.messages[2].tool_calls[0], { id: 'previous-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } });
  assert.deepEqual(captured.body.messages[3], { role: 'tool', content: 'hello', tool_call_id: 'previous-call' });
  assert.deepEqual(captured.body.tools, [{ type: 'function', function: tools[0] }]);
  assert.equal(captured.body.thinking, undefined);
  assert.equal(captured.body.reasoning_effort, undefined);
  assert.deepEqual(captured.body.stream_options, { include_usage: true });
  assert.equal(result.message.content, 'Reading files');
  assert.deepEqual(deltas, ['Reading', ' files']);
  assert.deepEqual(result.message.toolCalls, [
    { id: 'call-1', name: 'read_file', arguments: { path: 'one.txt' } },
    { id: 'call-2', name: 'read_file', arguments: { path: 'two.txt' } },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 });
});

test('Anthropic maps tool blocks, accumulates JSON and normalizes cached usage', async t => {
  let captured;
  const base = await localServer(t, async input => {
    captured = input;
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在读取' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"你好.txt"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 19 } },
      { type: 'message_stop' },
    ];
    await sendFragments(input.response, events.map(value => sse(value, value.type)).join(''));
  });
  const deltas = [];
  const result = await requestModel(options(`${base}/anthropic/v1`, { provider: 'anthropic', maxOutputTokens: 1024, onTextDelta: value => deltas.push(value) }));
  assert.equal(captured.request.url, '/anthropic/v1/messages');
  assert.equal(captured.request.headers['x-api-key'], apiKey);
  assert.equal(captured.request.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.request.headers.authorization, undefined);
  assert.equal(captured.body.system, history[0].content);
  assert.equal(captured.body.max_tokens, 1024);
  assert.deepEqual(captured.body.tools, [{ name: tools[0].name, description: tools[0].description, input_schema: tools[0].parameters }]);
  assert.deepEqual(captured.body.messages[1].content[1], { type: 'tool_use', id: 'previous-call', name: 'read_file', input: { path: 'hello.txt' } });
  assert.deepEqual(captured.body.messages[2], { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'previous-call', content: 'hello' }, { type: 'text', text: 'Now read next.txt' },
  ] });
  assert.deepEqual(deltas, ['正在读取']);
  const { providerState, ...normalized } = result.message;
  assert.deepEqual(normalized, { role: 'assistant', content: '正在读取', toolCalls: [{ id: 'toolu-1', name: 'read_file', arguments: { path: '你好.txt' } }] });
  assert.equal(providerState.provider, 'anthropic');
  assert.deepEqual(providerState.content[1].input, { path: '你好.txt' });
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 19, cachedInputTokens: 7 });
});

test('custom paths never duplicate v1 or a complete endpoint', async t => {
  const requests = [];
  const base = await localServer(t, ({ request, response, body }) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/responses')) response.end(JSON.stringify({ output: [], usage: {} }));
    else if (request.url.endsWith('/messages')) response.end(JSON.stringify({ content: [], usage: {} }));
    else response.end(JSON.stringify({ choices: [{ message: { content: body.model } }], usage: {} }));
  });
  await requestModel(options(`${base}/v1`));
  await requestModel(options(`${base}/gateway/responses/`));
  await requestModel(options(`${base}/custom/v1/messages`, { provider: 'anthropic' }));
  await requestModel(options(`${base}/other`, { provider: 'deepseek' }));
  assert.deepEqual(requests, ['/v1/responses', '/gateway/responses', '/custom/v1/messages', '/other/chat/completions']);
});

test('rejects insecure, credential-bearing, query and fragment base URLs', async () => {
  for (const baseUrl of [
    'not-a-url', 'http://example.com/v1', 'ftp://localhost/v1', 'https://user:password@example.com/v1',
    'https://@example.com/v1', ' https://@example.com/v1 ', 'https://example.com/v1?token=secret', 'https://example.com/v1?',
    'https://example.com/v1#fragment', 'https://example.com/v1#',
  ]) await assert.rejects(requestModel(options(baseUrl)), error => error.code === 'INVALID_BASE_URL');
});

test('rejects malformed SSE JSON and invalid complete tool JSON', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url.startsWith('/invalid-event/')) response.end('data: {this is invalid}\n\n');
    else response.end(sse({ type: 'response.completed', response: { output: [
      { type: 'function_call', call_id: 'call-bad', name: 'read_file', arguments: '{"path":' },
    ] } }));
  });
  await assert.rejects(requestModel(options(`${base}/invalid-event`)), error => error.code === 'PROVIDER_INVALID_JSON');
  await assert.rejects(requestModel(options(`${base}/invalid-arguments`)), error => error.code === 'INVALID_TOOL_ARGUMENTS');
});

test('all adapters reject array/null or malformed tool arguments', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/responses')) response.end(JSON.stringify({ output: [
      { type: 'function_call', call_id: 'bad', name: 'read_file', arguments: '[]' },
    ] }));
    else if (request.url.endsWith('/messages')) response.end(JSON.stringify({ content: [
      { type: 'tool_use', id: 'bad', name: 'read_file', input: null },
    ] }));
    else response.end(JSON.stringify({ choices: [{ message: { tool_calls: [
      { id: 'bad', type: 'function', function: { name: 'read_file', arguments: 'broken json' } },
    ] } }] }));
  });
  for (const provider of ['openai', 'deepseek', 'anthropic']) {
    await assert.rejects(requestModel(options(base, { provider })), error => error.code === 'INVALID_TOOL_ARGUMENTS');
  }
});

test('rejects incomplete streams and length-truncated tool calls', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url.startsWith('/disconnect/')) response.end(sse({ type: 'response.output_text.delta', delta: 'partial' }));
    else response.end(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) + sse({ type: 'message_stop' }));
  });
  await assert.rejects(requestModel(options(`${base}/disconnect`)), error => error.code === 'PROVIDER_INCOMPLETE_STREAM');
  await assert.rejects(requestModel(options(`${base}/truncated`, { provider: 'anthropic' })), error => error.code === 'PROVIDER_TRUNCATED');
});

test('supports multiline SSE data and non-streaming proxy JSON', async t => {
  const base = await localServer(t, ({ request, response }) => {
    if (request.url.startsWith('/multiline/')) {
      response.setHeader('content-type', 'text/event-stream');
      response.end('event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'gateway fallback' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    }
  });
  assert.equal((await requestModel(options(`${base}/multiline`))).message.content, 'done');
  const result = await requestModel(options(`${base}/json`, { provider: 'deepseek' }));
  assert.equal(result.message.content, 'gateway fallback');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 });
});

test('aborts before request and while a stream is active', async t => {
  let requests = 0;
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const base = await localServer(t, ({ response }) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': connected\n\n');
    started();
  });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(requestModel(options(base, { signal: pre.signal })), error => error.name === 'AbortError');
  assert.equal(requests, 0);
  const active = new AbortController();
  const request = requestModel(options(base, { signal: active.signal }));
  await requestStarted;
  active.abort();
  await assert.rejects(request, error => error.name === 'AbortError' && !error.message.includes(apiKey));
});

test('enforces network inactivity timeout and bounded response size', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url.startsWith('/large/')) response.end('data: ' + 'x'.repeat(1024) + '\n\n');
    else response.write(': hold connection open\n\n');
  });
  await assert.rejects(requestModel(options(`${base}/timeout`, { timeoutMs: 30 })), error => error.code === 'PROVIDER_TIMEOUT'
    && error.message.includes('未收到网络数据'));
  await assert.rejects(requestModel(options(`${base}/large`, { maxResponseBytes: 64 })), error => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('HTTP failures and redirects never expose keys or upstream bodies', async t => {
  let redirectedRequest = false;
  const base = await localServer(t, ({ request, response }) => {
    if (request.url.startsWith('/redirect/')) {
      response.writeHead(302, { location: '/must-not-follow/responses' });
      response.end();
    } else if (request.url.startsWith('/must-not-follow/')) {
      redirectedRequest = true;
      response.end('{}');
    } else {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `reflected secret: ${apiKey}` } }));
    }
  });
  await assert.rejects(requestModel(options(base)), error => error.code === 'PROVIDER_HTTP_401' && !error.message.includes(apiKey));
  await assert.rejects(requestModel(options(`${base}/redirect`)), error => error.code === 'PROVIDER_NETWORK_ERROR' && !error.message.includes(apiKey));
  assert.equal(redirectedRequest, false);
});

test('requires explicit model and valid normalized messages', async () => {
  await assert.rejects(requestModel(options('http://localhost', { model: '' })), error => error.code === 'INVALID_MODEL_CONFIG');
  await assert.rejects(requestModel(options('http://localhost', { messages: [] })), error => error.code === 'INVALID_MODEL_INPUT');
  await assert.rejects(requestModel(options('http://localhost', { messages: [{ role: 'tool', content: 'orphan' }] })), error => error.code === 'INVALID_MODEL_CONFIG');
});

test('OpenAI reasoning survives persisted tool round trips without duplicate assistant items', async t => {
  const requests = [];
  const nativeOutput = [
    { id: 'rs-1', type: 'reasoning', summary: [], encrypted_content: 'opaque-signed-reasoning' },
    { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: 'I will read the file.', annotations: [] },
    ] },
    { id: 'fc-1', type: 'function_call', status: 'completed', call_id: 'call-1', name: 'read_file', arguments: '{"path":"hello.txt"}' },
  ];
  const base = await localServer(t, async ({ request, response, body }) => {
    requests.push({ url: request.url, body });
    if (requests.length === 1) {
      await sendFragments(response, [
        { type: 'response.output_item.done', output_index: 0, item: nativeOutput[0] },
        { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'I will read the file.' },
        { type: 'response.output_item.done', output_index: 1, item: nativeOutput[1] },
        { type: 'response.output_item.done', output_index: 2, item: nativeOutput[2] },
        { type: 'response.completed', response: { status: 'completed', output: nativeOutput, usage: { input_tokens: 10, output_tokens: 5 } } },
      ].map(value => sse(value, value.type)).join(''));
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished.' }] }] }));
    }
  });
  const messages = [{ role: 'user', content: 'Read hello.txt' }];
  const first = await requestModel(options(`${base}/v1`, { messages }));
  // Serialization matches saving and reopening a local session.
  messages.push(JSON.parse(JSON.stringify(first.message)), { role: 'tool', toolCallId: 'call-1', content: 'hello' });
  await requestModel(options(`${base}/v1/responses`, { messages }));
  assert.deepEqual(requests[1].body.input, [
    { role: 'user', content: 'Read hello.txt' }, ...nativeOutput,
    { type: 'function_call_output', call_id: 'call-1', output: 'hello' },
  ]);
  assert.equal(requests[1].body.input.filter(item => item.type === 'function_call').length, 1);
  assert.deepEqual(first.message.providerState, { provider: 'openai', model, endpoint: `${base}/v1/responses`, output: nativeOutput });

  await requestModel(options(`${base}/v1`, { messages, model: 'a-different-model' }));
  await requestModel(options(`${base}/another-prefix`, { messages }));
  for (const request of requests.slice(2)) {
    assert.equal(request.body.input.some(item => item.type === 'reasoning'), false);
    assert.deepEqual(request.body.input[1], { role: 'assistant', content: 'I will read the file.' });
    assert.deepEqual(request.body.input[2], { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"hello.txt"}' });
  }
});

test('native provider state rejects credentials without altering signatures and rejects duplicate tool IDs', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.setHeader('content-type', 'application/json');
    const output = request.url.startsWith('/duplicates/') ? [
      { type: 'function_call', call_id: 'same-id', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'same-id', name: 'read_file', arguments: '{}' },
    ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reflected ${apiKey}` }] }];
    response.end(JSON.stringify({ output }));
  });
  await assert.rejects(requestModel(options(base)), error => error.code === 'PROVIDER_SECRET_IN_RESPONSE' && !error.message.includes(apiKey));
  await assert.rejects(requestModel(options(`${base}/duplicates`)), error => error.code === 'INVALID_TOOL_CALL');
});

test('invalid UTF-8 is reported as a response encoding error', async t => {
  const base = await localServer(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(Buffer.from([0xff, 0xfe]));
  });
  await assert.rejects(requestModel(options(base)), error => error.code === 'PROVIDER_INVALID_ENCODING');
});

test('Anthropic persists and replays complete thinking/signature blocks with text-only UI deltas', async t => {
  const requests = [];
  const nativeContent = [
    { type: 'thinking', thinking: 'initial thought continued', signature: 'signature-prefix-part-1-part-2' },
    { type: 'redacted_thinking', data: 'opaque-redacted-block' },
    { type: 'text', text: 'Ready. ' },
    { type: 'tool_use', id: 'toolu-read', name: 'read_file', input: { path: 'hello.txt' } },
  ];
  const base = await localServer(t, async ({ request, response, body }) => {
    requests.push({ url: request.url, body });
    if (requests.length === 1) {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'initial thought ', signature: 'signature-prefix-' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'continued' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part-1-' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part-2' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: nativeContent[1] },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Ready' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '. ' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu-read', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"hello.txt"}' } },
        { type: 'content_block_stop', index: 3 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ];
      await sendFragments(response, events.map(value => sse(value, value.type)).join(''));
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'Finished.' }], usage: { input_tokens: 10, output_tokens: 2 } }));
    }
  });
  const messages = [{ role: 'user', content: 'Read hello.txt' }];
  const deltas = [];
  const first = await requestModel(options(`${base}/v1`, { provider: 'anthropic', messages, onTextDelta: value => deltas.push(value) }));
  assert.deepEqual(deltas, ['Ready', '. ']);
  assert.equal(first.message.content, 'Ready. ');
  assert.deepEqual(first.message.providerState, { provider: 'anthropic', model, endpoint: `${base}/v1/messages`, content: nativeContent });
  messages.push(JSON.parse(JSON.stringify(first.message)), { role: 'tool', toolCallId: 'toolu-read', content: 'hello' });
  await requestModel(options(`${base}/v1/messages`, { provider: 'anthropic', messages }));
  assert.deepEqual(requests[1].body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Read hello.txt' }] },
    { role: 'assistant', content: nativeContent },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-read', content: 'hello' }] },
  ]);
  await requestModel(options(`${base}/v1`, { provider: 'anthropic', messages, model: 'a-different-model' }));
  await requestModel(options(`${base}/different-path`, { provider: 'anthropic', messages }));
  for (const request of requests.slice(2)) {
    assert.deepEqual(request.body.messages[1].content, [
      { type: 'text', text: 'Ready. ' },
      { type: 'tool_use', id: 'toolu-read', name: 'read_file', input: { path: 'hello.txt' } },
    ]);
  }
  assert.deepEqual(messages[1].providerState.content, nativeContent);
});

test('Anthropic signed state with a reflected key fails without rewriting the signature', async t => {
  const base = await localServer(t, ({ response }) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ content: [{ type: 'thinking', thinking: '', signature: apiKey }] }));
  });
  await assert.rejects(requestModel(options(base, { provider: 'anthropic' })), error =>
    error.code === 'PROVIDER_SECRET_IN_RESPONSE' && !error.message.includes(apiKey));
});

test('reasoning effort uses exact provider fields and default sends no thinking override', async t => {
  const requests = [];
  const base = await localServer(t, ({ request, response, body }) => {
    requests.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/responses') ? { output: [] }
      : request.url.endsWith('/messages') ? { content: [] } : { choices: [{ message: { content: 'ok' } }] }));
  });
  for (const effort of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    await requestModel(options(base, { reasoningEffort: effort }));
    const body = requests.at(-1);
    assert.deepEqual(body.reasoning, effort === 'default' ? undefined : { effort });
  }
  for (const effort of ['default', 'none', 'low', 'high', 'max']) {
    await requestModel(options(base, { provider: 'deepseek', reasoningEffort: effort }));
    const body = requests.at(-1);
    assert.deepEqual(body.thinking, effort === 'default' ? undefined : { type: effort === 'none' ? 'disabled' : 'enabled' });
    assert.equal(body.reasoning_effort, ['default', 'none'].includes(effort) ? undefined : effort);
  }
  for (const effort of ['default', 'low', 'medium', 'high', 'xhigh', 'max']) {
    await requestModel(options(base, { provider: 'anthropic', model: 'claude-sonnet-4-6', reasoningEffort: effort }));
    const body = requests.at(-1);
    assert.deepEqual(body.output_config, effort === 'default' ? undefined : { effort });
    assert.deepEqual(body.thinking, effort === 'default' ? undefined : { type: 'adaptive' });
  }
  for (const id of ['claude-opus-4-5', 'custom-model-alias']) {
    await requestModel(options(base, { provider: 'anthropic', model: id, reasoningEffort: 'high' }));
    assert.deepEqual(requests.at(-1).output_config, { effort: 'high' });
    assert.equal(requests.at(-1).thinking, undefined);
  }
  for (const [provider, reasoningEffort] of [['deepseek', 'medium'], ['deepseek', 'minimal'], ['anthropic', 'none'], ['openai', 'invented-level']]) {
    await assert.rejects(requestModel(options(base, { provider, reasoningEffort })), error => error.code === 'INVALID_REASONING_EFFORT');
  }
  assert.equal(requests.length, 21);
});

test('unsupported reasoning configuration produces a clear HTTP error without leaking credentials', async t => {
  const base = await localServer(t, ({ response }) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `unsupported effort; reflected ${apiKey}` } }));
  });
  await assert.rejects(requestModel(options(base, { reasoningEffort: 'max' })), error =>
    error.code === 'PROVIDER_HTTP_400' && error.message.includes('推理强度') && !error.message.includes(apiKey));
});

test('DeepSeek preserves all reasoning when changing models on the same endpoint and isolates other endpoints', async t => {
  const requests = [];
  const base = await localServer(t, async ({ request, response, body }) => {
    requests.push({ url: request.url, body });
    const round = requests.length;
    const choice = round === 2 ? {
      index: 0, delta: { reasoning_content: 'second reasoning', content: 'Reading.', tool_calls: [
        { index: 0, id: 'deep-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } },
      ] }, finish_reason: 'tool_calls',
    } : { index: 0, delta: { reasoning_content: 'first reasoning', content: 'First answer.' }, finish_reason: 'stop' };
    await sendFragments(response, sse({ choices: [choice] }) + sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + sse('[DONE]'));
  });
  const messages = [{ role: 'user', content: 'First question.' }];
  const deltas = [], progress = [];
  const first = await requestModel(options(`${base}/v1`, { provider: 'deepseek', messages,
    onTextDelta: value => deltas.push(value), onProgress: value => progress.push(value) }));
  assert.deepEqual(deltas, ['First answer.']);
  assert.equal(first.message.providerState.message.reasoning_content, 'first reasoning');
  assert.equal(first.message.toolCalls.length, 0);
  assert.equal(first.usageReported, true);
  assert.equal(JSON.stringify(progress).includes('first reasoning'), false);
  assert.equal(progress.some(value => value.phase === 'thinking'), true);
  messages.push(JSON.parse(JSON.stringify(first.message)), { role: 'user', content: 'Now call a tool.' });
  const second = await requestModel(options(`${base}/v1/chat/completions`, { provider: 'deepseek', messages, reasoningEffort: 'high' }));
  assert.equal(requests[1].body.messages[1].reasoning_content, 'first reasoning');
  messages.push(JSON.parse(JSON.stringify(second.message)), { role: 'tool', toolCallId: 'deep-call', content: 'hello' });
  await requestModel(options(`${base}/v1`, { provider: 'deepseek', messages }));
  assert.deepEqual(requests[2].body.messages.filter(value => value.role === 'assistant').map(value => value.reasoning_content),
    ['first reasoning', 'second reasoning']);
  assert.equal(requests[2].body.messages[3].tool_calls[0].id, 'deep-call');
  await requestModel(options(`${base}/v1`, { provider: 'deepseek', messages, model: 'different-model' }));
  assert.deepEqual(requests[3].body.messages.filter(value => value.role === 'assistant').map(value => value.reasoning_content),
    ['first reasoning', 'second reasoning']);
  assert.equal(requests[3].body.messages[3].tool_calls[0].id, 'deep-call');
  await requestModel(options(`${base}/different-prefix`, { provider: 'deepseek', messages }));
  assert.equal(requests[4].body.messages.some(value => Object.hasOwn(value, 'reasoning_content')), false);
});

test('HTTP 400 surfaces bounded structured model errors for default effort without retrying or rewriting the model', async () => {
  let requests = 0;
  const selectedModel = 'DeepSeek-V4.1-Flash-1017';
  await assert.rejects(requestModel(options(undefined, { provider: 'deepseek', model: selectedModel,
    fetchImpl: async (endpoint, init) => {
      requests++;
      assert.equal(endpoint, 'https://api.deepseek.com/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(body.model, selectedModel);
      assert.equal(body.thinking, undefined);
      assert.equal(body.reasoning_effort, undefined);
      return new Response(JSON.stringify({ error: { message: 'Model Not Exist', code: 'model_not_found', param: 'model' },
        request: 'Unrelated request data must not be displayed.' }), { status: 400 });
    },
  })), error => error.code === 'PROVIDER_HTTP_400' && error.message.includes('Model Not Exist')
    && error.message.includes('code: model_not_found') && error.message.includes('param: model')
    && error.message.includes('模型 ID') && !error.message.includes('Unrelated request data'));
  assert.equal(requests, 1);
});

test('explicit gateway group/account/channel errors preserve HTTP status and model without misleading local repair hints', async t => {
  const selectedModel = 'gemini-4-argon-high';
  const cases = [
    { status: 404, apiProtocol: 'responses', message: `Model "${selectedModel}" is not supported by any configured account in this group`, code: 'server_error' },
    { status: 503, apiProtocol: 'chat-completions', message: `No available channel for model ${selectedModel} in group default`, code: 'no_available_channel' },
    { status: 404, apiProtocol: 'responses', message: `当前分组 default 下对于模型 ${selectedModel} 无可用渠道`, code: 'server_error' },
    { status: 404, apiProtocol: 'chat-completions', code: 'model_not_available_in_group' },
  ];
  const requests = [];
  const base = await localServer(t, ({ request, response, body }) => {
    const fixture = cases[requests.length];
    requests.push({ path: request.url, model: body.model });
    response.writeHead(fixture.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: fixture.message, code: fixture.code, param: 'model' } }));
  });
  for (const fixture of cases) {
    await assert.rejects(requestModel(options(`${base}/v1`, { provider: 'relay', apiProtocol: fixture.apiProtocol, model: selectedModel })), error => {
      assert.equal(error.code, `PROVIDER_HTTP_${fixture.status}`);
      assert.match(error.message, /当前分组.*上游账号或渠道/u);
      assert.match(error.message, /更换.*模型、切换分组.*联系服务商/u);
      assert.ok(error.message.includes(fixture.code));
      assert.doesNotMatch(error.message, /发布名称|模型 ID|默认强度|API 地址或模型不存在|模型目录可用不代表/u);
      return true;
    });
  }
  assert.deepEqual(requests, cases.map(fixture => ({ path: fixture.apiProtocol === 'responses' ? '/v1/responses' : '/v1/chat/completions', model: selectedModel })),
    'Each submission makes exactly one request with its selected model and protocol');
});

test('generic 404 resource errors retain safe actual protocol/path without inferring gateway account configuration', async t => {
  let requests = 0;
  const base = await localServer(t, ({ request, response, body }) => {
    requests++;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(body.model, 'gemini-4-argon-high');
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Resource not found', code: 'not_found_error',
      private_diagnostic: 'No available channel for model in group default' } }));
  });
  await assert.rejects(requestModel(options(`${base}/v1`, { provider: 'relay', apiProtocol: 'chat-completions', model: 'gemini-4-argon-high' })), error => {
    assert.equal(error.code, 'PROVIDER_HTTP_404');
    assert.match(error.message, /路由、资源或模型.*无法区分/u);
    assert.match(error.message, /中转站 Chat Completions.*\/v1\/chat\/completions/u);
    assert.match(error.message, /Resource not found.*not_found_error/u);
    assert.doesNotMatch(error.message, /当前分组没有|上游账号|private_diagnostic|No available channel|发布名称/u);
    return true;
  });
  assert.equal(requests, 1);
});

test('gateway diagnosis reads only bounded sanitized fields and still hides credentials', async () => {
  let requests = 0;
  const selectedModel = 'gemini-4-argon-high';
  const secretValues = [apiKey, encodeURIComponent(apiKey), 'another-gateway-bearer', 'user-secret', 'pass-secret', 'query-secret'];
  await assert.rejects(requestModel(options('https://gateway.example/v1', { provider: 'relay', model: selectedModel,
    fetchImpl: async () => {
      requests++;
      return new Response(JSON.stringify({ error: {
        message: `Model ${selectedModel} is not supported by any configured account in this group. ${apiKey} ${encodeURIComponent(apiKey)} Bearer another-gateway-bearer https://user-secret:pass-secret@example.test/?key=query-secret`,
        code: 'server_error', param: 'model', private_body: 'never disclose this fixture field',
      } }), { status: 404 });
    } })), error => {
      assert.match(error.message, /当前分组.*上游账号/u);
      for (const secret of secretValues) assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('never disclose this fixture field'), false);
      assert.doesNotMatch(error.message, /发布名称|模型 ID/u);
      return true;
    });
  await assert.rejects(requestModel(options('https://gateway.example/v1', { provider: 'relay',
    fetchImpl: async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: 'Resource not found. ' + 'x'.repeat(800) + ' No available channel for model in group default', code: 'server_error' } }), { status: 404 });
    } })), error => {
      assert.match(error.message, /路由、资源或模型.*无法区分/u);
      assert.doesNotMatch(error.message, /当前分组没有|No available channel/u);
      return true;
    });
  assert.equal(requests, 2);
});

test('group diagnostics do not change ChatGPT account errors or Cloudflare 524 semantics', async () => {
  const message = 'Model gemini-4-argon-high is not supported by any configured account in this group';
  let requests = 0;
  for (const scenario of [{ status: 404, authMode: 'chatgpt', provider: 'openai' }, { status: 524, authMode: 'apiKey', provider: 'relay' }]) {
    await assert.rejects(requestModel(options(scenario.authMode === 'chatgpt' ? 'https://api.openai.com/v1' : 'https://gateway.example/v1', {
      authMode: scenario.authMode, provider: scenario.provider, fetchImpl: async () => {
        requests++;
        return new Response(JSON.stringify({ error: { message, code: 'server_error' } }), { status: scenario.status });
      },
    })), error => {
      assert.equal(error.code, `PROVIDER_HTTP_${scenario.status}`);
      if (scenario.status === 524) assert.match(error.message, /Cloudflare.*上游.*超时/u);
      else assert.match(error.message, /此模型不在当前 ChatGPT 账号的可用列表/u);
      assert.doesNotMatch(error.message, /中转站当前分组没有/u);
      return true;
    });
  }
  assert.equal(requests, 2);
});

test('HTTP diagnostic fields redact keys, bearer tokens, URL credentials and control characters', async () => {
  const hidden = [apiKey, encodeURIComponent(apiKey), 'another-bearer-token', 'user-secret', 'pass-secret',
    'query-secret', 'fragment-secret', 'sk-unknowncredential1234', 'standalone-secret'];
  const message = `Rejected ${apiKey}; encoded ${encodeURIComponent(apiKey)}; Bearer another-bearer-token; `
    + 'https://user-secret:pass-secret@example.test/v1?api_key=query-secret#fragment-secret '
    + 'sk-unknowncredential1234 api_key=standalone-secret\u0000\u202e request invalid';
  await assert.rejects(requestModel(options(undefined, {
    fetchImpl: async () => new Response(JSON.stringify({ error: {
      message, code: `bad_${apiKey}`, param: `authorization=Bearer-another-bearer-token`, private_data: 'never-show-private-data',
    } }), { status: 400 }),
  })), error => {
    assert.equal(error.code, 'PROVIDER_HTTP_400');
    assert.match(error.message, /Rejected/);
    assert.match(error.message, /https:\/\/example\.test\/v1/);
    for (const value of hidden) assert.equal(error.message.includes(value), false, `Must redact ${value}`);
    assert.equal(error.message.includes('never-show-private-data'), false);
    assert.equal(/[\u0000\u202e]/u.test(error.message), false);
    return true;
  });
});

test('HTTP error bodies are size limited and malformed or non-JSON bodies stay private', async () => {
  let reads = 0, cancelled = false;
  const oversized = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(40 * 1024).fill(65)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(requestModel(options(undefined, {
    fetchImpl: async () => new Response(oversized, { status: 400 }),
  })), error => error.code === 'PROVIDER_HTTP_400' && !error.message.includes('AAAA'));
  assert.ok(reads <= 2);
  assert.equal(cancelled, true);
  for (const source of ['<html>private diagnostic details</html>', '{"error":{"message":"private malformed details"',
    JSON.stringify({ error: { message: 'A'.repeat(33 * 1024) } })]) {
    await assert.rejects(requestModel(options(undefined, {
      fetchImpl: async () => new Response(source, { status: 400 }),
    })), error => error.code === 'PROVIDER_HTTP_400' && !error.message.includes('private') && error.message.length < 200);
  }
  await assert.rejects(requestModel(options(undefined, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'A'.repeat(4000), code: 'B'.repeat(300), param: 'C'.repeat(300) } }), { status: 400 }),
  })), error => error.code === 'PROVIDER_HTTP_400' && error.message.length < 1200);
});

test('reading HTTP error diagnostics remains cancellable and obeys the request timeout', async t => {
  const base = await localServer(t, ({ response }) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.write('{"error":');
  });
  const controller = new AbortController();
  const request = requestModel(options(base, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(request, error => error.name === 'AbortError');
  await assert.rejects(requestModel(options(base, { timeoutMs: 25 })), error => error.code === 'PROVIDER_TIMEOUT');
});

test('missing DeepSeek reasoning errors give an actionable continuation hint', async () => {
  await assert.rejects(requestModel(options(undefined, { provider: 'deepseek', fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.',
      code: 'invalid_request_error', param: 'messages[1].reasoning_content' } }), { status: 400 }),
  })), error => error.code === 'PROVIDER_HTTP_400' && error.message.includes('reasoning_content')
    && error.message.includes('新建对话') && error.message.includes('关闭推理'));
});

test('catalog capabilities reject unsupported efforts, tools and protocols locally without a request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('Must not request'); };
  for (const [extra, code] of [
    [{ reasoningEffort: 'max', modelCapabilities: { reasoningEfforts: ['none', 'low', 'high'] } }, 'INVALID_REASONING_EFFORT'],
    [{ reasoningEffort: 'low', modelCapabilities: { reasoningEfforts: [] } }, 'INVALID_REASONING_EFFORT'],
    [{ modelCapabilities: { supportsTools: false } }, 'MODEL_TOOLS_UNSUPPORTED'],
    [{ tools: [], modelCapabilities: { supportsTools: false } }, 'MODEL_TOOLS_UNSUPPORTED'],
    [{ modelCapabilities: { compatible: false } }, 'MODEL_INCOMPATIBLE'],
    [{ modelCapabilities: { reasoningEfforts: 'high' } }, 'INVALID_MODEL_CONFIG'],
  ]) {
    await assert.rejects(requestModel(options(undefined, { provider: 'deepseek', fetchImpl, ...extra })), error => error.code === code);
  }
  assert.equal(requests, 0);
});

test('text-only catalog capabilities serialize actual independent text requests across provider protocols', async () => {
  const textMessages = [{ role: 'system', content: '[APPROVAL_REVIEW] Return JSON.' }, { role: 'user', content: 'Review a project operation.' }];
  for (const [provider, apiProtocol] of [['relay', 'responses'], ['relay', 'chat-completions'], ['openai', 'responses'], ['deepseek', undefined], ['anthropic', undefined]]) {
    const normalized = deriveModelCapabilities(provider, model, { supportsTools: false });
    const capabilities = deriveModelCapabilities(provider, model, JSON.parse(JSON.stringify(normalized)));
    let calls = 0;
    const result = await requestModel(options('https://fixture.invalid/v1', { provider, apiProtocol, tools: [], messages: textMessages,
      modelCapabilities: capabilities, fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.equal(body.model, model); assert.equal(body.tools, undefined, 'Text-only requests must not serialize any function schemas');
        assert.ok(!JSON.stringify(body).includes('function_call'));
        const content = '{"decision":"allow","reason":"本地测试"}';
        const payload = provider === 'anthropic' ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
          : apiProtocol === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 10, output_tokens: 5 } }
          : { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      } }));
    assert.equal(calls, 1); assert.equal(JSON.parse(result.message.content).decision, 'allow');
    assert.deepEqual(result.message.toolCalls, []);
  }
});

test('text-only allowance never admits tools or tool history, nor hard text incompatibilities', async () => {
  const textMessages = [{ role: 'user', content: 'Review this operation.' }];
  const textCapabilities = deriveModelCapabilities('relay', model, { supportsTools: false });
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Must not request'); };
  for (const extra of [
    { messages: textMessages, tools },
    { messages: history, tools: [] },
    { messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_file', arguments: { path: 'a.txt' } }] }], tools: [] },
    { messages: [{ role: 'tool', toolCallId: 'c', content: 'file text' }], tools: [] },
  ]) await assert.rejects(requestModel(options('https://fixture.invalid/v1', { provider: 'relay', modelCapabilities: textCapabilities, fetchImpl, ...extra })), { code: 'MODEL_INCOMPATIBLE' });
  for (const [provider, id, metadata] of [
    ['openai', 'text-embedding-3-small', { officialSource: true }],
    ['relay', 'not-text', { output_modalities: ['image'] }],
    ['relay', 'retired', { lifecycle: 'retired' }],
    ['relay', 'explicit-denial', { compatible: false }],
  ]) await assert.rejects(requestModel(options('https://fixture.invalid/v1', { provider, model: id, tools: [], messages: textMessages,
    modelCapabilities: deriveModelCapabilities(provider, id, metadata), fetchImpl })), { code: 'MODEL_INCOMPATIBLE' });
  const catalog = await new ModelCatalog().list({ provider: 'relay', baseUrl: 'https://fixture.invalid/v1', apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'denied', compatible: false, textCompatible: true, supportsTools: false }] })) });
  await assert.rejects(requestModel(options('https://fixture.invalid/v1', { provider: 'relay', tools: [], messages: textMessages,
    modelCapabilities: deriveModelCapabilities('relay', 'denied', catalog.models[0]), fetchImpl })), { code: 'MODEL_INCOMPATIBLE' });
  await assert.rejects(requestModel(options('https://fixture.invalid/v1', { provider: 'relay', tools: [], messages: textMessages,
    modelCapabilities: { textCompatible: 'true' }, fetchImpl })), { code: 'INVALID_MODEL_CONFIG' });
  assert.equal(calls, 0);
});

test('catalog capabilities preserve default and map supported DeepSeek none without guessing legacy aliases', async () => {
  const bodies = [];
  const fetchImpl = async (_endpoint, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      { headers: { 'content-type': 'application/json' } });
  };
  for (const selectedModel of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'custom-gateway-model']) {
    await requestModel(options('https://gateway.example.test/v1', { provider: 'deepseek', model: selectedModel, fetchImpl,
      modelCapabilities: { reasoningEfforts: ['none', 'low', 'high', 'max'], supportsTools: true } }));
    assert.equal(bodies.at(-1).model, selectedModel);
    assert.equal(bodies.at(-1).thinking, undefined);
    assert.equal(bodies.at(-1).reasoning_effort, undefined);
  }
  await requestModel(options(undefined, { provider: 'deepseek', fetchImpl, reasoningEffort: 'none',
    modelCapabilities: { reasoningEfforts: ['none', 'high'] } }));
  assert.deepEqual(bodies.at(-1).thinking, { type: 'disabled' });
  assert.equal(bodies.at(-1).reasoning_effort, undefined);
  await requestModel(options(undefined, { provider: 'deepseek', fetchImpl, modelCapabilities: { reasoningEfforts: [] } }));
  assert.equal(bodies.at(-1).thinking, undefined);
});

function estimatedTokens(...values) {
  let units = 0;
  for (const text of values) for (const character of text) units += character.codePointAt(0) <= 127 ? 3 : 8;
  return Math.ceil(units / 12);
}

test('live token estimates depend on generated characters, including split Unicode, not chunk counts', async t => {
  const text = 'ABCDEFGH中文👋';
  const reasoning = 'think 中文';
  const base = await localServer(t, async ({ request, response }) => {
    const split = request.url.startsWith('/split/');
    const textPieces = split ? ['A', 'BCD', 'EFGH中', '文\ud83d', '\udc4b'] : [text];
    const thinkingPieces = split ? ['th', 'ink ', '中', '文'] : [reasoning];
    const chunks = [
      ...thinkingPieces.map(value => ({ choices: [{ index: 0, delta: { reasoning_content: value } }] })),
      ...textPieces.map(value => ({ choices: [{ index: 0, delta: { content: value } }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    await sendFragments(response, chunks.map(value => sse(value)).join('') + sse('[DONE]'));
  });
  const finalEstimates = [];
  for (const path of ['whole', 'split']) {
    const progress = [], deltas = [];
    const result = await requestModel(options(`${base}/${path}`, { provider: 'deepseek',
      onProgress: value => progress.push(value), onTextDelta: value => deltas.push(value) }));
    assert.equal(deltas.join(''), text);
    assert.equal(result.usageReported, false);
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(progress.some(value => value.usage !== undefined), false);
    assert.equal(JSON.stringify(progress).includes(reasoning), false);
    finalEstimates.push(progress.at(-1).estimatedOutputTokens);
  }
  assert.deepEqual(finalEstimates, [estimatedTokens(text, reasoning), estimatedTokens(text, reasoning)]);
});

test('OpenAI progress counts interleaved tool arguments and reasoning summaries once, then reports actual total usage', async t => {
  const text = 'Readable answer.';
  const reasoning = 'summary text';
  const args1 = '{"path":"one.txt"}', args2 = '{"path":"你好.txt"}';
  const output = [
    { type: 'reasoning', id: 'rs-progress', encrypted_content: 'do-not-count-this-opaque-data', summary: [{ type: 'summary_text', text: reasoning }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    { type: 'function_call', id: 'fc-1', call_id: 'p1', name: 'read_file', arguments: args1 },
    { type: 'function_call', id: 'fc-2', call_id: 'p2', name: 'read_file', arguments: args2 },
  ];
  const base = await localServer(t, async ({ response }) => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: reasoning },
      { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: reasoning },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: text },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'p1', name: 'read_file', arguments: '' } },
      { type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', call_id: 'p2', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: args1.slice(0, 5) },
      { type: 'response.function_call_arguments.delta', output_index: 3, delta: args2.slice(0, 8) },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: args1.slice(5) },
      { type: 'response.function_call_arguments.delta', output_index: 3, delta: args2.slice(8) },
      { type: 'response.function_call_arguments.done', output_index: 2, arguments: args1 },
      { type: 'response.function_call_arguments.done', output_index: 3, arguments: args2 },
      ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
      { type: 'response.completed', response: { output, usage: { input_tokens: 10, output_tokens: 50, output_tokens_details: { reasoning_tokens: 40 } } } },
    ];
    await sendFragments(response, events.map(value => sse(value, value.type)).join(''));
  });
  const progress = [], deltas = [];
  const result = await requestModel(options(base, { onProgress: value => progress.push(value), onTextDelta: value => deltas.push(value) }));
  assert.deepEqual(deltas, [text]);
  assert.equal(progress.at(-1).estimatedOutputTokens, estimatedTokens(text, reasoning, args1, args2));
  assert.deepEqual(progress.at(-1).usage, { inputTokens: 10, outputTokens: 50 });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 50 });
  assert.equal(result.usageReported, true);
  assert.deepEqual(new Set(progress.map(value => value.phase).filter(Boolean)), new Set(['thinking', 'generating', 'tool-call']));
  assert.equal(JSON.stringify(progress).includes('summary text'), false);
});

test('Anthropic progress merges cumulative usage and cached input without counting signatures', async t => {
  const base = await localServer(t, async ({ response }) => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'thinking ', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'a-very-long-opaque-signature-that-is-not-generated-text' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'done' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9, cache_read_input_tokens: 7 } },
      { type: 'message_stop' },
    ];
    await sendFragments(response, events.map(value => sse(value)).join(''));
  });
  const progress = [];
  const result = await requestModel(options(base, { provider: 'anthropic', onProgress: value => progress.push(value) }));
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 9, cachedInputTokens: 7 });
  assert.equal(result.usageReported, true);
  assert.equal(progress.at(-1).estimatedOutputTokens, estimatedTokens('thinking text', 'done'));
  assert.deepEqual(progress.filter(value => value.usage).map(value => value.usage), [
    { inputTokens: 30, outputTokens: 1, cachedInputTokens: 7 }, { inputTokens: 30, outputTokens: 5, cachedInputTokens: 7 },
    { inputTokens: 30, outputTokens: 9, cachedInputTokens: 7 }, { inputTokens: 30, outputTokens: 9, cachedInputTokens: 7 },
  ]);
});

test('usage callbacks precede truncation/API errors and never add reasoning detail twice', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.setHeader('content-type', 'text/event-stream');
    if (request.url.startsWith('/openai/')) response.end(sse({ type: 'response.incomplete', response: { usage: { input_tokens: 11, output_tokens: 7, output_tokens_details: { reasoning_tokens: 6 } } } }));
    else if (request.url.startsWith('/deepseek/')) response.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 6 } } }));
    else if (request.url.startsWith('/anthropic/')) response.end(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 11, output_tokens: 7 } }));
    else response.end(sse({ type: 'error', error: { message: 'upstream failure' }, usage: { input_tokens: 11, output_tokens: 7 } }));
  });
  for (const provider of ['openai', 'deepseek', 'anthropic']) {
    const progress = [];
    await assert.rejects(requestModel(options(`${base}/${provider}`, { provider, onProgress: value => progress.push(value) })), error => error.code === 'PROVIDER_TRUNCATED');
    assert.deepEqual(progress.at(-1).usage, { inputTokens: 11, outputTokens: 7 });
  }
  const progress = [];
  await assert.rejects(requestModel(options(`${base}/error`, { onProgress: value => progress.push(value) })), error => error.code === 'PROVIDER_API_ERROR');
  assert.deepEqual(progress.at(-1).usage, { inputTokens: 11, outputTokens: 7 });
});

test('usageReported distinguishes missing/empty usage from API-reported zero tokens', async t => {
  const base = await localServer(t, ({ request, response }) => {
    response.setHeader('content-type', 'application/json');
    const usage = request.url.startsWith('/zero/') ? { input_tokens: 0, output_tokens: 0 } : request.url.startsWith('/empty/') ? {} : undefined;
    response.end(JSON.stringify({ output: [], ...(usage ? { usage } : {}) }));
  });
  for (const path of ['missing', 'empty', 'zero']) {
    const progress = [];
    const result = await requestModel(options(`${base}/${path}`, { onProgress: value => progress.push(value) }));
    assert.equal(result.usageReported, path === 'zero');
    assert.equal(progress.some(value => value.usage !== undefined), path === 'zero');
  }
});

test('one-sided or invalid token usage never masquerades as complete API usage', async t => {
  const examples = [
    { input_tokens: 20 }, { output_tokens: 3 }, { prompt_tokens: 20 },
    { input_tokens: 20, output_tokens: null }, { input_tokens: 20, output_tokens: -1 },
    { input_tokens: 20, output_tokens: 1.5 }, { input_tokens: 20, output_tokens: '3' },
    { input_tokens: 20, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_tokens: 2.5, output_tokens: 3 },
  ];
  const base = await localServer(t, ({ request, response }) => {
    const index = Number(request.url.split('/')[1]);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ output: [], usage: examples[index] }));
  });
  for (let index = 0; index < examples.length; index++) {
    const progress = [];
    const result = await requestModel(options(`${base}/${index}`, { onProgress: value => progress.push(value) }));
    assert.equal(result.usageReported, false);
    assert.equal(progress.some(value => value.usage !== undefined), false);
  }
});

test('Anthropic usage can become complete across events without losing cached input', async t => {
  const base = await localServer(t, ({ response }) => {
    response.setHeader('content-type', 'text/event-stream');
    response.end([
      { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 7 } } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, cache_read_input_tokens: 7 } },
      { type: 'message_stop' },
    ].map(value => sse(value)).join(''));
  });
  const progress = [];
  const result = await requestModel(options(base, { provider: 'anthropic', onProgress: value => progress.push(value) }));
  assert.equal(progress[0].usage, undefined);
  assert.deepEqual(progress.filter(value => value.usage).map(value => value.usage), [
    { inputTokens: 27, outputTokens: 3, cachedInputTokens: 7 }, { inputTokens: 27, outputTokens: 5, cachedInputTokens: 7 }, { inputTokens: 27, outputTokens: 5, cachedInputTokens: 7 },
  ]);
  assert.equal(result.usageReported, true);
  assert.deepEqual(result.usage, { inputTokens: 27, outputTokens: 5, cachedInputTokens: 7 });
});

const chatGPTEndpoint = 'https://api.openai.com/v1/responses';

function localChatGPTFetch(base) {
  return async (endpoint, init) => {
    // Only the injected test transport reaches localhost. The production
    // adapter must still select the fixed official OAuth inference endpoint.
    assert.equal(endpoint, chatGPTEndpoint);
    return fetch(`${base}/mock-chatgpt`, init);
  };
}

test('ChatGPT mode fixes the endpoint and uses instructions plus a forge tool namespace', async t => {
  let captured;
  const base = await localServer(t, async input => {
    captured = input;
    await sendFragments(input.response, sse({ type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready.' }] }],
      usage: { input_tokens: 12, output_tokens: 3 },
    } }));
  });
  const result = await requestModel(options(undefined, {
    authMode: 'chatgpt', fetchImpl: localChatGPTFetch(base), reasoningEffort: 'high', maxOutputTokens: 999,
    messages: [history[0], { role: 'system', content: 'Additional project instructions.' }, ...history.slice(1)],
    // Unsupported public API options must never leak into the plan request.
    background: true, conversation: 'server-conversation', metadata: { secret: 'never forward' }, temperature: 0,
  }));
  assert.equal(captured.request.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(captured.request.headers.accept, 'text/event-stream');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.instructions, `${history[0].content}\n\nAdditional project instructions.`);
  assert.equal(captured.body.input.some(item => item.role === 'system'), false);
  assert.deepEqual(captured.body.reasoning, { effort: 'high' });
  assert.deepEqual(captured.body.include, ['reasoning.encrypted_content']);
  for (const field of ['max_output_tokens', 'max_tool_calls', 'background', 'conversation', 'metadata', 'temperature', 'previous_response_id']) {
    assert.equal(Object.hasOwn(captured.body, field), false);
  }
  assert.equal(captured.body.tools.length, 1);
  assert.equal(captured.body.tools[0].type, 'namespace');
  assert.equal(captured.body.tools[0].name, 'forge');
  assert.equal(typeof captured.body.tools[0].description, 'string');
  assert.deepEqual(captured.body.tools[0].tools, [{ type: 'function', ...tools[0], strict: false }]);
  assert.equal(captured.body.input.find(item => item.type === 'function_call').namespace, 'forge');
  assert.equal(result.message.content, 'Ready.');
  assert.equal(result.message.providerState.authMode, 'chatgpt');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(result.usageReported, true);
});

test('ChatGPT OAuth mode rejects every custom base URL even when fetch is injected', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not run'); };
  for (const baseUrl of [
    'https://gateway.example/v1', 'https://api.openai.com.evil.example/v1',
    'https://api.openai.com/custom-path', 'http://localhost:9999/v1',
    'http://127.0.0.1:9999/v1', 'https://chatgpt.com/backend-api',
  ]) {
    await assert.rejects(requestModel(options(baseUrl, { authMode: 'chatgpt', fetchImpl })), error =>
      error.code === 'INVALID_CHATGPT_BASE_URL' && !error.message.includes(apiKey));
  }
  for (const provider of ['deepseek', 'anthropic']) {
    await assert.rejects(requestModel(options(undefined, { authMode: 'chatgpt', provider, fetchImpl })), error => error.code === 'INVALID_AUTH_MODE');
  }
  await assert.rejects(requestModel(options(undefined, { authMode: 'a-cookie-or-api-key-substitute', fetchImpl })), error => error.code === 'INVALID_AUTH_MODE');
  assert.equal(called, false);
});

test('ChatGPT accepts only official base variants and never sends an unapproved URL to the transport', async () => {
  const urls = [];
  const fetchImpl = async endpoint => {
    urls.push(endpoint);
    return new Response(new TextEncoder().encode(sse({ type: 'response.completed', response: { status: 'completed', output: [] } })),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  for (const baseUrl of [undefined, '', 'https://api.openai.com/v1', 'https://api.openai.com/v1/', chatGPTEndpoint, `${chatGPTEndpoint}/`]) {
    await requestModel(options(baseUrl, { authMode: 'chatgpt', fetchImpl }));
  }
  assert.deepEqual(urls, Array(6).fill(chatGPTEndpoint));
});

test('ChatGPT namespace and encrypted reasoning survive persisted tool round trips without crossing auth modes', async t => {
  const requests = [];
  const nativeOutput = [
    { id: 'plan-rs', type: 'reasoning', summary: [], encrypted_content: 'opaque-chatgpt-plan-reasoning' },
    { id: 'plan-msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Checking.' }] },
    { id: 'plan-fc', type: 'function_call', call_id: 'plan-call', name: 'read_file', namespace: 'forge', arguments: '{"path":"hello.txt"}', status: 'completed' },
  ];
  const base = await localServer(t, async ({ request, response, body }) => {
    requests.push(body);
    const output = requests.length === 1 ? nativeOutput : [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    ];
    await sendFragments(response, sse({ type: 'response.completed', response: { status: 'completed', output } }));
  });
  const fetchImpl = localChatGPTFetch(base);
  const messages = [{ role: 'system', content: 'Use the project tools.' }, { role: 'user', content: 'Read hello.txt' }];
  const first = await requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl, messages }));
  assert.deepEqual(first.message.toolCalls, [{ id: 'plan-call', name: 'read_file', arguments: { path: 'hello.txt' } }]);
  messages.push(JSON.parse(JSON.stringify(first.message)), { role: 'tool', toolCallId: 'plan-call', content: 'hello' });
  await requestModel(options(chatGPTEndpoint, { authMode: 'chatgpt', fetchImpl, messages }));
  assert.deepEqual(requests[1].input, [
    { role: 'user', content: 'Read hello.txt' }, ...nativeOutput,
    { type: 'function_call_output', call_id: 'plan-call', output: 'hello' },
  ]);
  assert.equal(requests[1].input.filter(item => item.type === 'function_call').length, 1);
  assert.equal(requests[1].input.find(item => item.type === 'function_call').namespace, 'forge');

  await requestModel(options(undefined, { authMode: 'apiKey', fetchImpl, messages }));
  assert.equal(requests[2].input.some(item => item.type === 'reasoning'), false);
  assert.equal(requests[2].input.find(item => item.type === 'function_call').namespace, undefined);
  assert.equal(requests[2].tools[0].type, 'function');
  assert.equal(requests[2].input[0].role, 'system');

  const oldAPIKeyMessage = JSON.parse(JSON.stringify(first.message));
  delete oldAPIKeyMessage.providerState.authMode;
  await requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl,
    messages: [...messages.slice(0, 2), oldAPIKeyMessage, messages.at(-1)] }));
  assert.equal(requests[3].input.some(item => item.type === 'reasoning'), false);
  assert.equal(requests[3].input.find(item => item.type === 'function_call').namespace, 'forge');
});

test('ChatGPT normalizes qualified forge tool names and rejects unknown namespaces', async () => {
  const fetchImpl = namespace => async () => new Response(new TextEncoder().encode(sse({
    type: 'response.completed', response: { status: 'completed', output: [
      { type: 'function_call', call_id: 'namespace-call', namespace, name: `${namespace}.read_file`, arguments: '{}' },
    ] },
  })), { headers: { 'content-type': 'text/event-stream' } });
  const result = await requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl: fetchImpl('forge') }));
  assert.equal(result.message.toolCalls[0].name, 'read_file');
  assert.equal(result.message.providerState.output[0].name, 'forge.read_file');
  assert.equal(result.message.providerState.output[0].namespace, 'forge');
  await assert.rejects(requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl: fetchImpl('unexpected') })),
    error => error.code === 'INVALID_TOOL_CALL');
});

test('ChatGPT sharing-limit failures after deltas remain failures and report only safe diagnostics', async t => {
  const cases = [
    ['subscription_sharing_usage_limit_exceeded', 'CHATGPT_USAGE_LIMIT_EXCEEDED', '用量已达上限'],
    ['subscription_sharing_usage_unavailable', 'CHATGPT_USAGE_UNAVAILABLE', '暂时无法核验'],
  ];
  let index = 0;
  const base = await localServer(t, async ({ response }) => {
    const [code] = cases[index++];
    const events = [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial reply.' },
      { type: 'response.failed', response: { status: 'failed', error: { code, message: `unsafe upstream message ${apiKey}` },
        usage: { input_tokens: 10, output_tokens: 3 } } },
      // A later forged completion must not override the earlier failure.
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ];
    await sendFragments(response, events.map(value => sse(value)).join(''));
  });
  for (const [, expectedCode, expectedText] of cases) {
    const deltas = [], progress = [];
    await assert.rejects(requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl: localChatGPTFetch(base),
      onTextDelta: value => deltas.push(value), onProgress: value => progress.push(value) })), error =>
      error.code === expectedCode && error.message.includes(expectedText) && !error.message.includes(apiKey));
    assert.deepEqual(deltas, ['Partial reply.']);
    assert.deepEqual(progress.at(-1).usage, { inputTokens: 10, outputTokens: 3 });
  }
});

test('ChatGPT requires completed SSE, permits missing content type, and rejects a JSON-only success', async () => {
  const complete = sse({ type: 'response.completed', response: { status: 'completed', output: [] } });
  const headerless = await requestModel(options(undefined, { authMode: 'chatgpt',
    fetchImpl: async () => new Response(new TextEncoder().encode(complete)) }));
  assert.equal(headerless.message.role, 'assistant');
  await assert.rejects(requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl: async () =>
    new Response(new TextEncoder().encode(sse({ type: 'response.output_text.delta', delta: 'Only partial.' })),
      { headers: { 'content-type': 'text/event-stream' } }) })), error => error.code === 'PROVIDER_INCOMPLETE_STREAM');
  await assert.rejects(requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl: async () =>
    new Response(JSON.stringify({ output: [] }), { headers: { 'content-type': 'application/json' } }) })),
    error => error.code === 'CHATGPT_INVALID_STREAM');
});

test('ChatGPT HTTP authorization errors request sign-in again without reflecting tokens', async () => {
  await assert.rejects(requestModel(options(undefined, { authMode: 'chatgpt', fetchImpl: async () =>
    new Response(`credential failure ${apiKey}`, { status: 401 }) })), error =>
    error.code === 'PROVIDER_HTTP_401' && error.message.includes('重新登录') && !error.message.includes(apiKey));
});

test('every provider excludes only explicitly local assistant notices without mutating real history', async () => {
  const localText = 'UI-only response/round-limit notice';
  const messages = [
    { role: 'system', content: 'System guidance.' },
    { role: 'user', content: 'Keep this user instruction.', localOnly: true },
    { role: 'assistant', content: localText, toolCalls: [], localOnly: true },
    { role: 'assistant', content: 'Keep this real model reply.', toolCalls: [], localOnly: false },
  ];
  const original = structuredClone(messages);
  for (const provider of ['openai', 'deepseek', 'anthropic']) {
    let body;
    const fetchImpl = async (_endpoint, init) => {
      body = JSON.parse(init.body);
      const value = provider === 'openai' ? { output: [] }
        : provider === 'deepseek' ? { choices: [{ message: { content: 'ok' } }] } : { content: [] };
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    };
    await requestModel(options(undefined, { provider, messages, fetchImpl }));
    assert.equal(JSON.stringify(body).includes(localText), false);
    assert.equal(JSON.stringify(body).includes('Keep this user instruction.'), true);
    assert.equal(JSON.stringify(body).includes('Keep this real model reply.'), true);
    assert.deepEqual(messages, original);
  }
});
