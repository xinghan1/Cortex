import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { aggregateSessionUsage, createSessionMetrics, estimateContextTokens, makePendingContextUsage } = createRequire(import.meta.url)('../src/core/session-metrics.cjs');
let ordinal = 0;
const record = overrides => ({ id: `request-${++ordinal}`, reported: true, inputTokens: 100, outputTokens: 20, ...overrides });
const metrics = (records = [], session = {}, options) => createSessionMetrics(session, aggregateSessionUsage(records), options);

test('cache tokens are an input subset and weighted by the reported input denominator', () => {
  const value = metrics([record({ cachedInputTokens: 90 }), record({ inputTokens: 900, cachedInputTokens: 0 })]);
  assert.equal(value.totalTokens, 1040);
  assert.equal(value.cachedInputTokens, 90);
  assert.equal(value.cacheHitPercent, 9);
  assert.equal(value.cacheStatus, 'reported');
});

test('missing cache reports do not become zero hits or enter the cache denominator', () => {
  const value = metrics([record({ cachedInputTokens: 90 }), record({ inputTokens: 900 })]);
  assert.equal(value.cacheHitPercent, 90);
  assert.equal(value.cacheCoveragePercent, 10);
  assert.equal(value.cacheInputTokens, 100);
  assert.equal(value.cacheStatus, 'partial');
  assert.equal(value.totalTokens, 1040);
  assert.equal(metrics([record()]).cacheHitPercent, null);
  assert.equal(metrics([record()]).cacheStatus, 'unavailable');
  assert.equal(metrics([record({ cachedInputTokens: 0 })]).cacheHitPercent, 0);
});

test('duplicates, unreported failures, historical approximations and partial responses stay explicit', () => {
  const known = record({ cachedInputTokens: 40 });
  const value = metrics([known, known, record({ reported: false, inputTokens: null, outputTokens: null }), record({ partial: true, inputTokens: 5, outputTokens: 3 })]);
  assert.equal(value.totalTokens, 128);
  assert.equal(value.usageStatus, 'partial');
  assert.equal(value.cacheStatus, 'partial');
  assert.equal(metrics([record({ historicalApproximate: true })]).usageStatus, 'partial');
  assert.equal(metrics([], {}, { unavailable: true }).totalTokens, null);
});

test('rounds count the complete sent transcript, including steering but excluding tool and assistant messages', () => {
  const messages = Array.from({ length: 200 }, () => ({ role: 'user', content: 'sent' }));
  messages.push({ role: 'assistant', content: 'reply' }, { role: 'tool', content: 'tool result' }, { role: 'user', source: 'steering', content: 'supplement' });
  assert.equal(metrics([], { messages, contextCheckpoint: { throughIndex: 150 } }).rounds, 201);
  assert.equal(metrics([], { messages, demo: true }).rounds, 0);
});

test('context uses only the latest projected request and a declared capacity', () => {
  const session = { contextUsage: { version: 2, provider: 'relay', model: 'actual-id', inputTokens: 2600, outputTokens: 400,
    usedTokens: 99999, limit: 10000, limitKind: 'input', status: 'reported', phase: 'complete' } };
  const value = metrics([record({ inputTokens: 500000 })], session);
  assert.equal(value.contextPercent, 26);
  assert.equal(value.contextLimitKind, 'input');
  assert.equal(value.totalTokens, 500020);
  assert.match(value.contextDescription, /不含输出/);
  assert.equal(metrics([], { contextUsage: { ...session.contextUsage, limit: null } }).contextPercent, null);
  assert.equal(metrics([], { contextUsage: { usedTokens: 2600, limit: 10000, status: 'estimated' } }).contextStatus, 'unknown');
  assert.equal(metrics([], session, { expectedContext: { provider: 'relay', model: 'different-id' } }).contextStatus, 'unknown');
});

test('a different connection cannot reuse a previous endpoint context capacity', () => {
  const session = { contextUsage: { version: 2, provider: 'relay', model: 'same-id', connectionKey: 'old', inputTokens: 20, outputTokens: 5,
    limit: 100, status: 'reported', phase: 'complete' } };
  assert.equal(metrics([], session, { expectedContext: { provider: 'relay', model: 'same-id', connectionKey: 'new' } }).contextPercent, null);
});

test('total-window context uses actual input plus output without adding cached or reasoning subsets again', () => {
  const context = { version: 2, provider: 'ollama', model: 'coder', limit: 32768, limitKind: 'total', status: 'reported', phase: 'complete',
    inputTokens: 3503, outputTokens: 1000, cachedInputTokens: 3000, reasoningTokens: 600, usedTokens: 7 };
  const value = metrics([record({ inputTokens: 1000000 })], { contextUsage: context });
  assert.equal(value.contextUsedTokens, 4503); assert.equal(value.contextPercent, 13.7);
  assert.equal(value.contextInputTokens, 3503); assert.equal(value.contextOutputTokens, 1000);
  assert.equal(value.totalTokens, 1000020);
  assert.match(value.contextDescription, /服务端实测.*输入与输出/);
  const grown = metrics([], { contextUsage: { ...context, outputTokens: 2000 } });
  assert.equal(grown.contextUsedTokens, 5503); assert.equal(grown.contextPercent, 16.8);
  assert.equal(metrics([], { contextUsage: { ...context, inputTokens: 0, outputTokens: 0 } }).contextPercent, 0);
});

test('missing, streaming, stopped and legacy statistics cannot become complete real-time context', () => {
  const base = { version: 2, provider: 'ollama', model: 'coder', limit: 32768, status: 'reported', phase: 'complete', inputTokens: 3503, outputTokens: 1000 };
  for (const update of [{ outputTokens: null }, { inputTokens: null }, { inputTokens: -1 }, { outputTokens: NaN },
    { phase: 'stopped' }, { phase: 'requesting', status: 'partial' }, { status: 'unknown', phase: 'failed' }]) {
    const value = metrics([], { contextUsage: { ...base, ...update } });
    assert.notEqual(value.contextStatus, 'reported'); assert.equal(value.contextPercent, null); assert.equal(value.contextUsedTokens, null);
  }
  for (const contextUsage of [{ usedTokens: 20, limit: 100, status: 'reported' }, { ...base, version: undefined },
    { usedTokens: 20, limit: 100, status: 'estimated' }]) {
    assert.equal(metrics([], { contextUsage }).contextStatus, 'unknown');
    assert.equal(metrics([], { contextUsage }).contextPercent, null);
  }
});

test('new content invalidates current measurement while preserving a single private-safe previous report', () => {
  const previous = { version: 2, provider: 'ollama', model: 'coder', connectionKey: 'same', inputTokens: 42, outputTokens: 5,
    limit: 8192, status: 'reported', phase: 'complete', measuredAt: '2026-10-21T01:00:00Z', measurement: { prefixHash: 'fixture-private-hash' } };
  const pending = makePendingContextUsage(previous);
  assert.equal(pending.status, 'pending'); assert.equal(pending.inputTokens, null); assert.equal(pending.outputTokens, null);
  assert.equal(pending.lastReported.inputTokens, 42); assert.equal(pending.measurement.prefixHash, 'fixture-private-hash');
  const again = makePendingContextUsage(pending);
  assert.equal(Object.hasOwn(again.lastReported, 'lastReported'), false);
  const value = metrics([], { contextUsage: again }, { expectedContext: { provider: 'ollama', model: 'coder', connectionKey: 'same' } });
  assert.equal(value.contextStatus, 'pending'); assert.equal(value.contextPercent, null);
  assert.equal(value.contextLastReported.usedTokens, 47);
  assert.equal(value.contextDisplay.source, 'last-reported'); assert.equal(value.contextDisplay.pending, true);
  assert.equal(value.contextDisplay.usedTokens, 47); assert.equal(value.contextDisplay.percent, 0.6);
  assert.ok(!JSON.stringify(value).includes('fixture-private-hash'));
  const changed = metrics([], { contextUsage: again }, { expectedContext: { provider: 'ollama', model: 'other', connectionKey: 'same' } });
  assert.equal(changed.contextStatus, 'unknown'); assert.equal(changed.contextLastReported, null);
  assert.equal(changed.contextDisplay.source, 'none'); assert.equal(changed.contextDisplay.percent, null);
  assert.equal(changed.contextInputTokens, null); assert.equal(changed.contextLimit, null); assert.equal(changed.contextModel, null);
});

test('ChatGPT pending tools keep the last complete official report visible without claiming current measurement', () => {
  const expectedContext = { provider: 'openai', model: 'official-fixture', connectionKey: 'chatgpt-profile-a' };
  const completed = { ...expectedContext, version: 2, inputTokens: 35662, outputTokens: 208, limit: 128000, limitKind: 'total',
    phase: 'complete', status: 'reported', measuredAt: '2026-10-21T01:00:00Z', requestId: 'official-request',
    measurement: { prefixHash: 'PRIVATE_HASH', bindingHash: 'PRIVATE_BINDING' } };
  const pending = makePendingContextUsage(completed), session = { contextUsage: pending };
  const value = metrics([record({ inputTokens: 1000000 })], session, { expectedContext });
  assert.equal(value.contextStatus, 'pending'); assert.equal(value.contextPercent, null); assert.equal(value.contextUsedTokens, null);
  assert.equal(value.contextInputTokens, null); assert.equal(value.contextOutputTokens, null);
  assert.deepEqual(value.contextDisplay, { source: 'last-reported', pending: true, inputTokens: 35662, outputTokens: 208,
    usedTokens: 35870, limit: 128000, limitKind: 'total', percent: 28, provider: 'openai', model: 'official-fixture', measuredAt: completed.measuredAt });
  assert.equal(value.totalTokens, 1000020, 'The context display must remain separate from cumulative billed usage');
  assert.equal(JSON.stringify(value.contextDisplay).includes('PRIVATE'), false);
  assert.equal(Object.hasOwn(value.contextDisplay, 'lastReported'), false);
  value.contextDisplay.inputTokens = 1;
  assert.equal(session.contextUsage.lastReported.inputTokens, 35662, 'Display metadata must not modify the archived report');
});

test('partial, failed and stopped requests cannot replace the last complete display, but a complete newer report does', () => {
  const old = { version: 2, provider: 'openai', model: 'official-fixture', limit: 10000, limitKind: 'total',
    phase: 'complete', status: 'reported', inputTokens: 1000, outputTokens: 100, measuredAt: 'old' };
  const pending = makePendingContextUsage(old);
  for (const phase of ['requesting', 'failed', 'stopped']) {
    const value = metrics([], { contextUsage: { ...pending, phase, status: 'partial', inputTokens: 2000, outputTokens: 5 } });
    assert.equal(value.contextDisplay.source, 'last-reported'); assert.equal(value.contextDisplay.pending, true);
    assert.equal(value.contextDisplay.percent, 11); assert.equal(value.contextDisplay.inputTokens, 1000);
    assert.equal(value.contextPercent, null); assert.equal(value.contextUsedTokens, null);
    assert.equal(value.contextInputTokens, 2000); assert.equal(value.contextOutputTokens, 5);
  }
  const current = metrics([], { contextUsage: { ...old, lastReported: old, inputTokens: 2000, outputTokens: 200, measuredAt: 'new' } });
  assert.equal(current.contextDisplay.source, 'current'); assert.equal(current.contextDisplay.pending, false);
  assert.equal(current.contextDisplay.percent, 22); assert.equal(current.contextPercent, 22);
  assert.equal(current.contextDisplay.measuredAt, 'new'); assert.equal(current.contextLastReported.measuredAt, 'old');
});

test('historical context display never crosses providers, models or connections and never invents a capacity', () => {
  const previous = { version: 2, provider: 'openai', model: 'same-id', connectionKey: 'profile-a', limit: 10000,
    phase: 'complete', status: 'reported', inputTokens: 500, outputTokens: 50 };
  const session = { contextUsage: makePendingContextUsage(previous) };
  for (const expectedContext of [{ provider: 'relay', model: 'same-id', connectionKey: 'profile-a' },
    { provider: 'openai', model: 'other-id', connectionKey: 'profile-a' },
    { provider: 'openai', model: 'same-id', connectionKey: 'profile-b' }]) {
    const value = metrics([], session, { expectedContext });
    assert.equal(value.contextDisplay.source, 'none'); assert.equal(value.contextDisplay.percent, null);
    assert.equal(value.contextDisplay.usedTokens, null); assert.equal(value.contextDisplay.model, null);
    assert.equal(value.contextLastReported, null); assert.equal(value.contextPercent, null);
  }
  const unknownCapacity = metrics([], { contextUsage: makePendingContextUsage({ ...previous, limit: null }) });
  assert.equal(unknownCapacity.contextDisplay.source, 'last-reported'); assert.equal(unknownCapacity.contextDisplay.usedTokens, 550);
  assert.equal(unknownCapacity.contextDisplay.limit, null); assert.equal(unknownCapacity.contextDisplay.percent, null);
  const noReport = metrics([], { contextUsage: { version: 2, status: 'pending', phase: 'requesting', inputTokens: null, outputTokens: null, limit: 10000 } });
  assert.equal(noReport.contextDisplay.source, 'none'); assert.equal(noReport.contextDisplay.percent, null);
  assert.equal(noReport.contextDisplay.usedTokens, null);
  const { connectionKey, ...unbound } = previous;
  for (const contextUsage of [unbound, makePendingContextUsage(unbound)]) {
    const value = metrics([], { contextUsage }, { expectedContext: { provider: previous.provider, model: previous.model, connectionKey: 'profile-b' } });
    assert.equal(value.contextDisplay.source, 'none', 'A legacy report without a connection identity cannot be assigned to the selected profile');
    assert.equal(value.contextPercent, null); assert.equal(value.contextLastReported, null);
  }
});

test('display preserves true zero and input-only semantics instead of substituting cumulative or estimated counts', () => {
  const report = { version: 2, provider: 'relay', model: 'fixture', phase: 'complete', status: 'reported',
    limit: 1000, limitKind: 'input', inputTokens: 0, outputTokens: null, estimatedTokens: 99999 };
  for (const pending of [false, true]) {
    const value = metrics([record({ inputTokens: 100000 })], { contextUsage: pending ? makePendingContextUsage(report) : report });
    assert.equal(value.contextDisplay.source, pending ? 'last-reported' : 'current');
    assert.equal(value.contextDisplay.percent, 0); assert.equal(value.contextDisplay.usedTokens, 0);
    assert.equal(value.contextDisplay.outputTokens, null); assert.equal(value.contextDisplay.limitKind, 'input');
    assert.equal(value.contextDisplay.pending, pending);
  }
});

test('character estimates exclude image transport, signatures, opaque state and private reasoning', () => {
  const plain = [{ role: 'user', content: 'Hello world' }];
  const withTransport = [{ ...plain[0], attachments: [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(100000) }],
    providerState: { encrypted_content: 'X'.repeat(100000), reasoning_content: 'private reasoning' } }];
  assert.equal(estimateContextTokens(plain), estimateContextTokens(withTransport));
  assert.ok(estimateContextTokens(plain, [{ name: 'read_file', description: 'A real tool definition' }]) > estimateContextTokens(plain));
  assert.equal(withTransport[0].providerState.reasoning_content, 'private reasoning');
});
