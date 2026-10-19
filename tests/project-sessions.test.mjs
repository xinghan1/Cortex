import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { Store } = createRequire(import.meta.url)('../src/core/store.cjs');
const testRoot = path.resolve('tests', '.tmp');
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'project-sessions-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(dir).startsWith('project-sessions-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir, crypto); await store.init(); return store;
}
async function history(store, extra = {}) {
  const session = { ...store.createSession('C:/Projects/Demo'), messages: [{ role: 'user', content: '第一条提示词' }], ...extra };
  await fs.writeFile(path.join(store.dir, 'sessions', session.id + '.json'), JSON.stringify(session));
  return session;
}

test('current project lists all meaningful sessions while project switcher remains grouped', async t => {
  const store = await fixture(t);
  const older = await history(store, { updatedAt: '2026-10-18T00:00:00Z', messages: [{ role: 'user', content: '较早的任务' }] });
  const newer = await history(store, { workspace: 'c:\\Projects\\Demo\\', updatedAt: '2026-10-19T00:00:00Z', messages: [{ role: 'user', content: '较新的任务' }] });
  await history(store, { workspace: 'D:/Projects/Demo' });
  await history(store, { workspace: 'C:/Different/Demo' });
  const items = await store.listProjectSessions('C:/Projects/./Demo/');
  assert.deepEqual(items.map(item => item.id), [newer.id, older.id]);
  assert.ok(items.every(item => item.title === 'Demo'));
  assert.equal(items[0].preview, '较新的任务');
  const grouped = await store.listSessions();
  assert.equal(grouped.length, 3);
  assert.equal(grouped.filter(item => /^c:[\\/]Projects[\\/]/iu.test(item.workspace)).length, 1);
});

test('project session metadata contains no bodies, events, attachments, workspace or secrets', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'deepseek', apiKey: 'private-model-key' });
  const source = await history(store, {
    events: [{ type: 'tool-result', result: 'INTERNAL_TOOL_RESULT' }],
    messages: [{ role: 'user', content: 'private-model-key\n\t请完成任务' }, { role: 'assistant', content: 'ASSISTANT_PRIVATE_BODY' }],
  });
  const [item] = await store.listProjectSessions(source.workspace);
  assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'preview', 'title', 'updatedAt']);
  assert.equal(item.preview, '[已隐藏密钥] 请完成任务');
  assert.ok(!JSON.stringify(item).includes('private-model-key'));
  assert.ok(!JSON.stringify(item).includes('ASSISTANT_PRIVATE_BODY'));
  assert.ok(!JSON.stringify(item).includes('INTERNAL_TOOL_RESULT'));
});

test('session previews collapse whitespace, keep literal text and cap at 80 Unicode code points', async t => {
  const store = await fixture(t);
  await history(store, { messages: [{ role: 'user', content: '\n <script>"\t ' + '😀'.repeat(100) }] });
  const [item] = await store.listProjectSessions('C:/Projects/Demo');
  assert.equal([...item.preview].length, 80);
  assert.ok(item.preview.startsWith('<script>" '));
  assert.equal(item.preview.includes('\n'), false);
  assert.equal(item.preview.includes('\ud83d\ufffd'), false);
});

test('demo, temporary, empty, invalid date and malformed histories are skipped', async t => {
  const store = await fixture(t);
  const good = await history(store);
  await history(store, { demo: true }); await history(store, { temporary: true });
  await history(store, { messages: [] }); await history(store, { messages: [{ role: 'user', content: '  \n' }] });
  await history(store, { updatedAt: 'not-a-date' });
  const malformed = await history(store); await fs.writeFile(path.join(store.dir, 'sessions', malformed.id + '.json'), '{bad-json');
  const wrong = await history(store); await fs.writeFile(path.join(store.dir, 'sessions', wrong.id + '.json'), JSON.stringify({ ...wrong, id: 'other-id' }));
  await fs.writeFile(path.join(store.dir, 'sessions', 'settings.json'), '{"messages":"do not read this as session"}');
  assert.deepEqual((await store.listProjectSessions(good.workspace)).map(item => item.id), [good.id]);
});

test('image-only history is available without sending encoded image contents to the menu', async t => {
  const store = await fixture(t);
  const image = await history(store, { messages: [{ role: 'user', content: '', attachments: [{ dataUrl: 'data:image/png;base64,AAAA_IMAGE_CONTENT' }] }] });
  const [item] = await store.listProjectSessions(image.workspace);
  assert.equal(item.id, image.id); assert.equal(item.preview, '图片消息');
  assert.ok(!JSON.stringify(item).includes('AAAA_IMAGE_CONTENT'));
});

test('missing, relative, control-bearing and Windows device project paths return no history', async t => {
  const store = await fixture(t); await history(store);
  for (const value of [undefined, null, '', '.', 'C:Projects', '\\\\?\\C:\\Projects\\Demo', '\\\\.\\C:\\Projects\\Demo', 'C:/Projects/Demo\u0000', {}, 12]) {
    assert.deepEqual(await store.listProjectSessions(value), [], String(value));
  }
});

test('UNC project identity is normalized without contacting the project server', async t => {
  const store = await fixture(t);
  const source = await history(store, { workspace: '\\\\offline-server\\share\\Projects\\Demo\\' });
  await history(store, { workspace: '\\\\another-server\\share\\Projects\\Demo' });
  const result = await store.listProjectSessions('//OFFLINE-SERVER/share/Projects/./Demo');
  assert.equal(result.length, 1); assert.equal(result[0].id, source.id);
});

test('new sessions have real creation timestamps while legacy histories omit unknown creation time', async t => {
  const store = await fixture(t);
  const current = await history(store);
  assert.equal(current.createdAt, current.updatedAt);
  const legacy = await history(store, { createdAt: undefined, updatedAt: '2026-10-18T00:00:00Z' });
  const result = await store.listProjectSessions(current.workspace);
  assert.equal(result.find(item => item.id === current.id).createdAt, current.createdAt);
  assert.equal(result.find(item => item.id === legacy.id).createdAt, null);
});

test('latest 100 project histories are returned in deterministic descending date order', async t => {
  const store = await fixture(t);
  const created = await Promise.all(Array.from({ length: 105 }, (_, index) => history(store, { updatedAt: new Date(Date.UTC(2026, 9, 19, 0, index)).toISOString() })));
  const result = await store.listProjectSessions('C:/Projects/Demo');
  assert.equal(result.length, 100);
  assert.deepEqual(result.map(item => item.id), created.slice(5).reverse().map(item => item.id));
});

test('obsolete maxSteps setting is ignored while legacy provider and encrypted key still load', async t => {
  const store = await fixture(t);
  const saved = { provider: 'openai', maxSteps: 1, providers: { openai: { model: 'legacy-model', baseUrl: 'https://api.openai.com/v1', reasoningEffort: 'default', authMode: 'apiKey', encryptedKey: Buffer.from('legacy-secret').toString('base64') } } };
  await fs.writeFile(path.join(store.dir, 'settings.json'), JSON.stringify(saved));
  const restored = new Store(store.dir, crypto); await restored.init();
  assert.equal(restored.publicSettings().model, 'legacy-model'); assert.equal(restored.key('openai'), 'legacy-secret');
  assert.equal(Object.hasOwn(restored.settings, 'maxSteps'), false); assert.equal(Object.hasOwn(restored.publicSettings(), 'maxSteps'), false);
  await restored.saveSettings({ provider: 'openai', maxSteps: 30 });
  const next = JSON.parse(await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8'));
  assert.equal(Object.hasOwn(next, 'maxSteps'), false); assert.equal(restored.key('openai'), 'legacy-secret');
});
