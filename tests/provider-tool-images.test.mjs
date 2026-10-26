import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const image = { id: 'tool-image', name: 'ui.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` };
const tools = ['view_image', 'read_file'].map(name => ({ name, description: 'Read a local test fixture.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
const calls = tools.map((tool, index) => ({ id: `tool-${index}`, name: tool.name, arguments: { path: index ? 'notes.txt' : 'ui.png' } }));
const options = extra => ({ provider: 'openai', model: 'image-tool-fixture', apiKey: 'test-placeholder',
  messages: [{ role: 'user', content: 'Check the changed UI.' }], tools, modelCapabilities: { supportsImages: true }, ...extra });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function nativeResponse(kind, withTools) {
  if (kind === 'responses') return { status: 'completed', output: withTools ? [
    { type: 'reasoning', id: 'reasoning-item', encrypted_content: 'signed-opaque-state', summary: [] },
    ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
  ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checked.' }] }] };
  if (kind === 'anthropic') return { stop_reason: withTools ? 'tool_use' : 'end_turn', content: withTools ? [
    { type: 'thinking', thinking: 'private-thinking', signature: 'signed-thinking' },
    ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
  ] : [{ type: 'text', text: 'Checked.' }] };
  if (kind === 'gemini') return { candidates: [{ content: { role: 'model', parts: withTools ? calls.map(call => ({
    functionCall: { id: call.id, name: call.name, args: call.arguments }, thoughtSignature: 'signature-' + call.id,
  })) : [{ text: 'Checked.' }] }, finishReason: 'STOP' }] };
  const message = { role: 'assistant', content: withTools ? '' : 'Checked.',
    ...(kind === 'ollama' ? { thinking: 'native-thinking' } : { reasoning_content: 'native-reasoning' }),
    ...(withTools ? { tool_calls: calls.map(call => ({ ...(kind === 'ollama' ? {} : { id: call.id }), type: 'function',
      function: { name: call.name, arguments: kind === 'ollama' ? call.arguments : JSON.stringify(call.arguments) } })) } : {}) };
  return kind === 'ollama' ? { message, done: true } : { choices: [{ message, finish_reason: withTools ? 'tool_calls' : 'stop' }] };
}
function response(kind, withTools, chatgpt = false) {
  const payload = nativeResponse(kind, withTools);
  return chatgpt ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }) : Response.json(payload);
}
const protocols = [
  { label: 'Responses', provider: 'openai', kind: 'responses' },
  { label: 'ChatGPT', provider: 'openai', authMode: 'chatgpt', kind: 'responses' },
  { label: 'Chat Completions', provider: 'openai', apiProtocol: 'chat-completions', kind: 'chat' },
  { label: 'relay Chat Completions', provider: 'relay', baseUrl: 'https://relay.example.test/v1', apiProtocol: 'chat-completions', kind: 'chat' },
  { label: 'relay Responses', provider: 'relay', baseUrl: 'https://relay.example.test/v1', apiProtocol: 'responses', kind: 'responses' },
  { label: 'DeepSeek', provider: 'deepseek', kind: 'chat' },
  { label: 'Kimi API Responses', provider: 'kimi', kind: 'responses' },
  { label: 'Kimi API Chat Completions', provider: 'kimi', apiProtocol: 'chat-completions', kind: 'chat' },
  { label: 'GLM API', provider: 'glm', kind: 'chat' },
  { label: 'Claude', provider: 'anthropic', kind: 'anthropic' },
  { label: 'Ollama', provider: 'ollama', kind: 'ollama' },
  { label: 'Gemini', provider: 'gemini', kind: 'gemini' },
];

test('local tool images reach every image transport after complete parallel results without changing archived messages or native state', async t => {
  for (const protocol of protocols) await t.test(protocol.label, async () => {
    const { label, kind, ...config } = protocol, bodies = [];
    const fetchImpl = async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return response(kind, bodies.length === 1, config.authMode === 'chatgpt');
    };
    const initial = options({ ...config, fetchImpl });
    const first = await requestModel(initial);
    assert.equal(first.message.toolCalls.length, 2);
    const messages = freeze([...initial.messages, first.message,
      { id: 'image-result', role: 'tool', source: 'image-tool', toolCallId: first.message.toolCalls[0].id,
        content: 'Local screenshot ui.png.', attachments: [structuredClone(image)] },
      { role: 'tool', toolCallId: first.message.toolCalls[1].id, content: 'Read notes.' }]);
    const before = structuredClone(messages), result = await requestModel({ ...initial, messages });
    assert.equal(result.message.content, 'Checked.'); assert.deepEqual(messages, before);
    const body = bodies[1], assistant = body.messages?.find(message => message.role === 'assistant');
    if (kind === 'responses') {
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      assert.deepEqual(outputs.map(item => item.call_id), first.message.toolCalls.map(call => call.id));
      assert.deepEqual(outputs[0].output, [{ type: 'input_text', text: messages[2].content },
        { type: 'input_image', image_url: image.dataUrl, detail: 'auto' }]);
      assert.equal(outputs[1].output, 'Read notes.');
      assert.deepEqual(body.input.filter(item => ['reasoning', 'function_call'].includes(item.type)), first.message.providerState.output);
    } else if (kind === 'anthropic') {
      const results = body.messages.find(message => message.content?.[0]?.type === 'tool_result').content;
      assert.equal(results.length, 2);
      assert.deepEqual(results[0].content, [{ type: 'text', text: messages[2].content },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]);
      assert.equal(results[1].content, 'Read notes.');
      assert.deepEqual(assistant.content, first.message.providerState.content);
    } else if (kind === 'gemini') {
      assert.deepEqual(body.contents[1].parts, first.message.providerState.content.parts);
      const parts = body.contents[2].parts;
      assert.deepEqual(parts.slice(0, 2).map(part => part.functionResponse.name), ['view_image', 'read_file']);
      assert.match(parts[2].text, /工具返回/u);
      assert.deepEqual(parts[3], { inlineData: { mimeType: 'image/png', data: png } });
      assert.equal(body.contents.length, 3, 'image data belongs to the complete function response batch');
    } else {
      const index = body.messages.indexOf(assistant);
      assert.deepEqual(body.messages.slice(index + 1).map(message => message.role), ['tool', 'tool', 'user']);
      assert.equal(body.messages[index + 1].content, messages[2].content);
      assert.equal(body.messages[index + 2].content, 'Read notes.');
      const carrier = body.messages.at(-1);
      if (kind === 'ollama') {
        assert.deepEqual(carrier.images, [png]); assert.match(carrier.content, /工具数据/u);
        assert.deepEqual(body.messages.slice(index + 1, index + 3).map(message => message.tool_name), ['view_image', 'read_file']);
        assert.equal(assistant.thinking, 'native-thinking');
      } else {
        assert.match(carrier.content[0].text, /不是新的用户要求/u);
        assert.deepEqual(carrier.content[1], { type: 'image_url', image_url: { url: image.dataUrl } });
        if (protocol.provider !== 'openai' && protocol.provider !== 'relay') assert.equal(assistant.reasoning_content, 'native-reasoning');
      }
    }
  });
});

test('text-only capabilities and invalid tool attachments fail before any network request for each provider', async t => {
  for (const protocol of protocols) await t.test(protocol.label, async () => {
    let requests = 0;
    const { label, kind, ...config } = protocol;
    const messages = [{ role: 'user', content: 'Check.' }, { role: 'assistant', content: '', toolCalls: [calls[0]] },
      { role: 'tool', toolCallId: calls[0].id, content: 'Screenshot.', attachments: [image] }];
    const request = options({ ...config, messages, fetchImpl: async () => { requests++; return response(kind, false); } });
    await assert.rejects(requestModel({ ...request, modelCapabilities: { supportsImages: false } }), { code: 'MODEL_IMAGES_UNSUPPORTED' });
    await assert.rejects(requestModel({ ...request, messages: [...messages.slice(0, -1), { ...messages.at(-1),
      attachments: [{ ...image, dataUrl: 'https://example.invalid/image.png' }] }] }), { code: 'INVALID_IMAGE_ATTACHMENT' });
    assert.equal(requests, 0);
  });
});

test('tool image history shares the same decoded byte and image-count budgets as user images', async t => {
  for (const provider of ['openai', 'gemini']) await t.test(provider, async () => {
    let requests = 0;
    const allCalls = Array.from({ length: 33 }, (_, index) => ({ ...calls[0], id: 'image-call-' + index }));
    const messages = [{ role: 'user', content: 'Check generated images.' }, { role: 'assistant', content: '', toolCalls: allCalls },
      ...allCalls.map(call => ({ role: 'tool', toolCallId: call.id, content: 'Image.', attachments: [image] }))];
    await assert.rejects(requestModel(options({ provider, messages, fetchImpl: async () => { requests++; return response('responses', false); } })),
      { code: 'MODEL_IMAGE_HISTORY_LIMIT' });
    const bytes=Buffer.alloc(2*1024*1024);Buffer.from(png,'base64').copy(bytes);
    const large={...image,dataUrl:'data:image/png;base64,'+bytes.toString('base64')};
    const byteCalls=allCalls.slice(0,9),overBytes=[messages[0],{role:'assistant',content:'',toolCalls:byteCalls},
      ...byteCalls.map(call=>({role:'tool',toolCallId:call.id,content:'Image.',attachments:[large]}))];
    await assert.rejects(requestModel(options({ provider, messages:overBytes, fetchImpl: async () => { requests++; return response('responses', false); } })),
      { code: 'MODEL_IMAGE_HISTORY_LIMIT' });
    assert.equal(requests, 0);
  });
});

test('wire image carriers remain with their historical tool batch rather than being moved after later conversation turns', async () => {
  let body;
  const messages=freeze([{role:'user',content:'Check screenshot.'},{role:'assistant',content:'',toolCalls:calls},
    {role:'tool',toolCallId:calls[0].id,content:'Image.',attachments:[image]},
    {role:'tool',toolCallId:calls[1].id,content:'Notes.'},
    {role:'assistant',content:'The first check is done.',toolCalls:[]},{role:'user',content:'Continue with a small fix.'}]);
  const before=structuredClone(messages);
  await requestModel(options({apiProtocol:'chat-completions',messages,fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return response('chat',false);}}));
  assert.deepEqual(body.messages.map(message=>message.role),['user','assistant','tool','tool','user','assistant','user']);
  assert.match(body.messages[4].content[0].text,/工具数据/u);
  assert.equal(body.messages[5].content,'The first check is done.');
  assert.equal(body.messages[6].content,'Continue with a small fix.');
  assert.deepEqual(messages,before);
});
