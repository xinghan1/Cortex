import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetDialogController, PET_QUESTION_TOOL, PET_DIALOG_LIMITS as LIMITS, normalizePetChatText } from '../src/core/pet-dialog.mjs';
import { createPetTaskHandoff } from '../src/core/pet-task-intent.mjs';
import { requestModel as providerRequestModel } from '../src/core/providers.mjs';

const config = { provider: 'relay', model: 'pet-model', apiKey: 'pet-private-key', connectionKey: 'profile-a', roleConnectionRevision: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; }); return { promise, resolve, reject }; };
const reply = (content = '今天过得怎么样？', extra = {}) => ({ message: { role: 'assistant', content, toolCalls: [] },
  usageReported: true, usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 5 }, ...extra });
function fixture(extra = {}) {
  const events = [], requests = [], usage = [];
  const controller = createPetDialogController({ getConfig: () => config,
    requestModel: async request => { requests.push(request); return reply(); },
    emit: event => events.push(event), onUsage: async record => usage.push(record), ...extra });
  return { controller, events, requests, usage };
}

test('a decision waits without model requests and accepts a selected option as user input, never permission approval', async () => {
  const f = fixture(), signal = new AbortController();
  const pending = f.controller.ask({ question: '使用哪个文件名？', options: ['alpha.txt', 'beta.txt'] }, { signal: signal.signal, runId: 'run-a', sessionId: 'main-a' });
  let resolved = false; pending.then(() => { resolved = true; });
  await tick(); assert.equal(resolved, false); assert.equal(f.requests.length, 0); assert.equal(f.usage.length, 0);
  const state = f.controller.snapshot(), id = state.question.id;
  assert.equal(state.question.blocking, true); assert.equal(state.question.kind, 'decision'); assert.equal(state.running, false);
  state.question.options[0] = 'mutated'; assert.equal(f.controller.snapshot().question.options[0], 'alpha.txt');
  f.controller.answer({ id, choiceIndex: 1 });
  assert.deepEqual(await pending, { questionId: id, answer: 'beta.txt', choiceIndex: 1, source: 'user' });
  assert.equal(f.controller.snapshot().question, null);
  assert.equal(PET_QUESTION_TOOL.name, 'ask_user_question'); assert.equal(PET_QUESTION_TOOL.parameters.additionalProperties, false);
});

test('custom answers and explicit question cancellation remain distinct from answers, task cancellation and approvals', async () => {
  const f = fixture();
  const first = f.controller.ask({ question: '说明具体要求。' });
  const old = f.controller.snapshot().question.id;
  f.controller.answer({ id: old, text: ' 自定义回答 ' });
  assert.deepEqual(await first, { questionId: old, answer: '自定义回答', source: 'user' });
  const second = f.controller.ask({ question: '继续选择？', options: ['继续'] });
  const current = f.controller.snapshot().question.id;
  assert.throws(() => f.controller.answer({ id: old, text: '旧回答' }), /已结束/);
  assert.equal(f.controller.snapshot().question.id, current);
  f.controller.dismiss({ id: current });
  assert.deepEqual(await second, { questionId: current, cancelled: true, source: 'user' });
  assert.equal(f.controller.snapshot().question, null); assert.equal(f.usage.length, 0);
});

test('answered task questions emit one redacted activity receipt with the exact question, answer and captured task scope', async () => {
  const f = fixture({ redact: value => value.replaceAll('PRIVATE', '[hidden]') });
  const selected = f.controller.ask({ question: '如何处理 PRIVATE？', options: ['保留 PRIVATE', '调整'] }, { runId: 'run-one', sessionId: 'session-one' });
  const selectedId = f.controller.snapshot().question.id; f.controller.answer({ id: selectedId, choiceIndex: 0 }); await selected;
  const custom = f.controller.ask({ question: '另一项具体要求？' }, { runId: 'run-two', sessionId: 'session-two' });
  const customId = f.controller.snapshot().question.id;
  assert.throws(() => f.controller.answer({ id: selectedId, text: '迟到回答' }), /已结束/);
  f.controller.answer({ id: customId, text: ' 使用 PRIVATE 的自定义方案 ' }); await custom;
  assert.deepEqual(f.events.filter(event => event.type === 'question-answer'), [
    { type: 'question-answer', questionId: selectedId, question: '如何处理 [hidden]？', options: ['保留 [hidden]', '调整'], answer: '保留 [hidden]', choiceIndex: 0, source: 'user', runId: 'run-one', sessionId: 'session-one' },
    { type: 'question-answer', questionId: customId, question: '另一项具体要求？', options: [], answer: '使用 [hidden] 的自定义方案', source: 'user', runId: 'run-two', sessionId: 'session-two' },
  ]);
  assert.deepEqual(f.controller.snapshot().messages, []); assert.equal(f.requests.length, 0); assert.equal(f.usage.length, 0);
});

test('cancelled, stopped, unscoped and casual pet questions do not produce main-task answer receipts', async () => {
  const f = fixture();
  const cancelled = f.controller.ask({ question: '可取消的问题' }, { runId: 'run', sessionId: 'session' }); f.controller.dismiss({ id: f.controller.snapshot().question.id }); await cancelled;
  const stopped = f.controller.ask({ question: '任务停止' }, { runId: 'run', sessionId: 'session' }); const rejected = assert.rejects(stopped, { name: 'AbortError' }); f.controller.stop(); await rejected;
  const unscoped = f.controller.ask({ question: '未绑定任务' }); f.controller.answer({ id: f.controller.snapshot().question.id, text: '回答' }); await unscoped;
  f.controller.greet({ runId: 'run', sessionId: 'session' }); await f.controller.settled(); f.controller.answer({ id: f.controller.snapshot().question.id, text: '仅宠物闲聊' }); await f.controller.settled();
  assert.deepEqual(f.events.filter(event => event.type === 'question-answer'), []);
});

test('stopping or changing sessions rejects the pending decision without inventing a choice', async () => {
  for (const action of ['parent', 'stop', 'close']) {
    const f = fixture(), parent = new AbortController();
    const result = f.controller.ask({ question: '等待真实用户回答。', options: ['一', '二'] }, { signal: parent.signal });
    const rejected = assert.rejects(result, { name: 'AbortError' });
    if (action === 'parent') parent.abort(); else f.controller[action]();
    await rejected; await f.controller.settled();
    assert.equal(f.controller.snapshot().question, null); assert.equal(f.requests.length, 0);
  }
  const f = fixture(), parent = new AbortController(); parent.abort();
  assert.throws(() => f.controller.ask({ question: '不可发出' }, { signal: parent.signal }), { name: 'AbortError' });
  assert.equal(f.controller.snapshot().question, null);
});

test('invalid and stale decisions preserve the active question and cannot become accidental choices', async () => {
  const f = fixture(), pending = f.controller.ask({ question: '保留原问题', options: ['一'] });
  const id = f.controller.snapshot().question.id;
  for (const input of [{ id, text: '' }, { id, text: 'x'.repeat(LIMITS.textChars + 1) }, { id, choiceIndex: -1 },
    { id, choiceIndex: 1 }, { id, choiceIndex: 0, text: 'both' }, { id }, { id, choiceIndex: 0, allow: true }]) {
    assert.throws(() => f.controller.answer(input)); assert.equal(f.controller.snapshot().question.id, id);
  }
  assert.throws(() => f.controller.ask({ question: '覆盖旧问题' }), /等待/);
  assert.throws(() => f.controller.send({ text: '闲聊不能覆盖决策' }), /完成/);
  assert.equal(f.controller.greet().question.id, id); assert.equal(f.requests.length, 0);
  f.controller.dismiss({ id }); await pending;
  for (const args of [{ question: '' }, { question: 'x'.repeat(LIMITS.textChars + 1) }, { question: 'a', options: Array(9).fill('x') },
    { question: 'a', options: ['x'.repeat(161)] }, { question: 'a', options: [4] }, { question: 'a', command: 'execute' }])
    assert.throws(() => f.controller.ask(args), /无效/);
});

test('a greeting is an optional independent text-only request; answering stays in temporary pet chat', async () => {
  const f = fixture(), parent = new AbortController();
  const started = f.controller.greet({ signal: parent.signal, runId: 'run-a', sessionId: 'main-a' });
  assert.equal(started.running, true); assert.equal(started.question, null); assert.equal(f.requests.length, 0);
  await f.controller.settled();
  const state = f.controller.snapshot(); assert.equal(state.running, false); assert.equal(state.question.kind, 'casual');
  assert.equal(state.question.blocking, false); assert.deepEqual(state.question.options, []);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].tools, []);
  assert.match(f.requests[0].messages[0].content, /没有文件、命令、网页或审批工具/);
  assert.equal(f.usage[0].purpose, 'pet-chat'); assert.equal(f.usage[0].runId, 'run-a'); assert.equal(f.usage[0].sessionId, 'main-a');
  assert.equal(f.usage[0].inputTokens, 20); assert.equal(f.usage[0].cachedInputTokens, 5);
  f.controller.answer({ id: state.question.id, text: '挺好的' }); await f.controller.settled();
  assert.equal(f.controller.snapshot().question.blocking, false); assert.equal(parent.signal.aborted, false);
  assert.notEqual(f.controller.snapshot().question.id, state.question.id, 'A finished reply remains visible and accepts the next temporary chat answer');
  assert.equal(f.requests[1].messages.at(-1).content, '挺好的');
  assert.equal(f.usage[1].sessionId, f.usage[0].sessionId, 'A casual answer retains the greeting session lineage');
  assert.notEqual(f.usage[1].runId, f.usage[0].runId, 'Casual turns use independent request runs');
  assert.equal(f.controller.snapshot().messages.some(message => message.content === '挺好的'), true);
  assert.ok(f.events.every(event => event.type === 'pet-dialog' && event.petDialog.revision > 0));
  assert.equal(new Set(f.events.map(event => event.petDialog.revision)).size, f.events.length);
});

test('the Big Fat Fish persona is applied only to explicitly requested casual calls, with a brief default and clear task boundaries', async () => {
  const f = fixture();
  await tick(); assert.equal(f.requests.length, 0); assert.equal(f.usage.length, 0);
  assert.deepEqual(f.controller.snapshot().messages, [], 'Startup welcome and action lines are local UI, not model calls');
  f.controller.greet(); await f.controller.settled();
  const system = f.requests[0].messages[0].content, greeting = f.requests[0].messages.at(-1).content;
  assert.match(system, /大肥鱼/); assert.match(system, /默认用中文/); assert.match(system, /俏皮.*不油腻/);
  assert.match(system, /120.*5–10秒/s); assert.match(system, /不为字数截断实质回答/);
  assert.match(system, /不能执行操作或代表用户给主任务授权/); assert.match(system, /不要暗示了解用户的项目/);
  assert.match(greeting, /大肥鱼/); assert.match(greeting, /不要重复启动欢迎语/);
  assert.match(greeting, /不要询问主任务决策、授权或进度/);
  assert.deepEqual(f.requests[0].tools, []); assert.equal(f.usage.length, 1);
});

test('the short bubble persona does not truncate a substantive answer to the suggested 120-character default', async () => {
  const answer = '这是用户要求的具体解释，需要保留完整的操作条件和注意事项。'.repeat(12);
  assert.ok(answer.length > 120);
  const f = fixture({ requestModel: async () => reply(answer) });
  f.controller.send({ text: '请详细说明这个概念，保留必要的内容。' }); await f.controller.settled();
  assert.equal(f.controller.snapshot().messages.at(-1).content, answer);
  assert.equal(f.controller.snapshot().question.question, answer); assert.equal(f.usage[0].status, 'completed');
});

test('dismissing a casual greeting makes no choice, extra request, or main-task mutation', async () => {
  const f = fixture(); f.controller.greet(); await f.controller.settled();
  const id = f.controller.snapshot().question.id, messages = f.controller.snapshot().messages;
  f.controller.dismiss({ id }); assert.equal(f.controller.snapshot().question, null);
  assert.deepEqual(f.controller.snapshot().messages, messages); assert.equal(f.requests.length, 1);
  assert.throws(() => f.controller.answer({ id, text: '迟到' }), /已结束/);
});

test('a blocking decision preempts a casual request and cannot be cleared or resurrected by its late model result', async () => {
  const held = deferred(); let request;
  const f = fixture({ requestModel: value => { request = value; return held.promise; } });
  f.controller.greet(); await tick(); request.onTextDelta('部分问候');
  const blocking = f.controller.ask({ question: '真实决策', options: ['保留', '调整'] });
  const id = f.controller.snapshot().question.id;
  assert.equal(request.signal.aborted, true); assert.equal(f.controller.snapshot().question.blocking, true);
  const revision = f.controller.snapshot().revision;
  request.onTextDelta('迟到文本'); held.resolve(reply('迟到问候')); await tick();
  assert.equal(f.controller.snapshot().question.id, id); assert.equal(f.controller.snapshot().revision, revision);
  f.controller.answer({ id, text: '自定义决定' }); assert.equal((await blocking).answer, '自定义决定');
  await f.controller.settled(); assert.equal(f.usage[0].status, 'stopped');
});

test('casual streaming redacts split credentials and never exposes signed provider state or executes returned tools', async () => {
  const held = deferred(); let request;
  const f = fixture({ requestModel: value => { request = value; return held.promise; } });
  f.controller.send({ text: '问候' }); await tick();
  request.onTextDelta('key:pet-private-'); request.onTextDelta('key');
  assert.doesNotMatch(JSON.stringify(f.events), /pet-private-|pet-private-key/);
  held.resolve(reply('key:' + config.apiKey, { message: { content: 'key:' + config.apiKey, toolCalls: [],
    providerState: { signature: 'PRIVATE_SIGNATURE' } } }));
  await f.controller.settled(); assert.doesNotMatch(JSON.stringify(f.events), /pet-private-key|PRIVATE_SIGNATURE|providerState/);
  assert.match(f.controller.snapshot().messages.at(-1).content, /已隐藏凭据/);
  const tools = fixture({ requestModel: async () => reply('执行', { message: { content: '执行', toolCalls: [{ name: 'run_command' }] } }) });
  tools.controller.send({ text: '解释' }); await tools.controller.settled();
  assert.match(tools.controller.snapshot().error, /文字|工具/); assert.equal(tools.usage[0].status, 'failed');
});

test('close or parent cancellation interrupts ignored aborts, settles one partial ledger record and rejects late changes', async () => {
  for (const action of ['close', 'parent']) {
    const held = deferred(), parent = new AbortController(); let request;
    const f = fixture({ requestModel: value => { request = value; return held.promise; } });
    f.controller.send({ text: '等待' }, { signal: parent.signal }); await tick();
    request.onProgress({ usage: { inputTokens: 8, outputTokens: 2 } }); request.onTextDelta('部分');
    if (action === 'close') f.controller.close(); else parent.abort();
    await f.controller.settled(); const finished = f.controller.snapshot();
    assert.equal(request.signal.aborted, true); assert.equal(f.usage.length, 1);
    assert.equal(f.usage[0].purpose, 'pet-chat'); assert.equal(f.usage[0].status, 'stopped');
    assert.equal(f.usage[0].reported, true); assert.equal(f.usage[0].inputTokens, 8); assert.equal(f.usage[0].partial, true);
    request.onTextDelta('迟到'); held.resolve(reply('迟到结果')); await tick();
    assert.deepEqual(f.controller.snapshot(), finished); assert.equal(f.usage.length, 1);
    if (action === 'close') assert.deepEqual(finished.messages, []);
  }
});

test('model and account generation changes before dispatch or before final display reject stale requests', async () => {
  let current = config, reads = 0;
  const before = fixture({ getConfig: () => ++reads === 1 ? config : { ...config, connectionKey: 'profile-b' } });
  before.controller.send({ text: '旧账号' }); await before.controller.settled();
  assert.equal(before.requests.length, 0); assert.equal(before.usage.length, 0);
  const held = deferred(); let request;
  const after = fixture({ getConfig: () => current, requestModel: value => { request = value; return held.promise; } });
  after.controller.send({ text: '原问题' }); await tick(); request.onTextDelta('旧账号部分');
  current = { ...config, deepseekProfileId: 'new-profile', roleConnectionRevision: 2 };
  held.resolve(reply('旧账号回复')); await after.controller.settled();
  assert.deepEqual(after.controller.snapshot().messages, []); assert.equal(after.usage[0].status, 'stopped');
  assert.equal(after.usage[0].model, config.model);
});

test('a synchronous generation guard cancels a changed-account stream before exposing its next chunk', async () => {
  const held = deferred(); let request, current = true;
  const f = fixture({ isConfigCurrent: () => current, requestModel: value => { request = value; return held.promise; } });
  f.controller.send({ text: '问题' }); await tick(); request.onTextDelta('第一段'); current = false;
  request.onTextDelta('NEW_ACCOUNT_PRIVATE_TEXT'); await f.controller.settled();
  assert.equal(request.signal.aborted, true); assert.deepEqual(f.controller.snapshot().messages, []);
  assert.doesNotMatch(JSON.stringify(f.events), /NEW_ACCOUNT_PRIVATE_TEXT/);
});

test('close during config preflight prevents dispatch and a casual timeout cannot synthesize a blocking answer', async () => {
  const held = deferred();
  const f = fixture({ getConfig: () => held.promise });
  f.controller.send({ text: '等待配置' }); await tick(); f.controller.close(); await f.controller.settled();
  held.resolve(config); await tick(); assert.equal(f.requests.length, 0); assert.equal(f.usage.length, 0);
  const timeout = fixture({ timeoutMs: 5, requestModel: () => new Promise(() => {}) });
  timeout.controller.send({ text: '闲聊' }); await timeout.controller.settled();
  assert.match(timeout.controller.snapshot().error, /超时/); assert.equal(timeout.usage[0].status, 'failed');
  assert.equal(timeout.controller.snapshot().question.blocking, false, 'The local error bubble stays dismissible rather than disappearing');
  const parent = new AbortController(), decision = timeout.controller.ask({ question: '没有回答之前一直等待' }, { signal: parent.signal });
  const rejected = assert.rejects(decision, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(timeout.controller.snapshot().question.blocking, true);
  parent.abort(); await rejected;
});

test('completed and stopped history is bound to one model/account owner and never crosses into a changed connection request', async () => {
  for (const patch of [{ connectionKey: 'profile-b' }, { model: 'other-model' }, { apiKey: 'another-private-key' },
    { authMode: 'chatgpt', chatgptProfileId: 'chatgpt-b' }, { deepseekProfileId: 'deepseek-b' },
    { roleConnectionRevision: 2 }, { petSessionId: 'another-main-session' }, { petConfigRevision: 2 }]) {
    let current = config;
    const f = fixture({ getConfig: () => current });
    f.controller.send({ text: 'ACCOUNT_A_PRIVATE_QUESTION' }); await f.controller.settled();
    assert.equal(f.requests.length, 1); assert.ok(f.controller.snapshot().messages.length > 0);
    current = { ...config, ...patch };
    f.controller.send({ text: '新问题' }); await f.controller.settled();
    assert.equal(f.requests.length, 1, 'The first changed-account continuation is rejected before dispatch');
    assert.deepEqual(f.controller.snapshot().messages, []); assert.match(f.controller.snapshot().error, /已清除/);
    f.controller.send({ text: '用户重新输入的 B 问题' }); await f.controller.settled();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[1].messages.slice(1).map(message => message.content), ['用户重新输入的 B 问题']);
    assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /ACCOUNT_A_PRIVATE_QUESTION/);
    assert.notEqual(f.usage[0].sessionId, f.usage[1].sessionId);
  }
});

test('a cancelled partial history cannot be replayed by a new account even when the transport ignores abort', async () => {
  let current = config, request;
  const held = deferred(), f = fixture({ getConfig: () => current,
    requestModel: value => { f.requests.push(value); request = value; return f.requests.length === 1 ? held.promise : reply(); } });
  f.controller.send({ text: 'ACCOUNT_A_USER_TEXT' }); await tick();
  request.onTextDelta('ACCOUNT_A_PARTIAL_TEXT'); f.controller.stop(); await f.controller.settled();
  current = { ...config, connectionKey: 'profile-b' };
  f.controller.send({ text: 'B first' }); await f.controller.settled();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.controller.snapshot().messages, []);
  held.resolve(reply('LATE_ACCOUNT_A_TEXT')); await tick();
  f.controller.send({ text: 'B retry' }); await f.controller.settled();
  assert.equal(f.requests.length, 2); assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /ACCOUNT_A/);
});

test('only three explicit actions request a short pure-text model reaction without adding artificial prompts or responses to chat history', async () => {
  for (const [index, kind] of ['clicks', 'turn', 'actions'].entries()) {
    const f = fixture({ requestModel: async request => { f.requests.push(request); return reply('嘿，**大肥鱼**收到啦！'); } });
    const state = f.controller.react({ kind, sequence: index + 1 }, { sessionId: 'main-session' });
    assert.equal(state.running, true); assert.equal(state.activity, 'reaction');
    await f.controller.settled();
    assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].tools, []);
    assert.equal(f.requests[0].messages.length, 2); assert.equal(f.requests[0].timeoutMs, 8000);
    assert.match(f.requests[0].messages[1].content, /只用自然的纯文本/);
    assert.match(f.requests[0].messages[1].content, /不执行任何操作/);
    const done = f.controller.snapshot();
    assert.deepEqual(done.messages, []); assert.equal(done.running, false); assert.equal(done.activity, null);
    assert.equal(done.question.kind, 'reaction'); assert.equal(done.question.reactionKind, kind);
    assert.equal(done.question.actionSequence, index + 1); assert.equal(done.question.fallback, false);
    assert.equal(done.question.question, '嘿，大肥鱼收到啦！');
    assert.equal(f.usage[0].purpose, 'pet-reaction'); assert.equal(f.usage[0].sessionId, 'main-session');
    assert.match(f.usage[0].runId, /^[a-f\d-]{36}$/iu);
  }
  const f = fixture();
  for (const args of [{ kind: 'idle', sequence: 1 }, { kind: 'working', sequence: 1 }, { kind: 'clicks', sequence: 0 },
    { kind: 'clicks', sequence: 1.5 }, { kind: 'turn', sequence: 1, text: 'arbitrary prompt' }]) assert.throws(() => f.controller.react(args), /动作无效/);
  assert.equal(f.requests.length, 0);
});

test('reaction failures and short timeouts use only fixed backend fallback lines while unknown usage stays unknown', async () => {
  for (const failure of ['config', 'http', 'empty', 'tools', 'timeout']) {
    const f = fixture({ reactionTimeoutMs: 5,
      getConfig: () => { if (failure === 'config') throw new Error('No configured model'); return config; },
      requestModel: async request => {
        f.requests.push(request);
        if (failure === 'http') throw new Error('HTTP rejected: ' + config.apiKey);
        if (failure === 'timeout') { request.onProgress({ usage: { inputTokens: 7, outputTokens: 1 } }); return new Promise(() => {}); }
        return reply(failure === 'empty' ? '' : 'unsafe', { message: { content: failure === 'empty' ? '' : 'unsafe',
          toolCalls: failure === 'tools' ? [{ name: 'run_command' }] : [] }, usageReported: false });
      } });
    f.controller.react({ kind: 'clicks', sequence: 1 }); await f.controller.settled();
    const state = f.controller.snapshot();
    assert.equal(state.question.question, '嘿嘿，摸摸头，干活更有劲啦！'); assert.equal(state.question.fallback, true);
    assert.equal(state.question.kind, 'reaction'); assert.equal(state.error, null); assert.deepEqual(state.messages, []);
    assert.doesNotMatch(JSON.stringify(f.events), /pet-private-key|HTTP rejected/);
    if (failure === 'config') assert.equal(f.usage.length, 0);
    else {
      assert.equal(f.usage[0].purpose, 'pet-reaction'); assert.equal(f.usage[0].status, 'failed'); assert.equal(f.usage[0].partial, true);
      assert.equal(f.usage[0].reported, failure === 'timeout');
      assert.equal(f.usage[0].inputTokens, failure === 'timeout' ? 7 : null);
    }
  }
});

test('only animation reactions lower reasoning effort, preserving the pet model, credentials and ordinary chat/task preferences', async () => {
  const cases = [
    [{ provider: 'deepseek' }, 'none'],
    [{ provider: 'deepseek', authMode: 'deepseek-account' }, 'none'],
    [{ provider: 'deepseek', modelCapabilities: { reasoningEfforts: ['high', 'max'] } }, 'default'],
    [{ provider: 'openai', modelCapabilities: { reasoningEfforts: ['none', 'high'] } }, 'none'],
    [{ provider: 'openai', modelCapabilities: { reasoningEfforts: ['low', 'high', 'max'] } }, 'default'],
    [{ provider: 'relay', modelCapabilities: { reasoningEfforts: ['none', 'max'] } }, 'none'],
    [{ provider: 'relay' }, 'default'],
    [{ provider: 'anthropic' }, 'default'],
    [{ provider: 'ollama', modelCapabilities: { reasoningEfforts: ['none'], ollamaThinkingValues: [false] } }, 'none'],
    [{ provider: 'ollama', modelCapabilities: { reasoningEfforts: ['none'] } }, 'default'],
  ];
  for (const [patch, effort] of cases) {
    const selected = { ...config, ...patch, reasoningEffort: 'max', modelRole: 'pet', roleConnectionRevision: 7 };
    const f = fixture({ getConfig: () => selected });
    f.controller.react({ kind: 'clicks', sequence: 1 }); await f.controller.settled();
    assert.equal(f.requests[0].reasoningEffort, effort); assert.equal(f.requests[0].model, selected.model);
    assert.equal(f.requests[0].apiKey, selected.apiKey); assert.equal(f.requests[0].modelRole, 'pet');
    assert.equal(f.requests[0].roleConnectionRevision, 7); assert.equal(f.requests[0].maxOutputTokens, 256);
    assert.equal(f.requests[0].timeoutMs, 8000); assert.equal(selected.reasoningEffort, 'max');
    f.controller.send({ text: '你好，大肥鱼。' }); await f.controller.settled();
    assert.equal(f.requests[1].reasoningEffort, 'max');
    const task = fixture({ getConfig: () => selected,
      requestModel: async request => { task.requests.push(request); return reply('{"prompt":"制作本地待办应用。"}'); },
      onTask: async () => ({ disposition: 'queued' }) });
    task.controller.send({ text: '帮我制作一个待办应用。' }); await task.controller.settled();
    assert.equal(task.requests[0].reasoningEffort, 'max');
  }
});

test('DeepSeek API and account virtual transports send reaction thinking disabled within the existing short output budget', async () => {
  for (const authMode of ['apiKey', 'deepseek-account']) {
    const calls = [], selected = { ...config, provider: 'deepseek', authMode, model: 'deepseek-flash',
      reasoningEffort: 'max', modelRole: 'pet', modelCapabilities: { reasoningEfforts: ['none', 'low', 'high', 'max'] } };
    const f = fixture({ getConfig: () => selected, requestModel: request => providerRequestModel({ ...request,
      fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return Response.json(authMode === 'deepseek-account'
          ? { id: 'pet', type: 'message', role: 'assistant', model: selected.model,
            content: [{ type: 'text', text: '嘿，收到摸摸啦！' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 4 } }
          : { choices: [{ message: { role: 'assistant', content: '嘿，收到摸摸啦！' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 4 } });
      } }) });
    f.controller.react({ kind: 'clicks', sequence: 1 }); await f.controller.settled();
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
    assert.equal(calls[0].body.max_tokens, 256); assert.equal(Object.hasOwn(calls[0].body, 'output_config'), false);
    assert.equal(Object.hasOwn(calls[0].body, 'reasoning_effort'), false);
    assert.equal(f.controller.snapshot().question.fallback, false); assert.equal(f.usage[0].status, 'completed');
    assert.equal(selected.reasoningEffort, 'max');
    if (authMode === 'deepseek-account') assert.equal(calls[0].options.headers['x-dsh-auth-token'], selected.apiKey);
  }
});

test('duplicate sequences, dense clicks, active chat and blocking questions cannot queue unlimited reaction requests', async () => {
  let now = 0; const held = deferred();
  const f = fixture({ clock: () => now, requestModel: request => { f.requests.push(request); return held.promise; } });
  f.controller.react({ kind: 'clicks', sequence: 1 }); await tick();
  for (let sequence = 1; sequence < 100; sequence++) f.controller.react({ kind: 'turn', sequence });
  assert.equal(f.requests.length, 1);
  held.resolve(reply()); await f.controller.settled();
  f.controller.react({ kind: 'actions', sequence: 100 }); await tick(); assert.equal(f.requests.length, 1);
  now = 2000; f.controller.react({ kind: 'actions', sequence: 101 }); await f.controller.settled(); assert.equal(f.requests.length, 2);
  f.controller.react({ kind: 'actions', sequence: 101 }); await tick(); assert.equal(f.requests.length, 2);
  const chatHeld = deferred(), chat = fixture({ requestModel: request => { chat.requests.push(request); return chatHeld.promise; } });
  chat.controller.send({ text: '真实聊天优先' }); await tick(); chat.controller.react({ kind: 'clicks', sequence: 1 });
  assert.equal(chat.requests.length, 1); assert.equal(chat.controller.snapshot().activity, 'chat');
  chatHeld.resolve(reply()); await chat.controller.settled();
  const question = chat.controller.ask({ question: '真实决策优先' });
  chat.controller.react({ kind: 'turn', sequence: 2 }); assert.equal(chat.controller.snapshot().question.blocking, true);
  chat.controller.dismiss({ id: chat.controller.snapshot().question.id }); await question;
});

test('user chat preempts a reaction, with no late fallback or action prompt in later user conversation', async () => {
  const held = deferred(); let actionRequest;
  const f = fixture({ requestModel: request => {
    f.requests.push(request);
    if (f.requests.length === 1) { actionRequest = request; return held.promise; }
    return reply('回答真正的问题。');
  } });
  f.controller.react({ kind: 'actions', sequence: 1 }); await tick();
  actionRequest.onProgress({ usage: { inputTokens: 9, outputTokens: 2 } });
  const accepted = f.controller.send({ text: '99 + 11 等于多少？' }); assert.equal(accepted.activity, 'chat');
  await f.controller.settled(); const final = f.controller.snapshot();
  assert.equal(actionRequest.signal.aborted, true); assert.equal(final.question.kind, 'casual');
  assert.deepEqual(f.requests[1].messages.slice(1).map(message => message.content), ['99 + 11 等于多少？']);
  assert.deepEqual(final.messages.map(message => message.content), ['99 + 11 等于多少？', '回答真正的问题。']);
  assert.equal(f.usage.find(record => record.purpose === 'pet-reaction').status, 'stopped');
  const revision = final.revision; held.resolve(reply('不应复活的动作回复')); await tick();
  assert.equal(f.controller.snapshot().revision, revision); assert.equal(f.usage.length, 2);
});

test('stop, close, parent or preflight abort, and model/account changes never revive a reaction or fallback', async () => {
  for (const action of ['stop', 'close', 'parent', 'config', 'account', 'preflight']) {
    let current = config, request; const held = deferred(), parent = new AbortController();
    const f = fixture({ getConfig: () => {
      if (action === 'preflight') throw new DOMException('Session changed', 'AbortError');
      return current;
    }, requestModel: value => { request = value; return held.promise; } });
    f.controller.react({ kind: 'turn', sequence: 1 }, { signal: parent.signal }); await tick();
    if (action === 'config' || action === 'account') { current = { ...config, ...(action === 'config' ? { roleConnectionRevision: 2 } : { connectionKey: 'account-b' }) }; held.resolve(reply()); }
    else if (action === 'parent') parent.abort(new Error('Externally stopped'));
    else if (action !== 'preflight') f.controller[action]();
    await f.controller.settled(); const state = f.controller.snapshot();
    assert.equal(state.question, null); assert.deepEqual(state.messages, []);
    if (request) { request.onTextDelta('迟到动作'); held.resolve(reply('迟到响应')); await tick(); assert.deepEqual(f.controller.snapshot(), state); }
  }
});

test('reaction request and result never borrow or pollute existing completed chat history', async () => {
  let now = 0;
  const f = fixture({ clock: () => now, requestModel: async request => { f.requests.push(request); return reply(f.requests.length === 2 ? 'ACTION_REPLY' : 'CHAT_REPLY'); } });
  f.controller.send({ text: 'PRIVATE_USER_CHAT' }); await f.controller.settled();
  const oldMessages = f.controller.snapshot().messages;
  f.controller.react({ kind: 'clicks', sequence: 1 }); await f.controller.settled();
  assert.deepEqual(f.controller.snapshot().messages, oldMessages);
  assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /PRIVATE_USER_CHAT|CHAT_REPLY/);
  f.controller.send({ text: 'NEXT_CHAT' }); await f.controller.settled();
  assert.deepEqual(f.requests[2].messages.slice(1).map(message => message.content), ['PRIVATE_USER_CHAT', 'CHAT_REPLY', 'NEXT_CHAT']);
  assert.doesNotMatch(JSON.stringify(f.requests[2].messages), /ACTION_REPLY|摸了摸大肥鱼/);
});

test('paired model Markdown becomes plain prose while arithmetic operators, literal stars and original user input remain intact', async () => {
  assert.equal(normalizePetChatText('99 + 11 = **110**'), '99 + 11 = 110');
  assert.equal(normalizePetChatText('**加粗**，__强调__，`code_span`，*轻声*。'), '加粗，强调，code_span，轻声。');
  assert.equal(normalizePetChatText('2 * 3 = 6；2**3**4；x_y；__init__；未闭合 **符号'), '2 * 3 = 6；2**3**4；x_y；__init__；未闭合 **符号');
  assert.equal(normalizePetChatText('# 小标题\n- 你好\n1. 再见\n```js\nconst x = 2 * 3;\n```'), '小标题\n你好\n再见\nconst x = 2 * 3;');
  assert.equal(normalizePetChatText('`a**b**c` 和 `__init__` 保留含义，**强调**改为文字。'), 'a**b**c 和 __init__ 保留含义，强调改为文字。');
  assert.equal(normalizePetChatText('```python\nx = a**b**c\n```'), 'x = a**b**c');
  const rawUser = '请计算 99 + 11，并保留我输入的 **星号**。';
  const f = fixture({ requestModel: async request => { f.requests.push(request); return reply('99 + 11 = **110**'); } });
  f.controller.send({ text: rawUser }); await f.controller.settled();
  assert.equal(f.requests[0].messages.at(-1).content, rawUser);
  assert.equal(f.controller.snapshot().messages[0].content, rawUser);
  assert.equal(f.controller.snapshot().question.question, '99 + 11 = 110');
});

test('an explicit creation request uses one private refinement request and acknowledges only a real main-queue handoff', async () => {
  const original = '帮我制作一个**本地记账程序**，不要上传数据。', delivered = deferred(), transfers = [];
  const f = fixture({ getConfig: () => ({ ...config, petSessionId: 'main-session' }),
    requestModel: async request => {
      f.requests.push(request); request.onTextDelta('{"prompt":"INTERNAL_POLISHED_TASK"');
      return reply(JSON.stringify({ prompt: '制作本地记账程序，不上传数据。', reply: '已开发完成并发布。' }));
    }, onTask: value => { transfers.push(value); return delivered.promise; } });
  f.controller.send({ text: original }, { sessionId: 'main-session' }); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].tools, []);
  assert.match(f.requests[0].messages[0].content, /只输出严格 JSON/);
  assert.equal(f.requests[0].messages.at(-1).content, original);
  assert.equal(transfers.length, 1); assert.equal(transfers[0].originalText, original);
  assert.equal(transfers[0].prompt, '制作本地记账程序，不上传数据。');
  assert.equal(transfers[0].sessionId, 'main-session'); assert.equal(transfers[0].signal.aborted, false);
  assert.equal(f.controller.snapshot().question, null, 'No success receipt is published while main queueing is unresolved');
  assert.doesNotMatch(JSON.stringify(f.events), /INTERNAL_POLISHED_TASK|已开发完成并发布/);
  delivered.resolve({ disposition: 'queued' }); await f.controller.settled();
  assert.match(f.controller.snapshot().question.question, /正在排队/);
  assert.deepEqual(f.controller.snapshot().messages.map(message => message.content), [original, '已把整理后的需求交给主会话，正在排队。']);
  assert.equal(f.usage[0].purpose, 'pet-chat'); assert.equal(f.usage[0].id, transfers[0].requestId);
  assert.equal(f.usage.length, 1, 'Refinement reuses one request instead of adding a second classification/model call');
});

test('an accepted handoff can asynchronously close and fork the saved session without misbilling a complete model response', async () => {
  let current = { ...config, petSessionId: 'session-before-fork' }, reads = 0, transfers = 0;
  const f = fixture({ getConfig: () => { reads++; return current; },
    isConfigCurrent: selected => selected.petSessionId === current.petSessionId,
    requestModel: async () => reply('{"prompt":"制作一个本地待办应用。"}'),
    onTask: async () => {
      transfers++; current = { ...current, petSessionId: 'accepted-fork' };
      // The real startTask closes the pet dialog before awaiting its fork.
      f.controller.close(); await tick(); return { disposition: 'started' };
    } });
  f.controller.send({ text: '帮我制作一个待办应用。' }); await f.controller.settled();
  assert.equal(reads, 3); assert.equal(transfers, 1); assert.equal(f.usage[0].status, 'completed');
  assert.equal(f.usage[0].partial, false); assert.equal(f.usage[0].inputTokens, 20); assert.equal(f.usage[0].outputTokens, 4);
  assert.equal(f.controller.snapshot().question, null); assert.deepEqual(f.controller.snapshot().messages, []);
  assert.doesNotMatch(JSON.stringify(f.events), /已把整理后的需求发送到主会话/);
});

test('stopping before the controlled queue accepts a refined task still cancels validation and never sends late', async () => {
  for (const action of ['stop', 'close']) {
    const held = deferred(); let queueAttempts = 0, accepted = 0;
    const handoff = createPetTaskHandoff({ validate: () => {}, submit: async (_arg, options) => {
      queueAttempts++; await held.promise; options.validate(); accepted++; return { disposition: 'queued' };
    } });
    const f = fixture({ requestModel: async () => reply('{"prompt":"制作一个本地待办应用。"}'), onTask: handoff });
    f.controller.send({ text: '帮我制作一个待办应用。' }); await tick(); assert.equal(queueAttempts, 1);
    f.controller[action](); const cancelled = f.controller.snapshot(); assert.equal(cancelled.running, false);
    held.resolve(); await f.controller.settled();
    assert.equal(accepted, 0); assert.deepEqual(f.controller.snapshot(), cancelled);
    assert.equal(f.usage.length, 1); assert.equal(f.usage[0].status, 'stopped'); assert.equal(f.usage[0].partial, true);
    assert.doesNotMatch(JSON.stringify(f.events), /已把整理后的需求/);
  }
});

test('a closed accepted handoff cannot publish a receipt or erase a newer chat error after its callback settles', async () => {
  const delivered = deferred(); let requestCount = 0;
  const f = fixture({ requestModel: async () => {
    if (++requestCount === 1) return reply('{"prompt":"制作一个本地待办应用。"}');
    throw new Error('新的聊天请求失败。');
  }, onTask: async () => { f.controller.close(); return delivered.promise; } });
  f.controller.send({ text: '帮我制作一个待办应用。' }); await tick();
  f.controller.send({ text: '聊聊天' }); await tick();
  const current = f.controller.snapshot(); assert.match(current.error, /新的聊天请求失败/);
  delivered.resolve({ disposition: 'started' }); await f.controller.settled();
  assert.deepEqual(f.controller.snapshot(), current);
  assert.equal(f.usage.find(record => record.status === 'completed').partial, false);
  assert.equal(f.usage.length, 2);
});

test('discussion, negation and quoted creation instructions remain ordinary chat even when the model suggests a task JSON', async () => {
  for (const text of ['如何制作一个网站？', '不要帮我制作一个程序。', '“帮我制作一个项目”是什么意思？']) {
    let transfers = 0;
    const f = fixture({ requestModel: async request => { f.requests.push(request); return reply('这是一段普通讨论。'); },
      onTask: async () => { transfers++; return { disposition: 'started' }; } });
    f.controller.send({ text }); await f.controller.settled();
    assert.match(f.requests[0].messages[0].content, /宠物聊天伙伴/); assert.doesNotMatch(f.requests[0].messages[0].content, /严格 JSON/);
    assert.equal(transfers, 0); assert.equal(f.controller.snapshot().messages[0].content, text);
  }
});

test('invalid JSON, unsupported tools or refused main queueing cannot publish a sent receipt or leak the private protocol', async () => {
  for (const kind of ['json', 'tool', 'queue', 'unconfirmed']) {
    let transfers = 0;
    const f = fixture({ requestModel: async request => {
      request.onTextDelta('{"prompt":"PRIVATE_PROTOCOL_MARKER"}');
      return reply(kind === 'json' ? 'not json' : '{"prompt":"PRIVATE_PROTOCOL_MARKER"}',
        kind === 'tool' ? { message: { content: '{"prompt":"PRIVATE_PROTOCOL_MARKER"}', toolCalls: [{ name: 'write_file' }] } } : {});
    }, onTask: async () => { transfers++; if (kind === 'queue') throw new Error('请先打开本地项目。'); return {}; } });
    f.controller.send({ text: '帮我制作一个本地笔记应用。' }); await f.controller.settled();
    assert.equal(transfers, ['json', 'tool'].includes(kind) ? 0 : 1);
    assert.equal(f.usage[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_PROTOCOL_MARKER|已把整理后的需求发送|正在排队/);
    assert.equal(f.controller.snapshot().messages.at(-1).content, '');
    assert.ok(f.controller.snapshot().error);
  }
});

test('stopped or account-changed refinement never reaches the main queue and late completion cannot revive it', async () => {
  for (const action of ['close', 'stop', 'account']) {
    const held = deferred(); let current = config, request, transfers = 0;
    const f = fixture({ getConfig: () => current, requestModel: value => { request = value; return held.promise; },
      onTask: async () => { transfers++; return { disposition: 'started' }; } });
    f.controller.send({ text: '帮我开发一个本地相册程序。' }); await tick();
    if (action === 'account') { current = { ...config, connectionKey: 'another-account' }; held.resolve(reply('{"prompt":"制作本地相册程序。"}')); }
    else f.controller[action]();
    await f.controller.settled(); const state = f.controller.snapshot();
    assert.equal(transfers, 0); assert.doesNotMatch(JSON.stringify(state), /已把整理后的需求/);
    request.onTextDelta('late JSON'); held.resolve(reply('{"prompt":"late task"}')); await tick();
    assert.deepEqual(f.controller.snapshot(), state); assert.equal(f.usage[0].status, 'stopped');
  }
});
