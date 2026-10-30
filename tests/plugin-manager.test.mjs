import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { PluginManager, validatePluginManifest, inspectPluginDirectory } = createRequire(import.meta.url)('../src/core/plugin-manager.cjs');
const testRoot = path.resolve('tests/.tmp');
const manifest = () => ({ schemaVersion: 1, id: 'demo.hello', name: 'Hello 插件', version: '1.0.0', entry: 'index.html',
  permissions: ['project.read', 'notifications'], commands: [{ id: 'hello.show', title: '显示问候' }] });
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'plugins-')), source = path.join(dir, 'source'), data = path.join(dir, 'data');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'synora-plugin.json'), JSON.stringify(manifest()));
  await fs.writeFile(path.join(source, 'index.html'), '<h1>Hello</h1><script src="main.js"></script>');
  await fs.writeFile(path.join(source, 'main.js'), 'throw new Error("plugin source must never run in Node")');
  const events = [], manager = new PluginManager({ dataDir: data, onChange: value => events.push(value) });
  await manager.init();
  t.after(async () => { await manager.dispose(); assert.equal(path.dirname(dir), testRoot); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, source, data, manager, events };
}
test('plugin manifests restrict executable entry paths, unsupported APIs and duplicate commands', () => {
  assert.equal(validatePluginManifest(manifest()).id, 'demo.hello');
  for (const patch of [{ id: '../escape' }, { entry: '../host.html' }, { entry: 'C:/secret.html' }, { entry: 'index.js' }, { entry: 'dir\\index.html' },
    { entry: 'dir%2findex.html' }, { permissions: ['shell'] }, { permissions: ['project.read', 'project.read'] }, { schemaVersion: 2 },
    { nodeIntegration: true }, { commands: [{ id: 'same', title: 'A' }, { id: 'same', title: 'B' }] }]) assert.throws(() => validatePluginManifest({ ...manifest(), ...patch }));
});
test('Cortex manifests install and reload while legacy manifests remain supported', async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.source, 'synora-plugin.json'), path.join(f.source, 'cortex-plugin.json'));
  await f.manager.install(f.source);
  const second = await new PluginManager({ dataDir: f.data }).init();
  assert.equal(second.list()[0].id, 'demo.hello'); await second.dispose();
  await fs.writeFile(path.join(f.source, 'synora-plugin.json'), JSON.stringify(manifest()));
  await assert.rejects(f.manager.preview(f.source), /一个 cortex-plugin/);
});
test('install is a managed copy, disabled initially, and never executes JavaScript', async t => {
  const f = await fixture(t);
  const preview = await f.manager.preview(f.source);
  assert.equal(preview.files, 3); assert.equal(preview.entry, 'index.html'); assert.ok(preview.totalBytes > 0);
  const listed = await f.manager.install(f.source);
  assert.equal(listed.length, 1); assert.equal(listed[0].enabled, false); assert.equal(listed[0].name, 'Hello 插件');
  assert.ok(!JSON.stringify(listed).includes(f.data));
  await fs.writeFile(path.join(f.source, 'index.html'), 'changed original');
  const internal = await f.manager.get('demo.hello');
  assert.match(await fs.readFile(path.join(internal.root, 'index.html'), 'utf8'), /<h1>Hello/);
  listed[0].permissions.push('shell'); listed[0].commands[0].title = 'mutated'; internal.manifest.name = 'mutated';
  assert.deepEqual(f.manager.list()[0].permissions, ['project.read', 'notifications']); assert.equal(f.manager.list()[0].commands[0].title, '显示问候');
  await assert.rejects(f.manager.install(f.source), /已安装/);
});
test('enabled state persists across restart; disabling and uninstalling notify listeners', async t => {
  const f = await fixture(t); await f.manager.install(f.source); await f.manager.setEnabled('demo.hello', true);
  const second = new PluginManager({ dataDir: f.data }); await second.init();
  assert.equal(second.list()[0].enabled, true); await second.dispose();
  await f.manager.setEnabled('demo.hello', false); assert.equal(f.events.at(-1)[0].enabled, false);
  const pluginRoot = (await f.manager.get('demo.hello')).root;
  await f.manager.uninstall('demo.hello'); assert.deepEqual(f.events.at(-1), []); assert.deepEqual(f.manager.list(), []);
  await assert.rejects(fs.access(pluginRoot), { code: 'ENOENT' });
});
test('uninstall only removes its managed folder and malformed registry IDs never escape storage', async t => {
  const f = await fixture(t); await f.manager.install(f.source);
  await fs.writeFile(path.join(f.data, 'keep.txt'), 'keep');
  await assert.rejects(f.manager.uninstall('../keep.txt'), /不存在/);
  await f.manager.uninstall('demo.hello'); assert.equal(await fs.readFile(path.join(f.data, 'keep.txt'), 'utf8'), 'keep');
  const corrupted = JSON.stringify({ schemaVersion: 1, plugins: [{ id: '../../outside', enabled: true }] });
  await fs.writeFile(path.join(f.data, 'plugins', 'registry.json'), corrupted);
  const second = await new PluginManager({ dataDir: f.data }).init(); assert.deepEqual(second.list(), []); assert.match(second.storageError, /原文件已保留/u);
  await assert.rejects(second.install(f.source), /配置损坏/u);
  assert.equal(await fs.readFile(path.join(f.data, 'plugins', 'registry.json'), 'utf8'), corrupted); await second.dispose();
});
test('missing HTML entry, malformed JSON and oversized source files are rejected before install', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.source, 'index.html')); await assert.rejects(f.manager.install(f.source), /入口/);
  await fs.writeFile(path.join(f.source, 'index.html'), 'html');
  await fs.writeFile(path.join(f.source, 'synora-plugin.json'), '{broken'); await assert.rejects(f.manager.install(f.source), /JSON/);
  await fs.writeFile(path.join(f.source, 'synora-plugin.json'), JSON.stringify(manifest()));
  await fs.writeFile(path.join(f.source, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1)); await assert.rejects(inspectPluginDirectory(f.source), /大小限制/);
  assert.deepEqual(f.manager.list(), []);
});
test('source hard links are rejected', async t => {
  const f = await fixture(t);
  try { await fs.link(path.join(f.source, 'main.js'), path.join(f.source, 'linked.js')); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'ENOTSUP') { t.skip('Filesystem does not allow test hard links.'); return; } throw error; }
  await assert.rejects(f.manager.preview(f.source), /普通文件/);
});
test('hidden source dependencies are not installed', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, 'node_modules')); await fs.writeFile(path.join(f.source, 'node_modules', 'ignored.js'), 'ignored');
  await fs.mkdir(path.join(f.source, '.git')); await fs.writeFile(path.join(f.source, '.git', 'config'), 'ignored');
  await f.manager.install(f.source); const internal = await f.manager.get('demo.hello');
  await assert.rejects(fs.access(path.join(internal.root, 'node_modules')), { code: 'ENOENT' });
});
test('concurrent registry mutations are serialized without losing independently installed plugins', async t => {
  const f = await fixture(t); await f.manager.install(f.source);
  const operations = [f.manager.setEnabled('demo.hello', true), f.manager.setEnabled('demo.hello', false), f.manager.setEnabled('demo.hello', true)];
  assert.equal(f.manager.pending, true); await Promise.all(operations); await f.manager.settled(); assert.equal(f.manager.pending, false);
  assert.equal(f.manager.list()[0].enabled, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.data, 'plugins', 'registry.json'), 'utf8')).plugins.map(({ id, enabled }) => ({ id, enabled })), [{ id: 'demo.hello', enabled: true }]);
});
test('failed uninstall keeps a disabled persisted entry and permits a scoped retry followed by reinstall', async t => {
  const f = await fixture(t); await f.manager.install(f.source); await f.manager.setEnabled('demo.hello', true);
  const pluginRoot = (await f.manager.get('demo.hello')).root, original = fs.rm;
  let locked = true;
  const mock = t.mock.method(fs, 'rm', async (target, ...args) => {
    if (locked && target === pluginRoot) throw Object.assign(new Error('fixture lock'), { code: 'EBUSY' });
    return original.call(fs, target, ...args);
  });
  await assert.rejects(f.manager.uninstall('demo.hello'), /重新点击/u);
  assert.equal(f.manager.list().length, 1); assert.equal(f.manager.list()[0].enabled, false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.data, 'plugins', 'registry.json'), 'utf8')).plugins.map(({ id, enabled }) => ({ id, enabled })), [{ id: 'demo.hello', enabled: false }]);
  const reopened = await new PluginManager({ dataDir: f.data }).init(); assert.equal(reopened.list()[0].enabled, false); await reopened.dispose();
  assert.match(await fs.readFile(path.join(pluginRoot, 'index.html'), 'utf8'), /Hello/u);
  locked = false; await f.manager.uninstall('demo.hello'); assert.deepEqual(f.manager.list(), []);
  await f.manager.install(f.source); assert.equal(f.manager.list().length, 1); mock.mock.restore();
});
test('partial uninstall failures survive restart as disabled recovery entries even when the manifest is gone', async t => {
  const f = await fixture(t); await f.manager.install(f.source); await f.manager.setEnabled('demo.hello', true);
  const pluginRoot = (await f.manager.get('demo.hello')).root, original = fs.rm;
  const mock = t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === pluginRoot) {
      await original.call(fs, path.join(pluginRoot, 'synora-plugin.json'), { force: true });
      throw Object.assign(new Error('fixture partially removed locked folder'), { code: 'EBUSY' });
    }
    return original.call(fs, target, ...args);
  });
  await assert.rejects(f.manager.uninstall('demo.hello'), /重新点击/u); mock.mock.restore();
  const reopened = await new PluginManager({ dataDir: f.data }).init();
  assert.equal(reopened.list().length, 1); assert.equal(reopened.list()[0].enabled, false);
  await assert.rejects(reopened.setEnabled('demo.hello', true), /不完整/u);
  await reopened.uninstall('demo.hello'); assert.deepEqual(reopened.list(), []); await reopened.dispose();
  await assert.rejects(fs.access(pluginRoot), { code: 'ENOENT' });
});
test('oversized optional plugin storage cannot stop application initialization or be overwritten by mutations', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.data, 'plugins'), { recursive: true });
  const registry = path.join(f.data, 'plugins', 'registry.json'), oversized = ' '.repeat(1024 * 1024 + 1);
  await fs.writeFile(registry, oversized);
  const recovered = await new PluginManager({ dataDir: f.data }).init(); assert.deepEqual(recovered.list(), []); assert.ok(recovered.storageError);
  await assert.rejects(recovered.install(f.source), /配置损坏/u);
  assert.equal((await fs.stat(registry)).size, oversized.length); await recovered.dispose();
});
