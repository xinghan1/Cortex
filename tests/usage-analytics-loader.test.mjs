import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { testTempRoot } from './helpers/temp-root.mjs';

const { loadUsageAnalytics } = createRequire(import.meta.url)('../src/core/usage-analytics-loader.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(testTempRoot, 'synora-analytics-loader-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(dir).startsWith('synora-analytics-loader-'));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await fs.mkdir(path.join(dir, 'sessions'));
  return { dir, usage: { records: [], since: '2026-01-01T00:00:00.000Z' }, usageQueue: Promise.resolve(), usageError: null };
}
const ended = (id, duration) => ({
  type: 'run-end', runId: id, kind: 'agent', status: 'completed',
  startedAt: Date.now() - duration - 60_000, endedAt: Date.now() - 60_000, elapsedMs: duration,
});
async function save(store, session, filename = session.id + '.json') {
  await fs.writeFile(path.join(store.dir, 'sessions', filename), JSON.stringify(session));
}

test('live trimmed suffix cannot erase a readable persisted longest task', async t => {
  const store = await fixture(t), id = randomUUID();
  const oldEnd = ended(randomUUID(), 3_600_000);
  const disk = { id, workspace: 'E:\\Project', events: [oldEnd], taskRuns: [] };
  await save(store, disk);
  const live = { ...disk, events: Array.from({ length: 150 }, (_, index) => ({
    type: 'tool-start', runId: 'current', sequence: index, args: { command: 'PRIVATE_COMMAND' },
  })), taskRuns: [] };
  const value = await loadUsageAnalytics(store, [live]);
  assert.equal(value.summary.longestTaskMs, 3_600_000);
  assert.equal(value.summary.totalTokens, 0, 'Session timing must not create ledger usage');
  assert.equal(value.durationWarning, undefined);
  assert.equal(live.events.length, 150);
  assert.equal(disk.events[0], oldEnd);
});

test('multiple windows with stale same-id copies preserve the longest available run regardless of ordering', async t => {
  const store = await fixture(t), id = randomUUID();
  const disk = { id, workspace: 'E:\\Project', events: [ended('disk-only', 10_000)], taskRuns: [] };
  await save(store, disk);
  const active = { ...disk, events: [ended('live-only', 90_000)] };
  const stale = { ...disk, events: [], taskRuns: [] };
  assert.equal((await loadUsageAnalytics(store, [active, stale])).summary.longestTaskMs, 90_000);
  assert.equal((await loadUsageAnalytics(store, [stale, active])).summary.longestTaskMs, 90_000);
  const snapshot = await fs.readFile(path.join(store.dir, 'sessions', id + '.json'), 'utf8');
  assert.deepEqual(JSON.parse(snapshot).events, disk.events, 'Reading analytics must not rewrite history');
});

test('loader output includes numeric analytics without conversation, provider, or run metadata', async t => {
  const store = await fixture(t), id = randomUUID();
  const session = {
    id, workspace: 'E:\\PRIVATE_PROJECT_PATH', title: 'PRIVATE_TITLE', apiKey: 'PRIVATE_KEY',
    model: 'PRIVATE_MODEL', provider: 'PRIVATE_PROVIDER', usageBaseline: { totalTokens: 999_999 },
    messages: [{ role: 'user', content: 'PRIVATE_MESSAGE' }],
    events: [{ type: 'tool-result', result: 'PRIVATE_TOOL_RESULT' },
      { ...ended('PRIVATE_RUN_ID', 50_000), error: 'PRIVATE_ERROR', args: { apiKey: 'PRIVATE_KEY' } }],
  };
  await save(store, session);
  store.usage.records.push({ id: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z', reported: true,
    inputTokens: 100, outputTokens: 20, sessionId: id, runId: 'PRIVATE_LEDGER_RUN', model: 'PRIVATE_MODEL' });
  const result = await loadUsageAnalytics(store, [session]);
  assert.equal(result.summary.longestTaskMs, 50_000);
  assert.equal(result.summary.totalTokens, 120, 'Fork usage baselines are not new requests');
  assert.equal(result.summary.requests, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('PRIVATE_'));
  assert.ok(!serialized.includes(id));
  assert.ok(!serialized.includes('taskRuns'));
  assert.ok(!serialized.includes('events'));
});

test('unreadable, mismatched, oversized, and non-file histories warn without dropping valid usage', async t => {
  const store = await fixture(t), valid = { id: randomUUID(), workspace: 'E:\\Project', events: [ended('valid-run', 45_000)] };
  await save(store, valid);
  await fs.writeFile(path.join(store.dir, 'sessions', randomUUID() + '.json'), '{ invalid JSON');
  await save(store, { ...valid, id: randomUUID() }, randomUUID() + '.json');
  await fs.mkdir(path.join(store.dir, 'sessions', randomUUID() + '.json'));
  const oversized = await fs.open(path.join(store.dir, 'sessions', randomUUID() + '.json'), 'w');
  try { await oversized.truncate(32 * 1024 * 1024 + 1); } finally { await oversized.close(); }
  await fs.writeFile(path.join(store.dir, 'sessions', 'unrelated.json'), 'unrelated content');
  await save(store, { id: randomUUID(), demo: true, events: [ended('demo-run', 200_000)] });
  store.usage.records = [{ id: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z', reported: true, inputTokens: 200, outputTokens: 30 }];
  const result = await loadUsageAnalytics(store);
  assert.equal(result.summary.totalTokens, 230);
  assert.equal(result.summary.longestTaskMs, 45_000);
  assert.match(result.durationWarning, /部分历史会话无法读取/u);
  assert.equal(result.error, null);
  assert.equal(result.historyWarning, undefined);
});

test('loader waits for pending ledger writes and reports migration or ledger failures without resetting totals', async t => {
  const store = await fixture(t);
  let release, settled = false;
  store.usageQueue = new Promise(resolve => { release = resolve; });
  const pending = loadUsageAnalytics(store).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  store.usage.records.push({ id: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z', reported: true, inputTokens: 40, outputTokens: 10 });
  store.usage.legacyMigration = { skippedSessions: 1 };
  release();
  const value = await pending;
  assert.equal(value.summary.totalTokens, 50);
  assert.match(value.historyWarning, /部分旧会话未能迁入/u);
  store.usageError = '账本读取失败，原记录已保留。';
  const unavailable = await loadUsageAnalytics(store);
  assert.equal(unavailable.summary.totalTokens, null);
  assert.equal(unavailable.summary.requests, null);
  assert.deepEqual(unavailable.days, []);
  assert.equal(unavailable.error, store.usageError);
  assert.equal(store.usage.records.length, 1);
  assert.equal(store.usage.records[0].inputTokens, 40);
});
