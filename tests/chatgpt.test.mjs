import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { ChatGPTConnection } from '../src/core/chatgpt.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const connected = (id = 'profile-one', sharing = true) => ({
  status: 'connected', sharing, profileId: id, profileLabel: id,
  identity: { name: 'Local user', email: 'local@example.com' },
});

function mockSDK(initial = { status: 'disconnected', sharing: false }) {
  const listeners = new Set();
  const mock = {
    state: structuredClone(initial), models: [{ slug: 'test-model', displayName: 'Test model' }],
    accessToken: 'private-chatgpt-access-token', getSessionCalls: 0, listModelsCalls: 0, tokenCalls: 0, cancelCalls: 0,
    profiles: [], signInOptions: null, activeControllers: new Set(),
    publish(state = mock.state) { mock.state = structuredClone(state); for (const listener of listeners) listener(structuredClone(mock.state)); },
    client: {
      subscribe(listener) { listeners.add(listener); listener(structuredClone(mock.state)); return () => listeners.delete(listener); },
      async getSession() { mock.getSessionCalls++; mock.publish(); return structuredClone(mock.state); },
      async listProfiles() {
        return mock.profiles.length ? structuredClone(mock.profiles) : mock.state.profileId ? [{
          id: mock.state.profileId, label: mock.state.profileLabel || mock.state.profileId,
          status: mock.state.status, sharing: mock.state.sharing,
          credentials: { accessToken: mock.accessToken, refreshToken: 'private-refresh-token' },
        }] : [];
      },
      async signIn(options) {
        mock.signInOptions = options;
        if (mock.signInImplementation) return mock.signInImplementation(options);
        mock.publish(connected()); return structuredClone(mock.state);
      },
      cancelSignIn() { mock.cancelCalls++; },
      async selectProfile(id) {
        for (const controller of mock.activeControllers) controller.abort();
        mock.publish(connected(id)); return structuredClone(mock.state);
      },
      async disconnect() {
        for (const controller of mock.activeControllers) controller.abort();
        if (mock.disconnectError?.code !== 'storage_error') mock.publish({ status: 'disconnected', sharing: false, profileId: mock.state.profileId,
          ...(mock.disconnectError?.code === 'revocation_failed' ? { error: { code: 'revocation_failed', message: 'Local credentials removed, remote revocation unconfirmed.', retryable: true } } : {}),
        });
        if (mock.disconnectError) throw mock.disconnectError;
      },
      async listModels({ signal } = {}) {
        mock.listModelsCalls++; signal?.throwIfAborted();
        if (mock.modelError) throw mock.modelError;
        if (mock.listModelsImplementation) return mock.listModelsImplementation({ signal });
        return structuredClone(mock.models);
      },
      async withAccessToken(operation, callerSignal) {
        mock.tokenCalls++;
        const controller = new AbortController(); mock.activeControllers.add(controller);
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        mock.lastCallerSignal = callerSignal; mock.lastSDKSignal = signal;
        try {
          signal.throwIfAborted();
          if (!mock.state.sharing) throw Object.assign(new Error('Scope required'), { code: 'sharing_not_enabled' });
          const value = await operation(mock.accessToken, signal);
          signal.throwIfAborted(); return value;
        } catch (error) {
          // Emulate the SDK's deliberate generic wrapping of foreign errors.
          throw Object.assign(new Error('SDK connection wrapper'), { code: error.name === 'AbortError' ? 'cancelled' : 'connection_error' });
        } finally { mock.activeControllers.delete(controller); }
      },
    },
  };
  return mock;
}

function harness(initial, overrides = {}) {
  const mock = mockSDK(initial);
  let sdkConfig;
  let factories = 0;
  const crypto = {
    available: true,
    isEncryptionAvailable() { return crypto.available; },
    encryptString: text => Buffer.from(`os-encrypted:${text}`),
    decryptString: value => Buffer.from(value).toString().slice(13),
  };
  const opened = [];
  const connection = new ChatGPTConnection({
    dataDir: path.join(os.tmpdir(), 'forgedesk-chatgpt-test'), safeStorage: crypto,
    openExternal: async url => { opened.push(url); },
    createClient: async config => { factories++; sdkConfig = config; return mock.client; },
    ...overrides,
  });
  return { connection, mock, crypto, opened, get sdkConfig() { return sdkConfig; }, get factories() { return factories; } };
}

test('initialization configures official SDK and only returns safe public fields', async () => {
  const h = harness({ ...connected(), accessToken: 'private-chatgpt-access-token', credentials: { refreshToken: 'private-refresh-token' } });
  const state = await h.connection.init();
  assert.equal(h.sdkConfig.appName, 'Synora code');
  assert.equal(h.sdkConfig.appId, 'forgedesk');
  assert.equal(h.sdkConfig.sendHostId, true);
  assert.equal(h.sdkConfig.redirectPort, 0);
  assert.equal(h.sdkConfig.storageDir, path.join(os.tmpdir(), 'forgedesk-chatgpt-test', 'chatgpt'));
  assert.equal(state.session.status, 'connected');
  assert.equal(state.session.sharing, true);
  assert.equal(state.profiles.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /private-chatgpt-access-token|private-refresh-token|credentials|accessToken/);
  const encrypted = await h.sdkConfig.credentialEncryption.encrypt('credential');
  assert.notEqual(Buffer.from(encrypted).toString(), 'credential');
  assert.equal(await h.sdkConfig.credentialEncryption.decrypt(encrypted), 'credential');
});

test('publicState is a side-effect-free snapshot and cannot cause onChange broadcast recursion', async () => {
  let notifications = 0;
  let connection;
  const h = harness(connected(), { onChange: async () => { notifications++; await connection.publicState(); } });
  connection = h.connection;
  await connection.init(); await tick();
  const reads = h.mock.getSessionCalls;
  const changes = notifications;
  for (let index = 0; index < 20; index++) await connection.publicState();
  await tick();
  assert.equal(h.mock.getSessionCalls, reads);
  assert.equal(notifications, changes);
  assert.ok(notifications < 5);
});

test('sign-in without token sharing never lists models or invokes a provider', async () => {
  const h = harness(connected('identity-only', false));
  await h.connection.init();
  assert.deepEqual(await h.connection.listModels(), []);
  assert.equal(h.mock.listModelsCalls, 0);
  let providerCalls = 0;
  await assert.rejects(h.connection.requestModel({ requestModel: async () => { providerCalls++; } }), { code: 'sharing_not_enabled' });
  assert.equal(providerCalls, 0);
  assert.equal(h.mock.tokenCalls, 0);
  assert.equal((await h.connection.publicState()).session.status, 'connected');
});

test('disconnected session cannot send a model request', async () => {
  const h = harness();
  await h.connection.init();
  await assert.rejects(h.connection.requestModel({ requestModel: async () => assert.fail('provider must not run') }), { code: 'sign_in_required' });
  assert.deepEqual(await h.connection.listModels(), []);
});

test('models are cached per profile; catalog failures remain errors and preserve sharing eligibility', async () => {
  const h = harness(connected());
  await h.connection.init();
  assert.deepEqual(await h.connection.listModels(), [{ slug: 'test-model', displayName: 'Test model' }]);
  await h.connection.listModels();
  assert.equal(h.mock.listModelsCalls, 1);
  h.mock.modelError = Object.assign(new Error('Model service offline'), { code: 'network_error', retryable: true });
  await assert.rejects(h.connection.listModels({ force: true }), { code: 'network_error' });
  let state = await h.connection.publicState();
  assert.equal(state.session.sharing, true);
  assert.equal(state.session.status, 'connected');
  assert.equal(state.session.error.code, 'network_error');
  assert.equal(state.models.length, 1);
  h.mock.modelError = null;
  h.mock.models = [{ slug: 'other-model', displayName: 'Other model' }];
  await h.connection.selectProfile('profile-two');
  state = await h.connection.publicState();
  assert.deepEqual(state.models, []);
  assert.equal(state.session.error, undefined);
  assert.deepEqual(await h.connection.listModels(), h.mock.models);
});

test('malformed model catalogs produce explicit errors rather than an empty eligibility result', async () => {
  const h = harness(connected());
  await h.connection.init(); h.mock.models = [{ slug: 'invalid' }];
  await assert.rejects(h.connection.listModels(), { code: 'invalid_model_catalog' });
  assert.equal((await h.connection.publicState()).session.sharing, true);
});

test('signIn waits for authorization and forwards only explicit SDK consent options', async () => {
  const h = harness();
  await h.connection.init();
  let finishAuthorization;
  h.mock.signInImplementation = async () => {
    h.mock.publish({ status: 'connecting', sharing: false });
    await new Promise(resolve => { finishAuthorization = resolve; });
    h.mock.publish(connected()); return structuredClone(h.mock.state);
  };
  let resolved = false;
  const pending = h.connection.signIn({ newProfile: true, reconsent: true, apiKey: 'never-forwarded' }).then(state => { resolved = true; return state; });
  await tick();
  assert.equal(resolved, false);
  assert.equal((await h.connection.publicState()).session.status, 'connecting');
  assert.equal(h.mock.signInOptions.newProfile, true);
  assert.equal(h.mock.signInOptions.reconsent, true);
  assert.equal(h.mock.signInOptions.apiKey, undefined);
  finishAuthorization();
  assert.equal((await pending).session.status, 'connected');
});

test('cancelSignIn aborts the SDK authorization flow without clearing profiles', async () => {
  const h = harness(connected('saved-profile'));
  await h.connection.init();
  h.mock.signInImplementation = async options => {
    h.mock.publish({ ...connected('saved-profile'), status: 'connecting', sharing: false });
    try {
      await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      });
    } finally { h.mock.publish(connected('saved-profile')); }
  };
  const pending = h.connection.signIn({ newProfile: true });
  await tick(); h.connection.cancelSignIn();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.mock.cancelCalls, 1);
  assert.equal((await h.connection.publicState()).session.profileId, 'saved-profile');
  assert.equal((await h.connection.publicState()).profiles.length, 1);
});

test('cancelling while the SDK is loading prevents authorization from opening afterward', async () => {
  const mock = mockSDK();
  let finishLoading;
  const h = harness(undefined, { createClient: () => new Promise(resolve => { finishLoading = () => resolve(mock.client); }) });
  const pending = h.connection.signIn();
  await tick();
  h.connection.cancelSignIn(); finishLoading();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(mock.signInOptions, null);
});

test('concurrent catalog refreshes share one SDK request', async () => {
  const h = harness(connected()); await h.connection.init();
  let complete;
  h.mock.listModelsImplementation = () => new Promise(resolve => { complete = () => resolve(h.mock.models); });
  const requests = Array.from({ length: 5 }, () => h.connection.listModels());
  await tick();
  assert.equal(h.mock.listModelsCalls, 1);
  complete();
  const values = await Promise.all(requests);
  assert.equal(values.length, 5);
  assert.ok(values.every(models => models[0].slug === 'test-model'));
});

test('authorization browser boundary only accepts the official HTTPS authorize endpoint', async () => {
  const h = harness(); await h.connection.init();
  const official = 'https://auth.openai.com/api/accounts/authorize?client_id=registered&state=nonce';
  await h.sdkConfig.openBrowser(official);
  assert.deepEqual(h.opened, [official]);
  for (const url of [
    'http://auth.openai.com/api/accounts/authorize', 'https://auth.openai.com.evil.example/api/accounts/authorize',
    'https://auth.openai.com/api/accounts/logout', 'https://user:pass@auth.openai.com/api/accounts/authorize',
    'https://auth.openai.com/api/accounts/authorize#fragment', 'file:///C:/Windows/system.ini',
  ]) await assert.rejects(h.sdkConfig.openBrowser(url), { code: 'invalid_authorization_url' });
  assert.equal(h.opened.length, 1);
});

test('OS encryption unavailable is visible without breaking initialization or falling back to plaintext', async () => {
  const h = harness(); h.crypto.available = false;
  const state = await h.connection.init();
  assert.equal(state.session.error.code, 'storage_encryption_unavailable');
  assert.equal(h.factories, 0);
  await assert.rejects(h.connection.signIn(), { code: 'storage_encryption_unavailable' });
  assert.equal(h.factories, 0);
  h.crypto.available = true;
  assert.equal((await h.connection.signIn()).session.status, 'connected');
  h.crypto.available = false;
  assert.throws(() => h.sdkConfig.credentialEncryption.encrypt('secret'), { code: 'storage_encryption_unavailable' });
  h.crypto.available = true; h.crypto.getSelectedStorageBackend = () => 'basic_text';
  assert.equal(h.sdkConfig.credentialEncryption.isAvailable(), false);
});

test('request token and refreshing are delegated to the SDK and endpoint overrides cannot escape OpenAI', async () => {
  const h = harness(connected()); await h.connection.init();
  const sessionReads = h.mock.getSessionCalls;
  const caller = new AbortController();
  const onTextDelta = () => {}, onProgress = () => {};
  const received = [];
  const requestModel = async options => { received.push(options); return { message: 'ok' }; };
  const options = {
    requestModel, provider: 'deepseek', baseUrl: 'https://evil.example', authMode: 'api', apiKey: 'attacker-key',
    model: 'test-model', messages: [{ role: 'user', content: 'hello' }], tools: [],
    signal: caller.signal, onTextDelta, onProgress,
  };
  assert.deepEqual(await h.connection.requestModel(options), { message: 'ok' });
  h.mock.accessToken = 'rotated-sdk-access-token';
  await h.connection.requestModel(options);
  assert.equal(h.mock.tokenCalls, 2);
  assert.equal(h.mock.getSessionCalls, sessionReads, 'request preflight must not add a non-cancellable SDK metadata read');
  assert.equal(received[0].provider, 'openai');
  assert.equal(received[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(received[0].authMode, 'chatgpt');
  assert.equal(received[0].apiKey, 'private-chatgpt-access-token');
  assert.equal(received[1].apiKey, 'rotated-sdk-access-token');
  assert.equal(received[1].signal, h.mock.lastSDKSignal);
  assert.equal(h.mock.lastCallerSignal, caller.signal);
  assert.equal(received[0].onTextDelta, onTextDelta);
  assert.equal(received[0].onProgress, onProgress);
  const publicState = await h.connection.publicState();
  assert.doesNotMatch(JSON.stringify(publicState), /private-chatgpt-access-token|rotated-sdk-access-token|attacker-key/);
  assert.doesNotMatch(h.connection.redact('private-chatgpt-access-token rotated-sdk-access-token'), /private-chatgpt-access-token|rotated-sdk-access-token/);
});

test('provider errors keep their original details instead of being generically rewrapped by the SDK', async () => {
  const h = harness(connected()); await h.connection.init();
  const providerError = Object.assign(new Error('quota restriction'), { code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw providerError; } }), error => error === providerError && error.status === 429);
  const reflected = Object.assign(new Error(`rejected ${h.mock.accessToken}`), { code: 'provider_test_error' });
  await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw reflected; } }), error => error === reflected && !error.message.includes(h.mock.accessToken));
  assert.equal((await h.connection.publicState()).session.sharing, true);
});

test('caller cancellation reaches the provider through the SDK combined signal', async () => {
  const h = harness(connected()); await h.connection.init();
  const controller = new AbortController();
  const pending = h.connection.requestModel({ signal: controller.signal, requestModel: async ({ signal }) => {
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
  } });
  await tick(); controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});

test('disconnect clears local connection state and warns if remote revocation was not confirmed', async () => {
  const h = harness(connected()); await h.connection.init(); await h.connection.listModels();
  h.mock.disconnectError = Object.assign(new Error('Remote revocation unconfirmed'), { code: 'revocation_failed' });
  const state = await h.connection.disconnect();
  assert.equal(state.session.status, 'disconnected');
  assert.equal(state.session.sharing, false);
  assert.deepEqual(state.models, []);
  assert.match(state.warning, /本机.*已移除.*远程撤销/);
  const restoredWarning = await h.connection.publicState();
  assert.equal(restoredWarning.session.error.code, 'revocation_failed');
  assert.match(restoredWarning.session.error.message, /本机.*已移除.*远程撤销/);
  const other = harness(connected()); await other.connection.init();
  other.mock.disconnectError = Object.assign(new Error('Storage write failed'), { code: 'storage_error' });
  await assert.rejects(other.connection.disconnect(), { code: 'storage_error' });
  assert.equal((await other.connection.publicState()).session.status, 'connected');
});

test('account usage starts unknown and exposes no invented percentage/reset or extra SDK reads', async () => {
  for (const [session, expected] of [
    [{ status: 'disconnected', sharing: false }, 'not_connected'],
    [connected('identity-only', false), 'not_authorized'],
    [connected(), 'unknown'],
  ]) {
    const h = harness(session);
    await h.connection.init();
    const reads = h.mock.getSessionCalls;
    for (let index = 0; index < 10; index++) {
      const state = await h.connection.publicState();
      assert.deepEqual(state.usage, { status: expected, source: 'unavailable', checkedAt: null, stale: false });
      assert.deepEqual(Object.keys(state.usage).sort(), ['checkedAt', 'source', 'stale', 'status']);
    }
    assert.equal(h.mock.getSessionCalls, reads);
    assert.equal(h.mock.tokenCalls, 0);
    assert.equal(h.mock.listModelsCalls, 0);
  }
});

test('official request observations distinguish recent success, limits, unavailable and ineligible without estimating a balance', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z');
  const h = harness(connected(), { clock: () => now });
  await h.connection.init();
  const success = async () => {
    const value = { message: { content: 'Official request fixture succeeded' } };
    assert.equal(await h.connection.requestModel({ requestModel: async () => value }), value);
    assert.deepEqual((await h.connection.publicState()).usage, {
      status: 'request_succeeded', source: 'official_response', checkedAt: new Date(now).toISOString(), stale: false,
    });
  };
  await success();
  for (const [code, status] of [
    ['CHATGPT_USAGE_LIMIT_EXCEEDED', 'limit_reached'], ['subscription_sharing_usage_limit_exceeded', 'limit_reached'],
    ['CHATGPT_USAGE_UNAVAILABLE', 'unavailable'], ['subscription_sharing_usage_unavailable', 'unavailable'],
    ['CHATGPT_NOT_ELIGIBLE', 'not_eligible'], ['subscription_sharing_user_not_eligible', 'not_eligible'],
    ['subscription_sharing_v2_user_not_eligible', 'not_eligible'],
  ]) {
    now += 1000;
    const error = Object.assign(new Error(`private diagnostic ${h.mock.accessToken}`), { code });
    await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw error; } }), candidate => candidate === error);
    const observed = (await h.connection.publicState()).usage;
    assert.deepEqual(observed, { status, source: 'official_response', checkedAt: new Date(now).toISOString(), stale: false });
    assert.doesNotMatch(error.message, /private-chatgpt-access-token/u);
    assert.doesNotMatch(JSON.stringify(observed), /percent|remaining|reset|balance|credentials|private diagnostic/u);
  }
  now += 1000;
  await success();
});

test('generic HTTP/network errors and error text do not infer exhausted account quota or refresh an old observation', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z');
  const h = harness(connected(), { clock: () => now });
  await h.connection.init();
  for (const code of ['PROVIDER_HTTP_429', 'PROVIDER_HTTP_401', 'PROVIDER_NETWORK_ERROR', 'PROVIDER_TIMEOUT', 'cancelled']) {
    const error = Object.assign(new Error('subscription_sharing_usage_limit_exceeded 0% remaining in untrusted error text'), { code });
    await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw error; } }), candidate => candidate === error);
    assert.equal((await h.connection.publicState()).usage.status, 'unknown');
  }
  const exact = Object.assign(new Error('quota fixture'), { code: 'PROVIDER_HTTP_429', serviceCode: 'subscription_sharing_usage_limit_exceeded' });
  await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw exact; } }));
  const before = (await h.connection.publicState()).usage;
  now += 1000;
  await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw Object.assign(new Error('network fixture'), { code: 'PROVIDER_NETWORK_ERROR' }); } }));
  assert.deepEqual((await h.connection.publicState()).usage, before, 'An unrelated failure cannot claim a fresh quota check');
});

test('usage observations stay with their profile and disconnect clears the selected account record', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z');
  const h = harness(connected('profile-one'), { clock: () => now });
  await h.connection.init();
  await assert.rejects(h.connection.requestModel({ requestModel: async () => { throw Object.assign(new Error('limit fixture'), { code: 'CHATGPT_USAGE_LIMIT_EXCEEDED' }); } }));
  const first = (await h.connection.publicState()).usage;
  await h.connection.selectProfile('profile-two');
  assert.equal((await h.connection.publicState()).usage.status, 'unknown');
  now += 1000;
  await h.connection.requestModel({ requestModel: async () => ({ message: 'profile two request' }) });
  const second = (await h.connection.publicState()).usage;
  await h.connection.selectProfile('profile-one');
  assert.deepEqual((await h.connection.publicState()).usage, first);
  await h.connection.disconnect();
  assert.equal((await h.connection.publicState()).usage.status, 'not_connected');
  h.mock.publish(connected('profile-one'));
  assert.equal((await h.connection.publicState()).usage.status, 'unknown');
  await h.connection.selectProfile('profile-two');
  assert.deepEqual((await h.connection.publicState()).usage, second);
});

test('usage expires after five minutes without new network activity, fake resets or repeated notifications', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z'), notifications = 0;
  const h = harness(connected(), { clock: () => now, onChange: () => { notifications++; } });
  await h.connection.init(); await tick(); notifications = 0;
  await h.connection.requestModel({ requestModel: async () => ({ message: 'ok' }) });
  await tick();
  assert.equal(notifications, 1);
  const checked = (await h.connection.publicState()).usage.checkedAt;
  const reads = h.mock.getSessionCalls, tokenCalls = h.mock.tokenCalls;
  now += 5 * 60 * 1000 - 1;
  assert.equal((await h.connection.publicState()).usage.stale, false);
  now++;
  for (let index = 0; index < 10; index++) {
    assert.deepEqual((await h.connection.publicState()).usage, { status: 'request_succeeded', source: 'official_response', checkedAt: checked, stale: true });
  }
  await tick();
  assert.equal(h.mock.getSessionCalls, reads);
  assert.equal(h.mock.tokenCalls, tokenCalls);
  assert.equal(notifications, 1);
});

test('a late request from a previous account cannot populate the current account usage or revive the old snapshot', async () => {
  let now = Date.parse('2026-10-19T01:00:00.000Z'), finish;
  const h = harness(connected('profile-one'), { clock: () => now });
  await h.connection.init();
  const first = h.connection.requestModel({ requestModel: () => new Promise(resolve => { finish = resolve; }) });
  await tick();
  h.mock.publish(connected('profile-two'));
  now += 1000;
  await h.connection.requestModel({ requestModel: async () => ({ message: 'profile two' }) });
  const current = (await h.connection.publicState()).usage;
  now += 1000;
  finish({ message: 'late profile one' });
  await first;
  assert.deepEqual((await h.connection.publicState()).usage, current);
  await h.connection.selectProfile('profile-one');
  assert.equal((await h.connection.publicState()).usage.status, 'unknown');
});

test('usage observers cannot break successful model requests and public snapshots remain detached and credential-free', async () => {
  let clockBroken = false;
  const h = harness(connected(), {
    clock: () => { if (clockBroken) throw new Error('clock fixture failed'); return Date.parse('2026-10-19T01:00:00.000Z'); },
    onChange: async () => { throw new Error('observer fixture failed'); },
  });
  await h.connection.init(); await tick();
  clockBroken = true;
  const value = { message: 'provider result must survive observer failures' };
  assert.equal(await h.connection.requestModel({ requestModel: async () => value }), value);
  assert.equal((await h.connection.publicState()).usage.status, 'unknown');
  clockBroken = false;
  await h.connection.requestModel({ requestModel: async () => value });
  await tick();
  const state = await h.connection.publicState();
  state.usage.status = 'forged percentage';
  const actual = await h.connection.publicState();
  assert.equal(actual.usage.status, 'request_succeeded');
  assert.doesNotMatch(JSON.stringify(actual), /private-chatgpt-access-token|private-refresh-token|credentials|accessToken|remainingPercent|resetAt/u);
});
