import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

// Real 1x1 RGB PNG, generated and decoded in memory with Pillow.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const image = Object.freeze({ id: 'image-1', name: 'sample.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` });
const tools = [{ name: 'read_file', description: 'Read a local fixture.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const options = extra => ({ provider: 'openai', model: 'selected-fixture-model', apiKey: 'image-test-placeholder',
  messages: [{ role: 'user', content: 'Read this screenshot.', attachments: [image] }], tools, ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function response(provider, tool = false) {
  if (provider === 'openai') return { status: 'completed', output: tool ? [
    { id: 'reasoning-1', type: 'reasoning', encrypted_content: 'opaque-reasoning', summary: [] },
    { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"note.txt"}' },
  ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 2, output_tokens: 3 } };
  if (provider === 'deepseek') return { choices: [{ message: { role: 'assistant', content: tool ? '' : 'done', reasoning_content: 'private-native-reasoning',
    ...(tool ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } }] } : {}) },
  finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } };
  return { content: tool ? [{ type: 'thinking', thinking: 'private-native-reasoning', signature: 'signed-state' },
    { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'note.txt' } }] : [{ type: 'text', text: 'done' }],
  stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } };
}
function assertImageContent(provider, body, text = 'Read this screenshot.') {
  const content = (provider === 'openai' ? body.input : body.messages).find(message => message.role === 'user').content;
  if (provider === 'openai') assert.deepEqual(content, [
    ...(text ? [{ type: 'input_text', text }] : []), { type: 'input_image', image_url: image.dataUrl, detail: 'auto' },
  ]);
  else if (provider === 'deepseek') assert.deepEqual(content, [
    ...(text ? [{ type: 'text', text }] : []), { type: 'image_url', image_url: { url: image.dataUrl } },
  ]);
  else assert.deepEqual(content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ...(text ? [{ type: 'text', text }] : [])]);
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('every provider sends real image blocks for text+image and image-only user messages', async t => {
  for (const provider of ['openai', 'deepseek', 'anthropic']) await t.test(provider, async () => {
    for (const content of ['Read this screenshot.', '']) {
      let body;
      const original = Object.freeze({ role: 'user', content, attachments: Object.freeze([image]) });
      const reply = await requestModel(options({ provider, messages: [original], modelCapabilities: { supportsImages: true },
        fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return json(response(provider)); } }));
      assertImageContent(provider, body, content);
      assert.equal(body.model, 'selected-fixture-model');
      assert.equal(reply.message.content, 'done');
      assert.equal(original.attachments[0], image);
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('sample.png'), false, 'display names are metadata, never a base64-text fallback prompt');
    }
  });
});

test('ChatGPT keeps the official image protocol alongside instructions and native tool namespace', async () => {
  let body;
  await requestModel(options({ authMode: 'chatgpt', messages: [{ role: 'system', content: 'Instruction.' }, { role: 'user', content: '', attachments: [image] }],
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses'); body = JSON.parse(init.body);
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: response('openai') })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } }));
  assert.equal(body.instructions, 'Instruction.');
  assert.equal(body.input.some(item => item.role === 'system'), false);
  assert.equal(body.tools[0].type, 'namespace');
  assertImageContent('openai', body, '');
});

test('image-bearing user history survives native reasoning/tool round trips without mutation', async t => {
  for (const provider of ['openai', 'deepseek', 'anthropic']) await t.test(provider, async () => {
    const messages = [freeze({ role: 'user', content: 'Read this screenshot.', attachments: [image] })];
    const bodies = [];
    const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return json(response(provider, bodies.length === 1)); };
    const first = await requestModel(options({ provider, messages, fetchImpl }));
    assert.equal(first.message.toolCalls[0].name, 'read_file');
    const native = structuredClone(first.message.providerState);
    messages.push(freeze(first.message), { role: 'tool', toolCallId: 'call-1', content: 'fixture file' });
    await requestModel(options({ provider, messages, fetchImpl }));
    bodies.forEach(body => assertImageContent(provider, body));
    assert.deepEqual(first.message.providerState, native);
    assert.equal(messages[0].attachments[0], image);
    if (provider === 'openai') assert.deepEqual(bodies[1].input.filter(item => ['reasoning', 'function_call'].includes(item.type)), native.output);
    else if (provider === 'deepseek') assert.deepEqual(bodies[1].messages.find(item => item.role === 'assistant'), native.message);
    else assert.deepEqual(bodies[1].messages.find(item => item.role === 'assistant').content, native.content);
  });
});

test('explicit text-only capability rejects historical images before fetch while unknown capabilities may try', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(response('openai')); };
  await assert.rejects(requestModel(options({ modelCapabilities: { supportsImages: false }, fetchImpl })), { code: 'MODEL_IMAGES_UNSUPPORTED' });
  await assert.rejects(requestModel(options({ modelCapabilities: { supportsImages: 'yes' }, fetchImpl })), { code: 'INVALID_MODEL_CONFIG' });
  assert.equal(calls, 0);
  await requestModel(options({ modelCapabilities: {}, fetchImpl }));
  await requestModel(options({ fetchImpl }));
  assert.equal(calls, 2);
  await requestModel(options({ messages: [{ role: 'user', content: 'text only' }], modelCapabilities: { supportsImages: false }, fetchImpl }));
  assert.equal(calls, 3);
});

test('invalid, remote, oversized and non-user image attachments fail before a transport request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(response('openai')); };
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1); Buffer.from(png, 'base64').copy(oversized);
  for (const attachments of [null, [image, image, image, image, image], [{ ...image, dataUrl: 'https://example.invalid/image.png' }],
    [{ ...image, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }], [{ ...image, dataUrl: 'data:image/png;base64,!!!!' }],
    [{ ...image, dataUrl: 'data:image/png;base64,' + oversized.toString('base64') }]]) {
    await assert.rejects(requestModel(options({ messages: [{ role: 'user', content: '', attachments }], fetchImpl })),
      error => ['INVALID_IMAGE_ATTACHMENT', 'IMAGE_ATTACHMENT_LIMIT'].includes(error.code) && !error.message.includes('base64,'));
  }
  await assert.rejects(requestModel(options({ messages: [{ role: 'assistant', content: '', attachments: [image] }], fetchImpl })), { code: 'INVALID_MODEL_INPUT' });
  assert.equal(calls, 0);
});

test('per-request historical image limits count decoded bytes and never discard earlier images', async () => {
  let calls = 0, bodyLength = 0;
  const fetchImpl = async (_url, init) => { calls++; bodyLength = init.body.length; return json(response('openai')); };
  const full = Buffer.alloc(8 * 1024 * 1024); Buffer.from(png, 'base64').copy(full);
  const large = { ...image, dataUrl: 'data:image/png;base64,' + full.toString('base64') };
  const sixteenMiB = [0, 1].map(() => ({ role: 'user', content: '', attachments: [large, large, large, large] }));
  await requestModel(options({ messages: sixteenMiB, fetchImpl }));
  assert.ok(bodyLength > 64 * 1024 * 1024, 'decoded-byte budget must not mistakenly count base64 transport bytes');
  await assert.rejects(requestModel(options({ messages: [...sixteenMiB, { role: 'user', content: '', attachments: [image] }], fetchImpl })),
    error => error.code === 'MODEL_IMAGE_HISTORY_LIMIT' && error.message.includes('新建会话'));
  const thirtyTwo = Array.from({ length: 8 }, () => ({ role: 'user', content: '', attachments: [image, image, image, image] }));
  await requestModel(options({ messages: thirtyTwo, fetchImpl }));
  await assert.rejects(requestModel(options({ messages: [...thirtyTwo, { role: 'user', content: '', attachments: [image] }], fetchImpl })), { code: 'MODEL_IMAGE_HISTORY_LIMIT' });
  assert.equal(calls, 2);
  assert.equal(sixteenMiB[0].attachments.length, 4);
  assert.equal(thirtyTwo.length, 8);
});

test('upstream image incompatibility remains actionable without echoing inline image data', async () => {
  await assert.rejects(requestModel(options({ fetchImpl: async () => new Response(JSON.stringify({ error: {
    message: 'image input unsupported: ' + image.dataUrl, code: 'unsupported_image', param: 'input',
  } }), { status: 400, headers: { 'content-type': 'application/json' } }) })), error => {
    assert.equal(error.code, 'PROVIDER_HTTP_400');
    assert.ok(error.message.includes('图片输入'));
    assert.ok(error.message.includes('unsupported_image'));
    assert.equal(error.message.includes(png), false);
    assert.equal(error.message.includes('data:image/'), false);
    return true;
  });
});
