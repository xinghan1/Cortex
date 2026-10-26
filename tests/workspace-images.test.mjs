import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { IMAGE_ATTACHMENT_LIMITS } from '../src/core/message-images.mjs';
import { testTempRoot } from './helpers/temp-root.mjs';
import { withFileCommit } from '../src/core/file-commit.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEBAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', 'base64');
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(testTempRoot, 'synora-image-reader-'));
  const root = path.join(parent, 'project'), outside = path.join(parent, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(parent)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(parent).startsWith('synora-image-reader-'));
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, outside, tools: new WorkspaceTools(root, options) };
}

function noisyPng() {
  const chunk = (name, data) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(512, 0); header.writeUInt32BE(512, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(512 * (512 * 4 + 1));
  for (let row = 0; row < 512; row++) randomBytes(512 * 4).copy(pixels, row * (512 * 4 + 1) + 1);
  return Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('image reads identify supported containers from bytes and return original normalized attachments', async t => {
  const { root, tools } = await fixture(t);
  for (const [name, bytes, mediaType] of [['layout.data', PNG, 'image/png'], ['screen.jpg', JPEG, 'image/jpeg'], ['preview.webp', WEBP, 'image/webp']]) {
    await fs.writeFile(path.join(root, name), bytes);
    const image = await tools.readImage({ path: name });
    assert.equal(image.path, name); assert.equal(image.bytes, bytes.length);
    assert.equal(image.attachment.mediaType, mediaType); assert.equal(image.attachment.name, name);
    assert.equal(image.attachment.dataUrl, `data:${mediaType};base64,${bytes.toString('base64')}`);
    assert.match(image.attachment.id, /^sha256:[a-f\d]{64}$/u);
    assert.deepEqual(await tools.readImage({ path: name }), image);
  }
});

test('view_image transfers pixels only to its explicit receiver and logs safe metadata as a string', async t => {
  const { root, tools } = await fixture(t), received = [];
  await fs.writeFile(path.join(root, 'layout.png'), PNG);
  const output = await tools.execute('view_image', { path: 'layout.png' }, { onImage: image => received.push(image) });
  assert.equal(typeof output, 'string');
  assert.deepEqual(JSON.parse(output), { path: 'layout.png', name: 'layout.png', mediaType: 'image/png', bytes: PNG.length, status: 'loaded' });
  assert.equal(received.length, 1); assert.equal(received[0].attachment.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.doesNotMatch(output, /data:|base64|iVBOR/u);
  assert.match(await tools.execute('view_image', { path: 'does-not-exist.png' }), /不能接收图片/u);
  const refused = await tools.execute('view_image', { path: 'layout.png' }, { onImage: () => { throw Error('当前模型不支持图片'); } });
  assert.match(refused, /^错误：当前模型不支持图片/u); assert.doesNotMatch(refused, /loaded/u);
});

test('image reads accept valid screenshots over the text cap but enforce image byte and dimension limits', async t => {
  const { root, tools } = await fixture(t), image = noisyPng();
  assert.ok(image.length > 512 * 1024 && image.length < IMAGE_ATTACHMENT_LIMITS.maxImageBytes);
  await fs.writeFile(path.join(root, 'large.png'), image);
  assert.equal((await tools.readImage({ path: 'large.png' })).bytes, image.length);
  await assert.rejects(tools.readFile({ path: 'large.png' }), /512 KB/u);
  await fs.writeFile(path.join(root, 'oversized.png'), Buffer.alloc(IMAGE_ATTACHMENT_LIMITS.maxImageBytes + 1));
  await assert.rejects(tools.readImage({ path: 'oversized.png' }), /2 MiB/u);
  for (const [name, width, height] of [['wide.png', 8193, 1], ['pixels.png', 5000, 5000]]) {
    const bytes = Buffer.from(PNG); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    await fs.writeFile(path.join(root, name), bytes);
    await assert.rejects(tools.readImage({ path: name }), /尺寸上限/u);
  }
});

test('invalid image content, credential paths and directories never reach the image receiver', async t => {
  const { root, tools } = await fixture(t), received = [];
  for (const [name, bytes] of [['not-image.png', Buffer.from('not an image')], ['broken.png', PNG.subarray(0, 20)],
    ['.env.png', PNG], ['credentials.png', PNG], ['private.key', PNG]]) {
    await fs.writeFile(path.join(root, name), bytes);
    const result = await tools.execute('view_image', { path: name }, { onImage: image => received.push(image) });
    assert.match(result, /^错误：/u); assert.doesNotMatch(result, /data:|base64|iVBOR/u);
  }
  await fs.mkdir(path.join(root, 'screenshots'));
  await assert.rejects(tools.readImage({ path: 'screenshots' }), /不是常规文件/u);
  assert.equal(received.length, 0);
});

test('external image paths stay opt-in and linked or protected paths cannot bypass existing guards', async t => {
  const { root, outside, tools } = await fixture(t);
  const file = path.join(outside, 'screen.png'); await fs.writeFile(file, PNG);
  await assert.rejects(tools.readImage({ path: file }));
  await assert.rejects(tools.readImage({ path: '../outside/screen.png' }));
  const external = new WorkspaceTools(root, { allowExternalPaths: true });
  const viewed = await external.readImage({ path: file });
  assert.equal(viewed.path, file.replaceAll('\\', '/'));
  await fs.mkdir(path.join(outside, '.git')); await fs.writeFile(path.join(outside, '.git', 'screen.png'), PNG);
  await assert.rejects(external.readImage({ path: path.join(outside, '.git', 'screen.png') }), /受保护/u);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(external.readImage({ path: 'linked/screen.png' }), /符号链接|联接/u);
});

test('a file changed during image reading is rejected before returning pixels', async t => {
  const { root, tools } = await fixture(t), file = path.join(root, 'screen.png');
  await fs.writeFile(file, PNG);
  const originalOpen = fs.open.bind(fs); let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    return { stat: handle.stat.bind(handle), close: handle.close.bind(handle), read: async (...readArgs) => {
      const result = await handle.read(...readArgs);
      if (!changed) { changed = true; await fs.appendFile(file, Buffer.from([1])); }
      return result;
    } };
  });
  let delivered = false;
  assert.match(await tools.execute('view_image', { path: 'screen.png' }, { onImage: () => { delivered = true; } }), /读取期间发生变化/u);
  assert.equal(delivered, false);
});

test('cancellation releases a stalled image read without waiting for disk completion or publishing a late image', async t => {
  const { root, tools } = await fixture(t), file = path.join(root, 'screen.png');
  await fs.writeFile(file, PNG);
  const originalOpen = fs.open.bind(fs), entered = deferred(), release = deferred(); let closes = 0, reads = 0, delivered = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    return { stat: handle.stat.bind(handle), close: () => { closes++; return handle.close(); }, read: () => { reads++; entered.resolve(); return release.promise; } };
  });
  const controller = new AbortController();
  const pending = tools.execute('view_image', { path: 'screen.png' }, { signal: controller.signal, onImage: () => { delivered = true; } });
  await entered.promise; controller.abort();
  const result = await pending; assert.match(result, /^错误：任务已取消/u); assert.equal(closes, 1);
  release.resolve({ bytesRead: 0 }); await immediate(); await immediate();
  assert.equal(reads, 1); assert.equal(delivered, false);
});

test('an image open that completes after cancellation closes its owned handle and stops the validation chain', async t => {
  const { root, tools } = await fixture(t), file = path.join(root, 'screen.png');
  await fs.writeFile(file, PNG);
  const originalOpen = fs.open.bind(fs), entered = deferred(), release = deferred(); let closes = 0, stats = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args); entered.resolve(); await release.promise;
    return { stat: () => { stats++; return handle.stat(); }, close: () => { closes++; return handle.close(); } };
  });
  const controller = new AbortController(), pending = tools.readImage({ path: 'screen.png' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /任务已取消/u); await entered.promise; controller.abort(); await rejected;
  release.resolve(); await immediate(); await immediate();
  assert.equal(closes, 1); assert.equal(stats, 0);
});

test('a cancelled image queued behind a filesystem commit returns before that commit releases', async t => {
  const { root, tools } = await fixture(t); await fs.writeFile(path.join(root, 'screen.png'), PNG);
  const entered = deferred(), release = deferred();
  const held = withFileCommit(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const controller = new AbortController(), pending = tools.readImage({ path: 'screen.png' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /任务已取消/u); await immediate(); controller.abort(); await rejected;
  release.resolve(); await held;
});
