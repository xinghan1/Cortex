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
