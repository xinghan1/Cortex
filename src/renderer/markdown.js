/* A small, DOM-only Markdown renderer. Model text is never interpreted as HTML. */
(() => {
  'use strict';
  const MAX_DEPTH = 18;
  const escapable = /[\\`*{}\[\]()#+\-.!_>~|]/;
  const whitespace = char => !char || /\s/u.test(char);
  const word = char => !!char && /[\p{L}\p{N}]/u.test(char);
  const textNode = value => ({ type: 'text', value });

  function safeMarkdownUrl(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value)) return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function parseInline(source, depth = 0, links = true) {
    const text = String(source || '');
    if (depth > MAX_DEPTH) return [textNode(text)];
    const nodes = [], missing = new Set();
    let plain = '', index = 0;
    const flush = () => { if (plain) { nodes.push(textNode(plain)); plain = ''; } };
    const locate = (needle, from) => {
      if (missing.has(needle)) return -1;
      const found = text.indexOf(needle, from);
      if (found < 0) missing.add(needle);
      return found;
    };
    while (index < text.length) {
      const char = text[index];
      if (char === '\\' && escapable.test(text[index + 1] || '')) { plain += text[index + 1]; index += 2; continue; }
      if (char === '`') {
        let count = 1;
        while (text[index + count] === '`') count++;
        const marker = '`'.repeat(count);
        let end = locate(marker, index + count);
        while (end >= 0 && (text[end - 1] === '`' || text[end + count] === '`')) end = locate(marker, end + count);
        if (end >= 0) { flush(); nodes.push({ type: 'code', value: text.slice(index + count, end) }); index = end + count; continue; }
        plain += marker; index += count; continue;
      }
      // Images remain visible source text; no remote image request is ever made.
      const isImage = char === '!' && text[index + 1] === '[';
      if ((char === '[' && links) || isImage) {
        const begin = index + (isImage ? 1 : 0);
        let bracket = locate(']', begin + 1);
        while (bracket >= 0 && text[bracket - 1] === '\\') bracket = locate(']', bracket + 1);
        if (bracket >= 0 && bracket - begin <= 8192 && text[bracket + 1] === '(') {
          let end = bracket + 2, balance = 1;
          for (; end < Math.min(text.length, bracket + 8192) && balance; end++) {
            if (text[end] === '\\') { end++; continue; }
            if (text[end] === '(') balance++;
            if (text[end] === ')') balance--;
            if (balance > 16 || text[end] === '\n') break;
          }
          if (!balance) {
            const raw = text.slice(index, end);
            let target = text.slice(bracket + 2, end - 1).trim();
            target = target.replace(/\s+["'][^"'\n]*["']$/u, '').replace(/^<([^<>]+)>$/u, '$1').replace(/\\([()\\])/g, '$1');
            const href = !isImage && safeMarkdownUrl(target);
            if (href) { flush(); nodes.push({ type: 'link', href, children: parseInline(text.slice(begin + 1, bracket), depth + 1, false) }); }
            else plain += raw;
            index = end; continue;
          }
        }
      }
      if (links && char === '<') {
        const end = locate('>', index + 1);
        if (end >= 0 && end - index <= 8192) {
          const href = safeMarkdownUrl(text.slice(index + 1, end));
          if (href) { flush(); nodes.push({ type: 'link', href, children: [textNode(text.slice(index + 1, end))] }); index = end + 1; continue; }
        }
      }
      if (char === '*' || char === '_' || (char === '~' && text[index + 1] === '~')) {
        const run = char === '~' ? 2 : text.startsWith(char.repeat(3), index) ? 3 : text[index + 1] === char ? 2 : 1;
        const marker = char.repeat(run);
        if (!whitespace(text[index + run]) && !(char === '_' && word(text[index - 1]) && word(text[index + run]))) {
          let end = locate(marker, index + run);
          while (end >= 0) {
            let closingRun = run;
            while (text[end + closingRun] === char) closingRun++;
            if (!whitespace(text[end - 1]) && !(run === 1 && closingRun === 2) && !(char === '_' && word(text[end - 1]) && word(text[end + closingRun]))) break;
            end = locate(marker, end + closingRun);
          }
          if (end >= 0) {
            if (run === 2 && char !== '~' && text[end + 2] === char) end++;
            flush();
            let children = parseInline(text.slice(index + run, end), depth + 1, links);
            if (run === 3) children = [{ type: 'em', children }];
            nodes.push({ type: char === '~' ? 'del' : run >= 2 ? 'strong' : 'em', children });
            index = end + run; continue;
          }
        }
      }
      plain += char; index++;
    }
    flush();
    return nodes;
  }

  const indentation = value => (/^[ \t]*/u.exec(value)?.[0] || '').replace(/\t/g, '    ').length;
  const listMarker = line => /^( {0,3})([-+*]|\d{1,9}[.)])\s+(.*)$/u.exec(line);
  const fenceMarker = line => /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
  const heading = line => /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
  const rule = line => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(line);
  function tableCells(line) {
    const trimmed = line.trim(), cells = [];
    let value = '', codeRun = 0;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '\\' && i + 1 < trimmed.length) { value += trimmed[i] + trimmed[++i]; continue; }
      if (trimmed[i] === '`') {
        let count = 1; while (trimmed[i + count] === '`') count++;
        if (!codeRun) codeRun = count; else if (codeRun === count) codeRun = 0;
        value += '`'.repeat(count); i += count - 1; continue;
      }
      if (trimmed[i] === '|' && !codeRun) { cells.push(value.trim()); value = ''; } else value += trimmed[i];
    }
    cells.push(value.trim());
    if (trimmed.startsWith('|')) cells.shift();
    if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
    return cells;
  }
  function tableAlignment(line) {
    if (!line?.includes('|')) return null;
    const cells = tableCells(line);
    if (!cells.length || !cells.every(cell => /^:?-{3,}:?$/u.test(cell))) return null;
    return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
  }

  function parseBlocks(lines, depth = 0) {
    const blocks = [];
    if (depth > MAX_DEPTH) return [{ type: 'paragraph', children: [textNode(lines.map(line => line.text).join('\n'))] }];
    const startsBlock = i => heading(lines[i]?.text || '') || fenceMarker(lines[i]?.text || '') || rule(lines[i]?.text || '') || /^ {0,3}>/u.test(lines[i]?.text || '') || listMarker(lines[i]?.text || '') || (lines[i]?.text.includes('|') && tableAlignment(lines[i + 1]?.text));
    let index = 0;
    while (index < lines.length) {
      const line = lines[index].text;
      if (!line.trim()) { index++; continue; }
      const fence = fenceMarker(line);
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const marker = fence[1][0], count = fence[1].length, code = [];
        let cursor = index + 1;
        for (; cursor < lines.length; cursor++) {
          const match = /^ {0,3}(`+|~+)\s*$/u.exec(lines[cursor].text);
          if (match && match[1][0] === marker && match[1].length >= count) break;
          code.push(lines[cursor].text + lines[cursor].ending);
        }
        blocks.push({ type: 'fence', language: fence[2].trim().split(/\s/u)[0].slice(0, 60), value: code.join('') });
        index = cursor < lines.length ? cursor + 1 : cursor; continue;
      }
      const title = heading(line);
      if (title) { blocks.push({ type: 'heading', level: title[1].length, children: parseInline(title[2].replace(/[ \t]+#+[ \t]*$/u, '')) }); index++; continue; }
      if (rule(line)) { blocks.push({ type: 'rule' }); index++; continue; }
      if (/^ {0,3}>/u.test(line)) {
        const quoted = [];
        while (index < lines.length && /^ {0,3}>/u.test(lines[index].text)) { quoted.push({ ...lines[index], text: lines[index].text.replace(/^ {0,3}> ?/u, '') }); index++; }
        blocks.push({ type: 'quote', children: parseBlocks(quoted, depth + 1) }); continue;
      }
      const marker = listMarker(line);
      if (marker) {
        const ordered = /^\d/u.test(marker[2]), items = [];
        const start = ordered ? Number.parseInt(marker[2], 10) : undefined;
        while (index < lines.length) {
          const itemMarker = listMarker(lines[index].text);
          if (!itemMarker || /^\d/u.test(itemMarker[2]) !== ordered) break;
          const width = itemMarker[0].length - itemMarker[3].length;
          const item = [{ ...lines[index], text: itemMarker[3] }];
          index++;
          while (index < lines.length) {
            if (!lines[index].text.trim()) {
              const next = lines[index + 1]?.text || '';
              if (next && indentation(next) >= width) { item.push(lines[index++]); continue; }
              if (listMarker(next) && /^\d/u.test(listMarker(next)[2]) === ordered) { index++; break; }
              break;
            }
            if (indentation(lines[index].text) >= width) { item.push({ ...lines[index], text: lines[index].text.replace(new RegExp('^ {0,' + width + '}'), '') }); index++; continue; }
            if (listMarker(lines[index].text) || startsBlock(index)) break;
            item.push(lines[index++]);
          }
          items.push(parseBlocks(item, depth + 1));
        }
        blocks.push({ type: 'list', ordered, ...(ordered ? { start } : {}), items }); continue;
      }
      const align = line.includes('|') ? tableAlignment(lines[index + 1]?.text) : null;
      if (align) {
        const headers = tableCells(line);
        if (headers.length === align.length) {
          const rows = []; index += 2;
          while (index < lines.length && lines[index].text.trim() && lines[index].text.includes('|') && !startsBlock(index)) {
            const cells = tableCells(lines[index++].text);
            rows.push(align.map((_, i) => parseInline(cells[i] || '')));
          }
          blocks.push({ type: 'table', align, headers: headers.map(cell => parseInline(cell)), rows }); continue;
        }
      }
      const paragraph = [line]; index++;
      while (index < lines.length && lines[index].text.trim() && !startsBlock(index)) paragraph.push(lines[index++].text);
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    }
    return blocks;
  }

  function parseMarkdown(value) {
    const source = String(value ?? ''), lines = [];
    const matcher = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    let match;
    while ((match = matcher.exec(source)) && match[0]) lines.push({ text: match[1], ending: match[2] });
    return parseBlocks(lines);
  }

  function renderMarkdown(container, source, options = {}) {
    const doc = container.ownerDocument, fragment = doc.createDocumentFragment();
    function element(tag, className) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    }
    function inline(parent, nodes) {
      for (const token of nodes) {
        if (token.type === 'text') { parent.append(doc.createTextNode(token.value)); continue; }
        const node = element(token.type === 'link' ? 'a' : token.type);
        if (token.type === 'link') {
          const href = safeMarkdownUrl(token.href);
          if (!href) { inline(parent, token.children); continue; }
          node.href = href; node.title = href; node.rel = 'noopener noreferrer';
          node.addEventListener('click', event => {
            event.preventDefault();
            if (typeof options.onLink === 'function') options.onLink(href, event);
          });
          node.addEventListener('auxclick', event => event.preventDefault());
          inline(node, token.children);
        } else if (token.type === 'code') node.textContent = token.value;
        else inline(node, token.children);
        parent.append(node);
      }
    }
    function blocks(parent, tokens) {
      for (const token of tokens) {
        let node;
        if (token.type === 'fence') {
          node = element('div', 'message-code');
          const label = element('div', 'message-code-label'); label.textContent = token.language || '代码';
          const pre = element('pre'); pre.tabIndex = 0;
          const code = element('code');
          if (globalThis.ForgeSyntax?.append) globalThis.ForgeSyntax.append(doc, code, token.value, token.language);
          else code.textContent = token.value;
          pre.append(code); node.append(label, pre);
        } else if (token.type === 'paragraph' || token.type === 'heading') {
          node = element(token.type === 'paragraph' ? 'p' : 'h' + token.level, token.type === 'paragraph' ? 'message-paragraph' : 'markdown-heading');
          inline(node, token.children);
        } else if (token.type === 'rule') node = element('hr');
        else if (token.type === 'quote') { node = element('blockquote'); blocks(node, token.children); }
        else if (token.type === 'list') {
          node = element(token.ordered ? 'ol' : 'ul');
          if (token.ordered && token.start !== 1) node.start = token.start;
          for (const item of token.items) { const li = element('li'); blocks(li, item); node.append(li); }
        } else if (token.type === 'table') {
          node = element('div', 'markdown-table-wrap'); node.tabIndex = 0;
          const table = element('table'), head = element('thead'), row = element('tr'), body = element('tbody');
          token.headers.forEach((content, index) => { const cell = element('th', 'markdown-align-' + token.align[index]); inline(cell, content); row.append(cell); });
          head.append(row);
          for (const content of token.rows) { const tr = element('tr'); content.forEach((value, index) => { const cell = element('td', 'markdown-align-' + token.align[index]); inline(cell, value); tr.append(cell); }); body.append(tr); }
          table.append(head, body); node.append(table);
        }
        if (node) parent.append(node);
      }
    }
    blocks(fragment, parseMarkdown(source));
    container.classList.add('markdown-body');
    container.replaceChildren(fragment);
    return container;
  }

  globalThis.ForgeMarkdown = Object.freeze({ parseMarkdown, parseInline, renderMarkdown, safeMarkdownUrl });
})();
