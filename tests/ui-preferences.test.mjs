import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UIPreferences, DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS } = require('../src/core/ui-preferences.cjs');
const testRoot = path.resolve('tests', '.tmp');

async function removeFixture(dir) {
  const target = path.resolve(dir);
  // Every recursive cleanup is restricted to a direct child created for this
  // test suite. Never delete the shared temporary root or a computed ancestor.
  assert.equal(path.dirname(target).toLowerCase(), testRoot.toLowerCase());
  assert.ok(path.basename(target).startsWith('ui-preferences-'));
  await fs.rm(target, { recursive: true, force: true });
}

async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'ui-preferences-'));
  t.after(() => removeFixture(dir));
  return { dir, file: path.join(dir, 'preferences.json') };
}

test('missing preferences default to 100 without creating files; saved scale survives reopening', async t => {
  const { dir, file } = await fixture(t);
  const preferences = new UIPreferences({ dataDir: dir });
  assert.equal(preferences.textScale, 100);
  assert.equal(preferences.contextCompressionTriggerTokens, 850000);
  assert.equal(DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS, 850000);
  assert.equal(await preferences.init(), preferences);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await preferences.setTextScale(130), 130);
  assert.equal(preferences.textScale, 130);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2, textScale: 130, contextCompressionTriggerTokens: 850000 });
  const reopened = new UIPreferences(dir);
  await reopened.init();
  assert.equal(reopened.textScale, 130);
  assert.equal(reopened.contextCompressionTriggerTokens, 850000);
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
});

test('invalid values reject without changing persisted preferences or model settings', async t => {
  const { dir, file } = await fixture(t);
  const settings = path.join(dir, 'settings.json');
  const modelSettings = '{"provider":"deepseek","encryptedKey":"mock-encrypted-value"}';
  await fs.writeFile(settings, modelSettings);
  const preferences = await new UIPreferences(dir).init();
  await preferences.setTextScale(110);
  const original = await fs.readFile(file, 'utf8');
  for (const value of [undefined, null, false, '100', 0, 70, 170, 85, 100.5, NaN, Infinity, {}, []]) {
    await assert.rejects(preferences.setTextScale(value), { code: 'UI_PREFERENCES_INVALID_SCALE' });
  }
  assert.equal(preferences.textScale, 110);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(await fs.readFile(settings, 'utf8'), modelSettings);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['preferences.json', 'settings.json']);
});

test('damaged, unexpected and invalid-version files fall back to 100 and can be replaced', async t => {
  const { dir, file } = await fixture(t);
  for (const value of ['{', 'null', '[]', '{}', '{"version":2,"textScale":140}',
    '{"version":1,"textScale":85}', '{"version":1,"textScale":"140"}',
    '{"version":1,"textScale":140,"unexpected":true}']) {
    await fs.writeFile(file, value);
    const preferences = await new UIPreferences(dir).init();
    assert.equal(preferences.textScale, 100);
    assert.equal(await fs.readFile(file, 'utf8'), value, 'Initialization must not rewrite damaged data');
    await preferences.setTextScale(140);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2, textScale: 140, contextCompressionTriggerTokens: 850000 });
  }
});

test('rapid writes are ordered and initialization cannot overwrite a later saved scale', async t => {
  const { dir, file } = await fixture(t);
  await fs.writeFile(file, '{"version":1,"textScale":120}');
  const preferences = new UIPreferences(dir);
  const initializing = preferences.init();
  const scales = Array.from({ length: 45 }, (_, index) => 80 + (index % 9) * 10);
  const completed = [];
  const writes = scales.map(scale => preferences.setTextScale(scale).then(value => { completed.push(value); return value; }));
  await initializing;
  assert.deepEqual(await Promise.all(writes), scales);
  assert.deepEqual(completed, scales);
  assert.equal(preferences.textScale, scales.at(-1));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).textScale, scales.at(-1));
  assert.equal((await new UIPreferences(dir).init()).textScale, scales.at(-1));
  await preferences.init();
  assert.equal(preferences.textScale, scales.at(-1));
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
});

test('rename failures keep the previous value, clean temporary files and do not poison later writes', async t => {
  const { dir, file } = await fixture(t);
  const preferences = await new UIPreferences(dir).init();
  await preferences.setTextScale(110);
  await fs.unlink(file);
  await fs.mkdir(file);
  const failed = preferences.setTextScale(120);
  await assert.rejects(failed, error => {
    assert.equal(error.code, 'UI_PREFERENCES_SAVE_FAILED');
    assert.equal(error.message.includes(dir), false);
    assert.equal(error.message.includes('preferences.json'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(preferences.textScale, 110);
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
  await fs.rmdir(file);
  assert.equal(await preferences.setTextScale(150), 150);
  assert.equal(preferences.textScale, 150);
  assert.equal((await new UIPreferences(dir).init()).textScale, 150);
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
});

test('a missing data directory is created only when saving and non-directory errors remain recoverable', async t => {
  const { dir } = await fixture(t);
  const nested = path.join(dir, 'new-data');
  const preferences = await new UIPreferences({ dataDir: nested }).init();
  assert.equal(preferences.textScale, 100);
  await assert.rejects(fs.stat(nested), { code: 'ENOENT' });
  await fs.writeFile(nested, 'blocks the directory');
  await assert.rejects(preferences.setTextScale(80), { code: 'UI_PREFERENCES_SAVE_FAILED' });
  assert.equal(preferences.textScale, 100);
  await fs.unlink(nested);
  await preferences.setTextScale(80);
  assert.equal((await new UIPreferences(nested).init()).textScale, 80);
});

test('invalid construction and recursive cleanup cannot target the shared root or unrelated directories', async () => {
  for (const value of [undefined, null, {}, '', { dataDir: '' }, { dataDir: 123 }, { dataDir: 'a\0b' }]) {
    assert.throws(() => new UIPreferences(value), { code: 'UI_PREFERENCES_INVALID_CONFIG' });
  }
  for (const target of [testRoot, path.dirname(testRoot), path.join(testRoot, 'store-unrelated'), path.join(testRoot, '..', 'ui-preferences-outside')]) {
    await assert.rejects(removeFixture(target), { name: 'AssertionError' });
  }
});

test('legacy v1 scale migrates in memory and saves alongside the default compression threshold', async t => {
  const { dir, file } = await fixture(t);
  const legacy = '{"version":1,"textScale":140}';
  await fs.writeFile(file, legacy);
  const preferences = await new UIPreferences(dir).init();
  assert.equal(preferences.textScale, 140); assert.equal(preferences.contextCompressionTriggerTokens, 850000);
  assert.equal(await fs.readFile(file, 'utf8'), legacy, 'Reading old preferences must not force a filesystem migration');
  assert.equal(await preferences.setContextCompressionTriggerTokens(900000), 900000);
  assert.deepEqual(preferences.snapshot(), { version: 2, textScale: 140, contextCompressionTriggerTokens: 900000 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), preferences.snapshot());
  assert.deepEqual((await new UIPreferences(dir).init()).snapshot(), preferences.snapshot());
  const external = preferences.snapshot(); external.contextCompressionTriggerTokens = 1;
  assert.equal(preferences.contextCompressionTriggerTokens, 900000, 'A returned snapshot must not mutate stored preferences');
});

test('compression threshold accepts inclusive integer bounds and rejects invalid values without touching either preference', async t => {
  const { dir, file } = await fixture(t);
  const preferences = await new UIPreferences(dir).init();
  await preferences.setTextScale(120);
  for (const value of [1000, 850000, 16000000]) {
    assert.equal(await preferences.setContextCompressionTriggerTokens(value), value);
    assert.equal((await new UIPreferences(dir).init()).contextCompressionTriggerTokens, value);
  }
  const saved = await fs.readFile(file, 'utf8');
  for (const value of [undefined, null, false, true, '850000', '', 0, 999, 16000001, -1, 1000.5, NaN, Infinity, {}, []]) {
    await assert.rejects(preferences.setContextCompressionTriggerTokens(value), { code: 'UI_PREFERENCES_INVALID_CONTEXT_TRIGGER' });
  }
  assert.equal(preferences.contextCompressionTriggerTokens, 16000000);
  assert.equal(preferences.textScale, 120);
  assert.equal(await fs.readFile(file, 'utf8'), saved);
});

test('mixed rapid scale and threshold changes share a queue without losing the other field', async t => {
  const { dir, file } = await fixture(t);
  await fs.writeFile(file, '{"version":1,"textScale":110}');
  const preferences = new UIPreferences(dir), writes = [];
  for (let index = 0; index < 20; index++) {
    writes.push(preferences.setTextScale(80 + index % 9 * 10));
    writes.push(preferences.setContextCompressionTriggerTokens(850000 + index));
  }
  await Promise.all(writes);
  assert.equal(preferences.textScale, 80 + 19 % 9 * 10);
  assert.equal(preferences.contextCompressionTriggerTokens, 850019);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), preferences.snapshot());
  assert.deepEqual((await new UIPreferences(dir).init()).snapshot(), preferences.snapshot());
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
});

test('failed threshold writes preserve both persisted values and the queue recovers for scale and threshold', async t => {
  const { dir, file } = await fixture(t);
  const preferences = await new UIPreferences(dir).init();
  await preferences.setTextScale(130); await preferences.setContextCompressionTriggerTokens(950000);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(preferences.setContextCompressionTriggerTokens(1000000), error => {
    assert.equal(error.code, 'UI_PREFERENCES_SAVE_FAILED'); assert.equal(error.message.includes(dir), false); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(preferences.textScale, 130); assert.equal(preferences.contextCompressionTriggerTokens, 950000);
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
  await fs.rmdir(file);
  await preferences.setTextScale(150);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2, textScale: 150, contextCompressionTriggerTokens: 950000 });
  await preferences.setContextCompressionTriggerTokens(1000000);
  assert.deepEqual((await new UIPreferences(dir).init()).snapshot(), preferences.snapshot());
});

test('invalid v2 thresholds and unknown fields cannot silently take effect or rewrite a damaged file', async t => {
  const { dir, file } = await fixture(t);
  for (const record of [
    { version: 2, textScale: 140, contextCompressionTriggerTokens: 999 },
    { version: 2, textScale: 140, contextCompressionTriggerTokens: '850000' },
    { version: 2, textScale: 140, contextCompressionTriggerTokens: 16000001 },
    { version: 2, textScale: 140, contextCompressionTriggerTokens: 850000, unknown: true },
    { version: 2, textScale: 85, contextCompressionTriggerTokens: 950000 },
  ]) {
    const encoded = JSON.stringify(record); await fs.writeFile(file, encoded);
    const preferences = await new UIPreferences(dir).init();
    assert.deepEqual(preferences.snapshot(), { version: 2, textScale: 100, contextCompressionTriggerTokens: 850000 });
    assert.equal(await fs.readFile(file, 'utf8'), encoded);
  }
});
