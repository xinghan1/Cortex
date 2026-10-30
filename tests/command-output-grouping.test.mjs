import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName, className = '', text = '') {
    this.tagName = tagName; this.className = className; this.content = text;
    this.children = []; this.dataset = {}; this.attributes = {}; this.parentElement = null;
    this.open = false; this.hidden = false; this.scrollTop = 0; this.scrollHeight = 120;
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      remove: value => { this.className = this.className.split(' ').filter(name => name !== value).join(' '); },
      add: value => { if (!this.classList.contains(value)) this.className += ` ${value}`; },
    };
  }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); for (const child of this.children) child.parentElement = null; this.children = []; }
  get lastElementChild() { return this.children.findLast(child => child.tagName !== '#text') || null; }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  insertBefore(child, before) { child.remove(); const index = this.children.indexOf(before); assert.notEqual(index, -1); child.parentElement = this; this.children.splice(index, 0, child); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelectorAll(selector) {
    const matches = child => selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const source = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const groupSource = await fs.readFile(new URL('../src/renderer/tool-operation-groups.js', import.meta.url), 'utf8');
function appFunction(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0, `Renderer function ${name} exists`);
  return source.slice(start, end < 0 ? source.length : end);
}
function fixture() {
  const target = new Element('div', 'task-activity-events'), tools = [];
  const context = vm.createContext({
    target, tools, window: {},
    element: (tag, className, text) => new Element(tag, className, text),
    document: { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', '', text) },
    taskProcessTarget: () => target,
    toolActivity: (name, args, completed) => completed ? '已运行命令' : '正在运行命令',
    safeString: value => JSON.stringify(value),
    setTaskActivityPhase() {}, scrollBottom() {},
  });
  vm.runInContext('let pendingTools = tools; let commandOutput = null;', context);
  vm.runInContext(groupSource, context);
  context.window.ForgeToolOperationGroups = context.ForgeToolOperationGroups;
  for (const name of ['toolPayload', 'createCommandOutput', 'commandOutputForEvent', 'refreshGroupedToolCard', 'completeTool'])
    vm.runInContext(appFunction(name), context);
  const makeTool = (name, toolCallId, runId = 'round-one') => {
    const card = new Element('details', 'tool-card running'), details = new Element('div', 'tool-details');
    const technical = new Element('div', 'tool-technical-details'), title = new Element('span', 'tool-title', name), badge = new Element('span', 'tool-badge');
    details.append(technical); card.append(title, badge, details);
    return { name, toolCallId, runId, args: { command: `Write-Output '${toolCallId}'` }, card, details, technical, title, badge };
  };
  const appendTool = tool => {
    tools.push(tool);
    return context.ForgeToolOperationGroups.appendTool(target, tool.card, { name: tool.name, runId: tool.runId });
  };
  return { context, target, tools, makeTool, appendTool };
}

test('six sequential commands with stdout form one closed operation group without detaching their outputs', () => {
  const { context, target, tools, makeTool, appendTool } = fixture(), originals = [], outputs = [];
  for (let index = 0; index < 6; index++) {
    const tool = makeTool('run_command', `call-${index}`); originals.push(tool);
    appendTool(tool);
    const output = context.commandOutputForEvent({ toolCallId: tool.toolCallId, runId: tool.runId });
    output.append(new Element('#text', '', `command ${index} stdout\n`)); outputs.push(output);
    assert.equal(context.commandOutputForEvent({ toolCallId: tool.toolCallId, runId: tool.runId }), output, 'A later chunk reuses this command preview');
    context.completeTool({ name: tool.name, toolCallId: tool.toolCallId, result: { exitCode: 0 } });
    assert.equal(tools.length, 0);
  }
  assert.equal(target.children.length, 1, 'Streaming output must not leave sibling nodes that split adjacent commands');
  const group = target.children[0];
  assert.equal(group.className, 'tool-operation-group'); assert.equal(group.open, false);
  assert.equal(group.dataset.count, '6'); assert.equal(group.dataset.status, 'completed');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '运行了命令');
  assert.deepEqual(group.querySelector('.tool-operation-group-items').children, originals.map(tool => tool.card));
  assert.equal(group.querySelectorAll('.command-output-disclosure').length, 6);
  for (const [index, tool] of originals.entries()) {
    assert.equal(tool.details.contains(outputs[index]), true);
    assert.equal(outputs[index].textContent, `command ${index} stdout\n`);
    assert.equal(outputs[index].parentElement.open, false, 'Output itself stays manually expandable');
  }
});

test('streaming chunks and later commands preserve the group and output disclosure states chosen by the user', () => {
  const { context, target, makeTool, appendTool } = fixture();
  const first = makeTool('run_command', 'first'); appendTool(first);
  const firstOutput = context.commandOutputForEvent({}); firstOutput.append(new Element('#text', '', 'first\n'));
  context.completeTool({ name: first.name, toolCallId: first.toolCallId, result: { exitCode: 0 } });
  const second = makeTool('run_command', 'second'), group = appendTool(second);
  const secondOutput = context.commandOutputForEvent({});
  group.open = true; secondOutput.parentElement.open = true;
  context.commandOutputForEvent({}).append(new Element('#text', '', 'one\n'));
  context.commandOutputForEvent({}).append(new Element('#text', '', 'two\n'));
  context.completeTool({ name: second.name, toolCallId: second.toolCallId, result: { exitCode: 0 } });
  const third = makeTool('run_command', 'third'); appendTool(third);
  assert.equal(group.open, true); assert.equal(secondOutput.parentElement.open, true);
  assert.equal(secondOutput.textContent, 'one\ntwo\n'); assert.equal(target.children[0], group);
  group.open = false;
  context.commandOutputForEvent({}).append(new Element('#text', '', 'third\n'));
  context.completeTool({ name: third.name, toolCallId: third.toolCallId, result: { exitCode: 7 } });
  assert.equal(group.open, false); assert.equal(group.dataset.status, 'failed');
  assert.equal(group.dataset.count, '3');
});

test('identity mismatches, a noncommand last tool and orphan output never append to an unrelated command', () => {
  for (const scenario of ['tool-id', 'run-id', 'last-tool', 'no-tool']) {
    const { context, target, tools, makeTool, appendTool } = fixture();
    const first = makeTool('run_command', 'expected'); appendTool(first);
    let event = {};
    if (scenario === 'tool-id') event = { toolCallId: 'different' };
    if (scenario === 'run-id') event = { runId: 'another-round' };
    if (scenario === 'last-tool') appendTool(makeTool('read_file', 'latest'));
    if (scenario === 'no-tool') tools.length = 0;
    const output = context.commandOutputForEvent(event);
    assert.equal(first.details.contains(output), false, scenario);
    assert.equal(output.parentElement.parentElement, target, scenario);
    output.append(new Element('#text', '', `orphan ${scenario}\n`));
    assert.equal(context.commandOutputForEvent(event, tools, target, output), output, 'One orphan stream retains its existing fallback');
    assert.equal(target.querySelectorAll('.command-output-disclosure').length, 1);
  }
});

test('an orphan output after a visible conversation boundary starts a new preview instead of changing the earlier log', () => {
  const { context, target, tools } = fixture();
  const previous = context.commandOutputForEvent({}, tools, target);
  previous.textContent = 'before steering\n';
  const steering = new Element('article', 'message user', '新的引导'); target.append(steering);
  const next = context.commandOutputForEvent({}, tools, target, previous);
  next.textContent = 'after steering\n';
  assert.notEqual(next, previous);
  assert.deepEqual(target.children, [previous.parentElement, steering, next.parentElement]);
  assert.equal(previous.textContent, 'before steering\n');
  assert.equal(context.commandOutputForEvent({}, tools, target, next), next);
});

test('historical command ownership uses explicit tools and target while normalizing simulated command names', () => {
  const { context, tools, makeTool, appendTool } = fixture();
  appendTool(makeTool('run_command', 'unrelated-live', 'live-round'));
  const historyTarget = new Element('div', 'task-activity-events');
  const historical = makeTool('run_command（模拟）', 'old-command');
  delete historical.runId;
  historyTarget.append(historical.card);
  const output = context.commandOutputForEvent({ toolCallId: 'old-command' }, [historical], historyTarget);
  assert.equal(historical.details.contains(output), true);
  assert.equal(tools[0].details.contains(output), false);
  assert.equal(historyTarget.querySelectorAll('.command-output-disclosure').length, 1);
  assert.equal(context.commandOutputForEvent({}, [historical], historyTarget), output);
});

test('a truncated command result updates only its own output and preserves the real exit status', () => {
  const { context, makeTool, appendTool } = fixture();
  const first = makeTool('run_command', 'first'); appendTool(first);
  const firstOutput = context.commandOutputForEvent({}); firstOutput.textContent = 'first remains exact\n';
  context.completeTool({ name: first.name, toolCallId: first.toolCallId, result: { exitCode: 0 } });
  const second = makeTool('run_command', 'second'), group = appendTool(second);
  const secondOutput = context.commandOutputForEvent({}); secondOutput.textContent = 'second partial\n';
  context.decoy = firstOutput;
  vm.runInContext('commandOutput = decoy', context);
  context.completeTool({ name: second.name, toolCallId: second.toolCallId, result: {
    exitCode: 7, outputTruncated: true, output: 'second head\n[… omitted …]\nsecond actual tail\n',
  } });
  assert.equal(firstOutput.textContent, 'first remains exact\n', 'A stale global stream reference cannot corrupt an earlier command');
  assert.equal(secondOutput.textContent, 'second head\n[… omitted …]\nsecond actual tail\n');
  assert.equal(secondOutput.scrollTop, secondOutput.scrollHeight);
  assert.equal(second.card.dataset.status, 'failed'); assert.equal(group.dataset.status, 'failed');
  assert.equal(group.open, false);
});

test('historical completion restores a truncated command tail without writing to a live output preview', () => {
  const { context, makeTool, appendTool } = fixture();
  const live = makeTool('run_command', 'live-command', 'live-round'); appendTool(live);
  const liveOutput = context.commandOutputForEvent({}); liveOutput.textContent = 'live untouched\n';
  const historyTarget = new Element('div', 'task-activity-events');
  const historical = makeTool('run_command', 'historical-command', 'old-round');
  const historicalTools = [historical]; historyTarget.append(historical.card);
  const historicalOutput = context.commandOutputForEvent({ runId: 'old-round' }, historicalTools, historyTarget);
  historicalOutput.textContent = 'original streamed prefix\n';
  context.completeTool({ name: historical.name, toolCallId: historical.toolCallId, result: JSON.stringify({
    exitCode: 0, outputTruncated: true, output: 'saved head\n[… omitted …]\nsaved tail\n',
  }) }, { tools: historicalTools, updateActivity: false });
  assert.equal(historicalOutput.textContent, 'saved head\n[… omitted …]\nsaved tail\n');
  assert.equal(liveOutput.textContent, 'live untouched\n');
  assert.equal(historical.card.dataset.status, 'completed'); assert.equal(historicalTools.length, 0);
});
