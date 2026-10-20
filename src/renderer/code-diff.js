'use strict';

// Self-contained, bounded line diff. No file access, IPC, markup interpolation,
// or dependency on a model response is needed to render an edit.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeCodeDiff = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const MAX_TEXT = 1024 * 1024;
  const MAX_ROWS = 600;
  const MAX_EDIT_DISTANCE = 256;
  const MAX_WORK = 2000000;
  const CONTEXT = 3;

  function lines(value) {
    if (!value) return [];
    const normalized = value.replace(/\r\n/g, '\n');
    const result = normalized.split('\n');
    const last = result.length - 1;
    for (let i = 0; i < last; i++) result[i] += '\n';
    if (result[last] === '') result.pop();
    return result;
  }

  function appendRun(runs, kind, oldStart, newStart, length) {
    if (!length) return;
    const previous = runs[runs.length - 1];
    if (previous && previous.kind === kind &&
        previous.oldStart + (kind === 'add' ? 0 : previous.length) === oldStart &&
        previous.newStart + (kind === 'remove' ? 0 : previous.length) === newStart) {
      previous.length += length;
    } else runs.push({ kind, oldStart, newStart, length });
  }

  // Myers' shortest edit path, with explicit work and trace limits. A very large
  // edit becomes a documented whole-block replacement rather than freezing UI.
  function shortestEdits(before, after, start, oldEnd, newEnd) {
    const n = oldEnd - start, m = newEnd - start;
    if (!n) return [{ kind: 'add', oldStart: start, newStart: start, length: m }];
    if (!m) return [{ kind: 'remove', oldStart: start, newStart: start, length: n }];
    const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
    const offset = limit + 1;
    let v = new Int32Array(2 * limit + 3);
    v.fill(-1);
    v[offset + 1] = 0;
    const trace = [];
    let work = 0;
    for (let d = 0; d <= limit; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        if (++work > MAX_WORK) return null;
        const index = offset + k;
        let x = k === -d || (k !== d && v[index - 1] < v[index + 1]) ? v[index + 1] : v[index - 1] + 1;
        let y = x - k;
        while (x < n && y < m && before[start + x] === after[start + y]) {
          x++; y++;
          if (++work > MAX_WORK) return null;
        }
        v[index] = x;
        if (x >= n && y >= m) {
          const reversed = [];
          let oldIndex = n, newIndex = m;
          for (let depth = d; depth >= 0; depth--) {
            const previous = trace[depth];
            const diagonal = oldIndex - newIndex;
            const previousDiagonal = diagonal === -depth || (diagonal !== depth && previous[offset + diagonal - 1] < previous[offset + diagonal + 1]) ? diagonal + 1 : diagonal - 1;
            const previousX = previous[offset + previousDiagonal];
            const previousY = previousX - previousDiagonal;
            while (oldIndex > previousX && newIndex > previousY) {
              reversed.push({ kind: 'context', oldStart: start + --oldIndex, newStart: start + --newIndex, length: 1 });
            }
            if (!depth) break;
            if (oldIndex === previousX) {
              reversed.push({ kind: 'add', oldStart: start + oldIndex, newStart: start + --newIndex, length: 1 });
            } else reversed.push({ kind: 'remove', oldStart: start + --oldIndex, newStart: start + newIndex, length: 1 });
          }
          const runs = [];
          for (let i = reversed.length - 1; i >= 0; i--) {
            const run = reversed[i];
            appendRun(runs, run.kind, run.oldStart, run.newStart, run.length);
          }
          return runs;
        }
      }
    }
    return null;
  }

  function compare(before, after) {
    if (before !== null && typeof before !== 'string') throw new TypeError('before must be a string or null');
    if (after !== null && typeof after !== 'string') throw new TypeError('after must be a string or null');
    const changed = before !== after && (before === null || after === null || before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n'));
    const result = { added: 0, removed: 0, rows: [], changed, exact: true, truncated: false, created: before === null && after !== null, deleted: after === null && before !== null };
    if ((before?.length || 0) > MAX_TEXT || (after?.length || 0) > MAX_TEXT) {
      return { ...result, added: null, removed: null, exact: false, truncated: true, rows: [{ kind: 'notice', text: '文件过大，未计算完整差异；请在文件编辑器中查看。' }] };
    }
    if (!changed) return result;
    const oldLines = lines(before), newLines = lines(after);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let oldEnd = oldLines.length, newEnd = newLines.length;
    while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
    const runs = [];
    appendRun(runs, 'context', 0, 0, prefix);
    const edits = shortestEdits(oldLines, newLines, prefix, oldEnd, newEnd);
    if (edits) {
      for (const run of edits) appendRun(runs, run.kind, run.oldStart, run.newStart, run.length);
    } else {
      result.exact = false;
      result.rows.push({ kind: 'notice', text: '改动较大，按整段替换显示；新增和删除统计为替换行数。' });
      appendRun(runs, 'remove', prefix, prefix, oldEnd - prefix);
      appendRun(runs, 'add', oldEnd, prefix, newEnd - prefix);
    }
    appendRun(runs, 'context', oldEnd, newEnd, oldLines.length - oldEnd);
    for (const run of runs) {
      if (run.kind === 'add') result.added += run.length;
      if (run.kind === 'remove') result.removed += run.length;
    }
    let emitted = 0, omitted = 0;
    let remainingChanges = result.added + result.removed;
    const emitLine = (run, index) => {
      if (emitted >= MAX_ROWS) { omitted++; return; }
      const token = run.kind === 'add' ? newLines[run.newStart + index] : oldLines[run.oldStart + index];
      result.rows.push({ kind: run.kind, text: token.endsWith('\n') ? token.slice(0, -1) : token,
        oldLine: run.kind === 'add' ? null : run.oldStart + index + 1,
        newLine: run.kind === 'remove' ? null : run.newStart + index + 1,
        noNewline: !token.endsWith('\n') });
      emitted++;
    };
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.kind !== 'context') {
        // Reserve a share for later changed blocks, so a large replacement
        // still previews both deleted and added code.
        const available = Math.max(0, MAX_ROWS - emitted);
        const share = remainingChanges > available ? Math.ceil(available * run.length / remainingChanges) : available;
        const visible = Math.min(run.length, share);
        for (let j = 0; j < visible; j++) emitLine(run, j);
        omitted += run.length - visible;
        remainingChanges -= run.length;
        continue;
      }
      const leading = i > 0 ? Math.min(CONTEXT, run.length) : 0;
      const trailing = i < runs.length - 1 ? Math.min(CONTEXT, run.length - leading) : 0;
      if (run.length <= leading + trailing) {
        for (let j = 0; j < run.length; j++) emitLine(run, j);
      } else {
        for (let j = 0; j < leading; j++) emitLine(run, j);
        const skipped = run.length - leading - trailing;
        result.rows.push({ kind: 'gap', count: skipped, text: `··· 省略 ${skipped} 行未改动代码 ···` });
        for (let j = run.length - trailing; j < run.length; j++) emitLine(run, j);
      }
    }
    if (omitted) {
      result.truncated = true;
      result.rows.push({ kind: 'notice', text: `预览已省略 ${omitted} 行；以上统计包含全部改动。` });
    }
    if (!result.rows.length) result.rows.push({ kind: 'notice', text: result.created ? '新建空文件。' : '已删除空文件。' });
    return result;
  }

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Tokenise conservatively. The source always remains text nodes; no model or
  // file text is interpreted as HTML. Single very long lines are also bounded.
  function highlight(document, node, text, language) {
    const clipped = text.length > 16000 ? text.slice(0, 16000) : text;
    if (!language) node.appendChild(document.createTextNode(clipped));
    else {
      const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|#[^\n]*$|\b(?:const|let|var|function|return|if|else|for|while|class|new|async|await|import|from|export|default|throw|try|catch|finally|def|self|None|True|False|public|private|static|void|int|boolean|package|extends|implements|interface|type|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g;
      let previous = 0;
      for (const match of clipped.matchAll(pattern)) {
        if (match.index > previous) node.appendChild(document.createTextNode(clipped.slice(previous, match.index)));
        const token = match[0];
        const kind = /^["'`]/.test(token) ? 'string' : /^(?:\/\/|#)/.test(token) ? 'comment' : /^\d/.test(token) ? 'number' : 'keyword';
        node.appendChild(element(document, 'span', `code-diff-token-${kind}`, token));
        previous = match.index + token.length;
      }
      if (previous < clipped.length) node.appendChild(document.createTextNode(clipped.slice(previous)));
    }
    if (text.length > clipped.length) node.appendChild(element(document, 'span', 'code-diff-inline-note', ` … 本行预览省略 ${text.length - clipped.length} 个字符`));
  }

  function create(edit, options = {}) {
    const document = rootDocument();
    const path = typeof edit.path === 'string' ? edit.path : '未命名文件';
    const diff = compare(edit.before, edit.after);
    const card = element(document, 'article', 'code-diff-card');
    card.dataset.exact = String(diff.exact);
    card.setAttribute('aria-label', `${path} 的代码改动`);
    const header = element(document, 'header', 'code-diff-header');
    const filename = element(document, 'span', 'code-diff-filename', path.split(/[\\/]/).pop() || path);
    filename.title = path;
    header.appendChild(filename);
    const stats = element(document, 'span', 'code-diff-stats');
    const added = element(document, 'span', 'code-diff-added', diff.added === null ? '+—' : `+${diff.added}`);
    const removed = element(document, 'span', 'code-diff-removed', diff.removed === null ? '-—' : `-${diff.removed}`);
    added.setAttribute('aria-label', diff.added === null ? '新增行数未计算' : `新增 ${diff.added} 行`);
    removed.setAttribute('aria-label', diff.removed === null ? '删除行数未计算' : `删除 ${diff.removed} 行`);
    stats.append(added, removed);
    header.appendChild(stats);
    const copy = element(document, 'button', 'code-diff-copy', '⧉');
    copy.type = 'button';
    copy.title = edit.after === null ? '复制删除前的文件内容' : '复制修改后的文件内容';
    copy.setAttribute('aria-label', copy.title);
    copy.disabled = typeof options.onCopy !== 'function';
    const copyTitle = copy.title;
    copy.addEventListener('click', async () => {
      if (copy.disabled) return;
      copy.disabled = true;
      try {
        await options.onCopy(edit.after ?? edit.before ?? '', copy);
        copy.title = '已复制';
        copy.setAttribute('aria-label', '已复制文件内容');
      } catch {
        copy.title = '复制失败，请重试';
        copy.setAttribute('aria-label', copy.title);
      } finally {
        copy.disabled = false;
        setTimeout(() => { copy.title = copyTitle; copy.setAttribute('aria-label', copyTitle); }, 1800);
      }
    });
    header.appendChild(copy);
    card.appendChild(header);
    const scroll = element(document, 'div', 'code-diff-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', `${path} 的差异预览，可滚动查看`);
    const table = element(document, 'div', 'code-diff-lines');
    const language = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json[5c]?|java|py|cs|c|h|cc|cpp|hpp|go|rs|php|rb|sh|ps1|css|scss|html?|vue|svelte|ya?ml|toml)$/i.test(path);
    const rows = diff.rows.length ? diff.rows : [{ kind: 'notice', text: '文件内容未发生变化。' }];
    for (const row of rows) {
      const line = element(document, 'div', `code-diff-row code-diff-${row.kind}`);
      line.dataset.kind = row.kind;
      if (row.kind === 'gap' || row.kind === 'notice') line.appendChild(element(document, 'span', 'code-diff-note-text', row.text));
      else {
        const oldNumber = element(document, 'span', 'code-diff-old-line', row.oldLine === null ? '' : String(row.oldLine));
        const newNumber = element(document, 'span', 'code-diff-new-line', row.newLine === null ? '' : String(row.newLine));
        oldNumber.setAttribute('aria-hidden', 'true'); newNumber.setAttribute('aria-hidden', 'true');
        const sign = element(document, 'span', 'code-diff-sign', row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ');
        sign.setAttribute('aria-label', row.kind === 'add' ? '新增' : row.kind === 'remove' ? '删除' : '未改动');
        const code = element(document, 'code', 'code-diff-code');
        highlight(document, code, row.text, language);
        line.append(oldNumber, newNumber, sign, code);
        if (row.noNewline && row.kind !== 'context') {
          const note = element(document, 'span', 'code-diff-no-newline', '末尾无换行');
          note.title = '这一侧文件末尾没有换行符';
          line.appendChild(note);
        }
      }
      table.appendChild(line);
    }
    scroll.appendChild(table);
    card.appendChild(scroll);
    return card;
  }

  function rootDocument() {
    if (typeof document !== 'object' || !document.createElement) throw new Error('A document is required to render code differences');
    return document;
  }

  return Object.freeze({ compare, create });
});
