import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const { Store } = createRequire(import.meta.url)('../src/core/store.cjs');
const testRoot = path.resolve('tests', '.tmp');
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from('fixture:' + value),
  decryptString: value => value.toString().slice(8),
};
async function fixture(t, storage = crypto) {
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'ollama-settings-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(directory).startsWith('ollama-settings-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new Store(directory, storage); await store.init(); return store;
}

test('Ollama saves a local model without a key or OS encryption and survives reopening', async t => {
  const storage = { isEncryptionAvailable: () => false };
  const store = await fixture(t, storage);
  assert.equal(store.publicSettings().providers.ollama.baseUrl, 'http://localhost:11434');
  assert.equal(store.publicSettings().providers.ollama.contextWindowTokens, 32768);
  const saved = await store.saveSettings({ provider: 'ollama', model: 'local-coder:latest', contextWindowTokens: 16384 });
  assert.equal(saved.hasKey, false); assert.equal(saved.authMode, 'apiKey'); assert.equal(store.key('ollama'), '');
  assert.equal(Object.hasOwn(saved, 'apiProtocol'), false);
  const reopened = new Store(store.dir, storage); await reopened.init();
  assert.equal(reopened.publicSettings().provider, 'ollama');
  assert.equal(reopened.publicSettings().model, 'local-coder:latest');
  assert.equal(reopened.publicSettings().contextWindowTokens, 16384);
});

test('Ollama alone accepts user-configured HTTP deployments while other provider restrictions stay intact', async t => {
  const store = await fixture(t);
  for (const baseUrl of ['http://192.168.1.10:11434', 'http://inference.internal.example:11434/ollama/api', 'http://[fd00::1234]:11434', 'https://inference.example/ollama']) {
    await store.saveSettings({ provider: 'ollama', model: 'local-model', baseUrl });
    assert.equal(store.publicSettings().baseUrl, baseUrl);
  }
  for (const provider of ['openai', 'deepseek', 'anthropic', 'relay']) {
    await assert.rejects(store.saveSettings({ provider, baseUrl: 'http://192.168.1.10:11434' }), /HTTPS/);
  }
});

test('Ollama rejects unsafe endpoint forms before changing settings or storing a key', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'ollama', model: 'kept-model' });
  const before = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
  for (const baseUrl of ['file:///C:/models', 'ftp://server/models', 'http://user:password@localhost:11434', 'http://@localhost:11434', 'http://localhost:11434?key=secret', 'http://localhost:11434/#', 'http://local\nhost:11434']) {
    await assert.rejects(store.saveSettings({ provider: 'ollama', baseUrl, apiKey: 'rejected-fixture-key' }));
    assert.equal(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'), before);
    assert.equal(store.key('ollama'), '');
  }
});

test('Ollama optional proxy key remains encrypted, redacted, and independent of another provider', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'deepseek', apiKey: 'fixture-other-secret', model: 'other-model' });
  await store.saveSettings({ provider: 'ollama', model: 'coder', apiKey: 'fixture-ollama-secret' });
  assert.equal(store.key('deepseek'), 'fixture-other-secret');
  assert.equal(store.key('ollama'), 'fixture-ollama-secret');
  const publicValue = JSON.stringify(store.publicSettings());
  assert.ok(!publicValue.includes('fixture-ollama-secret')); assert.ok(!publicValue.includes('encryptedKey'));
  assert.equal(store.redact('fixture-ollama-secret fixture-other-secret'), '[已隐藏密钥] [已隐藏密钥]');
  const disk = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
  assert.ok(!disk.includes('fixture-ollama-secret'));
  await store.saveSettings({ provider: 'ollama', apiKey: '' });
  assert.equal(store.key('ollama'), 'fixture-ollama-secret');
  await store.saveSettings({ provider: 'ollama', clearKey: true });
  assert.equal(store.key('ollama'), ''); assert.equal(store.key('deepseek'), 'fixture-other-secret');
});

test('Ollama context limits validate atomically and do not create fields on other providers', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'ollama', model: 'kept-model', contextWindowTokens: 65536 });
  const before = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
  for (const value of [0, 4095, 2097153, 8192.5, '8192', null, false, {}, []]) {
    await assert.rejects(store.saveSettings({ provider: 'ollama', contextWindowTokens: value, model: 'not-saved' }), /上下文/);
    assert.equal(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'), before);
  }
  await assert.rejects(store.saveSettings({ provider: 'deepseek', contextWindowTokens: 8192 }), /上下文/);
  assert.equal(Object.hasOwn(store.publicSettings().providers.deepseek, 'contextWindowTokens'), false);
  for (const value of [4096, 2097152]) {
    await store.saveSettings({ provider: 'ollama', contextWindowTokens: value });
    assert.equal(store.publicSettings().contextWindowTokens, value);
  }
});

test('old settings gain Ollama defaults without changing existing connection and corrupted context limits repair', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'deepseek', model: 'kept-model', apiKey: 'fixture-old-key' });
  const file = path.join(store.dir, 'settings.json');
  const previous = JSON.parse(await fs.readFile(file, 'utf8')); delete previous.providers.ollama;
  await fs.writeFile(file, JSON.stringify(previous));
  const restored = new Store(store.dir, crypto); await restored.init();
  assert.equal(restored.publicSettings().provider, 'deepseek'); assert.equal(restored.publicSettings().model, 'kept-model');
  assert.equal(restored.key('deepseek'), 'fixture-old-key'); assert.equal(restored.publicSettings().providers.ollama.contextWindowTokens, 32768);
  for (const contextWindowTokens of [null, '32768', -1, 2097153]) {
    const malformed = structuredClone(previous);
    malformed.providers.ollama = { model: 'kept-ollama', contextWindowTokens };
    await fs.writeFile(file, JSON.stringify(malformed));
    const reopened = new Store(store.dir, crypto); await reopened.init();
    assert.equal(reopened.publicSettings().providers.ollama.contextWindowTokens, 32768);
    assert.equal(reopened.publicSettings().providers.ollama.model, 'kept-ollama');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).providers.ollama.contextWindowTokens, 32768);
  }
});

test('Ollama usage and independent approval requests persist as reported tokens', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'ollama', model: 'coder', reasoningEffort: 'enabled' });
  assert.equal(store.publicSettings().reasoningEffort, 'enabled');
  await assert.rejects(store.saveSettings({ provider: 'ollama', authMode: 'chatgpt' }), /登录方式/);
  await assert.rejects(store.saveSettings({ provider: 'ollama', apiProtocol: 'chat-completions' }), /API 协议/);
  const sessionId = randomUUID();
  await store.recordUsage({ id: randomUUID(), timestamp: '2026-10-20T02:00:00Z', provider: 'ollama', model: 'coder', sessionId, runId: randomUUID(),
    inputTokens: 100, outputTokens: 12, reported: true, status: 'completed', purpose: 'approval-review' });
  const reopened = new Store(store.dir, crypto); await reopened.init();
  assert.equal(reopened.usageStats('2026-10-20T03:00:00Z').day.totalTokens, 112);
  const entries = JSON.parse(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'));
  assert.equal(entries.records[0].provider, 'ollama'); assert.equal(entries.records[0].purpose, 'approval-review');
});
