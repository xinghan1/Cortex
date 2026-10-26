import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ArkAccount, arkCliNativeExecutablePath } from '../src/core/ark-account.mjs';

test('the native executable resolves outside app.asar while source checkout paths remain unchanged', () => {
  const filename = 'arkcli-windows-amd64.exe';
  const packed = path.resolve('artifacts', 'packaged app', 'resources', 'app.asar', 'node_modules', '@volcengine', 'ark-cli');
  assert.equal(arkCliNativeExecutablePath(packed, filename), path.join(packed, 'bin', filename).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`));
  const source = path.resolve('node_modules', '@volcengine', 'ark-cli');
  assert.equal(arkCliNativeExecutablePath(source, filename), path.join(source, 'bin', filename));
  const unrelated = path.resolve('artifacts', 'app.asar-cache', 'ark-cli');
  assert.equal(arkCliNativeExecutablePath(unrelated, filename), path.join(unrelated, 'bin', filename));
});

function encryptedStorage() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, encryptString: value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }, decryptString: value => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); } };
}
async function fixture(t, options = {}) {
  const base = path.resolve('artifacts', 'test-ark-account'); await fs.mkdir(base, { recursive: true }); const directory = await fs.mkdtemp(path.join(base, 'case-'));
  const calls = [], profiles = new Map(), agents = [], safeStorage = options.safeStorage || encryptedStorage();
  const runtime = { init: async () => {}, publicState: async () => ({ status: 'ready', version: '1.0.42' }), ensure: async () => ({ entry: path.join(directory, 'official-arkcli.exe'), version: '1.0.42' }) };
  const spawnImpl = (entry, args, config) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 72000 + calls.length, stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.finish = (value, code = 0) => { if (value !== undefined) child.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); child.stdout.end(); child.stderr.end(); child.emit('exit', code); child.emit('close', code); };
    child.kill = () => { child.killed = true; child.finish(undefined, 1); return true; };
    const invocation = { entry, args, options: config, child }; calls.push(invocation);
    queueMicrotask(async () => {
      try {
        if (await options.handler?.(invocation)) return;
        const home = config.env.HOME;
        if (args[0] === 'auth' && args[1] === 'login') { profiles.set(home, { name: 'official-profile', type: options.type || 'agent-plan', region: 'cn-beijing', project: 'default', owner_trn: 'trn:iam::account:user/fixture', key: 'PRIVATE_RUNTIME_KEY_' + calls.length }); child.finish('Logged in.\n'); return; }
        const saved = profiles.get(home); assert.ok(saved, 'commands must use the same official isolated home');
        const requested = args.indexOf('--profile'), choice = requested >= 0 ? options.summary?.find(row => row.name === args[requested + 1]) : null;
        const profile = { ...saved, ...(choice || {}) };
        if (args[0] === 'auth' && args[1] === 'status') child.finish({ logged_in: true, active_profile: profile, profiles_summary: options.summary || [profile], ark_api_key: { key: 'PRIVATE****', status: 'active' } });
        else if (args[0] === 'auth' && args[1] === 'whoami') child.finish({ logged_in: true, trn: profile.owner_trn, profile });
        else if (args.slice(0, 3).join('/') === 'profile/apikey/get') child.finish(profile.key + '\n');
        else if (args.slice(0, 2).join('/') === 'resources/list') child.finish({ profile: profile.name, type: profile.type, modality: 'text', current_default: profile.type === 'platform' ? 'ep-official' : 'official-model', item_count: 1,
          items: [{ id: profile.type === 'platform' ? 'ep-official' : 'official-model', resource_kind: profile.type === 'platform' ? 'endpoint' : 'model', data_plane: profile.type.startsWith('agent-plan') ? 'agent_plan' : profile.type.startsWith('coding-plan') ? 'coding_plan' : 'platform', credential_kind: profile.type.endsWith('-team') ? 'team_seat' : profile.type === 'agent-plan' ? 'agent_plan' : 'paygo', invocable: true, is_default: true }] });
        else throw new Error('Unexpected CLI command');
      } catch (error) { child.testError = error; child.finish(undefined, 2); }
    }); return child;
  };
  const config = { dataDir: directory, safeStorage, runtime, spawnImpl, killTreeImpl: async child => child?.kill(), onChange: options.onChange || (() => {}), requestTimeoutMs: 200, loginTimeoutMs: 200, getProxyEnv: () => ({ HTTPS_PROXY: 'http://127.0.0.1:9911', ARK_API_KEY: 'IGNORE_OVERRIDE' }) };
  const create = () => { const agent = new ArkAccount(config); agents.push(agent); return agent; }; const agent = create();
  t.after(async () => { for (const item of agents) await item.dispose(); for (const call of calls) assert.equal(call.child.testError, undefined); assert.equal(path.dirname(directory), base); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, agent, create, calls, profiles, safeStorage, config };
}

test('official browser authorization and documented profile-key export securely bind the exact runtime profile', async t => {
  const f = await fixture(t); await f.agent.init(); assert.equal(f.calls.length, 0); assert.equal((await f.agent.publicState()).session.status, 'disconnected');
  await f.agent.signIn({ profileName: 'official-profile' }); const state = await f.agent.publicState(); assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true);
  assert.deepEqual(f.calls.map(call => call.args.slice(0, 3)), [['auth', 'login', 'volc-sso'], ['auth', 'status', '--format'], ['auth', 'whoami', '--format'], ['auth', 'status', '--profile'], ['auth', 'whoami', '--profile'], ['profile', 'apikey', 'get'], ['resources', 'list', '--profile']]);
  const key = [...f.profiles.values()][0].key; assert.ok(key); assert.equal(f.agent.redact(`key=${key}`), 'key=[已隐藏方舟凭据]');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_RUNTIME_KEY|owner_trn|trn:iam/);
  for (const call of f.calls) { assert.equal(call.options.env.HOME, call.options.env.USERPROFILE); assert.ok(call.options.env.HOME.startsWith(f.directory + path.sep)); assert.equal(call.options.env.ARK_API_KEY, undefined); assert.equal(call.options.env.HTTPS_PROXY, 'http://127.0.0.1:9911'); assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.args.includes('--debug'), false); }
  const persisted = await fs.readFile(path.join(f.directory, 'ark-account', 'connection.json'), 'utf8'); assert.equal(persisted.includes(key), false); assert.equal(persisted.includes('official-profile'), false);
  await f.agent.dispose(); const restarted = f.create(), restored = await restarted.publicState(); assert.equal(restored.session.profileId, state.session.profileId); assert.equal(restored.session.status, 'connected'); assert.equal(f.calls.length, 7);
  const models = await restarted.listModels(); assert.deepEqual(models.map(model => model.id), ['official-model']);
  const result = await restarted.requestModel({ provider: 'doubao', authMode: 'ark-account', arkProfileId: state.session.profileId, model: 'official-model', baseUrl: 'https://evil.example', apiKey: 'OVERRIDE', requestModel: async config => {
    assert.equal(config.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3'); assert.equal(config.apiKey, key); assert.equal(config.authMode, 'apiKey'); assert.equal(config.apiProtocol, 'chat-completions'); assert.match(config.connectionKey, /^ark:/u); return { text: 'done' };
  } }); assert.equal(result.text, 'done');
  await assert.rejects(restarted.requestModel({ provider: 'doubao', authMode: 'ark-account', model: 'invented', requestModel: async () => assert.fail('must not call') }), { code: 'ARK_MODEL_UNAVAILABLE' });
});

test('the five official profile types retain distinct routing and credential scopes', async t => {
  for (const type of ['platform', 'agent-plan', 'coding-plan', 'agent-plan-team', 'coding-plan-team']) await t.test(type, async t => {
    const f = await fixture(t, { type }); await f.agent.signIn({ profileName: 'official-profile' });
    await f.agent.requestModel({ provider: 'doubao', authMode: 'ark-account', model: type === 'platform' ? 'ep-official' : 'official-model', requestModel: async config => {
      assert.equal(config.baseUrl, `https://ark.cn-beijing.volces.com/api/${type.startsWith('agent-plan') ? 'plan/' : type.startsWith('coding-plan') ? 'coding/' : ''}v3`); return {};
    } });
  });
});

test('SSO success with missing or masked runtime credentials never becomes connected', async t => {
  for (const output of ['masked****key\n', '', 'PRIVATE_VALID_KEY\nPRIVATE_EXTRA_LINE']) await t.test(JSON.stringify(output), async t => {
    const f = await fixture(t, { handler: ({ args, child }) => { if (args.slice(0, 3).join('/') !== 'profile/apikey/get') return false; child.finish(output); return true; } });
    await assert.rejects(f.agent.signIn({ profileName: 'official-profile' }), { code: 'ARK_RUNTIME_KEY_UNAVAILABLE' }); assert.equal((await f.agent.publicState()).session.sharing, false);
    assert.equal(f.calls.some(call => call.args[0] === '+chat'), false); assert.deepEqual(await fs.readdir(path.join(f.directory, 'ark-account', 'profiles')), []);
  });
});

test('identity and profile mismatches cannot borrow a sibling profile or overwrite a previous connection', async t => {
  let mismatch = false;
  const f = await fixture(t, { handler: ({ args, child, options }) => {
    if (!mismatch || args.slice(0, 2).join('/') !== 'auth/whoami') return false;
    child.finish({ logged_in: true, trn: 'trn:iam::other:user/other', profile: f.profiles.get(options.env.HOME) }); return true;
  } }); await f.agent.signIn({ profileName: 'official-profile' }); const previous = (await f.agent.publicState()).session.profileId; mismatch = true;
  await assert.rejects(f.agent.signIn({ profileName: 'official-profile' }), { code: 'ARK_ACCOUNT_CHANGED' }); assert.equal((await f.agent.publicState()).session.profileId, previous);
  assert.equal((await f.agent.publicState()).session.sharing, true);
  assert.equal(f.calls.filter(call => call.args.slice(0, 3).join('/') === 'profile/apikey/get').length, 1);
});

test('an unavailable secure store cannot start login or write plaintext fallback credentials', async t => {
  const f = await fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(f.agent.signIn({ profileName: 'official-profile' }), { code: 'ARK_STORAGE_LOCKED' }); assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(path.join(f.directory, 'ark-account', 'connection.json')), { code: 'ENOENT' });
});

test('cancellation stops the official login process and keeps the prior connection', async t => {
  let hold = false, entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { handler: ({ args }) => { if (hold && args.slice(0, 2).join('/') === 'auth/login') { entered(); return true; } return false; } });
  await f.agent.signIn({ profileName: 'official-profile' }); const profileId = (await f.agent.publicState()).session.profileId; hold = true;
  const running = f.agent.signIn({ profileName: 'official-profile' }); await started; const cancellation = f.agent.cancelSignIn(); await assert.rejects(running, { name: 'AbortError' }); await cancellation;
  assert.equal(f.calls.at(-1).child.killed, true); assert.equal((await f.agent.publicState()).session.profileId, profileId);
});

test('account changes reject stale task bindings and abort an in-flight runtime request', async t => {
  const f = await fixture(t); await f.agent.signIn({ profileName: 'official-profile' }); const first = (await f.agent.publicState()).session.profileId;
  await f.agent.signIn({ profileName: 'official-profile' }); const second = (await f.agent.publicState()).session.profileId; assert.notEqual(second, first);
  await assert.rejects(f.agent.requestModel({ provider: 'doubao', authMode: 'ark-account', arkProfileId: first, model: 'official-model', requestModel: async () => assert.fail('must not call') }), { code: 'ARK_ACCOUNT_CHANGED' });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const running = f.agent.requestModel({ provider: 'doubao', authMode: 'ark-account', model: 'official-model', requestModel: async ({ signal }) => { entered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })); } });
  await started; const disconnecting = f.agent.disconnect(); await assert.rejects(running, { name: 'AbortError' }); await disconnecting;
  assert.equal((await f.agent.publicState()).session.status, 'disconnected'); await assert.rejects(fs.stat(path.join(f.directory, 'ark-account', 'connection.json')), { code: 'ENOENT' });
});

test('a runtime 401 requires reconnection while retaining the bound identity for a safe recovery', async t => {
  const f = await fixture(t); await f.agent.signIn({ profileName: 'official-profile' }); const profileId = (await f.agent.publicState()).session.profileId;
  await assert.rejects(f.agent.requestModel({ provider: 'doubao', authMode: 'ark-account', model: 'official-model', requestModel: async () => { throw Object.assign(new Error('rejected'), { status: 401 }); } }), { status: 401 });
  const state = await f.agent.publicState(); assert.equal(state.session.status, 'reauth_required'); assert.equal(state.session.sharing, false); assert.equal(state.session.profileId, profileId);
});

test('resource visibility without matching invocation and credential scope cannot establish a connection', async t => {
  for (const overrides of [{ invocable: false }, { credential_kind: 'paygo' }, { data_plane: 'platform' }, { required_overrides: ['api_key'] }]) await t.test(JSON.stringify(overrides), async t => {
    const f = await fixture(t, { handler: ({ args, child }) => {
      if (args.slice(0, 2).join('/') !== 'resources/list') return false;
      child.finish({ profile: 'official-profile', type: 'agent-plan', modality: 'text', item_count: 1, items: [{ id: 'visible-model', resource_kind: 'model', data_plane: 'agent_plan', credential_kind: 'agent_plan', invocable: true, ...overrides }] }); return true;
    } }); await assert.rejects(f.agent.signIn({ profileName: 'official-profile' }), { code: 'ARK_CATALOG_EMPTY' }); assert.equal((await f.agent.publicState()).session.sharing, false);
  });
});

test('cancelling immediately after atomic credential rename restores the previous encrypted connection', async t => {
  const f = await fixture(t); await f.agent.signIn({ profileName: 'official-profile' }); const before = (await f.agent.publicState()).session.profileId, controller = new AbortController();
  const original = fs.rename; let triggered = false;
  fs.rename = async (from, to) => {
    const result = await original(from, to);
    if (!triggered && to === path.join(f.directory, 'ark-account', 'connection.json')) { triggered = true; controller.abort(); }
    return result;
  };
  try { await assert.rejects(f.agent.signIn({ profileName: 'official-profile', signal: controller.signal }), { name: 'AbortError' }); }
  finally { fs.rename = original; }
  assert.equal((await f.agent.publicState()).session.profileId, before); await f.agent.dispose();
  const restored = await f.create().publicState(); assert.equal(restored.session.profileId, before); assert.equal(restored.session.sharing, true);
});

test('browser login waits for an explicit official profile choice without silently using a pay-as-you-go default', async t => {
  let f, ready; const choosing = new Promise(resolve => { ready = resolve; });
  const summary = [{ name: 'platform-option', type: 'platform', region: 'cn-beijing', project: 'default' }, { name: 'plan-option', type: 'agent-plan', region: 'cn-beijing', project: 'default' }];
  f = await fixture(t, { type: 'platform', summary, onChange: async () => { if (f && (await f.agent.publicState()).attempt?.phase === 'choosing-profile') ready(); } });
  const signing = f.agent.signIn(); await choosing;
  let state = await f.agent.publicState(); assert.equal(state.session.status, 'connecting'); assert.equal(state.session.sharing, false);
  assert.ok(state.profiles.some(profile => profile.name === 'plan-option')); assert.doesNotMatch(JSON.stringify(state.profiles), /PRIVATE|owner_trn/);
  assert.equal(f.calls.some(call => call.args.slice(0, 3).join('/') === 'profile/apikey/get'), false);
  await assert.rejects(f.agent.selectProfile('invented-profile'), { code: 'ARK_PROFILE_UNAVAILABLE' });
  await f.agent.selectProfile('plan-option'); await signing; state = await f.agent.publicState(); assert.equal(state.session.status, 'connected'); assert.equal(state.session.identity.type, 'agent-plan');
  assert.equal(f.calls.filter(call => call.args.slice(0, 2).join('/') === 'auth/login').length, 1);
  await f.agent.requestModel({ provider: 'doubao', authMode: 'ark-account', model: 'official-model', requestModel: async config => { assert.equal(config.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3'); return {}; } });
});

test('even a single platform profile requires confirmation and cancellation interrupts the pending choice', async t => {
  let f, ready; const choosing = new Promise(resolve => { ready = resolve; });
  f = await fixture(t, { type: 'platform', onChange: async () => { if (f && (await f.agent.publicState()).attempt?.phase === 'choosing-profile') ready(); } });
  const signing = f.agent.signIn(); await choosing; assert.equal((await f.agent.publicState()).profiles.length, 1);
  const cancel = f.agent.cancelSignIn(); await assert.rejects(signing, { name: 'AbortError' }); await cancel;
  assert.equal((await f.agent.publicState()).session.sharing, false); assert.equal(f.calls.some(call => call.args.slice(0, 3).join('/') === 'profile/apikey/get'), false);
  await assert.rejects(f.agent.selectProfile('official-profile'), { code: 'ARK_NO_PROFILE_SELECTION' });
});

test('a same-name profile cannot change the user-selected Plan into a platform billing route', async t => {
  const f = await fixture(t, { handler: ({ args, child, options }) => {
    if (args.slice(0, 2).join('/') !== 'auth/status' || !args.includes('--profile')) return false;
    const saved = f.profiles.get(options.env.HOME); child.finish({ logged_in: true, active_profile: { ...saved, type: 'platform' } }); return true;
  } });
  await assert.rejects(f.agent.signIn({ profileName: 'official-profile' }), { code: 'ARK_ACCOUNT_CHANGED' });
  assert.equal(f.calls.some(call => call.args.slice(0, 3).join('/') === 'profile/apikey/get'), false);
  assert.equal((await f.agent.publicState()).session.sharing, false);
});

test('a changed SSO identity after profile discovery cannot bind credentials from another account', async t => {
  const f = await fixture(t, { handler: ({ args, child, options }) => {
    if (!args.includes('--profile') || args[0] !== 'auth') return false;
    const changed = { ...f.profiles.get(options.env.HOME), owner_trn: 'trn:iam::other:user/changed' };
    child.finish(args[1] === 'status' ? { logged_in: true, active_profile: changed } : { logged_in: true, trn: changed.owner_trn, active_profile: changed }); return true;
  } });
  await assert.rejects(f.agent.signIn({ profileName: 'official-profile' }), { code: 'ARK_ACCOUNT_CHANGED' });
  assert.equal(f.calls.some(call => call.args.slice(0, 3).join('/') === 'profile/apikey/get'), false);
});
