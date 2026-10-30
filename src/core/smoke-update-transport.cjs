const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { createUpdateFetch } = require('./update-transport.cjs');
const { AppUpdater } = require('./app-updater.cjs');

// Real Electron transport over a loopback-only proxy. No external connection,
// production session, real installer, updater launch or account is involved.
module.exports = async function smokeUpdateTransport({ output, dataDir, net, electronSession }) {
  const session = electronSession.fromPartition('update-transport-smoke-' + randomUUID(), { cache: false });
  const root = await fs.mkdtemp(path.join(dataDir, 'update-transport-'));
  const body = Buffer.alloc(256 * 1024, 65); body.write('MZ_SYNORA_TRANSPORT_FIXTURE_NOT_EXECUTABLE');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const api = 'https://api.github.com/repos/xinghan1/Cortex/releases/latest';
  const name = 'Cortex-Setup-1.0.1-x64.exe';
  const asset = `https://github.com/xinghan1/Cortex/releases/download/v1.0.1/${name}`;
  const webLatest = 'https://github.com/xinghan1/Cortex/releases/latest';
  const stableTag = 'https://github.com/xinghan1/Cortex/releases/tag/v1.0.1';
  const checksumAsset = asset + '.sha256';
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?sig=not-a-credential';
  const checksumCdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/checksum?sig=fixture';
  const forbidden = 'https://forbidden-update.invalid/payload.exe';
  const origin = 'http://update-fixture.invalid';
  const proxyRequests = [], requests = [], clients = [], delayed = new Set(), fallbackCases = new Map();
  let stalledClosed = 0;
  const metadata = { tag_name: 'v1.0.1', draft: false, prerelease: false,
    assets: [{ name, state: 'uploaded', size: body.length, digest: 'sha256:' + sha256, browser_download_url: asset }] };
  const server = http.createServer((request, response) => {
    proxyRequests.push({ url: request.url, method: request.method, cookie: request.headers.cookie, authorization: request.headers.authorization });
    const route = new URL(request.url, origin).pathname;
    if (route.startsWith('/fallback/')) {
      const [, , scenario, resource] = route.split('/'), fixture = fallbackCases.get(scenario);
      if (!fixture) { response.writeHead(500); response.end('Unknown fallback fixture'); return; }
      if (resource === 'api') {
        const limited = scenario !== 'plain-forbidden';
        response.writeHead(fixture.apiStatus, { 'content-type': 'application/json', ...(limited ? {
          'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((fixture.now + 120000) / 1000)),
        } : {}) }); response.end(JSON.stringify({ message: limited ? 'API rate limit exceeded' : 'Forbidden' }));
      } else if (resource === 'latest') {
        if (scenario === 'web-unavailable') { response.writeHead(503); response.end('Unavailable'); return; }
        const locations = { 'wrong-repository': 'https://github.com/another-owner/Synora-code/releases/tag/v1.0.1',
          'prerelease-tag': stableTag + '-rc.1', 'insecure-redirect': stableTag.replace('https:', 'http:') };
        response.writeHead(302, { location: locations[scenario] || stableTag }); response.end();
      } else if (resource === 'checksum') {
        response.writeHead(302, { location: checksumCdn }); response.end();
      } else if (resource === 'checksum-cdn') {
        const checksum = sha256 + '  ' + name + '\n';
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(checksum) }); response.end(checksum);
      } else if (resource === 'installer') {
        response.writeHead(302, { location: cdn }); response.end();
      } else if (resource === 'installer-cdn') {
        response.writeHead(200, { 'content-type': 'application/octet-stream', ...(scenario === 'missing-head-length' && request.method === 'HEAD'
          ? {} : { 'content-length': String(body.length) }) });
        response.end(request.method === 'HEAD' ? undefined : body);
      } else { response.writeHead(500); response.end('Unexpected fallback resource'); }
    } else if (route === '/metadata') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(metadata)); }
    else if (route === '/allowed-redirect' || route === '/blocked-redirect') {
      response.writeHead(302, { location: route === '/allowed-redirect' ? cdn : forbidden }); response.end();
    } else if (route === '/binary') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
      response.write(body.subarray(0, 65536));
      const timer = setTimeout(() => { delayed.delete(timer); response.end(body.subarray(65536)); }, 15); delayed.add(timer);
    } else if (route === '/stall' || route === '/reset') {
      response.on('close', () => { stalledClosed++; }); response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.flushHeaders(); response.write(Buffer.alloc(65536, 65));
      if (route === '/reset') {
        const timer = setTimeout(() => { delayed.delete(timer); response.socket?.destroy(); }, 25); delayed.add(timer);
      }
    } else { response.writeHead(500); response.end('Unexpected fixture request'); }
  });
  const waitFor = async (label, predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error('Transport smoke timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await session.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${server.address().port}`, proxyBypassRules: '<-loopback>' });
    assert.match(await session.resolveProxy(origin + '/metadata'), /^PROXY 127\.0\.0\.1:/u);
    await session.cookies.set({ url: origin, name: 'isolated-private-cookie', value: 'must-not-send' });
    const fetch = createUpdateFetch({ net, session });
    const makeUpdater = mode => {
      const client = new AppUpdater({ currentVersion: '1.0.0', dataDir: path.join(root, mode), enabled: true,
        fetchImpl: (address, options) => {
          requests.push(address);
          const route = address === api ? '/metadata' : address === asset ? `/${mode}-redirect` : address === cdn ? '/binary' : null;
          assert.ok(route, 'AppUpdater requested an unexpected redirect target');
          return fetch(origin + route, options);
        } });
      clients.push(client); return client;
    };
    const updater = makeUpdater('allowed');
    assert.equal((await updater.check()).status, 'available');
    assert.equal((await updater.download()).status, 'downloaded');
    assert.deepEqual(await fs.readFile(await updater.verifiedInstaller()), body);
    assert.deepEqual(requests, [api, asset, cdn]);

    const before = requests.length, blocked = makeUpdater('blocked'); await blocked.check();
    await assert.rejects(blocked.download(), /非官方地址/u);
    assert.deepEqual(requests.slice(before), [api, asset]);
    assert.equal(proxyRequests.some(request => request.url.startsWith(forbidden)), false);
    assert.equal(proxyRequests.some(request => request.url.startsWith(cdn)), false, 'The adapter must not follow the native redirect automatically');

    const makeFallback = (scenario, apiStatus = 429) => {
      const fixture = { now: 1800000000000, apiStatus, requests: [] }; fallbackCases.set(scenario, fixture);
      const mappings = new Map([[api, 'api'], [webLatest, 'latest'], [checksumAsset, 'checksum'],
        [checksumCdn, 'checksum-cdn'], [asset, 'installer'], [cdn, 'installer-cdn']]);
      fixture.client = new AppUpdater({ currentVersion: '1.0.0', dataDir: path.join(root, scenario), enabled: true,
        now: () => fixture.now, fetchImpl: (address, options) => {
          const resource = mappings.get(address); assert.ok(resource, 'Fallback followed an untrusted or unexpected URL: ' + address);
          fixture.requests.push({ url: address, method: options.method || 'GET' });
          return fetch(origin + '/fallback/' + scenario + '/' + resource, options);
        } });
      clients.push(fixture.client); return fixture;
    };
    const expectedWeb = [{ url: webLatest, method: 'GET' }, { url: checksumAsset, method: 'GET' },
      { url: checksumCdn, method: 'GET' }, { url: asset, method: 'HEAD' }, { url: cdn, method: 'HEAD' }];
    const limited = makeFallback('limited-429');
    assert.equal((await limited.client.check()).status, 'available');
    assert.deepEqual(limited.requests, [{ url: api, method: 'GET' }, ...expectedWeb]);
    const checkedCount = limited.requests.length;
    await limited.client.check(); assert.equal(limited.requests.length, checkedCount, 'Successful checks must use the short cache');
    limited.now += 61000;
    assert.equal((await limited.client.check()).status, 'available');
    assert.deepEqual(limited.requests.slice(checkedCount), expectedWeb, 'API cooldown must recheck the website without repeating API requests');
    limited.now += 61000;
    assert.equal((await limited.client.check()).status, 'available');
    assert.deepEqual(limited.requests.slice(checkedCount + expectedWeb.length), [{ url: api, method: 'GET' }, ...expectedWeb], 'API must become eligible after its cooldown');
    const beforeDownload = limited.requests.length;
    assert.equal((await limited.client.download()).status, 'downloaded');
    assert.deepEqual(limited.requests.slice(beforeDownload), [{ url: asset, method: 'GET' }, { url: cdn, method: 'GET' }]);
    assert.deepEqual(await fs.readFile(await limited.client.verifiedInstaller()), body);
    const readyCount = limited.requests.length;
    assert.equal((await limited.client.check()).status, 'downloaded'); assert.equal(limited.requests.length, readyCount);

    const forbiddenLimited = makeFallback('limited-403', 403);
    assert.equal((await forbiddenLimited.client.check()).status, 'available');
    assert.deepEqual(forbiddenLimited.requests, [{ url: api, method: 'GET' }, ...expectedWeb]);
    const plainForbidden = makeFallback('plain-forbidden', 403);
    await assert.rejects(plainForbidden.client.check());
    assert.deepEqual(plainForbidden.requests, [{ url: api, method: 'GET' }], 'Unrelated HTTP 403 must not trigger the rate-limit fallback');
    for (const scenario of ['wrong-repository', 'prerelease-tag', 'insecure-redirect']) {
      const unsafe = makeFallback(scenario); await assert.rejects(unsafe.client.check());
      assert.deepEqual(unsafe.requests, [{ url: api, method: 'GET' }, { url: webLatest, method: 'GET' }], 'Unsafe web release must be rejected before requesting another target');
      assert.equal(unsafe.client.snapshot().status, 'error'); assert.equal(unsafe.client.snapshot().version, null);
    }
    const noLength = makeFallback('missing-head-length');
    await assert.rejects(noLength.client.check(), /大小|长度|发布|文件/u);
    assert.deepEqual(noLength.requests, [{ url: api, method: 'GET' }, ...expectedWeb]);
    assert.equal(noLength.client.snapshot().status, 'error'); assert.equal(noLength.client.snapshot().version, null);
    const webFailed = makeFallback('web-unavailable');
    await assert.rejects(webFailed.client.check());
    const fallbackError = webFailed.client.snapshot().error;
    assert.ok(typeof fallbackError === 'string' && fallbackError.length > 0, 'Fallback failure must expose a useful error');
    assert.doesNotMatch(fallbackError, /sig=|update-fixture|undefined|TypeError/iu);
    const failedCount = webFailed.requests.length;
    await assert.rejects(webFailed.client.check());
    assert.equal(webFailed.requests.length, failedCount, 'Failed fallback must have a brief request cooldown');

    const controller = new AbortController(), cancelled = new Error('isolated transport cancelled');
    const response = await fetch(origin + '/stall', { signal: controller.signal }), reader = response.body.getReader();
    assert.ok((await reader.read()).value.byteLength > 0);
    const reading = reader.read(); controller.abort(cancelled);
    await assert.rejects(reading, error => error === cancelled);
    await waitFor('signal closes native request', () => stalledClosed >= 1);
    const cancelledByReader = await fetch(origin + '/stall'); await cancelledByReader.body.cancel();
    await waitFor('reader cancellation closes native request', () => stalledClosed >= 2);

    const reset = await fetch(origin + '/reset');
    await assert.rejects(reset.arrayBuffer(), error => /ERR_|reset|closed|aborted/iu.test(error.message));
    assert.ok(proxyRequests.length >= 8);
    assert.ok(proxyRequests.every(request => !request.cookie && !request.authorization), 'The isolated session cookie never accompanies update traffic');
    const result = { status: 'completed', realElectronTransport: true, proxyRouting: true, manualRedirect: true,
      allowedCdnDownload: true, forbiddenTargetNotRequested: true, streaming: true, signalAbort: true, readerCancel: true,
      rateLimitedApiWebFallback: true, http403RequiresRateLimitEvidence: true, officialStableTagOnly: true,
      checksumAndHeadThroughCdn: true, headMethodPreserved: true, fallbackDownloadVerified: true,
      successfulCheckCache: true, rateLimitCooldown: true, apiRetryAfterCooldown: true, downloadedStatePreserved: true,
      missingHeadLengthRejected: true, failedFallbackCooldown: true,
      fallbackCases: [...fallbackCases].map(([scenario, fixture]) => ({ scenario, requestCount: fixture.requests.length })),
      prematureStreamClose: true, noSessionCookies: true, installerExecuted: false, externalConnections: 0 };
    await fs.writeFile(path.join(output, 'update-transport-result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    for (const timer of delayed) clearTimeout(timer);
    await Promise.allSettled(clients.map(client => client.dispose()));
    await session.closeAllConnections();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(dataDir));
    assert.ok(path.basename(root).startsWith('update-transport-'));
    await fs.rm(root, { recursive: true, force: true });
  }
};
