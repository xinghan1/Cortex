'use strict';
(function (root, factory) {
  const api = factory(root.ForgeCodeDiff);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeTaskChangeSummary = api;
})(typeof globalThis === 'object' ? globalThis : this, function (diffAPI) {
  const valid = edit => edit && typeof edit.runId === 'string' && typeof edit.path === 'string' && edit.path
    && ['before', 'after'].every(key => edit[key] === null || typeof edit[key] === 'string');
  const normalizedPath = path => path.replace(/\\/g, '/').replace(/^(?:\.\/)+/u, '');
  const absolutePath = path => /^(?:[A-Za-z]:\/|\/)/u.test(path);
  function aggregate(edits, runId, { expectedCount } = {}) {
    const files = new Map(), seen = new Map();
    let recordedCount = 0;
    for (const edit of Array.isArray(edits) ? edits : []) {
      if (!valid(edit) || edit.runId !== runId) continue;
      const path = normalizedPath(edit.path);
      const key = typeof edit.toolCallId === 'string' && edit.toolCallId ? `${edit.toolCallId}:${path.toLowerCase()}`
        : Number.isSafeInteger(edit.sequence) ? `${edit.sequence}:${path.toLowerCase()}` : null;
      if (key && seen.get(key)?.before === edit.before && seen.get(key)?.after === edit.after) continue;
      if (key) seen.set(key, edit);
      recordedCount++;
      const identity = path.toLowerCase();
      let file = files.get(identity);
      if (!file) { file = { path, before: edit.before, after: edit.after, continuous: true, segments: [{ before: edit.before, after: edit.after }] }; files.set(identity, file); }
      else {
        const segment = file.segments.at(-1);
        if (segment.after === edit.before) segment.after = edit.after;
        else { file.continuous = false; file.segments.push({ before: edit.before, after: edit.after }); }
        file.after = edit.after;
      }
    }
    const result = [];
    for (const file of files.values()) {
      if (file.continuous && file.before === file.after) continue;
      const diff = file.continuous ? diffAPI.compare(file.before, file.after) : null;
      result.push({ ...file, added: diff?.added ?? null, removed: diff?.removed ?? null, exact: diff?.exact === true });
    }
    const complete = Number.isSafeInteger(expectedCount) && expectedCount >= 0 && expectedCount === recordedCount;
    const exact = complete && result.every(file => file.continuous && file.exact);
    return { runId, files: result, recordedCount, expectedCount: Number.isSafeInteger(expectedCount) ? expectedCount : null, complete, exact,
      added: exact ? result.reduce((total, file) => total + file.added, 0) : null,
      removed: exact ? result.reduce((total, file) => total + file.removed, 0) : null };
  }
  function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }
  function stats(value, className = '') {
    const group = node('span', `task-change-stats ${className}`);
    group.append(node('span', 'task-change-added', value.added === null ? '+—' : `+${value.added}`),
      node('span', 'task-change-removed', value.removed === null ? '-—' : `-${value.removed}`));
    return group;
  }
  function collapse(className) {
    const wrap = node('div', `task-change-collapse ${className}`), inner = node('div', 'task-change-collapse-inner');
    wrap.append(inner); inner.inert = true; inner.setAttribute('aria-hidden', 'true');
    return { wrap, inner, open(value) { wrap.classList.toggle('open', value); inner.inert = !value; inner.setAttribute('aria-hidden', String(!value)); } };
  }
  function updateControls(card, { canUndo = false, canRedo = false, busy = false } = {}) {
    const changing = card.dataset.changing === 'true';
    const undo = card.querySelector('.task-change-undo'), redo = card.querySelector('.task-change-redo');
    undo.disabled = !canUndo || busy || changing;
    undo.title = canUndo ? '撤销本轮已记录的文件修改' : '此任务当前不可撤销';
    redo.disabled = !canRedo || busy || changing;
    redo.hidden = !canRedo && card.dataset.redoing !== 'true';
    redo.title = canRedo ? '恢复本轮已撤销的文件修改' : '此任务当前不可取消撤销';
  }
  function create(summary, options = {}) {
    const card = node('article', 'task-change-summary'); card.dataset.runId = summary.runId;
    card.dataset.complete = String(summary.complete); card.dataset.historical = String(options.historical === true);
    const heading = node('div', 'task-change-heading');
    const caption = node('div', 'task-change-caption'), copy = node('div', 'task-change-heading-copy'), icon = node('span', 'task-change-icon'); icon.setAttribute('aria-hidden', 'true');
    copy.append(node('strong', 'task-change-count', `${summary.complete ? '已编辑' : '已记录'} ${summary.files.length} 个文件`), stats(summary, 'task-change-totals'));
    caption.append(icon, copy); heading.append(caption);
    const list = node('div', 'task-change-files'), extra = collapse('task-change-extra');
    let expanded = false, bulkViewing = false;
    const entries = [];
    const view = node('button', 'task-change-view', '查看变更'); view.type = 'button'; view.setAttribute('aria-expanded', 'false');
    function syncView() {
      const viewing = entries.some(entry => entry.open);
      view.setAttribute('aria-expanded', String(viewing)); view.textContent = viewing ? '收起变更' : '查看变更';
    }
    function showFile(entry, value) {
      if (value && !entry.ready) {
        const detail = node('div', 'task-change-diff'); detail.dataset.path = entry.file.path;
        if (!entry.file.continuous) detail.append(node('p', 'task-change-warning', '记录不连续，以下分别展示已记录片段。'));
        for (const segment of entry.file.continuous ? [{ before: entry.file.before, after: entry.file.after }] : entry.file.segments) {
          const diff = diffAPI.create({ path: entry.file.path, ...segment }, { onCopy: options.onCopy });
          diff.querySelector('.code-diff-filename')?.remove(); diff.querySelector('.code-diff-stats')?.remove();
          diff.querySelector('.code-diff-header')?.classList.add('task-change-diff-tools');
          detail.append(diff);
        }
        entry.preview.inner.append(detail); entry.ready = true;
      }
      entry.open = value; entry.preview.open(value); entry.row.setAttribute('aria-expanded', String(value));
    }
    function showPreviews(value) {
      bulkViewing = value;
      entries.forEach((entry, index) => showFile(entry, value && (expanded || index < 3)));
      syncView();
      if (value && entries.length) options.onExpand?.(entries[0].element);
    }
    summary.files.forEach((file, index) => {
      const element = node('div', 'task-change-entry'), preview = collapse('task-change-file-preview'); element.dataset.path = file.path;
      const row = node('button', 'task-change-file'); row.type = 'button'; row.dataset.path = file.path; row.title = file.path;
      row.dataset.external = String(absolutePath(file.path));
      row.setAttribute('aria-expanded', 'false');
      row.append(node('span', 'task-change-path', file.path), stats(file));
      if (!file.continuous) row.append(node('span', 'task-change-warning', '记录不连续'));
      const entry = { element, file, row, preview, open: false, ready: false }; entries.push(entry);
      row.addEventListener('click', () => {
        bulkViewing = false; showFile(entry, !entry.open); syncView();
        if (entry.open) options.onExpand?.(element);
      });
      element.append(row, preview.wrap); (index < 3 ? list : extra.inner).append(element);
    });
    card.append(heading, list);
    if (summary.files.length > 3) {
      const more = node('button', 'task-change-more', `再显示 ${summary.files.length - 3} 个文件`); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        expanded = !expanded; extra.open(expanded); more.setAttribute('aria-expanded', String(expanded)); more.textContent = expanded ? '收起文件' : `再显示 ${summary.files.length - 3} 个文件`;
        entries.slice(3).forEach(entry => { if (!expanded || bulkViewing) showFile(entry, expanded && bulkViewing); }); syncView();
      });
      card.append(extra.wrap, more);
    }
    if (!summary.complete) card.append(node('p', 'task-change-warning', '快照可能未完整保留，总净变化未计算。'));
    else if (summary.files.some(file => !file.continuous)) card.append(node('p', 'task-change-warning', '记录不连续，总净变化未计算。'));
    else if (!summary.exact) card.append(node('p', 'task-change-warning', '改动较大，差异按整段替换展示。'));
    const actions = node('div', 'task-change-actions'), undo = node('button', 'task-change-undo', '撤销'); undo.type = 'button';
    const redo = node('button', 'task-change-redo', '取消撤销'); redo.type = 'button';
    const status = node('p', 'task-change-status'); status.setAttribute('role', 'status');
    view.disabled = summary.files.length === 0; view.addEventListener('click', () => showPreviews(!entries.some(entry => entry.open)));
    async function change(action) {
      const isRedo = action === 'redo', button = isRedo ? redo : undo, callback = isRedo ? options.onRedo : options.onUndo;
      const label = isRedo ? '取消撤销' : '撤销';
      if (button.disabled || card.dataset.changing === 'true' || typeof callback !== 'function') return;
      card.dataset.changing = 'true'; card.dataset.undoing = String(!isRedo); card.dataset.redoing = String(isRedo);
      updateControls(card, options.getControls?.() || options); status.textContent = `正在${label}…`;
      try {
        const result = await callback(summary.runId);
        status.textContent = result?.status === 'completed' ? isRedo ? '已取消撤销，已恢复本轮修改' : '已撤销本轮修改' : result?.message || `${label}未完成。`;
      } catch (error) { status.textContent = error?.message || `${label}未完成，请重试。`; }
      finally { card.dataset.changing = 'false'; card.dataset.undoing = 'false'; card.dataset.redoing = 'false'; updateControls(card, options.getControls?.() || options); }
    }
    undo.addEventListener('click', () => change('undo')); redo.addEventListener('click', () => change('redo'));
    actions.append(undo, redo, view); heading.append(actions); card.append(status); updateControls(card, options);
    return card;
  }
  return Object.freeze({ aggregate, create, updateControls });
});
