import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8');
function mainFunction(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(name === 'cancelAccountSignIns' ? '\nfunction providerAccountURL(' : '\nfunction ', start + 1);
  assert.ok(start >= 0, `Main-process function ${name} exists`);
  return source.slice(start, end < 0 ? source.length : end);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const officialComponents = ['antigravity', 'kimiAgent', 'glmAgent', 'claudeAgent', 'arkAccount', 'antigravityRuntime', 'kimiRuntime', 'glmRuntime', 'claudeRuntime'];
const verifiedPath = 'C:\\Users\\测试\\updates & safe\\Synora-code-Setup-0.18.4-x64.exe';
function fixture({ completions = [], restoreFlush, capacityFlush, failLaunches = 0, componentFlushes = {} } = {}) {
  const calls = [], spawns = [], windows = new Map();
  let launches = 0;
  for (const [index, enabled] of [true, false].entries()) {
    let windowEnabled = enabled;
    const host = { busy: false, hasPendingPrompts: false, editorDirty: false, hasFileOperation: false,
      win: { isEnabled: () => windowEnabled, setEnabled: value => { windowEnabled = value; }, isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (channel, event) => calls.push(`publish:${event.update.status}`) } },
      contexts: new Set([{ cancelPromptCompletion: () => calls.push(`cancel:${index}`),
        settleSideChat: async () => calls.push(`settle-sidebar:${index}`),
        settlePromptCompletion: () => { calls.push(`settle:${index}`); return completions[index] ?? Promise.resolve(); } }]),
    };
    windows.set(index, host);
  }
  const agents = Object.fromEntries(officialComponents.map(name => [name, {
    cancelSignIn: () => calls.push(`cancel-signin:${name}`), cancel: () => calls.push(`cancel-runtime:${name}`),
    dispose: async () => { calls.push(`dispose:${name}`); await componentFlushes[name]; calls.push(`disposed:${name}`); },
  }]));
  const context = vm.createContext({ windows, calls, ...agents,
    updateEnabled: true, updateInstalling: false, updateInstallPromise: null,
    quitting: false, sharedMutations: 0, sharedQueue: Promise.resolve(), sessionRenameLocks: new Set(), sessionDeleteLocks: new Set(),
    app: { getVersion: () => '0.18.3', quit: () => calls.push('quit') },
    appUpdater: { snapshot: () => ({ status: 'downloaded', version: '0.18.4', progress: 100 }),
      verifiedInstaller: async () => { calls.push('verify'); return verifiedPath; } },
    sessionRestore: { flush: () => { calls.push('flush:restore'); return restoreFlush ?? Promise.resolve(); } },
    persistentTaskUndo: { flush: async () => { calls.push('flush:undo'); } },
    permissionPreferences: { settled: async () => { calls.push('flush:permissions'); } },
    approvalReviewerPreferences: { settled: async () => { calls.push('flush:reviewer'); } },
    modelCapacityPreferences: { settled: () => { calls.push('flush:capacity'); return capacityFlush ?? Promise.resolve(); } },
    roleModels: { settled: async () => { calls.push('flush:roles'); } },
    pluginManager: { settled: async () => { calls.push('flush:plugins'); } },
    dshPet: { settled: async () => { calls.push('flush:pet'); } },
    chatgpt: { cancelSignIn: () => calls.push('cancel-signin') },
    deepseek: { cancelSignIn: () => calls.push('cancel-deepseek-signin') },
    gemini: { cancelSignIn: () => calls.push('cancel-gemini-signin') },
    roleAccounts: new Map([['sidebar', { cancelSignIn: () => calls.push('cancel-role-signin') }]]),
    roleDeepseekAccounts: new Map([['sidebar', { cancelSignIn: () => calls.push('cancel-role-deepseek-signin') }]]),
    roleGeminiAccounts: new Map([['pet', { cancelSignIn: () => calls.push('cancel-role-gemini-signin') }]]),
    spawn(filename, args, options) {
      spawns.push({ filename, args: [...args], options: { ...options } }); calls.push('spawn');
      const child = new EventEmitter(); child.unref = () => calls.push('unref');
      const fail = launches++ < failLaunches;
      queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', fail ? new Error('private launch details') : undefined));
      return child;
    },
  });
  for (const name of ['appUpdateSnapshot', 'publishAppUpdate', 'launchUpdateInstaller', 'requireUpdateIdle', 'installAppUpdate', 'cancelAccountSignIns'])
    vm.runInContext(mainFunction(name), context);
  vm.runInContext('let launchInstaller = launchUpdateInstaller; let quitForUpdate = () => { quitting = true; app.quit(); };', context);
  return { context, calls, spawns, windows, install: (...args) => context.installAppUpdate(...args) };
}

test('installation waits for every cancelled completion and storage flush before launching and quitting', async () => {
  const first = deferred(), second = deferred(), storage = deferred(), capacity = deferred();
  const f = fixture({ completions: [first.promise, second.promise], restoreFlush: storage.promise, capacityFlush: capacity.promise });
  const install = f.install({ path: 'C:\\untrusted.exe', url: 'https://untrusted.example/installer.exe' });
  assert.equal(f.install(), install, 'Repeated clicks share one installation operation');
  assert.ok([...f.windows.values()].every(host => host.win.isEnabled() === false));
  await tick();
  assert.ok(f.calls.includes('cancel:0') && f.calls.includes('cancel:1'));
  assert.ok(f.calls.includes('settle:0') && f.calls.includes('settle:1'));
  assert.ok(f.calls.includes('settle-sidebar:0') && f.calls.includes('settle-sidebar:1') && f.calls.includes('flush:roles'));
  assert.ok(f.calls.includes('flush:restore') && f.calls.includes('flush:undo') && f.calls.includes('flush:permissions') && f.calls.includes('flush:reviewer'));
  assert.ok(f.calls.includes('flush:plugins') && f.calls.includes('flush:pet'));
  assert.ok(f.calls.includes('flush:capacity'));
  assert.equal(f.spawns.length, 0); assert.equal(f.calls.includes('quit'), false);
  first.resolve(); storage.resolve(); await tick();
  assert.equal(f.spawns.length, 0, 'A different window can still be recording its cancelled completion usage');
  second.resolve(); await tick();
  assert.equal(f.spawns.length, 0, 'Model capacity preferences must finish saving before restarting for an update');
  capacity.resolve(); await install;
  assert.ok(f.calls.includes('cancel-signin') && f.calls.includes('cancel-role-signin'));
  assert.equal(f.spawns.length, 1); assert.equal(f.spawns[0].filename, verifiedPath);
  assert.ok(f.calls.indexOf('verify') < f.calls.indexOf('spawn'));
  assert.ok(f.calls.indexOf('spawn') < f.calls.indexOf('quit'));
  assert.deepEqual([...f.windows.values()].map(host => host.win.isEnabled()), [true, false]);
});

test('installer launch receives only the verified path and NSIS flags with shell execution disabled', async () => {
  const f = fixture(); await f.install();
  assert.deepEqual(f.spawns, [{ filename: verifiedPath, args: ['--updated', '/S', '--force-run'],
    options: { detached: true, stdio: 'ignore', windowsHide: true, shell: false } }]);
  assert.equal(f.calls.filter(value => value === 'unref').length, 1);
  assert.equal(f.calls.filter(value => value === 'quit').length, 1);
  assert.equal(f.calls.filter(value => value === 'cancel-deepseek-signin').length, 1);
  assert.equal(f.calls.filter(value => value === 'cancel-role-deepseek-signin').length, 1);
});

test('restart installation waits for native Agent and runtime disposal before bypassing the ordinary quit handler', async () => {
  const agent = deferred(), runtime = deferred(), claude = deferred(), claudeRuntime = deferred(), ark = deferred();
  const f = fixture({ componentFlushes: { kimiAgent: agent.promise, glmRuntime: runtime.promise,
    claudeAgent: claude.promise, claudeRuntime: claudeRuntime.promise, arkAccount: ark.promise } });
  const installing = f.install(); await tick();
  for (const name of officialComponents) assert.ok(f.calls.includes(`dispose:${name}`), name);
  assert.ok(f.calls.includes('cancel-signin:claudeAgent') && f.calls.includes('cancel-runtime:claudeRuntime') && f.calls.includes('cancel-signin:arkAccount'));
  assert.equal(f.calls.includes('quit'), false); assert.equal(f.context.quitting, false);
  agent.resolve(); await tick(); assert.ok(f.calls.includes('disposed:kimiAgent')); assert.equal(f.calls.includes('quit'), false);
  runtime.resolve(); await tick(); assert.equal(f.calls.includes('quit'), false);
  claude.resolve(); await tick(); assert.ok(f.calls.includes('disposed:claudeAgent')); assert.equal(f.calls.includes('quit'), false);
  claudeRuntime.resolve(); await tick(); assert.ok(f.calls.includes('disposed:claudeRuntime')); assert.equal(f.calls.includes('quit'), false);
  ark.resolve(); await installing; assert.equal(f.calls.filter(call => call === 'quit').length, 1);
  for (const name of ['glmRuntime', 'claudeAgent', 'claudeRuntime', 'arkAccount']) {
    assert.ok(f.calls.indexOf(`disposed:${name}`) < f.calls.indexOf('quit'));
  }
});

test('spawn failure keeps the app open, restores each original window state and permits an explicit retry', async () => {
  const f = fixture({ failLaunches: 1 });
  await assert.rejects(f.install(), /无法启动更新程序/u);
  assert.equal(f.calls.includes('quit'), false); assert.equal(f.calls.includes('unref'), false);
  assert.equal(f.context.updateInstalling, false); assert.equal(f.context.updateInstallPromise, null);
  assert.equal(f.context.appUpdateSnapshot().status, 'downloaded');
  assert.deepEqual([...f.windows.values()].map(host => host.win.isEnabled()), [true, false]);
  await f.install();
  assert.equal(f.spawns.length, 2); assert.equal(f.calls.filter(value => value === 'quit').length, 1);
});

test('work, queued prompts and unsaved or changing files in another window prevent verification and launch', () => {
  for (const field of ['busy', 'hasPendingPrompts', 'editorDirty', 'hasFileOperation']) {
    const f = fixture(); f.windows.get(1)[field] = true;
    assert.throws(() => f.install(), /所有窗口/u, field);
    assert.equal(f.spawns.length, 0); assert.equal(f.calls.includes('verify'), false); assert.equal(f.calls.includes('quit'), false);
    assert.equal(f.windows.get(0).win.isEnabled(), true);
  }
});

test('late dirty state or a failing storage flush aborts installation and restores the UI', async () => {
  const pending = deferred(), f = fixture({ completions: [pending.promise] });
  const install = f.install(); await tick();
  f.windows.get(1).editorDirty = true; pending.resolve();
  await assert.rejects(install, /所有窗口/u);
  assert.equal(f.spawns.length, 0); assert.equal(f.calls.includes('quit'), false); assert.equal(f.windows.get(0).win.isEnabled(), true);
  assert.equal(f.context.updateInstalling, false);

  const failed = deferred(), g = fixture({ restoreFlush: failed.promise });
  const failingInstall = g.install(); await tick();
  failed.reject(new Error('usage write failed'));
  await assert.rejects(failingInstall, /usage write failed/u);
  assert.equal(g.spawns.length, 0); assert.equal(g.calls.includes('quit'), false);
  assert.equal(g.context.updateInstallPromise, null); assert.equal(g.windows.get(0).win.isEnabled(), true);
});
