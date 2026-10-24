import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { createBackgroundTray } = createRequire(import.meta.url)('../src/core/background-tray.cjs');

const source = (await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const beforeQuitSource = source.slice(source.indexOf("app.on('before-quit', event => {"));
const shutdownSource = source.slice(source.indexOf('async function shutdown()'), source.indexOf('\nfunction initializeBrowser()'));
const cancelSignInsSource = source.slice(source.indexOf('function cancelAccountSignIns()'), source.indexOf('\nasync function publishRoleAccount('));
const trayStart = source.indexOf('backgroundTray = createBackgroundTray({');
const traySource = source.slice(trayStart, source.indexOf('\n  }\n  startUpdateChecks();', trayStart));
assert.ok(beforeQuitSource.startsWith("app.on('before-quit',"));
assert.ok(shutdownSource.startsWith('async function shutdown()'));
assert.ok(traySource.startsWith('backgroundTray = createBackgroundTray({'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
};

// Execute the production project shutdown implementation as well as the real
// before-quit callback. No Electron process, account, filesystem write or model
// request is involved; deferred completions expose the actual shutdown order.
function runtimeFixture(calls, name, { dirty = false, busy = true, editorDecision = true, completion } = {}) {
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => calls.push(`${name}:abort-model`));
  let visible = false;
  const win = { name, isDestroyed: () => false, isMinimized: () => false, isVisible: () => visible,
    show() { visible = true; calls.push(`${name}:show`); }, focus() { calls.push(`${name}:focus`); },
    hide() { visible = false; } };
  const settled = what => ({ settled: async () => { calls.push(`${name}:settled:${what}`); } });
  const context = vm.createContext({ stopGeneration: 0, shuttingDown: false, win,
    pluginRuntime: { closeOwner: () => calls.push(`${name}:close-plugins`) },
    promptCompletion: { abort: () => calls.push(`${name}:abort-tab`), ...settled('tab') },
    sideChat: { close: () => calls.push(`${name}:abort-sidebar`), ...settled('sidebar') },
    petDialog: { close: () => calls.push(`${name}:abort-pet`), ...settled('pet') },
    pauseQueue: () => calls.push(`${name}:pause-queue`),
    activeRun: busy ? { controller, done: completion ?? Promise.resolve() } : null,
    terminal: { stop: () => calls.push(`${name}:stop-terminal`) },
    approvals: new Map([['pending-approval', () => calls.push(`${name}:reject-approval`)]]),
    fileOperationDone: null, permissionPreferences: settled('permissions'),
    approvalReviewerPreferences: settled('reviewer'), roleModels: settled('roles'), modelCapacityPreferences: settled('capacity'),
  });
  vm.runInContext(shutdownSource, context);
  const host = { win, busy, editorDirty: dirty, hasFileOperation: false,
    requestEditorClose(reason) { calls.push(`${name}:editor:${reason}`); return Promise.resolve(editorDecision); },
    shutdown: () => context.shutdown(), scheduleNextPrompt: () => calls.push(`${name}:resume-queue`) };
  return { host, context, controller };
}

function fixture({ runtimes = [{}], restoreFlush = Promise.resolve(), capacityFlush = Promise.resolve() } = {}) {
  const calls = [], callbacks = new Map();
  const contexts = runtimes.map((options, index) => runtimeFixture(calls, `window-${index}`, options));
  const windows = new Map(contexts.map((value, index) => [index, value.host]));
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const app = { on(name, callback) { callbacks.set(name, callback); }, quit() {
    calls.push('app:quit');
    const next = event(); callbacks.get('before-quit')(next);
    if (!next.prevented) calls.push('app:exit');
  } };
  const account = name => ({ cancelSignIn: () => calls.push(`cancel-signin:${name}`) });
  const context = vm.createContext({ windows, quitting: false, updateInstalling: false, sharedMutations: 0,
    sessionRestore: { pending: false, flush: () => { calls.push('flush:restore'); return restoreFlush; } },
    persistentTaskUndo: { pending: false, flush: async () => { calls.push('flush:undo'); } },
    modelCapacityPreferences: { settled: () => { calls.push('flush:capacity'); return capacityFlush; } },
    roleModels: { settled: async () => { calls.push('flush:roles'); } },
    pluginManager: { settled: async () => { calls.push('flush:plugins'); } },
    dshPet: { settled: async () => { calls.push('flush:pet'); } }, sharedQueue: Promise.resolve(),
    chatgpt: account('chatgpt'), deepseek: account('deepseek'), gemini: account('gemini'), roleAccounts: new Map([['sidebar', account('role-chatgpt')]]),
    roleDeepseekAccounts: new Map([['sidebar', account('role-deepseek')]]), roleGeminiAccounts: new Map([['pet', account('role-gemini')]]), app,
  });
  vm.runInContext(cancelSignInsSource + '\n' + beforeQuitSource, context);
  return { context, contexts, calls, callbacks, requestQuit: () => app.quit(), app, windows };
}

test('explicit quit confirms editors before cancelling every active runtime, then waits for completion and storage', async () => {
  const decision = deferred(), run = deferred(), storage = deferred(), capacity = deferred();
  const f = fixture({ runtimes: [{ dirty: true, editorDecision: decision.promise, completion: run.promise }, {}],
    restoreFlush: storage.promise, capacityFlush: capacity.promise });
  f.requestQuit();
  assert.equal(f.context.quitting, 'pending');
  assert.equal(f.calls.includes('window-0:abort-model'), false);
  assert.equal(f.calls.includes('window-1:abort-model'), false);
  assert.equal(f.calls.includes('cancel-signin:chatgpt'), false);
  assert.equal(f.calls.includes('app:exit'), false);
  decision.resolve(true); await tick();
  assert.ok(f.contexts.every(value => value.controller.signal.aborted));
  for (const name of ['window-0', 'window-1']) {
    assert.ok(f.calls.includes(`${name}:abort-tab`) && f.calls.includes(`${name}:abort-sidebar`));
    assert.ok(f.calls.includes(`${name}:abort-pet`));
    assert.ok(f.calls.includes(`${name}:stop-terminal`) && f.calls.includes(`${name}:reject-approval`));
    assert.ok(f.calls.includes(`${name}:pause-queue`));
  }
  assert.equal(f.calls.includes('flush:restore'), false, 'Session writes wait for the cancelled model completion to settle');
  run.resolve(); await tick();
  assert.ok(f.calls.includes('flush:restore')); assert.equal(f.calls.includes('app:exit'), false);
  storage.resolve(); await tick();
  assert.ok(f.calls.includes('flush:undo') && f.calls.includes('flush:plugins') && f.calls.includes('flush:pet'));
  assert.ok(f.calls.includes('flush:capacity')); assert.equal(f.calls.includes('app:exit'), false);
  capacity.resolve(); await tick();
  assert.equal(f.context.quitting, true); assert.equal(f.calls.filter(call => call === 'app:exit').length, 1);
  assert.ok(f.calls.includes('cancel-signin:chatgpt') && f.calls.includes('cancel-signin:deepseek'));
  assert.ok(f.calls.includes('cancel-signin:role-chatgpt') && f.calls.includes('cancel-signin:role-deepseek'));
  assert.ok(f.calls.includes('cancel-signin:gemini') && f.calls.includes('cancel-signin:role-gemini'));
  assert.equal(f.calls.filter(call => call.endsWith('resume-queue')).length, 0);
});

test('cancelling a dirty editor exit keeps models, terminals and accounts alive and resumes all prompt queues', async () => {
  const decision = deferred(), f = fixture({ runtimes: [{ dirty: true, editorDecision: decision.promise }, {}] });
  f.requestQuit(); f.requestQuit();
  assert.equal(f.calls.filter(call => call === 'window-0:editor:quit').length, 1, 'A repeated quit cannot duplicate the confirmation flow');
  assert.equal(f.calls.includes('app:exit'), false);
  decision.resolve(false); await tick();
  assert.equal(f.context.quitting, false); assert.ok(f.contexts.every(value => !value.controller.signal.aborted));
  assert.equal(f.calls.some(call => call.includes('abort-') || call.includes('stop-terminal') || call.startsWith('cancel-signin:')), false);
  assert.equal(f.calls.some(call => call.startsWith('flush:')), false);
  assert.deepEqual(f.calls.filter(call => call.endsWith('resume-queue')), ['window-0:resume-queue', 'window-1:resume-queue']);
});

test('an editor confirmation failure cancels exit and allows queued work to resume without aborting it', async () => {
  const decision = deferred(), f = fixture({ runtimes: [{ dirty: true, editorDecision: decision.promise }] });
  f.requestQuit(); decision.reject(new Error('Synthetic editor confirmation error')); await tick();
  assert.equal(f.context.quitting, false); assert.equal(f.contexts[0].controller.signal.aborted, false);
  assert.ok(f.calls.includes('window-0:resume-queue')); assert.equal(f.calls.includes('app:exit'), false);
});

test('idle explicit quit flushes pending shared storage and rejects duplicate quit during the flush', async () => {
  const storage = deferred(), f = fixture({ runtimes: [{ busy: false }], restoreFlush: storage.promise });
  f.requestQuit(); f.requestQuit(); await tick();
  assert.equal(f.context.quitting, 'pending'); assert.equal(f.calls.includes('app:exit'), false);
  assert.equal(f.calls.filter(call => call === 'flush:restore').length, 1);
  assert.ok(f.calls.includes('flush:roles') && f.calls.includes('flush:capacity'));
  assert.equal(f.calls.includes('window-0:stop-terminal'), false);
  storage.resolve(); await tick();
  assert.equal(f.context.quitting, true); assert.equal(f.calls.filter(call => call === 'app:exit').length, 1);
});

test('an installer transition blocks ordinary quit until the verified installation path allows it', () => {
  const f = fixture(); f.context.updateInstalling = true;
  f.requestQuit();
  assert.equal(f.context.quitting, false); assert.equal(f.calls.includes('window-0:editor:quit'), false);
  assert.equal(f.calls.includes('app:exit'), false); assert.equal(f.contexts[0].controller.signal.aborted, false);
  f.context.quitting = true; f.requestQuit();
  assert.equal(f.calls.filter(call => call === 'app:exit').length, 1);
});

test('the production tray quit callback restores every hidden dirty window before requesting editor confirmation', async () => {
  const first = deferred(), second = deferred(), f = fixture({ runtimes: [
    { dirty: true, editorDecision: first.promise }, { dirty: true, editorDecision: second.promise },
  ] });
  let menu;
  class Tray {
    setToolTip() {} setContextMenu(value) { menu = value; } on() {} isDestroyed() { return false; }
  }
  Object.assign(f.context, { createBackgroundTray, Tray, Menu: { buildFromTemplate: value => value }, icon: 'local-fixture',
    activeWindowHost: f.contexts[0].host, backgroundTray: null, createAppWindow: () => assert.fail('Existing hidden runtimes must be reused') });
  vm.runInContext(traySource, f.context);
  menu.find(item => item.label === '退出应用').click();
  assert.ok(f.contexts.every(value => value.host.win.isVisible()), 'Every pending save/discard prompt must have a visible owner');
  assert.ok(f.calls.indexOf('window-0:show') < f.calls.indexOf('window-0:editor:quit'));
  assert.ok(f.calls.indexOf('window-1:show') < f.calls.indexOf('window-1:editor:quit'));
  first.resolve(false); second.resolve(true); await tick();
  assert.equal(f.context.quitting, false); assert.ok(f.contexts.every(value => !value.controller.signal.aborted));
});
