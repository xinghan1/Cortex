import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

const encoder = new TextEncoder();
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const deepseek = (delta = {}, extra = {}) => ({ choices: [{ index: 0, delta }], ...extra });
const options = extra => ({
  provider: 'deepseek', model: 'local-limits-fixture', apiKey: 'unit-test-placeholder',
  baseUrl: 'https://unit-test.invalid/v1', messages: [{ role: 'user', content: 'Fixture only.' }], ...extra,
});

function fixture(chunks, contentType = 'text/event-stream') {
  const observed = { cancelled: 0, calls: 0 };
  const bytes = chunks.map(chunk => typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes[index++]);
      else controller.close();
    },
    cancel() { observed.cancelled += 1; },
  }, { highWaterMark: 0 });
  return {
    observed,
    fetchImpl: async () => { observed.calls += 1; return new Response(body, { headers: { 'Content-Type': contentType } }); },
  };
}

function split(value, length = 23) {
  const bytes = encoder.encode(value);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += length) chunks.push(bytes.subarray(index, index + length));
  return chunks;
}

test('default SSE wire budget accepts >8 MiB keepalives and repeated metadata while retaining only small private reasoning', async () => {
  const privateReasoning = 'limits-private-reasoning';
  const comment = encoder.encode(': keepalive ' + 'x'.repeat(16 * 1024) + '\n\n');
  const metadata = encoder.encode(event({ choices: [], fixture_metadata: 'ignored'.repeat(100) }));
  const chunks = [...Array(576).fill(comment), ...Array(25).fill(metadata),
    event(deepseek({ reasoning_content: privateReasoning })),
    event(deepseek({ content: '完成' })),
    event({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 9 } }), event('[DONE]')];
  assert.ok(chunks.reduce((sum, chunk) => sum + (typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength), 0) > 8 * 1024 * 1024);
  const { fetchImpl } = fixture(chunks);
  const deltas = [];
  const progress = [];
  const reply = await requestModel(options({ fetchImpl, maxModelPayloadBytes: 512, onTextDelta: text => deltas.push(text), onProgress: sample => progress.push(sample) }));
  assert.equal(reply.message.content, '完成');
  assert.equal(reply.message.providerState.message.reasoning_content, privateReasoning);
  assert.deepEqual(reply.usage, { inputTokens: 17, outputTokens: 9 });
  assert.equal(reply.usageReported, true);
  assert.deepEqual(deltas, ['完成']);
  assert.ok(!JSON.stringify(progress).includes(privateReasoning));
});

test('retained multi-line SSE event budget accumulates across data lines and transport chunks, then cancels the reader', async () => {
  const source = 'data: {"choices":\n' + 'data: [],\n' + 'data: "metadata":"' + 'x'.repeat(70) + '"}\n\n';
  const { fetchImpl, observed } = fixture(split(source, 11));
  await assert.rejects(requestModel(options({ fetchImpl, maxEventBytes: 110 })), { code: 'PROVIDER_EVENT_TOO_LARGE' });
  assert.equal(observed.cancelled, 1);
});

test('an unterminated oversized SSE line is stopped before EOF and the source is cancelled', async () => {
  const { fetchImpl, observed } = fixture(split('data: ' + 'x'.repeat(160), 19));
  await assert.rejects(requestModel(options({ fetchImpl, maxEventBytes: 64 })), { code: 'PROVIDER_EVENT_TOO_LARGE' });
  assert.equal(observed.cancelled, 1);
});

test('reasoning payload budget accumulates UTF-8 bytes across frames and reports supplied usage before rejecting', async () => {
  const progress = [];
  const { fetchImpl, observed } = fixture([
    event(deepseek({ reasoning_content: '汉'.repeat(40) })),
    event(deepseek({ reasoning_content: '汉'.repeat(40) }, { usage: { prompt_tokens: 9, completion_tokens: 2 } })),
    event('[DONE]'),
  ]);
  await assert.rejects(requestModel(options({ fetchImpl, maxModelPayloadBytes: 256, onProgress: sample => progress.push(sample) })), { code: 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE' });
  assert.equal(observed.cancelled, 1);
  assert.ok(progress.some(sample => sample.usage?.inputTokens === 9 && sample.usage?.outputTokens === 2));
  assert.ok(!JSON.stringify(progress).includes('汉'));
});

test('parallel tool argument channels share one model payload budget and retain already reported usage on failure', async () => {
  const progress = [];
  const call = (index, letter) => ({ index, id: 'call-' + index, type: 'function', function: { name: 'noop', arguments: JSON.stringify({ value: letter.repeat(80) }) } });
  const { fetchImpl, observed } = fixture([
    event(deepseek({ tool_calls: [call(0, 'a')] })),
    event(deepseek({ tool_calls: [call(1, 'b')] }, { usage: { prompt_tokens: 12, completion_tokens: 3 } })),
    event('[DONE]'),
  ]);
  await assert.rejects(requestModel(options({ fetchImpl, maxModelPayloadBytes: 550, onProgress: sample => progress.push(sample) })), { code: 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE' });
  assert.equal(observed.cancelled, 1);
  assert.ok(progress.some(sample => sample.usage?.inputTokens === 12 && sample.usage?.outputTokens === 3));
});

test('OpenAI streamed delta, done and completed native replay use the same text/argument channels without double-counting', async () => {
  const text = 't'.repeat(300);
  const argumentsText = JSON.stringify({ value: 'a'.repeat(300) });
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
  const tool = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'noop', arguments: argumentsText };
  const values = [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: argumentsText },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: argumentsText },
    { type: 'response.output_item.done', output_index: 1, item: tool },
    { type: 'response.completed', response: { status: 'completed', output: [message, tool], usage: { input_tokens: 4, output_tokens: 5 } } },
  ];
  const { fetchImpl } = fixture(values.map(event));
  const reply = await requestModel(options({ provider: 'openai', fetchImpl, maxModelPayloadBytes: 1400 }));
  assert.equal(reply.message.content, text);
  assert.deepEqual(reply.message.toolCalls, [{ id: 'call-1', name: 'noop', arguments: { value: 'a'.repeat(300) } }]);
  assert.deepEqual(reply.usage, { inputTokens: 4, outputTokens: 5 });
});

test('Claude thinking signatures count toward the model budget without exposing their data through progress', async () => {
  const progress = [];
  const values = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking'.repeat(10) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-signature'.repeat(30) } },
    { type: 'message_stop' },
  ];
  const { fetchImpl, observed } = fixture(values.map(event));
  await assert.rejects(requestModel(options({ provider: 'anthropic', fetchImpl, maxModelPayloadBytes: 450, onProgress: sample => progress.push(sample) })), { code: 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE' });
  assert.equal(observed.cancelled, 1);
  assert.ok(progress.some(sample => sample.usage?.inputTokens === 5));
  assert.ok(!JSON.stringify(progress).includes('private-signature'));
});

test('Claude redacted native thinking and OpenAI encrypted reasoning are budgeted even without visible text', async () => {
  for (const [provider, values] of [
    ['anthropic', [{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque'.repeat(100) } }, { type: 'message_stop' }]],
    ['openai', [{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [], encrypted_content: 'opaque'.repeat(100) } }, { type: 'response.completed', response: { status: 'completed', output: [] } }]],
  ]) {
    const { fetchImpl, observed } = fixture(values.map(event));
    await assert.rejects(requestModel(options({ provider, fetchImpl, maxModelPayloadBytes: 256 })), { code: 'PROVIDER_MODEL_PAYLOAD_TOO_LARGE' });
    assert.equal(observed.cancelled, 1);
  }
});

test('non-streaming JSON keeps its default 8 MiB transport limit', async () => {
  const padding = encoder.encode('x'.repeat(128 * 1024));
  const { fetchImpl, observed } = fixture(['{"output":[],"metadata":"', ...Array(65).fill(padding), '"}'], 'application/json');
  await assert.rejects(requestModel(options({ provider: 'openai', fetchImpl })), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  assert.equal(observed.cancelled, 1);
});

test('explicit maxResponseBytes remains a raw hard limit for both metadata SSE and JSON', async () => {
  for (const [chunks, contentType] of [
    [[event({ choices: [], metadata: 'x'.repeat(200) }), event('[DONE]')], 'text/event-stream'],
    [[JSON.stringify({ output: [], metadata: 'x'.repeat(200) })], 'application/json'],
  ]) {
    const { fetchImpl, observed } = fixture(chunks, contentType);
    await assert.rejects(requestModel(options({ provider: 'openai', fetchImpl, maxResponseBytes: 64 })), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    assert.equal(observed.cancelled, 1);
  }
});

test('relaxed transport limits still reject a stream that ends before its completion marker', async () => {
  const { fetchImpl } = fixture([event(deepseek({ content: 'unfinished' }))]);
  await assert.rejects(requestModel(options({ fetchImpl })), { code: 'PROVIDER_INCOMPLETE_STREAM' });
});

test('invalid event and payload budgets fail before fetch is invoked', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('Should not fetch'); };
  for (const extra of [{ maxEventBytes: 0 }, { maxEventBytes: 16 * 1024 * 1024 + 1 }, { maxModelPayloadBytes: NaN }, { maxModelPayloadBytes: 32 * 1024 * 1024 + 1 }]) {
    await assert.rejects(requestModel(options({ fetchImpl, ...extra })), { code: 'INVALID_MODEL_CONFIG' });
  }
  assert.equal(calls, 0);
});
