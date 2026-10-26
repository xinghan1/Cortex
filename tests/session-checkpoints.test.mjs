import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { Store } = require('../src/core/store.cjs');
const { SessionCheckpoints, recoverInterruptedSession } = require('../src/core/session-checkpoints.cjs');
const root = path.resolve('tests/.tmp');
const crypto = { isEncryptionAvailable: () => false };
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function fixture(options = {}) {
  const session = { id: randomUUID(), workspace: 'C:/checkpoint-project', title: 'Task',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: 'user-one', role: 'user', content: 'Keep my entire original request.' }], events: [] };
  const run = { id: randomUUID(), sessionId: session.id, startedAt: 1000, messageStartIndex: 0 };
  const saves = [], errors = [];
  const writer = new SessionCheckpoints({ session, run, ownerId: 'process-a',
    save: async snapshot => { saves.push(structuredClone(snapshot)); }, onError: error => errors.push(error), ...options });
  return { session, run, saves, errors, writer };
}
async function storage(t) {
  await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'checkpoints-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(dir).startsWith('checkpoints-')); await fs.rm(dir, { recursive: true, force: true }); });
  const store = new Store(dir, crypto); await store.init(); return { dir, store };
}

test('first user and safe streamed partial survive simulated crash/reload, without mutating live transcript', async t => {
  const { dir, store } = await storage(t), session = store.createSession('C:/checkpoint-project');
  session.messages.push({ role: 'user', content: 'Keep the complete request and attachments metadata.' });
  const run = { id: randomUUID(), sessionId: session.id, startedAt: Date.now() - 100, messageStartIndex: 0 };
  const writer = new SessionCheckpoints({ session, run, ownerId: 'old-process', save: snapshot => store.saveSession(snapshot) });
  writer.touch(); await writer.flush();
  assert.equal((await store.getSession(session.id)).messages[0].content, session.messages[0].content);
  writer.observe({ type: 'text-delta', text: 'first ' }); writer.observe({ type: 'text-delta', text: 'partial' }); await writer.flush(); writer.dispose();
  assert.equal(session.messages.length, 1); assert.equal(session.runCheckpoint, undefined);
  const fresh = new Store(dir, crypto); await fresh.init(); const recovered = await fresh.getSession(session.id);
  const partial = recovered.messages.at(-1); assert.equal(partial.content, 'first partial'); assert.equal(partial.localOnly, true);
  assert.deepEqual(partial.toolCalls, []); assert.equal(partial.providerState, undefined);
  assert.equal(recoverInterruptedSession(recovered, { ownerId: 'new-process' }), true);
  assert.equal(recovered.messages.length, 2); assert.equal(recovered.runCheckpoint, undefined);
  assert.match(recovered.messages.at(-1).content, /first partial\n\n\[本次响应因程序异常退出而未完成\]/u);
  assert.equal(recovered.events.at(-1).status, 'stopped'); assert.equal(recovered.taskRuns.at(-1).status, 'stopped');
  assert.ok(Number.isFinite(recovered.taskRuns.at(-1).elapsedMs));
  assert.equal(recoverInterruptedSession(recovered, { ownerId: 'third-process' }), false);
  assert.equal(recovered.messages.at(-1).content.match(/本次响应因程序异常退出而未完成/gu).length, 1);
  await fresh.saveSession(recovered); assert.equal((await fresh.getSession(session.id)).messages.length, 2);
});

test('continuous stream uses non-sliding max interval while short bursts use one debounce write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0; const at = [];
  const f = fixture({ debounceMs: 100, maxIntervalMs: 250, save: async () => at.push(clock) });
  t.after(() => f.writer.dispose());
  for (let index = 0; index < 30; index++) {
    f.writer.observe({ type: 'text-delta', text: '.' }); clock += 20; t.mock.timers.tick(20); await settle();
  }
  assert.ok(at.length >= 2); assert.ok(at[0] <= 260); assert.ok(at[1] - at[0] <= 260);
  clock += 110; t.mock.timers.tick(110); await settle();
  const before = at.length;
  for (let index = 0; index < 50; index++) f.writer.observe({ type: 'text-delta', text: 'burst' });
  clock += 99; t.mock.timers.tick(99); await settle(); assert.equal(at.length, before);
  clock++; t.mock.timers.tick(1); await settle(); assert.equal(at.length, before + 1);
});

test('in-flight bursts coalesce and final committed snapshot is strictly last after a running save', async () => {
  let release, active = 0, maxActive = 0; const saves = [];
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ save: async snapshot => { active++; maxActive = Math.max(maxActive, active); saves.push(snapshot);
    if (saves.length === 1) await gate; active--; } });
  f.writer.observe({ type: 'text-delta', text: 'old partial' }); const running = f.writer.flush(); await settle();
  for (let index = 0; index < 1000; index++) f.writer.observe({ type: 'text-delta', text: 'x' });
  f.session.messages.push({ role: 'assistant', content: 'Final committed answer', toolCalls: [], providerState: { signed: 'native' } });
  const final = f.writer.finish(); release(); await Promise.all([running, final]);
  assert.equal(maxActive, 1); assert.equal(saves.length, 2);
  assert.equal(saves[0].runCheckpoint.status, 'running'); assert.equal(saves[1].runCheckpoint, undefined);
  assert.equal(saves[1].messages.length, 2); assert.equal(saves[1].messages.at(-1).content, 'Final committed answer');
  assert.deepEqual(saves[1].messages.at(-1).providerState, { signed: 'native' });
  assert.equal(f.writer.pending, false); f.writer.dispose();
});

test('temporary sessions schedule no timers and make no writes, including immediate/final saves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); f.session.temporary = true;
  f.writer.observe({ type: 'text-delta', text: 'private temporary text' }); f.writer.touch({ immediate: true });
  await f.writer.flush(); await f.writer.finish(); t.mock.timers.tick(10000); await settle();
  assert.deepEqual(f.saves, []); assert.equal(f.writer.pending, false); f.writer.dispose();
});

test('failed writes reject and notify once, preserve last valid JSON and permit explicit final retry', async t => {
  const { store } = await storage(t); let fail = false; const errors = [];
  const f = fixture({ save: snapshot => fail ? Promise.reject(Object.assign(new Error('disk unavailable'), { code: 'EACCES' })) : store.saveSession(snapshot),
    onError: error => errors.push(error) });
  f.writer.touch(); await f.writer.flush(); const previous = await store.getSession(f.session.id);
  fail = true; f.writer.observe({ type: 'text-delta', text: 'latest bytes' });
  await assert.rejects(f.writer.flush(), /disk unavailable/); await assert.rejects(f.writer.flush(), /disk unavailable/);
  assert.equal(errors.length, 1); assert.deepEqual(await store.getSession(f.session.id), previous);
  fail = false; f.session.messages.push({ role: 'assistant', content: 'Retried final answer', toolCalls: [] }); await f.writer.finish();
  const final = await store.getSession(f.session.id); assert.equal(final.runCheckpoint, undefined);
  assert.equal(final.messages.at(-1).content, 'Retried final answer'); f.writer.dispose();
});

test('finish attempts final snapshot even when an older blocked running save fails', async () => {
  let rejectFirst; const saves = [], errors = [];
  const f = fixture({ onError: error => errors.push(error), save: snapshot => {
    saves.push(snapshot); return saves.length === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(); } });
  f.writer.touch(); const running = f.writer.flush(); await settle();
  const final = f.writer.finish(); rejectFirst(new Error('old running snapshot failed'));
  await assert.rejects(running, /old running snapshot failed/); await final;
  assert.equal(errors.length, 1); assert.equal(saves.length, 2); assert.equal(saves.at(-1).runCheckpoint, undefined); f.writer.dispose();
});

test('replacement streams, retry reset, committed assistant and tool results clear provisional projections', async () => {
  const f = fixture();
  f.writer.observe({ type: 'text-delta', text: 'wrong' }); f.writer.observe({ type: 'text-delta', text: 'replacement', replace: true });
  await f.writer.flush(); assert.equal(f.saves.at(-1).messages.at(-1).content, 'replacement');
  f.writer.observe({ type: 'reconnect', resetText: true }); await f.writer.flush(); assert.equal(f.saves.at(-1).messages.length, 1);
  f.writer.observe({ type: 'text-delta', text: 'now committed' });
  f.session.messages.push({ role: 'assistant', content: 'now committed', toolCalls: [] });
  f.writer.observe({ type: 'assistant-message', text: 'now committed' });
  f.session.events.push({ type: 'tool-start', runId: f.run.id, toolCallId: 'command-a', name: 'run_command' });
  f.writer.observe(f.session.events.at(-1)); f.writer.observe({ type: 'command-output', toolCallId: 'command-a', text: 'one' });
  f.writer.observe({ type: 'command-output', toolCallId: 'command-a', text: ' two' }); await f.writer.flush();
  assert.equal(f.saves.at(-1).messages.length, 2); assert.equal(f.saves.at(-1).events.at(-1).text, 'one two');
  const done = { type: 'tool-result', runId: f.run.id, toolCallId: 'command-a', name: 'run_command', result: 'Entire committed result' };
  f.session.events.push(done); f.writer.observe(done); await f.writer.flush();
  assert.equal(f.saves.at(-1).events.some(event => event.type === 'command-output'), false);
  assert.equal(f.saves.at(-1).events.at(-1).result, 'Entire committed result'); f.writer.dispose();
});

test('recovery preserves executed results and native state, pairs only missing tools with explicit uncertainty', async () => {
  const f = fixture(); const native = { provider: 'doubao', message: { encrypted_content: 'opaque-signature' } };
  const assistant = { role: 'assistant', content: 'Executing two tools', providerState: native,
    toolCalls: [{ id: 'done-one', name: 'read_file', arguments: {} }, { id: 'unknown-two', name: 'run_command', arguments: {} }] };
  f.session.messages.push(assistant, { role: 'tool', toolCallId: 'done-one', content: 'Entire completed output'.repeat(10000) });
  f.session.events.push({ type: 'tool-start', runId: f.run.id, toolCallId: 'unknown-two', name: 'run_command' },
    { type: 'tool-result', runId: f.run.id, toolCallId: 'done-one', name: 'read_file', result: 'Known completed read' });
  f.writer.touch(); await f.writer.flush(); f.writer.dispose();
  const recovered = f.saves.at(-1); recovered.runCheckpoint.savedAt = new Date(4500).toISOString();
  assert.equal(recoverInterruptedSession(recovered, { ownerId: 'process-b', now: 90000 }), true);
  assert.deepEqual(recovered.messages[1].providerState, native); assert.equal(recovered.messages[2].content, f.session.messages[2].content);
  const uncertain = recovered.messages[3]; assert.equal(uncertain.role, 'tool'); assert.equal(uncertain.toolCallId, 'unknown-two');
  assert.match(uncertain.content, /无法确认.*执行结果/u); assert.match(uncertain.content, /不可据此直接重跑/u);
  assert.equal(recovered.events.filter(event => event.type === 'tool-result' && event.toolCallId === 'done-one').length, 1);
  const stopped = recovered.events.find(event => event.type === 'tool-result' && event.toolCallId === 'unknown-two');
  assert.equal(JSON.parse(stopped.result).status, 'stopped'); assert.equal(recovered.taskRuns[0].elapsedMs, 3500);
  assert.equal(recovered.taskRuns[0].endedAt, 4500); assert.equal(recovered.taskRuns[0].recoveredAt, 90000);
});

test('official agent tool events and active command output recover stopped without inventing model tool messages', async () => {
  const f = fixture(); f.session.events.push({ type: 'tool-start', runId: f.run.id, toolCallId: 'official-tool', name: 'run_command' });
  f.writer.observe(f.session.events[0]); f.writer.observe({ type: 'command-output', toolCallId: 'official-tool', text: 'observed real output' });
  f.writer.observe({ type: 'text-delta', text: 'Visible official response', replace: true });
  await f.writer.flush(); f.writer.dispose(); const recovered = f.saves[0];
  recoverInterruptedSession(recovered, { ownerId: 'next-process', now: 5000 });
  assert.equal(recovered.messages.filter(message => message.role === 'tool').length, 0);
  assert.equal(recovered.events.find(event => event.type === 'command-output').text, 'observed real output');
  assert.equal(JSON.parse(recovered.events.find(event => event.type === 'tool-result').result).status, 'stopped');
  assert.equal(recovered.messages.at(-1).localOnly, true);
});

test('current process checkpoints are not recovered; foreign events and session identity changes cannot cross-write', async () => {
  const f = fixture(); f.writer.touch(); await f.writer.flush(); const saved = f.saves[0], original = structuredClone(saved);
  assert.equal(recoverInterruptedSession(saved, { ownerId: 'process-a' }), false); assert.deepEqual(saved, original);
  f.writer.observe({ type: 'text-delta', runId: 'unrelated-run', text: 'Do not save elsewhere' });
  f.writer.observe({ type: 'text-delta', sessionId: 'unrelated-session', text: 'Do not save elsewhere' });
  await f.writer.flush(); assert.equal(f.saves.length, 1);
  f.session.id = randomUUID(); f.writer.touch(); await assert.rejects(f.writer.flush(), /未跨会话保存/u);
  assert.equal(f.saves.length, 1); f.writer.dispose();
});

test('disposing a crash fixture stops scheduled writes without finalizing the persisted running marker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  f.writer.touch(); await f.writer.flush(); f.writer.observe({ type: 'text-delta', text: 'unsaved tail' }); f.writer.dispose();
  t.mock.timers.tick(20000); await settle(); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].runCheckpoint.status, 'running');
});


test('critical message/tool/commit events start a durable write without waiting for debounce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const types = ['assistant-message', 'tool-start', 'tool-result', 'user-message', 'file-change-recorded', 'context-compacted', 'approval-resolved', 'run-start'];
  for (const type of types) {
    const f = fixture({ debounceMs: 1000, maxIntervalMs: 2000 });
    f.writer.observe({ type, toolCallId: 'tool-one', name: 'read_file' }); await settle();
    assert.equal(f.saves.length, 1, type + ' must save before advancing any timer'); f.writer.dispose();
  }
  const delayed = fixture({ debounceMs: 350, maxIntervalMs: 2000 });
  delayed.writer.observe({ type: 'text-delta', text: 'ordinary stream' }); await settle(); assert.equal(delayed.saves.length, 0);
  t.mock.timers.tick(349); await settle(); assert.equal(delayed.saves.length, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(delayed.saves.length, 1); delayed.writer.dispose();
});

test('recovery visibly marks only its unsigned provisional partial and keeps all other local-only/native content unchanged', async () => {
  const f = fixture();
  const old = { role: 'assistant', content: 'Old local note', localOnly: true, toolCalls: [] };
  const native = { role: 'assistant', content: 'Signed complete answer', localOnly: true, toolCalls: [],
    checkpointRunId: f.run.id, providerState: { encrypted_content: 'signed' } };
  f.session.messages.push(old, native); f.writer.observe({ type: 'text-delta', text: 'Actual unfinished bytes' }); await f.writer.flush(); f.writer.dispose();
  const recovered = f.saves.at(-1); recoverInterruptedSession(recovered, { ownerId: 'new-process' });
  assert.equal(recovered.messages[1].content, old.content); assert.equal(recovered.messages[2].content, native.content);
  assert.deepEqual(recovered.messages[2].providerState, native.providerState);
  assert.equal(recovered.messages.at(-1).content, 'Actual unfinished bytes\n\n[本次响应因程序异常退出而未完成]');
});


test('recovery timing excludes offline downtime and clamps a skewed start to the last known checkpoint', async () => {
  for (const startedAt of [1000, 9000]) {
    const f = fixture(); f.writer.touch(); await f.writer.flush(); f.writer.dispose(); const snapshot = f.saves[0];
    Object.assign(snapshot.runCheckpoint, { startedAt, savedAt: new Date(5000).toISOString() });
    recoverInterruptedSession(snapshot, { ownerId: 'process-after-days-offline', now: 172800000 });
    const ended = snapshot.events.at(-1); assert.equal(ended.endedAt, 5000); assert.equal(ended.recoveredAt, 172800000);
    assert.equal(ended.startedAt, Math.min(startedAt, 5000)); assert.equal(ended.elapsedMs, Math.max(0, 5000 - startedAt));
    assert.ok(ended.startedAt <= ended.endedAt);
  }
});


test('slow background writes yield to debounce while an explicit barrier still drains the freshest snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const saves = [], releases = [];
  let active = 0, maximum = 0;
  const f = fixture({ save: snapshot => {
    saves.push(snapshot); active++; maximum = Math.max(maximum, active);
    if (saves.length > 2) { active--; return Promise.resolve(); }
    return new Promise(resolve => releases.push(() => { active--; resolve(); }));
  } });
  f.writer.observe({ type: 'text-delta', text: 'first' }); t.mock.timers.tick(350); await settle(); assert.equal(saves.length, 1);
  for (let index = 0; index < 20; index++) { f.writer.observe({ type: 'text-delta', text: '.' }); t.mock.timers.tick(10); await settle(); }
  releases.shift()(); await settle(); assert.equal(saves.length, 1, 'Slow ordinary I/O must not loop immediately into another snapshot');
  t.mock.timers.tick(349); await settle(); assert.equal(saves.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(saves.length, 2);
  f.writer.observe({ type: 'text-delta', text: ' newest' }); const barrier = f.writer.flush();
  releases.shift()(); await barrier; assert.equal(saves.length, 3, 'Explicit barrier must immediately persist bytes received during the previous background write');
  assert.equal(saves.at(-1).messages.at(-1).content, 'first' + '.'.repeat(20) + ' newest');
  assert.equal(maximum, 1); await f.writer.finish(); assert.equal(saves.length, 4); assert.equal(saves.at(-1).runCheckpoint, undefined); f.writer.dispose();
});

test('rescheduling after a slow background write retains the first dirty max deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const saves = []; let release;
  const f = fixture({ save: snapshot => { saves.push(snapshot); return saves.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); } });
  f.writer.observe({ type: 'text-delta', text: 'initial' }); t.mock.timers.tick(350); await settle();
  f.writer.observe({ type: 'text-delta', text: ' while blocked' });
  t.mock.timers.tick(1800); await settle(); assert.equal(saves.length, 1);
  release(); await settle(); assert.equal(saves.length, 1);
  t.mock.timers.tick(199); await settle(); assert.equal(saves.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(saves.length, 2, 'The original 2-second deadline must beat a fresh 350ms debounce'); f.writer.dispose();
});
