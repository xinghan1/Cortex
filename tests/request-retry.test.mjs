import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_RETRY_LIMITS, retryAfterMilliseconds, reconnectReason, retryModelRequest } from '../src/core/request-retry.mjs';

const failure = (code, extra = {}) => Object.assign(new Error('private-service-detail-must-not-be-an-event'), { code, ...extra });

test('Retry-After accepts bounded numeric durations and HTTP dates, never malformed or negative delays', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(retryAfterMilliseconds(' 0 ', now), 0);
  assert.equal(retryAfterMilliseconds('12', now), 12_000);
  assert.equal(retryAfterMilliseconds('Thu, 22 Oct 2026 10:00:42 GMT', now), 42_000);
  assert.equal(retryAfterMilliseconds('Thu, 22 Oct 2026 09:00:00 GMT', now), 0);
  for (const value of [null, undefined, true, 12, '', '-1', '1.5', 'Infinity', 'later', 'x'.repeat(257), '9'.repeat(80)]) {
    assert.equal(retryAfterMilliseconds(value, now), undefined);
  }
});

test('only temporary request errors reconnect, not cancellation, authentication, parse or explicit permanent errors', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 524, 599]) assert.equal(reconnectReason(failure(`PROVIDER_HTTP_${status}`)), 'service');
  for (const status of [400, 401, 402, 403, 404, 413, 422, 499, 600]) assert.equal(reconnectReason(failure(`PROVIDER_HTTP_${status}`)), null);
  for (const code of ['PROVIDER_INVALID_JSON', 'PROVIDER_INVALID_ENCODING', 'PROVIDER_RESPONSE_TOO_LARGE', 'INVALID_TOOL_ARGUMENTS', 'CHATGPT_USAGE_LIMIT_EXCEEDED', 'CHATGPT_AUTH_EXPIRED']) assert.equal(reconnectReason(failure(code)), null);
  assert.equal(reconnectReason(failure('PROVIDER_NETWORK_ERROR')), 'connection');
  assert.equal(reconnectReason(failure('PROVIDER_INCOMPLETE_STREAM')), 'connection');
  assert.equal(reconnectReason(failure('PROVIDER_TIMEOUT')), 'timeout');
  assert.equal(reconnectReason(failure('PROVIDER_NETWORK_ERROR', { retryable: false })), null);
  assert.equal(reconnectReason(failure('PROVIDER_TIMEOUT', { name: 'AbortError' })), null);
  assert.equal(reconnectReason(failure('network_error', { retryable: true })), 'connection');
  assert.equal(reconnectReason(failure('network_error', { retryable: false })), null);
});

test('default retry limit is five reconnects with progressive waits and safe status events', async () => {
  const error = failure('PROVIDER_NETWORK_ERROR'), waits = [], events = [], attempts = [];
  await assert.rejects(retryModelRequest(async attempt => { attempts.push(attempt); throw error; }, {
    sleep: async milliseconds => { waits.push(milliseconds); }, onEvent: event => events.push(event),
  }), candidate => candidate === error);
  assert.equal(MODEL_RETRY_LIMITS.maxRetries, 5);
  assert.deepEqual(attempts, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000]);
  assert.deepEqual(events.filter(event => event.status === 'waiting').map(event => event.attempt), [1, 2, 3, 4, 5]);
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(events.at(-1).reason, 'retry-limit');
  assert.equal(events.every(event => event.maxAttempts === 5), true);
  assert.equal(JSON.stringify(events).includes(error.message), false);
});

test('server cooldown takes priority and a cooldown beyond the bounded wait never retries early', async () => {
  const waits = [], events = [];
  let count = 0;
  const value = await retryModelRequest(async () => {
    count++;
    if (count <= 2) throw failure('PROVIDER_HTTP_429', { retryAfterMs: count === 1 ? 0 : 60_000 });
    return 'finished';
  }, { sleep: async value => { waits.push(value); }, onEvent: value => events.push(value) });
  assert.equal(value, 'finished');
  assert.deepEqual(waits, [0, 60_000]);
  assert.equal(events.at(-1).status, 'recovered');
  assert.equal(events.at(-1).attempt, 2);
  let calls = 0;
  await assert.rejects(retryModelRequest(async () => { calls++; throw failure('PROVIDER_HTTP_503', { retryAfterMs: 60_001 }); }, {
    sleep: async () => assert.fail('Must not wait or shorten the server cooldown'), onEvent: event => events.push(event),
  }));
  assert.equal(calls, 1);
  assert.equal(events.at(-1).reason, 'retry-after');
});

test('abort cancels a real cooldown immediately and does not start another attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = performance.now();
  const pending = retryModelRequest(async () => { calls++; throw failure('PROVIDER_HTTP_503', { retryAfterMs: 60_000 }); }, {
    signal: controller.signal,
    onEvent: event => { if (event.status === 'waiting') setImmediate(() => controller.abort()); },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.ok(performance.now() - started < 1000);
});

test('a permanent error after reconnect stops immediately and preserves the original failure', async () => {
  const events = [], terminal = failure('PROVIDER_HTTP_401');
  let calls = 0;
  await assert.rejects(retryModelRequest(async () => {
    if (++calls === 1) throw failure('PROVIDER_TIMEOUT');
    throw terminal;
  }, { sleep: async () => {}, onEvent: event => events.push(event) }), candidate => candidate === terminal);
  assert.equal(calls, 2);
  assert.equal(events.at(-1).reason, 'not-retryable');
});

test('observer failure after successful recovery never replays the completed request', async () => {
  let calls = 0;
  await assert.rejects(retryModelRequest(async () => {
    if (++calls === 1) throw failure('PROVIDER_NETWORK_ERROR');
    return 'complete';
  }, { sleep: async () => {}, onEvent: event => { if (event.status === 'recovered') throw failure('PROVIDER_NETWORK_ERROR'); } }));
  assert.equal(calls, 2);
});
