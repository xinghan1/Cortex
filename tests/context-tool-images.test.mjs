import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { prepareContext, contextChars } from '../src/core/context-compaction.mjs';
import { normalizeImageAttachments, IMAGE_ATTACHMENT_LIMITS } from '../src/core/message-images.mjs';

const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
const call = (id, name = 'view_image') => ({ role: 'assistant', content: 'Read and verify the requested UI.',
  toolCalls: [{ id, name, arguments: { path: name === 'view_image' ? `${id}.png` : `${id}.txt` } }] });
const tool = (id, content, attachments) => ({ role: 'tool', id: `message-${id}`, source: 'image-tool', toolCallId: id,
  content, ...(attachments ? { attachments } : {}) });

function largeImage() {
  // A complete, uncompressed PNG close to the 2 MiB attachment limit. This
  // exercises real normalized image transport rather than a giant text stub.
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([size, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(512, 0); header.writeUInt32BE(1023, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(1023 * 2049), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
  assert.ok(bytes.length > IMAGE_ATTACHMENT_LIMITS.maxImageBytes - 2048 && bytes.length <= IMAGE_ATTACHMENT_LIMITS.maxImageBytes);
  return normalizeImageAttachments([{ id: 'local-screen', name: 'layout.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }])[0];
}
const image = largeImage();
const imageResult = (id, extra = '') => tool(id, JSON.stringify({ path: `${id}.png`, status: 'loaded' }) + extra, [image]);
const smallImage = normalizeImageAttachments([{ id: 'small-screen', name: 'small.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' }])[0];
const imageCount = messages => messages.reduce((count, message) => count + (message.attachments?.length || 0), 0);
const imageBytes = messages => messages.reduce((count, message) => count + (message.attachments || []).reduce((sum, attachment) => {
  const encoded = attachment.dataUrl.split(',')[1];
  return sum + encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
}, 0), 0);
function screenshots(count, attachment = smallImage) {
  const messages = [user('Check actual UI screenshots as the task progresses.')];
  for (let index = 0; index < count; index++) messages.push(call(`screen-${index}`),
    tool(`screen-${index}`, JSON.stringify({ path: `screen-${index}.png`, status: 'loaded' }), [attachment]));
  return messages;
}

test('near-limit tool image bytes do not become textual fallback-budget usage', async () => {
  const messages = [user('Check the generated UI screenshot.'), call('latest'), imageResult('latest')];
  assert.ok(contextChars(messages) < 2000);
  assert.equal(contextChars(messages), contextChars(messages.map(message => message.attachments
    ? { ...message, attachments: message.attachments.map(({ dataUrl, ...metadata }) => metadata) } : message)));
  const result = await prepareContext({ messages, protectedFromIndex: 1, summarize: () => assert.fail('Pixels are not text context') });
  assert.equal(result.compacted, false); assert.equal(result.messages[2], messages[2]);
  assert.equal(result.messages[2].attachments[0], image);
});

test('compaction summarizes old screenshots as metadata while preserving the unread latest assistant/image batch', async () => {
  const messages = [user('Preserve the original task and inspect actual layouts.'), call('older'), imageResult('older'),
    call('large-log', 'read_file'), tool('large-log', 'X'.repeat(210000)), user('Verify the current UI.'),
    call('latest'), imageResult('latest')];
  const original = structuredClone(messages), checkpoint = {};
  const result = await prepareContext({ messages, checkpoint, protectedFromIndex: 6, summarize: async ({ source }) => {
    assert.match(source, /older\.png/u); assert.match(source, /工具图片记录/u); assert.match(source, /layout\.png/u);
    assert.doesNotMatch(source, /data:image|iVBOR|base64/u);
    return 'The older screenshot and log have been checked. Preserve the user requirements and inspect latest.png next.';
  } });
  assert.equal(result.compacted, true); assert.ok(result.metadata.throughIndex < 6);
  assert.equal(result.messages.includes(messages[6]), true); assert.equal(result.messages.includes(messages[7]), true);
  assert.equal(result.messages.some(message => message.toolCallId === 'older'), false);
  assert.equal(result.messages.some(message => message.toolCalls?.some(call => call.id === 'older')), false);
  assert.equal(result.messages.at(-1).attachments[0], image);
  assert.deepEqual(messages, original);
});

test('an oversized unread image batch fails before a paid summary instead of silently omitting it', async () => {
  const messages = [user('Verify the UI.'), call('latest'), imageResult('latest', 'X'.repeat(200000))];
  const checkpoint = {}, original = structuredClone(messages);
  await assert.rejects(prepareContext({ messages, checkpoint, protectedFromIndex: 1,
    summarize: () => assert.fail('No allowed cut can fit the unread batch') }), { code: 'CONTEXT_COMPACTION_LIMIT' });
  assert.deepEqual(checkpoint, {}); assert.deepEqual(messages, original);
});

test('no earlier safe boundary means the protected original transcript must not be compacted', async () => {
  const messages = [user('Original goal.'), call('latest'), imageResult('latest', 'X'.repeat(200000))];
  await assert.rejects(prepareContext({ messages, protectedFromIndex: 0,
    summarize: () => assert.fail('The whole transcript is protected') }), { code: 'CONTEXT_COMPACTION_LIMIT' });
});

test('already viewed tool image batches may compact while original user photos remain intact', async () => {
  const messages = [user('Use my photo and repair this layout.', { attachments: [image] }),
    { role: 'assistant', content: 'Read the previous log and screenshot.', toolCalls: [
      { id: 'log', name: 'read_file', arguments: { path: 'test.log' } }, { id: 'screen', name: 'view_image', arguments: { path: 'old-screen.png' } },
    ] }, tool('log', 'X'.repeat(210000)), imageResult('screen'), user('Continue checking the current task.')];
  const original = structuredClone(messages);
  const result = await prepareContext({ messages, summarize: async ({ source }) => {
    assert.match(source, /工具图片记录/u); assert.doesNotMatch(source, /data:image|iVBOR/u);
    return 'The old log and screenshot are archived. Preserve the original user photo and continue the task.';
  } });
  assert.equal(result.compacted, true);
  assert.equal(result.messages.some(message => message.role === 'tool' && message.attachments?.length), false);
  assert.equal(result.messages.find(message => message.role === 'user' && message.attachments?.length).attachments[0], image);
  assert.deepEqual(messages, original);
});

test('a saved checkpoint cannot hide a newly protected image group from a later request', async () => {
  const messages = [user('Original goal.'), call('protected-old'), imageResult('protected-old'),
    call('old-log', 'read_file'), tool('old-log', 'X'.repeat(210000)), user('Continue.')];
  const checkpoint = {};
  await prepareContext({ messages, checkpoint, summarize: async () => 'Earlier image and log were summarized.' });
  assert.ok(checkpoint.throughIndex >= 2);
  const before = structuredClone(checkpoint);
  await assert.rejects(prepareContext({ messages, checkpoint, protectedFromIndex: 1,
    summarize: () => assert.fail('A saved cut across the protected group is not usable') }), { code: 'CONTEXT_COMPACTION_LIMIT' });
  assert.deepEqual(checkpoint, before);
});

test('protected tail validation is explicit and an end-of-transcript marker keeps normal compaction behavior', async () => {
  const messages = [user('Short task.'), call('image'), imageResult('image')];
  for (const protectedFromIndex of [-1, 1.2, '1', NaN, Infinity, 4]) {
    await assert.rejects(prepareContext({ messages, protectedFromIndex }), { code: 'CONTEXT_INVALID_PROTECTION' });
  }
  assert.equal((await prepareContext({ messages, protectedFromIndex: messages.length })).compacted, false);
});

test('the 33rd screenshot compacts previously viewed image groups while retaining its unread batch', async () => {
  const messages = screenshots(33), protectedFromIndex = messages.length - 2, original = structuredClone(messages);
  let summaries = 0;
  const result = await prepareContext({ messages, protectedFromIndex, modelCapabilities: { contextWindow: 1048576 },
    summarize: async ({ source }) => { summaries++; assert.doesNotMatch(source, /data:image|iVBOR/u); return 'Earlier screenshot checks are archived; inspect the latest requested screenshot.'; } });
  assert.equal(result.compacted, true); assert.equal(summaries, 1);
  assert.ok(imageCount(result.messages) <= 32); assert.equal(imageCount(messages), 33);
  assert.equal(result.metadata.imageHistoryExceeded, true);
  assert.ok(result.metadata.throughIndex < protectedFromIndex);
  assert.equal(result.messages.at(-2), messages.at(-2)); assert.equal(result.messages.at(-1), messages.at(-1));
  assert.deepEqual(messages, original);
});

test('decoded image bytes can require compaction before textual or image-count capacity is full', async () => {
  const messages = screenshots(9, image), protectedFromIndex = messages.length - 2, original = structuredClone(messages);
  assert.ok(imageBytes(messages) > 16 * 1024 * 1024); assert.ok(imageCount(messages) < 32);
  const result = await prepareContext({ messages, protectedFromIndex, modelCapabilities: { contextWindow: 1048576 },
    summarize: async () => 'Earlier large screenshots were checked. Keep the pending screenshot for the next request.' });
  assert.equal(result.compacted, true); assert.ok(imageBytes(result.messages) <= 16 * 1024 * 1024);
  assert.equal(result.messages.at(-2), messages.at(-2)); assert.equal(result.messages.at(-1), messages.at(-1));
  assert.deepEqual(messages, original);
});

test('32 small screenshots stay within the ordinary request budget without an unnecessary summary', async () => {
  const messages = screenshots(32);
  const result = await prepareContext({ messages, protectedFromIndex: messages.length - 2,
    modelCapabilities: { contextWindow: 1048576 }, summarize: () => assert.fail('The valid transport boundary is inclusive') });
  assert.equal(result.compacted, false); assert.equal(imageCount(result.messages), 32);
});

test('mandatory user photos above transport image capacity fail before billing instead of being discarded', async () => {
  const messages = Array.from({ length: 33 }, (_, index) => user(`User reference ${index}.`, { attachments: [smallImage] }));
  const checkpoint = {}, original = structuredClone(messages);
  await assert.rejects(prepareContext({ messages, checkpoint, modelCapabilities: { contextWindow: 1048576 },
    summarize: () => assert.fail('No permissible projection can remove user photos') }), { code: 'CONTEXT_COMPACTION_LIMIT' });
  assert.deepEqual(checkpoint, {}); assert.deepEqual(messages, original);
});

test('an oversized mandatory photo byte budget or unread image batch fails before requesting a summary', async () => {
  const photos = Array.from({ length: 9 }, (_, index) => user(`User photo ${index}.`, { attachments: [image] }));
  const batch = [user('Inspect these UI screenshots.'), { role: 'assistant', content: 'Read the screenshots.',
    toolCalls: Array.from({ length: 33 }, (_, index) => ({ id: `pending-${index}`, name: 'view_image', arguments: { path: `pending-${index}.png` } })),
  }, ...Array.from({ length: 33 }, (_, index) => tool(`pending-${index}`, 'Screenshot loaded.', [smallImage]))];
  for (const options of [{ messages: photos }, { messages: batch, protectedFromIndex: 1 }]) {
    const checkpoint = {};
    await assert.rejects(prepareContext({ ...options, checkpoint, modelCapabilities: { contextWindow: 1048576 },
      summarize: () => assert.fail('Mandatory images cannot fit; do not bill for an unusable summary') }), { code: 'CONTEXT_COMPACTION_LIMIT' });
    assert.deepEqual(checkpoint, {});
  }
});

test('text compaction retains 28 valid user photos without imposing a smaller image target', async () => {
  const messages = Array.from({ length: 7 }, (_, index) => user(`Reference set ${index}.`, { attachments: Array.from({ length: 4 }, () => smallImage) }));
  messages.push(call('log', 'read_file'), tool('log', 'X'.repeat(210000)), user('Finish the requested UI verification.'));
  const result = await prepareContext({ messages, summarize: async () => 'The long log is archived; all user photo references remain available.' });
  assert.equal(result.compacted, true); assert.equal(imageCount(result.messages), 28);
  assert.ok(result.messages.every(message => !message.attachments?.length || message.role === 'user'));
});
