import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createPetTaskHandoff } from '../src/core/pet-task-intent.mjs';

const source = (await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const between = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `${start} is present in the main process`); return source.slice(first, last);
};
const mainSource = [
  between('function currentPetConfig(config)', '\nfunction publicPetDialog()'),
  between('function serializePrompts(operation)', '\nfunction requireEmptyQueue()'),
  between('async function dispatchNextPrompt()', '\nfunction scheduleNextPrompt()'),
  between('async function submitPrompt(arg,', '\nasync function managePendingPrompt('),
].join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ busy = false, block = Promise.resolve(), project = true } = {}) {
  const calls = [], runtime = {}, host = { active: runtime };
  const sandbox = vm.createContext({ createPetTaskHandoff, DOMException, randomUUID,
    configRevision: 1, currentSession: { id: 'session-a' }, workspaceId: 'workspace-a',
    shuttingDown: false, quitting: false, host, context: runtime,
    roleModels: { isEnabled: role => role === 'pet' }, roleRuntime: { revisions: { pet: 1 } },
    win: { isDestroyed: () => false }, tools: project ? { root: 'C:/project-a' } : null,
    promptCompletion: { abort: () => calls.push('abort-tab') }, normalizeImageAttachments: () => [],
    stopGeneration: 0, promptOperations: block, pendingPrompts: [], queuePaused: false,
    localOperation: false, fileOperationDone: null,
    activeRun: busy ? { kind: 'agent', controller: new AbortController() } : null,
    requireTools: () => { if (!sandbox.tools) throw new Error('请先打开本地项目。'); return sandbox.tools; },
    emitQueue: () => calls.push({ queue: structuredClone(sandbox.pendingPrompts) }),
    pauseQueue: message => { calls.push({ paused: message }); sandbox.queuePaused = true; },
    startTask: async input => { calls.push({ started: structuredClone(input) }); sandbox.activeRun = { kind: 'agent', controller: new AbortController() }; },
    broadcastAllStates: async () => {}, redact: value => value,
  });
  vm.runInContext(mainSource, sandbox);
  const config = { provider: 'relay', model: 'pet-model', modelRole: 'pet', roleConnectionRevision: 1,
    petSessionId: 'session-a', petConfigRevision: 1 };
  const request = overrides => ({ requestId: randomUUID(), originalText: '帮我制作一个本地记账程序，不上传数据。',
    prompt: '制作本地记账程序，支持本机录入与汇总，不上传数据。', sessionId: 'session-a', config: { ...config },
    signal: new AbortController().signal, ...overrides });
  return { sandbox, calls, config, request, deliver: value => sandbox.handoffPetTask(value), host };
}

test('real main handoff preserves the exact original requirement and original-priority boundary, then reports actual started or queued disposition', async () => {
  for (const busy of [false, true]) {
    const f = fixture({ busy }), request = f.request();
    const result = await f.deliver(request);
    assert.equal(result.disposition, busy ? 'queued' : 'started');
    assert.equal(f.calls.filter(call => call.started).length, busy ? 0 : 1);
    const queued = f.calls.find(call => call.queue)?.queue[0];
    assert.equal(queued.source, 'pet'); assert.equal(queued.mode, 'queue');
    assert.ok(queued.text.includes(request.originalText)); assert.ok(queued.text.includes(request.prompt));
    assert.match(queued.text, /不扩展授权；有冲突时以原始需求为准/);
    assert.equal(f.sandbox.pendingPrompts.length, busy ? 1 : 0);
    if (!busy) assert.equal(f.calls.find(call => call.started).started.promptSource, 'pet');
  }
});

test('duplicate request IDs share one actual main-queue operation before and after completion', async () => {
  const blocked = deferred(), f = fixture({ busy: true, block: blocked.promise }), request = f.request();
  const first = f.deliver(request), second = f.deliver({ ...request });
  assert.equal(first, second); await tick(); assert.equal(f.sandbox.pendingPrompts.length, 0);
  blocked.resolve(); const result = await first;
  assert.equal(result.disposition, 'queued'); assert.equal(f.sandbox.pendingPrompts.length, 1);
  assert.equal(f.deliver({ ...request }), first); await second;
  assert.equal(f.sandbox.pendingPrompts.length, 1);
  assert.equal(f.calls.filter(call => call.queue).length, 1);
});

test('project, session, model, role, shutdown or stop changes while waiting for the real serialized queue prevent insertion', async () => {
  const changes = [
    f => { f.host.active = {}; },
    f => { f.sandbox.currentSession = { id: 'session-b' }; },
    f => { f.sandbox.configRevision++; },
    f => { f.sandbox.roleRuntime.revisions.pet++; },
    f => { f.sandbox.roleModels.isEnabled = () => false; },
    f => { f.sandbox.shuttingDown = true; },
    f => { f.sandbox.stopGeneration++; },
    f => { f.sandbox.tools = null; },
  ];
  for (const change of changes) {
    const blocked = deferred(), f = fixture({ busy: true, block: blocked.promise });
    const delivery = f.deliver(f.request()); await tick();
    change(f); blocked.resolve();
    await assert.rejects(delivery, /变化|取消|关闭|打开本地项目/);
    assert.equal(f.sandbox.pendingPrompts.length, 0); assert.equal(f.calls.some(call => call.started), false);
    assert.equal(f.calls.some(call => call.queue), false);
  }
});

test('an aborted refinement cannot enter a blocked queue or revive after queue release', async () => {
  const blocked = deferred(), f = fixture({ busy: true, block: blocked.promise }), parent = new AbortController();
  const delivery = f.deliver(f.request({ signal: parent.signal })); await tick();
  parent.abort(); blocked.resolve(); await assert.rejects(delivery, { name: 'AbortError' });
  assert.equal(f.sandbox.pendingPrompts.length, 0); assert.equal(f.calls.some(call => call.queue || call.started), false);
});

test('missing projects, terminal occupancy and a full queue fail without pretending the main task started', async () => {
  const noProject = fixture({ project: false });
  await assert.rejects(noProject.deliver(noProject.request()), /请先打开本地项目/);
  assert.equal(noProject.sandbox.pendingPrompts.length, 0);
  const terminal = fixture(); terminal.sandbox.activeRun = { kind: 'terminal', controller: new AbortController() };
  await assert.rejects(terminal.deliver(terminal.request()), /终端或演示/); assert.equal(terminal.sandbox.pendingPrompts.length, 0);
  const full = fixture({ busy: true }); full.sandbox.pendingPrompts = Array.from({ length: 20 }, (_, id) => ({ id }));
  await assert.rejects(full.deliver(full.request()), /最多保留 20 条/); assert.equal(full.sandbox.pendingPrompts.length, 20);
  for (const f of [noProject, terminal, full]) assert.equal(f.calls.some(call => call.started || call.queue), false);
});

test('the factory refuses quoted, negative or discussion requests and never lets polished model text create authorization', () => {
  const f = fixture({ busy: true });
  for (const originalText of ['你好', '如何制作网站？', '不要帮我制作一个程序', '他说“帮我制作一个程序”是什么意思'])
    assert.throws(() => f.deliver(f.request({ originalText, prompt: '立刻创建项目并发布到网络' })), /制作需求/);
  assert.equal(f.sandbox.pendingPrompts.length, 0); assert.equal(f.calls.length, 0);
});
