import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';
import { TOOL_DEFINITIONS } from '../src/core/workspace.mjs';

const config = { provider: 'relay', model: 'coordinator', apiKey: 'parent-key', permissionMode: 'request', modelCapabilities: { contextWindow: 128000 } };
const reply = (content = '完成', toolCalls = []) => ({ message: { role: 'assistant', content, toolCalls }, usageReported: true, usage: { inputTokens: 10, outputTokens: 2 } });
const tool = (id, name, args) => ({ id, name, arguments: args });
const childRequest = request => request.messages[0].content.includes('你是独立子智能体');
const delegated = () => reply('分配任务', [tool('spawn', 'spawn_agent', { name: 'Reader', task: '只读检查 fixture.txt' }), tool('wait', 'wait_agents', {})]);
const options = extra => ({ config, messages: [{ role: 'user', content: '只读检查并汇总' }], workspace: { root: 'C:/fixture', execute: async () => 'fixture' },
  toolDefinitions: TOOL_DEFINITIONS, signal: new AbortController().signal, emit: () => {},
  subagentFactory: async () => ({ root: 'C:/fixture', execute: async () => 'fixture' }), ...extra });

test('dedicated child connection routes independently and refreshes between child requests without changing tools or usage attribution', async () => {
  const records = [], events = [], childModels = [];
  let childConfig = { ...config, provider: 'openai', model: 'child-one', apiKey: 'child-key', reasoningEffort: 'high', configRevision: 1 }, rootRound = 0;
  await runAgent(options({ getRequestConfig: () => config, getSubagentRequestConfig: () => childConfig,
    onUsage: async value => records.push(value), emit: value => events.push(value),
    requestModel: async request => {
      if (!childRequest(request)) { assert.equal(request.model, 'coordinator'); assert.equal(request.apiKey, 'parent-key'); return ++rootRound === 1 ? delegated() : reply(); }
      childModels.push(request.model); assert.equal(request.provider, 'openai'); assert.equal(request.apiKey, 'child-key');
      assert.equal(request.tools.some(tool => ['spawn_agent', 'run_command', 'write_file'].includes(tool.name)), false);
      assert.match(request.messages[0].content, /当前操作权限：request/);
      if (childModels.length === 1) { childConfig = { ...childConfig, model: 'child-two', configRevision: 2 }; return reply('读取', [tool('read', 'read_file', { path: 'fixture.txt' })]); }
      return reply('检查完成');
    } }));
  assert.deepEqual(childModels, ['child-one', 'child-two']);
  assert.deepEqual(records.filter(record => record.agentId).map(record => record.model), childModels);
  assert.deepEqual(records.filter(record => !record.agentId).map(record => record.model), ['coordinator', 'coordinator']);
  assert.equal(new Set(records.map(record => record.id)).size, 4);
  assert.ok(events.some(event => event.type === 'request-config-applied' && event.agentId && event.model === 'child-two'));
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1), { type: 'usage', inputTokens: 40, outputTokens: 8 });
});

test('absent role callback retains the live coordinator model for children', async () => {
  let rounds = 0, children = 0;
  await runAgent(options({ getRequestConfig: () => ({ ...config, model: 'live-main' }), requestModel: async request => {
    assert.equal(request.model, 'live-main');
    if (childRequest(request)) { children++; return reply(); }
    return ++rounds === 1 ? delegated() : reply();
  } }));
  assert.equal(children, 1);
});

test('invalid dedicated child config fails that child without silently falling back to coordinator credentials', async () => {
  let rounds = 0, children = 0; const records = [];
  await runAgent(options({ getSubagentRequestConfig: () => ({ provider: 'relay' }), onUsage: value => records.push(value), requestModel: async request => {
    if (childRequest(request)) { children++; return reply(); }
    if (++rounds === 1) return delegated();
    const waited = request.messages.filter(message => message.role === 'tool').at(-1);
    assert.equal(JSON.parse(waited.content).agents[0].status, 'failed'); return reply('子任务未完成');
  } }));
  assert.equal(children, 0); assert.equal(records.some(record => record.agentId), false);
});

test('parent cancellation interrupts an unresolved child-role config before dispatch', async () => {
  const abort = new AbortController(); let entered, children = 0, preflight;
  const started = new Promise(resolve => { entered = resolve; });
  const running = runAgent(options({ signal: abort.signal, getSubagentRequestConfig: value => { preflight = value; entered(); return new Promise(() => {}); }, requestModel: async request => {
    if (childRequest(request)) { children++; return reply(); } return delegated();
  } }));
  await started; abort.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(children, 0);
  assert.notEqual(preflight.signal, abort.signal); assert.equal(preflight.signal.aborted, true); assert.match(preflight.agentId, /^agent-/);
});
