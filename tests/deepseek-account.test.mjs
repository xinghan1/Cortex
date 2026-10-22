import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDeepSeekBalance, isOfficialDeepSeekURL } from '../src/core/deepseek-account.mjs';

const apiKey = 'fixture-private-deepseek-key';
const info = changes => ({ currency: 'CNY', total_balance: '9007199254740993.123456789012345678',
  granted_balance: '-0.000000000000000001', topped_up_balance: '9007199254740993.123456789012345679', ...changes });
const balance = changes => ({ is_available: true, balance_infos: [info()], ...changes });
const options = extra => ({ apiKey, fetchImpl: async () => Response.json(balance()), ...extra });

test('official URL recognition accepts only the raw official HTTPS authority and supported base paths', () => {
  for (const url of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://API.DEEPSEEK.COM/v1/'])
    assert.equal(isOfficialDeepSeekURL(url), true, url);
  for (const url of [undefined, null, '', ' https://api.deepseek.com', 'http://api.deepseek.com', 'https://api.deepseek.com:443',
    'https://api.deepseek.com.evil.invalid', 'https://api.deepseek.com@evil.invalid', 'https://user@api.deepseek.com',
    'https://api.deepseek.com?x', 'https://api.deepseek.com/#', 'https://api.deepseek.com/v1?key=x',
    'https://api.deepseek.com/v1/..', 'https://api.deepseek.com/%76%31', 'https://api.deepseek.com/V1',
    'https://api.deepseek.com//', 'https://api.deepseek.com/v1\\', 'https://api.deepseek.com\n', 'https://relay.invalid/v1'])
    assert.equal(isOfficialDeepSeekURL(url), false, String(url));
});

test('a balance query uses only the official endpoint and preserves decimal precision and negative balances', async () => {
  let calls = 0;
  const expected = balance({ balance_infos: [info(), info({ currency: 'USD', total_balance: '-2.50', granted_balance: '0', topped_up_balance: '-2.50' })] });
  const result = await fetchDeepSeekBalance(options({ baseUrl: 'https://api.deepseek.com/v1/', fetchImpl: async (url, request) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, `Bearer ${apiKey}`); assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'no-store'); assert.equal(request.body, undefined);
    assert.ok(request.signal instanceof AbortSignal);
    return Response.json(expected);
  } }));
  assert.deepEqual(result, expected); assert.equal(calls, 1);
  assert.equal(result.balance_infos[0].total_balance, expected.balance_infos[0].total_balance);
});

test('empty account data and unavailable status remain distinct and never manufacture zero balances', async () => {
  const result = await fetchDeepSeekBalance(options({ fetchImpl: async () => Response.json(balance({ is_available: false, balance_infos: [] })) }));
  assert.deepEqual(result, { is_available: false, balance_infos: [] });
});

test('invalid keys, third-party bases and invalid timeout settings fail before any request', async () => {
  let requests = 0;
  for (const extra of [{ apiKey: '' }, { apiKey: null }, { apiKey: 4 }, { apiKey: ' private ' }, { apiKey: 'x\r\nAuthorization: y' },
    { apiKey: 'x'.repeat(4097) }, { apiKey: '密钥' }, { baseUrl: 'https://relay.invalid/v1' }, { baseUrl: '' },
    { timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: 1.5 }]) {
    await assert.rejects(fetchDeepSeekBalance(options({ ...extra, fetchImpl: async () => { requests++; return Response.json(balance()); } })),
      error => error.name === 'DeepSeekBalanceError' && !error.message.includes(apiKey));
  }
  assert.equal(requests, 0);
});

test('strict response schemas reject missing, numeric, unsupported, unbounded and unexpected data without exposing the body', async () => {
  const invalid = [null, [], {}, { ...balance(), is_available: 'true' }, { ...balance(), balance_infos: null },
    { ...balance(), secret: apiKey }, balance({ balance_infos: [info({ currency: 'EUR' })] }),
    balance({ balance_infos: [info(), info()] }), balance({ balance_infos: [info({ total_balance: 0 })] }),
    balance({ balance_infos: [info({ total_balance: 'NaN' })] }), balance({ balance_infos: [info({ total_balance: '1e6' })] }),
    balance({ balance_infos: [info({ total_balance: ' 1.0' })] }), balance({ balance_infos: [info({ total_balance: '+1' })] }),
    balance({ balance_infos: [info({ total_balance: '1'.repeat(65) })] }), balance({ balance_infos: [info({ granted_balance: undefined })] }),
    balance({ balance_infos: [info({ private: apiKey })] })];
  for (const value of invalid) await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async () => Response.json(value) })),
    error => error.code === 'DEEPSEEK_BALANCE_RESPONSE' && !JSON.stringify(error).includes(apiKey));
  await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async () => new Response('RAW_SECRET ' + apiKey) })),
    error => error.code === 'DEEPSEEK_BALANCE_RESPONSE' && !error.message.includes('RAW_SECRET') && !error.message.includes(apiKey));
});

test('HTTP failures and redirects produce safe short errors and never read or echo raw error bodies', async () => {
  for (const [status, code] of [[301, 'HTTP'], [401, 'AUTH'], [403, 'FORBIDDEN'], [429, 'BUSY'], [500, 'HTTP']]) {
    await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async (_url, request) => {
      assert.equal(request.redirect, 'error'); return new Response(apiKey + ' RAW_BODY', { status });
    } })), error => error.code === `DEEPSEEK_BALANCE_${code}` && !error.message.includes(apiKey) && !error.message.includes('RAW_BODY'));
  }
  await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async () => { throw new Error('NETWORK_PRIVATE ' + apiKey); } })),
    error => error.code === 'DEEPSEEK_BALANCE_NETWORK' && !error.message.includes('NETWORK_PRIVATE') && !error.message.includes(apiKey));
  await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async () => {
    throw Object.assign(new Error(apiKey), { name: 'DeepSeekBalanceError', code: 'DEEPSEEK_BALANCE_AUTH' });
  } })), error => error.code === 'DEEPSEEK_BALANCE_NETWORK' && !error.message.includes(apiKey),
  'A fetch error cannot impersonate a validated internal error to expose its raw message');
});

test('content-length and streamed response limits both reject over 32 KiB and cancel the body', async () => {
  await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async () => new Response('{}', { headers: { 'content-length': '32769' } }) })),
    { code: 'DEEPSEEK_BALANCE_TOO_LARGE' });
  let cancelled = false;
  await assert.rejects(fetchDeepSeekBalance(options({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16000)); controller.enqueue(new Uint8Array(17000)); },
    cancel() { cancelled = true; },
  })) })), { code: 'DEEPSEEK_BALANCE_TOO_LARGE' });
  assert.equal(cancelled, true);
});

test('timeouts bound both a fetch and a response reader that ignore the abort signal', async () => {
  let fetchSignal;
  await assert.rejects(fetchDeepSeekBalance(options({ timeoutMs: 10, fetchImpl: async (_url, request) => {
    fetchSignal = request.signal; return new Promise(() => {});
  } })), { code: 'DEEPSEEK_BALANCE_TIMEOUT' });
  assert.equal(fetchSignal.aborted, true);
  let bodyCancelled = false;
  await assert.rejects(fetchDeepSeekBalance(options({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
    start() {}, cancel() { bodyCancelled = true; },
  })) })),
    { code: 'DEEPSEEK_BALANCE_TIMEOUT' });
  assert.equal(bodyCancelled, true);
});

test('pre-cancellation sends nothing and in-flight cancellation rejects with a sanitized AbortError', async () => {
  const before = new AbortController(); before.abort(new Error(apiKey));
  let calls = 0;
  await assert.rejects(fetchDeepSeekBalance(options({ signal: before.signal, fetchImpl: async () => { calls++; } })),
    error => error.name === 'AbortError' && !error.message.includes(apiKey));
  assert.equal(calls, 0);
  const controller = new AbortController();
  let requestSignal;
  const running = fetchDeepSeekBalance(options({ signal: controller.signal, fetchImpl: async (_url, request) => {
    requestSignal = request.signal; return new Promise(() => {});
  } }));
  controller.abort(new Error(apiKey));
  await assert.rejects(running, error => error.name === 'AbortError' && !error.message.includes(apiKey));
  assert.equal(requestSignal.aborted, true);
});
