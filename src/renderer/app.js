'use strict';

const $ = (id) => document.getElementById(id);
const bridge = window.forge;
const providerNames = { openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Claude', relay: '中转站' };
const reasoningOptions = {
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  deepseek: ['none', 'low', 'high', 'max'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  relay: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
};
const reasoningLabels = { default: '默认', none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' };
const chatgptStorageMessages = {
  storage_decryption_failed: '无法解密本机保存的 ChatGPT 登录信息。原凭据已保留，请先重试读取；仍失败时可退出本机登录后重新连接。',
  storage_encrypted_invalid: '本机保存的 ChatGPT 登录信息格式无效或已损坏。原凭据已保留，可先重试读取，或退出本机登录后重新连接。',
  storage_provider_mismatch: '本机登录信息的加密方式与当前版本不匹配。原凭据已保留，请先重试读取，或退出本机登录后重新连接。',
  storage_invalid: '无法读取本机保存的 ChatGPT 登录信息。原凭据已保留，请先重试读取，或退出本机登录后重新连接。',
  storage_encryption_unavailable: '系统安全存储暂不可用。原凭据已保留，请解锁系统密钥存储后重试读取。'
};
let appState = null;
let running = false;
let selectedPath = null;
let selectedRow = null;
let sessionId = null;
let streamedMessage = null;
let streamedText = '';
let changes = [];
let pendingTools = [];
let commandOutput = null;
let followOutput = true;
let filesRequest = 0;
let sessionRequest = 0;
let reasoningSaving = false;
let latestTelemetry = null;
let taskActivityTimer = null;
let activeTaskActivity = null;
let settingsSaving = false;
let chatgptBusy = false;
let chatgptAction = null;
let chatgptCancelling = false;
let chatgptLocalError = '';
let chatgptUsageProfileId = null;
let chatgptUsagePositionRule = null;
let chatgptUsageTimer = null;
let chatgptUsageOpening = false;
let currentCatalog = null;
let currentCatalogKey = '';
let catalogRequest = 0;
let catalogLoading = false;
let catalogError = '';
let settingsCatalog = null;
let settingsCatalogDraft = null;
let settingsCatalogRequest = 0;
let settingsCatalogLoading = false;
let settingsCatalogError = '';
let modelSaving = false;
let sidebarWidth = 208;
let sidebarPreferredWidth = 208;
let sidebarDrag = null;
let sidebarSizeRule = null;
let textScaleRule = null;
let textScale = 100;
let textScaleDesired = 100;
let textScaleConfirmed = 100;
let textScaleIntent = 0;
let textScaleSavedIntent = 0;
let textScalePending = false;
let textScaleSaveTimer = null;
let terminalRunning = false;
let terminalCurrentId = null;
let taskDemo = false;
let taskKind = null;
let promptSubmitting = false;
let pendingResuming = false;
let taskStateVersion = 0;
let promptQueueVersion = 0;
let promptQueue = { items: [], paused: false, reason: null };
const pendingPromptActions = new Set();
const renderedUserMessageIds = new Set();
const terminalRuns = new Map();
let previewPinned = false;
let navigationEntries = [];
let navigationIndex = -1;
let navigationReplaying = false;
let findRequestId = null;
let findTimer = null;
let selectedEntry = null;
let editorVersion = null;
let editorOriginal = '';
let editorDirty = false;
let editorSaving = false;
let editorSaveTimer = null;
let editorSavePromise = null;
let editorAutoSavePaused = false;
let editorSaveError = '';
let editorDocumentEpoch = 0;
let editorReadRequest = 0;
let fileMutationBusy = false;
let projectSwitching = false;
let fileClipboard = null;
let fileNameRequest = null;
let unsavedDecision = null;
let editorWidth = 470;
let editorSizeRule = null;
const expandedDirectories = new Set();
const chatgptDisabledControls = new Map();
const approvals = new Map();
let browserController, permissionControls, sessionControls;
let contextCompacting = false;
const contextCompactionNotices = new Set();
const workspaceDrafts = new Map();
let restoringWorkspace = false;
let draftAttachments = [];
let draftAttachmentSequence = 0;
const IMAGE_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function errorText(error) {
  const message = error?.message || String(error || '操作失败，请重试。');
  return message.replace(/^Error invoking remote method ['"]forge:[^'"]+['"]:\s*(?:(?:Error|FileManagerError|ImageAttachmentError):\s*)?/u, '');
}

function notice(message, error = false) {
  $('notice-text').textContent = error && !String(message).startsWith('错误') ? `错误：${message}` : message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}

function scrollBottom(force = false) {
  if (force || followOutput) $('message-scroll').scrollTop = $('message-scroll').scrollHeight;
}

function showConversation() {
  $('welcome').hidden = true;
}

function safeString(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}

function baseName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path || '';
}

function workspacePath(workspace) {
  return typeof workspace === 'string' ? workspace : workspace?.root || '';
}

function workspaceIdentity(workspace) {
  return workspacePath(workspace).replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');
}

function conversationTitle(session) {
  const workspace = workspacePath(session?.workspace) || workspacePath(appState?.workspace);
  return workspace ? baseName(workspace) : session?.title || '新的对话';
}

function notifyMenuState() {
  if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('aicode-ui-change'));
}

function syncWindowChrome() {
  const root = document.documentElement;
  root.classList.toggle('window-fullscreen', appState?.isFullscreen === true);
  let visible = false;
  try {
    const overlay = typeof navigator === 'undefined' ? null : navigator.windowControlsOverlay;
    visible = overlay?.visible === true && Number(overlay.getTitlebarAreaRect?.()?.width) > 0;
  } catch { /* Older runtimes use the fixed caption-button reservation. */ }
  root.classList.toggle('window-controls-visible', visible);
}

function contextBusy() {
  return running || terminalRunning || promptSubmitting || pendingResuming || promptQueue.items.length > 0 || fileMutationBusy || projectSwitching;
}

function projectTransitionBusy() {
  return projectSwitching || fileMutationBusy || editorSaving || promptSubmitting || pendingResuming
    || settingsSaving || reasoningSaving || modelSaving || navigationReplaying || Boolean(fileNameRequest || unsavedDecision)
    || draftAttachments.some(attachment => attachment.loading);
}

function fileOperationBusy({ allowSaving = false, allowDialog = false, allowNavigation = false } = {}) {
  return fileMutationBusy || (!allowSaving && editorSaving) || projectSwitching || promptSubmitting || pendingResuming
    || settingsSaving || (!allowNavigation && navigationReplaying) || (!allowDialog && Boolean(fileNameRequest || unsavedDecision)) || isChatGPTBusy();
}

function currentWorkspaceId() { return appState?.workspaceId || ''; }

function belongsToCurrentWorkspace(value) {
  return !value?.workspaceId || !currentWorkspaceId() || value.workspaceId === currentWorkspaceId();
}

function saveWorkspaceDraft() {
  const key = currentWorkspaceId() || workspaceIdentity(appState?.workspace);
  if (!key) return;
  workspaceDrafts.set(key, { text: $('task-input').value, attachments: draftAttachments, terminal: $('terminal-input').value });
}

function restoreWorkspaceDraft() {
  const draft = workspaceDrafts.get(currentWorkspaceId() || workspaceIdentity(appState?.workspace));
  $('task-input').value = draft?.text || '';
  $('terminal-input').value = draft?.terminal || '';
  draftAttachments = draft?.attachments || [];
  renderDraftAttachments();
}

function activateWorkspace(state, session) {
  if (!state) return;
  closeChatGPTUsage();
  if (fileNameRequest) answerFileName(null);
  saveWorkspaceDraft();
  ++filesRequest;
  ++sessionRequest;
  ++editorReadRequest;
  invalidateCatalogs();
  closeReasoningPopup();
  closeProjectDropdown();
  sessionControls?.close();
  browserController?.reset();
  clearInterval(taskActivityTimer);
  taskActivityTimer = null;
  running = false;
  terminalRunning = false;
  taskKind = null;
  terminalCurrentId = null;
  terminalRuns.clear();
  $('terminal-output').replaceChildren();
  $('terminal-status').textContent = '尚未运行';
  $('notice').hidden = true;
  setTerminalOpen(false);
  showPreviewTab('file');
  clearConversation();
  sessionId = state.sessionId || session?.id || null;
  followOutput = true;
  updateState(state, { allowWorkspaceChange: true });
  const active = state.activeTask;
  const live = Array.isArray(active?.liveEvents) ? active.liveEvents : [];
  if (session?.id) {
    const snapshot = live.length && Number.isInteger(active.messageStartIndex) ? {
      ...session,
      messages: session.messages?.slice(0, active.messageStartIndex + 1),
      events: session.events?.filter(event => event.runId !== active.runId)
    } : session;
    renderSessionSnapshot(snapshot);
  }
  restoringWorkspace = true;
  try {
    for (const event of state.terminalEvents || []) handleTerminalEvent(event);
    for (const event of live) if (!event.type?.startsWith('terminal-')) handleEvent({ ...event, workspaceId: state.workspaceId });
    if (!live.length && active?.streamText) handleEvent({ type: 'text-delta', text: active.streamText, replace: true, workspaceId: state.workspaceId });
  } finally { restoringWorkspace = false; }
  for (const event of state.pendingApprovals || []) if (!approvals.has(event.id)) approvalRequest(event);
  if (active?.telemetry) updateTelemetry(active.telemetry);
  if (state.activeTask?.compacting) setTaskActivityPhase('compacting', '正在压缩上下文…');
  if (!state.activeTask?.running) {
    $('run-status').textContent = '准备就绪';
    $('run-status').classList.remove('running');
  }
  restoreWorkspaceDraft();
  refreshControlLocks();
  scrollBottom(true);
}

function canSteerPrompt() {
  return running && taskKind === 'agent' && !terminalRunning && !taskDemo;
}

function syncPromptQueue(queue) {
  if (!queue || !Array.isArray(queue.items)) return;
  promptQueue = {
    items: queue.items.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string').map((item) => ({ id: item.id, text: item.text, attachments: messageImageAttachments(item.attachments).map((attachment) => ({ name: attachment.name, mediaType: attachment.mediaType, dataUrl: attachment.src })), mode: item.mode === 'steer' ? 'steer' : 'queue' })),
    paused: queue.paused === true,
    reason: typeof queue.reason === 'string' ? queue.reason : null
  };
  if (appState) appState = { ...appState, promptQueue };
  renderPendingPrompts();
  refreshControlLocks();
}

function renderPendingPrompts() {
  const list = $('pending-items');
  const expanded = new Set([...list.querySelectorAll('details[open]')].map((node) => node.closest('[data-prompt-id]')?.dataset.promptId));
  list.replaceChildren();
  $('pending-prompts').hidden = promptQueue.items.length === 0;
  $('pending-count').textContent = `待发送 ${promptQueue.items.length}`;
  $('pending-status').textContent = promptQueue.paused ? `已暂停${promptQueue.reason ? ` · ${promptQueue.reason}` : ' · 请确认后继续'}` : '未发送内容不计入用量';
  $('pending-status').title = $('pending-status').textContent;
  $('resume-pending').hidden = !promptQueue.paused || promptQueue.items.length === 0;
  $('resume-pending').disabled = running || terminalRunning || promptSubmitting || pendingResuming || isChatGPTBusy();
  for (const item of promptQueue.items) {
    const card = element('article', `pending-prompt${item.mode === 'steer' ? ' steering' : ''}`);
    card.dataset.promptId = item.id;
    card.dataset.mode = item.mode;
    const heading = element('div', 'pending-prompt-heading');
    heading.append(element('span', 'pending-prompt-mode', item.mode === 'steer' ? '待引导 · 当前请求结束后继续' : '待发送 · 回复结束后自动发送'));
    const actions = element('div', 'pending-prompt-actions');
    if (item.mode === 'queue') {
      const steer = element('button', 'pending-steer', '引导');
      steer.type = 'button';
      steer.disabled = !canSteerPrompt() || pendingPromptActions.has(item.id) || isChatGPTBusy();
      steer.title = canSteerPrompt() ? '转为当前任务下一轮的补充，不中断模型请求' : '当前任务运行时可转为引导';
      steer.addEventListener('click', () => managePendingPrompt(item.id, 'steer'));
      actions.append(steer);
    }
    const remove = element('button', 'pending-remove', item.mode === 'steer' ? '取消' : '删除');
    remove.type = 'button';
    remove.disabled = pendingPromptActions.has(item.id) || isChatGPTBusy();
    remove.setAttribute('aria-label', item.mode === 'steer' ? '取消此条待引导内容' : '删除此条待发送内容');
    remove.addEventListener('click', () => managePendingPrompt(item.id, 'remove'));
    actions.append(remove);
    heading.append(actions);
    card.append(heading);
    const attachments = messageImageAttachments(item.attachments);
    if (attachments.length) {
      const gallery = element('div', 'pending-attachments');
      gallery.append(element('span', 'pending-attachment-count', `${attachments.length} 张图片`));
      attachments.forEach((attachment) => gallery.append(createMessageImage(attachment, 'pending-attachment-image')));
      card.append(gallery);
    }
    if (item.text.length > 220) {
      const details = element('details', 'pending-content');
      details.open = expanded.has(item.id);
      const summary = element('summary');
      summary.append(element('span', 'pending-summary', `${item.text.slice(0, 140)}…`), element('span', 'pending-collapse', '收起全文'));
      details.append(summary, element('pre', 'pending-text', item.text));
      card.append(details);
    } else card.append(element('pre', 'pending-text', item.text));
    list.append(card);
  }
}

async function managePendingPrompt(id, action) {
  if (pendingPromptActions.has(id) || isChatGPTBusy() || (action === 'steer' && !canSteerPrompt())) return;
  pendingPromptActions.add(id);
  renderPendingPrompts();
  try {
    const result = await bridge.managePendingPrompt({ id, action });
    if (result?.settings) updateState(result);
    else if (result?.queue || result?.promptQueue) syncPromptQueue(result.queue || result.promptQueue);
  } catch (error) { notice(errorText(error), true); }
  finally { pendingPromptActions.delete(id); renderPendingPrompts(); refreshControlLocks(); }
}

async function resumePendingPrompts() {
  if (!promptQueue.paused || !promptQueue.items.length || running || terminalRunning || promptSubmitting || pendingResuming || isChatGPTBusy()) return;
  pendingResuming = true;
  refreshControlLocks();
  renderPendingPrompts();
  try {
    const result = await bridge.resumePendingPrompts();
    if (result?.settings) updateState(result);
    else if (result?.queue || result?.promptQueue) syncPromptQueue(result.queue || result.promptQueue);
  } catch (error) { notice(errorText(error), true); }
  finally { pendingResuming = false; refreshControlLocks(); renderPendingPrompts(); }
}

function recordNavigation(entry) {
  if (navigationReplaying) return;
  const current = navigationEntries[navigationIndex];
  if (current && current.type === entry.type && current.id === entry.id && current.path === entry.path && workspaceIdentity(current.workspace) === workspaceIdentity(entry.workspace)) return;
  navigationEntries = navigationEntries.slice(0, navigationIndex + 1);
  navigationEntries.push(entry);
  if (navigationEntries.length > 100) navigationEntries.shift();
  navigationIndex = navigationEntries.length - 1;
  notifyMenuState();
}

async function navigateHistory(direction) {
  if (contextBusy() || isChatGPTBusy()) return;
  if (!(await confirmEditorTransition())) return;
  const next = navigationIndex + direction;
  if (next < 0 || next >= navigationEntries.length) return;
  const previous = navigationIndex;
  const entry = navigationEntries[next];
  navigationReplaying = true;
  navigationIndex = next;
  try {
    if (entry.type === 'session') {
      const session = await bridge.getSession({ id: entry.id });
      renderSessionSnapshot(session);
    } else {
      if (workspaceIdentity(entry.workspace) !== workspaceIdentity(appState?.workspace)) {
        if (!entry.sessionId) throw new Error('此文件属于另一个项目，请先打开对应项目。');
        const session = await bridge.getSession({ id: entry.sessionId });
        renderSessionSnapshot(session);
      }
      if (!(await previewFile(entry.path, null, { allowNavigation: true }))) navigationIndex = previous;
    }
  } catch (error) { navigationIndex = previous; notice(errorText(error), true); }
  finally { navigationReplaying = false; notifyMenuState(); }
}

function toggleSidebar() {
  document.documentElement.classList.toggle('sidebar-hidden');
  notifyMenuState();
}

function setPreviewPinned(value) {
  const browserActive = !$('browser-preview').hidden;
  previewPinned = !!value;
  document.documentElement.classList.toggle('preview-pinned', previewPinned);
  $('preview-pin').setAttribute('aria-pressed', String(previewPinned));
  $('preview-pin').title = previewPinned ? '改为浮动面板' : '将摘要固定到右侧';
  setPreviewOpen(true);
  showPreviewTab(browserActive ? 'browser' : 'changes');
  notifyMenuState();
}

function switchEditorFocus() {
  if (!$('preview-panel').hidden && $('preview-panel').contains(document.activeElement)) $('task-input').focus();
  else {
    setPreviewOpen(true);
    if (!$('file-preview').hidden) $('file-content').focus();
    else $('file-preview-tab').focus();
  }
}

function cyclePreviewTab(direction) {
  const file = $('file-preview-tab').classList.contains('active');
  const tabs = ['file', 'changes', 'browser'];
  const next = (tabs.indexOf(file ? 'file' : 'changes') + direction + tabs.length) % tabs.length;
  setPreviewOpen(true);
  showPreviewTab(tabs[next]);
  $(tabs[next] === 'file' ? 'file-preview-tab' : 'changes-preview-tab').focus();
}

function navigateSidebarItem(direction) {
  if (fileOperationBusy()) return;
  const entries = [...document.querySelectorAll('#file-tree .file-row')].filter((entry) => entry.getClientRects().length);
  if (!entries.length) return;
  const selected = entries.findIndex((entry) => entry === document.activeElement || entry.classList.contains('selected') || entry.classList.contains('active'));
  const index = selected < 0 ? direction > 0 ? 0 : entries.length - 1 : (selected + direction + entries.length) % entries.length;
  entries[index].focus();
  entries[index].click();
}

function setTerminalOpen(open, focus = false) {
  $('terminal-panel').hidden = !open;
  if (open && focus && !$('terminal-input').disabled) $('terminal-input').focus();
  notifyMenuState();
}

function ensureTerminalRun(id, command = '') {
  let run = terminalRuns.get(id);
  if (!run) {
    const block = element('article', 'terminal-run-block');
    const heading = element('div', 'terminal-command', command ? `PS > ${command}` : 'PowerShell');
    const output = element('pre', 'terminal-run-output');
    output.tabIndex = 0;
    const result = element('div', 'terminal-run-result');
    block.append(heading, output, result);
    run = { id, block, heading, output, result, text: '', clearedPrefix: '' };
    terminalRuns.set(id, run);
    while (terminalRuns.size > 20) {
      const oldest = terminalRuns.keys().next().value;
      terminalRuns.get(oldest).block.remove();
      terminalRuns.delete(oldest);
    }
  }
  if (!run.block.isConnected) $('terminal-output').append(run.block);
  return run;
}

function terminalSnapshot(event) {
  const run = ensureTerminalRun(event.id);
  const text = String(event.text || '');
  run.text = text;
  if (run.clearedPrefix && !text.startsWith(run.clearedPrefix)) run.clearedPrefix = text;
  run.output.textContent = run.clearedPrefix ? text.slice(run.clearedPrefix.length) : text;
  $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
}

function handleTerminalEvent(event) {
  if (event.type === 'terminal-start') {
    terminalRunning = true;
    terminalCurrentId = event.id;
    setTerminalOpen(true);
    ensureTerminalRun(event.id, event.command || event.text || '');
    $('terminal-status').textContent = '执行中';
    $('run-status').textContent = '终端执行中';
  } else if (event.type === 'terminal-output') terminalSnapshot(event);
  else if (event.type === 'terminal-end') {
    const run = ensureTerminalRun(event.id);
    const labels = { completed: '已完成', failed: '执行失败', stopped: '已停止', denied: '未执行' };
    const message = typeof event.result?.message === 'string' ? event.result.message : typeof event.result?.error === 'string' ? event.result.error : '';
    run.result.textContent = `${labels[event.status] || '已结束'}${event.exitCode !== null && event.exitCode !== undefined ? ` · 退出代码 ${event.exitCode}` : ''}${message ? ` · ${message}` : ''}`;
    if (terminalCurrentId === event.id || !terminalCurrentId) {
      terminalRunning = false;
      terminalCurrentId = null;
      $('terminal-status').textContent = labels[event.status] || '已结束';
      $('run-status').textContent = '准备就绪';
      for (const approval of approvals.values()) approval.actions.replaceWith(element('div', 'approval-resolved', '终端任务已结束，此请求已失效'));
      approvals.clear();
      if (!restoringWorkspace) {
        refreshSelectedFile();
        if (appState?.workspace) loadFiles();
      }
    }
  }
  refreshControlLocks();
  notifyMenuState();
}

async function runTerminal(event) {
  event?.preventDefault();
  if (contextBusy() || isChatGPTBusy()) return;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
  const command = $('terminal-input').value.trim();
  if (!command) return;
  if (!appState?.workspace) { notice('请先打开项目，再运行终端命令。'); return; }
  const workspaceId = currentWorkspaceId();
  terminalRunning = true;
  $('terminal-status').textContent = '正在启动…';
  refreshControlLocks();
  notifyMenuState();
  try {
    const result = await bridge.runTerminal({ command });
    if (workspaceId !== currentWorkspaceId()) return;
    if (!terminalCurrentId && terminalRunning) terminalCurrentId = result?.id || null;
    $('terminal-input').value = '';
  } catch (error) {
    if (workspaceId !== currentWorkspaceId()) return;
    terminalRunning = false;
    terminalCurrentId = null;
    $('terminal-status').textContent = '未启动';
    notice(errorText(error), true);
    refreshControlLocks();
    notifyMenuState();
  }
}

function clearTerminalOutput() {
  const current = terminalCurrentId ? terminalRuns.get(terminalCurrentId) : null;
  $('terminal-output').replaceChildren();
  for (const [id, run] of terminalRuns) {
    if (run === current) {
      run.clearedPrefix = run.text;
      run.output.textContent = '';
      run.heading.hidden = true;
      run.result.textContent = '';
    } else terminalRuns.delete(id);
  }
}

function showFindBar() {
  $('find-bar').hidden = false;
  $('find-input').focus();
  $('find-input').select();
}

async function requestFind(forward = true, newSearch = true) {
  clearTimeout(findTimer);
  const text = $('find-input').value;
  if (!text) { await bridge.stopFind(); $('find-result').textContent = ''; findRequestId = null; return; }
  try {
    const result = await bridge.findText({ text, forward, findNext: newSearch });
    findRequestId = typeof result === 'number' ? result : result?.requestId ?? null;
  } catch (error) { $('find-result').textContent = '查找失败'; notice(errorText(error), true); }
}

async function closeFindBar() {
  clearTimeout(findTimer);
  $('find-bar').hidden = true;
  findRequestId = null;
  await bridge.stopFind();
  $('task-input').focus();
}

function showLinkDialog() {
  $('link-error').hidden = true;
  if (!$('link-dialog').open) $('link-dialog').showModal();
  $('link-input').focus();
}

async function openEnteredLink(event) {
  event.preventDefault();
  try {
    const url = new URL($('link-input').value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不含用户名和密码的 HTTP 或 HTTPS 地址。');
    await browserController.open({ url: url.href });
    $('link-dialog').close();
  } catch (error) { $('link-error').textContent = errorText(error); $('link-error').hidden = false; }
}

function normalizeTextScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) ? Math.min(160, Math.max(80, Math.round(scale / 10) * 10)) : 100;
}

function applyTextScale(value) {
  textScale = normalizeTextScale(value);
  if (textScaleRule) textScaleRule.style.setProperty('--text-scale', String(textScale / 100));
  document.documentElement.dataset.textScale = String(textScale);
}

function syncTextScaleState(value) {
  // The local intent wins over older state snapshots for this window's lifetime.
  // A fresh window has no local intent and restores the persisted preference.
  if (textScaleIntent) return;
  textScaleConfirmed = normalizeTextScale(value);
  textScaleDesired = textScaleConfirmed;
  applyTextScale(textScaleConfirmed);
}

async function flushTextScale() {
  if (textScalePending || textScaleSavedIntent >= textScaleIntent) return;
  const intent = textScaleIntent;
  const scale = textScaleDesired;
  textScalePending = true;
  try {
    if (typeof bridge?.setTextScale !== 'function') throw new Error('当前版本尚未提供文字大小保存功能。');
    const state = await bridge.setTextScale({ scale });
    textScaleConfirmed = normalizeTextScale(state?.textScale ?? scale);
    textScaleSavedIntent = Math.max(textScaleSavedIntent, intent);
    if (textScaleIntent === intent) {
      textScaleDesired = textScaleConfirmed;
      applyTextScale(textScaleConfirmed);
    }
    if (state?.settings) updateState(state);
  } catch (error) {
    textScaleSavedIntent = Math.max(textScaleSavedIntent, intent);
    if (textScaleIntent === intent) {
      textScaleDesired = textScaleConfirmed;
      applyTextScale(textScaleConfirmed);
    }
    notice(`文字大小保存失败：${errorText(error)}`, true);
  } finally {
    textScalePending = false;
    if (textScaleSavedIntent < textScaleIntent && !textScaleSaveTimer) flushTextScale();
  }
}

function requestTextScale(value) {
  const scale = normalizeTextScale(value);
  if (scale === textScaleDesired) return;
  textScaleDesired = scale;
  ++textScaleIntent;
  applyTextScale(scale);
  clearTimeout(textScaleSaveTimer);
  textScaleSaveTimer = setTimeout(() => { textScaleSaveTimer = null; flushTextScale(); }, 80);
}

function initializeTextScaling() {
  document.documentElement.classList.add('text-scaling');
  const visitRules = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText === ':root.text-scaling') textScaleRule = rule;
      if (rule.style) {
        const size = rule.style.getPropertyValue('font-size').trim();
        if (/^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(size)) {
          const priority = rule.style.getPropertyPriority('font-size');
          rule.style.setProperty('font-size', `calc(${size} * var(--text-scale, 1))`, priority);
        }
      }
      if (rule.cssRules) visitRules(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { visitRules(sheet.cssRules); } catch { /* Only this document's own readable stylesheets participate. */ }
  }
  applyTextScale(100);
  document.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (event.deltaY) requestTextScale(textScaleDesired + (event.deltaY < 0 ? 10 : -10));
  }, { passive: false });
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && !event.altKey && (event.key === '0' || event.code === 'Numpad0')) {
      event.preventDefault();
      requestTextScale(100);
    }
  });
}

function currentAuthMode(settings = appState?.settings || {}) {
  return settings.provider === 'openai' && (settings.authMode || settings.providers?.openai?.authMode) === 'chatgpt' ? 'chatgpt' : 'apiKey';
}

function catalogIdentity(provider, authMode, state = appState) {
  const config = state?.settings?.providers?.[provider] || {};
  const account = provider === 'openai' && authMode === 'chatgpt';
  return JSON.stringify([provider, authMode, account ? '' : config.baseUrl || '', account ? state?.chatgpt?.session?.profileId || '' : !!config.hasKey, account ? state?.chatgpt?.session?.status || '' : '', account ? !!state?.chatgpt?.session?.sharing : false]);
}

function activeCatalogIdentity(state = appState) {
  return catalogIdentity(state?.settings?.provider || 'openai', currentAuthMode(state?.settings), state);
}

function normalizeCatalog(value, provider, authMode) {
  if (!value || !Array.isArray(value.models) || value.provider !== provider || value.authMode !== authMode) throw new Error('模型目录与当前连接不匹配，请刷新后重试。');
  return { ...value, models: value.models.filter((model) => model && typeof model.id === 'string' && model.id).map((model) => ({ ...model, displayName: typeof model.displayName === 'string' && model.displayName ? model.displayName : model.id })) };
}

function invalidateSettingsCatalog() {
  ++settingsCatalogRequest;
  settingsCatalog = null;
  settingsCatalogDraft = null;
  settingsCatalogError = '';
  settingsCatalogLoading = false;
  if ($('settings-error')) $('settings-error').hidden = true;
}

function invalidateCatalogs() {
  ++catalogRequest;
  currentCatalog = null;
  currentCatalogKey = '';
  catalogLoading = false;
  catalogError = '';
  invalidateSettingsCatalog();
}

function savedConnectionReady(provider, authMode) {
  if (provider === 'openai' && authMode === 'chatgpt') return appState?.chatgpt?.session?.status === 'connected' && appState?.chatgpt?.session?.sharing === true;
  return appState?.settings?.providers?.[provider]?.hasKey === true;
}

function modelSettingsDraft() {
  const provider = $('provider-select').value;
  const authMode = selectedAuthMode();
  const draft = { provider, authMode };
  if (authMode === 'apiKey') {
    Object.assign(draft, { baseUrl: $('base-url-input').value.trim(), apiKey: $('api-key-input').value.trim(), clearKey: $('clear-key-input').checked });
    if (['openai', 'relay'].includes(provider)) draft.apiProtocol = $('api-protocol-select').value;
  }
  return draft;
}

function modelSettingsDraftSnapshot() {
  const draft = modelSettingsDraft();
  const session = appState?.chatgpt?.session;
  return { ...draft, profileId: draft.authMode === 'chatgpt' ? session?.profileId || '' : '', accountStatus: draft.authMode === 'chatgpt' ? session?.status || '' : '', sharing: draft.authMode === 'chatgpt' && session?.sharing === true };
}

function settingsCatalogMatches() {
  if (!settingsCatalog || !settingsCatalogDraft || typeof settingsCatalog.selectionToken !== 'string' || !settingsCatalog.selectionToken) return false;
  const expiry = typeof settingsCatalog.expiresAt === 'number' ? settingsCatalog.expiresAt : Date.parse(settingsCatalog.expiresAt);
  if (settingsCatalog.expiresAt !== undefined && (!Number.isFinite(expiry) || expiry <= Date.now())) return false;
  const current = modelSettingsDraftSnapshot();
  return Object.keys(current).length === Object.keys(settingsCatalogDraft).length
    && Object.keys(current).every(key => current[key] === settingsCatalogDraft[key]);
}

function selectedSettingsModel() {
  return settingsCatalogMatches() ? settingsCatalog.models.find(model => model.id === $('chatgpt-model-select').value && model.compatible !== false && model.supportsTools !== false) : undefined;
}

function selectedModelMetadata() {
  return currentCatalogKey === activeCatalogIdentity() ? currentCatalog?.models.find((model) => model.id === appState?.settings?.model) : undefined;
}

function reasoningSpec(range, provider) {
  const model = selectedModelMetadata();
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const known = Array.isArray(model?.reasoningEfforts);
  const options = known ? [...new Set(model.reasoningEfforts.filter((effort) => order.includes(effort)))].sort((a, b) => order.indexOf(a) - order.indexOf(b)) : reasoningOptions[provider] || reasoningOptions.openai;
  return { options, known, defaultEffort: model?.defaultReasoningEffort };
}

function rangeOptions(range) {
  try { if (Array.isArray(JSON.parse(range.dataset.options || 'null'))) return JSON.parse(range.dataset.options); } catch { /* Use generic provider levels until the catalogue supplies model capabilities. */ }
  return reasoningOptions[range.dataset.provider] || reasoningOptions.openai;
}

function reasoningAvailable(range) {
  return range.dataset.support !== 'none' && rangeOptions(range).length > 0;
}

function renderComposerModel() {
  const settings = appState?.settings || {};
  const id = settings.model || settings.providers?.[settings.provider]?.model || '';
  const metadata = selectedModelMetadata();
  const name = metadata?.displayName || id || '选择模型';
  $('composer-model-name').textContent = name;
  $('popup-model-name').textContent = name;
  $('composer-model-name').title = id;
  $('popup-model-button').title = id || '打开模型目录';
  const effort = $('reasoning-effort').dataset.effort || 'default';
  $('composer-reasoning-label').textContent = reasoningAvailable($('reasoning-effort')) ? reasoningLabels[effort] || '默认' : '不可用';
  $('composer-reasoning-label').classList.toggle('is-unavailable', !reasoningAvailable($('reasoning-effort')));
  $('composer-reasoning-label').classList.toggle('is-max', $('reasoning-effort').classList.contains('is-max'));
}

function renderModelList() {
  const list = $('model-list');
  list.replaceChildren();
  const query = $('model-search').value.trim().toLocaleLowerCase();
  const models = currentCatalog?.models || [];
  const visible = models.filter((model) => `${model.id} ${model.displayName}`.toLocaleLowerCase().includes(query));
  const selected = appState?.settings?.model || '';
  let message = catalogLoading ? '正在获取模型目录…' : catalogError;
  if (!message && currentCatalog && selected && !models.some((model) => model.id === selected)) message = '当前模型未出现在目录中，请选择目录中的可用模型。';
  if (!message && currentCatalog && !models.length) message = '模型目录为空，请检查连接配置后重新获取。';
  if (!message && query && !visible.length) message = '没有匹配的模型。';
  $('model-list-status').textContent = message || '选择模型后保存真实模型 ID。';
  $('model-list-retry').hidden = !catalogError;
  $('model-list-refresh').disabled = contextBusy() || modelSaving || catalogLoading || isChatGPTBusy();
  visible.forEach((model) => {
    const button = element('button', `model-option${model.id === selected ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(model.id === selected));
    const copy = element('span', 'model-option-copy');
    copy.append(element('strong', '', model.displayName));
    if (model.displayName !== model.id) copy.append(element('small', '', model.id));
    if (model.compatible === false) copy.append(element('small', 'model-option-warning', model.compatibilityReason || '当前编程工具不支持此模型'));
    button.append(copy, element('span', 'model-option-check', model.id === selected ? '✓' : ''));
    button.disabled = contextBusy() || modelSaving || isChatGPTBusy() || model.compatible === false;
    button.title = model.compatibilityReason || model.id;
    button.addEventListener('click', () => selectCurrentModel(model));
    list.append(button);
  });
}

function renderSettingsCatalog() {
  const select = $('chatgpt-model-select');
  const current = select.value;
  if (settingsCatalog && !settingsCatalogMatches()) {
    invalidateSettingsCatalog();
    settingsCatalogError = '模型目录已失效，请重新获取。';
  }
  const catalog = settingsCatalogMatches() ? settingsCatalog : null;
  select.replaceChildren();
  const placeholder = element('option', '', catalog ? '选择目录中的模型' : '先获取模型目录，再选择模型');
  placeholder.value = '';
  select.append(placeholder);
  (catalog?.models || []).forEach((model) => {
    const option = element('option', '', model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`);
    option.value = model.id;
    option.disabled = model.compatible === false || model.supportsTools === false;
    select.append(option);
  });
  select.value = catalog?.models.some((model) => model.id === current) ? current : '';
  let message = '填写连接配置，获取模型目录并选择模型后保存。';
  if (settingsCatalogLoading) message = '正在获取当前连接配置的模型目录…';
  else if (settingsCatalogError) message = settingsCatalogError;
  else if (catalog && !catalog.models.length) message = '目录中没有可选择的模型，请检查连接配置后重新获取。';
  else if (catalog) message = `已获取 ${catalog.models.length} 个模型；目录不等于实际访问权限。`;
  $('settings-model-catalog-message').textContent = message;
  $('settings-model-refresh').disabled = contextBusy() || settingsSaving || settingsCatalogLoading || isChatGPTBusy();
}

async function fetchCurrentCatalog(force = false) {
  if (contextBusy() || isChatGPTBusy()) return;
  const provider = appState?.settings?.provider || 'openai';
  const authMode = currentAuthMode();
  const key = activeCatalogIdentity();
  const request = ++catalogRequest;
  catalogLoading = true;
  catalogError = '';
  renderModelList();
  try {
    if (!savedConnectionReady(provider, authMode)) throw new Error(authMode === 'chatgpt' ? '请先在模型设置中连接并授权 ChatGPT。' : '请先在模型设置中保存 API Key。');
    if (typeof bridge.listModels !== 'function') throw new Error('当前版本不支持模型目录，请更新软件后重试。');
    const result = await bridge.listModels({ provider, authMode, force });
    if (request !== catalogRequest || key !== activeCatalogIdentity()) return;
    currentCatalog = normalizeCatalog(result, provider, authMode);
    currentCatalogKey = key;
    fillReasoningOptions($('reasoning-effort'), provider, appState?.settings?.reasoningEffort || 'default');
    renderComposerModel();
  } catch (error) { if (request === catalogRequest && key === activeCatalogIdentity()) catalogError = errorText(error); }
  finally { if (request === catalogRequest) { catalogLoading = false; renderModelList(); refreshControlLocks(); } }
}

async function fetchSettingsCatalog(force = true) {
  if (contextBusy() || settingsSaving || isChatGPTBusy()) return;
  const provider = $('provider-select').value;
  const authMode = selectedAuthMode();
  const draft = modelSettingsDraft();
  const snapshot = modelSettingsDraftSnapshot();
  const selected = $('chatgpt-model-select').value;
  const request = ++settingsCatalogRequest;
  settingsCatalogLoading = true;
  settingsCatalog = null;
  settingsCatalogDraft = null;
  settingsCatalogError = '';
  $('settings-error').hidden = true;
  renderSettingsCatalog();
  refreshControlLocks();
  try {
    if (authMode === 'chatgpt' && !savedConnectionReady(provider, authMode)) throw new Error('请先连接 ChatGPT 并同意使用套餐用量。');
    if (typeof bridge.previewModelCatalog !== 'function') throw new Error('当前版本不支持预览模型目录，请更新软件后重试。');
    const result = await bridge.previewModelCatalog(draft);
    const current = modelSettingsDraftSnapshot();
    if (request !== settingsCatalogRequest || Object.keys(snapshot).some(key => snapshot[key] !== current[key]) || !$('settings-dialog').open) return;
    if (typeof result?.selectionToken !== 'string' || !result.selectionToken) throw new Error('模型目录验证失败，请重新获取。');
    settingsCatalog = normalizeCatalog({ ...result, provider: result.provider || provider, authMode: result.authMode || authMode }, provider, authMode);
    settingsCatalogDraft = snapshot;
    renderSettingsCatalog();
    if (settingsCatalog.models.some(model => model.id === selected && model.compatible !== false && model.supportsTools !== false)) $('chatgpt-model-select').value = selected;
  } catch (error) { if (request === settingsCatalogRequest) settingsCatalogError = errorText(error); }
  finally { if (request === settingsCatalogRequest) { settingsCatalogLoading = false; renderSettingsCatalog(); refreshControlLocks(); } }
}

async function selectCurrentModel(model) {
  if (contextBusy() || reasoningSaving || modelSaving || isChatGPTBusy() || model.compatible === false) return;
  modelSaving = true;
  renderModelList();
  refreshControlLocks();
  try {
    updateState(await bridge.selectModel({ model: model.id }));
    showModelList(false);
  } catch (error) { catalogError = errorText(error); }
  finally { modelSaving = false; renderModelList(); refreshControlLocks(); }
}

function showModelList(open) {
  $('reasoning-popup-main').hidden = open;
  $('model-list-panel').hidden = !open;
  if (open) { renderModelList(); $('model-search').focus(); }
}

function closeReasoningPopup(restoreFocus = false) {
  $('reasoning-popup').hidden = true;
  $('model-reasoning-trigger').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('model-reasoning-trigger').focus();
}

function openReasoningPopup() {
  if (contextBusy() || reasoningSaving || modelSaving || isChatGPTBusy()) return;
  $('reasoning-popup').hidden = false;
  $('model-reasoning-trigger').setAttribute('aria-expanded', 'true');
  showModelList(false);
  renderComposerModel();
  if ($('reasoning-effort').disabled) $('popup-model-button').focus();
  else $('reasoning-effort').focus();
  fetchCurrentCatalog();
}

function fillReasoningOptions(range, provider, value = 'default') {
  const spec = reasoningSpec(range, provider);
  const options = spec.options;
  range.min = '0';
  range.max = String(Math.max(0, options.length - 1));
  range.step = '1';
  range.dataset.provider = provider;
  range.dataset.options = JSON.stringify(options);
  range.dataset.support = spec.known ? options.length ? 'known' : 'none' : 'unknown';
  range.dataset.defaultEffort = spec.defaultEffort || '';
  range.dataset.effort = options.includes(value) ? value : 'default';
  range.value = String(range.dataset.effort === 'default' ? Math.max(0, Math.floor((options.length - 1) / 2)) : options.indexOf(value));
  updateReasoningControl(range);
}

function updateReasoningControl(range, fromInput = false) {
  const options = rangeOptions(range);
  const available = reasoningAvailable(range);
  const index = Math.max(0, Math.min(options.length - 1, Math.max(0, Math.round(Number(range.value) || 0))));
  range.value = String(index);
  if (!available) range.dataset.effort = 'default';
  else if (fromInput) range.dataset.effort = options[index] || 'default';
  const effort = range.dataset.effort || 'default';
  const prefix = 'reasoning';
  const label = $(`${prefix}-value`);
  const reset = $(`${prefix}-default`);
  const maximum = available && effort !== 'default' && index === options.length - 1;
  label.textContent = available ? reasoningLabels[effort] || '默认' : '不可用';
  label.classList.toggle('is-max', maximum);
  label.classList.toggle('is-unavailable', !available);
  range.classList.toggle('is-max', maximum);
  range.dataset.fill = String(options.length > 1 ? Math.round(index / (options.length - 1) * 100) : 0);
  const visual = range.closest?.('.reasoning-slider-visual');
  if (visual) {
    visual.dataset.fill = range.dataset.fill;
    visual.classList.toggle('is-max', maximum);
    visual.classList.toggle('is-unavailable', !available);
    if (!available) visual.classList.remove('is-dragging');
  }
  const hint = range.dataset.support === 'none' ? '此模型不支持可调推理强度，使用服务商默认设置。' : range.dataset.support === 'unknown' ? '通用档位，获取模型能力后自动校正。' : effort === 'default' ? `遵从模型默认设置${range.dataset.defaultEffort ? `（${reasoningLabels[range.dataset.defaultEffort] || range.dataset.defaultEffort}）` : ''}。` : '仅显示模型目录返回的可用档位。';
  range.setAttribute('aria-valuetext', !available ? '不可用，使用服务商默认设置' : effort === 'default' ? '默认，遵从模型默认设置' : reasoningLabels[effort]);
  range.title = !available ? hint : effort === 'default' ? '遵从模型默认设置。拖动滑块可选择明确的推理强度。' : `推理强度：${reasoningLabels[effort]}。具体支持的档位取决于所选模型。`;
  reset.classList.toggle('active', available && effort === 'default');
  reset.setAttribute('aria-pressed', String(available && effort === 'default'));
  $('reasoning-hint').textContent = hint;
  $('reasoning-low-label').textContent = available ? reasoningLabels[options[0]] : '—';
  $('reasoning-high-label').textContent = available ? reasoningLabels[options.at(-1)] : '—';
  renderComposerModel();
  range.disabled = !available || contextBusy() || reasoningSaving || modelSaving || isChatGPTBusy();
  reset.disabled = range.disabled;
}

function setReasoningDisabled(disabled) {
  $('reasoning-effort').disabled = disabled || modelSaving || !reasoningAvailable($('reasoning-effort'));
  $('reasoning-default').disabled = disabled || modelSaving || !reasoningAvailable($('reasoning-effort'));
}

async function setReasoningEffort() {
  if (!reasoningAvailable($('reasoning-effort')) || contextBusy() || reasoningSaving || modelSaving || isChatGPTBusy()) return;
  reasoningSaving = true;
  setReasoningDisabled(true);
  $('send-button').disabled = true;
  try { updateState(await bridge.setReasoningEffort({ reasoningEffort: $('reasoning-effort').dataset.effort || 'default' })); }
  catch (error) {
    const settings = appState?.settings || {};
    fillReasoningOptions($('reasoning-effort'), settings.provider, settings.reasoningEffort || 'default');
    notice(errorText(error), true);
  } finally {
    reasoningSaving = false;
    setReasoningDisabled(running);
    $('send-button').disabled = false;
    refreshControlLocks();
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isChatGPTBusy() {
  return chatgptBusy || appState?.chatgpt?.session?.status === 'connecting';
}

function selectedAuthMode() {
  return $('provider-select').value === 'openai' && $('openai-auth-mode').value === 'chatgpt' ? 'chatgpt' : 'apiKey';
}

function restoreChatGPTControls() {
  if (isChatGPTBusy()) return;
  for (const [control, disabled] of chatgptDisabledControls) control.disabled = disabled;
  chatgptDisabledControls.clear();
}

function refreshControlLocks() {
  restoreChatGPTControls();
  if (appState) sessionControls?.update({ ...appState, sessionId: sessionId || appState.sessionId, busy: contextBusy() || editorSaving, authBusy: isChatGPTBusy() });
  const busy = contextBusy() || editorSaving;
  $('task-form').classList.toggle('has-active-task', running);
  $('task-input').disabled = terminalRunning || (running && taskKind === 'undo') || isChatGPTBusy();
  $('task-input').placeholder = running ? '可继续输入，发送后加入待发送列表…' : '描述需要完成的任务…';
  $('send-button').hidden = false;
  $('send-button').disabled = draftAttachments.some((attachment) => attachment.loading) || projectSwitching || promptSubmitting || reasoningSaving || modelSaving || terminalRunning || (running && taskKind === 'undo') || isChatGPTBusy();
  $('send-button').title = running || promptQueue.items.length ? '加入待发送列表（Ctrl + Enter）' : '发送任务（Ctrl + Enter）';
  $('send-button').setAttribute('aria-label', running || promptQueue.items.length ? '加入待发送列表' : '发送任务');
  $('stop-button').hidden = !running;
  $('project-switcher').disabled = isChatGPTBusy();
  if ($('open-workspace-sidebar')) $('open-workspace-sidebar').disabled = projectTransitionBusy() || isChatGPTBusy();
  $('undo-change').disabled = busy || !appState?.workspace;
  setReasoningDisabled(busy || reasoningSaving || modelSaving);
  $('model-reasoning-trigger').disabled = busy || reasoningSaving || modelSaving;
  $('popup-model-button').disabled = busy || reasoningSaving || modelSaving;
  $('reasoning-open-settings').disabled = busy || reasoningSaving || modelSaving || isChatGPTBusy();
  $('terminal-input').disabled = busy || isChatGPTBusy();
  $('terminal-run').disabled = busy || !appState?.workspace || isChatGPTBusy();
  $('terminal-stop').disabled = !terminalRunning;
  $('attach-images').disabled = terminalRunning || (running && taskKind === 'undo') || isChatGPTBusy();
  $('attachment-input').disabled = $('attach-images').disabled;
  refreshFileLocks();
  const settingsLocked = busy || settingsSaving;
  ['provider-select', 'openai-auth-mode'].forEach((id) => { $(id).disabled = settingsLocked; });
  $('chatgpt-model-select').disabled = settingsLocked || settingsCatalogLoading || !settingsCatalogMatches();
  $('save-settings').disabled = settingsLocked || settingsCatalogLoading || !selectedSettingsModel();
  $('base-url-input').disabled = settingsLocked || selectedAuthMode() === 'chatgpt';
  $('api-protocol-select').disabled = settingsLocked || selectedAuthMode() === 'chatgpt';
  $('api-key-input').disabled = settingsLocked || selectedAuthMode() === 'chatgpt' || $('clear-key-input').checked;
  $('clear-key-input').disabled = settingsLocked || selectedAuthMode() === 'chatgpt';
  $('settings-model-refresh').disabled = settingsLocked || settingsCatalogLoading;
  $('close-settings').disabled = settingsSaving;
  if (isChatGPTBusy()) {
    document.querySelectorAll('button,input,select,textarea').forEach((control) => {
      if (control.id === 'chatgpt-cancel-sign-in') return;
      if (!chatgptDisabledControls.has(control)) chatgptDisabledControls.set(control, control.disabled);
      control.disabled = true;
    });
  }
  $('chatgpt-cancel-sign-in').disabled = chatgptCancelling;
  renderPendingPrompts();
  notifyMenuState();
}

function syncAuthModeVisibility() {
  const openai = $('provider-select').value === 'openai';
  const relay = $('provider-select').value === 'relay';
  const account = openai && selectedAuthMode() === 'chatgpt';
  $('openai-auth-mode-field').hidden = !openai;
  $('api-protocol-field').hidden = !(openai || relay) || account;
  $('api-protocol-help').textContent = $('api-protocol-select').value === 'chat-completions'
    ? '使用 /chat/completions；适用于提供 OpenAI 兼容接口的中转站。'
    : '使用 /responses；请确认服务商支持 Responses 协议。';
  $('base-url-input').placeholder = relay ? '例如 https://你的中转地址/v1' : '使用服务商默认 API 地址';
  $('chatgpt-panel').hidden = !account;
  $('chatgpt-model-field').hidden = false;
  $('base-url-field').hidden = account;
  $('api-key-field').hidden = account;
  $('api-key-clear-field').hidden = account;
  $('settings-privacy').textContent = account ? 'ChatGPT 账号模式仅供个人本机预览。任务及相关项目内容会发送给 OpenAI，额度取决于账号套餐。命令以当前 Windows 用户权限运行，执行前需由你确认。' : 'API Key 在本机加密保存。任务和相关项目内容会发送至所配置的 API 地址。命令以当前 Windows 用户权限运行，执行前需由你确认。';
  $('settings-footer-hint').textContent = account ? '个人本机预览 · 额度取决于账号' : '支持自定义 API 地址';
  $('settings-dialog').classList.toggle('chatgpt-mode', account);
}

function renderChatGPTModels() {
  renderSettingsCatalog();
}

function chatgptErrorInfo(value) {
  if (!value) return null;
  let message = typeof value === 'string' ? value : typeof value.message === 'string' ? value.message : safeString(value);
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = message;
    message = message.replace(/^Error invoking remote method ['"]forge:[^'"]+['"]:\s*/u, '')
      .replace(/^(?:(?:Error|ChatGPTError|ChatGPTConnectionError):\s*)+/u, '').trim();
    if (message === previous) break;
  }
  let code = typeof value.code === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/u.test(value.code) ? value.code : '';
  if (!code) {
    const explicit = message.match(/\b(storage_decryption_failed|storage_encrypted_invalid|storage_provider_mismatch|storage_invalid|storage_encryption_unavailable|local_disconnect_only|revocation_failed)\b/u);
    if (explicit) code = explicit[1];
    else if (/^Saved credentials could not be decrypted\./u.test(message)) code = 'storage_decryption_failed';
    else if (/^(?:The encrypted credential file is damaged\.|The saved credential format is not supported\.)/u.test(message)) code = 'storage_encrypted_invalid';
    else if (/^Use the credential encryption provider that created this file\./u.test(message)) code = 'storage_provider_mismatch';
    else if (/^(?:Saved ChatGPT (?:credentials|identity|profiles) (?:could not be read|are invalid|is invalid)\.|The pending ChatGPT connection is invalid\.)/u.test(message)) code = 'storage_invalid';
    else if (/^(?:Secure credential storage is unavailable\.|系统安全加密暂不可用)/u.test(message)) code = 'storage_encryption_unavailable';
  }
  return { code, message };
}

function chatgptStorageError() {
  for (const value of [appState?.chatgpt?.session?.error, chatgptLocalError]) {
    const error = chatgptErrorInfo(value);
    if (error && Object.hasOwn(chatgptStorageMessages, error.code)) return error;
  }
  return null;
}

function chatgptDisplayMessages(values) {
  const messages = [], seen = new Set(), rawSeen = new Set();
  for (const value of values) {
    const error = chatgptErrorInfo(value);
    if (!error?.message) continue;
    const key = error.message.replace(/\s+/gu, ' ');
    if (rawSeen.has(key)) continue;
    rawSeen.add(key);
    let message = chatgptStorageMessages[error.code] || error.message;
    if (error.code === 'local_disconnect_only') message = '已退出本机连接，原登录文件已备份；无法确认服务端撤销，可到官方页面管理授权。';
    else if (error.code === 'revocation_failed') message = '已退出本机登录，但未能确认远程授权已撤销，可到 ChatGPT 设置中管理连接。';
    if (error.code) message += `（错误代码：${error.code}）`;
    if (!seen.has(message)) { seen.add(message); messages.push(message); }
  }
  return messages;
}

function closeChatGPTUsage(restoreFocus = false) {
  clearInterval(chatgptUsageTimer);
  chatgptUsageTimer = null;
  if ($('chatgpt-usage-popover').open) $('chatgpt-usage-popover').close();
  $('chatgpt-usage-button').setAttribute('aria-expanded', 'false');
  if (restoreFocus && !$('chatgpt-usage-control').hidden) $('chatgpt-usage-button').focus({ preventScroll: true });
}

function positionChatGPTUsage() {
  const popup = $('chatgpt-usage-popover');
  if (!popup.open) return;
  if (!chatgptUsagePositionRule) {
    for (const sheet of document.styleSheets) {
      try {
        const rule = [...sheet.cssRules].find(candidate => candidate.selectorText === '#chatgpt-usage-popover');
        if (rule) { chatgptUsagePositionRule = rule; break; }
      } catch { /* Only the local application stylesheets are inspected. */ }
    }
  }
  if (!chatgptUsagePositionRule) return;
  const anchor = $('chatgpt-usage-button').getBoundingClientRect();
  const bounds = popup.getBoundingClientRect();
  chatgptUsagePositionRule.style.setProperty('left', `${Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12))}px`);
  chatgptUsagePositionRule.style.setProperty('top', `${Math.max(12, Math.min(anchor.top - bounds.height - 8, innerHeight - bounds.height - 12))}px`);
}

function renderChatGPTUsage() {
  const session = appState?.chatgpt?.session || {};
  const visible = appState?.settings?.provider === 'openai' && currentAuthMode() === 'chatgpt' && session.status === 'connected';
  const profileId = visible ? session.profileId || '' : null;
  if (profileId !== chatgptUsageProfileId || !visible) closeChatGPTUsage();
  chatgptUsageProfileId = profileId;
  $('chatgpt-usage-control').hidden = !visible;
  $('chatgpt-usage-button').disabled = isChatGPTBusy();
  $('chatgpt-usage-official').disabled = chatgptUsageOpening || isChatGPTBusy();
  if (!visible) {
    $('chatgpt-usage-label').textContent = '查看额度';
    $('chatgpt-usage-status').textContent = '';
    $('chatgpt-usage-checked').textContent = '';
    $('chatgpt-usage-checked').hidden = true;
    $('chatgpt-usage-source').textContent = '';
    $('chatgpt-usage-button').title = 'ChatGPT 使用情况';
    delete $('chatgpt-usage-button').dataset.status;
    delete $('chatgpt-usage-popover').dataset.status;
    delete $('chatgpt-usage-popover').dataset.stale;
    return;
  }
  const usage = appState?.chatgpt?.usage || {};
  const statuses = {
    not_authorized: ['未授权', '尚未授权使用 ChatGPT 套餐用量'],
    unknown: ['查看额度', '暂未获取请求状态'],
    request_succeeded: ['最近请求可用', '最近请求可用'],
    limit_reached: ['用量达到限制', '用量达到限制'],
    unavailable: ['暂不可用', '暂不可用'],
    not_eligible: ['套餐不可用', '套餐不可用']
  };
  const status = session.sharing !== true ? 'not_authorized' : Object.hasOwn(statuses, usage.status) ? usage.status : 'unknown';
  const official = usage.source === 'official_response';
  const checked = official && typeof usage.checkedAt === 'string' ? new Date(usage.checkedAt) : null;
  const validDate = checked && Number.isFinite(checked.getTime());
  const stale = usage.stale === true || Boolean(validDate && Date.now() - checked.getTime() >= 5 * 60 * 1000);
  const oldLabels = { request_succeeded: '上次请求可用', limit_reached: '上次达到限制', unavailable: '上次不可用', not_eligible: '上次套餐不可用', unknown: '上次状态未知' };
  const label = stale ? oldLabels[status] || statuses[status][0] : statuses[status][0];
  const detail = `${stale ? '上次状态：' : ''}${statuses[status][1]}`;
  $('chatgpt-usage-label').textContent = label;
  $('chatgpt-usage-status').textContent = detail;
  $('chatgpt-usage-message').textContent = '当前账号接口未提供剩余额度，可在官方页面查看。';
  $('chatgpt-usage-checked').hidden = !validDate;
  $('chatgpt-usage-checked').textContent = validDate ? `状态时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(checked)}` : '';
  $('chatgpt-usage-source').textContent = official ? '来自官方模型请求，不代表剩余额度。' : '当前连接未返回官方用量信息。';
  $('chatgpt-usage-button').title = `${detail}。当前账号接口未提供剩余额度。`;
  $('chatgpt-usage-button').dataset.status = status;
  $('chatgpt-usage-popover').dataset.status = status;
  $('chatgpt-usage-popover').dataset.stale = String(stale);
  positionChatGPTUsage();
}

function bindChatGPTUsage() {
  const popup = $('chatgpt-usage-popover');
  $('chatgpt-usage-button').addEventListener('click', () => {
    if (popup.open) { closeChatGPTUsage(true); return; }
    renderChatGPTUsage();
    if ($('chatgpt-usage-control').hidden) return;
    closeReasoningPopup();
    closeProjectDropdown();
    closeFileContextMenu();
    sessionControls?.close();
    popup.show();
    $('chatgpt-usage-button').setAttribute('aria-expanded', 'true');
    positionChatGPTUsage();
    chatgptUsageTimer = setInterval(renderChatGPTUsage, 30000);
    $('chatgpt-usage-official').focus({ preventScroll: true });
  });
  $('chatgpt-usage-close').addEventListener('click', () => closeChatGPTUsage(true));
  popup.addEventListener('cancel', event => { event.preventDefault(); closeChatGPTUsage(true); });
  document.addEventListener('pointerdown', event => {
    if (popup.open && !$('chatgpt-usage-control').contains(event.target)) closeChatGPTUsage();
  });
  document.addEventListener('keydown', event => {
    if (popup.open && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeChatGPTUsage(true);
    }
  }, true);
  window.addEventListener('resize', positionChatGPTUsage);
  $('chatgpt-usage-official').addEventListener('click', async () => {
    if (chatgptUsageOpening) return;
    const profileId = chatgptUsageProfileId;
    chatgptUsageOpening = true;
    renderChatGPTUsage();
    try { await bridge.chatgptOpenUsage(); }
    catch (error) { if (profileId === chatgptUsageProfileId) notice(errorText(error), true); }
    finally { chatgptUsageOpening = false; renderChatGPTUsage(); }
  });
}

function renderChatGPTState() {
  restoreChatGPTControls();
  const chatgpt = appState?.chatgpt || {};
  const session = chatgpt.session || { status: 'disconnected', sharing: false };
  const statuses = { disconnected: '未连接', connecting: '等待官方浏览器授权', connected: '已登录', reauth_required: '需要重新授权' };
  const storageError = chatgptStorageError();
  const signing = chatgptAction === 'signin' || session.status === 'connecting';
  const busy = contextBusy() || settingsSaving || reasoningSaving || isChatGPTBusy();
  $('chatgpt-status').textContent = signing ? '等待官方浏览器授权' : storageError ? '本机登录信息读取失败' : statuses[session.status] || '未连接';
  $('chatgpt-identity').textContent = [session.identity?.name, session.identity?.email].filter(Boolean).join(' · ') || session.profileLabel || '';
  $('chatgpt-sharing').textContent = storageError ? '套餐用量：暂无法读取授权状态' : session.sharing ? '套餐用量：已授权' : '套餐用量：未授权';
  const profiles = Array.isArray(chatgpt.profiles) ? chatgpt.profiles : [];
  const profileSelect = $('chatgpt-profile-select');
  profileSelect.replaceChildren();
  const placeholder = element('option', '', '选择已保存的账号');
  placeholder.value = '';
  profileSelect.append(placeholder);
  profiles.forEach((profile) => {
    if (!profile || typeof profile.id !== 'string') return;
    const identity = profile.label || profile.identity?.email || profile.identity?.name || '已保存账号';
    const option = element('option', '', `${identity} · ${statuses[profile.status] || '已保存'}${profile.sharing ? '' : ' · 套餐未授权'}`);
    option.value = profile.id;
    profileSelect.append(option);
  });
  profileSelect.value = session.profileId || '';
  profileSelect.disabled = busy || Boolean(storageError);
  $('chatgpt-profiles-field').hidden = !profiles.length;
  $('chatgpt-sign-in').hidden = signing || Boolean(storageError) || (session.status === 'connected' && session.sharing === true);
  $('chatgpt-sign-in').disabled = busy || Boolean(storageError);
  $('chatgpt-reconnect').textContent = storageError ? chatgptAction === 'retry' ? '读取中…' : '重试读取' : '重新连接';
  $('chatgpt-reconnect').title = storageError ? '重新读取本机登录信息，不发起浏览器授权。' : '重新连接并授权 ChatGPT。';
  $('chatgpt-reconnect').hidden = !storageError && !['connected', 'reauth_required'].includes(session.status);
  $('chatgpt-reconnect').disabled = busy;
  $('chatgpt-add-profile').disabled = busy || Boolean(storageError);
  $('chatgpt-add-profile').hidden = session.status === 'disconnected';
  $('chatgpt-disconnect').disabled = busy || (!session.profileId && session.status === 'disconnected');
  $('chatgpt-open-usage').disabled = busy;
  $('chatgpt-refresh-models').disabled = busy || session.status !== 'connected' || session.sharing !== true;
  $('chatgpt-cancel-sign-in').hidden = !signing;
  const messages = chatgptDisplayMessages([session.error, chatgptLocalError, chatgpt.warning]);
  $('chatgpt-message').textContent = messages.join('\n');
  $('chatgpt-message').hidden = !messages.length;
  syncAuthModeVisibility();
  renderChatGPTModels();
  renderChatGPTUsage();
  refreshControlLocks();
}

async function runChatGPTAction(action, callback) {
  if (contextBusy() || settingsSaving || reasoningSaving || isChatGPTBusy()) return;
  if (['signin', 'profile', 'disconnect', 'retry'].includes(action)) invalidateCatalogs();
  chatgptLocalError = '';
  chatgptBusy = true;
  chatgptAction = action;
  renderChatGPTState();
  try {
    const state = await callback();
    if (state?.settings) {
      updateState(state);
      if (state.warning) chatgptLocalError = chatgptErrorInfo(state.warning);
      if (['signin', 'profile'].includes(action)) renderChatGPTModels();
    }
  } catch (error) { chatgptLocalError = chatgptErrorInfo(error); }
  finally {
    chatgptBusy = false;
    chatgptAction = null;
    chatgptCancelling = false;
    renderChatGPTState();
  }
}

async function signInChatGPT(options = {}) {
  if (chatgptStorageError()) { renderChatGPTState(); return; }
  const session = appState?.chatgpt?.session || {};
  const input = { ...options };
  if (!input.newProfile && session.profileId) input.profileId = session.profileId;
  if (!input.newProfile && (session.status === 'reauth_required' || (session.status === 'connected' && !session.sharing))) input.reconsent = true;
  await runChatGPTAction('signin', () => bridge.chatgptSignIn(input));
}

async function cancelChatGPTSignIn() {
  if (chatgptCancelling) return;
  chatgptCancelling = true;
  renderChatGPTState();
  try {
    await bridge.chatgptCancelSignIn();
    updateState(await bridge.getState());
  } catch (error) { chatgptLocalError = chatgptErrorInfo(error); }
  finally { chatgptCancelling = false; renderChatGPTState(); }
}

async function refreshChatGPTModels() {
  await fetchSettingsCatalog(true);
}

async function retryChatGPTStorage() {
  await runChatGPTAction('retry', () => bridge.chatgptRetryStorage());
}

function renderUsageStats(stats) {
  const periods = { day: '今日', week: '本周', month: '本月' };
  Object.entries(periods).forEach(([key, label]) => {
    const period = !stats?.error && stats?.[key];
    $(`usage-${key}`).textContent = period ? count(period.totalTokens).toLocaleString('en-US') : '—';
    const detail = period ? `${label} · 香港时间\n输入：${count(period.inputTokens).toLocaleString('en-US')} Token\n输出：${count(period.outputTokens).toLocaleString('en-US')} Token\nAPI 请求：${count(period.requests).toLocaleString('en-US')} 次\n用量不完整：${count(period.unreportedRequests).toLocaleString('en-US')} 次\n仅累计本应用 API 已回报的用量，缺失部分不计入。${period.historicalApproximate ? '\n包含旧版历史近似用量。' : ''}` : '等待读取用量统计';
    $(`usage-${key}-row`).title = detail;
    $(`usage-${key}-row`).setAttribute('aria-label', detail.replace(/\n/g, '，'));
  });
  const approximate = stats?.historicalApproximate || stats?.day?.historicalApproximate || stats?.week?.historicalApproximate || stats?.month?.historicalApproximate;
  let updated = '';
  const date = new Date(stats?.generatedAt || '');
  if (!Number.isNaN(date.getTime())) updated = `\n更新：${date.toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })}`;
  $('usage-updated').title = `仅累计本应用 API 已回报的输入和输出 Token。缺失部分不计入。\n时区：Asia/Hong_Kong；每周一开始。${updated}${approximate ? '\n包含旧版历史近似用量。' : ''}${stats?.warning ? `\n提示：${safeString(stats.warning)}` : ''}${stats?.error ? `\n统计不可用：${safeString(stats.error)}` : ''}`;
}

function renderSessionMetrics(metrics) {
  const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const number = value => validNumber(value) ? Math.trunc(value).toLocaleString('en-US') : '—';
  const percent = value => validNumber(value) && value <= 100
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%' : null;
  const rounds = validNumber(metrics?.rounds) ? Math.trunc(metrics.rounds) : null;
  $('session-rounds').textContent = rounds === null ? '— 轮对话' : rounds ? `第 ${number(rounds)} 轮对话` : '0 轮对话';

  const cachePercent = metrics?.cacheStatus === 'unavailable' ? null : percent(metrics?.cacheHitPercent);
  const partialCache = cachePercent !== null && metrics?.cacheStatus === 'partial';
  $('session-cache-value').textContent = cachePercent === null ? '—' : cachePercent + (partialCache ? '*' : '');
  $('session-cache').title = cachePercent === null ? '服务商尚未提供当前会话的缓存命中数据。'
    : `API 回报缓存输入：${number(metrics.cachedInputTokens)} Token。命中率为已回报缓存输入占对应请求输入的比例。${partialCache ? '\n部分请求未提供缓存用量；仅统计已提供数据的请求。' : ''}`;

  const noReportedUsage = metrics?.usageStatus === 'unavailable' && rounds > 0;
  $('session-total-value').textContent = noReportedUsage ? '—' : number(metrics?.totalTokens);
  $('session-total').classList.toggle('partial', metrics?.usageStatus === 'partial');
  $('session-total').title = noReportedUsage ? '服务商尚未回报当前会话的 Token 用量。'
    : `当前会话 API 已回报的累计用量：输入 ${number(metrics?.inputTokens)} / 输出 ${number(metrics?.outputTokens)} Token。${metrics?.usageStatus === 'partial' ? '\n部分请求缺少用量报告，仅累计已知用量。' : ''}\n缓存输入和推理 Token 已包含在相应用量中，不重复累加。`;

  const contextPercent = metrics?.contextStatus === 'unknown' ? null : percent(metrics?.contextPercent);
  const contextEstimated = contextPercent !== null && metrics?.contextStatus === 'estimated';
  const contextLabel = contextPercent === null ? '—' : (contextEstimated ? '≈' : '') + contextPercent;
  const context = $('session-context');
  const description = typeof metrics?.contextDescription === 'string' ? metrics.contextDescription : '';
  const contextTitle = contextPercent === null
    ? description || '模型上下文容量未知，暂无法计算使用率。'
    : `上下文使用率：${contextLabel}\n当前请求：${number(metrics.contextUsedTokens)} / 容量 ${number(metrics.contextLimit)} Token。${contextEstimated ? '\n使用率为估算值。' : ''}${description ? '\n' + description : ''}`;
  $('session-context-value').textContent = contextLabel;
  $('session-context-progress').setAttribute('stroke-dasharray', `${contextPercent === null ? 0 : metrics.contextPercent} 100`);
  context.classList.toggle('unknown', contextPercent === null);
  context.title = contextTitle;
  context.setAttribute('aria-valuetext', contextTitle.replace(/\n/g, '，'));
  if (contextPercent === null) context.removeAttribute('aria-valuenow');
  else context.setAttribute('aria-valuenow', String(metrics.contextPercent));
}

function resetTelemetry() {
  contextCompacting = false;
  clearInterval(taskActivityTimer);
  taskActivityTimer = null;
  activeTaskActivity = null;
  latestTelemetry = null;
}

function hasTokenRate(event) {
  return typeof event?.tokensPerSecond === 'number' && Number.isFinite(event.tokensPerSecond) && event.tokensPerSecond > 0;
}

function showTokenRate(event, activity = activeTaskActivity) {
  if (!activity) return;
  const { speed, separator } = activity;
  if (!hasTokenRate(event)) { speed.hidden = true; separator.hidden = true; return; }
  const rate = event.tokensPerSecond.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  speed.textContent = event.estimated ? `≈${rate} tok/s` : `${rate} tok/s`;
  const output = event.estimated ? count(event.estimatedOutputTokens) : count(event.outputTokens);
  speed.title = `模型请求平均输出速度，排除工具执行与审批等待。\n${event.estimated ? '估算' : 'API 回报'}输出：${output.toLocaleString('en-US')} Token\n任务总时长：${(Math.max(0, Number(event.elapsedMs) || 0) / 1000).toFixed(1)} 秒${event.estimated ? '\n估算速度不计入用量统计。' : ''}`;
  speed.hidden = false;
  separator.hidden = false;
}

function updateTelemetry(event) {
  if (event.runId && activeTaskActivity?.runId && event.runId !== activeTaskActivity.runId) return;
  latestTelemetry = event;
  if (!running || !activeTaskActivity) return;
  if (Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0) activeTaskActivity.elapsedFloor = Math.max(activeTaskActivity.elapsedFloor, event.elapsedMs);
  const phaseLabels = { waiting: '等待模型', thinking: '正在思考', generating: '正在生成', tool: '正在执行工具', approval: '等待你的确认', completed: '模型已返回' };
  if (contextCompacting) setTaskActivityPhase('compacting', '正在压缩上下文…');
  else if (phaseLabels[event.phase]) {
    const preserveToolLabel = event.phase === 'tool' && activeTaskActivity.phase === 'tool';
    if (!preserveToolLabel) setTaskActivityPhase(event.phase, phaseLabels[event.phase]);
  }
  if (hasTokenRate(event)) activeTaskActivity.lastRate = { ...event };
  if (['generating', 'thinking', 'completed'].includes(event.phase)) showTokenRate(event);
  else showTokenRate(null);
  renderTaskActivityElapsed();
}

function activityDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `已处理${minutes ? `${minutes}分钟` : ''}${seconds % 60}秒`;
}

function taskElapsed(activity) {
  if (Number.isFinite(activity.finishedElapsed)) return activity.finishedElapsed;
  return Math.max(activity.elapsedFloor || 0, performance.now() - activity.startedMono);
}

function renderTaskActivityElapsed(activity = activeTaskActivity) {
  if (!activity) return;
  activity.elapsed.textContent = activityDuration(taskElapsed(activity));
}

function createTaskActivity(record = {}) {
  const block = element('section', 'task-activity');
  const phaseLine = element('div', 'task-activity-phase-line');
  const marker = element('span', 'task-activity-marker', '◌');
  marker.setAttribute('aria-hidden', 'true');
  const phase = element('span', 'task-activity-phase', '等待模型');
  phaseLine.append(marker, phase);
  const meta = element('div', 'task-activity-meta');
  const elapsed = element('span', 'task-activity-elapsed', '已处理0秒');
  const separator = element('span', 'task-activity-separator', '·');
  const speed = element('span', 'generation-speed task-activity-speed');
  separator.hidden = true;
  speed.hidden = true;
  meta.append(elapsed, separator, speed);
  block.append(phaseLine, meta);
  const runId = String(record.runId || record.id || '');
  if (runId) block.dataset.runId = runId;
  return { block, phaseLine, phaseNode: phase, marker, elapsed, separator, speed, runId, phase: 'waiting', lastRate: null, elapsedFloor: 0, startedMono: performance.now(), finishedElapsed: null, status: 'running' };
}

function moveTaskActivityToEnd() {
  if (activeTaskActivity?.status === 'running' && activeTaskActivity.block.isConnected) $('messages').append(activeTaskActivity.block);
}

function beginTaskActivity(record = {}) {
  const runId = String(record.runId || record.id || '');
  if (activeTaskActivity?.status === 'running' && (!runId || !activeTaskActivity.runId || activeTaskActivity.runId === runId)) {
    if (runId) { activeTaskActivity.runId = runId; activeTaskActivity.block.dataset.runId = runId; }
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.parse(record.startedAt || '');
    if (Number.isFinite(startedAt) && startedAt <= Date.now()) activeTaskActivity.elapsedFloor = Math.max(activeTaskActivity.elapsedFloor, Date.now() - startedAt);
    return activeTaskActivity;
  }
  clearInterval(taskActivityTimer);
  const oldSpeed = $('generation-speed');
  if (oldSpeed) oldSpeed.removeAttribute('id');
  latestTelemetry = null;
  activeTaskActivity = createTaskActivity(record);
  const activity = activeTaskActivity;
  activity.block.classList.add('running');
  activity.block.dataset.status = 'running';
  activity.speed.id = 'generation-speed';
  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.parse(record.startedAt || '');
  if (Number.isFinite(startedAt) && startedAt <= Date.now()) {
    activity.elapsedFloor = Date.now() - startedAt;
    activity.startedMono -= activity.elapsedFloor;
  }
  $('messages').append(activity.block);
  showConversation();
  renderTaskActivityElapsed();
  taskActivityTimer = setInterval(() => renderTaskActivityElapsed(activity), 500);
  return activity;
}

function setTaskActivityPhase(phase, label) {
  if (!running || !activeTaskActivity || activeTaskActivity.status !== 'running') return;
  activeTaskActivity.phase = phase;
  activeTaskActivity.phaseNode.textContent = label;
  activeTaskActivity.block.dataset.phase = phase;
  $('run-status').textContent = label;
  if (!['thinking', 'generating', 'completed'].includes(phase)) showTokenRate(null);
}

function finishTaskActivity(record = {}) {
  if (record.runId && activeTaskActivity?.runId && record.runId !== activeTaskActivity.runId) return;
  clearInterval(taskActivityTimer);
  taskActivityTimer = null;
  const activity = activeTaskActivity;
  if (!activity || activity.status !== 'running') return;
  const duration = Number.isFinite(record.elapsedMs) ? record.elapsedMs : record.durationMs;
  activity.finishedElapsed = Number.isFinite(duration) && duration >= 0 ? duration : taskElapsed(activity);
  activity.status = ['completed', 'failed', 'stopped'].includes(record.status) ? record.status : 'completed';
  activity.block.dataset.status = activity.status;
  activity.block.classList.remove('running');
  activity.phaseLine.hidden = true;
  const finalRate = record.telemetry || record.finalTelemetry;
  if (finalRate) activity.lastRate = hasTokenRate(finalRate) ? { ...finalRate, elapsedMs: activity.finishedElapsed } : null;
  else if (hasTokenRate(latestTelemetry)) activity.lastRate = { ...latestTelemetry };
  showTokenRate(activity.lastRate, activity);
  renderTaskActivityElapsed(activity);
}

function restoreTaskActivityFromState() {
  const active = appState?.activeTask;
  if (!active?.running || !['agent', 'undo'].includes(active.kind)) return;
  beginTaskActivity(active);
  if (active.telemetry) updateTelemetry(active.telemetry);
  else if (active.kind === 'undo') setTaskActivityPhase('tool', '正在撤销文件修改');
}

function historicalTaskRecords(session) {
  const records = [...(Array.isArray(session.taskRuns) ? session.taskRuns : []), ...(session.events || []).filter((event) => event.type === 'run-end')];
  const seen = new Set();
  return records.filter((record) => {
    const duration = Number.isFinite(record.elapsedMs) ? record.elapsedMs : record.durationMs;
    if (!Number.isFinite(duration) || duration < 0) return false;
    const key = record.runId || `${record.startedAt || ''}:${record.messageIndex}:${duration}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderHistoricalTaskActivity(record) {
  const activity = createTaskActivity(record);
  activity.status = ['completed', 'failed', 'stopped'].includes(record.status) ? record.status : 'completed';
  activity.block.dataset.status = activity.status;
  activity.block.dataset.historical = 'true';
  activity.phaseLine.hidden = true;
  activity.finishedElapsed = Number.isFinite(record.elapsedMs) ? record.elapsedMs : record.durationMs;
  showTokenRate(record.telemetry || record.finalTelemetry, activity);
  renderTaskActivityElapsed(activity);
  $('messages').append(activity.block);
}

function toolActivity(name, args, completed = false) {
  const id = String(name || '').replace(/（模拟）/g, '');
  const labels = {
    list_files: completed ? '已读取文件列表' : '正在浏览项目文件',
    read_file: completed ? '已读取文件' : '正在读取文件',
    search_text: completed ? '已完成搜索' : '正在搜索代码',
    search_files: completed ? '已完成搜索' : '正在搜索代码',
    write_file: completed ? '已写入文件' : '正在写入文件',
    replace_in_file: completed ? '已修改文件' : '正在修改文件',
    run_command: completed ? '已运行命令' : '正在运行命令',
    undo_last_change: completed ? '已撤销文件修改' : '正在撤销文件修改',
    browser_navigate: completed ? '已打开网页' : '正在打开网页',
    browser_snapshot: completed ? '已读取页面' : '正在读取页面',
    browser_click: completed ? '已点击页面元素' : '正在点击页面元素',
    browser_type: completed ? '已填写页面内容' : '正在填写页面内容',
    browser_scroll: completed ? '已滚动页面' : '正在滚动页面',
    browser_screenshot: completed ? '已保存网页截图' : '正在截取网页'
  };
  const label = labels[id] || (completed ? '工具已返回' : '正在执行工具');
  const path = typeof args?.path === 'string' ? args.path.slice(0, 220) : '';
  return path ? `${label} · ${path}` : label;
}

function renderText(container, text) {
  window.ForgeMarkdown.renderMarkdown(container, text, { onLink: url => browserController?.open({ url }).catch(() => {}) });
}

function addMessage(role, text, streaming = false, metadata = {}) {
  showConversation();
  const message = element('article', `message ${role === 'user' ? 'user' : 'assistant'}${streaming ? ' streaming' : ''}`);
  if (typeof metadata.id === 'string') {
    message.dataset.messageId = metadata.id;
    if (role === 'user') renderedUserMessageIds.add(metadata.id);
  }
  const body = element('div', 'message-body');
  renderText(body, text);
  if (role === 'user') {
    const images = messageImageAttachments(metadata.attachments);
    if (images.length) {
      const gallery = element('div', 'user-message-attachments');
      gallery.setAttribute('aria-label', '消息图片');
      images.forEach((attachment) => gallery.append(createMessageImage(attachment)));
      message.append(gallery);
    }
    if (String(text || '').trim()) {
      const bubble = element('div', 'user-message-bubble');
      bubble.append(body);
      message.append(bubble);
    }
    message.append(createUserMessageFooter(text, metadata));
  } else {
    const header = element('div', 'message-header');
    header.append(element('span', 'message-avatar', '✳'), element('span', '', 'Synora code'));
    message.append(header, body);
  }
  $('messages').append(message);
  moveTaskActivityToEnd();
  scrollBottom();
  return { message, body };
}

function messageImageAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  const images = [];
  for (const attachment of attachments.slice(0, 4)) {
    const src = typeof attachment === 'string' ? attachment : attachment?.dataUrl || attachment?.src || attachment?.url;
    if (typeof src !== 'string' || src.length > Math.ceil(IMAGE_ATTACHMENT_BYTES / 3) * 4 + 64) continue;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/]+={0,2})$/i.exec(src);
    if (!match || match[2].length % 4 !== 0) continue;
    const bytes = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    const mediaType = match[1].toLowerCase();
    if (bytes <= 0 || bytes > IMAGE_ATTACHMENT_BYTES || (attachment?.mediaType && attachment.mediaType !== mediaType)) continue;
    images.push({ src, mediaType, name: typeof attachment?.name === 'string' ? attachment.name.slice(0, 120) : '消息图片' });
  }
  return images;
}

function createMessageImage(attachment, imageClass = 'user-message-image') {
  const button = element('button', 'user-message-image-button');
  button.type = 'button';
  button.title = `查看图片：${attachment.name}`;
  button.setAttribute('aria-label', `查看图片：${attachment.name}`);
  const image = element('img', imageClass);
  image.src = attachment.src;
  image.alt = attachment.name;
  image.loading = 'lazy';
  image.addEventListener('load', () => scrollBottom());
  button.append(image);
  button.addEventListener('click', () => openImagePreview(attachment));
  return button;
}

function openImagePreview(attachment) {
  const image = messageImageAttachments([attachment])[0];
  if (!image) return;
  $('image-preview-content').src = image.src;
  $('image-preview-content').alt = image.name;
  $('image-preview-title').textContent = image.name;
  if (!$('image-preview-dialog').open) $('image-preview-dialog').showModal();
}

function renderDraftAttachments() {
  const list = $('attachment-drafts');
  list.replaceChildren();
  list.hidden = draftAttachments.length === 0;
  for (const attachment of draftAttachments) {
    const card = element('div', 'attachment-draft');
    card.dataset.attachmentId = attachment.localId;
    card.title = attachment.name;
    if (attachment.loading) card.append(element('span', 'attachment-loading', '正在读取…'));
    else {
      const image = messageImageAttachments([attachment])[0];
      if (image) card.append(createMessageImage(image, 'attachment-draft-image'));
    }
    const remove = element('button', 'remove-attachment', '×');
    remove.type = 'button';
    remove.title = '移除图片';
    remove.setAttribute('aria-label', `移除图片：${attachment.name}`);
    remove.addEventListener('click', () => { draftAttachments = draftAttachments.filter((item) => item.localId !== attachment.localId); renderDraftAttachments(); refreshControlLocks(); });
    card.append(remove, element('span', 'attachment-draft-name', attachment.name));
    list.append(card);
  }
}

async function addDraftImageFiles(files) {
  const pending = [];
  for (const file of Array.from(files || [])) {
    const mediaType = String(file?.type || '').toLowerCase();
    if (!IMAGE_ATTACHMENT_TYPES.has(mediaType)) { notice('图片仅支持 PNG、JPEG 和 WebP 格式。', true); continue; }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > IMAGE_ATTACHMENT_BYTES) { notice('每张图片需大于 0 字节且不超过 2 MiB。', true); continue; }
    if (draftAttachments.length >= 4) { notice('每条消息最多添加 4 张图片。', true); break; }
    if (draftAttachments.reduce((sum, item) => sum + item.size, 0) + file.size > 8 * 1024 * 1024) { notice('每条消息图片总大小不能超过 8 MiB。', true); break; }
    const attachment = { localId: `image-${Date.now()}-${++draftAttachmentSequence}`, name: String(file.name || '截图.png').slice(0, 120), mediaType, size: file.size, dataUrl: '', loading: true };
    draftAttachments.push(attachment);
    pending.push(new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (draftAttachments.includes(attachment)) {
          attachment.dataUrl = typeof reader.result === 'string' ? reader.result : '';
          attachment.loading = false;
          if (!messageImageAttachments([attachment]).length) { draftAttachments = draftAttachments.filter((item) => item !== attachment); notice('图片内容或格式无效，请重新选择。', true); }
        }
        renderDraftAttachments(); refreshControlLocks(); resolve();
      };
      reader.onerror = reader.onabort = () => {
        draftAttachments = draftAttachments.filter((item) => item !== attachment);
        notice(`无法读取图片：${attachment.name}`, true);
        renderDraftAttachments(); refreshControlLocks(); resolve();
      };
      try { reader.readAsDataURL(file); } catch { reader.onerror(); }
    }));
  }
  renderDraftAttachments();
  refreshControlLocks();
  await Promise.all(pending);
}

function clearSubmittedAttachments(ids) {
  draftAttachments = draftAttachments.filter((attachment) => !ids.has(attachment.localId));
  renderDraftAttachments();
  refreshControlLocks();
}

function modelExplicitlyTextOnly() {
  const settings = appState?.settings || {};
  const model = settings.model || settings.providers?.[settings.provider]?.model;
  const entry = currentCatalog?.models?.find((item) => item.id === model);
  const candidates = [appState?.modelCapabilities, settings.modelCapabilities, settings.providers?.[settings.provider]?.modelCapabilities, entry, entry?.capabilities];
  const ordered = [entry, entry?.capabilities, ...candidates].filter(Boolean);
  for (const value of ordered) {
    if (typeof value.supportsImages === 'boolean') return !value.supportsImages;
    if (typeof value.supportsVision === 'boolean') return !value.supportsVision;
    const modalities = value.inputModalities || value.input_modalities;
    if (Array.isArray(modalities) && modalities.length > 0) return !modalities.includes('image');
  }
  return false;
}

function bindImageAttachments() {
  $('attach-images').addEventListener('click', () => { if (!$('attach-images').disabled) $('attachment-input').click(); });
  $('attachment-input').addEventListener('change', (event) => { const files = Array.from(event.target.files || []); event.target.value = ''; addDraftImageFiles(files); });
  $('task-input').addEventListener('paste', (event) => {
    if ($('task-input').disabled) return;
    const items = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!items.length) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text) { const input = $('task-input'); input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }
    addDraftImageFiles(items.map((item) => item.getAsFile()).filter(Boolean));
  });
  $('image-preview-close').addEventListener('click', () => $('image-preview-dialog').close());
  $('image-preview-dialog').addEventListener('close', () => { $('image-preview-content').removeAttribute('src'); $('image-preview-title').textContent = '图片预览'; });
}

function createUserMessageFooter(text, metadata = {}) {
  const footer = element('div', 'user-message-footer');
  if (metadata.source === 'steering') footer.append(element('span', 'user-message-source', '引导'));
  if (typeof metadata.createdAt === 'string') {
    const date = new Date(metadata.createdAt);
    if (!Number.isNaN(date.getTime())) {
      const time = element('time', 'user-message-time', date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
      time.dateTime = date.toISOString();
      time.title = `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}（香港时间）`;
      footer.append(time);
    }
  }
  if (!String(text || '')) return footer;
  const feedback = element('span', 'user-message-copy-feedback');
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  const copy = element('button', 'user-message-copy');
  copy.type = 'button';
  copy.title = '复制提示词';
  copy.setAttribute('aria-label', '复制这条提示词');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M9 9h11v12H9V9Z M15 6V3H4v12h2');
  icon.append(path);
  copy.append(icon);
  let feedbackTimer = null;
  copy.addEventListener('click', async () => {
    if (copy.disabled) return;
    copy.disabled = true;
    clearTimeout(feedbackTimer);
    try {
      await bridge.copyText({ text: String(text || '') });
      copy.title = '已复制';
      copy.setAttribute('aria-label', '已复制提示词');
      copy.classList.add('copied');
      feedback.textContent = '已复制';
      feedback.hidden = false;
      feedbackTimer = setTimeout(() => {
        copy.title = '复制提示词';
        copy.setAttribute('aria-label', '复制这条提示词');
        copy.classList.remove('copied');
        feedback.hidden = true;
      }, 1800);
    } catch (error) {
      copy.title = '复制提示词';
      copy.setAttribute('aria-label', '复制这条提示词');
      copy.classList.remove('copied');
      feedback.hidden = true;
      notice(`复制失败：${errorText(error)}`, true);
    }
    finally { copy.disabled = false; }
  });
  footer.append(feedback, copy);
  return footer;
}

function finishStream(text) {
  if (streamedMessage) {
    if (text !== undefined) renderText(streamedMessage.body, text);
    streamedMessage.message.classList.remove('streaming');
    streamedMessage = null;
    streamedText = '';
  } else if (text) addMessage('assistant', text);
}

function setRunning(value, metadata = {}) {
  const starting = value && !running;
  running = value;
  if (!value) taskDemo = false;
  $('run-status').textContent = value ? '任务进行中' : '准备就绪';
  $('run-status').classList.toggle('running', value);
  if (starting) { resetTelemetry(); beginTaskActivity(metadata); closeReasoningPopup(); }
  if (!value) { clearInterval(taskActivityTimer); taskActivityTimer = null; }
  if (!value) $('task-input').focus();
  renderChatGPTState();
}

function updateState(state, { syncActiveTask = true, syncPendingQueue = true, allowWorkspaceChange = false } = {}) {
  if (!state) return;
  if (!allowWorkspaceChange && !belongsToCurrentWorkspace(state)) return;
  const oldRoot = appState?.workspace?.root;
  const oldIdentity = activeCatalogIdentity();
  appState = state;
  permissionControls?.update(state);
  document.querySelector('.welcome-note').textContent = state.permissionMode === 'full' ? '当前为完全控制：操作将自动批准。' : state.permissionMode === 'assist' ? '低风险操作自动批准，其余操作会请求确认。' : '写入文件与执行命令前会请求你的确认。';
  if (state.browser) browserController?.apply(state.browser);
  syncWindowChrome();
  if (syncPendingQueue && state.promptQueue) syncPromptQueue(state.promptQueue);
  if (syncActiveTask && state.activeTask && !(promptSubmitting && !state.activeTask.running)) {
    const active = state.activeTask;
    contextCompacting = active.compacting === true;
    taskKind = active.kind;
    taskDemo = active.demo === true;
    terminalRunning = active.running === true && active.kind === 'terminal';
    const agentRunning = active.running === true && ['agent', 'undo'].includes(active.kind);
    if (agentRunning !== running) setRunning(agentRunning, active);
    if (agentRunning) restoreTaskActivityFromState();
    if (agentRunning && contextCompacting) setTaskActivityPhase('compacting', '正在压缩上下文…');
    if (terminalRunning) { setTerminalOpen(true); $('terminal-status').textContent = '终端执行中'; }
  }
  syncTextScaleState(state.textScale);
  const identity = activeCatalogIdentity(state);
  if (oldIdentity !== identity) invalidateCatalogs();
  if (Object.hasOwn(state, 'modelCatalog')) {
    if (state.modelCatalog) {
      try {
        currentCatalog = normalizeCatalog(state.modelCatalog, state.settings?.provider || 'openai', currentAuthMode(state.settings));
        currentCatalogKey = identity;
      } catch { currentCatalog = null; currentCatalogKey = ''; }
    } else if (currentCatalog) {
      currentCatalog = null;
      currentCatalogKey = '';
    }
  }
  if (!sessionId && state.sessionId) sessionId = state.sessionId;
  const workspace = state.workspace;
  $('workspace-label').textContent = workspace?.name || (workspace ? baseName(workspace.root) : '选择项目');
  $('workspace-label').title = workspace?.root || '';
  $('project-avatar').textContent = projectInitials(workspace?.name || baseName(workspace?.root) || 'AI');
  $('project-name').textContent = workspace?.name || (workspace ? baseName(workspace.root) : '未选择项目');
  $('conversation-title').textContent = conversationTitle();
  $('temporary-indicator').hidden = state.temporary !== true;
  $('version-label').textContent = state.version ? `v${state.version}` : 'v0.1';
  $('undo-change').disabled = contextBusy() || !workspace;
  const settings = state.settings || {};
  const provider = settings.provider || 'openai';
  const model = settings.model || settings.providers?.[provider]?.model;
  const account = provider === 'openai' && (settings.authMode || settings.providers?.openai?.authMode) === 'chatgpt';
  $('provider-hint').textContent = account ? `ChatGPT 账号 · ${model || '尚未选择模型'}` : model ? `${providerNames[provider] || provider} · ${model}` : '尚未配置模型';
  fillReasoningOptions($('reasoning-effort'), provider, settings.reasoningEffort || settings.providers?.[provider]?.reasoningEffort || 'default');
  setReasoningDisabled(contextBusy() || reasoningSaving);
  renderUsageStats(state.usageStats);
  renderSessionMetrics(state.sessionMetrics);
  renderSessions(state.sessions || []);
  renderChatGPTState();
  renderComposerModel();
  renderModelList();
  if (workspace?.root !== oldRoot) {
    resetEditorAutosave();
    ++editorReadRequest;
    selectedPath = null;
    selectedRow = null;
    selectedEntry = null;
    fileClipboard = null;
    expandedDirectories.clear();
    setEditorDirty(false);
    editorVersion = null;
    editorOriginal = '';
    $('file-content').value = '';
    $('file-content').textContent = '';
    showPreviewTab('file');
    if (workspace) loadFiles();
  }
  if (Object.hasOwn(state, 'fileClipboard')) fileClipboard = state.fileClipboard ? { ...state.fileClipboard } : null;
}

async function openWorkspace() {
  if (projectTransitionBusy() || isChatGPTBusy()) return;
  if (!(await confirmEditorTransition())) return;
  if (projectTransitionBusy() || isChatGPTBusy()) return;
  closeProjectDropdown();
  projectSwitching = true;
  refreshControlLocks();
  try {
    const state = await bridge.chooseWorkspace();
    if (state && belongsToCurrentWorkspace(state)) updateState(state);
  } catch (error) { notice(errorText(error), true); }
  finally { projectSwitching = false; refreshControlLocks(); }
}

async function loadFiles() {
  if (!appState?.workspace) return;
  const request = ++filesRequest;
  const tree = $('file-tree');
  tree.replaceChildren(element('div', 'tree-loading', '正在读取项目…'));
  try {
    const files = await bridge.fileList({ path: '' });
    if (request !== filesRequest) return;
    tree.replaceChildren(createTree(files));
    if (!files.length) tree.append(element('div', 'sidebar-empty', '项目文件夹为空'));
  } catch (error) {
    if (request === filesRequest) tree.replaceChildren(element('div', 'sidebar-empty', errorText(error)));
  }
}

function createTree(files) {
  const list = element('ul', 'tree-list');
  [...files].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)).forEach((file) => {
    const item = element('li', 'tree-item');
    const row = element('button', `file-row ${file.type}`);
    row.type = 'button';
    row.dataset.path = file.path;
    row.dataset.type = file.type;
    row.setAttribute('role', 'treeitem');
    if (selectedEntry?.path === file.path) { row.classList.add('selected'); selectedRow = row; }
    const arrow = element('span', 'file-arrow', file.type === 'directory' ? '›' : '');
    row.append(arrow, element('span', 'file-icon', file.type === 'directory' ? '▱' : '◇'), element('span', 'file-name', file.name));
    row.title = file.path;
    row.addEventListener('focus', () => selectFileEntry(file, row));
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); selectFileEntry(file, row); row.focus(); showFileContextMenu(event.clientX, event.clientY); });
    item.append(row);
    if (file.type === 'directory') {
      row.setAttribute('aria-expanded', 'false');
      let child = null;
      let loading = false;
      row.addEventListener('click', async () => {
        const workspaceId = currentWorkspaceId();
        if (!row.hasAttribute('data-restoring-expansion')) selectFileEntry(file, row);
        if (loading) return;
        if (child) {
          child.hidden = !child.hidden;
          arrow.textContent = child.hidden ? '›' : '⌄';
          row.setAttribute('aria-expanded', String(!child.hidden));
          if (child.hidden) expandedDirectories.delete(file.path); else expandedDirectories.add(file.path);
          return;
        }
        loading = true;
        arrow.textContent = '·';
        try {
          const entries = await bridge.fileList({ path: file.path });
          if (workspaceId !== currentWorkspaceId() || !row.isConnected) return;
          child = element('div', 'tree-children');
          child.append(entries.length ? createTree(entries) : element('div', 'tree-loading', '空文件夹'));
          item.append(child);
          arrow.textContent = '⌄';
          row.setAttribute('aria-expanded', 'true');
          expandedDirectories.add(file.path);
        } catch (error) { if (workspaceId === currentWorkspaceId() && row.isConnected) { arrow.textContent = '›'; notice(errorText(error), true); } }
        finally { loading = false; }
      });
      if (expandedDirectories.has(file.path)) queueMicrotask(() => { if (row.isConnected) { row.setAttribute('data-restoring-expansion', ''); row.click(); row.removeAttribute('data-restoring-expansion'); } });
    } else row.addEventListener('click', () => { selectFileEntry(file, row); previewFile(file.path, row); });
    list.append(item);
  });
  return list;
}

async function previewFile(path, row, { allowNavigation = false } = {}) {
  if (fileOperationBusy({ allowNavigation })) return false;
  const workspaceId = currentWorkspaceId();
  if (path === selectedPath) { if (!editorDirty) refreshSelectedFile(); setPreviewOpen(true); showPreviewTab('file'); return true; }
  if (!(await confirmEditorTransition())) return false;
  if (workspaceId !== currentWorkspaceId() || fileOperationBusy({ allowNavigation })) return false;
  const request = ++editorReadRequest;
  try {
    const file = await bridge.fileRead({ path });
    if (request !== editorReadRequest) return false;
    selectedPath = file.path || path;
    resetEditorAutosave();
    selectFileEntry({ path: selectedPath, name: baseName(selectedPath), type: 'file' }, row || null);
    $('preview-filename').textContent = baseName(selectedPath);
    $('preview-filename').title = selectedPath;
    editorVersion = file.version;
    editorOriginal = file.content;
    $('file-content').value = file.content;
    $('file-content').textContent = file.content;
    setEditorDirty(false);
    $('editor-status').textContent = '自动保存已开启 · UTF-8';
    previewPinned = true;
    document.documentElement.classList.add('preview-pinned', 'file-editor-open');
    $('preview-pin').setAttribute('aria-pressed', 'true');
    setPreviewOpen(true);
    showPreviewTab('file');
    recordNavigation({ type: 'file', path: selectedPath, workspace: workspacePath(appState?.workspace), sessionId });
    return true;
  } catch (error) { if (request === editorReadRequest) notice(errorText(error), true); return false; }
}

function renderSessions(sessions) {
  renderProjectDropdown(sessions);
}

function projectInitials(name) {
  const value = String(name || 'AI').trim();
  return /[\u4e00-\u9fff]/.test(value) ? value.slice(0, 1) : value.slice(0, 2).toUpperCase();
}

function closeProjectDropdown() {
  $('project-dropdown').hidden = true;
  $('project-switcher').setAttribute('aria-expanded', 'false');
}

function renderProjectDropdown(sessions = []) {
  const current = $('project-current-list');
  const recent = $('session-list');
  current.replaceChildren();
  recent.replaceChildren();
  const projects = new Map();
  for (const project of appState?.recentProjects || []) if (project.path) projects.set(workspaceIdentity(project.path), { ...project });
  for (const session of sessions) {
    const path = workspacePath(session.workspace);
    if (!path) continue;
    const key = workspaceIdentity(path);
    const project = projects.get(key) || { path, name: baseName(path) };
    if (!project.sessionId) project.sessionId = session.id;
    if (!project.lastOpenedAt) project.lastOpenedAt = session.updatedAt;
    projects.set(key, project);
  }
  for (const workspace of appState?.openWorkspaces || []) {
    if (!workspace.root) continue;
    const key = workspaceIdentity(workspace.root);
    projects.set(key, { ...projects.get(key), ...workspace, path: workspace.root, current: workspace.workspaceId === currentWorkspaceId() });
  }
  const root = workspacePath(appState?.workspace);
  const rootKey = workspaceIdentity(root);
  if (root) {
    const project = projects.get(rootKey) || { path: root, name: baseName(root) };
    project.current = true;
    projects.set(rootKey, project);
  }
  const projectButton = (project) => {
    const button = element('button', `recent-project${project.current ? ' active' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.dataset.workspace = project.path;
    button.disabled = projectTransitionBusy() || isChatGPTBusy();
    button.title = project.path;
    const icon = element('span', 'project-avatar', projectInitials(project.name || baseName(project.path)));
    const copy = element('span', 'recent-project-copy');
    const heading = element('span', 'recent-project-heading');
    heading.append(element('strong', '', project.name || baseName(project.path)));
    if (project.sessionId) heading.append(element('small', 'project-history-badge', '含历史会话'));
    const status = project.approvalCount > 0 ? `待批准 ${project.approvalCount}`
      : project.running ? '运行中' : project.pendingCount > 0 ? `待发送 ${project.pendingCount}` : '';
    if (status) {
      const badge = element('small', 'project-run-badge', status);
      badge.dataset.status = project.approvalCount > 0 ? 'approval' : project.running ? 'running' : 'queued';
      heading.append(badge);
    }
    if (project.pendingCount > 0 && (project.running || project.approvalCount > 0)) heading.append(element('small', 'project-history-badge', `待发送 ${project.pendingCount}`));
    copy.append(heading, element('span', 'recent-project-path', project.path));
    button.append(icon, copy);
    if (project.current) button.append(element('span', 'project-current-check', '✓'));
    button.addEventListener('click', () => openRecentProject(project));
    return button;
  };
  const values = [...projects.values()];
  for (const project of values) (project.current ? current : recent).append(projectButton(project));
  $('project-current-section').hidden = !root;
  if (!values.some((project) => !project.current)) recent.append(element('p', 'recent-project-empty', '打开过的项目和历史会话会显示在这里。'));
  $('project-open').disabled = projectTransitionBusy() || isChatGPTBusy();
  $('project-create').disabled = projectTransitionBusy() || isChatGPTBusy();
}

async function openRecentProject(project) {
  if (projectTransitionBusy() || isChatGPTBusy() || !(await confirmEditorTransition())) return;
  if (projectTransitionBusy() || isChatGPTBusy()) return;
  closeProjectDropdown();
  projectSwitching = true;
  refreshControlLocks();
  try {
    const state = await bridge.openProject({ path: project.path });
    if (state && belongsToCurrentWorkspace(state)) updateState(state);
  } catch (error) { notice(errorText(error), true); }
  finally { projectSwitching = false; refreshControlLocks(); }
}

async function createProject() {
  if (projectTransitionBusy() || isChatGPTBusy() || !(await confirmEditorTransition())) return;
  if (projectTransitionBusy() || isChatGPTBusy()) return;
  closeProjectDropdown();
  projectSwitching = true;
  refreshControlLocks();
  try { const state = await bridge.createProject(); if (state && belongsToCurrentWorkspace(state)) updateState(state); }
  catch (error) { notice(errorText(error), true); }
  finally { projectSwitching = false; refreshControlLocks(); }
}

function selectFileEntry(entry, row) {
  selectedRow?.classList.remove('selected');
  selectedEntry = entry;
  selectedRow = row;
  selectedRow?.classList.add('selected');
}

function selectedDirectory() {
  if (!selectedEntry) return '';
  if (selectedEntry.type === 'directory') return selectedEntry.path;
  const path = String(selectedEntry.path);
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator < 0 ? '' : path.slice(0, separator);
}

function setEditorDirty(value) {
  editorDirty = !!value;
  $('editor-dirty').hidden = !editorDirty;
  $('file-preview-tab').textContent = editorDirty ? '文件 ●' : '文件';
  if (typeof bridge?.setEditorDirty === 'function') bridge.setEditorDirty({ dirty: editorDirty || editorSaving }).catch(() => {});
  refreshFileLocks();
}

function refreshFileLocks() {
  const locked = fileOperationBusy();
  $('new-file').disabled = locked || !appState?.workspace;
  $('new-folder').disabled = locked || !appState?.workspace;
  $('save-file').disabled = locked || !selectedPath || (!editorDirty && !editorSaving);
  $('file-content').readOnly = fileOperationBusy({ allowSaving: true }) || !selectedPath;
  $('file-content').setAttribute('aria-readonly', String($('file-content').readOnly));
  const projectLocked = projectTransitionBusy() || isChatGPTBusy();
  $('project-open').disabled = projectLocked;
  $('project-create').disabled = projectLocked;
  document.querySelectorAll('.recent-project').forEach((button) => { button.disabled = projectLocked; });
  if (editorDirty && !locked && !editorSaving && !editorSaveTimer && !editorAutoSavePaused && !unsavedDecision) scheduleEditorAutosave();
}

function resetEditorAutosave() {
  clearTimeout(editorSaveTimer);
  editorSaveTimer = null;
  editorAutoSavePaused = false;
  editorSaveError = '';
  ++editorDocumentEpoch;
}

function scheduleEditorAutosave() {
  clearTimeout(editorSaveTimer);
  editorSaveTimer = null;
  if (!selectedPath || !editorDirty || editorAutoSavePaused || fileOperationBusy()) return;
  editorSaveTimer = setTimeout(() => {
    editorSaveTimer = null;
    saveEditor({ automatic: true });
  }, 500);
}

async function saveEditor(options = {}) {
  const automatic = options.automatic === true;
  clearTimeout(editorSaveTimer);
  editorSaveTimer = null;
  if (editorSavePromise) return editorSavePromise;
  if (!selectedPath || !editorDirty) return true;
  if (automatic && editorAutoSavePaused) return false;
  if (fileOperationBusy()) {
    $('editor-status').textContent = '等待当前文件操作结束后自动保存 · 编辑内容仍保留';
    if (!automatic) notice('请等待当前文件操作结束后保存文件。');
    return false;
  }
  if (!automatic) { editorAutoSavePaused = false; editorSaveError = ''; }
  const path = selectedPath;
  const epoch = editorDocumentEpoch;
  const workspaceId = currentWorkspaceId();
  editorSaving = true;
  setEditorDirty(editorDirty);
  refreshControlLocks();
  const operation = (async () => {
    try {
      while (workspaceId === currentWorkspaceId() && selectedPath === path && editorDocumentEpoch === epoch) {
        if (!editorDirty) return true;
        if (fileOperationBusy({ allowSaving: true })) return false;
        const content = $('file-content').value;
        const expectedVersion = editorVersion;
        $('editor-status').textContent = '正在自动保存…';
        const result = await bridge.fileSave({ path, content, expectedVersion });
        if (workspaceId !== currentWorkspaceId() || selectedPath !== path || editorDocumentEpoch !== epoch) return false;
        editorVersion = result.version;
        editorOriginal = content;
        $('file-content').textContent = content;
        editorAutoSavePaused = false;
        editorSaveError = '';
        setEditorDirty($('file-content').value !== content);
        $('editor-status').textContent = editorDirty ? '正在保存后续更改…' : '已自动保存 · UTF-8';
        // A later keystroke stays in the textarea and is saved with this new version.
      }
      return false;
    } catch (error) {
      if (workspaceId === currentWorkspaceId() && selectedPath === path && editorDocumentEpoch === epoch) {
        editorAutoSavePaused = true;
        editorSaveError = errorText(error);
        setEditorDirty(true);
        $('editor-status').textContent = `自动保存已暂停 · ${editorSaveError} · Ctrl+S 重试`;
        notice(`自动保存已暂停：${editorSaveError}。编辑内容已保留，可按 Ctrl+S 重试。`, true);
      }
      return false;
    }
  })();
  editorSavePromise = operation;
  try { return await operation; }
  finally {
    if (editorSavePromise === operation) {
      editorSavePromise = null;
      editorSaving = false;
      setEditorDirty(editorDirty);
      refreshControlLocks();
    }
  }
}

async function flushEditorAutosave() {
  clearTimeout(editorSaveTimer);
  editorSaveTimer = null;
  if (editorSavePromise && !(await editorSavePromise)) return false;
  if (!editorDirty) return true;
  if (editorAutoSavePaused) return false;
  return saveEditor({ automatic: true });
}

async function confirmEditorTransition() {
  if ((editorDirty || editorSavePromise) && await flushEditorAutosave() && !editorDirty) return true;
  if (!editorDirty) return true;
  if (unsavedDecision) return false;
  const choice = await new Promise((resolve) => {
    unsavedDecision = resolve;
    $('editor-unsaved-message').textContent = `“${baseName(selectedPath)}”有尚未保存的更改。`;
    $('editor-unsaved-dialog').showModal();
    $('editor-unsaved-save').disabled = fileOperationBusy({ allowDialog: true });
    $('editor-unsaved-save').focus();
  });
  if (choice === 'save') return saveEditor();
  if (choice === 'discard') {
    clearTimeout(editorSaveTimer);
    editorSaveTimer = null;
    editorAutoSavePaused = false;
    editorSaveError = '';
    $('file-content').value = editorOriginal;
    setEditorDirty(false);
    return true;
  }
  return false;
}

function answerUnsaved(choice) {
  const resolve = unsavedDecision;
  unsavedDecision = null;
  $('editor-unsaved-dialog').close();
  resolve?.(choice);
}

function askFileName({ title, value = '', parent = '' }) {
  if (fileNameRequest) return Promise.resolve(null);
  return new Promise((resolve) => {
    fileNameRequest = resolve;
    $('file-name-title').textContent = title;
    $('file-name-input').value = value;
    $('file-name-parent').textContent = parent || appState?.workspace?.root || '';
    $('file-name-error').hidden = true;
    $('file-name-dialog').showModal();
    $('file-name-input').focus();
    $('file-name-input').select();
  });
}

function answerFileName(value) {
  const resolve = fileNameRequest;
  fileNameRequest = null;
  $('file-name-dialog').close();
  resolve?.(value);
}

async function explorerAction(action) {
  const entry = selectedEntry;
  const directory = selectedDirectory();
  const workspaceId = currentWorkspaceId();
  closeFileContextMenu();
  if (!appState?.workspace || fileOperationBusy()) return;
  if (action === 'open' && entry?.type === 'file') return previewFile(entry.path, selectedRow);
  let mutationOwned = false;
  const lock = () => { mutationOwned = true; fileMutationBusy = true; refreshControlLocks(); };
  const unlock = () => { if (mutationOwned) { mutationOwned = false; fileMutationBusy = false; } };
  try {
    if (action === 'reveal' || action === 'copy-path' || action === 'copy-relative-path') {
      if (!entry) return;
      lock();
      if (action === 'reveal') await bridge.fileReveal({ path: entry.path });
      else await bridge.fileCopyPath({ path: entry.path, relative: action === 'copy-relative-path' });
      return;
    }
    if (action === 'copy' || action === 'cut') {
      if (!entry) return;
      lock();
      const result = await bridge.fileClipboard({ path: entry.path, mode: action });
      if (workspaceId === currentWorkspaceId()) fileClipboard = result;
      return;
    }
    if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
    if (workspaceId !== currentWorkspaceId() || fileOperationBusy()) return;
    const targetEdited = entry && selectedPath && (entry.path === selectedPath || String(selectedPath).startsWith(`${entry.path}/`) || String(selectedPath).startsWith(`${entry.path}\\`));
    const movingEditor = action === 'paste' && fileClipboard?.mode === 'cut' && selectedPath && (fileClipboard.path === selectedPath || String(selectedPath).startsWith(`${fileClipboard.path}/`) || String(selectedPath).startsWith(`${fileClipboard.path}\\`));
    let args;
    let method;
    if (action === 'new-file' || action === 'new-folder') {
      const parent = directory;
      const name = await askFileName({ title: action === 'new-file' ? '新建文件' : '新建文件夹', parent });
      if (!name) return;
      args = { parent, name, type: action === 'new-file' ? 'file' : 'directory' };
      method = 'fileCreate';
    } else if (action === 'rename') {
      if (!entry) return;
      const name = await askFileName({ title: '重命名', value: entry.name || baseName(entry.path), parent: entry.path });
      if (!name || name === (entry.name || baseName(entry.path))) return;
      method = 'fileRename'; args = { path: entry.path, name };
    } else if (action === 'delete') {
      if (!entry) return;
      method = 'fileDelete'; args = { path: entry.path };
    } else if (action === 'paste') {
      if (!fileClipboard) return;
      method = 'filePaste'; args = { destination: directory };
    } else return;
    if (workspaceId !== currentWorkspaceId() || fileOperationBusy()) return;
    lock();
    ++editorReadRequest;
    const result = await bridge[method](args);
    if (workspaceId !== currentWorkspaceId() || result?.canceled) return;
    if (movingEditor && result?.source && result?.path) {
      resetEditorAutosave();
      selectedPath = result.path + selectedPath.slice(result.source.length);
      $('preview-filename').textContent = baseName(selectedPath);
      $('preview-filename').title = selectedPath;
      refreshSelectedFile();
    }
    if (action === 'paste' && fileClipboard?.mode === 'cut') fileClipboard = null;
    if (targetEdited && action === 'delete') {
      resetEditorAutosave();
      selectedPath = null;
      editorVersion = null;
      editorOriginal = '';
      $('file-content').value = '';
      $('file-content').textContent = '';
      setEditorDirty(false);
      showPreviewTab('file');
    } else if (targetEdited && action === 'rename') {
      const target = result.path || result.destination;
      if (target) {
        resetEditorAutosave();
        selectedPath = target + selectedPath.slice(entry.path.length);
        $('preview-filename').textContent = baseName(selectedPath);
        $('preview-filename').title = selectedPath;
        refreshSelectedFile();
      }
    }
    selectedEntry = null;
    selectedRow = null;
    await loadFiles();
    if (workspaceId !== currentWorkspaceId()) return;
    unlock();
    refreshControlLocks();
    if (action === 'new-file' && result?.path) await previewFile(result.path);
  } catch (error) { if (workspaceId === currentWorkspaceId()) notice(errorText(error), true); }
  finally { unlock(); refreshControlLocks(); }
}

function closeFileContextMenu() { $('file-context-menu').hidden = true; }

async function requestPreviewOpen(open) {
  if (!open && editorDirty && !(await confirmEditorTransition())) return;
  setPreviewOpen(open);
}

function bindExplorer() {
  $('project-switcher').addEventListener('click', () => {
    const open = $('project-dropdown').hidden;
    if (open) { renderProjectDropdown(appState?.sessions || []); closeReasoningPopup(); closeFileContextMenu(); }
    $('project-dropdown').hidden = !open;
    $('project-switcher').setAttribute('aria-expanded', String(open));
  });
  $('project-open').addEventListener('click', openWorkspace);
  $('project-create').addEventListener('click', createProject);
  $('project-dropdown').addEventListener('keydown', (event) => {
    const buttons = [...$('project-dropdown').querySelectorAll('button:not(:disabled)')].filter((button) => button.getClientRects().length);
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  $('project-switcher').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if ($('project-dropdown').hidden) $('project-switcher').click(); $('project-dropdown').querySelector('button:not(:disabled)')?.focus(); }
  });
  $('new-file').addEventListener('click', () => explorerAction('new-file'));
  $('new-folder').addEventListener('click', () => explorerAction('new-folder'));
  $('file-tree').addEventListener('contextmenu', (event) => {
    if (event.target.closest('.file-row')) return;
    event.preventDefault();
    selectFileEntry(null, null);
    showFileContextMenu(event.clientX, event.clientY);
  });
  $('file-context-menu').addEventListener('keydown', (event) => {
    const buttons = [...$('file-context-menu').querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  });
  $('file-name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('file-name-input').value.trim();
    if (!name || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) {
      $('file-name-error').textContent = '请输入有效的文件或文件夹名称，不包含路径分隔符。';
      $('file-name-error').hidden = false;
      return;
    }
    answerFileName(name);
  });
  ['file-name-close', 'file-name-cancel'].forEach((id) => $(id).addEventListener('click', () => answerFileName(null)));
  $('file-name-dialog').addEventListener('cancel', (event) => { event.preventDefault(); answerFileName(null); });
  $('editor-unsaved-save').addEventListener('click', () => answerUnsaved('save'));
  $('editor-unsaved-discard').addEventListener('click', () => answerUnsaved('discard'));
  $('editor-unsaved-cancel').addEventListener('click', () => answerUnsaved('cancel'));
  $('editor-unsaved-dialog').addEventListener('cancel', (event) => { event.preventDefault(); answerUnsaved('cancel'); });
  $('file-content').addEventListener('input', () => {
    setEditorDirty($('file-content').value !== editorOriginal || editorAutoSavePaused);
    $('editor-status').textContent = editorAutoSavePaused
      ? `自动保存已暂停 · ${editorSaveError} · Ctrl+S 重试`
      : editorSaving ? '正在自动保存 · 新输入将继续保存' : editorDirty ? '等待自动保存…' : '已自动保存 · UTF-8';
    scheduleEditorAutosave();
  });
  $('file-content').addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey && !$('file-content').readOnly) {
      event.preventDefault();
      const editor = $('file-content');
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  $('save-file').addEventListener('click', saveEditor);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.project-switcher-wrap')) closeProjectDropdown();
    if (!$('file-context-menu').contains(event.target)) closeFileContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's' && selectedPath) { event.preventDefault(); saveEditor(); return; }
    if (!$('file-tree').contains(document.activeElement)) return;
    const key = event.key.toLowerCase();
    const action = event.ctrlKey && !event.altKey && !event.shiftKey ? { c: 'copy', x: 'cut', v: 'paste' }[key] : !event.ctrlKey && !event.altKey ? { F2: 'rename', Delete: 'delete', Enter: 'open' }[event.key] : null;
    if (action) { event.preventDefault(); explorerAction(action); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const rows = [...$('file-tree').querySelectorAll('.file-row')].filter((row) => row.getClientRects().length);
      const index = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      rows[next]?.focus();
    }
    if (selectedEntry?.type === 'directory' && ((event.key === 'ArrowRight' && selectedRow?.getAttribute('aria-expanded') === 'false') || (event.key === 'ArrowLeft' && selectedRow?.getAttribute('aria-expanded') === 'true'))) { event.preventDefault(); selectedRow.click(); }
  });
  initializeEditorSizing();
}

function initializeEditorSizing() {
  document.documentElement.classList.add('editor-layout');
  for (const sheet of document.styleSheets) {
    editorSizeRule = [...sheet.cssRules].find((rule) => rule.selectorText === ':root.editor-layout') || editorSizeRule;
  }
  const resize = (width) => {
    editorWidth = Math.max(300, Math.min(Math.max(300, innerWidth - (document.documentElement.classList.contains('sidebar-hidden') ? 0 : sidebarWidth) - 320), width));
    editorSizeRule?.style.setProperty('--editor-width', `${editorWidth}px`);
    $('editor-resizer').setAttribute('aria-valuenow', String(Math.round(editorWidth)));
  };
  const handle = $('editor-resizer');
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, width: $('preview-panel').getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('is-resizing-editor');
  });
  handle.addEventListener('pointermove', (event) => { if (drag) resize(drag.width + drag.x - event.clientX); });
  const finish = () => { drag = null; document.documentElement.classList.remove('is-resizing-editor'); };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(editorWidth + (event.key === 'ArrowLeft' ? 20 : -20)); } });
  handle.addEventListener('dblclick', () => resize(470));
  window.addEventListener('resize', () => { resize(editorWidth); closeFileContextMenu(); });
  resize(editorWidth);
}

function showFileContextMenu(x, y) {
  const menu = $('file-context-menu');
  menu.replaceChildren();
  const actions = [['open', '打开', 'Enter'], ['reveal', '打开文件所在位置'], null, ['new-file', '新建文件…'], ['new-folder', '新建文件夹…'], null, ['cut', '剪切', 'Ctrl+X'], ['copy', '复制', 'Ctrl+C'], ['paste', '粘贴', 'Ctrl+V'], null, ['copy-path', '复制路径'], ['copy-relative-path', '复制相对路径'], null, ['rename', '重命名…', 'F2'], ['delete', '删除', 'Delete']];
  const locked = fileOperationBusy();
  for (const action of actions) {
    if (!action) { menu.append(element('div', 'app-menu-separator')); continue; }
    const button = element('button', 'app-menu-item');
    button.type = 'button';
    button.dataset.fileAction = action[0];
    button.setAttribute('role', 'menuitem');
    button.append(element('span', 'app-menu-label', action[1]), element('span', 'app-menu-shortcut', action[2] || ''));
    button.disabled = locked || (action[0] === 'open' ? selectedEntry?.type !== 'file' : action[0] === 'reveal' || action[0].startsWith('copy-') ? !selectedEntry : (['cut', 'copy', 'rename', 'delete'].includes(action[0]) && !selectedEntry) || (action[0] === 'paste' && !fileClipboard));
    button.addEventListener('click', () => explorerAction(action[0]));
    menu.append(button);
  }
  menu.hidden = false;
  for (const sheet of document.styleSheets) {
    const rule = [...sheet.cssRules].find((candidate) => candidate.selectorText === '#file-context-menu');
    if (!rule) continue;
    rule.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
    rule.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
    break;
  }
  menu.querySelector('button:not(:disabled)')?.focus();
}

function clearConversation() {
  contextCompactionNotices.clear();
  $('messages').replaceChildren();
  renderedUserMessageIds.clear();
  $('welcome').hidden = false;
  $('conversation-title').textContent = conversationTitle();
  $('token-usage').textContent = '请检查生成的代码与命令';
  renderSessionMetrics(null);
  resetTelemetry();
  streamedMessage = null;
  streamedText = '';
  pendingTools = [];
  commandOutput = null;
  changes = [];
  approvals.clear();
  renderChanges();
}

async function newSession(options = {}) {
  if (contextBusy() || isChatGPTBusy()) return;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
  const workspaceId = currentWorkspaceId();
  try {
    const session = await bridge.newSession(options);
    if (workspaceId !== currentWorkspaceId()) return;
    sessionId = session.id;
    appState = { ...appState, sessionId: session.id, temporary: session.temporary === true,
      sessionMetrics: session.sessionMetrics || (appState?.sessionId === session.id ? appState.sessionMetrics : null) };
    $('temporary-indicator').hidden = session.temporary !== true;
    ++sessionRequest;
    clearConversation();
    renderSessionMetrics(appState.sessionMetrics);
    refreshControlLocks();
    renderSessions(appState?.sessions || []);
    $('task-input').focus();
  } catch (error) { if (workspaceId === currentWorkspaceId()) notice(errorText(error), true); }
}

async function loadSession(id) {
  if (isChatGPTBusy()) return;
  if (contextBusy()) { notice('请先停止当前任务，并发送或清空待发送内容，再切换历史对话。'); return; }
  if (!(await confirmEditorTransition())) return;
  closeProjectDropdown();
  const request = ++sessionRequest;
  try {
    const session = await bridge.getSession({ id });
    if (request !== sessionRequest) return;
    renderSessionSnapshot(session);
    recordNavigation({ type: 'session', id: session.id, workspace: workspacePath(session.workspace) || workspacePath(appState?.workspace) });
  } catch (error) { notice(errorText(error), true); }
}

function appendContextCompactionNotice(event) {
  const key = `${event.runId || ''}:${event.count || 0}:${event.throughIndex || 0}:${event.messageIndex || 0}`;
  if (contextCompactionNotices.has(key)) return;
  contextCompactionNotices.add(key);
  const note = element('div', 'context-compaction-notice');
  note.setAttribute('role', 'status');
  note.dataset.count = String(event.count || 1);
  note.append(element('span', 'context-compaction-mark', '↻'), element('span', 'context-compaction-message', '上下文已自动压缩'));
  if (Number.isFinite(event.beforeChars) && Number.isFinite(event.afterChars)) note.title = `发送给模型的上下文：${event.beforeChars.toLocaleString()} → ${event.afterChars.toLocaleString()} 字符；完整聊天记录保留。`;
  $('messages').append(note);
}

function renderSessionSnapshot(session) {
  const metrics = session.sessionMetrics || (appState?.sessionId === session.id ? appState.sessionMetrics : null);
  clearConversation();
  sessionId = session.id;
  appState = { ...appState, sessionId: session.id, sessionMetrics: metrics };
  renderSessionMetrics(metrics);
  sessionControls?.update({ ...appState, sessionId, busy: contextBusy(), authBusy: isChatGPTBusy() });
  if (typeof session.temporary === 'boolean') appState = { ...appState, temporary: session.temporary };
  $('temporary-indicator').hidden = appState?.temporary !== true;
  $('conversation-title').textContent = conversationTitle(session);
  const records = historicalTaskRecords(session);
  const compactions = (session.events || []).filter(event => event.type === 'context-compacted');
  const renderedCompactions = new Set();
  const rendered = new Set();
  (session.messages || []).forEach((message, index) => {
    compactions.forEach((event) => {
      if (!renderedCompactions.has(event) && Number.isInteger(event.messageIndex) && event.messageIndex <= index) { appendContextCompactionNotice(event); renderedCompactions.add(event); }
    });
    if (['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && (message.content || (message.role === 'user' && messageImageAttachments(message.attachments).length))) addMessage(message.role, message.content, false, { id: message.id, source: message.source, createdAt: message.createdAt, attachments: message.attachments });
    records.forEach((record) => {
      if (!rendered.has(record) && Number.isInteger(record.messageIndex) && record.messageIndex <= index) { renderHistoricalTaskActivity(record); rendered.add(record); }
    });
  });
  records.forEach((record) => { if (!rendered.has(record)) renderHistoricalTaskActivity(record); });
  compactions.forEach((event) => { if (!renderedCompactions.has(event)) appendContextCompactionNotice(event); });
  restoreTaskActivityFromState();
  renderSessions(appState?.sessions || []);
  scrollBottom(true);
}

function showPreviewTab(tab) {
  $('browser-preview-tab').classList.toggle('active', tab === 'browser');
  $('browser-preview').hidden = tab !== 'browser';
  $('preview-panel').classList.toggle('browser-active', tab === 'browser');
  document.documentElement.classList.toggle('browser-panel-open', tab === 'browser' && !$('preview-panel').hidden);
  browserController?.sync();
  $('file-preview-tab').classList.toggle('active', tab === 'file');
  $('changes-preview-tab').classList.toggle('active', tab === 'changes');
  $('changes-preview').hidden = tab !== 'changes';
  $('file-preview').hidden = tab !== 'file' || !selectedPath;
  $('preview-empty').hidden = tab !== 'file' || !!selectedPath;
}

function setPreviewOpen(open) {
  $('preview-panel').hidden = !open;
  document.documentElement.classList.toggle('browser-panel-open', open && !$('browser-preview').hidden);
  browserController?.sync();
  $('toggle-preview').setAttribute('aria-expanded', String(open));
  document.documentElement.classList.toggle('file-editor-open', open && !!selectedPath);
  notifyMenuState();
}

function diffSide(label, content, className) {
  const side = element('div', `diff-side ${className}`);
  side.append(element('div', 'diff-heading', label));
  const value = content === undefined || content === null ? '（文件不存在）' : content === '' ? '（空文件）' : content;
  const pre = element('pre', '', value);
  pre.tabIndex = 0;
  side.append(pre);
  return side;
}

function renderChanges() {
  $('change-count').textContent = changes.length;
  $('changes-empty').hidden = !!changes.length;
  const list = $('change-list');
  list.replaceChildren();
  changes.forEach((change) => {
    const card = element('article', 'change-card');
    card.append(element('div', 'change-path', change.path || change.title || '文件修改'));
    card.append(element('div', 'change-status', change.status || '等待确认'));
    const diff = element('div', 'change-diff');
    diff.append(diffSide('修改前', change.before, 'before'), diffSide('修改后', change.after, 'after'));
    card.append(diff);
    list.append(card);
  });
}

function addTool(event) {
  finishStream();
  showConversation();
  updateTelemetry({ phase: 'tool', tokensPerSecond: null });
  setTaskActivityPhase('tool', toolActivity(event.name, event.args));
  commandOutput = null;
  const card = element('details', 'tool-card running');
  const summary = element('summary', 'tool-summary');
  const badge = element('span', 'tool-badge', '执行中');
  summary.append(element('span', 'tool-mark', '⌘'), element('span', 'tool-title', event.name || '工具调用'), badge);
  const details = element('div', 'tool-details');
  details.append(element('div', 'tool-label', '输入参数'), element('pre', '', safeString(event.args)));
  card.append(summary, details);
  $('messages').append(card);
  pendingTools.push({ name: event.name, args: event.args, card, details, badge });
  moveTaskActivityToEnd();
  scrollBottom();
}

function completeTool(event) {
  const index = pendingTools.findIndex((tool) => tool.name === event.name);
  const tool = index >= 0 ? pendingTools.splice(index, 1)[0] : null;
  if (!tool) return;
  let result = event.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Human-readable failures stay in the original tool detail. */ } }
  const denied = result?.denied === true || result?.canceled === true || (typeof result === 'string' && /^操作已停止，未执行/.test(result));
  const failed = result?.error || (typeof result === 'string' && /^(?:错误|工具执行失败|Error)/i.test(result));
  const command = String(event.name || '').replace(/（模拟）/g, '') === 'run_command';
  tool.card.classList.remove('running');
  tool.badge.textContent = denied ? '未执行' : failed ? '返回错误' : '已返回';
  tool.details.append(element('div', 'tool-label', '执行结果'), element('pre', '', safeString(event.result)));
  const status = denied ? command ? '命令未执行' : '操作未执行'
    : failed ? '工具未完成，继续处理'
    : command && result?.terminated ? '命令已停止'
    : command && Number.isFinite(result?.exitCode) && result.exitCode !== 0 ? `命令已结束 · 退出代码 ${result.exitCode}`
    : toolActivity(event.name, tool.args, true);
  setTaskActivityPhase('tool', status);
  scrollBottom();
}

function approvalRequest(event) {
  const workspaceId = currentWorkspaceId();
  finishStream();
  showConversation();
  const card = element('article', 'approval-card');
  const header = element('div', 'approval-header');
  header.append(element('span', 'approval-icon', '◇'), element('strong', '', event.title || (event.kind === 'command' ? '确认执行终端命令' : '确认写入文件')));
  const body = element('div', 'approval-body');
  body.tabIndex = 0;
  body.setAttribute('aria-label', '操作详情，可滚动查看完整内容');
  card.append(header, body);
  body.append(element('div', 'approval-detail', event.detail || '请查看以下操作，确认后继续。'));
  if (event.path) body.append(element('div', 'approval-path', `${event.kind === 'command' ? '执行目录' : '文件路径'}：${event.path}`));
  if (event.kind === 'command') body.append(element('pre', 'approval-command', event.command || '（未提供命令）'));
  else if (event.kind === 'browser') {
    body.append(element('pre', 'approval-command', [event.url, event.selector, event.action].filter(Boolean).join('\n')));
  } else {
    const diff = element('div', 'approval-diff');
    diff.append(diffSide('修改前 · 完整内容', event.before, 'before'), diffSide('修改后 · 完整内容', event.after, 'after'));
    body.append(diff);
    changes.push({ ...event, status: '等待确认' });
    renderChanges();
    showPreviewTab('changes');
  }
  const actions = element('div', 'approval-actions');
  actions.append(element('span', '', '由你决定是否继续'));
  const reject = element('button', 'button approval-reject', '拒绝');
  const accept = element('button', 'button approval-accept', event.kind === 'command' ? '允许执行' : event.kind === 'browser' ? '允许操作' : '允许写入');
  if (event.kind === 'command' && !event.command) accept.disabled = true;
  const respond = async (approved) => {
    reject.disabled = true;
    accept.disabled = true;
    try {
      await bridge.respondApproval({ id: event.id, approved });
      if (workspaceId !== currentWorkspaceId()) return;
      actions.replaceWith(element('div', 'approval-resolved', approved ? (terminalRunning ? '✓ 已批准，请在底部终端查看结果' : '✓ 已批准，等待工具返回执行结果') : '× 已拒绝此操作'));
      approvals.delete(event.id);
      if (running) setTaskActivityPhase(approved ? 'tool' : 'waiting', approved ? event.kind === 'command' ? '正在运行命令' : '正在写入文件' : '操作已拒绝，等待模型');
      const change = changes.find((entry) => entry.id === event.id);
      if (change) { change.status = approved ? '已批准 · 请查看工具执行结果' : '已拒绝'; renderChanges(); }
      $('run-status').textContent = running ? '任务进行中' : terminalRunning ? '终端执行中' : '准备就绪';
    } catch (error) {
      if (workspaceId !== currentWorkspaceId()) return;
      reject.disabled = false; accept.disabled = false; notice(errorText(error), true);
    }
  };
  reject.addEventListener('click', () => respond(false));
  accept.addEventListener('click', () => respond(true));
  actions.append(reject, accept);
  card.append(actions);
  approvals.set(event.id, { actions, reject, accept });
  $('messages').append(card);
  updateTelemetry({ phase: 'approval', tokensPerSecond: null });
  if (running) setTaskActivityPhase('approval', event.kind === 'command' ? '等待确认：运行命令' : '等待确认：写入文件');
  else $('run-status').textContent = '等待你的确认';
  moveTaskActivityToEnd();
  scrollBottom(true);
}

async function runTask(demo = false, mode = 'queue') {
  if (projectSwitching) return;
  if (running && taskKind === 'undo') return;
  if (terminalRunning || promptSubmitting || reasoningSaving || modelSaving || settingsSaving || isChatGPTBusy() || (demo && contextBusy())) return;
  if (mode === 'steer' && !canSteerPrompt()) return;
  if (!demo && !bridge.submitPrompt && running) return;
  if (!demo && draftAttachments.some((attachment) => attachment.loading)) { notice('请等待图片读取完成。'); return; }
  const attachmentSnapshot = demo ? [] : draftAttachments.filter((attachment) => !attachment.loading).map((attachment) => ({ ...attachment }));
  const attachments = attachmentSnapshot.map(({ name, mediaType, dataUrl }) => ({ name, mediaType, dataUrl }));
  const submittedAttachmentIds = new Set(attachmentSnapshot.map((attachment) => attachment.localId));
  const text = $('task-input').value.trim() || (demo ? '演示如何阅读项目、提出文件修改并请求执行确认。' : '');
  if (!text && !attachments.length) { $('task-input').focus(); return; }
  if (!demo && text.length > 40000) { notice('任务最多支持 40000 个字符，请缩短后再发送。'); return; }
  if (!demo && !appState?.workspace) { notice('请先打开一个项目文件夹。'); return; }
  const settings = appState?.settings || {};
  const provider = settings.provider || 'openai';
  const config = settings.providers?.[provider] || {};
  const account = provider === 'openai' && (settings.authMode || config.authMode) === 'chatgpt';
  if (!demo && !(settings.model || config.model)) {
    notice('请先在模型设置中获取目录并选择模型，再发送任务。');
    openSettings();
    return;
  }
  if (!demo && account && (appState?.chatgpt?.session?.status !== 'connected' || appState?.chatgpt?.session?.sharing !== true)) {
    notice('请先通过官方页面连接 ChatGPT，并同意使用套餐用量。身份登录本身不代表推理权限。');
    openSettings();
    return;
  }
  if (!demo && !account && !config.hasKey) {
    notice('请先配置当前服务商的 API Key，再发送任务。');
    openSettings();
    return;
  }
  if (attachments.length && modelExplicitlyTextOnly()) { notice('当前模型不支持图片，请切换支持图片的模型后再发送。', true); return; }
  if (!running && (editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
  if (projectSwitching) return;
  $('notice').hidden = true;
  if (!demo && typeof bridge.submitPrompt === 'function') {
    if (promptQueue.items.length >= 20) { notice('待发送列表最多保留 20 条，请先删除或发送部分内容。'); return; }
    const draft = $('task-input').value;
    promptSubmitting = true;
    refreshControlLocks();
    try {
      await bridge.submitPrompt({ text, attachments, mode: mode === 'steer' ? 'steer' : 'queue' });
      if ($('task-input').value === draft) $('task-input').value = '';
      clearSubmittedAttachments(submittedAttachmentIds);
      $('task-input').focus();
    } catch (error) { notice(errorText(error), true); }
    finally { promptSubmitting = false; refreshControlLocks(); }
    return;
  }
  const draft = $('task-input').value;
  addMessage('user', text, false, { attachments });
  $('conversation-title').textContent = conversationTitle();
  followOutput = true;
  scrollBottom(true);
  commandOutput = null;
  taskDemo = demo;
  taskKind = 'agent';
  setRunning(true);
  try {
    await bridge.runTask({ text, demo, attachments });
    if ($('task-input').value === draft) $('task-input').value = '';
    clearSubmittedAttachments(submittedAttachmentIds);
  }
  catch (error) {
    finishStream();
    finishTaskActivity({ status: 'failed' });
    setRunning(false);
    notice(errorText(error), true);
  }
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'workspace-activated') {
    activateWorkspace(event.state, event.session);
    return;
  }
  if (event.type === 'workspace-update') {
    if (appState) {
      appState = { ...appState, ...(Array.isArray(event.openWorkspaces) ? { openWorkspaces: event.openWorkspaces } : {}), ...(event.usageStats ? { usageStats: event.usageStats } : {}) };
      if (event.usageStats) renderUsageStats(event.usageStats);
      renderProjectDropdown(appState.sessions || []);
    }
    return;
  }
  if (!belongsToCurrentWorkspace(event) && !['window-state', 'editor-close-request', 'find-result'].includes(event.type)) return;
  if (['run-start', 'run-end', 'terminal-start', 'terminal-end'].includes(event.type)) ++taskStateVersion;
  switch (event.type) {
    case 'context-compaction-start':
      contextCompacting = true;
      finishStream();
      setTaskActivityPhase('compacting', '正在压缩上下文…');
      break;
    case 'context-compacted':
      contextCompacting = false;
      appendContextCompactionNotice(event);
      moveTaskActivityToEnd();
      setTaskActivityPhase('waiting', '等待模型继续');
      scrollBottom();
      break;
    case 'window-state':
      appState = { ...appState, isFullscreen: event.isFullscreen === true };
      syncWindowChrome();
      notifyMenuState();
      break;
    case 'editor-close-request':
      confirmEditorTransition().then((allow) => bridge.confirmCloseWindow({ requestId: event.requestId, allow })).catch((error) => notice(errorText(error), true));
      break;
    case 'files-changed':
      if (event.operation !== 'save') loadFiles();
      if (!editorDirty && !editorSaving && !fileMutationBusy) refreshSelectedFile();
      break;
    case 'terminal-start': case 'terminal-output': case 'terminal-end': handleTerminalEvent(event); break;
    case 'pending-prompts': ++promptQueueVersion; syncPromptQueue(event.queue); break;
    case 'user-message':
      followOutput = true;
      commandOutput = null;
      if (typeof event.text === 'string' && (!event.id || !renderedUserMessageIds.has(event.id))) {
        finishStream();
        addMessage('user', event.text, false, { id: event.id, source: event.source, createdAt: event.createdAt, attachments: event.attachments });
        $('conversation-title').textContent = conversationTitle();
      }
      scrollBottom(true);
      break;
    case 'find-result':
      if (!$('find-bar').hidden && (findRequestId === null || event.requestId === findRequestId)) $('find-result').textContent = event.matches ? `${event.activeMatchOrdinal || 0} / ${event.matches}` : '无结果';
      break;
    case 'approval-auto':
      if (event.kind === 'write') { changes.push({ ...event, status: '已自动批准' }); renderChanges(); }
      setTaskActivityPhase('tool', `已按权限自动批准：${event.title || event.action || '操作'}`);
      break;
    case 'state': updateState(event.state); break;
    case 'session-metrics':
      if (!event.sessionId || event.sessionId === appState?.sessionId) {
        appState = { ...appState, sessionMetrics: event.metrics };
        renderSessionMetrics(event.metrics);
      }
      break;
    case 'session':
      if (event.session?.id && event.session.id !== sessionId) renderSessionSnapshot(event.session);
      if (event.session?.id) sessionId = event.session.id;
      if (event.session) $('conversation-title').textContent = conversationTitle(event.session);
      renderSessions(appState?.sessions || []);
      break;
    case 'run-start':
      contextCompacting = false;
      taskKind = event.kind || 'agent'; taskDemo = event.demo === true;
      setRunning(true, event);
      beginTaskActivity(event);
      setTaskActivityPhase(event.kind === 'undo' ? 'tool' : 'waiting', event.kind === 'undo' ? '正在撤销文件修改' : event.demo ? '正在演示任务流程' : '等待模型');
      scrollBottom();
      break;
    case 'telemetry': updateTelemetry(event); break;
    case 'text-delta':
      setTaskActivityPhase('generating', '正在生成');
      if (!streamedMessage) { streamedText = ''; streamedMessage = addMessage('assistant', '', true); }
      streamedText = event.replace ? (event.text || '') : streamedText + (event.text || '');
      renderText(streamedMessage.body, streamedText);
      scrollBottom();
      break;
    case 'assistant-message': finishStream(event.text || ''); moveTaskActivityToEnd(); scrollBottom(); break;
    case 'tool-start': addTool(event); break;
    case 'tool-result': completeTool(event); break;
    case 'approval-request': approvalRequest(event); break;
    case 'approval-resolved': {
      const approval = approvals.get(event.id);
      if (approval) {
        approval.actions.replaceWith(element('div', 'approval-resolved', event.approved ? '✓ 已批准，等待工具返回执行结果' : '× 已拒绝此操作'));
        approvals.delete(event.id);
      }
      const change = changes.find(entry => entry.id === event.id);
      if (change) { change.status = event.approved ? '已批准 · 请查看工具执行结果' : '已拒绝'; renderChanges(); }
      break;
    }
    case 'command-output':
      if (!commandOutput) { commandOutput = element('pre', 'command-output'); $('messages').append(commandOutput); }
      commandOutput.append(document.createTextNode(event.text || ''));
      commandOutput.scrollTop = commandOutput.scrollHeight;
      moveTaskActivityToEnd();
      scrollBottom();
      break;
    case 'storage-error': notice(`本机保存失败：${event.error || '未知错误'}`, true); break;
    case 'usage':
      $('token-usage').textContent = `本次输入 ${(event.inputTokens || 0).toLocaleString()} / 输出 ${(event.outputTokens || 0).toLocaleString()} Token`;
      break;
    case 'run-end': {
      contextCompacting = false;
      finishStream();
      moveTaskActivityToEnd();
      finishTaskActivity(event);
      setRunning(false);
      const failed = event.status === 'failed';
      const text = failed ? `任务未完成：${event.error || '发生错误'}` : event.status === 'stopped' ? '任务已停止' : '任务已完成';
      $('run-status').textContent = failed ? '任务失败' : event.status === 'stopped' ? '已停止' : '已完成';
      $('messages').append(element('div', `run-result${failed ? ' failed' : ''}`, `${failed ? '×' : '✓'} ${text}`));
      for (const approval of approvals.values()) approval.actions.replaceWith(element('div', 'approval-resolved', '任务已结束，此请求已失效'));
      approvals.clear();
      pendingTools.forEach((tool) => { tool.card.classList.remove('running'); tool.badge.textContent = '已结束'; });
      pendingTools = [];
      changes.forEach((change) => { if (change.status === '等待确认') change.status = '任务结束 · 未批准'; });
      renderChanges();
      scrollBottom();
      const version = taskStateVersion;
      const queueVersion = promptQueueVersion;
      if (!restoringWorkspace) {
        const workspaceId = currentWorkspaceId();
        bridge.getState().then((state) => {
          if (currentWorkspaceId() === workspaceId) updateState(state, { syncActiveTask: version === taskStateVersion, syncPendingQueue: queueVersion === promptQueueVersion });
        }).catch(() => {});
        refreshSelectedFile();
        if (appState?.workspace) loadFiles();
      }
      break;
    }
  }
}

function refreshSelectedFile() {
  const path = selectedPath;
  const epoch = editorDocumentEpoch;
  const version = editorVersion;
  if (path && !editorDirty && !editorSaving) bridge.fileRead({ path }).then((file) => {
    if (selectedPath === path && editorDocumentEpoch === epoch && editorVersion === version && !editorDirty && !editorSaving) {
      $('file-content').value = file.content;
      $('file-content').textContent = file.content;
      editorOriginal = file.content;
      editorVersion = file.version;
      $('editor-status').textContent = '自动保存已开启 · UTF-8';
    }
  }).catch(() => {});
}

function fillProvider(provider) {
  invalidateSettingsCatalog();
  const settings = appState?.settings || {};
  const config = settings.providers?.[provider] || {};
  const current = settings.provider === provider;
  $('openai-auth-mode').value = provider === 'openai' && (config.authMode || (current ? settings.authMode : '')) === 'chatgpt' ? 'chatgpt' : 'apiKey';
  $('api-protocol-select').value = config.apiProtocol || (provider === 'relay' ? 'chat-completions' : 'responses');
  $('base-url-input').value = config.baseUrl || (current ? settings.baseUrl : '') || '';
  $('api-key-input').value = '';
  $('api-key-input').disabled = false;
  $('api-key-input').placeholder = config.hasKey ? '已保存密钥，留空以保留' : '输入 API Key';
  $('key-status').textContent = config.hasKey ? '已在本机保存' : '未配置';
  $('key-status').classList.toggle('saved', !!config.hasKey);
  $('key-help').textContent = config.hasKey ? '不显示已保存的密钥；留空保留，输入新值替换。' : '密钥只用于你配置的模型 API 请求。';
  $('clear-key-input').checked = false;
  $('settings-error').hidden = true;
  chatgptLocalError = '';
  renderChatGPTState();
}

function openSettings() {
  if (contextBusy() || isChatGPTBusy()) return;
  closeReasoningPopup();
  ++catalogRequest;
  catalogLoading = false;
  const provider = appState?.settings?.provider || 'openai';
  $('provider-select').value = provider;
  fillProvider(provider);
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  if (contextBusy() || settingsSaving || isChatGPTBusy()) return;
  const model = selectedSettingsModel();
  if (!model) {
    $('settings-error').textContent = '请先获取当前连接的模型目录，并选择其中的模型。';
    $('settings-error').hidden = false;
    refreshControlLocks();
    return;
  }
  const input = { ...modelSettingsDraft(), model: model.id, selectionToken: settingsCatalog.selectionToken };
  settingsSaving = true;
  refreshControlLocks();
  try {
    const state = await bridge.saveModelSettings(input);
    updateState(state);
    $('api-key-input').value = '';
    $('settings-dialog').close();
    notice('模型配置已保存。发送任务时将使用所选模型。');
  } catch (error) { $('settings-error').textContent = errorText(error); $('settings-error').hidden = false; }
  finally { settingsSaving = false; renderChatGPTState(); }
}

async function undoChange() {
  if (contextBusy() || isChatGPTBusy() || !appState?.workspace) return;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
  const workspaceId = currentWorkspaceId();
  $('undo-change').disabled = true;
  addTool({ name: 'undo_last_change', args: {} });
  try {
    const result = await bridge.undoLastChange();
    if (workspaceId !== currentWorkspaceId()) return;
    const raw = typeof result?.result === 'string' ? result.result : safeString(result);
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch { /* Plain-text errors are already suitable for the notice. */ }
    notice(message, raw.startsWith('错误：'));
    refreshSelectedFile();
    loadFiles();
  } catch (error) { if (workspaceId === currentWorkspaceId()) notice(errorText(error), true); }
  finally { $('undo-change').disabled = contextBusy() || !appState?.workspace; }
}

function maximumSidebarWidth() {
  const width = document.querySelector('.workspace-layout')?.clientWidth || window.innerWidth;
  return Math.max(160, Math.min(420, width - 480));
}

function setSidebarWidth(value, persist = false) {
  sidebarWidth = Math.max(160, Math.min(maximumSidebarWidth(), Number(value) || 208));
  if (sidebarSizeRule) sidebarSizeRule.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  $('sidebar-resizer').setAttribute('aria-valuenow', String(Math.round(sidebarWidth)));
  $('sidebar-resizer').setAttribute('aria-valuemax', String(Math.round(maximumSidebarWidth())));
  $('sidebar-resizer').setAttribute('aria-valuetext', `${Math.round(sidebarWidth)} 像素`);
  if (persist) {
    sidebarPreferredWidth = sidebarWidth;
    try { localStorage.setItem('forgedesk.sidebarWidth', String(Math.round(sidebarWidth))); } catch { /* A blocked preferences store does not prevent resizing. */ }
  }
}

function initializeSidebarSizing() {
  document.documentElement.classList.add('sidebar-layout');
  for (const sheet of document.styleSheets) {
    try {
      const rule = [...sheet.cssRules].find((entry) => entry.selectorText === ':root.sidebar-layout');
      if (rule) { sidebarSizeRule = rule; break; }
    } catch { /* Ignore stylesheets that are not readable from this document. */ }
  }
  try {
    const saved = Number(localStorage.getItem('forgedesk.sidebarWidth'));
    if (Number.isFinite(saved) && saved >= 160 && saved <= 420) sidebarPreferredWidth = saved;
  } catch { /* Use the default width when local preferences are unavailable. */ }
  setSidebarWidth(sidebarPreferredWidth);
  const handle = $('sidebar-resizer');
  const finish = (event) => {
    if (!sidebarDrag || (event.pointerId !== undefined && event.pointerId !== sidebarDrag.pointerId)) return;
    const id = sidebarDrag.pointerId;
    sidebarDrag = null;
    document.documentElement.classList.remove('is-resizing-sidebar');
    try { if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id); } catch { /* Capture may already have been released by the OS. */ }
    setSidebarWidth(sidebarWidth, true);
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isChatGPTBusy()) return;
    event.preventDefault();
    sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: sidebarWidth };
    document.documentElement.classList.add('is-resizing-sidebar');
    try { handle.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer events may not support capture. */ }
  });
  handle.addEventListener('pointermove', (event) => {
    if (sidebarDrag?.pointerId === event.pointerId) setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((name) => handle.addEventListener(name, finish));
  handle.addEventListener('dblclick', () => { if (!isChatGPTBusy()) setSidebarWidth(208, true); });
  handle.addEventListener('keydown', (event) => {
    if (isChatGPTBusy()) return;
    let width;
    const step = event.shiftKey ? 20 : 10;
    if (event.key === 'ArrowLeft') width = sidebarWidth - step;
    if (event.key === 'ArrowRight') width = sidebarWidth + step;
    if (event.key === 'Home') width = 160;
    if (event.key === 'End') width = maximumSidebarWidth();
    if (width !== undefined) { event.preventDefault(); setSidebarWidth(width, true); }
  });
  window.addEventListener('resize', () => setSidebarWidth(sidebarPreferredWidth));
}

function bindRangeAnimation(range) {
  const visual = range.closest('.reasoning-slider-visual');
  if (!visual) return;
  let pointerX = null;
  range.addEventListener('pointerdown', (event) => { pointerX = range.disabled ? null : event.clientX; });
  range.addEventListener('pointermove', (event) => {
    if (pointerX !== null && Math.abs(event.clientX - pointerX) > 3) visual.classList.add('is-dragging');
  });
  const finish = () => { pointerX = null; visual.classList.remove('is-dragging'); };
  range.addEventListener('pointerup', finish);
  range.addEventListener('pointercancel', finish);
  range.addEventListener('lostpointercapture', finish);
}

function bindUI() {
  const overlay = typeof navigator === 'undefined' ? null : navigator.windowControlsOverlay;
  overlay?.addEventListener?.('geometrychange', syncWindowChrome);
  syncWindowChrome();
  initializeTextScaling();
  initializeSidebarSizing();
  bindImageAttachments();
  bindChatGPTUsage();
  bindRangeAnimation($('reasoning-effort'));
  $('open-workspace-sidebar').addEventListener('click', openWorkspace);
  $('refresh-files').addEventListener('click', loadFiles);
  $('undo-change').addEventListener('click', undoChange);
  bindExplorer();
  $('preview-pin').addEventListener('click', () => setPreviewPinned(!previewPinned));
  $('terminal-form').addEventListener('submit', runTerminal);
  $('terminal-close').addEventListener('click', () => setTerminalOpen(false));
  $('terminal-clear').addEventListener('click', clearTerminalOutput);
  $('terminal-stop').addEventListener('click', async () => {
    $('terminal-stop').disabled = true;
    try { await bridge.stopTerminal(); } catch (error) { notice(errorText(error), true); $('terminal-stop').disabled = !terminalRunning; }
  });
  $('find-bar').addEventListener('submit', (event) => { event.preventDefault(); requestFind(true, false); });
  $('find-input').addEventListener('input', () => { clearTimeout(findTimer); findRequestId = null; findTimer = setTimeout(() => requestFind(true, true), 120); });
  $('find-input').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closeFindBar(); } });
  $('find-previous').addEventListener('click', () => requestFind(false, false));
  $('find-close').addEventListener('click', closeFindBar);
  $('link-form').addEventListener('submit', openEnteredLink);
  $('link-close').addEventListener('click', () => $('link-dialog').close());
  $('file-preview-tab').addEventListener('click', () => showPreviewTab('file'));
  $('changes-preview-tab').addEventListener('click', () => showPreviewTab('changes'));
  $('toggle-preview').addEventListener('click', () => requestPreviewOpen($('preview-panel').hidden));
  $('close-preview').addEventListener('click', () => requestPreviewOpen(false));
  $('reveal-file').addEventListener('click', async () => { if (selectedPath) try { await bridge.openPath({ path: selectedPath }); } catch (error) { notice(errorText(error), true); } });
  const previewHTML = element('button', 'button subtle', '网页预览');
  previewHTML.id = 'browser-preview-file'; previewHTML.type = 'button';
  previewHTML.title = '在右侧内置浏览器预览当前 HTML 文件';
  $('reveal-file').before(previewHTML);
  previewHTML.addEventListener('click', async () => {
    if (!selectedPath || !/\.html?$/i.test(selectedPath)) { notice('请先打开项目中的 HTML 文件。', true); return; }
    if (!(await confirmEditorTransition())) return;
    try { await browserController.open({ path: selectedPath }); } catch {}
  });
  $('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
  $('model-reasoning-trigger').addEventListener('click', () => { if ($('reasoning-popup').hidden) openReasoningPopup(); else closeReasoningPopup(); });
  $('popup-model-button').addEventListener('click', () => { showModelList(true); if (!currentCatalog && !catalogLoading) fetchCurrentCatalog(); });
  $('model-list-back').addEventListener('click', () => { showModelList(false); $('popup-model-button').focus(); });
  $('model-search').addEventListener('input', renderModelList);
  $('model-list-refresh').addEventListener('click', () => fetchCurrentCatalog(true));
  $('model-list-retry').addEventListener('click', () => fetchCurrentCatalog(true));
  $('model-open-settings').addEventListener('click', openSettings);
  $('reasoning-open-settings').addEventListener('click', openSettings);
  $('settings-model-refresh').addEventListener('click', () => fetchSettingsCatalog(true));
  $('settings-dialog').addEventListener('close', () => { invalidateSettingsCatalog(); $('api-key-input').value = ''; ++catalogRequest; catalogLoading = false; });
  $('close-settings').addEventListener('click', () => { if (isChatGPTBusy() || settingsSaving) return; $('api-key-input').value = ''; $('settings-dialog').close(); });
  $('settings-dialog').addEventListener('cancel', (event) => { if (isChatGPTBusy() || settingsSaving) { event.preventDefault(); return; } $('api-key-input').value = ''; });
  $('provider-select').addEventListener('change', (event) => fillProvider(event.target.value));
  $('api-protocol-select').addEventListener('change', () => { invalidateSettingsCatalog(); syncAuthModeVisibility(); renderSettingsCatalog(); $('settings-error').hidden = true; refreshControlLocks(); });
  $('openai-auth-mode').addEventListener('change', () => {
    invalidateSettingsCatalog();
    $('api-key-input').value = '';
    $('clear-key-input').checked = false;
    $('settings-error').hidden = true;
    chatgptLocalError = '';
    renderChatGPTState();
  });
  $('chatgpt-sign-in').addEventListener('click', () => signInChatGPT());
  $('chatgpt-reconnect').addEventListener('click', () => chatgptStorageError() ? retryChatGPTStorage() : signInChatGPT({ reconsent: true }));
  $('chatgpt-add-profile').addEventListener('click', () => signInChatGPT({ newProfile: true }));
  $('chatgpt-cancel-sign-in').addEventListener('click', cancelChatGPTSignIn);
  $('chatgpt-profile-select').addEventListener('change', () => {
    const id = $('chatgpt-profile-select').value;
    if (id) runChatGPTAction('profile', () => bridge.chatgptSelectProfile({ id }));
  });
  $('chatgpt-disconnect').addEventListener('click', () => runChatGPTAction('disconnect', () => bridge.chatgptDisconnect()));
  $('chatgpt-refresh-models').addEventListener('click', refreshChatGPTModels);
  $('chatgpt-open-usage').addEventListener('click', () => runChatGPTAction('usage', () => bridge.chatgptOpenUsage()));
  $('chatgpt-model-select').addEventListener('change', () => {
    $('settings-error').hidden = true;
    refreshControlLocks();
  });
  ['base-url-input', 'api-key-input'].forEach((id) => $(id).addEventListener('input', () => {
    invalidateSettingsCatalog();
    renderSettingsCatalog();
    refreshControlLocks();
  }));
  $('reasoning-effort').addEventListener('input', () => { if (!$('reasoning-effort').disabled && !contextBusy() && !reasoningSaving) updateReasoningControl($('reasoning-effort'), true); });
  $('reasoning-effort').addEventListener('change', () => {
    if ($('reasoning-effort').disabled || contextBusy() || reasoningSaving) return;
    updateReasoningControl($('reasoning-effort'), true);
    setReasoningEffort();
  });
  $('reasoning-default').addEventListener('click', () => {
    if ($('reasoning-default').disabled || contextBusy() || reasoningSaving) return;
    fillReasoningOptions($('reasoning-effort'), appState?.settings?.provider || 'openai', 'default');
    setReasoningEffort();
  });
  $('clear-key-input').addEventListener('change', (event) => {
    invalidateSettingsCatalog();
    $('api-key-input').disabled = event.target.checked;
    if (event.target.checked) $('api-key-input').value = '';
    renderSettingsCatalog();
    refreshControlLocks();
  });
  $('settings-form').addEventListener('submit', saveSettings);
  $('task-form').addEventListener('submit', (event) => { event.preventDefault(); runTask(); });
  $('resume-pending').addEventListener('click', resumePendingPrompts);
  $('stop-button').addEventListener('click', async () => {
    $('stop-button').disabled = true;
    try { await bridge.stopTask(); } catch (error) { notice(errorText(error), true); }
    finally { $('stop-button').disabled = false; }
  });
  $('task-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); runTask(); } });
  $('message-scroll').addEventListener('scroll', () => { const node = $('message-scroll'); followOutput = node.scrollHeight - node.scrollTop - node.clientHeight < 100; });
  document.addEventListener('pointerdown', (event) => { if (!$('reasoning-popup').hidden && !$('composer-model-control').contains(event.target)) closeReasoningPopup(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('app-menu-popup').hidden || !$('app-menu-submenu').hidden) return;
    if ($('session-dropdown') && !$('session-dropdown').hidden) { event.preventDefault(); sessionControls?.close(); $('session-menu-button')?.focus(); return; }
    if (event.defaultPrevented) return;
    if (!$('project-dropdown').hidden) { event.preventDefault(); closeProjectDropdown(); $('project-switcher').focus(); return; }
    if (!$('file-context-menu').hidden) { event.preventDefault(); closeFileContextMenu(); selectedRow?.focus(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (!$('reasoning-popup').hidden) { event.preventDefault(); closeReasoningPopup(true); }
    else if (!$('settings-dialog').open && !event.defaultPrevented) requestPreviewOpen(false);
  });
  setPreviewOpen(false);
}

async function initialize() {
  bindUI();
  if (!bridge) {
    notice('桌面桥接未就绪，请通过 Synora code 桌面应用启动此界面。', true);
    document.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = true; });
    return;
  }
  browserController = window.ForgeBrowser.create({ bridge, getWorkspaceId: currentWorkspaceId, isCurrentWorkspace: belongsToCurrentWorkspace, showPanel: () => { if (!previewPinned) setPreviewPinned(true); setPreviewOpen(true); showPreviewTab('browser'); }, notice });
  permissionControls = window.ForgePermissions.create({ bridge, getWorkspaceId: currentWorkspaceId, isCurrentWorkspace: belongsToCurrentWorkspace, notice });
  sessionControls = window.ForgeSessions.create({ bridge, onSelect: loadSession, onNew: () => newSession(), notice });
  bridge.onEvent(handleEvent);
  try {
    const version = taskStateVersion;
    const queueVersion = promptQueueVersion;
    updateState(await bridge.getState(), { syncActiveTask: version === taskStateVersion, syncPendingQueue: queueVersion === promptQueueVersion });
    if (typeof bridge.getCurrentSession === 'function') {
      const session = await bridge.getCurrentSession();
      if (session?.id && belongsToCurrentWorkspace(session)) renderSessionSnapshot(session);
    }
  }
  catch (error) { notice(`初始化失败：${errorText(error)}`, true); }
}

window.aiCodeCommands = Object.freeze({
  getState: () => ({
    busy: contextBusy(),
    projectBusy: projectTransitionBusy(),
    authBusy: isChatGPTBusy(),
    hasWorkspace: !!appState?.workspace,
    hasChatGPTAccount: !!appState?.chatgpt?.session?.profileId || ['connected', 'reauth_required'].includes(appState?.chatgpt?.session?.status),
    sidebarVisible: !document.documentElement.classList.contains('sidebar-hidden'),
    terminalVisible: !$('terminal-panel').hidden,
    previewVisible: !$('preview-panel').hidden,
    previewPinned,
    fullscreen: appState?.isFullscreen === true,
    temporary: appState?.temporary === true,
    canBack: navigationIndex > 0,
    canForward: navigationIndex >= 0 && navigationIndex < navigationEntries.length - 1
  }),
  reportError: (error) => notice(errorText(error), true),
  execute: async (action) => {
    const stateCall = async (method, arg) => { const result = await bridge[method](arg); if (result?.settings) updateState(result); return result; };
    const editing = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', delete: 'delete', 'select-all': 'selectAll' };
    if (editing[action]) {
      if ($('file-tree').contains(document.activeElement) && ['cut', 'copy', 'paste', 'delete'].includes(action)) return explorerAction(action);
      return bridge.editCommand({ command: editing[action] });
    }
    switch (action) {
      case 'new-window': return bridge.newWindow();
      case 'new-chat': return newSession();
      case 'temporary-chat': return newSession({ temporary: true });
      case 'create-project': return createProject();
      case 'open-project': return openWorkspace();
      case 'close-window': return bridge.closeWindow();
      case 'logout': return runChatGPTAction('disconnect', () => bridge.chatgptDisconnect());
      case 'quit': return bridge.quitApp();
      case 'settings': return openSettings();
      case 'toggle-sidebar': return toggleSidebar();
      case 'toggle-terminal': return setTerminalOpen($('terminal-panel').hidden);
      case 'pin-summary': return setPreviewPinned(!previewPinned);
      case 'open-terminal': return setTerminalOpen(true, true);
      case 'toggle-navigation': return requestPreviewOpen($('preview-panel').hidden);
      case 'switch-focus': return switchEditorFocus();
      case 'open-browser': return browserController.show();
      case 'open-link': return showLinkDialog();
      case 'find': return showFindBar();
      case 'back': return navigateHistory(-1);
      case 'forward': return navigateHistory(1);
      case 'previous-sidebar': return navigateSidebarItem(-1);
      case 'next-sidebar': return navigateSidebarItem(1);
      case 'previous-tab': return cyclePreviewTab(-1);
      case 'next-tab': return cyclePreviewTab(1);
      case 'zoom-in': return requestTextScale(textScaleDesired + 10);
      case 'zoom-out': return requestTextScale(textScaleDesired - 10);
      case 'zoom-reset': return requestTextScale(100);
      case 'fullscreen': return stateCall('toggleFullscreen');
      case 'guide': return bridge.openHelp({ topic: 'guide' });
      case 'about': return bridge.openHelp({ topic: 'about' });
      default: throw new Error('未识别的菜单操作。');
    }
  }
});

initialize();
