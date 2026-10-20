import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { testTempRoot } from './helpers/temp-root.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { runAgent } from '../src/core/agent.mjs';

const require = createRequire(import.meta.url);
const { Store } = require('../src/core/store.cjs');

async function fixture(t, approve = async () => true) {
  const directory = await fs.mkdtemp(path.join(testTempRoot, 'synora-file-change-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(directory).startsWith('synora-file-change-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, root, workspace: new WorkspaceTools(root, { approve }) };
}

function committedChanges(root) {
  const changes = [];
  return { changes, onFileChange(change) {
    const target = path.join(root, change.path);
    assert.equal(change.after === null ? !existsSync(target) : readFileSync(target, 'utf8') === change.after, true,
      'the callback runs after the exact filesystem change commits');
    changes.push(change);
  } };
}

test('successful writes publish exact committed snapshots separately from model-facing results', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'sample.txt'), 'old\r\ntext\n');
  const observer = committedChanges(root);
  const result = JSON.parse(await workspace.execute('write_file', { path: 'sample.txt', content: 'new\n' }, observer));
  assert.deepEqual(observer.changes, [{ path: 'sample.txt', before: 'old\r\ntext\n', after: 'new\n' }]);
  assert.equal(result.path, 'sample.txt');
  assert.equal(Object.hasOwn(result, 'before'), false);
  assert.equal(Object.hasOwn(result, 'after'), false);
  await workspace.execute('write_file', { path: 'nested/empty.txt', content: '' }, observer);
  assert.deepEqual(observer.changes[1], { path: 'nested/empty.txt', before: null, after: '' });
});

test('replace and both kinds of undo publish actual forward and reverse changes', async t => {
  const { root, workspace } = await fixture(t);
  const observer = committedChanges(root);
  await fs.writeFile(path.join(root, 'sample.txt'), 'one\ntwo\nthree\n');
  await workspace.execute('replace_in_file', { path: 'sample.txt', old_text: 'two', new_text: 'second\nextra' }, observer);
  await workspace.undoLastChange(observer);
  await workspace.execute('write_file', { path: 'created.txt', content: 'created\n' }, observer);
  const deletion = JSON.parse(await workspace.execute('undo_last_change', {}, observer));
  assert.equal(deletion.deleted, true);
  assert.deepEqual(observer.changes, [
    { path: 'sample.txt', before: 'one\ntwo\nthree\n', after: 'one\nsecond\nextra\nthree\n' },
    { path: 'sample.txt', before: 'one\nsecond\nextra\nthree\n', after: 'one\ntwo\nthree\n' },
    { path: 'created.txt', before: null, after: 'created\n' },
    { path: 'created.txt', before: 'created\n', after: null },
  ]);
});

test('denied, invalid, canceled and concurrently changed writes never publish committed changes', async t => {
  let approval = false;
  let duringApproval = async () => {};
  const { root, workspace } = await fixture(t, async () => { await duringApproval(); return approval; });
  const observer = committedChanges(root);
  await fs.writeFile(path.join(root, 'sample.txt'), 'old old');
  assert.equal(JSON.parse(await workspace.execute('write_file', { path: 'sample.txt', content: 'denied' }, observer)).denied, true);
  assert.match(await workspace.execute('replace_in_file', { path: 'sample.txt', old_text: 'old', new_text: 'ambiguous' }, observer), /^错误：/);
  approval = true;
  duringApproval = () => fs.writeFile(path.join(root, 'sample.txt'), 'concurrent user edit');
  assert.match(await workspace.execute('write_file', { path: 'sample.txt', content: 'not committed' }, observer), /^错误：/);
  duringApproval = async () => {};
  const canceled = new AbortController();
  canceled.abort();
  assert.match(await workspace.execute('write_file', { path: 'never-created.txt', content: 'not committed' }, { ...observer, signal: canceled.signal }), /^错误：/);
  assert.deepEqual(observer.changes, []);
  assert.equal(await fs.readFile(path.join(root, 'sample.txt'), 'utf8'), 'concurrent user edit');
  await workspace.execute('write_file', { path: 'created.txt', content: 'created' });
  approval = false;
  assert.equal(JSON.parse(await workspace.undoLastChange(observer)).denied, true);
  assert.deepEqual(observer.changes, []);
});

test('a broken display listener cannot change the success of an already committed edit', async t => {
  const { root, workspace } = await fixture(t);
  const result = JSON.parse(await workspace.execute('write_file', { path: 'created.txt', content: 'committed' }, {
    onFileChange() { throw new Error('display listener failed'); },
  }));
  assert.equal(result.path, 'created.txt');
  assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'committed');
});

test('agent correlates and redacts local edit metadata without putting it in model messages, then it survives session storage', async t => {
  const { directory, root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'sample.txt'), 'private-secret\noriginal\n');
  const messages = [{ role: 'user', content: 'update the file' }], events = [];
  let requests = 0;
  await runAgent({ config: { provider: 'openai', apiKey: 'test-credential', model: 'test-model' }, messages,
    workspace, signal: new AbortController().signal, toolDefinitions: [], emit: event => events.push(event),
    redact: text => text.replaceAll('private-secret', '[redacted]'),
    requestModel: async request => {
      requests++;
      assert.equal(request.messages.some(message => Object.hasOwn(message, 'fileChange')), false);
      assert.equal(JSON.stringify(request.messages).includes('private-secret'), false);
      if (requests === 1) return { message: { role: 'assistant', content: '', toolCalls: [
        { id: 'edit-1', name: 'write_file', arguments: { path: 'sample.txt', content: 'updated\n' } },
        { id: 'read-1', name: 'list_files', arguments: {} },
      ] } };
      return { message: { role: 'assistant', content: 'finished', toolCalls: [] } };
    },
  });
  assert.equal(requests, 2);
  const start = events.find(event => event.type === 'tool-start' && event.name === 'write_file');
  const edit = events.find(event => event.type === 'tool-result' && event.name === 'write_file');
  assert.equal(start.toolCallId, 'edit-1');
  assert.equal(edit.toolCallId, 'edit-1');
  assert.deepEqual(edit.fileChange, { path: 'sample.txt', before: '[redacted]\noriginal\n', after: 'updated\n' });
  assert.equal(Object.hasOwn(events.find(event => event.type === 'tool-result' && event.name === 'list_files'), 'fileChange'), false);
  assert.equal(messages.some(message => Object.hasOwn(message, 'fileChange')), false);
  assert.equal(JSON.stringify(messages.filter(message => message.role === 'tool')).includes('original'), false);

  const store = new Store(path.join(directory, 'isolated-data'), { isEncryptionAvailable: () => false });
  await store.init();
  const session = store.createSession(root);
  session.messages = messages;
  // The main process archives this local sidecar independently of the model
  // transcript and of the bounded 150-event activity suffix.
  session.fileEdits = [{ runId: 'test-run', toolCallId: edit.toolCallId, ...edit.fileChange }];
  await store.saveSession(session);
  const restored = await store.getSession(session.id);
  assert.deepEqual(restored.fileEdits, session.fileEdits);
  assert.equal(restored.messages.some(message => Object.hasOwn(message, 'fileChange')), false);
});
