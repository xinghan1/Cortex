import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../src/core/approval-reviewer-preferences.cjs');
const { ApprovalReviewerPreferences, approvalReviewerConnectionKey } = require(modulePath);
const testRoot = path.resolve('tests', '.tmp'), project = 'C:\\Work\\Project', otherProject = 'C:\\Work\\Other';
const source = await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8');
const functionsSource = source.slice(source.indexOf('function reviewerConnectionKey('), source.indexOf('function capabilitiesFor('));
const handlerSource = source.slice(source.indexOf('setApprovalReviewer: async arg =>') + 'setApprovalReviewer: '.length,
  source.indexOf('    browserOpen:', source.indexOf('setApprovalReviewer: async arg =>'))).trim().replace(/,$/u, '');
const connection = (provider = 'openai') => ({ provider, authMode: 'apiKey', key: `catalog-${provider}`,
  config: { baseUrl: 'https://example.invalid/v1', apiProtocol: 'responses', model: 'main' } });
const key = approvalReviewerConnectionKey(connection(), 'test-key');
const otherKey = approvalReviewerConnectionKey(connection('relay'), 'test-key');

async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'approval-reviewer-'));
  t.after(async () => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(target).startsWith('approval-reviewer-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { dir, file: path.join(dir, 'approval-reviewer-preferences.json') };
}

function runtime(preferences) {
  const value = { approvalReviewerPreferences: preferences, approvalReviewerConnectionKey,
    isAccountMode: mode => mode === 'chatgpt' || mode === 'deepseek-account',
    tools: { root: project }, approvalReviewerModel: null, approvalReviewerScope: null, approvalReviewerConnectionCache: null,
    localOperation: false, promptPreflights: 0, shuttingDown: false, quitting: false, connection: connection(), reads: 0, reconciles: 0,
    catalogSnapshots: new Map([['catalog-openai', { models: [{ id: 'reviewer-a' }, { id: 'reviewer-b' }] }]]),
    capabilitiesFor: () => ({ textCompatible: true }), broadcastState: async () => {},
  };
  value.store = { settings: { providers: { openai: { encryptedKey: 'cipher-one' }, relay: { encryptedKey: 'cipher-two' } } },
    key: () => { value.reads++; return 'test-key'; } };
  value.publicSettings = () => ({ provider: value.connection.provider, model: 'main' });
  value.catalogContext = async () => value.connection;
  value.approvalController = { reconcile: () => value.reconciles++ };
  vm.runInNewContext(`${functionsSource}\nglobalThis.select = (${handlerSource}); globalThis.restore = restoreApprovalReviewer;`, value);
  return value;
}

test('reviewer connection identity survives transient official-account state, token changes and model settings', () => {
  const official = { provider: 'openai', authMode: 'chatgpt', account: { session: { profileId: 'account-one', status: 'connected', sharing: true } } };
  const first = approvalReviewerConnectionKey(official);
  for (const status of ['connected', 'connecting', 'reauth_required', 'disconnected']) {
    assert.equal(approvalReviewerConnectionKey({ ...official, config: { model: 'different', contextWindowTokens: 800000 },
      account: { session: { profileId: 'account-one', status, sharing: false, accessToken: 'new-token' } } }), first);
  }
  assert.notEqual(approvalReviewerConnectionKey({ ...official, account: { session: { profileId: 'account-two' } } }), first);
  assert.notEqual(approvalReviewerConnectionKey({ ...official, account: { session: {} } }), first);
  const original = connection();
  assert.equal(approvalReviewerConnectionKey({ ...original, config: { ...original.config, model: 'another', encryptedKey: 'new-cipher', contextWindowTokens: 10000 } }, 'test-key'), key);
  assert.equal(approvalReviewerConnectionKey({ ...original, config: { ...original.config, baseUrl: 'https://EXAMPLE.invalid:443/v1/' } }, 'test-key'), key);
  for (const modified of [{ ...original, provider: 'relay' }, { ...original, config: { ...original.config, baseUrl: 'https://other.invalid/v1' } },
    { ...original, config: { ...original.config, apiProtocol: 'chat-completions' } }]) assert.notEqual(approvalReviewerConnectionKey(modified, 'test-key'), key);
  assert.notEqual(approvalReviewerConnectionKey(original, 'different-key'), key);
  const ollama = connection('ollama');
  assert.equal(approvalReviewerConnectionKey(ollama), approvalReviewerConnectionKey({ ...ollama, config: { ...ollama.config, contextWindowTokens: 32768 } }));
});

test('DeepSeek reviewer choices bind to the signed-in account generation and remain separate from API keys', () => {
  const context = { provider: 'deepseek', authMode: 'deepseek-account', account: { session: { profileId: 'grant-one', status: 'connected', sharing: true } } };
  const savedKey = approvalReviewerConnectionKey(context);
  assert.equal(approvalReviewerConnectionKey({ ...context, account: { session: { profileId: 'grant-one', status: 'connecting', sharing: false } } }), savedKey);
  assert.notEqual(approvalReviewerConnectionKey({ ...context, account: { session: { profileId: 'grant-two' } } }), savedKey);
  assert.notEqual(approvalReviewerConnectionKey(connection('deepseek'), 'key'), savedKey);
  assert.throws(() => approvalReviewerConnectionKey({ ...context, provider: 'relay' }));
});

test('project, empty window and provider identities independently persist model and explicit follow-current selections', async t => {
  const { dir, file } = await fixture(t), preferences = await new ApprovalReviewerPreferences(dir).init();
  assert.equal(preferences.get(project, key), null); assert.deepEqual(await fs.readdir(dir), []);
  await preferences.set('C:/Work/Project/', key, 'reviewer-a');
  await preferences.set(otherProject, key, 'reviewer-b');
  await preferences.set(project, otherKey, 'other-provider');
  await preferences.set(null, key, 'empty-window');
  let reopened = await new ApprovalReviewerPreferences(dir).init();
  assert.equal(reopened.get(project, key), 'reviewer-a'); assert.equal(reopened.get(otherProject, key), 'reviewer-b');
  assert.equal(reopened.get(project, otherKey), 'other-provider'); assert.equal(reopened.get(null, key), 'empty-window');
  await preferences.set(project, key, null);
  reopened = await new ApprovalReviewerPreferences(dir).init();
  assert.equal(reopened.get(project, key), null); assert.equal(reopened.get(otherProject, key), 'reviewer-b');
  const saved = await fs.readFile(file, 'utf8');
  assert.equal(saved.includes('test-key'), false); assert.equal(saved.includes('example.invalid'), false);
  assert.equal(saved.includes('encryptedKey'), false);
  assert.ok(JSON.parse(saved).selections.some(([root, id, model]) => root === 'c:\\work\\project' && id === key && model === null));
});

test('invalid values and damaged preference files never silently select a model or overwrite source data', async t => {
  const { dir, file } = await fixture(t), preferences = await new ApprovalReviewerPreferences(dir).init();
  await preferences.set(project, key, 'reviewer-a');
  const original = await fs.readFile(file, 'utf8');
  for (const model of [undefined, '', ' model', 'model\n', '\u202emodel', 'x'.repeat(201), {}, 1])
    await assert.rejects(preferences.set(project, key, model), { code: 'APPROVAL_REVIEWER_INVALID_MODEL' });
  for (const invalidKey of [null, '', '__proto__', 'raw-secret', {}, key.toUpperCase()])
    await assert.rejects(preferences.set(project, invalidKey, null), { code: 'APPROVAL_REVIEWER_INVALID_CONNECTION' });
  await assert.rejects(preferences.set('relative', key, 'reviewer-a'), { code: 'PERMISSION_PREFERENCES_INVALID_PATH' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const valid = ['c:\\work\\project', key, 'reviewer-a'];
  for (const encoded of ['{', 'null', '[]', JSON.stringify({ version: 2, selections: [valid] }),
    JSON.stringify({ version: 1, selections: [valid], extra: true }), ...[
      [valid, valid], [valid, ['__proto__', key, 'reviewer-b']], [valid, [null, 'secret', 'reviewer-b']],
      [valid, [null, otherKey, 'bad\n']], Array(513).fill(valid),
    ].map(selections => JSON.stringify({ version: 1, selections }))]) {
    await fs.writeFile(file, encoded);
    const reopened = await new ApprovalReviewerPreferences(dir).init();
    assert.equal(reopened.get(project, key), null);
    assert.equal(await fs.readFile(file, 'utf8'), encoded);
  }
});

test('queued writes preserve other scopes and failed writes preserve effective state with retry available', async t => {
  const { dir, file } = await fixture(t), preferences = new ApprovalReviewerPreferences(dir);
  const writes = Array.from({ length: 30 }, (_, index) => preferences.set(index % 2 ? project : otherProject, key, `reviewer-${index}`));
  await preferences.settled(); await Promise.all(writes);
  assert.equal(preferences.get(project, key), 'reviewer-29'); assert.equal(preferences.get(otherProject, key), 'reviewer-28');
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(preferences.set(project, key, null), error => {
    assert.equal(error.code, 'APPROVAL_REVIEWER_SAVE_FAILED'); assert.equal(error.message.includes(dir), false); return true;
  });
  assert.equal(preferences.get(project, key), 'reviewer-29');
  assert.deepEqual(await fs.readdir(dir), ['approval-reviewer-preferences.json']);
  await fs.rmdir(file); await preferences.set(project, key, null);
  const reopened = await new ApprovalReviewerPreferences(dir).init();
  assert.equal(reopened.get(project, key), null); assert.equal(reopened.get(otherProject, key), 'reviewer-28');
});

test('the actual main-process selection handler persists before applying and preserves active settings on disk failure', async t => {
  const { dir, file } = await fixture(t), preferences = await new ApprovalReviewerPreferences(dir).init();
  const active = runtime(preferences);
  assert.equal((await active.select({ model: 'reviewer-a' })).model, 'reviewer-a');
  assert.equal(active.approvalReviewerModel, 'reviewer-a'); assert.equal(active.reconciles, 1);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(active.select({ model: 'reviewer-b' }), { code: 'APPROVAL_REVIEWER_SAVE_FAILED' });
  assert.equal(active.approvalReviewerModel, 'reviewer-a'); assert.equal(active.reconciles, 1);
  await fs.rmdir(file); await active.select({ model: null });
  assert.equal(active.approvalReviewerModel, null);
  assert.equal((await new ApprovalReviewerPreferences(dir).init()).get(project, key), null);
});

test('window scopes restore independently, avoid repeated decryption, and remain stable after credential re-encryption', async t => {
  const { dir } = await fixture(t), preferences = await new ApprovalReviewerPreferences(dir).init();
  await preferences.set(project, key, 'reviewer-a'); await preferences.set(project, otherKey, 'provider-reviewer');
  const first = runtime(preferences), second = runtime(preferences);
  first.restore(first.connection); second.restore(second.connection);
  assert.equal(first.approvalReviewerModel, 'reviewer-a'); assert.equal(second.approvalReviewerModel, 'reviewer-a');
  await first.select({ model: 'reviewer-b' });
  second.restore(second.connection); assert.equal(second.approvalReviewerModel, 'reviewer-a', 'broadcasts must not change another open window');
  for (let index = 0; index < 5; index++) second.restore(second.connection);
  assert.equal(second.reads, 1);
  second.store.settings.providers.openai.encryptedKey = 'reencrypted-same-secret';
  second.restore(second.connection);
  assert.equal(second.reads, 2); assert.equal(second.approvalReviewerModel, 'reviewer-a');
  second.connection = connection('relay'); second.restore(second.connection);
  assert.equal(second.approvalReviewerModel, 'provider-reviewer');
  second.connection = connection(); second.restore(second.connection);
  assert.equal(second.approvalReviewerModel, 'reviewer-b');
  const reopened = runtime(await new ApprovalReviewerPreferences(dir).init()); reopened.restore(reopened.connection);
  assert.equal(reopened.approvalReviewerModel, 'reviewer-b');
});

test('a selection saved during a project switch cannot overwrite the newly active scope', async t => {
  const { dir } = await fixture(t), preferences = await new ApprovalReviewerPreferences(dir).init();
  await preferences.set(otherProject, key, 'other-reviewer');
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  const active = runtime({ get: (...args) => preferences.get(...args), set: async (...args) => {
    reached(); await gate; return preferences.set(...args);
  } });
  active.restore(active.connection);
  const selecting = active.select({ model: 'reviewer-a' }); await started;
  active.tools = { root: otherProject }; active.restore(active.connection); release(); await selecting;
  assert.equal(active.approvalReviewerModel, 'other-reviewer'); assert.equal(preferences.get(project, key), 'reviewer-a');
  assert.equal(preferences.get(otherProject, key), 'other-reviewer'); assert.equal(active.reconciles, 0);
});

test('an independent Node process restores the official-account reviewer after transient connection changes', async t => {
  const { dir } = await fixture(t), preferences = await new ApprovalReviewerPreferences(dir).init();
  const official = { provider: 'openai', authMode: 'chatgpt', account: { session: { profileId: 'profile-fixture', status: 'connected', sharing: true } } };
  await preferences.set(project, approvalReviewerConnectionKey(official), 'official-reviewer'); await preferences.settled();
  const script = "const {ApprovalReviewerPreferences,approvalReviewerConnectionKey}=require(process.argv[1]); const c={provider:'openai',authMode:'chatgpt',account:{session:{profileId:'profile-fixture',status:'reauth_required',sharing:false}}}; new ApprovalReviewerPreferences(process.argv[2]).init().then(p=>process.stdout.write(JSON.stringify({model:p.get(process.argv[3],approvalReviewerConnectionKey(c))}))).catch(()=>process.exit(1));";
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', script, modulePath, dir, project], { windowsHide: true, timeout: 10000 });
  assert.equal(stderr, ''); assert.deepEqual(JSON.parse(stdout), { model: 'official-reviewer' });
});
