import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';
import { ChatGPTConnection } from '../src/core/chatgpt.mjs';
import { reconnectReason } from '../src/core/request-retry.mjs';

const config = { provider: 'deepseek', model: 'reconnect-fixture', apiKey: 'reconnect-private-fixture' };
const transient = (code = 'PROVIDER_NETWORK_ERROR', extra = {}) => Object.assign(new Error('Synthetic connection interruption'), { code, retryAfterMs: 0, ...extra });
const reply = (content, toolCalls = []) => ({ message: { role: 'assistant', content, toolCalls }, usage: { inputTokens: 10, outputTokens: 3 } });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

test('retrying a partially streamed model reply preserves completed tools and accounts for each attempt exactly once', async () => {
  const messages = [{ role: 'user', content: 'Read then explain the fixture.' }], events = [], records = [];
  let calls = 0, executions = 0;
  await runAgent({ config, messages, signal: new AbortController().signal, toolDefinitions: [],
    workspace: { root: 'synthetic', execute: async () => { executions++; return 'fixture contents'; } },
    emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: async request => {
      calls++;
      if (calls === 1) return reply('Inspecting.', [{ id: 'only-call', name: 'read_file', arguments: { path: 'fixture.txt' } }]);
      assert.equal(request.messages.at(-1).toolCallId, 'only-call');
      assert.equal(request.messages.at(-1).content, 'fixture contents');
      assert.equal(request.messages.some(message => message.localOnly), false);
      if (calls === 2) {
        request.onTextDelta('discard this failed partial');
        request.onProgress({ estimatedOutputTokens: 5, usage: { inputTokens: 12, outputTokens: 4 } });
        throw transient();
      }
      request.onTextDelta('Final recovered answer.');
      return reply('Final recovered answer.');
    },
  });
  assert.equal(calls, 3);
  assert.equal(executions, 1);
  assert.equal(events.filter(event => event.type === 'tool-start').length, 1);
  assert.equal(events.filter(event => event.type === 'tool-result').length, 1);
  assert.equal(events.filter(event => event.type === 'assistant-message').length, 2);
  assert.equal(messages.some(message => message.localOnly || message.content.includes('discard this failed partial')), false);
  const waiting = events.find(event => event.type === 'reconnect' && event.status === 'waiting');
  assert.equal(waiting.resetText, true);
  assert.equal(waiting.attempt, 1);
  assert.equal(events.find(event => event.type === 'reconnect' && event.status === 'recovered').attempt, 1);
  assert.deepEqual(records.map(record => record.status), ['completed', 'failed', 'completed']);
  assert.equal(new Set(records.map(record => record.id)).size, 3);
  assert.equal(records[1].partial, true);
  assert.equal(records[1].reported, true);
  assert.equal(records[1].outputTokens, 4);
});

test('retry exhaustion preserves only the final partial as non-executable local history', async () => {
  const messages = [{ role: 'user', content: 'Explain.' }], records = [], events = [];
  let calls = 0;
  await assert.rejects(runAgent({ config, messages, signal: new AbortController().signal,
    workspace: { root: 'synthetic', execute: () => assert.fail('No incomplete tool can execute') }, toolDefinitions: [],
    emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: async request => {
      calls++;
      request.onTextDelta(`partial-${calls}`);
      request.onProgress({ usage: { inputTokens: 20, outputTokens: 2 } });
      throw transient('PROVIDER_INCOMPLETE_STREAM');
    },
  }), { code: 'PROVIDER_INCOMPLETE_STREAM' });
  assert.equal(calls, 6);
  assert.equal(records.length, 6);
  assert.equal(new Set(records.map(record => record.id)).size, 6);
  assert.ok(records.every(record => record.status === 'failed' && record.partial));
  assert.equal(messages.length, 2);
  assert.equal(messages.at(-1).localOnly, true);
  assert.equal(messages.at(-1).content, 'partial-6\n\n[本次响应未完成]');
  assert.deepEqual(messages.at(-1).toolCalls, []);
  assert.equal(events.filter(event => event.type === 'assistant-message').length, 0);
  assert.equal(events.filter(event => event.type === 'reconnect' && event.status === 'waiting').length, 5);
  assert.equal(events.filter(event => event.type === 'reconnect').at(-1).reason, 'retry-limit');
});

test('stopping during cooldown clears the discarded partial and creates no request or usage entry that was never sent', async () => {
  const controller = new AbortController(), messages = [{ role: 'user', content: 'Explain.' }], records = [];
  let calls = 0;
  await assert.rejects(runAgent({ config, messages, signal: controller.signal,
    workspace: { root: 'synthetic' }, toolDefinitions: [],
    emit: event => { if (event.type === 'reconnect' && event.status === 'waiting') controller.abort(); },
    onUsage: async record => records.push(record),
    requestModel: async request => { calls++; request.onTextDelta('discarded'); throw transient('PROVIDER_TIMEOUT', { retryAfterMs: 30_000 }); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(messages.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed');
});

test('stopping a new active attempt keeps only its partial and records the real cancelled attempt once', async () => {
  const controller = new AbortController(), messages = [{ role: 'user', content: 'Explain.' }], records = [];
  let calls = 0;
  await assert.rejects(runAgent({ config, messages, signal: controller.signal,
    workspace: { root: 'synthetic' }, toolDefinitions: [], emit: () => {}, onUsage: async record => records.push(record),
    requestModel: async request => {
      calls++;
      request.onTextDelta(calls === 1 ? 'old failed text' : 'new cancelled text');
      if (calls === 1) throw transient();
      controller.abort(); request.signal.throwIfAborted();
    },
  }), { name: 'AbortError' });
  assert.equal(calls, 2);
  assert.equal(messages.at(-1).content, 'new cancelled text\n\n[本次响应未完成]');
  assert.deepEqual(records.map(record => record.status), ['failed', 'stopped']);
});

test('an explicit SSE early end retries from the same original input and does not execute partial tool calls', async () => {
  const messages = [{ role: 'user', content: 'Read a fixture.' }], wireBodies = [], records = [];
  const tools = [{ name: 'read_file', description: 'Read fixture', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  let calls = 0, executed = 0;
  await runAgent({ config: { ...config, provider: 'openai' }, messages, signal: new AbortController().signal,
    workspace: { root: 'synthetic', execute: async () => { executed++; return 'contents'; } }, toolDefinitions: tools,
    emit: () => {}, onUsage: async record => records.push(record),
    requestModel: request => requestModel({ ...request, fetchImpl: async (_url, init) => {
      wireBodies.push(JSON.parse(init.body));
      if (++calls === 1) return new Response(sse({ type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', id: 'not-finished', call_id: 'not-finished', name: 'read_file', arguments: '{"path":"fixture.txt"}' } }), { headers: { 'content-type': 'text/event-stream' } });
      return json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered without running the incomplete call.' }] }], usage: { input_tokens: 17, output_tokens: 8 } });
    } }),
  });
  assert.equal(calls, 2);
  assert.equal(executed, 0);
  assert.deepEqual(wireBodies[0], wireBodies[1]);
  assert.deepEqual(records.map(record => record.status), ['failed', 'completed']);
  assert.equal(records[0].reported, false);
});

test('all native adapters share the agent retry boundary including ChatGPT account credential dispatch', async t => {
  for (const provider of ['openai', 'deepseek', 'anthropic', 'relay', 'ollama', 'chatgpt']) await t.test(provider, async () => {
    const records = [], events = [];
    let calls = 0, tokenCalls = 0;
    const modelConfig = { ...config, provider: provider === 'chatgpt' ? 'openai' : provider,
      ...(provider === 'relay' ? { baseUrl: 'https://relay.invalid/v1' } : {}), ...(provider === 'chatgpt' ? { authMode: 'chatgpt' } : {}) };
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return json({ error: { code: 'server_error', message: 'Temporary fixture outage' } }, 503, { 'retry-after': '0' });
      if (provider === 'ollama') return json({ message: { role: 'assistant', content: 'Done.' }, done: true, prompt_eval_count: 17, eval_count: 8 });
      if (provider === 'anthropic') return json({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 8 } });
      if (['deepseek', 'relay'].includes(provider)) return json({ choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 8 } });
      const response = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }], usage: { input_tokens: 17, output_tokens: 8 } };
      return provider === 'chatgpt' ? new Response(sse({ type: 'response.completed', response }), { headers: { 'content-type': 'text/event-stream' } }) : json(response);
    };
    let dispatch = request => requestModel({ ...request, fetchImpl });
    if (provider === 'chatgpt') {
      const state = { status: 'connected', sharing: true, profileId: 'synthetic-profile', profileLabel: 'Fixture' };
      const client = { getSession: async () => state, subscribe: callback => { callback(state); return () => {}; }, listProfiles: async () => [],
        signIn: async () => state, cancelSignIn() {}, selectProfile: async () => state, disconnect: async () => {}, listModels: async () => [],
        withAccessToken: async (operation, signal) => { tokenCalls++; return operation('synthetic-oauth-never-display', signal); } };
      const account = new ChatGPTConnection({ dataDir: path.resolve('tests/.tmp/injected-sdk-no-files'),
        safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }, createClient: async () => client });
      await account.init();
      dispatch = request => account.requestModel({ ...request, requestModel: value => requestModel({ ...value, fetchImpl }) });
    }
    await runAgent({ config: modelConfig, messages: [{ role: 'user', content: 'Synthetic retry only.' }],
      signal: new AbortController().signal, workspace: { root: 'synthetic' }, toolDefinitions: [], requestModel: dispatch,
      emit: event => events.push(event), onUsage: async record => records.push(record) });
    assert.equal(calls, 2);
    assert.deepEqual(records.map(record => record.status), ['failed', 'completed']);
    assert.equal(records[1].inputTokens, 17);
    assert.equal(records[1].outputTokens, 8);
    assert.equal(events.filter(event => event.type === 'assistant-message').length, 1);
    assert.equal(events.filter(event => event.type === 'reconnect' && event.status === 'recovered').length, 1);
    if (provider === 'chatgpt') assert.equal(tokenCalls, 2, 'Each actual POST gets exactly one SDK token wrapper, with no nested model retry');
    assert.equal(JSON.stringify(events).includes('synthetic-oauth-never-display'), false);
  });
});

test('quota, routing and certificate failures remain terminal and Retry-After never exposes raw diagnostics', async () => {
  const options = { ...config, messages: [{ role: 'user', content: 'Synthetic request.' }] };
  const fixtures = [
    { status: 429, code: 'insufficient_quota', message: 'Quota exhausted.' },
    { status: 503, code: 'no_available_channel', message: 'No available channel for model in current group.' },
    { status: 429, code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.' },
  ];
  for (const fixture of fixtures) await assert.rejects(requestModel({ ...options, fetchImpl: async () => json({ error: fixture }, fixture.status, { 'retry-after': '0' }) }), error => {
    assert.equal(error.retryable, false); assert.equal(reconnectReason(error), null); return true;
  });
  await assert.rejects(requestModel({ ...options, fetchImpl: async () => { throw new TypeError('private URL', { cause: { code: 'CERT_HAS_EXPIRED' } }); } }), error => {
    assert.equal(error.retryable, false); assert.equal(reconnectReason(error), null); return true;
  });
  await assert.rejects(requestModel({ ...options, onTextDelta: () => { throw new Error('private callback state'); }, fetchImpl: async () => json({ choices: [{ message: { role: 'assistant', content: 'text' }, finish_reason: 'stop' }] }) }), error => {
    assert.equal(error.retryable, false); assert.equal(reconnectReason(error), null); return true;
  });
  await assert.rejects(requestModel({ ...options, fetchImpl: async () => json({}, 429, { 'retry-after': '7' }) }), error => {
    assert.equal(error.retryAfterMs, 7000); return true;
  });
});

test('changing model and permission during reconnect replans a smaller context before the next actual request', async () => {
  const large = { ...config, provider: 'relay', apiProtocol: 'responses', baseUrl: 'https://fixture.invalid/v1',
    model: 'large-alpha', modelCapabilities: { contextWindow: 1_000_000 }, permissionMode: 'request', connectionKey: 'fixture-connection', configRevision: 1 };
  const small = { ...large, model: 'small-beta', modelCapabilities: { contextWindow: 20_000 }, permissionMode: 'full', configRevision: 2 };
  let current = large;
  const messages = [{ role: 'user', content: 'Preserve this goal and inspect the fixture.' },
    { role: 'assistant', content: 'Already read.', toolCalls: [{ id: 'old-call', name: 'read_file', arguments: { path: 'fixture.txt' } }],
      providerState: { provider: 'openai', model: 'large-alpha', endpoint: 'https://fixture.invalid/v1/responses', output: [{ type: 'reasoning', encrypted_content: 'old-model-state' }] } },
    { role: 'tool', toolCallId: 'old-call', content: '旧'.repeat(60_000) }];
  const original = structuredClone(messages), records = [], requests = [], compacted = [], events = [];
  await runAgent({ config: large, messages, getRequestConfig: async () => current, signal: new AbortController().signal,
    workspace: { root: 'synthetic', execute: () => assert.fail('Already completed tools must remain completed') }, toolDefinitions: [],
    emit: event => { events.push(event); if (event.type === 'reconnect' && event.status === 'waiting') current = small; },
    onUsage: async record => records.push(record), onContextCompacted: async value => compacted.push(value),
    requestModel: async request => {
      requests.push(request);
      if (requests.length === 1) {
        assert.equal(request.model, 'large-alpha');
        request.onTextDelta('Discard the failed alpha response.');
        throw transient();
      }
      assert.equal(request.model, 'small-beta');
      assert.equal(request.permissionMode, 'full');
      assert.equal(request.modelCapabilities.contextWindow, 20_000);
      assert.match(request.messages[0].content, /当前操作权限：full/);
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        assert.ok(request.messages[1].content.length <= 16_000);
        return reply('保留原任务，fixture.txt 已读，继续核对。');
      }
      assert.ok(request.messages.some(message => message.content.includes('自动压缩的历史资料')));
      assert.equal(request.messages.some(message => message.providerState?.model === 'large-alpha'), false);
      return reply('Recovered with the new model.');
    },
  });
  assert.equal(requests.length, 3, 'The configuration replan creates no fictitious failed API attempt');
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].contextLimit, 20_000);
  assert.deepEqual(records.map(record => [record.model, record.configRevision, record.status, record.purpose]), [
    ['large-alpha', 1, 'failed', undefined], ['small-beta', 2, 'completed', 'context-compaction'], ['small-beta', 2, 'completed', undefined],
  ]);
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(messages.some(message => message.localOnly || message.content.includes('Discard the failed alpha')), false);
  assert.equal(events.filter(event => event.type === 'reconnect' && event.status === 'recovered').at(-1).attempt, 1);
});

test('configuration replanning does not reset the five-reconnect budget', async () => {
  let current = { ...config, model: 'model-0', permissionMode: 'request', configRevision: 0 }, calls = 0;
  const events = [], records = [];
  await assert.rejects(runAgent({ config: current, messages: [{ role: 'user', content: 'Synthetic request.' }],
    getRequestConfig: async () => current, signal: new AbortController().signal,
    workspace: { root: 'synthetic' }, toolDefinitions: [],
    emit: event => {
      events.push(event);
      if (event.type === 'reconnect' && event.status === 'waiting') current = { ...current, model: `model-${event.attempt}`, configRevision: event.attempt };
    }, onUsage: async record => records.push(record),
    requestModel: async () => { calls++; throw transient(); },
  }), { code: 'PROVIDER_NETWORK_ERROR' });
  assert.equal(calls, 6);
  assert.equal(records.length, 6);
  assert.deepEqual(records.map(record => record.model), ['model-0', 'model-1', 'model-2', 'model-3', 'model-4', 'model-5']);
  assert.deepEqual(events.filter(event => event.type === 'reconnect' && event.status === 'waiting').map(event => event.attempt), [1, 2, 3, 4, 5]);
});

test('valid JSON with invalid response structures is a single protocol failure, never a network reconnect', async t => {
  const fixtures = [
    { provider: 'deepseek', frame: { choices: {} } },
    { provider: 'deepseek', frame: { choices: [{ index: 0, delta: { tool_calls: {} } }] } },
    { provider: 'openai', frame: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: {} } } },
  ];
  for (const [index, fixture] of fixtures.entries()) await t.test(String(index + 1), async () => {
    let calls = 0;
    const events = [], records = [];
    await assert.rejects(runAgent({ config: { ...config, provider: fixture.provider }, messages: [{ role: 'user', content: 'Synthetic request.' }],
      signal: new AbortController().signal, workspace: { root: 'synthetic', execute: () => assert.fail('Invalid data cannot execute tools') }, toolDefinitions: [],
      emit: event => events.push(event), onUsage: async record => records.push(record),
      requestModel: request => requestModel({ ...request, fetchImpl: async () => {
        calls++; return new Response(sse(fixture.frame), { headers: { 'content-type': 'text/event-stream' } });
      } }),
    }), { code: 'PROVIDER_PROTOCOL_ERROR' });
    assert.equal(calls, 1);
    assert.equal(events.some(event => event.type === 'reconnect' || event.type === 'tool-start'), false);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'failed');
    assert.equal(records[0].reported, false);
  });
});

test('known authentication failure stays terminal when reading its error body loses the connection', async () => {
  let calls = 0;
  const events = [], records = [];
  await assert.rejects(runAgent({ config, messages: [{ role: 'user', content: 'Synthetic request.' }],
    signal: new AbortController().signal, workspace: { root: 'synthetic' }, toolDefinitions: [],
    emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: request => requestModel({ ...request, fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('fixture transport reset')); } }), { status: 401 });
    } }),
  }), { code: 'PROVIDER_HTTP_401' });
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === 'reconnect'), false);
  assert.equal(records.length, 1);
});
