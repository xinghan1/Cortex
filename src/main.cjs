const { app, BrowserWindow, Tray, ipcMain, dialog, safeStorage, shell, clipboard, Menu, net, nativeImage, nativeTheme, screen, session: electronSession } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { AppUpdater } = require('./core/app-updater.cjs');
const { createUpdateFetch } = require('./core/update-transport.cjs');
const { Store } = require('./core/store.cjs');
const { RoleModels, ROLE_KEYS } = require('./core/role-models.cjs');
const { makePendingContextUsage } = require('./core/session-metrics.cjs');
const { createTurnUsage } = require('./core/turn-usage.cjs');
const { installEditorContextMenu } = require('./core/editor-context-menu.cjs');
const { loadUsageAnalytics } = require('./core/usage-analytics-loader.cjs');
const { migrateLegacyData, findLegacyData, prepareLegacyEncryptionState } = require('./core/migrate.cjs');
const { UIPreferences } = require('./core/ui-preferences.cjs');
const { ModelCapacityPreferences, modelCapacityConnectionKey, modelCapacityScope, applyModelCapacity } = require('./core/model-capacity-preferences.cjs');
const { PermissionPreferences } = require('./core/permission-preferences.cjs');
const { ApprovalReviewerPreferences, approvalReviewerConnectionKey } = require('./core/approval-reviewer-preferences.cjs');
const { AppearanceStore } = require('./core/appearance.cjs');
const { nativeAppearance } = require('./core/native-appearance.cjs');
const { RecentProjects } = require('./core/recent-projects.cjs');
const { approvalDecision, validateMode } = require('./core/approval-policy.cjs');
const { BrowserPanel, BROWSER_TOOL_DEFINITIONS } = require('./core/browser-panel.cjs');
const { isXmlURL } = require('./core/xml-reader.cjs');
const { resolveDataDirectory } = require('./core/data-path.cjs');
const { SessionRestore } = require('./core/session-restore.cjs');
const { PluginManager } = require('./core/plugin-manager.cjs');
const { createPluginExample } = require('./core/plugin-template.cjs');
const { createPluginRuntime } = require('./core/plugin-runtime.cjs');
const { DshPetStore } = require('./core/dsh-pet.cjs');
const { createBackgroundTray } = require('./core/background-tray.cjs');

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
  previousVersions.unshift('Synora-code-0.19.2-win32-x64', 'Synora-code-0.19.1-win32-x64', 'Synora-code-0.18.5-win32-x64', 'Synora-code-0.16.8-win32-x64');
  legacyMigrationSource = findLegacyData(dataDir, previousVersions.map(previous =>
    path.join(path.dirname(path.dirname(process.execPath)), previous, 'data')));
  if (legacyMigrationSource) prepareLegacyEncryptionState(dataDir, legacyMigrationSource);
}

let win, store, chatgpt, roleModels, roleRuntime, createSideChatController, createPetDialogController, PET_QUESTION_TOOL, WorkspaceTools, TOOL_DEFINITIONS, createSubagentWorkspace, runAgent, runDemo, requestModel, reviewApproval, selectApprovalIntent, createApprovalController, createPromptCompletionController, TerminalSession, ManualFileManager, EditorFileTargets, normalizeImageAttachments, persistentTaskUndo;
const roleAccounts = new Map();
let deepseek;
const roleDeepseekAccounts = new Map();
const isAccountMode = mode => mode === 'chatgpt' || mode === 'deepseek-account';
const accountLabel = mode => mode === 'deepseek-account' ? 'DeepSeek' : 'ChatGPT';
const accountController = mode => mode === 'deepseek-account' ? deepseek : chatgpt;
const accountBaseUrl = mode => mode === 'deepseek-account' ? 'https://api.deepseek.com/anthropic/v1' : 'https://api.openai.com/v1';
const roleAccountIdentities = new Map();
let modelCatalog, deriveModelCapabilities, settingsCatalogSelections, uiPreferences, modelCapacityPreferences, permissionPreferences, approvalReviewerPreferences, appearance, recentProjects, primaryContext;
let setWorkspace, createSession, broadcastState;
const catalogSnapshots = new Map();
const windows = new Map();
let sessionRestore, activeWindowHost = null;
const sessionRenameLocks = new Set();
const sessionDeleteLocks = new Set();
let sessionRenameRevision = 0;
const rendererErrors = [];
let sharedQueue = Promise.resolve(), sharedMutations = 0, quitting = false;
let appUpdater, updateEnabled = false, updateInstalling = false, updateInstallPromise = null;
let pluginManager, pluginRuntime, dshPet, pluginProjectAccess;
let updateTimer, updateInterval, petPointerTimer;
let backgroundTray = null;
let launchInstaller = launchUpdateInstaller;
let quitForUpdate = () => { quitting = true; app.quit(); };
function appUpdateSnapshot() {
  return { ...appUpdater?.snapshot(), currentVersion: app.getVersion(), enabled: updateEnabled,
    ...(updateInstalling ? { status: 'installing' } : {}) };
}
function publishAppUpdate() {
  const update = appUpdateSnapshot();
  for (const host of windows.values()) {
    if (host.win && !host.win.isDestroyed() && !host.win.webContents.isDestroyed())
      host.win.webContents.send('forge:event', { type: 'app-update', update });
  }
}
function launchUpdateInstaller(filename) {
  // The path comes only from verifiedInstaller(), never from renderer input.
  // These flags are supported by the bundled electron-builder NSIS template.
  return new Promise((resolve, reject) => {
    const child = spawn(filename, ['--updated', '/S', '--force-run'], {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    });
    child.once('error', () => reject(new Error('无法启动更新程序，请稍后重试。')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
function requireUpdateIdle() {
  if (!updateEnabled) throw new Error('此版本请从 GitHub Releases 下载新版；安装版支持应用内更新。');
  if (quitting || sharedMutations || sessionRenameLocks.size || sessionDeleteLocks.size
      || [...windows.values()].some(host => host.busy || host.hasPendingPrompts || host.editorDirty || host.hasFileOperation))
    throw new Error('请先结束所有窗口的任务、保存文件，并处理待发送消息，再重启更新。');
}
function installAppUpdate() {
  if (updateInstallPromise) return updateInstallPromise;
  requireUpdateIdle();
  if (appUpdater.snapshot().status !== 'downloaded') throw new Error('请先下载并校验更新包。');
  const lockedWindows = [...windows.values()].map(host => ({ win: host.win, enabled: host.win.isEnabled() }));
  for (const { win } of lockedWindows) win.setEnabled(false);
  updateInstalling = true; publishAppUpdate();
  updateInstallPromise = (async () => {
    try {
      const filename = await appUpdater.verifiedInstaller();
      requireUpdateIdle();
      const contexts = [...windows.values()].flatMap(host => [...host.contexts]);
      for (const context of contexts) { context.cancelPromptCompletion(); context.closePetDialog?.(); }
      await Promise.all([...contexts.map(context => context.settlePromptCompletion()), ...contexts.map(context => context.settleSideChat()),
        ...contexts.map(context => context.settlePetDialog?.()),
        sessionRestore?.flush(), persistentTaskUndo?.flush(), permissionPreferences?.settled(),
        approvalReviewerPreferences?.settled(), modelCapacityPreferences?.settled(), roleModels?.settled(), pluginManager?.settled(), dshPet?.settled(), sharedQueue]);
      requireUpdateIdle();
      await launchInstaller(filename);
      cancelAccountSignIns();
      quitForUpdate();
      return appUpdateSnapshot();
    } finally {
      for (const { win, enabled } of lockedWindows) if (!win.isDestroyed()) win.setEnabled(enabled);
      updateInstalling = false; updateInstallPromise = null; publishAppUpdate();
    }
  })();
  return updateInstallPromise;
}
function startUpdateChecks() {
  if (!updateEnabled || smoke) return;
  const check = () => { if (!quitting && !updateInstalling) void appUpdater.check().catch(() => {}); };
  updateTimer = setTimeout(check, 5000); updateTimer.unref();
  updateInterval = setInterval(check, 4 * 60 * 60 * 1000); updateInterval.unref();
}
function extensionsSnapshot() { return { plugins: pluginManager?.list() || [], pluginError: pluginManager?.storageError || null }; }
function publishExtensions() {
  const extensions = extensionsSnapshot();
  for (const host of windows.values()) if (!host.win.isDestroyed()) host.win.webContents.send('forge:event', { type: 'extensions', extensions });
}
function publishPet() {
  const pet = dshPet.snapshot();
  for (const host of windows.values()) if (!host.win.isDestroyed()) host.win.webContents.send('forge:event', { type: 'pet-state', pet });
  return pet;
}
function startPetPointerTracking() {
  const previous = new WeakMap();
  petPointerTimer = setInterval(() => {
    if (quitting) return;
    if (!dshPet.cursorTrackingEnabled()) return;
    for (const { win: target } of windows.values()) {
      if (target.isDestroyed() || !target.isVisible() || target.isMinimized() || target.webContents.isDestroyed()) continue;
      const cursor = screen.getCursorScreenPoint(), bounds = target.getContentBounds(), zoom = target.webContents.getZoomFactor();
      const dipX = cursor.x - bounds.x, dipY = cursor.y - bounds.y;
      const x = dipX / zoom, y = dipY / zoom, last = previous.get(target);
      const sentAt = Date.now();
      if (last?.x === x && last?.y === y && sentAt - last.sentAt < 250) continue;
      previous.set(target, { x, y, sentAt });
      target.webContents.send('forge:event', { type: 'pet-pointer', x, y,
        inside: dipX >= 0 && dipY >= 0 && dipX < bounds.width && dipY < bounds.height });
    }
  }, 50);
  petPointerTimer.unref();
}
function pluginOwnerContext({ ownerWindow }) {
  const host = ownerWindow && !ownerWindow.isDestroyed() && windows.get(ownerWindow.webContents.id);
  if (!host || host.win !== ownerWindow || quitting || updateInstalling) throw new Error('软件正在切换或关闭，请稍后重新打开插件。');
  return host.active;
}
function pluginProjectInfo(request) {
  const context = pluginOwnerContext(request), root = context.tools?.root || null;
  return { root, name: root ? path.basename(root) : '', workspaceId: context.id, sessionId: context.currentSession?.id || null };
}
function pluginDeveloperFiles() {
  return app.isPackaged ? { guide: path.join(path.dirname(process.execPath), '开发者插件', 'PLUGIN_DEVELOPMENT.md'),
    example: path.join(path.dirname(process.execPath), '开发者插件', 'examples', 'hello-plugin') }
    : { guide: path.join(projectDir, 'docs', 'PLUGIN_DEVELOPMENT.md'), example: path.join(projectDir, 'examples', 'hello-plugin') };
}
function redact(value) {
  let clean = store.redact(value);
  if (chatgpt) clean = chatgpt.redact(clean);
  if (deepseek) clean = deepseek.redact(clean);
  if (roleModels) clean = roleModels.redact(clean);
  for (const account of roleAccounts.values()) clean = account.redact(clean);
  for (const account of roleDeepseekAccounts.values()) clean = account.redact(clean);
  return clean;
}
function requireGlobalIdle() {
  if ([...windows.values()].some(context => context.busy || context.hasPendingPrompts)) throw new Error('请先停止所有窗口的任务，并发送或移除待发送消息，再更改共享配置。');
}
function requireSharedReady() { if (sharedMutations) throw new Error('共享配置或账号正在更新，请稍后启动任务。'); }
function roleAccount(role, provider = 'openai') {
  const accounts = provider === 'deepseek' ? roleDeepseekAccounts : roleAccounts;
  if (!ROLE_KEYS.includes(role) || !accounts.has(role)) throw new Error('模型用途无效。');
  return accounts.get(role);
}
function cancelAccountSignIns() {
  chatgpt?.cancelSignIn();
  deepseek?.cancelSignIn();
  for (const account of roleAccounts.values()) account.cancelSignIn();
  for (const account of roleDeepseekAccounts.values()) account.cancelSignIn();
}
async function publishRoleAccount(role, provider = 'openai') {
  const state = await roleAccount(role, provider).publicState();
  const identityKey = provider === 'deepseek' ? `deepseek:${role}` : role;
  const identity = JSON.stringify([state.session.status, state.session.profileId, state.session.sharing]);
  const previous = roleAccountIdentities.get(identityKey);
  roleAccountIdentities.set(identityKey, identity);
  if (previous !== undefined && previous !== identity) roleRuntime?.invalidate(role);
  await broadcastAllStates();
}
function mutateShared(operation) {
  requireGlobalIdle();
  sharedMutations++;
  const pending = sharedQueue.then(async () => {
    requireGlobalIdle();
    const contexts = [...windows.values()].flatMap(host => [...host.contexts]);
    for (const context of contexts) { context.cancelPromptCompletion(); context.closePetDialog?.(); }
    await Promise.allSettled(contexts.map(context => context.settlePromptCompletion()));
    requireGlobalIdle(); return operation();
  });
  sharedQueue = pending.catch(() => {});
  return pending.finally(() => { sharedMutations--; });
}
async function broadcastAllStates() { await Promise.allSettled([...windows.values()].map(context => context.broadcastState())); }
async function readSessionForContext(id) {
  for (;;) {
    const revision = sessionRenameRevision;
    if (sessionRenameLocks.has(id) || sessionDeleteLocks.has(id)) throw new Error('此会话正在更新，请稍后重试。');
    const loaded = await store.getSession(id);
    if (sessionRenameLocks.has(id) || sessionDeleteLocks.has(id)) throw new Error('此会话正在更新，请稍后重试。');
    // A read begun before the atomic title update may complete afterwards.
    if (revision === sessionRenameRevision) return loaded;
  }
}
function broadcastAppearance(value) {
  // Background bytes are local UI state. Keep them out of periodic application
  // state, project sessions, model inputs and telemetry.
  const palette = nativeAppearance(value);
  nativeTheme.themeSource = palette.theme;
  for (const host of windows.values()) {
    if (!host.win || host.win.isDestroyed() || host.win.webContents.isDestroyed()) continue;
    host.win.setBackgroundColor(palette.background);
    if (process.platform === 'win32') host.win.setTitleBarOverlay({ color: palette.caption, symbolColor: palette.symbol, height: 44 });
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
function createWindowHost({ restoreTarget = null } = {}) {
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
    async rememberSelection(context) {
      if (!sessionRestore || host.active !== context) return false;
      try { return await sessionRestore.record(context.currentSession, { active: activeWindowHost === host }); }
      catch (error) { context.emit({ type: 'storage-error', error: error.message }); return false; }
    },
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
        previous.cancelPromptCompletion();
        host.active = target;
        await target.rememberSelection();
        previous.refreshBrowserVisibility(); target.refreshBrowserVisibility();
        const nextState = await target.state();
        target.emit({ type: 'workspace-activated', state: nextState, session: target.publicCurrentSession() });
        await broadcastAllStates();
        return nextState;
      });
      switching = operation.catch(() => {});
      return operation;
    },
    async initialize() { await host.active.initialize({ restoreTarget }); return host; },
  };
  async function rememberOpenProject(root) {
    try { await recentProjects.record(root); }
    catch (error) { host.active.emit({ type: 'storage-error', error: error.message || '最近项目保存失败。' }); }
  }
  host.active = createWindowContext(host); host.contexts.add(host.active);
  return host;
}

function createWindowContext(host) {
let win, tools, currentSession, activeRun, terminal, fileManager, editorFiles;
const workspaceId = randomUUID();
let modelSelection = null, configRevision = 0, approvalReviewerModel = null;
let approvalReviewerScope = null, approvalReviewerConnectionCache = null;
let metricsConnectionKey = null, metricsModelCapacity = null;
const settingsCatalogPreviews = new Map();
const terminalEvents = [];
let permissionMode = permissionPreferences.get(null), browser;
let eventSequence = 0, localOperation = false, promptPreflights = 0, closeAllowed = false, closing = false, loadedSnapshot = false;
let initialized = false, lastRememberedSessionId = null, lastPetGreetingAt = 0;
let lastFindText = null;
let fileClipboard = null, editorDirty = false, editorCloseRequest = null, fileOperationDone = null;
let manualOperations = Promise.resolve();
const pendingPrompts = [];
let queuePaused = false, queueReason = null, promptOperations = Promise.resolve(), shuttingDown = false, stopGeneration = 0;
const approvals = new Map();
const approvalController = createApprovalController({ pending: approvals, getMode: () => permissionMode,
  decide: approvalDecision, review: reviewOperation, emit, redact, idFactory: randomUUID });
const promptCompletion = createPromptCompletionController({
  getSnapshot() {
    requireSharedReady();
    if (shuttingDown || quitting || win?.isDestroyed() || host.active !== context || localOperation || promptPreflights)
      throw new Error('会话正在切换或关闭，请稍后补全提示词。');
    return { sessionId: currentSession?.id, workspaceId, messages: currentSession?.messages,
      chatgptProfileId: currentSession?.chatgptProfileId || null, deepseekProfileId: currentSession?.deepseekProfileId || null, configRevision };
  },
  isCurrent: snapshot => !shuttingDown && !quitting && !win?.isDestroyed() && host.active === context
    && currentSession?.id === snapshot.sessionId && configRevision === snapshot.configRevision
    && (currentSession?.chatgptProfileId || null) === snapshot.chatgptProfileId
    && (currentSession?.deepseekProfileId || null) === snapshot.deepseekProfileId,
  async getConfig(snapshot, signal) {
    signal.throwIfAborted();
    if (roleModels.isEnabled('completion')) return roleRequestConfig('completion', { controller: { signal } });
    const connection = await catalogContext();
    signal.throwIfAborted();
    const profileId = connection.authMode === 'chatgpt' ? connection.account?.session?.profileId || null : null;
    const deepseekProfileId = connection.authMode === 'deepseek-account' ? connection.account?.session?.profileId || null : null;
    if (snapshot.hasConversation && ((snapshot.chatgptProfileId || null) !== profileId || (snapshot.deepseekProfileId || null) !== deepseekProfileId))
      throw new Error('会话模型账号已变化，请新建会话后再补全提示词。');
    const config = await currentRequestConfig({ controller: { signal }, connectionKey: connection.key,
      chatgptProfileId: snapshot.hasConversation ? snapshot.chatgptProfileId : null,
      deepseekProfileId: snapshot.hasConversation ? snapshot.deepseekProfileId : null }, publicSettings().model);
    return { ...config, chatgptProfileId: config.authMode === 'chatgpt' ? profileId : null,
      deepseekProfileId: config.authMode === 'deepseek-account' ? deepseekProfileId : null };
  },
  async validateConfig(config, snapshot, signal) {
    signal.throwIfAborted();
    if (config.modelRole === 'completion') {
      const current = await roleRequestConfig('completion', { controller: { signal } });
      if (current.connectionKey !== config.connectionKey || current.modelRole !== 'completion')
        throw new DOMException('补全模型连接已变化。', 'AbortError');
      return;
    }
    if (roleModels.isEnabled('completion')) throw new DOMException('补全模型配置已变化。', 'AbortError');
    const connection = await catalogContext();
    signal.throwIfAborted();
    if (connection.key !== config.connectionKey || configRevision !== snapshot.configRevision
        || config.authMode === 'chatgpt' && (!connection.account?.session?.profileId
          || connection.account.session.profileId !== config.chatgptProfileId)
        || config.authMode === 'deepseek-account' && (!connection.account?.session?.profileId
          || connection.account.session.profileId !== config.deepseekProfileId))
      throw new DOMException('模型连接已变化，提示词补全已取消。', 'AbortError');
  },
  requestModel: dispatchModelRequest, onUsage: recordRunUsage, redact,
});
const sideChat = createSideChatController({
  getConfig: ({ signal }) => {
    requireSharedReady();
    if (shuttingDown || quitting) throw new DOMException('窗口正在关闭。', 'AbortError');
    return roleRequestConfig('sidebar', { controller: { signal } }, publicSettings().model);
  },
  requestModel: dispatchModelRequest, redact, onUsage: recordRunUsage,
  emit: event => {
    // Temporary questions never enter the main run's replay or session archive.
    if (win && !win.isDestroyed() && host.active === context)
      win.webContents.send('forge:event', { ...event, workspaceId });
  },
});
const petDialog = createPetDialogController({
  async getConfig({ signal }) {
    requireSharedReady(); signal.throwIfAborted();
    const sessionId = currentSession?.id, revision = configRevision;
    if (shuttingDown || quitting || !sessionId) throw new DOMException('会话正在关闭。', 'AbortError');
    const connection = await catalogContext(); signal.throwIfAborted();
    const chatgptProfileId = connection.authMode === 'chatgpt' ? connection.account?.session?.profileId || null : null;
    const deepseekProfileId = connection.authMode === 'deepseek-account' ? connection.account?.session?.profileId || null : null;
    if (!roleModels.isEnabled('sidebar') && currentSession.messages.length
        && ((currentSession.chatgptProfileId || null) !== chatgptProfileId || (currentSession.deepseekProfileId || null) !== deepseekProfileId))
      throw new Error('会话模型账号已变化，请新建会话后再与宠物聊天。');
    const config = await roleRequestConfig('sidebar', { controller: { signal }, connectionKey: connection.key,
      chatgptProfileId, deepseekProfileId }, publicSettings().model);
    signal.throwIfAborted();
    if (shuttingDown || quitting || sessionId !== currentSession?.id || revision !== configRevision)
      throw new DOMException('宠物聊天的会话或模型已变化。', 'AbortError');
    return { ...config, ...(config.modelRole ? {} : { chatgptProfileId, deepseekProfileId }),
      petSessionId: sessionId, petConfigRevision: revision };
  },
  isConfigCurrent: config => !shuttingDown && !quitting && config.petSessionId === currentSession?.id
    && config.petConfigRevision === configRevision && (config.modelRole
      ? roleModels.isEnabled(config.modelRole) && roleRuntime.revisions[config.modelRole] === config.roleConnectionRevision
      : !roleModels.isEnabled('sidebar')),
  requestModel: dispatchModelRequest, redact, onUsage: recordRunUsage,
  emit: event => {
    if (win && !win.isDestroyed() && host.active === context)
      win.webContents.send('forge:event', { ...event, workspaceId, sessionId: currentSession?.id || null });
    else host.publishWorkspaces();
  },
});
function publicPetDialog() { return { ...petDialog.snapshot(), workspaceId, sessionId: currentSession?.id || null }; }
function validatePetDialogScope(arg, fields) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)
      || Object.keys(arg).some(key => !['workspaceId', 'sessionId', ...fields].includes(key))
      || shuttingDown || quitting || arg.workspaceId !== workspaceId || arg.sessionId !== (currentSession?.id || null))
    throw new Error('会话已变化，请重新打开宠物对话。');
}
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
  promptCompletion.abort();
  petDialog.close();
  publicSettings();
  const value = settings.providers[settings.provider];
  modelSelection.provider = settings.provider;
  modelSelection.providers[settings.provider] = {
    model: value.model, reasoningEffort: value.reasoningEffort, authMode: value.authMode,
    ...(value.modelsByAuth ? { modelsByAuth: { ...value.modelsByAuth } } : {}),
  };
  ++configRevision;
  approvalController.reconcile();
}
async function saveProjectSettings(input) {
  if (localOperation || promptPreflights || fileOperationDone || shuttingDown || quitting) throw new Error('正在准备任务或处理文件，请稍后更改模型。');
  const selected = publicSettings();
  if (activeRun && (input?.provider !== selected.provider || (input.authMode !== undefined && input.authMode !== selected.authMode))) {
    throw new Error('运行中可切换当前连接的模型；更换服务商或登录方式需要先停止任务。');
  }
  const shared = store.publicSettings();
  const previous = shared.providers[input?.provider];
  // Selecting a configured provider/model is local. Changing a connection is
  // shared, so it keeps the existing all-project idle requirement.
  const connectionChange = !previous || input?.clearKey === true || Boolean(String(input?.apiKey || '').trim())
    || (input?.baseUrl !== undefined && String(input.baseUrl).trim() !== previous.baseUrl)
    || (input?.contextWindowTokens !== undefined && input.contextWindowTokens !== previous.contextWindowTokens)
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
  if (clean.type === 'reconnect' && clean.resetText) run.streamText = '';
  const previous = events.at(-1);
  if (clean.type === 'text-delta') {
    run.streamText = clean.replace ? String(clean.text || '') : String(run.streamText || '') + String(clean.text || '');
    const frame = { ...clean, text: run.streamText, replace: true };
    if (previous?.type === 'text-delta') events[events.length - 1] = frame;
    else events.push(frame);
  } else if (clean.type === 'subagent-update' || clean.type === 'approval-review') {
    const index = events.findIndex(event => event.type === clean.type && (clean.type === 'subagent-update' ? event.agent?.id === clean.agent?.id : event.id === clean.id));
    if (index === -1) events.push(clean);
    else events[index] = clean;
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
  if (event.type === 'reconnect' && event.status === 'waiting' && !Number.isFinite(event.retryAt)) {
    event = { ...event, retryAt: Date.now() + Math.max(0, Math.min(60_000, Number(event.delayMs) || 0)) };
  }
  if (activeRun && event.type === 'context-compaction-start') activeRun.compacting = true;
  if (activeRun && ['context-compacted', 'context-compaction-end'].includes(event.type)) activeRun.compacting = false;
  if (activeRun?.kind === 'agent' && event.type === 'telemetry') activeRun.telemetry = telemetrySnapshot(event);
  if (activeRun?.kind === 'agent' && !activeRun.demo && event.type === 'tool-start') {
    currentSession.toolSteps = (Number.isSafeInteger(currentSession.toolSteps) ? currentSession.toolSteps
      : currentSession.events.filter(item => item.type === 'tool-start').length) + 1;
    emitSessionMetrics();
  }
  const clean = JSON.parse(redact(JSON.stringify({ ...(activeRun ? { runId: activeRun.id } : {}), ...event, workspaceId, sequence: ++eventSequence })));
  if (activeRun?.kind === 'agent' && clean.type === 'images-viewed' && clean.version === 1 && currentSession) {
    clean.messageIndex = currentSession.messages.length - 1;
    const views = currentSession.imageViews = Array.isArray(currentSession.imageViews) ? currentSession.imageViews : [];
    if (!views.some(view => view.runId === clean.runId && view.requestId === clean.requestId)) views.push({ ...clean });
    // Keep lightweight references after the general event suffix rolls over.
    if (views.length > 256) views.splice(0, views.length - 256);
  }
  if (activeRun && clean.type === 'subagent-update' && clean.agent?.id && currentSession) {
    const agents = currentSession.subagents = Array.isArray(currentSession.subagents) ? currentSession.subagents : [];
    const index = agents.findIndex(agent => agent.id === clean.agent.id && agent.parentRunId === clean.runId);
    const snapshot = { ...clean.agent, parentRunId: clean.runId };
    if (index === -1) agents.push(snapshot);
    else agents[index] = snapshot;
    if (agents.length > 64) agents.splice(0, agents.length - 64);
  }
  // Local display metadata stays outside model messages and context budgets.
  if (activeRun && ['tool-result', 'file-change-recorded'].includes(clean.type) && clean.fileChange && currentSession) {
    const change = clean.fileChange;
    if (typeof change.path === 'string' && change.path && ['before', 'after'].every(key => change[key] === null || typeof change[key] === 'string')) {
      const edits = currentSession.fileEdits = Array.isArray(currentSession.fileEdits) ? currentSession.fileEdits.filter(item => item && typeof item.path === 'string'
        && ['before', 'after'].every(key => item[key] === null || typeof item[key] === 'string')) : [];
      const previous = edits.findIndex(item => clean.toolCallId && item.runId === clean.runId && item.toolCallId === clean.toolCallId);
      if (previous !== -1) edits.splice(previous, 1);
      edits.push({ runId: clean.runId, kind: activeRun.kind, toolCallId: clean.toolCallId, sequence: clean.sequence, path: change.path, before: change.before, after: change.after });
      let characters = edits.reduce((sum, item) => sum + (item.before?.length || 0) + (item.after?.length || 0), 0);
      while (edits.length > 64 || characters > 8 * 1024 * 1024) {
        const oldest = edits.shift();
        characters -= (oldest.before?.length || 0) + (oldest.after?.length || 0);
      }
    }
  }
  recordLiveEvent(activeRun, clean); rememberTerminalEvent(clean);
  if (host.active === context) win.webContents.send('forge:event', clean);
  else host.publishWorkspaces({ force: ['approval-request', 'approval-resolved', 'run-start', 'run-end', 'terminal-start', 'terminal-end', 'pending-prompts'].includes(clean.type) });
  if (activeRun && activeRun.kind !== 'terminal' && (event.type !== 'user-message' || event.source === 'steering') && !['text-delta', 'state', 'session', 'command-output', 'telemetry', 'find-result', 'window-state', 'pending-prompts', 'files-changed', 'editor-close-request', 'browser-state', 'browser-open', 'browser-capture', 'context-compaction-start', 'context-compaction-end', 'session-metrics'].includes(event.type) && !event.type.startsWith('terminal-')) {
    // Snapshots have their own bounded archive. Do not retain a second copy
    // in the 150-event suffix after the live event has been delivered.
    const { fileChange: localSnapshot, ...publicEvent } = clean;
    const historicalEvent = clean.type === 'user-message'
      ? { type: clean.type, id: clean.id, source: clean.source, runId: clean.runId, sequence: clean.sequence } : publicEvent;
    const previousAgent = ['subagent-update', 'approval-review'].includes(clean.type)
      ? currentSession.events.findIndex(event => event.type === clean.type && (clean.type === 'subagent-update' ? event.agent?.id === clean.agent?.id : event.id === clean.id)) : -1;
    if (previousAgent === -1) currentSession.events.push(historicalEvent);
    else currentSession.events[previousAgent] = historicalEvent;
    currentSession.events = currentSession.events.slice(-150);
  }
}
function emitSessionMetrics() {
  if (currentSession) emit({ type: 'session-metrics', sessionId: currentSession.id, metrics: sessionMetricsSnapshot(currentSession) });
}
function recordRunFileChange(run, change) {
  if (activeRun !== run || run.kind !== 'agent' || run.demo) return;
  run.fileChangeCount++;
  const report = () => { if (!run.undoPersistenceError) { run.undoPersistenceError = true; emit({ type: 'storage-error', error: '本轮撤销记录保存失败，自动撤销已停用；文件改动仍保留。' }); } };
  try { persistentTaskUndo.record({ runId: run.id, sessionId: run.sessionId, workspace: tools.root, change }).catch(report); }
  catch { report(); }
}
function rememberTaskRun(record) {
  // Timing and anchors must survive the bounded event suffix. Retain recent
  // tasks plus any parent still referenced by the bounded subagent archive.
  const fields = ['type', 'runId', 'kind', 'status', 'error', 'startedAt', 'endedAt', 'elapsedMs', 'messageStartIndex', 'messageIndex', 'telemetry', 'fileChangeCount', 'usage', 'demo'];
  const runs = new Map();
  for (const value of [...(currentSession.taskRuns || []), ...currentSession.events.filter(event => event.type === 'run-end')]) {
    if (!value || typeof value.runId !== 'string') continue;
    runs.set(value.runId, Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])));
  }
  runs.set(record.runId, record);
  const entries = [...runs.values()], parents = new Set([
    ...(currentSession.subagents || []).map(agent => agent.parentRunId),
    ...(Array.isArray(currentSession.imageViews) ? currentSession.imageViews : []).map(view => view?.runId),
  ]);
  currentSession.taskRuns = entries.filter((value, index) => index >= entries.length - 64 || parents.has(value.runId));
  // All turns retain a small anchor/usage summary. Rich telemetry and activity
  // events keep their existing bounds independently of this lightweight index.
  currentSession.turnUsage = store.snapshotTurnUsage(currentSession);
}
function sessionMetricsSnapshot(session) {
  const settings = publicSettings();
  const capacity = metricsModelCapacity?.connectionKey === metricsConnectionKey && metricsModelCapacity.model === settings.model ? metricsModelCapacity : null;
  return store.sessionMetrics(session, { provider: settings.provider, model: settings.model, connectionKey: metricsConnectionKey,
    ...(capacity ? { limit: capacity.capacityTokens, limitKind: capacity.limitKind } : {}) });
}
function requireIdle() {
  if (activeRun) throw new Error('请先停止正在执行的任务。');
  if (sessionDeleteLocks.has(currentSession?.id)) throw new Error('此会话正在删除，请稍后重试。');
  if (sessionRenameLocks.has(currentSession?.id)) throw new Error('此会话正在重命名，请稍后重试。');
}
function requireTools({ allowDuringUndo = false } = {}) { if (!tools) throw new Error('请先打开本地项目。'); if (!allowDuringUndo && persistentTaskUndo.isProjectBusy(tools.root)) throw new Error('此项目正在撤销或恢复修改，请稍后再操作文件。'); return tools; }
function requireFileManager(options) { requireTools(options); if (!fileManager) throw new Error('请先打开本地项目。'); return fileManager; }
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
  promptCompletion.abort();
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
  if (typeof arg?.id !== 'string' || !['steer', 'remove', 'edit'].includes(arg.action)) throw new Error('待发送消息操作无效。');
  if (arg.action === 'edit' && (typeof arg.text !== 'string' || arg.text.trim().length > 40000)) throw new Error('提示词最多支持 40000 个字符。');
  return serializePrompts(async () => {
    const index = pendingPrompts.findIndex(item => item.id === arg.id);
    if (index === -1) throw new Error('这条消息已发送或移除。');
    if (arg.action === 'remove') pendingPrompts.splice(index, 1);
    else if (arg.action === 'edit') {
      const item = pendingPrompts[index];
      if (!arg.text.trim() && !item.attachments?.length) throw new Error('请输入提示词内容。');
      pendingPrompts[index] = { ...item, text: arg.text.trim() };
    }
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
async function approve(request, { signal } = {}) {
  const run = activeRun;
  if (!run || run.controller.signal.aborted || signal?.aborted) return false;
  let decision;
  const approved = await approvalController.approve(request, { signal, parentSignal: run.controller.signal, runId: run.id, workspaceId,
    onDecision: outcome => { decision = outcome; } });
  if (!approved && decision?.reviewStatus === 'denied') {
    const error = new Error(`AI 审批已拒绝：${decision.reviewReason || '操作未获批准。'}`);
    error.code = 'APPROVAL_DENIED';
    throw error;
  }
  return approved;
}
function dispatchModelRequest(config) {
  if (config.modelRole) return roleRuntime.dispatch(config);
  return isAccountMode(config.authMode) ? accountController(config.authMode).requestModel({ ...config, requestModel }) : requestModel(config);
}
async function roleRequestConfig(role, run, modelOverride) {
  if (!roleModels.isEnabled(role)) return currentRequestConfig(run, modelOverride);
  const config = await roleRuntime.config(role, { signal: run.controller.signal, permissionMode });
  const context = { provider: config.provider, authMode: config.authMode,
    config: { baseUrl: config.baseUrl, apiProtocol: config.apiProtocol },
    account: { session: { profileId: config.chatgptProfileId || config.deepseekProfileId } } };
  const connection = modelCapacityConnectionKey(context, config.apiKey);
  const effective = applyModelCapacity({ capabilities: config.modelCapabilities,
    manualTokens: modelCapacityPreferences.get(connection, config.model) });
  return { ...config, modelCapabilities: effective.capabilities,
    contextCompressionTriggerTokens: effective.modelCapacity.capacityTokens ?? 850000 };
}
async function currentRequestConfig(run, modelOverride) {
  run.controller.signal.throwIfAborted();
  const settings = publicSettings(), context = await catalogContext();
  if (settings.provider === 'ollama' && !catalogSnapshots.has(context.key)) await fetchModelCatalog();
  if (settings.authMode === 'chatgpt' && !catalogSnapshots.has(context.key)) {
    try { await fetchModelCatalog(); } catch { /* Keep a connected account usable with the unknown-capacity guard. */ }
    if ((await catalogContext()).key !== context.key) throw new Error('模型连接已变更，请停止后重新开始任务。');
  }
  run.controller.signal.throwIfAborted();
  if (run.connectionKey && run.connectionKey !== context.key) throw new Error('模型连接已变更，请停止后重新开始任务。');
  const account = isAccountMode(settings.authMode);
  if (account && (context.account?.session?.status !== 'connected' || !context.account.session.sharing
      || (settings.authMode === 'chatgpt' ? run.chatgptProfileId : run.deepseekProfileId)
        && (settings.authMode === 'chatgpt' ? run.chatgptProfileId : run.deepseekProfileId) !== context.account.session.profileId)) throw new Error(`${accountLabel(settings.authMode)} 授权已变更，请停止后重新开始任务。`);
  const apiKey = account ? '' : store.key(settings.provider);
  if (!account && settings.provider !== 'ollama' && !apiKey) throw new Error('请先配置模型连接，才能使用 AI。');
  const model = modelOverride || settings.model, modelCapabilities = capabilitiesFor(context, model);
  if (!model) throw new Error('请先选择模型。');
  if (!modelOverride && modelCapabilities.supportsTools === false) throw new Error('所选模型不支持编程工具调用。');
  if (!modelOverride && modelCapabilities.supportsImages === false && currentSession.messages.some(message => message.attachments?.length)) throw new Error('当前会话包含图片，请选择支持图片的模型。');
  return { provider: settings.provider, apiKey, authMode: account ? settings.authMode : 'apiKey',
    baseUrl: account ? accountBaseUrl(settings.authMode) : settings.baseUrl, apiProtocol: account ? settings.authMode === 'chatgpt' ? 'responses' : 'chat-completions' : settings.apiProtocol,
    ...(settings.authMode === 'deepseek-account' ? { deepseekProfileId: context.account.session.profileId } : {}),
    model, modelCapabilities, reasoningEffort: resolvedReasoningEffort(modelCapabilities, settings.reasoningEffort),
    permissionMode, connectionKey: context.key, configRevision,
    contextCompressionTriggerTokens: modelCapabilities.contextWindow ?? 850000 };
}
async function recordRunUsage(record) {
  if (activeRun && record.runId === activeRun.id && record.sessionId === activeRun.sessionId) {
    const records = activeRun.usageRecords ||= new Map();
    if (!records.has(record.id)) records.set(record.id, {
      id: record.id, reported: record.reported === true, partial: record.partial === true,
      inputTokens: record.inputTokens, outputTokens: record.outputTokens,
    });
  }
  try { await store.recordUsage(record); emitSessionMetrics(); await broadcastAllStates(); }
  catch (cause) { emit({ type: 'storage-error', error: 'Token 统计保存失败：' + cause.message }); throw cause; }
}
async function reviewOperation(request, { signal, runId }) {
  const run = activeRun;
  if (!run || run.id !== runId || signal.aborted) throw new DOMException('审批已取消。', 'AbortError');
  const sessionId = currentSession.id;
  restoreApprovalReviewer(await catalogContext());
  const config = await roleRequestConfig('approval', { ...run, controller: { signal } }, approvalReviewerModel || undefined);
  signal.throwIfAborted();
  const selected = selectApprovalIntent(currentSession.messages, run.command ? { terminalCommand: run.command } : undefined);
  return reviewApproval({ request, context: { projectRoot: tools?.root, ...selected }, config,
    requestModel: dispatchModelRequest, signal, sessionId, runId, redact, onUsage: recordRunUsage });
}
async function state() {
  const account = chatgpt ? await chatgpt.publicState() : null;
  const deepseekAccount = deepseek ? await deepseek.publicState() : null;
  const roleState = await roleRuntime.publicState(publicSettings());
  const context = await catalogContext({}, { chatgpt: account, deepseek: deepseekAccount });
  restoreApprovalReviewer(context);
  if (!roleState.approval.enabled && approvalReviewerModel) roleState.approval.effective.model = approvalReviewerModel;
  metricsConnectionKey = context.key;
  const modelCapacity = capacityFor(context, publicSettings().model).modelCapacity;
  metricsModelCapacity = { ...modelCapacity, connectionKey: context.key };
  reconcileReasoningSelection(context);
  const sessions = (await store.listSessions()).filter(session => !recentProjects?.isHidden(session.workspace));
  const history = new Map(sessions.map(session => [projectIdentity(session.workspace), session]));
  const projects = (recentProjects?.list() || []).map(project => ({ ...project, ...(history.get(projectIdentity(project.path)) ? { sessionId: history.get(projectIdentity(project.path)).id } : {}) }));
  const sessionMetrics = sessionMetricsSnapshot(currentSession);
  const undoableRunIds = persistentTaskUndo.ids(currentSession?.id, tools?.root);
  const redoableRunIds = persistentTaskUndo.ids(currentSession?.id, tools?.root, 'redo');
  const activeTask = { compacting: activeRun?.compacting === true, running: !!activeRun, kind: activeRun?.kind || null, demo: activeRun?.demo === true,
    ...(activeRun ? { runId: activeRun.id, startedAt: activeRun.startedAt, messageStartIndex: activeRun.replayMessageStartIndex ?? activeRun.messageStartIndex,
      streamText: activeRun.streamText || '', liveEvents: structuredClone(activeRun.liveEvents || []), telemetry: activeRun.telemetry || null,
      subagents: structuredClone((currentSession?.subagents || []).filter(agent => agent.parentRunId === activeRun.id)) } : {}) };
  return { workspaceId, hiddenRecentProjects: recentProjects?.hidden() || [], openWorkspaces: host.summaries(), pendingApprovals: [...approvals.values()].map(value => value.request), terminalEvents: structuredClone(terminalEvents), permissionMode, approvalReviewer: { model: approvalReviewerModel, effectiveModel: approvalReviewerModel || publicSettings().model, provider: publicSettings().provider }, browser: browser?.state() || null, workspace: tools ? { root: tools.root, name: path.basename(tools.root) } : null, settings: publicSettings(), roleModels: roleState, sideChat: sideChat.snapshot(), petDialog: publicPetDialog(), sessions, recentProjects: projects, recentProjectsError: recentProjects?.error || null, fileClipboard: fileClipboard ? { ...fileClipboard } : null, editorDirty, usageStats: store.usageStats(), sessionMetrics, chatgpt: account, deepseek: deepseekAccount, textScale: uiPreferences?.textScale ?? 100, modelCapacity, modelCatalog: catalogSnapshots.get(context.key) || null, version: app.getVersion(), sessionId: currentSession?.id, sessionTitle: store.sessionTitle(currentSession), temporary: currentSession?.temporary === true, isFullscreen: win && !win.isDestroyed() ? win.isFullScreen() : false, promptQueue: queueSnapshot(), activeTask, undoableRunIds, redoableRunIds };
}
async function catalogContext(arg = {}, account) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new Error('模型目录参数无效。');
  const settings = publicSettings();
  const provider = arg.provider ?? settings.provider;
  if (!Object.hasOwn(settings.providers, provider)) throw new Error('请选择有效的模型供应商。');
  const config = settings.providers[provider];
  const authMode = arg.authMode ?? config.authMode;
  if (!['apiKey','chatgpt','deepseek-account'].includes(authMode) || (authMode === 'chatgpt' && provider !== 'openai') || (authMode === 'deepseek-account' && provider !== 'deepseek')) throw new Error('此服务商不支持所选的连接方式。');
  const chatgptState = isAccountMode(authMode) ? account?.[authMode === 'chatgpt' ? 'chatgpt' : 'deepseek'] ?? await accountController(authMode).publicState() : null;
  const key = catalogConnectionKey(provider, authMode, config, chatgptState);
  return { provider, authMode, config, account: chatgptState, key };
}
function catalogConnectionKey(provider, authMode, config, account) {
  const credential = isAccountMode(authMode) ? [account?.session?.status, account?.session?.sharing, account?.session?.profileId] : store.settings.providers[provider].encryptedKey || '';
  return createHash('sha256').update(JSON.stringify([provider, authMode, isAccountMode(authMode) ? 'official' : config.baseUrl, credential,
    ...(provider === 'ollama' ? [config.contextWindowTokens] : [])])).digest('hex');
}
function reviewerConnectionKey(connection) {
  const { provider, authMode, config, account } = connection;
  // Cache by encrypted credential/config identity so periodic UI broadcasts do
  // not repeatedly decrypt keys. The persisted digest uses the stable secret,
  // not random encrypted bytes or transient ChatGPT connection status.
  const fingerprint = JSON.stringify([provider, authMode, isAccountMode(authMode) ? account?.session?.profileId || null
    : [config.baseUrl, config.apiProtocol, store.settings.providers[provider].encryptedKey || '']]);
  if (approvalReviewerConnectionCache?.fingerprint === fingerprint) return approvalReviewerConnectionCache.key;
  try {
    const key = approvalReviewerConnectionKey(connection, isAccountMode(authMode) ? '' : store.key(provider));
    approvalReviewerConnectionCache = { fingerprint, key };
    return key;
  } catch { return null; /* Unreadable credentials must not break the settings UI. */ }
}
function restoreApprovalReviewer(connection) {
  const key = reviewerConnectionKey(connection), root = tools?.root || null;
  const scope = JSON.stringify([root, key]);
  if (approvalReviewerScope !== scope) {
    approvalReviewerScope = scope;
    approvalReviewerModel = key ? approvalReviewerPreferences.get(root, key) : null;
  }
  return key;
}
function capabilitiesFor(context, model) {
  return capacityFor(context, model).capabilities;
}
function capacityFor(context, model) {
  const metadata = catalogSnapshots.get(context.key)?.models.find(item => item.id === model);
  const capabilities = deriveModelCapabilities(context.provider, model, { ...metadata, ...(context.provider === 'ollama' ? { contextWindowTokens: context.config.contextWindowTokens } : {}), ...(context.authMode === 'chatgpt' ? { officialSource: true, allowPublishedContextWindow: Boolean(metadata) } : {}) });
  let connection = null, scope = null, manualTokens = null;
  try {
    connection = modelCapacityConnectionKey(context, isAccountMode(context.authMode) ? '' : store.key(context.provider));
    scope = modelCapacityScope(connection, model);
    manualTokens = modelCapacityPreferences?.get(connection, model) ?? null;
  } catch { /* Incomplete settings still allow the settings window to open. */ }
  const applied = applyModelCapacity({ capabilities, manualTokens });
  return { ...applied, connection, modelCapacity: { ...applied.modelCapacity, scope, model: model || '' } };
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
  if (!isAccountMode(authMode)) {
    for (const field of ['baseUrl', 'apiProtocol', 'apiKey', 'clearKey', 'contextWindowTokens']) if (Object.hasOwn(arg, field)) input[field] = arg[field];
  }
  // Validate the draft with exactly the same rules as a saved connection, while
  // keeping its key and all configuration changes in main-process memory only.
  const validator = new Store(store.dir, safeStorage);
  validator.settings = structuredClone(store.settings);
  validator.write = async () => {};
  const validated = await validator.saveSettings(input);
  const config = validated.providers[provider];
  const account = isAccountMode(authMode) ? await accountController(authMode).publicState() : null;
  if (account && (account.session.status !== 'connected' || !account.session.sharing || !account.session.profileId)) throw new Error(`请先连接 ${accountLabel(authMode)} 并完成授权，再获取模型目录。`);
  const apiKey = isAccountMode(authMode) ? '' : validator.key(provider);
  if (!isAccountMode(authMode) && provider !== 'ollama' && !apiKey) throw new Error('请填写 API Key，再获取模型目录。');
  const connection = createHash('sha256').update(JSON.stringify([
    workspaceId, provider, authMode, isAccountMode(authMode) ? 'official' : config.baseUrl,
    authMode === 'chatgpt' ? 'responses' : config.apiProtocol || 'responses',
    isAccountMode(authMode) ? account.session.profileId : apiKey,
    ...(provider === 'ollama' ? [config.contextWindowTokens] : []),
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
  } else if (draft.authMode === 'deepseek-account') {
    const models = await deepseek.listModels({ force: true });
    result = { models, fetchedAt: new Date().toISOString(), source: 'deepseek-account' };
  } else result = await modelCatalog.list({ provider: draft.provider, baseUrl: draft.config.baseUrl, apiKey: draft.apiKey, contextWindowTokens: draft.config.contextWindowTokens, force: true });
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
  const context = await catalogContext(arg);
  let result;
  try {
    if (context.authMode === 'chatgpt') {
      if (context.account?.session?.status !== 'connected') throw new Error('请先登录 ChatGPT，再获取账号模型目录。');
      if (!context.account.session.sharing) throw new Error('请先授权 ChatGPT 套餐用量，再获取模型目录。');
      const models = (await chatgpt.listModels({ force: arg.force === true })).map(model => ({ id: model.slug, displayName: model.displayName, ...deriveModelCapabilities('openai', model.slug, { ...model, officialSource: true }) }));
      result = { models, fetchedAt: new Date().toISOString(), source: 'chatgpt' };
    } else if (context.authMode === 'deepseek-account') {
      const models = await deepseek.listModels({ force: arg.force === true });
      result = { models, fetchedAt: new Date().toISOString(), source: 'deepseek-account' };
    } else {
      const apiKey = store.key(context.provider);
      if (context.provider !== 'ollama' && !apiKey) throw new Error('请先保存此服务商的 API Key，再获取模型目录。');
      result = await modelCatalog.list({ provider: context.provider, baseUrl: context.config.baseUrl, apiKey, contextWindowTokens: context.config.contextWindowTokens, force: arg.force === true });
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
  if (initialized && lastRememberedSessionId !== currentSession.id) await rememberSessionSelection();
}
async function rememberSessionSelection() {
  if (!initialized || host.active !== context) return false;
  const saved = await host.rememberSelection(context);
  if (saved) lastRememberedSessionId = currentSession.id;
  return saved;
}
function publicSession(session) {
  const { contextCheckpoint, usageBaseline, contextUsage, turnUsage, ...publicData } = session;
  publicData.taskRuns = store.sessionTaskRuns(session);
  const usages = new Map(publicData.taskRuns.filter(record => record.usage).map(record => [record.runId, record.usage]));
  publicData.events = (session.events || []).map(event => event.type === 'run-end' && usages.has(event.runId)
    ? { ...event, usage: usages.get(event.runId) } : event);
  publicData.sessionMetrics = sessionMetricsSnapshot(session);
  return JSON.parse(redact(JSON.stringify({ ...publicData, title: store.sessionTitle(session), messages: session.messages.map(({ providerState, ...message }) => message) })));
}
function sessionContextCheckpoint() {
  if (!currentSession.contextCheckpoint || typeof currentSession.contextCheckpoint !== 'object' || Array.isArray(currentSession.contextCheckpoint)) currentSession.contextCheckpoint = {};
  return currentSession.contextCheckpoint;
}
function setWorkspace(root) {
  if (shuttingDown) throw new Error('窗口正在关闭，请在新窗口继续操作。');
  requireEditorSettled();
  if (tools && projectIdentity(tools.root) !== projectIdentity(root)) throw new Error('请通过项目下拉菜单切换项目，当前任务的项目目录不能更改。');
  const nextTools = new WorkspaceTools(root, { approve, onEvent: emit, allowExternalPaths: true });
  const nextFiles = new ManualFileManager(nextTools.root, { trash: absolute => shell.trashItem(absolute) });
  if (!tools || projectIdentity(tools.root) !== projectIdentity(nextTools.root)) { permissionMode = permissionPreferences.get(nextTools.root); browser?.resetWorkspace(); }
  tools = nextTools; fileManager = nextFiles; editorFiles = new EditorFileTargets(nextFiles); fileClipboard = null; editorDirty = false;
}
async function activateProjectLocal(root, restore = true) {
  const canonical = await fs.realpath(root);
  const selected = restore ? await sessionRestore.resolveProject(canonical, {
    readSession: readSessionForContext, listProjectSessions: root => store.listProjectSessions(root),
  }) : null;
  // A missing/corrupt selection falls back to available history or a new chat.
  const snapshot = selected?.session;
  setWorkspace(canonical);
  if (snapshot) { petDialog.close(); currentSession = snapshot; loadedSnapshot = true; }
  else await createSession();
  await persistentTaskUndo.loadSession(currentSession);
  await rememberProject(canonical);
  return state();
}
async function createSession({ temporary = false } = {}) {
  promptCompletion.abort();
  petDialog.close();
  currentSession = store.createSession(tools?.root || null);
  loadedSnapshot = false;
  if (temporary) currentSession.temporary = true;
  await persistentTaskUndo.loadSession(currentSession);
  currentSession.usageLedgerVersion = 1;
  await saveCurrentSession();
  if (initialized) await rememberSessionSelection();
  return currentSession;
}
async function startTask(input) {
  promptCompletion.abort();
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
  const useDeepSeekAccount = provider === 'deepseek' && settings.authMode === 'deepseek-account';
  const modelContext = await catalogContext();
  if (!demo && provider === 'ollama' && !catalogSnapshots.has(modelContext.key)) await fetchModelCatalog();
  if (!demo && useChatGPT && !catalogSnapshots.has(modelContext.key)) {
    try { await fetchModelCatalog(); } catch { /* Missing catalog capacity stays conservative until discovery succeeds. */ }
    if ((await catalogContext()).key !== modelContext.key) throw new Error('模型连接已变更，请重新开始任务。');
  }
  if (shuttingDown || win?.isDestroyed()) throw new Error('窗口已关闭，任务未启动。');
  if (stopGeneration !== startingGeneration) throw new Error('任务启动已取消，消息仍保留在待发送列表。');
  metricsConnectionKey = modelContext.key;
  metricsModelCapacity = { ...capacityFor(modelContext, settings.model).modelCapacity, connectionKey: modelContext.key };
  const modelCapabilities = capabilitiesFor(modelContext, settings.model);
  // Unknown models accept the user's generic choice. Advertised capabilities
  // narrow those choices, including an explicit empty list for no adjustment.
  const reasoningEffort = resolvedReasoningEffort(modelCapabilities, settings.reasoningEffort);
  let chatgptProfileId = null;
  let deepseekProfileId = null;
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
    } else if (useDeepSeekAccount) {
      const account = await deepseek.publicState();
      if (account.session.status !== 'connected' || !account.session.sharing || !account.session.profileId) throw new Error('请先在模型设置中登录并授权 DeepSeek 账号。');
      deepseekProfileId = account.session.profileId;
    } else {
      apiKey = store.key(provider);
      if (provider !== 'ollama' && !apiKey) throw new Error('请先在模型设置中填写 API Key。');
    }
  }
  if (!demo) {
    if (currentSession.messages.length && ((currentSession.chatgptProfileId || null) !== chatgptProfileId || (currentSession.deepseekProfileId || null) !== deepseekProfileId)) await createSession({ temporary: currentSession.temporary === true });
    currentSession.chatgptProfileId = chatgptProfileId;
    currentSession.deepseekProfileId = deepseekProfileId;
  }
  if (loadedSnapshot) {
    petDialog.close();
    const sourceSessionId = currentSession.id;
    const fork = store.createSession(currentSession.workspace);
    // A history continuation inherits only the totals visible at this fork.
    // Later requests in the original session cannot change the branch's totals.
    currentSession = { ...currentSession, id: fork.id, createdAt: fork.createdAt,
      usageBaseline: store.sessionUsageTotals(currentSession), turnUsage: store.snapshotTurnUsage(currentSession) };
    try { await persistentTaskUndo.copySession(sourceSessionId, currentSession); }
    catch { emit({ type: 'storage-error', error: '历史撤销记录无法复制到新分支，当前文件和历史均已保留。' }); }
    loadedSnapshot = false;
  }
  if (shuttingDown || win?.isDestroyed()) throw new Error('窗口已关闭，任务未启动。');
  if (stopGeneration !== startingGeneration) throw new Error('任务启动已取消，消息仍保留在待发送列表。');
  currentSession.demo = demo;
  currentSession.usageLedgerVersion = 1;
  const userText = demo ? '演示一次代码助手的工作流程（离线，不调用 API）' : text;
  const previousContextUsage = structuredClone(currentSession.contextUsage || {});
  const userMessage = { id: input?.promptId || randomUUID(), role: 'user', content: userText, createdAt: input?.promptCreatedAt || new Date().toISOString(), ...(input?.promptSource ? { source: input.promptSource } : {}), ...(attachments.length ? { attachments } : {}) };
  currentSession.messages.push(userMessage);
  if (!demo) currentSession.contextUsage = makePendingContextUsage(previousContextUsage, { provider, model: settings.model,
    connectionKey: modelContext.key, limit: modelCapabilities.contextWindow ?? null, limitKind: modelCapabilities.contextWindowKind ?? 'total' });
  const run = makeRun('agent');
  run.sessionId = currentSession.id;
  run.fileChangeCount = 0;
  run.connectionKey = modelContext.key;
  run.chatgptProfileId = chatgptProfileId;
  run.deepseekProfileId = deepseekProfileId;
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
    if (!demo) {
      run.petGreetingTimer = setTimeout(() => {
        if (activeRun !== run || run.controller.signal.aborted || shuttingDown || quitting || !win?.isVisible()
            || win.isMinimized() || host.active !== context
            || Date.now() - lastPetGreetingAt < 120000 || petDialog.snapshot().question || petDialog.snapshot().running) return;
        lastPetGreetingAt = Date.now();
        petDialog.greet({ signal: run.controller.signal, sessionId: run.sessionId });
      }, 45000);
      run.petGreetingTimer.unref();
    }
    try {
      if (demo) {
        await runDemo({ signal: run.controller.signal, emit: event => {
          if (event.type === 'assistant-message') currentSession.messages.push({ role: 'assistant', content: event.text, toolCalls: [] });
          emit(event);
        }, approve });
      } else {
        await runAgent({ config: { provider, apiKey, authMode: useChatGPT ? 'chatgpt' : useDeepSeekAccount ? 'deepseek-account' : 'apiKey', deepseekProfileId, connectionKey: modelContext.key, configRevision, baseUrl: useChatGPT || useDeepSeekAccount ? accountBaseUrl(settings.authMode) : settings.baseUrl, apiProtocol: useChatGPT ? 'responses' : settings.apiProtocol, model: settings.model, modelCapabilities, reasoningEffort }, messages: currentSession.messages, permissionMode, workspace: { root: tools.root, execute: (name, args, options) => {
          if (name === PET_QUESTION_TOOL.name)
            return petDialog.ask(args, { signal: options.signal, runId: run.id, sessionId: run.sessionId }).then(value => JSON.stringify(value));
          if (name === 'read_url' || name.startsWith('browser_')) {
            if (name !== 'read_url' && !(name === 'browser_navigate' && isXmlURL(args.url))) emit({ type: 'browser-open' });
            return browser.execute(name, args, { ...options, approve });
          }
          return tools.execute(name, args, { ...options, onFileChange: change => { recordRunFileChange(run, change); options.onFileChange?.(change); } });
        } }, toolDefinitions: [...TOOL_DEFINITIONS, ...BROWSER_TOOL_DEFINITIONS, PET_QUESTION_TOOL], requestModel: dispatchModelRequest, getRequestConfig: () => currentRequestConfig(run), getSubagentRequestConfig: ({ signal }) => roleRequestConfig('subagent', { ...run, controller: { signal } }), signal: run.controller.signal, emit, redact, runId: run.id, sessionId: currentSession.id, messageStartIndex: run.messageStartIndex,
          subagentFactory: meta => createSubagentWorkspace({ root: tools.root, ...meta, approve, history: tools.history,
            onCommitted: change => {
              recordRunFileChange(run, change);
              emit({ type: 'file-change-recorded', toolCallId: `child-${meta.id}-${randomUUID()}`, fileChange: change });
              emit({ type: 'files-changed', operation: 'subagent', path: change.path });
            } }),
          onSubagentManager: manager => { run.subagentManager = manager; },
          takeSteering: () => takeSteering(run),
          previousContextUsage,
          contextMeasurement: previousContextUsage.measurement || previousContextUsage.lastReported?.measurement,
          onMessagesChanged: () => { currentSession.contextUsage = makePendingContextUsage(currentSession.contextUsage); emitSessionMetrics(); },
          contextCheckpoint: sessionContextCheckpoint(),
          onContextCompacted: () => saveCurrentSession(),
          onContextUsage: sample => {
            currentSession.contextUsage = { ...sample };
            emitSessionMetrics();
          },
          onUsage: record => recordRunUsage(record).catch(() => {})
        });
      }
    } catch (cause) {
      if (run.controller.signal.aborted) status = 'stopped';
      else { status = 'failed'; error = redact(cause.message || '任务失败。'); }
    } finally {
      clearTimeout(run.petGreetingTimer);
      for (const done of [...approvals.values()]) done(false);
      await approvalController.drain(run.id);
      if (run.controller.signal.aborted) status = 'stopped';
      try { await persistentTaskUndo.seal(run.id, run.sessionId, tools.root); }
      catch { emit({ type: 'storage-error', error: '本轮撤销记录保存失败，自动撤销已停用；文件改动仍保留。' }); }
      const endEvent = { type: 'run-end', runId: run.id, kind: 'agent', status, fileChangeCount: run.fileChangeCount, ...(error ? { error } : {}), startedAt: run.startedAt, endedAt: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - run.startedMonotonic)), messageStartIndex: run.messageStartIndex, messageIndex: currentSession.messages.length - 1, ...(run.telemetry ? { telemetry: run.telemetry } : {}),
        ...(demo ? { demo: true } : { usage: createTurnUsage([...(run.usageRecords?.values() || [])]) }) };
      // Store only one timing/rate summary per task. Streaming estimates stay
      // out of the token ledger, and history never restarts a completed timer.
      currentSession.events.push(endEvent);
      currentSession.events = currentSession.events.slice(-150);
      rememberTaskRun(endEvent);
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

async function runPersistedChangeOperation(arg, direction) {
  requireIdle(); requireSharedReady(); requireEditorSettled();
  const workspace = requireTools(), name = direction === 'redo' ? 'redo_run_changes' : 'undo_run_changes';
  if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).length !== 1
      || typeof arg.runId !== 'string' || !/^[a-f\d-]{36}$/iu.test(arg.runId)) throw new Error('本轮撤销或恢复参数无效。');
  const peers = [...windows.values()].flatMap(value => [...value.contexts]);
  if (peers.some(peer => peer !== context && peer.tools && projectIdentity(peer.tools.root) === projectIdentity(workspace.root)
      && (peer.busy || peer.editorDirty || peer.hasPendingPrompts))) throw new Error('此项目在其他窗口仍有任务或未保存内容，请先处理后再撤销或恢复。');
  if (!persistentTaskUndo.ids(currentSession.id, workspace.root, direction).includes(arg.runId)) throw new Error('此轮没有可用的撤销或恢复记录。');
  const run = makeRun('undo'); activeRun = run;
  emit({ type: 'run-start', runId: run.id, kind: 'undo' });
  emit({ type: 'tool-start', name, args: { runId: arg.runId }, toolCallId: run.id });
  let status = 'completed', error;
  try {
    let sequence = 0;
    const rawResult = await persistentTaskUndo.operate({ sessionId: currentSession.id, workspace: workspace.root, runId: arg.runId,
      direction, workspaceTools: workspace, signal: run.controller.signal, onFileChange: change => {
        emit({ type: 'file-change-recorded', toolCallId: `${run.id}-${++sequence}`, fileChange: change });
        emit({ type: 'files-changed', operation: direction + '-run', path: change.path });
      } });
    const detail = JSON.parse(rawResult);
    if (detail.status !== 'completed') { status = detail.stopped ? 'stopped' : 'failed'; error = detail.message; }
    const result = redact(rawResult);
    emit({ type: 'tool-result', name, toolCallId: run.id, result }); return { result };
  } catch (cause) { status = 'failed'; error = cause.message; throw cause; }
  finally {
    for (const done of [...approvals.values()]) done(false);
    await approvalController.drain(run.id);
    const endEvent = { type: 'run-end', runId: run.id, kind: 'undo', status: run.controller.signal.aborted ? 'stopped' : status,
      ...(error ? { error: redact(error) } : {}), startedAt: run.startedAt, endedAt: Date.now(),
      elapsedMs: Math.max(0, Math.round(performance.now() - run.startedMonotonic)), messageIndex: currentSession.messages.length - 1 };
    currentSession.events.push(endEvent); currentSession.events = currentSession.events.slice(-150); rememberTaskRun(endEvent);
    try { await saveCurrentSession(); }
    finally { activeRun = null; run.finish(); emit(endEvent); }
  }
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
    getAppUpdate: () => appUpdateSnapshot(),
    checkAppUpdate: async () => { if (updateEnabled) await appUpdater.check(); return appUpdateSnapshot(); },
    downloadAppUpdate: async () => { await appUpdater.download(); return appUpdateSnapshot(); },
    installAppUpdate,
    getExtensions: () => extensionsSnapshot(),
    installExtension: async () => {
      const selected = await dialog.showOpenDialog(win, { title: '选择本地插件文件夹', properties: ['openDirectory'] });
      if (!selected.canceled && selected.filePaths[0]) {
        const manifest = await pluginManager.preview(selected.filePaths[0]);
        const labels = { 'project.read': '读取当前项目文本文件', 'project.write': '请求修改当前项目文本文件', notifications: '显示软件内通知' };
        const decision = await dialog.showMessageBox(win, { type: 'question', title: '安装本地插件',
          message: `安装“${manifest.name}” ${manifest.version}？`,
          detail: `申请权限：\n${manifest.permissions.map(value => '• ' + labels[value]).join('\n') || '无需项目权限'}\n\n安装后可在插件列表中启用和打开。`,
          buttons: ['取消', '安装'], defaultId: 0, cancelId: 0, noLink: true });
        if (decision.response !== 1 || quitting || win.isDestroyed()) return null;
        await pluginManager.install(selected.filePaths[0]);
        return extensionsSnapshot();
      }
      return null;
    },
    setExtensionEnabled: async arg => {
      if (!arg || Object.keys(arg).some(key => !['id', 'enabled'].includes(key))) throw new Error('插件参数无效。');
      await pluginManager.setEnabled(arg.id, arg.enabled); return extensionsSnapshot();
    },
    removeExtension: async arg => {
      if (!arg || Object.keys(arg).some(key => key !== 'id')) throw new Error('插件参数无效。');
      pluginRuntime.close(arg.id); await pluginManager.uninstall(arg.id); return extensionsSnapshot();
    },
    openExtension: arg => {
      if (!arg || Object.keys(arg).some(key => key !== 'id')) throw new Error('插件参数无效。');
      return pluginRuntime.open(arg.id, null, win);
    },
    runExtensionCommand: arg => {
      if (!arg || Object.keys(arg).some(key => !['id', 'command'].includes(key)) || typeof arg.command !== 'string') throw new Error('插件命令参数无效。');
      return pluginRuntime.open(arg.id, arg.command, win);
    },
    createExtensionExample: async () => {
      const selected = await dialog.showOpenDialog(win, { title: '选择示例插件的保存位置', properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return null;
      const destination = await createPluginExample(pluginDeveloperFiles().example, selected.filePaths[0]);
      return { path: destination };
    },
    openExtensionGuide: async () => {
      const error = await shell.openPath(pluginDeveloperFiles().guide);
      if (error) throw new Error('无法打开插件开发文档，请检查文件关联。');
      return null;
    },
    petState: () => dshPet.snapshot(),
    setPet: async arg => { await dshPet.set(arg); return publishPet(); },
    petImport: async () => {
      const selected = await dialog.showOpenDialog(win, { title: '导入 dsh-pet 宠物配置',
        properties: ['openFile'], filters: [{ name: 'dsh-pet 配置', extensions: ['json', 'jsonc'] }] });
      if (selected.canceled || !selected.filePaths[0]) return null;
      await dshPet.importFile(selected.filePaths[0]);
      return publishPet();
    },
    getState: state,
    getUsageAnalytics: () => loadUsageAnalytics(store, [...windows.values()].flatMap(value => [...value.contexts].map(context => context.currentSession)).filter(Boolean)),
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
    copyText: async arg => {
      if (typeof arg?.text !== 'string' || arg.text.length > 1024 * 1024) throw new Error('复制内容无效或超过 1 MB 字符上限。');
      await clipboard.writeText(arg.text);
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
    setModelCapacity: async arg => {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)
          || Object.keys(arg).some(key => !['scope', 'capacityTokens'].includes(key))
          || typeof arg.scope !== 'string' || !Object.hasOwn(arg, 'capacityTokens')) throw new Error('模型容量设置无效。');
      if (shuttingDown || quitting || localOperation || promptPreflights) throw new Error('会话正在切换或关闭，请稍后设置模型容量。');
      const context = await catalogContext(), settings = publicSettings();
      const current = capacityFor(context, settings.model);
      if (!current.modelCapacity.scope || arg.scope !== current.modelCapacity.scope) throw new Error('模型或连接已变化，请重新打开模型容量设置。');
      if ((await catalogContext()).key !== context.key || publicSettings().model !== settings.model)
        throw new Error('模型或连接已变化，请重新打开模型容量设置。');
      await modelCapacityPreferences.set(current.connection, settings.model, arg.capacityTokens,
        { advertisedTokens: current.modelCapacity.advertisedTokens });
      await broadcastAllStates(); return state();
    },
    setPermissionMode: async arg => {
      const mode = validateMode(arg?.mode);
      if (localOperation || promptPreflights || shuttingDown || quitting) throw new Error('请等待当前操作结束后再切换权限。');
      if (mode === 'full' && arg?.confirmed !== true) throw new Error('启用完全控制前需要确认风险。');
      const root = tools?.root || null;
      await permissionPreferences.set(root, mode);
      if ((tools?.root || null) !== root || shuttingDown || quitting) return { mode: permissionMode };
      permissionMode = mode;
      ++configRevision;
      approvalController.reconcile();
      await broadcastState();
      return { mode: permissionMode };
    },
    setApprovalReviewer: async arg => {
      if (!arg || Object.keys(arg).some(key => key !== 'model') || !(arg.model === null || typeof arg.model === 'string' && arg.model && arg.model.length <= 200)) throw new Error('审批模型参数无效。');
      if (localOperation || promptPreflights || shuttingDown || quitting) throw new Error('请等待当前操作结束后切换审批模型。');
      const context = await catalogContext();
      if (arg.model && !catalogSnapshots.get(context.key)?.models.some(model => model.id === arg.model)) throw new Error('请先获取当前连接的模型目录，再选择审批模型。');
      if (arg.model) {
        const capabilities = capabilitiesFor(context, arg.model);
        if (capabilities.textCompatible === false || capabilities.compatible === false && capabilities.textCompatible !== true) throw new Error('此模型不支持文字审批，请选择支持文字对话的模型。');
      }
      const root = tools?.root || null, connection = restoreApprovalReviewer(context);
      if (!connection) throw new Error('当前模型连接不可用，请检查连接设置后重试。');
      await approvalReviewerPreferences.set(root, connection, arg.model);
      const currentConnection = restoreApprovalReviewer(await catalogContext());
      if ((tools?.root || null) === root && currentConnection === connection && !shuttingDown && !quitting) {
        approvalReviewerModel = arg.model;
        approvalController.reconcile();
      }
      await broadcastState();
      return { model: approvalReviewerModel, effectiveModel: approvalReviewerModel || publicSettings().model, provider: publicSettings().provider };
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
    listFiles: arg => requireTools({ allowDuringUndo: true }).listFiles(arg || {}),
    readFile: arg => requireTools({ allowDuringUndo: true }).readFile(arg || {}),
    fileList: arg => requireFileManager({ allowDuringUndo: true }).list(arg || {}),
    listProjectSessions: () => store.listProjectSessions(tools?.root || null),
    chooseEditorFile: async () => {
      requireFileManager({ allowDuringUndo: true });
      const selected = await dialog.showOpenDialog(win, { title: '打开文件', defaultPath: tools.root, properties: ['openFile'] });
      if (selected.canceled || !selected.filePaths.length) return null;
      const file = await editorFiles.paths({ path: selected.filePaths[0] });
      return { path: file.absolute };
    },
    fileRead: arg => { requireFileManager({ allowDuringUndo: true }); return editorFiles.read(arg); },
    fileCreate: async arg => fileChanged('create', await requireFileManager().create(arg)),
    ...require('./core/explorer-batch.cjs').createExplorerHandlers({
      getManager: requireFileManager, getClipboard: () => fileClipboard,
      setClipboard: value => { fileClipboard = value; }, onChange: fileChanged,
      broadcast: broadcastState, writeText: text => clipboard.writeText(text),
      confirmDelete: async targets => {
        const confirmation = await dialog.showMessageBox(win, { type: 'question', title: '移至回收站',
          message: targets.length === 1 ? `将“${targets[0].relative}”移至 Windows 回收站？` : `将选中的 ${targets.length} 个项目移至 Windows 回收站？`,
          detail: (targets.length > 1 ? targets.slice(0, 8).map(target => target.relative).join('\n') + (targets.length > 8 ? '\n…' : '') + '\n\n' : '') + '文件夹内的内容也会一起移入回收站。',
          buttons: ['移至回收站', '取消'], defaultId: 1, cancelId: 1, noLink: true });
        return confirmation.response === 0;
      },
    }),
    fileReveal: async arg => {
      requireFileManager();
      const target = await editorFiles.paths(arg);
      shell.showItemInFolder(target.absolute);
      return null;
    },
    fileSave: async arg => { requireFileManager(); return fileChanged('save', await editorFiles.save(arg)); },
    listModels: fetchModelCatalog,
    selectModel: async arg => {
      if (typeof arg?.model !== 'string' || !arg.model || arg.model.length > 200) throw new Error('模型标识无效。');
      const context = await catalogContext();
      const model = catalogSnapshots.get(context.key)?.models.find(item => item.id === arg.model);
      if (!model) throw new Error('请先刷新当前连接的模型目录，再选择模型。');
      if (model.supportsTools === false) throw new Error('此模型不支持当前编程助手使用的工具，请选择支持工具调用的模型。');
      const previous = publicSettings();
      if (model.supportsImages === false && activeRun?.kind === 'agent' && currentSession.messages.some(message => message.attachments?.length)) throw new Error('当前任务包含图片，请选择支持图片的模型。');
      const capabilities = capabilitiesFor(context, model.id);
      const reasoningEffort = resolvedReasoningEffort(capabilities, previous.reasoningEffort);
      await saveProjectSettings({ provider: context.provider, authMode: context.authMode, model: model.id, reasoningEffort });
      await broadcastState(); return state();
    },
    saveSettings: async arg => { await saveProjectSettings(arg); await broadcastAllStates(); return state(); },
    previewModelCatalog: previewModelSettingsCatalog,
    saveModelSettings: commitModelSettings,
    previewRoleModelCatalog: async arg => {
      requireGlobalIdle(); requireSharedReady();
      return roleRuntime.preview(arg?.role, arg);
    },
    saveRoleModelSettings: arg => mutateShared(async () => {
      await roleRuntime.save(arg?.role, arg);
      await broadcastAllStates(); return state();
    }),
    resetRoleModel: arg => mutateShared(async () => {
      await roleRuntime.reset(arg?.role);
      if (arg.role === 'approval') {
        const connection = restoreApprovalReviewer(await catalogContext());
        if (connection) await approvalReviewerPreferences.set(tools?.root || null, connection, null);
        approvalReviewerModel = null; approvalController.reconcile();
      }
      await broadcastAllStates(); return state();
    }),
    roleChatgptSignIn: arg => mutateShared(async () => {
      const account = roleAccount(arg?.role);
      const options = {};
      for (const key of ['newProfile', 'reconsent', 'profileId']) if (Object.hasOwn(arg, key)) options[key] = arg[key];
      await account.signIn(options); await broadcastAllStates(); return state();
    }),
    roleChatgptCancelSignIn: arg => { roleAccount(arg?.role).cancelSignIn(); return null; },
    roleChatgptSelectProfile: arg => mutateShared(async () => {
      await roleAccount(arg?.role).selectProfile(arg?.id); await broadcastAllStates(); return state();
    }),
    roleChatgptDisconnect: arg => mutateShared(async () => {
      await roleAccount(arg?.role).disconnect(); await broadcastAllStates(); return state();
    }),
    roleChatgptRetryStorage: arg => mutateShared(async () => {
      await roleAccount(arg?.role).retryLocalRead(); await broadcastAllStates(); return state();
    }),
    roleChatgptOpenUsage: async arg => {
      roleAccount(arg?.role); await shell.openExternal('https://chatgpt.com/settings/usage'); return null;
    },
    roleDeepseekSignIn: arg => mutateShared(async () => {
      await roleAccount(arg?.role, 'deepseek').signIn(); await broadcastAllStates(); return state();
    }),
    roleDeepseekCancelSignIn: arg => { requireGlobalIdle(); void roleAccount(arg?.role, 'deepseek').cancelSignIn(); return null; },
    roleDeepseekDisconnect: arg => mutateShared(async () => {
      await roleAccount(arg?.role, 'deepseek').disconnect(); await broadcastAllStates(); return state();
    }),
    roleDeepseekRetryStorage: arg => mutateShared(async () => {
      await roleAccount(arg?.role, 'deepseek').retryLocalRead(); await broadcastAllStates(); return state();
    }),
    sideChatOpen: () => { requireSharedReady(); return sideChat.open(); },
    sideChatSend: arg => {
      requireSharedReady();
      if (shuttingDown || quitting || host.active !== context) throw new Error('窗口正在切换或关闭。');
      return sideChat.send(arg);
    },
    sideChatStop: () => sideChat.stop(),
    sideChatClose: () => sideChat.hide(),
    getDeepSeekBalance: async () => {
      const { fetchDeepSeekBalance, isOfficialDeepSeekURL } = await import('./core/deepseek-account.mjs');
      const baseUrl = store.settings.providers.deepseek.baseUrl;
      const apiKey = store.key('deepseek');
      if (!isOfficialDeepSeekURL(baseUrl)) throw new Error('DEEPSEEK_BALANCE_UNOFFICIAL: 余额查询仅支持 DeepSeek 官方 API 地址。');
      if (!apiKey) throw new Error('DEEPSEEK_BALANCE_KEY: 请先保存 DeepSeek API Key。');
      let balance;
      try { balance = await fetchDeepSeekBalance({ apiKey, baseUrl }); }
      catch (error) {
        const code = /^DEEPSEEK_BALANCE_[A-Z_]+$/u.test(error?.code) ? error.code : 'DEEPSEEK_BALANCE_NETWORK';
        // Electron IPC preserves Error.message, not custom properties. The UI
        // maps this bounded code to a local message and never renders a body.
        throw new Error(code + ': DeepSeek 余额查询失败。');
      }
      if (store.settings.providers.deepseek.baseUrl !== baseUrl || store.key('deepseek') !== apiKey)
        throw new Error('连接已变更，请重新查询。');
      return balance;
    },
    openDeepSeekAccount: async () => { await shell.openExternal('https://platform.deepseek.com/'); return null; },
    deepseekSignIn: () => mutateShared(async () => {
      await deepseek.signIn(); await broadcastAllStates(); return state();
    }),
    deepseekCancelSignIn: () => { requireGlobalIdle(); void deepseek.cancelSignIn(); return null; },
    deepseekDisconnect: () => mutateShared(async () => {
      await deepseek.disconnect(); await broadcastAllStates(); return state();
    }),
    deepseekRetryStorage: () => mutateShared(async () => {
      await deepseek.retryLocalRead(); await broadcastAllStates(); return state();
    }),
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
      const current = publicSettings();
      const capabilities = capabilitiesFor(await catalogContext(), current.model);
      if (arg?.reasoningEffort !== 'default') {
        if (Array.isArray(capabilities.reasoningEfforts) && !capabilities.reasoningEfforts.includes(arg?.reasoningEffort)) throw new Error('当前模型不支持此推理强度，请使用默认或支持的档位。');
      }
      await saveProjectSettings({ provider: current.provider, authMode: current.authMode, model: current.model, baseUrl: current.baseUrl, reasoningEffort: arg?.reasoningEffort });
      await broadcastState(); return state();
    },
    runTask: startTask,
    completePrompt: arg => promptCompletion.complete(arg),
    getPetDialog: () => publicPetDialog(),
    answerPetDialog: arg => {
      validatePetDialogScope(arg, ['id', 'text', 'choiceIndex']);
      const { workspaceId: _workspace, sessionId: _session, ...answer } = arg;
      petDialog.answer(answer); return publicPetDialog();
    },
    dismissPetDialog: arg => {
      validatePetDialogScope(arg, ['id']);
      petDialog.dismiss({ id: arg.id }); return publicPetDialog();
    },
    sendPetChat: arg => {
      validatePetDialogScope(arg, ['text']);
      petDialog.send({ text: arg.text }, { sessionId: currentSession.id }); return publicPetDialog();
    },
    cancelPromptCompletion: arg => promptCompletion.cancel(arg),
    stopTask: () => { ++stopGeneration; pauseQueue('任务已停止，待发送消息已暂停。'); activeRun?.controller.abort(); petDialog.stop(); return null; },
    stopSubagent: async arg => {
      if (!arg || typeof arg.id !== 'string' || Object.keys(arg).some(key => key !== 'id')) throw new Error('子智能体参数无效。');
      const manager = activeRun?.kind === 'agent' && activeRun.subagentManager;
      if (!manager) throw new Error('当前没有正在运行的子智能体。');
      return manager.stop({ id: arg.id });
    },
    respondApproval: arg => {
      if (typeof arg?.id !== 'string' || typeof arg?.approved !== 'boolean') throw new Error('审批参数无效。');
      return approvalController.respond(arg);
    },
    getSession: async arg => {
      requireIdle();
      promptCompletion.abort();
      petDialog.close();
      const loaded = await readSessionForContext(arg?.id);
      if (loaded.workspace && (!tools || projectIdentity(loaded.workspace) !== projectIdentity(tools.root))) throw new Error('请先通过项目下拉菜单切换到此会话所属项目，再打开历史会话。');
      currentSession = loaded;
      await persistentTaskUndo.loadSession(currentSession);
      loadedSnapshot = true;
      if (tools) await rememberProject(tools.root);
      await context.rememberSelection();
      await broadcastState();
      return publicSession(loaded);
    },
    newSession: async arg => {
      requireIdle();
      if (arg !== undefined && (!arg || typeof arg !== 'object' || Array.isArray(arg) || (arg.temporary !== undefined && typeof arg.temporary !== 'boolean'))) throw new Error('新对话参数无效。');
      await createSession({ temporary: arg?.temporary === true }); await broadcastAllStates();
      return { id: currentSession.id, title: store.sessionTitle(currentSession), temporary: currentSession.temporary === true };
    },
    deleteSession: async arg => {
      requireIdle(); requireEditorSettled();
      if (sessionDeleteLocks.size) throw new Error('正在删除会话记录，请稍后重试。');
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some(key => key !== 'id')
        || typeof arg.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(arg.id)) throw new Error('会话删除参数无效。');
      if (sessionDeleteLocks.has(arg.id) || sessionRenameLocks.has(arg.id)) throw new Error('此会话正在更新，请稍后重试。');
      sessionDeleteLocks.add(arg.id);
      try {
        const target = currentSession?.id === arg.id && currentSession.temporary === true ? currentSession : await store.getSession(arg.id);
        const identity = root => root ? projectIdentity(root) : null;
        if (identity(target.workspace) !== identity(tools?.root || null)) throw new Error('只能删除当前项目的会话。');
        const peers = [...windows.values()].flatMap(value => [...value.contexts]).filter(value => value.currentSession?.id === arg.id);
        if (peers.some(value => value.editorDirty || value.hasFileOperation || value.hasPendingPrompts || value !== context && value.busy))
          throw new Error('此会话正在另一个窗口处理任务或保存文件，请等待结束后再删除。');
        await store.validateSessionDeletion(arg.id, target.workspace, { temporary: target.temporary === true });
        for (const peer of peers) peer.cancelPromptCompletion();
        let replacement;
        if (peers.length) {
          for (const row of await store.listProjectSessions(target.workspace)) {
            if (row.id === arg.id) continue;
            try { replacement = await readSessionForContext(row.id); break; } catch { /* Skip unavailable histories. */ }
          }
          if (!replacement) {
            replacement = store.createSession(target.workspace); replacement.usageLedgerVersion = 1;
            await persistentTaskUndo.loadSession(replacement); await store.saveSession(replacement);
          }
        }
        const undoDeletion = await persistentTaskUndo.deleteSession(arg.id);
        try { await store.deleteSession(arg.id, target.workspace, { temporary: target.temporary === true }); }
        catch (error) {
          try { await undoDeletion.rollback(); }
          catch { throw new Error('会话删除失败，撤销记录恢复也未成功，请保留本机数据后重试。'); }
          throw error;
        }
        ++sessionRenameRevision;
        try { await sessionRestore.forgetSession(arg.id); } catch (error) { emit({ type: 'storage-error', error: error.message }); }
        for (const peer of peers) await peer.replaceDeletedSession(arg.id, replacement);
        const observers = [...windows.values()].flatMap(value => [...value.contexts])
          .filter(value => identity(value.tools?.root || value.currentSession?.workspace || null) === identity(target.workspace));
        for (const observer of observers) observer.emit({ type: 'session-deleted', deletedId: arg.id,
          state: await observer.state(), session: observer.publicCurrentSession() });
        await broadcastAllStates();
        return { deletedId: arg.id, state: await state(), session: publicSession(currentSession) };
      } finally { sessionDeleteLocks.delete(arg.id); }
    },
    removeRecentProject: async arg => {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some(key => key !== 'path') || typeof arg.path !== 'string') throw new Error('最近项目参数无效。');
      const visible = await state(), identity = projectIdentity(arg.path);
      if (recentProjects.isHidden(arg.path) || ![...visible.recentProjects.map(item => item.path), ...visible.sessions.map(item => item.workspace),
        ...visible.openWorkspaces.map(item => item.root)].filter(Boolean).some(root => projectIdentity(root) === identity)) throw new Error('最近项目记录已变化，请刷新后重试。');
      await recentProjects.remove(arg.path); await broadcastAllStates();
      return state();
    },
    renameSession: async arg => {
      requireIdle();
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || typeof arg.id !== 'string' || arg.id !== currentSession?.id) throw new Error('当前会话已切换，请重新打开重命名。');
      const peers = [...windows.values()].flatMap(value => [...value.contexts]).filter(value => value.currentSession?.id === arg.id);
      if (peers.some(value => value !== context && (value.busy || value.hasPendingPrompts))) throw new Error('此会话正在另一个窗口处理任务，请等待结束后再重命名。');
      let renamed;
      sessionRenameLocks.add(arg.id);
      try {
        renamed = await store.renameSession(currentSession, arg.title);
        ++sessionRenameRevision;
        for (const peer of peers) {
          if (peer.currentSession?.id !== arg.id) continue;
          peer.currentSession.customTitle = currentSession.customTitle;
          peer.currentSession.title = renamed.title;
          peer.currentSession.updatedAt = currentSession.updatedAt;
        }
      } finally { sessionRenameLocks.delete(arg.id); }
      for (const peer of peers) if (peer.currentSession?.id === arg.id) peer.emit({ type: 'session', session: peer.publicCurrentSession() });
      await broadcastAllStates();
      return renamed;
    },
    undoRunChanges: async arg => runPersistedChangeOperation(arg, 'undo'),
    redoRunChanges: async arg => runPersistedChangeOperation(arg, 'redo'),
    undoLastChange: async () => {
      requireIdle();
      const workspace = requireTools();
      requireSharedReady();
      const run = makeRun('undo');
      activeRun = run;
      emit({ type: 'run-start', runId: run.id, kind: 'undo' });
      emit({ type: 'tool-start', name: 'undo_last_change', args: {}, toolCallId: run.id });
      let status = 'completed', error;
      try {
        let fileChange;
        const result = await workspace.undoLastChange({ signal: run.controller.signal, onFileChange: change => { fileChange = change; } });
        if (result.startsWith('错误：')) { status = 'failed'; error = result; }
        emit({ type: 'tool-result', name: 'undo_last_change', toolCallId: run.id, result, ...(fileChange ? { fileChange } : {}) });
        return { result };
      } finally {
        for (const done of [...approvals.values()]) done(false);
        await approvalController.drain(run.id);
        const endEvent = { type: 'run-end', runId: run.id, kind: 'undo', status: run.controller.signal.aborted ? 'stopped' : status,
          ...(error ? { error } : {}), startedAt: run.startedAt, endedAt: Date.now(),
          elapsedMs: Math.max(0, Math.round(performance.now() - run.startedMonotonic)), messageIndex: currentSession.messages.length - 1 };
        currentSession.events.push(endEvent);
        currentSession.events = currentSession.events.slice(-150);
        rememberTaskRun(endEvent);
        try { await saveCurrentSession(); }
        finally {
          activeRun = null;
          run.finish();
          emit(endEvent);
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
  const manualMutations = new Set(['fileCreate', 'fileRename', 'fileMove', 'fileDelete', 'filePaste', 'fileSave', 'fileClipboard']);
  for (const name of ['fileList', 'fileRead', 'fileCreate', 'fileRename', 'fileMove', 'fileDelete', 'fileClipboard', 'filePaste', 'fileCopyPath', 'fileReveal', 'fileSave']) {
    const handler = handlers[name];
    handlers[name] = arg => {
      if (shuttingDown || quitting || win?.isDestroyed()) throw new Error('窗口正在关闭，文件操作未开始。');
      const manager = requireFileManager({ allowDuringUndo: !manualMutations.has(name) });
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
  for (const name of ['getSession', 'newSession', 'renameSession', 'deleteSession', 'runTask', 'undoLastChange', 'undoRunChanges', 'redoRunChanges', 'runTerminal']) {
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
      if (typeof arg?.command !== 'string' || !arg.command.trim() || arg.command.includes('\0') || arg.command.length > 16000 || (arg.timeoutMs !== undefined && (!Number.isSafeInteger(arg.timeoutMs) || arg.timeoutMs < 1000 || arg.timeoutMs > 600000))) throw new Error('终端命令或超时参数无效。');
      const run = makeRun('terminal'); run.command = arg.command; activeRun = run;
      // Reuse the validated workspace: constructing one here performs synchronous
      // disk checks and can block even the stop IPC when a volume disappears.
      const terminalTools = tools;
      terminal = new TerminalSession({ workspaceFactory: ({ onEvent }) => ({
        execute: (name, args, options) => terminalTools.execute(name, args, { ...options, onCommandOutput: onEvent }),
      }), redact, onEvent: emit });
      setTimeout(async () => {
        try { await terminal.run({ id: run.id, command: arg.command, timeoutMs: arg.timeoutMs, signal: run.controller.signal }); }
        catch (error) { emit({ type: 'terminal-end', id: run.id, status: run.controller.signal.aborted ? 'stopped' : 'failed', result: redact(error.message || '终端执行失败。') }); }
        finally {
          for (const done of [...approvals.values()]) done(false);
          await approvalController.drain(run.id);
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
  pluginRuntime?.closeOwner(win);
  promptCompletion.abort();
  sideChat.close();
  petDialog.close();
  pauseQueue('窗口正在关闭。');
  const run = activeRun;
  run?.controller.abort(); terminal?.stop();
  for (const done of [...approvals.values()]) done(false);
  if (run?.done) await run.done;
  if (fileOperationDone) await fileOperationDone;
  await promptCompletion.settled();
  await sideChat.settled();
  await petDialog.settled();
  await permissionPreferences.settled();
  await approvalReviewerPreferences.settled();
  await roleModels.settled();
  await modelCapacityPreferences.settled();
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
  async replaceDeletedSession(id, replacement) {
    if (currentSession?.id !== id) return;
    promptCompletion.abort();
    petDialog.close();
    currentSession = structuredClone(replacement); loadedSnapshot = true;
    await persistentTaskUndo.loadSession(currentSession);
    await rememberSessionSelection();
  },
  rememberSelection: rememberSessionSelection,
  activateProjectLocal,
  refreshBrowserVisibility: () => browser?.applyLayout(),
  clearFind: () => { lastFindText = null; },
  cancelEditorClose() { editorCloseRequest?.resolve(true); editorCloseRequest = null; },
  cancelPromptCompletion: () => promptCompletion.abort(),
  settlePromptCompletion: () => promptCompletion.settled(),
  settleSideChat: () => sideChat.settled(),
  closePetDialog: () => petDialog.close(),
  settlePetDialog: () => petDialog.settled(),
  pluginCanWrite: () => !shuttingDown && !quitting && !activeRun && !localOperation && !promptPreflights && !editorDirty
    && !!tools && !persistentTaskUndo.isProjectBusy(tools.root),
  runPluginMutation(operation, project, signal) {
    const pending = manualOperations.then(() => {
      signal?.throwIfAborted();
      if (host.active !== context || context.id !== project?.workspaceId || tools?.root !== project?.root || !context.pluginCanWrite())
        throw new Error('当前项目或编辑状态已变化，请重新打开插件窗口后重试。');
      return operation();
    });
    const settled = pending.then(() => {}, () => {});
    manualOperations = settled; fileOperationDone = settled;
    return pending.finally(async () => {
      if (fileOperationDone === settled) fileOperationDone = null;
      try { await broadcastAllStates(); } finally { scheduleNextPrompt(); }
    });
  },
  dispose: () => { promptCompletion.abort(); sideChat.close(); petDialog.close(); browser?.destroy(); },
  abort() { ++stopGeneration; pluginRuntime?.closeOwner(win); promptCompletion.abort(); sideChat.close(); petDialog.close(); activeRun?.controller.abort(); terminal?.stop(); for (const done of [...approvals.values()]) done(false); },
  get activeRun() { return activeRun; }, get busy() { return Boolean(activeRun || localOperation || promptPreflights || fileOperationDone || sideChat.snapshot().running); },
  get hasPendingPrompts() { return pendingPrompts.length > 0; },
  get editorDirty() { return editorDirty; },
  get hasFileOperation() { return !!fileOperationDone; },
  emit, approve, state, broadcastState, setWorkspace, createSession, shutdown, requestEditorClose, scheduleNextPrompt,
  handlers: buildHandlers(),
  async initialize({ restoreTarget = null } = {}) {
    if (!activeWindowHost) activeWindowHost = host;
    // Resolve and load before exposing IPC or the first renderer document.
    // No queued prompt, model call, terminal or browser operation is resumed.
    try {
      if (restoreTarget?.workspace) setWorkspace(restoreTarget.workspace);
      if (restoreTarget?.session) { currentSession = restoreTarget.session; loadedSnapshot = true; }
      else await createSession();
      await persistentTaskUndo.loadSession(currentSession);
    } catch {
      tools = null; fileManager = null;
      await createSession();
    }
    initialized = true;
    if (host.win) { win = host.win; initializeBrowser(); return context; }
    const palette = nativeAppearance(appearance.snapshot());
    win = new BrowserWindow({ width: 1340, height: 900, minWidth: 980, minHeight: 680, show: false, title: 'Synora code', backgroundColor: palette.background, autoHideMenuBar: true,
      ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: palette.caption, symbolColor: palette.symbol, height: 44 } } : {}),
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
    const disposeEditorContextMenu = installEditorContextMenu({ win, Menu });
    win.once('closed', disposeEditorContextMenu);
    win.webContents.on('did-start-loading', () => { for (const value of host.contexts) value.clearFind(); });
    win.webContents.on('found-in-page', (_event, result) => host.active.emit({ type: 'find-result', requestId: result.requestId, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: result.finalUpdate }));
    for (const event of ['enter-full-screen', 'leave-full-screen']) win.on(event, () => { host.active.emit({ type: 'window-state', isFullscreen: win.isFullScreen() }); host.broadcastState().catch(() => {}); });
    win.on('close', event => {
      if (updateInstalling && quitting !== true) { event.preventDefault(); return; }
      if (closeAllowed || quitting === true) return;
      if (!quitting && backgroundTray?.hideWindow(win)) { event.preventDefault(); return; }
      if (!host.busy && !host.editorDirty && !host.hasFileOperation) { host.abortAll(); shuttingDown = true; return; }
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
    win.on('focus', () => {
      activeWindowHost = host;
      host.active.rememberSelection().catch(() => {});
      host.broadcastState().catch(() => {});
    });
    win.on('closed', () => clearInterval(refresh));
    await rememberSessionSelection();
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
    if (updateInstalling && !['getAppUpdate', 'getState', 'setEditorDirty', 'installAppUpdate'].includes(name)) throw new Error('正在准备重启更新，请稍候。');
    return context.handlers[name](arg);
  });
}

async function boot() {
  if (legacyMigrationError) throw legacyMigrationError;
  // Chromium's transport follows Windows system proxy settings. Renderer pages
  // have no network access; only these main-process model requests use it.
  globalThis.fetch = net.fetch.bind(net);
  ({ WorkspaceTools, TOOL_DEFINITIONS } = await import('./core/workspace.mjs'));
  ({ createSubagentWorkspace } = await import('./core/subagent-workspace.mjs'));
  ({ reviewApproval } = await import('./core/approval-review.mjs'));
  ({ selectApprovalIntent } = await import('./core/approval-intent.mjs'));
  ({ createApprovalController } = await import('./core/approval-controller.mjs'));
  ({ createPromptCompletionController } = await import('./core/prompt-completion.mjs'));
  ({ createSideChatController } = await import('./core/side-chat.mjs'));
  ({ createPetDialogController, PET_QUESTION_TOOL } = await import('./core/pet-dialog.mjs'));
  ({ runAgent, runDemo } = await import('./core/agent.mjs'));
  ({ requestModel } = await import('./core/providers.mjs'));
  ({ TerminalSession } = await import('./core/terminal.mjs'));
  ({ ManualFileManager } = await import('./core/file-manager.mjs'));
  ({ EditorFileTargets } = await import('./core/editor-file-targets.mjs'));
  ({ normalizeImageAttachments } = await import('./core/message-images.mjs'));
  const { ModelCatalog, deriveModelCapabilities: deriveCapabilities } = await import('./core/model-catalog.mjs');
  modelCatalog = new ModelCatalog(); deriveModelCapabilities = deriveCapabilities;
  const { SettingsCatalogSelections } = await import('./core/settings-model-catalog.mjs');
  settingsCatalogSelections = new SettingsCatalogSelections();
  if (legacyMigrationSource) await migrateLegacyData(dataDir, legacyMigrationSource, { encryptionPrepared: true });
  store = new Store(dataDir, safeStorage);
  await store.init();
  const { PersistentTaskUndo } = await import('./core/persistent-task-undo.mjs');
  const { legacyTaskUndoRuns } = await import('./core/legacy-task-undo.mjs');
  persistentTaskUndo = new PersistentTaskUndo({ dataDir, safeStorage, legacyTaskUndoRuns });
  sessionRestore = await new SessionRestore(dataDir).init();
  recentProjects = new RecentProjects(dataDir);
  await recentProjects.init();
  if (recentProjects.writable && !recentProjects.list().length) {
    for (const session of (await store.listSessions()).reverse()) {
      try { await recentProjects.record(session.workspace); } catch { /* A damaged entry does not block other project history. */ }
    }
  }
  uiPreferences = new UIPreferences(dataDir);
  await uiPreferences.init();
  modelCapacityPreferences = await new ModelCapacityPreferences(dataDir).init();
  permissionPreferences = await new PermissionPreferences(dataDir).init();
  approvalReviewerPreferences = await new ApprovalReviewerPreferences(dataDir).init();
  appearance = new AppearanceStore({ dataDir, decodeImage: bytes => {
    const image = nativeImage.createFromBuffer(bytes);
    return image.isEmpty() ? null : image.getSize();
  } });
  await appearance.init();
  dshPet = await new DshPetStore({ dataDir }).init();
  pluginManager = new PluginManager({ dataDir, onChange: publishExtensions });
  await pluginManager.init();
  const { createPluginProjectAccess } = await import('./core/plugin-project.mjs');
  pluginProjectAccess = createPluginProjectAccess({ WorkspaceTools,
    getContext(request) {
      const context = pluginOwnerContext(request);
      return { ...pluginProjectInfo(request), canWrite: context.pluginCanWrite(),
        runMutation: operation => context.runPluginMutation(operation, request.project, request.signal) };
    },
    async confirmWrite({ plugin, ownerWindow, operation, signal }) {
      signal.throwIfAborted();
      const preview = text => text === null ? '（新文件）' : text.length > 6000 ? text.slice(0, 6000) + '\n…（内容较长，仅显示预览）' : text;
      const decision = await dialog.showMessageBox(ownerWindow, { type: 'question', title: '插件文件修改',
        message: `允许“${plugin.name}”写入 ${operation.path}？`,
        detail: `修改前：\n${preview(operation.before)}\n\n修改后：\n${preview(operation.after)}`,
        buttons: ['取消', '允许写入'], defaultId: 0, cancelId: 0, noLink: true, signal });
      signal.throwIfAborted(); return decision.response === 1;
    },
    onFilesChanged: request => pluginOwnerContext(request).emit({ type: 'files-changed', operation: 'save', path: request.path }),
  });
  const notifyPlugin = ({ plugin, ownerWindow, message }) => {
    const context = pluginOwnerContext({ ownerWindow });
    context.win.webContents.send('forge:event', { type: 'extension-notice', workspaceId: context.id, message: `${plugin.name}：${message}` });
  };
  pluginRuntime = createPluginRuntime({ BrowserWindow, session: electronSession, ipcMain, manager: pluginManager,
    getOwnerWindow: () => activeWindowHost?.win || win,
    getAppInfo: () => ({ name: app.getName(), version: app.getVersion(), apiVersion: 1 }), getProjectInfo: pluginProjectInfo,
    listFiles: pluginProjectAccess.listFiles, readText: pluginProjectAccess.readText, writeText: pluginProjectAccess.writeText,
    notify: notifyPlugin, onError: event => { try { notifyPlugin(event); } catch {} } });
  nativeTheme.themeSource = nativeAppearance(appearance.snapshot()).theme;
  const { ChatGPTConnection } = await import('./core/chatgpt.mjs');
  const { DeepSeekConnection } = await import('./core/deepseek-login.mjs');
  const deepseekNetwork = electronSession.fromPartition('synora-deepseek-account', { cache: false });
  const deepseekFetch = (input, options) => deepseekNetwork.fetch(input, options);
  chatgpt = new ChatGPTConnection({ dataDir, safeStorage, openExternal: url => shell.openExternal(url), onChange: () => { broadcastAllStates().catch(() => {}); } });
  await chatgpt.init();
  deepseek = new DeepSeekConnection({ dataDir, safeStorage, version: app.getVersion(), fetchImpl: deepseekFetch,
    openExternal: url => shell.openExternal(url), onChange: () => { broadcastAllStates().catch(() => {}); } });
  await deepseek.init();
  roleModels = await new RoleModels(dataDir, safeStorage).init();
  for (const role of ROLE_KEYS) {
    const account = new ChatGPTConnection({ dataDir: path.join(dataDir, 'role-accounts', role), safeStorage,
      openExternal: url => shell.openExternal(url), onChange: () => {
        publishRoleAccount(role).catch(() => {});
      } });
    roleAccounts.set(role, account); await account.init();
    const deepseekAccount = new DeepSeekConnection({ dataDir: path.join(dataDir, 'role-accounts', role), safeStorage, version: app.getVersion(), fetchImpl: deepseekFetch,
      openExternal: url => shell.openExternal(url), onChange: () => { publishRoleAccount(role, 'deepseek').catch(() => {}); } });
    roleDeepseekAccounts.set(role, deepseekAccount); await deepseekAccount.init();
  }
  const { RoleModelRuntime } = await import('./core/role-model-runtime.mjs');
  roleRuntime = new RoleModelRuntime({ configs: roleModels, accounts: roleAccounts, deepseekAccounts: roleDeepseekAccounts, catalog: modelCatalog,
    deriveCapabilities: deriveModelCapabilities, requestModel, redact });
  updateEnabled = !smoke && app.isPackaged && isInstalledBuild && process.platform === 'win32' && process.arch === 'x64';
  const updateSession = electronSession.fromPartition('synora-updates', { cache: false });
  appUpdater = new AppUpdater({ currentVersion: app.getVersion(), dataDir, enabled: updateEnabled,
    fetchImpl: createUpdateFetch({ net, session: updateSession }), onChange: publishAppUpdate });
  Menu.setApplicationMenu(null);
  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  const restoreTarget = await sessionRestore.resolve({ readSession: readSessionForContext,
    listProjectSessions: root => store.listProjectSessions(root), listSessions: () => store.listSessions() });
  primaryContext = createWindowHost({ restoreTarget });
  registerHandlers();
  await primaryContext.initialize();
  win = primaryContext.win;
  ({ setWorkspace, createSession, broadcastState } = primaryContext);
  if (!smoke || process.env.FORGEDESK_SMOKE_ONLY === 'background-tray') {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'synora-logo.png')).resize({ width: 20, height: 20 });
    backgroundTray = createBackgroundTray({ Tray, Menu, icon,
      getWindows: () => [activeWindowHost?.win, ...[...windows.values()].map(host => host.win)],
      createWindow: createAppWindow,
      onQuit() {
        for (const host of windows.values()) if (host.editorDirty) backgroundTray.showWindow(host.win);
        app.quit();
      } });
  }
  startUpdateChecks();
  startPetPointerTracking();
  if (smoke) await smokeTest();
}

async function smokeTest() {
  const output = process.env.FORGEDESK_ARTIFACT_DIR || path.join(projectDir, 'artifacts');
  await fs.mkdir(output, { recursive: true });
  if (process.env.FORGEDESK_SMOKE_ONLY === 'extensions') {
    const result = { version: app.getVersion(), extensions: await require('./core/smoke-extensions.cjs')({
      win, output, dataDir, pluginManager, pluginRuntime, dshPet, createAppWindow, dialog }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_EXTENSIONS_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'background-tray') {
    const result = { version: app.getVersion(), 'background-tray': await require('./core/smoke-background-tray.cjs')({ win, output, dataDir, backgroundTray }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_BACKGROUND_TRAY_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'role-models') {
    const result = { version: app.getVersion(), roleModels: await require('./core/smoke-role-models.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_ROLE_MODELS_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'command-stop') {
    const result = { version: app.getVersion(), commandStop: await require('./core/smoke-command-stop.cjs')({
      win, output, dataDir, configureWorkspaceTools: decorate => { WorkspaceTools = decorate(WorkspaceTools); },
    }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_COMMAND_STOP_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'updater') {
    const transport = await require('./core/smoke-update-transport.cjs')({ output, dataDir, net, electronSession });
    const configureUpdater = async options => {
      await appUpdater.dispose();
      updateEnabled = true;
      appUpdater = options.createUpdater(publishAppUpdate);
      launchInstaller = options.launchInstaller; quitForUpdate = options.quitForUpdate;
      publishAppUpdate();
      return appUpdater;
    };
    const result = { version: app.getVersion(), transport, updater: await require('./core/smoke-updater.cjs')({
      win, output, dataDir, configureUpdater, getHost: () => windows.get(win.webContents.id),
    }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_UPDATER_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'deepseek-login') {
    const result = { version: app.getVersion(), deepseekLogin: await require('./core/smoke-deepseek-login.cjs')({
      win, output, dataDir, store, readConnection: () => deepseek, writeConnection: value => { deepseek = value; },
      broadcastState: broadcastAllStates, requestModel, roleModels, roleRuntime, roleDeepseekAccounts,
    }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_DEEPSEEK_LOGIN_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (['scroll', 'permissions', 'window-chrome', 'compaction', 'operation-progress', 'prompt-completion', 'pet-dialog', 'markdown', 'command-result', 'conversation-colors', 'background-presets', 'editor-highlight', 'editor-completion', 'disclosure-motion', 'disclosure-visibility', 'image-viewed', 'explorer', 'explorer-drag', 'explorer-selection', 'usage-analytics', 'sessions', 'history-delete', 'round-usage', 'chat-selection', 'color-style', 'external-files', 'subagents', 'live-controls', 'context-settings', 'ollama', 'editor-context-menu', 'startup-restore', 'deepseek-account', 'deepseek-easter-egg', 'task-change-summary', 'persistent-undo', 'dropdown-motion', 'queue', 'pending-compact', 'tool-operation-groups', 'xml-reading', 'browser', 'ui-styles', 'accent-palette', 'round-navigator', 'reconnect'].includes(process.env.FORGEDESK_SMOKE_ONLY)) {
    const name = process.env.FORGEDESK_SMOKE_ONLY;
    const result = { version: app.getVersion(), [name]: await require(`./core/smoke-${name}.cjs`)({ win, output, dataDir, store }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_FOCUSED_UI_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'composer-approval') {
    const result = { version: app.getVersion(), composerApproval: await require('./core/smoke-composer-approval.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_COMPOSER_APPROVAL_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'code-diff') {
    const result = { version: app.getVersion(), codeDiff: await require('./core/smoke-code-diff.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_CODE_DIFF_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'task-history') {
    const result = { version: app.getVersion(), taskHistory: await require('./core/smoke-task-history.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_TASK_HISTORY_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
  if (process.env.FORGEDESK_SMOKE_ONLY === 'activity') {
    const result = { version: app.getVersion(), activity: await require('./core/smoke-activity.cjs')({ win, output, dataDir }) };
    if (rendererErrors.length) throw new Error('Renderer errors: ' + rendererErrors.join(' | '));
    await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('SYNORA_ACTIVITY_SMOKE_OK ' + JSON.stringify(result));
    app.quit(); return;
  }
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
        if (e.type === 'approval-request') queueMicrotask(() => approvals.get(e.id)?.accept?.click());
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
          if(e.type==='approval-request') queueMicrotask(() => approvals.get(e.id)?.accept?.click());
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
      if(document.getElementById('session-speed').classList.contains('unknown')||!document.getElementById('generation-speed').textContent.includes('tok/s')) throw new Error('Token speed did not render');
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
  result.pendingCompact = await require('./core/smoke-pending-compact.cjs')({ win, output, dataDir });
  result.toolOperationGroups = await require('./core/smoke-tool-operation-groups.cjs')({ win, output, dataDir });
  result.xmlReading = await require('./core/smoke-xml-reading.cjs')({ win, output, dataDir, store });
  result.largeResponse = await require('./core/smoke-large-response.cjs')({ win, output, dataDir });
  result.explorer = await require('./core/smoke-explorer.cjs')({ win, output, dataDir });
  result.activity = await require('./core/smoke-activity.cjs')({ win, output, dataDir });
  result.operationProgress = await require('./core/smoke-operation-progress.cjs')({ win, output, dataDir });
  result.promptCompletion = await require('./core/smoke-prompt-completion.cjs')({ win, output, dataDir, store });
  result.windowChrome = await require('./core/smoke-window-chrome.cjs')({ win, output, dataDir });
  result.userMessages = await require('./core/smoke-user-messages.cjs')({ win, output, dataDir });
  result.markdown = await require('./core/smoke-markdown.cjs')({ win, output });
  result.browser = await require('./core/smoke-browser.cjs')({ win, output, dataDir });
  result.permissions = await require('./core/smoke-permissions.cjs')({ win, output, dataDir });
  result.scroll = await require('./core/smoke-scroll.cjs')({ win, output, dataDir });
  result.projectSessions = await require('./core/smoke-sessions.cjs')({ win, output, dataDir });
  result.historyDelete = await require('./core/smoke-history-delete.cjs')({ win, output, dataDir, store });
  result.usageAnalytics = await require('./core/smoke-usage-analytics.cjs')({ win, output, dataDir, store });
  result.compaction = await require('./core/smoke-compaction.cjs')({ win, output, dataDir });
  result.apiProtocol = await require('./core/smoke-api-protocol.cjs')({ win, output, dataDir });
  result.parallelProjects = await require('./core/smoke-parallel-projects.cjs')({ win, output, dataDir });
  result.reasoningCapabilities = await require('./core/smoke-reasoning-capabilities.cjs')({ win, output, dataDir });
  result.liveFiles = await require('./core/smoke-live-files.cjs')({ win, output, dataDir });
  result.explorerDrag = await require('./core/smoke-explorer-drag.cjs')({ win, output, dataDir });
  result.explorerSelection = await require('./core/smoke-explorer-selection.cjs')({ win, output, dataDir });
  result.sessionMetrics = await require('./core/smoke-session-metrics.cjs')({ win, output });
  result.appearance = await require('./core/smoke-appearance.cjs')({ win, output, dataDir });
  result.conversationColors = await require('./core/smoke-conversation-colors.cjs')({ win, output, dataDir });
  result.backgroundPresets = await require('./core/smoke-background-presets.cjs')({ win, output, dataDir });
  result.uiStyles = await require('./core/smoke-ui-styles.cjs')({ win, output, dataDir });
  result.accentPalette = await require('./core/smoke-accent-palette.cjs')({ win, output, dataDir });
  result.roundNavigator = await require('./core/smoke-round-navigator.cjs')({ win, output, dataDir });
  result.editorHighlight = await require('./core/smoke-editor-highlight.cjs')({ win, output, dataDir });
  result.editorCompletion = await require('./core/smoke-editor-completion.cjs')({ win, output, dataDir });
  result.taskHistory = await require('./core/smoke-task-history.cjs')({ win, output, dataDir });
  result.taskChangeSummary = await require('./core/smoke-task-change-summary.cjs')({ win, output, dataDir, store });
  result.subagents = await require('./core/smoke-subagents.cjs')({ win, output, dataDir, store });
  result.liveControls = await require('./core/smoke-live-controls.cjs')({ win, output, dataDir, store });
  result.contextSettings = await require('./core/smoke-context-settings.cjs')({ win, output, dataDir, store });
  result.ollama = await require('./core/smoke-ollama.cjs')({ win, output, dataDir, store });
  result.editorContextMenu = await require('./core/smoke-editor-context-menu.cjs')({ win, output, dataDir, store });
  result.deepseekAccount = await require('./core/smoke-deepseek-account.cjs')({ win, output, dataDir, store });
  result.codeDiff = await require('./core/smoke-code-diff.cjs')({ win, output, dataDir });
  result.disclosureMotion = await require('./core/smoke-disclosure-motion.cjs')({ win, output, dataDir });
  result.disclosureVisibility = await require('./core/smoke-disclosure-visibility.cjs')({ win, output, dataDir });
  result.imageViewed = await require('./core/smoke-image-viewed.cjs')({ win, output, dataDir, store });
  result.commandResult = await require('./core/smoke-command-result.cjs')({ win, output, dataDir });
  result.composerApproval = await require('./core/smoke-composer-approval.cjs')({ win, output, dataDir });
  result.reconnect = await require('./core/smoke-reconnect.cjs')({ win, output, dataDir, store });
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
app.on('window-all-closed', () => { if (!backgroundTray?.snapshot().available || quitting) app.quit(); });
app.on('activate', () => { if (backgroundTray) void backgroundTray.show(); });
app.on('will-quit', () => {
  clearTimeout(updateTimer); clearInterval(updateInterval);
  clearInterval(petPointerTimer);
  backgroundTray?.dispose();
  void deepseek?.dispose();
  for (const account of roleDeepseekAccounts.values()) void account.dispose();
  pluginRuntime?.dispose();
  void appUpdater?.dispose();
});
app.on('before-quit', event => {
  if (updateInstalling && quitting !== true) { event.preventDefault(); return; }
  if (quitting === true) return;
  if (quitting === 'pending') { event.preventDefault(); return; }
  if (![...windows.values()].some(context => context.busy || context.editorDirty || context.hasFileOperation)) {
    cancelAccountSignIns();
    if (sessionRestore?.pending || persistentTaskUndo?.pending || sharedMutations || pluginManager || dshPet) {
      event.preventDefault(); quitting = 'pending';
      Promise.all([sessionRestore?.flush(), persistentTaskUndo?.flush(), roleModels?.settled(), modelCapacityPreferences?.settled(), pluginManager?.settled(), dshPet?.settled(), sharedQueue]).finally(() => { quitting = true; app.quit(); });
    }
    return;
  }
  event.preventDefault(); quitting = 'pending';
  const contexts = [...windows.values()];
  Promise.all(contexts.map(context => context.requestEditorClose('quit'))).then(async allowed => {
    if (allowed.some(value => !value)) {
      quitting = false;
      for (const context of contexts) context.scheduleNextPrompt();
      return;
    }
    cancelAccountSignIns();
    await Promise.allSettled(contexts.map(context => context.shutdown()));
    await sessionRestore?.flush();
    await persistentTaskUndo?.flush();
    await pluginManager?.settled();
    await dshPet?.settled();
    await modelCapacityPreferences?.settled();
    quitting = true; app.quit();
  }).catch(() => { quitting = false; for (const context of contexts) context.scheduleNextPrompt(); });
});
