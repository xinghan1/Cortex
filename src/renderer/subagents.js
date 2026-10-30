/* Public subagent snapshots only. Tool data stays literal, inspectable text. */
(() => {
  'use strict';
  const states = new WeakMap();
  const statuses = new Set(['running', 'completed', 'failed', 'stopped']);
  const activityTypes = new Set(['message', 'assistant-message', 'text', 'tool-start', 'tool-result', 'command-output', 'status', 'progress']);
  const privateKeys = new Set(['providerstate', 'nativestate', 'reasoning', 'analysis', 'apikey', 'accesstoken', 'refreshtoken', 'authorization', 'credentials', 'credential', 'secret', 'headers', '__proto__', 'constructor', 'prototype']);
  const text = (value, limit = 16000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const statusText = { running: '进行中', completed: '已完成', failed: '失败', stopped: '已停止' };

  function publicValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return value.slice(0, 20000);
    if (depth >= 6 || !value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map(item => publicValue(item, depth + 1, seen) ?? null);
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (privateKeys.has(key.toLowerCase().replace(/[-_]/g, '')) || privateKeys.has(key)) continue;
      const clean = publicValue(item, depth + 1, seen);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  }
  function normalize(agent = {}) {
    return {
      id: text(agent.id, 200), name: text(agent.name, 160) || '子代理', task: text(agent.task),
      status: statuses.has(agent.status) ? agent.status : 'running',
      elapsedMs: number(agent.elapsedMs), inputTokens: number(agent.inputTokens), outputTokens: number(agent.outputTokens),
      summary: text(agent.summary), error: text(agent.error),
      activity: (Array.isArray(agent.activity) ? agent.activity : []).filter(item => item && activityTypes.has(item.type)).slice(-100).map(item => ({
        type: item.type, name: text(item.name, 160), text: text(item.text), toolCallId: text(item.toolCallId, 200),
        ...(item.streaming === true ? { streaming: true } : {}),
        ...(Object.prototype.hasOwnProperty.call(item, 'args') ? { args: publicValue(item.args) } : {}),
        ...(Object.prototype.hasOwnProperty.call(item, 'result') ? { result: publicValue(item.result) } : {}),
      })),
    };
  }
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function colorFor(id) {
    let hash = 2166136261;
    for (const character of id) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    return String((hash >>> 0) % 8);
  }
  function icon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 6; index++) {
      const petal = document.createElementNS(namespace, 'ellipse');
      petal.setAttribute('cx', '12'); petal.setAttribute('cy', '6.7');
      petal.setAttribute('rx', '3.1'); petal.setAttribute('ry', '5.4');
      petal.setAttribute('transform', 'rotate(' + index * 60 + ' 12 12)');
      svg.append(petal);
    }
    return svg;
  }
  function elapsed(value) {
    if (value === null) return '';
    const seconds = Math.floor(value / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    return '用时 ' + (hours ? hours + 'h ' + minutes % 60 + 'm ' : minutes ? minutes + 'm ' : '') + seconds % 60 + 's';
  }
  function liveElapsed(state, now = performance.now()) {
    return state.elapsedBase === null ? null : state.elapsedBase + Math.max(0, now - state.elapsedAt);
  }
  function updateElapsed(state, value) {
    const duration = elapsed(value);
    if (state.meta.textContent !== duration) state.meta.textContent = duration;
    state.meta.hidden = !duration;
    if (state.usage) {
      const parts = [];
      if (duration) parts.push(duration);
      if (state.agent.inputTokens !== null) parts.push('输入 ' + Math.floor(state.agent.inputTokens).toLocaleString() + ' Token');
      if (state.agent.outputTokens !== null) parts.push('输出 ' + Math.floor(state.agent.outputTokens).toLocaleString() + ' Token');
      const text = parts.join(' · ');
      if (state.usage.textContent !== text) state.usage.textContent = text;
    }
  }
  function tick(element) {
    const state = states.get(element);
    if (!state || state.historical || state.agent?.status !== 'running') return;
    updateElapsed(state, liveElapsed(state));
  }
  function raw(parent, label, value, key, pathHint) {
    if (value === undefined || value === null || value === '') return;
    const details = node('div', 'subagent-raw');
    details.append(node('div', 'subagent-raw-label', label));
    let content;
    try { content = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
    catch { content = '无法显示此项数据。'; }
    const pre = node('pre');
    let json = typeof value !== 'string';
    if (!json) try { JSON.parse(content); json = true; } catch {}
    const language = json ? 'json' : typeof pathHint === 'string' ? window.ForgeSyntax?.languageForPath(pathHint) : '';
    if (language && window.ForgeSyntax) window.ForgeSyntax.append(document, pre, content, language);
    else pre.textContent = content;
    details.append(pre); parent.append(details);
  }
  function section(parent, label, content, className = '') {
    if (!content) return;
    const block = node('section', 'subagent-section ' + className);
    block.append(node('h4', 'subagent-section-title', label), node('div', 'subagent-section-text', content));
    parent.append(block);
  }
  function renderBody(state, agent) {
    const opened = new Set([...state.body.querySelectorAll('details[open][data-state-key]')].map(item => item.dataset.stateKey));
    const fragment = document.createDocumentFragment();
    section(fragment, '任务', agent.task);
    // The latest assistant message is already visible in the process log.
    // Retain distinct summaries and earlier activity, but do not show the
    // same current message twice while streaming or after confirmation.
    const latestMessage = [...agent.activity].reverse().find(item => ['message', 'assistant-message', 'text'].includes(item.type) && item.text);
    if (!latestMessage || latestMessage.text !== agent.summary) section(fragment, '总结', agent.summary);
    section(fragment, '错误', agent.error, 'subagent-error-section');
    if (agent.activity.length) {
      const log = node('section', 'subagent-section subagent-activities');
      log.append(node('h4', 'subagent-section-title', '操作过程'));
      agent.activity.forEach((item, index) => {
        if (['message', 'assistant-message', 'text', 'status', 'progress'].includes(item.type)) {
          if (item.text) log.append(node('div', 'subagent-activity-text', item.text));
          return;
        }
        if (item.type === 'command-output') { raw(log, '命令输出', item.text || item.result, 'activity-' + index + '-output'); return; }
        const key = 'activity-' + (item.toolCallId || index) + '-' + item.type;
        const operation = node('details', 'subagent-activity-item'); operation.dataset.stateKey = key;
        operation.append(node('summary', '', (item.type === 'tool-start' ? '调用工具 · ' : '工具返回 · ') + (item.name || '工具')));
        const body = node('div', 'subagent-operation-body');
        if (item.text) body.append(node('div', 'subagent-activity-text', item.text));
        raw(body, '输入参数', item.args, key + '-args');
        raw(body, '执行结果', item.result, key + '-result', item.args?.path);
        operation.append(body); log.append(operation);
      });
      fragment.append(log);
    }
    state.usage = null;
    if (state.elapsedBase !== null || agent.inputTokens !== null || agent.outputTokens !== null) {
      state.usage = node('div', 'subagent-usage');
      fragment.append(state.usage);
    }
    state.body.replaceChildren(fragment);
    for (const item of state.body.querySelectorAll('details[data-state-key]')) if (opened.has(item.dataset.stateKey)) item.open = true;
  }
  function update(element, snapshot) {
    const state = states.get(element);
    if (!state) return element;
    const agent = normalize(snapshot);
    if (state.agent && agent.id !== state.agent.id) return element;
    const status = state.historical && agent.status === 'running' ? 'stopped' : agent.status;
    const now = performance.now();
    const previous = state.agent?.status === 'running' && !state.historical ? liveElapsed(state, now) : null;
    state.elapsedBase = status === 'running' ? Math.max(agent.elapsedMs ?? 0, previous ?? 0) : agent.elapsedMs ?? previous;
    state.elapsedAt = now;
    state.agent = agent;
    element.dataset.agentId = agent.id; element.dataset.status = status; element.dataset.color = colorFor(agent.id);
    state.name.textContent = agent.name; state.name.title = agent.task || agent.name;
    state.status.textContent = state.historical && agent.status === 'running' ? '任务已结束' : statusText[status];
    state.stop.hidden = state.historical || status !== 'running';
    state.stop.disabled = state.stopPending;
    state.stop.textContent = state.stopPending ? '停止中…' : '停止';
    if (status !== 'running') { state.stopPending = false; state.error.textContent = ''; state.error.hidden = true; }
    const signature = JSON.stringify(agent);
    if (signature !== state.signature) { renderBody(state, agent); state.signature = signature; }
    updateElapsed(state, state.elapsedBase);
    return element;
  }
  function render(agent, { historical = false } = {}) {
    const element = node('details', 'subagent-card');
    const summary = node('summary', 'subagent-header');
    const badge = node('span', 'subagent-badge'); badge.append(icon());
    const name = node('span', 'subagent-name'), status = node('span', 'subagent-status');
    status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    const meta = node('span', 'subagent-meta');
    const stop = node('button', 'subagent-stop', '停止'); stop.type = 'button'; stop.title = '停止此子代理';
    const chevron = node('span', 'subagent-chevron', '⌄'); chevron.setAttribute('aria-hidden', 'true');
    summary.append(badge, name, status, meta, stop, chevron);
    const body = node('div', 'subagent-body'), error = node('div', 'subagent-stop-error');
    error.hidden = true; error.setAttribute('role', 'alert');
    element.append(summary, error, body);
    const state = { agent: null, historical: Boolean(historical), body, name, status, meta, stop, error, usage: null, stopPending: false, signature: '', elapsedBase: null, elapsedAt: performance.now() };
    states.set(element, state);
    stop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
    stop.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (state.stopPending || state.historical || state.agent?.status !== 'running') return;
      state.stopPending = true; stop.disabled = true; stop.textContent = '停止中…'; error.hidden = true;
      try {
        if (typeof window.forge?.stopSubagent !== 'function') throw new Error('当前窗口无法停止此子代理。');
        const result = await window.forge.stopSubagent({ id: state.agent.id });
        const returned = result?.agent || result;
        if (returned?.id === state.agent.id && statuses.has(returned.status)) update(element, { ...state.agent, ...returned });
      } catch (failure) {
        state.stopPending = false;
        if (state.agent?.status !== 'running') return;
        stop.disabled = false; stop.textContent = '停止';
        error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false;
      }
    });
    return update(element, agent);
  }
  function finish(element, status = 'stopped') {
    const state = states.get(element);
    if (!state || state.agent.status !== 'running') return element;
    return update(element, { ...state.agent, elapsedMs: liveElapsed(state), status: statuses.has(status) && status !== 'running' ? status : 'stopped' });
  }
  window.ForgeSubagents = Object.freeze({ render, update, finish, tick });
})();
