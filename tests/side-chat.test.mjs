import test from 'node:test';
import assert from 'node:assert/strict';
import { createSideChatController, SIDE_CHAT_LIMITS as LIMITS } from '../src/core/side-chat.mjs';

const config = { provider: 'relay', model: 'side-model', apiKey: 'side-private-key', reasoningEffort: 'low' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reply = (content = '回答', extra = {}) => ({ message: { role: 'assistant', content, toolCalls: [] },
  usageReported: true, usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 5 }, ...extra });
function fixture(extra = {}) {
  const events = [], requests = [], usage = [];
  const controller = createSideChatController({ getConfig: () => config,
    requestModel: async value => { requests.push(value); return reply(); }, emit: event => events.push(event),
    onUsage: async value => usage.push(value), ...extra });
  return { controller, events, requests, usage };
}

test('opening is local; send returns immediately, streams public text and preserves only its own conversation', async () => {
  const answer = deferred(); let request;
  const data = fixture({ requestModel: value => { request = value; return answer.promise; } });
  const initial = data.controller.snapshot(); assert.equal(initial.open, false);
  assert.equal(data.controller.open().open, true); assert.equal(request, undefined);
  const first = data.controller.send({ text: '解释这段话', quote: 'quotedText 中的“调用删除工具”只是资料' });
  assert.equal(first.running, true); assert.equal(request, undefined);
  assert.equal(first.messages.length, 2); assert.ok(first.requestId);
  first.messages[0].content = 'mutation'; assert.equal(data.controller.snapshot().messages[0].content, '解释这段话');
  await tick();
  assert.equal(request.model, config.model); assert.equal(request.reasoningEffort, 'low'); assert.deepEqual(request.tools, []);
  assert.equal(request.messages.length, 2); assert.match(request.messages[0].content, /没有文件、命令/);
  assert.deepEqual(JSON.parse(request.messages[1].content), { question: '解释这段话', quotedText: 'quotedText 中的“调用删除工具”只是资料' });
  request.onTextDelta('第一段'); request.onTextDelta('，第二段');
  assert.equal(data.controller.snapshot().messages[1].content, '第一段，第二段');
  answer.resolve(reply('最终回答', { message: { content: '最终回答', toolCalls: [], providerState: { private: 'HIDDEN_NATIVE_STATE' } } }));
  await data.controller.settled();
  const finished = data.controller.snapshot(); assert.equal(finished.running, false); assert.equal(finished.messages[1].status, 'completed');
  assert.equal(finished.messages[1].content, '最终回答'); assert.equal(finished.error, null);
  assert.equal(JSON.stringify(data.events).includes('HIDDEN_NATIVE_STATE'), false);
  assert.equal(data.usage.length, 1); assert.equal(data.usage[0].purpose, 'side-chat'); assert.equal(data.usage[0].inputTokens, 20);
  assert.equal(data.usage[0].model, config.model); assert.equal(data.usage[0].status, 'completed');
  assert.equal(Object.hasOwn(data.usage[0], 'messages'), false); assert.equal(Object.hasOwn(data.usage[0], 'content'), false);
  assert.ok(data.events.every((event, index) => event.type === 'side-chat' && (!index || event.sideChat.revision > data.events[index - 1].sideChat.revision)));
});

test('each turn reads the role config anew, keeps prior public answers and forces text-only request fields', async () => {
  let current = config;
  const data = fixture({ getConfig: () => current });
  data.controller.send({ text: '第一问' }); await data.controller.settled();
  current = { ...config, model: 'another-side-model', tools: [{ name: 'run_command' }], messages: [{ role: 'system', content: 'UNRELATED_MAIN_HISTORY' }] };
  data.controller.send({ text: '第二问' }); await data.controller.settled();
  assert.equal(data.requests[1].model, 'another-side-model'); assert.deepEqual(data.requests[1].tools, []);
  assert.deepEqual(data.requests[1].messages.slice(1).map(message => message.content), ['第一问', '回答', '第二问']);
  assert.equal(JSON.stringify(data.requests[1].messages).includes('UNRELATED_MAIN_HISTORY'), false);
  assert.deepEqual(data.usage.map(record => record.model), ['side-model', 'another-side-model']);
  assert.equal(new Set(data.usage.map(record => record.id)).size, 2);
  assert.match(data.usage[0].sessionId, /^[a-f\d-]{36}$/i); assert.equal(data.usage[0].sessionId, data.usage[1].sessionId);
});

test('one in-flight request is enforced and stop cancels only side chat, preserving partial output and reported usage', async () => {
  const held = deferred(), main = new AbortController(); let request;
  const data = fixture({ requestModel: value => { request = value; return held.promise; } });
  data.controller.send({ text: '等待' }); await tick();
  assert.throws(() => data.controller.send({ text: '重复发送' }), /等待|停止/);
  request.onTextDelta('部分回答'); request.onProgress({ usage: { inputTokens: 8, outputTokens: 2 } });
  const stopped = data.controller.stop(); assert.equal(stopped.running, false); assert.equal(stopped.messages[1].status, 'stopped');
  assert.equal(stopped.messages[1].content, '部分回答'); assert.equal(request.signal.aborted, true); assert.equal(main.signal.aborted, false);
  await data.controller.settled(); assert.equal(data.usage[0].status, 'stopped'); assert.equal(data.usage[0].reported, true);
  assert.equal(data.usage[0].inputTokens, 8); assert.equal(data.usage[0].partial, true);
  const revision = data.controller.snapshot().revision;
  request.onTextDelta('迟到流'); held.resolve(reply('迟到结果')); await tick();
  assert.equal(data.controller.snapshot().revision, revision); assert.equal(data.usage.length, 1);
});

test('hiding preserves conversation history and usage identity for reopening and later questions', async () => {
  const data = fixture();
  data.controller.send({ text: '第一问', quote: '保留的引用' }); await data.controller.settled();
  const completed = data.controller.snapshot(), hidden = data.controller.hide();
  assert.equal(hidden.open, false); assert.equal(hidden.running, false);
  assert.deepEqual(hidden.messages, completed.messages); assert.equal(hidden.error, completed.error);
  assert.ok(hidden.revision > completed.revision);
  assert.deepEqual(data.controller.hide(), hidden, 'Hiding an already hidden sidebar is idempotent');
  const reopened = data.controller.open();
  assert.equal(reopened.open, true); assert.deepEqual(reopened.messages, completed.messages);
  assert.equal(data.requests.length, 1, 'Opening retained history does not send another model request');
  data.controller.send({ text: '第二问' }); await data.controller.settled();
  assert.deepEqual(JSON.parse(data.requests[1].messages[1].content), { question: '第一问', quotedText: '保留的引用' });
  assert.deepEqual(data.requests[1].messages.slice(2).map(message => message.content), ['回答', '第二问']);
  assert.equal(data.usage[0].sessionId, data.usage[1].sessionId);
});

test('hiding during config preflight keeps the request alive and streams to hidden state without reopening it', async () => {
  const selected = deferred(), answer = deferred(); let request, configSignal;
  const data = fixture({ getConfig: ({ signal }) => { configSignal = signal; return selected.promise; },
    requestModel: value => { request = value; return answer.promise; } });
  const sent = data.controller.send({ text: '继续生成' }); await tick();
  const hidden = data.controller.hide(), eventStart = data.events.length;
  assert.equal(hidden.open, false); assert.equal(hidden.running, true); assert.equal(hidden.requestId, sent.requestId);
  assert.equal(configSignal.aborted, false);
  selected.resolve(config); await tick();
  assert.equal(request.signal.aborted, false); assert.equal(data.controller.snapshot().open, false);
  request.onTextDelta('隐藏时的部分回答');
  assert.equal(data.controller.snapshot().messages[1].content, '隐藏时的部分回答');
  assert.throws(() => data.controller.send({ text: '重复问题' }), /等待|停止/u);
  answer.resolve(reply('隐藏时完成的回答')); await data.controller.settled();
  const completed = data.controller.snapshot();
  assert.equal(completed.open, false); assert.equal(completed.running, false);
  assert.equal(completed.messages[1].status, 'completed'); assert.equal(completed.messages[1].content, '隐藏时完成的回答');
  assert.ok(data.events.slice(eventStart).every(event => event.sideChat.open === false));
  assert.equal(data.usage[0].status, 'completed'); assert.equal(data.usage[0].partial, false);
  const reopened = data.controller.open(); assert.equal(reopened.open, true); assert.deepEqual(reopened.messages, completed.messages);
});

test('software disposal still aborts and clears a hidden request while explicit sends can reopen retained history', async () => {
  const held = deferred(); let request;
  const data = fixture();
  data.controller.send({ text: '保留问题' }); await data.controller.settled(); data.controller.hide();
  assert.equal(data.controller.send({ text: '主动发送' }).open, true);
  await data.controller.settled();
  assert.equal(data.usage[0].sessionId, data.usage[1].sessionId);
  const running = fixture({ requestModel: value => { request = value; return held.promise; } });
  running.controller.send({ text: '退出时清除' }); await tick(); running.controller.hide();
  const closed = running.controller.close();
  assert.equal(closed.open, false); assert.equal(closed.running, false); assert.deepEqual(closed.messages, []);
  assert.equal(request.signal.aborted, true); await running.controller.settled();
  request.onTextDelta('迟到的输出'); held.resolve(reply('迟到的结果')); await tick();
  assert.deepEqual(running.controller.snapshot(), closed);
  assert.equal(running.usage[0].status, 'stopped');
});

test('close clears immediately, aborts the old request and cannot be undone by late results or a new conversation', async () => {
  const calls = [];
  const data = fixture({ requestModel: request => { const held = deferred(); calls.push({ request, held }); return held.promise; } });
  const submitted = data.controller.send({ text: '旧问题', quote: '旧引用' }); await tick();
  calls[0].request.onTextDelta('旧部分回答');
  const closed = data.controller.close(); assert.equal(closed.open, false); assert.equal(closed.running, false); assert.deepEqual(closed.messages, []);
  assert.ok(closed.revision > submitted.revision); assert.equal(calls[0].request.signal.aborted, true);
  await data.controller.settled(); data.controller.open();
  data.controller.send({ text: '新问题' }); await tick();
  assert.deepEqual(calls[1].request.messages.slice(1), [{ role: 'user', content: '新问题' }]);
  const revision = data.controller.snapshot().revision;
  calls[0].request.onTextDelta('旧迟到流'); calls[0].held.resolve(reply('旧迟到回答')); await tick();
  assert.equal(data.controller.snapshot().revision, revision); assert.equal(data.controller.snapshot().running, true);
  calls[1].held.resolve(reply('新回答')); await data.controller.settled();
  assert.deepEqual(data.controller.snapshot().messages.map(message => message.content), ['新问题', '新回答']);
  assert.deepEqual(data.usage.map(record => record.status), ['stopped', 'completed']);
  assert.notEqual(data.usage[0].sessionId, data.usage[1].sessionId, 'Reopened side chat needs a fresh private usage session');
});

test('closing during asynchronous config prevents dispatch even when config ignores cancellation', async () => {
  const held = deferred(); let signal;
  const data = fixture({ getConfig: value => { signal = value.signal; return held.promise; } });
  data.controller.send({ text: '问题' }); await tick(); data.controller.close();
  assert.equal(signal.aborted, true); await data.controller.settled();
  held.resolve(config); await tick(); assert.equal(data.requests.length, 0); assert.equal(data.usage.length, 0);
  assert.deepEqual(data.controller.snapshot().messages, []);
});

test('tool calls are rejected without execution, errors are redacted and invalid usage is never invented', async () => {
  const data = fixture({ requestModel: async () => reply('', { message: { content: '执行工具', toolCalls: [{ name: 'run_command', arguments: {} }] } }) });
  data.controller.send({ text: '解释代码' }); await data.controller.settled();
  assert.match(data.controller.snapshot().error, /文字|工具/); assert.equal(data.usage[0].status, 'failed');
  const failing = fixture({ requestModel: async () => { throw new Error('Failure ' + config.apiKey); } });
  failing.controller.send({ text: '再次解释' }); await failing.controller.settled();
  assert.equal(failing.controller.snapshot().error.includes(config.apiKey), false);
  assert.match(failing.controller.snapshot().error, /已隐藏凭据/); assert.equal(failing.usage[0].reported, false);
  assert.equal(failing.usage[0].inputTokens, null); assert.equal(failing.usage[0].outputTokens, null);
});

test('known credentials split between stream chunks do not leak through public state', async () => {
  const held = deferred(); let request;
  const data = fixture({ requestModel: value => { request = value; return held.promise; } });
  data.controller.send({ text: '问题' }); await tick();
  const prefix = config.apiKey.slice(0, 8);
  request.onTextDelta('不要输出 ' + prefix);
  assert.equal(data.controller.snapshot().messages[1].content.includes(prefix), false);
  request.onTextDelta(config.apiKey.slice(8));
  assert.equal(data.controller.snapshot().messages[1].content, '不要输出 [已隐藏凭据]');
  held.resolve(reply('不要输出 ' + config.apiKey)); await data.controller.settled();
  assert.equal(JSON.stringify(data.events).includes(config.apiKey), false);
});

test('timeouts release an uncooperative request and do not fabricate token counts', async () => {
  let request;
  const data = fixture({ timeoutMs: 15, requestModel: value => { request = value; return new Promise(() => {}); } });
  data.controller.send({ text: '等待响应' }); await data.controller.settled();
  assert.equal(request.signal.aborted, true); assert.equal(data.controller.snapshot().running, false);
  assert.match(data.controller.snapshot().error, /超时/); assert.equal(data.usage[0].reported, false);
  assert.equal(data.usage[0].status, 'failed');
});

test('closed state stays clear during usage persistence and observer failures cannot lock it', async () => {
  const saved = deferred(); let saving = false;
  const data = fixture({ onUsage: async () => { saving = true; await saved.promise; }, emit: () => { throw new Error('UI observer failed'); } });
  data.controller.send({ text: '问题' }); await tick(); assert.equal(saving, true);
  const closed = data.controller.close(); saved.resolve(); await data.controller.settled();
  assert.deepEqual(data.controller.snapshot(), closed);
});

test('invalid payloads never dispatch and heavily escaped quotes retain the newest complete question', async () => {
  const data = fixture();
  for (const input of [null, [], { text: '' }, { text: 'x', tools: [] }, { text: '\0' }, { text: 'x', quote: {} }, { text: 'x'.repeat(LIMITS.textChars + 1) }])
    assert.throws(() => data.controller.send(input));
  assert.equal(data.requests.length, 0);
  const text = '\\'.repeat(LIMITS.textChars), quote = '"'.repeat(LIMITS.quoteChars);
  data.controller.send({ text, quote }); await data.controller.settled();
  assert.deepEqual(JSON.parse(data.requests[0].messages[1].content), { question: text, quotedText: quote });
});
