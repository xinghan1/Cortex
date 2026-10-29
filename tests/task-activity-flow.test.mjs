import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName, className = '', text = '') {
    this.tagName = tagName; this.className = className; this.content = text;
    this.children = []; this.dataset = {}; this.attributes = {}; this.parentElement = null; this.hidden = false;
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      remove: value => { this.className = this.className.split(' ').filter(name => name !== value).join(' '); },
      add: value => { if (!this.classList.contains(value)) this.className += ` ${value}`; },
    };
  }
  get textContent() { return this.content + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get isConnected() { return Boolean(this.parentElement); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  after(node) { this.parentElement.insertBefore(node, this.parentElement.children[this.parentElement.children.indexOf(this) + 1]); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelectorAll(selector) {
    const [tag, name] = selector.split('.');
    const match = node => (!tag || node.tagName === tag) && (!name || node.classList.contains(name));
    return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const source = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const groupSource = await fs.readFile(new URL('../src/renderer/tool-operation-groups.js', import.meta.url), 'utf8');
const historySource = await fs.readFile(new URL('../src/renderer/task-history.js', import.meta.url), 'utf8');
function appFunction(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0, name);
  return source.slice(start, end < 0 ? source.length : end);
}
function fixture() {
  const messages = new Element('div'), runStatus = new Element('span');
  const context = vm.createContext({
    element: (tag, name, value) => new Element(tag, name, value),
    document: { createElement: tag => new Element(tag) },
    $: id => id === 'messages' ? messages : runStatus,
    performance: { now: () => 842000 }, clearInterval() {}, window: {},
    showTokenRate() {}, finishContextCompaction() {}, renderTaskReconnect() {},
    hasTokenRate: () => false,
    taskProcessTarget: () => context.activity.events,
    messageImageAttachments: value => Array.isArray(value) ? value.filter(item => item?.dataUrl) : [],
    appendGeneratedImages: (message, attachments) => { for (const image of attachments) message.append(new Element('img', '', image.dataUrl)); },
    addMessage: (_role, text) => { const message = new Element('article', 'message assistant', text); messages.append(message); return { message }; },
  });
  vm.runInContext('let running = true; let contextCompacting = false; let activeTaskActivity; let taskActivityTimer = null; let latestTelemetry = null; let taskKind = "agent"; let sessionId = "session";', context);
  vm.runInContext(historySource, context); context.window.ForgeTaskHistory = context.ForgeTaskHistory;
  for (const name of ['activityDuration', 'taskElapsed', 'renderTaskActivityElapsed', 'createTaskActivity', 'rememberGeneratedImage', 'setTaskActivityPhase', 'clearTaskReconnect', 'finishTaskActivity', 'renderQuestionAnswer'])
    vm.runInContext(appFunction(name), context);
  vm.runInContext(groupSource, context);
  const activity = context.createTaskActivity({ runId: 'current' });
  activity.block.classList.add('running'); activity.block.dataset.status = 'running';
  activity.startedMono = 0; messages.append(activity.block);
  context.activity = activity;
  vm.runInContext('activeTaskActivity = activity', context);
  return { context, activity, messages, runStatus };
}

test('answered choices and custom text render once in the current task flow without creating a user message or another round', () => {
  const { context, activity, messages } = fixture();
  const choice = { type: 'question-answer', questionId: 'one', runId: 'current', sessionId: 'session', question: '采用哪种方式？', options: ['保留', '调整'], answer: '调整', choiceIndex: 1, source: 'user' };
  const card = context.renderQuestionAnswer(choice); assert.ok(card); assert.equal(card.parentElement, activity.events);
  assert.equal(card.querySelector('.question-answer-question').textContent, choice.question); assert.equal(card.querySelector('.question-answer-text').textContent, choice.answer);
  assert.equal(card.querySelector('.question-answer-response').dataset.kind, 'choice'); assert.equal(context.renderQuestionAnswer(choice), card);
  const answer = '完整自定义回答\n' + '较长的具体要求'.repeat(300);
  const custom = context.renderQuestionAnswer({ ...choice, questionId: 'two', question: '<script>原文问题</script>', options: [], choiceIndex: undefined, answer });
  assert.equal(custom, null, 'A malformed choice index is rejected');
  const event = { ...choice, questionId: 'two', question: '<script>原文问题</script>', options: [], answer }; delete event.choiceIndex;
  const customCard = context.renderQuestionAnswer(event); assert.equal(customCard.querySelector('.question-answer-text').textContent, answer); assert.equal(customCard.querySelector('.question-answer-question').textContent, event.question);
  assert.equal(customCard.querySelector('.question-answer-response').dataset.kind, 'custom'); assert.equal(activity.events.querySelectorAll('.question-answer-card').length, 2);
  assert.equal(messages.children.length, 1); assert.equal(messages.querySelectorAll('article.message').length, 0);
});

test('generated images are deduplicated by id and attached to the final answer; failed turns retain images outside the folded process', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    const { context, activity, messages } = fixture();
    const first = { runId:'current', id:'image-one', attachments:[{dataUrl:'fixture-one'}] };
    assert.equal(context.rememberGeneratedImage(first), true); assert.equal(context.rememberGeneratedImage(first), true);
    assert.equal(context.rememberGeneratedImage({ ...first, id:'image-two', attachments:[{dataUrl:'fixture-two'}] }), true);
    assert.equal(context.rememberGeneratedImage({ ...first, runId:'wrong' }), false);
    const answer = new Element('article','message assistant'); answer.append(new Element('div','message-body','最终答复'));
    activity.events.append(answer); activity.lastAssistant = answer; activity.lastAssistantConfirmed = status === 'completed';
    context.finishTaskActivity({status,elapsedMs:100});
    const target = status === 'completed' ? answer : messages.children.at(-1);
    assert.equal(target.parentElement, messages); assert.equal(target.querySelectorAll('img').length, 2);
    assert.equal(activity.events.querySelectorAll('img').length, 0);
  }
});

test('live question receipts cannot cross sessions, tasks, cancellations, casual chat or settled activity', () => {
  const { context, activity } = fixture();
  const base = { type: 'question-answer', questionId: 'q', runId: 'current', sessionId: 'session', question: '当前问题', options: [], answer: '真实回答', source: 'user' };
  for (const patch of [{ runId: 'different' }, { sessionId: 'different' }, { cancelled: true }, { source: 'assistant' }, { type: 'pet-dialog' }]) assert.equal(context.renderQuestionAnswer({ ...base, ...patch }), null);
  activity.status = 'completed'; assert.equal(context.renderQuestionAnswer(base), null); assert.equal(activity.events.childElementCount, 0);
  const historical = context.renderQuestionAnswer(base, { target: activity.events, historical: true, runId: 'current' }); assert.ok(historical);
  assert.equal(context.renderQuestionAnswer({ ...base, questionId: 'other', runId: 'wrong' }, { target: activity.events, historical: true, runId: 'current' }), null);
  assert.equal(activity.events.querySelectorAll('.question-answer-card').length, 1);
});

test('round heading shows only elapsed time during work and after completion', () => {
  const { context, activity } = fixture();
  context.renderTaskActivityElapsed();
  assert.equal(activity.summary.textContent, '用时 14分钟 2秒·');
  assert.equal(activity.separator.hidden, true); assert.equal(activity.speed.hidden, true);
  assert.equal(activity.summary.contains(activity.phaseNode), false);
  context.setTaskActivityPhase('thinking', '正在思考');
  assert.equal(activity.summary.textContent, '用时 14分钟 2秒·');
  activity.status = 'completed'; activity.finishedElapsed = 3661000;
  context.renderTaskActivityElapsed();
  assert.equal(activity.elapsed.textContent, '用时 1小时 1分钟 1秒');
  assert.equal(context.activityDuration(0), '用时 0秒');
});

test('live phase follows messages and steering without splitting consecutive tool groups', () => {
  const { context, activity } = fixture();
  const commentary = new Element('article', 'message', '先检查'), steering = new Element('article', 'message', '再检查第二个文件');
  activity.events.append(commentary, steering);
  const first = new Element('details', 'tool-card running'), second = new Element('details', 'tool-card running');
  context.setTaskActivityPhase('tool', '正在读取文件');
  context.ForgeToolOperationGroups.appendTool(activity.events, first, { name: 'read_file', runId: 'current' });
  context.setTaskActivityPhase('waiting', '等待模型');
  context.setTaskActivityPhase('tool', '正在读取文件');
  const group = context.ForgeToolOperationGroups.appendTool(activity.events, second, { name: 'read_file', runId: 'current' });
  assert.ok(group, 'The live phase must not interrupt adjacent tool grouping');
  assert.deepEqual(activity.events.children, [commentary, steering, group]);
  assert.equal(activity.phaseLine.hidden, true, 'Tool cards supply their own visible status');
  context.setTaskActivityPhase('thinking', '正在思考');
  assert.equal(activity.phaseLine.hidden, false);
  assert.equal(activity.block.lastElementChild, activity.phaseLine);
  assert.equal(activity.phaseLine.attributes.role, 'status');
  assert.equal(activity.events.contains(activity.phaseLine), false);
  const answer = new Element('article', 'message', '正在输出'); activity.events.append(answer);
  context.setTaskActivityPhase('generating', '正在生成');
  assert.equal(activity.block.lastElementChild, activity.phaseLine);
  assert.equal(activity.phaseNode.textContent, '正在生成');
});

test('compression and its reconnect own a single progress notice while generic phases resume afterward', () => {
  const { context, activity } = fixture();
  vm.runInContext('contextCompacting = true', context);
  context.setTaskActivityPhase('compacting', '正在压缩上下文…');
  assert.equal(activity.phaseLine.hidden, true);
  context.setTaskActivityPhase('reconnecting', '正在重连 2/5');
  assert.equal(activity.phaseLine.hidden, true);
  vm.runInContext('contextCompacting = false', context);
  context.setTaskActivityPhase('waiting', '等待模型继续');
  assert.equal(activity.phaseLine.hidden, false);
  context.setTaskActivityPhase('reconnecting', '正在重连 3/5');
  assert.equal(activity.phaseLine.hidden, false);
  context.setTaskActivityPhase('completed', '模型已返回');
  assert.equal(activity.phaseLine.hidden, true);
});

test('terminal outcomes fold operations, clear the live status, and keep only confirmed final replies outside', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    const { context, activity, messages } = fixture();
    const operation = new Element('details', 'tool-card'); operation.open = true;
    const answer = new Element('article', 'message assistant'); answer.append(new Element('div', 'message-body', '最终答复'));
    activity.events.append(operation, answer);
    activity.lastAssistant = answer; activity.lastAssistantConfirmed = status === 'completed';
    context.finishTaskActivity({ runId: 'current', status, elapsedMs: 842000 });
    assert.equal(activity.block.open, false); assert.equal(operation.open, false);
    assert.equal(activity.phaseLine.hidden, true); assert.equal(activity.block.classList.contains('running'), false);
    assert.equal(activity.elapsed.textContent, '用时 14分钟 2秒');
    assert.equal(answer.parentElement, status === 'completed' ? messages : activity.events);
    if (status === 'completed') assert.deepEqual(messages.children, [activity.block, answer]);
    const previousPhase = activity.phaseNode.textContent;
    context.setTaskActivityPhase('thinking', 'late status');
    assert.equal(activity.phaseNode.textContent, previousPhase, 'Late telemetry cannot revive a settled phase');
  }
});
