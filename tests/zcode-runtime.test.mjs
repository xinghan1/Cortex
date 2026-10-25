import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ZCodeRuntime } from '../src/core/zcode-runtime.mjs';
import { ZCODE_STANDALONE_PATCH } from '../scripts/patches/zcode-standalone-account.mjs';
const filename = 'zcode-windows-x64.exe', commit = '3c5b227649371507ddc4eb46ac5133afe6db1cab';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const patchBytes = Buffer.from((await fs.readFile(new URL('../scripts/patches/zcode-standalone-account.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const payload = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(256 * 1024, 0x51)]);
async function fixture(t, options = {}) {
  const root = path.resolve('artifacts', 'test-zcode-runtime'); await fs.mkdir(root, { recursive: true }); const directory = await fs.mkdtemp(path.join(root, 'case-'));
  const dataDir = path.join(directory, 'data'), sourceDirectory = path.join(directory, 'source'); await fs.mkdir(sourceDirectory);
  await fs.writeFile(path.join(sourceDirectory, filename), payload); await fs.writeFile(path.join(sourceDirectory, 'synora-standalone-account.mjs'), patchBytes);
  await fs.writeFile(path.join(sourceDirectory, 'provenance.json'), JSON.stringify({ formatVersion: 2, officialSourceUnmodified: false,
    patches: [{ ...ZCODE_STANDALONE_PATCH, patchSha256: hash(patchBytes) }], sourceCommit: commit, version: '0.17.0', license: 'Apache-2.0',
    files: { [filename]: hash(payload), 'synora-standalone-account.mjs': hash(patchBytes) } }));
  const runtime = new ZCodeRuntime({ dataDir, sourceDirectory, platform: 'win32', arch: 'x64', ...options });
  t.after(async () => { await runtime.dispose(); assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  return { runtime, directory, dataDir, sourceDirectory, entry: path.join(dataDir, 'zcode-runtime', '0.17.0', filename) };
}
const partFiles = async f => (await fs.readdir(path.dirname(f.entry)).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => name.endsWith('.part'));

test('prepared official source is copied out to a private executable only after full digest verification and atomic rename', async t => {
  const f = await fixture(t), progress = [], entered = deferred(), release = deferred(), originalRename = fs.rename;
  fs.rename = async (from, to) => { if (to === f.entry) { entered.resolve(); await release.promise; } return originalRename(from, to); };
  try {
    const installing = f.runtime.ensure({ onProgress: value => progress.push(value) }); await entered.promise;
    await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' }); assert.equal((await partFiles(f)).length, 1); release.resolve();
    const installed = await installing; assert.deepEqual(installed, { entry: f.entry, args: [], version: '0.17.0' }); assert.deepEqual(await fs.readFile(installed.entry), payload);
    assert.equal((await f.runtime.publicState()).status, 'ready'); assert.equal(progress[0].receivedBytes, 0); assert.equal(progress[0].totalBytes, payload.length);
    assert.deepEqual(await partFiles(f), []); assert.equal((await f.runtime.ensure()).entry, installed.entry);
  } finally { release.resolve(); fs.rename = originalRename; }
});

test('a tampered installed executable is repaired from the complete prepared source, and a tampered source is never installed', async t => {
  const f = await fixture(t); await f.runtime.ensure(); await fs.writeFile(f.entry, 'MZ-tampered'); await f.runtime.ensure(); assert.deepEqual(await fs.readFile(f.entry), payload);
  const corrupted = await fixture(t); await fs.writeFile(path.join(corrupted.sourceDirectory, filename), 'MZ-tampered');
  await assert.rejects(corrupted.runtime.ensure(), { code: 'ZCODE_RUNTIME_INTEGRITY' }); await assert.rejects(fs.stat(corrupted.entry), { code: 'ENOENT' }); assert.deepEqual(await partFiles(corrupted), []);
});

test('missing or unprepared source does not block API-only application startup and fails only when Agent installation is requested', async t => {
  for (const broken of ['missing', 'wrong-commit', 'wrong-license', 'invalid-json']) {
    const f = await fixture(t), file = path.join(f.sourceDirectory, 'provenance.json');
    if (broken === 'missing') await fs.unlink(file);
    else if (broken === 'invalid-json') await fs.writeFile(file, '{broken');
    else { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (broken === 'wrong-commit') value.sourceCommit = '0'.repeat(40); else value.license = 'private'; await fs.writeFile(file, JSON.stringify(value)); }
    await f.runtime.init(); assert.equal((await f.runtime.publicState()).status, 'missing'); await assert.rejects(f.runtime.ensure(), { code: 'ZCODE_RUNTIME_MISSING' }); await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' });
  }
});

test('old worker-only builds, unknown patches and modified patch sources cannot be installed as the account runtime', async t => {
  for (const change of ['legacy-worker', 'unknown-patch', 'tampered-source']) {
    const f = await fixture(t), file = path.join(f.sourceDirectory, 'provenance.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    if (change === 'legacy-worker') { manifest.formatVersion = 1; manifest.officialSourceUnmodified = true; delete manifest.patches; }
    if (change === 'unknown-patch') manifest.patches[0].resultSha256 = '0'.repeat(64);
    if (change === 'tampered-source') await fs.appendFile(path.join(f.sourceDirectory, 'synora-standalone-account.mjs'), '\n// modified');
    await fs.writeFile(file, JSON.stringify(manifest));
    await assert.rejects(f.runtime.ensure(), { code: 'ZCODE_RUNTIME_MISSING' });
    await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' });
  }
});

test('cancellation during a local source copy removes incomplete files and allows a clean retry', async t => {
  const f = await fixture(t); const pending = f.runtime.ensure({ onProgress: value => { if (value.receivedBytes > 0) f.runtime.cancel(); } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(await partFiles(f), []); await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' });
  assert.equal((await f.runtime.publicState()).error, null); await f.runtime.ensure(); assert.equal((await f.runtime.publicState()).status, 'ready');
});

test('cancellation while verifying a previously installed executable cannot report a successful ensure', async t => {
  const f = await fixture(t); await f.runtime.ensure(); const entered = deferred(), release = deferred(), controller = new AbortController(), originalLstat = fs.lstat; let held = false;
  fs.lstat = async (...args) => { if (args[0] === f.entry && !held) { held = true; entered.resolve(); await release.promise; } return originalLstat(...args); };
  try {
    const pending = f.runtime.ensure({ signal: controller.signal }), rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise; controller.abort(); release.resolve(); await rejected;
    assert.deepEqual(await fs.readFile(f.entry), payload); assert.deepEqual(await partFiles(f), []);
  } finally { release.resolve(); fs.lstat = originalLstat; }
});

test('cancellation while the final atomic rename is pending rejects the operation and leaves no partial file', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController(), originalRename = fs.rename;
  fs.rename = async (from, to) => { if (to === f.entry) { entered.resolve(); await release.promise; } return originalRename(from, to); };
  try {
    const pending = f.runtime.ensure({ signal: controller.signal }), rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise; controller.abort(); release.resolve(); await rejected;
    assert.deepEqual(await partFiles(f), []);
    // A complete verified file may survive cancellation after atomic commit;
    // it must still be verified on a subsequent explicit ensure.
  } finally { release.resolve(); fs.rename = originalRename; }
  await f.runtime.ensure(); assert.deepEqual(await fs.readFile(f.entry), payload);
});

test('a cancelled secondary ensure stops waiting promptly without cancelling the first installation', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController(), originalLstat = fs.lstat;
  let held = false, secondError, secondarySettled = false;
  fs.lstat = async (...args) => { if (args[0] === path.join(f.sourceDirectory, filename) && !held) { held = true; entered.resolve(); await release.promise; } return originalLstat(...args); };
  const first = f.runtime.ensure(); let second;
  try {
    await entered.promise; second = f.runtime.ensure({ signal: controller.signal }).then(() => { secondarySettled = true; }, error => { secondarySettled = true; secondError = error; });
    controller.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(secondarySettled, true); assert.equal(secondError?.name, 'AbortError');
  } finally { release.resolve(); fs.lstat = originalLstat; await first; await second; }
  assert.equal((await f.runtime.publicState()).status, 'ready');
});

test('source growth after stat cannot bypass the copy byte bound even when its final content hash matches', async t => {
  const f = await fixture(t), originalLstat = fs.lstat, source = path.join(f.sourceDirectory, filename);
  fs.lstat = async (...args) => { const stat = await originalLstat(...args); if (args[0] === source) return new Proxy(stat, { get(target, key) { return key === 'size' ? Math.floor(payload.length / 2) : Reflect.get(target, key); } }); return stat; };
  try { await assert.rejects(f.runtime.ensure(), error => ['ZCODE_RUNTIME_INTEGRITY', 'ZCODE_RUNTIME_MISSING'].includes(error.code)); await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' }); assert.deepEqual(await partFiles(f), []); }
  finally { fs.lstat = originalLstat; }
});

test('an owned runtime ancestor junction cannot advertise or install an executable from another directory', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'unrelated'), runtimeDir = path.join(f.dataDir, 'zcode-runtime');
  await fs.mkdir(path.join(outside, '0.17.0'), { recursive: true }); await fs.writeFile(path.join(outside, '0.17.0', filename), payload); await fs.mkdir(f.dataDir);
  try { await fs.symlink(outside, runtimeDir, 'junction'); } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) { t.skip('filesystem denied junction creation'); return; } throw error; }
  try {
    assert.equal((await f.runtime.publicState()).status, 'missing'); await assert.rejects(f.runtime.ensure(), { code: 'ZCODE_STORAGE_ERROR' }); assert.deepEqual(await fs.readFile(path.join(outside, '0.17.0', filename)), payload);
  } finally { await fs.unlink(runtimeDir); }
});

test('a source-root junction cannot substitute another prepared component directory', async t => {
  const f = await fixture(t), original = path.join(f.directory, 'original-source'); await fs.rename(f.sourceDirectory, original);
  try { await fs.symlink(original, f.sourceDirectory, 'junction'); }
  catch (error) { await fs.rename(original, f.sourceDirectory); if (['EACCES', 'EPERM'].includes(error.code)) { t.skip('filesystem denied junction creation'); return; } throw error; }
  try { assert.equal((await f.runtime.publicState()).status, 'missing'); await assert.rejects(f.runtime.ensure(), { code: 'ZCODE_RUNTIME_MISSING' }); await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' }); }
  finally { await fs.unlink(f.sourceDirectory); await fs.rename(original, f.sourceDirectory); }
});

test('manifest growth after stat is checked against its actual byte length before it can authorize a component', async t => {
  const f = await fixture(t), file = path.join(f.sourceDirectory, 'provenance.json'), originalLstat = fs.lstat;
  await fs.appendFile(file, ' '.repeat(129 * 1024));
  fs.lstat = async (...args) => { const stat = await originalLstat(...args); if (args[0] === file) return new Proxy(stat, { get(target, key) { return key === 'size' ? 1 : Reflect.get(target, key); } }); return stat; };
  try { assert.equal((await f.runtime.publicState()).status, 'missing'); await assert.rejects(f.runtime.ensure(), { code: 'ZCODE_RUNTIME_MISSING' }); await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' }); }
  finally { fs.lstat = originalLstat; }
});

test('unsupported platform remains optional during startup and never installs a Windows executable', async t => {
  const f = await fixture(t, { platform: 'linux' }); await f.runtime.init(); assert.equal((await f.runtime.publicState()).error.code, 'ZCODE_PLATFORM_UNSUPPORTED');
  await assert.rejects(f.runtime.ensure(), { code: 'ZCODE_PLATFORM_UNSUPPORTED' }); await assert.rejects(fs.stat(f.entry), { code: 'ENOENT' });
});
