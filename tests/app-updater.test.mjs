import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { AppUpdater } = createRequire(import.meta.url)('../src/core/app-updater.cjs');
const testRoot = path.resolve('tests', '.tmp');
const api = 'https://api.github.com/repos/xinghan1/Synora-code/releases/latest';
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
    fetchImpl: (...args) => client.fetch(...args), onChange: state => states.push(state), ...overrides });
  t.after(async () => {
    await updater.dispose();
    const target = path.resolve(dir);
    assert.equal(path.dirname(target).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(target).startsWith('app-updater-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { updater, dir, calls, states, client };
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
  client.fetch = async address => address === api ? new Response('limited', { status: 429 }) : binary();
  await assert.rejects(updater.check(), /限流/u);
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
