import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { APPROVAL_MODES, validateMode, approvalDecision } = require('../src/core/approval-policy.cjs');
const write = (path = 'src/main.js', before = 'old text', after = 'new text') => ({ kind: 'write', path, before, after });
const command = text => ({ kind: 'command', command: text });
const browser = (action, url) => ({ kind: 'browser', action, ...(url ? { url } : {}) });

test('mode validation accepts only the three explicit session modes', () => {
  assert.deepEqual(APPROVAL_MODES, ['request', 'assist', 'full']);
  assert.equal(Object.isFrozen(APPROVAL_MODES), true);
  for (const mode of APPROVAL_MODES) assert.equal(validateMode(mode), mode);
  for (const mode of [undefined, null, '', 'FULL', 'default', ' full', true, 1, {}, []]) {
    assert.throws(() => validateMode(mode), { code: 'APPROVAL_MODE_INVALID' });
  }
});

test('unknown modes, missing requests and unknown operations always ask', () => {
  for (const mode of [undefined, null, 'unknown', 'FULL']) assert.equal(approvalDecision(mode, write()), 'ask');
  for (const mode of APPROVAL_MODES) {
    for (const request of [undefined, null, [], 'write', {}, { kind: 'read' }, { kind: 'undo' }, browser('submit')]) {
      assert.equal(approvalDecision(mode, request), 'ask');
    }
  }
});

test('request mode asks for writes, every command and active browser operations', () => {
  for (const request of [write(), command('Get-Location'), command('Remove-Item note.txt'), browser('navigate', 'http://localhost:3000'), browser('click'), browser('type'), browser('scroll')]) {
    assert.equal(approvalDecision('request', request), 'ask');
  }
  for (const mode of APPROVAL_MODES) assert.equal(approvalDecision(mode, browser('snapshot')), 'allow');
});

test('assist allows guarded project text creation, edits and undo', () => {
  for (const request of [write(), write('README.md', null, ''), write('src/中文 文件.js', '', '你好'), write('src\\main.js', 'new text', null), write('./src/main.js')]) {
    assert.equal(approvalDecision('assist', request), 'allow', JSON.stringify(request));
  }
});

test('external file writes use independent review in assist, manual review in request and existing full control in full', () => {
  const operation = write('G:/plugin/QcNPCDialogue/src/Region.java');
  assert.equal(approvalDecision('assist', operation), 'ask', 'External paths leave the shortcut and reach independent intent review');
  assert.equal(approvalDecision('request', operation), 'ask');
  assert.equal(approvalDecision('full', operation), 'allow');
  assert.equal(approvalDecision('assist', write('src/Region.java')), 'allow', 'Current-project local shortcut stays intact');
});

test('assist never auto-approves unsafe, secret, ambiguous or non-text writes', () => {
  const paths = ['', '.', '..', '../other.txt', 'src/../../other.txt', '/tmp/note', '\\server\share\note', 'C:\\note.txt', 'notes.txt:stream', 'src//note.txt', 'src/note.txt ', 'src/.git/config', '.aws/config', '.ENV.local', 'src/secret.json', 'id_ed25519', 'src/file.PEM', 'node_modules/a.js', 'NUL.txt'];
  for (const path of paths) assert.equal(approvalDecision('assist', write(path)), 'ask', path);
  for (const request of [{ ...write('a.txt'), before: undefined }, write('a.txt', null, null), { ...write('a.txt'), after: undefined }, write('a.txt', '', '\0'), write('a.txt', '', '好'.repeat(180_000)), write('a.txt', { text: 'before' })]) {
    assert.equal(approvalDecision('assist', request), 'ask');
  }
});

test('assist allows only the narrow read-only PowerShell command language', () => {
  for (const text of ['Get-Location', ' get-location ', 'Get-ChildItem', 'Get-ChildItem -LiteralPath .', "Get-ChildItem -LiteralPath './src'", "Get-ChildItem -LiteralPath 'src folder'", 'GET-CHILDITEM -LiteralPath src\\nested']) {
    assert.equal(approvalDecision('assist', command(text)), 'allow', text);
  }
});

test('assist command parsing rejects expansions, statement chaining and extra switches', () => {
  const commands = ['pwd', 'ls', 'Get-Content README.md', 'git status', 'Remove-Item note.txt', 'Get-Location;Remove-Item a', 'Get-Location | Out-File a', 'Get-Location > a', 'Get-Location\nRemove-Item a', 'Get-Location\r', 'Get-Location\t', 'Get-Location #comment', 'Get-Location & x', '& Get-Location', '(Get-Location)', 'Get-ChildItem -Recurse', 'Get-ChildItem -Force', 'Get-ChildItem -Path src', 'Get-ChildItem src', 'Get-ChildItem -LiteralPath src -Recurse', 'Get-ChildItem -LiteralPath $HOME', 'Get-ChildItem -LiteralPath $(Remove-Item a)', 'Get-ChildItem -LiteralPath "src"', "Get-ChildItem -LiteralPath 'src' 'other'", "Get-ChildItem -LiteralPath 'src''other'", 'Get-ChildItem -LiteralPath @{x=1}', 'Get-ChildItem -LiteralPath src*', 'Get-ChildItem -LiteralPath ../outside', 'Get-ChildItem -LiteralPath C:\\Windows', 'Get-ChildItem -LiteralPath .git', "Get-ChildItem -LiteralPath '.aws'", 'Get-ChildItem -LiteralPath .env', 'Get-ChildItem -LiteralPath src/secret.json', 'Get-ChildItem -LiteralPath -Force', 'Get-ChildItem -LiteralPath src:stream', 'Get-Location\0'];
  for (const text of [...commands, 'Get-ChildItem -LiteralPath src,../outside', "Get-ChildItem -LiteralPath 'src',../outside"]) assert.equal(approvalDecision('assist', command(text)), 'ask', text);
});

test('assist browser navigation permits loopback preview URLs and passive scrolling only', () => {
  for (const url of ['http://localhost:3000/', 'https://LOCALHOST:8443/index.html', 'http://127.0.0.1:5173/preview?a=1', 'http://[::1]:3000/']) {
    assert.equal(approvalDecision('assist', browser('navigate', url)), 'allow', url);
  }
  assert.equal(approvalDecision('assist', browser('scroll')), 'allow');
  for (const action of ['click', 'type']) assert.equal(approvalDecision('assist', browser(action, 'http://localhost:3000/')), 'ask');
});

test('assist browser rejects external, credentialed, invalid and non-HTTP navigation', () => {
  for (const url of [undefined, '', 'https://example.com', 'http://localhost.example.com/', 'http://localhost@evil.example/', 'http://user:pass@localhost:3000/', 'http://127.0.0.2/', 'file:///C:/project/index.html', 'javascript:alert(1)', 'data:text/html,hello', 'http://localhost:3000/\n', ' http://localhost/', 'not a URL']) {
    assert.equal(approvalDecision('assist', browser('navigate', url)), 'ask', String(url));
  }
});

test('full control skips individual approvals for known guarded operation kinds', () => {
  for (const request of [write(), command('npm install'), browser('navigate', 'https://example.com'), browser('click'), browser('type'), browser('scroll')]) {
    assert.equal(approvalDecision('full', request), 'allow');
  }
  // This is deliberately stateless: a full-control decision cannot change the
  // next request-mode window or persist any trust to disk.
  assert.equal(approvalDecision('request', command('npm install')), 'ask');
  assert.equal(approvalDecision('full', browser('unknown')), 'ask');
});
