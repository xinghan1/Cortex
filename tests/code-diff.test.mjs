import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/code-diff.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const compare = (before, after) => JSON.parse(JSON.stringify(context.ForgeCodeDiff.compare(before, after)));
const changes = diff => diff.rows.filter(row => row.kind === 'add' || row.kind === 'remove');

test('line diff preserves unchanged code and reports actual additions and removals', () => {
  const diff = compare('const a = 1;\nconst b = 2;\nreturn a;\n', 'const a = 1;\nconst b = 3;\nconst c = 4;\nreturn a;\n');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.exact, true);
  assert.deepEqual(changes(diff).map(row => [row.kind, row.text]), [['remove', 'const b = 2;'], ['add', 'const b = 3;'], ['add', 'const c = 4;']]);
  assert.equal(diff.rows.find(row => row.text === 'return a;').newLine, 4);
});

test('created and deleted files retain the distinction from an empty existing file', () => {
  assert.deepEqual(changes(compare(null, 'hello\n')).map(row => [row.kind, row.oldLine, row.newLine]), [['add', null, 1]]);
  assert.deepEqual(changes(compare('hello\n', null)).map(row => [row.kind, row.oldLine, row.newLine]), [['remove', 1, null]]);
  assert.equal(compare(null, '').created, true);
  assert.match(compare(null, '').rows[0].text, /空文件/);
  assert.equal(compare('', null).deleted, true);
  assert.equal(compare('', '').changed, false);
  assert.equal(compare(null, null).changed, false);
});

test('CRLF is normalized while a missing final newline is a real line change', () => {
  assert.equal(compare('one\r\ntwo\r\n', 'one\ntwo\n').changed, false);
  const diff = compare('one\nlast', 'one\nlast\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(changes(diff)[0].noNewline, true);
  assert.equal(changes(diff)[1].noNewline, false);
  assert.equal(compare('', '\n').added, 1);
});

test('separate hunks show three context lines and explicit gaps', () => {
  const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`);
  const after = before.slice();
  after[10] = 'changed first\n'; after[35] = 'changed last\n';
  const diff = compare(before.join(''), after.join(''));
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  assert.deepEqual(diff.rows.filter(row => row.kind === 'gap').map(row => row.count), [7, 18, 11]);
  assert.equal(diff.rows.find(row => row.kind === 'context').oldLine, 8);
});

test('bounded large replacement reports replacement counting and retains exact displayed counts', () => {
  const before = Array.from({ length: 18000 }, (_, i) => `previous ${i}\n`).join('');
  const after = Array.from({ length: 18000 }, (_, i) => `updated ${i}\n`).join('');
  const start = performance.now();
  const diff = compare(before, after);
  assert.ok(performance.now() - start < 3000);
  assert.equal(diff.exact, false);
  assert.equal(diff.added, 18000);
  assert.equal(diff.removed, 18000);
  assert.ok(diff.rows.length <= 604);
  assert.equal(diff.truncated, true);
  assert.ok(diff.rows.some(row => row.kind === 'add'));
  assert.ok(diff.rows.some(row => row.kind === 'remove'));
  assert.match(diff.rows[0].text, /整段替换/);
  assert.match(diff.rows.at(-1).text, /省略/);
});

test('half-megabyte files with a small edit remain a minimal diff with correct line numbers', () => {
  const before = `${'unchanged line\n'.repeat(36000)}tail\n`;
  const after = before.replace('tail\n', 'new tail\n');
  const diff = compare(before, after);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.exact, true);
  assert.equal(changes(diff).find(row => row.kind === 'add').newLine, 36001);
  assert.ok(diff.rows.length < 10);
});

test('over-limit files expose unavailable counts rather than invented totals', () => {
  const diff = compare('a'.repeat(1024 * 1024 + 1), 'b');
  assert.equal(diff.exact, false);
  assert.equal(diff.added, null);
  assert.equal(diff.removed, null);
  assert.match(diff.rows[0].text, /未计算/);
});

test('validates explicit snapshots and does not coerce unknown data to code', () => {
  for (const invalid of [undefined, 123, {}, []]) {
    assert.throws(() => compare(invalid, ''), /before/);
    assert.throws(() => compare('', invalid), /after/);
  }
});

test('shortest edit counts agree with an independent LCS oracle, including repeated lines', () => {
  let seed = 41;
  const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let sample = 0; sample < 240; sample++) {
    const before = Array.from({ length: random(22) }, () => `${random(5)}\n`);
    const after = Array.from({ length: random(22) }, () => `${random(5)}\n`);
    const dp = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const diff = compare(before.join(''), after.join(''));
    assert.equal(diff.exact, true);
    assert.equal(diff.added, after.length - dp[0][0]);
    assert.equal(diff.removed, before.length - dp[0][0]);
    for (const row of diff.rows) {
      if (row.oldLine !== undefined && row.oldLine !== null) assert.equal(`${row.text}\n`, before[row.oldLine - 1]);
      if (row.newLine !== undefined && row.newLine !== null) assert.equal(`${row.text}\n`, after[row.newLine - 1]);
    }
  }
});

test('renderer is independent from IPC and never interpolates source as HTML', () => {
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|window\.forge|\.invoke\(/);
  assert.throws(() => context.ForgeCodeDiff.create({ path: 'a.js', before: '', after: '' }), /document/);
});
