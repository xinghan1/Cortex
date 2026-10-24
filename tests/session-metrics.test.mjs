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

test('a current matching capacity immediately changes the circle denominator without rewriting history or billing', () => {
  const identity = { provider: 'relay', model: 'current-model', connectionKey: 'current-account' };
  const session = { contextUsage: { ...identity, version: 2, inputTokens: 20000, outputTokens: 4000,
    limit: 64000, limitKind: 'total', status: 'reported', phase: 'complete' } };
  const before = structuredClone(session), records = [record({ inputTokens: 800000, outputTokens: 9000 })];
  const enlarged = metrics(records, session, { expectedContext: { ...identity, limit: 128000, limitKind: 'total' } });
  assert.equal(enlarged.contextLimit, 128000); assert.equal(enlarged.contextPercent, 18.8);
  assert.equal(enlarged.contextDisplay.limit, 128000); assert.equal(enlarged.contextDisplay.usedTokens, 24000);
  assert.equal(enlarged.totalTokens, 809000); assert.deepEqual(session, before);
  const input = metrics(records, session, { expectedContext: { ...identity, limit: 100000, limitKind: 'input' } });
  assert.equal(input.contextUsedTokens, 20000); assert.equal(input.contextPercent, 20);
  assert.equal(input.contextDisplay.limitKind, 'input'); assert.equal(input.contextDisplay.usedTokens, 20000);
  const unknown = metrics(records, session, { expectedContext: { ...identity, limit: null, limitKind: 'total' } });
  assert.equal(unknown.contextLimit, null); assert.equal(unknown.contextPercent, null);
  assert.equal(unknown.contextDisplay.limit, null); assert.equal(unknown.contextDisplay.percent, null);
  assert.equal(unknown.contextUsedTokens, 24000);
  assert.equal(metrics(records, session, { expectedContext: identity }).contextLimit, 64000);
  const incomplete = metrics([], { contextUsage: { ...session.contextUsage, limitKind: 'input', outputTokens: null } },
    { expectedContext: { ...identity, limit: 128000, limitKind: 'total' } });
  assert.equal(incomplete.contextUsedTokens, null); assert.equal(incomplete.contextPercent, null);
  assert.equal(incomplete.contextStatus, 'partial');
  assert.deepEqual(session, before);
});

test('pending last-reported context uses the current matching capacity and cannot cross account/model scopes', () => {
  const identity = { provider: 'openai', model: 'gpt-6.1-sol', connectionKey: 'account-a' };
  const original = { ...identity, version: 2, status: 'reported', phase: 'complete', inputTokens: 90000, outputTokens: 10000,
    limit: 1050000, limitKind: 'total' };
  const session = { contextUsage: makePendingContextUsage(original) }, before = structuredClone(session);
  const changed = metrics([], session, { expectedContext: { ...identity, limit: 200000, limitKind: 'total' } });
  assert.equal(changed.contextDisplay.source, 'last-reported'); assert.equal(changed.contextDisplay.percent, 50);
  assert.equal(changed.contextLastReported.limit, 200000); assert.equal(changed.contextLastReported.usedTokens, 100000);
  const reset = metrics([], session, { expectedContext: { ...identity, limit: null, limitKind: 'total' } });
  assert.equal(reset.contextDisplay.limit, null); assert.equal(reset.contextDisplay.percent, null);
  for (const change of [{ connectionKey: 'account-b' }, { model: 'another-model' }, { provider: 'relay' }]) {
    const stale = metrics([], session, { expectedContext: { ...identity, ...change, limit: 200000, limitKind: 'total' } });
    assert.equal(stale.contextDisplay.source, 'none'); assert.equal(stale.contextLastReported, null); assert.equal(stale.contextPercent, null);
  }
  assert.deepEqual(session, before);
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

const breakdownContext = (overrides = {}) => ({ version: 2, provider: 'openai', model: 'fixture', connectionKey: 'account',
  requestId: 'dispatch-a', phase: 'complete', status: 'reported', inputTokens: 1001, outputTokens: 101,
  limit: 10000, limitKind: 'total', measuredAt: '2026-10-24T01:00:00Z',
  breakdown: { version: 1, requestId: 'dispatch-a', source: 'estimated-local',
    systemTokens: 100, toolTokens: 200, messageTokens: 700, totalTokens: 1000,
    estimatedOutputTokens: 888, hasUnknownAttachmentCost: false }, ...overrides });

test('breakdown allocates measured input by local weights and adds output only to total-window messages', () => {
  const context = breakdownContext(), session = { contextUsage: context }, before = structuredClone(session);
  const value = metrics([record({ inputTokens: 900000, outputTokens: 8000 })], session);
  assert.deepEqual(value.contextBreakdown, { systemTokens: 100, toolTokens: 200, messageTokens: 802, totalTokens: 1102,
    source: 'estimated-allocation', displaySource: 'current', hasUnknownAttachmentCost: false });
  assert.equal(value.contextBreakdown.totalTokens, value.contextDisplay.usedTokens);
  assert.equal(value.totalTokens, 908000); assert.deepEqual(session, before);
  const expectedContext = { provider: context.provider, model: context.model, connectionKey: context.connectionKey,
    limit: 2000, limitKind: 'input' };
  const input = metrics([], session, { expectedContext });
  assert.equal(input.contextDisplay.usedTokens, 1001); assert.equal(input.contextDisplay.percent, 50);
  assert.equal(input.contextBreakdown.messageTokens, 701); assert.equal(input.contextBreakdown.totalTokens, 1001);
  assert.equal(input.contextBreakdown.source, 'estimated-allocation');
  assert.deepEqual(session, before, 'Changing the denominator or kind never rewrites stored input weights');
  const zero = metrics([], { contextUsage: breakdownContext({ inputTokens: 0, outputTokens: 0 }) });
  assert.deepEqual([zero.contextBreakdown.systemTokens, zero.contextBreakdown.toolTokens, zero.contextBreakdown.messageTokens], [0, 0, 0]);
  assert.equal(zero.contextBreakdown.totalTokens, zero.contextDisplay.usedTokens);
});

test('partial or absent usage permits an explicitly local estimate without fabricating measured fields or billing', () => {
  for (const phase of ['requesting', 'complete', 'stopped', 'failed']) {
    const context = breakdownContext({ phase, status: phase === 'requesting' ? 'pending' : 'unknown', inputTokens: null, outputTokens: null });
    const value = metrics([record({ reported: false, inputTokens: null, outputTokens: null })], { contextUsage: context });
    assert.equal(value.contextDisplay.source, 'estimated'); assert.equal(value.contextDisplay.usedTokens, 1888);
    assert.equal(value.contextDisplay.percent, 18.9); assert.equal(value.contextDisplay.inputTokens, null);
    assert.equal(value.contextDisplay.outputTokens, null); assert.equal(value.contextBreakdown.messageTokens, 1588);
    assert.equal(value.contextBreakdown.totalTokens, value.contextDisplay.usedTokens);
    assert.equal(value.contextBreakdown.source, 'estimated-local'); assert.equal(value.contextBreakdown.displaySource, 'estimated');
    assert.equal(value.contextUsedTokens, null); assert.equal(value.contextPercent, null);
    assert.equal(value.totalTokens, 0); assert.equal(value.usageStatus, 'partial');
  }
  const input = metrics([], { contextUsage: breakdownContext({ status: 'unknown', inputTokens: null, outputTokens: null, limitKind: 'input' }) });
  assert.equal(input.contextDisplay.usedTokens, 1000); assert.equal(input.contextBreakdown.messageTokens, 700);
  const partial = metrics([], { contextUsage: breakdownContext({ phase: 'requesting', status: 'partial', inputTokens: null, outputTokens: 20 }) });
  assert.equal(partial.contextDisplay.usedTokens, 1020, 'A wire output counter replaces the stream output estimate, never adds to it');
  assert.equal(partial.contextOutputTokens, 20); assert.equal(partial.contextUsedTokens, null);
});

test('last-reported breakdown is bound to its own report and cannot borrow the current request weights', () => {
  const old = breakdownContext({ inputTokens: 2000, outputTokens: 20 });
  const pending = makePendingContextUsage(old);
  assert.equal(pending.requestId, null); assert.equal(pending.breakdown, undefined);
  assert.deepEqual(pending.lastReported.breakdown, old.breakdown);
  const current = breakdownContext({ requestId: 'dispatch-b', phase: 'requesting', status: 'pending', inputTokens: null, outputTokens: null,
    breakdown: { ...old.breakdown, requestId: 'dispatch-b', systemTokens: 990, toolTokens: 0, messageTokens: 10 }, lastReported: old });
  const value = metrics([], { contextUsage: current });
  assert.equal(value.contextDisplay.source, 'last-reported');
  assert.deepEqual(value.contextBreakdown, { systemTokens: 200, toolTokens: 400, messageTokens: 1420, totalTokens: 2020,
    source: 'estimated-allocation', displaySource: 'last-reported', hasUnknownAttachmentCost: false });
  const { breakdown, ...legacy } = old;
  const missing = metrics([], { contextUsage: { ...current, lastReported: legacy } });
  assert.equal(missing.contextDisplay.source, 'last-reported'); assert.equal(missing.contextBreakdown, null);
  assert.equal(missing.contextDisplay.usedTokens, 2020, 'Legacy real totals remain visible without invented category rows');
});

test('breakdown rejects stale bindings, malformed numbers and invalidated request anchors while stripping raw extras', () => {
  const context = breakdownContext(), expectedContext = { provider: context.provider, model: context.model, connectionKey: context.connectionKey };
  for (const patch of [{ provider: 'relay' }, { model: 'other' }, { connectionKey: 'another-account' }]) {
    const value = metrics([], { contextUsage: context }, { expectedContext: { ...expectedContext, ...patch } });
    assert.equal(value.contextBreakdown, null); assert.equal(value.contextDisplay.source, 'none');
  }
  for (const patch of [{ version: 0 }, { requestId: 'another-dispatch' }, { systemTokens: -1 }, { toolTokens: 1.2 },
    { totalTokens: 1001 }, { hasUnknownAttachmentCost: 'yes' }, { estimatedOutputTokens: Infinity },
    { systemTokens: Number.MAX_SAFE_INTEGER, toolTokens: Number.MAX_SAFE_INTEGER }]) {
    const value = metrics([], { contextUsage: { ...context, breakdown: { ...context.breakdown, ...patch } } });
    assert.equal(value.contextBreakdown, null); assert.equal(value.contextDisplay.source, 'current');
  }
  for (const patch of [{ requestId: null }, { phase: 'changed', status: 'pending', inputTokens: null, outputTokens: null },
    { phase: 'compacted', status: 'pending', inputTokens: null, outputTokens: null }])
    assert.equal(metrics([], { contextUsage: { ...context, ...patch } }).contextBreakdown, null);
  const extra = { ...context, breakdown: { ...context.breakdown, hasUnknownAttachmentCost: true,
    rawSystem: 'PRIVATE_SYSTEM', providerState: { signature: 'PRIVATE_SIGNATURE' } } };
  const result = metrics([], { contextUsage: extra });
  assert.equal(result.contextBreakdown.hasUnknownAttachmentCost, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|rawSystem|providerState|estimatedOutputTokens/);
  assert.doesNotMatch(JSON.stringify(result.contextBreakdown), /dispatch-a/);
  // Only the existing public contextRequestId is a valid request identifier.
  assert.equal(result.contextRequestId, 'dispatch-a');
});
