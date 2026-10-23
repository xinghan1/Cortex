import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandOutputCapture } from '../src/core/command-output.mjs';

test('head and tail retain complete UTF-8 across arbitrary chunks and wrapped tail positions', () => {
  const original = '开始🙂' + '中🙂文'.repeat(13_000) + '结束🙂';
  const bytes = Buffer.from(original, 'utf8');
  for (const chunkSize of [1, 101, 16_385, bytes.length]) {
    const capture = new CommandOutputCapture();
    for (let start = 0; start < bytes.length; start += chunkSize) capture.append(bytes.subarray(start, start + chunkSize));
    const result = capture.snapshot();
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.truncated, true);
    assert.ok(result.omittedBytes > 0);
    assert.match(result.text, /^开始🙂/u);
    assert.match(result.text, /结束🙂$/u);
    assert.doesNotMatch(result.text, /�/u);
    const pieces = result.text.split(/\n\[… 已省略 \d+ 字节输出 …\]\n/u);
    assert.equal(pieces.length, 2);
    assert.equal(result.omittedBytes + Buffer.byteLength(pieces.join('')), bytes.length);
    assert.ok(Buffer.byteLength(pieces.join('')) <= 32 * 1024);
    assert.equal(capture.head.byteLength + capture.tail.byteLength, 32 * 1024);
  }
});

test('untruncated UTF-8 is unchanged including a character across the head/tail boundary', () => {
  const original = 'x'.repeat(16_383) + '中🙂文' + 'last';
  const bytes = Buffer.from(original);
  const capture = new CommandOutputCapture();
  for (const byte of bytes) capture.append(Buffer.from([byte]));
  assert.deepEqual(capture.snapshot(), { text: original, bytes: bytes.length, omittedBytes: 0, truncated: false });
  assert.deepEqual(new CommandOutputCapture().snapshot(), { text: '', bytes: 0, omittedBytes: 0, truncated: false });
});
