'use strict';

// Present command results without changing the saved tool payload or asking a
// model to interpret them. Exit status and diagnostics are deliberately separate.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeCommandResult = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  function object(value) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function message(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value.message === 'string') return value.message;
    if (value === undefined || value === null) return '';
    return JSON.stringify(value);
  }

  function describe(args, raw) {
    args = object(args) || {};
    const result = object(raw);
    const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    let status = 'unknown', label = raw === undefined ? '正在运行' : '命令已返回，未提供退出状态';
    let detail = '';
    if (raw === undefined) status = 'running';
    else if (result?.denied === true || result?.canceled === true || (typeof raw === 'string' && /^操作已停止，未执行/.test(raw))) {
      status = 'denied'; label = '命令未执行'; detail = message(result?.message) || '本次操作未获批准或已取消。';
    } else if (result?.terminated) {
      const reason = result.terminated;
      status = reason === 'timeout' ? 'timeout' : reason === 'output_limit' ? 'output-limit' : reason === 'cancelled' ? 'cancelled' : 'stopped';
      label = reason === 'timeout' ? '运行超时，已停止' : reason === 'output_limit' ? '输出达到上限，已停止' : '命令已停止';
      detail = reason === 'output_limit' ? '输出未完整保留，请缩小命令的输出范围后重试。'
        : reason === 'timeout' ? '命令未在允许时间内结束。' : '';
    } else if (result?.error || (typeof raw === 'string' && !result && /^(?:错误|工具执行失败|Error\b)/i.test(raw))) {
      status = 'failed'; label = '命令执行失败'; detail = message(result?.error) || raw;
    } else if (result?.signal) {
      status = 'stopped'; label = '命令已停止';
    } else if (exitCode !== null) {
      status = exitCode === 0 ? 'success' : 'failed';
      label = exitCode === 0 ? '执行完成' : '命令执行失败';
    }
    const command = typeof result?.command === 'string' ? result.command : typeof args.command === 'string' ? args.command : '';
    const stdout = typeof result?.stdout === 'string' ? result.stdout : typeof result?.output === 'string' ? result.output : '';
    const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
    const output = !result && typeof raw === 'string' && status !== 'failed' && status !== 'denied' ? raw : '';
    const outputTruncated = result?.outputTruncated === true;
    const outputBytes = Number.isSafeInteger(result?.outputBytes) && result.outputBytes >= 0 ? result.outputBytes : null;
    return { status, label, detail, command, exitCode, stdout, stderr, output, outputTruncated, outputBytes,
      signal: typeof result?.signal === 'string' ? result.signal : '',
      timeoutMs: Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : null };
  }

  function create(args, raw) {
    const document = root.document;
    const value = describe(args, raw);
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const card = el('section', 'command-result');
    card.dataset.status = value.status;
    card.setAttribute('aria-label', '命令执行结果');
    const heading = el('div', 'command-result-heading');
    heading.append(el('span', 'command-result-status', value.label));
    if (value.exitCode !== null) heading.append(el('span', 'command-result-meta', `退出代码 ${value.exitCode}`));
    if (value.signal) heading.append(el('span', 'command-result-meta', `终止信号 ${value.signal}`));
    card.append(heading);
    if (value.detail) {
      // Keep the first useful line readable; complete error data remains in the
      // original-data disclosure provided by the tool card.
      const first = value.detail.split(/\r?\n/).find(line => line.trim()) || '';
      card.append(el('p', 'command-result-explanation', first.length > 240 ? first.slice(0, 240) + '…' : first));
    }
    if (value.outputTruncated) {
      const note = el('p', 'command-result-explanation command-result-output-notice', '输出较多，部分预览已节选首尾，省略处已标记。');
      if (value.outputBytes !== null) note.title = `总输出 ${value.outputBytes.toLocaleString()} 字节。执行结果以实际退出状态为准。`;
      card.append(note);
    }
    const section = (label, text, className, language) => {
      const block = el('div', 'command-result-section');
      block.append(el('div', 'tool-label', label));
      const pre = el('pre', className);
      pre.tabIndex = 0;
      const code = el('code', '');
      if (root.ForgeSyntax) root.ForgeSyntax.append(document, code, text, language);
      else code.textContent = text;
      pre.append(code);
      block.append(pre);
      card.append(block);
    };
    if (value.command) section('运行命令', value.command, 'command-result-command', 'powershell');
    if (value.timeoutMs !== null) card.append(el('div', 'command-result-meta', `最长运行 ${value.timeoutMs / 1000} 秒`));
    if (value.stdout || value.output) section('输出内容', value.stdout || value.output, 'command-result-stdout', 'text');
    else if (value.status !== 'running' && value.status !== 'denied') card.append(el('p', 'command-result-empty', '没有普通输出。'));
    if (value.stderr) {
      section(value.status === 'success' ? '诊断信息' : '错误与诊断信息', value.stderr, 'command-result-stderr', 'text');
      if (value.status === 'success') card.append(el('p', 'command-result-explanation', '命令已正常退出；诊断信息也可能包含警告。'));
    }
    return card;
  }

  return Object.freeze({ describe, create });
});
