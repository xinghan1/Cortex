import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClaudeRuntime, CLAUDE_AGENT_SDK_VERSION } from '../src/core/claude-runtime.mjs';

async function fixture(t) {
  const base = path.resolve('artifacts', 'test-claude-runtime'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(async () => { assert.equal(path.dirname(dir), base); await fs.rm(dir, { recursive: true, force: true }); }); return dir;
}
test('runtime resolves only absolute native executable paths and does not execute any command or read credentials', async t => {
  const dir = await fixture(t), bin = path.join(dir, 'bin'); await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'MZnative-fixture');
  const runtime = new ClaudeRuntime({ dataDir: dir, env: { PATH: ['.', 'relative', bin].join(path.delimiter) }, bundledExecutablePath: null, platform: 'win32' });
  assert.equal((await runtime.publicState()).status, 'ready'); const prepared = await runtime.ensure(); assert.equal(prepared.entry, path.join(bin, 'claude.exe')); assert.equal(prepared.sdkVersion, CLAUDE_AGENT_SDK_VERSION); assert.deepEqual(prepared.args, []);
});
test('shell shims, fake executables and current directory lookup are rejected', async t => {
  const dir = await fixture(t), native = path.join(dir, 'claude.exe'); await fs.writeFile(native, 'plain-text'); await fs.writeFile(path.join(dir, 'claude.cmd'), '@echo fake');
  const runtime = new ClaudeRuntime({ dataDir: dir, executablePath: native, env: {}, bundledExecutablePath: null, platform: 'win32' });
  await assert.rejects(runtime.ensure(), { code: 'CLAUDE_RUNTIME_MISSING' });
  const script = new ClaudeRuntime({ dataDir: dir, executablePath: path.join(dir, 'claude.cmd'), env: {}, bundledExecutablePath: null, platform: 'win32' }); await assert.rejects(script.ensure(), { code: 'CLAUDE_RUNTIME_MISSING' });
  const local = new ClaudeRuntime({ dataDir: dir, env: { PATH: '.' }, bundledExecutablePath: null, platform: 'win32' }); await assert.rejects(local.ensure(), { code: 'CLAUDE_RUNTIME_MISSING' });
});
test('missing runtime reports the official installation URL once and can detect installation on retry', async t => {
  const dir = await fixture(t); let changes = 0;
  const runtime = new ClaudeRuntime({ dataDir: dir, env: { PATH: dir }, bundledExecutablePath: null, platform: 'win32', onChange: () => changes++ });
  const state = await runtime.publicState(); assert.equal(state.status, 'missing'); assert.equal(state.installUrl, 'https://code.claude.com/docs/en/setup'); await runtime.publicState(); assert.equal(changes, 1);
  await fs.writeFile(path.join(dir, 'claude.exe'), 'MZfixture'); await runtime.ensure(); assert.equal((await runtime.publicState()).status, 'ready');
});
test('bundled component rejects a changed binary rather than trusting its filename', async t => {
  const dir = await fixture(t), native = path.join(dir, 'claude.exe'); await fs.writeFile(native, 'MZtampered');
  const runtime = new ClaudeRuntime({ dataDir: dir, env: {}, bundledExecutablePath: native, platform: 'win32' }); await assert.rejects(runtime.ensure(), { code: 'CLAUDE_RUNTIME_MISSING' });
});
test('runtime preparation honours cancellation and unsupported platforms', async t => {
  const dir = await fixture(t), controller = new AbortController(); controller.abort();
  const runtime = new ClaudeRuntime({ dataDir: dir, env: {}, bundledExecutablePath: null, platform: 'win32' }); await assert.rejects(runtime.ensure({ signal: controller.signal }), { name: 'AbortError' });
  const unsupported = new ClaudeRuntime({ dataDir: dir, env: {}, bundledExecutablePath: null, platform: 'linux' }); await assert.rejects(unsupported.ensure(), { code: 'CLAUDE_PLATFORM_UNSUPPORTED' });
});
