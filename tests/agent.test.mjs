import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';

const config = { provider: 'openai', apiKey: 'secret', model: 'test-model', maxSteps: 3 };
test('agent returns tool results to model, streams text, and accounts usage', async () => {
  const messages = [{ role: 'user', content: 'read it' }], events = [];
  let round = 0;
  await runAgent({ config, messages, signal: new AbortController().signal,
    workspace: { root: 'C:/project', execute: async (name, args) => { assert.equal(name, 'read_file'); assert.equal(args.path, 'a.js'); return 'file text'; } },
    toolDefinitions: [], emit: e => events.push(e),
    requestModel: async request => {
      round++;
      assert.equal(request.messages[0].role, 'system');
      if (round === 1) return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.js' } }] }, usage: { inputTokens: 10, outputTokens: 3 } };
      assert.equal(request.messages.at(-1).toolCallId, 'call-1');
      assert.equal(request.messages.at(-1).content, 'file text');
      request.onTextDelta('done');
      return { message: { role: 'assistant', content: 'done', toolCalls: [] }, usage: { inputTokens: 20, outputTokens: 5 } };
    }
  });
  assert.equal(round, 2);
  assert.equal(messages.at(-1).content, 'done');
  assert.deepEqual(events.filter(e => e.type === 'usage').at(-1), { type: 'usage', inputTokens: 30, outputTokens: 8 });
});

test('cancelled tool batch leaves a matching result for every tool call', async () => {
  const controller = new AbortController(), messages = [];
  await assert.rejects(runAgent({ config, messages, signal: controller.signal,
    workspace: { root: 'test', execute: async () => { controller.abort(); return 'stopped'; } },
    toolDefinitions: [], emit: () => {},
    requestModel: async () => ({ message: { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'one', arguments: {} }, { id: 'b', name: 'two', arguments: {} }] }, usage: {} })
  }));
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.toolCallId), ['a', 'b']);
});

test('legacy round limits are ignored while tool output stays redacted', async () => {
  const messages = [], events = [];
  let requests = 0;
  await runAgent({ config: { ...config, maxSteps: 1 }, messages, signal: new AbortController().signal,
    workspace: { root: 'test', execute: async () => 'sensitive secret' }, toolDefinitions: [], emit: e => events.push(e), redact: x => x.replaceAll('secret', '[redacted]'),
    requestModel: async () => ({ message: { role: 'assistant', content: ++requests === 1 ? '' : 'Finished.',
      toolCalls: requests === 1 ? [{ id: 'a', name: 'test', arguments: {} }] : [] }, usage: {} })
  });
  assert.equal(requests, 2);
  assert.equal(messages.find(m => m.role === 'tool').content, 'sensitive [redacted]');
  assert.equal(messages.at(-1).content, 'Finished.');
  assert.equal(events.some(event => /轮模型调用上限/.test(event.text || '')), false);
});
test('stream replacement frames cannot reassemble a credential split across chunks', async () => {
  const frames = [];
  await runAgent({ config, messages: [], signal: new AbortController().signal,
    workspace: { root: 'test' }, toolDefinitions: [], emit: e => { if (e.type === 'text-delta') frames.push(e); }, redact: x => x.replaceAll('secret-key', '[redacted]'),
    requestModel: async request => {
      request.onTextDelta('key:secret-');
      await new Promise(resolve => setTimeout(resolve, 40));
      request.onTextDelta('key');
      return { message: { role: 'assistant', content: 'key:secret-key', toolCalls: [] }, usage: {} };
    }
  });
  assert.equal(frames.length, 2);
  assert.ok(frames.every(e => e.replace === true && !e.text.includes('secret-key')));
  assert.equal(frames.at(-1).text, 'key:[redacted]');
});
test('request accounting uses final cumulative usage once and passes reasoning effort', async () => {
  const records = [];
  await runAgent({ config: { ...config, reasoningEffort: 'high' }, messages: [], signal: new AbortController().signal,
    workspace: { root: 'test' }, toolDefinitions: [], emit: () => {}, onUsage: async r => records.push(r),
    requestModel: async request => {
      assert.equal(request.reasoningEffort, 'high');
      request.onProgress({ estimatedOutputTokens: 5, usage: { inputTokens: 20, outputTokens: 0 } });
      request.onProgress({ estimatedOutputTokens: 8, usage: { inputTokens: 20, outputTokens: 8 } });
      return { message: { role: 'assistant', content: 'ok', toolCalls: [] }, usage: { inputTokens: 20, outputTokens: 10 }, usageReported: true };
    }
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].inputTokens, 20);
  assert.equal(records[0].outputTokens, 10);
  assert.equal(records[0].partial, false);
});

test('cancelled and failed requests preserve provider-reported usage without estimated billing', async () => {
  const records = [];
  await assert.rejects(runAgent({ config, messages: [], signal: new AbortController().signal,
    workspace: { root: 'test' }, toolDefinitions: [], emit: () => {}, onUsage: async r => records.push(r),
    requestModel: async request => {
      request.onProgress({ estimatedOutputTokens: 500, usage: { inputTokens: 20, outputTokens: 4 } });
      throw new Error('stream failed');
    }
  }), /stream failed/);
  assert.equal(records.length, 1);
  assert.equal(records[0].outputTokens, 4);
  assert.equal(records[0].reported, true);
  assert.equal(records[0].partial, true);
  assert.equal(records[0].status, 'failed');
  const unknown = [];
  await assert.rejects(runAgent({ config, messages: [], signal: new AbortController().signal,
    workspace: { root: 'test' }, toolDefinitions: [], emit: () => {}, onUsage: async r => unknown.push(r),
    requestModel: async () => { throw new Error('offline'); }
  }));
  assert.equal(unknown[0].reported, false);
  assert.equal(unknown[0].outputTokens, null);
});
test('stopping a streaming request records its already reported tokens once', async () => {
  const records = [], controller = new AbortController();
  await assert.rejects(runAgent({ config, messages: [], signal: controller.signal,
    workspace: { root: 'test' }, toolDefinitions: [], emit: () => {}, onUsage: async record => records.push(record),
    requestModel: async request => {
      request.onProgress({ estimatedOutputTokens: 99, usage: { inputTokens: 20, outputTokens: 7 } });
      controller.abort();
      request.signal.throwIfAborted();
    }
  }));
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'stopped');
  assert.equal(records[0].outputTokens, 7);
  assert.equal(records[0].partial, true);
});

const continuationConfig = { provider: 'deepseek', apiKey: 'continuation-test-credential', model: 'test-model', maxSteps: 1 };
const continuationTools = [{ name: 'read_file', description: 'Read a file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} }];
function deepSeekStream(message, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const delta = { ...message };
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
  const source = [
    { choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] },
    { choices: [], usage },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
}
function assertDeepSeekHistory(body) {
  assert.equal(body.tools.length, 1);
  for (const message of body.messages.filter(value => value.role === 'assistant')) {
    assert.equal(typeof message.reasoning_content, 'string', 'Every real assistant continuation must keep its native reasoning_content');
  }
}

test('real agent/provider continuation excludes legacy round-limit notices and preserves native DeepSeek state', async () => {
  const messages = [{ role: 'user', content: 'Read the file.' }], requests = [], records = [], events = [];
  const fetchImpl = async (_endpoint, init) => {
    const body = JSON.parse(init.body);
    assertDeepSeekHistory(body);
    requests.push(body);
    return deepSeekStream(requests.length === 1 ? { content: 'Reading.', reasoning_content: 'first native reasoning', tool_calls: [
      { id: 'continuation-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } },
    ] } : { content: 'Finished.', reasoning_content: 'second native reasoning' });
  };
  const options = { config: continuationConfig, messages, signal: new AbortController().signal,
    workspace: { root: 'mock-project', execute: async () => 'file contents' }, toolDefinitions: continuationTools,
    emit: event => events.push(event), onUsage: async record => records.push(record),
    requestModel: request => requestModel({ ...request, fetchImpl }),
  };
  await runAgent(options);
  const native = structuredClone(messages.find(message => message.providerState).providerState);
  assert.equal(requests.length, 2);
  assert.equal(messages.at(-1).content, 'Finished.');
  // Existing histories can still contain the old client-only cap notice.
  const notice = { role: 'assistant', content: '已达到本次 1 轮模型调用上限，任务暂停。', toolCalls: [], localOnly: true };
  messages.push(notice);
  messages.push({ role: 'user', content: 'Continue.' });
  await runAgent({ ...options, config: { ...continuationConfig, model: 'another-deepseek-model' } });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].model, 'another-deepseek-model');
  assert.equal(requests[2].messages.some(message => message.content === notice.content), false);
  assert.deepEqual(requests[2].messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content), ['first native reasoning', 'second native reasoning']);
  assert.deepEqual(messages.find(message => message.providerState).providerState, native);
  assert.equal(messages.at(-1).content, 'Finished.');
  assert.equal(messages.at(-1).localOnly, undefined);
  assert.equal(records.length, 3);
  assert.equal(records.every(record => record.reported && !record.partial), true);
});

test('real agent/provider resumes after a failed stream while preserving earlier completed native tool state', async () => {
  const messages = [{ role: 'user', content: 'Read the file.' }], requests = [], records = [];
  const fetchImpl = async (_endpoint, init) => {
    const body = JSON.parse(init.body);
    assertDeepSeekHistory(body);
    requests.push(body);
    if (requests.length === 1) return deepSeekStream({ content: 'Reading.', reasoning_content: 'completed native reasoning', tool_calls: [
      { id: 'completed-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.txt"}' } },
    ] });
    if (requests.length === 2) return new Response([
      { choices: [{ index: 0, delta: { reasoning_content: 'uncompleted reasoning' } }] },
      { choices: [{ index: 0, delta: { content: 'Partial visible answer.' } }] },
      { error: { code: 'mock_failure' }, usage: { prompt_tokens: 20, completion_tokens: 4 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    return deepSeekStream({ content: 'Recovered.', reasoning_content: 'recovery native reasoning' });
  };
  const options = { config: { ...continuationConfig, maxSteps: 3 }, messages, signal: new AbortController().signal,
    workspace: { root: 'mock-project', execute: async () => 'file contents' }, toolDefinitions: continuationTools,
    emit: () => {}, onUsage: async record => records.push(record),
    requestModel: request => requestModel({ ...request, fetchImpl }),
  };
  await assert.rejects(runAgent(options), error => error.code === 'PROVIDER_API_ERROR');
  const native = structuredClone(messages.find(message => message.providerState).providerState);
  const partial = messages.at(-1);
  assert.equal(partial.localOnly, true);
  assert.match(partial.content, /Partial visible answer.*本次响应未完成/s);
  assert.equal(partial.providerState, undefined);
  assert.equal(records[1].partial, true);
  assert.equal(records[1].outputTokens, 4);
  messages.push({ role: 'user', content: 'Try again.' });
  await runAgent(options);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.some(message => message.content === partial.content), false);
  assert.deepEqual(requests[2].messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content), ['completed native reasoning']);
  assert.equal(requests[2].messages.find(message => message.role === 'tool').tool_call_id, 'completed-call');
  assert.deepEqual(messages.find(message => message.providerState).providerState, native);
  assert.equal(messages.at(-1).content, 'Recovered.');
  assert.equal(records.length, 3);
  assert.equal(records.filter(record => record.status === 'failed').length, 1);
});

const assistantReply = (content, toolCalls = []) => ({
  message: { role: 'assistant', content, toolCalls }, usage: { inputTokens: 1, outputTokens: 1 }, usageReported: true,
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const steeringOptions = extra => ({ config, messages: [{ role: 'user', content: 'Initial task.' }],
  workspace: { root: 'mock-project' }, toolDefinitions: [], signal: new AbortController().signal, emit: () => {}, ...extra });

test('steering queued before the first request is applied in FIFO order with IDs and no core user events', async () => {
  const messages = [{ role: 'user', content: 'Initial task.' }], events = [], queue = [
    { id: 'steer-one', text: 'First adjustment.' }, { id: 'steer-two', text: 'Second adjustment.' },
  ];
  let takes = 0;
  await runAgent(steeringOptions({ config: { ...config, maxSteps: 1 }, messages, emit: event => events.push(event),
    takeSteering: () => { takes++; return queue.splice(0); },
    requestModel: async request => {
      assert.deepEqual(request.messages.slice(-2), [
        { id: 'steer-one', role: 'user', content: 'First adjustment.' },
        { id: 'steer-two', role: 'user', content: 'Second adjustment.' },
      ]);
      return assistantReply('Finished.');
    },
  }));
  assert.equal(takes, 2);
  assert.equal(queue.length, 0);
  assert.equal(events.some(event => event.type === 'user-message'), false);
});

test('steering arriving during a stream waits for the assistant and then continues with a stable request snapshot', async () => {
  const started = deferred(), response = deferred(), requests = [], events = [], queue = [];
  const previous = { role: 'assistant', content: 'Previous answer.', toolCalls: [],
    providerState: { provider: 'deepseek', message: { reasoning_content: 'previous native reasoning' } } };
  const messages = [{ role: 'user', content: 'Initial task.' }, previous];
  let takes = 0;
  const running = runAgent(steeringOptions({ messages, emit: event => events.push(event),
    takeSteering: async () => {
      takes++;
      if (queue.length) {
        assert.equal(events.at(-1).type, 'assistant-message');
        assert.equal(messages.at(-1).content, 'First answer.');
      }
      return queue.splice(0);
    },
    requestModel: async request => {
      requests.push(request);
      if (requests.length === 1) {
        request.onTextDelta('Working.');
        started.resolve();
        return response.promise;
      }
      assert.deepEqual(request.messages.slice(-3).map(message => [message.role, message.content]), [
        ['assistant', 'First answer.'], ['user', 'Change the target.'], ['user', 'Also check the result.'],
      ]);
      return assistantReply('Adjusted answer.');
    },
  }));
  await started.promise;
  queue.push({ id: 'stream-one', text: 'Change the target.' }, { id: 'stream-two', text: 'Also check the result.' });
  assert.equal(takes, 1, 'Streaming must not poll or dequeue steering');
  assert.equal(messages.some(message => message.id === 'stream-one'), false);
  messages[0].content = 'Changed in the live store.';
  previous.providerState.message.reasoning_content = 'changed live native state';
  assert.equal(requests[0].messages[1].content, 'Initial task.');
  assert.equal(requests[0].messages[2].providerState.message.reasoning_content, 'previous native reasoning');
  response.resolve(assistantReply('First answer.'));
  await running;
  assert.equal(requests.length, 2);
  assert.deepEqual(messages.filter(message => message.id).map(message => message.id), ['stream-one', 'stream-two']);
  assert.equal(messages.at(-1).content, 'Adjusted answer.');
  assert.equal(queue.length, 0);
});

test('steering during a tool batch waits for every matching result before the next request', async () => {
  const firstTool = deferred(), releaseTool = deferred(), queue = [], messages = [], requests = [], events = [];
  const calls = ['tool-one', 'tool-two'].map(id => ({ id, name: id, arguments: {} }));
  let takes = 0, executions = 0;
  const running = runAgent(steeringOptions({ messages, emit: event => events.push(event),
    takeSteering: () => {
      takes++;
      if (queue.length) {
        assert.equal(executions, 2);
        assert.equal(events.at(-1).type, 'tool-result');
        assert.deepEqual(messages.slice(-2).map(message => message.toolCallId), ['tool-one', 'tool-two']);
      }
      return queue.splice(0);
    },
    workspace: { root: 'mock-project', execute: async name => {
      executions++;
      if (name === 'tool-one') { firstTool.resolve(); await releaseTool.promise; }
      else {
        assert.equal(takes, 1);
        assert.equal(messages.some(message => message.id === 'during-first-tool'), false);
        queue.push({ id: 'during-second-tool', text: 'Second tool adjustment.' });
      }
      return `${name} complete`;
    } },
    requestModel: async request => {
      requests.push(request);
      return requests.length === 1 ? assistantReply('Using two tools.', calls) : assistantReply('Finished with adjustments.');
    },
  }));
  await firstTool.promise;
  queue.push({ id: 'during-first-tool', text: 'First tool adjustment.' });
  assert.equal(takes, 1);
  releaseTool.resolve();
  await running;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(1).map(message => message.role), ['assistant', 'tool', 'tool', 'user', 'user']);
  assert.deepEqual(requests[1].messages.filter(message => message.role === 'tool').map(message => message.toolCallId), ['tool-one', 'tool-two']);
  assert.deepEqual(requests[1].messages.filter(message => message.id).map(message => message.id), ['during-first-tool', 'during-second-tool']);
});

test('final answers and tool batches keep accepting steering after legacy round limits', async t => {
  for (const withTools of [false, true]) await t.test(withTools ? 'after tool batch' : 'after final answer', async () => {
    const queue = [], messages = [], pending = { id: 'continue-this-run', text: 'Do this afterward.' };
    const calls = withTools ? [{ id: 'last-call', name: 'read_file', arguments: {} }] : [];
    let takes = 0, requests = 0;
    await runAgent(steeringOptions({ config: { ...config, maxSteps: 1 }, messages,
      takeSteering: () => { takes++; return queue.splice(0); },
      workspace: { root: 'mock-project', execute: async () => 'last tool result' },
      requestModel: async request => {
        requests++;
        if (requests === 1) { queue.push(pending); return assistantReply('First answer.', calls); }
        assert.equal(request.messages.at(-1).id, pending.id);
        return assistantReply('Adjusted answer.');
      },
    }));
    assert.equal(requests, 2);
    assert.equal(takes, 3);
    assert.deepEqual(queue, []);
    assert.equal(messages.filter(message => message.id === pending.id).length, 1);
    assert.equal(messages.at(-1).content, 'Adjusted answer.');
    assert.equal(messages.filter(message => message.role === 'tool').length, calls.length);
  });
});

test('tasks complete beyond thirty rounds with late steering and one usage record per request', { timeout: 3000 }, async () => {
  const messages = [{ role: 'user', content: 'Complete the long task.' }], records = [], events = [], queue = [];
  let requests = 0, executions = 0;
  await runAgent(steeringOptions({ config: { ...config, maxSteps: 1 }, messages, emit: event => events.push(event),
    takeSteering: () => queue.splice(0), onUsage: async record => records.push(record),
    workspace: { root: 'mock-project', execute: async (_name, args) => { executions++; return `result ${args.round}`; } },
    requestModel: async request => {
      requests++;
      assert.ok(requests <= 36, 'The test must terminate without an unbounded fake model.');
      const result = requests <= 34
        ? assistantReply('', [{ id: `long-${requests}`, name: 'read_file', arguments: { round: requests } }])
        : assistantReply(requests === 35 ? 'Initial result.' : 'Completed after steering.');
      if (requests === 35) queue.push({ id: 'late-adjustment', text: 'Verify one more thing.' });
      if (requests === 36) assert.equal(request.messages.at(-1).id, 'late-adjustment');
      result.usage = { inputTokens: requests, outputTokens: 2 };
      return result;
    },
  }));
  assert.equal(requests, 36);
  assert.equal(executions, 34);
  assert.equal(messages.filter(message => message.role === 'tool').length, executions);
  assert.equal(messages.filter(message => message.id === 'late-adjustment').length, 1);
  assert.equal(messages.at(-1).content, 'Completed after steering.');
  assert.deepEqual(queue, []);
  assert.equal(records.length, requests);
  assert.equal(new Set(records.map(record => record.id)).size, requests);
  assert.ok(records.every(record => record.status === 'completed' && record.reported && !record.partial));
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1), { type: 'usage', inputTokens: 666, outputTokens: 72 });
  assert.equal(messages.some(message => message.localOnly), false);
});

test('a task beyond thirty rounds cancels its active request and timer without consuming later steering', { timeout: 3000 }, async t => {
  const controller = new AbortController(), blocked = deferred(), records = [], queue = [], messages = [];
  const timers = [], cleared = [], events = [];
  const nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = nativeSetInterval(...args); timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', timer => { cleared.push(timer); return nativeClearInterval(timer); });
  let requests = 0, activeRequests = 0;
  const running = runAgent(steeringOptions({ config: { ...config, maxSteps: 30 }, messages, signal: controller.signal,
    emit: event => events.push(event), onUsage: async record => records.push(record), takeSteering: () => queue.splice(0),
    workspace: { root: 'mock-project', execute: async () => 'done' },
    requestModel: async request => {
      requests++;
      assert.ok(requests <= 36, 'Cancellation must not issue another model request.');
      if (requests <= 35) return assistantReply('', [{ id: `cancel-long-${requests}`, name: 'read_file', arguments: {} }]);
      activeRequests++;
      let onAbort;
      try {
        request.onTextDelta('Still working.');
        request.onProgress({ phase: 'thinking', usage: { inputTokens: 3, outputTokens: 4 } });
        const stopped = new Promise((_resolve, reject) => {
          onAbort = () => reject(request.signal.reason);
          request.signal.addEventListener('abort', onAbort, { once: true });
        });
        blocked.resolve();
        return await stopped;
      } finally {
        activeRequests--;
        request.signal.removeEventListener('abort', onAbort);
      }
    },
  }));
  await blocked.promise;
  queue.push({ id: 'keep-after-cancel', text: 'Wait for my next task.' });
  controller.abort();
  await assert.rejects(running, error => error.name === 'AbortError');
  const eventCount = events.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 36);
  assert.equal(activeRequests, 0);
  assert.equal(events.length, eventCount);
  assert.equal(timers.length, 1);
  assert.deepEqual(cleared, timers);
  assert.deepEqual(queue.map(entry => entry.id), ['keep-after-cancel']);
  assert.equal(messages.some(message => message.id === 'keep-after-cancel'), false);
  assert.equal(messages.filter(message => message.role === 'tool').length, 35);
  assert.match(messages.at(-1).content, /Still working\..*本次响应未完成/s);
  assert.equal(records.length, requests);
  assert.equal(new Set(records.map(record => record.id)).size, requests);
  assert.ok(records.slice(0, -1).every(record => record.status === 'completed' && !record.partial));
  assert.equal(records.at(-1).status, 'stopped');
  assert.equal(records.at(-1).partial, true);
  assert.equal(records.at(-1).reported, true);
  assert.equal(records.at(-1).inputTokens, 3);
  assert.equal(records.at(-1).outputTokens, 4);
});

test('cancellation before a request, during streaming or during tools never dequeues later steering', async t => {
  for (const phase of ['before', 'stream', 'tools', 'after-answer']) await t.test(phase, async () => {
    const controller = new AbortController(), pending = { id: `cancel-${phase}`, text: 'Keep this adjustment.' };
    const queue = phase === 'before' ? [pending] : [], messages = [];
    let takes = 0;
    if (phase === 'before') controller.abort();
    await assert.rejects(runAgent(steeringOptions({ messages, signal: controller.signal,
      takeSteering: () => { takes++; return queue.splice(0); },
      emit: event => {
        if (phase === 'after-answer' && event.type === 'assistant-message') { queue.push(pending); controller.abort(); }
      },
      workspace: { root: 'mock-project', execute: async () => { queue.push(pending); controller.abort(); return 'stopped tool'; } },
      requestModel: async request => {
        if (phase === 'stream') {
          request.onTextDelta('Partial answer.'); queue.push(pending); controller.abort(); controller.signal.throwIfAborted();
        }
        return phase === 'tools' ? assistantReply('Tools.', ['one', 'two'].map(id => ({ id, name: id, arguments: {} })))
          : assistantReply('Completed answer.');
      },
    })), error => error.name === 'AbortError');
    assert.equal(takes, phase === 'before' ? 0 : 1);
    assert.deepEqual(queue, [pending]);
    assert.equal(messages.some(message => message.id === pending.id), false);
    if (phase === 'tools') assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.toolCallId), ['one', 'two']);
  });
});
