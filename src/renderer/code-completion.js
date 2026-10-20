/* Offline, text-only suggestions for the native file editor. No code is executed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeCompletion = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_CHARACTERS = 160000, MAX_WORDS = 12000, MAX_ITEMS = 40;
  const extensions = Object.freeze({ py: 'python', java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', c: 'c', h: 'c', html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript' });
  const wordPart = char => !!char && /[A-Za-z0-9_$\u0080-\uffff]/u.test(char);
  const cssPart = char => !!char && /[A-Za-z0-9_-]/.test(char);
  const htmlPart = char => !!char && /[A-Za-z0-9_:-]/.test(char);
  const entry = (label, insertText = label, detail = '关键字', kind = 'keyword') => ({ label, insertText, detail, kind });
  const words = (text, detail = '关键字', kind = 'keyword') => text.split(' ').filter(Boolean).map(word => entry(word, word, detail, kind));
  const snippet = (label, text, detail) => entry(label, text, detail, 'snippet');
  const call = (name, args = 'value', detail = '函数') => entry(name, name + '(' + (args ? '${1:' + args + '}' : '') + ')${0}', detail, 'function');
  const catalogs = {
    python: [
      ...words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'),
      ...words('str int float bool list dict set tuple bytes object Exception ValueError TypeError', '内置类型', 'class'),
      ...['print', 'len', 'range', 'enumerate', 'zip', 'sorted', 'reversed', 'sum', 'min', 'max', 'abs', 'round', 'isinstance', 'input', 'open', 'super'].map(name => call(name)),
      snippet('def', 'def ${1:function_name}(${2:args}):\n    ${3:pass}\n${0}', '函数定义'),
      snippet('for', 'for ${1:item} in ${2:items}:\n    ${3:pass}\n${0}', 'for 循环'),
      snippet('if', 'if ${1:condition}:\n    ${2:pass}\n${0}', '条件语句'),
      snippet('class', 'class ${1:ClassName}:\n    def __init__(self${2:}):\n        ${3:pass}\n${0}', '类定义'),
      snippet('main', 'if __name__ == "__main__":\n    ${1:main()}\n${0}', '程序入口'),
      snippet('import', 'import ${1:module}${0}', '导入模块'),
      snippet('from', 'from ${1:module} import ${2:name}${0}', '导入模块成员'),
    ],
    java: [
      ...words('abstract assert boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'),
      ...words('String System Object Integer Long Double Boolean List ArrayList Map HashMap Set HashSet Arrays Collections Optional', '常用类型', 'class'),
      snippet('sout', 'System.out.println(${1:value});${0}', '标准输出'),
      snippet('main', 'public static void main(String[] args) {\n    ${1}\n}${0}', '程序入口'),
      snippet('class', 'public class ${1:ClassName} {\n    ${2}\n}${0}', '类定义'),
      snippet('for', 'for (int i = 0; i < ${1:count}; i++) {\n    ${2}\n}${0}', 'for 循环'),
      snippet('if', 'if (${1:condition}) {\n    ${2}\n}${0}', '条件语句'),
      snippet('try', 'try {\n    ${1}\n} catch (${2:Exception} ${3:e}) {\n    ${4}\n}${0}', '异常处理'),
    ],
    csharp: [
      ...words('abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield'),
      ...words('Console String Math DateTime Task List Dictionary HashSet IEnumerable Exception', '常用类型', 'class'),
      snippet('cw', 'Console.WriteLine(${1:value});${0}', '控制台输出'),
      snippet('main', 'static void Main(string[] args) {\n    ${1}\n}${0}', '程序入口'),
      snippet('class', 'public class ${1:ClassName} {\n    ${2}\n}${0}', '类定义'),
      snippet('prop', 'public ${1:string} ${2:Name} { get; set; }${0}', '自动属性'),
      snippet('foreach', 'foreach (var ${1:item} in ${2:items}) {\n    ${3}\n}${0}', 'foreach 循环'),
      snippet('if', 'if (${1:condition}) {\n    ${2}\n}${0}', '条件语句'),
    ],
    c: [
      ...words('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool NULL'),
      ...['printf', 'scanf', 'fprintf', 'fopen', 'fclose', 'malloc', 'calloc', 'realloc', 'free', 'strlen', 'strcmp', 'memcpy', 'memset'].map(name => call(name)),
      snippet('main', 'int main(void) {\n    ${1}\n    return 0;\n}${0}', '程序入口'),
      snippet('include', 'include <${1:stdio.h}>${0}', '头文件（在 # 后使用）'),
      snippet('for', 'for (int i = 0; i < ${1:count}; i++) {\n    ${2}\n}${0}', 'for 循环'),
      snippet('if', 'if (${1:condition}) {\n    ${2}\n}${0}', '条件语句'),
      snippet('struct', 'struct ${1:Name} {\n    ${2}\n};${0}', '结构体'),
    ],
    cpp: [
      ...words('alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_cast struct switch template this thread_local throw true try typedef typename union unsigned using virtual void volatile wchar_t while'),
      ...words('std string vector map set unordered_map unique_ptr shared_ptr cout cin endl', '标准库', 'class'),
      snippet('main', 'int main() {\n    ${1}\n    return 0;\n}${0}', '程序入口'),
      snippet('include', 'include <${1:iostream}>${0}', '头文件（在 # 后使用）'),
      snippet('cout', 'std::cout << ${1:value} << std::endl;${0}', '标准输出'),
      snippet('class', 'class ${1:ClassName} {\npublic:\n    ${2}\n};${0}', '类定义'),
      snippet('for', 'for (const auto& ${1:item} : ${2:items}) {\n    ${3}\n}${0}', '范围 for 循环'),
      snippet('if', 'if (${1:condition}) {\n    ${2}\n}${0}', '条件语句'),
    ],
    javascript: [
      ...words('async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield'),
      ...words('console document window Math JSON Object Array String Number Boolean Promise Map Set Date Error RegExp', '内置对象', 'class'),
      ...['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'parseInt', 'parseFloat'].map(name => call(name)),
      snippet('function', 'function ${1:name}(${2:args}) {\n    ${3}\n}${0}', '函数定义'),
      snippet('const', 'const ${1:name} = ${2:value};${0}', '常量声明'),
      snippet('log', 'console.log(${1:value});${0}', '控制台输出'),
      snippet('if', 'if (${1:condition}) {\n    ${2}\n}${0}', '条件语句'),
      snippet('for', 'for (const ${1:item} of ${2:items}) {\n    ${3}\n}${0}', 'for…of 循环'),
      snippet('class', 'class ${1:ClassName} {\n    constructor(${2:args}) {\n        ${3}\n    }\n}${0}', '类定义'),
      snippet('import', 'import ${1:name} from "${2:module}";${0}', '模块导入'),
    ],
  };
  const members = {
    javascript: {
      console: ['log', 'warn', 'error', 'info', 'debug', 'table', 'time', 'timeEnd'].map(name => call(name)),
      Math: [...['abs', 'ceil', 'floor', 'round', 'max', 'min', 'pow', 'sqrt', 'random'].map(name => call(name, name === 'random' ? '' : 'value')), ...words('PI E', '数学常量', 'property')],
      JSON: [call('parse', 'text'), call('stringify', 'value')],
      Object: ['keys', 'values', 'entries', 'assign', 'freeze', 'fromEntries'].map(name => call(name)),
      Array: [call('from', 'items'), call('isArray', 'value'), call('of', 'items')],
      Promise: ['all', 'allSettled', 'race', 'resolve', 'reject'].map(name => call(name)),
      document: [...['querySelector', 'querySelectorAll', 'getElementById', 'createElement', 'addEventListener'].map(name => call(name, 'selector')), ...words('body head title documentElement', '文档属性', 'property')],
      window: [...['addEventListener', 'removeEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame'].map(name => call(name)), ...words('location localStorage sessionStorage innerWidth innerHeight', '窗口属性', 'property')],
    },
    python: {
      math: [...['sqrt', 'ceil', 'floor', 'sin', 'cos', 'log', 'pow'].map(name => call(name)), ...words('pi e inf', '数学常量', 'property')],
      os: [...['getcwd', 'listdir', 'makedirs', 'remove', 'rename'].map(name => call(name)), ...words('path environ', '模块成员', 'property')],
      'os.path': ['join', 'exists', 'isfile', 'isdir', 'basename', 'dirname', 'abspath'].map(name => call(name, 'path')),
      sys: [...words('argv path version executable', '模块属性', 'property'), call('exit', 'code')],
      random: [call('random', ''), call('randint', 'start, end'), call('choice', 'items'), call('shuffle', 'items')],
      str: ['lower', 'upper', 'strip', 'split', 'join', 'replace', 'startswith', 'endswith', 'format'].map(name => call(name)),
    },
    java: {
      System: [...words('out err in', '系统流', 'property'), ...['currentTimeMillis', 'nanoTime', 'exit', 'getProperty'].map(name => call(name))],
      'System.out': ['println', 'print', 'printf'].map(name => call(name, 'value', '标准输出')),
      'System.err': ['println', 'print', 'printf'].map(name => call(name, 'value', '错误输出')),
      Math: ['abs', 'ceil', 'floor', 'round', 'max', 'min', 'pow', 'sqrt', 'random'].map(name => call(name)),
      Arrays: ['asList', 'sort', 'copyOf', 'equals', 'toString', 'stream'].map(name => call(name)),
      Collections: ['sort', 'reverse', 'emptyList', 'singletonList', 'unmodifiableList'].map(name => call(name)),
      String: ['valueOf', 'format', 'join'].map(name => call(name)),
    },
    csharp: {
      Console: ['WriteLine', 'Write', 'ReadLine', 'ReadKey', 'Clear'].map(name => call(name, /^Read|^Clear/.test(name) ? '' : 'value')),
      Math: ['Abs', 'Ceiling', 'Floor', 'Round', 'Max', 'Min', 'Pow', 'Sqrt'].map(name => call(name)),
      String: ['Format', 'Join', 'IsNullOrEmpty', 'IsNullOrWhiteSpace'].map(name => call(name)),
      string: ['Format', 'Join', 'IsNullOrEmpty', 'IsNullOrWhiteSpace'].map(name => call(name)),
      Task: ['Run', 'Delay', 'WhenAll', 'WhenAny'].map(name => call(name)),
    },
    cpp: { std: [...words('cout cin cerr clog endl string vector map set unordered_map unique_ptr shared_ptr nullopt', 'C++ 标准库', 'property'), ...['make_unique', 'make_shared', 'move', 'forward', 'sort', 'find', 'begin', 'end', 'getline'].map(name => call(name))] },
    c: {},
  };
  members.csharp['System.Console'] = members.csharp.Console;
  members.csharp['System.Math'] = members.csharp.Math;
  const tags = 'html head body title meta link script style header footer main nav section article aside div span p a ul ol li img picture source button input label form textarea select option table thead tbody tr th td h1 h2 h3 h4 h5 h6 strong em small pre code blockquote br hr video audio canvas svg details summary dialog'.split(' ');
  const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
  const attributes = 'id class title style hidden lang dir role tabindex data- aria-label aria-hidden'.split(' ');
  const tagAttributes = { a: 'href target rel download', img: 'src alt width height loading', input: 'type name value placeholder required disabled checked autocomplete', button: 'type disabled name value', form: 'action method enctype', label: 'for', script: 'src type defer async', link: 'rel href type media', meta: 'name content charset', textarea: 'name rows cols placeholder required disabled', select: 'name multiple required disabled', option: 'value selected disabled', html: 'lang', video: 'src controls autoplay muted loop poster' };
  const htmlValues = { type: 'text button submit reset password email number checkbox radio file hidden search tel url date module', target: '_blank _self _parent _top', rel: 'stylesheet noopener noreferrer icon preload', loading: 'lazy eager', method: 'get post', lang: 'zh-CN en ja', dir: 'ltr rtl auto', autocomplete: 'on off', role: 'button dialog navigation main alert status tab tabpanel', 'aria-hidden': 'true false' };
  const properties = 'color background background-color background-image display position top right bottom left inset width height min-width max-width min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-radius border-color border-width border-style box-shadow box-sizing opacity overflow overflow-x overflow-y font font-family font-size font-weight line-height letter-spacing text-align text-decoration white-space cursor content z-index flex flex-direction flex-wrap flex-grow flex-shrink flex-basis justify-content align-items align-content align-self gap row-gap column-gap grid grid-template-columns grid-template-rows grid-column grid-row place-items transform transition animation filter backdrop-filter visibility outline object-fit aspect-ratio'.split(' ');
  const cssValues = {
    display: 'flex grid block inline inline-block inline-flex inline-grid none contents', position: 'relative absolute fixed sticky static',
    'flex-direction': 'row column row-reverse column-reverse', 'flex-wrap': 'wrap nowrap wrap-reverse',
    'justify-content': 'center flex-start flex-end space-between space-around space-evenly', 'align-items': 'center stretch flex-start flex-end baseline',
    'align-content': 'center stretch flex-start flex-end space-between space-around', 'align-self': 'auto center stretch flex-start flex-end',
    'text-align': 'left right center justify start end', 'text-decoration': 'none underline line-through overline',
    overflow: 'hidden auto scroll visible clip', 'overflow-x': 'hidden auto scroll visible clip', 'overflow-y': 'hidden auto scroll visible clip',
    'font-weight': 'normal bold bolder lighter 100 200 300 400 500 600 700 800 900',
    'font-family': 'Arial sans-serif serif monospace system-ui Georgia Verdana',
    'box-sizing': 'border-box content-box', cursor: 'pointer default text move grab grabbing not-allowed crosshair',
    visibility: 'visible hidden collapse', 'object-fit': 'cover contain fill none scale-down', 'border-style': 'solid dashed dotted double none',
    'white-space': 'normal nowrap pre pre-wrap pre-line break-spaces',
  };

  function languageForPath(path) {
    if (typeof path !== 'string') return '';
    return extensions[path.split(/[\\/]/).pop().toLowerCase().split('.').pop()] || '';
  }

  // Scan only the bounded document prefix. A trailing quote/comment stays closed
  // to completion; this is a lexical editor aid, not a language server/parser.
  function lexical(text, language, end = text.length, collect = false) {
    let i = 0, state = '', quote = '', last = '', count = 0;
    const identifiers = new Map();
    while (i < end) {
      const char = text[i], next = text[i + 1];
      if (state === 'line') { if (char === '\n' || char === '\r') state = ''; i++; continue; }
      if (state === 'block') { if (char === '*' && next === '/') { state = ''; i += 2; } else i++; continue; }
      if (state === 'string' || state === 'regex' || state === 'raw') {
        if (char === '\\' && state !== 'raw' && quote !== '@"') { i += 2; continue; }
        if (language === 'csharp' && quote === '@"' && char === '"' && next === '"') { i += 2; continue; }
        const closer = quote === '@"' ? '"' : quote;
        if (text.startsWith(closer, i) && i + closer.length <= end) { i += closer.length; state = ''; last = 'v'; continue; }
        if ((char === '\n' || char === '\r') && quote.length === 1 && quote !== '`') { state = ''; quote = ''; }
        i++; continue;
      }
      if (language === 'python' && char === '#') { state = 'line'; i++; continue; }
      if (language !== 'python' && char === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (language !== 'python' && char === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (language === 'csharp' && char === '@' && next === '"') { state = 'string'; quote = '@"'; i += 2; continue; }
      if (language === 'cpp' && char === 'R' && next === '"') {
        const rawStart = /^R"([^\s()\\]{0,16})\(/.exec(text.slice(i, i + 20));
        if (rawStart) { state = 'raw'; quote = ')' + rawStart[1] + '"'; i += rawStart[0].length; continue; }
      }
      if (char === '"' || char === "'" || (language === 'javascript' && char === '`')) {
        quote = (language === 'python' || (language === 'java' || language === 'csharp') && char === '"') && text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
        state = 'string'; i += quote.length; continue;
      }
      if (language === 'javascript' && char === '/' && (!last || '=(:,[!&|?;{}'.includes(last))) { state = 'regex'; quote = '/'; i++; continue; }
      if (collect && /[A-Za-z_$\u0080-\uffff]/u.test(char)) {
        const start = i++;
        while (i < end && wordPart(text[i])) i++;
        const name = text.slice(start, i);
        if (++count <= MAX_WORDS && name.length <= 96) identifiers.set(name, (identifiers.get(name) || 0) + 1);
        if (count >= MAX_WORDS) break;
        last = 'v'; continue;
      }
      if (!/\s/.test(char)) last = char;
      i++;
    }
    return { state, quote, identifiers };
  }

  function rangeAt(text, offset, part = wordPart) {
    let from = offset, to = offset;
    while (from > 0 && part(text[from - 1])) from--;
    while (to < text.length && part(text[to])) to++;
    return { from, to, prefix: text.slice(from, offset) };
  }

  function ranked(items, prefix) {
    const lower = prefix.toLowerCase(), choices = new Map();
    for (let order = 0; order < items.length; order++) {
      const item = items[order];
      if (!item.label.toLowerCase().startsWith(lower)) continue;
      const rank = (item.label === prefix ? -10000 : item.label.startsWith(prefix) ? -1000 : 0) + (item.kind === 'snippet' ? -200 : item.kind === 'variable' ? 40 : 0) + order / 1000;
      const previous = choices.get(item.label);
      if (!previous || rank < previous.rank) choices.set(item.label, { item, rank });
    }
    return [...choices.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_ITEMS).map(({ item }) => ({ ...item }));
  }

  function result(language, range, items, source = '') {
    const selected = ranked(items, range.prefix);
    if (/^\s*\(/.test(source.slice(range.to, range.to + 64))) {
      for (const item of selected) {
        const callHead = /^((?:[A-Za-z_$][\w$]*(?:\.|::))*[A-Za-z_$][\w$]*)\(/.exec(item.insertText);
        if (callHead) item.insertText = callHead[1];
      }
    }
    return selected.length ? { language, from: range.from, to: range.to, items: selected } : null;
  }

  function codeSuggestions(language, text, offset, explicit) {
    if (lexical(text, language, offset).state) return null;
    const range = rangeAt(text, offset);
    if (range.prefix.length > 96 || /^\d/.test(range.prefix)) return null;
    const before = text.slice(Math.max(0, range.from - 256), range.from);
    if (language === 'python' && /(?:^|[\r\n])\s*(?:import|from)\s+[^\r\n]*$/.test(before)) {
      const line = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1);
      if (!/\bimport\b/.test(line.trim().replace(/^import\b/, ''))) {
        if (!explicit && range.prefix.length < 1) return null;
        return result(language, range, words('os sys math random datetime json re pathlib collections itertools functools typing asyncio time logging unittest dataclasses statistics subprocess csv io', '标准库模块', 'module'));
      }
      const fromModule = /^\s*from\s+([\w.]+)\s+import\s+/.exec(line);
      if (fromModule && members.python[fromModule[1]]) return result(language, range, members.python[fromModule[1]].map(item => ({ ...item, insertText: item.label, kind: 'property' })));
    }
    const member = /([A-Za-z_$][\w$]*(?:\s*(?:\.|::)\s*[A-Za-z_$][\w$]*)*)\s*(\.|::)\s*$/.exec(before);
    if (member) {
      if (!explicit && !range.prefix) return null;
      const receiver = member[1].replace(/\s/g, '');
      const known = members[language]?.[receiver];
      if (known && (language !== 'cpp' || member[2] === '::')) return result(language, range, known, text);
      // Existing members of this exact receiver are useful; unrelated global
      // keywords are not. Escape the receiver before constructing this regexp.
      const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expression = new RegExp('(?:^|[^\\w$])' + escaped + '\\s*' + (member[2] === '::' ? '::' : '\\.') + '\\s*([A-Za-z_$][\\w$]{0,95})', 'g');
      const observed = [], seen = new Set();
      let match, inspected = 0;
      while ((match = expression.exec(text)) && inspected++ < MAX_WORDS) {
        if (seen.has(match[1]) || (match.index <= range.from && expression.lastIndex >= offset)) continue;
        seen.add(match[1]); observed.push(entry(match[1], match[1], '本文件成员', 'variable'));
      }
      return result(language, range, observed, text);
    }
    // A dot after an expression, optional chaining or pointer member is not a
    // global identifier context, even when its receiver is not a simple name.
    if (/(?:\.|::|->)\s*$/.test(before)) return null;
    if (!explicit && range.prefix.length < 2) return null;
    const identifiers = lexical(text, language, text.length, true).identifiers;
    const documentItems = [...identifiers].filter(([name]) => name !== range.prefix || text.slice(range.from, range.to) !== name || identifiers.get(name) > 1)
      .sort((a, b) => b[1] - a[1]).map(([name]) => entry(name, name, '本文件标识符', 'variable'));
    let items = [...(catalogs[language] || []), ...documentItems];
    if ((language === 'c' || language === 'cpp') && /#\s*$/.test(before)) items = [snippet('include', 'include <${1:' + (language === 'c' ? 'stdio.h' : 'iostream') + '}>${0}', '头文件'), ...words('define ifdef ifndef endif pragma', '预处理指令')];
    return result(language, range, items, text);
  }

  function cssSuggestions(text, offset, explicit) {
    // Strip lexical noise while retaining positions to locate the declaration.
    let i = 0, mode = '', quote = '', brace = -1, separator = -1, colon = -1;
    while (i < offset) {
      const char = text[i], next = text[i + 1];
      if (mode === 'comment') { if (char === '*' && next === '/') { mode = ''; i += 2; } else i++; continue; }
      if (mode === 'quote') {
        if (char === '\\') { i += 2; continue; }
        if (char === quote) mode = '';
        i++; continue;
      }
      if (char === '/' && next === '*') { mode = 'comment'; i += 2; continue; }
      if (char === '"' || char === "'") { mode = 'quote'; quote = char; i++; continue; }
      if (char === '{') { brace = i; separator = i; colon = -1; }
      else if (char === '}') { brace = -1; separator = i; colon = -1; }
      else if (char === ';') { separator = i; colon = -1; }
      else if (char === ':' && colon < separator) colon = i;
      i++;
    }
    if (mode === 'comment') return null;
    const range = rangeAt(text, offset, cssPart);
    if (brace < 0) {
      if (mode || !/@[\w-]*$/.test(text.slice(Math.max(0, offset - 64), offset))) return null;
      return result('css', range, [snippet('media', 'media (${1:max-width: 768px}) {\n    ${2}\n}${0}', '媒体查询'), snippet('keyframes', 'keyframes ${1:name} {\n    from { ${2} }\n    to { ${3} }\n}${0}', '关键帧'), entry('import', 'import url("${1:style.css}");${0}', '导入样式', 'snippet')]);
    }
    if (colon > separator) {
      const property = text.slice(separator + 1, colon).trim().toLowerCase();
      if (mode && property !== 'font-family') return null;
      if (!explicit && !range.prefix) return null;
      let values = cssValues[property];
      if (/color$/.test(property) || property === 'background' || property === 'border') values = 'transparent currentColor inherit initial unset white black red rebeccapurple blue green yellow orange purple pink cyan magenta';
      else if (!values && /(?:width|height|margin|padding|gap|inset|top|right|bottom|left|size|radius)$/.test(property)) values = 'auto 0 100% 1rem 1px fit-content max-content min-content';
      const items = words(values || 'inherit initial unset', 'CSS 属性值', 'value');
      if (property === 'background' || property === 'background-image') items.push(snippet('linear-gradient', 'linear-gradient(${1:135deg}, ${2:#3b82f6}, ${3:#8b5cf6})${0}', '线性渐变'), snippet('url', 'url("${1:image.png}")${0}', '背景图'));
      if (property === 'transform') items.push(snippet('translate', 'translate(${1:0}, ${2:0})${0}', '位移'), snippet('rotate', 'rotate(${1:0deg})${0}', '旋转'), snippet('scale', 'scale(${1:1})${0}', '缩放'));
      if (property === 'filter' || property === 'backdrop-filter') items.push(snippet('blur', 'blur(${1:12px})${0}', '模糊'), snippet('saturate', 'saturate(${1:140%})${0}', '饱和度'));
      return result('css', range, items);
    }
    if (mode || (!explicit && !range.prefix)) return null;
    const hasColon = /^\s*:/.test(text.slice(range.to, range.to + 16));
    return result('css', range, properties.map(name => entry(name, hasColon ? name : name + ': ${1:value};${0}', 'CSS 属性', hasColon ? 'property' : 'snippet')));
  }

  function htmlTagSuggestions(text, offset, start, explicit) {
    if (offset - start > 4096) return null;
    const fragment = text.slice(start, offset), closing = /^<\//.test(fragment);
    const nameMatch = /^<\/?([A-Za-z][\w:-]*)?/.exec(fragment);
    if (!nameMatch) return null;
    const nameEnd = start + nameMatch[0].length;
    if (offset <= nameEnd && !/[\s=]/.test(fragment)) {
      const range = rangeAt(text, offset, htmlPart);
      const after = text.slice(range.to, range.to + 64);
      const items = tags.map(name => {
        const hasEnding = /^\s*\/?[>]/.test(after) || /^\s+[\w:-]/.test(after);
        const insert = closing || hasEnding ? name : voidTags.has(name) ? name + '>${0}' : name + '>${1}</' + name + '>${0}';
        return entry(name, insert, closing ? '闭合标签' : 'HTML 标签', insert === name ? 'tag' : 'snippet');
      });
      return result('html', range, items);
    }
    if (closing) return null;
    const remainder = fragment.slice(nameMatch[0].length);
    let quote = '', quoteStart = -1;
    for (let i = 0; i < remainder.length; i++) {
      if (quote) { if (remainder[i] === quote) { quote = ''; quoteStart = -1; } }
      else if (remainder[i] === '"' || remainder[i] === "'") { quote = remainder[i]; quoteStart = i; }
    }
    const range = rangeAt(text, offset, htmlPart);
    const assignment = /([\w:-]+)\s*=\s*(?:"[^"<>]*|'[^'<>]*|[^\s<>"']*)$/.exec(remainder);
    if (assignment) {
      const attribute = assignment[1].toLowerCase(), values = htmlValues[attribute];
      if (!values || (!explicit && !range.prefix)) return null;
      return result('html', range, words(values, 'HTML 属性值', 'value'));
    }
    if (quote || quoteStart >= 0 || (!explicit && !range.prefix)) return null;
    const tag = (nameMatch[1] || '').toLowerCase();
    const names = [...attributes, ...(tagAttributes[tag] || '').split(' ').filter(Boolean)];
    const hasAssignment = /^\s*=/.test(text.slice(range.to, range.to + 16));
    return result('html', range, names.map(name => {
      const boolean = /^(?:hidden|required|disabled|checked|defer|async|multiple|selected|controls|autoplay|muted|loop)$/.test(name);
      return entry(name, hasAssignment || boolean ? name : name + '="${1}"${0}', 'HTML 属性', hasAssignment || boolean ? 'property' : 'snippet');
    }));
  }

  function htmlSuggestions(text, offset, explicit) {
    const lower = text.toLowerCase();
    let i = 0;
    while (i < offset) {
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i + 4);
        if (close < 0 || close + 3 > offset) return null;
        i = close + 3; continue;
      }
      if (text[i] !== '<') { i++; continue; }
      const start = i, match = /^<\/?([A-Za-z][\w:-]*)?/.exec(text.slice(i, i + 128));
      if (!match) { i++; continue; }
      let quote = '', end = i + 1;
      for (; end < text.length; end++) {
        const char = text[end];
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '>') break;
        if (end >= offset) break;
      }
      if (end >= offset) return htmlTagSuggestions(text, offset, start, explicit);
      const tag = (match[1] || '').toLowerCase();
      if (!text.startsWith('</', start) && (tag === 'script' || tag === 'style') && text[end - 1] !== '/') {
        const close = lower.indexOf('</' + tag, end + 1), rawEnd = close < 0 ? text.length : close;
        if (offset <= rawEnd) {
          const embedded = text.slice(end + 1, rawEnd), local = offset - end - 1;
          const answer = tag === 'script' ? codeSuggestions('javascript', embedded, local, explicit) : cssSuggestions(embedded, local, explicit);
          return answer ? { ...answer, from: answer.from + end + 1, to: answer.to + end + 1 } : null;
        }
        i = rawEnd; continue;
      }
      i = end + 1;
    }
    return null;
  }

  function suggest({ path, value, offset, explicit = false } = {}) {
    const language = languageForPath(path);
    if (!language || typeof value !== 'string' || value.length > MAX_CHARACTERS || !Number.isInteger(offset) || offset < 0 || offset > value.length) return null;
    return language === 'html' ? htmlSuggestions(value, offset, !!explicit) : language === 'css' ? cssSuggestions(value, offset, !!explicit) : codeSuggestions(language, value, offset, !!explicit);
  }

  function expandSnippet(template, indent = '', newline = '\n') {
    if (typeof template !== 'string' || template.length > 20000) return { text: typeof template === 'string' ? template : '', stops: [] };
    if (typeof indent !== 'string' || !/^[\t ]{0,256}$/.test(indent)) indent = '';
    if (newline !== '\r\n') newline = '\n';
    let text = '', last = 0;
    const stops = [], pattern = /\$\{(\d{1,2})(?::([^}\r\n]*))?\}/g;
    const append = chunk => { text += chunk.replace(/\r\n|\r|\n/g, newline + indent); };
    let match;
    while ((match = pattern.exec(template))) {
      append(template.slice(last, match.index));
      const start = text.length;
      append(match[2] || '');
      stops.push({ index: Number(match[1]), start, end: text.length });
      last = pattern.lastIndex;
    }
    append(template.slice(last));
    stops.sort((a, b) => (a.index === 0 ? 100 : a.index) - (b.index === 0 ? 100 : b.index) || a.start - b.start);
    return { text, stops };
  }

  return Object.freeze({ suggest, expandSnippet, languageForPath });
});
