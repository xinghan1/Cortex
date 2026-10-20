const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, Menu, net, nativeImage, session: electronSession } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { Store } = require('./core/store.cjs');
const { migrateLegacyData, findLegacyData, prepareLegacyEncryptionState } = require('./core/migrate.cjs');
const { UIPreferences } = require('./core/ui-preferences.cjs');
const { AppearanceStore } = require('./core/appearance.cjs');
const { RecentProjects } = require('./core/recent-projects.cjs');
const { approvalDecision, validateMode } = require('./core/approval-policy.cjs');
const { BrowserPanel, BROWSER_TOOL_DEFINITIONS } = require('./core/browser-panel.cjs');
const { resolveDataDirectory } = require('./core/data-path.cjs');

const projectDir = path.resolve(__dirname, '..');
const smoke = process.argv.includes('--smoke-test');
const isInstalledBuild = require('../package.json').synoraInstalled === true;
const dataDir = resolveDataDirectory({
  override: process.env.FORGEDESK_DATA_DIR,
  isPackaged: app.isPackaged,
  isInstalled: isInstalledBuild,
  appDataPath: app.getPath('appData'),
  execPath: process.execPath,
  projectDir,
  smoke,
});
app.setName('Synora code');
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'chromium'));
if (smoke) app.disableHardwareAcceleration();

let legacyMigrationSource = null, legacyMigrationError = null;
function preparePortableMigration() {
  if (!app.isPackaged || isInstalledBuild || smoke || process.env.FORGEDESK_DATA_DIR) return;
  const previousVersions = ['Synora-code-0.16.7-win32-x64', 'Synora-code-0.16.6-win32-x64', 'Synora-code-0.16.5-win32-x64', 'Synora-code-0.16.4-win32-x64', 'Synora-code-0.16.3-win32-x64', 'Synora-code-0.16.2-win32-x64', 'Synora-code-0.16.1-win32-x64', 'Synora-code-0.16.0-win32-x64', 'Synora-code-0.15.0-win32-x64', 'Synora-code-0.14.2-win32-x64', 'Synora-code-0.14.1-win32-x64', 'Synora-code-0.14.0-win32-x64', 'Synora-code-0.13.0-win32-x64', 'Synora-code-0.12.0-win32-x64', 'AI-code-0.11.0-win32-x64', 'AI-code-0.10.0-win32-x64', 'AI-code-0.9.0-win32-x64', 'AI-code-0.8.0-win32-x64', 'AI-code-0.7.0-win32-x64', 'AI-code-0.6.0-win32-x64', 'AI-code-0.5.0-win32-x64', 'ForgeDesk-0.4.0-win32-x64', 'ForgeDesk-0.3.0-win32-x64', 'ForgeDesk-0.2.0-win32-x64', 'ForgeDesk-win32-x64'];
  previousVersions.unshift('Synora-code-0.16.8-win32-x64');
  legacyMigrationSource = findLegacyData(dataDir, previousVersions.map(previous =>
    path.join(path.dirname(path.dirname(process.execPath)), previous, 'data')));
  if (legacyMigrationSource) prepareLegacyEncryptionState(dataDir, legacyMigrationSource);
}

let win, store, chatgpt, WorkspaceTools, TOOL_DEFINITIONS, runAgent, runDemo, requestModel, TerminalSession, ManualFileManager, normalizeImageAttachments;
let modelCatalog, deriveModelCapabilities, settingsCatalogSelections, uiPreferences, appearance, recentProjects, primaryContext;
let setWorkspace, createSession, broadcastState;
const catalogSnapshots = new Map();
const windows = new Map();
const rendererErrors = [];
let sharedQueue = Promise.resolve(), sharedMutations = 0, quitting = false;
function redact(value) { return chatgpt ? chatgpt.redact(store.redact(value)) : store.redact(value); }
function requireGlobalIdle() {
  if ([...windows.values()].some(context => context.busy || context.hasPendingPrompts)) throw new Error('请先停止所有窗口的任务，并发送或移除待发送消息，再更改共享配置。');
}
function requireSharedReady() { if (sharedMutations) throw new Error('共享配置或账号正在更新，请稍后启动任务。'); }
function mutateShared(operation) {
  requireGlobalIdle();
  sharedMutations++;
  const pending = sharedQueue.then(async () => { requireGlobalIdle(); return operation(); });
  sharedQueue = pending.catch(() => {});
  return pending.finally(() => { sharedMutations--; });
}
async function broadcastAllStates() { await Promise.allSettled([...windows.values()].map(context => context.broadcastState())); }
function broadcastAppearance(value) {
  // Background bytes are local UI state. Keep them out of periodic application
  // state, project sessions, model inputs and telemetry.
  for (const host of windows.values()) {
    if (!host.win || host.win.isDestroyed() || host.win.webContents.isDestroyed()) continue;
    host.win.webContents.send('forge:event', { type: 'appearance', appearance: value });
  }
}
function makeRun(kind) {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  return { id: randomUUID(), controller: new AbortController(), kind, done, finish, startedAt: Date.now(), startedMonotonic: performance.now() };
}
function telemetrySnapshot(event) {
  const snapshot = { estimated: event.estimated === true, incomplete: event.incomplete === true };
  if (['idle', 'waiting', 'thinking', 'generating', 'tool', 'approval', 'completed'].includes(event.phase)) snapshot.phase = event.phase;
  for (const key of ['tokensPerSecond', 'elapsedMs', 'modelMs', 'inputTokens', 'outputTokens', 'estimatedOutputTokens']) {
    if (Number.isFinite(event[key]) && event[key] >= 0) snapshot[key] = event[key];
  }
  return snapshot;
}
function projectIdentity(root) { return path.normalize(root).replace(/[\\/]+$/, '').toLowerCase(); }

// One native window hosts isolated project runtimes. A project switch changes
// only the foreground runtime; its peers keep their own tools, model and queue.
function createWindowHost() {
  let switching = Promise.resolve();
  let publishTimer = null, lastPublished = 0;
  const host = {
    win: null, active: null, contexts: new Set(),
    get handlers() { return host.active.handlers; },
    get tools() { return host.active.tools; },
    get currentSession() { return host.active.currentSession; },
    get activeRun() { return [...host.contexts].find(value => value.activeRun)?.activeRun || null; },
    get busy() { return [...host.contexts].some(value => value.busy); },
    get hasPendingPrompts() { return [...host.contexts].some(value => value.hasPendingPrompts); },
    get editorDirty() { return [...host.contexts].some(value => value.editorDirty); },
    get hasFileOperation() { return [...host.contexts].some(value => value.hasFileOperation); },
    summaries() { return [...host.contexts].filter(value => value.tools).map(value => value.summary()); },
    state: () => host.active.state(),
    broadcastState: () => host.active.broadcastState(),
    setWorkspace: (...args) => host.active.setWorkspace(...args),
    createSession: (...args) => host.active.createSession(...args),
    requestEditorClose: reason => host.active.requestEditorClose(reason),
    scheduleNextPrompt() { for (const value of host.contexts) value.scheduleNextPrompt(); },
    async shutdown() { await Promise.allSettled([...host.contexts].map(value => value.shutdown())); },
    abortAll() { for (const value of host.contexts) value.abort(); },
    publishWorkspaces({ force = false } = {}) {
      if (!host.win || host.win.isDestroyed()) return;
      if (!force && Date.now() - lastPublished < 100) {
        if (!publishTimer) {
          publishTimer = setTimeout(() => { publishTimer = null; host.publishWorkspaces({ force: true }); }, 100);
          publishTimer.unref();
        }
        return;
      }
      if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; }
      lastPublished = Date.now();
      host.win.webContents.send('forge:event', {
        type: 'workspace-update', workspaceId: host.active.id,
        openWorkspaces: host.summaries(), usageStats: store.usageStats(),
      });
    },
    activateProject(root, restore = true) {
      const operation = switching.then(async () => {
        const previous = host.active;
        previous.requireSwitchReady();
        const canonical = await fs.realpath(root);
        let target = [...host.contexts].find(value => value.tools && projectIdentity(value.tools.root) === projectIdentity(canonical));
        if (!target) {
          target = previous.tools ? createWindowContext(host) : previous;
          if (target !== previous) { await target.initialize(); host.contexts.add(target); }
          try { await target.activateProjectLocal(canonical, restore); }
          catch (error) { if (target !== previous) { host.contexts.delete(target); target.dispose(); } throw error; }
        } else await rememberOpenProject(canonical);
        // The editor has already saved before the renderer requests a switch.
        // Recheck after asynchronous filesystem/history work as well.
        previous.requireSwitchReady();
        host.active = target;
        previous.refreshBrowserVisibility(); target.refreshBrowserVisibility();
        const nextState = await target.state();
        target.emit({ type: 'workspace-activated', state: nextState, session: target.publicCurrentSession() });
        await broadcastAllStates();
        return nextState;
      });
      switching = operation.catch(() => {});
      return operation;
    },
    async initialize() { await host.active.initialize(); return host; },
  };
  async function rememberOpenProject(root) {
    try { await recentProjects.record(root); }
    catch (error) { host.active.emit({ type: 'storage-error', error: error.message || '最近项目保存失败。' }); }
  }
  host.active = createWindowContext(host); host.contexts.add(host.active);
  return host;
}

function createWindowContext(host) {
let win, tools, currentSession, activeRun, terminal, fileManager;
const workspaceId = randomUUID();
let modelSelection = null;
let metricsConnectionKey = null;
const settingsCatalogPreviews = new Map();
const terminalEvents = [];
let permissionMode = 'request', browser;
let eventSequence = 0, localOperation = false, promptPreflights = 0, closeAllowed = false, closing = false, loadedSnapshot = false;
let lastFindText = null;
let fileClipboard = null, editorDirty = false, editorCloseRequest = null, fileOperationDone = null;
const pendingPrompts = [];
let queuePaused = false, queueReason = null, promptOperations = Promise.resolve(), shuttingDown = false, stopGeneration = 0;
const approvals = new Map();
function publicSettings() {
  const settings = store.publicSettings();
  if (!modelSelection) modelSelection = {
    provider: settings.provider,
    providers: Object.fromEntries(Object.entries(settings.providers).map(([name, value]) => [name, {
      model: value.model, reasoningEffort: value.reasoningEffort, authMode: value.authMode,
      ...(value.modelsByAuth ? { modelsByAuth: { ...value.modelsByAuth } } : {}),
    }])),
  };
  for (const [name, selection] of Object.entries(modelSelection.providers)) Object.assign(settings.providers[name], structuredClone(selection));
  return { ...settings, provider: modelSelection.provider, ...settings.providers[modelSelection.provider] };
}
function rememberSelection(settings) {
  publicSettings();
  const value = settings.providers[settings.provider];
  modelSelection.provider = settings.provider;
  modelSelection.providers[settings.provider] = {
    model: value.model, reasoningEffort: value.reasoningEffort, authMode: value.authMode,
    ...(value.modelsByAuth ? { modelsByAuth: { ...value.modelsByAuth } } : {}),
  };
}
async function saveProjectSettings(input) {
  requireIdle();
  if (localOperation || promptPreflights || fileOperationDone || shuttingDown || quitting) throw new Error('正在准备任务或处理文件，请稍后更改模型。');
  const shared = store.publicSettings();
  const previous = shared.providers[input?.provider];
  // Selecting a configured provider/model is local. Changing a connection is
  // shared, so it keeps the existing all-project idle requirement.
  const connectionChange = !previous || input?.clearKey === true || Boolean(String(input?.apiKey || '').trim())
    || (input?.baseUrl !== undefined && String(input.baseUrl).trim() !== previous.baseUrl)
    || (input?.apiProtocol !== undefined && input.apiProtocol !== previous.apiProtocol);
  if (connectionChange) {
    const result = await mutateShared(() => store.saveSettings(input));
    rememberSelection(result);
    return result;
  }
  // Reuse Store's validation without modifying another project's defaults or
  // credentials. The clone never writes to disk and never returns a key.
  const validator = Object.create(Store.prototype);
  validator.settings = structuredClone(store.settings);
  const local = publicSettings();
  for (const [name, selection] of Object.entries(modelSelection.providers)) Object.assign(validator.settings.providers[name], structuredClone(selection));
  validator.settings.provider = local.provider;
  validator.crypto = safeStorage; validator.write = async () => {};
  const result = await validator.saveSettings(input);
  rememberSelection(result);
  // Persist defaults only while every runtime is idle. Background requests use
  // their frozen configuration, and existing project selections stay intact.
  if (![...windows.values()].some(value => value.busy || value.hasPendingPrompts) && !sharedMutations) {
    await mutateShared(() => store.saveSettings(input));
  }
  return result;
}
function recordLiveEvent(run, clean) {
  if (!run || ['state', 'session', 'workspace-activated', 'workspace-update', 'pending-prompts', 'files-changed', 'editor-close-request', 'browser-state', 'browser-open', 'browser-capture', 'find-result', 'window-state', 'telemetry', 'session-metrics'].includes(clean.type)) return;
  const events = run.liveEvents ||= [];
  const previous = events.at(-1);
  if (clean.type === 'text-delta') {
    run.streamText = clean.replace ? String(clean.text || '') : String(run.streamText || '') + String(clean.text || '');
    const frame = { ...clean, text: run.streamText, replace: true };
    if (previous?.type === 'text-delta') events[events.length - 1] = frame;
    else events.push(frame);
  } else {
    if (clean.type === 'assistant-message') run.streamText = '';
    if (clean.type === 'command-output' && previous?.type === 'command-output') previous.text = (String(previous.text || '') + String(clean.text || '')).slice(-256 * 1024);
    else events.push(clean.type === 'command-output' ? { ...clean, text: String(clean.text || '').slice(-256 * 1024) } : clean);
  }
  // At a completed message/tool boundary it is safe to move the replay prefix
  // forward. The full original messages remain in the session archive.
  if (['assistant-message', 'tool-result'].includes(clean.type) && (events.length > 2000 || JSON.stringify(events).length > 4 * 1024 * 1024) && !approvals.size) {
    run.replayMessageStartIndex = currentSession.messages.length - 1;
    run.liveEvents = []; run.streamText = '';
  }
}
function rememberTerminalEvent(clean) {
  if (!clean.type.startsWith('terminal-')) return;
  if (clean.type === 'terminal-output') {
    const existing = terminalEvents.findIndex(value => value.id === clean.id && value.type === clean.type);
    if (existing !== -1) terminalEvents.splice(existing, 1);
  }
  const value = structuredClone(clean);
  if (typeof value.text === 'string') value.text = value.text.slice(-256 * 1024);
  if (typeof value.result?.output === 'string') value.result.output = value.result.output.slice(-256 * 1024);
  terminalEvents.push(value);
  while (terminalEvents.length > 60 || (terminalEvents.length > 3 && JSON.stringify(terminalEvents).length > 1024 * 1024)) {
    const id = terminalEvents[0].id;
    for (let index = terminalEvents.length - 1; index >= 0; index--) if (terminalEvents[index].id === id) terminalEvents.splice(index, 1);
  }
}
function emit(event) {
  if (!win || win.isDestroyed()) return;
  if (activeRun && event.type === 'context-compaction-start') activeRun.compacting = true;
  if (activeRun && event.type === 'context-compacted') activeRun.compacting = false;
  if (activeRun?.kind === 'agent' && event.type === 'telemetry') activeRun.telemetry = telemetrySnapshot(event);
  if (activeRun?.kind === 'agent' && !activeRun.demo && event.type === 'tool-start') {
    currentSession.toolSteps = (Number.isSafeInteger(currentSession.toolSteps) ? currentSession.toolSteps
      : currentSession.events.filter(item => item.type === 'tool-start').length) + 1;
    emitSessionMetrics();
  }
  const clean = JSON.parse(redact(JSON.stringify({ ...(activeRun ? { runId: activeRun.id } : {}), ...event, workspaceId, sequence: ++eventSequence })));
  recordLiveEvent(activeRun, clean); rememberTerminalEvent(clean);
  if (host.active === context) win.webContents.send('forge:event', clean);
  else host.publishWorkspaces({ force: ['approval-request', 'approval-resolved', 'run-start', 'run-end', 'terminal-start', 'terminal-end', 'pending-prompts'].includes(clean.type) });
  if (activeRun && activeRun.kind !== 'terminal' && !['text-delta', 'state', 'session', 'command-output', 'telemetry', 'find-result', 'window-state', 'pending-prompts', 'user-message', 'files-changed', 'editor-close-request', 'browser-state', 'browser-open', 'browser-capture', 'context-compaction-start', 'session-metrics'].includes(event.type) && !event.type.startsWith('terminal-')) {
    currentSession.events.push(clean);
    currentSession.events = currentSession.events.slice(-150);
  }
}
function emitSessionMetrics() {
  if (currentSession) emit({ type: 'session-metrics', sessionId: currentSession.id, metrics: sessionMetricsSnapshot(currentSession) });
}
function sessionMetricsSnapshot(session) {
  const settings = publicSettings();
  return store.sessionMetrics(session, { provider: settings.provider, model: settings.model, connectionKey: metricsConnectionKey });
}
function requireIdle() { if (activeRun) throw new Error('请先停止正在执行的任务。'); }
function requireTools() { if (!tools) throw new Error('请先打开本地项目。'); return tools; }
function requireFileManager() { if (!fileManager) throw new Error('请先打开本地项目。'); return fileManager; }
function requireEditorSettled() { if (editorDirty) throw new Error('请先保存或放弃右侧文件的修改，再切换项目。'); }
function requestEditorClose(reason = 'window') {
  if (!editorDirty || !win || win.isDestroyed()) return Promise.resolve(true);
  if (editorCloseRequest) return editorCloseRequest.promise;
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const requestId = randomUUID();
  editorCloseRequest = { requestId, promise, resolve };
  emit({ type: 'editor-close-request', requestId, reason });
  return promise;
}
async function rememberProject(root) {
  try { await recentProjects.record(root); }
  catch (error) { emit({ type: 'storage-error', error: error.message || '最近项目保存失败。' }); }
}
function fileChanged(operation, result) {
  const { content, ...summary } = result;
  emit({ type: 'files-changed', operation, ...summary });
  return result;
}
function queueSnapshot() {
  return JSON.parse(redact(JSON.stringify({ items: pendingPrompts.map(({ id, text, mode, createdAt, attachments }) => ({ id, text, mode, createdAt, ...(attachments?.length ? { attachments } : {}) })), paused: queuePaused, reason: queueReason })));
}
function emitQueue() { emit({ type: 'pending-prompts', queue: queueSnapshot() }); }
function pauseQueue(reason) {
  queuePaused = pendingPrompts.length > 0; queueReason = queuePaused ? reason : null;
  for (const item of pendingPrompts) item.mode = 'queue';
  emitQueue();
}
function serializePrompts(operation) {
  const pending = promptOperations.then(operation);
  promptOperations = pending.catch(() => {});
  return pending;
}
function requireEmptyQueue() {
  if (pendingPrompts.length) throw new Error('请先发送或移除待发送消息，再切换项目、会话或运行终端。');
}
async function dispatchNextPrompt() {
  if (activeRun || localOperation || fileOperationDone || queuePaused || shuttingDown || quitting || !pendingPrompts.length || win?.isDestroyed()) return false;
  const item = pendingPrompts[0];
  localOperation = true;
  try {
    await startTask({ text: item.text, attachments: item.attachments, promptId: item.id, promptSource: item.source || 'queue', promptCreatedAt: item.createdAt });
    const index = pendingPrompts.findIndex(value => value.id === item.id);
    if (index !== -1) pendingPrompts.splice(index, 1);
    emitQueue();
    return true;
  } catch (error) {
    pauseQueue(redact(error.message || '消息未能发送，请检查设置后继续。'));
    return false;
  } finally {
    localOperation = false;
    await broadcastAllStates();
  }
}
function scheduleNextPrompt() {
  setImmediate(() => serializePrompts(dispatchNextPrompt).catch(error => {
    pauseQueue(redact(error.message || '待发送队列已暂停。'));
  }));
}
async function submitPrompt(arg) {
  const attachments = normalizeImageAttachments(arg?.attachments);
  if (typeof arg?.text !== 'string' || (!arg.text.trim() && !attachments.length) || arg.text.trim().length > 40000 || (arg.mode !== undefined && !['queue', 'steer'].includes(arg.mode))) throw new Error('请输入最多 40000 个字符的提示词或添加图片，并选择有效发送方式。');
  const createdAt = new Date().toISOString();
  const submissionGeneration = stopGeneration;
  return serializePrompts(async () => {
    if (shuttingDown || quitting || win?.isDestroyed()) throw new Error('窗口正在关闭或等待退出确认，消息未发送。');
    if (submissionGeneration !== stopGeneration) throw new Error('发送已取消，消息未发送，输入内容仍保留。');
    requireTools();
    if (localOperation) throw new Error('此窗口正在处理另一项操作，请稍后发送。');
    if (activeRun && (activeRun.kind !== 'agent' || activeRun.demo)) throw new Error('请等待终端或演示任务结束后再发送提示词。');
    if (pendingPrompts.length >= 20) throw new Error('最多保留 20 条待发送消息，请先发送或移除部分消息。');
    if (attachments.length) {
      const preparingTools = tools, preparingSession = currentSession;
      let capabilities;
      promptPreflights++;
      try {
        requireSharedReady();
        capabilities = capabilitiesFor(await catalogContext(), publicSettings().model);
      } finally { promptPreflights--; }
      if (capabilities.supportsImages === false) throw new Error('当前模型不支持图片，请选择支持图片的模型后发送。');
      const imageChars = [...pendingPrompts.flatMap(item => item.attachments || []), ...attachments].reduce((sum, image) => sum + image.dataUrl.length, 0);
      if (imageChars > 32 * 1024 * 1024) throw new Error('待发送图片总量过大，请先发送或移除部分图片消息。');
      if (shuttingDown || quitting || win?.isDestroyed() || localOperation) throw new Error('窗口状态已变化，消息未发送，请稍后重试。');
      if (submissionGeneration !== stopGeneration || tools !== preparingTools || currentSession !== preparingSession) throw new Error('发送已取消或项目已切换，消息未发送，输入内容仍保留。');
      if (activeRun && (activeRun.kind !== 'agent' || activeRun.demo)) throw new Error('请等待终端或演示任务结束后再发送提示词。');
    }
    const immediately = !activeRun && !pendingPrompts.length && !queuePaused;
    const mode = arg.mode === 'steer' && activeRun && !activeRun.controller.signal.aborted ? 'steer' : 'queue';
    const item = { id: randomUUID(), text: arg.text.trim(), mode, source: immediately ? 'direct' : 'queue', createdAt, ...(attachments.length ? { attachments } : {}) };
    pendingPrompts.push(item); emitQueue();
    const started = await dispatchNextPrompt();
    return { id: item.id, disposition: started ? 'started' : mode === 'steer' ? 'steering' : 'queued' };
  });
}
async function managePendingPrompt(arg) {
  if (typeof arg?.id !== 'string' || !['steer', 'remove'].includes(arg.action)) throw new Error('待发送消息操作无效。');
  return serializePrompts(async () => {
    const index = pendingPrompts.findIndex(item => item.id === arg.id);
    if (index === -1) throw new Error('这条消息已发送或移除。');
    if (arg.action === 'remove') pendingPrompts.splice(index, 1);
    else {
      if (!activeRun || activeRun.kind !== 'agent' || activeRun.demo || activeRun.controller.signal.aborted || shuttingDown) throw new Error('当前没有可接收引导的模型任务，消息仍保留在待发送列表。');
      pendingPrompts[index].mode = 'steer';
    }
    if (!pendingPrompts.length) { queuePaused = false; queueReason = null; }
    emitQueue();
    return queueSnapshot();
  });
}
function takeSteering(run) {
  if (activeRun !== run || run.controller.signal.aborted || shuttingDown) return [];
  const items = pendingPrompts.filter(item => item.mode === 'steer');
  if (!items.length) return [];
  const ids = new Set(items.map(item => item.id));
  for (let index = pendingPrompts.length - 1; index >= 0; index--) if (ids.has(pendingPrompts[index].id)) pendingPrompts.splice(index, 1);
  emitQueue();
  for (const item of items) emit({ type: 'user-message', id: item.id, text: item.text, source: 'steering', createdAt: item.createdAt, ...(item.attachments?.length ? { attachments: item.attachments } : {}) });
  return items.map(({ id, text, createdAt, attachments }) => ({ id, text, createdAt, source: 'steering', ...(attachments?.length ? { attachments } : {}) }));
}
function approve(request) {
  const run = activeRun;
  if (!run || run.controller.signal.aborted) return Promise.resolve(false);
  if (approvalDecision(permissionMode, request) === 'allow') {
    emit({ type: 'approval-auto', ...request, permissionMode });
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const id = randomUUID();
    const abort = () => done(false);
    const done = value => {
      if (!approvals.delete(id)) return;
      run.controller.signal.removeEventListener('abort', abort);
      emit({ type: 'approval-resolved', id, approved: value === true }); resolve(value);
    };
    done.request = JSON.parse(redact(JSON.stringify({ type: 'approval-request', ...request, id, runId: run.id, workspaceId })));
    approvals.set(id, done);
    run.controller.signal.addEventListener('abort', abort, { once: true });
    emit({ type: 'approval-request', ...request, id });
  });
}
async function state() {
  const account = chatgpt ? await chatgpt.publicState() : null;
  const context = await catalogContext({}, account);
  metricsConnectionKey = context.key;
  reconcileReasoningSelection(context);
  const sessions = await store.listSessions();
  const history = new Map(sessions.map(session => [projectIdentity(session.workspace), session]));
  const projects = (recentProjects?.list() || []).map(project => ({ ...project, ...(history.get(projectIdentity(project.path)) ? { sessionId: history.get(projectIdentity(project.path)).id } : {}) }));
  const sessionMetrics = sessionMetricsSnapshot(currentSession);
  return { workspaceId, openWorkspaces: host.summaries(), pendingApprovals: [...approvals.values()].map(value => value.request), terminalEvents: structuredClone(terminalEvents), permissionMode, browser: browser?.state() || null, workspace: tools ? { root: tools.root, name: path.basename(tools.root) } : null, settings: publicSettings(), sessions, recentProjects: projects, recentProjectsError: recentProjects?.error || null, fileClipboard: fileClipboard ? { ...fileClipboard } : null, editorDirty, usageStats: store.usageStats(), sessionMetrics, chatgpt: account, textScale: uiPreferences?.textScale ?? 100, modelCatalog: catalogSnapshots.get(context.key) || null, version: app.getVersion(), sessionId: currentSession?.id, temporary: currentSession?.temporary === true, isFullscreen: win && !win.isDestroyed() ? win.isFullScreen() : false, promptQueue: queueSnapshot(), activeTask: { compacting: activeRun?.compacting === true, running: !!activeRun, kind: activeRun?.kind || null, demo: activeRun?.demo === true, ...(activeRun ? { runId: activeRun.id, startedAt: activeRun.startedAt, messageStartIndex: activeRun.replayMessageStartIndex ?? activeRun.messageStartIndex, streamText: activeRun.streamText || '', liveEvents: structuredClone(activeRun.liveEvents || []), telemetry: activeRun.telemetry || null } : {}) } };
}
async function catalogContext(arg = {}, account) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new Error('模型目录参数无效。');
  const settings = publicSettings();
  const provider = arg.provider ?? settings.provider;
  if (!Object.hasOwn(settings.providers, provider)) throw new Error('请选择有效的模型供应商。');
  const config = settings.providers[provider];
  const authMode = arg.authMode ?? config.authMode;
  if (!['apiKey','chatgpt'].includes(authMode) || (authMode === 'chatgpt' && provider !== 'openai')) throw new Error('此服务商不支持所选的连接方式。');
  const chatgptState = authMode === 'chatgpt' ? account ?? await chatgpt.publicState() : null;
  const key = catalogConnectionKey(provider, authMode, config, chatgptState);
  return { provider, authMode, config, account: chatgptState, key };
}
function catalogConnectionKey(provider, authMode, config, account) {
  const credential = authMode === 'chatgpt' ? [account?.session?.status, account?.session?.sharing, account?.session?.profileId] : store.settings.providers[provider].encryptedKey || '';
  return createHash('sha256').update(JSON.stringify([provider, authMode, authMode === 'chatgpt' ? 'official' : config.baseUrl, credential])).digest('hex');
}
function capabilitiesFor(context, model) {
  const metadata = catalogSnapshots.get(context.key)?.models.find(item => item.id === model);
  return deriveModelCapabilities(context.provider, model, { ...metadata, ...(context.authMode === 'chatgpt' ? { officialSource: true } : {}) });
}
function resolvedReasoningEffort(capabilities, selected = 'default') {
  if (selected === 'default' || !Array.isArray(capabilities.reasoningEfforts)) return selected;
  return capabilities.reasoningEfforts.includes(selected) ? selected : 'default';
}
function reconcileReasoningSelection(context) {
  const settings = publicSettings();
  if (settings.provider !== context.provider || settings.authMode !== context.authMode
      || catalogConnectionKey(context.provider, context.authMode, settings.providers[context.provider], context.account) !== context.key) return;
  const effort = resolvedReasoningEffort(capabilitiesFor(context, settings.model), settings.reasoningEffort);
  if (effort !== settings.reasoningEffort) modelSelection.providers[settings.provider].reasoningEffort = effort;
}
async function modelSettingsDraft(arg) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new Error('模型设置草稿无效。');
  const settings = publicSettings();
  const provider = arg.provider;
  if (!Object.hasOwn(settings.providers, provider)) throw new Error('请选择有效的模型供应商。');
  const authMode = arg.authMode ?? settings.providers[provider].authMode;
  const input = { provider, authMode, model: '' };
  if (authMode !== 'chatgpt') {
    for (const field of ['baseUrl', 'apiProtocol', 'apiKey', 'clearKey']) if (Object.hasOwn(arg, field)) input[field] = arg[field];
  }
  // Validate the draft with exactly the same rules as a saved connection, while
  // keeping its key and all configuration changes in main-process memory only.
  const validator = new Store(store.dir, safeStorage);
  validator.settings = structuredClone(store.settings);
  validator.write = async () => {};
  const validated = await validator.saveSettings(input);
  const config = validated.providers[provider];
  const account = authMode === 'chatgpt' ? await chatgpt.publicState() : null;
  if (authMode === 'chatgpt' && (account.session.status !== 'connected' || !account.session.sharing || !account.session.profileId)) throw new Error('请先连接 ChatGPT 并授权套餐用量，再获取模型目录。');
  const apiKey = authMode === 'chatgpt' ? '' : validator.key(provider);
  if (authMode !== 'chatgpt' && !apiKey) throw new Error('请填写 API Key，再获取模型目录。');
  const connection = createHash('sha256').update(JSON.stringify([
    workspaceId, provider, authMode, authMode === 'chatgpt' ? 'official' : config.baseUrl,
    authMode === 'chatgpt' ? 'responses' : config.apiProtocol || 'responses',
    authMode === 'chatgpt' ? account.session.profileId : apiKey,
  ])).digest('hex');
  return { input, provider, authMode, config, account, apiKey, connection };
}
async function previewModelSettingsCatalog(arg) {
  requireIdle(); requireSharedReady();
  const draft = await modelSettingsDraft(arg);
  let result;
  if (draft.authMode === 'chatgpt') {
    const models = (await chatgpt.listModels({ force: true })).map(model => ({ id: model.slug, displayName: model.displayName, ...deriveModelCapabilities('openai', model.slug, { ...model, officialSource: true }) }));
    result = { models, fetchedAt: new Date().toISOString(), source: 'chatgpt' };
  } else result = await modelCatalog.list({ provider: draft.provider, baseUrl: draft.config.baseUrl, apiKey: draft.apiKey, force: true });
  if ((await modelSettingsDraft(arg)).connection !== draft.connection) throw new Error('连接配置或账号已变更，请重新获取目录。');
  let safeResult = redact(JSON.stringify({ ...result, provider: draft.provider, authMode: draft.authMode }));
  if (draft.apiKey) safeResult = safeResult.split(draft.apiKey).join('[已隐藏密钥]');
  const snapshot = JSON.parse(safeResult);
  const grant = settingsCatalogSelections.register({ connection: draft.connection, models: snapshot.models });
  settingsCatalogPreviews.set(grant.selectionToken, { connection: draft.connection, snapshot });
  if (settingsCatalogPreviews.size > 6) settingsCatalogPreviews.delete(settingsCatalogPreviews.keys().next().value);
  return { ...snapshot, selectionToken: grant.selectionToken, expiresAt: grant.expiresAt };
}
async function commitModelSettings(arg) {
  requireIdle();
  return mutateShared(async () => {
    const draft = await modelSettingsDraft(arg);
    const selected = settingsCatalogSelections.validate({ selectionToken: arg.selectionToken, connection: draft.connection, model: arg.model });
    const preview = settingsCatalogPreviews.get(arg.selectionToken);
    if (!preview || preview.connection !== draft.connection) throw new Error('请重新获取模型目录，再选择模型并保存。');
    const current = publicSettings().providers[draft.provider];
    const reasoningEffort = resolvedReasoningEffort(selected, current.reasoningEffort);
    const saved = await store.saveSettings({ ...draft.input, model: selected.id, reasoningEffort });
    rememberSelection(saved);
    const context = await catalogContext();
    catalogSnapshots.set(context.key, structuredClone(preview.snapshot));
    if (catalogSnapshots.size > 24) catalogSnapshots.delete(catalogSnapshots.keys().next().value);
    await broadcastAllStates();
    return state();
  });
}
async function fetchModelCatalog(arg = {}) {
  requireIdle();
  const context = await catalogContext(arg);
  let result;
  try {
    if (context.authMode === 'chatgpt') {
      if (context.account?.session?.status !== 'connected') throw new Error('请先登录 ChatGPT，再获取账号模型目录。');
      if (!context.account.session.sharing) throw new Error('请先授权 ChatGPT 套餐用量，再获取模型目录。');
      const models = (await chatgpt.listModels({ force: arg.force === true })).map(model => ({ id: model.slug, displayName: model.displayName, ...deriveModelCapabilities('openai', model.slug, { ...model, officialSource: true }) }));
      result = { models, fetchedAt: new Date().toISOString(), source: 'chatgpt' };
    } else {
      const apiKey = store.key(context.provider);
      if (!apiKey) throw new Error('请先保存此服务商的 API Key，再获取模型目录。');
      result = await modelCatalog.list({ provider: context.provider, baseUrl: context.config.baseUrl, apiKey, force: arg.force === true });
    }
    if ((await catalogContext({ provider: context.provider, authMode: context.authMode })).key !== context.key) throw new Error('模型连接配置已变更，请重新获取目录。');
    const snapshot = JSON.parse(redact(JSON.stringify({ ...result, provider: context.provider, authMode: context.authMode })));
    catalogSnapshots.set(context.key, snapshot);
    if (catalogSnapshots.size > 24) catalogSnapshots.delete(catalogSnapshots.keys().next().value);
    await broadcastState();
    return snapshot;
  } catch (error) {
    catalogSnapshots.delete(context.key);
    await broadcastState();
    throw new Error(redact(error.message || '无法获取模型目录，请稍后重试。'));
  }
}
async function broadcastState() { if (win && !win.isDestroyed()) emit({ type: 'state', state: await state() }); }
async function saveCurrentSession() {
  if (!currentSession || currentSession.temporary === true || loadedSnapshot) return;
  const clean = JSON.parse(redact(JSON.stringify(currentSession)));
  await store.saveSession(clean);
  currentSession.updatedAt = clean.updatedAt;
}
function publicSession(session) {
  const { contextCheckpoint, usageBaseline, contextUsage, ...publicData } = session;
  publicData.sessionMetrics = sessionMetricsSnapshot(session);
  return JSON.parse(redact(JSON.stringify({ ...publicData, ...(session.workspace && !session.demo ? { title: path.basename(path.normalize(session.workspace)) || path.parse(session.workspace).root } : {}), messages: session.messages.map(({ providerState, ...message }) => message) })));
}
function sessionContextCheckpoint() {
  if (!currentSession.contextCheckpoint || typeof currentSession.contextCheckpoint !== 'object' || Array.isArray(currentSession.contextCheckpoint)) currentSession.contextCheckpoint = {};
  return currentSession.contextCheckpoint;
}
function setWorkspace(root) {
  if (shuttingDown) throw new Error('窗口正在关闭，请在新窗口继续操作。');
  requireEditorSettled();
  if (tools && projectIdentity(tools.root) !== projectIdentity(root)) throw new Error('请通过项目下拉菜单切换项目，当前任务的项目目录不能更改。');
  const nextTools = new WorkspaceTools(root, { approve, onEvent: emit });
  const nextFiles = new ManualFileManager(nextTools.root, { trash: absolute => shell.trashItem(absolute) });
  if (!tools || projectIdentity(tools.root) !== projectIdentity(nextTools.root)) { permissionMode = 'request'; browser?.resetWorkspace(); }
  tools = nextTools; fileManager = nextFiles; fileClipboard = null; editorDirty = false;
}
async function activateProjectLocal(root, restore = true) {
  const canonical = await fs.realpath(root);
  const history = restore ? (await store.listSessions()).find(session => projectIdentity(session.workspace) === projectIdentity(canonical)) : null;
  // Load the historical snapshot before changing either the workspace or editor.
  const snapshot = history ? await store.getSession(history.id) : null;
  setWorkspace(canonical);
  if (snapshot) { currentSession = snapshot; loadedSnapshot = true; }
  else await createSession();
  await rememberProject(canonical);
  return state();
}
async function createSession({ temporary = false } = {}) {
  currentSession = store.createSession(tools?.root || null);
  loadedSnapshot = false;
  if (temporary) currentSession.temporary = true;
  if (tools) currentSession.title = path.basename(tools.root) || path.parse(tools.root).root;
  currentSession.usageLedgerVersion = 1;
  await saveCurrentSession();
  return currentSession;
}
async function startTask(input) {
  requireIdle();
  requireSharedReady();
  const startingGeneration = stopGeneration;
  const text = String(input?.text || '').trim();
  const demo = input?.demo === true;
  const attachments = demo ? [] : normalizeImageAttachments(input?.attachments);
  if (!demo && ((!text && !attachments.length) || text.length > 40000)) throw new Error('请输入任务或添加图片，文字长度最多 40000 字符。');
  if (!demo) requireTools();
  if (currentSession.demo === true || (demo && currentSession.messages.length) || (!demo && currentSession.workspace !== tools.root)) await createSession({ temporary: currentSession.temporary === true });
  const settings = publicSettings();
  const provider = settings.provider;
  const useChatGPT = provider === 'openai' && settings.authMode === 'chatgpt';
  const modelContext = await catalogContext();
  metricsConnectionKey = modelContext.key;
  const modelCapabilities = capabilitiesFor(modelContext, settings.model);
  // Unknown models accept the user's generic choice. Advertised capabilities
  // narrow those choices, including an explicit empty list for no adjustment.
  const reasoningEffort = resolvedReasoningEffort(modelCapabilities, settings.reasoningEffort);
  let chatgptProfileId = null;
  let apiKey = '';
  if (!demo) {
    if (!settings.model) throw new Error('请先在模型设置中填写模型 ID。');
    if (modelCapabilities.supportsTools === false) throw new Error('此模型不支持编程工具调用，请从目录选择兼容模型。');
    if (attachments.length && modelCapabilities.supportsImages === false) throw new Error('当前模型不支持图片，请选择支持图片的模型后发送。');
    if (reasoningEffort !== 'default' && Array.isArray(modelCapabilities.reasoningEfforts) && !modelCapabilities.reasoningEfforts.includes(reasoningEffort)) throw new Error('所选模型不支持当前推理强度，请改用默认或目录支持的档位。');
    if (useChatGPT) {
      const account = await chatgpt.publicState();
      if (account.session.status !== 'connected') throw new Error('请先在模型设置中登录 ChatGPT。');
      if (!account.session.sharing) throw new Error('ChatGPT 已登录，但尚未授权套餐用量；请在模型设置中连接套餐。');
      chatgptProfileId = account.session.profileId;
      if (!chatgptProfileId) throw new Error('ChatGPT 账号信息不完整，请重新登录。');
    } else {
      apiKey = store.key(provider);
      if (!apiKey) throw new Error('请先在模型设置中填写 API Key。');
    }
  }
  if (!demo) {
    if (currentSession.messages.length && (currentSession.chatgptProfileId || null) !== chatgptProfileId) await createSession({ temporary: currentSession.temporary === true });
    currentSession.chatgptProfileId = chatgptProfileId;
  }
  if (loadedSnapshot) {
    const fork = store.createSession(currentSession.workspace);
    // A history continuation inherits only the totals visible at this fork.
    // Later requests in the original session cannot change the branch's totals.
    currentSession = { ...currentSession, id: fork.id, createdAt: fork.createdAt, usageBaseline: store.sessionUsageTotals(currentSession) };
    loadedSnapshot = false;
  }
  if (shuttingDown || win?.isDestroyed()) throw new Error('窗口已关闭，任务未启动。');
  if (stopGeneration !== startingGeneration) throw new Error('任务启动已取消，消息仍保留在待发送列表。');
  currentSession.demo = demo;
  currentSession.usageLedgerVersion = 1;
  currentSession.title = demo ? '离线演示 · 代码助手流程' : path.basename(tools.root) || path.parse(tools.root).root;
  const userText = demo ? '演示一次代码助手的工作流程（离线，不调用 API）' : text;
  const userMessage = { id: input?.promptId || randomUUID(), role: 'user', content: userText, createdAt: input?.promptCreatedAt || new Date().toISOString(), ...(input?.promptSource ? { source: input.promptSource } : {}), ...(attachments.length ? { attachments } : {}) };
  currentSession.messages.push(userMessage);
  const run = makeRun('agent');
  run.demo = demo;
  run.messageStartIndex = currentSession.messages.length - 1;
  activeRun = run;
  // Let invoke resolve before the first event, so the renderer can set its running state.
  const executeRun = async () => {
    if (activeRun !== run) return;
    let status = 'completed', error;
    emit({ type: 'session', session: publicSession(currentSession) });
    if (input?.promptId) emit({ type: 'user-message', id: input.promptId, text: userText, source: input.promptSource || 'direct', createdAt: userMessage.createdAt, ...(attachments.length ? { attachments } : {}) });
    emit({ type: 'run-start', runId: run.id, kind: 'agent', demo, startedAt: run.startedAt, messageStartIndex: run.messageStartIndex });
    try {
      if (demo) {
        await runDemo({ signal: run.controller.signal, emit: event => {
          if (event.type === 'assistant-message') currentSession.messages.push({ role: 'assistant', content: event.text, toolCalls: [] });
          emit(event);
        }, approve });
      } else {
        const modelRequest = useChatGPT ? options => chatgpt.requestModel({ ...options, requestModel }) : requestModel;
        await runAgent({ config: { provider, apiKey, baseUrl: useChatGPT ? 'https://api.openai.com/v1' : settings.baseUrl, apiProtocol: useChatGPT ? 'responses' : settings.apiProtocol, model: settings.model, modelCapabilities, reasoningEffort }, messages: currentSession.messages, permissionMode, workspace: { root: tools.root, execute: (name, args, options) => { if (name.startsWith('browser_')) { emit({ type: 'browser-open' }); return browser.execute(name, args, { ...options, approve }); } return tools.execute(name, args, options); } }, toolDefinitions: [...TOOL_DEFINITIONS, ...BROWSER_TOOL_DEFINITIONS], requestModel: modelRequest, signal: run.controller.signal, emit, redact, runId: run.id, sessionId: currentSession.id,
          takeSteering: () => takeSteering(run),
          onMessagesChanged: emitSessionMetrics,
          contextCheckpoint: sessionContextCheckpoint(),
          onContextCompacted: () => saveCurrentSession(),
          onContextUsage: sample => {
            currentSession.contextUsage = { ...sample, connectionKey: modelContext.key };
            emitSessionMetrics();
          },
          onUsage: async record => {
            try { await store.recordUsage(record); emitSessionMetrics(); await broadcastAllStates(); }
            catch (cause) { emit({ type: 'storage-error', error: 'Token 统计保存失败：' + cause.message }); }
          }
        });
      }
    } catch (cause) {
      if (run.controller.signal.aborted) status = 'stopped';
      else { status = 'failed'; error = redact(cause.message || '任务失败。'); }
    } finally {
      for (const done of [...approvals.values()]) done(false);
      if (run.controller.signal.aborted) status = 'stopped';
      const endEvent = { type: 'run-end', runId: run.id, kind: 'agent', status, ...(error ? { error } : {}), startedAt: run.startedAt, endedAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - run.startedMonotonic)), messageStartIndex: run.messageStartIndex, messageIndex: currentSession.messages.length - 1, ...(run.telemetry ? { telemetry: run.telemetry } : {}) };
      // Store only one timing/rate summary per task. Streaming estimates stay
      // out of the token ledger, and history never restarts a completed timer.
      currentSession.events.push(endEvent);
      currentSession.events = currentSession.events.slice(-150);
      try {
        await saveCurrentSession();
        if (run.controller.signal.aborted && endEvent.status !== 'stopped') {
          status = 'stopped'; endEvent.status = status;
          await saveCurrentSession();
        }
      }
      catch (cause) { status = 'failed'; error = '会话保存失败，请检查本地存储后继续。'; endEvent.status = status; endEvent.error = error; emit({ type: 'storage-error', error: '会话保存失败：' + cause.message }); }
      if (run.controller.signal.aborted) status = 'stopped';
      endEvent.status = status;
      activeRun = null;
      run.finish();
      for (const item of pendingPrompts) item.mode = 'queue';
      if (status !== 'completed') pauseQueue(status === 'stopped' ? '当前任务已停止，待发送消息已暂停。' : '当前任务未完成，请检查错误后继续发送。');
      else { if (!pendingPrompts.length) { queuePaused = false; queueReason = null; } emitQueue(); }
      emit({ ...endEvent, status, error });
      await broadcastState();
      if (status === 'completed') scheduleNextPrompt();
    }
  };
  try { await saveCurrentSession(); }
  catch (cause) { run.controller.abort(); if (currentSession.messages.at(-1) === userMessage) currentSession.messages.pop(); activeRun = null; run.finish(); throw cause; }
  setTimeout(executeRun, 40);
  return { runId: run.id };
}

function buildHandlers() {
  const activateChatGPT = async () => {
    const account = await chatgpt.publicState();
    if (account.session.status === 'connected' && account.session.sharing) {
      let models = [];
      try { models = await chatgpt.listModels(); } catch { /* Keep the account connected; saving a model still requires a successful catalog. */ }
      if (models.length) {
        const openai = publicSettings().providers.openai;
        const model = models.find(item => item.slug === openai.modelsByAuth?.chatgpt)?.slug || models[0].slug;
        rememberSelection(await store.saveSettings({ provider: 'openai', authMode: 'chatgpt', model, baseUrl: openai.baseUrl }));
      }
    }
    await broadcastState(); return state();
  };
  const handlers = {
    getState: state,
    getAppearance: () => appearance.snapshot(),
    importBackground: async () => {
      let chosen;
      try {
        chosen = await dialog.showOpenDialog(win, {
          title: '导入背景图', buttonLabel: '导入背景图', properties: ['openFile'],
          filters: [{ name: '背景图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        });
      } catch { throw new Error('背景图片选择窗口无法打开，请稍后重试。'); }
      if (chosen.canceled || !chosen.filePaths?.length) return appearance.snapshot();
      // The renderer cannot supply a filesystem path. Only this native chooser
      // passes a user-selected raster file into the persistent appearance store.
      const value = await appearance.importFile(chosen.filePaths[0]);
      broadcastAppearance(value);
      return value;
    },
    setAppearance: async arg => {
      const value = await appearance.setAppearance(arg);
      broadcastAppearance(value);
      return value;
    },
    resetBackground: async () => {
      const value = await appearance.resetBackground();
      broadcastAppearance(value);
      return value;
    },
    copyText: arg => {
      if (typeof arg?.text !== 'string' || arg.text.length > 40000) throw new Error('复制内容无效或超过 40000 个字符。');
      clipboard.writeText(arg.text);
      return { copied: true };
    },
    getCurrentSession: async () => publicSession(currentSession),
    setEditorDirty: arg => {
      if (typeof arg?.dirty !== 'boolean') throw new Error('编辑状态无效。');
      editorDirty = arg.dirty;
      return { dirty: editorDirty };
    },
    confirmCloseWindow: arg => {
      if (typeof arg?.requestId !== 'string' || typeof arg.allow !== 'boolean') throw new Error('关闭确认无效。');
      if (!editorCloseRequest || editorCloseRequest.requestId !== arg.requestId) return false;
      const request = editorCloseRequest; editorCloseRequest = null;
      if (arg.allow) editorDirty = false;
      request.resolve(arg.allow);
      return true;
    },
    submitPrompt,
    managePendingPrompt,
    resumePendingPrompts: () => serializePrompts(async () => {
      if (shuttingDown) throw new Error('窗口正在关闭。');
      queuePaused = false; queueReason = null; emitQueue();
      await dispatchNextPrompt();
      return queueSnapshot();
    }),
    ...menuHandlers(),
    setTextScale: async arg => {
      await uiPreferences.setTextScale(arg?.scale);
      await broadcastAllStates(); return state();
    },
    setPermissionMode: async arg => {
      const mode = validateMode(arg?.mode);
      requireIdle(); requireEmptyQueue();
      if (localOperation || promptPreflights || shuttingDown || quitting) throw new Error('请等待当前操作结束后再切换权限。');
      if (mode === 'full' && arg?.confirmed !== true) throw new Error('启用完全控制前需要确认风险。');
      permissionMode = mode;
      await broadcastState();
      return { mode: permissionMode };
    },
    browserOpen: async arg => {
      if (!browser) throw new Error('浏览器尚未就绪。');
      emit({ type: 'browser-open' });
      return browser.open(arg);
    },
    browserLayout: arg => browser.setLayout(arg),
    browserCommand: async arg => {
      if (!['back', 'forward', 'reload', 'stop', 'close'].includes(arg?.action)) throw new Error('浏览器操作无效。');
      await browser[arg.action](); return browser.state();
    },
    chooseWorkspace: async () => {
      context.requireSwitchReady();
      const result = await dialog.showOpenDialog(win, { title: '打开代码项目', properties: ['openDirectory'] });
      if (!result.canceled && result.filePaths[0]) {
        await host.activateProject(result.filePaths[0]);
      }
      return host.state();
    },
    openProject: async arg => {
      if (typeof arg?.path !== 'string' || !path.isAbsolute(arg.path) || arg.path.includes('\0')) throw new Error('项目路径无效。');
      return host.activateProject(arg.path);
    },
    listFiles: arg => requireTools().listFiles(arg || {}),
    readFile: arg => requireTools().readFile(arg || {}),
    fileList: arg => requireFileManager().list(arg || {}),
    listProjectSessions: () => store.listProjectSessions(tools?.root || null),
    fileRead: arg => requireFileManager().read(arg),
    fileCreate: async arg => fileChanged('create', await requireFileManager().create(arg)),
    fileRename: async arg => {
      const result = await requireFileManager().rename(arg);
      if (fileClipboard && (fileClipboard.path === result.oldPath || fileClipboard.path.startsWith(result.oldPath + '/'))) {
        fileClipboard.path = result.path + fileClipboard.path.slice(result.oldPath.length);
      }
      return fileChanged('rename', result);
    },
    fileDelete: async arg => {
      const manager = requireFileManager();
      const target = await manager.paths(arg);
      if (!target.relative) throw new Error('不能删除项目根目录。');
      const confirmation = await dialog.showMessageBox(win, { type: 'question', title: '移至回收站', message: `将“${target.relative}”移至 Windows 回收站？`, detail: '文件夹内的内容也会一起移入回收站。', buttons: ['移至回收站', '取消'], defaultId: 1, cancelId: 1, noLink: true });
      if (confirmation.response !== 0) return { canceled: true };
      const result = await manager.remove(arg);
      if (fileClipboard && (fileClipboard.path === result.path || fileClipboard.path.startsWith(result.path + '/'))) fileClipboard = null;
      return fileChanged('delete', result);
    },
    fileClipboard: async arg => {
      if (!['copy', 'cut'].includes(arg?.mode)) throw new Error('请选择复制或剪切。');
      const target = await requireFileManager().paths(arg);
      if (!target.relative) throw new Error('请先选择项目内的文件或文件夹。');
      fileClipboard = { path: target.relative, mode: arg.mode };
      await broadcastState();
      return { ...fileClipboard };
    },
    filePaste: async arg => {
      if (!fileClipboard) throw new Error('请先在文件树中复制或剪切文件。');
      const result = await requireFileManager().copyOrMove({ source: fileClipboard.path, destination: arg?.destination ?? '', mode: fileClipboard.mode });
      if (fileClipboard.mode === 'cut') fileClipboard = null;
      return fileChanged('paste', result);
    },
    fileCopyPath: async arg => {
      if (arg?.relative !== undefined && typeof arg.relative !== 'boolean') throw new Error('路径复制参数无效。');
      const target = await requireFileManager().paths(arg);
      const text = arg?.relative === true ? target.relative : target.absolute;
      clipboard.writeText(text);
      return { text };
    },
    fileReveal: async arg => {
      const target = await requireFileManager().paths(arg);
      shell.showItemInFolder(target.absolute);
      return null;
    },
    fileSave: async arg => fileChanged('save', await requireFileManager().save(arg)),
    listModels: fetchModelCatalog,
    selectModel: async arg => {
      requireIdle();
      if (typeof arg?.model !== 'string' || !arg.model || arg.model.length > 200) throw new Error('模型标识无效。');
      const context = await catalogContext();
      const model = catalogSnapshots.get(context.key)?.models.find(item => item.id === arg.model);
      if (!model) throw new Error('请先刷新当前连接的模型目录，再选择模型。');
      if (model.supportsTools === false) throw new Error('此模型不支持当前编程助手使用的工具，请选择支持工具调用的模型。');
      const previous = publicSettings();
      const capabilities = capabilitiesFor(context, model.id);
      const reasoningEffort = resolvedReasoningEffort(capabilities, previous.reasoningEffort);
      await saveProjectSettings({ provider: context.provider, authMode: context.authMode, model: model.id, reasoningEffort });
      await broadcastState(); return state();
    },
    saveSettings: async arg => { await saveProjectSettings(arg); await broadcastAllStates(); return state(); },
    previewModelCatalog: previewModelSettingsCatalog,
    saveModelSettings: commitModelSettings,
    chatgptSignIn: async arg => {
      requireIdle();
      if (arg !== undefined && (!arg || typeof arg !== 'object' || Array.isArray(arg))) throw new Error('登录参数无效。');
      const options = {};
      if (arg?.newProfile === true) options.newProfile = true;
      if (arg?.reconsent === true) options.reconsent = true;
      if (arg?.profileId !== undefined) {
        if (typeof arg.profileId !== 'string' || arg.profileId.length > 200) throw new Error('账号标识无效。');
        options.profileId = arg.profileId;
      }
      await chatgpt.signIn(options); return activateChatGPT();
    },
    chatgptCancelSignIn: () => { requireGlobalIdle(); chatgpt.cancelSignIn(); return null; },
    chatgptSelectProfile: async arg => { requireIdle(); await chatgpt.selectProfile(arg?.id); return activateChatGPT(); },
    chatgptDisconnect: async () => { requireIdle(); await chatgpt.disconnect(); await broadcastState(); return state(); },
    chatgptRetryStorage: async () => { requireIdle(); await chatgpt.retryLocalRead(); await broadcastAllStates(); return state(); },
    chatgptListModels: async () => { requireIdle(); const models = await chatgpt.listModels({ force: true }); await broadcastState(); return models; },
    chatgptOpenUsage: async () => { await shell.openExternal('https://chatgpt.com/settings/usage'); return null; },
    setReasoningEffort: async arg => {
      requireIdle();
      const current = publicSettings();
      const capabilities = capabilitiesFor(await catalogContext(), current.model);
      if (arg?.reasoningEffort !== 'default') {
        if (Array.isArray(capabilities.reasoningEfforts) && !capabilities.reasoningEfforts.includes(arg?.reasoningEffort)) throw new Error('当前模型不支持此推理强度，请使用默认或支持的档位。');
      }
      await saveProjectSettings({ provider: current.provider, authMode: current.authMode, model: current.model, baseUrl: current.baseUrl, reasoningEffort: arg?.reasoningEffort });
      await broadcastState(); return state();
    },
    runTask: startTask,
    stopTask: () => { ++stopGeneration; pauseQueue('任务已停止，待发送消息已暂停。'); activeRun?.controller.abort(); return null; },
    respondApproval: arg => {
      if (typeof arg?.id !== 'string' || typeof arg?.approved !== 'boolean') throw new Error('审批参数无效。');
      const done = approvals.get(arg.id);
      if (!done) return false;
      done(arg.approved); return true;
    },
    getSession: async arg => {
      requireIdle();
      const loaded = await store.getSession(arg?.id);
      if (loaded.workspace && (!tools || projectIdentity(loaded.workspace) !== projectIdentity(tools.root))) throw new Error('请先通过项目下拉菜单切换到此会话所属项目，再打开历史会话。');
      currentSession = loaded;
      loadedSnapshot = true;
      if (tools) await rememberProject(tools.root);
      await broadcastState();
      return publicSession(loaded);
    },
    newSession: async arg => {
      requireIdle();
      if (arg !== undefined && (!arg || typeof arg !== 'object' || Array.isArray(arg) || (arg.temporary !== undefined && typeof arg.temporary !== 'boolean'))) throw new Error('新对话参数无效。');
      await createSession({ temporary: arg?.temporary === true }); await broadcastAllStates();
      return { id: currentSession.id, temporary: currentSession.temporary === true };
    },
    undoLastChange: async () => {
      requireIdle();
      const workspace = requireTools();
      requireSharedReady();
      const run = makeRun('undo');
      activeRun = run;
      emit({ type: 'run-start', runId: run.id, kind: 'undo' });
      let status = 'completed', error;
      try {
        const result = await workspace.undoLastChange({ signal: run.controller.signal });
        if (result.startsWith('错误：')) { status = 'failed'; error = result; }
        emit({ type: 'tool-result', name: 'undo_last_change', result });
        return { result };
      } finally {
        try { await saveCurrentSession(); }
        finally {
          activeRun = null;
          run.finish();
          emit({ type: 'run-end', status: run.controller.signal.aborted ? 'stopped' : status, error });
        }
      }
    },
    openPath: async arg => {
      const workspace = requireTools();
      if (!arg?.path || arg.path === '.') return shell.openPath(workspace.root);
      // Reuse the guarded file reader before opening anything in the host OS.
      const file = await workspace.readFile({ path: arg.path });
      const target = path.resolve(workspace.root, file.path);
      shell.showItemInFolder(target);
      return null;
    }
  };
  for (const name of ['chatgptSignIn', 'chatgptSelectProfile', 'chatgptDisconnect', 'chatgptRetryStorage']) {
    const handler = handlers[name];
    handlers[name] = arg => mutateShared(async () => { const result = await handler(arg); await broadcastAllStates(); return result; });
  }
  // Manual file actions can run alongside a model/terminal and queued prompts.
  // Serialize their own requests, including clipboard state, without waiting
  // for an active model or holding the prompt/session operation lock.
  let manualOperations = Promise.resolve();
  const manualMutations = new Set(['fileCreate', 'fileRename', 'fileDelete', 'filePaste', 'fileSave', 'fileClipboard']);
  for (const name of ['fileList', 'fileRead', 'fileCreate', 'fileRename', 'fileDelete', 'fileClipboard', 'filePaste', 'fileCopyPath', 'fileReveal', 'fileSave']) {
    const handler = handlers[name];
    handlers[name] = arg => {
      if (shuttingDown || quitting || win?.isDestroyed()) throw new Error('窗口正在关闭，文件操作未开始。');
      const manager = requireFileManager();
      const pending = manualOperations.then(() => {
        if (win?.isDestroyed() || manager !== fileManager) throw new Error('项目已切换或关闭，文件操作未开始。');
        return handler(arg);
      });
      const settled = pending.then(() => {}, () => {});
      manualOperations = settled;
      // Reads queue behind already accepted mutations but do not by themselves
      // prevent starting a task or switching the foreground project.
      if (manualMutations.has(name)) fileOperationDone = settled;
      return pending.finally(async () => {
        if (fileOperationDone === settled) fileOperationDone = null;
        try { if (manualMutations.has(name)) await broadcastAllStates(); }
        finally { scheduleNextPrompt(); }
      });
    };
  }
  for (const name of ['getSession', 'newSession', 'runTask', 'undoLastChange', 'runTerminal']) {
    const handler = handlers[name];
    handlers[name] = async arg => {
      if (shuttingDown) throw new Error('窗口正在关闭，请在新窗口继续操作。');
      if (promptPreflights) throw new Error('正在检查消息附件，请等待发送完成后再操作。');
      if (localOperation || fileOperationDone) throw new Error('此窗口正在处理另一项操作，请稍后重试。');
      if (['chooseWorkspace', 'createProject', 'openProject', 'getSession'].includes(name)) requireEditorSettled();
      requireEmptyQueue();
      requireIdle(); localOperation = true;
      try { return await handler(arg); }
      finally {
        localOperation = false;
        await broadcastAllStates();
      }
    };
  }
  return handlers;
}

function menuHandlers() {
  return {
    newWindow: async () => ({ id: (await createAppWindow()).win.id }),
    createProject: async () => {
      context.requireSwitchReady();
      const result = await dialog.showSaveDialog(win, { title: '新建项目', buttonLabel: '新建项目', defaultPath: path.join(app.getPath('documents'), '新项目'), properties: ['createDirectory'] });
      if (!result.canceled && result.filePath) {
        try { await fs.mkdir(result.filePath); }
        catch (error) { throw new Error(error.code === 'EEXIST' ? '该位置已存在，请选择新的项目文件夹名称。' : '无法创建项目文件夹，请检查所选位置。'); }
        await host.activateProject(result.filePath, false);
      }
      return host.state();
    },
    closeWindow: () => { setImmediate(() => { if (!win.isDestroyed()) win.close(); }); return null; },
    quitApp: () => { setImmediate(() => app.quit()); return null; },
    editCommand: arg => {
      if (!['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'].includes(arg?.command)) throw new Error('编辑命令无效。');
      win.webContents[arg.command](); return null;
    },
    toggleFullscreen: () => { const enabled = !win.isFullScreen(); win.setFullScreen(enabled); return enabled; },
    findText: arg => {
      if (typeof arg?.text !== 'string' || arg.text.length > 5000 || ['forward', 'findNext'].some(key => arg[key] !== undefined && typeof arg[key] !== 'boolean')) throw new Error('查找参数无效。');
      if (!arg.text) { lastFindText = null; win.webContents.stopFindInPage('clearSelection'); return 0; }
      // Electron's findNext flag starts a new search when true; false advances it.
      const newSearch = lastFindText !== arg.text || (arg.findNext ?? true);
      lastFindText = arg.text;
      return win.webContents.findInPage(arg.text, { forward: arg.forward ?? true, findNext: newSearch });
    },
    stopFind: () => { lastFindText = null; win.webContents.stopFindInPage('clearSelection'); return null; },
    openLink: async arg => {
      if (typeof arg?.url !== 'string' || arg.url.length > 4096 || /[\u0000-\u001f\u007f]/u.test(arg.url)) throw new Error('链接地址无效。');
      let url; try { url = new URL(arg.url); } catch { throw new Error('链接地址无效。'); }
      const authority = arg.url.trim().match(/^[a-z][a-z\d+.-]*:\/\/([^/]*)/iu)?.[1] || '';
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || authority.includes('@')) throw new Error('仅允许不含用户名和密码的 HTTP 或 HTTPS 链接。');
      await shell.openExternal(url.href); return null;
    },
    openHelp: async arg => {
      if (arg?.topic === 'guide') {
        const guide = app.isPackaged ? path.join(path.dirname(process.execPath), '使用说明.md') : path.join(projectDir, 'README.md');
        if (await shell.openPath(guide)) throw new Error('无法打开使用说明，请在应用目录查看说明文件。');
      } else if (arg?.topic === 'about') {
        await dialog.showMessageBox(win, { type: 'info', title: '关于 Synora code', message: 'Synora code', detail: `版本 ${app.getVersion()}\n本地项目 AI 编程助手`, buttons: ['确定'] });
      } else throw new Error('帮助主题无效。');
      return null;
    },
    runTerminal: async arg => {
      requireIdle(); requireSharedReady(); requireTools();
      if (typeof arg?.command !== 'string' || !arg.command.trim() || arg.command.includes('\0') || arg.command.length > 16000 || (arg.timeoutMs !== undefined && (!Number.isSafeInteger(arg.timeoutMs) || arg.timeoutMs < 1000 || arg.timeoutMs > 120000))) throw new Error('终端命令或超时参数无效。');
      const run = makeRun('terminal'); activeRun = run;
      terminal = new TerminalSession({ workspaceFactory: ({ onEvent }) => new WorkspaceTools(tools.root, { approve, onEvent }), redact, onEvent: emit });
      setTimeout(async () => {
        try { await terminal.run({ id: run.id, command: arg.command, timeoutMs: arg.timeoutMs, signal: run.controller.signal }); }
        catch (error) { emit({ type: 'terminal-end', id: run.id, status: run.controller.signal.aborted ? 'stopped' : 'failed', result: redact(error.message || '终端执行失败。') }); }
        finally {
          if (activeRun === run) activeRun = null;
          run.finish();
          await broadcastAllStates();
        }
      }, 40);
      return { id: run.id };
    },
    stopTerminal: () => { if (activeRun?.kind === 'terminal') { activeRun.controller.abort(); terminal?.stop(); } return null; },
  };
}
async function shutdown() {
  ++stopGeneration;
  shuttingDown = true;
  pauseQueue('窗口正在关闭。');
  const run = activeRun;
  run?.controller.abort(); terminal?.stop();
  for (const done of [...approvals.values()]) done(false);
  if (run?.done) await run.done;
  if (fileOperationDone) await fileOperationDone;
}
function initializeBrowser() {
  browser = new BrowserPanel({ window: win, externalLifecycle: true, isForeground: () => host.active === context,
    getWorkspaceRoot: () => tools?.root || null,
    onState: value => emit({ type: 'browser-state', browser: value }), approve,
    captureDir: path.join(dataDir, 'browser-captures'),
    onCapture: capture => emit({ type: 'browser-capture', capture }) });
}
const context = {
  id: workspaceId,
  get win() { return win; }, get tools() { return tools; }, get currentSession() { return currentSession; },
  summary() {
    const settings = publicSettings();
    return { workspaceId, root: tools?.root || null, name: tools ? path.basename(tools.root) : '',
      sessionId: currentSession?.id || null, running: Boolean(activeRun), kind: activeRun?.kind || null,
      model: settings.model, provider: settings.provider, pendingCount: pendingPrompts.length,
      approvalCount: approvals.size, active: host.active === context };
  },
  requireSwitchReady() {
    if (shuttingDown || quitting || win?.isDestroyed()) throw new Error('窗口正在关闭，请在新窗口继续操作。');
    requireEditorSettled();
    if (localOperation || promptPreflights || fileOperationDone) throw new Error('正在保存文件或准备消息，请稍后切换项目。');
  },
  publicCurrentSession: () => publicSession(currentSession),
  activateProjectLocal,
  refreshBrowserVisibility: () => browser?.applyLayout(),
  clearFind: () => { lastFindText = null; },
  cancelEditorClose() { editorCloseRequest?.resolve(true); editorCloseRequest = null; },
  dispose: () => browser?.destroy(),
  abort() { ++stopGeneration; activeRun?.controller.abort(); terminal?.stop(); for (const done of [...approvals.values()]) done(false); },
  get activeRun() { return activeRun; }, get busy() { return Boolean(activeRun || localOperation || promptPreflights || fileOperationDone); },
  get hasPendingPrompts() { return pendingPrompts.length > 0; },
  get editorDirty() { return editorDirty; },
  get hasFileOperation() { return !!fileOperationDone; },
  emit, approve, state, broadcastState, setWorkspace, createSession, shutdown, requestEditorClose, scheduleNextPrompt,
  handlers: buildHandlers(),
  async initialize() {
    await createSession();
    if (host.win) { win = host.win; initializeBrowser(); return context; }
    win = new BrowserWindow({ width: 1340, height: 900, minWidth: 980, minHeight: 680, show: false, title: 'Synora code', backgroundColor: '#101010', autoHideMenuBar: true,
      ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0b0b', symbolColor: '#d6dde3', height: 44 } } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, backgroundThrottling: false, offscreen: smoke } });
    host.win = win; initializeBrowser();
    const contentsId = win.webContents.id;
    windows.set(contentsId, host);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (smoke) win.webContents.on('console-message', (_event, ...args) => {
      const details = args[0], level = typeof details === 'object' ? details.level : details;
      const message = typeof details === 'object' ? details.message : args[1];
      if (level === 'error' || Number(level) >= 2) rendererErrors.push(String(message));
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('did-start-loading', () => { for (const value of host.contexts) value.clearFind(); });
    win.webContents.on('found-in-page', (_event, result) => host.active.emit({ type: 'find-result', requestId: result.requestId, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: result.finalUpdate }));
    for (const event of ['enter-full-screen', 'leave-full-screen']) win.on(event, () => { host.active.emit({ type: 'window-state', isFullscreen: win.isFullScreen() }); host.broadcastState().catch(() => {}); });
    win.on('close', event => {
      if (closeAllowed || quitting === true) return;
      if (!host.activeRun && !host.editorDirty && !host.hasFileOperation) { host.abortAll(); shuttingDown = true; return; }
      event.preventDefault();
      if (closing) return;
      closing = true;
      host.requestEditorClose('window').then(async allowed => {
        if (!allowed) { closing = false; return; }
        await host.shutdown(); closeAllowed = true;
        if (!win.isDestroyed()) win.close();
      }).catch(error => { closing = false; emit({ type: 'storage-error', error: error.message || '关闭窗口失败，请先保存文件。' }); });
    });
    win.on('resize', () => { for (const value of host.contexts) value.refreshBrowserVisibility(); });
    win.on('closed', () => { host.abortAll(); for (const value of host.contexts) { value.cancelEditorClose(); value.dispose(); } windows.delete(contentsId); });
    win.webContents.on('render-process-gone', () => { host.abortAll(); });
    const refresh = setInterval(() => { if (!win.isDestroyed()) host.broadcastState().catch(() => {}); }, 60000);
    refresh.unref();
    win.on('focus', () => host.broadcastState().catch(() => {}));
    win.on('closed', () => clearInterval(refresh));
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    if (!smoke) win.show();
    return context;
  },
};
return context;
}
async function createAppWindow() { const host = createWindowHost(); return host.initialize(); }
function registerHandlers() {
  for (const name of Object.keys(primaryContext.handlers)) ipcMain.handle(`forge:${name}`, (event, arg) => {
    const context = windows.get(event.sender.id);
    if (!context || event.sender !== context.win.webContents || event.senderFrame !== context.win.webContents.mainFrame) throw new Error('IPC 调用来源无效。');
    return context.handlers[name](arg);
  });
}

async function boot() {
  if (legacyMigrationError) throw legacyMigrationError;
  // Chromium's transport follows Windows system proxy settings. Renderer pages
  // have no network access; only these main-process model requests use it.
  globalThis.fetch = net.fetch.bind(net);
  ({ WorkspaceTools, TOOL_DEFINITIONS } = await import('./core/workspace.mjs'));
  ({ runAgent, runDemo } = await import('./core/agent.mjs'));
  ({ requestModel } = await import('./core/providers.mjs'));
  ({ TerminalSession } = await import('./core/terminal.mjs'));
  ({ ManualFileManager } = await import('./core/file-manager.mjs'));
  ({ normalizeImageAttachments } = await import('./core/message-images.mjs'));
  const { ModelCatalog, deriveModelCapabilities: deriveCapabilities } = await import('./core/model-catalog.mjs');
  modelCatalog = new ModelCatalog(); deriveModelCapabilities = deriveCapabilities;
  const { SettingsCatalogSelections } = await import('./core/settings-model-catalog.mjs');
  settingsCatalogSelections = new SettingsCatalogSelections();
  if (legacyMigrationSource) await migrateLegacyData(dataDir, legacyMigrationSource, { encryptionPrepared: true });
  store = new Store(dataDir, safeStorage);
  await store.init();
  recentProjects = new RecentProjects(dataDir);
  await recentProjects.init();
  if (recentProjects.writable && !recentProjects.list().length) {
    for (const session of (await store.listSessions()).reverse()) {
      try { await recentProjects.record(session.workspace); } catch { /* A damaged entry does not block other project history. */ }
    }
  }
  uiPreferences = new UIPreferences(dataDir);
  await uiPreferences.init();
  appearance = new AppearanceStore({ dataDir, decodeImage: bytes => {
    const image = nativeImage.createFromBuffer(bytes);
    return image.isEmpty() ? null : image.getSize();
  } });
  await appearance.init();
  const { ChatGPTConnection } = await import('./core/chatgpt.mjs');
  chatgpt = new ChatGPTConnection({ dataDir, safeStorage, openExternal: url => shell.openExternal(url), onChange: () => { broadcastAllStates().catch(() => {}); } });
  await chatgpt.init();
  Menu.setApplicationMenu(null);
  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  primaryContext = createWindowHost();
  registerHandlers();
  await primaryContext.initialize();
  win = primaryContext.win;
  ({ setWorkspace, createSession, broadcastState } = primaryContext);
  if (smoke) await smokeTest();
}

async function smokeTest() {
  const output = process.env.FORGEDESK_ARTIFACT_DIR || path.join(projectDir, 'artifacts');
  await fs.mkdir(output, { recursive: true });
  if (process.env.FORGEDESK_SMOKE_ONLY === 'appearance') {
    const result = { version: app.getVersion(), appearance: await require('./core/smoke-appearance.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_APPEARANCE_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  if (process.env.FORGEDESK_SMOKE_SESSION_METRICS_ONLY || process.env.FORGEDESK_SMOKE_ONLY === 'session-metrics') {
    const result = { version: app.getVersion(), sessionMetrics: await require('./core/smoke-session-metrics.cjs')({ win, output }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FORGEDESK_SESSION_METRICS_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'api-protocol') {
    const result = { version: app.getVersion(), apiProtocol: await require('./core/smoke-api-protocol.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FORGEDESK_API_PROTOCOL_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'live-files') {
    const result = { version: app.getVersion(), liveFiles: await require('./core/smoke-live-files.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FORGEDESK_LIVE_FILES_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'reasoning-capabilities') {
    const result = { version: app.getVersion(), reasoningCapabilities: await require('./core/smoke-reasoning-capabilities.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FORGEDESK_REASONING_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'chatgpt') {
    const result = { version: app.getVersion(), chatgpt: await require('./core/smoke-chatgpt.cjs')({ win, store, getConnection: () => chatgpt, setConnection: value => { chatgpt = value; }, broadcastState, requestModel, fetchImpl: globalThis.fetch, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FORGEDESK_CHATGPT_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'parallel-projects') {
    const result = { version: app.getVersion(), parallelProjects: await require('./core/smoke-parallel-projects.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FORGEDESK_PARALLEL_SMOKE_OK ' + JSON.stringify(result));
    app.quit();
    return;
  }
  await win.webContents.executeJavaScript(`window.forge.setTextScale({scale:100})`);
  await win.webContents.executeJavaScript(`window.forge.setReasoningEffort({reasoningEffort:'default'})`);
  win.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.writeFile(path.join(output, 'welcome.png'), (await win.webContents.capturePage()).toPNG());
  const projectChrome = await win.webContents.executeJavaScript(`({gradient:getComputedStyle(document.querySelector('.topbar')).backgroundImage,projectSelector:!!document.getElementById('project-switcher'),legacyTabs:!!document.querySelector('#files-tab,#sessions-tab,#new-session')})`);
  if (!projectChrome.gradient.includes('linear-gradient') || !projectChrome.projectSelector || projectChrome.legacyTabs) throw new Error('Project explorer chrome is incomplete: ' + JSON.stringify(projectChrome));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const state = await window.forge.getState();
    if (!state.version || !document.querySelector('textarea')) throw new Error('UI not ready');
    if(getComputedStyle(document.getElementById('preview-panel')).display!=='none') throw new Error('File preview must be closed by default');
    updateState({...state,usageStats:{...state.usageStats,error:'smoke simulated unreadable ledger'}});
    if(!['usage-day','usage-week','usage-month'].every(id=>document.getElementById(id).textContent==='—')) throw new Error('Unavailable usage incorrectly displays zero');
    updateState(state);
    const events = [];
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Demo timed out')); }, 15000);
      const off = window.forge.onEvent(e => {
        events.push(e.type);
        if (e.type === 'approval-request') queueMicrotask(() => document.querySelector('.approval-card:last-of-type .approval-accept')?.click());
        if (e.type === 'run-end') { clearTimeout(timer); off(); resolve(e); }
      });
    });
    await window.forge.runTask({demo:true});
    const end = await finished;
    if (end.status !== 'completed' || !events.includes('text-delta') || !events.includes('approval-request')) throw new Error('Demo failed');
    return {version:state.version,events,status:end.status,bodyText:document.body.innerText.slice(0,1800)};
  })()`);
  // Exercise the complete real provider -> agent -> workspace -> approval path
  // against a local mock endpoint. Never use a real API key in smoke tests.
  const http = require('node:http');
  const fixture = path.join(dataDir, 'project');
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'hello.js'), 'const answer = 41;\n');
  const calls = [
    { id: 'smoke-read', name: 'read_file', arguments: { path: 'hello.js' } },
    { id: 'smoke-write', name: 'replace_in_file', arguments: { path: 'hello.js', old_text: '41', new_text: '42' } },
    { id: 'smoke-command', name: 'run_command', arguments: { command: 'node --check hello.js', timeout_ms: 10000 } }
  ];
  let round = 0;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'smoke-model', object: 'model', reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], supportsTools: true }] }));
        return;
      }
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (request.url !== '/v1/responses' || input.model !== 'smoke-model' || input.reasoning?.effort !== 'low') throw new Error('Unexpected mock request or reasoning level');
      if (round > 0 && !input.input.some(item => item.type === 'function_call_output' && item.call_id === calls[round - 1].id)) throw new Error('Missing tool result');
      if (round === 3) {
        const commandResult = input.input.find(item => item.type === 'function_call_output' && item.call_id === 'smoke-command');
        if (JSON.parse(commandResult.output).exitCode !== 0) throw new Error('Command syntax check failed');
      }
      const call = calls[round++];
      const modelOutput = call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '本机集成测试完成：文件已修改，语法检查通过。' }] }];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!call) {
        const deltas = ['本机集成测试完成：', '文件已修改，', '语法检查通过。'];
        for (let index = 0; index < deltas.length; index++) {
          const delta = deltas[index];
          response.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta }) + '\n\n');
          await new Promise(resolve => setTimeout(resolve, 180));
          if (index === 1) {
            const speed = await win.webContents.executeJavaScript(`document.getElementById('generation-speed').textContent`);
            if (!speed.includes('≈')) throw new Error('Live speed missing estimate label');
            win.webContents.invalidate();
            await new Promise(resolve => setTimeout(resolve, 80));
            await fs.writeFile(path.join(output, 'live.png'), (await win.webContents.capturePage()).toPNG());
          }
        }
      }
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: modelOutput, usage: { input_tokens: 8, output_tokens: 4 } } }) + '\n\n');
    } catch (error) {
      console.error('Local mock failed:', error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    setWorkspace(fixture); await createSession(); await broadcastState();
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await win.webContents.executeJavaScript(`(async()=>{
      await window.forge.saveSettings({provider:'openai',authMode:'apiKey',model:'smoke-model',baseUrl:${JSON.stringify(baseUrl)},apiKey:'forgedesk-smoke-key',maxSteps:6});
      await window.forge.listModels();
      await window.aiCodeCommands.execute('settings');
      if(document.getElementById('settings-reasoning-effort')||document.getElementById('model-input')) throw new Error('Settings must select a catalog model without manual ID or reasoning controls');
      if(!document.getElementById('save-settings').disabled) throw new Error('Settings without a fetched catalog must not save');
      document.getElementById('close-settings').click();
      updateState(await window.forge.setReasoningEffort({reasoningEffort:'medium'}));
      const slider=document.getElementById('reasoning-effort');
      if(slider?.type!=='range') throw new Error('Reasoning must use a draggable slider');
      slider.value=slider.max;
      slider.dispatchEvent(new Event('input',{bubbles:true}));
      slider.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,150));
      if((await window.forge.getState()).settings.reasoningEffort!=='max') throw new Error('Maximum reasoning was not saved');
    })()`);
    win.webContents.invalidate();
    await new Promise(resolve=>setTimeout(resolve,100));
    await fs.writeFile(path.join(output,'maximum-reasoning.png'),(await win.webContents.capturePage()).toPNG());
    const integration = await win.webContents.executeJavaScript(`(async () => {
      const effort=document.getElementById('reasoning-effort');
      if(!effort) throw new Error('Missing reasoning selector');
      effort.value='2';effort.dispatchEvent(new Event('input',{bubbles:true}));effort.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,120));
      const configured=await window.forge.getState();
      if(configured.settings.reasoningEffort!=='low') throw new Error('Reasoning setting not persisted');
      const initialTokens=configured.usageStats.day.totalTokens;
      const events = [];
      let estimatedLiveRate=false, finalExactRate=false;
      const waitRun = () => new Promise((resolve,reject) => {
        const timer = setTimeout(() => {off();reject(new Error('Integration timed out'));},30000);
        const off = window.forge.onEvent(e => {
          events.push(e.type);
          if(e.type==='approval-request') queueMicrotask(() => document.querySelector('.approval-card:last-of-type .approval-accept')?.click());
          if(e.type==='telemetry' && e.estimated && e.tokensPerSecond>0) estimatedLiveRate=true;
          if(e.type==='telemetry' && !e.estimated && e.phase==='completed' && e.tokensPerSecond>0) finalExactRate=true;
          if(e.type==='run-end'){clearTimeout(timer);off();resolve(e);}
        });
      });
      const finished = waitRun();
      await window.forge.runTask({text:'读取 hello.js，将答案改成42并检查语法。'});
      const end = await finished;
      if(end.status!=='completed') throw new Error(end.error||'Integration task failed');
      const counted=await window.forge.getState();
      if(counted.usageStats.day.totalTokens-initialTokens!==48) throw new Error('Token ledger double counted or lost requests');
      if(document.getElementById('usage-day').textContent==='—') throw new Error('Token stats did not render');
      if(!document.getElementById('generation-speed').textContent.includes('tok/s')) throw new Error('Token speed did not render');
      if(!estimatedLiveRate||!finalExactRate) throw new Error('Live/final token rate was not emitted');
      const file = await window.forge.readFile({path:'hello.js'});
      if(!file.content.includes('42')) throw new Error('Write did not happen');
      const undoFinished=waitRun();
      const undo=await window.forge.undoLastChange();
      await undoFinished;
      const restored=await window.forge.readFile({path:'hello.js'});
      if(!restored.content.includes('41')) throw new Error('Undo failed');
      const settings=(await window.forge.getState()).settings;
      if(JSON.stringify(settings).includes('forgedesk-smoke-key')||!settings.hasKey) throw new Error('Key exposure or persistence failure');
      return {status:end.status,undo:undo.result,events,estimatedLiveRate,finalExactRate,tokensRecorded:counted.usageStats.day.totalTokens-initialTokens};
    })()`);
    result.integration = integration;
    result.modelRounds = round;
    if (round !== 4) throw new Error('Expected four complete mock model rounds');
    await store.saveSettings({ provider: 'deepseek', model: '', clearKey: true });
    await store.saveSettings({ provider: 'openai', authMode: 'apiKey', model: '', baseUrl: 'https://api.openai.com/v1', clearKey: true });
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  await new Promise(resolve => setTimeout(resolve, 600));
  result.ui = await win.webContents.executeJavaScript(`({
    status:document.getElementById('run-status').textContent,
    welcomeDisplay:getComputedStyle(document.getElementById('welcome')).display,
    messages:document.getElementById('messages').innerText,
    project:document.getElementById('project-name').textContent
  })`);
  if (result.ui.welcomeDisplay !== 'none' || !result.ui.messages.includes('本机集成测试完成') || result.ui.status !== '已完成') throw new Error('Renderer did not reflect finished task: ' + JSON.stringify(result.ui));
  if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
  win.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.writeFile(path.join(output, 'desktop.png'), (await win.webContents.capturePage()).toPNG());
  result.chatgpt = await require('./core/smoke-chatgpt.cjs')({ win, store, getConnection: () => chatgpt, setConnection: value => { chatgpt = value; }, broadcastState, requestModel, fetchImpl: globalThis.fetch, output });
  result.controls = await require('./core/smoke-controls.cjs')({ win, store, output, broadcastState });
  result.personalization = await require('./core/smoke-personalization.cjs')({ win, output, dataDir });
  result.menus = await require('./core/smoke-menus.cjs')({ win, output, dataDir });
  result.promptQueue = await require('./core/smoke-queue.cjs')({ win, output, dataDir, readState: () => primaryContext.state() });
  result.largeResponse = await require('./core/smoke-large-response.cjs')({ win, output, dataDir });
  result.explorer = await require('./core/smoke-explorer.cjs')({ win, output, dataDir });
  result.activity = await require('./core/smoke-activity.cjs')({ win, output, dataDir });
  result.windowChrome = await require('./core/smoke-window-chrome.cjs')({ win, output, dataDir });
  result.userMessages = await require('./core/smoke-user-messages.cjs')({ win, output, dataDir });
  result.markdown = await require('./core/smoke-markdown.cjs')({ win, output });
  result.browser = await require('./core/smoke-browser.cjs')({ win, output, dataDir });
  result.permissions = await require('./core/smoke-permissions.cjs')({ win, output, dataDir });
  result.scroll = await require('./core/smoke-scroll.cjs')({ win, output, dataDir });
  result.projectSessions = await require('./core/smoke-sessions.cjs')({ win, output, dataDir });
  result.compaction = await require('./core/smoke-compaction.cjs')({ win, output, dataDir });
  result.apiProtocol = await require('./core/smoke-api-protocol.cjs')({ win, output, dataDir });
  result.parallelProjects = await require('./core/smoke-parallel-projects.cjs')({ win, output, dataDir });
  result.reasoningCapabilities = await require('./core/smoke-reasoning-capabilities.cjs')({ win, output, dataDir });
  result.liveFiles = await require('./core/smoke-live-files.cjs')({ win, output, dataDir });
  result.sessionMetrics = await require('./core/smoke-session-metrics.cjs')({ win, output });
  result.appearance = await require('./core/smoke-appearance.cjs')({ win, output, dataDir });
  if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
  await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
  console.log('FORGEDESK_SMOKE_OK ' + JSON.stringify({ version: result.version, status: result.status, modelRounds: result.modelRounds, integration: result.integration.status, events: [...new Set(result.events)] }));
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // This must run synchronously before the main module yields to Electron.
  // By `ready`, Chromium has already loaded the encryption key for this profile.
  try { preparePortableMigration(); } catch (error) { legacyMigrationError = error; }
  app.on('second-instance', () => {
    const target = [...windows.values()].map(context => context.win).find(window => !window.isDestroyed());
    if (target) { if (target.isMinimized()) target.restore(); target.show(); target.focus(); }
  });
  app.whenReady().then(boot).catch(error => {
    console.error('Synora code startup failed:', error.message);
    if (smoke && rendererErrors.length) console.error('SMOKE_RENDERER_ERRORS', rendererErrors.join(' | '));
    if (!smoke) dialog.showErrorBox('Synora code 无法启动', error.message);
    app.exit(1);
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting === true) return;
  if (quitting === 'pending') { event.preventDefault(); return; }
  if (![...windows.values()].some(context => context.activeRun || context.editorDirty || context.hasFileOperation)) { chatgpt?.cancelSignIn(); return; }
  event.preventDefault(); quitting = 'pending';
  const contexts = [...windows.values()];
  Promise.all(contexts.map(context => context.requestEditorClose('quit'))).then(async allowed => {
    if (allowed.some(value => !value)) {
      quitting = false;
      for (const context of contexts) context.scheduleNextPrompt();
      return;
    }
    chatgpt?.cancelSignIn();
    await Promise.allSettled(contexts.map(context => context.shutdown()));
    quitting = true; app.quit();
  }).catch(() => { quitting = false; for (const context of contexts) context.scheduleNextPrompt(); });
});
