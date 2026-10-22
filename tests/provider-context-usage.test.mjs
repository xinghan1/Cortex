import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

const options = extra => ({ provider: 'openai', model: 'fixture', apiKey: 'fixture-key',
  messages: [{ role: 'user', content: 'Inspect.' }], tools: [], ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = values => new Response(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const ndjson = values => new Response(values.map(value => JSON.stringify(value)).join('\n') + '\n',
  { headers: { 'content-type': 'application/x-ndjson' } });

test('Responses exposes real input early, output growth and terminal completion independently from ledger usage', async () => {
  const samples = [];
  const result = await requestModel(options({ onProgress: sample => samples.push(sample), fetchImpl: async () => sse([
    { type: 'response.created', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 } } } },
    { type: 'response.in_progress', response: { usage: { output_tokens: 5, output_tokens_details: { reasoning_tokens: 4 } } } },
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 20,
      input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 17 } } } },
  ]) }));
  const early = samples.find(sample => sample.contextUsage.inputTokens === 100 && sample.contextUsage.outputTokens === undefined);
  assert.deepEqual(early.contextUsage, { inputTokens: 100, complete: false }); assert.equal(early.usage, undefined);
  assert.ok(samples.some(sample => sample.contextUsage.outputTokens === 5 && sample.contextUsage.complete === false));
  assert.deepEqual(result.contextUsage, { inputTokens: 100, outputTokens: 20, complete: true });
  assert.deepEqual(samples.at(-1).contextUsage, result.contextUsage);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 });
});

test('missing input or output stays missing, while explicit zero is exact across JSON protocols', async () => {
  for (const [provider, extra, value, expected] of [
    ['openai', {}, { status: 'completed', output: [], usage: { input_tokens: 0 } }, { inputTokens: 0, complete: true }],
    ['openai', {}, { status: 'completed', output: [], usage: { output_tokens: 5 } }, { outputTokens: 5, complete: true }],
    ['deepseek', {}, { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { completion_tokens: 0 } }, { outputTokens: 0, complete: true }],
    ['ollama', { apiKey: '' }, { message: { content: 'done' }, done: true, prompt_eval_count: 0 }, { inputTokens: 0, complete: true }],
  ]) {
    const result = await requestModel(options({ provider, ...extra, fetchImpl: async () => json(value) }));
    assert.deepEqual(result.contextUsage, expected); assert.equal(result.usageReported, false);
  }
  const absent = await requestModel(options({ fetchImpl: async () => json({ status: 'completed', output: [] }) }));
  assert.deepEqual(absent.contextUsage, { complete: true });
});

test('Anthropic totals its three input components and preserves real partial counts on cancellation or failure', async () => {
  const samples = [];
  const result = await requestModel(options({ provider: 'anthropic', onProgress: value => samples.push(value), fetchImpl: async () => sse([
    { type: 'message_start', message: { usage: { input_tokens: 30, cache_creation_input_tokens: 40, cache_read_input_tokens: 50 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }, { type: 'message_stop' },
  ]) }));
  assert.deepEqual(samples[0].contextUsage, { inputTokens: 120, complete: false });
  assert.deepEqual(result.contextUsage, { inputTokens: 120, outputTokens: 12, complete: true });
  assert.equal(result.usage.cachedInputTokens, 50);
  const failed = [];
  await assert.rejects(requestModel(options({ onProgress: value => failed.push(value.contextUsage), fetchImpl: async () => sse([
    { type: 'response.failed', response: { usage: { input_tokens: 40, output_tokens: 3 } } },
  ]) })), { code: 'PROVIDER_API_ERROR' });
  assert.deepEqual(failed.at(-1), { inputTokens: 40, outputTokens: 3, complete: false });
});

test('DeepSeek cache and reasoning are subsets, and missing DONE never reports a complete stream', async () => {
  const result = await requestModel(options({ provider: 'deepseek', fetchImpl: async () => sse([
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 9,
      prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 40, completion_tokens_details: { reasoning_tokens: 8 } } }, '[DONE]',
  ]) }));
  assert.deepEqual(result.contextUsage, { inputTokens: 70, outputTokens: 9, complete: true });
  const samples = [];
  await assert.rejects(requestModel(options({ provider: 'deepseek', onProgress: value => samples.push(value.contextUsage), fetchImpl: async () => sse([
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 9 } },
  ]) })), { code: 'PROVIDER_INCOMPLETE_STREAM' });
  assert.equal(samples.every(sample => sample.complete === false), true);
});

test('Ollama publishes only actual prompt/eval counters and completion belongs to the done frame', async () => {
  const samples = [];
  const result = await requestModel(options({ provider: 'ollama', apiKey: '', onProgress: value => samples.push(value.contextUsage),
    fetchImpl: async () => ndjson([{ message: { thinking: 'private', content: 'text' }, done: false },
      { done: false, prompt_eval_count: 80 }, { done: false, eval_count: 2 },
      { done: true, eval_count: 10, prompt_eval_cached_count: 60 }]) }));
  assert.deepEqual(samples[0], { complete: false });
  assert.ok(samples.some(sample => sample.inputTokens === 80 && sample.outputTokens === undefined));
  assert.ok(samples.some(sample => sample.outputTokens === 2 && sample.complete === false));
  assert.deepEqual(result.contextUsage, { inputTokens: 80, outputTokens: 10, complete: true });
  assert.equal(result.usage.cachedInputTokens, 60);
});
