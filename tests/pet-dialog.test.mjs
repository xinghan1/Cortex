import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetDialogController, PET_QUESTION_TOOL, PET_DIALOG_LIMITS as LIMITS } from '../src/core/pet-dialog.mjs';

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
