import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalController } from '../src/core/approval-controller.mjs';
import { createRequire } from 'node:module';
const { approvalDecision } = createRequire(import.meta.url)('../src/core/approval-policy.cjs');
const request = { kind: 'command', title: '测试', command: 'npm.cmd test', detail: '项目测试' };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(initial = 'assist') {
  let mode = initial, nextId = 0;
  const pending = new Map(), events = [], calls = [];
  const controller = createApprovalController({ pending, getMode: () => mode, decide: approvalDecision, emit: event => events.push(event),
    redact: value => value.replaceAll('PRIVATE_SECRET', '[redacted]'), idFactory: () => 'approval-' + ++nextId,
    review: (operation, meta) => { const gate = deferred(); calls.push({ operation, ...meta, ...gate }); return gate.promise; },
  });
  return { pending, events, calls, controller, mode: value => { mode = value; controller.reconcile(); }, approve: (operation = request, meta = {}) => controller.approve(operation, { runId: 'run-1', workspaceId: 'project-1', ...meta }) };
}

test('safe rules and full mode approve synchronously without launching an AI request', async () => {
  for (const [mode, operation] of [['assist', { ...request, command: 'Get-Location' }], ['full', request]]) {
    const f = fixture(mode); assert.equal(await f.approve(operation), true);
    assert.equal(f.calls.length, 0); assert.equal(f.pending.size, 0);
    assert.deepEqual(f.events.map(event => event.type), ['approval-auto', 'approval-resolved']);
    assert.ok(f.events.every(event => event.id === 'approval-1' && event.runId === 'run-1' && event.workspaceId === 'project-1'));
  }
});

test('request mode publishes a manual callable pending entry and never invokes AI', async () => {
  const f = fixture('request'), result = f.approve();
  const done = f.pending.get('approval-1'); assert.equal(typeof done, 'function');
  assert.equal(done.request.reviewStatus, 'manual'); assert.equal(f.events[0].type, 'approval-request');
  assert.equal(f.controller.respond({ id: 'approval-1', approved: true }), true);
  assert.equal(await result, true); assert.equal(f.calls.length, 0); assert.equal(f.pending.size, 0);
  assert.equal(f.controller.respond({ id: 'approval-1', approved: false }), false);
});

test('assist waits for isolated review and rejects stale human responses while reviewing', async () => {
  const f = fixture(), result = f.approve(); await turn();
  assert.equal(f.events[0].type, 'approval-review'); assert.equal(f.pending.get('approval-1').request.reviewStatus, 'reviewing');
  assert.equal(f.events.some(event => event.type === 'approval-request'), false);
  assert.equal(f.controller.respond({ id: 'approval-1', approved: true }), false);
  f.calls[0].resolve({ decision: 'allow', reason: '必要测试' });
  assert.equal(await result, true); await f.controller.drain('run-1'); assert.equal(f.pending.size, 0);
  assert.ok(f.events.some(event => event.type === 'approval-auto' && event.reviewed));
  assert.deepEqual(f.events.map(event => event.type === 'approval-review' ? event.status : event.type), ['reviewing', 'allowed', 'approval-auto', 'approval-resolved']);
});

test('AI denial, legacy ask, malformed results and review failure deny without a human approval request', async () => {
  const denied = fixture(), deniedResult = denied.approve(); await turn();
  denied.calls[0].resolve({ decision: 'deny', reason: '无关广泛删除' }); assert.equal(await deniedResult, false);
  assert.ok(denied.events.some(event => event.type === 'approval-review' && event.status === 'denied'));
  for (const failure of ['ask', 'throw', 'missing', 'unknown', 'allow-without-reason']) {
    const f = fixture(), outcomes = [], result = f.approve(request, { onDecision: value => outcomes.push(value) }); await turn();
    if (failure === 'throw') f.calls[0].reject(new Error('PRIVATE_SECRET'));
    else f.calls[0].resolve(failure === 'missing' ? null : failure === 'allow-without-reason' ? { decision: 'allow' } : { decision: failure, reason: '无法确认用户授权范围。' });
    assert.equal(await result, false); await f.controller.drain('run-1'); assert.equal(f.pending.size, 0);
    assert.ok(f.events.some(event => event.type === 'approval-review' && event.status === 'denied'));
    assert.equal(f.events.some(event => event.type === 'approval-request' || event.status === 'manual'), false);
    assert.equal(f.controller.respond({ id: 'approval-1', approved: true }), false);
    assert.equal(JSON.stringify(f.events).includes('PRIVATE_SECRET'), false);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].approved, false); assert.equal(outcomes[0].reviewStatus, 'denied');
    assert.equal(typeof outcomes[0].reviewReason, 'string'); assert.equal(JSON.stringify(outcomes).includes('PRIVATE_SECRET'), false);
  }
});

test('decision callback runs exactly once with only the safe binary outcome and a readable denial reason', async () => {
  const f = fixture(), outcomes = [];
  const result = f.approve({ ...request, providerState: 'PRIVATE_STATE' }, { onDecision: value => outcomes.push(value) }); await turn();
  f.calls[0].resolve({ decision: 'deny', reason: '超出授权范围 PRIVATE_SECRET', rawResponse: 'PRIVATE_STATE' });
  assert.equal(await result, false); await f.controller.drain('run-1');
  assert.deepEqual(outcomes, [{ approved: false, reviewReason: '超出授权范围 [redacted]', reviewStatus: 'denied' }]);
  assert.equal(f.controller.respond({ id: 'approval-1', approved: true }), false); f.controller.reconcile();
  assert.equal(outcomes.length, 1); assert.equal(JSON.stringify(outcomes).includes('PRIVATE_'), false);
  const resolved = f.events.find(event => event.type === 'approval-resolved');
  assert.equal(resolved.reviewed, true); assert.equal(resolved.reviewReason, outcomes[0].reviewReason);
});

test('decision callback exceptions and rejected callback promises do not change the result', async () => {
  for (const asyncFailure of [false, true]) {
    const f = fixture(), outcomes = [];
    const result = f.approve(request, { onDecision: value => {
      outcomes.push(value);
      if (asyncFailure) return Promise.reject(new Error('callback failed'));
      throw new Error('callback failed');
    } }); await turn();
    f.calls[0].resolve({ decision: 'allow', reason: '用户目标内的必要测试。' });
    assert.equal(await result, true); await f.controller.drain('run-1'); await turn();
    assert.deepEqual(outcomes, [{ approved: true, reviewReason: '用户目标内的必要测试。', reviewStatus: 'allowed' }]);
    assert.equal(f.pending.size, 0);
  }
});

test('decision callbacks preserve request/full behavior and report cancellation without reviewer data', async () => {
  const manual = fixture('request'), manualOutcomes = [];
  const waiting = manual.approve(request, { onDecision: value => manualOutcomes.push(value) });
  manual.controller.respond({ id: 'approval-1', approved: false }); assert.equal(await waiting, false);
  assert.deepEqual(manualOutcomes, [{ approved: false, reviewReason: null, reviewStatus: 'manual' }]);
  const full = fixture('full'), autoOutcomes = [];
  assert.equal(await full.approve(request, { onDecision: value => autoOutcomes.push(value) }), true);
  assert.deepEqual(autoOutcomes, [{ approved: true, reviewReason: null, reviewStatus: 'auto' }]);
  const stopped = fixture(), parent = new AbortController(), stoppedOutcomes = []; parent.abort();
  assert.equal(await stopped.approve(request, { parentSignal: parent.signal, onDecision: value => stoppedOutcomes.push(value) }), false);
  assert.deepEqual(stoppedOutcomes, [{ approved: false, reviewReason: null, reviewStatus: 'cancelled' }]);
  assert.equal(stopped.calls.length, 0);
});

test('cancelled or superseded reviews cannot deliver another callback or leak an old review reason', async () => {
  const cancelled = fixture(), parent = new AbortController(), cancelledOutcomes = [];
  const stopped = cancelled.approve(request, { parentSignal: parent.signal, onDecision: value => cancelledOutcomes.push(value) }); await turn();
  parent.abort(); assert.equal(await stopped, false);
  cancelled.calls[0].resolve({ decision: 'allow', reason: 'PRIVATE_SECRET old review' }); await cancelled.controller.drain('run-1');
  assert.deepEqual(cancelledOutcomes, [{ approved: false, reviewReason: null, reviewStatus: 'cancelled' }]);
  const rerouted = fixture(), reroutedOutcomes = [];
  const result = rerouted.approve(request, { onDecision: value => reroutedOutcomes.push(value) }); await turn();
  rerouted.mode('request'); rerouted.calls[0].resolve({ decision: 'deny', reason: 'PRIVATE_SECRET old review' }); await turn();
  assert.equal(reroutedOutcomes.length, 0);
  rerouted.controller.respond({ id: 'approval-1', approved: false }); assert.equal(await result, false); await rerouted.controller.drain('run-1');
  assert.deepEqual(reroutedOutcomes, [{ approved: false, reviewReason: null, reviewStatus: 'manual' }]);
});

test('changing assist to request aborts the old generation and a late allow cannot approve', async () => {
  const f = fixture(), result = f.approve(); await turn();
  f.mode('request'); assert.equal(f.calls[0].signal.aborted, true);
  assert.ok(f.events.some(event => event.type === 'approval-review' && event.status === 'cancelled'));
  assert.equal(f.events.some(event => event.type === 'approval-resolved'), false, 'Rerouting must not resolve the operation');
  f.calls[0].resolve({ decision: 'allow', reason: '过期结果' }); await turn();
  assert.equal(f.pending.size, 1); assert.equal(f.pending.get('approval-1').request.reviewStatus, 'manual');
  assert.equal(f.events.some(event => event.type === 'approval-auto'), false);
  assert.equal(f.controller.respond({ id: 'approval-1', approved: false }), true); assert.equal(await result, false);
});

test('switching review model restarts review and ignores both stale allow and stale denial', async () => {
  for (const stale of ['allow', 'deny']) {
    const f = fixture(), result = f.approve(); await turn();
    f.controller.reconcile(); await turn(); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].signal.aborted, true);
    f.calls[0].resolve({ decision: stale, reason: '旧模型结果' }); await turn(); assert.equal(f.pending.size, 1);
    f.calls[1].resolve({ decision: 'allow', reason: '当前模型已批准' }); assert.equal(await result, true);
    assert.equal(f.events.filter(event => event.type === 'approval-auto').length, 1);
  }
});

test('changing manual to assist invalidates old human actions; changing to full resolves pending work', async () => {
  const f = fixture('request'), result = f.approve(); f.mode('assist'); await turn();
  assert.equal(f.controller.respond({ id: 'approval-1', approved: true }), false);
  f.mode('full'); assert.equal(await result, true); assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve({ decision: 'deny', reason: '已失效' }); await f.controller.drain('run-1');
  assert.equal(f.events.filter(event => event.type === 'approval-resolved').length, 1);
});

test('individual operation cancellation leaves sibling review and parent task untouched', async () => {
  const f = fixture(), parent = new AbortController(), childA = new AbortController(), childB = new AbortController();
  const a = f.approve(request, { signal: childA.signal, parentSignal: parent.signal });
  const b = f.approve(request, { signal: childB.signal, parentSignal: parent.signal }); await turn();
  childA.abort(); assert.equal(await a, false); assert.equal(parent.signal.aborted, false); assert.equal(childB.signal.aborted, false);
  assert.ok(f.events.some(event => event.type === 'approval-review' && event.status === 'cancelled' && event.id === 'approval-1'));
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[1].signal.aborted, false);
  f.calls[0].resolve({ decision: 'allow' }); f.calls[1].resolve({ decision: 'allow', reason: '独立审批' }); assert.equal(await b, true);
  await f.controller.drain('run-1'); assert.equal(f.pending.size, 0);
});

test('parent cancellation and legacy done(false) cancel pending reviews without leaving public signals', async () => {
  const f = fixture(), parent = new AbortController();
  const a = f.approve({ ...request, providerState: 'PRIVATE_STATE', command: 'echo PRIVATE_SECRET' }, { parentSignal: parent.signal });
  const b = f.approve(); await turn(); parent.abort(); assert.equal(await a, false);
  for (const done of f.pending.values()) done(false);
  assert.equal(await b, false); assert.ok(f.calls.every(call => call.signal.aborted));
  assert.equal(f.calls[0].operation.command, 'echo PRIVATE_SECRET', 'Reviewer must receive original bytes to detect redacted/incomplete content itself');
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_SECRET'), false); assert.equal(JSON.stringify(f.events).includes('PRIVATE_STATE'), false);
  assert.equal(JSON.stringify(f.events).includes('AbortSignal'), false);
  f.calls.forEach(call => call.resolve({ decision: 'allow' })); await f.controller.drain('run-1');
});

test('drain waits for cancelled reviews and usage finalizers after entries leave the pending map', async () => {
  const f = fixture(), result = f.approve(); await turn();
  f.pending.get('approval-1')(false); assert.equal(await result, false); assert.equal(f.pending.size, 0);
  let drained = false; const drain = f.controller.drain('run-1').then(() => { drained = true; }); await turn(); assert.equal(drained, false);
  f.calls[0].resolve({ decision: 'allow' }); await drain; assert.equal(drained, true);
  assert.equal(f.events.some(event => event.type === 'approval-auto'), false);
});

test('already-cancelled requests create no pending entry or model call', async () => {
  const f = fixture(), parent = new AbortController(); parent.abort();
  assert.equal(await f.approve(request, { parentSignal: parent.signal }), false);
  assert.equal(f.events.length, 0); assert.equal(f.pending.size, 0); assert.equal(f.calls.length, 0);
});
