import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModel } from '../src/core/providers.mjs';
import { runAgent } from '../src/core/agent.mjs';
import { ModelCatalog, deriveModelCapabilities } from '../src/core/model-catalog.mjs';

const tools = [{ name: 'write_file', description: 'Synthetic file writer', parameters: {
  type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
} }];
const base = { provider: 'deepseek', authMode: 'deepseek-account', model: 'deepseek-flash', apiKey: 'fake-budget-key',
  messages: [{ role: 'user', content: 'Create an HTML and SVG animation.' }], tools };
const response = (stop_reason = 'end_turn', content = [{ type: 'text', text: 'done' }]) => Response.json({
  id: 'fixture-message', type: 'message', role: 'assistant', model: base.model, stop_reason, content,
  usage: { input_tokens: 6908, output_tokens: stop_reason === 'max_tokens' ? 8192 : 15 },
});

test('DeepSeek account Messages gets bounded effort-aware output defaults instead of the Claude 8K default', async () => {
  for (const [reasoningEffort, expected] of [['none', 8192], ['default', 65536], ['low', 65536], ['high', 65536], ['max', 131072]]) {
    let sent;
    await requestModel({ ...base, reasoningEffort, modelCapabilities: { maxOutputTokens: 393216 },
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages'); sent = JSON.parse(init.body); return response();
      } });
    assert.equal(sent.max_tokens, expected); assert.equal(sent.thinking?.budget_tokens, undefined);
    if (reasoningEffort === 'max') assert.deepEqual(sent.output_config, { effort: 'max' });
  }
});

test('validated catalog output limits survive normalization and clamp defaults without using context capacity as output', async () => {
  const listed = await new ModelCatalog().list({ provider: 'deepseek', apiKey: 'fake-catalog-key',
    fetchImpl: async () => Response.json({ data: [{ id: base.model, context_window: 1048576,
      max_output_tokens: 20000, api_capabilities: { anthropic_messages: {} } }] }) });
  const capabilities = deriveModelCapabilities('deepseek', base.model, listed.models[0]);
  assert.equal(capabilities.contextWindow, 1048576); assert.equal(capabilities.maxOutputTokens, 20000);
  for (const raw of [0, -1, 1.5, '20000', Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(deriveModelCapabilities('deepseek', base.model, { max_output_tokens: raw }).maxOutputTokens, undefined);
  }
  for (const [modelCapabilities, expected] of [[capabilities, 20000], [{ contextWindow: 1048576 }, 131072],
    [{ maxOutputTokens: 4096 }, 4096], [{ maxOutputTokens: Number.MAX_SAFE_INTEGER }, 131072]]) {
    let sent;
    await requestModel({ ...base, modelCapabilities, reasoningEffort: 'max', fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return response(); } });
    assert.equal(sent.max_tokens, expected);
  }
});

test('explicit auxiliary budgets and unrelated provider defaults remain unchanged', async () => {
  for (const [extra, expected] of [[{ maxOutputTokens: 256 }, 256], [{ maxOutputTokens: 2048 }, 2048],
    [{ provider: 'anthropic', authMode: 'apiKey', model: 'claude-fixture' }, 8192]]) {
    let sent;
    await requestModel({ ...base, reasoningEffort: 'max', ...extra,
      fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return response(); } });
    assert.equal(sent.max_tokens, expected);
  }
  let apiBody;
  await requestModel({ ...base, authMode: 'apiKey', reasoningEffort: 'max', fetchImpl: async (_url, init) => {
    apiBody = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
  } });
  assert.equal(Object.hasOwn(apiBody, 'max_tokens'), false, 'The existing Chat Completions route keeps its server-selected default');
});

test('agent can finish a >8K synthetic tool response while every explicitly truncated response executes no tools or retry', async () => {
  for (const limited of [false, true]) {
    const bodies = [], executions = [], usage = [], messages = [...base.messages];
    const args = { path: 'index.html', content: '<svg>' + 'x'.repeat(36000) + '</svg>' };
    const operation = runAgent({ config: { ...base, reasoningEffort: 'max', modelCapabilities: { maxOutputTokens: 393216 },
      ...(limited ? { maxOutputTokens: 8192 } : {}) }, messages, signal: new AbortController().signal,
      workspace: { root: 'synthetic-budget-project', execute: async (name, input) => { executions.push({ name, input }); return 'written'; } },
      toolDefinitions: tools, emit() {}, onUsage: value => usage.push(value),
      requestModel: config => requestModel({ ...config, fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body); bodies.push(body);
        if (bodies.length > 1) return response();
        return response(body.max_tokens <= 8192 ? 'max_tokens' : 'tool_use', [{ type: 'tool_use', id: 'fixture-write', name: 'write_file', input: args }]);
      } }),
    });
    if (limited) {
      await assert.rejects(operation, error => error.code === 'PROVIDER_TRUNCATED' && !error.message.includes('缩短上下文'));
      assert.equal(bodies.length, 1); assert.equal(executions.length, 0); assert.equal(messages.some(message => message.role === 'tool'), false);
      assert.equal(usage[0].outputTokens, 8192); assert.equal(usage[0].status, 'failed');
    } else {
      await operation; assert.equal(bodies.length, 2); assert.equal(bodies[0].max_tokens, 131072);
      assert.deepEqual(executions, [{ name: 'write_file', input: args }]); assert.equal(messages.at(-1).content, 'done');
    }
  }
});

test('streamed truncated tool arguments remain unexecutable even with a complete-looking JSON fragment', async () => {
  const values = [
    { type: 'message_start', message: { id: 'fixture-stream', role: 'assistant', content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'partial-write', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"index.html","content":"incomplete"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } },
    { type: 'message_stop' },
  ];
  let requests = 0;
  await assert.rejects(requestModel({ ...base, reasoningEffort: 'max', fetchImpl: async () => {
    requests++; return new Response(values.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } }), { code: 'PROVIDER_TRUNCATED' });
  assert.equal(requests, 1);
});
