import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

const key = 'placeholder-chat-protocol-key';
const model = 'claude-through-explicit-chat-relay';
const tool = { name: 'read_file', description: 'Read the selected fixture.', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} };
const options = extra => ({ provider: 'openai', apiProtocol: 'chat-completions', apiKey: key,
  baseUrl: 'https://relay.example/gateway/v1', model,
  messages: [{ role: 'system', content: 'Follow the current task.' }, { role: 'user', content: 'Read the fixture.' }],
  tools: [tool], ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const reply = (content = 'Ready.', extra = {}) => ({ choices: [{ index: 0,
  message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7 }, ...extra });
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
function streaming(values, fragmentSize = 17) {
  const wire = new TextEncoder().encode(values.map(event).join(''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= wire.length) { controller.close(); return; }
    const end = Math.min(offset + fragmentSize, wire.length);
    controller.enqueue(wire.slice(offset, end)); offset = end;
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const image = freeze({ id: 'chat-image', name: 'fixture.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` });

test('explicit Chat Completions uses standard messages, tools, bearer auth and reported usage without DeepSeek fields', async () => {
  let requests = 0;
  const result = await requestModel(options({ maxOutputTokens: 1234, fetchImpl: async (url, init) => {
    requests++;
    assert.equal(url, 'https://relay.example/gateway/v1/chat/completions');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.headers['x-api-key'], undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, model);
    assert.deepEqual(body.messages, options().messages);
    assert.deepEqual(body.tools, [{ type: 'function', function: tool }]);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_completion_tokens, 1234);
    for (const name of ['input', 'thinking', 'reasoning', 'reasoning_effort', 'include', 'instructions']) assert.equal(body[name], undefined);
    return json(reply());
  } }));
  assert.equal(requests, 1);
  assert.equal(result.message.content, 'Ready.');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
  assert.equal(result.usageReported, true);
  assert.equal(result.message.providerState.provider, 'openai');
  assert.equal(result.message.providerState.apiProtocol, 'chat-completions');
});

test('OpenAI defaults to Responses while explicit Chat effort uses only reasoning_effort', async () => {
  const requests = [];
  await requestModel(options({ apiProtocol: undefined, fetchImpl: async (url, init) => {
    requests.push(url); const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body.input)); assert.equal(body.messages, undefined);
    return json({ output: [] });
  } }));
  await requestModel(options({ reasoningEffort: 'high', fetchImpl: async (url, init) => {
    requests.push(url); const body = JSON.parse(init.body);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.reasoning, undefined); assert.equal(body.thinking, undefined);
    return json(reply());
  } }));
  assert.deepEqual(requests, ['https://relay.example/gateway/v1/responses', 'https://relay.example/gateway/v1/chat/completions']);
});

test('relay defaults to Chat Completions, supports Responses explicitly and requires its own Base URL', async () => {
  const requests = [];
  for (const apiProtocol of [undefined, 'responses']) {
    const result = await requestModel(options({ provider: 'relay', apiProtocol, fetchImpl: async (url, init) => {
      requests.push(url); const body = JSON.parse(init.body);
      if (apiProtocol === 'responses') {
        assert.ok(Array.isArray(body.input)); assert.equal(body.messages, undefined);
        return json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Relay response.' }] }],
          usage: { input_tokens: 4, output_tokens: 5 } });
      }
      assert.ok(Array.isArray(body.messages)); assert.equal(body.input, undefined);
      return json(reply('Relay chat.'));
    } }));
    assert.equal(result.message.content, apiProtocol === 'responses' ? 'Relay response.' : 'Relay chat.');
  }
  assert.deepEqual(requests, ['https://relay.example/gateway/v1/chat/completions', 'https://relay.example/gateway/v1/responses']);
  let calls = 0;
  for (const baseUrl of [undefined, '', '   ']) {
    await assert.rejects(requestModel(options({ provider: 'relay', baseUrl, fetchImpl: async () => { calls++; } })),
      error => error.code === 'INVALID_BASE_URL' && error.message.includes('中转站'));
  }
  assert.equal(calls, 0);
});

test('relay forwards explicit generic effort choices when metadata is unknown without rewriting suffixes', async () => {
  const capabilities = [undefined, {}];
  const efforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let requests = 0;
  for (const apiProtocol of ['chat-completions', 'responses']) {
    for (const modelCapabilities of capabilities) {
      for (const reasoningEffort of efforts) {
        const selectedModel = 'gemini-4-argon-high';
        const result = await requestModel(options({ provider: 'relay', apiProtocol, model: selectedModel,
          reasoningEffort, modelCapabilities, fetchImpl: async (_url, init) => {
            requests++;
            const body = JSON.parse(init.body);
            assert.equal(body.model, selectedModel);
            if (apiProtocol === 'chat-completions') {
              assert.equal(body.reasoning_effort, reasoningEffort === 'default' ? undefined : reasoningEffort);
              assert.equal(body.reasoning, undefined);
            } else {
              assert.deepEqual(body.reasoning, reasoningEffort === 'default' ? undefined : { effort: reasoningEffort });
              assert.equal(body.reasoning_effort, undefined);
            }
            assert.equal(body.thinking, undefined);
            return json(apiProtocol === 'responses' ? { output: [] } : reply());
          } }));
        assert.ok(result.message);
      }
    }
  }
  assert.equal(requests, capabilities.length * efforts.length * 2, 'Exactly one inference request per user submission');
});

test('relay explicit empty effort metadata still omits overrides and malformed capabilities remain rejected', async () => {
  let requests = 0;
  for (const apiProtocol of ['chat-completions', 'responses']) {
    for (const reasoningEffort of ['default', 'none', 'high']) {
      await requestModel(options({ provider: 'relay', apiProtocol, reasoningEffort, modelCapabilities: { reasoningEfforts: [] },
        fetchImpl: async (_url, init) => {
          requests++;
          const body = JSON.parse(init.body);
          assert.equal(body.reasoning_effort, undefined);
          assert.equal(body.reasoning, undefined);
          return json(apiProtocol === 'responses' ? { output: [] } : reply());
        } }));
    }
    for (const modelCapabilities of [null, [], { reasoningEfforts: 'high' }, { reasoningEfforts: ['high', null] }]) {
      await assert.rejects(requestModel(options({ provider: 'relay', apiProtocol, reasoningEffort: 'high', modelCapabilities,
        fetchImpl: async () => { throw new Error('Malformed metadata must not start a request'); } })), { code: 'INVALID_MODEL_CONFIG' });
    }
    for (const reasoningEfforts of [['none'], ['ultra'], ['default']]) {
      await assert.rejects(requestModel(options({ provider: 'relay', apiProtocol, reasoningEffort: 'high', modelCapabilities: { reasoningEfforts },
        fetchImpl: async () => { throw new Error('Unsupported metadata effort must not start a request'); } })), { code: 'INVALID_REASONING_EFFORT' });
    }
  }
  assert.equal(requests, 6);
});

test('relay forwards only explicitly supported effort overrides and rejects unsupported levels before requesting', async () => {
  let requests = 0;
  const modelCapabilities = freeze({ reasoningEfforts: ['low', 'high'] });
  for (const apiProtocol of ['chat-completions', 'responses']) {
    await requestModel(options({ provider: 'relay', apiProtocol, reasoningEffort: 'high', modelCapabilities,
      fetchImpl: async (_url, init) => {
        requests++;
        const body = JSON.parse(init.body);
        if (apiProtocol === 'responses') assert.deepEqual(body.reasoning, { effort: 'high' });
        else assert.equal(body.reasoning_effort, 'high');
        return json(apiProtocol === 'responses' ? { output: [] } : reply());
      } }));
    await assert.rejects(requestModel(options({ provider: 'relay', apiProtocol, reasoningEffort: 'max', modelCapabilities,
      fetchImpl: async () => { throw new Error('Must not make an incompatible request'); } })), { code: 'INVALID_REASONING_EFFORT' });
  }
  assert.equal(requests, 2);
  assert.deepEqual(modelCapabilities, { reasoningEfforts: ['low', 'high'] });
});

test('HTTP 524 distinguishes Cloudflare upstream timeout and never retries or changes the model', async () => {
  let requests = 0;
  await assert.rejects(requestModel(options({ provider: 'relay', model: 'gemini-4-argon-low', reasoningEffort: 'high',
    fetchImpl: async (_url, init) => {
      requests++;
      assert.equal(JSON.parse(init.body).model, 'gemini-4-argon-low');
      assert.equal(JSON.parse(init.body).reasoning_effort, 'high');
      return new Response(JSON.stringify({ error: { code: 'server_error', message: `upstream timeout ${key}` } }), { status: 524 });
    } })), error => {
      assert.equal(error.code, 'PROVIDER_HTTP_524');
      assert.match(error.message, /Cloudflare.*上游.*超时/u);
      assert.match(error.message, /server_error/u);
      assert.doesNotMatch(error.message, /模型不存在|推理强度不受支持|placeholder-chat-protocol-key/u);
      return true;
    });
  assert.equal(requests, 1);
});

test('fragmented Chat SSE tool calls round-trip once with tool results, images, final usage and private progress', async () => {
  const messages = [freeze({ role: 'system', content: 'Use tools.' }),
    freeze({ role: 'user', content: 'Inspect 图片.', attachments: [image] })];
  const bodies = [], deltas = [], progress = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return streaming([
      { choices: [{ index: 0, delta: { reasoning_content: 'private-relay-thinking' } }] },
      { choices: [{ index: 0, delta: { content: '读取' } }] },
      { choices: [{ index: 0, delta: { content: '中。', tool_calls: [
        { index: 0, id: 'call-read', type: 'function', function: { name: 'read_', arguments: '{"pa' } },
      ] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, function: { name: 'file', arguments: 'th":"note.txt"}' } },
      ] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } }, '[DONE]',
    ], 5);
    assert.equal(bodies.length, 2);
    const assistant = bodies[1].messages.find(item => item.role === 'assistant');
    assert.deepEqual(assistant, { role: 'assistant', content: '读取中。', tool_calls: [
      { id: 'call-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
    ] });
    assert.deepEqual(bodies[1].messages.at(-1), { role: 'tool', tool_call_id: 'call-read', content: 'Read-only fixture result.' });
    assert.equal(JSON.stringify(bodies[1]).includes('private-relay-thinking'), false);
    return streaming([{ choices: [{ index: 0, delta: { content: '完成。' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }, '[DONE]']);
  };
  const first = await requestModel(options({ messages, fetchImpl, onTextDelta: text => deltas.push(text), onProgress: sample => progress.push(sample) }));
  assert.equal(first.message.content, '读取中。');
  assert.deepEqual(first.message.toolCalls, [{ id: 'call-read', name: 'read_file', arguments: { path: 'note.txt' } }]);
  assert.deepEqual(first.usage, { inputTokens: 21, outputTokens: 9 });
  assert.equal(first.usageReported, true);
  assert.deepEqual(deltas, ['读取', '中。']);
  assert.ok(progress.some(sample => sample.phase === 'thinking'));
  assert.ok(progress.some(sample => sample.phase === 'tool-call'));
  assert.ok(progress.some(sample => sample.usage?.outputTokens === 9));
  assert.equal(JSON.stringify([progress, first.message.providerState]).includes('private-relay-thinking'), false);
  messages.push(freeze(first.message), freeze({ role: 'tool', toolCallId: 'call-read', content: 'Read-only fixture result.' }));
  const second = await requestModel(options({ messages, fetchImpl }));
  assert.equal(second.message.content, '完成。');
  assert.deepEqual(second.usage, { inputTokens: 30, outputTokens: 4 });
  for (const body of bodies) assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'Inspect 图片.' }, { type: 'image_url', image_url: { url: image.dataUrl } },
  ]);
  assert.equal(messages[1].attachments[0], image);
});

test('Chat JSON supports image-only input and tool calls without reported usage or reasoning overrides', async () => {
  const original = freeze({ role: 'user', content: '', attachments: [image] });
  const result = await requestModel(options({ messages: [original], fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image.dataUrl } }] }]);
    return json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'json-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } },
    ] }, finish_reason: 'tool_calls' }] });
  } }));
  assert.deepEqual(result.message.toolCalls, [{ id: 'json-call', name: 'read_file', arguments: { path: 'fixture.txt' } }]);
  assert.equal(result.usageReported, false);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(original.attachments[0], image);
});

test('switching Responses, Chat and DeepSeek never replays another protocol private native state', async () => {
  const toolCall = { id: 'old-call', name: 'read_file', arguments: { path: 'old.txt' } };
  const assistant = { role: 'assistant', content: 'Previous public text.', toolCalls: [toolCall],
    providerState: { provider: 'openai', model, endpoint: 'https://relay.example/gateway/v1/responses',
      output: [{ type: 'reasoning', encrypted_content: 'private-response-item' }] } };
  const messages = [...options().messages, assistant, { role: 'tool', toolCallId: 'old-call', content: 'prior result' }];
  const chat = await requestModel(options({ messages, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.body.includes('private-response-item'), false);
    assert.equal(body.messages[2].tool_calls[0].id, 'old-call');
    return json(reply());
  } }));
  // The hypothetical opaque marker must not cross endpoint/model/protocol or auth boundaries.
  chat.message.providerState.message.fixture_marker = 'private-chat-marker';
  messages.push(chat.message);
  for (const change of [{ apiProtocol: 'responses' }, { baseUrl: 'https://relay.example/other/v1' }, { model: 'changed-model' },
    { provider: 'deepseek' }]) {
    await requestModel(options({ ...change, messages, fetchImpl: async (url, init) => {
      assert.equal(init.body.includes('private-chat-marker'), false);
      assert.equal(init.body.includes('private-response-item'), url.endsWith('/responses'));
      if (url.endsWith('/responses')) return json({ output: [] });
      return json(reply());
    } }));
  }
});

test('models suffixes normalize across providers and matching full endpoints preserve custom prefixes', async () => {
  for (const [provider, apiProtocol, resource] of [
    ['openai', 'responses', 'responses'], ['openai', 'chat-completions', 'chat/completions'],
    ['relay', undefined, 'chat/completions'], ['relay', 'responses', 'responses'],
    ['deepseek', undefined, 'chat/completions'], ['anthropic', undefined, 'messages'],
  ]) {
    for (const suffix of ['models/', resource + '/', '']) {
      await requestModel(options({ provider, apiProtocol, baseUrl: `https://relay.example/custom/v1/${suffix}`,
        fetchImpl: async url => {
          assert.equal(url, `https://relay.example/custom/v1/${resource}`);
          return json(resource === 'responses' ? { output: [] } : resource === 'messages' ? { content: [] } : reply());
        } }));
    }
  }
});

test('a mismatched complete request endpoint is rejected locally instead of duplicating paths or switching protocol', async () => {
  let calls = 0;
  for (const [provider, apiProtocol, resource] of [
    ['openai', 'responses', 'chat/completions'], ['openai', 'chat-completions', 'responses'],
    ['relay', undefined, 'responses'], ['relay', 'responses', 'messages'],
    ['deepseek', undefined, 'responses'], ['anthropic', undefined, 'chat/completions'],
  ]) await assert.rejects(requestModel(options({ provider, apiProtocol, baseUrl: `https://relay.example/v1/${resource}`,
    fetchImpl: async () => { calls++; } })), error => error.code === 'API_PROTOCOL_MISMATCH' && error.message.includes('协议不匹配'));
  assert.equal(calls, 0);
});

test('404 names selected protocol and safe actual path, preserves server code and sends exactly one request', async () => {
  for (const [provider, apiProtocol, name, resource] of [
    ['openai', 'responses', 'OpenAI Responses', 'responses'],
    ['openai', 'chat-completions', 'OpenAI Chat Completions', 'chat/completions'],
    ['relay', undefined, '中转站 Chat Completions', 'chat/completions'],
    ['anthropic', undefined, 'Claude Messages', 'messages'],
  ]) {
    let calls = 0;
    await assert.rejects(requestModel(options({ provider, apiProtocol,
      baseUrl: `https://relay.example/private/${key}/v1/models`, fetchImpl: async () => {
        calls++; return new Response(JSON.stringify({ error: { code: 'server_error', private_body: 'never-echo-this' } }), { status: 404 });
      } })), error => {
      assert.equal(error.code, 'PROVIDER_HTTP_404');
      assert.ok(error.message.includes(name));
      assert.ok(error.message.includes(`/v1/${resource}`));
      assert.ok(error.message.includes('server_error'));
      assert.ok(error.message.includes('模型目录可用不代表'));
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes('never-echo-this'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Chat cancellation aborts a pending stream promptly without retrying and releases its reader', async () => {
  const controller = new AbortController();
  let calls = 0, cancelled = 0, signal;
  const result = requestModel(options({ signal: controller.signal, fetchImpl: async (_url, init) => {
    calls++; signal = init.signal;
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(event({ choices: [{ index: 0, delta: { content: 'partial' } }] })));
    }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  }, onTextDelta: () => controller.abort() }));
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test('Chat shares wire, event and private reasoning payload caps and reports usage before truncation', async () => {
  for (const [extra, code, values] of [
    [{ maxResponseBytes: 16 }, 'PROVIDER_RESPONSE_TOO_LARGE', [{ choices: [] }, '[DONE]']],
    [{ maxEventBytes: 64 }, 'PROVIDER_EVENT_TOO_LARGE', [{ choices: [{ delta: { content: 'a'.repeat(120) } }] }, '[DONE]']],
    [{ maxModelPayloadBytes: 128 }, 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE', [{ choices: [{ delta: { reasoning_content: 'r'.repeat(200) } }] }, '[DONE]']],
    [{}, 'PROVIDER_TRUNCATED', [{ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 8 } }]],
  ]) {
    const progress = [];
    await assert.rejects(requestModel(options({ ...extra, onProgress: value => progress.push(value),
      fetchImpl: async () => streaming(values) })), { code });
    if (code === 'PROVIDER_TRUNCATED') assert.ok(progress.some(sample => sample.usage?.inputTokens === 5 && sample.usage?.outputTokens === 8));
  }
  await assert.rejects(requestModel(options({ fetchImpl: async () => streaming([
    { choices: [{ index: 0, delta: { content: 'Unterminated.' }, finish_reason: 'stop' }] },
  ]) })), { code: 'PROVIDER_INCOMPLETE_STREAM' });
});

test('invalid protocols and explicit incompatible capabilities fail before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Must not send.'); };
  for (const provider of ['openai', 'relay']) {
    await assert.rejects(requestModel(options({ provider, apiProtocol: 'guessed-auto', fetchImpl })), { code: 'INVALID_API_PROTOCOL' });
    await assert.rejects(requestModel(options({ provider, modelCapabilities: { supportsTools: false }, fetchImpl })), { code: 'MODEL_TOOLS_UNSUPPORTED' });
    await assert.rejects(requestModel(options({ provider, messages: [{ role: 'user', content: '', attachments: [image] }],
      modelCapabilities: { supportsImages: false }, fetchImpl })), { code: 'MODEL_IMAGES_UNSUPPORTED' });
  }
  assert.equal(calls, 0);
});

test('ChatGPT ignores saved API protocol preferences and only sends OAuth to official Responses', async () => {
  const urls = [];
  for (const apiProtocol of ['chat-completions', 'responses']) {
    await requestModel(options({ authMode: 'chatgpt', apiProtocol, baseUrl: 'https://api.openai.com/v1',
      fetchImpl: async (url, init) => {
        urls.push(url); const body = JSON.parse(init.body);
        assert.equal(body.messages, undefined); assert.ok(Array.isArray(body.input));
        assert.equal(body.tools[0].type, 'namespace');
        return streaming([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
      } }));
  }
  assert.deepEqual(urls, ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
  let calls = 0;
  for (const extra of [
    { baseUrl: 'https://relay.example/v1' }, { baseUrl: 'https://api.openai.com/v1/chat/completions' },
    { provider: 'relay', baseUrl: 'https://api.openai.com/v1' },
  ]) await assert.rejects(requestModel(options({ authMode: 'chatgpt', ...extra,
    fetchImpl: async () => { calls++; } })), error => ['INVALID_CHATGPT_BASE_URL', 'API_PROTOCOL_MISMATCH', 'INVALID_AUTH_MODE'].includes(error.code));
  assert.equal(calls, 0);
});
