import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createImageAssetStore } from '../src/core/image-asset-store.cjs';

test('generated image files are immutable and content-addressed, with copy and reveal', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synora-image-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pixels = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('test-image')]), url = `data:image/png;base64,${pixels.toString('base64')}`;
  const copied = [], revealed = [];
  const nativeImage = { createFromBuffer: data => ({ raw: data.toString('hex'), isEmpty: () => !data.length, getSize: () => ({ width: 10, height: 10 }) }) };
  const store = createImageAssetStore({ dataDir: dir, nativeImage, clipboard: { writeImage: img => copied.push(img) }, shell: { showItemInFolder: file => revealed.push(file) } });
  const first = await store.save(url), second = await store.save(url);
  assert.equal(first, second); assert.deepEqual(await fs.readFile(first), pixels); assert.equal(path.dirname(first), path.join(dir, 'generated-images'));
  const preview = `data:image/jpeg;base64,${Buffer.from([255,216,255,1,2,3]).toString('base64')}`;
  assert.equal(await store.materialize(preview, first), first, 'Existing original is reused rather than replaced by a preview');
  const legacy = await store.materialize(preview); assert.equal(path.extname(legacy), '.jpg');
  assert.deepEqual(await fs.readFile(legacy), Buffer.from([255,216,255,1,2,3]));
  await store.copy(preview, first); assert.equal(copied.length, 1); assert.equal(copied[0].raw, pixels.toString('hex'));
  await store.reveal(preview, first); assert.deepEqual(revealed, [first]);
  await assert.rejects(store.save('data:image/svg+xml;base64,PHN2Zz4='), /格式/);
  await fs.writeFile(first, 'tampered'); await assert.rejects(store.save(url), /校验/);
});

test('untrusted reveal paths cannot escape the managed image directory', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synora-image-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const value = Buffer.from([137,80,78,71,13,10,26,10,1]), url = `data:image/png;base64,${value.toString('base64')}`; let revealed;
  const store = createImageAssetStore({ dataDir: dir, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) }, clipboard: {}, shell: { showItemInFolder: file => { revealed = file; } } });
  await store.reveal(url, path.resolve(dir, '..', 'untrusted.png'));
  assert.equal(path.dirname(revealed), path.join(dir, 'generated-images'));
});
