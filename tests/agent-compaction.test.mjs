import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runAgent } from '../src/core/agent.mjs';
import { requestModel } from '../src/core/providers.mjs';

const config = { provider: 'deepseek', apiKey: 'local-test-credential', model: 'local-test-model', reasoningEffort: 'high' };
const toolDefinitions = [{ name: 'read_file', description: 'Read a local fixture.', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} }];
const isSummary = request => request.messages[0]?.content.includes('[CONTEXT_COMPACTION]');
const reply = (content, toolCalls = [], usage = { inputTokens: 10, outputTokens: 3 }) => ({
  message: { role: 'assistant', content, toolCalls }, usage, usageReported: true,
});
function history() {
  const result = [{ role: 'user', content: 'Complete the existing project; do not repeat completed writes.' }];
  for (let i = 0; i < 24; i++) result.push(
    { role: 'assistant', content: `Read file ${i}.`, toolCalls: [{ id: `old-${i}`, name: 'read_file', arguments: { path: `file-${i}.txt` } }],
      providerState: { provider: 'deepseek', message: { reasoning_content: `private-completed-reasoning-${i}` } } },
    { role: 'tool', toolCallId: `old-${i}`, content: `FILE ${i}: ` + 'completed output '.repeat(700) },
  );
  result.push({ role: 'user', content: 'Now verify the final result.' });
  return result;
}
const options = extra => ({ config, messages: [], workspace: { root: 'fixture-project' }, toolDefinitions,
  signal: new AbortController().signal, emit: () => {}, ...extra });

test('short sessions make no compaction request or notice', async () => {
  const events = [], checkpoint = {}, requests = [], messages = [{ role: 'user', content: 'Hello.' }];
  await runAgent(options({ messages, contextCheckpoint: checkpoint, emit: event => events.push(event),
    requestModel: async request => { requests.push(request); return reply('Done.'); } }));
  assert.equal(requests.length, 1);
  assert.equal(isSummary(requests[0]), false);
  assert.equal(requests[0].reasoningEffort, 'high');
  assert.deepEqual(checkpoint, {});
  assert.equal(events.some(event => event.type.startsWith('context-')), false);
});

test('a real local HTTP provider summarizes a long completed tool result and continues without repeating the tool', { timeout: 5000 }, async t => {
  const messages = [{ role: 'user', content: 'Inspect large.txt and report the actual result.' }];
  const events = [], records = [], bodies = [], checkpoint = {}, order = [];
  let executions = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const summary = body.messages[0].content.includes('[CONTEXT_COMPACTION]');
    let message;
    if (bodies.length === 1) message = { content: 'Reading the fixture.', reasoning_content: 'private original reasoning', tool_calls: [
      { id: 'read-large', type: 'function', function: { name: 'read_file', arguments: '{"path":"large.txt"}' } },
    ] };
    else if (summary) {
      assert.equal(body.tools, undefined);
      assert.ok(body.messages.at(-1).content.length <= 60_000);
      assert.match(body.messages.at(-1).content, /large\.txt/);
      message = { content: '目标：检查 large.txt。read_file 已完成，文件内容很长；下一步仅报告结果，不要重复读取。', reasoning_content: 'private summary reasoning' };
    } else {
      assert.ok(JSON.stringify(body).length < 180_000);
      assert.match(JSON.stringify(body), /read_file 已完成/);
      message = { content: 'Large file inspected; reporting the result.', reasoning_content: 'private final reasoning' };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: bodies.length * 10, completion_tokens: bodies.length } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await runAgent(options({ messages, config: { ...config, baseUrl: `http://127.0.0.1:${server.address().port}` },
    contextCheckpoint: checkpoint, emit: event => { events.push(event); if (event.type === 'context-compacted') order.push('notice'); },
    onUsage: async record => records.push(record),
    onContextCompacted: async metadata => { assert.equal(metadata.messageIndex, 3); assert.ok(checkpoint.throughIndex > 0); order.push('saved'); },
    workspace: { root: 'fixture-project', execute: async (name, args) => {
      executions++; assert.equal(name, 'read_file'); assert.equal(args.path, 'large.txt');
      return 'FILE large.txt read successfully\n' + 'long actual project text\n'.repeat(10_000);
    } }, requestModel }));
  assert.equal(executions, 1);
  assert.equal(bodies.length, 3);
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(record => record.id)).size, 3);
  assert.equal(records.filter(record => record.purpose === 'context-compaction').length, 1);
  assert.deepEqual(records.map(record => record.inputTokens), [10, 20, 30]);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1), { type: 'usage', inputTokens: 60, outputTokens: 6 });
  assert.deepEqual(order, ['saved', 'notice']);
  assert.equal(events.filter(event => event.type === 'context-compacted').length, 1);
  assert.equal(events.some(event => event.type === 'text-delta' && /目标：/.test(event.text)), false);
  assert.equal(messages.filter(message => message.role === 'tool').length, 1);
  assert.ok(messages.find(message => message.role === 'tool').content.length > 180_000, 'The archive keeps the full tool output.');
  assert.equal(messages.some(message => message.content.startsWith('目标：')), false);
  assert.equal(messages.at(-1).content, 'Large file inspected; reporting the result.');
});

test('saved checkpoints survive the next task while full history and native provider state stay unchanged', async () => {
  const messages = history(), originals = structuredClone(messages), checkpoint = {}, events = [], records = [];
  let summaries = 0, normal = 0;
  const request = async request => {
    if (isSummary(request)) {
      summaries++; assert.equal(request.reasoningEffort, 'default'); assert.deepEqual(request.tools, []);
      assert.ok(request.messages.at(-1).content.length <= 60_000);
      assert.equal(request.messages.at(-1).content.includes('private-completed-reasoning'), false, 'Private native reasoning is not summary input.');
      request.onTextDelta('Internal summary text must not appear as an answer.');
      request.onProgress({ phase: 'generating', estimatedOutputTokens: 30 });
      return reply('已读取文件，保留最终验证要求，继续完成验证即可。');
    }
    normal++; assert.ok(JSON.stringify(request.messages).length < 180_000);
    return reply(`Finished ${normal}.`);
  };
  await runAgent(options({ messages, contextCheckpoint: checkpoint, emit: event => events.push(event),
    onUsage: async record => records.push(record), requestModel: request }));
  assert.deepEqual(messages.slice(0, originals.length), originals);
  const saved = structuredClone(checkpoint);
  messages.push({ role: 'user', content: 'Continue from that result.' });
  await runAgent(options({ messages, contextCheckpoint: checkpoint, emit: event => events.push(event),
    onUsage: async record => records.push(record), requestModel: request }));
  assert.equal(summaries, 1);
  assert.equal(normal, 2);
  assert.deepEqual(checkpoint, saved);
  assert.equal(events.filter(event => event.type === 'context-compacted').length, 1);
  assert.equal(events.some(event => event.type === 'text-delta' && /Internal summary/.test(event.text)), false);
  assert.equal(records.length, 3);
  assert.deepEqual(messages.slice(0, originals.length), originals);
});

test('continued large tool results can compact repeatedly while preserving every executed result', { timeout: 5000 }, async () => {
  const messages = [{ role: 'user', content: 'Read all three fixtures once and finish.' }], checkpoint = {}, records = [], events = [];
  let normal = 0, summaries = 0, executions = 0;
  await runAgent(options({ messages, contextCheckpoint: checkpoint, emit: event => events.push(event),
    onUsage: async record => records.push(record),
    workspace: { root: 'fixture-project', execute: async () => { executions++; return `completed file ${executions}\n` + 'data '.repeat(50_000); } },
    requestModel: async request => {
      if (isSummary(request)) { summaries++; return reply(`已读 ${executions} 个文件；继续未完成部分，不重读。`); }
      normal++;
      assert.ok(normal <= 4);
      return normal <= 3 ? reply('', [{ id: `large-${normal}`, name: 'read_file', arguments: { path: `${normal}.txt` } }]) : reply('All fixtures complete.');
    } }));
  assert.equal(normal, 4);
  assert.equal(executions, 3);
  assert.equal(summaries, 3);
  assert.equal(checkpoint.count, 3);
  assert.equal(messages.filter(message => message.role === 'tool').length, 3);
  assert.equal(records.length, 7);
  assert.equal(events.filter(event => event.type === 'context-compacted').length, summaries);
  assert.equal(messages.at(-1).content, 'All fixtures complete.');
});

test('cancelling a summary preserves history and checkpoint, records reported tokens once, and consumes no later steering', async () => {
  const messages = history(), original = structuredClone(messages), checkpoint = {}, controller = new AbortController(), events = [], records = [];
  const queue = [];
  let requests = 0, takes = 0;
  await assert.rejects(runAgent(options({ messages, contextCheckpoint: checkpoint, signal: controller.signal,
    emit: event => events.push(event), onUsage: async record => records.push(record),
    takeSteering: () => { takes++; return queue.splice(0); }, requestModel: async request => {
      requests++; assert.equal(isSummary(request), true);
      request.onTextDelta('A partial internal summary.');
      request.onProgress({ phase: 'thinking', usage: { inputTokens: 70, outputTokens: 9 } });
      queue.push({ id: 'next-steering', text: 'Save this for the next task.' });
      controller.abort(); request.signal.throwIfAborted();
    } })), error => error.name === 'AbortError');
  assert.equal(requests, 1);
  assert.equal(takes, 1);
  assert.deepEqual(queue.map(entry => entry.id), ['next-steering']);
  assert.deepEqual(messages, original);
  assert.deepEqual(checkpoint, {});
  assert.equal(events.some(event => event.type === 'context-compacted' || event.type === 'text-delta'), false);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'stopped');
  assert.equal(records[0].partial, true);
  assert.equal(records[0].reported, true);
  assert.equal(records[0].inputTokens, 70);
  assert.equal(records[0].outputTokens, 9);
});

test('invalid or failed summaries never execute tools, commit a checkpoint, leak partial summary, or automatically retry', async t => {
  for (const kind of ['tool-call', 'empty', 'network']) await t.test(kind, async () => {
    const messages = history(), original = structuredClone(messages), checkpoint = {}, events = [], records = [];
    let requests = 0, executions = 0;
    await assert.rejects(runAgent(options({ messages, contextCheckpoint: checkpoint, emit: event => events.push(event),
      onUsage: async record => records.push(record), workspace: { root: 'fixture-project', execute: async () => { executions++; } },
      requestModel: async request => {
        requests++; assert.equal(isSummary(request), true);
        request.onTextDelta('Partial summary.');
        if (kind === 'network') { request.onProgress({ usage: { inputTokens: 5, outputTokens: 1 } }); throw new Error('local summary transport failed'); }
        return kind === 'empty' ? reply('') : reply('Summary with an impermissible tool call.', [{ id: 'no', name: 'read_file', arguments: {} }]);
      } })), kind === 'network' ? /local summary transport failed/ : /压缩.*摘要/);
    assert.equal(requests, 1);
    assert.equal(executions, 0);
    assert.deepEqual(checkpoint, {});
    assert.deepEqual(messages, original);
    assert.equal(records.length, 1);
    assert.equal(events.some(event => event.type === 'context-compacted' || event.type === 'text-delta' || event.type === 'assistant-message'), false);
  });
});

test('failure to persist a committed summary stops before the next model request and never repeats a completed tool', async () => {
  const messages = history(), checkpoint = {}, events = [];
  let requests = 0, saves = 0;
  await assert.rejects(runAgent(options({ messages, contextCheckpoint: checkpoint, emit: event => events.push(event),
    requestModel: async request => { requests++; assert.ok(isSummary(request)); return reply('文件均已读取，下一步验证。'); },
    onContextCompacted: async () => { saves++; throw new Error('isolated save failure'); },
  })), /isolated save failure/);
  assert.equal(requests, 1);
  assert.equal(saves, 1);
  assert.ok(checkpoint.throughIndex > 0, 'Do not roll back a successful in-memory summary on a storage error.');
  assert.equal(events.some(event => event.type === 'context-compacted'), false);
});
