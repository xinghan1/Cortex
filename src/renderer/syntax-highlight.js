/* Small, text-only syntax colours shared by diffs, messages and command details. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeSyntax = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_CHARACTERS = 160000;
  const MAX_TOKENS = 12000;
  const aliases = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', py: 'python', ps1: 'powershell', ps: 'powershell', pwsh: 'powershell', sh: 'shell', bash: 'shell', zsh: 'shell', htm: 'html', xml: 'html', vue: 'html', svelte: 'html', scss: 'css', less: 'css', yml: 'yaml', json5: 'json', jsonc: 'json', cs: 'csharp', h: 'c', cc: 'cpp', hpp: 'cpp', rs: 'rust', rb: 'ruby' };
  const supported = new Set(['javascript', 'typescript', 'json', 'python', 'java', 'csharp', 'c', 'cpp', 'go', 'rust', 'php', 'ruby', 'shell', 'powershell', 'css', 'html', 'yaml', 'toml', 'sql']);
  const control = new Set('if else for while do switch case break continue return throw try catch finally yield await raise except elif with match when then fi done foreach until trap'.split(' '));
  const keywords = new Set('const let var function class new async import from export default def self public private protected static void package extends implements interface type enum abstract final synchronized volatile native namespace using struct union typedef template typename virtual override auto sizeof fn impl trait pub mod use mut unsafe defer func range select chan map go end module begin require include echo print pass lambda global nonlocal del delete in of as is not and or instanceof typeof debugger get set constructor super this assert async await'.split(' '));
  const types = new Set('String Number Boolean Object Array Promise Map Set WeakMap Date RegExp Error JSON Math Console console process document window Buffer int float double bool boolean byte char long short string integer decimal dynamic void any never unknown null undefined true false None True False nil NULL'.split(' '));
  const hashComments = new Set(['python', 'ruby', 'shell', 'powershell', 'yaml', 'toml']);
  const slashComments = new Set(['javascript', 'typescript', 'java', 'csharp', 'c', 'cpp', 'go', 'rust', 'php', 'json']);
  const identifierStart = char => !!char && /[A-Za-z_$\u0080-\uffff]/u.test(char);
  const identifierPart = char => !!char && /[\w$\u0080-\uffff]/u.test(char);

  function language(value) {
    const key = typeof value === 'string' ? value.trim().toLowerCase().replace(/^language-/, '') : '';
    const normalized = aliases[key] || key;
    return supported.has(normalized) ? normalized : '';
  }

  function languageForPath(path) {
    if (typeof path !== 'string') return '';
    const name = path.split(/[\\/]/).pop().toLowerCase();
    if (/^(?:dockerfile|makefile)$/i.test(name)) return 'shell';
    return language(name.includes('.') ? name.split('.').pop() : '');
  }

  // State is optional and caller-owned: successive lines can retain a block
  // comment, a Python triple quote or a JavaScript template literal.
  function tokenize(value, hint, state = {}, budget) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    const lang = language(hint);
    if (!lang) return [{ kind: 'plain', text }];
    const tokens = [];
    const availableCharacters = Number.isFinite(budget?.remainingCharacters) ? Math.max(0, budget.remainingCharacters) : MAX_CHARACTERS;
    const availableTokens = Number.isFinite(budget?.remainingTokens) ? Math.max(0, budget.remainingTokens) : MAX_TOKENS;
    const limit = Math.min(text.length, MAX_CHARACTERS, availableCharacters);
    let index = 0, colouredTokens = 0;
    const emit = (kind, start, end) => {
      const value = text.slice(start, end);
      const previous = tokens[tokens.length - 1];
      if (previous?.kind === kind) previous.text += value;
      else {
        tokens.push({ kind, text: value });
        if (kind !== 'plain') colouredTokens++;
      }
    };
    const following = end => { while (end < limit && /\s/u.test(text[end])) end++; return text[end]; };
    const quoted = (start, delimiter, continuing = false) => {
      let end = continuing ? start : start + delimiter.length;
      let closed = false;
      while (end < limit) {
        if (text[end] === '\\' && lang !== 'powershell') { end = Math.min(limit, end + 2); continue; }
        if (text[end] === '`' && lang === 'powershell') { end = Math.min(limit, end + 2); continue; }
        if (text.startsWith(delimiter, end)) { end += delimiter.length; closed = true; break; }
        if (text[end] === '\n' && delimiter.length === 1 && delimiter !== '`') break;
        end++;
      }
      const multiline = delimiter.length === 3 || delimiter === '`';
      if (!closed && multiline) state.quote = delimiter; else delete state.quote;
      emit(lang === 'json' && following(end) === ':' ? 'property' : 'string', start, end);
      return end;
    };
    while (index < limit && tokens.length < MAX_TOKENS && colouredTokens < availableTokens) {
      const start = index, char = text[index], next = text[index + 1];
      if (state.commentEnd) {
        const end = text.indexOf(state.commentEnd, index);
        index = end < 0 || end >= limit ? limit : Math.min(limit, end + state.commentEnd.length);
        if (end >= 0 && end < limit) delete state.commentEnd;
        emit('comment', start, index); continue;
      }
      if (state.quote) { index = quoted(start, state.quote, true); continue; }
      const block = text.startsWith('<!--', index) && lang === 'html' ? ['<!--', '-->'] :
        char === '/' && next === '*' && (slashComments.has(lang) || lang === 'css') ? ['/*', '*/'] :
          char === '<' && next === '#' && lang === 'powershell' ? ['<#', '#>'] : null;
      if (block) {
        const end = text.indexOf(block[1], index + block[0].length);
        index = end < 0 || end >= limit ? limit : Math.min(limit, end + block[1].length);
        if (end < 0 || end >= limit) state.commentEnd = block[1];
        emit('comment', start, index); continue;
      }
      if ((char === '/' && next === '/' && slashComments.has(lang)) ||
          (char === '#' && hashComments.has(lang)) || (char === '-' && next === '-' && lang === 'sql')) {
        const end = text.indexOf('\n', index);
        index = end < 0 || end > limit ? limit : end;
        emit('comment', start, index); continue;
      }
      if (char === '"' || char === "'" || (char === '`' && ['javascript', 'typescript', 'shell'].includes(lang))) {
        const delimiter = lang === 'python' && text.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
        index = quoted(index, delimiter); continue;
      }
      if (lang === 'css' && char === '#' && /[\da-f]/i.test(next || '')) {
        index++; while (index < limit && /[\da-f]/i.test(text[index])) index++;
        emit('number', start, index); continue;
      }
      if (/\d/.test(char) || (char === '.' && /\d/.test(next || ''))) {
        index++; while (index < limit && /[\w.%]/u.test(text[index])) index++;
        if ((text[index] === '+' || text[index] === '-') && /[eE]/.test(text[index - 1])) {
          index++; while (index < limit && /\d/.test(text[index])) index++;
        }
        emit('number', start, index); continue;
      }
      if (identifierStart(char) || (lang === 'css' && char === '-' && identifierStart(next))) {
        index++;
        while (index < limit && (identifierPart(text[index]) || (['css', 'powershell'].includes(lang) && text[index] === '-'))) index++;
        const word = text.slice(start, index), folded = ['powershell', 'sql'].includes(lang) ? word.toLowerCase() : word;
        let kind = control.has(folded) ? 'control' : keywords.has(folded) ? 'keyword' : types.has(word) ? 'type' :
          following(index) === '(' ? 'function' : following(index) === ':' || text[start - 1] === '.' ? 'property' : 'variable';
        if (lang === 'json') kind = /^(?:true|false|null)$/.test(word) ? 'keyword' : 'plain';
        if (lang === 'html') kind = text[start - 1] === '<' || text.slice(Math.max(0, start - 2), start) === '</' ? 'keyword' : following(index) === '=' ? 'property' : 'plain';
        if (lang === 'powershell' && /^[A-Z][a-z]+-[A-Za-z]+$/.test(word)) kind = 'function';
        emit(kind, start, index); continue;
      }
      if (/[=+*\/<>!&|?:~^%-]/.test(char)) {
        index++; while (index < limit && /[=+*\/<>!&|?:~^%-]/.test(text[index])) index++;
        emit('operator', start, index); continue;
      }
      index++;
      while (index < limit && /\s/u.test(char) && /\s/u.test(text[index])) index++;
      emit('plain', start, index);
    }
    // A diff can call us once per line. Its optional shared budget bounds the
    // whole card independently of the old/new lexical state for each side.
    if (budget) {
      budget.remainingCharacters = Math.max(0, availableCharacters - index);
      budget.remainingTokens = Math.max(0, availableTokens - colouredTokens);
    }
    // Limit visual work, never truncate or silently change copied source.
    if (index < text.length) emit('plain', index, text.length);
    return tokens;
  }

  function append(document, node, text, hint, state, budget) {
    for (const token of tokenize(text, hint, state, budget)) {
      if (token.kind === 'plain') node.appendChild(document.createTextNode(token.text));
      else {
        const span = document.createElement('span');
        span.className = `syntax-token syntax-${token.kind}`;
        span.textContent = token.text;
        node.appendChild(span);
      }
    }
    return node;
  }
  return Object.freeze({ append, tokenize, languageForPath });
});
