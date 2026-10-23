import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoleModels, ROLE_KEYS } = require('../src/core/role-models.cjs');
const { Store } = require('../src/core/store.cjs');
const testRoot = path.resolve('tests', '.tmp');
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => {
    const decoded = value.toString();
    if (!decoded.startsWith('encrypted:')) throw new Error('Invalid test ciphertext');
    return decoded.slice(10);
  },
};

async function fixture(t, encryption = crypto) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'role-models-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(dir).startsWith('role-models-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const roles = new RoleModels(dir, encryption);
  await roles.init();
  return { dir, roles, file: path.join(dir, 'role-models.json') };
}

const openai = (apiKey, model = 'role-api-model') => ({ provider: 'openai', model, apiKey });

test('all roles start following the main model without inheriting any main credentials', async t => {
  const { dir, roles } = await fixture(t);
  const main = new Store(dir, crypto);
  await main.saveSettings(openai('main-only-secret'));
  assert.deepEqual(Object.keys(roles.publicState()), ROLE_KEYS);
  for (const role of ROLE_KEYS) {
    assert.equal(roles.isEnabled(role), false);
    assert.equal(roles.key(role, 'openai'), '');
    for (const config of Object.values(roles.publicState()[role].settings.providers)) assert.equal(config.hasKey, false);
    await assert.rejects(roles.draft(role, openai(undefined)), { code: 'ROLE_MODELS_API_KEY_REQUIRED' });
  }
  assert.deepEqual(await fs.readdir(dir), ['settings.json']);
  assert.equal(main.key('openai'), 'main-only-secret');
});

test('four independent provider connections and reasoning settings survive restart without exposing keys', async t => {
  const { dir, roles, file } = await fixture(t);
  const payloads = {
    subagent: { provider: 'relay', model: 'proxy-coder', apiKey: 'subagent-secret', baseUrl: 'https://relay.example/v1', apiProtocol: 'responses', reasoningEffort: 'high' },
    approval: { provider: 'anthropic', model: 'approval-model', apiKey: 'approval-secret', baseUrl: 'https://api.anthropic.com/v1', reasoningEffort: 'low' },
    completion: { ...openai('completion-secret', 'completion-model'), apiProtocol: 'chat-completions', reasoningEffort: 'none' },
    sidebar: { provider: 'ollama', model: 'local-model', baseUrl: 'http://192.0.2.10:11434', reasoningEffort: 'enabled', contextWindowTokens: 65536 },
  };
  await Promise.all(ROLE_KEYS.map(role => roles.save(role, payloads[role])));
  await roles.settled();
  const state = roles.publicState();
  for (const role of ROLE_KEYS) {
    assert.equal(state[role].enabled, true);
    assert.equal(state[role].settings.provider, payloads[role].provider);
    assert.equal(state[role].settings.model, payloads[role].model);
    assert.equal(state[role].settings.reasoningEffort, payloads[role].reasoningEffort);
    assert.equal(roles.key(role), payloads[role].apiKey || '');
  }
  assert.equal(state.completion.settings.apiProtocol, 'chat-completions');
  assert.equal(state.sidebar.settings.contextWindowTokens, 65536);
  const encoded = await fs.readFile(file, 'utf8');
  const publicText = JSON.stringify(state);
  for (const payload of Object.values(payloads)) {
    if (!payload.apiKey) continue;
    assert.ok(!encoded.includes(payload.apiKey));
    assert.ok(!publicText.includes(payload.apiKey));
  }
  assert.ok(!publicText.includes('encryptedKey'));
  const restored = new RoleModels(dir, crypto);
  await restored.init();
  assert.deepEqual(restored.publicState(), state);
  for (const role of ROLE_KEYS) assert.equal(restored.key(role), roles.key(role));
  assert.deepEqual(await fs.readdir(dir), ['role-models.json']);
});

test('catalog drafts allow an empty model and never persist or mutate role state', async t => {
  const { dir, roles } = await fixture(t);
  const before = roles.publicState();
  const draft = await roles.draft('approval', openai('draft-only-secret', ''));
  assert.ok(draft instanceof Store);
  assert.equal(draft.publicSettings().model, '');
  assert.equal(draft.key('openai'), 'draft-only-secret');
  assert.equal(draft.redact('failure draft-only-secret'), 'failure [已隐藏密钥]');
  draft.settings.providers.openai.baseUrl = 'https://changed.example';
  assert.deepEqual(roles.publicState(), before);
  assert.deepEqual(await fs.readdir(dir), []);
  await assert.rejects(roles.save('approval', openai('draft-only-secret', '')), { code: 'ROLE_MODELS_MODEL_REQUIRED' });
  assert.deepEqual(roles.publicState(), before);
});

test('keys are retained only within each role/provider and reset follows main while retaining encrypted configuration', async t => {
  const { dir, roles, file } = await fixture(t);
  await roles.save('subagent', openai('subagent-openai-secret'));
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(roles.save('subagent', { provider: 'deepseek', model: 'deepseek-model' }), { code: 'ROLE_MODELS_API_KEY_REQUIRED' });
  await assert.rejects(roles.save('approval', openai(undefined)), { code: 'ROLE_MODELS_API_KEY_REQUIRED' });
  await assert.rejects(roles.save('subagent', { ...openai(undefined), clearKey: true }), { code: 'ROLE_MODELS_API_KEY_REQUIRED' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await roles.save('subagent', { provider: 'deepseek', model: 'deepseek-model', apiKey: 'subagent-deepseek-secret' });
  await roles.save('subagent', openai('', 'second-openai-model'));
  assert.equal(roles.key('subagent'), 'subagent-openai-secret');
  await roles.reset('subagent');
  assert.equal(roles.isEnabled('subagent'), false);
  assert.equal(roles.key('subagent', 'deepseek'), 'subagent-deepseek-secret');
  const restored = new RoleModels(dir, crypto);
  await restored.init();
  assert.equal(restored.isEnabled('subagent'), false);
  assert.equal(restored.publicState().subagent.settings.model, 'second-openai-model');
  await restored.save('subagent', openai('', 'third-openai-model'));
  assert.equal(restored.isEnabled('subagent'), true);
  assert.equal(restored.key('subagent'), 'subagent-openai-secret');
});

test('ChatGPT and Ollama do not require API keys and switching back to API mode requires a role key', async t => {
  const { roles } = await fixture(t);
  await roles.save('completion', { provider: 'openai', authMode: 'chatgpt', model: 'account-model' });
  await roles.save('sidebar', { provider: 'ollama', model: 'local-model' });
  assert.equal(roles.publicState().completion.settings.authMode, 'chatgpt');
  assert.equal(roles.key('completion'), '');
  assert.equal(roles.key('sidebar'), '');
  await assert.rejects(roles.save('completion', { provider: 'openai', authMode: 'apiKey', model: 'api-model' }), { code: 'ROLE_MODELS_API_KEY_REQUIRED' });
  assert.equal(roles.publicState().completion.settings.authMode, 'chatgpt');
  await roles.save('completion', { ...openai('own-api-secret'), authMode: 'apiKey' });
  await roles.save('completion', { provider: 'openai', authMode: 'chatgpt' });
  assert.equal(roles.publicState().completion.settings.model, 'account-model');
});

test('OS decryption failures preserve enabled role state and cannot cause fallback to main', async t => {
  const { dir, roles } = await fixture(t);
  await roles.save('approval', openai('machine-bound-secret'));
  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('Unavailable'); },
    decryptString: () => { throw new Error('Different machine'); },
  };
  const restored = new RoleModels(dir, unavailable);
  await restored.init();
  assert.equal(restored.isEnabled('approval'), true);
  assert.equal(restored.publicState().approval.settings.hasKey, true);
  assert.throws(() => restored.key('approval'), /重新填写 API Key/);
  await assert.rejects(restored.draft('approval', openai(undefined)), /重新填写 API Key/);
  assert.equal(restored.isEnabled('approval'), true);
  await assert.rejects(restored.save('completion', openai('replacement-secret')), /系统密钥加密暂不可用/);
  assert.equal(restored.isEnabled('completion'), false);
});

test('serialized saves and resets retain other changes and only publish after atomic persistence succeeds', async t => {
  const { dir, roles, file } = await fixture(t);
  await roles.save('subagent', openai('existing-secret'));
  const before = roles.publicState();
  const backup = path.join(dir, 'saved-role-models.json');
  await fs.rename(file, backup);
  await fs.mkdir(file);
  await assert.rejects(roles.save('approval', openai('not-committed-secret')), { code: 'ROLE_MODELS_SAVE_FAILED' });
  await assert.rejects(roles.reset('subagent'), { code: 'ROLE_MODELS_SAVE_FAILED' });
  assert.deepEqual(roles.publicState(), before);
  assert.equal(roles.key('approval'), '');
  await fs.rmdir(file);
  await fs.rename(backup, file);
  const pending = [
    roles.save('approval', openai('approval-secret')),
    roles.save('completion', { provider: 'ollama', model: 'completion-local' }),
    roles.reset('subagent'),
    roles.save('approval', openai('', 'approval-new-model')),
  ];
  await Promise.all(pending);
  await roles.settled();
  const restored = new RoleModels(dir, crypto);
  await restored.init();
  assert.deepEqual(restored.publicState(), roles.publicState());
  assert.equal(restored.isEnabled('subagent'), false);
  assert.equal(restored.isEnabled('completion'), true);
  assert.equal(restored.publicState().approval.settings.model, 'approval-new-model');
  assert.equal(restored.key('approval'), 'approval-secret');
  assert.deepEqual(await fs.readdir(dir), ['role-models.json']);
});

test('public snapshots and raw settings snapshots cannot mutate service settings; redaction covers disabled roles', async t => {
  const { roles } = await fixture(t);
  await roles.save('subagent', openai('shared-secret'));
  await roles.save('approval', openai('shared-secret-long'));
  await roles.reset('approval');
  const state = roles.publicState();
  state.subagent.settings.providers.openai.modelsByAuth.apiKey = 'tampered-model';
  const raw = roles.settingsFor('subagent');
  raw.providers.openai.encryptedKey = '';
  raw.providers.openai.model = 'tampered-model';
  assert.equal(roles.publicState().subagent.settings.model, 'role-api-model');
  assert.equal(roles.key('subagent'), 'shared-secret');
  assert.equal(roles.redact('shared-secret-long / shared-secret'), '[已隐藏密钥] / [已隐藏密钥]');
  assert.equal(roles.redact(null), 'null');
});

test('damaged schemas never leak extra fields or get overwritten by subsequent saves', async t => {
  const { dir, roles, file } = await fixture(t);
  await roles.save('approval', openai('saved-secret'));
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  const changes = [
    data => { data.version = 99; },
    data => { data.roles.unexpected = data.roles.approval; },
    data => { data.roles.approval.settings.providers.openai.modelsByAuth.apiKeyLeak = 'plaintext-secret'; },
    data => { data.roles.approval.settings.providers.openai.apiKey = 'plaintext-secret'; },
    data => { data.roles.approval.settings.providers.openai.encryptedKey = '!not-base64!'; },
    data => { data.roles.approval.settings.providers.openai.baseUrl = 'https://user:password@example.com'; },
    data => { data.roles.approval.settings.providers.openai.model = 'unsafe\u0000model'; },
    data => { data.roles.approval.settings.providers.openai.modelsByAuth.apiKey = 'other-model'; },
    data => { data.roles.approval.enabled = 'true'; },
  ];
  for (const mutate of changes) {
    const data = structuredClone(original); mutate(data);
    const encoded = JSON.stringify(data);
    await fs.writeFile(file, encoded);
    const restored = new RoleModels(dir, crypto);
    await assert.rejects(restored.init(), { code: 'ROLE_MODELS_LOAD_FAILED' });
    assert.equal(restored.isEnabled('approval'), false);
    assert.ok(!JSON.stringify(restored.publicState()).includes('plaintext-secret'));
    await assert.rejects(restored.save('sidebar', { provider: 'ollama', model: 'new-model' }), { code: 'ROLE_MODELS_LOAD_FAILED' });
    assert.equal(await fs.readFile(file, 'utf8'), encoded);
  }
});

test('invalid roles, provider protocols and non-string settings cannot change stored state', async t => {
  const { roles, dir } = await fixture(t);
  for (const role of ['__proto__', 'constructor', '', null, '../completion']) {
    assert.throws(() => roles.isEnabled(role), { code: 'ROLE_MODELS_INVALID_ROLE' });
    await assert.rejects(roles.save(role, openai('unused-secret')), { code: 'ROLE_MODELS_INVALID_ROLE' });
    await assert.rejects(roles.reset(role), { code: 'ROLE_MODELS_INVALID_ROLE' });
  }
  for (const input of [
    { provider: 'invalid', model: 'model' },
    { ...openai('unused-secret'), apiProtocol: 'invalid' },
    { ...openai('unused-secret'), model: {} },
    { ...openai('unused-secret'), apiKey: {} },
    { ...openai('unused-secret'), baseUrl: 'https://example.com?key=unsafe' },
    { provider: 'ollama', model: 'model', reasoningEffort: 'invalid' },
  ]) await assert.rejects(roles.save('completion', input));
  assert.equal(roles.isEnabled('completion'), false);
  assert.deepEqual(await fs.readdir(dir), []);
});
