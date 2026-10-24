import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGeminiRpcError as classify } from '../src/core/gemini-auth-errors.mjs';

test('existing Google authentication classifications survive extraction from flattened CLI messages', () => {
  for (const [message, expected] of [
    ['invalid_grant', 'GEMINI_SIGN_IN_REQUIRED'], ['invalid_token', 'GEMINI_SIGN_IN_REQUIRED'],
    ['credentials have expired', 'GEMINI_SIGN_IN_REQUIRED'],
    ['This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var.', 'GEMINI_PROJECT_REQUIRED'],
    ['Account validation required: private account details', 'GEMINI_ACCOUNT_VALIDATION_REQUIRED'],
    ['account validation required: private account details', 'GEMINI_ACCOUNT_VALIDATION_REQUIRED'],
    ['LoadCodeAssist returned empty response', 'GEMINI_SERVICE_UNAVAILABLE'],
    ['Please accept the terms of service', 'GEMINI_ACCOUNT_ACTION_REQUIRED'],
    ['quota exhausted', 'GEMINI_QUOTA_EXCEEDED'], ['rate limit exceeded', 'GEMINI_QUOTA_EXCEEDED'],
    ['fetch failed', 'GEMINI_NETWORK_ERROR'], ['certificate could not be verified', 'GEMINI_NETWORK_ERROR'],
    ['proxy error', 'GEMINI_NETWORK_ERROR'],
    ['enotfound', 'GEMINI_NETWORK_ERROR'], ['econnreset', 'GEMINI_NETWORK_ERROR'],
  ]) assert.equal(classify('authenticate', { code: -32000, message }).code, expected, message);
});

test('JSON-RPC internal error reads bounded nested details instead of categorizing the wrapper', () => {
  const error = { code: -32603, message: 'Internal error', data: { details: {
    error: { code: 503, status: 'UNAVAILABLE', message: 'upstream unavailable PRIVATE_ACCOUNT' },
  } } };
  assert.deepEqual(classify('authenticate', error), { code: 'GEMINI_SERVICE_UNAVAILABLE', diagnostic: { httpStatus: 503, serverStatus: 'UNAVAILABLE' } });
  error.data.details = { error: { code: 403, status: 'PERMISSION_DENIED' } };
  assert.deepEqual(classify('authenticate', error), { code: 'GEMINI_ACCESS_DENIED', diagnostic: { httpStatus: 403, serverStatus: 'PERMISSION_DENIED' } });
});

test('Google unsupported-client business errors are distinct from OAuth, network and location failures', () => {
  const message = 'This client is no longer supported for Gemini Code PRIVATE for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google/PRIVATE';
  for (const error of [{ message }, { data: { details: { unsupportedClient: { message } } } },
    { message: 'Internal error', data: JSON.stringify({ details: JSON.stringify({ unsupportedClient: message }) }) },
    { data: { unsupportedClient: true } }, { data: { unsupportedClient: { reason: 'CLIENT_RETIRED' } } },
    { code: 403, message: message + ' network error in unsupported location' }]) {
    const result = classify('authenticate', error);
    assert.equal(result.code, 'GEMINI_CLIENT_UNSUPPORTED');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|https:|Antigravity|individuals/iu);
  }
  assert.deepEqual(classify('authenticate', { data: { unsupportedClient: false } }), { code: 'GEMINI_AUTH_FAILED' });
});

test('nested JSON strings and arrays preserve actionable auth failures without returning their content', () => {
  const details = JSON.stringify([{ error: { message: 'restricted region PRIVATE_IDENTITY', code: 403, status: 'PERMISSION_DENIED' } }]);
  const error = { code: -32603, message: 'Internal error', data: JSON.stringify({ details }) };
  assert.deepEqual(classify('authenticate', error), { code: 'GEMINI_REGION_UNAVAILABLE', diagnostic: { httpStatus: 403, serverStatus: 'PERMISSION_DENIED' } });
  assert.deepEqual(classify('authenticate', { message: JSON.stringify(JSON.stringify({ error: 'invalid_grant' })) }), { code: 'GEMINI_SIGN_IN_REQUIRED' });
  assert.equal(classify('session/new', { data: { details: [null, { error: { reason: 'VALIDATION_REQUIRED' } }] } }).code, 'GEMINI_ACCOUNT_VALIDATION_REQUIRED');
});

test('unreachable hosts, DNS retries and Undici connection errors are network failures', () => {
  for (const errno of ['ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']) {
    assert.deepEqual(classify('authenticate', { code: -32603, message: 'Internal error', data: { details: { cause: { code: errno } } } }),
      { code: 'GEMINI_NETWORK_ERROR', diagnostic: { errno } });
  }
  assert.deepEqual(classify('authenticate', { message: 'UND_ERR_FUTURE_PRIVATE_CODE' }), { code: 'GEMINI_NETWORK_ERROR' });
});

test('explicit HTTP responses distinguish auth, access, quota, proxy and service failures', () => {
  for (const [status, code] of [[401, 'GEMINI_SIGN_IN_REQUIRED'], [403, 'GEMINI_ACCESS_DENIED'],
    [407, 'GEMINI_PROXY_FAILED'], [408, 'GEMINI_TIMEOUT'], [429, 'GEMINI_QUOTA_EXCEEDED'],
    [500, 'GEMINI_SERVICE_UNAVAILABLE'], [502, 'GEMINI_SERVICE_UNAVAILABLE'], [503, 'GEMINI_SERVICE_UNAVAILABLE'],
    [504, 'GEMINI_SERVICE_UNAVAILABLE'], [524, 'GEMINI_SERVICE_UNAVAILABLE']]) {
    for (const error of [{ data: { statusCode: status } }, { message: `Request failed with status code ${status}` },
      { message: `HTTP/1.1 ${status}` }, { message: JSON.stringify({ error: { code: status } }) }]) {
      assert.deepEqual(classify('authenticate', error), { code, diagnostic: { httpStatus: status } });
    }
  }
  assert.deepEqual(classify('authenticate', { message: 'HTTP status 555' }), { code: 'GEMINI_SERVICE_UNAVAILABLE' });
});

test('HTTP 403 never implies a regional restriction without an explicit location statement', () => {
  for (const message of ['Forbidden', 'Permission denied', 'Account is not eligible', 'Access denied from Google service']) {
    assert.equal(classify('authenticate', { error: { status: 'PERMISSION_DENIED', code: 403, message } }).code, 'GEMINI_ACCESS_DENIED');
  }
  for (const message of ['unsupported location', 'restricted region', 'User location is not supported for this service']) {
    assert.equal(classify('authenticate', { code: 403, message }).code, 'GEMINI_REGION_UNAVAILABLE');
  }
  assert.equal(classify('authenticate', { code: 403, message: 'Account validation required: finish verification' }).code, 'GEMINI_ACCOUNT_VALIDATION_REQUIRED');
  assert.equal(classify('authenticate', { code: 403, message: 'Google Cloud project required' }).code, 'GEMINI_PROJECT_REQUIRED');
});

test('server enum diagnostics remain whitelisted and request-specific fallback is retained', () => {
  assert.deepEqual(classify('authenticate', { data: { error: { status: 'UNAUTHENTICATED' } } }), { code: 'GEMINI_SIGN_IN_REQUIRED', diagnostic: { serverStatus: 'UNAUTHENTICATED' } });
  assert.deepEqual(classify('authenticate', { data: { error: { status: 'RESOURCE_EXHAUSTED' } } }), { code: 'GEMINI_QUOTA_EXCEEDED', diagnostic: { serverStatus: 'RESOURCE_EXHAUSTED' } });
  for (const [method, expected] of [['authenticate', 'GEMINI_AUTH_FAILED'], ['session/new', 'GEMINI_SESSION_FAILED'], ['session/prompt', 'GEMINI_CLI_REQUEST_FAILED']]) {
    assert.deepEqual(classify(method, { code: -32603, message: 'Internal error', data: { private: 'PRIVATE_TOKEN' } }), { code: expected });
  }
  assert.deepEqual(classify('authenticate', { status: 'PRIVATE_ACCOUNT_STATUS', errno: 'PRIVATE_TOKEN' }), { code: 'GEMINI_AUTH_FAILED' });
});

test('diagnostics cannot disclose URLs, credentials, identities, paths or arbitrary properties', () => {
  const secret = 'PRIVATE_IDENTITY_PRIVATE_TOKEN';
  const error = { code: -32603, message: 'Internal error', data: { details: { error: {
    message: `request failed with status code 403 https://accounts.google.com/${secret}?code=${secret}`,
    reason: secret, contact: secret, identity: secret, credentials: secret, path: `C:\\Users\\${secret}`,
  } }, token: secret }, ignored: { code: 401 } };
  const result = classify('authenticate', error);
  assert.deepEqual(result, { code: 'GEMINI_ACCESS_DENIED', diagnostic: { httpStatus: 403 } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|https:|accounts|Users|message|details|identity|token/iu);
  assert.deepEqual(classify('authenticate', { credentials: { error: 'invalid_grant' }, account: { status: 401 } }), { code: 'GEMINI_AUTH_FAILED' });
});

test('untrusted accessors, cycles, oversized strings and deeply nested arrays remain bounded', () => {
  let accessed = 0;
  const error = { message: 'Internal error' };
  Object.defineProperty(error, 'data', { get() { accessed++; throw new Error('do not execute getters'); } });
  assert.deepEqual(classify('authenticate', error), { code: 'GEMINI_AUTH_FAILED' }); assert.equal(accessed, 0);
  const cycle = { message: 'Internal error' }; cycle.data = cycle;
  assert.deepEqual(classify('authenticate', cycle), { code: 'GEMINI_AUTH_FAILED' });
  assert.deepEqual(classify('authenticate', { message: 'x'.repeat(100_000) + ' invalid_grant' }), { code: 'GEMINI_AUTH_FAILED' });
  let deep = { message: 'invalid_grant' }; for (let index = 0; index < 50; index++) deep = { data: deep };
  assert.deepEqual(classify('authenticate', deep), { code: 'GEMINI_AUTH_FAILED' });
  const array = Array(100_000); array[99_999] = { message: 'invalid_grant' };
  assert.deepEqual(classify('authenticate', { details: array }), { code: 'GEMINI_AUTH_FAILED' });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } });
  assert.deepEqual(classify('authenticate', proxy), { code: 'GEMINI_AUTH_FAILED' });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.deepEqual(classify('authenticate', revoked.proxy), { code: 'GEMINI_AUTH_FAILED' });
});

test('ordinary Error instances are inspected without requiring enumerable message fields', () => {
  const error = Object.assign(new Error('fetch failed PRIVATE_OAUTH_URL'), { cause: Object.assign(new Error('connect'), { code: 'EHOSTUNREACH' }) });
  assert.deepEqual(classify('authenticate', error), { code: 'GEMINI_NETWORK_ERROR', diagnostic: { errno: 'EHOSTUNREACH' } });
});
