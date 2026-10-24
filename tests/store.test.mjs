import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { Store } = require('../src/core/store.cjs');
const testRoot = path.resolve('tests', '.tmp');
const mockCrypto = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from('encrypted:' + text), decryptString: bytes => bytes.toString().slice(10) };
async function fixture(t, { initialize = true } = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'store-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(dir).startsWith('store-'));
    return fs.rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir, mockCrypto); if (initialize) await store.init(); return store;
}
test('settings retain key when blank and never expose it in renderer state', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'openai', model: 'test', apiKey: 'secret-key', baseUrl: 'https://api.openai.com/v1' });
  assert.equal(store.key('openai'), 'secret-key');
  assert.ok(!JSON.stringify(store.publicSettings()).includes('secret-key'));
  await store.saveSettings({ provider: 'openai', model: 'test2', apiKey: '', baseUrl: 'https://api.openai.com/v1' });
  assert.equal(store.key('openai'), 'secret-key');
  await store.saveSettings({ provider: 'openai', clearKey: true });
  assert.equal(store.key('openai'), '');
});

test('OpenAI API protocol survives restart and is public without exposing credentials', async t => {
  const store = await fixture(t);
  assert.equal(store.publicSettings().providers.openai.apiProtocol, 'responses');
  await store.saveSettings({ provider: 'openai', model: 'proxy-model', apiProtocol: 'chat-completions', apiKey: 'fake-proxy-key' });
  const settings = store.publicSettings();
  assert.equal(settings.apiProtocol, 'chat-completions');
  assert.equal(settings.providers.openai.apiProtocol, 'chat-completions');
  assert.equal(settings.hasKey, true);
  assert.ok(!JSON.stringify(settings).includes('fake-proxy-key'));
  assert.ok(!JSON.stringify(settings).includes('encryptedKey'));
  assert.equal(Object.hasOwn(settings.providers.deepseek, 'apiProtocol'), false);
  assert.equal(Object.hasOwn(settings.providers.anthropic, 'apiProtocol'), false);
  const restored = new Store(store.dir, mockCrypto); await restored.init();
  assert.equal(restored.publicSettings().apiProtocol, 'chat-completions');
  assert.equal(restored.key('openai'), 'fake-proxy-key');
  await restored.saveSettings({ provider: 'openai', model: 'updated-proxy-model' });
  assert.equal(restored.publicSettings().apiProtocol, 'chat-completions');
});

test('invalid API protocols never change saved settings or cross provider boundaries', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'openai', model: 'kept-model', apiProtocol: 'chat-completions', apiKey: 'fake-kept-key' });
  const before = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
  const state = store.publicSettings();
  for (const provider of ['openai', 'deepseek', 'anthropic', 'relay']) {
    for (const apiProtocol of ['unknown', '', null, false, {}, []]) {
      await assert.rejects(store.saveSettings({ provider, apiProtocol, model: 'not-saved', clearKey: true }), /API 协议/);
      assert.equal(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'), before);
      assert.deepEqual(store.publicSettings(), state);
    }
    if (!['openai', 'relay'].includes(provider)) {
      await assert.rejects(store.saveSettings({ provider, apiProtocol: 'chat-completions' }), /API 协议/);
      assert.equal(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'), before);
    }
  }
  assert.equal(store.key('openai'), 'fake-kept-key');
  await store.saveSettings({ provider: 'deepseek', apiProtocol: 'responses' });
  assert.equal(Object.hasOwn(store.publicSettings().providers.deepseek, 'apiProtocol'), false);
  assert.equal(store.publicSettings().providers.openai.apiProtocol, 'chat-completions');
});

test('missing and corrupt persisted OpenAI API protocols migrate to Responses', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'openai', model: 'kept-model', apiKey: 'fake-migration-key' });
  const saved = JSON.parse(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'));
  for (const apiProtocol of [undefined, 'unknown', '', null, false, {}, []]) {
    const input = structuredClone(saved);
    if (apiProtocol === undefined) delete input.providers.openai.apiProtocol;
    else input.providers.openai.apiProtocol = apiProtocol;
    await fs.writeFile(path.join(store.dir, 'settings.json'), JSON.stringify(input));
    const restored = new Store(store.dir, mockCrypto); await restored.init();
    assert.equal(restored.publicSettings().apiProtocol, 'responses');
    assert.equal(restored.publicSettings().model, 'kept-model');
    assert.equal(restored.key('openai'), 'fake-migration-key');
    const migrated = JSON.parse(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'));
    assert.equal(migrated.providers.openai.apiProtocol, 'responses');
  }
});

test('relay requires its own endpoint and keeps model, key and protocol independent of OpenAI', async t => {
  const store = await fixture(t);
  const defaults = store.publicSettings().providers.relay;
  assert.equal(defaults.apiProtocol, 'chat-completions');
  assert.equal(defaults.baseUrl, '');
  assert.equal(defaults.authMode, 'apiKey');
  await store.saveSettings({ provider: 'openai', model: 'official-model', apiKey: 'fake-official-key', apiProtocol: 'responses' });
  await assert.rejects(store.saveSettings({ provider: 'relay', model: 'not-saved', apiKey: 'fake-rejected-key' }), /API 地址/);
  assert.equal(store.key('relay'), '');
  await store.saveSettings({ provider: 'relay', baseUrl: 'https://relay.example/v1', model: 'relay-model', apiKey: 'fake-relay-key', reasoningEffort: 'minimal' });
  assert.equal(store.publicSettings().apiProtocol, 'chat-completions');
  assert.equal(store.publicSettings().providers.openai.model, 'official-model');
  assert.equal(store.key('openai'), 'fake-official-key');
  assert.equal(store.key('relay'), 'fake-relay-key');
  assert.ok(!JSON.stringify(store.publicSettings()).includes('fake-relay-key'));
  const before = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
  await assert.rejects(store.saveSettings({ provider: 'relay', authMode: 'chatgpt' }), /登录方式/);
  assert.equal(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'), before);
  await store.saveSettings({ provider: 'relay', apiProtocol: 'responses' });
  const restored = new Store(store.dir, mockCrypto); await restored.init();
  assert.equal(restored.publicSettings().provider, 'relay');
  assert.equal(restored.publicSettings().model, 'relay-model');
  assert.equal(restored.publicSettings().baseUrl, 'https://relay.example/v1');
  assert.equal(restored.publicSettings().reasoningEffort, 'minimal');
  assert.equal(restored.publicSettings().apiProtocol, 'responses');
  assert.equal(restored.key('relay'), 'fake-relay-key');
  assert.equal(restored.key('openai'), 'fake-official-key');
  await restored.recordUsage(usageRecord({ provider: 'relay', model: 'relay-model' }));
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.equal(reopened.usageStats('2026-01-05T10:00:00Z').day.totalTokens, 12);
});

test('missing and corrupt persisted relay protocols default to Chat Completions', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'relay', baseUrl: 'https://relay.example/v1', model: 'kept-relay-model', apiKey: 'fake-relay-migration-key' });
  const saved = JSON.parse(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'));
  for (const apiProtocol of [undefined, 'unknown', '', null, false, {}, []]) {
    const input = structuredClone(saved);
    if (apiProtocol === undefined) delete input.providers.relay.apiProtocol;
    else input.providers.relay.apiProtocol = apiProtocol;
    await fs.writeFile(path.join(store.dir, 'settings.json'), JSON.stringify(input));
    const restored = new Store(store.dir, mockCrypto); await restored.init();
    assert.equal(restored.publicSettings().apiProtocol, 'chat-completions');
    assert.equal(restored.publicSettings().model, 'kept-relay-model');
    assert.equal(restored.key('relay'), 'fake-relay-migration-key');
    const migrated = JSON.parse(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'));
    assert.equal(migrated.providers.relay.apiProtocol, 'chat-completions');
  }
});
test('unsafe API addresses are rejected before key is saved', async t => {
  const store = await fixture(t);
  for (const baseUrl of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/?key=secret', 'file:///C:/file']) {
    await assert.rejects(store.saveSettings({ provider: 'deepseek', baseUrl, apiKey: 'secret' }));
  }
  assert.equal(store.key('deepseek'), '');
});
test('session persistence removes known keys and validates session identifiers', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'deepseek', apiKey: 'the-real-key' });
  const session = store.createSession('C:/project');
  session.messages.push({ role: 'assistant', content: 'the-real-key' });
  await store.saveSession(session);
  const restored = await store.getSession(session.id);
  assert.ok(!JSON.stringify(restored).includes('the-real-key'));
  await assert.rejects(store.getSession('../settings'));
  assert.equal((await store.listSessions()).length, 1);
});
test('edited session ids cannot be used to save outside the sessions directory', async t => {
  const store = await fixture(t);
  const session = store.createSession();
  await store.saveSession(session);
  const originalId = session.id;
  session.id = '../../settings';
  await fs.writeFile(path.join(store.dir, 'sessions', originalId + '.json'), JSON.stringify(session));
  await assert.rejects(store.getSession(originalId), /格式损坏/);
  await assert.rejects(store.saveSession(session), /ID 无效/);
});

async function historySession(store, { workspace = 'C:/project', timestamp = '2026-10-19T01:00:00.000Z', messages, demo = false, title = 'Original task title', ...extra } = {}) {
  const session = store.createSession(workspace);
  Object.assign(session, { title, updatedAt: timestamp, demo,
    messages: messages ?? [{ role: 'user', content: 'An actual task' }], ...extra });
  await fs.writeFile(path.join(store.dir, 'sessions', `${session.id}.json`), JSON.stringify(session));
  return session;
}

test('history groups Windows path variants by full directory and displays only the latest actual session', async t => {
  const store = await fixture(t);
  const older = await historySession(store, { workspace: 'C:\\Projects\\ForgeDesk', timestamp: '2026-10-18T01:00:00.000Z' });
  const latest = await historySession(store, { workspace: 'c:/Projects/ForgeDesk/', timestamp: '2026-10-19T01:00:00.000Z', title: 'Latest task title' });
  await historySession(store, { workspace: 'C:\\PROJECTS\\.\\FORGEDESK\\', timestamp: '2026-10-17T01:00:00.000Z' });
  const listed = await store.listSessions();
  assert.deepEqual(listed, [{ id: latest.id, title: 'ForgeDesk', updatedAt: latest.updatedAt, workspace: latest.workspace, demo: false }]);
  assert.equal((await store.getSession(older.id)).title, older.title);
  assert.equal((await store.getSession(latest.id)).title, 'Latest task title');
});

test('newer empty, whitespace-only, demo and invalid-workspace sessions cannot obscure meaningful project history', async t => {
  const store = await fixture(t);
  const meaningful = await historySession(store, { workspace: 'E:/work/project', timestamp: '2026-10-17T01:00:00.000Z' });
  await historySession(store, { workspace: 'E:/work/project', timestamp: '2026-10-19T01:00:00.000Z', messages: [] });
  await historySession(store, { workspace: 'E:/work/project/', timestamp: '2026-10-19T02:00:00.000Z', messages: [{ role: 'user', content: ' \r\n\t ' }] });
  await historySession(store, { workspace: 'E:/work/project', timestamp: '2026-10-19T03:00:00.000Z', demo: true });
  for (const workspace of [null, '', 'relative/project', 'C:relative', '\\drive-relative', '\\\\?\\C:\\device']) {
    await historySession(store, { workspace, timestamp: '2026-10-19T04:00:00.000Z' });
  }
  const listed = await store.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, meaningful.id);
  assert.equal(listed[0].title, 'project');
});

test('folders with the same basename remain separate projects and UNC aliases deduplicate', async t => {
  const store = await fixture(t);
  const first = await historySession(store, { workspace: 'C:/one/app', timestamp: '2026-10-17T01:00:00.000Z' });
  const second = await historySession(store, { workspace: 'D:/two/app', timestamp: '2026-10-18T01:00:00.000Z' });
  await historySession(store, { workspace: '\\\\SERVER\\Share\\app\\', timestamp: '2026-10-16T01:00:00.000Z' });
  const unc = await historySession(store, { workspace: '//server/share/app', timestamp: '2026-10-19T01:00:00.000Z' });
  const listed = await store.listSessions();
  assert.deepEqual(listed.map(item => item.id), [unc.id, second.id, first.id]);
  assert.ok(listed.every(item => item.title === 'app'));
});

test('drive roots have a meaningful title and latest ordering compares actual timestamps', async t => {
  const store = await fixture(t);
  const rootSession = await historySession(store, { workspace: 'C:\\', timestamp: '2026-10-19T09:00:00+08:00' });
  const later = await historySession(store, { workspace: 'D:/project', timestamp: '2026-10-19T02:00:00Z' });
  const listed = await store.listSessions();
  assert.deepEqual(listed.map(item => item.id), [later.id, rootSession.id]);
  assert.equal(listed[1].title, 'C:');
});

test('project summaries preserve archived session files, account bindings and usage ledger', async t => {
  const store = await fixture(t);
  const older = await historySession(store, { workspace: 'C:/project', chatgptProfileId: 'account-a', timestamp: '2026-01-05T03:00:00Z' });
  const latest = await historySession(store, { workspace: 'c:\\project\\', chatgptProfileId: 'account-b', timestamp: '2026-01-05T04:00:00Z' });
  await store.recordUsage(usageRecord({ sessionId: older.id }));
  await store.recordUsage(usageRecord({ sessionId: latest.id }));
  const filesBefore = await fs.readdir(path.join(store.dir, 'sessions'));
  const archivedBefore = await fs.readFile(path.join(store.dir, 'sessions', `${older.id}.json`), 'utf8');
  const ledgerBefore = await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8');
  assert.equal((await store.listSessions()).length, 1);
  assert.equal((await store.getSession(older.id)).chatgptProfileId, 'account-a');
  assert.equal((await store.getSession(latest.id)).chatgptProfileId, 'account-b');
  assert.deepEqual(await fs.readdir(path.join(store.dir, 'sessions')), filesBefore);
  assert.equal(await fs.readFile(path.join(store.dir, 'sessions', `${older.id}.json`), 'utf8'), archivedBefore);
  assert.equal(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'), ledgerBefore);
  assert.equal(store.usageStats('2026-01-05T10:00:00Z').day.requests, 2);
});
test('ChatGPT account mode persists separately from the stored API key', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'openai', model: 'test', apiKey: 'kept-api-key', authMode: 'chatgpt' });
  assert.equal(store.publicSettings().authMode, 'chatgpt');
  assert.equal(store.key('openai'), 'kept-api-key');
  const restored = new Store(store.dir, mockCrypto); await restored.init();
  assert.equal(restored.publicSettings().providers.openai.authMode, 'chatgpt');
  await restored.saveSettings({ provider: 'openai', authMode: 'apiKey', model: 'test' });
  assert.equal(restored.key('openai'), 'kept-api-key');
  await assert.rejects(restored.saveSettings({ provider: 'deepseek', authMode: 'chatgpt' }), /不支持/);
});

test('switching account authentication preserves API endpoint and separate model selections', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'openai', authMode: 'apiKey', model: 'proxy-model', baseUrl: 'https://proxy.example/v1', apiProtocol: 'chat-completions', apiKey: 'proxy-key' });
  await store.saveSettings({ provider: 'openai', authMode: 'chatgpt', model: 'account-model' });
  assert.equal(store.publicSettings().baseUrl, 'https://proxy.example/v1');
  assert.equal(store.publicSettings().model, 'account-model');
  assert.equal(store.publicSettings().apiProtocol, 'chat-completions');
  const restored = new Store(store.dir, mockCrypto); await restored.init();
  await restored.saveSettings({ provider: 'openai', authMode: 'apiKey' });
  assert.equal(restored.publicSettings().model, 'proxy-model');
  assert.equal(restored.publicSettings().baseUrl, 'https://proxy.example/v1');
  assert.equal(restored.publicSettings().apiProtocol, 'chat-completions');
  assert.equal(restored.key('openai'), 'proxy-key');
  await restored.saveSettings({ provider: 'openai', authMode: 'chatgpt' });
  assert.equal(restored.publicSettings().model, 'account-model');
  assert.equal(restored.publicSettings().apiProtocol, 'chat-completions');
});

test('reasoning effort is provider-specific, preserved when omitted, and included in public settings', async t => {
  const store = await fixture(t);
  assert.equal(store.publicSettings().reasoningEffort, 'default');
  await store.saveSettings({ provider: 'openai', model: 'model', reasoningEffort: 'minimal' });
  assert.equal(store.publicSettings().reasoningEffort, 'minimal');
  await store.saveSettings({ provider: 'openai', model: 'updated-model' });
  assert.equal(store.publicSettings().reasoningEffort, 'minimal');
  await store.saveSettings({ provider: 'deepseek', model: 'deepseek', reasoningEffort: 'none' });
  await store.saveSettings({ provider: 'anthropic', model: 'claude', reasoningEffort: 'xhigh' });
  assert.equal(store.publicSettings().providers.openai.reasoningEffort, 'minimal');
  assert.equal(store.publicSettings().providers.deepseek.reasoningEffort, 'none');
  assert.equal(store.publicSettings().providers.anthropic.reasoningEffort, 'xhigh');
  for (const [provider, reasoningEffort] of [['deepseek', 'medium'], ['anthropic', 'none'], ['openai', 'unsupported']]) {
    await assert.rejects(store.saveSettings({ provider, reasoningEffort }), /思考强度/);
  }
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.equal(reopened.publicSettings().providers.openai.reasoningEffort, 'minimal');
});

test('older settings gain default effort without losing encrypted keys', async t => {
  const store = await fixture(t, { initialize: false });
  await fs.writeFile(path.join(store.dir, 'settings.json'), JSON.stringify({
    provider: 'openai', providers: { openai: { model: 'old-model', baseUrl: 'https://api.openai.com/v1', encryptedKey: mockCrypto.encryptString('old-key').toString('base64') } },
  }));
  await store.init();
  assert.equal(store.publicSettings().reasoningEffort, 'default');
  assert.equal(store.publicSettings().providers.anthropic.reasoningEffort, 'default');
  assert.equal(store.publicSettings().apiProtocol, 'responses');
  assert.equal(store.publicSettings().providers.relay.apiProtocol, 'chat-completions');
  assert.equal(store.publicSettings().providers.relay.baseUrl, '');
  assert.equal(store.key('openai'), 'old-key');
  const persisted = JSON.parse(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'));
  assert.equal(persisted.providers.openai.reasoningEffort, 'default');
  assert.equal(persisted.providers.relay.apiProtocol, 'chat-completions');
});

const usageRecord = overrides => ({
  id: randomUUID(), timestamp: '2026-01-05T04:00:00.000Z', provider: 'openai', model: 'test-model',
  sessionId: randomUUID(), runId: randomUUID(), inputTokens: 10, outputTokens: 2,
  reported: true, status: 'completed', ...overrides,
});

for (const purpose of ['pet-chat', 'pet-reaction']) test(`${purpose} and isolated run identity survive ledger normalization and reload`, async t => {
  const store = await fixture(t), mainRun = randomUUID(), petRun = randomUUID(), sessionId = randomUUID();
  const entry = usageRecord({ sessionId, runId: petRun, purpose, inputTokens: 40, outputTokens: 6, partial: true, status: 'stopped' });
  await store.recordUsage(entry); await store.recordUsage(entry);
  const restored = new Store(store.dir, mockCrypto); await restored.init();
  const records = restored.usage.records.filter(record => record.id === entry.id);
  assert.equal(records.length, 1); assert.equal(records[0].purpose, purpose);
  assert.equal(records[0].runId, petRun); assert.notEqual(records[0].runId, mainRun);
  assert.equal(records[0].partial, true); assert.equal(records[0].inputTokens, 40);
  const raw = JSON.parse(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'));
  assert.equal(raw.records.find(record => record.id === entry.id).purpose, purpose);
});

test('session metrics preserve cache reports, compaction charges and frozen history baselines across restart', async t => {
  const store = await fixture(t);
  const original = store.createSession('E:\\synthetic-project');
  original.messages.push({ role: 'user', content: 'first turn' });
  original.contextUsage = { version: 2, provider: 'openai', model: 'test-model', inputTokens: 100, outputTokens: 20,
    limit: 1000, status: 'reported', phase: 'complete', measuredAt: '2026-10-21T01:00:00Z' };
  const first = usageRecord({ sessionId: original.id, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
  await store.recordUsage(first);
  await store.recordUsage(first);
  assert.equal(store.sessionMetrics(original).totalTokens, 120);
  const branch = { ...structuredClone(original), id: randomUUID(), usageBaseline: store.sessionUsageTotals(original) };
  branch.messages.push({ role: 'user', content: 'continue this snapshot' });
  await store.recordUsage(usageRecord({ sessionId: original.id, inputTokens: 900, outputTokens: 10 }));
  await store.recordUsage(usageRecord({ sessionId: branch.id, inputTokens: 50, outputTokens: 10, cachedInputTokens: 0, purpose: 'context-compaction' }));
  await store.recordUsage(usageRecord({ sessionId: branch.id, inputTokens: 100, outputTokens: 5, cachedInputTokens: 100 }));
  branch.contextUsage = { ...branch.contextUsage, inputTokens: 100, outputTokens: 5 };
  assert.equal(store.sessionMetrics(original).totalTokens, 1030);
  assert.equal(store.sessionMetrics(branch).totalTokens, 285);
  assert.equal(store.sessionMetrics(branch).rounds, 2);
  assert.equal(store.sessionMetrics(branch).cacheHitPercent, 56);
  assert.equal(store.sessionMetrics(branch).contextUsedTokens, 105);
  assert.equal(store.sessionMetrics(branch).contextPercent, 10.5);
  await store.saveSession(branch);
  const restored = new Store(store.dir, mockCrypto); await restored.init();
  const loaded = await restored.getSession(branch.id);
  assert.deepEqual(restored.sessionMetrics(loaded), store.sessionMetrics(branch));
  assert.equal(restored.usage.records.find(item => item.sessionId === branch.id && item.purpose)?.purpose, 'context-compaction');
  assert.equal(restored.usage.records.find(item => item.id === first.id).cachedInputTokens, 40);
  const empty = restored.createSession('E:\\another-project');
  assert.equal(restored.sessionMetrics(empty).totalTokens, 0);
  assert.equal(restored.sessionMetrics(empty).rounds, 0);
  assert.equal(restored.sessionMetrics(empty).cacheStatus, 'unavailable');
});

test('Hong Kong midnight and Monday boundaries use the local calendar', async t => {
  const store = await fixture(t);
  await store.recordUsage(usageRecord({ timestamp: '2026-01-04T15:59:59.999Z', inputTokens: 7, outputTokens: 3 }));
  await store.recordUsage(usageRecord({ timestamp: '2026-01-04T16:00:00.000Z', inputTokens: 11, outputTokens: 5 }));
  const monday = store.usageStats('2026-01-04T16:00:00.000Z');
  assert.equal(monday.timeZone, 'Asia/Hong_Kong');
  assert.equal(monday.day.totalTokens, 16);
  assert.equal(monday.day.requests, 1);
  assert.equal(monday.week.totalTokens, 16);
  assert.equal(monday.month.totalTokens, 26);
  assert.equal(monday.month.requests, 2);
  const sunday = store.usageStats('2026-01-04T15:59:59.999Z');
  assert.equal(sunday.day.totalTokens, 10);
  assert.equal(sunday.week.totalTokens, 10);
});

test('month and year rollovers in Hong Kong retain the correct natural week', async t => {
  const store = await fixture(t);
  await store.recordUsage(usageRecord({ timestamp: '2025-12-31T15:59:59.999Z', inputTokens: 20, outputTokens: 1 }));
  await store.recordUsage(usageRecord({ timestamp: '2025-12-31T16:00:00.000Z', inputTokens: 30, outputTokens: 2 }));
  const january = store.usageStats('2025-12-31T16:00:00.000Z');
  assert.equal(january.day.totalTokens, 32);
  assert.equal(january.month.totalTokens, 32);
  assert.equal(january.week.totalTokens, 53);
  assert.equal(january.week.requests, 2);
  const december = store.usageStats('2025-12-31T15:59:59.999Z');
  assert.equal(december.month.totalTokens, 21);
});

test('usage writes are idempotent, serialized under concurrency, and survive restart', async t => {
  const store = await fixture(t);
  const first = usageRecord();
  await Promise.all([store.recordUsage(first), store.recordUsage(first), ...Array.from({ length: 25 }, () => store.recordUsage(usageRecord()))]);
  assert.equal(store.usageStats('2026-01-05T10:00:00Z').day.requests, 26);
  assert.equal(store.usageStats('2026-01-05T10:00:00Z').day.totalTokens, 26 * 12);
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.equal((await reopened.recordUsage(first)).duplicate, true);
  assert.equal(reopened.usageStats('2026-01-05T10:00:00Z').day.requests, 26);
  const disk = JSON.parse(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'));
  assert.equal(disk.records.length, 26);
});

test('unknown or malformed usage stays null and is counted as incomplete rather than invented zero', async t => {
  const store = await fixture(t);
  const entries = [
    usageRecord({ reported: false, inputTokens: 123, outputTokens: 456 }),
    usageRecord({ reported: true, inputTokens: null, outputTokens: 4 }),
    usageRecord({ reported: true, inputTokens: -1, outputTokens: 4 }),
    usageRecord({ reported: true, inputTokens: 2.5, outputTokens: 4 }),
    usageRecord({ reported: true, inputTokens: Number.POSITIVE_INFINITY, outputTokens: 4 }),
  ];
  for (const entry of entries) await store.recordUsage(entry);
  const stats = store.usageStats('2026-01-05T10:00:00Z');
  assert.equal(stats.day.requests, 5);
  assert.equal(stats.day.unreportedRequests, 5);
  assert.equal(stats.day.totalTokens, 0);
  const disk = JSON.parse(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'));
  assert.ok(disk.records.every(record => record.inputTokens === null && record.outputTokens === null && record.reported === false));
});

test('cancelled requests retain reported token lower bounds and mark partial totals', async t => {
  const store = await fixture(t);
  await store.recordUsage(usageRecord({ status: 'stopped', reported: true, partial: true, inputTokens: 40, outputTokens: 6 }));
  await store.recordUsage(usageRecord({ status: 'failed', reported: true, partial: true, inputTokens: 9, outputTokens: 1 }));
  const stats = store.usageStats('2026-01-05T10:00:00Z');
  assert.equal(stats.day.inputTokens, 49);
  assert.equal(stats.day.outputTokens, 7);
  assert.equal(stats.day.totalTokens, 56);
  assert.equal(stats.day.requests, 2);
  assert.equal(stats.day.unreportedRequests, 2);
  assert.equal(stats.day.partialRequests, 2);
});

test('legacy per-run cumulative totals are imported once, not summed per model turn', async t => {
  const store = await fixture(t, { initialize: false });
  await fs.mkdir(path.join(store.dir, 'sessions'));
  const session = store.createSession('C:/project');
  session.updatedAt = '2026-01-05T05:00:00.000Z';
  session.events = [
    { type: 'run-start', runId: 'old-first' },
    { type: 'usage', inputTokens: 10, outputTokens: 3 },
    { type: 'usage', inputTokens: 30, outputTokens: 8 },
    { type: 'run-end', status: 'completed' },
    { type: 'run-start', runId: 'old-second' },
    { type: 'usage', inputTokens: 7, outputTokens: 2 },
    { type: 'run-end', status: 'stopped' },
  ];
  await fs.writeFile(path.join(store.dir, 'sessions', `${session.id}.json`), JSON.stringify(session));
  const demo = { ...session, id: randomUUID(), demo: true };
  await fs.writeFile(path.join(store.dir, 'sessions', `${demo.id}.json`), JSON.stringify(demo));
  await store.init();
  const stats = store.usageStats('2026-01-05T10:00:00Z');
  assert.equal(stats.day.inputTokens, 37);
  assert.equal(stats.day.outputTokens, 10);
  assert.equal(stats.day.requests, 2);
  assert.equal(stats.day.unreportedRequests, 1);
  assert.equal(stats.historicalApproximate, true);
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.equal(reopened.usageStats('2026-01-05T10:00:00Z').day.totalTokens, 47);
  assert.equal(reopened.usageStats('2026-01-05T10:00:00Z').day.requests, 2);
});

test('legacy migration skips already-ledgered sessions and versioned sessions', async t => {
  const store = await fixture(t);
  const session = store.createSession();
  session.updatedAt = '2026-01-05T05:00:00.000Z';
  session.events = [{ type: 'usage', inputTokens: 100, outputTokens: 50 }];
  await fs.writeFile(path.join(store.dir, 'sessions', `${session.id}.json`), JSON.stringify(session));
  await store.recordUsage(usageRecord({ sessionId: session.id }));
  const versioned = { ...session, id: randomUUID(), usageLedgerVersion: 1 };
  await fs.writeFile(path.join(store.dir, 'sessions', `${versioned.id}.json`), JSON.stringify(versioned));
  const ledger = JSON.parse(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'));
  delete ledger.legacyMigration;
  await fs.writeFile(path.join(store.dir, 'usage.json'), JSON.stringify(ledger));
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.equal(reopened.usageStats('2026-01-05T10:00:00Z').day.requests, 1);
  assert.equal(reopened.usageStats('2026-01-05T10:00:00Z').day.totalTokens, 12);
});

test('corrupt usage ledger is exposed as an error and never silently overwritten', async t => {
  const store = await fixture(t);
  const corrupted = '{"version":1,"records":[';
  await fs.writeFile(path.join(store.dir, 'usage.json'), corrupted);
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.match(reopened.usageStats().error, /账本损坏|无法读取/);
  await assert.rejects(reopened.recordUsage(usageRecord()), /账本损坏|无法读取/);
  assert.equal(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'), corrupted);
  assert.equal(reopened.publicSettings().provider, 'deepseek');
});

test('semantically corrupt persisted counts fail visibly rather than becoming zero', async t => {
  const store = await fixture(t);
  await store.recordUsage(usageRecord());
  const ledger = JSON.parse(await fs.readFile(path.join(store.dir, 'usage.json'), 'utf8'));
  ledger.records[0].inputTokens = 'corrupt-value';
  await fs.writeFile(path.join(store.dir, 'usage.json'), JSON.stringify(ledger));
  const reopened = new Store(store.dir, mockCrypto); await reopened.init();
  assert.match(reopened.usageStats().error, /账本损坏|无法读取/);
  await assert.rejects(reopened.recordUsage(usageRecord()), /账本损坏|无法读取/);
});
