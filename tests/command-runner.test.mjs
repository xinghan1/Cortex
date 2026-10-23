import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { runPowerShellCommand, waitForCommandRead, validateCommandDirectory } from '../src/core/command-runner.mjs';

class Child extends EventEmitter {
  constructor(pid = 12345) { super(); this.pid = pid; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.kills = []; this.unrefs = 0; }
  kill(signal) { this.kills.push(signal); return false; }
  unref() { this.unrefs++; }
}
function fixture(options = {}) {
  const child = new Child(), killer = new Child(23456), events = [], calls = [];
  const runtime = { platform: 'win32', stopGraceMs: 35, exitDrainMs: 20, killFallbackMs: 10,
    spawnImpl: (name, args, config) => { calls.push({ name, args, config }); return calls.length === 1 ? child : killer; }, ...options };
  const run = (signal, timeout = 5000) => runPowerShellCommand({ command: 'fixture', cwd: '.', env: {}, timeout, signal,
    onEvent: event => events.push(event) }, runtime);
  return { child, killer, events, calls, run };
}

test('normal exit preserves real status and head/tail output while releasing process listeners', async () => {
  const { child, events, run } = fixture(); const result = run();
  child.stdout.write('FIRST' + '中🙂'.repeat(20000) + 'LAST'); child.stderr.write('diagnostic');
  child.stdout.end(); child.stderr.end(); await immediate(); child.emit('exit', 7, null); child.emit('close', 7, null);
  const value = await result;
  assert.equal(value.exitCode, 7); assert.equal(value.terminated, null); assert.equal(value.processExitObserved, true);
  assert.equal(value.outputTruncated, true); assert.match(value.stdout, /^FIRST/u); assert.match(value.stdout, /LAST$/u);
  assert.equal(value.outputIncomplete, false); assert.equal(value.cleanupPending, false);
  assert.ok(events.some(event => event.outputTruncated)); assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('close'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
});

test('shell exit with inherited pipes still open returns its real exit code after a bounded drain', async () => {
  const { child, events, run, calls } = fixture(); const started = Date.now(), pending = run();
  child.stdout.write('before-exit'); child.emit('exit', 3, null);
  const value = await pending;
  assert.ok(Date.now() - started < 500); assert.equal(value.exitCode, 3); assert.equal(value.signal, null);
  assert.equal(value.terminated, null); assert.equal(value.processExitObserved, true);
  assert.equal(value.outputIncomplete, true); assert.equal(value.cleanupPending, true);
  assert.equal(value.processTreeTerminationConfirmed, false); assert.equal(calls.length, 1);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  const count = events.length; child.stdout.emit('data', Buffer.from('late')); child.emit('close', 0, null); child.emit('error', new Error('late error'));
  assert.equal(events.length, count); assert.equal(value.exitCode, 3);
});

test('abort settles even when taskkill, child.kill and stdio close all fail to finish', async () => {
  const { child, killer, run, calls } = fixture(); const controller = new AbortController();
  const started = Date.now(), pending = run(controller.signal); child.stdout.write('running'); controller.abort();
  const value = await pending;
  assert.ok(Date.now() - started < 500); assert.equal(value.terminated, 'cancelled');
  assert.equal(value.exitCode, null); assert.equal(value.signal, null); assert.equal(value.processExitObserved, false);
  assert.equal(value.terminationConfirmed, false); assert.equal(value.processTreeTerminationConfirmed, false);
  assert.equal(value.cleanupPending, true); assert.equal(value.outputIncomplete, true);
  assert.deepEqual(calls[1].args, ['/PID', '12345', '/T', '/F']); assert.equal(calls[1].config.windowsHide, true);
  assert.ok(child.kills.length >= 1); assert.deepEqual(killer.kills, ['SIGKILL']);
  assert.ok(child.unrefs > 0); assert.ok(killer.unrefs > 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(killer.listenerCount('exit'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
  killer.emit('error', new Error('late killer error')); child.emit('error', new Error('late command error'));
});

test('timeout uses the same bounded termination path without inventing a successful kill', async () => {
  const { run } = fixture(); const value = await run(undefined, 5);
  assert.equal(value.terminated, 'timeout'); assert.equal(value.terminationConfirmed, false);
  assert.equal(value.exitCode, null); assert.equal(value.cleanupPending, true);
});

test('successful taskkill waits for the shell status and reports observed tree termination', async () => {
  const { child, killer, run } = fixture(); const controller = new AbortController(), pending = run(controller.signal);
  controller.abort(); child.emit('exit', 1, null); child.emit('close', 1, null);
  let completed = false; pending.then(() => { completed = true; }); await immediate(); assert.equal(completed, false);
  killer.emit('exit', 0, null);
  const value = await pending;
  assert.equal(value.terminated, 'cancelled'); assert.equal(value.exitCode, 1); assert.equal(value.terminationConfirmed, true);
  assert.equal(value.processTreeTerminationConfirmed, true); assert.equal(value.cleanupPending, false);
  assert.equal(killer.kills.length, 0);
});

test('taskkill nonzero, launch error and synchronous launch failure fall back without blocking forever', async () => {
  for (const failure of ['nonzero', 'error', 'throw']) {
    const { child, killer, run } = fixture(failure === 'throw' ? { spawnImpl: (() => {
      let count = 0; return () => { if (++count === 1) return child; throw new Error('taskkill missing'); };
    })() } : {});
    const controller = new AbortController(), pending = run(controller.signal); controller.abort();
    if (failure === 'nonzero') killer.emit('exit', 1, null);
    if (failure === 'error') killer.emit('error', new Error('missing executable'));
    const value = await pending;
    assert.equal(value.terminationConfirmed, false); assert.equal(value.processTreeTerminationConfirmed, false);
    assert.ok(child.kills.length > 0);
  }
});

test('a shell that already exited is never killed by a stale PID when stop arrives during pipe drain', async () => {
  const { child, run, calls } = fixture(); const controller = new AbortController(), pending = run(controller.signal);
  child.emit('exit', 0, null); controller.abort(); const value = await pending;
  assert.equal(calls.length, 1); assert.equal(child.kills.length, 0);
  assert.equal(value.terminationConfirmed, true); assert.equal(value.processTreeTerminationConfirmed, false);
  assert.equal(value.exitCode, 0); assert.equal(value.outputIncomplete, true);
});

test('POSIX group-kill failure falls back and an unobserved shell remains unconfirmed', async () => {
  const groups = [];
  const { child, run } = fixture({ platform: 'linux', killProcess: (...args) => { groups.push(args); throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
  const controller = new AbortController(), pending = run(controller.signal); controller.abort();
  const value = await pending;
  assert.deepEqual(groups, [[-12345, 'SIGKILL'], [-12345, 0]]); assert.ok(child.kills.length > 0);
  assert.equal(value.terminationConfirmed, false);
});

test('an already-cancelled command never spawns and launch errors do not leak listeners', async () => {
  const controller = new AbortController(); controller.abort(); const { run, calls } = fixture();
  await assert.rejects(run(controller.signal), /已取消/u); assert.equal(calls.length, 0);
  const { child, run: start } = fixture(); child.pid = undefined;
  const pending = start(); child.emit('error', new Error('ENOENT'));
  await assert.rejects(pending, /无法启动 PowerShell/u); assert.equal(child.listenerCount('close'), 0);
});

test('read-only cancellation settles without launching later reads or observing late rejection as unhandled', async () => {
  const controller = new AbortController(); let rejectRead, reads = 0;
  const pending = waitForCommandRead(() => { reads++; return new Promise((_resolve, reject) => { rejectRead = reject; }); }, controller.signal);
  await immediate(); controller.abort(); await assert.rejects(pending, /已取消/u);
  rejectRead(new Error('disk disconnected')); await immediate(); assert.equal(reads, 1);
  await assert.rejects(waitForCommandRead(() => { reads++; }, controller.signal), /已取消/u);
  assert.equal(reads, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('read-only command preparation has a deadline and its late completion cannot start another validation step', async () => {
  let completeRead, continued = false;
  const pending = validateCommandDirectory(async signal => {
    await waitForCommandRead(() => new Promise(resolve => { completeRead = resolve; }), signal);
    continued = true;
  }, undefined, 15);
  await assert.rejects(pending, { code: 'COMMAND_PATH_UNAVAILABLE' });
  completeRead(); await immediate(); assert.equal(continued, false);
});
