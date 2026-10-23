import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';

const { createUpdateFetch } = createRequire(import.meta.url)('../src/core/update-transport.cjs');
class Incoming extends EventEmitter {
  constructor(statusCode = 200, headers = {}) { super(); this.statusCode = statusCode; this.headers = headers; this.registered = []; }
  on(name, callback) { this.registered.push(name); return super.on(name, callback); }
}
class Request extends EventEmitter {
  constructor() { super(); this.aborts = 0; this.ends = 0; this.follows = 0; }
  end() { this.ends++; }
  abort() { this.aborts++; this.emit('abort'); this.emit('close'); }
  followRedirect() { this.follows++; throw new Error('Transport must never follow redirects'); }
}
function fixture(options = {}) {
  const requests = [], session = { isolated: true };
  const fetch = createUpdateFetch({ net: { request(config) { const request = new Request(); requests.push({ request, config }); return request; } }, session, ...options });
  return { requests, fetch, session };
}

test('200 responses stream before EOF using a cookie-free session without requiring pause or resume', async () => {
  const f = fixture(), pending = f.fetch('https://example.invalid/body', { redirect: 'manual', headers: {
    Accept: 'application/octet-stream', Authorization: 'secret', Cookie: 'private', 'Proxy-Authorization': 'secret',
  } });
  const { request, config } = f.requests[0];
  assert.equal(config.method, 'GET'); assert.equal(config.redirect, 'manual'); assert.equal(config.credentials, 'omit');
  assert.equal(config.useSessionCookies, false); assert.equal(config.session, f.session); assert.equal(config.bypassCustomProtocolHandlers, true);
  assert.deepEqual(config.headers, { accept: 'application/octet-stream' }); assert.equal(request.ends, 1);
  const incoming = new Incoming(200, { 'content-length': '6', 'content-type': 'application/octet-stream' });
  request.emit('response', incoming); const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), '6');
  assert.ok(incoming.registered.indexOf('end') < incoming.registered.indexOf('data'));
  const reader = response.body.getReader(), first = reader.read(); incoming.emit('data', Buffer.from('one'));
  assert.equal(Buffer.from((await first).value).toString(), 'one', 'The body is readable while the native response remains open');
  const second = reader.read(); incoming.emit('data', Buffer.from('two')); incoming.emit('end');
  assert.equal(Buffer.from((await second).value).toString(), 'two'); assert.equal((await reader.read()).done, true);
  assert.equal(request.aborts, 0); assert.equal(incoming.listenerCount('data'), 0); assert.equal(request.listenerCount('redirect'), 0);
});

test('a redirect is returned with its original Location, aborts synchronously and never follows or requests the target', async () => {
  for (const location of ['https://release-assets.githubusercontent.com/github-production-release-asset/123/a?sig=fixture', 'https://untrusted.invalid/payload', '/relative']) {
    const f = fixture(), pending = f.fetch('https://github.com/owner/repo/releases/download/v1/file.exe');
    const { request } = f.requests[0];
    request.emit('redirect', 302, 'GET', new URL(location, 'https://github.com').href, { location: [location], 'x-fixture': ['value'] });
    assert.equal(request.aborts, 1, 'Abort occurs inside the redirect callback');
    const response = await pending;
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), location); assert.equal(response.headers.get('x-fixture'), 'value');
    assert.equal(response.redirected, false); assert.equal(response.url, ''); assert.equal(response.body, null);
    assert.equal(request.follows, 0); assert.equal(f.requests.length, 1, 'Only AppUpdater may decide whether to issue the next request');
    request.emit('error', new Error('Redirect was cancelled')); request.emit('close');
  }
});

test('HEAD returns original status and exact headers without waiting for a body, including after manual redirect', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = f.fetch('https://github.com/owner/repo/releases/download/v1/file.exe', { method: 'head', signal: controller.signal,
    redirect: 'manual', headers: { Cookie: 'private', Authorization: 'private' } });
  const first = f.requests[0];
  assert.equal(first.config.method, 'HEAD'); assert.equal(first.config.credentials, 'omit'); assert.equal(first.config.useSessionCookies, false);
  assert.equal(first.config.session, f.session); assert.deepEqual(first.config.headers, {});
  const target = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/a?sig=fixture';
  first.request.emit('redirect', 302, 'HEAD', target, { location: [target] });
  const redirect = await pending;
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), target); assert.equal(redirect.body, null);
  assert.equal(first.request.aborts, 1); assert.equal(first.request.follows, 0); assert.equal(f.requests.length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

  const responsePending = f.fetch(target, { method: 'HEAD', signal: controller.signal });
  const second = f.requests[1], incoming = new Incoming(200, { 'content-length': '123597488', 'content-type': 'application/octet-stream' });
  second.request.emit('close'); second.request.emit('response', incoming);
  assert.equal(second.request.aborts, 1, 'HEAD aborts immediately after headers, without waiting for data/end');
  const response = await responsePending;
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), '123597488');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.equal(response.body, null);
  assert.equal(await response.text(), ''); assert.equal(incoming.listenerCount('data'), 0); assert.equal(incoming.listenerCount('end'), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  incoming.emit('data', Buffer.from('must not consume body')); incoming.emit('error', new Error('late aborted HEAD'));
  second.request.emit('error', new Error('late request error'));
});

test('raw native error messages and codes survive before headers and during body streaming', async () => {
  const early = fixture(), failed = early.fetch('https://example.invalid/');
  const networkError = Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { code: 'ERR_PROXY_CONNECTION_FAILED' });
  early.requests[0].request.emit('error', networkError);
  await assert.rejects(failed, error => error === networkError);

  const late = fixture(), pending = late.fetch('https://example.invalid/');
  const incoming = new Incoming(); late.requests[0].request.emit('response', incoming);
  const response = await pending, reading = response.body.getReader().read();
  const streamError = Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ERR_CONNECTION_RESET' });
  incoming.emit('error', streamError);
  await assert.rejects(reading, error => error === streamError);
  assert.equal(late.requests[0].request.aborts, 1); assert.equal(incoming.listenerCount('data'), 0);
  incoming.emit('error', new Error('late error')); late.requests[0].request.emit('error', new Error('late request error'));
});

test('signal cancellation rejects pending headers or readers and reader cancellation aborts the native request', async () => {
  const reason = new Error('caller cancelled'), controller = new AbortController(), early = fixture();
  const pending = early.fetch('https://example.invalid/', { signal: controller.signal }); controller.abort(reason);
  await assert.rejects(pending, error => error === reason); assert.equal(early.requests[0].request.aborts, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(early.fetch('https://example.invalid/', { signal: controller.signal }), error => error === reason);
  assert.equal(early.requests.length, 1);

  for (const action of ['signal', 'reader']) {
    const f = fixture(), abort = new AbortController(), pending = f.fetch('https://example.invalid/', { signal: abort.signal });
    const incoming = new Incoming(); f.requests[0].request.emit('response', incoming);
    const response = await pending, reader = response.body.getReader();
    if (action === 'signal') { const reading = reader.read(); abort.abort(reason); await assert.rejects(reading, error => error === reason); }
    else await reader.cancel();
    assert.equal(f.requests[0].request.aborts, 1); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    assert.equal(incoming.listenerCount('data'), 0);
    incoming.emit('data', Buffer.from('late data')); incoming.emit('error', new Error('late error'));
  }
});

test('a native response without pause or resume has a bounded unread queue', async () => {
  const f = fixture({ maxBufferedBytes: 8 }), pending = f.fetch('https://example.invalid/');
  const incoming = new Incoming(); f.requests[0].request.emit('response', incoming); const response = await pending;
  incoming.emit('data', Buffer.from('12345678')); incoming.emit('data', Buffer.from('9'));
  await assert.rejects(response.arrayBuffer(), { code: 'UPDATE_BUFFER_LIMIT' });
  assert.equal(f.requests[0].request.aborts, 1); assert.equal(incoming.listenerCount('data'), 0);
});

test('the request writable side may close before headers while an aborted incoming response still fails', async () => {
  const f = fixture(), pending = f.fetch('https://example.invalid/'), incoming = new Incoming();
  f.requests[0].request.emit('close');
  f.requests[0].request.emit('response', incoming); const response = await pending, reading = response.body.getReader().read();
  incoming.emit('aborted');
  await assert.rejects(reading, { code: 'ERR_ABORTED' });
});

test('transport rejects non-GET/HEAD, request bodies, credentialed and automatic-follow requests before opening a connection', async () => {
  const f = fixture();
  for (const [address, init] of [['file:///C:/payload', {}], ['https://user:pass@example.invalid/', {}],
    ['https://example.invalid/', { method: 'POST' }], ['https://example.invalid/', { body: 'payload' }],
    ['https://example.invalid/', { method: 'HEAD', body: 'payload' }],
    ['https://example.invalid/', { redirect: 'follow' }]]) await assert.rejects(f.fetch(address, init));
  assert.equal(f.requests.length, 0);
});
