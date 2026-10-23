import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { AppUpdater } = createRequire(import.meta.url)('../src/core/app-updater.cjs');
const testRoot = path.resolve('tests', '.tmp');
const api = 'https://api.github.com/repos/xinghan1/Synora-code/releases/latest';
const web = 'https://github.com/xinghan1/Synora-code/releases/latest';
const tagURL = 'https://github.com/xinghan1/Synora-code/releases/tag/';
const nextVersion = '0.18.4', name = `Synora-code-Setup-${nextVersion}-x64.exe`;
const url = `https://github.com/xinghan1/Synora-code/releases/download/v${nextVersion}/${name}`;
const bytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(8190, 65)]);
const hash = data => createHash('sha256').update(data).digest('hex');
const release = () => ({ tag_name: `v${nextVersion}`, draft: false, prerelease: false, assets: [
  { name, state: 'uploaded', size: bytes.length, digest: `sha256:${hash(bytes)}`, browser_download_url: url },
] });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const binary = (data = bytes, size = data.length) => new Response(data, { headers: { 'content-length': String(size) } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, overrides = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'app-updater-'));
  const calls = [], states = [], client = { metadata: release(), data: bytes };
  client.fetch = async (address, options) => {
    calls.push({ address, options });
    if (address === api) return json(client.metadata);
    if (address === url) return binary(client.data);
    throw new Error('Unexpected network call');
  };
  const updater = new AppUpdater({ currentVersion: '0.18.3', dataDir: dir, enabled: true,
    fetchImpl: (...args) => client.fetch(...args), onChange: state => states.push(state), checkCacheMs: 0, ...overrides });
  t.after(async () => {
    await updater.dispose();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(target).startsWith('app-updater-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { updater, dir, calls, states, client };
}

function fallbackClient(f, override = () => null) {
  const requests = [];
  f.client.fetch = async (address, options) => {
    requests.push({ address, method: options.method });
    const custom = await override(address, options);
    if (custom) return custom;
    if (address === api) return new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    if (address === web) return new Response(null, { status: 302, headers: { location: `${tagURL}v${nextVersion}` } });
    if (address === `${url}.sha256`) return new Response(`${hash(bytes)}  ${name}\n`);
    if (address === url) return options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': String(bytes.length) } }) : binary();
    assert.fail('Unexpected fallback request: ' + address);
  };
  return requests;
}

test('checking and downloading only expose public state and never execute the verified installer', async t => {
  const { updater, dir, calls, states } = await fixture(t);
  assert.deepEqual(updater.snapshot(), { version: null, status: 'idle', progress: 0, error: null });
  assert.equal((await updater.check()).status, 'available');
  assert.equal((await updater.download()).status, 'downloaded');
  const installer = await updater.verifiedInstaller();
  assert.equal(installer, path.join(await fs.realpath(dir), 'updates', name));
  assert.deepEqual(await fs.readFile(installer), bytes);
  assert.deepEqual(calls.map(call => call.address), [api, url]);
  assert.ok(states.some(state => state.status === 'downloading' && state.progress > 0 && state.progress < 100));
  for (const state of states) assert.deepEqual(Object.keys(state).sort(), ['error', 'progress', 'status', 'version']);
  assert.equal(JSON.stringify(states).includes(dir), false);
  assert.equal(JSON.stringify(states).includes('github.com'), false);
  for (const call of calls) {
    assert.equal(call.options.redirect, 'manual'); assert.equal(call.options.credentials, 'omit');
    assert.equal(Object.keys(call.options.headers).some(key => /authorization|cookie/iu.test(key)), false);
  }
  const external = updater.snapshot(); external.status = 'idle'; assert.equal(updater.snapshot().status, 'downloaded');
});

test('equal and older versions never offer an installer and stable numeric versions compare correctly', async t => {
  const { updater, client, calls } = await fixture(t);
  for (const tag of ['v0.18.3', '0.18.2', 'v0.9.99']) {
    client.metadata = { ...release(), tag_name: tag, assets: [] };
    assert.equal((await updater.check()).status, 'current'); assert.equal(updater.snapshot().version, null);
    await assert.rejects(updater.download(), /先检查/u);
  }
  assert.equal(calls.length, 3);
});

test('draft, prerelease, malformed versions and version-mismatched installers are rejected', async t => {
  const { updater, client } = await fixture(t);
  for (const metadata of [{ ...release(), draft: true }, { ...release(), prerelease: true },
    ...['v0.18.4-beta', 'v0.18.04', '0.18', '../v0.18.4', 'v99999999.1.0'].map(tag_name => ({ ...release(), tag_name })),
    { ...release(), assets: [{ ...release().assets[0], name: 'Synora-code-Setup-0.18.3-x64.exe' }] },
    { ...release(), assets: [release().assets[0], release().assets[0]] }]) {
    client.metadata = metadata; await assert.rejects(updater.check());
    assert.equal(updater.snapshot().status, 'error'); await assert.rejects(updater.download(), /先检查/u);
  }
});

test('asset locations must exactly match the fixed repository, release tag and expected filename', async t => {
  const { updater, client } = await fixture(t);
  for (const address of [url.replace('xinghan1', 'untrusted'), url.replace('Synora-code/releases', 'another/releases'),
    url.replace('v0.18.4', 'v0.18.5'), url.replace('https:', 'http:'), `${url}?download=1`,
    'https://github.com.evil.invalid/xinghan1/Synora-code/file.exe', 'file:///C:/installer.exe']) {
    client.metadata = release(); client.metadata.assets[0].browser_download_url = address;
    await assert.rejects(updater.check(), /官方仓库/u);
  }
});

test('valid GitHub CDN redirects work while unexpected redirects, auto-follow and nonrepository metadata redirects fail', async t => {
  const { updater, client } = await fixture(t);
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?token=fixture';
  client.fetch = async address => address === api ? json(release()) : address === url
    ? new Response(null, { status: 302, headers: { location: cdn } }) : address === cdn ? binary() : assert.fail(address);
  await updater.check(); await updater.download(); assert.equal(updater.snapshot().status, 'downloaded');
  for (const location of ['https://evil.invalid/file.exe', 'http://release-assets.githubusercontent.com/github-production-release-asset/123/a',
    'https://release-assets.githubusercontent.com.evil.invalid/github-production-release-asset/123/a',
    'https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/123/a',
    'https://github.com/other/repo/releases/download/v1/file.exe', 'https://objects.githubusercontent.com/unexpected/path']) {
    const other = await fixture(t); await other.updater.check();
    other.client.fetch = async () => new Response(null, { status: 302, headers: { location } });
    await assert.rejects(other.updater.download(), /非官方地址/u);
  }
  const metadata = await fixture(t);
  metadata.client.fetch = async () => new Response(null, { status: 302, headers: { location: cdn } });
  await assert.rejects(metadata.updater.check(), /非官方地址/u);
  const followed = await fixture(t); await followed.updater.check();
  followed.client.fetch = async () => { const response = binary(); Object.defineProperty(response, 'redirected', { value: true }); return response; };
  await assert.rejects(followed.updater.download(), /未经允许/u);
});

test('same-name SHA256 file is required and validated when the GitHub asset digest is absent', async t => {
  const { updater, client } = await fixture(t);
  const checksumName = `${name}.sha256`, checksumURL = `${url}.sha256`;
  const configure = (text, { digest } = {}) => {
    const metadata = release(); metadata.assets[0].digest = digest;
    metadata.assets.push({ name: checksumName, browser_download_url: checksumURL, state: 'uploaded', size: Buffer.byteLength(text) });
    client.fetch = async address => address === api ? json(metadata) : address === checksumURL ? new Response(text) : binary();
  };
  configure(`${hash(bytes)}  ${name}\n`);
  await updater.check(); await updater.download(); await updater.verifiedInstaller();
  const invalid = await fixture(t);
  for (const digest of [undefined, 'sha256:bad', `sha512:${hash(bytes)}`]) {
    invalid.client.metadata = release(); invalid.client.metadata.assets[0].digest = digest;
    await assert.rejects(invalid.updater.check(), /校验/u);
  }
  const mismatch = await fixture(t);
  const text = `${hash(bytes)}  different.exe\n`, metadata = release(); delete metadata.assets[0].digest;
  metadata.assets.push({ name: checksumName, state: 'uploaded', size: Buffer.byteLength(text), browser_download_url: checksumURL });
  mismatch.client.fetch = async address => address === api ? json(metadata) : new Response(text);
  await assert.rejects(mismatch.updater.check(), /不匹配/u);
});

test('asset and streamed size limits reject zero, oversized, truncated and mismatched downloads without part leftovers', async t => {
  const { updater, client, dir } = await fixture(t);
  for (const size of [0, 63, -1, 1.5, 512 * 1024 * 1024 + 1]) {
    client.metadata = release(); client.metadata.assets[0].size = size;
    await assert.rejects(updater.check(), /大小/u);
  }
  client.metadata = release(); await updater.check();
  for (const data of [bytes.subarray(0, 100), Buffer.concat([bytes, Buffer.alloc(1)])]) {
    client.fetch = async () => new Response(data);
    await assert.rejects(updater.download(), /大小|不完整/u);
    assert.deepEqual(await fs.readdir(path.join(dir, 'updates')), []);
  }
  client.fetch = async () => binary(bytes, bytes.length + 1);
  await assert.rejects(updater.download(), /大小/u);
});

test('hash mismatch and non-executable payloads never become ready and an explicit retry can succeed', async t => {
  const { updater, client, dir } = await fixture(t);
  await updater.check(); client.data = Buffer.from(bytes); client.data[100] = 42;
  await assert.rejects(updater.download(), /SHA-256/u);
  assert.equal(updater.snapshot().version, nextVersion); await assert.rejects(updater.verifiedInstaller(), /先下载/u);
  assert.deepEqual(await fs.readdir(path.join(dir, 'updates')), []);
  client.data = bytes; await updater.download(); assert.equal(updater.snapshot().status, 'downloaded');
  const wrong = await fixture(t); wrong.client.data = Buffer.alloc(100, 65);
  wrong.client.metadata.assets[0].size = 100; wrong.client.metadata.assets[0].digest = `sha256:${hash(wrong.client.data)}`;
  await wrong.updater.check(); await assert.rejects(wrong.updater.download(), /Windows 安装包/u);
});

test('concurrent checks and downloads deduplicate; periodic checks preserve a downloaded installer', async t => {
  const { updater, client, calls } = await fixture(t), gate = deferred();
  const original = client.fetch; client.fetch = async (...args) => { if (args[0] === api) await gate.promise; return original(...args); };
  const first = updater.check(), second = updater.check(); assert.equal(first, second);
  gate.resolve(); await first;
  const one = updater.download(), two = updater.download(); assert.equal(one, two);
  assert.equal(updater.check(), one); await Promise.all([one, two]);
  await updater.check(); await updater.download();
  assert.equal(calls.filter(call => call.address === api).length, 1); assert.equal(calls.filter(call => call.address === url).length, 1);
  assert.equal(updater.snapshot().status, 'downloaded');
});

test('a failed later check retains a previously discovered, verified release for a download retry', async t => {
  const { updater, client } = await fixture(t); await updater.check();
  client.fetch = async address => address === api ? new Response('access denied', { status: 403 }) : binary();
  await assert.rejects(updater.check(), /拒绝访问/u);
  assert.equal(updater.snapshot().version, nextVersion); await updater.download();
  assert.equal(updater.snapshot().status, 'downloaded');
});

test('cached files are rehashed on reuse and again before returning a trusted installation path', async t => {
  const { updater, dir, client, calls } = await fixture(t);
  await updater.check(); await fs.mkdir(path.join(dir, 'updates'));
  await fs.writeFile(path.join(dir, 'updates', name), bytes);
  await updater.download(); assert.equal(calls.length, 1, 'matching cache avoids network but only after verification');
  const file = await updater.verifiedInstaller();
  const changed = Buffer.from(bytes); changed[50] ^= 1; await fs.writeFile(file, changed);
  await assert.rejects(updater.verifiedInstaller(), /已损坏或变化/u);
  assert.equal(updater.snapshot().status, 'error'); await assert.rejects(updater.verifiedInstaller(), /先下载/u);
  client.data = bytes; await updater.download(); assert.deepEqual(await fs.readFile(await updater.verifiedInstaller()), bytes);
});

test('invalid cache directories and symlinked installer paths are rejected', async t => {
  const { updater, dir } = await fixture(t); await updater.check();
  await fs.writeFile(path.join(dir, 'updates'), 'not-a-directory');
  await assert.rejects(updater.download()); await assert.rejects(updater.verifiedInstaller());
  await fs.unlink(path.join(dir, 'updates')); await fs.mkdir(path.join(dir, 'elsewhere'));
  await fs.symlink(path.join(dir, 'elsewhere'), path.join(dir, 'updates'), 'junction');
  await assert.rejects(updater.download(), /缓存目录/u);
  assert.deepEqual(await fs.readdir(path.join(dir, 'elsewhere')), []);
});

test('timeouts abort fetch and stalled response streams, allow retry and remove incomplete files', async t => {
  const { updater, client, dir } = await fixture(t, { timeoutMs: 30 });
  let signal;
  client.fetch = async (_url, options) => { signal = options.signal; return new Promise(() => {}); };
  await assert.rejects(updater.check(), { code: 'UPDATE_TIMEOUT' }); assert.equal(signal.aborted, true);
  client.fetch = async address => address === api ? json(release()) : new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 20)); } }));
  await updater.check(); await assert.rejects(updater.download(), { code: 'UPDATE_TIMEOUT' });
  assert.deepEqual(await fs.readdir(path.join(dir, 'updates')), []);
});

test('disposing during streaming aborts without retaining a partial installer or publishing further callbacks', async t => {
  const { updater, client, dir, states } = await fixture(t);
  await updater.check();
  const started = deferred();
  client.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 20)); started.resolve(); } }));
  const downloading = updater.download(); downloading.catch(() => {}); await started.promise;
  const count = states.length; await updater.dispose(); await assert.rejects(downloading, { code: 'UPDATE_CANCELLED' });
  assert.equal(states.length, count); assert.deepEqual(await fs.readdir(path.join(dir, 'updates')), []);
  await assert.rejects(updater.check(), { code: 'UPDATE_DISPOSED' });
});

test('unsupported installs never access the network, and transport errors never leak local paths or signed URLs', async t => {
  const disabled = await fixture(t, { enabled: false });
  await assert.rejects(disabled.updater.check(), { code: 'UPDATE_UNSUPPORTED' });
  await assert.rejects(disabled.updater.download(), { code: 'UPDATE_UNSUPPORTED' }); assert.equal(disabled.calls.length, 0);
  const { updater, client, dir } = await fixture(t);
  client.fetch = async () => { throw new Error(`secret-token at ${dir} https://example.invalid/?sig=private`); };
  await assert.rejects(updater.check(), error => {
    assert.equal(error.message.includes('secret'), false); assert.equal(error.message.includes(dir), false); return true;
  });
  assert.equal(JSON.stringify(updater.snapshot()).includes('private'), false);
});

test('network diagnostics distinguish proxy, TLS, DNS and interrupted streams without exposing raw errors', async t => {
  for (const [raw, code, message] of [
    ['net::ERR_PROXY_CONNECTION_FAILED', 'UPDATE_PROXY', /更新代理/u],
    ['net::ERR_TUNNEL_CONNECTION_FAILED', 'UPDATE_PROXY', /更新代理/u],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'UPDATE_TLS', /安全证书/u],
    ['net::ERR_NAME_NOT_RESOLVED', 'UPDATE_DNS', /解析更新服务器/u],
    ['net::ERR_CONNECTION_TIMED_OUT', 'UPDATE_NETWORK_TIMEOUT', /超时/u],
    ['net::ERR_CONNECTION_RESET', 'UPDATE_CONNECTION_LOST', /连接已中断/u],
    ['net::ERR_INCOMPLETE_CHUNKED_ENCODING', 'UPDATE_CONNECTION_LOST', /连接已中断/u],
  ]) {
    const { updater, client } = await fixture(t);
    client.fetch = async () => { throw new TypeError('fetch failed with private signed URL', { cause: new Error(raw + ' https://private.invalid/?token=secret') }); };
    await assert.rejects(updater.check(), error => error.code === code && message.test(error.message));
    assert.equal(JSON.stringify(updater.snapshot()).includes('private'), false);
    assert.equal(JSON.stringify(updater.snapshot()).includes('secret'), false);
  }
  const { updater, client } = await fixture(t); await updater.check();
  client.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('net::ERR_CONNECTION_RESET secret')); } }));
  await assert.rejects(updater.download(), { code: 'UPDATE_CONNECTION_LOST' });
  assert.match(updater.snapshot().error, /连接已中断/u);
});

test('proxy authentication receives a specific safe error', async t => {
  const { updater, client } = await fixture(t);
  client.fetch = async () => new Response(null, { status: 407 });
  await assert.rejects(updater.check(), { code: 'UPDATE_PROXY_AUTH' });
  assert.match(updater.snapshot().error, /代理需要身份验证/u);
});

test('disk-full and permission errors do not tell users to change the network and can be retried', async t => {
  for (const [code, expected, text] of [['ENOSPC', 'UPDATE_STORAGE_FULL', /空间不足/u], ['EACCES', 'UPDATE_STORAGE_ACCESS', /目录权限/u]]) {
    const { updater, dir } = await fixture(t); await updater.check();
    const originalOpen = fs.open.bind(fs);
    const mocked = t.mock.method(fs, 'open', async (filename, flags, ...rest) => {
      if (flags === 'wx') throw Object.assign(new Error('private path token=secret'), { code });
      return originalOpen(filename, flags, ...rest);
    });
    await assert.rejects(updater.download(), error => error.code === expected && text.test(error.message));
    assert.equal(/网络|private|secret/u.test(updater.snapshot().error), false);
    assert.deepEqual(await fs.readdir(path.join(dir, 'updates')), []);
    mocked.mock.restore();
    await updater.download(); assert.equal(updater.snapshot().status, 'downloaded');
  }
});

test('real API limits use the official stable tag, matching checksum and HEAD size before offering a download', async t => {
  for (const [status, headers, body] of [
    [429, {}, 'limited'], [403, { 'x-ratelimit-remaining': '0' }, 'limited'],
    [403, { 'retry-after': '120' }, 'limited'],
    [403, {}, JSON.stringify({ message: 'API rate limit exceeded for fixture.' })],
    [403, {}, JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait.' })],
  ]) {
    const f = await fixture(t), requests = fallbackClient(f, address => address === api ? new Response(body, { status, headers }) : null);
    assert.equal((await f.updater.check()).status, 'available');
    assert.deepEqual(requests, [
      { address: api, method: 'GET' }, { address: web, method: 'GET' },
      { address: `${url}.sha256`, method: 'GET' }, { address: url, method: 'HEAD' },
    ]);
    assert.equal(JSON.stringify(f.updater.snapshot()).includes('github'), false);
    await f.updater.download(); assert.deepEqual(await fs.readFile(await f.updater.verifiedInstaller()), bytes);
  }
});

test('plain forbidden responses, malformed metadata and rate-limited checksum assets never trigger the API fallback', async t => {
  for (const body of ['Access denied', JSON.stringify({ message: 'Resource not accessible' }), JSON.stringify({ message: 'arbitrary rate limit suggestion' })]) {
    const f = await fixture(t), requests = fallbackClient(f, address => address === api ? new Response(body, { status: 403 }) : null);
    await assert.rejects(f.updater.check(), { code: 'UPDATE_ACCESS_DENIED' });
    await assert.rejects(f.updater.check(), { code: 'UPDATE_ACCESS_DENIED' });
    assert.deepEqual(requests.map(item => item.address), [api, api], 'Ordinary errors can retry immediately');
  }
  const malformed = await fixture(t), malformedCalls = fallbackClient(malformed, address => address === api ? new Response('{bad JSON') : null);
  await assert.rejects(malformed.updater.check(), /格式无效/u); assert.equal(malformedCalls.length, 1);
  const f = await fixture(t), metadata = release(); delete metadata.assets[0].digest;
  metadata.assets.push({ name: `${name}.sha256`, state: 'uploaded', size: 100, browser_download_url: `${url}.sha256` });
  const requests = fallbackClient(f, address => address === api ? json(metadata)
    : address === `${url}.sha256` ? new Response(null, { status: 429 }) : null);
  await assert.rejects(f.updater.check(), { code: 'UPDATE_RATE_LIMIT' });
  assert.equal(requests.some(item => item.address === web), false);
});

test('web fallback rejects foreign, malformed, prerelease and automatic redirects before touching assets', async t => {
  for (const location of [`${tagURL.replace('xinghan1', 'other')}v${nextVersion}`, `${tagURL}v${nextVersion}-beta`,
    `${tagURL}v0.18.04`, `${tagURL}v${nextVersion}?secret=private`, `${tagURL}v${nextVersion}#part`,
    `${tagURL.replace('https:', 'http:')}v${nextVersion}`, `${tagURL.replace('github.com', 'github.com.evil.invalid')}v${nextVersion}`,
    `${tagURL.replace('github.com', 'user:pass@github.com')}v${nextVersion}`, `/xinghan1/Synora-code/releases/tag/v${nextVersion}`]) {
    const f = await fixture(t), requests = fallbackClient(f, address => address === web ? new Response(null, { status: 302, headers: { location } }) : null);
    await assert.rejects(f.updater.check()); assert.equal(requests.length, 2);
    assert.equal(/private|pass|github/u.test(f.updater.snapshot().error), false);
  }
  const f = await fixture(t), requests = fallbackClient(f, address => {
    if (address !== web) return null;
    const response = new Response('already followed'); Object.defineProperty(response, 'redirected', { value: true }); return response;
  });
  await assert.rejects(f.updater.check(), /未经允许/u); assert.equal(requests.length, 2);
  for (const tag of ['v0.18.3', '0.18.2']) {
    const f = await fixture(t), requests = fallbackClient(f, address => address === web ? new Response(null, { status: 302, headers: { location: tagURL + tag } }) : null);
    assert.equal((await f.updater.check()).status, 'current'); assert.equal(requests.length, 2);
  }
});

test('fallback checksum files and HEAD sizes are mandatory, bounded and tied to the exact installer', async t => {
  for (const response of [() => new Response(null, { status: 404 }), () => new Response(`${hash(bytes)}  another.exe\n`),
    () => new Response('not a checksum'), () => new Response('a'.repeat(8193))]) {
    const f = await fixture(t), requests = fallbackClient(f, address => address === `${url}.sha256` ? response() : null);
    await assert.rejects(f.updater.check()); assert.equal(requests.length, 3);
  }
  for (const length of [null, '0', '63', '-1', '1.5', String(512 * 1024 * 1024 + 1), '9007199254740993', '8192, 8192']) {
    const f = await fixture(t), requests = fallbackClient(f, (address, options) => address === url && options.method === 'HEAD'
      ? new Response(null, { headers: length === null ? {} : { 'content-length': length } }) : null);
    await assert.rejects(f.updater.check(), /大小/u); assert.equal(requests.length, 4);
    await assert.rejects(f.updater.download(), /先检查/u);
  }
});

test('fallback preserves GET versus HEAD across approved CDN hops and never follows rejected HEAD targets', async t => {
  const checksumCDN = 'https://objects.githubusercontent.com/github-production-release-asset/123/checksum?sig=private';
  const installerCDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/installer?sig=private';
  const f = await fixture(t), requests = fallbackClient(f, (address, options) => {
    if (address === `${url}.sha256` || address === url) return new Response(null, { status: 302, headers: { location: address === url ? installerCDN : checksumCDN } });
    if (address === checksumCDN) return new Response(`${hash(bytes)} *${name}\n`);
    if (address === installerCDN) return options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': String(bytes.length) } }) : binary();
    return null;
  });
  await f.updater.check(); await f.updater.download(); await f.updater.verifiedInstaller();
  assert.deepEqual(requests.map(item => [item.address, item.method]), [
    [api, 'GET'], [web, 'GET'], [`${url}.sha256`, 'GET'], [checksumCDN, 'GET'], [url, 'HEAD'], [installerCDN, 'HEAD'], [url, 'GET'], [installerCDN, 'GET'],
  ]);
  for (const location of ['https://evil.invalid/installer.exe', 'http://objects.githubusercontent.com/github-production-release-asset/123/file',
    'https://objects.githubusercontent.com/unexpected/file']) {
    const rejected = await fixture(t), calls = fallbackClient(rejected, (address, options) => address === url && options.method === 'HEAD'
      ? new Response(null, { status: 302, headers: { location } }) : null);
    await assert.rejects(rejected.updater.check(), /非官方/u); assert.equal(calls.length, 4);
  }
});

test('successful checks cache for sixty seconds and API limits use web checks until the server cooldown expires', async t => {
  let now = 1800000000000, apiCalls = 0;
  const f = await fixture(t, { now: () => now, checkCacheMs: undefined });
  const requests = fallbackClient(f, address => {
    if (address !== api) return null;
    apiCalls++; return apiCalls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '120' } }) : json(release());
  });
  await f.updater.check(); assert.equal(requests.length, 4);
  await f.updater.check(); assert.equal(requests.length, 4);
  now += 61000; await f.updater.check(); assert.equal(apiCalls, 1); assert.equal(requests.length, 7);
  now += 61000; await f.updater.check(); assert.equal(apiCalls, 2); assert.equal(requests.length, 8);
  const current = await fixture(t, { now: () => now, checkCacheMs: undefined }); current.client.metadata = { ...release(), tag_name: '0.18.3' };
  await current.updater.check(); await current.updater.check(); assert.equal(current.calls.length, 1);
  now += 60001; await current.updater.check(); assert.equal(current.calls.length, 2);
});

test('API cooldown honors reset and date headers, bounds extreme values and uses five minutes without hints', async t => {
  const start = 1800000000000;
  for (const [headers, delay] of [[{}, 300000], [{ 'retry-after': '0' }, 60000], [{ 'retry-after': '99999999' }, 3600000],
    [{ 'retry-after': new Date(start + 180000).toUTCString() }, 180000], [{ 'x-ratelimit-reset': String((start + 240000) / 1000) }, 240000]]) {
    let now = start, apiCalls = 0;
    const f = await fixture(t, { now: () => now });
    fallbackClient(f, address => { if (address !== api) return null; apiCalls++; return new Response(null, { status: 429, headers }); });
    await f.updater.check(); now += delay - 1; await f.updater.check(); assert.equal(apiCalls, 1);
    now++; await f.updater.check(); assert.equal(apiCalls, 2);
  }
});

test('failed web fallback is briefly cooled down without losing an earlier usable release', async t => {
  let now = 1800000000000, failWeb = true;
  const f = await fixture(t, { now: () => now }); await f.updater.check();
  const requests = fallbackClient(f, address => address === web && failWeb ? new Response(null, { status: 503 }) : null);
  await assert.rejects(f.updater.check(), /暂时不可用/u);
  await assert.rejects(f.updater.check(), /暂时不可用/u); assert.equal(requests.length, 2);
  assert.equal(f.updater.snapshot().version, nextVersion);
  now += 60001; failWeb = false; await f.updater.check(); assert.equal(requests.length, 5);
  await f.updater.download(); await f.updater.verifiedInstaller();
});

test('normal network failures retry immediately and fallback cancellation cannot make a later HEAD request', async t => {
  const f = await fixture(t); let attempts = 0;
  f.client.fetch = async () => { if (++attempts === 1) throw new Error('net::ERR_CONNECTION_RESET private'); return json(release()); };
  await assert.rejects(f.updater.check(), { code: 'UPDATE_CONNECTION_LOST' }); await f.updater.check(); assert.equal(attempts, 2);
  const stalled = await fixture(t, { timeoutMs: 30 }); let cancelled = false;
  const requests = fallbackClient(stalled, address => address === `${url}.sha256` ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : null);
  const first = stalled.updater.check(); assert.equal(first, stalled.updater.check());
  await assert.rejects(first, { code: 'UPDATE_TIMEOUT' }); assert.equal(cancelled, true);
  assert.equal(requests.some(item => item.method === 'HEAD'), false);
});
