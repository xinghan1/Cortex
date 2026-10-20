import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';
import { prepareContext } from '../src/core/context-compaction.mjs';
import { requestModel } from '../src/core/providers.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const call = (id, name, args) => ({ id, name, arguments: args });
const reply = (content = 'Finished.', toolCalls = []) => ({ message: { role: 'assistant', content, toolCalls },
  usage: { inputTokens: 10, outputTokens: 2 }, usageReported: true });
const base = { provider: 'relay', apiProtocol: 'responses', authMode: 'apiKey', baseUrl: 'https://fixture.invalid/v1', apiKey: 'first-key',
  model: 'alpha', modelCapabilities: { contextWindow: 100000, supportsTools: true }, reasoningEffort: 'low',
  permissionMode: 'request', connectionKey: 'connection-one', configRevision: 1 };
const options = overrides => ({ config: base, messages: [{ role: 'user', content: 'Inspect the fixture.' }],
  workspace: { root: 'C:/fixture', execute: async () => 'fixture text' }, toolDefinitions: [],
  signal: new AbortController().signal, emit: () => {}, ...overrides });
const childRequest = request => request.messages[0].content.includes('你是独立子智能体');
const abortWait = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const history = () => [{ role: 'user', content: 'Preserve the original goal and inspect the fixture.' },
  { role: 'assistant', content: 'Reading.', toolCalls: [call('large-read', 'read_file', { path: 'fixture.txt' })] },
  { role: 'tool', toolCallId: 'large-read', content: '旧'.repeat(60000) }];

test('an in-flight snapshot stays frozen while the next request applies model, effort, permission and actual usage identity', async () => {
  const entered = deferred(), release = deferred(), records = [], contexts = [], events = [], requests = [];
  const mutableFirst = structuredClone(base);
  let current = mutableFirst;
  const messages = [{ role: 'user', content: 'Inspect the fixture.' }];
  const running = runAgent(options({ messages, getRequestConfig: async () => current,
    emit: event => events.push(event), onUsage: async record => records.push(record), onContextUsage: value => contexts.push(value),
    requestModel: async request => {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve(); await release.promise;
        assert.equal(request.model, 'alpha'); assert.equal(request.reasoningEffort, 'low');
        assert.equal(request.modelCapabilities.contextWindow, 100000);
        assert.equal(Object.isFrozen(request.modelCapabilities), true);
        assert.match(request.messages[0].content, /当前操作权限：request/);
        return reply('Read first.', [call('read', 'read_file', { path: 'fixture.txt' })]);
      }
      assert.equal(request.model, 'beta'); assert.equal(request.reasoningEffort, 'high');
      assert.equal(request.permissionMode, 'full'); assert.equal(request.modelCapabilities.contextWindow, 64000);
      assert.match(request.messages[0].content, /当前操作权限：full/);
      assert.equal(request.authMode, 'apiKey'); assert.equal(request.apiProtocol, 'responses');
      return reply();
    },
  }));
  await entered.promise;
  mutableFirst.modelCapabilities.contextWindow = 1;
  current = { ...base, model: 'beta', modelCapabilities: { contextWindow: 64000 }, reasoningEffort: 'high', permissionMode: 'full', configRevision: 2 };
  release.resolve(); await running;
  assert.deepEqual(records.map(record => [record.model, record.connectionKey, record.configRevision]),
    [['alpha', 'connection-one', 1], ['beta', 'connection-one', 2]]);
  assert.equal(new Set(records.map(record => record.id)).size, 2);
  assert.deepEqual(contexts.filter(value => value.status === 'estimated').map(value => [value.model, value.limit]), [['alpha', 100000], ['beta', 64000]]);
  assert.deepEqual(events.filter(event => event.type === 'request-config-applied').map(event => [event.model, event.permissionMode]), [['alpha', 'request'], ['beta', 'full']]);
  assert.equal(JSON.stringify(events).includes('first-key'), false);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
});

test('a smaller model selected at the dispatch boundary replans and compacts with its own budget before any paid request', async () => {
  const original = history(), messages = structuredClone(original), records = [], compacted = [], events = [];
  let reads = 0, paid = 0;
  const large = { ...base, modelCapabilities: { contextWindow: 1000000 } };
  const small = { ...base, model: 'small', modelCapabilities: { contextWindow: 20000 }, configRevision: 2 };
  await runAgent(options({ messages, config: large, getRequestConfig: async () => ++reads === 1 ? large : small,
    emit: event => events.push(event), onUsage: async record => records.push(record), onContextCompacted: async value => compacted.push(value),
    requestModel: async request => {
      paid++; assert.equal(request.model, 'small');
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        assert.ok(request.messages[1].content.length <= 16000);
        assert.match(request.messages[0].content, /当前操作权限：request/);
        return reply('保留原任务，已读取 fixture.txt，继续核对。');
      }
      assert.ok(request.messages.some(message => message.content.includes('自动压缩的历史资料')));
      return reply();
    },
  }));
  assert.equal(paid, 2);
  assert.equal(compacted.length, 1); assert.equal(compacted[0].contextLimit, 20000);
  assert.equal(compacted[0].triggerTokens, 16000); assert.equal(compacted[0].model, 'small');
  assert.deepEqual(records.map(record => [record.model, record.purpose]), [['small', 'context-compaction'], ['small', undefined]]);
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(events.filter(event => event.type === 'request-config-applied').some(event => event.model === 'alpha'), false);
});

test('a switch during a paid summary keeps that request attribution and applies the new capacity to the following request', async () => {
  const entered = deferred(), release = deferred(), records = [], compacted = [], contexts = [];
  let current = { ...base, modelCapabilities: { contextWindow: 30000 } }, paid = 0;
  const running = runAgent(options({ messages: history(), getRequestConfig: async () => current,
    onUsage: async record => records.push(record), onContextCompacted: async value => compacted.push(value), onContextUsage: value => contexts.push(value),
    requestModel: async request => {
      paid++;
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        assert.equal(request.model, 'alpha'); entered.resolve(); await release.promise;
        assert.equal(request.modelCapabilities.contextWindow, 30000);
        return reply('已读原文件，继续任务。');
      }
      assert.equal(request.model, 'beta'); assert.equal(request.modelCapabilities.contextWindow, 20000);
      return reply();
    },
  }));
  await entered.promise;
  current = { ...base, model: 'beta', modelCapabilities: { contextWindow: 20000 }, configRevision: 2 };
  release.resolve(); await running;
  assert.equal(paid, 2);
  assert.deepEqual(records.map(record => [record.model, record.purpose]), [['alpha', 'context-compaction'], ['beta', undefined]]);
  assert.equal(compacted[0].contextLimit, 30000);
  assert.equal(contexts[0].model, 'beta'); assert.equal(contexts[0].limit, 20000);
});

async function oversizedCheckpoint() {
  const messages = history(), checkpoint = {};
  await prepareContext({ messages, checkpoint, modelCapabilities: { contextWindow: 50000 },
    summarize: async () => 'LEGACY_SUMMARY_ONLY_MARKER' + '摘'.repeat(13000) });
  assert.equal(checkpoint.count, 1);
  return { messages, checkpoint };
}

test('an oversized saved summary is rebuilt once from original history with the smaller budget and monotonic compaction count', async () => {
  const { messages, checkpoint } = await oversizedCheckpoint(), saved = structuredClone(checkpoint), original = structuredClone(messages);
  const entered = deferred(), release = deferred(), records = [], compacted = [];
  const current = { ...base, model: 'small', modelCapabilities: { contextWindow: 10000 }, configRevision: 3 };
  const running = runAgent(options({ messages, contextCheckpoint: checkpoint, getRequestConfig: async () => current,
    onUsage: async record => records.push(record), onContextCompacted: async value => compacted.push(value),
    requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        assert.equal(request.model, 'small');
        assert.match(request.messages[1].content, /Preserve the original goal/);
        assert.equal(request.messages[1].content.includes('LEGACY_SUMMARY_ONLY_MARKER'), false);
        entered.resolve(); await release.promise;
        return reply('原目标与已读文件保留，旧摘要已缩短。');
      }
      return reply();
    },
  }));
  await entered.promise;
  assert.deepEqual(checkpoint, saved, 'The old checkpoint remains committed until replacement succeeds');
  assert.deepEqual(messages, original);
  release.resolve(); await running;
  assert.equal(checkpoint.count, 2); assert.equal(compacted[0].count, 2);
  assert.equal(compacted[0].contextLimit, 10000); assert.equal(compacted.length, 1);
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(records.length, 2);
});

test('failure rebuilding a saved checkpoint preserves it and does not retry a paid request', async () => {
  const { messages, checkpoint } = await oversizedCheckpoint(), saved = structuredClone(checkpoint), records = [];
  let paid = 0;
  await assert.rejects(runAgent(options({ messages, contextCheckpoint: checkpoint,
    getRequestConfig: async () => ({ ...base, model: 'small', modelCapabilities: { contextWindow: 10000 }, configRevision: 3 }),
    onUsage: async value => records.push(value), requestModel: async () => { paid++; throw new Error('Summary provider offline'); },
  })), /Summary provider offline/);
  assert.deepEqual(checkpoint, saved); assert.equal(paid, 1);
  assert.equal(records[0].model, 'small'); assert.equal(records[0].purpose, 'context-compaction');
  assert.equal(records[0].status, 'failed');
});

test('an impossible essential prompt fails without configuration retry loops or paid requests', async () => {
  let reads = 0, paid = 0;
  await assert.rejects(runAgent(options({ messages: [{ role: 'user', content: '必需原任务'.repeat(5000) }],
    getRequestConfig: async () => { reads++; return { ...base, modelCapabilities: { contextWindow: 1000 } }; },
    requestModel: async () => { paid++; return reply(); },
  })), error => error.code === 'CONTEXT_COMPACTION_LIMIT');
  assert.ok(reads <= 3); assert.equal(paid, 0);
});

test('running children inherit the getter and apply selections independently at their next request boundaries', async () => {
  const bothEntered = deferred(), release = deferred(), records = [], contexts = [], events = [], rounds = new Map();
  let current = base, started = 0, parentRound = 0;
  const running = runAgent(options({ getRequestConfig: async () => current,
    subagentFactory: async () => ({ root: 'C:/fixture', execute: async () => 'child file' }),
    emit: event => events.push(event), onUsage: async value => records.push(value), onContextUsage: value => contexts.push(value),
    requestModel: async request => {
      if (childRequest(request)) {
        const name = request.messages[0].content.includes('智能体 First') ? 'First' : 'Second';
        const round = (rounds.get(name) || 0) + 1; rounds.set(name, round);
        if (round === 1) {
          assert.equal(request.model, 'alpha');
          if (++started === 2) bothEntered.resolve();
          await release.promise;
          return reply('Read child fixture.', [call(`read-${name}`, 'read_file', { path: 'fixture.txt' })]);
        }
        assert.equal(request.model, 'beta'); assert.match(request.messages[0].content, /当前操作权限：assist/);
        assert.equal(request.tools.some(tool => tool.name === 'spawn_agent'), false);
        return reply(`${name} verified.`);
      }
      if (++parentRound === 1) return reply('', [call('first', 'spawn_agent', { name: 'First', task: 'Inspect first fixture.' }),
        call('second', 'spawn_agent', { name: 'Second', task: 'Inspect second fixture.' }), call('join', 'wait_agents', {})]);
      assert.equal(request.model, 'beta'); return reply();
    },
  }));
  await bothEntered.promise;
  current = { ...base, model: 'beta', permissionMode: 'assist', configRevision: 2 };
  release.resolve(); await running;
  assert.equal(records.length, 6);
  assert.equal(records.filter(value => value.model === 'alpha').length, 3);
  assert.equal(records.filter(value => value.model === 'beta').length, 3);
  assert.equal(records.filter(value => value.agentId).length, 4);
  assert.deepEqual(contexts.filter(value => value.status === 'estimated').map(value => value.model), ['alpha', 'beta']);
  assert.equal(events.filter(event => event.type === 'request-config-applied' && event.agentId).length, 4);
});

test('real provider serialization does not replay old native reasoning after a live model or connection switch', async t => {
  for (const change of ['model', 'connection', 'protocol', 'provider']) await t.test(change, async () => {
    const first = { ...base, provider: 'deepseek', baseUrl: 'https://fixture.invalid/v1', model: 'deepseek-a', reasoningEffort: 'default' };
    let current = first, count = 0;
    const messages = [{ role: 'user', content: 'Read fixture.' }], originalNative = [];
    const next = { ...first, configRevision: 2,
      ...(change === 'model' ? { model: 'deepseek-b' } : {}),
      ...(change === 'connection' ? { connectionKey: 'connection-two', apiKey: 'second-key' } : {}),
      ...(change === 'protocol' ? { provider: 'relay', apiProtocol: 'chat-completions' } : {}),
      ...(change === 'provider' ? { provider: 'openai', apiProtocol: 'chat-completions' } : {}),
    };
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (++count === 1) {
        current = next;
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Reading.',
          reasoning_content: 'PRIVATE_NATIVE_MODEL_A', tool_calls: [{ id: 'native-read', type: 'function',
            function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } });
      }
      assert.equal(body.model, next.model);
      assert.equal(JSON.stringify(body).includes('PRIVATE_NATIVE_MODEL_A'), false);
      const assistant = body.messages.find(message => message.role === 'assistant');
      assert.equal(assistant.tool_calls[0].id, 'native-read');
      assert.equal(body.messages.at(-1).tool_call_id, 'native-read');
      originalNative.push(structuredClone(messages.find(message => message.providerState).providerState));
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.', reasoning_content: 'New model thought' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 18, completion_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
    };
    await runAgent(options({ config: first, messages, getRequestConfig: async () => current,
      requestModel: value => requestModel({ ...value, fetchImpl }),
    }));
    assert.equal(count, 2);
    assert.equal(messages[1].providerState.message.reasoning_content, 'PRIVATE_NATIVE_MODEL_A');
    assert.deepEqual(messages[1].providerState, originalNative[0]);
    assert.equal(messages.filter(message => message.role === 'user').length, 1);
  });
});

test('same-model native continuation is retained when only effort and permission change', async () => {
  const native = { provider: 'openai', apiProtocol: 'responses', authMode: 'apiKey', model: 'alpha', endpoint: 'https://fixture.invalid/v1/responses',
    output: [{ type: 'reasoning', encrypted_content: 'BOUND_ENCRYPTED_STATE' }] };
  let current = base, round = 0;
  await runAgent(options({ getRequestConfig: async () => current,
    requestModel: async request => {
      if (++round === 1) {
        current = { ...base, permissionMode: 'full', reasoningEffort: 'high', configRevision: 2 };
        return { ...reply('', [call('read', 'read_file', { path: 'fixture.txt' })]),
          message: { ...reply('', [call('read', 'read_file', { path: 'fixture.txt' })]).message, providerState: structuredClone(native) } };
      }
      assert.deepEqual(request.messages.find(message => message.providerState)?.providerState, native);
      return reply();
    },
  }));
  assert.equal(round, 2);
});

test('a Responses to Chat Completions switch strips encrypted native state in the request copy', async () => {
  let current = base, round = 0;
  const messages = [{ role: 'user', content: 'Inspect fixture.' }];
  await runAgent(options({ messages, getRequestConfig: async () => current,
    requestModel: async request => {
      if (++round === 1) {
        current = { ...base, apiProtocol: 'chat-completions', configRevision: 2 };
        return { ...reply('', [call('read', 'read_file', { path: 'fixture.txt' })]),
          message: { ...reply('', [call('read', 'read_file', { path: 'fixture.txt' })]).message,
            providerState: { provider: 'openai', model: 'alpha', endpoint: 'https://fixture.invalid/v1/responses',
              output: [{ type: 'reasoning', encrypted_content: 'PRIVATE_ENCRYPTED_RESPONSES_STATE' }] } } };
      }
      assert.equal(request.apiProtocol, 'chat-completions');
      assert.equal(request.messages.some(message => message.providerState), false);
      assert.equal(request.messages.at(-1).toolCallId, 'read');
      return reply();
    },
  }));
  assert.equal(messages[1].providerState.output[0].encrypted_content, 'PRIVATE_ENCRYPTED_RESPONSES_STATE');
});

test('auth mode is forwarded unchanged to the request dispatcher and old account native state is isolated', async () => {
  const first = { ...base, provider: 'openai' }, records = [];
  let current = first, round = 0;
  await runAgent(options({ config: first, getRequestConfig: async () => current, onUsage: async value => records.push(value),
    requestModel: async request => {
      if (++round === 1) {
        assert.equal(request.authMode, 'apiKey');
        current = { ...first, authMode: 'chatgpt', apiKey: 'synthetic-chatgpt-credential', connectionKey: 'account-two', configRevision: 2 };
        return { ...reply('', [call('read', 'read_file', { path: 'fixture.txt' })]),
          message: { ...reply('', [call('read', 'read_file', { path: 'fixture.txt' })]).message,
            providerState: { provider: 'openai', authMode: 'apiKey', model: 'alpha', endpoint: 'https://fixture.invalid/v1/responses',
              output: [{ type: 'reasoning', encrypted_content: 'PRIVATE_OLD_ACCOUNT_STATE' }] } } };
      }
      assert.equal(request.authMode, 'chatgpt'); assert.equal(request.apiKey, 'synthetic-chatgpt-credential');
      assert.equal(request.messages.some(message => message.providerState), false);
      return reply();
    },
  }));
  assert.deepEqual(records.map(value => [value.authMode, value.connectionKey]), [['apiKey', 'connection-one'], ['chatgpt', 'account-two']]);
});

test('cancellation during an old in-flight request records only its actual configuration and partial usage once', async () => {
  const controller = new AbortController(), entered = deferred(), records = [];
  let current = base, calls = 0;
  const running = runAgent(options({ signal: controller.signal, getRequestConfig: async () => current,
    onUsage: async value => records.push(value), requestModel: async request => {
      calls++; request.onProgress({ usage: { inputTokens: 17, outputTokens: 4 } }); entered.resolve();
      await abortWait(request.signal);
    },
  }));
  await entered.promise;
  current = { ...base, model: 'beta', configRevision: 2 };
  controller.abort(new Error('Stopped during alpha'));
  await assert.rejects(running, /Stopped during alpha/);
  assert.equal(calls, 1); assert.equal(records.length, 1);
  assert.equal(records[0].model, 'alpha'); assert.equal(records[0].configRevision, 1);
  assert.equal(records[0].outputTokens, 4); assert.equal(records[0].status, 'stopped'); assert.equal(records[0].partial, true);
});

test('cancellation and invalid snapshots stop before any model request without consuming ledger entries', async t => {
  await t.test('pending getter', async () => {
    const controller = new AbortController(), entered = deferred(), release = deferred();
    let paid = 0, entries = 0;
    const running = runAgent(options({ signal: controller.signal,
      getRequestConfig: async () => { entered.resolve(); await release.promise; return base; },
      onUsage: async () => { entries++; }, requestModel: async () => { paid++; return reply(); },
    }));
    await entered.promise; controller.abort(new Error('Stop config lookup'));
    await assert.rejects(running, /Stop config lookup/);
    release.resolve(); assert.equal(paid, 0); assert.equal(entries, 0);
  });
  await t.test('invalid snapshot', async () => {
    let paid = 0;
    await assert.rejects(runAgent(options({ getRequestConfig: async () => ({ ...base, model: '', permissionMode: 'invalid' }),
      requestModel: async () => { paid++; return reply(); },
    })), /实时模型配置无效/);
    assert.equal(paid, 0);
  });
});
