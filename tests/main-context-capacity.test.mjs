import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { deriveModelCapabilities } from '../src/core/model-catalog.mjs';
import { contextCompressionPolicy } from '../src/core/context-compaction.mjs';
const { modelCapacityConnectionKey, modelCapacityScope, applyModelCapacity } = createRequire(import.meta.url)('../src/core/model-capacity-preferences.cjs');

const source = await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8');
const configSource = source.slice(source.indexOf('async function currentRequestConfig('), source.indexOf('\nasync function recordRunUsage('));
const capabilitiesSource = source.slice(source.indexOf('function capabilitiesFor('), source.indexOf('\nfunction resolvedReasoningEffort('));
const startSource = source.slice(source.indexOf('async function startTask('), source.indexOf('\nasync function runPersistedChangeOperation('));

function fixture({ capacity = 128000, fail = false, model = 'gpt-6.1-sol' } = {}) {
  const snapshots = new Map(), controller = new AbortController();
  const settings = { provider: 'openai', authMode: 'chatgpt', model, reasoningEffort: 'default' };
  const connection = { key: 'fixture-account-a', provider: 'openai', authMode: 'chatgpt', config: {},
    account: { session: { status: 'connected', sharing: true, profileId: 'fixture-account-a' } } };
  let calls = 0, onFetch = () => {};
  const context = vm.createContext({
    publicSettings: () => settings, catalogContext: async () => connection, catalogSnapshots: snapshots,
    fetchModelCatalog: async () => {
      calls++; await onFetch();
      if (fail) throw new Error('Synthetic directory outage');
      snapshots.set(connection.key, { models: [{ id: settings.model, ...(capacity ? { contextWindow: capacity, contextWindowKind: 'total' } : {}) }] });
    },
    deriveModelCapabilities, modelCapacityConnectionKey, modelCapacityScope, applyModelCapacity,
    modelCapacityPreferences: { get: () => null }, metricsConnectionKey: null, metricsModelCapacity: null,
    isAccountMode: mode => mode === 'chatgpt', isExternalAgentMode: () => false, app: { getVersion: () => '0.23.0' },
    accountLabel: () => 'ChatGPT', accountBaseUrl: () => 'https://api.openai.com/v1',
    resolvedReasoningEffort: () => 'default', store: { key: () => '' },
    permissionMode: 'request', configRevision: 1, uiPreferences: {}, currentSession: { messages: [], workspace: 'C:/fixture' },
    promptCompletion: { abort() {} }, requireIdle() {}, requireSharedReady() {}, stopGeneration: 0,
    shuttingDown: false, win: { isDestroyed: () => false },
    normalizeImageAttachments: () => [], requireTools() {}, tools: { root: 'C:/fixture' },
  });
  vm.runInContext(capabilitiesSource + '\n' + configSource + '\n' + startSource, context);
  const run = { controller, connectionKey: connection.key, chatgptProfileId: connection.account.session.profileId };
  return { context, connection, snapshots, controller, run, calls: () => calls,
    onFetch: callback => { onFetch = callback; }, config: () => context.currentRequestConfig(run) };
}

test('the first main-account request reads the account directory and preserves a narrower capacity', async () => {
  const data = fixture();
  const config = await data.config();
  assert.equal(data.calls(), 1);
  assert.equal(config.modelCapabilities.contextWindow, 128000);
  assert.equal(contextCompressionPolicy(config).effectiveTriggerTokens, 102400);
  await data.config(); assert.equal(data.calls(), 1);
});

test('a successfully discovered exact official ID can use its published window when capacity is absent', async () => {
  const data = fixture({ capacity: null });
  const config = await data.config();
  assert.equal(config.modelCapabilities.contextWindow, 1050000);
  assert.equal(contextCompressionPolicy(config).effectiveTriggerTokens, 840000);
});

test('a directory outage keeps the account usable with an unknown capacity instead of assuming a larger window', async () => {
  const data = fixture({ fail: true });
  const config = await data.config();
  assert.equal(data.calls(), 1); assert.equal(config.authMode, 'chatgpt');
  assert.equal(config.modelCapabilities.contextWindow, undefined);
  assert.equal(config.modelCapabilities.supportsTools, true);
  assert.equal(contextCompressionPolicy(config).effectiveTriggerTokens, 45000);
});

test('an absent model entry cannot inherit another model or connection capacity', async () => {
  const data = fixture();
  data.snapshots.set(data.connection.key, { models: [{ id: 'another-model', contextWindow: 2000000 }] });
  const config = await data.config();
  assert.equal(data.calls(), 0); assert.equal(config.modelCapabilities.contextWindow, undefined);
});

test('a connection switch or cancellation during cold directory discovery prevents request planning', async () => {
  const changed = fixture();
  changed.onFetch(() => { changed.connection.key = 'fixture-account-b'; });
  await assert.rejects(changed.config(), /模型连接已变更/);
  const cancelled = fixture();
  cancelled.onFetch(() => { cancelled.controller.abort(); });
  await assert.rejects(cancelled.config(), { name: 'AbortError' });
});

test('starting a task waits for cold account capacity before planning or appending a user message', async () => {
  const data = fixture(), sentinel = new Error('capacity-observed-before-task-start');
  const derive = data.context.capabilitiesFor;
  let observed;
  data.context.capabilitiesFor = (...args) => { observed = derive(...args); throw sentinel; };
  await assert.rejects(data.context.startTask({ text: '检查项目。' }), error => error === sentinel);
  assert.equal(data.calls(), 1); assert.equal(observed.contextWindow, 128000);
  assert.equal(data.context.currentSession.messages.length, 0);
});

test('stopping or closing during cold task discovery preserves the existing session before owner changes', async () => {
  for (const cancel of [context => { context.stopGeneration++; }, context => { context.shuttingDown = true; }]) {
    const data = fixture();
    data.context.capabilitiesFor = () => assert.fail('Cancelled preflight must finish before planning or changing the session owner');
    data.onFetch(() => cancel(data.context));
    const original = JSON.stringify(data.context.currentSession);
    await assert.rejects(data.context.startTask({ text: '检查项目。' }), /任务启动已取消|窗口已关闭/);
    assert.equal(JSON.stringify(data.context.currentSession), original);
  }
});

test('a manually configured unknown model window reaches the real request planner and reset removes it', async () => {
  const data = fixture({ capacity: null, model: 'unknown-fixture-model' });
  let manual = 400000;
  data.context.modelCapacityPreferences.get = () => manual;
  let config = await data.config();
  assert.equal(config.modelCapabilities.contextWindow, 400000);
  assert.equal(config.contextCompressionTriggerTokens, 400000);
  assert.equal(contextCompressionPolicy(config).effectiveTriggerTokens, 320000);
  manual = null;
  config = await data.config();
  assert.equal(config.modelCapabilities.contextWindow, undefined);
  assert.equal(contextCompressionPolicy(config).effectiveTriggerTokens, 45000);
});

test('manual request capacity keeps the declared upper limit and can select a smaller window', async () => {
  const data = fixture({ capacity: 128000 });
  let manual = 256000;
  data.context.modelCapacityPreferences.get = () => manual;
  let config = await data.config();
  assert.equal(config.modelCapabilities.contextWindow, 128000);
  assert.equal(config.contextCompressionTriggerTokens, 128000);
  manual = 64000;
  config = await data.config();
  assert.equal(config.modelCapabilities.contextWindow, 64000);
  assert.equal(contextCompressionPolicy(config).effectiveTriggerTokens, 51200);
});
