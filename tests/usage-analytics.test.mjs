import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createUsageAnalytics } = createRequire(import.meta.url)('../src/core/usage-analytics.cjs');
const NOW = '2026-10-20T04:00:00.000Z';
let ordinal = 0;
const usage = (date, inputTokens = 100, outputTokens = 20, extra = {}) => ({
  id: `record-${++ordinal}`, timestamp: `${date}T04:00:00.000Z`, reported: true,
  inputTokens, outputTokens, ...extra,
});
const run = (runId, elapsedMs, extra = {}) => ({
  runId, kind: 'agent', status: 'completed', startedAt: Date.parse(NOW) - elapsedMs,
  endedAt: Date.parse(NOW), elapsedMs, ...extra,
});
const analytics = extra => createUsageAnalytics({ now: NOW, ...extra });

test('empty local ledger has an exact 365 day calendar and no invented task duration', () => {
  const value = analytics();
  assert.deepEqual(value.summary, {
    totalTokens: 0, inputTokens: 0, outputTokens: 0, peakDailyTokens: 0, longestTaskMs: null,
    longestStreak: 0, currentStreak: 0, activeDays: 0, requests: 0, unreportedRequests: 0, partialRequests: 0,
  });
  assert.equal(value.days.length, 365);
  assert.equal(value.days[0].date, '2025-10-21');
  assert.equal(value.days.at(-1).date, '2026-10-20');
  assert.ok(value.days.every(day => day.totalTokens === 0 && day.requests === 0 && day.cumulativeTokens === 0));
  assert.equal(value.timeZone, 'Asia/Hong_Kong');
  assert.equal(value.updatedAt, NOW);
  assert.equal(value.since, null);
  assert.equal(value.approximate, false);
  assert.doesNotThrow(() => JSON.stringify(value));
});

test('totals and peak cover all history, cumulative days include tokens preceding the window', () => {
  const records = [usage('2024-01-01', 1000, 2000), usage('2025-10-21', 20, 10),
    usage('2026-10-19', 80, 20), usage('2026-10-20', 60, 40)];
  const value = analytics({ records, since: '2025-01-01T00:00:00Z' });
  assert.equal(value.summary.totalTokens, 3230);
  assert.equal(value.summary.peakDailyTokens, 3000);
  assert.equal(value.summary.activeDays, 4);
  assert.equal(value.days[0].totalTokens, 30);
  assert.equal(value.days[0].cumulativeTokens, 3030);
  assert.equal(value.days.at(-1).cumulativeTokens, 3230);
  assert.equal(value.since, records[0].timestamp);
  assert.equal(value.summary.longestStreak, 2);
  assert.equal(value.summary.currentStreak, 2);
});

test('calendar uses Hong Kong midnight rather than UTC or host timezone', () => {
  const records = [usage('2026-10-19', 10, 1, { timestamp: '2026-10-19T15:59:59.999Z' }),
    usage('2026-10-19', 20, 2, { timestamp: '2026-10-19T16:00:00.000Z' }),
    usage('2026-10-19', 30, 3, { timestamp: '2026-10-20T00:00:00+08:00' })];
  const value = analytics({ records });
  assert.equal(value.days.at(-2).totalTokens, 11);
  assert.equal(value.days.at(-1).totalTokens, 55);
  assert.equal(value.summary.peakDailyTokens, 55);
  const beforeMidnight = createUsageAnalytics({ now: '2026-10-19T15:59:59.999Z', records });
  assert.equal(beforeMidnight.days.at(-1).date, '2026-10-19');
  assert.equal(beforeMidnight.summary.requests, 1);
});

test('365 day grid traverses leap day and year boundaries once each', () => {
  const value = createUsageAnalytics({ now: '2024-03-01T04:00:00Z', records: [usage('2024-02-29')] });
  assert.equal(value.days.length, 365);
  assert.equal(value.days[0].date, '2023-03-03');
  assert.equal(value.days.at(-2).date, '2024-02-29');
  assert.equal(value.days.at(-2).totalTokens, 120);
  assert.equal(new Set(value.days.map(day => day.date)).size, 365);
  assert.equal(value.days.find(day => day.date === '2024-01-01').date, '2024-01-01');
});

test('unknown, partial, historical and true zero usage remain distinguishable', () => {
  const records = [usage('2026-10-20', null, null, { reported: false }),
    usage('2026-10-20', 30, 4, { partial: true }), usage('2026-10-19', 0, 0),
    usage('2026-10-18', 5, 6, { historicalApproximate: true }),
    usage('2026-10-17', null, null, { reported: false, partial: true })];
  const value = analytics({ records });
  assert.equal(value.summary.totalTokens, 45);
  assert.equal(value.summary.requests, 5);
  assert.equal(value.summary.unreportedRequests, 3);
  assert.equal(value.summary.partialRequests, 2);
  assert.equal(value.summary.activeDays, 4);
  assert.equal(value.summary.currentStreak, 4);
  assert.equal(value.days.at(-2).totalTokens, 0);
  assert.equal(value.days.at(-2).requests, 1);
  assert.equal(value.days.at(-1).unreportedRequests, 2);
  assert.equal(value.approximate, true);
  assert.equal(value.historicalApproximate, true);
  assert.equal(value.days.at(-3).historicalApproximate, true);
});

test('streaks are calendar based, may end yesterday, and extend beyond the heatmap', () => {
  const value = analytics({ records: [usage('2024-01-01'), usage('2024-01-02'), usage('2024-01-03'),
    usage('2024-01-04'), usage('2026-10-18'), usage('2026-10-19')] });
  assert.equal(value.summary.longestStreak, 4);
  assert.equal(value.summary.currentStreak, 2);
  assert.equal(analytics({ records: [usage('2026-10-18')] }).summary.currentStreak, 0);
  assert.equal(analytics({ records: [usage('2026-10-20')] }).summary.currentStreak, 1);
});

test('duplicate ledger ids count once and future or invalid records do not pollute totals', () => {
  const first = usage('2026-10-20', 10, 2, { id: 'ABCD' });
  const records = [first, { ...first, id: 'abcd', inputTokens: 1000 }, usage('2026-10-21', 10000),
    usage('2026-10-20', 10000, 10000, { timestamp: 'not-a-date' }), null, false, {},
    usage('2026-10-20', 1, 1, { timestamp: Number.NEGATIVE_INFINITY })];
  const value = analytics({ records });
  assert.equal(value.summary.requests, 1);
  assert.equal(value.summary.totalTokens, 12);
  assert.equal(value.days.at(-1).requests, 1);
  assert.equal(value.since, first.timestamp);
});

test('invalid reported token counts are treated as unreported instead of coercion or NaN', () => {
  const invalid = [-1, 1.5, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined];
  const records = invalid.map(inputTokens => usage('2026-10-20', 0, 20, { inputTokens }));
  records.push(usage('2026-10-20', 4, 3, { reported: false }));
  const value = analytics({ records });
  assert.equal(value.summary.requests, invalid.length + 1);
  assert.equal(value.summary.unreportedRequests, invalid.length + 1);
  assert.equal(value.summary.totalTokens, 0);
  assert.equal(value.summary.currentStreak, 1);
  assert.ok(!JSON.stringify(value).includes('NaN'));
});

test('overflow is explicitly unavailable and JSON safe instead of a rounded token count', () => {
  const value = analytics({ records: [usage('2026-10-20', Number.MAX_SAFE_INTEGER, 1)] });
  assert.equal(value.summary.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(value.summary.totalTokens, null);
  assert.equal(value.summary.peakDailyTokens, null);
  assert.equal(value.days.at(-1).totalTokens, null);
  assert.equal(value.days.at(-1).cumulativeTokens, null);
  assert.equal(value.overflow, true);
  assert.equal(value.approximate, true);
  assert.equal(JSON.parse(JSON.stringify(value)).summary.totalTokens, null);
});

test('longest task accepts persisted summaries and paired events with interleaved run ids', () => {
  const base = Date.parse(NOW) - 200_000;
  const sessions = [{ id: 'a', workspace: 'E:\\Project', events: [
    { type: 'run-start', runId: 'a', startedAt: base },
    { type: 'run-start', runId: 'b', startedAt: base + 10_000 },
    { type: 'run-end', runId: 'a', status: 'completed', endedAt: base + 50_000 },
    { type: 'run-end', runId: 'b', status: 'failed', endedAt: base + 90_000 },
  ], taskRuns: [run('summary', 120_000)] }];
  assert.equal(analytics({ sessions }).summary.longestTaskMs, 120_000);
  assert.equal(analytics({ sessions: [{ ...sessions[0], taskRuns: [] }] }).summary.longestTaskMs, 80_000);
});

test('forked archives dedupe the same task while equal run ids in separate projects stay distinct', () => {
  const captured = run('shared-id', 5000);
  const sessions = [
    { id: 'original', workspace: 'E:\\Project\\', taskRuns: [captured] },
    { id: 'fork', workspace: 'e:/project', taskRuns: [{ ...captured, elapsedMs: 100_000 }] },
    { id: 'parallel', workspace: 'E:\\Other', taskRuns: [{ ...captured, elapsedMs: 10_000 }] },
  ];
  assert.equal(analytics({ sessions }).summary.longestTaskMs, 10_000);
  assert.equal(analytics({ sessions: [...sessions].reverse() }).summary.longestTaskMs, 10_000);
});

test('task duration excludes unfinished, undo, demo, future, negative and implausible runs', () => {
  const sessions = [{ workspace: 'E:\\Project', taskRuns: [
    run('running', 200_000, { status: 'running' }), run('undo', 200_000, { kind: 'undo' }),
    run('demo', 200_000, { demo: true }), run('negative', -50),
    run('bad-wall', 200_000, { endedAt: Date.parse(NOW) - 300_000 }),
    run('future', 200_000, { endedAt: Date.parse(NOW) + 1 }),
    run('implausible', 31 * 86_400_000), run('valid', 1000, { status: 'stopped' }),
  ] }, { workspace: 'E:\\Demo', demo: true, taskRuns: [run('whole-demo', 300_000)] }];
  assert.equal(analytics({ sessions }).summary.longestTaskMs, 1000);
  assert.equal(analytics({ sessions: [{ taskRuns: [run('zero', 0)] }] }).summary.longestTaskMs, 0);
  assert.equal(analytics({ sessions: [{ events: [{ type: 'run-start', runId: 'unfinished', startedAt: Date.parse(NOW) - 1000 }] }] }).summary.longestTaskMs, null);
});

test('projection exposes no messages, paths, model names, ids, or raw errors', () => {
  const records = [usage('2026-10-20', 10, 2, { model: 'SECRET_MODEL', provider: 'relay', sessionId: 'SECRET_ID',
    message: 'SECRET_MESSAGE', apiKey: 'SECRET_KEY' })];
  const sessions = [{ id: 'SECRET_SESSION', workspace: 'E:\\SECRET_PATH', messages: [{ content: 'SECRET_MESSAGE' }], taskRuns: [run('SECRET_RUN', 1000)] }];
  const serialized = JSON.stringify(analytics({ records, sessions }));
  assert.ok(!serialized.includes('SECRET_'));
  const unavailable = analytics({ records, sessions, error: new Error('SECRET_KEY') });
  assert.equal(unavailable.days.length, 0);
  assert.ok(Object.values(unavailable.summary).every(value => value === null));
  assert.equal(unavailable.error, '本机用量数据暂时不可用。');
  assert.ok(!JSON.stringify(unavailable).includes('SECRET_'));
});

test('unavailable data does not present zero totals and input data stays unchanged', () => {
  const records = [Object.freeze(usage('2026-10-20'))];
  const value = analytics({ records: Object.freeze(records), error: '账本无法读取。\n请检查。', since: '2026-10-01T00:00:00Z' });
  assert.equal(value.summary.totalTokens, null);
  assert.equal(value.summary.requests, null);
  assert.equal(value.error, '账本无法读取。 请检查。');
  assert.equal(value.days.length, 0);
  assert.equal(value.since, '2026-10-01T00:00:00.000Z');
  assert.doesNotThrow(() => analytics({ records }));
  assert.throws(() => createUsageAnalytics({ now: 'invalid' }), /统计时间无效/);
  assert.doesNotThrow(() => analytics({ records: {}, sessions: {} }));
});
