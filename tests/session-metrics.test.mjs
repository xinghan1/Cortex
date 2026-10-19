import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { aggregateSessionUsage, createSessionMetrics, estimateContextTokens } = createRequire(import.meta.url)('../src/core/session-metrics.cjs');
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
  const session = { contextUsage: { provider: 'relay', model: 'actual-id', usedTokens: 2600, limit: 10000, limitKind: 'input', status: 'reported' } };
  const value = metrics([record({ inputTokens: 500000 })], session);
  assert.equal(value.contextPercent, 26);
  assert.equal(value.contextLimitKind, 'input');
  assert.equal(value.totalTokens, 500020);
  assert.match(value.contextDescription, /不含输出/);
  assert.equal(metrics([], { contextUsage: { ...session.contextUsage, limit: null } }).contextPercent, null);
  assert.equal(metrics([], { contextUsage: { ...session.contextUsage, status: 'estimated' } }).contextStatus, 'estimated');
  assert.equal(metrics([], session, { expectedContext: { provider: 'relay', model: 'different-id' } }).contextStatus, 'unknown');
});

test('a different connection cannot reuse a previous endpoint context capacity', () => {
  const session = { contextUsage: { provider: 'relay', model: 'same-id', connectionKey: 'old', usedTokens: 20, limit: 100, status: 'reported' } };
  assert.equal(metrics([], session, { expectedContext: { provider: 'relay', model: 'same-id', connectionKey: 'new' } }).contextPercent, null);
});

test('character estimates exclude image transport, signatures, opaque state and private reasoning', () => {
  const plain = [{ role: 'user', content: 'Hello world' }];
  const withTransport = [{ ...plain[0], attachments: [{ dataUrl: 'data:image/png;base64,' + 'A'.repeat(100000) }],
    providerState: { encrypted_content: 'X'.repeat(100000), reasoning_content: 'private reasoning' } }];
  assert.equal(estimateContextTokens(plain), estimateContextTokens(withTransport));
  assert.ok(estimateContextTokens(plain, [{ name: 'read_file', description: 'A real tool definition' }]) > estimateContextTokens(plain));
  assert.equal(withTransport[0].providerState.reasoning_content, 'private reasoning');
});
