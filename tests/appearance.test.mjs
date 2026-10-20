import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AppearanceStore, APPEARANCE_LIMITS } = require('../src/core/appearance.cjs');
const testRoot = path.resolve('tests', '.tmp');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', 'base64');
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64');
const initial = { backgroundImage: null, backgroundName: '', backgroundTransparency: 28, panelFrost: 70, panelTransparency: 30, conversationTextColor: 'white', backgroundPreset: 'aurora' };
const decoder = () => ({ width: 1, height: 1 });

async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'appearance-'));
  t.after(async () => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(target).startsWith('appearance-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const dataDir = path.join(dir, 'data');
  return {
    dir, dataDir, file: path.join(dataDir, 'appearance.json'),
    store: new AppearanceStore({ dataDir, decodeImage: decoder }),
    async image(name = 'background.png', bytes = PNG) {
      const filename = path.join(dir, name);
      await fs.writeFile(filename, bytes);
      return filename;
    },
  };
}

function safeFailure(code, privateValue) {
  return error => {
    assert.equal(error.code, code);
    assert.ok(error.message.length < 180);
    if (privateValue) assert.equal(error.message.includes(privateValue), false);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('default appearance is independent, lazy and does not create files or rewrite model settings', async t => {
  const { dir, dataDir, store } = await fixture(t);
  assert.deepEqual(store.snapshot(), initial);
  const snapshot = store.snapshot(); snapshot.backgroundTransparency = 91;
  assert.deepEqual(store.snapshot(), initial);
  assert.equal(await store.init(), store);
  await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
  await fs.mkdir(dataDir);
  const secretSettings = '{"encryptedKey":"test-only-local-value"}';
  await fs.writeFile(path.join(dataDir, 'settings.json'), secretSettings);
  await store.setAppearance({ backgroundTransparency: 0 });
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), secretSettings);
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ['appearance.json', 'settings.json']);
  assert.equal((await fs.readdir(dir)).includes('preferences.json'), false);
});

test('native-validated image and metadata commit together and survive source removal and reopening', async t => {
  const { dir, dataDir, file, store, image } = await fixture(t);
  const filename = await image();
  await store.setAppearance({ backgroundTransparency: 58 });
  const value = await store.importFile(filename);
  assert.deepEqual(value, { ...initial, backgroundImage: `data:image/png;base64,${PNG.toString('base64')}`, backgroundName: 'background.png', backgroundTransparency: 58 });
  await fs.unlink(filename);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...value });
  assert.equal((await fs.readFile(file, 'utf8')).includes(dir), false, 'Do not retain the external absolute path');
  let decodes = 0;
  const reopened = await new AppearanceStore({ dataDir, decodeImage: bytes => { decodes++; assert.deepEqual(bytes, PNG); return decoder(); } }).init();
  assert.deepEqual(reopened.snapshot(), value);
  for (let index = 0; index < 15; index++) { reopened.snapshot(); await reopened.init(); }
  assert.equal(decodes, 1, 'Snapshots and periodic init calls must not reread or decode');
  assert.deepEqual(await fs.readdir(dataDir), ['appearance.json']);
});

test('only integer transparency is accepted, both endpoints work and extra payload fields are rejected', async t => {
  const { file, store } = await fixture(t);
  for (const backgroundTransparency of [undefined, null, true, '28', -1, 101, 5.5, NaN, Infinity, {}, []]) {
    await assert.rejects(store.setAppearance({ backgroundTransparency }), safeFailure('APPEARANCE_INVALID_TRANSPARENCY'));
  }
  for (const payload of [null, undefined, [], {}, { backgroundTransparency: 45, backgroundImage: 'file:///private.png' }, { path: '/private.png' }]) {
    await assert.rejects(store.setAppearance(payload), safeFailure('APPEARANCE_INVALID_TRANSPARENCY'));
  }
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal((await store.setAppearance({ backgroundTransparency: 100 })).backgroundTransparency, 100);
  assert.equal((await store.setAppearance({ backgroundTransparency: 0 })).backgroundTransparency, 0);
});

test('global frost and panel transparency update independently, accept endpoints and survive reopening', async t => {
  const { dataDir, file, store, image } = await fixture(t);
  const original = await store.importFile(await image());
  assert.deepEqual(await store.setAppearance({ panelFrost: 0 }), { ...original, panelFrost: 0 });
  assert.deepEqual(await store.setAppearance({ panelTransparency: 100 }), { ...original, panelFrost: 0, panelTransparency: 100 });
  await store.setAppearance({ backgroundTransparency: 43, panelFrost: 100, panelTransparency: 0 });
  await store.setAppearance({ panelTransparency: 83 });
  const saved = await store.setAppearance({ panelFrost: 70 });
  assert.deepEqual(saved, { ...original, backgroundTransparency: 43, panelFrost: 70, panelTransparency: 83 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...saved });
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), saved);
});

test('invalid panel values and obsolete per-panel fields reject whole patches without modifying saved appearance', async t => {
  const { file, store } = await fixture(t);
  const saved = await store.setAppearance({ backgroundTransparency: 56, panelFrost: 18, panelTransparency: 27 });
  const serialized = await fs.readFile(file, 'utf8');
  for (const [field, code] of [['panelFrost', 'APPEARANCE_INVALID_FROST'], ['panelTransparency', 'APPEARANCE_INVALID_PANEL_TRANSPARENCY']]) {
    for (const value of [undefined, null, true, '70', -1, 101, 5.5, NaN, Infinity, {}, []]) {
      await assert.rejects(store.setAppearance({ backgroundTransparency: 90, [field]: value }), safeFailure(code));
    }
    for (const unexpected of [{ backgroundImage: 'file:///private.png' }, { path: '/private.png' }, { opacity: 50 }]) {
      await assert.rejects(store.setAppearance({ [field]: 50, ...unexpected }), safeFailure(code));
    }
  }
  for (const field of ['sidebarFrost', 'conversationFrost', 'previewFrost']) {
    await assert.rejects(store.setAppearance({ [field]: 70 }), safeFailure('APPEARANCE_INVALID_FROST'));
    assert.equal(Object.hasOwn(store.snapshot(), field), false);
  }
  await assert.rejects(store.setAppearance({ panelFrost: 12, backgroundTransparency: '90' }), safeFailure('APPEARANCE_INVALID_TRANSPARENCY'));
  assert.deepEqual(store.snapshot(), saved);
  assert.equal(await fs.readFile(file, 'utf8'), serialized);
});

test('version 1 backgrounds load with default panel settings without rewriting and migrate only on an explicit change', async t => {
  const { dataDir, file } = await fixture(t);
  await fs.mkdir(dataDir);
  for (const background of [
    { backgroundImage: null, backgroundName: '' },
    { backgroundImage: 'data:image/png;base64,' + PNG.toString('base64'), backgroundName: 'legacy.png' },
  ]) {
    const legacy = { version: 1, ...background, backgroundTransparency: 49 };
    const contents = JSON.stringify(legacy) + '\n';
    await fs.writeFile(file, contents);
    await fs.utimes(file, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    const modified = (await fs.stat(file)).mtimeMs;
    const store = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
    assert.deepEqual(store.snapshot(), { ...initial, ...background, backgroundTransparency: 49 });
    assert.equal(await fs.readFile(file, 'utf8'), contents);
    assert.equal((await fs.stat(file)).mtimeMs, modified);
    const changed = await store.setAppearance({ panelFrost: 24 });
    assert.deepEqual(changed, { ...initial, ...background, backgroundTransparency: 49, panelFrost: 24 });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...changed });
    assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), changed);
  }
});

test('version 2 backgrounds average legacy frost and default new settings without rewriting', async t => {
  const { dataDir, file } = await fixture(t);
  await fs.mkdir(dataDir);
  const legacy = {
    version: 2, backgroundImage: 'data:image/png;base64,' + PNG.toString('base64'),
    backgroundName: 'legacy-frost.png', backgroundTransparency: 39,
    sidebarFrost: 11, conversationFrost: 22, previewFrost: 33,
  };
  const contents = JSON.stringify(legacy) + '\n';
  await fs.writeFile(file, contents);
  const store = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
  const expected = { ...initial, backgroundImage: legacy.backgroundImage, backgroundName: legacy.backgroundName, backgroundTransparency: 39, panelFrost: 22 };
  assert.deepEqual(store.snapshot(), expected);
  assert.equal(await fs.readFile(file, 'utf8'), contents);
  const changed = await store.setAppearance({ conversationTextColor: 'blue' });
  assert.deepEqual(changed, { ...expected, conversationTextColor: 'blue' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...changed });
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), changed);
});

test('version 3 backgrounds preserve image and text color while averaging frost and defaulting the preset', async t => {
  const { dataDir, file } = await fixture(t);
  await fs.mkdir(dataDir);
  const legacy = {
    version: 3, backgroundImage: 'data:image/png;base64,' + PNG.toString('base64'),
    backgroundName: 'custom-colored.png', backgroundTransparency: 43,
    sidebarFrost: 19, conversationFrost: 28, previewFrost: 37, conversationTextColor: 'green',
  };
  const contents = JSON.stringify(legacy) + '\n';
  await fs.writeFile(file, contents);
  const store = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
  const expected = { ...initial, backgroundImage: legacy.backgroundImage, backgroundName: legacy.backgroundName, backgroundTransparency: 43, panelFrost: 28, conversationTextColor: 'green' };
  assert.deepEqual(store.snapshot(), expected);
  assert.equal(await fs.readFile(file, 'utf8'), contents);
  const changed = await store.setAppearance({ panelTransparency: 55 });
  assert.deepEqual(changed, { ...expected, panelTransparency: 55 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...changed });
});

test('version 4 migration rounds mixed frost to one setting and preserves the image, colors and preset without rewriting', async t => {
  const { dataDir, file } = await fixture(t);
  await fs.mkdir(dataDir);
  const legacy = {
    version: 4, backgroundImage: 'data:image/png;base64,' + PNG.toString('base64'),
    backgroundName: 'mixed-frost.png', backgroundTransparency: 64,
    sidebarFrost: 0, conversationFrost: 100, previewFrost: 0,
    conversationTextColor: 'blue', backgroundPreset: 'forest',
  };
  const contents = JSON.stringify(legacy) + '\n';
  await fs.writeFile(file, contents);
  await fs.utimes(file, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const modified = (await fs.stat(file)).mtimeMs;
  const store = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
  const expected = { ...initial, backgroundImage: legacy.backgroundImage, backgroundName: legacy.backgroundName, backgroundTransparency: 64, panelFrost: 33, conversationTextColor: 'blue', backgroundPreset: 'forest' };
  assert.deepEqual(store.snapshot(), expected);
  assert.equal(await fs.readFile(file, 'utf8'), contents);
  assert.equal((await fs.stat(file)).mtimeMs, modified);
  const saved = await store.setAppearance({ panelTransparency: 77 });
  assert.deepEqual(saved, { ...expected, panelTransparency: 77 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...saved });
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), saved);
  const roundsUp = JSON.stringify({ ...legacy, previewFrost: 100 });
  await fs.writeFile(file, roundsUp);
  const rounded = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
  assert.equal(rounded.snapshot().panelFrost, 67, 'Legacy averages round to the closest integer in either direction');
  assert.equal(await fs.readFile(file, 'utf8'), roundsUp);
});

test('each built-in background replaces an imported image and retains global panel settings across restart', async t => {
  const { dataDir, store, image } = await fixture(t);
  const filename = await image();
  await store.setAppearance({ panelFrost: 9, panelTransparency: 81, backgroundTransparency: 36, conversationTextColor: 'black' });
  for (const backgroundPreset of ['aurora', 'rose', 'amber', 'forest', 'ocean', 'snow', 'midnight', 'orange', 'purple', 'olive', 'pink', 'magenta', 'cyan']) {
    const previousPreset = store.snapshot().backgroundPreset;
    const imported = await store.importFile(filename);
    assert.equal(imported.backgroundPreset, previousPreset);
    assert.equal(imported.backgroundName, 'background.png');
    const changed = await store.setAppearance({ backgroundPreset });
    assert.deepEqual(changed, { ...initial, panelFrost: 9, panelTransparency: 81, backgroundTransparency: 36, conversationTextColor: 'black', backgroundPreset });
    assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), changed);
  }
  await store.importFile(filename);
  assert.deepEqual(await store.resetBackground(), { ...initial, panelFrost: 9, panelTransparency: 81, conversationTextColor: 'black' });
});

test('invalid presets preserve an imported image and cannot partially commit panel changes', async t => {
  const { file, store, image } = await fixture(t);
  await store.setAppearance({ backgroundPreset: 'ocean' });
  const saved = await store.importFile(await image());
  const serialized = await fs.readFile(file, 'utf8');
  for (const backgroundPreset of [undefined, null, true, 0, 70, 'Aurora', 'custom', '', 'url(file:///private.png)', {}, []]) {
    await assert.rejects(store.setAppearance({ backgroundPreset, backgroundTransparency: 99, conversationTextColor: 'red' }), safeFailure('APPEARANCE_INVALID_BACKGROUND_PRESET'));
  }
  for (const unexpected of [{ backgroundImage: 'file:///private.png' }, { path: '/private.png' }, { style: 'ocean' }]) {
    await assert.rejects(store.setAppearance({ backgroundPreset: 'snow', ...unexpected }), safeFailure('APPEARANCE_INVALID_BACKGROUND_PRESET'));
  }
  await assert.rejects(store.setAppearance({ backgroundPreset: 'snow', conversationTextColor: 'purple' }), safeFailure('APPEARANCE_INVALID_TEXT_COLOR'));
  await assert.rejects(store.setAppearance({ backgroundPreset: 'snow', panelFrost: -1 }), safeFailure('APPEARANCE_INVALID_FROST'));
  await assert.rejects(store.setAppearance({ backgroundPreset: 'snow', panelTransparency: 101 }), safeFailure('APPEARANCE_INVALID_PANEL_TRANSPARENCY'));
  assert.deepEqual(store.snapshot(), saved);
  assert.equal(await fs.readFile(file, 'utf8'), serialized);
});

test('rapid preset, image and partial panel changes retain call order and reset only background fields', async t => {
  const { dataDir, store, image } = await fixture(t);
  const filename = await image();
  const patch = { backgroundPreset: 'rose', conversationTextColor: 'red' };
  const pending = [
    store.setAppearance(patch),
    store.importFile(filename),
    store.setAppearance({ panelFrost: 14, panelTransparency: 25 }),
    store.setAppearance({ backgroundPreset: 'forest', conversationTextColor: 'yellow', backgroundTransparency: 71 }),
    store.setAppearance({ panelTransparency: 36 }),
    store.resetBackground(),
  ];
  patch.backgroundPreset = 'midnight';
  patch.conversationTextColor = 'black';
  const values = await Promise.all(pending);
  assert.equal(values[0].backgroundPreset, 'rose');
  assert.equal(values[0].conversationTextColor, 'red');
  assert.equal(values[1].backgroundPreset, 'rose');
  assert.equal(values[1].backgroundName, 'background.png');
  assert.equal(values[2].backgroundName, 'background.png');
  assert.deepEqual(values[4], { ...initial, backgroundPreset: 'forest', conversationTextColor: 'yellow', backgroundTransparency: 71, panelFrost: 14, panelTransparency: 36 });
  assert.deepEqual(values[5], { ...initial, conversationTextColor: 'yellow', panelFrost: 14, panelTransparency: 36 });
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), values[5]);
});

test('all six text colors persist independently and image import or reset preserves color and panel settings', async t => {
  const { dataDir, file, store, image } = await fixture(t);
  await store.setAppearance({ panelFrost: 12, panelTransparency: 34, backgroundTransparency: 78 });
  for (const conversationTextColor of ['red', 'yellow', 'green', 'blue', 'white', 'black']) {
    const value = await store.setAppearance({ conversationTextColor });
    assert.deepEqual(value, { ...initial, panelFrost: 12, panelTransparency: 34, backgroundTransparency: 78, conversationTextColor });
  }
  const imported = await store.importFile(await image());
  assert.equal(imported.conversationTextColor, 'black');
  const reset = await store.resetBackground();
  assert.deepEqual(reset, { ...initial, panelFrost: 12, panelTransparency: 34, conversationTextColor: 'black' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...reset });
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), reset);
});

test('invalid text colors reject the whole patch and valid color changes preserve ordered panel updates', async t => {
  const { file, store } = await fixture(t);
  const saved = await store.setAppearance({ conversationTextColor: 'yellow', panelTransparency: 13 });
  const serialized = await fs.readFile(file, 'utf8');
  for (const conversationTextColor of [undefined, null, true, 0, 70, '#fff', 'White', 'purple', 'auto', '', {}, []]) {
    await assert.rejects(store.setAppearance({ conversationTextColor, panelFrost: 99 }), safeFailure('APPEARANCE_INVALID_TEXT_COLOR'));
  }
  for (const unexpected of [{ backgroundImage: 'file:///private.png' }, { path: '/private.png' }, { color: 'white' }]) {
    await assert.rejects(store.setAppearance({ conversationTextColor: 'green', ...unexpected }), safeFailure('APPEARANCE_INVALID_TEXT_COLOR'));
  }
  assert.deepEqual(store.snapshot(), saved);
  assert.equal(await fs.readFile(file, 'utf8'), serialized);
  const patch = { conversationTextColor: 'red', panelFrost: 17 };
  const updates = [
    store.setAppearance(patch),
    store.setAppearance({ backgroundTransparency: 42, panelTransparency: 29 }),
    store.setAppearance({ conversationTextColor: 'green' }),
    store.setAppearance({ panelFrost: 83 }),
  ];
  patch.conversationTextColor = 'black';
  const values = await Promise.all(updates);
  assert.equal(values[0].conversationTextColor, 'red');
  assert.equal(values[1].conversationTextColor, 'red');
  assert.deepEqual(values[3], { ...initial, conversationTextColor: 'green', panelFrost: 83, panelTransparency: 29, backgroundTransparency: 42 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...values[3] });
});

test('queued partial panel updates and background reset preserve captured values and independent panel transparency', async t => {
  const { dataDir, store, image } = await fixture(t);
  const filename = await image();
  const patch = { panelFrost: 13 };
  const operations = [
    store.setAppearance(patch),
    store.importFile(filename),
    store.setAppearance({ panelTransparency: 26, backgroundTransparency: 64 }),
    store.setAppearance({ panelFrost: 39 }),
    store.resetBackground(),
  ];
  patch.panelFrost = 99;
  const values = await Promise.all(operations);
  assert.equal(values[0].panelFrost, 13);
  assert.equal(values[1].panelFrost, 13);
  assert.equal(values[1].backgroundName, 'background.png');
  assert.equal(values[2].panelTransparency, 26);
  assert.equal(values[2].panelFrost, 13);
  assert.equal(values[3].panelFrost, 39);
  const reset = { ...initial, panelFrost: 39, panelTransparency: 26 };
  assert.deepEqual(values[4], reset);
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), reset);
});

test('rapid import, transparency and reset operations keep call order and failed writes do not poison the queue', async t => {
  const { dataDir, file, store, image } = await fixture(t);
  const filename = await image();
  const operations = [store.importFile(filename), store.setAppearance({ backgroundTransparency: 75 }), store.resetBackground(), store.setAppearance({ backgroundTransparency: 34 })];
  const values = await Promise.all(operations);
  assert.equal(values[0].backgroundName, 'background.png');
  assert.equal(values[1].backgroundTransparency, 75);
  assert.deepEqual(values[2], initial);
  assert.deepEqual(values[3], { ...initial, backgroundTransparency: 34 });
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot(), values[3]);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(store.importFile(filename), safeFailure('APPEARANCE_SAVE_FAILED', dataDir));
  assert.deepEqual(store.snapshot(), values[3]);
  assert.deepEqual(await fs.readdir(dataDir), ['appearance.json']);
  await fs.rmdir(file);
  assert.equal((await store.importFile(filename)).backgroundName, 'background.png');
  assert.deepEqual((await store.resetBackground()), initial);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 5, ...initial });
});

test('invalid formats, mismatched extension and missing files preserve the last committed appearance', async t => {
  const { dir, file, store, image } = await fixture(t);
  const original = await store.importFile(await image());
  const serialized = await fs.readFile(file, 'utf8');
  const candidates = [
    await image('secret.svg', Buffer.from('<svg onload="alert(1)"/>')),
    await image('secret.jpg'),
    await image('broken.png', Buffer.from('<html>not an image</html>')),
    'relative.png', null,
  ];
  for (const filename of candidates) await assert.rejects(store.importFile(filename), safeFailure('APPEARANCE_INVALID_IMAGE', dir));
  await assert.rejects(store.importFile(path.join(dir, 'missing.png')), safeFailure('APPEARANCE_READ_FAILED', dir));
  assert.deepEqual(store.snapshot(), original);
  assert.equal(await fs.readFile(file, 'utf8'), serialized);
});

test('byte and dimension limits reject before decoding, including valid 8K metadata within bounds', async t => {
  const { dataDir, store, image } = await fixture(t);
  const oversized = await image('oversized.png', Buffer.alloc(APPEARANCE_LIMITS.maxImageBytes + 1));
  await assert.rejects(store.importFile(oversized), safeFailure('APPEARANCE_IMAGE_LIMIT'));
  let decodes = 0;
  const bounded = new AppearanceStore({ dataDir, decodeImage: () => { decodes++; return { width: 7680, height: 4320 }; } });
  for (const [width, height] of [[16385, 1], [8001, 8000], [0, 1]]) {
    const bytes = Buffer.from(PNG); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    await assert.rejects(bounded.importFile(await image('bounds.png', bytes)), safeFailure(width === 0 ? 'APPEARANCE_INVALID_IMAGE' : 'APPEARANCE_IMAGE_LIMIT'));
  }
  assert.equal(decodes, 0);
  const eightK = Buffer.from(PNG); eightK.writeUInt32BE(7680, 16); eightK.writeUInt32BE(4320, 20);
  assert.equal((await bounded.importFile(await image('8k.png', eightK))).backgroundName, '8k.png');
  assert.equal(decodes, 1, 'Within-bounds header must still be checked by the native decoder');
});

test('native decoder errors, empty decoded images and geometry disagreement cannot replace good state', async t => {
  const { dataDir, file, image } = await fixture(t);
  const filename = await image();
  let result = decoder();
  const store = await new AppearanceStore({ dataDir, decodeImage: () => { if (result instanceof Error) throw result; return result; } }).init();
  await store.importFile(filename);
  const original = await fs.readFile(file, 'utf8');
  for (result of [null, { width: 0, height: 0 }, { width: 2, height: 1 }, { width: '1', height: 1 }, new Error(`Decode ${filename}`)]) {
    await assert.rejects(store.importFile(filename), safeFailure('APPEARANCE_INVALID_IMAGE', filename));
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
});

test('JPEG and WebP media types are preserved and display names strip controls without retaining directories', async t => {
  const { store, image } = await fixture(t);
  const jpeg = await store.importFile(await image('soft.JPEG', JPEG));
  assert.equal(jpeg.backgroundImage, `data:image/jpeg;base64,${JPEG.toString('base64')}`);
  const value = await store.importFile(await image('soft.webp', WEBP));
  assert.equal(value.backgroundImage, `data:image/webp;base64,${WEBP.toString('base64')}`);
  const cleaned = await store.importFile(await image('safe\u202ename.png'));
  assert.equal(cleaned.backgroundName, 'safename.png');
});

test('corrupt, noncanonical, unexpected or path-bearing metadata defaults safely without overwriting it', async t => {
  const { dataDir, file, image } = await fixture(t);
  await fs.mkdir(dataDir);
  const good = { version: 1, backgroundImage: `data:image/png;base64,${PNG.toString('base64')}`, backgroundName: 'saved.png', backgroundTransparency: 42 };
  const current = { ...good, version: 2, sidebarFrost: 70, conversationFrost: 70, previewFrost: 70 };
  const colored = { ...current, version: 3, conversationTextColor: 'blue' };
  const preset = { ...colored, version: 4, backgroundPreset: 'ocean' };
  const global = { version: 5, ...initial, backgroundImage: good.backgroundImage, backgroundName: 'saved.png' };
  const documents = ['{', 'null', '[]', '{}',
    JSON.stringify({ ...global, version: 6 }),
    JSON.stringify({ ...global, panelFrost: undefined }),
    JSON.stringify({ ...global, panelTransparency: undefined }),
    JSON.stringify({ ...global, panelFrost: '70' }),
    JSON.stringify({ ...global, panelTransparency: null }),
    JSON.stringify({ ...global, panelTransparency: -1 }),
    JSON.stringify({ ...global, panelTransparency: 101 }),
    JSON.stringify({ ...global, sidebarFrost: 70 }),
    JSON.stringify({ ...global, backgroundPreset: 'custom' }),
    JSON.stringify({ ...global, conversationTextColor: 'auto' }),
    JSON.stringify({ ...global, path: '/private/background.png' }),
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, version: 3 }),
    JSON.stringify({ ...current, version: 3 }),
    JSON.stringify({ ...colored, version: 4 }),
    JSON.stringify({ ...preset, version: 5 }),
    JSON.stringify({ ...preset, backgroundPreset: 'custom' }),
    JSON.stringify({ ...preset, backgroundPreset: null }),
    JSON.stringify({ ...preset, backgroundPreset: 'url(https://private.invalid)' }),
    JSON.stringify({ ...preset, path: '/private/background.png' }),
    JSON.stringify({ ...colored, conversationTextColor: 'auto' }),
    JSON.stringify({ ...colored, conversationTextColor: null }),
    JSON.stringify({ ...colored, conversationTextColor: '#fff' }),
    JSON.stringify({ ...colored, backgroundImage: 'https://private.invalid/background.png' }),
    JSON.stringify({ ...good, sidebarFrost: 70 }),
    JSON.stringify({ ...current, sidebarFrost: -1 }),
    JSON.stringify({ ...current, conversationFrost: '70' }),
    JSON.stringify({ ...current, previewFrost: 101 }),
    JSON.stringify({ ...current, path: '/private/background.png' }),
    JSON.stringify({ ...good, backgroundTransparency: '42' }),
    JSON.stringify({ ...good, backgroundName: '../saved.png' }),
    JSON.stringify({ ...good, backgroundImage: 'https://private.invalid/background.png' }),
    JSON.stringify({ ...good, backgroundImage: 'data:image/svg+xml;base64,PHN2Zy8+' }),
    JSON.stringify({ ...good, backgroundImage: good.backgroundImage + '\n' }),
    JSON.stringify({ ...good, externalPath: '/private/source.png' }),
    JSON.stringify({ ...good, backgroundImage: null }),
  ];
  for (const contents of documents) {
    await fs.writeFile(file, contents);
    const store = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
    assert.deepEqual(store.snapshot(), initial);
    assert.equal(await fs.readFile(file, 'utf8'), contents);
  }
  const store = await new AppearanceStore({ dataDir, decodeImage: decoder }).init();
  await store.importFile(await image());
  assert.equal((await new AppearanceStore({ dataDir, decodeImage: decoder }).init()).snapshot().backgroundName, 'background.png');
  const persisted = await fs.readFile(file, 'utf8');
  assert.deepEqual((await new AppearanceStore({ dataDir, decodeImage: () => null }).init()).snapshot(), initial);
  assert.equal(await fs.readFile(file, 'utf8'), persisted, 'Invalid native decode must not rewrite stored bytes during initialization');
});

test('loading and immediately queued writes do not restore stale state over the latest setting', async t => {
  const { dataDir, file, store, image } = await fixture(t);
  await store.importFile(await image());
  const reopened = new AppearanceStore({ dataDir, decodeImage: decoder });
  const loading = reopened.init();
  const changes = [reopened.setAppearance({ backgroundTransparency: 51 }), reopened.setAppearance({ backgroundTransparency: 87 })];
  await loading; await Promise.all(changes);
  assert.equal(reopened.snapshot().backgroundTransparency, 87);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).backgroundTransparency, 87);
  assert.equal(reopened.snapshot().backgroundName, 'background.png');
});

test('invalid construction cannot omit the trusted native image validator', () => {
  for (const options of [undefined, null, {}, { dataDir: '' }, { dataDir: 'a\0b', decodeImage: decoder }, { dataDir: '.', decodeImage: null }]) {
    assert.throws(() => new AppearanceStore(options), { code: 'APPEARANCE_INVALID_CONFIG' });
  }
});
