import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testTempRoot } from './helpers/temp-root.mjs';
import { WorkspaceTools, TOOL_DEFINITIONS } from '../src/core/workspace.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(testTempRoot, 'synora-read-page-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('synora-read-page-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const tools = new WorkspaceTools(root, options);
  return { root, tools, read: async args => {
    const result = await tools.execute('read_file', args);
    assert.ok(!result.startsWith('错误：'), result);
    return JSON.parse(result);
  } };
}

test('model reads page long files while direct editor reads retain complete bytes', async t => {
  const { root, tools, read } = await fixture(t);
  const content = Array.from({ length: 600 }, (_, index) => `line ${index + 1}\n`).join('');
  await fs.writeFile(path.join(root, 'source.txt'), content);
  const first = await read({ path: 'source.txt' });
  assert.deepEqual({ ...first, content: '' }, { path: 'source.txt', content: '', startLine: 1, endLine: 200,
    totalLines: 600, truncated: true, nextStartLine: 201 });
  assert.equal(first.content, content.split('\n').slice(0, 200).join('\n') + '\n');
  let assembled = first.content, next = first.nextStartLine;
  while (next !== null) {
    const page = await read({ path: 'source.txt', start_line: next });
    assert.equal(page.startLine, next);
    assembled += page.content;
    next = page.nextStartLine;
  }
  assert.equal(assembled, content);
  assert.deepEqual(await tools.readFile({ path: 'source.txt' }), { path: 'source.txt', content });
  const full = await read({ path: 'source.txt', full_file: true });
  assert.equal(full.content, content);
  assert.equal(full.truncated, false);
  assert.equal(full.nextStartLine, null);
});

test('inclusive ranges preserve Unicode and original mixed line endings without a phantom final line', async t => {
  const { root, read } = await fixture(t);
  await fs.writeFile(path.join(root, 'unicode.txt'), '一😀\r\n二é\r\n三\r四\n');
  assert.deepEqual(await read({ path: 'unicode.txt', start_line: 2, end_line: 3 }), {
    path: 'unicode.txt', content: '二é\r\n三\r', startLine: 2, endLine: 3, totalLines: 4, truncated: true, nextStartLine: 4,
  });
  const final = await read({ path: 'unicode.txt', start_line: 4, end_line: 500 });
  assert.equal(final.content, '四\n');
  assert.equal(final.endLine, 4);
  assert.equal(final.nextStartLine, null);
});

test('character budget ends at a complete line and continuation reconstructs exact contents', async t => {
  const { root, read } = await fixture(t);
  const line = '鱼'.repeat(1499) + '\r\n';
  const content = line.repeat(20);
  await fs.writeFile(path.join(root, 'wide.txt'), content);
  const first = await read({ path: 'wide.txt' });
  assert.equal(first.endLine, 15);
  assert.ok(first.content.length <= 24000);
  assert.equal(first.content, line.repeat(15));
  assert.equal(first.nextStartLine, 16);
  const rest = await read({ path: 'wide.txt', start_line: first.nextStartLine });
  assert.equal(first.content + rest.content, content);
});

test('oversized single lines are explicitly withheld until an intentional whole-file read', async t => {
  const { root, read } = await fixture(t);
  const content = '😀'.repeat(13000) + '\nlast line';
  await fs.writeFile(path.join(root, 'single-line.txt'), content);
  const page = await read({ path: 'single-line.txt' });
  assert.equal(page.content, '');
  assert.equal(page.startLine, 1);
  assert.equal(page.endLine, 0);
  assert.equal(page.totalLines, 2);
  assert.equal(page.truncated, true);
  assert.equal(page.nextStartLine, 1);
  assert.equal(page.requiresFullFile, true);
  assert.match(page.notice, /full_file:true/u);
  assert.equal((await read({ path: 'single-line.txt', full_file: true })).content, content);
  assert.equal((await read({ path: 'single-line.txt', start_line: 2 })).content, 'last line');
});

test('empty files and exact page edges have unambiguous range metadata', async t => {
  const { root, read } = await fixture(t);
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  assert.deepEqual(await read({ path: 'empty.txt' }), { path: 'empty.txt', content: '', startLine: 0, endLine: 0,
    totalLines: 0, truncated: false, nextStartLine: null });
  await fs.writeFile(path.join(root, 'edge.txt'), 'x\n'.repeat(200));
  const edge = await read({ path: 'edge.txt' });
  assert.equal(edge.totalLines, 200);
  assert.equal(edge.endLine, 200);
  assert.equal(edge.truncated, false);
  assert.equal(edge.nextStartLine, null);
});

test('invalid ranges and conflicting whole-file requests fail instead of guessing a range', async t => {
  const { root, tools } = await fixture(t);
  await fs.writeFile(path.join(root, 'source.txt'), 'one\ntwo\n');
  for (const args of [
    { start_line: 0 }, { start_line: -1 }, { start_line: 1.5 }, { start_line: '1' },
    { end_line: null }, { end_line: NaN }, { end_line: Infinity }, { start_line: Number.MAX_SAFE_INTEGER },
    { start_line: 2, end_line: 1 }, { end_line: 501 }, { start_line: 3 },
    { full_file: 'true' }, { full_file: true, start_line: 1 }, { full_file: true, end_line: 2 },
  ]) assert.match(await tools.execute('read_file', { path: 'source.txt', ...args }), /^错误：/u, JSON.stringify(args));
  const schema = TOOL_DEFINITIONS.find(tool => tool.name === 'read_file');
  assert.deepEqual(schema.parameters.required, ['path']);
  assert.equal(schema.parameters.properties.start_line.minimum, 1);
  assert.equal(schema.parameters.properties.full_file.type, 'boolean');
  assert.match(schema.description, /节选不是完整文件/u);
});

test('a partial model read retains the complete snapshot concurrency guard', async t => {
  let approvals = 0;
  const { root, tools, read } = await fixture(t, { approve: async () => { approvals++; return true; } });
  const content = 'line\n'.repeat(300);
  const file = path.join(root, 'source.txt');
  await fs.writeFile(file, content);
  await read({ path: 'source.txt', start_line: 1, end_line: 1 });
  const edited = content + 'manual edit outside the viewed range';
  await fs.writeFile(file, edited);
  assert.match(await tools.execute('write_file', { path: 'source.txt', content: 'must not replace user edit' }), /文件在读取后已发生变化/u);
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(file, 'utf8'), edited);
});

test('recursive source search skips Maven target while explicitly targeted artifacts remain searchable', async t => {
  const { root, tools } = await fixture(t);
  for (const relative of ['src/Main.java', 'target/classes/config.yml', 'module/target/generated-src/Copy.java']) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, 'uniqueNeedle');
  }
  const search = async args => JSON.parse(await tools.execute('search_files', { query: 'uniqueNeedle', ...args }));
  assert.deepEqual((await search({})).matches.map(match => match.path), ['src/Main.java']);
  assert.deepEqual((await search({ path: 'target' })).matches.map(match => match.path), ['target/classes/config.yml']);
  assert.deepEqual((await search({ path: 'module/target/generated-src' })).matches.map(match => match.path), ['module/target/generated-src/Copy.java']);
});
