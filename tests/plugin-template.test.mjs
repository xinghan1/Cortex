import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createPluginExample } = createRequire(import.meta.url)('../src/core/plugin-template.cjs');

async function fixture(t) {
  const parent = path.resolve('tests/.tmp'); await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'plugin-template-'));
  const source = path.join(dir, 'source'), destination = path.join(dir, 'destination');
  await fs.mkdir(source); await fs.mkdir(destination);
  await fs.writeFile(path.join(source, 'index.html'), '<h1>示例</h1>\n');
  await fs.writeFile(path.join(source, 'synora-plugin.json'), '{"schemaVersion":1}\n');
  t.after(async () => { assert.equal(path.dirname(dir), parent); await fs.rm(dir, { recursive: true, force: true }); });
  return { source, destination };
}
test('creating the bundled example copies complete source into a new folder without preexisting-directory errors', async t => {
  const f = await fixture(t), created = await createPluginExample(f.source, f.destination);
  assert.equal(created, path.join(f.destination, 'hello-plugin'));
  assert.deepEqual((await fs.readdir(created)).sort(), ['index.html', 'synora-plugin.json']);
  for (const name of await fs.readdir(f.source)) assert.deepEqual(await fs.readFile(path.join(created, name)), await fs.readFile(path.join(f.source, name)));
});
test('creating an example never merges into or replaces an existing developer folder', async t => {
  const f = await fixture(t), target = path.join(f.destination, 'hello-plugin');
  await fs.mkdir(target); await fs.writeFile(path.join(target, 'index.html'), 'user work');
  await assert.rejects(createPluginExample(f.source, f.destination), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(target), ['index.html']); assert.equal(await fs.readFile(path.join(target, 'index.html'), 'utf8'), 'user work');
});
test('an incomplete or redirected bundled example fails before creating a developer folder', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.source, 'unexpected'));
  await assert.rejects(createPluginExample(f.source, f.destination), /不完整/u);
  assert.deepEqual(await fs.readdir(f.destination), []);
});
