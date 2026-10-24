import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KimiRuntime, KIMI_RELEASE } from '../src/core/kimi-runtime.mjs';
const payload = Buffer.from('MZ-original-official-runtime-fixture');
const release = { ...KIMI_RELEASE, sha256: createHash('sha256').update(payload).digest('hex') };
async function fixture(t, options = {}) {
  const base = path.resolve('artifacts', 'test-kimi-runtime'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const calls = []; const runtime = new KimiRuntime({ dataDir: dir, platform: 'win32', arch: 'x64', release,
    fetchImpl: async (url, config) => { calls.push({ url, config }); return new Response(payload, { headers: { 'content-length': String(payload.length) } }); }, ...options });
  t.after(async () => { await runtime.dispose(); assert.equal(path.dirname(dir), base); await fs.rm(dir, { recursive: true, force: true }); });
  return { runtime, dir, calls };
}
test('original executable is streamed, verified, atomically installed and reused only while its digest matches', async t => {
  const f = await fixture(t), progress = []; assert.equal((await f.runtime.publicState()).status, 'missing');
  const installed = await f.runtime.ensure({ onProgress: value => progress.push(value) });
  assert.deepEqual(await fs.readFile(installed.entry), payload); assert.equal(installed.version, '2.3.1'); assert.equal(f.calls[0].config.redirect, 'manual');
  assert.equal(progress.at(-1).receivedBytes, payload.length); assert.equal((await f.runtime.publicState()).status, 'ready');
  assert.equal((await f.runtime.ensure()).entry, installed.entry); assert.equal(f.calls.length, 1);
  await fs.writeFile(installed.entry, Buffer.from('MZ-tampered')); await f.runtime.ensure(); assert.equal(f.calls.length, 2); assert.deepEqual(await fs.readFile(installed.entry), payload);
  assert.deepEqual((await fs.readdir(path.dirname(path.dirname(installed.entry)))).filter(name => name.startsWith('.install-')), []);
});
test('only the official same-version CDN redirect can be downloaded', async t => {
  for (const next of ['https://evil.example/kimi.exe', 'http://cdn.kimi.com/kimi-code/binaries/2.3.1/kimi-code-win32-x64.exe', 'https://cdn.kimi.com/kimi-code/binaries/2.3.2/kimi-code-win32-x64.exe']) {
    const f = await fixture(t, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: next } }) });
    await assert.rejects(f.runtime.ensure(), { code: 'KIMI_DOWNLOAD_FAILED' }); assert.equal((await f.runtime.publicState()).status, 'error');
  }
  let calls = 0; const f = await fixture(t, { fetchImpl: async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: release.url.replace('code.kimi.com', 'cdn.kimi.com') } }) : new Response(payload) });
  await f.runtime.ensure(); assert.equal(calls, 2);
});
test('bad digest, non-PE payload and incomplete downloads never become runnable', async t => {
  for (const response of [() => new Response(Buffer.from('MZ-wrong')), () => new Response(Buffer.from('no-pe')), () => new Response(payload, { headers: { 'content-length': String(payload.length + 1) } })]) {
    const f = await fixture(t, { fetchImpl: async () => response() }); await assert.rejects(f.runtime.ensure(), error => ['KIMI_DOWNLOAD_FAILED', 'KIMI_INTEGRITY_FAILED'].includes(error.code));
    const root = path.join(f.dir, 'kimi-runtime'); assert.deepEqual(await fs.readdir(root), []);
  }
});
test('cancel stops a stalled download promptly and another ensure can retry', async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; }); let cancelled = false, calls = 0;
  const f = await fixture(t, { fetchImpl: async () => ++calls === 1 ? new Response(new ReadableStream({ start() { enter(); }, cancel() { cancelled = true; } })) : new Response(payload) });
  const running = f.runtime.ensure(), rejected = assert.rejects(running, { name: 'AbortError' }); await entered; f.runtime.cancel(); await rejected;
  assert.equal(cancelled, true); assert.equal((await f.runtime.publicState()).status, 'missing'); await f.runtime.ensure(); assert.equal(calls, 2);
});
test('unsupported platform and unsafe release metadata cannot fetch or install', async t => {
  const f = await fixture(t, { arch: 'arm64' }); await assert.rejects(f.runtime.ensure(), { code: 'KIMI_RUNTIME_UNSUPPORTED' }); assert.equal(f.calls.length, 0);
  assert.throws(() => new KimiRuntime({ dataDir: f.dir, release: { ...release, url: 'https://evil.example/kimi.exe' } }), { code: 'KIMI_INVALID_INPUT' });
});
