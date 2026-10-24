import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DshPetStore, PET_LIMITS, parseJsonc } = require('../src/core/dsh-pet.cjs');
const root = path.resolve('tests', '.tmp');
const sample = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('test-webm-header'), Buffer.alloc(64)]);
const initial = { enabled: true, size: 220, x: 1, y: 1, workStatus: true, packId: 'dsh-pet' };
const config = () => ({ pets: [{ name: '测试鲸鱼' }], animations: { idle: ['呼吸'], clicks: ['开心'], events: { workStatus: ['思考', ['工作', '敲键盘'], '归档', '等待', '成功', '出错'] } } });

async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'dsh-pet-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert.ok(path.basename(dir).startsWith('dsh-pet-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const dataDir = path.join(dir, 'data');
  const store = new DshPetStore({ dataDir });
  async function pack(value = config(), layout = 'webm') {
    const sourceDir = path.join(dir, `source-${(await fs.readdir(dir)).length}`);
    await fs.mkdir(path.join(sourceDir, layout), { recursive: true });
    const filename = path.join(sourceDir, layout === 'kitty-animation/webm' ? 'kitty-config.json' : layout === 'main-animation/webm' ? 'main-config.jsonc' : 'config.jsonc');
    await fs.writeFile(filename, JSON.stringify(value));
    for (const name of ['呼吸', '开心', '思考', '工作', '敲键盘', '归档', '等待', '成功', '出错']) await fs.writeFile(path.join(sourceDir, layout, `${name}.webm`), sample);
    return { sourceDir, filename, animationDir: path.join(sourceDir, layout) };
  }
  return { dir, dataDir, store, pack };
}

const hasCode = code => error => { assert.equal(error.code, code); assert.equal(error.cause, undefined); assert.ok(error.message.length < 200); return true; };

test('built-in pet is visible by default, local, cloned and requires no writable data or executable runtime', async t => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  const { packs, ...settings } = store.snapshot();
  assert.deepEqual(settings, initial);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, 'dsh-pet');
  assert.equal(packs[0].license, 'MIT');
  assert.equal(packs[0].animations.thinking[0].name, '工作状态-思考冒泡');
  for (const entries of Object.values(packs[0].animations)) for (const clip of entries) {
    assert.equal(new URL(clip.url).protocol, 'file:');
    const bytes = await fs.readFile(fileURLToPath(clip.url));
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  packs[0].animations.idle[0].name = 'changed'; packs.length = 0;
  assert.equal(store.snapshot().packs[0].animations.idle[0].name, '待机呼吸休闲');
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});

test('bundled original assets match pinned provenance and include the upstream MIT notice', async () => {
  const dir = path.resolve('src', 'vendor', 'dsh-pet');
  const provenance = JSON.parse(await fs.readFile(path.join(dir, 'provenance.json'), 'utf8'));
  assert.equal(provenance.commit, '86bc30c83225919434de8396073078dc22e926fd');
  assert.equal(provenance.version, '0.3.8');
  assert.equal(provenance.assets.length, 11);
  let bytes = 0;
  for (const asset of provenance.assets) {
    const contents = await fs.readFile(path.join(dir, asset.path));
    assert.equal(contents.length, asset.size);
    assert.equal(createHash('sha256').update(contents).digest('hex'), asset.sha256);
    bytes += contents.length;
  }
  assert.ok(bytes < 5 * 1024 * 1024);
  assert.match(await fs.readFile(path.join(dir, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 PC2005-cloud/u);
});

test('JSONC parser preserves quoted comment markers, unicode and escaped quotes without evaluating code', () => {
  assert.deepEqual(parseJsonc('\uFEFF{/*x*/"url":"https://example.com/a//b", // comment\n "text":"鲸鱼\\\"/*ok*/", "list":[1,2,],}'), { url: 'https://example.com/a//b', text: '鲸鱼"/*ok*/', list: [1, 2] });
  for (const text of ['{ bad: true }', '{"x": function(){}}', '{"x":1/*', 'globalThis.eval("x")', '{"x":"unterminated}']) assert.throws(() => parseJsonc(text), hasCode('PET_INVALID_PACK'));
  assert.throws(() => parseJsonc(' '.repeat(PET_LIMITS.configBytes + 1)), hasCode('PET_INVALID_PACK'));
});

test('settings persist atomically, merge concurrent patches and leave model account configuration unchanged', async t => {
  const { dataDir, store } = await fixture(t);
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'settings.json'), 'independent-model-secret');
  await Promise.all([store.set({ enabled: false, size: 600 }), store.set({ x: 0.25, y: 0 }), store.set({ workStatus: false })]);
  await store.settled();
  const reopened = await new DshPetStore({ dataDir }).init();
  const { packs, ...value } = reopened.snapshot();
  assert.deepEqual(value, { ...initial, enabled: false, size: 600, x: 0.25, y: 0, workStatus: false });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'pet-settings.json'), 'utf8')), { version: 1, ...value });
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), 'independent-model-secret');
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ['pet-settings.json', 'settings.json']);
});

test('strict pet patches reject unknown fields, nonfinite positions, malformed types and unavailable packs', async t => {
  const { dataDir, store } = await fixture(t);
  for (const patch of [null, [], {}, { command: 'start executable' }, { enabled: 1 }, { workStatus: 'true' }, { size: 79 }, { size: 601 }, { size: 220.1 }, { x: -1 }, { x: NaN }, { y: Infinity }, { y: 1.1 }, { packId: '../escape' }, { packId: 'local-012345678901234567890123' }]) await assert.rejects(store.set(patch), hasCode('PET_INVALID_SETTINGS'));
  const { packs, ...state } = store.snapshot();
  assert.deepEqual(state, initial);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
  assert.equal((await store.set({ size: 80, x: 0, y: 1 })).size, 80);
});

test('corrupt preferences fall back safely without overwriting the original file', async t => {
  const { dataDir, store } = await fixture(t);
  await fs.mkdir(dataDir);
  const contents = '{"version":1,"enabled":false,"size":2}';
  await fs.writeFile(path.join(dataDir, 'pet-settings.json'), contents);
  await store.init();
  assert.equal(store.snapshot().enabled, true);
  assert.equal(await fs.readFile(path.join(dataDir, 'pet-settings.json'), 'utf8'), contents);
});

test('import copies complete DSH animation pools, preserves status alternatives and survives source removal and restart', async t => {
  const { dataDir, store, pack } = await fixture(t);
  const { filename, sourceDir } = await pack();
  const imported = await store.importFile(filename);
  assert.match(imported.packId, /^local-[a-f0-9]{24}$/u);
  assert.equal(imported.enabled, true);
  const selected = imported.packs.find(item => item.id === imported.packId);
  assert.equal(selected.name, '测试鲸鱼');
  assert.deepEqual(selected.animations.working.map(item => item.name), ['工作', '敲键盘']);
  for (const entries of Object.values(selected.animations)) for (const clip of entries) assert.ok(fileURLToPath(clip.url).startsWith(path.join(dataDir, 'pet-packs')));
  await fs.rm(sourceDir, { recursive: true, force: true });
  const reopened = await new DshPetStore({ dataDir }).init();
  assert.deepEqual(reopened.snapshot(), imported);
  for (const clip of selected.animations.working) assert.deepEqual(await fs.readFile(fileURLToPath(clip.url)), sample);
});

test('imports support upstream main-animation and named pet pack layout plus directory selection', async t => {
  const { store, pack } = await fixture(t);
  for (const layout of ['main-animation/webm', 'kitty-animation/webm']) {
    const source = await pack(config(), layout);
    const result = layout.startsWith('main') ? await store.importDirectory(source.sourceDir) : await store.importFile(source.filename);
    assert.equal(result.packs.length, 2, 'identical clips and map import once');
    assert.equal(result.packs.at(-1).animations.idle[0].name, '呼吸');
  }
});

test('reimport is deduplicated and selects the existing pack without copying unrelated files', async t => {
  const { dataDir, store, pack } = await fixture(t);
  const { filename, sourceDir } = await pack();
  await fs.writeFile(path.join(sourceDir, 'do-not-run.cjs'), 'throw new Error("must not execute")');
  const first = await store.importFile(filename);
  await store.set({ enabled: false, packId: 'dsh-pet' });
  const second = await store.importFile(filename);
  assert.equal(second.packId, first.packId);
  assert.equal(second.packs.length, 2);
  const destination = path.join(dataDir, 'pet-packs', first.packId);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['manifest.json', 'webm']);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'pet-packs')), [first.packId]);
});

test('a copied pet remains recoverable when preference saving fails and a retry selects it without replacing files', async t => {
  const { dataDir, store, pack } = await fixture(t);
  const { filename } = await pack();
  const blocked = path.join(dataDir, 'pet-settings.json');
  await fs.mkdir(blocked, { recursive: true });
  await assert.rejects(store.importFile(filename), hasCode('PET_STORAGE_ERROR'));
  const failed = store.snapshot();
  assert.equal(failed.packId, 'dsh-pet');
  assert.equal(failed.packs.length, 2);
  const copiedId = failed.packs.at(-1).id;
  const copiedFile = fileURLToPath(failed.packs.at(-1).animations.idle[0].url);
  const before = await fs.stat(copiedFile);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'pet-packs')), [copiedId]);
  await fs.rmdir(blocked);
  const retried = await store.importFile(filename);
  assert.equal(retried.packId, copiedId); assert.equal(retried.packs.length, 2);
  assert.equal((await fs.stat(copiedFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual((await new DshPetStore({ dataDir }).init()).snapshot(), retried);
});

test('missing, malformed and remote/path traversal animations fail before writing settings or data', async t => {
  const { dataDir, store, pack } = await fixture(t);
  for (const name of ['../outside', 'nested/file', 'C:\\private', 'https://example.com/clip', '..', 'bad\u0000name']) {
    const value = config(); value.animations.idle = [name];
    const { filename } = await pack(value);
    await assert.rejects(store.importFile(filename), hasCode('PET_INVALID_PACK'));
  }
  const missing = await pack(); await fs.unlink(path.join(missing.animationDir, '成功.webm'));
  await assert.rejects(store.importFile(missing.filename), hasCode('PET_INVALID_PACK'));
  const invalid = await pack(); await fs.writeFile(path.join(invalid.animationDir, '呼吸.webm'), '<script>throw 1</script>');
  await assert.rejects(store.importFile(invalid.filename), hasCode('PET_INVALID_PACK'));
  assert.equal(store.snapshot().packs.length, 1);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});

test('referenced animation limits and per-file size are enforced', async t => {
  const { store, pack } = await fixture(t);
  const configValue = config(); configValue.animations.idle = Array.from({ length: PET_LIMITS.clips + 1 }, (_, index) => `idle${index}`);
  const many = await pack(configValue);
  await assert.rejects(store.importFile(many.filename), hasCode('PET_INVALID_PACK'));
  const oversized = await pack();
  const handle = await fs.open(path.join(oversized.animationDir, '呼吸.webm'), 'r+');
  await handle.truncate(PET_LIMITS.clipBytes + 1); await handle.close();
  await assert.rejects(store.importFile(oversized.filename), hasCode('PET_INVALID_PACK'));
});

test('directory reparse points cannot redirect imported animations outside the selected pack', async t => {
  const { dir, dataDir, store, pack } = await fixture(t);
  const { filename, sourceDir, animationDir } = await pack();
  const external = path.join(dir, 'external-clips');
  await fs.rename(animationDir, external);
  try { await fs.symlink(external, path.join(sourceDir, 'webm'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink permission unavailable'); return; } throw error; }
  await assert.rejects(store.importFile(filename), hasCode('PET_INVALID_PACK'));
  assert.deepEqual(await fs.readFile(path.join(external, '呼吸.webm')), sample);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
});

test('damaged imported packs are omitted on restart and a missing selected pack returns to built-in', async t => {
  const { dataDir, store, pack } = await fixture(t);
  const imported = await store.importFile((await pack()).filename);
  await fs.writeFile(path.join(dataDir, 'pet-packs', imported.packId, 'webm', '成功.webm'), 'not webm');
  const reopened = await new DshPetStore({ dataDir }).init();
  assert.equal(reopened.snapshot().packs.length, 1);
  assert.equal(reopened.snapshot().packId, 'dsh-pet');
  assert.equal(reopened.snapshot().enabled, true);
});

test('the vendored compact DSH configuration is itself importable', async t => {
  const { store } = await fixture(t);
  const imported = await store.importDirectory(path.resolve('src', 'vendor', 'dsh-pet'));
  assert.equal(imported.packs.length, 2);
  assert.equal(imported.packs.at(-1).license, 'MIT');
  assert.equal(Object.values(imported.packs.at(-1).animations).flat().length, 11);
});
