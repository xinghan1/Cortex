import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';

const secret = 'synthetic-arguments-api-key';
const privateMarker = 'PRIVATE_TOOL_ARGUMENTS_MUST_NOT_LEAK';
const tools = [{ name: 'write_file', description: 'Write a synthetic fixture.', parameters: {
  type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
} }];
const reportedUsage = { inputTokens: 43, outputTokens: 17, cachedInputTokens: 11 };
const usageFor = protocol => protocol === 'responses'
  ? { input_tokens: 43, output_tokens: 17, input_tokens_details: { cached_tokens: 11 } }
  : { prompt_tokens: 43, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 11 } };
const call = (id, args) => ({ id, name: 'write_file', args });
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function toolResponse(protocol, calls) {
  const usage = usageFor(protocol);
  return protocol === 'responses'
    ? { status: 'completed', output: calls.map(value => ({ type: 'function_call', call_id: value.id,
      name: value.name, arguments: value.args })), usage }
    : { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: calls.map(value => ({
      id: value.id, type: 'function', function: { name: value.name, arguments: value.args },
    })) }, finish_reason: 'tool_calls' }], usage };
}

function streamedToolResponse(protocol, calls, usagePlacement = 'after') {
  if (protocol === 'responses') return new Response(event({ type: 'response.completed', response: toolResponse(protocol, calls) }),
    { headers: { 'content-type': 'text/event-stream' } });
  const usage = usageFor(protocol);
  const toolFrame = { choices: [{ index: 0, delta: { tool_calls: calls.map((value, index) => ({
    index, id: value.id, type: 'function', function: { name: value.name, arguments: value.args },
  })) }, finish_reason: 'tool_calls' }], ...(usagePlacement === 'same' ? { usage } : {}) };
  const values = [...(usagePlacement === 'before' ? [{ choices: [], usage }] : []), toolFrame,
    ...(usagePlacement === 'after' ? [{ choices: [], usage }] : []), '[DONE]'];
  const wire = values.map(event).join('');
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
}

async function rejectToolBatch(protocol, calls, transport, { usagePlacement = 'after', usageReported = true } = {}) {
  let requests = 0, executions = 0, caught;
  const messages = [{ role: 'user', content: 'Use the fixture tools.' }], events = [], records = [], context = [];
  await assert.rejects(runAgent({
    config: { provider: 'relay', apiProtocol: protocol, apiKey: secret, baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model',
      fetchImpl: async (endpoint, init) => {
        requests++;
        assert.equal(endpoint, `https://fixture.invalid/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
        const body = JSON.parse(init.body);
        assert.equal(body.stream, true);
        return transport === 'sse' ? streamedToolResponse(protocol, calls, usagePlacement) : json(toolResponse(protocol, calls));
      } },
    messages, workspace: { root: 'C:/synthetic-fixture', execute: async () => { executions++; return 'Must not execute.'; } },
    toolDefinitions: tools, requestModel, signal: new AbortController().signal,
    emit: value => events.push(value), onUsage: async value => records.push(value), onContextUsage: value => context.push(value),
  }), error => {
    caught = error;
    assert.equal(error.code, 'INVALID_TOOL_ARGUMENTS');
    return true;
  });
  assert.equal(requests, 1, 'A format error must not trigger another billed model request');
  assert.equal(executions, 0, 'The whole batch must validate before any tool executes');
  assert.equal(events.some(value => value.type === 'tool-start' || value.type === 'tool-result'), false);
  assert.equal(messages.some(value => value.toolCalls?.length || value.role === 'tool'), false);
  assert.equal(records.length, 1);
  assert.deepEqual({ inputTokens: records[0].inputTokens, outputTokens: records[0].outputTokens,
    cachedInputTokens: records[0].cachedInputTokens }, usageReported ? reportedUsage
      : { inputTokens: null, outputTokens: null, cachedInputTokens: undefined });
  assert.equal(records[0].reported, usageReported);
  assert.equal(records[0].partial, true);
  assert.equal(records[0].status, 'failed');
  assert.deepEqual(events.filter(value => value.type === 'usage').at(-1), { type: 'usage',
    inputTokens: usageReported ? 43 : 0, outputTokens: usageReported ? 17 : 0 });
  const surfaced = JSON.stringify({ error: { code: caught.code, message: caught.message,
    cause: caught.cause?.message }, messages, events, records, context });
  assert.equal(surfaced.includes(privateMarker), false, 'Arguments must not leak through errors, history, telemetry, or accounting');
  assert.equal(surfaced.includes(secret), false);
}

test('invalid arguments in the second tool prevent the first valid tool from executing', async t => {
  for (const protocol of ['responses', 'chat-completions']) {
    for (const transport of ['json', 'sse']) await t.test(`${protocol} ${transport}`, async () => {
      await rejectToolBatch(protocol, [
        call('valid-first', JSON.stringify({ path: 'first.txt', content: privateMarker })),
        call('invalid-second', `{"path":"second.txt","content":"${privateMarker}"`),
      ], transport);
    });
  }
});

test('malformed or non-object parameters fail closed and retain reported usage for both relay protocols', async t => {
  const invalid = [
    ['unfinished JSON', `{"path":"fixture.txt","content":"${privateMarker}"`],
    ['illegal escape', String.raw`{"path":"folder\qfixture.txt","content":"${privateMarker}"}`],
    ['trailing text', JSON.stringify({ path: 'fixture.txt', content: privateMarker }) + ' trailing'],
    ['empty arguments', ''],
    ['JSON null', 'null'],
    ['JSON array', JSON.stringify([{ path: privateMarker }])],
    ['null arguments', null],
    ['array arguments', [privateMarker]],
  ];
  for (const protocol of ['responses', 'chat-completions']) {
    for (const transport of ['json', 'sse']) {
      for (const [label, args] of invalid) await t.test(`${protocol} ${transport}: ${label}`, async () => {
        await rejectToolBatch(protocol, [call('invalid-tool', args)], transport, {
          // A known invalid type can stop the stream immediately. A later
          // usage-only frame is not an already-reported consumption value.
          usageReported: !(protocol === 'chat-completions' && transport === 'sse' && typeof args !== 'string'),
        });
      });
    }
  }
});

test('fail-fast tool type errors retain only usage already received, without reading future usage frames', async t => {
  for (const usagePlacement of ['before', 'same', 'after']) await t.test(usagePlacement, async () => {
    await rejectToolBatch('chat-completions', [call('invalid-null', null)], 'sse', {
      usagePlacement, usageReported: usagePlacement !== 'after',
    });
  });
});

function byteFragmentedStream(values) {
  const wire = new TextEncoder().encode(values.map(event).join(''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= wire.length) { controller.close(); return; }
    // This also splits multibyte UTF-8, CRLF and JSON-escaped Unicode pairs.
    controller.enqueue(wire.slice(offset, offset + 1));
    offset++;
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

function argumentFragments(protocol, args) {
  const raw = JSON.stringify(args), values = [];
  if (protocol === 'responses') {
    values.push({ type: 'response.output_item.added', output_index: 0, item: {
      type: 'function_call', id: 'item-1', call_id: 'complex-1', name: 'write_file', arguments: '',
    } });
    for (let index = 0; index < raw.length; index++) values.push({ type: 'response.function_call_arguments.delta',
      output_index: 0, item_id: 'item-1', delta: raw[index] });
    // No final full-arguments snapshot: success must come from the deltas.
    values.push({ type: 'response.completed', response: { status: 'completed', usage: usageFor(protocol) } });
  } else {
    for (let index = 0; index < raw.length; index++) values.push({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, ...(index === 0 ? { id: 'complex-1', type: 'function' } : {}),
      function: { ...(index === 0 ? { name: 'write_file' } : {}), arguments: raw[index] },
    }] } }] });
    values.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: usageFor(protocol) }, '[DONE]');
  }
  return byteFragmentedStream(values);
}

test('complex code and Windows path strings survive character deltas and byte-level network fragmentation', async t => {
  const args = { path: 'folder/file.txt', content: String.raw`const path = "C:\\Users\\fixture\\代码";` + '\r\n'
    + String.raw`const message = "quoted \"text\" and braces { [] }";` + '\n'
    + String.raw`const data = { emoji: "😀", nested: "{\"ok\":true}" };` + '\n' };
  for (const protocol of ['responses', 'chat-completions']) await t.test(protocol, async () => {
    let requests = 0;
    const executions = [], messages = [{ role: 'user', content: 'Write the synthetic file.' }], records = [];
    await runAgent({ config: { provider: 'relay', apiProtocol: protocol, apiKey: secret, model: 'fixture-model',
      baseUrl: 'https://fixture.invalid/v1', fetchImpl: async (_endpoint, init) => {
        requests++;
        if (requests === 1) return argumentFragments(protocol, args);
        assert.equal(requests, 2);
        const body = JSON.parse(init.body);
        if (protocol === 'responses') {
          const priorCall = body.input.find(value => value.type === 'function_call');
          assert.deepEqual(JSON.parse(priorCall.arguments), args);
          assert.equal(body.input.at(-1).type, 'function_call_output');
        } else {
          const priorCall = body.messages.find(value => value.role === 'assistant').tool_calls[0];
          assert.deepEqual(JSON.parse(priorCall.function.arguments), args);
          assert.equal(body.messages.at(-1).role, 'tool');
        }
        return json(protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Fixture complete.' }] }], usage: usageFor(protocol) }
          : { choices: [{ message: { content: 'Fixture complete.' }, finish_reason: 'stop' }], usage: usageFor(protocol) });
      } }, messages, workspace: { root: 'C:/synthetic-fixture', execute: async (name, argumentsObject) => {
        executions.push({ name, arguments: argumentsObject }); return 'Synthetic fixture written.';
      } }, toolDefinitions: tools, requestModel, signal: new AbortController().signal, emit: () => {},
    onUsage: async value => records.push(value) });
    assert.equal(requests, 2, 'One tool response and one final answer, without a repair request');
    assert.deepEqual(executions, [{ name: 'write_file', arguments: args }]);
    assert.equal(messages.at(-1).content, 'Fixture complete.');
    assert.equal(records.length, 2);
    assert.ok(records.every(value => value.status === 'completed' && value.reported));
  });
});
