import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { AntigravityRuntime, ANTIGRAVITY_RELEASE, unpackAntigravityArchive } from '../src/core/antigravity-runtime.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const files = new Map([['agy_acp_server.exe', Buffer.from('MZ original agent fixture')], ['localharness_external.exe', Buffer.from('MZ original harness fixture')]]);
function archive(entries = files) {
  const data = [], central = []; let offset = 0;
  for (const [name, bytes] of entries) {
    const encoded = Buffer.from(name), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(encoded.length, 26);
    data.push(header, encoded, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(encoded.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, encoded); offset += header.length + encoded.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, index, end]);
}
const zip = archive(), release = { ...ANTIGRAVITY_RELEASE, sha256: sha(zip), files: Object.fromEntries([...files].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) };
async function fixture(t, options = {}) {
  const parent = path.resolve('artifacts', 'test-antigravity-runtime'); await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'case-')); let calls = 0;
  const runtime = new AntigravityRuntime({ dataDir: dir, platform: 'win32', arch: 'x64', release,
    fetchImpl: async () => { calls++; return new Response(zip, { headers: { 'content-length': String(zip.length) } }); }, ...options });
  t.after(async () => { await runtime.dispose(); assert.equal(path.dirname(dir), parent); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, runtime, calls: () => calls };
}
test('official release is pinned to Google registry archive and original two executables', () => {
  assert.equal(ANTIGRAVITY_RELEASE.version, '1.4.3'); assert.equal(ANTIGRAVITY_RELEASE.sha256, '54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325');
  assert.equal(new URL(ANTIGRAVITY_RELEASE.url).hostname, 'dl.google.com'); assert.deepEqual(Object.keys(ANTIGRAVITY_RELEASE.files), ['agy_acp_server.exe', 'localharness_external.exe']);
});
test('on-demand installer verifies exact files, reports bytes, coalesces installs and detects local corruption', async t => {
  const states = [], f = await fixture(t, { onChange: () => {} }); assert.equal((await f.runtime.publicState()).status, 'missing'); assert.equal(f.calls(), 0);
  const first = f.runtime.ensure({ onProgress: value => states.push(value) }), second = f.runtime.ensure();
  const [installed, same] = await Promise.all([first, second]); assert.deepEqual(installed, same); assert.equal(f.calls(), 1);
  assert.equal(installed.version, '1.4.3'); assert.equal((await f.runtime.publicState()).status, 'ready');
  assert.equal(states.at(-1).receivedBytes, zip.length); assert.equal(states.at(-1).totalBytes, zip.length);
  for (const [name, expected] of files) assert.deepEqual(await fs.readFile(path.join(path.dirname(installed.entry), name)), expected);
  await f.runtime.ensure(); assert.equal(f.calls(), 1);
  await fs.writeFile(installed.entry, 'MZ corrupted'); await f.runtime.ensure(); assert.equal(f.calls(), 2); assert.deepEqual(await fs.readFile(installed.entry), files.get('agy_acp_server.exe'));
  const restored = new AntigravityRuntime({ dataDir: f.dir, platform: 'win32', arch: 'x64', release, fetchImpl: async () => { throw Error('must not download'); } });
  assert.equal((await restored.publicState()).status, 'ready'); await restored.dispose();
});
test('archive digest failure, truncated HTTP body and network errors never install or expose upstream text', async t => {
  for (const [fetchImpl, expected] of [
    [async () => new Response(Buffer.alloc(zip.length)), 'AGY_INTEGRITY_FAILED'],
    [async () => new Response(zip, { headers: { 'content-length': String(zip.length + 1) } }), 'AGY_DOWNLOAD_FAILED'],
    [async () => { throw Error('PRIVATE_PROXY_PASSWORD https://private/?token=SECRET'); }, 'AGY_DOWNLOAD_FAILED'],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('PRIVATE_BROKEN_NETWORK')); } })), 'AGY_DOWNLOAD_FAILED'],
  ]) {
    const f = await fixture(t, { fetchImpl }); await assert.rejects(f.runtime.ensure(), { code: expected });
    const state = await f.runtime.publicState(); assert.equal(state.status, 'error'); assert.doesNotMatch(JSON.stringify(state), /PRIVATE|SECRET|https:/);
    await assert.rejects(fs.stat(path.join(f.dir, 'antigravity-runtime', '1.4.3-win32-x64')), { code: 'ENOENT' });
  }
});
test('strict archive validation rejects traversal, duplicate entries, links, encryption and damaged members', async () => {
  assert.deepEqual(await unpackAntigravityArchive(zip, release), files);
  const central = zip.readUInt32LE(zip.length - 6);
  const bad = [];
  const traversal = Buffer.from(zip); Buffer.from('../evil-file-data.exe').copy(traversal, central + 46); bad.push(traversal);
  const duplicate = Buffer.from(zip); const second = central + 46 + Buffer.byteLength('agy_acp_server.exe'); duplicate.writeUInt32LE(0, second + 42); bad.push(duplicate);
  const link = Buffer.from(zip); link.writeUInt32LE(0xa0000000, central + 38); bad.push(link);
  const directory = Buffer.from(zip); directory.writeUInt32LE(0x10, central + 38); bad.push(directory);
  const encrypted = Buffer.from(zip); encrypted.writeUInt16LE(1, central + 8); bad.push(encrypted);
  const mismatch = Buffer.from(zip); mismatch.writeUInt16LE(0, 8); bad.push(mismatch);
  const damaged = Buffer.from(zip); damaged[31 + Buffer.byteLength('agy_acp_server.exe')] ^= 0xff; bad.push(damaged);
  const zip64 = Buffer.from(zip); zip64.writeUInt16LE(65535, zip64.length - 12); bad.push(zip64);
  for (const value of bad) await assert.rejects(unpackAntigravityArchive(value, release), { code: 'AGY_ARCHIVE_INVALID' });
});
test('download cancellation races an uncooperative fetch and does not create an installation', async t => {
  const f = await fixture(t, { fetchImpl: () => new Promise(() => {}) }), controller = new AbortController();
  const pending = f.runtime.ensure({ signal: controller.signal }), rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); await rejected;
  assert.equal((await f.runtime.publicState()).status, 'missing');
  await assert.rejects(fs.stat(path.join(f.dir, 'antigravity-runtime')), { code: 'ENOENT' });
});
test('unsupported platform fails before network and installation directory junctions cannot redirect writes', async t => {
  const unsupported = await fixture(t, { platform: 'linux' }); await assert.rejects(unsupported.runtime.ensure(), { code: 'AGY_RUNTIME_UNSUPPORTED' }); assert.equal(unsupported.calls(), 0);
  const f = await fixture(t), outside = path.join(f.dir, 'untouched'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.dir, 'antigravity-runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.runtime.ensure(), { code: 'AGY_STORAGE_ERROR' }); assert.deepEqual(await fs.readdir(outside), []);
});

function streamed(bytes, { total = bytes.length, status = 200, etag, contentRange, encoding, error, cleanup = () => {} } = {}) {
  let sent = false;
  return { ok: status >= 200 && status <= 299, status,
    headers: new Headers({ ...(total === null ? {} : { 'content-length': String(total) }), ...(etag ? { etag } : {}),
      ...(contentRange ? { 'content-range': contentRange } : {}), ...(encoding ? { 'content-encoding': encoding } : {}) }),
    body: { getReader: () => ({ async read() { if (!sent) { sent = true; return { done: false, value: bytes }; }
      if (error) throw error; return { done: true }; }, cancel: async () => cleanup('cancel'), releaseLock: () => cleanup('release') }) } };
}

test('transient HTTP and network errors retry at most twice while strict redirect handling is preserved', async t => {
  for (const kind of ['network', 408, 429, 503]) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async (url, options) => {
      calls++; assert.equal(url, release.url); assert.equal(options.redirect, 'error'); assert.equal(options.headers['Accept-Encoding'], 'identity');
      if (calls === 1) {
        if (kind === 'network') throw Object.assign(new Error('PRIVATE_AUTH_URL'), { code: 'ECONNRESET' });
        return new Response(null, { status: kind, headers: { 'retry-after': '0' } });
      }
      return new Response(zip, { headers: { 'content-length': String(zip.length) } });
    } });
    await f.runtime.ensure(); assert.equal(calls, 2); assert.equal((await f.runtime.publicState()).status, 'ready');
  }
  let calls = 0;
  const exhausted = await fixture(t, { fetchImpl: async () => { calls++; return new Response(null, { status: 503, headers: { 'retry-after': '0' } }); } });
  await assert.rejects(exhausted.runtime.ensure(), { code: 'AGY_DOWNLOAD_FAILED' }); assert.equal(calls, 3);
});

test('interrupted or short known-length bodies resume from the exact verified prefix and release readers', async t => {
  for (const interrupted of [true, false]) {
    const offset = 91, cleaned = []; let calls = 0;
    const f = await fixture(t, { fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) return streamed(zip.subarray(0, offset), { total: zip.length, etag: '"fixture-etag"',
        ...(interrupted ? { error: Object.assign(Error('PRIVATE body reset'), { code: 'ECONNRESET' }) } : {}), cleanup: value => cleaned.push(value) });
      assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity', Range: 'bytes=' + offset + '-', 'If-Range': '"fixture-etag"' });
      return streamed(zip.subarray(offset), { status: 206, etag: '"fixture-etag"', contentRange: 'bytes ' + offset + '-' + (zip.length - 1) + '/' + zip.length,
        cleanup: value => cleaned.push(value) });
    } });
    const installed = await f.runtime.ensure(); assert.equal(calls, 2);
    assert.deepEqual(await fs.readFile(installed.entry), files.get('agy_acp_server.exe'));
    assert.equal(cleaned.filter(value => value === 'cancel').length, 2); assert.equal(cleaned.filter(value => value === 'release').length, 2);
  }
});

test('a server ignoring Range restarts the complete buffer, while unknown-length failures restart without Range', async t => {
  for (const knownLength of [true, false]) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async (_url, options) => {
      if (++calls === 1) return streamed(zip.subarray(0, 73), { total: knownLength ? zip.length : null, error: Error('PRIVATE interrupted body') });
      assert.equal(options.headers?.Range, knownLength ? 'bytes=73-' : undefined);
      return new Response(zip, { headers: { 'content-length': String(zip.length) } });
    } });
    await f.runtime.ensure(); assert.equal(calls, 2); assert.equal((await f.runtime.publicState()).status, 'ready');
  }
});

test('resume rejects wrong offsets, totals, ranges, lengths and changed entity tags without further retries', async t => {
  const offset = 81, correct = 'bytes ' + offset + '-' + (zip.length - 1) + '/' + zip.length;
  for (const patch of [
    { contentRange: 'bytes 0-' + (zip.length - 1) + '/' + zip.length },
    { contentRange: 'bytes ' + offset + '-' + (zip.length - 1) + '/' + (zip.length + 1) },
    { contentRange: 'bytes ' + offset + '-' + (zip.length - 2) + '/' + zip.length },
    { total: zip.length - offset + 1 }, { etag: '"different-entity"' },
  ]) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async () => {
      if (++calls === 1) return streamed(zip.subarray(0, offset), { total: zip.length, etag: '"fixture-etag"' });
      return streamed(zip.subarray(offset), { status: 206, etag: '"fixture-etag"', contentRange: correct, ...patch });
    } });
    await assert.rejects(f.runtime.ensure(), { code: 'AGY_DOWNLOAD_FAILED' }); assert.equal(calls, 2);
    assert.equal((await f.runtime.publicState()).status, 'error');
  }
});

test('a transport closing after all declared bytes still requires the complete pinned archive digest', async t => {
  for (const corrupt of [false, true]) {
    let calls = 0;
    const bytes = Buffer.from(zip); if (corrupt) bytes[40] ^= 1;
    const f = await fixture(t, { fetchImpl: async () => { calls++; return streamed(bytes, { error: Error('PRIVATE connection close') }); } });
    if (corrupt) await assert.rejects(f.runtime.ensure(), { code: 'AGY_INTEGRITY_FAILED' });
    else await f.runtime.ensure();
    assert.equal(calls, 1);
  }
});

test('integrity, archive, TLS, permanent DNS, invalid sizes and nonretryable HTTP responses never retry or expose raw errors', async t => {
  const invalid = Buffer.from(zip); invalid.writeUInt16LE(1, zip.readUInt32LE(zip.length - 6) + 8);
  for (const [fetchImpl, code, override] of [
    [async () => new Response(Buffer.alloc(zip.length)), 'AGY_INTEGRITY_FAILED'],
    [async () => new Response(invalid), 'AGY_ARCHIVE_INVALID', { release: { ...release, sha256: sha(invalid) } }],
    [async () => { throw Error('net::ERR_CERT_AUTHORITY_INVALID PRIVATE secret'); }, 'AGY_DOWNLOAD_TLS'],
    [async () => { throw Object.assign(Error('PRIVATE secret'), { cause: { code: 'ENOTFOUND' } }); }, 'AGY_DOWNLOAD_DNS'],
    [async () => new Response(null, { status: 403 }), 'AGY_DOWNLOAD_FAILED'],
    [async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/private' } }), 'AGY_DOWNLOAD_FAILED'],
    [async () => new Response(null, { status: 407 }), 'AGY_DOWNLOAD_PROXY'],
    [async () => new Response(zip, { headers: { 'content-length': String(256 * 1024 * 1024 + 1) } }), 'AGY_DOWNLOAD_FAILED'],
    [async () => new Response(zip, { headers: { 'content-length': String(zip.length - 1) } }), 'AGY_DOWNLOAD_FAILED'],
    [async () => new Response(zip, { status: 206, headers: { 'content-range': 'bytes 0-' + (zip.length - 1) + '/' + zip.length } }), 'AGY_DOWNLOAD_FAILED'],
  ]) {
    let calls = 0;
    const f = await fixture(t, { ...override, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
    await assert.rejects(f.runtime.ensure(), { code }); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(await f.runtime.publicState()), /PRIVATE|secret|untrusted|https:/u);
  }
});

test('overall deadline spans retry waits, caller cancellation wins, and long server cooldowns are not shortened', async t => {
  let timeoutCalls = 0;
  const timeout = await fixture(t, { downloadTimeoutMs: 20, fetchImpl: async () => { timeoutCalls++; throw Error('network reset'); } });
  await assert.rejects(timeout.runtime.ensure(), { code: 'AGY_DOWNLOAD_TIMEOUT' }); assert.equal(timeoutCalls, 1);
  assert.equal((await timeout.runtime.publicState()).error.code, 'AGY_DOWNLOAD_TIMEOUT');
  const stalled = await fixture(t, { downloadTimeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(stalled.runtime.ensure(), { code: 'AGY_DOWNLOAD_TIMEOUT' });
  let cancelCalls = 0, started;
  const first = new Promise(resolve => { started = resolve; });
  const cancelled = await fixture(t, { downloadTimeoutMs: 2000, fetchImpl: async () => { cancelCalls++; started(); return new Response(null, { status: 429, headers: { 'retry-after': '10' } }); } });
  const controller = new AbortController(), pending = cancelled.runtime.ensure({ signal: controller.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError', code: 'AGY_CANCELLED' });
  await first; await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); await rejection;
  assert.equal(cancelCalls, 1); assert.equal((await cancelled.runtime.publicState()).status, 'missing');
  let longCalls = 0;
  const long = await fixture(t, { fetchImpl: async () => { longCalls++; return new Response(null, { status: 429, headers: { 'retry-after': '11' } }); } });
  await assert.rejects(long.runtime.ensure(), { code: 'AGY_DOWNLOAD_FAILED' }); assert.equal(longCalls, 1);
});

test('small download chunks update current byte counts while notifications are throttled and the final count is forced', async t => {
  let changes = 0, offset = 0; const progress = [];
  const f = await fixture(t, { onChange: () => { changes++; }, fetchImpl: async () => ({ ok: true, status: 200,
    headers: new Headers({ 'content-length': String(zip.length) }), body: { getReader: () => ({ async read() {
      return offset < zip.length ? { done: false, value: zip.subarray(offset, ++offset) } : { done: true };
    }, cancel: async () => {}, releaseLock() {} }) } }) });
  await f.runtime.ensure({ onProgress: value => progress.push(value) });
  assert.equal(progress.at(-1).receivedBytes, zip.length); assert.equal(progress.at(-1).totalBytes, zip.length);
  assert.ok(progress.length < 20 && changes < 20, 'Hundreds of chunks must not create hundreds of IPC broadcasts');
  assert.equal((await f.runtime.publicState()).status, 'ready');
});


test('decoded gzip bytes are not compared with compressed HTTP Content-Length and still require the exact ZIP digest', async t => {
  for (const corrupt of [false, true]) {
    let calls = 0; const progress = [];
    const decoded = Buffer.from(zip); if (corrupt) decoded[35] ^= 1;
    const f = await fixture(t, { fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.headers['Accept-Encoding'], 'identity');
      // Both Chromium and Fetch may return decoded bytes while retaining the
      // gzip wire length, even if a proxy ignored Accept-Encoding: identity.
      return streamed(decoded, { total: Math.floor(zip.length * .8), encoding: 'gzip' });
    } });
    if (corrupt) await assert.rejects(f.runtime.ensure({ onProgress: value => progress.push(value) }), { code: 'AGY_INTEGRITY_FAILED' });
    else { const installed = await f.runtime.ensure({ onProgress: value => progress.push(value) }); assert.deepEqual(await fs.readFile(installed.entry), files.get('agy_acp_server.exe')); }
    assert.equal(calls, 1); assert.equal(progress.at(-1).receivedBytes, zip.length); assert.equal(progress.at(-1).totalBytes, null);
  }
});

test('interrupted decoded gzip transfers restart without Range and encoded partial responses are rejected', async t => {
  let calls = 0;
  const fresh = await fixture(t, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Range, undefined);
    if (++calls === 1) return streamed(zip.subarray(0, 91), { total: 50, encoding: 'gzip', error: Error('PRIVATE interrupted gzip') });
    return new Response(zip, { headers: { 'content-length': String(zip.length) } });
  } });
  await fresh.runtime.ensure(); assert.equal(calls, 2);
  let rangeCalls = 0;
  const partial = await fixture(t, { fetchImpl: async () => {
    if (++rangeCalls === 1) return streamed(zip.subarray(0, 91), { total: zip.length });
    return streamed(zip.subarray(91), { status: 206, encoding: 'gzip', contentRange: 'bytes 91-' + (zip.length - 1) + '/' + zip.length });
  } });
  await assert.rejects(partial.runtime.ensure(), { code: 'AGY_DOWNLOAD_FAILED' }); assert.equal(rangeCalls, 2);
});
