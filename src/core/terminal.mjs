import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT = 600_000;
const MAX_TIMEOUT = 600_000;
const HIDDEN_OUTPUT = '[输出因脱敏失败而隐藏]';

function failure(message) {
  return { error: message, message, exitCode: null };
}

/** A single approved command at the project root; this is not a PTY or a persistent shell. */
export class TerminalSession {
  #workspaceFactory;
  #redact;
  #onEvent;
  #active = null;

  constructor({ workspaceFactory, redact = value => value, onEvent = () => {} } = {}) {
    if (typeof workspaceFactory !== 'function') throw new TypeError('workspaceFactory 必须是函数。');
    if (typeof redact !== 'function' || typeof onEvent !== 'function') throw new TypeError('终端回调必须是函数。');
    this.#workspaceFactory = workspaceFactory;
    this.#redact = redact;
    this.#onEvent = onEvent;
  }

  get running() { return this.#active !== null; }
  get activeId() { return this.#active?.id ?? null; }

  #safeText(value) {
    try {
      const redacted = this.#redact(String(value));
      return typeof redacted === 'string' ? redacted : HIDDEN_OUTPUT;
    } catch { return HIDDEN_OUTPUT; }
  }

  #emit(event) {
    // A renderer/listener failure must not leave a local process running without cleanup.
    try { this.#onEvent(event); } catch {}
  }

  stop() {
    if (!this.#active) return false;
    this.#active.controller.abort();
    return true;
  }

  async run({ id = randomUUID(), command, timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
    if (this.#active) {
      const error = new Error('终端正在执行命令，请先停止或等待完成。');
      error.code = 'TERMINAL_BUSY';
      throw error;
    }
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 16_000) {
      throw new TypeError('请提供 1 至 16000 个字符的 PowerShell 命令。');
    }
    if (typeof id !== 'string' || !id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) throw new TypeError('终端任务 ID 无效。');
    const timeout = Math.min(MAX_TIMEOUT, Math.max(1_000, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT));
    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const active = { id, controller, signal: combinedSignal, output: '' };
    this.#active = active;
    this.#emit({ type: 'terminal-start', id, text: this.#safeText(command), command: this.#safeText(command) });

    let result;
    let status;
    try {
      if (combinedSignal.aborted) {
        result = { ...failure('终端命令已停止。'), terminated: 'cancelled' };
      } else {
        const workspace = await this.#workspaceFactory({ onEvent: event => {
          if (this.#active !== active || event?.type !== 'command-output' || typeof event.text !== 'string') return;
          if (event.stream !== 'stdout' && event.stream !== 'stderr') return;
          active.output += event.text;
          // Always redact the full arrival-order snapshot: credentials can cross stream/chunk boundaries.
          this.#emit({ type: 'terminal-output', id, stream: event.stream, text: this.#safeText(active.output), replace: true });
        } });
        if (!workspace || typeof workspace.execute !== 'function') throw new Error('请先打开项目文件夹。');
        if (combinedSignal.aborted) {
          result = { ...failure('终端命令已停止。'), terminated: 'cancelled' };
        } else {
          const raw = await workspace.execute('run_command', { command, timeout_ms: timeout }, { signal: combinedSignal });
          if (typeof raw !== 'string') throw new Error('终端执行器返回了无效结果。');
          try { result = JSON.parse(raw); }
          catch { result = failure(raw || '终端执行器未返回结果。'); }
          if (!result || typeof result !== 'object' || Array.isArray(result)) result = failure('终端执行器返回了无效结果。');
        }
      }
      if (combinedSignal.aborted || result.terminated === 'cancelled') status = 'stopped';
      else if (result.denied === true) status = 'denied';
      else if (result.exitCode === 0 && !result.terminated && !result.error) status = 'completed';
      else status = 'failed';
    } catch (error) {
      status = combinedSignal.aborted ? 'stopped' : 'failed';
      result = failure(error instanceof Error ? error.message : '终端命令执行失败。');
      if (status === 'stopped') result.terminated = 'cancelled';
    }

    const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
    // Large commands keep a bounded arrival-order snapshot, including the tail
    // that was no longer streamed. Redact the combined text before display.
    const output = result.outputTruncated === true && typeof result.output === 'string' ? result.output : active.output;
    const safeResult = { output: this.#safeText(output), exitCode };
    if (result.outputTruncated === true) safeResult.outputTruncated = true;
    for (const key of ['outputBytes', 'outputOmittedBytes']) {
      if (Number.isSafeInteger(result[key]) && result[key] >= 0) safeResult[key] = result[key];
    }
    // Never forward the original streams: a credential split between stdout and stderr
    // is visible only in the combined snapshot, so redacting each stream separately is insufficient.
    for (const key of ['command', 'message', 'error', 'signal', 'terminated']) {
      if (typeof result[key] === 'string') safeResult[key] = this.#safeText(result[key]);
      else if (result[key] === null) safeResult[key] = null;
    }
    if (result.denied === true) safeResult.denied = true;
    this.#active = null;
    const completed = { id, status, result: safeResult };
    this.#emit({ type: 'terminal-end', ...completed, exitCode });
    return completed;
  }
}
