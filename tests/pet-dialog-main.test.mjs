import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createPetDialogController, PET_QUESTION_TOOL } from '../src/core/pet-dialog.mjs';
import { createPetTaskHandoff } from '../src/core/pet-task-intent.mjs';

const source = (await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const wiringStart = source.indexOf('const petDialog = createPetDialogController({');
const wiringSource = source.slice(wiringStart, source.indexOf('\nfunction publicSettings()', wiringStart));
const handlersStart = source.indexOf('    getPetDialog: () => publicPetDialog(),');
const handlersSource = source.slice(handlersStart, source.indexOf('    cancelPromptCompletion:', handlersStart));
const stopStart = source.indexOf('    stopTask: () => ');
const stopSource = source.slice(stopStart, source.indexOf('\n', stopStart));
const toolStart = source.indexOf('execute: (name, args, options) => {', source.indexOf('async function startTask('));
const toolEnd = source.indexOf('\n        } }, toolDefinitions:', toolStart);
const toolSource = source.slice(toolStart + 'execute: '.length, toolEnd + '\n        }'.length);
assert.ok(wiringStart > 0 && handlersStart > 0 && stopStart > 0 && toolStart > 0 && toolEnd > toolStart);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(extra = {}) {
  const events = [], requests = [], usage = [], calls = [], roleCalls = [];
  const run = { id: 'main-run', sessionId: 'session-a', controller: new AbortController() };
  const runtimeContext = {}, host = { active: runtimeContext, publishWorkspaces: () => calls.push('publish-workspaces') };
  const config = { provider: 'relay', model: 'pet-model', authMode: 'apiKey', baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'local-fixture-key', connectionKey: 'connection-a', apiProtocol: 'responses' };
  const sandbox = vm.createContext({ createPetDialogController, createPetTaskHandoff, PET_QUESTION_TOOL, AbortController, DOMException,
    currentSession: { id: 'session-a', messages: [], chatgptProfileId: null, deepseekProfileId: null },
    configRevision: 1, workspaceId: 'workspace-a', shuttingDown: false, quitting: false,
    requireSharedReady() {}, catalogContext: async () => ({ key: 'connection-a', authMode: 'apiKey' }),
    publicSettings: () => ({ model: config.model }), roleModels: { isEnabled: () => false }, roleRuntime: { revisions: { pet: 0 } },
    roleRequestConfig: async (role, owner, model) => { roleCalls.push({ role, owner, model }); return { ...config }; },
    dispatchModelRequest: async request => { requests.push(request); return { message: { role: 'assistant', content: '宠物回答', toolCalls: [] },
      usage: { inputTokens: 20, outputTokens: 4 }, usageReported: true }; },
    redact: value => value, recordRunUsage: async value => usage.push(value),
    win: { isDestroyed: () => false, webContents: { send: (channel, event) => events.push({ channel, ...event }) } },
    host, context: runtimeContext, run, activeRun: run, stopGeneration: 0,
    pauseQueue: () => calls.push('pause-queue'),
    tools: { root: 'C:/fixture', execute: (name, args, options) => { calls.push({ name, args, options }); return 'workspace result'; } },
    browser: { execute: () => assert.fail('A question must not execute a browser operation') },
    emit: () => {}, isXmlURL: () => false, approve: () => assert.fail('A question is never permission approval'), recordRunFileChange() {}, ...extra,
  });
  vm.runInContext(wiringSource + '\nconst petHandlers = {\n' + handlersSource + stopSource + '\n};\n'
    + 'globalThis.testHandlers = petHandlers; globalThis.testPet = petDialog; globalThis.executeTool = ' + toolSource + ';', sandbox);
  return { sandbox, pet: sandbox.testPet, handlers: sandbox.testHandlers, events, requests, usage, calls, roleCalls, run, host, config,
    scope: () => ({ workspaceId: sandbox.workspaceId, sessionId: sandbox.currentSession.id }) };
}

test('main pet handlers reject stale workspace/session and extraneous fields before changing a pending question', async () => {
  const f = fixture(), pending = f.pet.ask({ question: '选择文件', options: ['A', 'B'] });
  const id = f.pet.snapshot().question.id;
  for (const method of ['answerPetDialog', 'dismissPetDialog', 'sendPetChat', 'reactPetAction']) {
    const body = method === 'answerPetDialog' ? { id, text: '回答' } : method === 'dismissPetDialog' ? { id }
      : method === 'reactPetAction' ? { kind: 'clicks', sequence: 1 } : { text: '闲聊' };
    for (const patch of [{ workspaceId: 'another-workspace' }, { sessionId: 'another-session' }, { extra: 'untrusted' }]) {
      assert.throws(() => f.handlers[method]({ ...f.scope(), ...body, ...patch }), /会话已变化/);
      assert.equal(f.pet.snapshot().question.id, id);
    }
  }
  f.handlers.dismissPetDialog({ ...f.scope(), id }); assert.equal((await pending).cancelled, true);
  assert.equal(f.requests.length, 0); assert.equal(f.usage.length, 0);
});

test('the actual main composite routes questions to the bound run signal and returns user choices without workspace or approval actions', async () => {
  const f = fixture(), owner = new AbortController();
  const result = f.sandbox.executeTool('ask_user_question', { question: '用哪个？', options: ['一', '二'] }, { signal: owner.signal });
  const id = f.pet.snapshot().question.id;
  const state = f.handlers.answerPetDialog({ ...f.scope(), id, choiceIndex: 1 });
  assert.equal(state.workspaceId, 'workspace-a'); assert.equal(state.sessionId, 'session-a');
  assert.deepEqual(JSON.parse(await result), { questionId: id, answer: '二', choiceIndex: 1, source: 'user' });
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.run.controller.signal.aborted, false);
  assert.equal(f.sandbox.currentSession.messages.length, 0);
  const cancelled = f.sandbox.executeTool('ask_user_question', { question: '可以取消' }, { signal: owner.signal });
  f.handlers.dismissPetDialog({ ...f.scope(), id: f.pet.snapshot().question.id });
  const cancelledResult = JSON.parse(await cancelled);
  assert.equal(cancelledResult.cancelled, true); assert.equal(Object.hasOwn(cancelledResult, 'answer'), false);
});

test('a tool-specific abort and the real stopTask handler reject pending questions rather than answering them', async () => {
  const f = fixture(), owner = new AbortController();
  const task = f.sandbox.executeTool('ask_user_question', { question: '等待用户' }, { signal: owner.signal });
  const rejected = assert.rejects(task, { name: 'AbortError' }); owner.abort(); await rejected;
  assert.equal(f.pet.snapshot().question, null); assert.equal(f.run.controller.signal.aborted, false);
  const task2 = f.sandbox.executeTool('ask_user_question', { question: '再次等待' }, { signal: f.run.controller.signal });
  const stopped = assert.rejects(task2, { name: 'AbortError' }); f.handlers.stopTask(); await stopped;
  assert.equal(f.run.controller.signal.aborted, true); assert.equal(f.sandbox.stopGeneration, 1);
  assert.deepEqual(f.calls, ['pause-queue']); assert.equal(f.pet.snapshot().question, null);
});

test('main wiring uses the pet role, emits scoped ephemeral events, and gives casual use an independent run ledger', async () => {
  const f = fixture();
  const state = f.handlers.sendPetChat({ ...f.scope(), text: '你好' });
  assert.equal(state.running, true); await f.pet.settled();
  assert.equal(f.requests.length, 1); assert.ok(f.roleCalls.length >= 2);
  assert.ok(f.roleCalls.every(value => value.role === 'pet' && value.owner.connectionKey === 'connection-a'));
  assert.deepEqual(f.requests[0].tools, []); assert.equal(f.requests[0].messages.at(-1).content, '你好');
  assert.equal(f.usage[0].purpose, 'pet-chat'); assert.equal(f.usage[0].sessionId, 'session-a');
  assert.notEqual(f.usage[0].runId, f.run.id); assert.equal(f.sandbox.currentSession.messages.length, 0);
  assert.ok(f.events.every(event => event.type === 'pet-dialog' && event.workspaceId === 'workspace-a' && event.sessionId === 'session-a'));
  f.host.active = {}; const previous = f.events.length;
  f.pet.close(); assert.equal(f.events.length, previous); assert.ok(f.calls.includes('publish-workspaces'));
});

test('session or config changes during main model preflight prevent pet dispatch and stale scope answers', async () => {
  for (const change of [f => { f.sandbox.currentSession = { id: 'session-b', messages: [] }; },
    f => { f.sandbox.configRevision++; }, f => { f.sandbox.shuttingDown = true; }]) {
    const f = fixture(), held = deferred();
    f.sandbox.catalogContext = () => held.promise;
    f.handlers.sendPetChat({ ...f.scope(), text: '预检查中' }); await tick();
    change(f); held.resolve({ key: 'connection-a', authMode: 'apiKey' }); await f.pet.settled();
    assert.equal(f.requests.length, 0); assert.equal(f.usage.length, 0);
    assert.throws(() => f.handlers.sendPetChat({ workspaceId: 'workspace-a', sessionId: 'stale-session', text: '旧会话' }), /会话已变化/);
  }
});

test('the main stream generation guard drops a role revision change and old partial content before another chunk reaches the UI', async () => {
  const held = deferred(); let request;
  const f = fixture({ dispatchModelRequest: value => { request = value; return held.promise; } });
  f.sandbox.roleModels.isEnabled = () => true;
  f.sandbox.roleRequestConfig = async () => ({ ...f.config, modelRole: 'pet', roleConnectionRevision: 0 });
  f.handlers.sendPetChat({ ...f.scope(), text: '原角色问题' }); await tick();
  request.onTextDelta('旧角色部分文本'); f.sandbox.roleRuntime.revisions.pet++;
  request.onTextDelta('NEW_REVISION_PRIVATE_TEXT'); await f.pet.settled();
  assert.equal(request.signal.aborted, true); assert.deepEqual(f.pet.snapshot().messages, []);
  assert.doesNotMatch(JSON.stringify(f.events), /NEW_REVISION_PRIVATE_TEXT/);
  assert.equal(f.usage[0].status, 'stopped');
  held.resolve({ message: { content: '迟到结果', toolCalls: [] }, usageReported: false }); await tick();
});
