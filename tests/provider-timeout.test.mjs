import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

const IDLE_MS = 150;
const CHUNK_INTERVAL_MS = 25;
const apiKey = 'timeout-test-credential-never-print';
const encoder = new TextEncoder();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const completion = sse({ choices: [{ index: 0, delta: { content: 'finished' }, finish_reason: 'stop' }] }) + sse('[DONE]');

function options(fetchImpl, extra = {}) {
  return {
    provider: 'deepseek', model: 'deepseek-flash', apiKey,
    messages: [{ role: 'user', content: 'Synthetic timeout test.' }],
    timeoutMs: IDLE_MS, fetchImpl, ...extra,
  };
}

// An outer deadline prevents a broken fake transport from hanging this suite.
async function bounded(promise, milliseconds = 2_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Provider did not settle before the test deadline.')), milliseconds);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer); }
}

function fragments(source, count = 13) {
  const bytes = encoder.encode(source);
  const size = Math.ceil(bytes.byteLength / count);
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) chunks.push(bytes.slice(offset, offset + size));
  return chunks;
}

function streamedBody(t, { chunks = [], intervalMs = CHUNK_INTERVAL_MS, close = true, cancelNeverSettles = false } = {}) {
  let timer;
  let stopped = false;
  let index = 0;
  const stats = { cancelCount: 0, deliveredAt: [] };
  const body = new ReadableStream({
    start(controller) {
      const deliver = () => {
        if (stopped) return;
        if (index < chunks.length) {
          const chunk = chunks[index++];
          stats.deliveredAt.push(performance.now());
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        }
        if (index < chunks.length) timer = setTimeout(deliver, intervalMs);
        else if (close) { stopped = true; controller.close(); }
      };
      if (chunks.length || close) deliver();
    },
    cancel() {
      stats.cancelCount += 1;
      stopped = true;
      clearTimeout(timer);
      if (cancelNeverSettles) return new Promise(() => {});
    },
  });
  t.after(() => {
    stopped = true;
    clearTimeout(timer);
    // Never await a deliberately malicious underlying cancel implementation.
    body.cancel().catch(() => {});
  });
  return { body, stats };
}

function trackedCallerSignal() {
  const controller = new AbortController();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const active = new Set();
  const stats = { additions: 0, removals: 0, active };
  signal.addEventListener = (type, listener, ...rest) => {
    if (type === 'abort') { stats.additions += 1; active.add(listener); }
    return add(type, listener, ...rest);
  };
  signal.removeEventListener = (type, listener, ...rest) => {
    if (type === 'abort') { stats.removals += 1; active.delete(listener); }
    return remove(type, listener, ...rest);
  };
  return { controller, signal, stats };
}

test('DeepSeek reasoning bytes and comment-only heartbeats both extend the idle budget', async t => {
  for (const kind of ['reasoning', 'heartbeat']) await t.test(kind, async t => {
    const keepalives = Array.from({ length: 13 }, (_, index) => kind === 'heartbeat'
      ? `: heartbeat ${index}\n\n`
      : sse({ choices: [{ index: 0, delta: { reasoning_content: `thought-${index};` }, finish_reason: null }] }));
    const { body, stats } = streamedBody(t, { chunks: [...keepalives, completion], close: false });
    const visible = [];
    const result = await bounded(requestModel(options(async () => new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }), { onTextDelta: value => visible.push(value) })));
    assert.equal(result.message.content, 'finished');
    assert.deepEqual(visible, ['finished']);
    assert.ok(stats.deliveredAt.at(-1) - stats.deliveredAt[0] > IDLE_MS * 1.5);
    assert.equal(stats.cancelCount, 1, 'a completed SSE response releases its still-open body');
    if (kind === 'reasoning') assert.match(result.message.providerState.message.reasoning_content, /thought-12;/);
  });
});

test('a silent response read times out and cancels a body that ignores the fetch signal', async t => {
  const { body, stats } = streamedBody(t, {
    chunks: [sse({ choices: [{ delta: { reasoning_content: 'initial thought' }, finish_reason: null }] })], close: false,
  });
  let transportSignal;
  await assert.rejects(bounded(requestModel(options(async (_, request) => {
    transportSignal = request.signal;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }))), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(transportSignal.aborted, true);
  assert.equal(stats.cancelCount, 1);
});

test('timeout settlement does not wait for an underlying cancel promise that never resolves', async t => {
  const { body, stats } = streamedBody(t, { close: false, cancelNeverSettles: true });
  await assert.rejects(bounded(requestModel(options(async () => new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  })))), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(stats.cancelCount, 1);
});

test('waiting for headers times out whether fake fetch observes or ignores its signal', async t => {
  for (const observesSignal of [true, false]) await t.test(observesSignal ? 'observes signal' : 'ignores signal', async () => {
    let transportSignal;
    let abortEvents = 0;
    let calls = 0;
    const fetchImpl = async (_, request) => {
      calls += 1;
      transportSignal = request.signal;
      return new Promise((_, reject) => {
        if (observesSignal) request.signal.addEventListener('abort', () => {
          abortEvents += 1;
          reject(new DOMException('Synthetic transport aborted.', 'AbortError'));
        }, { once: true });
      });
    };
    await assert.rejects(bounded(requestModel(options(fetchImpl))), { code: 'PROVIDER_TIMEOUT' });
    assert.equal(transportSignal.aborted, true);
    assert.equal(calls, 1, 'an idle timeout never retries a potentially billable request');
    assert.equal(abortEvents, observesSignal ? 1 : 0);
  });
});

test('a fetch response arriving after timeout has its otherwise unobserved body cancelled', async t => {
  const { body, stats } = streamedBody(t, { close: false });
  let resolveFetch;
  let transportSignal;
  const fetchImpl = (_, request) => {
    transportSignal = request.signal;
    // This transport intentionally ignores abort and resolves only after the
    // public request has already rejected with its idle-timeout error.
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  await assert.rejects(bounded(requestModel(options(fetchImpl))), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(transportSignal.aborted, true);
  assert.equal(stats.cancelCount, 0, 'a body not yet delivered cannot be cancelled by the reader');
  resolveFetch(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stats.cancelCount, 1, 'the late response must be disposed without a retry or reader');
});

test('user cancellation interrupts a pending read, cancels the body and retains AbortError identity', async t => {
  const caller = trackedCallerSignal();
  const { body, stats } = streamedBody(t, { close: false });
  let transportSignal;
  const pending = requestModel(options(async (_, request) => {
    transportSignal = request.signal;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }, { signal: caller.signal }));
  const abortTimer = setTimeout(() => caller.controller.abort(), 35);
  t.after(() => clearTimeout(abortTimer));
  await assert.rejects(bounded(pending), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    assert.notEqual(error.code, 'PROVIDER_TIMEOUT');
    return true;
  });
  assert.equal(transportSignal.aborted, true);
  assert.equal(stats.cancelCount, 1);
  assert.equal(caller.stats.active.size, 0);
});

test('raw JSON fragments refresh idle time before a complete JSON value is available', async t => {
  const source = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '中文 final' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 } });
  const { body, stats } = streamedBody(t, { chunks: fragments(source) });
  const result = await bounded(requestModel(options(async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  }))));
  assert.equal(result.message.content, '中文 final');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 });
  assert.ok(stats.deliveredAt.at(-1) - stats.deliveredAt[0] > IDLE_MS * 1.5);
});

test('fragmented HTTP error diagnostics refresh idle time and retain bounded secret-safe HTTP 400 details', async t => {
  const bearer = 'synthetic-bearer-token-not-for-display';
  const password = 'synthetic-url-password';
  const source = JSON.stringify({ error: {
    message: `Unknown model. credential=${apiKey}; Bearer ${bearer}; https://user:${password}@example.invalid/path?api_key=query-secret`,
    code: 'invalid_model', param: 'model',
  } });
  const { body, stats } = streamedBody(t, { chunks: fragments(source) });
  await assert.rejects(bounded(requestModel(options(async () => new Response(body, {
    status: 400, headers: { 'content-type': 'application/json' },
  })))), error => {
    assert.equal(error.code, 'PROVIDER_HTTP_400');
    assert.match(error.message, /Unknown model/);
    assert.match(error.message, /code: invalid_model/);
    assert.match(error.message, /param: model/);
    for (const secret of [apiKey, bearer, password, 'query-secret']) assert.equal(error.message.includes(secret), false);
    assert.ok(error.message.length < 1_200);
    return true;
  });
  assert.ok(stats.deliveredAt.at(-1) - stats.deliveredAt[0] > IDLE_MS * 1.5);
});

test('silence inside an HTTP error body remains a timeout and cancels its reader', async t => {
  const { body, stats } = streamedBody(t, { chunks: ['{"error":{"message":"partial'], close: false });
  await assert.rejects(bounded(requestModel(options(async () => new Response(body, {
    status: 400, headers: { 'content-type': 'application/json' },
  })))), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(stats.cancelCount, 1);
});

test('success and HTTP failure both detach the caller listener and clear the idle timer', async t => {
  const checks = [];
  for (const status of [200, 400]) {
    const caller = trackedCallerSignal();
    let transportSignal;
    const source = status === 200 ? { choices: [{ message: { content: 'ok' } }] }
      : { error: { message: 'Synthetic invalid model.', code: 'invalid_model', param: 'model' } };
    const pending = bounded(requestModel(options(async (_, request) => {
      transportSignal = request.signal;
      return new Response(JSON.stringify(source), { status, headers: { 'content-type': 'application/json' } });
    }, { signal: caller.signal })));
    if (status === 200) assert.equal((await pending).message.content, 'ok');
    else await assert.rejects(pending, { code: 'PROVIDER_HTTP_400' });
    assert.equal(caller.stats.additions, 1);
    assert.equal(caller.stats.removals, 1);
    assert.equal(caller.stats.active.size, 0);
    checks.push({ caller, transportSignal });
  }
  await sleep(IDLE_MS + 75);
  for (const { caller, transportSignal } of checks) {
    assert.equal(transportSignal.aborted, false, 'the completed request must not be aborted by a stale timeout');
    caller.controller.abort();
    assert.equal(transportSignal.aborted, false, 'a detached caller signal cannot affect a completed request');
  }
});
