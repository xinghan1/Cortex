import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CommandOutputCapture } from './command-output.mjs';

const MAX_LIVE_BYTES = 32 * 1024;
const SYSTEM = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ignoreError = () => {};
const cancelled = () => new Error('任务已取消。');
const readInterrupted = signal => signal?.reason?.code === 'COMMAND_PATH_UNAVAILABLE' ? signal.reason : cancelled();

// Only use this for read-only preparation. The underlying OS read may finish
// later, but cancellation prevents every subsequent read, approval and spawn.
export function waitForCommandRead(read, signal) {
  if (signal?.aborted) return Promise.reject(readInterrupted(signal));
  if (!signal) return Promise.resolve().then(read);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(readInterrupted(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw readInterrupted(signal); return read(); }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(readInterrupted(signal)); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function validateCommandDirectory(validate, signal, timeoutMs = 10000) {
  const controller = new AbortController();
  const aborted = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('项目目录检查超时，磁盘或路径可能不可访问；未启动命令。'),
    { code: 'COMMAND_PATH_UNAVAILABLE' })), timeoutMs);
  try { return await waitForCommandRead(() => validate(controller.signal), controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}

export function runPowerShellCommand({ command, cwd, env, timeout, signal, onEvent = () => {} }, {
  spawnImpl = spawn, killProcess = process.kill.bind(process), platform = process.platform,
  powershell = platform === 'win32' ? path.join(SYSTEM, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh',
  taskkill = path.join(SYSTEM, 'taskkill.exe'), stopGraceMs = 2500, exitDrainMs = 500, killFallbackMs = 1000,
} = {}) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let child;
    try {
      const execution = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n${command}`;
      child = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', execution], {
        cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { reject(new Error(`无法启动 PowerShell：${error.message}`)); return; }
    const output = { stdout: new CommandOutputCapture(), stderr: new CommandOutputCapture() };
    const combinedOutput = new CommandOutputCapture();
    const outputDecoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const liveDecoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const streamListeners = [];
    let outputBytes = 0, terminated = null, settled = false, processExitObserved = false, closed = false;
    let exitCode = null, exitSignal = null, executionError = null, outputIncomplete = false;
    let killer = null, killerDone = false, killerExited = false, treeConfirmed = false;
    let timeoutTimer, forceTimer, settlementTimer, drainTimer;
    const notify = event => { if (!settled) { try { onEvent(event); } catch {} } };
    const killChild = () => { if (!processExitObserved) { try { child.kill('SIGKILL'); } catch {} } };
    const cleanupKiller = () => {
      if (!killer) return;
      killer.removeListener('error', onKillerError); killer.removeListener('exit', onKillerExit); killer.removeListener('close', onKillerExit);
      killer.on('error', ignoreError);
      if (!killerExited && killer.pid) { try { killer.kill('SIGKILL'); } catch {} }
      killer.unref?.(); killer = null;
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      for (const timer of [timeoutTimer, forceTimer, settlementTimer, drainTimer]) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.removeListener('error', onError); child.removeListener('exit', onExit); child.removeListener('close', onClose);
      // Node may report a late kill/pipe error after detachment. This shared
      // no-op holds no task state; all execution-specific listeners are removed.
      child.on('error', ignoreError);
      for (const { stream, data, end, error: onStreamError } of streamListeners) {
        stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', onStreamError);
        stream.on('error', ignoreError);
        if (!stream.destroyed) stream.destroy();
      }
      cleanupKiller(); child.unref?.();
      if (error) { reject(error); return; }
      const stdout = output.stdout.snapshot(), stderr = output.stderr.snapshot(), combined = combinedOutput.snapshot();
      const outputTruncated = stdout.truncated || stderr.truncated || combined.truncated;
      resolve({ command, exitCode, signal: exitSignal, terminated, stdout: stdout.text, stderr: stderr.text,
        ...(outputTruncated ? { output: combined.text } : {}), outputTruncated,
        outputBytes, outputByteCounts: { stdout: stdout.bytes, stderr: stderr.bytes },
        outputOmittedBytes: stdout.omittedBytes + stderr.omittedBytes, outputPreviewOmittedBytes: combined.omittedBytes,
        processExitObserved, terminationConfirmed: terminated ? processExitObserved : null,
        processTreeTerminationConfirmed: terminated ? treeConfirmed && processExitObserved : outputIncomplete ? false : null,
        outputIncomplete, cleanupPending: !processExitObserved || Boolean(terminated && !treeConfirmed) || outputIncomplete,
        ...(executionError ? { error: executionError } : {}),
      });
    };
    const maybeFinish = () => {
      if (closed && (!terminated || !killer || killerDone)) finish();
    };
    function onKillerExit(code) {
      killerExited = true;
      if (settled || killerDone) return;
      killerDone = true; treeConfirmed = code === 0;
      if (!treeConfirmed) killChild();
      maybeFinish();
    }
    function onKillerError() {
      if (settled || killerDone) return;
      killerDone = true; killChild(); maybeFinish();
    }
    const stop = reason => {
      if (terminated || settled) return;
      terminated = reason; clearTimeout(drainTimer);
      settlementTimer = setTimeout(() => {
        outputIncomplete ||= !closed;
        killChild(); finish();
      }, stopGraceMs);
      // Never target an exited shell's reusable PID merely because a descendant
      // still holds its pipes. Detach after the grace period in that case.
      if (!processExitObserved && child.pid) {
        if (platform === 'win32') {
          try {
            killer = spawnImpl(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', onKillerError); killer.once('exit', onKillerExit); killer.once('close', onKillerExit);
          } catch { killerDone = true; killChild(); }
        } else {
          try { killProcess(-child.pid, 'SIGKILL'); }
          catch { killChild(); }
          try { killProcess(-child.pid, 0); } catch (error) { treeConfirmed = error.code === 'ESRCH'; }
        }
      }
      forceTimer = setTimeout(killChild, killFallbackMs);
      maybeFinish();
    };
    const onAbort = () => stop('cancelled');
    function onExit(code, status) {
      if (settled) return;
      processExitObserved = true;
      exitCode = Number.isInteger(code) ? code : null; exitSignal = typeof status === 'string' ? status : null;
      clearTimeout(timeoutTimer);
      if (!terminated) drainTimer = setTimeout(() => { outputIncomplete = !closed; finish(); }, exitDrainMs);
    }
    function onClose(code, status) {
      if (settled) return;
      closed = true;
      if (!processExitObserved && (Number.isInteger(code) || typeof status === 'string')) onExit(code, status);
      maybeFinish();
    }
    function onError(error) {
      if (settled) return;
      if (!child.pid && !processExitObserved) { finish(new Error(`无法启动 PowerShell：${error.message}`)); return; }
      executionError = `PowerShell 进程错误：${error.message}`;
      stop('error');
    }
    child.on('error', onError); child.once('exit', onExit); child.once('close', onClose);
    for (const name of ['stdout', 'stderr']) {
      const stream = child[name];
      if (!stream) continue;
      let liveBytes = 0, liveTruncated = false, ended = false;
      const data = chunk => {
        if (settled) return;
        chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += chunk.length; output[name].append(chunk);
        combinedOutput.append(Buffer.from(outputDecoders[name].write(chunk), 'utf8'));
        const remaining = MAX_LIVE_BYTES - liveBytes;
        if (remaining > 0) {
          const part = chunk.subarray(0, remaining); liveBytes += part.length;
          const text = liveDecoders[name].write(part);
          if (text) notify({ type: 'command-output', stream: name, text });
        }
        if (chunk.length > remaining && !liveTruncated) {
          liveTruncated = true;
          notify({ type: 'command-output', stream: name, outputTruncated: true, outputBytes,
            text: '\n[… 后续日志已折叠，命令继续运行，完成后显示首尾内容 …]\n' });
        }
      };
      const end = () => {
        if (ended || settled) return; ended = true;
        combinedOutput.append(Buffer.from(outputDecoders[name].end(), 'utf8'));
        const text = liveTruncated ? '' : liveDecoders[name].end();
        if (text) notify({ type: 'command-output', stream: name, text });
      };
      const error = () => { outputIncomplete = true; };
      stream.on('data', data); stream.once('end', end); stream.on('error', error);
      streamListeners.push({ stream, data, end, error });
    }
    timeoutTimer = setTimeout(() => stop('timeout'), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
