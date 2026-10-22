import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';
import { contextMeasurementMatchesConfig } from '../src/core/context-usage.mjs';

const config = { provider: 'ollama', model: 'fixture', modelCapabilities: { contextWindow: 100000 }, permissionMode: 'request' };
const options = overrides => ({ config, messages: [{ role: 'user', content: 'Inspect.' }], toolDefinitions: [],
  workspace: { root: 'fixture', execute: async () => 'file contents' }, signal: new AbortController().signal, emit: () => {}, ...overrides });
const reply = (inputTokens = 100, outputTokens = 20, toolCalls = []) => ({ message: { role: 'assistant', content: 'Done.', toolCalls },
  usage: { inputTokens, outputTokens }, usageReported: true, contextUsage: { inputTokens, outputTokens, complete: true } });
const call = { id: 'read', name: 'read_file', arguments: { path: 'fixture.txt' } };

test('actual wire counters update input and output, then tool results invalidate the displayed measurement without billing duplicates', async () => {
  const samples = [], records = [], messages = [{ role: 'user', content: 'Inspect.' }]; let requests = 0;
  await runAgent(options({ messages, onContextUsage: value => samples.push(value), onUsage: async value => records.push(value),
    toolDefinitions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    requestModel: request => requestModel({ ...request, fetchImpl: async () => {
      requests++;
      const frames = requests === 1 ? [{ message: { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'fixture.txt' } } }] }, done: false },
        { done: false, prompt_eval_count: 40 }, { done: false, eval_count: 2 }, { done: true, eval_count: 5 }]
        : [{ message: { role: 'assistant', content: 'Finished.' }, done: true, prompt_eval_count: 42, eval_count: 5 }];
      return new Response(frames.map(value => JSON.stringify(value)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    } }),
  }));
  assert.equal(samples[0].version, 2); assert.equal(samples[0].status, 'pending'); assert.equal(samples[0].usedTokens, null);
  assert.ok(samples.some(sample => sample.status === 'partial' && sample.inputTokens === 40 && sample.outputTokens === null));
  assert.ok(samples.some(sample => sample.status === 'partial' && sample.outputTokens === 2 && sample.usedTokens === 42));
  assert.deepEqual(samples.filter(sample => sample.status === 'reported').map(sample => sample.usedTokens), [45, 47]);
  const changed = samples.find(sample => sample.phase === 'changed');
  assert.equal(changed.status, 'pending'); assert.equal(changed.usedTokens, null);
  assert.equal(changed.lastReported.inputTokens, 40); assert.equal(changed.lastReported.outputTokens, 5);
  assert.equal(changed.lastReported.lastReported, undefined); assert.ok(changed.measurement);
  assert.equal(samples.at(-1).measurement.measuredTokens, 47);
  assert.equal(contextMeasurementMatchesConfig(samples.at(-1).measurement, config), true);
  assert.equal(new Set(records.map(record => record.id)).size, 2); assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => [record.inputTokens, record.outputTokens]), [[40, 5], [42, 5]]);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
});

test('input-only and output-only reports remain partial; absent and invalid counts never become zero', async () => {
  for (const [counts, kind, expectedStatus, used] of [[{ inputTokens: 0 }, 'total', 'partial', 0],
    [{ outputTokens: 7 }, 'total', 'partial', null], [{ inputTokens: 7 }, 'input', 'reported', 7],
    [{ inputTokens: null, outputTokens: -1 }, 'total', 'unknown', null], [{}, 'total', 'unknown', null],
    [{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }, 'total', 'partial', null]]) {
    const samples = [];
    await runAgent(options({ config: { ...config, modelCapabilities: { contextWindow: 100000, contextWindowKind: kind } },
      onContextUsage: value => samples.push(value), requestModel: async request => {
        request.onProgress({ contextUsage: { complete: false } });
        request.onProgress({ contextUsage: { complete: false } });
        request.onProgress({ contextUsage: { ...counts, complete: false } });
        return { message: { role: 'assistant', content: 'Done.', toolCalls: [] }, usageReported: false, contextUsage: { ...counts, complete: true } };
      } }));
    assert.equal(samples.at(-1).status, expectedStatus); assert.equal(samples.at(-1).phase, 'complete'); assert.equal(samples.at(-1).usedTokens, used);
    assert.equal(samples.some(sample => sample.status === 'estimated'), false);
    assert.equal(samples.at(-1).measurement, undefined);
    assert.equal(samples.filter(sample => sample.status === 'pending' && sample.phase === 'requesting').length, 1);
  }
});

test('failure and cancellation retain actual partial counters and never claim complete usage', async () => {
  for (const stopped of [false, true]) {
    const controller = new AbortController(), samples = [], records = [];
    await assert.rejects(runAgent(options({ signal: controller.signal, onContextUsage: value => samples.push(value), onUsage: async value => records.push(value),
      requestModel: async request => {
        request.onProgress({ contextUsage: { inputTokens: 80, outputTokens: 4, complete: false } });
        if (stopped) controller.abort(new Error('Stopped fixture'));
        throw new Error('Incomplete fixture');
      } })), /Incomplete fixture/);
    assert.equal(samples.at(-1).status, 'partial'); assert.equal(samples.at(-1).phase, stopped ? 'stopped' : 'failed');
    assert.equal(samples.at(-1).inputTokens, 80); assert.equal(samples.at(-1).outputTokens, 4); assert.equal(samples.at(-1).measurement, undefined);
    assert.equal(samples.some(sample => sample.status === 'reported'), false); assert.equal(records.length, 1);
  }
});

test('restored measured prefix triggers compression at actual current context plus new growth, retaining the full archive', async () => {
  const messages = [{ role: 'user', content: 'Original goal.' }], samples = [], checkpoint = {};
  const thresholdConfig = { ...config, contextCompressionTriggerTokens: 10000 };
  await runAgent(options({ config: thresholdConfig, messages, contextCheckpoint: checkpoint, onContextUsage: sample => samples.push(sample),
    requestModel: async () => reply(9000, 1500) }));
  const previous = samples.at(-1), original = structuredClone(messages);
  messages.push({ role: 'user', content: 'Continue the goal.' });
  let summaries = 0, ordinary = 0;
  await runAgent(options({ config: thresholdConfig, messages, contextCheckpoint: checkpoint, contextMeasurement: previous.measurement,
    previousContextUsage: previous, onContextUsage: sample => samples.push(sample), requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) { summaries++; return reply(100, 10); }
      ordinary++; return reply(200, 30);
    } }));
  assert.equal(summaries, 1); assert.equal(ordinary, 1); assert.equal(checkpoint.count, 1);
  assert.deepEqual(messages.slice(0, original.length), original); assert.equal(messages.filter(message => message.role === 'user').length, 2);
  const compacted = samples.find(sample => sample.phase === 'compacted');
  assert.equal(compacted.status, 'pending'); assert.equal(compacted.usedTokens, null); assert.equal(compacted.lastReported.usedTokens, 10500);
  assert.equal(compacted.measurement, undefined);
  assert.equal(samples.at(-1).usedTokens, 230);
});

test('configuration switches discard calibration but keep prior real measurement as a nonrecursive reference', async () => {
  const samples = [], messages = [{ role: 'user', content: 'Original goal.' }];
  await runAgent(options({ messages, onContextUsage: value => samples.push(value), requestModel: async () => reply(9000, 1500) }));
  const previous = samples.at(-1), nextConfig = { ...config, model: 'other', contextCompressionTriggerTokens: 1000 };
  messages.push({ role: 'user', content: 'Continue.' });
  let summaries = 0;
  await runAgent(options({ config: nextConfig, messages, contextMeasurement: previous.measurement, previousContextUsage: previous,
    onContextUsage: value => samples.push(value), requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) summaries++;
      return { message: { role: 'assistant', content: 'No usage returned.', toolCalls: [] }, usageReported: false, contextUsage: { complete: true } };
    } }));
  assert.equal(summaries, 0); assert.equal(samples.at(-1).status, 'unknown'); assert.equal(samples.at(-1).usedTokens, null);
  assert.equal(samples.at(-1).measurement, undefined); assert.equal(samples.at(-1).lastReported.usedTokens, 10500);
  assert.equal(samples.at(-1).lastReported.model, 'fixture'); assert.equal(samples.at(-1).lastReported.lastReported, undefined);
});

test('steering added after a measured reply invalidates its current display before the next request', async () => {
  const samples = []; let requests = 0, steered = false;
  await runAgent(options({ onContextUsage: value => samples.push(value), takeSteering: async () => requests === 1 && !steered
    ? (steered = true, [{ id: 'steer', text: 'Also inspect the result.' }]) : [], requestModel: async () => { requests++; return reply(); } }));
  assert.equal(requests, 2);
  const changed = samples.find(sample => sample.phase === 'changed');
  assert.equal(changed.usedTokens, null); assert.equal(changed.lastReported.usedTokens, 120);
  assert.equal(samples.at(-1).status, 'reported');
});

test('a later partial failure preserves the previous complete sample and cancellation cannot race into a reported completion', async () => {
  const samples = [];
  await runAgent(options({ onContextUsage: value => samples.push(value), requestModel: async () => reply(70, 5) }));
  const previous = samples.at(-1), controller = new AbortController();
  await assert.rejects(runAgent(options({ signal: controller.signal, previousContextUsage: previous,
    contextMeasurement: previous.measurement, onContextUsage: value => samples.push(value), requestModel: async request => {
      request.onProgress({ contextUsage: { inputTokens: 90, outputTokens: 3, complete: false } });
      controller.abort(new Error('cancelled after native finish')); return reply(90, 4);
    } })), /cancelled after native finish/);
  const stopped = samples.at(-1);
  assert.equal(stopped.status, 'partial'); assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.inputTokens, 90); assert.equal(stopped.outputTokens, 4);
  assert.equal(stopped.lastReported.usedTokens, 75); assert.equal(stopped.lastReported.lastReported, undefined);
  assert.equal(stopped.measurement.measuredTokens, 75, 'A cancelled request cannot capture a new calibration anchor');
});
