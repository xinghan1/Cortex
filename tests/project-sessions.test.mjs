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
  assert.deepEqual(items.map(item => item.title), ['较新的任务', '较早的任务']);
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
  assert.equal(item.title, '[已隐藏密钥] 请完成任务');
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

test('legacy project titles resolve from the first prompt and never alter project grouping', async t => {
  const store = await fixture(t);
  const source = await history(store, { title: 'Demo', messages: [{ role: 'user', content: '\n 生成我的博客网站\t' }, { role: 'user', content: '后续的问题' }] });
  assert.equal(store.sessionTitle(await store.getSession(source.id)), '生成我的博客网站');
  assert.equal((await store.listProjectSessions(source.workspace))[0].title, '生成我的博客网站');
  assert.equal((await store.listSessions())[0].title, 'Demo');
  const disk = JSON.parse(await fs.readFile(path.join(store.dir, 'sessions', source.id + '.json'), 'utf8'));
  assert.equal(disk.title, 'Demo', 'Reading legacy history does not rewrite it');
});

test('derived titles preserve Unicode and literal markup while limiting to 40 characters', async t => {
  const store = await fixture(t);
  const source = await history(store, { messages: [{ role: 'user', content: '<img> ' + '😀'.repeat(90) }] });
  const title = store.sessionTitle(await store.getSession(source.id));
  assert.equal([...title].length, 40); assert.ok(title.startsWith('<img> 😀'));
  assert.equal(title.includes('\ufffd'), false);
  const image = store.createSession(source.workspace);
  image.messages.push({ role: 'user', content: '', attachments: [{ dataUrl: 'data:image/png;base64,AAAA' }] }, { role: 'user', content: '后面的文本' });
  assert.equal(store.sessionTitle(image), '图片消息');
});

test('manual titles persist across restarts and subsequent saves without changing content or usage', async t => {
  const store = await fixture(t);
  const source = await history(store, { events: [{ type: 'run-end', status: 'completed' }], usageBaseline: { inputTokens: 7 } });
  const original = structuredClone(source);
  const result = await store.renameSession(source, '  我的 Java 工程 😀  ');
  assert.deepEqual(result, { id: source.id, title: '我的 Java 工程 😀' });
  assert.deepEqual(source.messages, original.messages); assert.deepEqual(source.events, original.events); assert.deepEqual(source.usageBaseline, original.usageBaseline);
  source.messages.push({ role: 'user', content: '另一个任务' }); await store.saveSession(source);
  const restored = new Store(store.dir, crypto); await restored.init();
  const loaded = await restored.getSession(source.id);
  assert.equal(loaded.title, '我的 Java 工程 😀'); assert.equal(loaded.customTitle, loaded.title);
  assert.equal((await restored.listProjectSessions(source.workspace))[0].title, loaded.title);
  assert.equal((await restored.listSessions())[0].title, 'Demo');
});

test('empty named chats remain selectable and temporary names never write a history file', async t => {
  const store = await fixture(t), named = store.createSession('C:/Projects/Demo');
  await store.renameSession(named, '稍后继续的会话');
  assert.equal((await store.listProjectSessions(named.workspace))[0].id, named.id);
  const temporary = { ...store.createSession(named.workspace), temporary: true };
  await store.renameSession(temporary, '临时标题');
  assert.equal(temporary.customTitle, '临时标题');
  await assert.rejects(fs.access(path.join(store.dir, 'sessions', temporary.id + '.json')), { code: 'ENOENT' });
});

test('rename rejects invalid names atomically and accepts exactly 80 Unicode characters', async t => {
  const store = await fixture(t), source = await history(store);
  const old = structuredClone(source), filename = path.join(store.dir, 'sessions', source.id + '.json'), bytes = await fs.readFile(filename, 'utf8');
  for (const title of ['', '  ', null, 9, 'bad\nname', 'bad\0name', '\ttrimmed', 'x'.repeat(81), '😀'.repeat(81)]) {
    await assert.rejects(store.renameSession(source, title));
    assert.deepEqual(source, old); assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  }
  await store.renameSession(source, '😀'.repeat(80));
  assert.equal([...(await store.getSession(source.id)).title].length, 80);
});

test('custom title metadata redacts secrets and ignores damaged optional names', async t => {
  const store = await fixture(t);
  await store.saveSettings({ provider: 'deepseek', apiKey: 'session-secret-key' });
  const source = await history(store);
  await store.renameSession(source, '<script> session-secret-key </script>');
  const [record] = await store.listProjectSessions(source.workspace);
  assert.equal(record.title, '<script> [已隐藏密钥] </script>');
  assert.ok(!JSON.stringify(record).includes('session-secret-key'));
  const loaded = await store.getSession(source.id);
  assert.equal(loaded.customTitle, record.title);
  loaded.customTitle = 'bad\nname';
  assert.equal(store.sessionTitle(loaded), '第一条提示词');
});

test('renaming an old snapshot preserves newer disk messages, events and accounting metadata', async t => {
  const store = await fixture(t), source = await history(store), snapshot = await store.getSession(source.id);
  const snapshotMessages = structuredClone(snapshot.messages);
  const newer = { ...source, messages: [...source.messages, { role: 'assistant', content: '新完成的回复' }], events: [{ type: 'run-end', status: 'completed', elapsedMs: 4000 }], usageBaseline: { inputTokens: 900 }, contextCheckpoint: { throughIndex: 1 }, futureMetadata: { preserve: true } };
  await store.saveSession(newer);
  await store.renameSession(snapshot, '从另一个窗口重命名');
  const saved = await store.getSession(source.id);
  for (const field of ['messages', 'events', 'usageBaseline', 'contextCheckpoint', 'futureMetadata']) assert.deepEqual(saved[field], newer[field], field);
  assert.equal(saved.customTitle, '从另一个窗口重命名');
  assert.deepEqual(snapshot.messages, snapshotMessages, 'A title change does not silently advance the visible historical snapshot');
  assert.equal(snapshot.customTitle, saved.customTitle);
});

test('rename refuses mismatched projects and corrupt persisted sessions without overwriting either copy', async t => {
  const store = await fixture(t), source = await history(store), snapshot = structuredClone(source), filename = path.join(store.dir, 'sessions', source.id + '.json');
  for (const bytes of [JSON.stringify({ ...source, workspace: 'C:/OtherProject' }), '{damaged-json', JSON.stringify({ ...source, messages: 'corrupt' })]) {
    await fs.writeFile(filename, bytes);
    await assert.rejects(store.renameSession(snapshot, '不能覆盖'));
    assert.deepEqual(snapshot, source); assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  }
});

test('failed title persistence leaves in-memory title and existing history unchanged', async t => {
  const store = await fixture(t), source = await history(store), before = structuredClone(source), filename = path.join(store.dir, 'sessions', source.id + '.json'), bytes = await fs.readFile(filename, 'utf8');
  store.write = async () => { throw new Error('Injected atomic save failure'); };
  await assert.rejects(store.renameSession(source, '未保存的名字'), /Injected atomic save failure/u);
  assert.deepEqual(source, before); assert.equal(await fs.readFile(filename, 'utf8'), bytes);
});
