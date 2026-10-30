import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runAgent } from '../src/core/agent.mjs';

const { createRemoteOperationSession } = createRequire(import.meta.url)('../src/core/remote-operation-session.cjs');
const { BrowserPanel } = createRequire(import.meta.url)('../src/core/browser-panel.cjs');

test('exiting cancels the current remote operation, blocks its batch and permits a later model request', async () => {
  const parent = new AbortController(); let stops = 0, calls = 0, requests = 0;
  const session = createRemoteOperationSession({ onStop: () => { stops++; } });
  const messages = [{ role: 'user', content: 'Inspect the page.' }];
  const makeCall = id => ({ id, name: 'browser_click', arguments: { selector: '#fixture' } });
  await runAgent({ config: { provider: 'relay', model: 'fixture', apiProtocol: 'chat-completions' }, messages, onToolBatchStart: id => session.observeBatch(id),
    toolDefinitions: [{ name: 'browser_click', description: '', parameters: { type: 'object', properties: {} } }],
    signal: parent.signal, emit: () => {}, workspace: { root: 'C:/fixture', execute: async (_name, _args, options) => {
      return session.execute(options.toolBatchId, options.signal, async signal => {
        calls++;
        if (calls === 1) {
          const cancelled = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
          session.exit();
          return cancelled;
        }
        return 'new action completed';
      });
    } }, requestModel: async () => {
      requests++;
      if (requests === 1) return { message: { role: 'assistant', content: '', toolCalls: [makeCall('one'), makeCall('two')] } };
      if (requests === 2) return { message: { role: 'assistant', content: '', toolCalls: [makeCall('three')] } };
      return { message: { role: 'assistant', content: 'Finished.', toolCalls: [] } };
    } });
  assert.equal(stops, 1); assert.equal(parent.signal.aborted, false);
  assert.equal(calls, 2, 'the second call in the old batch never reaches the browser');
  assert.equal(requests, 3);
  const results = messages.filter(message => message.role === 'tool').map(message => message.content);
  assert.match(results[0], /用户已退出远程操作/); assert.match(results[1], /用户已退出远程操作/);
  assert.equal(results[2], 'new action completed');
});

test('exit while a non-browser tool runs prevents later browser calls already in that batch', async () => {
  const parent = new AbortController(), session = createRemoteOperationSession();
  let requests = 0, browserCalls = 0;
  await runAgent({ config: { provider: 'relay', model: 'fixture' }, messages: [{ role: 'user', content: 'Do the task' }],
    signal: parent.signal, emit: () => {}, onToolBatchStart: id => session.observeBatch(id),
    toolDefinitions: [{ name: 'read_file', parameters: { type: 'object' } }, { name: 'browser_click', parameters: { type: 'object' } }],
    workspace: { root: 'C:/fixture', execute: async (name, _args, options) => {
      if (name === 'read_file') { session.exit(); return 'file read'; }
      return session.execute(options.toolBatchId, options.signal, () => { browserCalls++; return 'clicked'; });
    } }, requestModel: async () => {
      requests++;
      if (requests === 1) return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: {} }, { id: 'b', name: 'browser_click', arguments: {} }] } };
      if (requests === 2) return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'browser_click', arguments: {} }] } };
      return { message: { role: 'assistant', content: 'done', toolCalls: [] } };
    } });
  assert.equal(browserCalls, 1); assert.equal(requests, 3); assert.equal(parent.signal.aborted, false);
});

test('parent task cancellation still propagates to a remote operation', async () => {
  const parent = new AbortController(), session = createRemoteOperationSession();
  const work = session.execute('batch', parent.signal, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  parent.abort(new Error('parent stopped'));
  await assert.rejects(work, /parent stopped/);
});

test('exit cancels a pending browser approval and a later approval cannot perform its click', async () => {
  const session = createRemoteOperationSession(), parent = new AbortController();
  const panel = Object.create(BrowserPanel.prototype);
  panel.generation = 1; panel.previewServer = null; panel.state = () => ({ url: 'https://example.com/' });
  let approveSignal, clicked = 0, resolveApproval;
  panel.runDOM = async input => { if (input.action === 'describe') return { tag: 'button' }; clicked++; return { clicked: true }; };
  const pending = session.execute('first', parent.signal, signal => panel.execute('browser_click', { selector: '#button' }, {
    signal, approve: (_request, options) => { approveSignal = options.signal; return new Promise(resolve => { resolveApproval = resolve; }); },
  }));
  while (!resolveApproval) await new Promise(resolve => setImmediate(resolve));
  session.exit(); assert.equal(approveSignal.aborted, true); resolveApproval(true);
  await assert.rejects(pending, /用户已退出远程操作/);
  assert.equal(clicked, 0); assert.equal(parent.signal.aborted, false);
  await session.execute('second', parent.signal, signal => panel.execute('browser_click', { selector: '#button' }, { signal, approve: async () => true }));
  assert.equal(clicked, 1);
});

test('exit retires a pending page operation without cancelling the parent task', async () => {
  const parent = new AbortController(), session = createRemoteOperationSession();
  const panel = Object.create(BrowserPanel.prototype); panel.generation = 1; panel.pageOperations = new Set();
  let retired = 0, entered;
  panel.retirePage = () => { retired++; };
  const start = new Promise(resolve => { entered = resolve; });
  const pending = session.execute('batch', parent.signal, signal => panel.boundedPageOperation({}, () => {
    entered(); return new Promise(() => {});
  }, { signal }));
  await start; session.exit();
  await assert.rejects(pending, /用户已退出远程操作/);
  assert.equal(retired, 1); assert.equal(panel.pageOperations.size, 0); assert.equal(parent.signal.aborted, false);
});

test('exit interrupts a pending navigation and permits a fresh navigation on the next batch', async () => {
  const parent = new AbortController(); let stopCount = 0, loadCount = 0;
  const panel = Object.create(BrowserPanel.prototype);
  const contents = { isDestroyed: () => false, stop: () => { stopCount++; }, loadURL: () => { loadCount++; return loadCount === 1 ? new Promise(() => {}) : Promise.resolve(); } };
  Object.assign(panel, { pageOperations: new Set(), ensureView: () => contents, applyLayout() {}, publish() {}, state: () => ({ url: 'https://example.com/' }) });
  const session = createRemoteOperationSession({ onStop: () => panel.stop() });
  const pending = session.execute('first', parent.signal, signal => panel.load('https://example.com/', { signal }));
  session.exit(); await assert.rejects(pending, /用户已退出远程操作/);
  assert.equal(parent.signal.aborted, false); assert.ok(stopCount >= 1);
  await session.execute('next', parent.signal, signal => panel.load('https://example.com/', { signal }));
  assert.equal(loadCount, 2);
});
