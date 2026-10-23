import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testTempRoot } from './helpers/temp-root.mjs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { WorkspaceTools, TOOL_DEFINITIONS } from '../src/core/workspace.mjs';

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(testTempRoot, 'forgedesk-workspace-test-'));
  const root = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(async () => {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('forgedesk-workspace-test-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, outside, tools: new WorkspaceTools(root, options) };
}

const jsonResult = async promise => {
  const result = await promise;
  assert.ok(!result.startsWith('错误：'), result);
  return JSON.parse(result);
};

test('tool schemas are complete and expose only the implemented tools', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(tool => tool.name), [
    'list_files', 'read_file', 'search_files', 'write_file', 'replace_in_file', 'run_command', 'undo_last_change',
  ]);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test('AI approval denial stays structured and never writes or starts a command', async t => {
  const reason = 'AI 审批已拒绝：该操作超出当前任务范围。';
  const { root, tools } = await fixture(t, { approve: async () => { throw Object.assign(new Error(reason), { code: 'APPROVAL_DENIED' }); } });
  const write = await jsonResult(tools.execute('write_file', { path: 'denied.txt', content: 'must not be written' }));
  assert.deepEqual(write, { denied: true, message: reason });
  assert.equal(await fs.stat(path.join(root, 'denied.txt')).then(() => true, () => false), false);
  const command = await jsonResult(tools.execute('run_command', { command: 'echo must-not-start', timeout_ms: 1000 }));
  assert.deepEqual(command, { denied: true, message: reason });
  assert.equal(tools.history.length, 0);
});

test('AI denial of a manual undo preserves the changed bytes and its undo record', async t => {
  let deny = false;
  const { root, tools } = await fixture(t, { approve: async () => {
    if (deny) throw Object.assign(new Error('AI 审批已拒绝：撤销超出任务范围。'), { code: 'APPROVAL_DENIED' });
    return true;
  } });
  await jsonResult(tools.execute('write_file', { path: 'kept.txt', content: 'keep this change' }));
  deny = true;
  const result = await jsonResult(tools.undoLastChange());
  assert.equal(result.denied, true);
  assert.match(result.message, /AI 审批已拒绝/u);
  assert.equal(await fs.readFile(path.join(root, 'kept.txt'), 'utf8'), 'keep this change');
  assert.equal(tools.history.length, 1);
});

test('confinement rejects traversal, absolute, UNC, ADS and Windows device names before approval', async t => {
  let approvals = 0;
  const { tools } = await fixture(t, { approve: async () => { approvals += 1; return true; } });
  for (const unsafe of ['../outside/readme.txt', '..\\outside\\readme.txt', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\secret', '\\\\?\\C:\\test', 'notes.txt:secret', 'sub/../note.txt', 'NUL', 'dir./note', 'dir /note']) {
    assert.match(await tools.execute('write_file', { path: unsafe, content: 'blocked' }), /^错误：/, unsafe);
    await assert.rejects(tools.readFile({ path: unsafe }), undefined, unsafe);
  }
  assert.equal(approvals, 0);
});

test('protected directories, environment files and key files cannot be read or written', async t => {
  let approvals = 0;
  const { root, tools } = await fixture(t, { approve: async () => { approvals += 1; return true; } });
  await fs.writeFile(path.join(root, 'visible.txt'), 'visible');
  const protectedPaths = ['.git/config', '.codex/config', '.aws/credentials', 'node_modules/pkg/index.js', '.env', '.env.local', 'private.pem', 'private.KEY', 'client.p12', '.npmrc'];
  for (const relative of protectedPaths) {
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, 'sensitive');
    await assert.rejects(tools.readFile({ path: relative }));
    assert.match(await tools.execute('write_file', { path: relative, content: 'changed' }), /^错误：/);
    assert.equal(await fs.readFile(absolute, 'utf8'), 'sensitive');
  }
  assert.equal(approvals, 0);
  assert.deepEqual((await tools.listFiles()).map(entry => entry.name), ['visible.txt']);
});

test('a directory junction cannot escape the root for reads, writes or searches', async t => {
  const { root, outside, tools } = await fixture(t, { approve: async () => true });
  await fs.writeFile(path.join(outside, 'outside.txt'), 'unique-outside-secret');
  await fs.symlink(outside, path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.readFile({ path: 'shortcut/outside.txt' }), /符号链接|联接/);
  assert.match(await tools.execute('write_file', { path: 'shortcut/new.txt', content: 'unsafe' }), /^错误：/);
  assert.equal((await tools.listFiles()).some(entry => entry.name === 'shortcut'), false);
  assert.deepEqual((await jsonResult(tools.execute('search_files', { query: 'unique-outside-secret' }))).matches, []);
  await assert.rejects(fs.access(path.join(outside, 'new.txt')));
});

test('replacing the selected root with a junction invalidates the workspace', async t => {
  const { root, outside, tools } = await fixture(t);
  await fs.rename(root, `${root}-original`);
  await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.listFiles(), /项目根目录已变化/);
});

test('file reads accept UTF-8 and reject binary, malformed UTF-8 and oversized files', async t => {
  const { root, tools } = await fixture(t);
  await fs.writeFile(path.join(root, 'text.txt'), '你好，ForgeDesk\n');
  assert.deepEqual(await tools.readFile({ path: 'text.txt' }), { path: 'text.txt', content: '你好，ForgeDesk\n' });
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 65));
  await assert.rejects(tools.readFile({ path: 'binary.dat' }), /二进制/);
  await assert.rejects(tools.readFile({ path: 'invalid.txt' }), /UTF-8/);
  await assert.rejects(tools.readFile({ path: 'large.txt' }), /512 KB/);
});

test('writes are denied by default and denied requests have no side effects', async t => {
  const { root, tools } = await fixture(t);
  await fs.writeFile(path.join(root, 'existing.txt'), 'before');
  assert.equal((await jsonResult(tools.execute('write_file', { path: 'existing.txt', content: 'after' }))).denied, true);
  assert.equal((await jsonResult(tools.execute('write_file', { path: 'new/child.txt', content: 'after' }))).denied, true);
  assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), 'before');
  await assert.rejects(fs.access(path.join(root, 'new')));
});

test('approved writes carry the exact before/after diff, create parents and truncate shorter files', async t => {
  const requests = [];
  const { root, tools } = await fixture(t, { approve: async request => { requests.push(request); return true; } });
  await fs.writeFile(path.join(root, 'existing.txt'), 'long previous content');
  await jsonResult(tools.execute('write_file', { path: 'existing.txt', content: '短' }));
  await jsonResult(tools.execute('write_file', { path: 'new/sub/file.txt', content: 'created' }));
  assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), '短');
  assert.equal(await fs.readFile(path.join(root, 'new/sub/file.txt'), 'utf8'), 'created');
  assert.equal(requests[0].kind, 'write');
  assert.equal(requests[0].before, 'long previous content');
  assert.equal(requests[0].after, '短');
  assert.equal(requests[1].before, null);
});

test('approval requires literal true rather than a truthy value', async t => {
  const { root, tools } = await fixture(t, { approve: async () => 'yes' });
  assert.equal((await jsonResult(tools.execute('write_file', { path: 'no.txt', content: 'denied' }))).denied, true);
  await assert.rejects(fs.access(path.join(root, 'no.txt')));
});

test('an edit made while approval is pending is preserved', async t => {
  let root;
  const context = await fixture(t, {
    approve: async () => {
      await fs.writeFile(path.join(root, 'notes.txt'), 'user concurrent edit');
      return true;
    },
  });
  root = context.root;
  await fs.writeFile(path.join(root, 'notes.txt'), 'original');
  assert.match(await context.tools.execute('write_file', { path: 'notes.txt', content: 'model change' }), /错误：.*等待审批时已变化/);
  assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'user concurrent edit');
});

test('a new file created during approval is preserved', async t => {
  let root;
  const context = await fixture(t, { approve: async () => { await fs.writeFile(path.join(root, 'new.txt'), 'user creation'); return true; } });
  root = context.root;
  assert.match(await context.tools.execute('write_file', { path: 'new.txt', content: 'model creation' }), /错误：.*已创建或删除/);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'user creation');
});

test('a parent swapped for a junction during approval cannot redirect a write', async t => {
  let root, outside;
  const context = await fixture(t, {
    approve: async () => {
      await fs.rename(path.join(root, 'sub'), path.join(root, 'sub-original'));
      await fs.symlink(outside, path.join(root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    },
  });
  ({ root, outside } = context);
  await fs.mkdir(path.join(root, 'sub'));
  assert.match(await context.tools.execute('write_file', { path: 'sub/new.txt', content: 'escaped' }), /^错误：/);
  await assert.rejects(fs.access(path.join(outside, 'new.txt')));
});

test('replace requires exactly one occurrence and approves only that precise change', async t => {
  const requests = [];
  const { root, tools } = await fixture(t, { approve: async request => { requests.push(request); return true; } });
  await fs.writeFile(path.join(root, 'replace.txt'), 'alpha beta alpha');
  assert.match(await tools.execute('replace_in_file', { path: 'replace.txt', old_text: 'alpha', new_text: 'gamma' }), /错误：.*多次/);
  assert.match(await tools.execute('replace_in_file', { path: 'replace.txt', old_text: 'missing', new_text: 'gamma' }), /错误：.*未找到/);
  assert.equal(requests.length, 0);
  await jsonResult(tools.execute('replace_in_file', { path: 'replace.txt', old_text: 'beta', new_text: 'BETA' }));
  assert.equal(await fs.readFile(path.join(root, 'replace.txt'), 'utf8'), 'alpha BETA alpha');
  assert.equal(requests[0].before, 'alpha beta alpha');
  assert.equal(requests[0].after, 'alpha BETA alpha');
});

test('search skips dependencies, hidden paths, builds, symlinks and secrets, and caps results', async t => {
  const { root, tools } = await fixture(t);
  for (const relative of ['src/code.txt', 'dist/bundle.js', 'build/out.js', '.hidden/info.txt', '.hidden.txt', 'node_modules/pkg/index.js', '.env.local']) {
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, 'needle');
  }
  const found = await jsonResult(tools.execute('search_files', { query: 'NEEDLE' }));
  assert.deepEqual(found.matches, [{ path: 'src/code.txt', line: 1, text: 'needle' }]);
  assert.deepEqual((await jsonResult(tools.execute('search_files', { query: 'needle', path: 'dist' }))).matches, []);
  await fs.writeFile(path.join(root, 'many.txt'), Array.from({ length: 150 }, () => 'needle').join('\n'));
  const capped = await jsonResult(tools.execute('search_files', { query: 'needle' }));
  assert.equal(capped.matches.length, 100);
  assert.equal(capped.truncated, true);
});

test('undo restores the original content and preserves subsequent user edits', async t => {
  const requests = [];
  const { root, tools } = await fixture(t, { approve: async request => { requests.push(request); return true; } });
  await fs.writeFile(path.join(root, 'undo.txt'), 'original');
  await jsonResult(tools.execute('write_file', { path: 'undo.txt', content: 'model edit' }));
  await jsonResult(tools.undoLastChange());
  assert.equal(await fs.readFile(path.join(root, 'undo.txt'), 'utf8'), 'original');
  assert.equal(requests[1].before, 'model edit');
  assert.equal(requests[1].after, 'original');
  await jsonResult(tools.execute('write_file', { path: 'undo.txt', content: 'second model edit' }));
  await fs.writeFile(path.join(root, 'undo.txt'), 'user final content');
  const approvalCount = requests.length;
  assert.match(await tools.undoLastChange(), /错误：.*已变化/);
  assert.equal(requests.length, approvalCount);
  assert.equal(await fs.readFile(path.join(root, 'undo.txt'), 'utf8'), 'user final content');
});

test('undoing a new file explicitly approves deletion and rechecks pending concurrent changes', async t => {
  let changeDuringUndo = false;
  let root;
  const requests = [];
  const context = await fixture(t, { approve: async request => {
    requests.push(request);
    if (changeDuringUndo && request.after === null) await fs.writeFile(path.join(root, 'created.txt'), 'user edit');
    return true;
  } });
  root = context.root;
  await jsonResult(context.tools.execute('write_file', { path: 'created.txt', content: 'created' }));
  const removed = await jsonResult(context.tools.execute('undo_last_change'));
  assert.equal(removed.deleted, true);
  assert.match(requests[1].title, /删除/);
  assert.equal(requests[1].before, 'created');
  assert.equal(requests[1].after, null);
  await assert.rejects(fs.access(path.join(root, 'created.txt')));
  await jsonResult(context.tools.execute('write_file', { path: 'created.txt', content: 'created again' }));
  changeDuringUndo = true;
  assert.match(await context.tools.undoLastChange(), /错误：.*等待撤销审批时已变化/);
  assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'user edit');
});

test('listFiles uses relative forward slash paths and has a 500 entry bound', async t => {
  const { root, tools } = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'file.txt'), 'content');
  assert.deepEqual(await tools.listFiles({ path: 'nested' }), [{ name: 'file.txt', path: 'nested/file.txt', type: 'file' }]);
  await Promise.all(Array.from({ length: 510 }, (_, index) => fs.writeFile(path.join(root, `file-${index}.txt`), '')));
  assert.equal((await tools.listFiles()).length, 500);
});

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell = !spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).error;

test('command rejection never starts a process', async t => {
  const { root, tools } = await fixture(t);
  assert.equal((await jsonResult(tools.execute('run_command', { command: "Set-Content -LiteralPath 'sentinel.txt' -Value 'unsafe'" }))).denied, true);
  await assert.rejects(fs.access(path.join(root, 'sentinel.txt')));
});

test('command approval exposes a ten-minute default and cap while honoring explicit shorter timeouts without spawning', async t => {
  const requests = [], { root, tools } = await fixture(t, { approve: async request => { requests.push(request); return false; } });
  const cases = [
    [{}, 600], [{ timeout_ms: 900_000 }, 600], [{ timeout_ms: NaN }, 600],
    [{ timeout_ms: 45_000 }, 45], [{ timeout_ms: -1 }, 1],
  ];
  for (const [parameters, seconds] of cases) {
    const result = await jsonResult(tools.execute('run_command', {
      command: "Set-Content -LiteralPath 'timeout-sentinel.txt' -Value 'must not run'", ...parameters,
    }));
    assert.equal(result.denied, true);
    assert.ok(requests.at(-1).detail.includes(`最长运行：${seconds} 秒`));
  }
  const definition = TOOL_DEFINITIONS.find(tool => tool.name === 'run_command');
  assert.equal(definition.parameters.properties.timeout_ms.maximum, 600_000);
  assert.equal(definition.parameters.required.includes('timeout_ms'), false);
  assert.match(definition.description, /当前权限模式/);
  assert.match(definition.description, /默认和最长均为 10 分钟/);
  await assert.rejects(fs.access(path.join(root, 'timeout-sentinel.txt')));
});

test('approved commands run in the selected workspace and return stdout, stderr and exit status', { skip: !hasPowerShell }, async t => {
  const events = [];
  let approval;
  const { root, tools } = await fixture(t, {
    approve: async request => { approval = request; return true; },
    onEvent: event => events.push(event),
  });
  const result = await jsonResult(tools.execute('run_command', { command: "Write-Output 'forge-command-ok'; Write-Output (Get-Location).Path; [Console]::Error.WriteLine('diagnostic'); exit 3" }));
  assert.equal(result.exitCode, 3);
  assert.equal(result.terminated, null);
  assert.equal(result.outputTruncated, false);
  assert.equal(Object.hasOwn(result, 'output'), false, 'Ordinary command results do not duplicate their logs');
  assert.equal(result.outputBytes, Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr));
  assert.equal(result.outputOmittedBytes, 0);
  assert.match(result.stdout, /forge-command-ok/);
  assert.ok(result.stdout.toLowerCase().includes(root.toLowerCase()));
  assert.match(result.stderr, /diagnostic/);
  assert.equal(approval.kind, 'command');
  assert.match(approval.detail, /不在系统沙箱内/);
  assert.ok(events.some(event => event.type === 'command-output' && event.stream === 'stdout'));
});

test('large command output preserves stdout and stderr heads and tails without stopping subsequent work', { skip: !hasPowerShell }, async t => {
  const events = [];
  const { root, tools } = await fixture(t, { approve: async () => true, onEvent: event => events.push(event) });
  const result = await jsonResult(tools.execute('run_command', { command: "[Console]::Out.Write('STDOUT_START' + ('中🙂文' * 20000) + 'STDOUT_END'); [Console]::Error.Write('STDERR_START' + ('错误🙂' * 20000) + 'STDERR_END'); Set-Content -LiteralPath 'after-output.txt' -Value 'continued'; Write-Output 'COMMAND_FINISHED'; exit 7" }));
  assert.equal(result.terminated, null);
  assert.equal(result.exitCode, 7);
  assert.match(await fs.readFile(path.join(root, 'after-output.txt'), 'utf8'), /continued/);
  assert.match(result.stdout, /^STDOUT_START/);
  assert.match(result.stdout, /STDOUT_ENDCOMMAND_FINISHED\r?\n$/);
  assert.match(result.stderr, /^STDERR_START/);
  assert.match(result.stderr, /STDERR_END$/);
  assert.match(result.output, /COMMAND_FINISHED/);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.outputBytes, result.outputByteCounts.stdout + result.outputByteCounts.stderr);
  assert.ok(result.outputBytes > 350_000);
  assert.ok(result.outputOmittedBytes > 250_000);
  assert.ok(result.outputPreviewOmittedBytes > 250_000);
  for (const value of [result.stdout, result.stderr, result.output, ...events.map(event => event.text)]) assert.doesNotMatch(value, /�/u);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 64 * 1024 + 256);
  assert.ok(Buffer.byteLength(result.output) < 32 * 1024 + 128);
  assert.ok(events.reduce((total, event) => total + Buffer.byteLength(event.text), 0) < 64 * 1024 + 512);
  assert.equal(events.filter(event => event.outputTruncated).length, 2, 'Streaming emits one folding notice per stream instead of the entire log');
});

test('a combined output preview reports truncation even when each individual stream fits its limit', { skip: !hasPowerShell }, async t => {
  const { tools } = await fixture(t, { approve: async () => true });
  const result = await jsonResult(tools.execute('run_command', { command: "[Console]::Out.Write(('a' * 20000)); [Console]::Out.Flush(); Start-Sleep -Milliseconds 100; [Console]::Error.Write(('b' * 20000)); [Console]::Error.Flush(); Start-Sleep -Milliseconds 100; [Console]::Out.Write('FINAL_MARKER'); exit 0" }));
  assert.equal(result.terminated, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'a'.repeat(20000) + 'FINAL_MARKER');
  assert.equal(result.stderr, 'b'.repeat(20000));
  assert.equal(result.outputTruncated, true);
  assert.equal(result.outputOmittedBytes, 0);
  assert.ok(result.outputPreviewOmittedBytes > 0);
  assert.match(result.output, /^a+/);
  assert.match(result.output, /b+FINAL_MARKER$/);
  assert.equal(result.outputBytes, 40_012);
});

test('truncating command output does not prevent cancellation or timeout from stopping the process', { skip: !hasPowerShell }, async t => {
  for (const reason of ['cancelled', 'timeout']) {
    const controller = new AbortController();
    const { root, tools } = await fixture(t, {
      approve: async () => true,
      onEvent: event => { if (reason === 'cancelled' && event.outputTruncated) controller.abort(); },
    });
    const result = await jsonResult(tools.execute('run_command', {
      command: "[Console]::Out.Write(('x' * 150000)); Start-Sleep -Seconds 20; Set-Content -LiteralPath 'must-not-run.txt' -Value 'late'",
      timeout_ms: reason === 'timeout' ? 1500 : 10000,
    }, { signal: controller.signal }));
    assert.equal(result.outputTruncated, true);
    assert.equal(result.terminated, reason);
    await assert.rejects(fs.access(path.join(root, 'must-not-run.txt')));
  }
});

test('AbortSignal stops a running command promptly', { skip: !hasPowerShell }, async t => {
  const controller = new AbortController();
  const { root, tools } = await fixture(t, {
    approve: async () => true,
    onEvent: event => { if (event.text.includes('cancel-ready')) controller.abort(); },
  });
  const started = Date.now();
  const result = await jsonResult(tools.execute('run_command', { command: "Write-Output 'cancel-ready'; Start-Sleep -Seconds 20; Set-Content -LiteralPath 'late.txt' -Value 'done'" }, { signal: controller.signal }));
  assert.equal(result.terminated, 'cancelled');
  assert.ok(Date.now() - started < 10000, 'cancelled command took too long to stop');
  await assert.rejects(fs.access(path.join(root, 'late.txt')));
});

test('command timeout stops execution', { skip: !hasPowerShell }, async t => {
  const { tools } = await fixture(t, { approve: async () => true });
  const result = await jsonResult(tools.execute('run_command', { command: 'Start-Sleep -Seconds 20', timeout_ms: 1000 }));
  assert.equal(result.terminated, 'timeout');
});

test('Windows cancellation kills the spawned descendant process as well', { skip: !hasPowerShell || process.platform !== 'win32' }, async t => {
  const controller = new AbortController();
  let childPid;
  let observed = '';
  const { tools } = await fixture(t, {
    approve: async () => true,
    onEvent: event => {
      observed += event.text;
      const match = observed.match(/childpid=(\d+)/);
      if (match) { childPid = Number(match[1]); controller.abort(); }
    },
  });
  t.after(() => { if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} } });
  const command = "$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60') -WindowStyle Hidden -PassThru; Write-Output ('childpid=' + $child.Id); Start-Sleep -Seconds 60";
  const result = await jsonResult(tools.execute('run_command', { command }, { signal: controller.signal }));
  assert.ok(childPid, 'descendant process did not report its PID');
  assert.equal(result.terminated, 'cancelled');
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'descendant survived cancellation');
});

test('provider API key variables are not inherited by PowerShell commands', { skip: !hasPowerShell }, async t => {
  const name = 'FORGEDESK_TEST_API_KEY';
  const previous = process.env[name];
  process.env[name] = 'provider-credential-should-not-leak';
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const { tools } = await fixture(t, { approve: async () => true });
  const result = await jsonResult(tools.execute('run_command', { command: `Write-Output $env:${name}; Write-Output 'done'` }));
  assert.doesNotMatch(result.stdout, /provider-credential-should-not-leak/);
  assert.match(result.stdout, /done/);
});

test('PowerShell Chinese output survives UTF-8 decoding', { skip: !hasPowerShell }, async t => {
  const { tools } = await fixture(t, { approve: async () => true });
  const result = await jsonResult(tools.execute('run_command', { command: "Write-Output '中文测试'; [Console]::Error.WriteLine('中文错误')" }));
  assert.match(result.stdout, /中文测试/);
  assert.match(result.stderr, /中文错误/);
});

test('an already aborted task cannot request approval', async t => {
  let approvals = 0;
  const { tools } = await fixture(t, { approve: async () => { approvals += 1; return true; } });
  const controller = new AbortController();
  controller.abort();
  assert.match(await tools.execute('run_command', { command: 'Write-Output unsafe' }, { signal: controller.signal }), /错误：.*已取消/);
  assert.equal(approvals, 0);
});

test('cancellation during either command root check returns promptly and never proceeds to approval or spawn', async t => {
  for (const phase of ['before-approval', 'after-approval']) {
    let approvals = 0, spawns = 0, rootReads = 0, realpathReads = 0, releaseRead, enteredRead;
    const entered = new Promise(resolve => { enteredRead = resolve; });
    const { root, tools } = await fixture(t, {
      approve: async () => { approvals++; return true; }, commandRuntime: { spawnImpl: () => { spawns++; throw new Error('must not spawn'); } },
    });
    const originalStat = fs.lstat.bind(fs), originalRealpath = fs.realpath.bind(fs), stat = await originalStat(root);
    const statMock = t.mock.method(fs, 'lstat', async (...args) => {
      if (args[0] === root && ++rootReads === (phase === 'before-approval' ? 1 : 2)) {
        enteredRead(); return new Promise(resolve => { releaseRead = resolve; });
      }
      return originalStat(...args);
    });
    const realpathMock = t.mock.method(fs, 'realpath', (...args) => { realpathReads++; return originalRealpath(...args); });
    const controller = new AbortController(), pending = tools.execute('run_command', { command: 'Write-Output never' }, { signal: controller.signal });
    await entered; const readsAtStop = realpathReads; controller.abort();
    const result = await pending;
    assert.match(result, /^错误：任务已取消/u); assert.equal(spawns, 0);
    assert.equal(approvals, phase === 'before-approval' ? 0 : 1);
    releaseRead(stat); await immediate(); await immediate();
    assert.equal(realpathReads, readsAtStop, 'a late disk read must not continue the validation chain');
    assert.equal(spawns, 0);
    statMock.mock.restore(); realpathMock.mock.restore();
  }
});

test('per-command output routing uses the existing workspace without changing other tool event listeners', async t => {
  const routed = [], defaults = [];
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => false; child.unref = () => {};
  let launched;
  const started = new Promise(resolve => { launched = resolve; });
  const { tools } = await fixture(t, { approve: async () => true, onEvent: event => defaults.push(event),
    commandRuntime: { spawnImpl: () => { launched(); return child; } } });
  const pending = tools.execute('run_command', { command: 'fixture' }, { onCommandOutput: event => routed.push(event) });
  await started; child.stdout.write('routed command output'); child.emit('exit', 0, null); child.emit('close', 0, null);
  const result = await jsonResult(pending);
  assert.equal(result.exitCode, 0); assert.equal(routed[0].text, 'routed command output'); assert.deepEqual(defaults, []);
  tools.onEvent({ type: 'separate-tool' }); assert.equal(defaults[0].type, 'separate-tool');
});

test('a stalled directory check times out before approval and does not continue when the disk read eventually returns', async t => {
  let approvals = 0, spawned = false, completeRead, laterReads = 0;
  const { tools, root } = await fixture(t, { approve: async () => { approvals++; return true; },
    commandRuntime: { pathCheckTimeoutMs: 20, spawnImpl: () => { spawned = true; throw new Error('unexpected spawn'); } } });
  const originalStat = fs.lstat.bind(fs), originalRealpath = fs.realpath.bind(fs), stat = await originalStat(root);
  const statMock = t.mock.method(fs, 'lstat', (...args) => args[0] === root ? new Promise(resolve => { completeRead = resolve; }) : originalStat(...args));
  const realpathMock = t.mock.method(fs, 'realpath', (...args) => { laterReads++; return originalRealpath(...args); });
  const result = await tools.execute('run_command', { command: 'never' });
  assert.match(result, /目录检查超时.*未启动命令/u); assert.equal(approvals, 0); assert.equal(spawned, false);
  completeRead(stat); await immediate(); await immediate(); assert.equal(laterReads, 0); assert.equal(spawned, false);
  statMock.mock.restore(); realpathMock.mock.restore();
});
