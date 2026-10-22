import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTurnUsage, normalizeTurnUsage, sessionTaskRuns, snapshotTurnUsage } = require('../src/core/turn-usage.cjs');
const { Store } = require('../src/core/store.cjs');

const report = overrides => ({ id: randomUUID(), timestamp: '2026-10-22T03:00:00.000Z', provider: 'relay', model: 'fixture',
  sessionId: 'session-a', runId: 'run-a', status: 'completed', reported: true, inputTokens: 100, outputTokens: 20, ...overrides });
const ended = overrides => ({ type: 'run-end', runId: 'run-a', kind: 'agent', status: 'completed', startedAt: 1, endedAt: 2,
  elapsedMs: 1, messageStartIndex: 0, messageIndex: 1, ...overrides });
const session = overrides => ({ id: 'session-a', messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' }],
  events: [], taskRuns: [ended()], ...overrides });

test('one turn sums every actual request once, including retries, compaction, approval and children', () => {
  const records = [report({ cachedInputTokens: 80, reasoningTokens: 10 }), report({ purpose: 'context-compaction' }),
    report({ purpose: 'approval-review' }), report({ agentId: 'child' }),
    report({ status: 'failed', reported: false, inputTokens: null, outputTokens: null })];
  const value = createTurnUsage([...records, records[0]]);
  assert.deepEqual(value, { version: 1, inputTokens: 400, outputTokens: 80, totalTokens: 480,
    requests: 5, reportedRequests: 4, unreportedRequests: 1, partialRequests: 0, status: 'partial' });
  assert.equal(JSON.stringify(value).includes('reasoning'), false);
  assert.equal(JSON.stringify(value).includes('cached'), false);
});

test('genuine zero reports remain zero while absent or invalid reports remain unavailable', () => {
  const zero = createTurnUsage([report({ inputTokens: 0, outputTokens: 0 })]);
  assert.equal(zero.status, 'reported'); assert.equal(zero.totalTokens, 0);
  for (const records of [[], [report({ reported: false, inputTokens: null, outputTokens: null })],
    [report({ inputTokens: -1 })], [report({ inputTokens: null })]]) {
    const value = createTurnUsage(records);
    assert.equal(value.status, 'unavailable'); assert.equal(value.totalTokens, null);
  }
  const partial = createTurnUsage([report({ inputTokens: 7, outputTokens: 3, partial: true, status: 'stopped' })]);
  assert.equal(partial.status, 'partial'); assert.equal(partial.totalTokens, 10); assert.equal(partial.partialRequests, 1);
  assert.equal(createTurnUsage([report({ historicalApproximate: true })]).status, 'partial');
});

test('history uses the explicit session/run ledger pair and never matches foreign or neighbouring turns', () => {
  const records = [report(), report({ sessionId: 'session-b', inputTokens: 90000 }), report({ runId: 'run-b', inputTokens: 80000 })];
  const original = session();
  const before = structuredClone(original);
  const [run] = sessionTaskRuns(original, records);
  assert.equal(run.usage.totalTokens, 120); assert.equal(run.usage.requests, 1);
  assert.deepEqual(original, before);
  assert.equal(sessionTaskRuns(session({ taskRuns: [ended({ runId: 'unknown' })] }), records)[0].usage.totalTokens, null);
});

test('the light index preserves all turn usage and anchors after rich task and event archives roll over', () => {
  const original = session({ taskRuns: [] }), records = [];
  for (let index = 0; index < 90; index++) {
    const run = ended({ runId: `run-${index}`, messageStartIndex: index * 2, messageIndex: index * 2 + 1,
      telemetry: { PRIVATE_TELEMETRY: 'large' }, activityEvents: [{ output: 'PRIVATE_COMMAND_OUTPUT' }] });
    records.push(report({ runId: run.runId, inputTokens: index, outputTokens: 1 }));
    original.taskRuns.push(run); original.taskRuns = original.taskRuns.slice(-64);
    original.events = [run];
    original.turnUsage = snapshotTurnUsage(original, records);
  }
  assert.equal(original.taskRuns.length, 64); assert.equal(original.turnUsage.length, 90);
  const restored = sessionTaskRuns(structuredClone(original), records);
  assert.equal(restored.length, 90); assert.equal(restored[0].messageStartIndex, 0);
  assert.equal(restored[0].elapsedMs, 1); assert.equal(restored[0].usage.totalTokens, 1);
  assert.equal(restored.at(-1).usage.totalTokens, 90);
  const serialized = JSON.stringify(original.turnUsage);
  assert.equal(serialized.includes('PRIVATE_TELEMETRY'), false);
  assert.equal(serialized.includes('PRIVATE_COMMAND_OUTPUT'), false);
  assert.equal(serialized.includes('activityEvents'), false);
});

test('a history fork freezes inherited turn summaries without moving, copying or recounting billing records', () => {
  const original = session(), first = report(), records = [first];
  const index = snapshotTurnUsage(original, records);
  const branch = { ...structuredClone(original), id: 'branch', turnUsage: index,
    usageBaseline: { inputTokens: 1000000, outputTokens: 1000000 } };
  records.push(report({ inputTokens: 900 }), report({ sessionId: 'branch', runId: 'next', inputTokens: 7, outputTokens: 2 }));
  branch.taskRuns.push(ended({ runId: 'next', messageStartIndex: 2, messageIndex: 3 }));
  const before = structuredClone(records), restored = sessionTaskRuns(branch, records);
  assert.equal(restored[0].usage.totalTokens, 120); assert.equal(restored[1].usage.totalTokens, 9);
  assert.equal(sessionTaskRuns(original, records)[0].usage.totalTokens, 1040);
  assert.deepEqual(records, before);
  branch.turnUsage = snapshotTurnUsage(branch, records);
  const secondFork = { ...structuredClone(branch), id: 'second-fork', turnUsage: snapshotTurnUsage(branch, records) };
  assert.deepEqual(sessionTaskRuns(secondFork, records).map(run => run.usage.totalTokens), [120, 9]);
});

test('a finalized observed summary survives a missing ledger write and cannot become incomplete success', () => {
  const observed = createTurnUsage([report(), report({ reported: false, inputTokens: null, outputTokens: null })]);
  const original = session({ taskRuns: [ended({ usage: observed })] });
  original.turnUsage = snapshotTurnUsage(original, [report()]);
  assert.equal(original.turnUsage[0].usage.status, 'partial'); assert.equal(original.turnUsage[0].usage.requests, 2);
  const restored = sessionTaskRuns(JSON.parse(JSON.stringify(original)), [], { unavailable: true });
  assert.deepEqual(restored[0].usage, observed);
});

test('legacy approximate records remain partial and legacy timing alone cannot invent turn usage', () => {
  const [approximate] = sessionTaskRuns(session(), [report({ historicalApproximate: true })]);
  assert.equal(approximate.usage.status, 'partial'); assert.equal(approximate.usage.historicalApproximate, true);
  const [unknown] = sessionTaskRuns(session(), []);
  assert.equal(unknown.usage.status, 'unavailable'); assert.equal(unknown.usage.totalTokens, null);
  const [badLedger] = sessionTaskRuns(session(), [report()], { unavailable: true });
  assert.equal(badLedger.usage.status, 'unavailable'); assert.equal(badLedger.usage.totalTokens, null);
});

test('invalid saved summaries are discarded rather than trusted as measured counts', () => {
  const valid = createTurnUsage([report()]);
  for (const usage of [{ ...valid, totalTokens: 999 }, { ...valid, requests: 2 }, { ...valid, status: 'partial' },
    { ...valid, inputTokens: NaN }, { ...valid, version: 2 }]) {
    assert.equal(normalizeTurnUsage(usage), null);
    const [restored] = sessionTaskRuns(session({ taskRuns: [], turnUsage: [{ ...ended(), usage }] }), []);
    assert.equal(restored, undefined);
  }
  const original = session({ taskRuns: [ended({ usage: { ...valid, totalTokens: 999 } })] });
  assert.equal(sessionTaskRuns(original, [report()])[0].usage.totalTokens, 120);
});

test('undo and terminal runs stay separate and do not enter the per-turn light index', () => {
  const original = session({ taskRuns: [ended(), ended({ runId: 'undo', kind: 'undo' }), ended({ runId: 'terminal', kind: 'terminal' })] });
  const runs = sessionTaskRuns(original, [report()]);
  assert.equal(runs.length, 3); assert.equal(Object.hasOwn(runs[1], 'usage'), false);
  assert.equal(Object.hasOwn(runs[2], 'usage'), false);
  assert.deepEqual(snapshotTurnUsage(original, [report()]).map(run => run.runId), ['run-a']);
  const demo = snapshotTurnUsage(session({ taskRuns: [ended({ demo: true })] }), [])[0];
  assert.equal(demo.demo, true);
});

const testRoot = path.resolve('tests', '.tmp');
const crypto = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() };
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'turn-usage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(dir).startsWith('turn-usage-'));
    return fs.rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir, crypto); await store.init(); return store;
}

test('Store preserves lightweight summaries across a real restart and deleting the session leaves billing totals intact', async t => {
  const store = await fixture(t), original = store.createSession('E:\\fixture-project');
  original.messages = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' }];
  original.taskRuns = [ended()];
  await store.recordUsage(report({ sessionId: original.id }));
  original.turnUsage = store.snapshotTurnUsage(original);
  await store.saveSession(original);
  const reopened = new Store(store.dir, crypto); await reopened.init();
  const loaded = await reopened.getSession(original.id), before = structuredClone(loaded);
  assert.equal(reopened.sessionTaskRuns(loaded)[0].usage.totalTokens, 120);
  assert.deepEqual(loaded, before);
  assert.equal(reopened.usage.records.length, 1);
  await reopened.deleteSession(original.id, original.workspace);
  assert.equal(reopened.usage.records.length, 1);
  assert.equal(reopened.usageStats(new Date('2026-10-22T03:00:00Z')).day.totalTokens, 120);
});
