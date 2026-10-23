import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/command-result.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const describe = (args, raw) => context.ForgeCommandResult.describe(args, raw);

test('exit code determines command success independently of diagnostic output', () => {
  assert.equal(describe({}, { exitCode: 0, stderr: 'warning: optional feature unavailable\n' }).status, 'success');
  for (const exitCode of [1, 2, 255, -1]) {
    const value = describe({}, { exitCode, stdout: 'All checks passed\n', stderr: '' });
    assert.equal(value.status, 'failed', 'Friendly output text must not override a nonzero exit code');
    assert.equal(value.exitCode, exitCode);
  }
});

test('unconfirmed command cleanup never claims that the process stopped or succeeded', () => {
  for (const terminated of ['cancelled', 'timeout', 'error']) {
    const value = describe({}, { terminated, exitCode: null, processExitObserved: false, cleanupPending: true, outputIncomplete: true });
    assert.match(value.label, /停止等待/);
    assert.match(value.detail, /尚未确认进程退出/);
    assert.notEqual(value.status, 'success');
    assert.equal(value.exitCode, null);
  }
  assert.notEqual(describe({}, { exitCode: 0, processExitObserved: false, cleanupPending: true }).status, 'success');
});

test('incomplete output preserves the observed exit code and explains remaining child-process uncertainty', () => {
  for (const exitCode of [0, 7]) {
    const value = describe({}, { exitCode, processExitObserved: true, outputIncomplete: true,
      cleanupPending: true, processTreeTerminationConfirmed: false });
    assert.equal(value.status, exitCode === 0 ? 'success' : 'failed');
    assert.equal(value.exitCode, exitCode);
    assert.match(value.detail, /部分日志可能缺失/);
    assert.match(value.detail, /尚未确认所有子进程退出/);
  }
});

test('a bounded output preview preserves the real command exit status and old interruption records', () => {
  const preview = { stdout: 'head\n[中间输出已省略]\ntail\n', stderr: '', outputTruncated: true, outputBytes: 200_000 };
  for (const [result, expected] of [
    [{ ...preview, exitCode: 0 }, 'success'],
    [{ ...preview, exitCode: 7 }, 'failed'],
    [{ ...preview, exitCode: 0, terminated: 'timeout' }, 'timeout'],
    [{ ...preview, exitCode: null, terminated: 'cancelled' }, 'cancelled'],
    [{ ...preview }, 'unknown'],
    [{ exitCode: null, terminated: 'output_limit' }, 'output-limit'],
  ]) {
    const actual = describe({}, JSON.stringify(result));
    assert.equal(actual.status, expected);
    assert.equal(actual.outputTruncated, result.outputTruncated === true);
    assert.equal(actual.outputBytes, result.outputBytes ?? null);
    if (result.stdout) assert.equal(actual.stdout, result.stdout);
  }
});

test('a known interruption or refusal takes precedence over exit zero', () => {
  const cases = [
    [{ denied: true, exitCode: 0, terminated: 'timeout' }, 'denied'],
    [{ canceled: true, exitCode: 0 }, 'denied'],
    [{ terminated: 'timeout', exitCode: 0, error: 'process was terminated' }, 'timeout'],
    [{ terminated: 'output_limit', exitCode: 0 }, 'output-limit'],
    [{ terminated: 'cancelled', exitCode: 0 }, 'cancelled'],
    [{ terminated: 'other-stop-reason', exitCode: 0 }, 'stopped'],
    [{ error: 'failed to initialize process', exitCode: 0 }, 'failed'],
    [{ signal: 'SIGTERM', exitCode: 0 }, 'stopped'],
    [{ signal: 'SIGKILL', exitCode: 2 }, 'stopped']
  ];
  for (const [result, expected] of cases) {
    const value = describe({}, result);
    assert.equal(value.status, expected, JSON.stringify(result));
    assert.ok(value.label.length > 0, 'Each outcome needs a readable status');
  }
});

test('missing, malformed, or unrelated completion data never establishes success', () => {
  const results = [null, false, 0, [], {}, { passed: true }, { status: 'completed' },
    { stdout: 'SUCCESS', stderr: '' }, { exitCode: '0' }, { exitCode: 0.5 }, { exitCode: NaN }, { exitCode: Infinity }];
  for (const result of results) {
    const value = describe({}, result);
    assert.equal(value.status, 'unknown', JSON.stringify(result));
    assert.equal(value.exitCode, null);
  }
  assert.equal(describe({}, undefined).status, 'running', 'A not-yet-returned tool call remains in progress');
});

test('stored JSON results and live objects produce equivalent readable fields', () => {
  const args = { command: 'Get-Location\nGet-ChildItem', timeout_ms: 120000 };
  const result = { command: args.command, exitCode: 0, signal: null, terminated: null, stdout: 'ok\n', stderr: '' };
  assert.deepEqual(describe(args, JSON.stringify(result)), describe(args, result));
  assert.deepEqual(describe(JSON.stringify(args), result), describe(args, result));
  assert.equal(describe(args, result).timeoutMs, 120000);
});

test('stdout, stderr, and multiline commands retain exact text instead of JSON escape syntax', () => {
  const command = 'Write-Output "中文 \\路径 <img src=x>"\r\nGet-Location\n';
  const stdout = '第一行\r\n第二行\n引号 "quoted"，路径 C:\\src\\file.js，表情 🟢\r\n';
  const stderr = '诊断信息\r\n\tcontinued detail\n';
  const value = describe({ command }, JSON.stringify({ exitCode: 0, stdout, stderr }));
  assert.equal(value.command, command);
  assert.equal(value.stdout, stdout);
  assert.equal(value.stderr, stderr);
  assert.equal(value.status, 'success');
});

test('the actual executed command and explicit modern stdout take precedence over legacy fields', () => {
  const value = describe({ command: 'requested command' }, {
    command: 'actual command', exitCode: 0, stdout: '', output: 'obsolete compatibility output', stderr: ''
  });
  assert.equal(value.command, 'actual command');
  assert.equal(value.stdout, '');
  assert.equal(describe({}, { output: 'legacy output\r\n' }).stdout, 'legacy output\r\n');
  assert.equal(describe({}, { output: 'legacy output' }).status, 'unknown');
});

test('older plain-text tool results remain inspectable without inventing a success state', () => {
  for (const text of ['legacy output\nnext line\n', 'FORGEDESK_SMOKE_OK {"status":"completed"}', '{malformed JSON']) {
    const value = describe({ command: 'display only' }, text);
    assert.equal(value.status, 'unknown');
    assert.equal(value.output, text);
    assert.equal(value.command, 'display only');
  }
});

test('plain-text failures and structured error messages retain complete diagnostic details', () => {
  const error = '错误：无法启动 PowerShell：ENOENT\n    at original stack frame\n';
  assert.equal(describe({}, error).status, 'failed');
  assert.equal(describe({}, error).detail, error);
  assert.equal(describe({}, 'Error: missing executable').status, 'failed');
  assert.equal(describe({}, '工具执行失败：无法访问目录').status, 'failed');
  const structured = describe({}, { error: { message: 'failure\nfull detail\n', code: 'ENOENT' } });
  assert.equal(structured.status, 'failed');
  assert.equal(structured.detail, 'failure\nfull detail\n');
});

test('denied and cancelled legacy results do not imply a process was executed', () => {
  assert.equal(describe({}, '操作已停止，未执行该命令。').status, 'denied');
  const denied = describe({}, { denied: true, message: '用户拒绝了命令执行，未启动进程。' });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.detail, '用户拒绝了命令执行，未启动进程。');
});

test('formatting never changes saved arguments or the original result object', () => {
  const args = Object.freeze({ command: 'Write-Output "unchanged"', timeout_ms: 3000 });
  const result = Object.freeze({ command: args.command, exitCode: 2, stdout: 'original\r\n', stderr: 'full diagnostic\n',
    error: Object.freeze({ message: 'original failure', nested: Object.freeze({ code: 'KEEP' }) }) });
  const before = JSON.stringify({ args, result });
  describe(args, result);
  describe(args, JSON.stringify(result));
  assert.equal(JSON.stringify({ args, result }), before);
});
