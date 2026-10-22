import test from 'node:test';
import assert from 'node:assert/strict';
import { collectViewedImages } from '../src/core/image-viewed.mjs';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const image = Object.freeze({ id: 'image-one', name: 'image.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` });
const user = () => ({ id: 'user-one', role: 'user', content: 'Inspect this image.', attachments: [image] });
const reply = (content = 'Done.', toolCalls = []) => ({ message: { role: 'assistant', content, toolCalls }, usageReported: false });
const options = overrides => ({ config: { provider: 'ollama', model: 'fixture', modelCapabilities: { supportsImages: true } },
  messages: [user()], workspace: { root: 'fixture', execute: async () => 'fixture contents' }, toolDefinitions: [],
  signal: new AbortController().signal, emit: () => {}, requestModel: async () => reply(), ...overrides });
const viewed = events => events.filter(event => event.type === 'images-viewed');

test('successful image references retain stable identities without copying image data or mutating messages', () => {
  const messages = [user(), { id: 'user-two', role: 'user', content: '', attachments: [{ ...image, id: undefined }] }];
  const original = structuredClone(messages), seen = new Set();
  assert.deepEqual(collectViewedImages(messages, seen), [{ messageId: 'user-one', attachmentIndex: 0, attachmentId: 'image-one' },
    { messageId: 'user-two', attachmentIndex: 0 }]);
  assert.deepEqual(collectViewedImages(messages, seen), []);
  assert.deepEqual(messages, original);
  assert.equal(JSON.stringify([...seen]).includes(png), false);
});

test('only unambiguous original user images can become viewed references; URLs and screenshot paths cannot', () => {
  const messages = [{ ...user(), id: undefined }, { ...user(), role: 'assistant' },
    { ...user(), id: 'url', attachments: [{ dataUrl: 'https://example.invalid/private.png' }] },
    { ...user(), id: 'svg', attachments: [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }] },
    { role: 'tool', content: JSON.stringify({ path: 'browser-capture.png' }) },
    { ...user(), id: 'duplicate' }, { ...user(), id: 'duplicate' },
    { ...user(), id: 'control\u0000id' }, { ...user(), id: 'too-many', attachments: Array(5).fill(image) }];
  assert.deepEqual(collectViewedImages(messages), []);
});

test('reference batches and the per-run identity set stay bounded without replaying evicted identities', () => {
  const messages = Array.from({ length: 70 }, (_, index) => ({ ...user(), id: `user-${index}` })), seen = new Set();
  assert.equal(collectViewedImages(messages, seen).length, 64);
  assert.equal(collectViewedImages(messages, seen).length, 6);
  assert.deepEqual(collectViewedImages(messages, seen), []);
  const full = new Set(Array.from({ length: 2048 }, (_, index) => `old-${index}`));
  assert.deepEqual(collectViewedImages(messages, full), []);
  assert.equal(full.size, 2048);
});

test('real provider request carries image bytes, then exactly one successful public reference appears after the response', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const events = [], records = [];
  const pending = runAgent(options({ emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: request => requestModel({ ...request, fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).messages.find(message => message.role === 'user').images, [png]);
      await held;
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Inspected.' }, done: true,
        prompt_eval_count: 10, eval_count: 2 }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    } }) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(viewed(events), [], 'upload and a pending request are not evidence of a completed view');
  release(); await pending;
  assert.equal(viewed(events).length, 1);
  const event = viewed(events)[0];
  assert.equal(event.version, 1); assert.equal(event.requestId, records[0].id);
  assert.deepEqual(event.images, [{ messageId: 'user-one', attachmentIndex: 0, attachmentId: 'image-one' }]);
  assert.equal(JSON.stringify(events).includes(png), false);
  assert.ok(events.indexOf(event) < events.findIndex(value => value.type === 'assistant-message'));
});

test('failed, malformed and cancelled image requests never report that the AI viewed images', async () => {
  for (const mode of ['failure', 'abort', 'malformed']) {
    const events = [], controller = new AbortController();
    await assert.rejects(runAgent(options({ signal: controller.signal, emit: event => events.push(event), requestModel: async () => {
      if (mode === 'failure') throw new Error('Provider failed');
      if (mode === 'abort') { controller.abort(new Error('Stopped')); return reply(); }
      return { message: { role: 'assistant', content: 'Malformed' }, usageReported: false };
    } })));
    assert.deepEqual(viewed(events), []);
  }
});

test('tool continuations deduplicate old images, while newly applied image steering gets its own successful reference', async () => {
  const events = [], steering = [], messages = [user()]; let requests = 0;
  await runAgent(options({ messages, emit: event => events.push(event), takeSteering: () => steering.splice(0),
    toolDefinitions: [{ name: 'read_file', description: 'Read fixture', parameters: { type: 'object' } }],
    requestModel: async () => {
      requests++;
      if (requests === 1) return reply('', [{ id: 'read', name: 'read_file', arguments: { path: 'fixture' } }]);
      if (requests === 2) steering.push({ id: 'steering-image', text: '', attachments: [image] });
      return reply();
    } }));
  assert.equal(requests, 3);
  assert.deepEqual(viewed(events).map(event => event.images.map(image => image.messageId)), [['user-one'], ['steering-image']]);
  assert.equal(messages.filter(message => message.role === 'user').length, 2, 'display evidence does not manufacture conversation turns');
});

test('compaction summarizes metadata only and never emits an image-view event for its request', async () => {
  const messages = [user(), { role: 'assistant', content: 'Earlier answer', toolCalls: [],
    providerState: { provider: 'ollama', message: { thinking: 'R'.repeat(180001) } } }];
  const events = [], records = []; let summaries = 0;
  await runAgent(options({ messages, emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        summaries++; assert.equal(JSON.stringify(request.messages).includes(png), false); return reply('Preserve the original image and current goal.');
      }
      return reply('Inspected original image.');
    } }));
  assert.equal(summaries, 1); assert.equal(viewed(events).length, 1);
  assert.equal(viewed(events)[0].requestId, records.find(record => !record.purpose).id);
  assert.notEqual(viewed(events)[0].requestId, records.find(record => record.purpose).id);
  assert.equal(messages[0].attachments[0], image);
});

test('an explicit AI approval rejection remains structured denial data for the tool UI and following model request', async () => {
  const events = [], messages = [user()]; let requests = 0;
  await runAgent(options({ messages, emit: event => events.push(event),
    workspace: { root: 'fixture', execute: async () => { throw Object.assign(new Error('独立 AI 已拒绝此操作。'), { code: 'APPROVAL_DENIED' }); } },
    toolDefinitions: [{ name: 'write_file', description: 'Write fixture', parameters: { type: 'object' } }],
    requestModel: async request => {
      if (++requests === 1) return reply('', [{ id: 'write', name: 'write_file', arguments: { path: 'fixture.txt', content: 'x' } }]);
      assert.deepEqual(JSON.parse(request.messages.at(-1).content), { denied: true, message: '独立 AI 已拒绝此操作。' });
      return reply('The operation was rejected.');
    } }));
  assert.equal(requests, 2);
  assert.deepEqual(JSON.parse(events.find(event => event.type === 'tool-result').result), { denied: true, message: '独立 AI 已拒绝此操作。' });
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
});
