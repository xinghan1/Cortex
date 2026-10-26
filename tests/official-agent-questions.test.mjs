import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createPetDialogController, PET_QUESTION_TOOL } from '../src/core/pet-dialog.mjs';
const source = (await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const functions = source.slice(source.indexOf('async function officialAgentUserInput('), source.indexOf('\nfunction dispatchModelRequest('));
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(permissionMode = 'full', checkpointFlush = async () => {}) {
  const approvals = [], events = [], requests = [], flushes = [];
  const pet = createPetDialogController({ getConfig: async () => assert.fail('A native decision must not call a model'), requestModel: async config => { requests.push(config); assert.fail('No inference'); }, emit: event => events.push(event) });
  const run = { id: 'run-a', sessionId: 'local-session', externalAgent: true, controller: new AbortController(), checkpoints: { flush: async () => { flushes.push('answer-saved'); await checkpointFlush(); } } };
  const context = vm.createContext({ activeRun: run, permissionMode, petDialog: pet, publicSettings: () => ({ authMode: 'kimi-agent' }),
    accountLabel: () => 'Kimi 官方代理', approve: async request => { approvals.push(request); return true; } });
  vm.runInContext(functions, context);
  return { context, pet, run, approvals, events, requests, flushes,
    permission: input => context.officialAgentPermission({ localSessionId: run.sessionId, signal: run.controller.signal, ...input }),
    input: input => context.officialAgentUserInput({ localSessionId: run.sessionId, signal: run.controller.signal, ...input }) };
}
// Exact published Kimi ACP shape, not the former interaction_* heuristic:
// https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/interaction-bridge.ts
// https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/question.ts
const kimiQuestion = () => ({ toolCall: { toolCallId: '1:ask-user', title: 'AskUserQuestion',
  content: [{ type: 'content', content: { type: 'text', text: '本次使用哪种数据库？' } }] }, options: [
  { optionId: 'q0_opt_0', kind: 'allow_once', name: 'SQLite' }, { optionId: 'q0_opt_1', kind: 'allow_once', name: 'PostgreSQL' }, { optionId: 'q0_skip', kind: 'reject_once', name: 'Skip' } ] });

test('the real main Kimi bridge waits for an actual native choice in Request, Assist and Full, and never routes a question as approval', async () => {
  for (const mode of ['request', 'assist', 'full']) {
    const f = fixture(mode); let settled = false;
    const pending = f.permission(kimiQuestion()).then(value => { settled = true; return value; }); await tick();
    const question = f.pet.snapshot().question; assert.equal(settled, false); assert.equal(question.question, '本次使用哪种数据库？');
    assert.deepEqual(question.options, ['SQLite', 'PostgreSQL']); assert.equal(question.choiceOnly, true); assert.equal(question.blocking, true);
    assert.equal(f.approvals.length, 0); assert.equal(f.requests.length, 0);
    f.pet.answer({ id: question.id, choiceIndex: 1 }); assert.equal(await pending, 'q0_opt_1'); assert.equal(f.pet.snapshot().question, null);
  }
});
test('native Kimi choices cannot claim to deliver arbitrary custom text, and dismissing never selects q0_opt_0', async () => {
  const f = fixture(), pending = f.permission(kimiQuestion()), question = f.pet.snapshot().question;
  assert.throws(() => f.pet.answer({ id: question.id, text: '使用其他数据库' }), /只接受原生选项/); assert.equal(f.pet.snapshot().question.id, question.id);
  f.pet.dismiss({ id: question.id }); assert.equal(await pending, null); assert.equal(f.approvals.length, 0);
  assert.deepEqual(Object.keys(PET_QUESTION_TOOL.parameters.properties).sort(), ['options', 'question']);
});
test('stopped or replaced native runs cannot receive a late choice and a foreign local session cannot open a question', async () => {
  const f = fixture(), pending = f.permission(kimiQuestion()), rejected = assert.rejects(pending, { name: 'AbortError' }); f.run.controller.abort(); await rejected; assert.equal(f.pet.snapshot().question, null);
  const changed = fixture(), old = changed.permission(kimiQuestion()), question = changed.pet.snapshot().question;
  changed.context.activeRun = { ...changed.run, id: 'run-new', controller: new AbortController() }; changed.pet.answer({ id: question.id, choiceIndex: 1 }); assert.equal(await old, null);
  const foreign = fixture(); assert.equal(await foreign.permission({ ...kimiQuestion(), localSessionId: 'foreign' }), null); assert.equal(foreign.pet.snapshot().question, null);
});
test('malformed native question namespaces and missing question text fail closed instead of falling back to approval', async () => {
  for (const alter of [
    value => { value.toolCall.content = []; }, value => { value.options[1].optionId = 'q1_opt_1'; },
    value => { value.options[1].kind = 'allow_always'; }, value => { value.options[1].optionId = value.options[0].optionId; },
  ]) { const f = fixture(), value = kimiQuestion(); alter(value); assert.equal(await f.permission(value), null); assert.equal(f.pet.snapshot().question, null); assert.equal(f.approvals.length, 0); }
});
test('eight native choices plus Skip fit the existing question UI and ordinary permissions still return the actual one-time option ID', async () => {
  const f = fixture(), value = kimiQuestion(); value.options = Array.from({ length: 8 }, (_, index) => ({ optionId: `q0_opt_${index}`, kind: 'allow_once', name: `选项${index}` })).concat({ optionId: 'q0_skip', kind: 'reject_once', name: 'Skip' });
  const pending = f.permission(value), question = f.pet.snapshot().question; assert.equal(question.options.length, 8); f.pet.answer({ id: question.id, choiceIndex: 7 }); assert.equal(await pending, 'q0_opt_7');
  const selected = await f.permission({ toolCall: { toolCallId: '1:bash', title: '执行测试', kind: 'execute', rawInput: { command: 'fixture-only' } },
    options: [{ optionId: 'real-once-id', kind: 'allow_once', name: '允许' }, { optionId: 'real-reject-id', kind: 'reject_once', name: '拒绝' }] });
  assert.equal(selected, 'real-once-id'); assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].command, 'fixture-only');
});
test('ZCode native choices preserve their values, custom text is supported only by its user-input protocol, and cancellation never becomes accept', async () => {
  const f = fixture(), pending = f.input({ questions: [{ question: '测试方式', options: [{ label: '仅检查', value: 'inspect-only' }, { label: '保留文件', value: 'keep-files' }] }] });
  let question = f.pet.snapshot().question; assert.equal(question.choiceOnly, undefined); f.pet.answer({ id: question.id, choiceIndex: 1 });
  assert.deepEqual(plain(await pending), { action: 'accept', content: { answers: { '测试方式': 'keep-files' } } });
  const custom = f.input({ questions: [{ question: '补充说明', options: [] }] }); question = f.pet.snapshot().question; f.pet.answer({ id: question.id, text: '保持已有文件' });
  assert.deepEqual(plain(await custom), { action: 'accept', content: { answers: { '补充说明': '保持已有文件' } } });
  const cancelled = f.input({ questions: [{ question: '要继续吗', options: [{ label: '继续', value: 'go' }] }] }); question = f.pet.snapshot().question; f.pet.dismiss({ id: question.id });
  assert.deepEqual(plain(await cancelled), { action: 'cancel' }); assert.equal(f.approvals.length, 0); assert.equal(f.requests.length, 0);
});


test('native multi-question input waits for each answer checkpoint before asking or returning the next answer', async () => {
  const pendingWrites = [];
  const f = fixture('full', () => new Promise(resolve => pendingWrites.push(resolve)));
  let returned = false;
  const answers = f.input({ questions: [{ question: '第一问', options: [] }, { question: '第二问', options: [] }] }).then(value => { returned = true; return value; });
  f.pet.answer({ id: f.pet.snapshot().question.id, text: '第一答' }); await tick();
  assert.equal(pendingWrites.length, 1); assert.equal(f.pet.snapshot().question, null); assert.equal(returned, false);
  pendingWrites.shift()(); await tick(); assert.equal(f.pet.snapshot().question.question, '第二问');
  f.pet.answer({ id: f.pet.snapshot().question.id, text: '第二答' }); await tick();
  assert.equal(pendingWrites.length, 1); assert.equal(returned, false);
  pendingWrites.shift()();
  assert.deepEqual(plain(await answers), { action: 'accept', content: { answers: { '第一问': '第一答', '第二问': '第二答' } } });
});

test('native fixed-choice reply cannot be returned before saving and storage failure never accepts the answer', async () => {
  let finishWrite;
  const f = fixture('full', () => new Promise(resolve => { finishWrite = resolve; })); let returned = false;
  const answer = f.permission(kimiQuestion()).then(value => { returned = true; return value; });
  f.pet.answer({ id: f.pet.snapshot().question.id, choiceIndex: 1 }); await tick(); assert.equal(returned, false);
  finishWrite(); assert.equal(await answer, 'q0_opt_1');
  const broken = fixture('full', async () => { throw new Error('checkpoint unavailable'); });
  const rejected = broken.input({ questions: [{ question: '不能丢失回答', options: [] }] });
  broken.pet.answer({ id: broken.pet.snapshot().question.id, text: '真实回答' });
  await assert.rejects(rejected, /checkpoint unavailable/); assert.equal(broken.pet.snapshot().question, null);
});
