import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImageAttachments, ImageAttachmentError, IMAGE_ATTACHMENT_LIMITS } from '../src/core/message-images.mjs';

// Real 1x1 images generated and decoded in memory with the already-installed
// Pillow library. The tests themselves need only Node and these fixed bytes.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
const WEBP_VP8 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=';
const WEBP_VP8L = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
const WEBP_VP8X = 'UklGRloAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAgFZQOCAyAAAAMAEAnQEqAQABAAFAJiWgAANwAP7y63//+bA/9vP/BHoB///S4P/+lwf/9Lg/9KQAAAA=';

const dataUrl = (mediaType, source) => `data:${mediaType};base64,${Buffer.isBuffer(source) ? source.toString('base64') : source}`;
const image = (source = PNG, mediaType = 'image/png', extra = {}) => ({ dataUrl: dataUrl(mediaType, source), ...extra });

function rejects(input, code = 'INVALID_IMAGE_ATTACHMENT') {
  let caught;
  assert.throws(() => normalizeImageAttachments(input), error => {
    assert.ok(error instanceof ImageAttachmentError);
    assert.equal(error.code, code);
    assert.ok(error.message.length < 300);
    caught = error;
    return true;
  });
  for (const item of Array.isArray(input) ? input : []) {
    if (typeof item?.dataUrl !== 'string') continue;
    if (item.dataUrl) assert.equal(caught.message.includes(item.dataUrl), false);
    const encoded = item.dataUrl.split(',')[1];
    if (encoded?.length > 20) assert.equal(caught.message.includes(encoded), false);
  }
  return caught;
}

function sizedPng(width, height) {
  const bytes = Buffer.from(PNG, 'base64');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes; // Intentionally changes only the inspected header, not pixel data/CRC.
}

function sizedJpeg(width, height) {
  const bytes = Buffer.from(JPEG, 'base64');
  const marker = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(marker >= 0);
  bytes.writeUInt16BE(height, marker + 5);
  bytes.writeUInt16BE(width, marker + 7);
  return bytes;
}

function sizedWebp(source, width, height) {
  const bytes = Buffer.from(source, 'base64');
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  } else if (chunk === 'VP8L') {
    const flags = bytes.readUInt32LE(21) & 0x10000000;
    bytes.writeUInt32LE((flags | (width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  }
  return bytes;
}

test('missing image input becomes a fresh empty array while null and other nonarrays fail', () => {
  assert.deepEqual(normalizeImageAttachments(undefined), []);
  assert.notEqual(normalizeImageAttachments(undefined), normalizeImageAttachments(undefined));
  for (const value of [null, false, 0, '', {}, new Set()]) rejects(value);
  for (const value of [null, false, 'text', [], {}]) rejects([value]);
  rejects(new Array(1));
});

test('real tiny PNG, JPEG and all three WebP header variants normalize to standard fields', () => {
  for (const [source, mediaType] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP_VP8, 'image/webp'], [WEBP_VP8L, 'image/webp'], [WEBP_VP8X, 'image/webp']]) {
    const attachment = image(source, mediaType, { id: 'stable-id', name: 'example', mediaType, extra: 'discard' });
    assert.deepEqual(normalizeImageAttachments([attachment]), [{ id: 'stable-id', name: 'example', mediaType, dataUrl: attachment.dataUrl }]);
  }
});

test('normalization creates new arrays and objects without mutating frozen input or forwarding extra fields', () => {
  const attachment = Object.freeze(image(PNG, 'image/png', { name: '../photo.png', extra: Object.freeze({ secret: 'discard' }) }));
  const input = Object.freeze([attachment]);
  const before = structuredClone(input);
  const output = normalizeImageAttachments(input);
  assert.notEqual(output, input);
  assert.notEqual(output[0], attachment);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(output[0]), ['name', 'mediaType', 'dataUrl']);
  output[0].name = 'edited display name';
  assert.equal(attachment.name, '../photo.png');
});

test('four images at exactly 16 MiB each satisfy both per-image and 64 MiB message boundaries', () => {
  assert.ok(Object.isFrozen(IMAGE_ATTACHMENT_LIMITS));
  assert.deepEqual(IMAGE_ATTACHMENT_LIMITS, { maxImages: 4, maxImageBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxDimension: 16384, maxPixels: 100_000_000 });
  const bytes = Buffer.alloc(IMAGE_ATTACHMENT_LIMITS.maxImageBytes);
  Buffer.from(PNG, 'base64').copy(bytes);
  const attachment = image(bytes);
  const output = normalizeImageAttachments(Array.from({ length: 4 }, () => attachment));
  assert.equal(output.length, 4);
  assert.deepEqual(output.map(item => item.name), ['image-1.png', 'image-2.png', 'image-3.png', 'image-4.png']);
  assert.equal(output.reduce((total, item) => total + Buffer.from(item.dataUrl.split(',')[1], 'base64').length, 0), 64 * 1024 * 1024);
});

test('decoded-byte overflow and image-count overflow fail before accepting an attachment', () => {
  for (const extraBytes of [1, 10]) {
    const bytes = Buffer.alloc(IMAGE_ATTACHMENT_LIMITS.maxImageBytes + extraBytes);
    Buffer.from(PNG, 'base64').copy(bytes);
    rejects([image(bytes)], 'IMAGE_ATTACHMENT_LIMIT');
  }
  rejects(Array.from({ length: 5 }, () => image()), 'IMAGE_ATTACHMENT_LIMIT');
});

test('only exact supported Base64 data URL prefixes are accepted', () => {
  for (const value of [
    'https://example.invalid/image.png', 'file:///C:/image.png', `data:image/svg+xml;base64,${PNG}`,
    `data:image/jpg;base64,${JPEG}`, `data:IMAGE/PNG;base64,${PNG}`, `data:image/png;BASE64,${PNG}`,
    `data:image/png;charset=utf-8;base64,${PNG}`, `data:image/png,${PNG}`, ` data:image/png;base64,${PNG}`,
    '', 'data:image/png;base64,', null, 42,
  ]) rejects([{ dataUrl: value }]);
});

test('Base64 rejects whitespace, URL-safe characters, incorrect padding and nonzero unused tail bits', () => {
  const malformed = [
    `${PNG}\n`, `${PNG} `, `${PNG.slice(0, 8)}\t${PNG.slice(8)}`, `-${PNG.slice(1)}`, `_${PNG.slice(1)}`,
    PNG.slice(0, -1), `${PNG}=`, `${PNG}====`, `${PNG.slice(0, 5)}=${PNG.slice(6)}`,
  ];
  for (const source of malformed) rejects([image(source)]);
  rejects([image(JPEG.slice(0, -2), 'image/jpeg')]);
  rejects([image(`${JPEG.slice(0, -3)}R==`, 'image/jpeg')]);
  rejects([image(`${WEBP_VP8.slice(0, -2)}B=`, 'image/webp')]);
  // Node's permissive decoder accepts these altered low bits; normalization must not.
  assert.deepEqual(Buffer.from(`${JPEG.slice(0, -3)}R==`, 'base64'), Buffer.from(JPEG, 'base64'));
  assert.deepEqual(Buffer.from(`${WEBP_VP8.slice(0, -2)}B=`, 'base64'), Buffer.from(WEBP_VP8, 'base64'));
});

test('an optional declared media type must exactly agree with the data URL and container header', () => {
  for (const mediaType of ['image/jpeg', 'image/PNG', null, 7]) rejects([image(PNG, 'image/png', { mediaType })]);
  rejects([image(JPEG, 'image/png')]);
  rejects([image(PNG, 'image/jpeg')]);
  rejects([image(PNG, 'image/webp')]);
  assert.equal(normalizeImageAttachments([image()])[0].mediaType, 'image/png');
});

test('truncated PNG/JPEG headers and inconsistent WebP RIFF or chunk lengths fail safely', () => {
  rejects([image(Buffer.from(PNG, 'base64').subarray(0, 8))]);
  rejects([image(Buffer.from(PNG, 'base64').subarray(0, 32))]);
  rejects([image(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')]);
  for (const mutate of [
    bytes => bytes.writeUInt32LE(4, 4),
    bytes => bytes.writeUInt32LE(bytes.length, 4),
    bytes => bytes.writeUInt32LE(0xffffffff, 16),
    bytes => bytes.write('AVI ', 8, 'ascii'),
    bytes => bytes.write('JUNK', 12, 'ascii'),
  ]) {
    const bytes = Buffer.from(WEBP_VP8, 'base64');
    mutate(bytes);
    rejects([image(bytes, 'image/webp')]);
  }
  const malformedJpeg = Buffer.from(JPEG, 'base64');
  malformedJpeg.writeUInt16BE(1, 4); // Invalid APP0 length before the SOF.
  rejects([image(malformedJpeg, 'image/jpeg')]);
});

test('image dimensions accept the inclusive side/pixel limits and reject zero, oversized sides or pixels', () => {
  for (const [width, height] of [[16384, 1], [1, 16384], [10000, 10000]]) assert.equal(normalizeImageAttachments([image(sizedPng(width, height))]).length, 1);
  for (const [width, height] of [[16385, 1], [1, 16385], [10001, 10000]]) rejects([image(sizedPng(width, height))], 'IMAGE_ATTACHMENT_LIMIT');
  for (const [width, height] of [[0, 1], [1, 0]]) rejects([image(sizedPng(width, height))]);
  rejects([image(sizedJpeg(16385, 1), 'image/jpeg')], 'IMAGE_ATTACHMENT_LIMIT');
  rejects([image(sizedJpeg(10001, 10000), 'image/jpeg')], 'IMAGE_ATTACHMENT_LIMIT');
  rejects([image(sizedJpeg(1, 0), 'image/jpeg')]);
  for (const source of [WEBP_VP8, WEBP_VP8L, WEBP_VP8X]) {
    assert.equal(normalizeImageAttachments([image(sizedWebp(source, 8192, 1), 'image/webp')]).length, 1);
    rejects([image(sizedWebp(source, 10001, 10000), 'image/webp')], 'IMAGE_ATTACHMENT_LIMIT');
  }
});

test('names lose directory segments, controls and bidi markers and are capped by Unicode code points', () => {
  const output = normalizeImageAttachments([
    image(PNG, 'image/png', { name: '../../folder\\\u202ephoto\0\u200f.png' }),
    image(JPEG, 'image/jpeg', { name: `C:\\fakepath\\${'😀'.repeat(90)}.jpg` }),
    image(WEBP_VP8, 'image/webp', { name: ' \u061c\u2066\n\u007f ' }),
  ]);
  assert.equal(output[0].name, 'photo.png');
  assert.equal(Array.from(output[1].name).length, 80);
  assert.equal(output[1].name, '😀'.repeat(80));
  assert.equal(output[2].name, 'image-3.webp');
  assert.equal(normalizeImageAttachments([image(JPEG, 'image/jpeg')])[0].name, 'image-1.jpg');
  for (const name of [null, 0, {}, []]) rejects([image(PNG, 'image/png', { name })]);
});

test('optional ids are preserved and invalid ids are rejected rather than silently rewritten', () => {
  for (const id of ['stable-id', 'x'.repeat(100), '😀'.repeat(100)]) assert.equal(normalizeImageAttachments([image(PNG, 'image/png', { id })])[0].id, id);
  assert.equal(Object.hasOwn(normalizeImageAttachments([image()])[0], 'id'), false);
  for (const id of ['', '   ', 'x'.repeat(101), 'bad\nvalue', 'bad\x7fvalue', 'bad\u202evalue', 'bad\u200bvalue', null, 0, {}]) rejects([image(PNG, 'image/png', { id })]);
});
