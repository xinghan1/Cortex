import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runAgent } from '../src/core/agent.mjs';
import { TOOL_DEFINITIONS } from '../src/core/workspace.mjs';

const require = createRequire(import.meta.url);
const { Store } = require('../src/core/store.cjs');
const { createTurnUsage } = require('../src/core/turn-usage.cjs');
const reply = (content, toolCalls = [], usage = { inputTokens: 10, outputTokens: 2 }) => ({
  message: { role: 'assistant', content, toolCalls }, usage, usageReported: Boolean(usage),
});

test('stopped child partial usage is included exactly once in the parent turn', async () => {
  const controller = new AbortController(), records = []; let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const running = runAgent({ config: { provider: 'relay', apiProtocol: 'responses', model: 'fixture', apiKey: 'fixture' },
    messages: [{ role: 'user', content: 'Check a task.' }], runId: 'run', sessionId: 'session',
    signal: controller.signal, emit: () => {}, toolDefinitions: TOOL_DEFINITIONS,
    workspace: { root: 'C:/fixture', execute: async () => '' },
    subagentFactory: async () => ({ root: 'C:/fixture', execute: async () => '' }),
    onUsage: async record => records.push(record),
    requestModel: async request => {
      if (request.messages[0].content.includes('你是独立子智能体')) {
        request.onProgress({ usage: { inputTokens: 7, outputTokens: 3 } });
        notifyStarted();
        return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      }
      return reply('Delegate', [call('a', 'spawn_agent', { name: 'A', task: 'Hold' }), call('b', 'wait_agents', {})]);
    } });
  await started; controller.abort(new Error('Stopped'));
  await assert.rejects(running, /Stopped/);
  assert.equal(records.length, 2); assert.equal(new Set(records.map(record => record.id)).size, 2);
  assert.equal(records.find(record => record.agentId)?.status, 'stopped');
  const totals = createTurnUsage(records);
  assert.deepEqual([totals.inputTokens, totals.outputTokens, totals.requests, totals.partialRequests, totals.status], [17, 5, 2, 1, 'partial']);
});
const call = (id, name, args) => ({ id, name, arguments: args });

test('child requests contribute once to parent turn and persisted session totals, including partial and unknown usage', async t => {
  const root = path.resolve('tests/.tmp'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'child-usage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(dir).startsWith('child-usage-'));
    return fs.rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir, { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: value => value.toString() });
  await store.init(); const sessionId = randomUUID(), runId = randomUUID(), records = [], events = [];
  let parentRequests = 0;
  await runAgent({ config: { provider: 'relay', apiProtocol: 'responses', model: 'fixture', apiKey: 'fixture', modelCapabilities: { contextWindow: 128000 } },
    messages: [{ role: 'user', content: 'Check independent tasks.' }], runId, sessionId,
    signal: new AbortController().signal, emit: event => events.push(event), toolDefinitions: TOOL_DEFINITIONS,
    workspace: { root: 'C:/fixture', execute: async () => '' },
    subagentFactory: async () => ({ root: 'C:/fixture', execute: async () => '' }),
    onUsage: async record => { records.push(record); await store.recordUsage(record); },
    requestModel: async request => {
      if (request.messages[0].content.includes('你是独立子智能体')) {
        if (request.messages[1].content.includes('child-fail')) {
          request.onProgress({ usage: { inputTokens: 7, outputTokens: 3 } });
          throw new Error('Synthetic failure');
        }
        if (request.messages[1].content.includes('child-unknown')) return reply('No reported usage', [], null);
        if (!request.messages.some(message => message.role === 'tool')) return reply('Read first', [call('child-read', 'read_file', { path: 'fixture.txt' })]);
        return reply('Child done');
      }
      if (++parentRequests === 1) return reply('Delegate', [
        call('a', 'spawn_agent', { name: 'A', task: 'child-ok' }),
        call('b', 'spawn_agent', { name: 'B', task: 'child-fail' }),
        call('c', 'spawn_agent', { name: 'C', task: 'child-unknown' }),
        call('d', 'wait_agents', {}),
      ]);
      return reply('Finished');
    } });
  assert.equal(records.length, 6);
  assert.equal(new Set(records.map(record => record.id)).size, 6);
  assert.equal(records.filter(record => record.agentId).length, 4);
  assert.ok(records.every(record => record.runId === runId && record.sessionId === sessionId));
  const turn = createTurnUsage(records);
  assert.deepEqual([turn.inputTokens, turn.outputTokens, turn.requests, turn.partialRequests, turn.unreportedRequests, turn.status], [47, 11, 6, 1, 1, 'partial']);
  const totals = store.sessionUsageTotals({ id: sessionId });
  assert.deepEqual([totals.inputTokens, totals.outputTokens, totals.requests, totals.partialRequests, totals.unreportedRequests], [47, 11, 6, 1, 1]);
  const metrics = store.sessionMetrics({ id: sessionId, messages: [] });
  assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.totalTokens, metrics.usageStatus], [47, 11, 58, 'partial']);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1), { type: 'usage', inputTokens: 47, outputTokens: 11 });
  assert.equal((await store.recordUsage(records[0])).duplicate, true);
  assert.equal(store.sessionUsageTotals({ id: sessionId }).requests, 6);
});
