'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeToolOperationGroups = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const cards = new WeakMap(), groups = new WeakMap(), boundaries = new WeakMap();
  const kinds = Object.freeze({ read_file: 'read', list_files: 'list', write_file: 'edit',
    replace_in_file: 'edit', undo_last_change: 'edit', run_command: 'command', search_files: 'search', search_text: 'search' });
  function describe(members) {
    const names = new Set(members.map(card => cards.get(card)?.name));
    const categories = new Set([...names].map(name => kinds[name]));
    const edit = categories.has('edit'), command = categories.has('command');
    if (categories.has('search')) return { kind: 'search', complete: '已完成搜索', running: '正在搜索', neutral: '搜索', readOnly: true, names };
    if (edit && command) return { kind: 'edit-command', complete: '编辑了文件并运行了命令', running: '正在编辑文件并运行命令', neutral: '编辑文件并运行命令', readOnly: false, names };
    if (edit) return { kind: 'edit', complete: '编辑了文件', running: '正在编辑文件', neutral: '编辑文件', readOnly: false, names };
    if (command) return { kind: 'command', complete: '运行了命令', running: '正在运行命令', neutral: '运行命令', readOnly: false, names };
    if (categories.has('read') && categories.has('list')) return { kind: 'read-list', complete: '读取了文件和文件列表', running: '正在读取文件和文件列表', neutral: '读取文件和文件列表', readOnly: true, names };
    if (categories.has('list')) return { kind: 'list', complete: '读取了文件列表', running: '正在读取文件列表', neutral: '读取文件列表', readOnly: true, names };
    return { kind: 'read', complete: '读取了文件', running: '正在读取文件', neutral: '读取文件', readOnly: true, names };
  }
  const normalizeName = name => typeof name === 'string' ? name.replace(/（模拟）$/u, '') : '';
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function statusOf(card) {
    if (card.classList.contains('running')) return 'running';
    return ['completed', 'failed', 'denied', 'stopped', 'unknown'].includes(card.dataset.status) ? card.dataset.status : 'unknown';
  }
  // Counts are based solely on completed file snapshots, never inferred from
  // streamed tool arguments. Coalesce rapid tool results into one update/s.
  function refreshEditCounts(state, members) {
    let added = 0, removed = 0, found = false, unknown = false;
    for (const card of members) {
      const edit = card.querySelector('.code-diff-card');
      if (!edit) continue;
      const a = edit.querySelector('.code-diff-added')?.textContent;
      const r = edit.querySelector('.code-diff-removed')?.textContent;
      if (edit.dataset.exact !== 'true' || !/^\+\d+$/.test(a || '') || !/^-\d+$/.test(r || '')) { unknown = true; continue; }
      added += Number(a.slice(1)); removed += Number(r.slice(1)); found = true;
    }
    state.pendingCounts = found && !unknown ? { added, removed } : null;
    if (state.countTimer) return;
    if (!state.pendingCounts && state.editCounts.hidden) return;
    const update = () => {
      state.countTimer = null;
      const counts = state.pendingCounts;
      state.editCounts.hidden = !counts;
      if (!counts) return;
      for (const [key, sign] of [['added', '+'], ['removed', '-']]) {
        const target = state[key];
        const value = `${sign}${counts[key]}`;
        if (target.textContent === value) continue;
        target.replaceChildren(node('span', `tool-operation-count-value ${key}`, value));
        target.setAttribute('aria-label', `${key === 'added' ? '新增' : '删除'} ${counts[key]} 行`);
      }
    };
    if (typeof setTimeout !== 'function') { update(); return; }
    state.countTimer = setTimeout(update, 1000);
  }
  function refresh(value) {
    const group = groups.has(value) ? value : cards.get(value)?.group;
    const state = groups.get(group);
    if (!state) return null;
    const members = state.cards.filter(card => card.parentElement === state.body);
    const counts = { running: 0, completed: 0, failed: 0, denied: 0, stopped: 0, unknown: 0 };
    for (const card of members) {
      const status = statusOf(card); counts[status]++;
    }
    const status = counts.running ? 'running' : counts.failed ? 'failed' : counts.denied ? 'denied'
      : counts.unknown ? 'unknown' : counts.stopped ? 'stopped' : 'completed';
    const description = describe(members);
    refreshEditCounts(state, members);
    state.label.textContent = status === 'running' ? description.running
      : counts.completed === members.length ? description.complete : description.neutral;
    state.count.textContent = `${members.length} ${description.readOnly ? '次' : '项操作'}`;
    const summaries = [['running', '进行中'], ['completed', '已完成'], ['failed', '未完成'],
      ['denied', '未执行'], ['stopped', '已停止'], ['unknown', '未返回']];
    state.status.textContent = '';
    for (const [key, label] of summaries.filter(([key]) => counts[key])) {
      if (state.status.children.length) state.status.append(node('span', 'tool-operation-status-separator', ' · '));
      const item = node('span', 'tool-operation-status-count', `${counts[key]} ${label}`);
      item.dataset.status = key;
      state.status.append(item);
    }
    state.status.hidden = counts.completed === members.length;
    group.dataset.status = status;
    group.dataset.count = String(members.length);
    group.dataset.kind = description.kind;
    group.dataset.operation = description.names.size === 1 ? [...description.names][0] : 'mixed';
    // Status updates change the summary only; disclosure stays under user control.
    return group;
  }
  function breakGroup(target) {
    if (target && typeof target === 'object') boundaries.set(target, (boundaries.get(target) || 0) + 1);
  }
  function detach(card) {
    const previous = cards.get(card), state = groups.get(previous?.group);
    if (!state) return;
    state.cards = state.cards.filter(item => item !== card);
    const remaining = state.cards.filter(item => item.parentElement === state.body);
    if (remaining.length < 2) {
      for (const item of remaining) {
        state.target.insertBefore(item, previous.group);
        cards.get(item).group = null;
      }
      previous.group.remove(); groups.delete(previous.group);
    } else refresh(previous.group);
    previous.group = null;
  }
  function appendTool(target, card, event = {}, { onGroup = () => {} } = {}) {
    if (!target || !card || typeof target.append !== 'function') return null;
    const previous = cards.get(card);
    if (previous?.target === target && (card.parentElement === target || card.parentElement === groups.get(previous.group)?.body))
      return refresh(card);
    detach(card);
    const name = normalizeName(event.name), generation = boundaries.get(target) || 0;
    const family = kinds[name] === 'search' ? 'search' : 'operations';
    const identity = { name, family, runId: typeof event.runId === 'string' ? event.runId : '', generation, target, group: null };
    // A block may mix local reads, edits and commands. Browsing, approvals and
    // arbitrary tool types retain their own rows and break the current block.
    // Searches form their own adjacent block, keeping their result count and
    // disclosure separate from local read/edit/command activity.
    if (!Object.hasOwn(kinds, name)) { cards.delete(card); target.append(card); return null; }
    const last = target.lastElementChild, existing = groups.get(last), single = cards.get(last);
    cards.set(card, identity);
    const matches = value => value && value.family === family && value.runId === identity.runId && value.generation === generation && value.target === target;
    if (matches(existing)) {
      identity.group = last; existing.cards.push(card); existing.body.append(card); refresh(last); return last;
    }
    if (matches(single) && single.target === target) {
      const group = node('details', 'tool-operation-group');
      // A second operation must not hide a detail the user already opened.
      // Ordinary cards start closed, so untouched read sequences stay folded.
      group.open = Boolean(last.open || card.open); group.dataset.operation = name;
      if (identity.runId) group.dataset.runId = identity.runId;
      const summary = node('summary', 'tool-operation-group-summary');
      const icon = node('span', 'tool-operation-group-icon'); icon.setAttribute('aria-hidden', 'true');
      const label = node('span', 'tool-operation-group-label'), count = node('span', 'tool-operation-group-count'), status = node('span', 'tool-operation-group-status');
      const editCounts = node('span', 'tool-operation-edit-counts'); editCounts.hidden = true;
      editCounts.title = '此组已完成文件操作的新增和删除行数之和';
      const added = node('span', 'tool-operation-count-added'), removed = node('span', 'tool-operation-count-removed');
      editCounts.append(added, removed);
      status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
      const chevron = node('span', 'tool-operation-group-chevron'); chevron.setAttribute('aria-hidden', 'true');
      summary.append(icon, label, count, editCounts, status, chevron);
      const body = node('div', 'tool-operation-group-body tool-operation-group-items');
      group.append(summary, body);
      target.insertBefore(group, last); body.append(last, card);
      single.group = identity.group = group;
      const state = { family, runId: identity.runId, generation, target, cards: [last, card], body, label, count, status, editCounts, added, removed, countTimer: null };
      groups.set(group, state);
      refresh(group); onGroup(group); return group;
    }
    target.append(card); return null;
  }
  return Object.freeze({ appendTool, refresh, breakGroup });
});
