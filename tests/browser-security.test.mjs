import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateBrowserURL, safeParts, resolveStaticFile, ProjectPreviewServer, clampBrowserBounds } = require('../src/core/browser-security.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-browser-test-'));
  const root = path.join(directory, 'project'), outside = path.join(directory, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('ai-code-browser-test-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, root, outside };
}
const request = (url, options = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, options, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end();
});

test('browser URL validation rejects schemes, embedded credentials, controls and oversized URLs', () => {
  assert.equal(validateBrowserURL('https://example.com/a?q=1#section'), 'https://example.com/a?q=1#section');
  assert.equal(validateBrowserURL('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
  for (const value of ['', 'example.com', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'https://user:pass@example.com', 'https://example.com/\n', 'https://example.com/a b', 'https://example.com/' + 'x'.repeat(8192)]) assert.throws(() => validateBrowserURL(value), undefined, value.slice(0, 80));
});
test('preview paths reject escapes, protected names and active non-web files', () => {
  assert.deepEqual(safeParts('nested/demo.html'), ['nested', 'demo.html']);
  for (const value of ['../outside/test.html', 'nested/../test.html', 'nested\\..\\test.html', '/test.html', 'C:\\test.html', '\\\\server\\share\\test.html', 'test.html:secret', '.git/config', '.env', 'nested/.env.local', '.ssh/key.html', '.npm/key.html', '.npm-cache/key.html', 'node_modules/a.js', 'secret.key', 'secret.html.pem', 'NUL.html', 'bad /test.html', 'nested//test.html', 'test.exe', 'test.bat', 'test.js\0']) assert.throws(() => safeParts(value), undefined, value);
});
test('native bounds cannot overlay the application titlebar or exceed content bounds', () => {
  assert.deepEqual(clampBrowserBounds({ x: -30, y: -10, width: 5000, height: 5000 }, [980, 700]), { x: 0, y: 44, width: 980, height: 656 });
  assert.deepEqual(clampBrowserBounds({ x: 900, y: 680, width: 500, height: 200 }, [980, 700]), { x: 900, y: 680, width: 80, height: 20 });
  assert.deepEqual(clampBrowserBounds({ x: 0, y: 0, width: 100, height: 100 }, [20, 20]), { x: 0, y: 20, width: 20, height: 0 });
  assert.throws(() => clampBrowserBounds({ x: NaN, y: 0, width: 4, height: 4 }, [980, 700]));
});
test('preview serves real HTML/assets with no caching and rejects raw/encoded traversal and writes', async t => {
  const { root, outside } = await fixture(t);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'demo.html'), '<h1>Preview fixture</h1>');
  await fs.writeFile(path.join(root, 'assets', 'hello.js'), 'window.fixture=true');
  await fs.writeFile(path.join(root, '.env'), 'SECRET_DO_NOT_SERVE');
  await fs.writeFile(path.join(outside, 'sentinel.html'), 'OUTSIDE_DO_NOT_SERVE');
  const preview = new ProjectPreviewServer(root); t.after(() => preview.close());
  const url = await preview.urlFor('demo.html');
  const response = await request(url);
  assert.equal(response.status, 200); assert.match(response.body, /Preview fixture/);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-type'], /^text\/html/);
  const asset = url.replace('demo.html', 'assets/hello.js');
  assert.equal((await request(asset)).status, 200);
  const head = await request(asset, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal((await request(url, { method: 'POST' })).status, 405);
  assert.equal((await request(url, { headers: { Host: 'example.com' } })).status, 403);
  assert.equal((await request(preview.origin + '/demo.html')).status, 403);
  for (const tail of ['.env', '%2e%2e/outside/sentinel.html', 'assets/%2e%2e/demo.html', 'assets%5c..%5cdemo.html', 'demo.html%00', 'assets/', 'missing.html']) {
    const result = await request(preview.origin, { path: '/' + preview.token + '/' + tail });
    assert.notEqual(result.status, 200, tail); assert.doesNotMatch(result.body, /SECRET_DO_NOT_SERVE|OUTSIDE_DO_NOT_SERVE/);
  }
  assert.equal(preview.isLocalURL(url), true); assert.equal(preview.isLocalURL(preview.origin + '/unknown/demo.html'), false);
  await assert.rejects(preview.urlFor('assets/hello.js'), /HTML/);
});
test('preview rejects hard links and directory junctions before serving', async t => {
  const { root, outside } = await fixture(t);
  const sentinel = path.join(outside, 'sentinel.html'); await fs.writeFile(sentinel, 'outside');
  await fs.link(sentinel, path.join(root, 'hard.html'));
  await assert.rejects(resolveStaticFile(root, 'hard.html'), /普通文件/);
  await fs.symlink(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveStaticFile(root, 'redirect/sentinel.html'), /链接|目录/);
});
test('preview rejects files beyond 16 MB and closed preview cannot restart', async t => {
  const { root } = await fixture(t);
  const handle = await fs.open(path.join(root, 'large.html'), 'wx'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(resolveStaticFile(root, 'large.html'), /16 MB/);
  await fs.writeFile(path.join(root, 'small.html'), 'small');
  const preview = new ProjectPreviewServer(root); await preview.urlFor('small.html'); preview.close();
  await assert.rejects(preview.urlFor('small.html'), /关闭/);
});
