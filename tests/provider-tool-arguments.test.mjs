import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

const apiKey = 'synthetic-tool-arguments-secret';
const model = 'relay-tool-fixture';
const baseUrl = 'https://tool-fixture.invalid/v1';
const messages = [{ role: 'user', content: 'Use the fixture tool.' }];
const tools = [{ name: 'write_file', description: 'Fixture only; never executes.', parameters: {
  type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
} }];
const options = (apiProtocol, extra = {}) => ({
  provider: 'relay', apiProtocol, apiKey, model, baseUrl, messages, tools, ...extra,
});
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const responseCall = (args, extra = {}) => ({
  type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'write_file', arguments: args, ...extra,
});
const chatCall = (args, extra = {}) => ({
  id: 'call-1', type: 'function', function: { name: 'write_file', arguments: args }, ...extra,
});
const completed = output => ({ type: 'response.completed', response: { status: 'completed', output,
  usage: { input_tokens: 21, output_tokens: 9 } } });
const chatDelta = (delta, extra = {}) => ({ choices: [{ index: 0, delta, ...extra }] });
const chatReply = args => ({ choices: [{ index: 0, message: {
  role: 'assistant', content: null, tool_calls: [chatCall(args)],
}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 21, completion_tokens: 9 } });
const bodyFor = (protocol, args) => protocol === 'responses'
  ? { status: 'completed', output: [responseCall(args)], usage: { input_tokens: 21, output_tokens: 9 } }
  : chatReply(args);

function stream(values, fragmentSize = 37) {
  const bytes = new TextEncoder().encode(values.map(value =>
    'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n').join(''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + fragmentSize, bytes.length);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

const source = [
  '<!doctype html>', '<script>',
  'const windowsPath = "C:\\\\Users\\\\fixture\\\\new\\\\tool.txt";',
  'const escaped = "\\n\\t\\r\\b\\f\\u2028";',
  'const symbols = "中文 👩🏽‍💻 🦢 \\"quoted\\" \\\\";',
  'const template = String.raw' + String.fromCharCode(96) + 'line\\n$' + '{literal}' + String.fromCharCode(96) + ';',
  '</script>',
].join('\r\n');
const args = { path: 'C:\\fixture\\中文\\new.html', content: source };

test('relay JSON object arguments round-trip as strings without changing code or opaque reasoning', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    let requests = 0;
    const opaque = { type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: 'opaque-fixture==',
      unknown_extension: { keep: ['unchanged', 1] } };
    const result = await requestModel(options(protocol, { fetchImpl: async () => {
      requests++;
      const body = bodyFor(protocol, args);
      if (protocol === 'responses') body.output.unshift(opaque);
      return json(body);
    } }));
    assert.equal(requests, 1);
    assert.deepEqual(result.message.toolCalls, [{ id: 'call-1', name: 'write_file', arguments: args }]);
    assert.deepEqual(result.usage, { inputTokens: 21, outputTokens: 9 });
    if (protocol === 'responses') {
      assert.deepEqual(result.message.providerState.output[0], opaque);
      assert.equal(typeof result.message.providerState.output[1].arguments, 'string');
    }
    await requestModel(options(protocol, {
      messages: [...messages, result.message, { role: 'tool', toolCallId: 'call-1', content: 'Fixture result.' }],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        const raw = protocol === 'responses'
          ? body.input.find(item => item.type === 'function_call').arguments
          : body.messages.find(item => item.role === 'assistant').tool_calls[0].function.arguments;
        assert.equal(typeof raw, 'string');
        assert.deepEqual(JSON.parse(raw), args);
        if (protocol === 'responses') assert.deepEqual(body.input.find(item => item.type === 'reasoning'), opaque);
        return json(protocol === 'responses' ? { status: 'completed', output: [] }
          : { choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] });
      },
    }));
  }
});

test('old Responses history normalizes only object arguments on replay and leaves frozen state unchanged', async () => {
  const opaque = Object.freeze({ type: 'reasoning', summary: [], encrypted_content: 'old-opaque==' });
  const oldCall = Object.freeze(responseCall(Object.freeze({ ...args })));
  const output = Object.freeze([opaque, oldCall]);
  const state = Object.freeze({ provider: 'openai', model, endpoint: baseUrl + '/responses', output });
  const history = [...messages, Object.freeze({ role: 'assistant', content: '', providerState: state,
    toolCalls: [Object.freeze({ id: 'call-1', name: 'write_file', arguments: { ...args } })] }),
  { role: 'tool', toolCallId: 'call-1', content: 'Fixture result.' }];
  await requestModel(options('responses', { messages: history, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.input.find(item => item.type === 'reasoning'), opaque);
    assert.deepEqual(body.input.find(item => item.type === 'function_call'), {
      ...oldCall, arguments: JSON.stringify(args),
    });
    return json({ status: 'completed', output: [] });
  } }));
  assert.equal(state.output, output);
  assert.equal(typeof oldCall.arguments, 'object');
});

test('Responses accepts object done snapshots after matching deltas once, preserving code characters', async () => {
  const raw = JSON.stringify(args, null, 2);
  const progress = [];
  const result = await requestModel(options('responses', { onProgress: value => progress.push(value),
    fetchImpl: async () => stream([
      { type: 'response.output_item.added', output_index: 0, item: responseCall('') },
      ...raw.split('').map(delta => ({ type: 'response.function_call_arguments.delta', output_index: 0, delta })),
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
      { type: 'response.output_item.done', output_index: 0, item: responseCall({ content: source, path: args.path }) },
      completed([responseCall(args)]),
    ], 1) }));
  assert.deepEqual(result.message.toolCalls, [{ id: 'call-1', name: 'write_file', arguments: args }]);
  assert.deepEqual(JSON.parse(result.message.providerState.output[0].arguments), args);
  assert.equal(JSON.stringify(progress).includes(source), false);
});

test('Responses blank/missing done placeholders preserve valid objects and native state but never invent {}', async () => {
  for (const placeholder of ['', ' \n', undefined]) {
    const result = await requestModel(options('responses', { fetchImpl: async () => stream([
      { type: 'response.output_item.added', output_index: 0, item: responseCall('') },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(args) },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: placeholder },
      { type: 'response.output_item.done', output_index: 0, item: responseCall(placeholder) },
      completed([responseCall(placeholder)]),
    ]) }));
    assert.deepEqual(result.message.toolCalls[0].arguments, args);
    assert.deepEqual(JSON.parse(result.message.providerState.output[0].arguments), args);
    await assert.rejects(requestModel(options('responses', {
      fetchImpl: async () => stream([completed([responseCall(placeholder)])]),
    })), error => error.code === 'INVALID_TOOL_ARGUMENTS' && /为空/u.test(error.message));
  }
});

test('Chat SSE object parameters and complete message snapshots preserve tools and complex code', async () => {
  for (const mode of ['object-delta', 'message-only', 'message-after-delta', 'string-deltas']) {
    let events;
    if (mode === 'object-delta') events = [chatDelta({ tool_calls: [{ index: 0, ...chatCall(args) }] })];
    else if (mode === 'string-deltas') events = JSON.stringify(args).split('').map((delta, index) => chatDelta({
      tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call-1', type: 'function' } : {}),
        function: { ...(index === 0 ? { name: 'write_file' } : {}), arguments: delta } }],
    }));
    else {
      events = mode === 'message-after-delta'
        ? [chatDelta({ tool_calls: [{ index: 0, ...chatCall(JSON.stringify(args)) }] })] : [];
      events.push({ choices: [{ index: 0, message: {
        role: 'assistant', content: 'Writing.', tool_calls: [chatCall(args)],
      }, finish_reason: 'tool_calls' }] });
    }
    const result = await requestModel(options('chat-completions', { fetchImpl: async () =>
      stream([...events, chatDelta({}, { finish_reason: 'tool_calls' }), '[DONE]'], 1),
    }));
    assert.deepEqual(result.message.toolCalls, [{ id: 'call-1', name: 'write_file', arguments: args }]);
  }
});

test('complete snapshots reject argument and identity conflicts rather than replacing received calls', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    for (const kind of ['arguments', 'id', 'name']) {
      const conflicting = kind === 'arguments' ? { ...args, path: 'different.html' } : args;
      const completeCall = protocol === 'responses'
        ? responseCall(conflicting, kind === 'id' ? { call_id: 'changed-id' } : kind === 'name' ? { name: 'different_tool' } : {})
        : chatCall(conflicting, kind === 'id' ? { id: 'changed-id' }
          : kind === 'name' ? { function: { name: 'different_tool', arguments: args } } : {});
      const events = protocol === 'responses' ? [
        { type: 'response.output_item.added', output_index: 0, item: responseCall('') },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(args) },
        completed([completeCall]),
      ] : [
        chatDelta({ tool_calls: [{ index: 0, ...chatCall(JSON.stringify(args)) }] }),
        { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [completeCall] },
          finish_reason: 'tool_calls' }] }, '[DONE]',
      ];
      await assert.rejects(requestModel(options(protocol, { fetchImpl: async () => stream(events) })),
        error => error.code === (kind === 'arguments' ? 'INVALID_TOOL_ARGUMENTS' : 'INVALID_TOOL_CALL'));
    }
  }
});

test('Chat rejects omitted calls, late object-snapshot fragments and cumulative pseudo-deltas without repair', async () => {
  const prefixes = [
    [chatDelta({ tool_calls: [{ index: 0, ...chatCall(args) }] }),
      { choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'tool_calls' }] }],
    [chatDelta({ tool_calls: [{ index: 0, ...chatCall(args) }] }),
      chatDelta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] })],
    [chatDelta({ tool_calls: [{ index: 0, ...chatCall('{"path":') }] }),
      chatDelta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })],
  ];
  for (const events of prefixes) {
    await assert.rejects(requestModel(options('chat-completions', { fetchImpl: async () =>
      stream([...events, chatDelta({}, { finish_reason: 'tool_calls' }), '[DONE]']),
    })), error => ['INVALID_TOOL_CALL', 'INVALID_TOOL_ARGUMENTS'].includes(error.code));
  }
});

test('diagnostics distinguish empty, malformed and non-object parameters without raw data or reflected names', async () => {
  const fence = String.fromCharCode(96).repeat(3);
  const failures = [
    ['', /为空/u], [' \n', /为空/u], [undefined, /为空/u],
    ['{"content":"private-marker"', /不是有效 JSON/u],
    ['{"content":"bad\\q-private-marker"}', /不是有效 JSON/u],
    ['{"content":"private-marker"} trailing', /不是有效 JSON/u],
    [fence + 'json\n{"content":"private-marker"}\n' + fence, /不是有效 JSON/u],
    ['[]', /必须是 JSON 对象/u], ['null', /必须是 JSON 对象/u],
    ['"private-marker"', /必须是 JSON 对象/u],
    [null, /必须是 JSON 对象/u], [[], /必须是 JSON 对象/u],
  ];
  for (const protocol of ['responses', 'chat-completions']) {
    for (const [raw, reason] of failures) {
      let requests = 0;
      await assert.rejects(requestModel(options(protocol, { fetchImpl: async () => {
        requests++; return json(bodyFor(protocol, raw));
      } })), error => {
        assert.equal(error.code, 'INVALID_TOOL_ARGUMENTS');
        assert.match(error.message, protocol === 'responses' ? /中转站 Responses/u : /中转站 Chat Completions/u);
        assert.match(error.message, /write_file/u);
        assert.match(error.message, reason);
        assert.doesNotMatch(error.message, /private-marker|synthetic-tool-arguments-secret/u);
        return true;
      });
      assert.equal(requests, 1);
    }
    for (const name of [apiKey, 'malicious-provider-marker', 'bad\nname']) {
      const body = bodyFor(protocol, 'not JSON private-marker');
      if (protocol === 'responses') body.output[0].name = name;
      else body.choices[0].message.tool_calls[0].function.name = name;
      await assert.rejects(requestModel(options(protocol, { fetchImpl: async () => json(body) })), error => {
        assert.equal(error.code, 'INVALID_TOOL_ARGUMENTS');
        assert.doesNotMatch(error.message, /private-marker|malicious-provider-marker|synthetic-tool-arguments-secret|bad\nname/u);
        return true;
      });
    }
  }
});

test('object snapshots and retained blank fallbacks share payload limits and preserve already reported usage', async () => {
  const large = { path: 'fixture.html', content: 'x'.repeat(900) };
  for (const protocol of ['responses', 'chat-completions']) {
    const progress = [];
    await assert.rejects(requestModel(options(protocol, { maxModelPayloadBytes: 700,
      onProgress: event => progress.push(event), fetchImpl: async () => json(bodyFor(protocol, large)),
    })), { code: 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE' });
    assert.ok(progress.some(event => event.usage?.inputTokens === 21 && event.usage?.outputTokens === 9));
  }
  await assert.rejects(requestModel(options('responses', { maxModelPayloadBytes: 1600, fetchImpl: async () => stream([
    { type: 'response.output_item.added', output_index: 0, item: responseCall('') },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(large) },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '' },
    { type: 'response.output_item.added', output_index: 1, item: responseCall('', { id: 'fc-2', call_id: 'call-2' }) },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: JSON.stringify(large) },
    completed([]),
  ]) })), { code: 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE' });
});

test('object compatibility retains secret scanning and fails closed on truncation or disconnection', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    await assert.rejects(requestModel(options(protocol, { fetchImpl: async () =>
      json(bodyFor(protocol, { path: 'fixture.html', content: apiKey })),
    })), { code: 'PROVIDER_SECRET_IN_RESPONSE' });
    const events = protocol === 'responses' ? [
      { type: 'response.output_item.done', output_index: 0, item: responseCall(args) },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ] : [chatDelta({ tool_calls: [{ index: 0, ...chatCall(args) }] }, { finish_reason: 'length' }), '[DONE]'];
    await assert.rejects(requestModel(options(protocol, { fetchImpl: async () => stream(events) })),
      { code: 'PROVIDER_TRUNCATED' });
    const interrupted = protocol === 'responses'
      ? [{ type: 'response.output_item.done', output_index: 0, item: responseCall(args) }]
      : [chatDelta({ tool_calls: [{ index: 0, ...chatCall(args) }] })];
    await assert.rejects(requestModel(options(protocol, { fetchImpl: async () => stream(interrupted) })),
      { code: 'PROVIDER_INCOMPLETE_STREAM' });
  }
});

test('Chat content and refusal retain their ordered text in JSON and explicit message snapshots', async () => {
  const message = { role: 'assistant', content: 'Visible text. ', refusal: 'Refusal text.' };
  for (const mode of ['json', 'snapshot']) {
    const result = await requestModel(options('chat-completions', { fetchImpl: async () => mode === 'json'
      ? json({ choices: [{ index: 0, message, finish_reason: 'stop' }] })
      : stream([chatDelta({ content: message.content }), chatDelta({ refusal: message.refusal }),
        { choices: [{ index: 0, message, finish_reason: 'stop' }] }, '[DONE]']),
    }));
    assert.equal(result.message.content, message.content + message.refusal);
  }
});

test('Chat rejects explicit unsupported snapshot types instead of reusing a preceding function delta', async () => {
  for (const withDelta of [false, true]) {
    const events = withDelta ? [chatDelta({ tool_calls: [{ index: 0, ...chatCall(JSON.stringify(args)) }] })] : [];
    events.push({ choices: [{ index: 0, message: { role: 'assistant', content: null,
      tool_calls: [chatCall(args, { type: 'custom' })] }, finish_reason: 'tool_calls' }] }, '[DONE]');
    await assert.rejects(requestModel(options('chat-completions', { fetchImpl: async () => stream(events) })),
      { code: 'INVALID_TOOL_CALL' });
  }
});
