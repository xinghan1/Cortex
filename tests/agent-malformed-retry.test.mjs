import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';

const malformed = () => Object.assign(new Error('工具参数不是有效 JSON。'), { code: 'INVALID_TOOL_ARGUMENTS', retryableMalformedToolJson: true });
const reply = { message: { role: 'assistant', content: '完成', toolCalls: [] }, usageReported: false };
const base = { provider: 'relay', apiProtocol: 'chat-completions', model: 'old', apiKey: 'fixture', baseUrl: 'https://example.invalid/v1' };
const workspace = { root: 'C:/fixture', execute: async () => { throw new Error('Should not execute'); } };

test('switching config after malformed output replans without replaying invalid output', async () => {
  let selected = base, count = 0;
  const requests = [], events = [], messages = [{ role: 'user', content: 'continue' }];
  await runAgent({ config: base, getRequestConfig: async () => selected, messages, workspace, toolDefinitions: [],
    requestModel: async args => {
      requests.push(structuredClone({ model: args.model, messages: args.messages }));
      if (++count === 1) { selected = { ...base, model: 'new' }; throw malformed(); }
      return reply;
    }, signal: new AbortController().signal, emit: event => events.push(event) });
  assert.deepEqual(requests.map(value => value.model), ['old', 'new']);
  assert.equal(JSON.stringify(requests[1].messages).includes('工具参数不是有效 JSON'), false);
  assert.ok(events.some(event => event.type === 'reconnect' && event.reason === 'format' && event.status === 'recovered'));
});

test('abort before format retry does not send another request', async () => {
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(runAgent({ config: base, messages: [{ role: 'user', content: 'continue' }], workspace, toolDefinitions: [],
    requestModel: async () => { requests++; controller.abort(); throw malformed(); }, signal: controller.signal, emit: () => {} }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('format retry exhaustion ends the reconnect state without executing tools', async () => {
  const events = []; let requests = 0;
  await assert.rejects(runAgent({ config: base, messages: [{ role: 'user', content: 'continue' }], workspace, toolDefinitions: [],
    requestModel: async () => { requests++; throw malformed(); }, signal: new AbortController().signal, emit: event => events.push(event) }), /自动重新生成两次/);
  assert.equal(requests, 3);
  assert.ok(events.some(event => event.type === 'reconnect' && event.status === 'failed' && event.reason === 'format'));
});

test('format retry budget stays bounded when a model is changed between attempts', async () => {
  let selected = base, requests = 0;
  await assert.rejects(runAgent({ config: base, getRequestConfig: async () => selected,
    messages: [{ role: 'user', content: 'continue' }], workspace, toolDefinitions: [],
    requestModel: async () => { requests++; selected = { ...base, model: `next-${requests}` }; throw malformed(); },
    signal: new AbortController().signal, emit: () => {} }), /自动重新生成两次/);
  assert.equal(requests, 3);
});
