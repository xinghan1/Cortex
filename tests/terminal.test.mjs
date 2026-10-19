import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TerminalSession } from '../src/core/terminal.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';

const success = values => JSON.stringify({ command: 'test', stdout: '', stderr: '', exitCode: 0, signal: null, terminated: null, ...values });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('delegates approval/execution to the workspace and emits only terminal events with cumulative output', async () => {
  const events = [];
  const calls = [];
  const session = new TerminalSession({
    onEvent: event => events.push(event),
    workspaceFactory: ({ onEvent }) => ({
      execute: async (...args) => {
        calls.push(args);
        onEvent({ type: 'approval', title: 'must not forward' });
        onEvent({ type: 'command-output', stream: 'stdout', text: 'first\n' });
        onEvent({ type: 'command-output', stream: 'stderr', text: 'warning\n' });
        onEvent({ type: 'command-output', stream: 'stdout', text: 'last\n' });
        return success({ stdout: 'first\nlast\n', stderr: 'warning\n' });
      },
    }),
  });
  assert.equal(session.running, false);
  const pending = session.run({ id: 'terminal-1', command: 'Write-Output first', timeoutMs: 999_999 });
  assert.equal(session.running, true);
  assert.equal(session.activeId, 'terminal-1');
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.id, 'terminal-1');
  assert.equal(result.result.output, 'first\nwarning\nlast\n');
  assert.equal(Object.hasOwn(result.result, 'stdout'), false);
  assert.equal(Object.hasOwn(result.result, 'stderr'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'run_command');
  assert.deepEqual(calls[0][1], { command: 'Write-Output first', timeout_ms: 120_000 });
  assert.ok(calls[0][2].signal instanceof AbortSignal);
  assert.deepEqual(events.map(event => event.type), ['terminal-start', 'terminal-output', 'terminal-output', 'terminal-output', 'terminal-end']);
  assert.deepEqual(events.filter(event => event.type === 'terminal-output').map(event => event.text), ['first\n', 'first\nwarning\n', 'first\nwarning\nlast\n']);
  assert.equal(events[2].stream, 'stderr');
  assert.equal(events[2].replace, true);
  assert.equal(events.at(-1).exitCode, 0);
  assert.equal(session.activeId, null);
  assert.equal(session.stop(), false);
});

test('redacts commands, cumulative split credentials, final output and thrown errors', async () => {
  const secret = 'sk-local-terminal-credential';
  const events = [];
  const redact = value => value.replaceAll(secret, '[REDACTED]');
  let emitLate;
  const session = new TerminalSession({
    redact, onEvent: event => events.push(event),
    workspaceFactory: ({ onEvent }) => {
      emitLate = onEvent;
      return { execute: async () => {
        onEvent({ type: 'command-output', stream: 'stdout', text: secret.slice(0, 10) });
        onEvent({ type: 'command-output', stream: 'stderr', text: secret.slice(10) });
        return success({ command: secret, stdout: secret.slice(0, 10), stderr: secret.slice(10), unexpectedRawOutput: secret });
      } };
    },
  });
  const result = await session.run({ command: `Write-Output '${secret}'` });
  assert.equal(events[2].text, '[REDACTED]');
  assert.equal(result.result.output, '[REDACTED]');
  assert.equal(Object.hasOwn(result.result, 'stdout'), false);
  assert.equal(Object.hasOwn(result.result, 'stderr'), false);
  assert.equal(Object.hasOwn(result.result, 'unexpectedRawOutput'), false);
  assert.ok(!JSON.stringify(events.at(-1)).includes(secret.slice(0, 10)));
  assert.ok(!JSON.stringify(events.at(-1)).includes(secret.slice(10)));
  assert.ok(!JSON.stringify(events).includes(secret));
  const count = events.length;
  emitLate({ type: 'command-output', stream: 'stdout', text: 'late output' });
  assert.equal(events.length, count);
  const failed = new TerminalSession({ redact, onEvent: event => events.push(event), workspaceFactory: () => { throw new Error(`missing ${secret}`); } });
  const failure = await failed.run({ command: 'test' });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.result.error, 'missing [REDACTED]');
  assert.ok(!JSON.stringify(events).includes(secret));
});

test('redaction failure hides output and listeners cannot break process cleanup', async () => {
  const events = [];
  const session = new TerminalSession({
    redact: () => { throw new Error('redactor broke'); },
    onEvent: event => { events.push(event); throw new Error('listener broke'); },
    workspaceFactory: ({ onEvent }) => ({ execute: async () => {
      onEvent({ type: 'command-output', stream: 'stdout', text: 'secret-value' });
      return success({ stdout: 'secret-value' });
    } }),
  });
  const completed = await session.run({ command: 'secret-value' });
  assert.equal(completed.status, 'completed');
  assert.equal(session.running, false);
  assert.ok(!JSON.stringify(events).includes('secret-value'));
  assert.match(events[1].text, /隐藏/);
});

test('reports denial, failure exit code, timeout, output limit and malformed workspace responses', async () => {
  for (const [raw, expected, code] of [
    [JSON.stringify({ denied: true, message: 'refused' }), 'denied', null],
    [success({ exitCode: 7, stderr: 'failed' }), 'failed', 7],
    [success({ terminated: 'timeout', exitCode: null }), 'failed', null],
    [success({ terminated: 'output_limit', exitCode: null }), 'failed', null],
    ['错误：PowerShell unavailable', 'failed', null],
    ['null', 'failed', null],
  ]) {
    const events = [];
    const session = new TerminalSession({ onEvent: event => events.push(event), workspaceFactory: () => ({ execute: async () => raw }) });
    const completed = await session.run({ command: 'test' });
    assert.equal(completed.status, expected);
    assert.equal(events.at(-1).exitCode, code);
    assert.equal(events.filter(event => event.type === 'terminal-end').length, 1);
    assert.equal(session.running, false);
  }
});

test('one command at a time, stop aborts its workspace signal and waits for process completion', async () => {
  const started = deferred();
  const closed = deferred();
  const events = [];
  let passedSignal;
  const session = new TerminalSession({
    onEvent: event => events.push(event),
    workspaceFactory: () => ({ execute: async (_name, _args, { signal }) => {
      passedSignal = signal;
      started.resolve();
      await closed.promise;
      return success({ exitCode: null, terminated: signal.aborted ? 'cancelled' : null });
    } }),
  });
  const pending = session.run({ id: 'first', command: 'Start-Sleep 10' });
  await started.promise;
  await assert.rejects(session.run({ command: 'second' }), { code: 'TERMINAL_BUSY' });
  assert.equal(session.activeId, 'first');
  assert.equal(session.stop(), true);
  assert.equal(passedSignal.aborted, true);
  assert.equal(session.running, true);
  assert.equal(events.some(event => event.type === 'terminal-end'), false);
  closed.resolve();
  assert.equal((await pending).status, 'stopped');
  assert.equal(events.filter(event => event.type === 'terminal-start').length, 1);
  assert.equal(session.running, false);
});

test('external abort reaches the workspace and pre-aborted runs never execute a command', async () => {
  const controller = new AbortController();
  const started = deferred();
  const session = new TerminalSession({ workspaceFactory: () => ({ execute: async (_name, _args, { signal }) => {
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('command aborted');
  } }) });
  const pending = session.run({ command: 'test', signal: controller.signal });
  await started.promise;
  controller.abort();
  assert.equal((await pending).status, 'stopped');
  let factoryCalls = 0;
  const preAborted = new TerminalSession({ workspaceFactory: () => { factoryCalls += 1; } });
  assert.equal((await preAborted.run({ command: 'test', signal: controller.signal })).status, 'stopped');
  assert.equal(factoryCalls, 0);
});

test('rejects invalid commands before creating a workspace and bounds timeout values', async () => {
  let calls = 0;
  const timeouts = [];
  const session = new TerminalSession({ workspaceFactory: () => { calls += 1; return { execute: async (_name, args) => { timeouts.push(args.timeout_ms); return success(); } }; } });
  for (const command of [undefined, '', '   ', 'bad\0input', 'x'.repeat(16_001), 123]) await assert.rejects(session.run({ command }), /PowerShell/);
  assert.equal(calls, 0);
  await session.run({ command: 'test', timeoutMs: -1 });
  await session.run({ command: 'test', timeoutMs: NaN });
  assert.deepEqual(timeouts, [1_000, 60_000]);
});

const shell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'pwsh';
const powerShellAvailable = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, stdio: 'ignore' }).status === 0;

test('executes a real approved local PowerShell command at the workspace root with UTF-8 output', { skip: !powerShellAvailable }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-terminal-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('forgedesk-terminal-test-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const events = [];
  const approvals = [];
  const session = new TerminalSession({
    onEvent: event => events.push(event),
    workspaceFactory: ({ onEvent }) => new WorkspaceTools(root, { onEvent, approve: async approval => { approvals.push(approval); return true; } }),
  });
  const completed = await session.run({ command: "Write-Output 'terminal-module-ok 中文测试'; Write-Output (Get-Location).Path" });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.result.exitCode, 0);
  assert.match(completed.result.output, /terminal-module-ok 中文测试/);
  assert.ok(completed.result.output.toLowerCase().includes(root.toLowerCase()));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'command');
  assert.match(approvals[0].detail, /系统沙箱/);
  assert.ok(events.some(event => event.type === 'terminal-output' && event.text.includes('中文测试')));
});
