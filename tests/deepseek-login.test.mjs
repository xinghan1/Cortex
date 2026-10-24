import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DeepSeekConnection, DEEPSEEK_ACCOUNT_BASE } from '../src/core/deepseek-login.mjs';
import { requestModel } from '../src/core/providers.mjs';
import { RoleModelRuntime, MODEL_ROLES } from '../src/core/role-model-runtime.mjs';
import { deriveModelCapabilities } from '../src/core/model-catalog.mjs';

const { Store } = createRequire(import.meta.url)('../src/core/store.cjs');
const { RoleModels } = createRequire(import.meta.url)('../src/core/role-models.cjs');
const root = path.resolve('tests/.tmp');
const token = 'test-deepseek-account-credential-DO-NOT-EXPOSE';
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`cipher:${value}`),
  decryptString: value => { const text = value.toString(); if (!text.startsWith('cipher:')) throw Error('Unreadable'); return text.slice(7); } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const envelope = value => Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
const listing = () => Response.json({ data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash',
  input_modalities: ['text', 'image'], output_modalities: ['text'], context_window: 1000000, max_output_tokens: 256000,
  api_capabilities: { anthropic_messages: {} } }, { id: 'unsupported', api_capabilities: {} }] });

async function fixture(t, options = {}) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'deepseek-account-'));
  const calls = [], opens = [], callbacks = []; let init, connection;
  const fetchImpl = async (url, request) => {
    assert.equal(request.redirect, 'error');
    const pathname = new URL(url).pathname, body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ url, request, body });
    if (options.fetchImpl) {
      const response = await options.fetchImpl({ url, pathname, request, body });
      if (response !== undefined) return response;
    }
    if (pathname.endsWith('/auth_init')) {
      init = body;
      return envelope({ authorize_id: randomUUID(), authorize_url: 'https://platform.deepseek.com/dsh/authorize?attempt=private', expires_in: 600 });
    }
    if (pathname.endsWith('/auth_exchange')) return envelope({ token, authorized_url: 'https://platform.deepseek.com/dsh/authorized?done=yes',
      user: { id: 'not-exposed-account-id', email: 'q1****@example.com', id_profile: { name: 'My DeepSeek' } } });
    if (pathname === '/models') return listing();
    if (pathname === '/anthropic/v1/messages') return Response.json({ id: 'model-message', type: 'message', role: 'assistant', model: 'deepseek-flash',
      content: [{ type: 'text', text: 'Account transport works' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 3 } });
    return envelope({});
  };
  const openExternal = async url => {
    opens.push(url);
    assert.equal(new URL(url).origin, 'https://platform.deepseek.com');
    assert.equal(new URL(url).pathname, '/dsh/authorize');
    if (options.openExternal) return options.openExternal({ url, init, connection, dir });
    const callback = new URL(init.redirect_uri); callback.searchParams.set('code', 'browser-code'); callback.searchParams.set('state', init.state);
    callbacks.push(fetch(callback, { redirect: 'manual' }));
  };
  const create = overrides => new DeepSeekConnection({ dataDir: dir, safeStorage: crypto, version: '0.21.0',
    openExternal, fetchImpl, ...overrides });
  connection = create(options.config); await connection.init();
  t.after(async () => {
    await connection.dispose(); await Promise.allSettled(callbacks);
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(dir).startsWith('deepseek-account-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { connection, create, dir, calls, opens, callbacks, get init() { return init; } };
}

test('browser PKCE login saves an encrypted grant before completion, restores identity, and isolates account from API keys', async t => {
  const data = await fixture(t);
  assert.equal((await data.connection.publicState()).session.status, 'disconnected');
  const state = await data.connection.signIn();
  assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true);
  assert.deepEqual(state.session.identity, { name: 'My DeepSeek', contact: 'q1****@example.com' });
  assert.match(state.session.profileId, /^[a-f\d-]{36}$/u);
  const initialization = data.calls.find(call => call.url.endsWith('/auth_init'));
  const exchange = data.calls.find(call => call.url.endsWith('/auth_exchange'));
  assert.equal(initialization.request.headers['user-agent'], 'Synora-code/0.21.0');
  assert.equal(initialization.request.headers['x-client-version'], '0.21.0');
  assert.equal(initialization.request.headers['x-client-bundle-id'], '');
  assert.equal(initialization.body.code_challenge_method, 'S256');
  assert.equal(initialization.body.code_challenge, createHash('sha256').update(exchange.body.code_verifier).digest('base64url'));
  assert.equal(exchange.body.redirect_uri, initialization.body.redirect_uri);
  assert.equal(exchange.body.code, 'browser-code');
  assert.equal(new URL(initialization.body.redirect_uri).hostname, '127.0.0.1');
  const callback = await data.callbacks[0];
  assert.equal(callback.status, 303); assert.equal(new URL(callback.headers.get('location')).pathname, '/dsh/authorized');
  assert.equal(new URL(callback.headers.get('location')).searchParams.get('login_source'), 'desktop');
  const stored = await fs.readFile(path.join(data.dir, 'deepseek-account.json'), 'utf8');
  assert.equal(stored.includes(token), false); assert.equal(stored.includes('browser-code'), false);
  const restored = data.create(); t.after(() => restored.dispose()); await restored.init();
  assert.deepEqual((await restored.publicState()).session, state.session);
  const models = await data.connection.listModels();
  assert.equal(models[0].id, 'deepseek-flash'); assert.equal(models[0].supportsImages, true);
  assert.equal(models[1].compatible, false); assert.equal(models[0].contextWindow, 1000000);
  const catalog = data.calls.find(call => call.url.endsWith('/models'));
  assert.equal(catalog.url, 'https://api.deepseek.com/models');
  assert.equal(catalog.request.headers['x-dsh-auth-token'], token);
  assert.equal(new Headers(catalog.request.headers).has('authorization'), false);
  assert.equal(JSON.stringify(await data.connection.publicState()).includes(token), false);
  assert.equal(JSON.stringify(await data.connection.publicState()).includes('code_verifier'), false);
  let sent;
  await data.connection.requestModel({ provider: 'deepseek', authMode: 'deepseek-account', deepseekProfileId: state.session.profileId,
    apiKey: 'should-not-be-used', baseUrl: 'https://untrusted.example', model: 'deepseek-flash', requestModel: async config => { sent = config; return {}; } });
  assert.equal(sent.baseUrl, DEEPSEEK_ACCOUNT_BASE); assert.equal(sent.apiKey, token);
  const inference = await data.connection.requestModel({ provider: 'deepseek', authMode: 'deepseek-account',
    model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }], requestModel,
    fetchImpl: () => { throw Error('Caller must not replace private account transport'); } });
  assert.equal(inference.message.content, 'Account transport works');
  assert.equal(data.calls.filter(call => call.url.endsWith('/anthropic/v1/messages')).length, 1);
  await assert.rejects(data.connection.requestModel({ provider: 'deepseek', authMode: 'deepseek-account', deepseekProfileId: 'old-generation', requestModel }), /账号已变化/);
  await data.connection.disconnect();
  const signedOut = data.create(); t.after(() => signedOut.dispose()); await signedOut.init();
  assert.equal((await signedOut.publicState()).session.status, 'disconnected');
  await assert.rejects(signedOut.listModels(), { code: 'DEEPSEEK_SIGN_IN_REQUIRED' });
});

test('invalid, repeated, non-GET or wrong-host callbacks never exchange a code', async t => {
  const data = await fixture(t, { openExternal: async ({ init }) => {
    const base = new URL(init.redirect_uri); base.searchParams.set('code', 'browser-code');
    base.searchParams.set('state', 'wrong'); assert.equal((await fetch(base)).status, 400);
    base.searchParams.set('state', init.state); base.searchParams.append('state', init.state);
    assert.equal((await fetch(base)).status, 400); base.searchParams.delete('state'); base.searchParams.set('state', init.state);
    assert.equal((await fetch(base, { method: 'POST' })).status, 400);
    const callback = fetch(base, { redirect: 'manual' }); void callback.catch(() => {});
  } });
  await data.connection.signIn();
  assert.equal(data.calls.filter(call => call.url.endsWith('/auth_exchange')).length, 1);
});

test('local cancellation wins over delayed exchange and remote cancellation cannot block the UI', async t => {
  const exchange = deferred(), entered = deferred(), callbackDone = deferred();
  const data = await fixture(t, { fetchImpl: async ({ pathname }) => {
    if (pathname.endsWith('/auth_exchange')) { entered.resolve(); return exchange.promise; }
    if (pathname.endsWith('/auth_cancel')) return new Promise(() => {});
  }, openExternal: ({ init }) => {
    const url = new URL(init.redirect_uri); url.searchParams.set('state', init.state); url.searchParams.set('code', 'old-code');
    fetch(url, { redirect: 'manual' }).then(callbackDone.resolve, callbackDone.resolve);
  } });
  const pending = data.connection.signIn(), rejection = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  await data.connection.cancelSignIn(); await rejection;
  exchange.resolve(envelope({ token, authorized_url: 'https://platform.deepseek.com/dsh/authorized' }));
  await callbackDone.promise; await tick();
  assert.equal((await data.connection.publicState()).session.status, 'disconnected');
  assert.equal((await fs.readFile(path.join(data.dir, 'deepseek-account.json'), 'utf8')).includes('encryptedGrant'), false);
  assert.equal(data.calls.some(call => call.url.endsWith('/auth_cancel')), true);
});

test('authorization URLs stay on the official fixed path and timeout closes the loopback listener', async t => {
  for (const authorize_url of ['https://evil.example/dsh/authorize', 'https://platform.deepseek.com/other',
    'https://name:password@platform.deepseek.com/dsh/authorize', 'https://platform.deepseek.com/dsh/authorize#fragment']) {
    const data = await fixture(t, { fetchImpl: ({ pathname }) => pathname.endsWith('/auth_init')
      ? envelope({ authorize_id: 'attempt', authorize_url, expires_in: 600 }) : undefined });
    await assert.rejects(data.connection.signIn(), { code: 'DEEPSEEK_INVALID_RESPONSE' });
    assert.equal(data.opens.length, 0);
  }
  let callback;
  const expires = await fixture(t, { config: { attemptTimeoutMs: 40 }, openExternal: ({ init }) => { callback = init.redirect_uri; } });
  await assert.rejects(expires.connection.signIn(), { code: 'DEEPSEEK_LOGIN_EXPIRED' });
  await assert.rejects(fetch(callback));
});

test('corrupt or temporarily undecryptable credentials are preserved, never silently overwritten', async t => {
  const data = await fixture(t); await data.connection.signIn();
  const file = path.join(data.dir, 'deepseek-account.json'), original = await fs.readFile(file, 'utf8');
  let unlocked = false;
  const locked = data.create({ safeStorage: { ...crypto, decryptString: value => { if (!unlocked) throw Error('Locked'); return crypto.decryptString(value); } } });
  t.after(() => locked.dispose()); await locked.init();
  assert.equal((await locked.publicState()).storageRecovery, true);
  await assert.rejects(locked.signIn(), { code: 'DEEPSEEK_STORAGE_UNREADABLE' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  unlocked = true; await locked.retryLocalRead(); assert.equal((await locked.publicState()).session.status, 'connected');
  const insecure = data.create({ safeStorage: { ...crypto, getSelectedStorageBackend: () => 'basic_text' } });
  t.after(() => insecure.dispose()); await insecure.init();
  assert.equal((await insecure.publicState()).storageRecovery, true);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('explicit disconnect clears an unreadable local login and allows a fresh authorization', async t => {
  const data = await fixture(t), file = path.join(data.dir, 'deepseek-account.json');
  await fs.writeFile(file, '{invalid-json');
  const recovery = data.create(); t.after(() => recovery.dispose()); await recovery.init();
  assert.equal((await recovery.publicState()).storageRecovery, true);
  await recovery.disconnect();
  assert.equal((await recovery.publicState()).session.status, 'disconnected');
  assert.equal((await recovery.publicState()).storageRecovery, false);
  await recovery.signIn(); assert.equal((await recovery.publicState()).session.status, 'connected');
});

test('a rejected old request cannot clear a replacement login and every authorization receives a new generation', async t => {
  const reply = deferred(); let delay = true;
  const data = await fixture(t, { fetchImpl: ({ pathname }) => pathname === '/models' && delay ? reply.promise : undefined });
  const first = await data.connection.signIn();
  const old = data.connection.listModels(), failed = assert.rejects(old, { code: 'DEEPSEEK_SIGN_IN_REQUIRED' });
  await tick();
  const second = await data.connection.signIn(); assert.notEqual(second.session.profileId, first.session.profileId);
  reply.resolve(new Response('', { status: 401 })); await failed;
  assert.equal((await data.connection.publicState()).session.profileId, second.session.profileId);
  delay = false; assert.equal((await data.connection.listModels()).length, 2);
});

test('account transport uses official Messages, x-dsh-auth-token and thinking effort, preserves native tool state', async () => {
  const secret = 'account-private-token', calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request, body: JSON.parse(request.body) });
    return Response.json({ id: 'message', type: 'message', role: 'assistant', model: 'deepseek-flash',
      content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'native-signature' },
        { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'one.txt' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 5 } });
  };
  const base = { provider: 'deepseek', authMode: 'deepseek-account', apiKey: secret, model: 'deepseek-flash', fetchImpl,
    messages: [{ role: 'user', content: 'read it' }], tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }] };
  const response = await requestModel({ ...base, reasoningEffort: 'high' });
  const sent = calls[0];
  assert.equal(sent.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(sent.request.headers['x-dsh-auth-token'], secret);
  assert.equal(Object.hasOwn(sent.request.headers, 'Authorization'), false);
  assert.equal(Object.hasOwn(sent.request.headers, 'x-api-key'), false);
  assert.equal(sent.request.redirect, 'error');
  assert.deepEqual(sent.body.thinking, { type: 'enabled' }); assert.deepEqual(sent.body.output_config, { effort: 'high' });
  assert.equal(response.message.providerState.content[0].signature, 'native-signature');
  assert.equal(response.message.toolCalls[0].id, 'call-1');
  await requestModel({ ...base, messages: [...base.messages, response.message, { role: 'tool', toolCallId: 'call-1', content: 'contents' }], reasoningEffort: 'none' });
  assert.equal(calls[1].body.messages[1].content[0].signature, 'native-signature');
  assert.deepEqual(calls[1].body.thinking, { type: 'disabled' });
  for (const baseUrl of ['https://evil.example/anthropic/v1', 'http://127.0.0.1/v1', 'https://api.deepseek.com'])
    await assert.rejects(requestModel({ ...base, baseUrl }), { code: 'INVALID_DEEPSEEK_ACCOUNT_BASE_URL' });
  assert.equal(calls.length, 2);
  await assert.rejects(requestModel({ ...base, provider: 'openai' }), { code: 'INVALID_AUTH_MODE' });
});

test('DeepSeek API key and account model choices survive switching and restart without changing the API credential', async t => {
  const data = await fixture(t), store = new Store(data.dir, crypto); await store.init();
  await store.saveSettings({ provider: 'deepseek', authMode: 'apiKey', model: 'api-model', apiKey: 'separate-api-key' });
  await store.saveSettings({ provider: 'deepseek', authMode: 'deepseek-account', model: 'account-model' });
  await store.saveSettings({ provider: 'deepseek', authMode: 'apiKey' });
  assert.equal(store.publicSettings().model, 'api-model');
  await store.saveSettings({ provider: 'deepseek', authMode: 'deepseek-account' });
  const restored = new Store(data.dir, crypto); await restored.init();
  assert.equal(restored.publicSettings().authMode, 'deepseek-account'); assert.equal(restored.publicSettings().model, 'account-model');
  assert.equal(restored.key('deepseek'), 'separate-api-key');
  assert.equal(JSON.stringify(restored.publicSettings()).includes('separate-api-key'), false);
});

test('independent role login is persisted, dispatches through its own account, and rejects replaced credentials', async t => {
  const data = await fixture(t), configs = await new RoleModels(data.dir, crypto).init();
  const accounts = new Map(MODEL_ROLES.map(role => [role, { publicState: async () => ({ session: { status: 'disconnected', sharing: false } }) }]));
  const deepseekAccounts = new Map();
  for (const role of MODEL_ROLES) {
    const account = data.create({ dataDir: path.join(data.dir, 'role-accounts', role) }); await account.init();
    t.after(() => account.dispose()); deepseekAccounts.set(role, account);
  }
  const approval = deepseekAccounts.get('approval'); await approval.signIn();
  const runtime = new RoleModelRuntime({ configs, accounts, deepseekAccounts, deriveCapabilities: deriveModelCapabilities,
    catalog: { list: () => { throw Error('Account role cannot call the API-key catalog'); } }, requestModel });
  const input = { provider: 'deepseek', authMode: 'deepseek-account' }, preview = await runtime.preview('approval', input);
  await runtime.save('approval', { ...input, model: 'deepseek-flash', selectionToken: preview.selectionToken });
  const configuration = await runtime.config('approval');
  assert.equal(configuration.deepseekProfileId, (await approval.publicState()).session.profileId);
  const result = await runtime.dispatch({ ...configuration, messages: [{ role: 'user', content: 'review' }], tools: [] });
  assert.equal(result.message.content, 'Account transport works');
  assert.equal((await data.connection.publicState()).session.status, 'disconnected');
  assert.equal((await deepseekAccounts.get('subagent').publicState()).session.status, 'disconnected');
  const restored = await new RoleModels(data.dir, crypto).init();
  assert.equal(restored.publicState().approval.settings.authMode, 'deepseek-account');
  assert.equal(restored.publicState().approval.settings.model, 'deepseek-flash');
  await approval.signIn();
  await assert.rejects(runtime.dispatch({ ...configuration, messages: [{ role: 'user', content: 'old' }] }), /授权已变化/);
});

test('legacy role provider records migrate DeepSeek API selection without losing the independent key', async t => {
  const data = await fixture(t), roles = await new RoleModels(data.dir, crypto).init();
  await roles.save('approval', { provider: 'deepseek', model: 'legacy-api-model', apiKey: 'legacy-role-api-key' });
  const file = path.join(data.dir, 'role-models.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const role of MODEL_ROLES) {
    delete saved.roles[role].settings.providers.deepseek.authMode;
    delete saved.roles[role].settings.providers.deepseek.modelsByAuth;
  }
  await fs.writeFile(file, JSON.stringify(saved));
  const restored = await new RoleModels(data.dir, crypto).init();
  assert.equal(restored.publicState().approval.settings.authMode, 'apiKey');
  assert.equal(restored.publicState().approval.settings.model, 'legacy-api-model');
  assert.equal(restored.key('approval', 'deepseek'), 'legacy-role-api-key');
});
