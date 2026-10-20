import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/code-completion.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const api = context.ForgeCompletion;
const plain = value => JSON.parse(JSON.stringify(value));
function suggest(path, marked, explicit = false) {
  const offset = marked.indexOf('|');
  assert.notEqual(offset, -1, 'fixture needs caret marker');
  return plain(api.suggest({ path, value: marked.slice(0, offset) + marked.slice(offset + 1), offset, explicit }));
}
const item = (answer, label) => answer?.items.find(entry => entry.label === label);

test('eight language families resolve extensions and offer native language snippets', () => {
  for (const [path, input, language, label, inserted] of [
    ['app.py', 'pri|', 'python', 'print', 'print('],
    ['Main.java', 'sou|', 'java', 'sout', 'System.out.println('],
    ['Program.cs', 'Console.Wr|', 'csharp', 'WriteLine', 'WriteLine('],
    ['main.cpp', 'std::co|', 'cpp', 'cout', 'cout'],
    ['main.c', 'pri|', 'c', 'printf', 'printf('],
    ['index.html', '<di|', 'html', 'div', 'div>'],
    ['style.css', '.card { col| }', 'css', 'color', 'color: '],
    ['app.js', 'console.lo|', 'javascript', 'log', 'log('],
  ]) {
    const answer = suggest(path, input);
    assert.equal(answer.language, language, path);
    assert.ok(item(answer, label)?.insertText.startsWith(inserted), path + ' ' + label);
  }
  for (const [path, language] of [['x.PY', 'python'], ['x.CXX', 'cpp'], ['x.hh', 'cpp'], ['x.hxx', 'cpp'], ['x.h', 'c'], ['x.mjs', 'javascript'], ['x.cjs', 'javascript'], ['x.jsx', 'javascript'], ['x.htm', 'html'], ['a\\b\\x.java', 'java']]) assert.equal(api.languageForPath(path), language);
});

test('replacement range covers the entire identifier including text after the caret', () => {
  const answer = suggest('x.js', 'console.lo|gging');
  assert.deepEqual([answer.from, answer.to], [8, 15]);
  const choice = item(answer, 'log');
  const expanded = plain(api.expandSnippet(choice.insertText));
  assert.equal('console.logging'.slice(0, answer.from) + expanded.text + 'console.logging'.slice(answer.to), 'console.log(value)');
  const html = suggest('x.html', '<di|vision>');
  assert.deepEqual([html.from, html.to], [1, 9]);
  assert.equal(item(html, 'div').insertText, 'div');
  const existingCall = suggest('x.js', 'console.lo|gger(existing, nested(1));');
  assert.equal(item(existingCall, 'log').insertText, 'log');
  const callSource = 'console.logger(existing, nested(1));';
  assert.equal(callSource.slice(0, existingCall.from) + item(existingCall, 'log').insertText + callSource.slice(existingCall.to), 'console.log(existing, nested(1));');
  assert.equal(item(suggest('x.java', 'sou| (value);'), 'sout').insertText, 'System.out.println');
  assert.equal(item(suggest('x.py', 'pri|nt("unchanged")'), 'print').insertText, 'print');
});

test('known member receivers are language specific and unknown members do not leak globals', () => {
  assert.ok(item(suggest('x.java', 'System.out.pr|'), 'println'));
  assert.ok(item(suggest('x.cs', 'System.Console.Wr|'), 'WriteLine'));
  assert.ok(item(suggest('x.py', 'os.path.jo|'), 'join'));
  assert.equal(suggest('x.js', 'object.co|'), null);
  assert.equal(suggest('x.java', 'Console.Wr|'), null);
  assert.equal(suggest('x.cpp', 'std.co|'), null);
  assert.equal(suggest('x.js', 'getValue().co|'), null);
  assert.equal(suggest('x.js', 'foo?.co|'), null);
  const observed = suggest('x.js', 'service.connect();\nservice.co|');
  assert.deepEqual(observed.items.map(entry => entry.label), ['connect']);
  assert.ok(item(suggest('x.js', 'console.|', true), 'log'));
  assert.ok(item(suggest('x.py', 'import ma|'), 'math'));
  assert.ok(item(suggest('x.py', 'from da|'), 'datetime'));
  assert.equal(item(suggest('x.py', 'from math import sq|'), 'sqrt').insertText, 'sqrt');
});

test('comments, quoted strings, multiline strings and templates suppress suggestions', () => {
  for (const [path, input] of [
    ['x.py', '# pri|'], ['x.py', '"pri|"'], ['x.py', '"""notes\npri|"""'],
    ['x.java', '// sou|'], ['x.java', '/* sou| */'], ['x.java', 'String text = "sou|";'], ['x.java', 'String text = """\n sou|\n""";'],
    ['x.cs', '@"hello "" quoted Wr|"'], ['x.c', "char *text = \"pri|\";"],
    ['x.cpp', '/* notes\nstd::co| */'], ['x.cpp', 'R"tag(notes\nstd::co|)tag";'], ['x.js', '`console.lo|`'], ['x.js', 'const re = /conso|/;'],
    ['x.html', '<!-- <di| -->'], ['x.css', '.a { /* col| */ }'], ['x.css', '.a { content: "col|"; }'],
  ]) assert.equal(suggest(path, input, true), null, path + ' ' + input);
  assert.ok(item(suggest('x.py', '"closed"\npri|'), 'print'));
  assert.ok(item(suggest('x.js', '// closed\nconsole.lo|'), 'log'));
  assert.ok(item(suggest('x.cpp', 'R"tag(notes)tag";\nstd::co|'), 'cout'));
});

test('HTML tags, attributes, enum values and existing endings retain markup structure', () => {
  assert.equal(item(suggest('x.html', '<di|'), 'div').insertText, 'div>${1}</div>${0}');
  assert.equal(item(suggest('x.html', '</di|'), 'div').insertText, 'div');
  assert.equal(item(suggest('x.html', '<di|>existing</div>'), 'div').insertText, 'div');
  assert.equal(item(suggest('x.html', '<di| class="card">'), 'div').insertText, 'div');
  assert.equal(item(suggest('x.html', '<im|'), 'img').insertText, 'img>${0}');
  assert.equal(item(suggest('x.html', '<div cla|'), 'class').insertText, 'class="${1}"${0}');
  assert.equal(item(suggest('x.html', '<div cla|="card">'), 'class').insertText, 'class');
  assert.ok(item(suggest('x.html', '<input type="te|">'), 'text'));
  assert.ok(item(suggest('x.html', '<a target=_b|>'), '_blank'));
  assert.equal(suggest('x.html', '<div class="co|">'), null);
  assert.equal(suggest('x.html', 'ordinary text pri|'), null);
  assert.ok(item(suggest('x.html', '<|'), 'div'));
});

test('CSS declarations use properties and values without irrelevant code suggestions', () => {
  assert.equal(item(suggest('x.css', '.a { col|: red; }'), 'color').insertText, 'color');
  assert.ok(item(suggest('x.css', '.a { display: fl|; }'), 'flex'));
  assert.ok(item(suggest('x.css', '.a { color: re|; }'), 'red'));
  assert.ok(item(suggest('x.css', '.a { font-family: "Ar|"; }'), 'Arial'));
  assert.ok(item(suggest('x.css', '.a { backdrop-filter: bl|; }'), 'blur'));
  assert.ok(item(suggest('x.css', '.a { background-image: lin|; }'), 'linear-gradient'));
  assert.ok(item(suggest('x.css', '@me|'), 'media'));
  assert.equal(suggest('x.css', '.conso|'), null);
  assert.equal(suggest('x.css', '.a { display: conso|; }'), null);
  assert.ok(item(suggest('x.css', '.a { | }', true), 'color'));
});

test('HTML embedded script and style completion returns original document coordinates', () => {
  const script = suggest('x.html', '<div></div>\n<script>console.lo|</script>');
  assert.equal(script.language, 'javascript');
  assert.deepEqual([script.from, script.to], [28, 30]);
  assert.ok(item(script, 'log'));
  const style = suggest('x.html', '<style>.card { display: fl|; }</style>');
  assert.equal(style.language, 'css');
  assert.ok(item(style, 'flex'));
  assert.equal(suggest('x.html', '<script>"console.lo|"</script>'), null);
  assert.equal(suggest('x.html', '<style>/* col| */</style>'), null);
});

test('current document identifiers are ranked, deduplicated and never interpreted as markup', () => {
  const answer = suggest('x.js', 'const customerName = 1;\nconst customerNumber = 2;\ncustomerName;\ncustomerName;\ncust|');
  assert.deepEqual(answer.items.map(entry => entry.label), ['customerName', 'customerNumber']);
  const known = suggest('x.js', 'const console = "literal";\nconsole;\ncon|');
  assert.equal(known.items.filter(entry => entry.label === 'console').length, 1);
  assert.equal(known.items[0].label, 'const');
  const unsafe = suggest('x.js', 'const harmless = "<img onerror=bad()>";\nha|');
  assert.deepEqual(unsafe.items.map(entry => entry.label), ['harmless']);
  assert.equal(suggest('x.js', 'ab|'), null);
});

test('unsupported documents and invalid input fall back safely with bounded suggestions', () => {
  for (const [path, value, offset] of [['x.md', 'pri', 3], ['x.json', 'pri', 3], ['x.js', 'x'.repeat(160001), 160001], ['x.js', 'pri', -1], ['x.js', 'pri', 4], ['x.js', 'pri', 1.5], ['x.js', null, 0]]) assert.equal(api.suggest({ path, value, offset, explicit: true }), null);
  assert.equal(suggest('x.js', 'c|'), null);
  const all = suggest('x.js', '|', true);
  assert.ok(all.items.length > 20 && all.items.length <= 40);
  const hugeWords = 'identifier '.repeat(12001) + ' customSymbol; cust';
  const started = performance.now();
  assert.equal(api.suggest({ path: 'x.js', value: hugeWords, offset: hugeWords.length }), null, 'word budget excludes later identifiers');
  assert.ok(performance.now() - started < 2000);
  const malformedTag = '<div ' + 'a'.repeat(150000);
  const htmlStarted = performance.now();
  assert.equal(api.suggest({ path: 'x.html', value: malformedTag, offset: malformedTag.length, explicit: true }), null);
  assert.ok(performance.now() - htmlStarted < 2000, 'unterminated tags stay bounded');
});

test('snippet expansion preserves source text and calculates ordered stops after indentation', () => {
  const expanded = plain(api.expandSnippet('if (${2:condition}) {\n    ${1:body}\n}${0}', '  ', '\r\n'));
  assert.equal(expanded.text, 'if (condition) {\r\n      body\r\n  }');
  assert.deepEqual(expanded.stops.map(stop => stop.index), [1, 2, 0]);
  assert.deepEqual(expanded.stops.map(stop => expanded.text.slice(stop.start, stop.end)), ['body', 'condition', '']);
  const py = item(suggest('x.py', 'de|'), 'def');
  const definition = plain(api.expandSnippet(py.insertText, '    '));
  assert.equal(definition.text, 'def function_name(args):\n        pass\n    ');
  assert.deepEqual(definition.stops.map(stop => stop.index), [1, 2, 3, 0]);
  const literal = '<img src=x onerror=bad()> ${notASnippet} $HOME $(bad)';
  assert.deepEqual(plain(api.expandSnippet(literal)), { text: literal, stops: [] });
  assert.equal(plain(api.expandSnippet('x\ny', '<bad>')).text, 'x\ny');
  assert.equal(Object.isFrozen(api), true);
  for (const [path, labels] of [['x.py', ['def', 'for', 'if', 'class', 'main', 'import', 'from']], ['x.java', ['sout', 'main', 'class', 'for', 'if', 'try']], ['x.cs', ['cw', 'main', 'class', 'prop', 'foreach', 'if']], ['x.c', ['main', 'include', 'for', 'if', 'struct']], ['x.cpp', ['main', 'include', 'cout', 'class', 'for', 'if']], ['x.js', ['function', 'const', 'log', 'if', 'for', 'class', 'import']]]) {
    for (const label of labels) {
      const choice = item(suggest(path, label + '|', true), label);
      assert.ok(choice, path + ' ' + label);
      const positive = plain(api.expandSnippet(choice.insertText)).stops.filter(stop => stop.index > 0).map(stop => stop.index);
      assert.equal(new Set(positive).size, positive.length, path + ' ' + label + ' must not require mirrored placeholders');
    }
  }
});
