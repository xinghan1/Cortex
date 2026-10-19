import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const image = Object.freeze({ id: 'image-fixture', name: 'image.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` });
const config = { provider: 'deepseek', model: 'image-fixture-model', apiKey: 'fixture-credential', maxSteps: 3 };
const tools = [{ name: 'read_file', description: 'Read a fixture.', parameters: { type: 'object', properties: {} } }];
const reply = content => ({ message: { role: 'assistant', content, toolCalls: [] }, usageReported: false });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('a normal image does not consume the text context budget and survives a real agent/provider tool round trip', async () => {
  const bytes = Buffer.alloc(200_000); Buffer.from(png, 'base64').copy(bytes);
  const attachment = Object.freeze({ ...image, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
  assert.ok(attachment.dataUrl.length > 180_000);
  const user = Object.freeze({ role: 'user', content: 'Inspect this image and read the fixture.', attachments: Object.freeze([attachment]) });
  const messages = [user], bodies = [], events = [];
  let executions = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    assert.equal(body.messages.find(message => message.role === 'user').content[1].image_url.url, attachment.dataUrl);
    if (bodies.length === 1) return json({ choices: [{ message: { content: '', reasoning_content: 'first completed private reasoning',
      tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
    assert.equal(body.messages.find(message => message.role === 'assistant').reasoning_content, 'first completed private reasoning');
    assert.equal(body.messages.at(-1).tool_call_id, 'tool-1');
    return json({ choices: [{ message: { content: 'done', reasoning_content: 'second private reasoning' }, finish_reason: 'stop' }] });
  };
  await runAgent({ config, messages, signal: new AbortController().signal, toolDefinitions: tools,
    workspace: { root: 'fixture-root', execute: async () => { executions++; return 'fixture text'; } }, emit: event => events.push(event),
    requestModel: request => requestModel({ ...request, fetchImpl }) });
  assert.equal(executions, 1);
  assert.equal(bodies.length, 2);
  assert.equal(messages[0], user);
  assert.equal(messages[0].attachments[0], attachment);
  assert.equal(messages.at(-1).content, 'done');
  assert.equal(JSON.stringify(events).includes(attachment.dataUrl), false, 'core output does not emit image bytes or turn them into assistant text');
});

test('oversized newest user text and image metadata fail before a compaction request without dropping the original', async () => {
  const cases = [
    [{ role: 'user', content: 'T'.repeat(180_001), attachments: [image] }],
    [{ role: 'user', content: 'Inspect.', attachments: [{ ...image, name: 'N'.repeat(180_001) }] }],
  ];
  for (const messages of cases) {
    let requests = 0;
    await assert.rejects(runAgent({ config, messages, signal: new AbortController().signal, workspace: { root: 'fixture-root' },
      toolDefinitions: [], emit: () => {}, requestModel: async () => { requests++; return reply('must not send'); } }), error => error.code === 'CONTEXT_COMPACTION_LIMIT');
    assert.equal(requests, 0);
  }
});

test('large native reasoning is compacted while the archived provider state and real image bytes stay intact', async () => {
  const messages = [{ role: 'user', content: 'Continue.', attachments: [image] }, { role: 'assistant', content: 'Earlier completed answer.', toolCalls: [],
    providerState: { provider: 'deepseek', message: { role: 'assistant', content: 'Earlier completed answer.', reasoning_content: 'R'.repeat(180_001) } } }];
  const original = structuredClone(messages), events = [], checkpoint = {};
  let summaries = 0, requests = 0;
  await runAgent({ config, messages, contextCheckpoint: checkpoint, signal: new AbortController().signal,
    workspace: { root: 'fixture-root' }, toolDefinitions: [], emit: event => events.push(event), requestModel: async request => {
      if (request.messages[0].content.includes('[CONTEXT_COMPACTION]')) {
        summaries++;
        assert.equal(request.messages.at(-1).content.includes(image.dataUrl), false, 'Summary input contains image metadata, not base64.');
        assert.equal(request.messages.at(-1).content.includes('R'.repeat(100)), false, 'Private native reasoning is not summarized.');
        return reply('用户要求继续，之前答复已完成。保留当前图片并继续处理。');
      }
      requests++;
      assert.ok(JSON.stringify(request.messages).length < 180_000);
      assert.equal(request.messages.find(message => message.attachments)?.attachments[0].dataUrl, image.dataUrl);
      return reply('Image inspected.');
    } });
  assert.equal(summaries, 1);
  assert.equal(requests, 1);
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(events.filter(event => event.type === 'context-compacted').length, 1);
  assert.ok(checkpoint.throughIndex > 0);
});

test('image-only steering preserves attachments and message metadata after a final answer boundary', async () => {
  const messages = [{ role: 'user', content: 'First answer.' }];
  const steering = Object.freeze({ id: 'steer-image', text: '', createdAt: '2026-10-19T12:00:00.000Z', source: 'steering', attachments: Object.freeze([image]) });
  const pending = [];
  let requests = 0;
  const observed = [];
  await runAgent({ config, messages, signal: new AbortController().signal, workspace: { root: 'fixture-root' }, toolDefinitions: [], emit: () => {},
    takeSteering: () => pending.splice(0),
    requestModel: async request => {
      requests++; observed.push(request.messages);
      if (requests === 1) { pending.push(steering); return reply('First complete.'); }
      const applied = request.messages.at(-1);
      assert.equal(applied.id, steering.id);
      assert.equal(applied.content, '');
      assert.equal(applied.createdAt, steering.createdAt);
      assert.equal(applied.source, steering.source);
      assert.deepEqual(applied.attachments, [image]);
      return reply('Image complete.');
    } });
  assert.equal(requests, 2);
  assert.equal(observed[0].some(message => message.id === steering.id), false, 'in-flight request history stays immutable');
  const applied = messages.find(message => message.id === steering.id);
  assert.notEqual(applied.attachments, steering.attachments);
  assert.notEqual(applied.attachments[0], image);
  assert.equal(applied.attachments[0].dataUrl, image.dataUrl);
});
