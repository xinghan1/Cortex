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

test('run-scoped references intersect the actual request and do not consume old or absent image identities', () => {
  const old = { ...user(), id: 'old-image' }, current = { ...user(), id: 'current-image' };
  const seen = new Set(), allowed = new Set([current.id]);
  assert.deepEqual(collectViewedImages([old], seen, allowed), []);
  assert.equal(seen.size, 0);
  assert.deepEqual(collectViewedImages([old, current], seen, allowed), [
    { messageId: current.id, attachmentIndex: 0, attachmentId: image.id },
  ]);
  assert.deepEqual([...seen], ['current-image\u00000']);
  assert.deepEqual(collectViewedImages([old, current], new Set(), new Set()), []);
  assert.deepEqual(collectViewedImages([old, current], new Set(), []), []);
  assert.deepEqual(collectViewedImages([current, { ...current }], new Set(), allowed), [], 'ambiguous history IDs cannot be relabelled');
});

test('successive runs report only their new two, one and zero images while preserving all model history', async () => {
  const messages = [], references = [], requestImageIds = [];
  for (const [index, count] of [2, 1, 0].entries()) {
    const messageStartIndex = messages.length, id = `round-${index}`;
    messages.push({ id, role: 'user', content: `Round ${index}`, attachments: Array.from({ length: count },
      (_, attachmentIndex) => ({ ...image, id: `photo-${index}-${attachmentIndex}` })) });
    const events = [];
    await runAgent(options({ messages, messageStartIndex, emit: event => events.push(event), requestModel: async request => {
      requestImageIds.push(request.messages.filter(message => message.attachments?.length).map(message => message.id));
      return reply();
    } }));
    references.push(viewed(events).flatMap(event => event.images));
  }
  assert.deepEqual(references, [
    [{ messageId: 'round-0', attachmentIndex: 0, attachmentId: 'photo-0-0' },
      { messageId: 'round-0', attachmentIndex: 1, attachmentId: 'photo-0-1' }],
    [{ messageId: 'round-1', attachmentIndex: 0, attachmentId: 'photo-1-0' }], [],
  ]);
  assert.deepEqual(requestImageIds, [['round-0'], ['round-0', 'round-1'], ['round-0', 'round-1']]);
  assert.equal(messages.filter(message => message.role === 'user').length, 3);
  assert.equal(messages[0].attachments.length, 2);
});

test('standalone runs default to the latest user, including text-only turns, rather than the latest photo', async () => {
  for (const attachments of [[image], []]) {
    const events = [], messages = [user(), reply().message, { id: 'latest', role: 'user', content: 'Next.', attachments }];
    await runAgent(options({ messages, emit: event => events.push(event) }));
    assert.deepEqual(viewed(events).flatMap(event => event.images.map(item => item.messageId)), attachments.length ? ['latest'] : []);
  }
});

test('an explicit run boundary admits each current user message and rejects invalid boundaries before requesting', async () => {
  const events = [], messages = [user(), reply().message, { ...user(), id: 'current-task' },
    { ...user(), id: 'applied-steering', source: 'steering' }];
  await runAgent(options({ messages, messageStartIndex: 2, emit: event => events.push(event) }));
  assert.deepEqual(viewed(events).flatMap(event => event.images.map(item => item.messageId)), ['current-task', 'applied-steering']);
  for (const messageStartIndex of [-1, 0.5, '0', null, 2]) {
    await assert.rejects(runAgent(options({ messageStartIndex, requestModel: async () => assert.fail('invalid boundary sent a request') })), /任务消息起始位置无效/u);
  }
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
    await assert.rejects(runAgent(options({ messages: [{ ...user(), id: 'earlier-round' }, reply().message, user()],
      messageStartIndex: 2, signal: controller.signal, emit: event => events.push(event), requestModel: async () => {
      if (mode === 'failure') throw new Error('Provider failed');
      if (mode === 'abort') { controller.abort(new Error('Stopped')); return reply(); }
      return { message: { role: 'assistant', content: 'Malformed' }, usageReported: false };
    } })));
    assert.deepEqual(viewed(events), []);
  }
});

test('tool continuations deduplicate old images, while newly applied image steering gets its own successful reference', async () => {
  const events = [], steering = [], messages = [{ ...user(), id: 'earlier-round' }, reply().message, user()]; let requests = 0;
  await runAgent(options({ messages, messageStartIndex: 2, emit: event => events.push(event), takeSteering: () => steering.splice(0),
    toolDefinitions: [{ name: 'read_file', description: 'Read fixture', parameters: { type: 'object' } }],
    requestModel: async () => {
      requests++;
      if (requests === 1) return reply('', [{ id: 'read', name: 'read_file', arguments: { path: 'fixture' } }]);
      if (requests === 2) steering.push({ id: 'steering-image', text: '', attachments: [image] });
      return reply();
    } }));
  assert.equal(requests, 3);
  assert.deepEqual(viewed(events).map(event => event.images.map(image => image.messageId)), [['user-one'], ['steering-image']]);
  assert.equal(messages.filter(message => message.role === 'user').length, 3, 'display evidence does not manufacture conversation turns');
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

test('compaction can retain past images in the request without reporting them again in the new round', async () => {
  const messages = [{ ...user(), id: 'old-round', attachments: [image, { ...image, id: 'old-second' }] },
    { role: 'assistant', content: 'Earlier answer', toolCalls: [],
      providerState: { provider: 'ollama', message: { thinking: 'R'.repeat(180001) } } },
    { ...user(), id: 'new-round' }];
  const events = [], records = []; let summaries = 0;
  await runAgent(options({ messages, messageStartIndex: 2, emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        summaries++;
        assert.equal(JSON.stringify(request.messages).includes(png), false);
        return reply('Previous task completed; inspect the latest attachment.');
      }
      assert.deepEqual(request.messages.filter(message => message.attachments?.length).map(message => message.id), ['old-round', 'new-round']);
      return reply();
    } }));
  assert.equal(summaries, 1);
  assert.equal(viewed(events).length, 1);
  assert.deepEqual(viewed(events)[0].images, [{ messageId: 'new-round', attachmentIndex: 0, attachmentId: image.id }]);
  assert.equal(viewed(events)[0].requestId, records.find(record => !record.purpose).id);
  assert.equal(messages[0].attachments.length, 2);
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
