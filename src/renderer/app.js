'use strict';

const $ = (id) => document.getElementById(id);
const bridge = window.forge;
const providerNames = { openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini', kimi: 'Kimi', glm: 'GLM', doubao: '豆包', anthropic: 'Claude', relay: '中转站', ollama: 'Ollama' };
const reasoningOptions = {
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  deepseek: ['none', 'low', 'high', 'max'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  gemini: [],
  kimi: [],
  glm: [],
  doubao: [],
  relay: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  ollama: []
};
const reasoningLabels = { default: '默认', none: '关闭', enabled: '开启思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' };
const chatgptStorageMessages = {
  storage_decryption_failed: '无法解密本机保存的 ChatGPT 登录信息。原凭据已保留，请先重试读取；仍失败时可退出本机登录后重新连接。',
  storage_encrypted_invalid: '本机保存的 ChatGPT 登录信息格式无效或已损坏。原凭据已保留，可先重试读取，或退出本机登录后重新连接。',
  storage_provider_mismatch: '本机登录信息的加密方式与当前版本不匹配。原凭据已保留，请先重试读取，或退出本机登录后重新连接。',
  storage_invalid: '无法读取本机保存的 ChatGPT 登录信息。原凭据已保留，请先重试读取，或退出本机登录后重新连接。',
  storage_encryption_unavailable: '系统安全存储暂不可用。原凭据已保留，请解锁系统密钥存储后重试读取。'
};
let appState = null;
let promptCompletion = null;
let appUpdateControls = null;
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
let fileDisclosureReveal = null;
let fileDisclosureScrollPaused = false;
let filesRequest = 0;
let sessionRequest = 0;
let reasoningSaving = false;
let latestTelemetry = null;
let sessionTokenRate = null;
let taskActivityTimer = null;
let activeTaskActivity = null;
let taskChangeEdits = [];
const taskChangeCards = new Map();
let taskChangeUndoBusy = false;
let imageViewSources = [];
const renderedImageViews = new Set();
let settingsSaving = false;
let settingsRole = null;
let chatgptBusy = false;
let chatgptAction = null;
let chatgptCancelling = false;
let chatgptLocalError = '';
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
let pendingPromptEdit = null;
let pendingPromptEditSaving = false;
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
let editorPickerOpen = false;
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
let explorerDrag = null;
let explorerMovePending = false;
let explorerSelection = null;
const EXPLORER_DRAG_TYPE = 'application/x-synora-file';
let projectSwitching = false;
let recentProjectRemoving = false;
let fileClipboard = null;
let fileNameRequest = null;
let unsavedDecision = null;
let editorWidth = 470;
let editorSizeRule = null;
const expandedDirectories = new Set();
const chatgptDisabledControls = new Map();
const approvals = new Map();
let composerApprovalFocus = null;
let composerApprovalEpoch = 0;
let composerApprovalSequence = 0;
let browserController, permissionControls, sessionControls, chatSelectionMenu, sideChatControls;
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
  if (/\[GEMINI_[A-Z_]+\]/u.test(message) && typeof window.ForgeGeminiLogin?.errorMessage === 'function') return window.ForgeGeminiLogin.errorMessage(error);
  return message.replace(/^Error invoking remote method ['"]forge:[^'"]+['"]:\s*(?:(?:Error|FileManagerError|ImageAttachmentError):\s*)?/u, '');
}

let noticeRevision = 0;
function notice(message, error = false) {
  const revision = ++noticeRevision;
  $('notice-text').textContent = error && !String(message).startsWith('错误') ? `错误：${message}` : message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  return () => { if (revision === noticeRevision) $('notice').hidden = true; };
}

function scrollBottom(force = false) {
  const viewport = $('message-scroll');
  if (force) { cancelFileDisclosureReveal(); fileDisclosureScrollPaused = false; }
  else if (fileDisclosureReveal || fileDisclosureScrollPaused) return;
  if (!viewport.classList.contains('usage-view-open') && (force || followOutput)) viewport.scrollTop = viewport.scrollHeight;
}

function cancelFileDisclosureReveal(manual = false) {
  if (!fileDisclosureReveal) return;
  cancelAnimationFrame(fileDisclosureReveal.frame);
  fileDisclosureReveal = null;
  if (manual) { followOutput = false; fileDisclosureScrollPaused = true; }
}

function fileDisclosureBounds(viewport) {
  const rect = viewport.getBoundingClientRect();
  // The composer is a flex sibling: clientHeight already excludes its height.
  const top = rect.top + viewport.clientTop + 12;
  return { top, bottom: rect.top + viewport.clientTop + viewport.clientHeight - 12 };
}

function fitFileDisclosure(card, viewport) {
  if (card.classList.contains('tool-operation-group')) {
    if (!card.open) return;
    const bounds = fileDisclosureBounds(viewport), summary = card.querySelector(':scope > summary');
    card.style.setProperty('--tool-operation-height', `${Math.max(60, Math.min(360, Math.floor(bounds.bottom - bounds.top - summary.getBoundingClientRect().height - 16)))}px`);
    return;
  }
  if (card.classList.contains('image-view-card')) {
    const gallery = card.querySelector('.image-view-gallery'), body = card.querySelector('.image-view-body');
    if (!gallery || !body || !card.open) return;
    const bounds = fileDisclosureBounds(viewport);
    const chrome = card.querySelector(':scope > summary').getBoundingClientRect().height
      + body.getBoundingClientRect().height - gallery.getBoundingClientRect().height;
    card.style.setProperty('--image-view-gallery-height', `${Math.max(78, Math.floor(bounds.bottom - bounds.top - chrome))}px`);
    return;
  }
  const previews = [...card.querySelectorAll('.code-diff-card > .code-diff-scroll')];
  if (!previews.length || !fileDisclosureOpen(card)) return;
  const preview = previews[0];
  if (card.classList.contains('task-change-entry')) {
    const row = card.querySelector(':scope > .task-change-file');
    const body = card.querySelector(':scope > .task-change-file-preview > .task-change-collapse-inner');
    if (!row || !body) return;
    const bounds = fileDisclosureBounds(viewport);
    const chrome = row.getBoundingClientRect().height + body.scrollHeight
      - previews.reduce((sum, item) => sum + item.getBoundingClientRect().height, 0);
    const height = Math.max(44, Math.min(360, Math.floor((bounds.bottom - bounds.top - chrome) / previews.length)));
    card.style.setProperty('--file-edit-preview-height', `${height}px`);
    return;
  }
  const details = card.querySelector(':scope > .file-edit-details');
  if (!details) return;
  const pixels = value => Number.parseFloat(value) || 0;
  const style = getComputedStyle(card), detailStyle = getComputedStyle(details);
  const bounds = fileDisclosureBounds(viewport);
  // The child retains its intrinsic layout while ::details-content reveals it.
  // Include margins/chrome so the entire card, rather than only its code, fits.
  const chrome = card.querySelector(':scope > summary').getBoundingClientRect().height
    + details.getBoundingClientRect().height - preview.getBoundingClientRect().height
    + pixels(detailStyle.marginTop) + pixels(detailStyle.marginBottom)
    + pixels(style.paddingTop) + pixels(style.paddingBottom)
    + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const height = Math.max(44, Math.min(360, Math.floor(bounds.bottom - bounds.top - chrome)));
  card.style.setProperty('--file-edit-preview-height', `${height}px`);
}

function fileDisclosureOpen(card) {
  return card.classList.contains('task-change-entry')
    ? card.querySelector(':scope > .task-change-file')?.getAttribute('aria-expanded') === 'true' : card.open;
}

function revealFileDisclosure(card) {
  cancelFileDisclosureReveal();
  const viewport = $('message-scroll');
  if (!fileDisclosureOpen(card) || !card.isConnected || viewport.classList.contains('usage-view-open')) return;
  const reveal = { card, frame: 0, until: performance.now() + 400 };
  fileDisclosureReveal = reveal;
  const frame = () => {
    if (fileDisclosureReveal !== reveal) return;
    if (!fileDisclosureOpen(card) || !card.isConnected || viewport.classList.contains('usage-view-open')) { cancelFileDisclosureReveal(); return; }
    fitFileDisclosure(card, viewport);
    const bounds = fileDisclosureBounds(viewport), rect = card.getBoundingClientRect();
    const available = bounds.bottom - bounds.top;
    let delta = 0;
    if (rect.height > available + 1) {
      // Extremely short windows can be smaller than the card's fixed controls.
      // Keep the summary reachable rather than chasing an impossible bottom.
      delta = rect.top - bounds.top;
    } else if (rect.bottom > bounds.bottom) delta = rect.bottom - bounds.bottom;
    else if (rect.top < bounds.top) delta = rect.top - bounds.top;
    if (Math.abs(delta) > 1) viewport.scrollTop += delta;
    if (performance.now() < reveal.until) reveal.frame = requestAnimationFrame(frame);
    else fileDisclosureReveal = null;
  };
  reveal.frame = requestAnimationFrame(frame);
}

function bindFileDisclosureVisibility(card, summary) {
  summary.addEventListener('click', event => {
    if (event.defaultPrevented || !card.matches('.file-edit-card,.image-view-card,.tool-operation-group')
        || event.target.closest('button,a,input,select,textarea')) return;
    cancelFileDisclosureReveal();
    // Native summary activation (including Enter/Space) toggles after click.
    // Register the pending frame too, so a scroll before the first frame wins.
    const intent = { card, frame: 0 };
    fileDisclosureReveal = intent;
    intent.frame = requestAnimationFrame(() => {
      if (fileDisclosureReveal !== intent) return;
      if (card.open) revealFileDisclosure(card);
      else cancelFileDisclosureReveal();
    });
  });
}

function bindConversationDisclosureVisibility() {
  const viewport = $('message-scroll');
  viewport.addEventListener('wheel', event => {
    if (!event.target.closest('.code-diff-scroll,.image-view-gallery,.tool-operation-group-items')) cancelFileDisclosureReveal(true);
  }, { passive: true, capture: true });
  viewport.addEventListener('touchstart', () => cancelFileDisclosureReveal(true), { passive: true });
  viewport.addEventListener('pointerdown', event => {
    // Clicking a scrollbar is an explicit reading-position choice.
    if (event.target === viewport) cancelFileDisclosureReveal(true);
  });
  document.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        && !event.target.closest('input,textarea,select,[contenteditable="true"]')) cancelFileDisclosureReveal(true);
  }, true);
  new ResizeObserver(() => {
    for (const card of viewport.querySelectorAll('.file-edit-card[open],.task-change-entry,.image-view-card[open],.tool-operation-group[open]')) fitFileDisclosure(card, viewport);
  }).observe(viewport);
}

function showConversation() {
  $('welcome').hidden = true;
}

function safeString(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}

function toolPayload(value, pathHint) {
  const content = safeString(value), pre = element('pre');
  let json = typeof value !== 'string' && value !== undefined;
  if (!json) try { JSON.parse(content); json = true; } catch {}
  const language = json ? 'json' : typeof pathHint === 'string' ? window.ForgeSyntax?.languageForPath(pathHint) : '';
  if (language && window.ForgeSyntax) window.ForgeSyntax.append(document, pre, content, language);
  else pre.textContent = content;
  return pre;
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
  return session?.title || appState?.sessionTitle || '新会话';
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
  return running || terminalRunning || promptSubmitting || pendingResuming || promptQueue.items.length > 0 || fileMutationBusy || projectSwitching || taskChangeUndoBusy;
}

function modelControlBusy() {
  return projectSwitching || fileMutationBusy || promptSubmitting || pendingResuming || isChatGPTBusy() || (running && taskKind === 'undo');
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
  // Replay owns the chronological placement of pending compression. A state
  // snapshot may already have restored a provisional notice at the tail.
  if (live.length && activeTaskActivity?.compaction) {
    activeTaskActivity.compaction.remove();
    activeTaskActivity.compaction = null;
    contextCompacting = false;
  }
  restoringWorkspace = true;
  try {
    for (const event of state.terminalEvents || []) handleTerminalEvent(event);
    for (const event of live) if (!event.type?.startsWith('terminal-')) handleEvent({ ...event, workspaceId: state.workspaceId });
    if (!live.length && active?.streamText) handleEvent({ type: 'text-delta', text: active.streamText, replace: true, workspaceId: state.workspaceId });
  } finally { restoringWorkspace = false; }
  syncComposerApprovals(state.pendingApprovals || []);
  if (active?.telemetry) updateTelemetry(active.telemetry);
  syncContextCompaction(state.activeTask);
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
  $('pending-pause-controls').hidden = !promptQueue.paused || promptQueue.items.length === 0;
  $('pending-paused').title = promptQueue.reason || '队列已暂停';
  $('resume-pending').hidden = !promptQueue.paused || promptQueue.items.length === 0;
  $('resume-pending').disabled = running || terminalRunning || promptSubmitting || pendingResuming || isChatGPTBusy();
  for (const item of promptQueue.items) {
    const card = element('article', `pending-prompt${item.mode === 'steer' ? ' steering' : ''}`);
    card.dataset.promptId = item.id;
    card.dataset.mode = item.mode;
    const row = element('div', 'pending-prompt-row');
    const mark = element('span', 'pending-prompt-mark', '↳'); mark.setAttribute('aria-hidden', 'true');
    const content = element('div', 'pending-prompt-preview');
    content.append(element('span', 'pending-preview-text', item.text));
    row.append(mark, content);
    const actions = element('div', 'pending-prompt-actions');
    {
      const steer = element('button', 'pending-steer');
      const arrow = element('span', 'pending-steer-mark', '↪'); arrow.setAttribute('aria-hidden', 'true');
      steer.append(arrow, element('span', '', '引导'));
      steer.type = 'button';
      steer.disabled = item.mode === 'steer' || !canSteerPrompt() || pendingPromptActions.has(item.id) || isChatGPTBusy();
      steer.title = item.mode === 'steer' ? '已设为引导，等待当前请求结束' : canSteerPrompt() ? '转为当前任务下一轮的补充，不中断模型请求' : '当前任务运行时可转为引导';
      steer.setAttribute('aria-label', item.mode === 'steer' ? '已设为引导' : '引导当前任务');
      steer.addEventListener('click', () => managePendingPrompt(item.id, 'steer'));
      actions.append(steer);
    }
    const edit = element('button', 'pending-edit'); edit.type = 'button';
    edit.title = '编辑提示词'; edit.setAttribute('aria-label', '编辑提示词');
    edit.disabled = pendingPromptActions.has(item.id) || isChatGPTBusy();
    const pencil = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); pencil.setAttribute('viewBox', '0 0 24 24'); pencil.setAttribute('aria-hidden', 'true');
    const pencilPath = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pencilPath.setAttribute('d', 'm4 16-1 5 5-1L21 7l-4-4L4 16Z M14 6l4 4'); pencil.append(pencilPath); edit.append(pencil);
    edit.addEventListener('click', () => editPendingPrompt(item.id)); actions.append(edit);
    const remove = element('button', 'pending-remove');
    remove.type = 'button';
    remove.disabled = pendingPromptActions.has(item.id) || isChatGPTBusy();
    remove.setAttribute('aria-label', item.mode === 'steer' ? '取消此条待引导内容' : '删除此条待发送内容');
    remove.title = item.mode === 'steer' ? '取消引导' : '删除';
    const trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); trash.setAttribute('viewBox', '0 0 24 24'); trash.setAttribute('aria-hidden', 'true');
    const trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path'); trashPath.setAttribute('d', 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7'); trash.append(trashPath); remove.append(trash);
    remove.addEventListener('click', () => managePendingPrompt(item.id, 'remove'));
    actions.append(remove);
    row.append(actions); card.append(row);
    const attachments = messageImageAttachments(item.attachments);
    if (attachments.length) {
      const gallery = element('div', 'pending-attachments');
      attachments.forEach((attachment) => gallery.append(createMessageImage(attachment, 'pending-attachment-image')));
      content.prepend(gallery);
    }
    {
      const details = element('details', 'pending-content');
      details.open = expanded.has(item.id);
      const summary = element('summary', 'pending-more', '⋯');
      summary.setAttribute('aria-label', '查看完整内容'); summary.title = '查看完整内容';
      details.append(summary, element('pre', 'pending-text', item.text || attachments.map(image => image.name).join('\n')));
      card.append(details);
    }
    list.append(card);
  }
  renderPendingPromptEditState();
}

function editPendingPrompt(id) {
  const item = promptQueue.items.find(value => value.id === id);
  if (!item || pendingPromptActions.has(id) || isChatGPTBusy()) return;
  pendingPromptEdit = { id, workspaceId: currentWorkspaceId() };
  $('pending-edit-input').value = item.text;
  $('pending-edit-error').textContent = '';
  renderPendingPromptEditState();
  $('pending-edit-dialog').showModal(); $('pending-edit-input').focus();
}

function renderPendingPromptEditState() {
  if (!pendingPromptEdit) return;
  const item = promptQueue.items.find(value => value.id === pendingPromptEdit.id);
  const current = pendingPromptEdit.workspaceId === currentWorkspaceId();
  if (!item || !current) $('pending-edit-error').textContent = current ? '这条内容已发送或移除，无法再修改。' : '项目已切换，未修改提示词。';
  const text = $('pending-edit-input').value;
  $('pending-edit-save').disabled = pendingPromptEditSaving || !item || !current || (!text.trim() && !item.attachments.length) || text.trim().length > 40000;
  $('pending-edit-cancel').disabled = pendingPromptEditSaving;
  $('pending-edit-close').disabled = pendingPromptEditSaving;
}

async function savePendingPromptEdit(event) {
  event.preventDefault();
  if (!pendingPromptEdit || pendingPromptEditSaving || $('pending-edit-save').disabled) return;
  const editing = pendingPromptEdit;
  pendingPromptEditSaving = true; pendingPromptActions.add(editing.id); renderPendingPromptEditState(); renderPendingPrompts();
  try {
    const queue = await bridge.managePendingPrompt({ id: editing.id, action: 'edit', text: $('pending-edit-input').value });
    if (pendingPromptEdit !== editing || currentWorkspaceId() !== editing.workspaceId) return;
    syncPromptQueue(queue.queue || queue.promptQueue || queue);
    $('pending-edit-dialog').close();
  } catch (error) { if (pendingPromptEdit === editing) $('pending-edit-error').textContent = errorText(error); }
  finally { pendingPromptEditSaving = false; pendingPromptActions.delete(editing.id); renderPendingPrompts(); renderPendingPromptEditState(); }
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
    setSessionTokenRate(null);
    terminalCurrentId = event.id;
    setTerminalOpen(true);
    ensureTerminalRun(event.id, event.command || event.text || '');
    $('terminal-status').textContent = '执行中';
    $('run-status').textContent = '终端执行中';
  } else if (event.type === 'terminal-output') terminalSnapshot(event);
  else if (event.type === 'terminal-end') {
    const run = ensureTerminalRun(event.id);
    if (event.result?.outputTruncated === true && typeof event.result.output === 'string') terminalSnapshot({ id: event.id, text: event.result.output });
    const labels = { completed: '已完成', failed: '执行失败', stopped: '已停止', denied: '未执行' };
    const message = typeof event.result?.message === 'string' ? event.result.message : typeof event.result?.error === 'string' ? event.result.error : '';
    const pendingExit = event.result?.cleanupPending === true && event.result.processExitObserved === false;
    const label = pendingExit ? '已停止等待命令' : labels[event.status] || '已结束';
    const cleanupDetail = (event.result?.cleanupPending || event.result?.outputIncomplete)
      ? window.ForgeCommandResult?.describe({}, event.result).detail || '' : '';
    run.result.textContent = `${label}${event.exitCode !== null && event.exitCode !== undefined ? ` · 退出代码 ${event.exitCode}` : ''}${message ? ` · ${message}` : ''}${cleanupDetail ? ` · ${cleanupDetail}` : ''}${event.result?.outputTruncated === true ? ' · 输出已节选首尾' : ''}`;
    if (terminalCurrentId === event.id || !terminalCurrentId) {
      terminalRunning = false;
      terminalCurrentId = null;
      $('terminal-status').textContent = label;
      $('run-status').textContent = '准备就绪';
      clearComposerApprovals();
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
  const mode = settings.authMode || settings.providers?.[settings.provider]?.authMode;
  return settings.provider === 'openai' && mode === 'chatgpt' ? 'chatgpt'
    : settings.provider === 'deepseek' && mode === 'deepseek-account' ? 'deepseek-account'
    : settings.provider === 'kimi' && mode === 'kimi-agent' ? 'kimi-agent'
    : settings.provider === 'glm' && mode === 'glm-agent' ? 'glm-agent'
    : settings.provider === 'anthropic' && mode === 'claude-agent' ? 'claude-agent'
    : settings.provider === 'doubao' && mode === 'ark-account' ? 'ark-account'
    : settings.provider === 'gemini' && ['gemini-account', 'antigravity-agent'].includes(mode) ? mode : 'apiKey';
}

function modelSettingsScope() { return window.ForgeRoleModels.scope(appState, settingsRole); }
function modelSettingsConfig() { return modelSettingsScope().settings || {}; }
function modelSettingsChatGPT() { return modelSettingsScope().chatgpt || {}; }
function settingsModelSelectable(model) { return window.ForgeRoleModels.selectable(settingsRole, model); }
function modelSettingsAction(action, input) { return window.ForgeRoleModels.invoke(bridge, settingsRole, action, input); }

function renderModelSettingsScope() {
  const role = window.ForgeRoleModels.roleInfo(settingsRole), entry = modelSettingsScope();
  const legacy = settingsRole === 'approval' && !entry.enabled && appState?.approvalReviewer?.model;
  $('settings-title').textContent = role ? `${role.name}模型设置` : '主模型设置';
  $('settings-scope-hint').hidden = !role;
  $('settings-scope-hint').textContent = role ? entry.enabled
    ? `当前使用独立配置，仅用于${role.name}。账号和密钥独立保存。`
    : ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(currentAuthMode()) ? '官方代理仅用于主会话；此功能请单独配置 API 模型。'
    : legacy ? `当前连接使用审批模型 ${legacy}。保存下方配置后，审批将使用独立连接。`
    : `当前跟随主模型。保存下方配置后，${role.name}将独立使用所选模型和账号。` : '';
  $('settings-role-reset').hidden = !role;
  $('settings-role-reset').disabled = !role || !(entry.enabled || legacy) || contextBusy() || settingsSaving || isChatGPTBusy();
}

function catalogIdentity(provider, authMode, state = appState) {
  const config = state?.settings?.providers?.[provider] || {};
  const account = provider === 'openai' && authMode === 'chatgpt' ? state?.chatgpt
    : provider === 'deepseek' && authMode === 'deepseek-account' ? state?.deepseek
    : provider === 'gemini' && authMode === 'gemini-account' ? state?.gemini
    : provider === 'gemini' && authMode === 'antigravity-agent' ? state?.antigravity
    : provider === 'kimi' && authMode === 'kimi-agent' ? state?.kimiAgent
    : provider === 'glm' && authMode === 'glm-agent' ? state?.glmAgent
    : provider === 'anthropic' && authMode === 'claude-agent' ? state?.claudeAgent
    : provider === 'doubao' && authMode === 'ark-account' ? state?.ark : null;
  const identity = [provider, authMode, account ? '' : config.baseUrl || '', account ? account.session?.profileId || '' : !!config.hasKey,
    account ? account.session?.status || '' : '', account ? account.session?.sharing === true : false];
  if (provider === 'ollama') identity.push(config.contextWindowTokens ?? 32768);
  if (['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(authMode)) identity.push(account?.runtime?.status || '', account?.runtime?.version || '', account?.region || '');
  return JSON.stringify(identity);
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

function savedConnectionReady(provider, authMode, state = appState) {
  if (provider === 'openai' && authMode === 'chatgpt') return state?.chatgpt?.session?.status === 'connected' && state?.chatgpt?.session?.sharing === true;
  if (provider === 'deepseek' && authMode === 'deepseek-account') return state?.deepseek?.session?.status === 'connected' && state?.deepseek?.session?.sharing === true;
  if (provider === 'gemini' && authMode === 'gemini-account') return state?.gemini?.session?.status === 'connected' && state?.gemini?.session?.sharing === true;
  const agent = provider === 'gemini' && authMode === 'antigravity-agent' ? state?.antigravity
    : provider === 'kimi' && authMode === 'kimi-agent' ? state?.kimiAgent : provider === 'glm' && authMode === 'glm-agent' ? state?.glmAgent
    : provider === 'anthropic' && authMode === 'claude-agent' ? state?.claudeAgent
    : provider === 'doubao' && authMode === 'ark-account' ? state?.ark : null;
  if (['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(authMode)) return agent?.runtime?.status === 'ready'
    && agent?.session?.status === 'connected' && agent?.session?.sharing === true && !!agent?.session?.profileId;
  if (authMode === 'ark-account') return state?.ark?.session?.status === 'connected' && state?.ark?.session?.sharing === true && !!state?.ark?.session?.profileId;
  if (provider === 'ollama') return true;
  return state?.settings?.providers?.[provider]?.hasKey === true;
}

function modelSettingsDraft() {
  const provider = $('provider-select').value;
  const authMode = selectedAuthMode();
  const draft = { provider, authMode };
  if (authMode === 'kimi-agent') draft.region = window.synoraKimiAgentLogin?.getRegion() || modelSettingsScope().kimiAgent?.region || 'mainland-cn';
  if (authMode === 'glm-agent') draft.region = window.synoraGlmAgentLogin?.getRegion() || modelSettingsScope().glmAgent?.region || 'bigmodel';
  if (authMode === 'apiKey') {
    Object.assign(draft, { baseUrl: $('base-url-input').value.trim(), apiKey: $('api-key-input').value.trim() });
    if (['openai', 'relay'].includes(provider)) draft.apiProtocol = $('api-protocol-select').value;
    if (provider === 'ollama') {
      const value = $('ollama-context-window-input').value.trim();
      draft.contextWindowTokens = /^\d+$/u.test(value) ? Number(value) : null;
    }
  }
  return draft;
}

function modelSettingsDraftSnapshot() {
  const draft = modelSettingsDraft();
  const account = ['chatgpt', 'deepseek-account', 'gemini-account', 'antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent', 'ark-account'].includes(draft.authMode);
  const agent = draft.authMode === 'antigravity-agent' ? modelSettingsScope().antigravity
    : draft.authMode === 'kimi-agent' ? modelSettingsScope().kimiAgent : draft.authMode === 'glm-agent' ? modelSettingsScope().glmAgent
    : draft.authMode === 'claude-agent' ? modelSettingsScope().claudeAgent : draft.authMode === 'ark-account' ? modelSettingsScope().ark : null;
  const session = agent ? agent.session
    : draft.authMode === 'gemini-account' ? modelSettingsScope().gemini?.session
    : draft.authMode === 'deepseek-account' ? modelSettingsScope().deepseek?.session : modelSettingsChatGPT().session;
  return { ...draft, role: settingsRole, profileId: account ? session?.profileId || '' : '', accountStatus: account ? session?.status || '' : '', sharing: account && session?.sharing === true,
    ...(agent ? { agentRuntime: JSON.stringify([agent.runtime?.status || '', agent.runtime?.version || '', agent.region || '']) } : {}) };
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
  return settingsCatalogMatches() ? settingsCatalog.models.find(model => model.id === $('chatgpt-model-select').value && settingsModelSelectable(model)) : undefined;
}

function selectedModelMetadata() {
  return currentCatalogKey === activeCatalogIdentity() ? currentCatalog?.models.find((model) => model.id === appState?.settings?.model) : undefined;
}

function reasoningSpec(range, provider) {
  const model = selectedModelMetadata();
  if (['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(currentAuthMode())) {
    const choices = model?.compatible !== false && Array.isArray(model?.reasoningOptions) ? model.reasoningOptions.filter(option => option
      && typeof option.value === 'string' && option.value.length > 0 && option.value.length <= 128
      && !/[\u0000-\u001f\u007f]/u.test(option.value) && typeof option.label === 'string'
      && option.label.length > 0 && option.label.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(option.label)) : [];
    const options = [...new Set(choices.map(option => option.value))];
    return { options, known: true, labels: Object.fromEntries(choices.map(option => [option.value, option.label])),
      defaultEffort: model?.defaultReasoningEffort, currentEffort: model?.currentReasoningEffort };
  }
  const order = ['none', 'enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const known = Array.isArray(model?.reasoningEfforts);
  const options = known ? [...new Set(model.reasoningEfforts.filter((effort) => order.includes(effort)))].sort((a, b) => order.indexOf(a) - order.indexOf(b)) : reasoningOptions[provider] || reasoningOptions.openai;
  return { options, known, defaultEffort: model?.defaultReasoningEffort };
}

function rangeOptions(range) {
  try { if (Array.isArray(JSON.parse(range.dataset.options || 'null'))) return JSON.parse(range.dataset.options); } catch { /* Use generic provider levels until the catalogue supplies model capabilities. */ }
  return reasoningOptions[range.dataset.provider] || reasoningOptions.openai;
}

function officialAgentReasoning(range) {
  return range.id === 'reasoning-effort' && ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(currentAuthMode())
    && reasoningSpec(range, range.dataset.provider).options.length === 0;
}

function reasoningLabel(range, effort) {
  if (effort === 'default') return '默认';
  try { const labels = JSON.parse(range.dataset.labels || '{}'); if (Object.hasOwn(labels, effort)) return labels[effort]; } catch {}
  return reasoningLabels[effort] || effort;
}

function reasoningAvailable(range) {
  return !officialAgentReasoning(range) && range.dataset.support !== 'none' && rangeOptions(range).length > 0;
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
  const officialAgent = officialAgentReasoning($('reasoning-effort')) && metadata?.compatible !== false;
  $('composer-reasoning-label').textContent = officialAgent ? '由官方代理管理' : reasoningAvailable($('reasoning-effort')) ? reasoningLabel($('reasoning-effort'), effort) : settings.provider === 'ollama' ? '默认' : '不可用';
  $('composer-reasoning-label').title = officialAgent ? '推理与工具由官方代理管理' : '';
  $('composer-reasoning-label').classList.toggle('is-unavailable', !officialAgent && !reasoningAvailable($('reasoning-effort')));
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
  if (!message && currentCatalog && !models.length) message = appState?.settings?.provider === 'ollama'
    ? 'Ollama 服务中没有已安装的模型，请准备模型后刷新。' : '模型目录为空，请检查连接配置后重新获取。';
  if (!message && query && !visible.length) message = '没有匹配的模型。';
  $('model-list-status').textContent = message || (running ? '切换后从下一次模型请求生效，当前响应会继续完成。' : '选择模型后保存真实模型 ID。');
  $('model-list-retry').hidden = !catalogError;
  $('model-list-refresh').disabled = modelControlBusy() || modelSaving || catalogLoading;
  visible.forEach((model) => {
    const button = element('button', `model-option${model.id === selected ? ' selected' : ''}`);
    button.type = 'button';
    button.dataset.model = model.id;
    button.dataset.provider = appState?.settings?.provider || '';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(model.id === selected));
    const copy = element('span', 'model-option-copy');
    copy.append(element('strong', '', model.displayName));
    if (model.displayName !== model.id) copy.append(element('small', '', model.id));
    if (model.compatible === false) copy.append(element('small', 'model-option-warning', model.compatibilityReason || '当前编程工具不支持此模型'));
    button.append(copy, element('span', 'model-option-check', model.id === selected ? '✓' : ''));
    button.disabled = modelControlBusy() || modelSaving || model.compatible === false;
    button.title = model.compatibilityReason || model.id;
    button.addEventListener('click', () => selectCurrentModel(model));
    list.append(button);
  });
}

function renderSettingsCatalog() {
  const ollama = $('provider-select').value === 'ollama';
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
    option.disabled = !settingsModelSelectable(model);
    select.append(option);
  });
  select.value = catalog?.models.some((model) => model.id === current) ? current : '';
  let message = '';
  if (settingsCatalogLoading) message = ollama ? '正在读取 Ollama 服务中已安装的模型…' : '正在获取当前连接配置的模型目录…';
  else if (settingsCatalogError) message = settingsCatalogError;
  else if (catalog && !catalog.models.length) message = ollama ? 'Ollama 服务中没有已安装的模型，请准备模型后刷新。' : '目录中没有可选择的模型，请检查连接配置后重新获取。';
  else if (catalog) message = catalog.source === 'official-docs' ? `官方文档列出 ${catalog.models.length} 个型号；可用性以账号实际权限为准。` : ollama && window.ForgeRoleModels.requiresTools(settingsRole) ? `已读取 ${catalog.models.length} 个已安装模型；不支持编程工具的模型不可选作任务模型。` : `已获取 ${catalog.models.length} 个模型；目录不等于实际访问权限。`;
  $('settings-model-catalog-message').textContent = message;
  $('settings-model-catalog-message').hidden = !message;
  $('settings-model-refresh').disabled = contextBusy() || settingsSaving || settingsCatalogLoading || isChatGPTBusy();
}

async function fetchCurrentCatalog(force = false) {
  if (modelControlBusy()) return;
  const provider = appState?.settings?.provider || 'openai';
  const authMode = currentAuthMode();
  const key = activeCatalogIdentity();
  const request = ++catalogRequest;
  catalogLoading = true;
  catalogError = '';
  renderModelList();
  try {
    if (!savedConnectionReady(provider, authMode)) throw new Error(authMode === 'chatgpt' ? '请先在模型设置中连接并授权 ChatGPT。'
      : authMode === 'deepseek-account' ? '请先在模型设置中登录并授权 DeepSeek。'
      : authMode === 'gemini-account' ? '请先在模型设置中连接 Gemini 的 Google 账号。'
      : ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(authMode) ? '请先在模型设置中连接官方代理账号。' : '请先在模型设置中保存 API Key。');
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

function settingsCatalogErrorText(error) {
  const message = errorText(error), codes = ['AGY_CATALOG_EMPTY', 'ZCODE_CATALOG_EMPTY'];
  const code = codes.includes(error?.code) ? error.code : message.slice(0, 8192).match(/\[(AGY_CATALOG_EMPTY|ZCODE_CATALOG_EMPTY)\]/u)?.[1];
  return codes.includes(code) && typeof window.ForgeAntigravityLogin?.errorMessage === 'function'
    ? window.ForgeAntigravityLogin.errorMessage({ code }) : message;
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
    if (authMode === 'chatgpt' && !savedConnectionReady(provider, authMode, modelSettingsScope())) throw new Error('请先连接 ChatGPT 并同意使用套餐用量。');
    if (authMode === 'deepseek-account' && !savedConnectionReady(provider, authMode, modelSettingsScope())) throw new Error('请先登录并授权 DeepSeek 账号。');
    if (authMode === 'gemini-account' && !savedConnectionReady(provider, authMode, modelSettingsScope())) throw new Error('请先连接 Gemini 的 Google 账号。');
    if (authMode === 'antigravity-agent' && !savedConnectionReady(provider, authMode, modelSettingsScope())) throw new Error('请先连接 Antigravity 官方代理。');
    if (['kimi-agent', 'glm-agent'].includes(authMode)) {
      const agent = authMode === 'kimi-agent' ? modelSettingsScope().kimiAgent : modelSettingsScope().glmAgent;
      if (!savedConnectionReady(provider, authMode, modelSettingsScope()) || agent?.region !== draft.region) throw new Error('请先连接所选地区的官方代理账号。');
    }
    if (provider === 'ollama' && (!Number.isInteger(draft.contextWindowTokens) || draft.contextWindowTokens < 4096 || draft.contextWindowTokens > 2097152)) throw new Error('模型上下文必须为 4096 至 2097152 之间的整数 Token。');
    const result = await modelSettingsAction('preview', draft);
    const current = modelSettingsDraftSnapshot();
    if (request !== settingsCatalogRequest || Object.keys(snapshot).length !== Object.keys(current).length
        || Object.keys(snapshot).some(key => snapshot[key] !== current[key]) || !$('settings-dialog').open) return;
    if (typeof result?.selectionToken !== 'string' || !result.selectionToken) throw new Error('模型目录验证失败，请重新获取。');
    settingsCatalog = normalizeCatalog({ ...result, provider: result.provider || provider, authMode: result.authMode || authMode }, provider, authMode);
    settingsCatalogDraft = snapshot;
    renderSettingsCatalog();
    if (settingsCatalog.models.some(model => model.id === selected && settingsModelSelectable(model))) $('chatgpt-model-select').value = selected;
  } catch (error) {
    if (request === settingsCatalogRequest && $('settings-dialog').open) {
      const current = modelSettingsDraftSnapshot();
      if (Object.keys(snapshot).length === Object.keys(current).length && Object.keys(snapshot).every(key => snapshot[key] === current[key])) settingsCatalogError = settingsCatalogErrorText(error);
    }
  }
  finally { if (request === settingsCatalogRequest) { settingsCatalogLoading = false; renderSettingsCatalog(); refreshControlLocks(); } }
}

async function selectCurrentModel(model) {
  if (modelControlBusy() || reasoningSaving || modelSaving || model.compatible === false) return;
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
  if (modelControlBusy() || reasoningSaving || modelSaving) return;
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
  range.dataset.labels = JSON.stringify(spec.labels || {});
  range.dataset.support = spec.known ? options.length ? 'known' : 'none' : 'unknown';
  range.dataset.defaultEffort = spec.defaultEffort || '';
  range.dataset.effort = options.includes(value) ? value : 'default';
  range.value = String(range.dataset.effort === 'default' ? Math.max(0, options.indexOf(spec.defaultEffort || spec.currentEffort) >= 0
    ? options.indexOf(spec.defaultEffort || spec.currentEffort) : Math.floor((options.length - 1) / 2)) : options.indexOf(value));
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
  window.ForgeDeepSeekEffort?.update($('reasoning-popup'), {
    provider: range.dataset.provider, modelId: appState?.settings?.model, effort,
    defaultEffort: range.dataset.defaultEffort, known: range.dataset.support === 'known', available, options,
  });
  const prefix = 'reasoning';
  const label = $(`${prefix}-value`);
  const reset = $(`${prefix}-default`);
  const maximum = available && effort !== 'default' && index === options.length - 1;
  const ollamaDefault = !available && range.dataset.provider === 'ollama';
  const officialAgent = officialAgentReasoning(range) && selectedModelMetadata()?.compatible !== false;
  label.textContent = officialAgent ? '由官方代理管理' : available ? reasoningLabel(range, effort) : ollamaDefault ? '默认' : '不可用';
  label.classList.toggle('is-max', maximum);
  label.classList.toggle('is-unavailable', !officialAgent && !available);
  range.classList.toggle('is-max', maximum);
  range.dataset.fill = String(options.length > 1 ? Math.round(index / (options.length - 1) * 100) : 0);
  const visual = range.closest?.('.reasoning-slider-visual');
  if (visual) {
    visual.dataset.fill = range.dataset.fill;
    visual.classList.toggle('is-max', maximum);
    visual.classList.toggle('is-unavailable', !available);
    if (!available) visual.classList.remove('is-dragging');
  }
  range.setAttribute('aria-valuetext', officialAgent ? '由官方代理管理' : ollamaDefault ? '默认，使用 Ollama 模型设置' : !available ? '不可用，使用服务商默认设置' : effort === 'default' ? '默认，遵从模型默认设置' : reasoningLabel(range, effort));
  range.title = officialAgent ? '推理与工具由官方代理管理' : available ? `推理强度：${label.textContent}` : '模型默认推理设置';
  label.title = officialAgent ? range.title : '';
  reset.classList.toggle('active', available && effort === 'default');
  reset.setAttribute('aria-pressed', String(available && effort === 'default'));
  renderComposerModel();
  range.disabled = !available || modelControlBusy() || reasoningSaving || modelSaving;
  reset.disabled = range.disabled;
}

function setReasoningDisabled(disabled) {
  $('reasoning-effort').disabled = disabled || modelSaving || !reasoningAvailable($('reasoning-effort'));
  $('reasoning-default').disabled = disabled || modelSaving || !reasoningAvailable($('reasoning-effort'));
}

async function setReasoningEffort() {
  if (!reasoningAvailable($('reasoning-effort')) || modelControlBusy() || reasoningSaving || modelSaving) return;
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
    setReasoningDisabled(modelControlBusy());
    $('send-button').disabled = false;
    refreshControlLocks();
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isChatGPTBusy() {
  return chatgptBusy || window.synoraDeepSeekLogin?.isBusy() || window.synoraGeminiLogin?.isBusy() || window.synoraAntigravityLogin?.isBusy()
    || window.synoraKimiAgentLogin?.isBusy() || window.synoraGlmAgentLogin?.isBusy() || window.synoraClaudeAgentLogin?.isBusy() || window.synoraArkLogin?.isBusy() || appState?.chatgpt?.session?.status === 'connecting'
    || appState?.antigravity?.session?.status === 'connecting' || appState?.antigravity?.runtime?.status === 'downloading'
    || appState?.kimiAgent?.session?.status === 'connecting' || appState?.kimiAgent?.runtime?.status === 'downloading'
    || appState?.glmAgent?.session?.status === 'connecting' || appState?.glmAgent?.runtime?.status === 'downloading' || appState?.claudeAgent?.session?.status === 'connecting' || appState?.ark?.session?.status === 'connecting'
    || appState?.deepseek?.session?.status === 'connecting' || appState?.gemini?.session?.status === 'connecting' || !!settingsRole && (modelSettingsChatGPT().session?.status === 'connecting'
      || modelSettingsScope().deepseek?.session?.status === 'connecting' || modelSettingsScope().gemini?.session?.status === 'connecting');
}

function selectedAuthMode() {
  const provider = $('provider-select').value;
  return provider === 'openai' && $('openai-auth-mode').value === 'chatgpt' ? 'chatgpt'
    : provider === 'deepseek' && $('deepseek-auth-mode')?.value === 'deepseek-account' ? 'deepseek-account'
    : provider === 'kimi' && !settingsRole && $('kimi-auth-mode')?.value === 'kimi-agent' ? 'kimi-agent'
    : provider === 'glm' && !settingsRole && $('glm-auth-mode')?.value === 'glm-agent' ? 'glm-agent'
    : provider === 'anthropic' && !settingsRole && $('anthropic-auth-mode')?.value === 'claude-agent' ? 'claude-agent'
    : provider === 'doubao' && !settingsRole && $('doubao-auth-mode')?.value === 'ark-account' ? 'ark-account'
    : provider === 'gemini' && $('gemini-auth-mode')?.value === 'gemini-account' ? 'gemini-account'
    : provider === 'gemini' && !settingsRole && $('gemini-auth-mode')?.value === 'antigravity-agent' ? 'antigravity-agent' : 'apiKey';
}

function restoreChatGPTControls() {
  if (isChatGPTBusy()) return;
  for (const [control, disabled] of chatgptDisabledControls) control.disabled = disabled;
  chatgptDisabledControls.clear();
}

function refreshControlLocks() {
  restoreChatGPTControls();
  refreshTaskChangeControls();
  if (appState) sessionControls?.update({ ...appState, sessionId: sessionId || appState.sessionId, busy: contextBusy() || editorSaving, authBusy: isChatGPTBusy() });
  const busy = contextBusy() || editorSaving;
  $('task-form').classList.toggle('has-active-task', running);
  renderComposerApproval({ restoreFocus: false });
  $('task-input').disabled = terminalRunning || (running && taskKind === 'undo') || isChatGPTBusy();
  $('task-input').placeholder = running ? '可继续输入，发送后加入待发送列表…' : '描述需要完成的任务…';
  promptCompletion?.sync();
  appUpdateControls?.sync();
  $('send-button').hidden = false;
  $('send-button').disabled = draftAttachments.some((attachment) => attachment.loading) || projectSwitching || promptSubmitting || reasoningSaving || modelSaving || terminalRunning || (running && taskKind === 'undo') || isChatGPTBusy();
  $('send-button').title = running || promptQueue.items.length ? '加入待发送列表（Ctrl + Enter）' : '发送任务（Ctrl + Enter）';
  $('send-button').setAttribute('aria-label', running || promptQueue.items.length ? '加入待发送列表' : '发送任务');
  $('stop-button').hidden = !running;
  $('project-switcher').disabled = isChatGPTBusy();
  if ($('open-workspace-sidebar')) $('open-workspace-sidebar').disabled = projectTransitionBusy() || isChatGPTBusy();
  $('undo-change').disabled = busy || !appState?.workspace;
  setReasoningDisabled(modelControlBusy() || reasoningSaving || modelSaving);
  $('model-reasoning-trigger').disabled = modelControlBusy() || reasoningSaving || modelSaving;
  $('popup-model-button').disabled = modelControlBusy() || reasoningSaving || modelSaving;
  $('reasoning-open-settings').disabled = busy || reasoningSaving || modelSaving || isChatGPTBusy();
  $('terminal-input').disabled = busy || isChatGPTBusy();
  $('terminal-run').disabled = busy || !appState?.workspace || isChatGPTBusy();
  $('terminal-stop').disabled = !terminalRunning;
  $('attach-images').disabled = terminalRunning || (running && taskKind === 'undo') || isChatGPTBusy();
  $('attachment-input').disabled = $('attach-images').disabled;
  refreshFileLocks();
  const settingsLocked = busy || settingsSaving;
  ['provider-select', 'openai-auth-mode', 'deepseek-auth-mode', 'gemini-auth-mode', 'kimi-auth-mode', 'glm-auth-mode', 'anthropic-auth-mode', 'doubao-auth-mode'].forEach((id) => { if ($(id)) $(id).disabled = settingsLocked; });
  $('chatgpt-model-select').disabled = settingsLocked || settingsCatalogLoading || !settingsCatalogMatches();
  $('save-settings').disabled = settingsLocked || settingsCatalogLoading || !selectedSettingsModel();
  $('base-url-input').disabled = settingsLocked || selectedAuthMode() !== 'apiKey';
  $('api-protocol-select').disabled = settingsLocked || selectedAuthMode() !== 'apiKey';
  $('ollama-context-window-input').disabled = settingsLocked || $('provider-select').value !== 'ollama';
  $('api-key-input').disabled = settingsLocked || selectedAuthMode() !== 'apiKey';
  $('settings-model-refresh').disabled = settingsLocked || settingsCatalogLoading;
  $('provider-account-open').disabled = settingsLocked;
  $('close-settings').disabled = settingsSaving;
  renderModelSettingsScope();
  if (isChatGPTBusy()) {
    document.querySelectorAll('button,input,select,textarea').forEach((control) => {
      if (['chatgpt-cancel-sign-in', 'deepseek-login-cancel', 'gemini-login-cancel', 'antigravity-cancel-sign-in', 'kimi-agent-cancel-sign-in', 'glm-agent-cancel-sign-in', 'claude-agent-cancel-sign-in', 'ark-cancel-sign-in', 'ark-profile-select', 'ark-profile-confirm', 'ark-code-input', 'ark-code-submit', 'ark-open-authorization'].includes(control.id)) return;
      if (!chatgptDisabledControls.has(control)) chatgptDisabledControls.set(control, control.disabled);
      control.disabled = true;
    });
  }
  $('chatgpt-cancel-sign-in').disabled = chatgptCancelling;
  window.synoraDeepSeekLogin?.render();
  window.synoraGeminiLogin?.render();
  window.synoraAntigravityLogin?.render();
  window.synoraKimiAgentLogin?.render();
  window.synoraGlmAgentLogin?.render();
  window.synoraClaudeAgentLogin?.render();
  window.synoraArkLogin?.render();
  renderPendingPrompts();
  notifyMenuState();
}

function syncAuthModeVisibility() {
  const openai = $('provider-select').value === 'openai';
  const relay = $('provider-select').value === 'relay';
  const ollama = $('provider-select').value === 'ollama';
  const gemini = $('provider-select').value === 'gemini';
  const kimi = $('provider-select').value === 'kimi';
  const glm = $('provider-select').value === 'glm';
  const doubao = $('provider-select').value === 'doubao';
  const ark = doubao && selectedAuthMode() === 'ark-account';
  const account = openai && selectedAuthMode() === 'chatgpt';
  const deepseekAccount = $('provider-select').value === 'deepseek' && selectedAuthMode() === 'deepseek-account';
  const geminiAccount = gemini && selectedAuthMode() === 'gemini-account';
  const antigravity = ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(selectedAuthMode());
  $('openai-auth-mode-field').hidden = !openai;
  $('api-protocol-field').hidden = !(openai || relay) || account;
  $('api-protocol-help').textContent = $('api-protocol-select').value === 'chat-completions'
    ? '使用 /chat/completions；适用于提供 OpenAI 兼容接口的中转站。'
    : '使用 /responses；请确认服务商支持 Responses 协议。';
  $('base-url-input').placeholder = ollama ? 'http://localhost:11434' : gemini ? 'https://generativelanguage.googleapis.com/v1beta'
    : kimi ? 'https://api.moonshot.cn/v1' : glm ? 'https://open.bigmodel.cn/api/paas/v4' : doubao ? 'https://ark.cn-beijing.volces.com/api/v3' : relay ? '例如 https://你的中转地址/v1' : '使用服务商默认 API 地址';
  $('base-url-label').textContent = ollama ? 'Ollama 服务地址' : 'Base URL';
  $('api-key-label').textContent = ollama ? 'API Key（可选）' : 'API Key';
  $('ollama-context-window-field').hidden = !ollama;
  $('ollama-context-window-input').required = ollama;
  $('chatgpt-panel').hidden = !account;
  $('chatgpt-model-field').hidden = false;
  $('base-url-field').hidden = account || deepseekAccount || geminiAccount || antigravity || ark;
  $('api-key-field').hidden = account || deepseekAccount || geminiAccount || antigravity || ark;
  $('provider-account-panel').hidden = !(kimi || glm) || antigravity;
  $('provider-account-open').textContent = kimi ? '登录 Kimi 官方控制台' : '登录智谱 / Z.AI 官方控制台';
  $('settings-footer-hint').textContent = ollama ? '本机服务无需密钥 · 支持自建地址' : account ? '账号登录 · 额度以账号实际权限为准'
    : deepseekAccount ? 'DeepSeek 账号登录' : ark ? '火山方舟账号登录' : antigravity ? '账号登录 · 主会话'
      : geminiAccount ? 'Google 账号 · 旧 Gemini CLI' : gemini ? 'Gemini 原生接口' : '支持自定义 API 地址';
  $('settings-dialog').classList.toggle('chatgpt-mode', account);
  window.synoraDeepSeekLogin?.render();
  window.synoraGeminiLogin?.render();
  window.synoraAntigravityLogin?.render();
  window.synoraKimiAgentLogin?.render();
  window.synoraGlmAgentLogin?.render();
  window.synoraClaudeAgentLogin?.render();
  window.synoraArkLogin?.render();
}

async function openProviderAccount() {
  const provider = $('provider-select').value;
  if (!['kimi', 'glm'].includes(provider) || $('provider-account-open').disabled) return;
  try { await bridge.openProviderAccount({ provider, baseUrl: $('base-url-input').value.trim() }); }
  catch { notice('无法打开官方控制台，请稍后重试。', true); }
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
  for (const value of [modelSettingsChatGPT().session?.error, chatgptLocalError]) {
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

function renderChatGPTState() {
  restoreChatGPTControls();
  const chatgpt = modelSettingsChatGPT();
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
  refreshControlLocks();
}

async function runChatGPTAction(action, callback) {
  if (contextBusy() || settingsSaving || reasoningSaving || isChatGPTBusy()) return;
  if (['signin', 'profile', 'disconnect', 'retry'].includes(action)) {
    if (settingsRole) invalidateSettingsCatalog(); else invalidateCatalogs();
  }
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
  const session = modelSettingsChatGPT().session || {};
  const input = { ...options };
  if (!input.newProfile && session.profileId) input.profileId = session.profileId;
  if (!input.newProfile && (session.status === 'reauth_required' || (session.status === 'connected' && !session.sharing))) input.reconsent = true;
  await runChatGPTAction('signin', () => modelSettingsAction('signin', input));
}

async function cancelChatGPTSignIn() {
  if (chatgptCancelling) return;
  chatgptCancelling = true;
  renderChatGPTState();
  try {
    await modelSettingsAction('cancel');
    updateState(await bridge.getState());
  } catch (error) { chatgptLocalError = chatgptErrorInfo(error); }
  finally { chatgptCancelling = false; renderChatGPTState(); }
}

async function refreshChatGPTModels() {
  await fetchSettingsCatalog(true);
}

async function retryChatGPTStorage() {
  await runChatGPTAction('retry', () => modelSettingsAction('retry'));
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
  window.ForgeContextSettings?.updateMetrics(metrics);
  const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const number = value => validNumber(value) ? Math.trunc(value).toLocaleString('en-US') : '—';
  const percent = value => validNumber(value) && value <= 100
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%' : null;
  const rounds = validNumber(metrics?.rounds) ? Math.trunc(metrics.rounds) : null;
  $('session-rounds').textContent = rounds === null ? '— 轮对话' : rounds ? `第 ${number(rounds)} 轮对话` : '0 轮对话';

  const cachePercent = metrics?.cacheStatus === 'unavailable' ? null : percent(metrics?.cacheHitPercent);
  const partialCache = cachePercent !== null && metrics?.cacheStatus === 'partial';
  $('session-cache-value').textContent = cachePercent === null ? '0' : cachePercent + (partialCache ? '*' : '');
  $('session-cache').title = cachePercent === null ? '服务商尚未提供当前会话的缓存命中数据，暂显示 0。'
    : `API 回报缓存输入：${number(metrics.cachedInputTokens)} Token。命中率为已回报缓存输入占对应请求输入的比例。${partialCache ? '\n部分请求未提供缓存用量；仅统计已提供数据的请求。' : ''}`;

  const noReportedUsage = metrics?.usageStatus === 'unavailable' && rounds > 0;
  $('session-total-value').textContent = noReportedUsage ? '—' : number(metrics?.totalTokens);
  $('session-total').classList.toggle('partial', metrics?.usageStatus === 'partial');
  $('session-total').title = noReportedUsage ? '服务商尚未回报当前会话的 Token 用量。'
    : `当前会话 API 已回报的累计用量：输入 ${number(metrics?.inputTokens)} / 输出 ${number(metrics?.outputTokens)} Token。${metrics?.usageStatus === 'partial' ? '\n部分请求缺少用量报告，仅累计已知用量。' : ''}\n缓存输入和推理 Token 已包含在相应用量中，不重复累加。`;

  const display = metrics?.contextDisplay || (metrics?.contextStatus === 'reported'
    ? { source: 'current', pending: false, percent: metrics.contextPercent, usedTokens: metrics.contextUsedTokens,
      inputTokens: metrics.contextInputTokens, outputTokens: metrics.contextOutputTokens, limit: metrics.contextLimit }
    : { source: 'none', pending: true });
  const contextPercent = validNumber(display.percent)
    ? `${display.source === 'estimated' ? '~' : ''}${display.percent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : null;
  const contextLabel = contextPercent === null ? '—' : contextPercent;
  const context = $('session-context');
  const description = typeof metrics?.contextDescription === 'string' ? metrics.contextDescription : '';
  const details = [];
  const hasEstimate = display.source === 'estimated' && validNumber(display.usedTokens);
  const hasSample = !['none', 'estimated'].includes(display.source) && validNumber(display.usedTokens);
  if (hasSample) {
    const limit = validNumber(display.limit) ? number(display.limit) : '未提供';
    details.push(`最近完整请求实测：${number(display.usedTokens)} / ${display.limitKind === 'input' ? '输入上限' : '容量'} ${limit} Token。`);
    details.push(`服务端回报：输入 ${number(display.inputTokens)} / 输出 ${validNumber(display.outputTokens) ? number(display.outputTokens) : '未回报'} Token。`);
    if (display.pending) details.push('当前新增内容待回报，以上保留最近完整实测；未计入本地估算。');
  }
  if (hasEstimate) {
    details.push(`本地估算：~${number(display.usedTokens)} / 容量 ${validNumber(display.limit) ? number(display.limit) : '未提供'} Token。`);
    details.push('服务端尚未完整回报；本地估算不作为实测或计费用量。');
  }
  if (description && !hasSample && !hasEstimate) details.push(description);
  else if (contextPercent === null && !hasSample && !hasEstimate) details.push('等待完整的服务端实测数据。');
  const contextTitle = (contextPercent !== null ? `${hasEstimate ? '本地估算上下文' : display.pending ? '最近实测上下文' : '上下文使用率'}：${contextLabel}\n`
    : hasSample || hasEstimate ? '模型未提供可用容量，使用率未知。\n' : '暂无可用上下文用量。\n') + details.join('\n');
  $('session-context-value').textContent = contextLabel;
  $('session-context-progress').setAttribute('stroke-dasharray', `${contextPercent === null ? 0 : Math.min(100, display.percent)} 100`);
  context.classList.toggle('unknown', contextPercent === null);
  context.classList.toggle('pending', Boolean(display.pending && (hasSample || hasEstimate)));
  context.title = contextTitle;
  context.setAttribute('aria-valuetext', contextTitle.replace(/\n/g, '，'));
  if (contextPercent === null) context.removeAttribute('aria-valuenow');
  else context.setAttribute('aria-valuenow', String(Math.min(100, display.percent)));
  renderSessionTokenRate();
}

function resetTelemetry() {
  activeTaskActivity?.compaction?.remove();
  contextCompacting = false;
  clearInterval(taskActivityTimer);
  taskActivityTimer = null;
  activeTaskActivity = null;
  latestTelemetry = null;
  setSessionTokenRate(null);
}

function hasTokenRate(event) {
  return typeof event?.tokensPerSecond === 'number' && Number.isFinite(event.tokensPerSecond) && event.tokensPerSecond > 0;
}

function sessionTokenRateIdentity() {
  return `${currentWorkspaceId()}\n${appState?.sessionId || sessionId || ''}`;
}

function setSessionTokenRate(event) {
  sessionTokenRate = hasTokenRate(event) ? { identity: sessionTokenRateIdentity(), event: { ...event } } : null;
  renderSessionTokenRate();
}

function renderSessionTokenRate() {
  const metric = $('session-speed'), speed = $('generation-speed');
  if (!metric || !speed) return;
  if (sessionTokenRate?.identity !== sessionTokenRateIdentity()) sessionTokenRate = null;
  const event = sessionTokenRate?.event;
  const known = hasTokenRate(event);
  metric.classList.toggle('unknown', !known);
  if (!known) {
    speed.textContent = '0 tok/s';
    metric.title = '模型输出速度；等待、工具执行和审批期间不显示实时速度。尚无可用输出速率时显示 0。';
  } else {
    const rate = event.tokensPerSecond.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    speed.textContent = `${event.estimated ? '≈' : ''}${rate} tok/s`;
    const output = event.estimated ? count(event.estimatedOutputTokens) : count(event.outputTokens);
    metric.title = `模型请求平均输出速度，排除工具执行与审批等待。\n${event.estimated ? '估算' : 'API 回报'}输出：${output.toLocaleString('en-US')} Token\n任务总时长：${(Math.max(0, Number(event.elapsedMs) || 0) / 1000).toFixed(1)} 秒${event.estimated ? '\n估算速度不计入用量统计。' : ''}`;
  }
  metric.setAttribute('aria-label', `输出速度：${speed.textContent}。${metric.title.replace(/\n/g, '，')}`);
}

function showTokenRate(event, activity = activeTaskActivity) {
  if (!activity) return;
  const { speed, separator } = activity;
  // Keep per-run values available for restoration, with one visible rate in
  // the composer statistics rather than repeating it beside every duration.
  speed.hidden = true; separator.hidden = true;
  if (activity === activeTaskActivity) setSessionTokenRate(event);
  if (!hasTokenRate(event)) { speed.hidden = true; separator.hidden = true; return; }
  const rate = event.tokensPerSecond.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  speed.textContent = event.estimated ? `≈${rate} tok/s` : `${rate} tok/s`;
  const output = event.estimated ? count(event.estimatedOutputTokens) : count(event.outputTokens);
  speed.title = `模型请求平均输出速度，排除工具执行与审批等待。\n${event.estimated ? '估算' : 'API 回报'}输出：${output.toLocaleString('en-US')} Token\n任务总时长：${(Math.max(0, Number(event.elapsedMs) || 0) / 1000).toFixed(1)} 秒${event.estimated ? '\n估算速度不计入用量统计。' : ''}`;
}

function updateTelemetry(event) {
  if (event.runId && activeTaskActivity?.runId && event.runId !== activeTaskActivity.runId) return;
  latestTelemetry = event;
  if (!running || !activeTaskActivity) return;
  if (event.phase === 'waiting') { activeTaskActivity.lastAssistant = null; activeTaskActivity.lastAssistantConfirmed = false; }
  if (Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0) activeTaskActivity.elapsedFloor = Math.max(activeTaskActivity.elapsedFloor, event.elapsedMs);
  if (activeTaskActivity.reconnect?.status === 'retrying' && ['thinking', 'generating', 'completed'].includes(event.phase)) clearTaskReconnect();
  if (activeTaskActivity.reconnect) {
    showTokenRate(null);
    renderTaskActivityElapsed();
    return;
  }
  const phaseLabels = { waiting: '等待模型', thinking: '正在思考', generating: '正在生成', tool: '正在执行工具', approval: '等待你的确认', completed: '模型已返回' };
  if (contextCompacting) setTaskActivityPhase('compacting', '正在压缩上下文…');
  else if (phaseLabels[event.phase]) {
    const preserveToolLabel = event.phase === 'tool' && activeTaskActivity.phase === 'tool';
    if (!preserveToolLabel) setTaskActivityPhase(event.phase, phaseLabels[event.phase]);
  }
  if (hasTokenRate(event)) activeTaskActivity.lastRate = { ...event };
  if (!contextCompacting && ['generating', 'thinking', 'completed'].includes(event.phase)) showTokenRate(event);
  else showTokenRate(null);
  renderTaskActivityElapsed();
}

function activityDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `用时 ${hours ? `${hours}小时 ` : ''}${hours || minutes ? `${minutes}分钟 ` : ''}${seconds % 60}秒`;
}

function taskElapsed(activity) {
  if (Number.isFinite(activity.finishedElapsed)) return activity.finishedElapsed;
  return Math.max(activity.elapsedFloor || 0, performance.now() - activity.startedMono);
}

function renderTaskActivityElapsed(activity = activeTaskActivity) {
  if (!activity) return;
  if (activity === activeTaskActivity && activity.status === 'running' && activity.reconnect) renderTaskReconnect(activity);
  activity.elapsed.textContent = activityDuration(taskElapsed(activity));
  if (activity.status === 'running') for (const card of activity.events.querySelectorAll('.subagent-card')) window.ForgeSubagents?.tick(card);
}

function createTaskActivity(record = {}) {
  const block = element('details', 'task-activity');
  const summary = element('summary', 'task-activity-summary');
  const events = element('div', 'task-activity-events');
  const phaseLine = element('div', 'task-activity-phase-line');
  phaseLine.setAttribute('role', 'status');
  phaseLine.setAttribute('aria-live', 'polite');
  phaseLine.setAttribute('aria-atomic', 'true');
  const marker = element('span', 'task-activity-marker', '◌');
  marker.setAttribute('aria-hidden', 'true');
  const phase = element('span', 'task-activity-phase', '等待模型');
  phaseLine.append(marker, phase);
  const meta = element('div', 'task-activity-meta');
  const elapsed = element('span', 'task-activity-elapsed', '用时 0秒');
  const separator = element('span', 'task-activity-separator', '·');
  const speed = element('span', 'generation-speed task-activity-speed');
  separator.hidden = true;
  speed.hidden = true;
  const chevron = element('span', 'task-history-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  meta.append(elapsed, separator, speed, chevron);
  summary.append(meta);
  // The live status follows the process rather than the round heading. Keep
  // it outside the event container so it cannot split adjacent tool groups.
  block.append(summary, events, phaseLine);
  block.open = true;
  const runId = String(record.runId || record.id || '');
  if (runId) block.dataset.runId = runId;
  return { block, events, summary, phaseLine, phaseNode: phase, marker, elapsed, separator, speed, runId, phase: 'waiting', lastRate: null, elapsedFloor: 0, startedMono: performance.now(), finishedElapsed: null, status: 'running', lastAssistant: null, lastAssistantConfirmed: false, generatedImages: new Map() };
}

function taskProcessTarget() {
  return activeTaskActivity?.status === 'running' ? activeTaskActivity.events : $('messages');
}

function rememberGeneratedImage(event) {
  if (!activeTaskActivity || activeTaskActivity.status !== 'running' || event.runId !== activeTaskActivity.runId
      || typeof event.id !== 'string' || !event.id || !messageImageAttachments(event.attachments).length) return false;
  activeTaskActivity.generatedImages.set(event.id, event.attachments);
  return true;
}

function renderSubagentUpdate(event, { target = taskProcessTarget(), historical = false } = {}) {
  if (!event.agent?.id || !window.ForgeSubagents) return;
  const existing = [...target.querySelectorAll('.subagent-card')].find(card => card.dataset.agentId === event.agent.id);
  if (existing) window.ForgeSubagents.update(existing, event.agent);
  else target.append(window.ForgeSubagents.render(event.agent, { historical }));
}

function renderApprovalReview(event, { historical = false } = {}) {
  if (!event.id) return;
  if (!historical && event.status === 'reviewing' && approvals.has(event.id)) resolveComposerApproval(event.id, false, { expired: true });
}

function archivedImageViewSources(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const displaySources = (Array.isArray(session?.imageToolSources) ? session.imageToolSources.slice(-64) : [])
    .filter(source => source?.role === 'tool' && source.source === 'image-tool' && typeof source.runId === 'string' && source.runId
      && Number.isInteger(source.messageIndex) && source.messageIndex >= 0 && source.messageIndex < messages.length);
  return [...messages, ...displaySources].filter(message => window.ForgeImageViewCard.eligibleSource(message));
}

function renderImageViewed(event, { target = taskProcessTarget(), historical = false } = {}) {
  if (!window.ForgeImageViewCard) return;
  if (!historical) for (const source of window.ForgeImageViewCard.transientSources(event)) {
    if (!imageViewSources.some(message => message.id === source.id)) imageViewSources.push(source);
  }
  const key = `${event.runId || ''}:${event.requestId || JSON.stringify(event.images || [])}`;
  if (renderedImageViews.has(key)) return;
  const card = window.ForgeImageViewCard.create(event, { messages: imageViewSources, onPreview: openImagePreview });
  if (!card) return;
  renderedImageViews.add(key);
  bindFileDisclosureVisibility(card, card.querySelector(':scope > summary'));
  target.append(card);
  if (!historical) {
    fitFileDisclosure(card, $('message-scroll'));
    scrollBottom();
  }
}

function createCommandOutput(target = taskProcessTarget()) {
  const disclosure = element('details', 'command-output-disclosure');
  const summary = element('summary', 'technical-details-summary', '查看命令输出');
  const output = element('pre', 'command-output');
  output.tabIndex = 0;
  disclosure.append(summary, output);
  target.append(disclosure);
  return output;
}

function commandOutputForEvent(event, tools = pendingTools, target = taskProcessTarget(), fallback = null) {
  const tool = tools.at(-1);
  const ownsOutput = tool && String(tool.name || '').replace(/（模拟）$/u, '') === 'run_command'
    && (!event.toolCallId || event.toolCallId === tool.toolCallId)
    && (!event.runId || !tool.runId || event.runId === tool.runId);
  // Output belongs to its command. A sibling output disclosure would split
  // otherwise adjacent commands and leave logs outside their collapsed group.
  if (ownsOutput) return tool.commandOutput ||= createCommandOutput(tool.details);
  // Preserve orphaned output from older records without assigning it to an
  // unrelated tool or moving it across a visible conversation boundary.
  if (fallback?.parentElement?.parentElement === target && target.lastElementChild === fallback.parentElement) return fallback;
  return createCommandOutput(target);
}

function moveTaskActivityToEnd() {
  if (activeTaskActivity?.status === 'running' && activeTaskActivity.block.isConnected) {
    $('messages').append(activeTaskActivity.block);
    activeTaskActivity.compaction?.place();
  }
}

function beginTaskActivity(record = {}) {
  if (record.kind === 'undo' || taskKind === 'undo') return null;
  const runId = String(record.runId || record.id || '');
  if (activeTaskActivity?.status === 'running' && (!runId || !activeTaskActivity.runId || activeTaskActivity.runId === runId)) {
    if (runId) { activeTaskActivity.runId = runId; activeTaskActivity.block.dataset.runId = runId; }
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.parse(record.startedAt || '');
    if (Number.isFinite(startedAt) && startedAt <= Date.now()) activeTaskActivity.elapsedFloor = Math.max(activeTaskActivity.elapsedFloor, Date.now() - startedAt);
    return activeTaskActivity;
  }
  clearInterval(taskActivityTimer);
  latestTelemetry = null;
  activeTaskActivity = createTaskActivity(record);
  const activity = activeTaskActivity;
  for (const tool of pendingTools) if (tool.card.parentElement === $('messages')) activity.events.append(tool.card);
  activity.block.classList.add('running');
  activity.block.dataset.status = 'running';
  setSessionTokenRate(null);
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
  if (activeTaskActivity.phaseNode.textContent !== label) activeTaskActivity.phaseNode.textContent = label;
  activeTaskActivity.block.dataset.phase = phase;
  // Tool cards already describe their own progress, and compression has a
  // dedicated notice (including reconnects). Avoid a second generic status.
  activeTaskActivity.phaseLine.hidden = ['tool', 'completed', 'compacting'].includes(phase) || contextCompacting;
  activeTaskActivity.marker.textContent = phase === 'reconnecting' ? '↻' : '◌';
  if (phase !== 'reconnecting') activeTaskActivity.phaseNode.removeAttribute('title');
  $('run-status').textContent = label;
  if (!['thinking', 'generating', 'completed'].includes(phase)) showTokenRate(null);
}

function clearTaskReconnect() {
  if (!activeTaskActivity) return;
  activeTaskActivity.reconnect = null;
  activeTaskActivity.compaction?.reconnect(null);
  delete activeTaskActivity.block.dataset.reconnect;
}

function renderTaskReconnect(activity = activeTaskActivity) {
  if (activity !== activeTaskActivity || !activity?.reconnect || activity.status !== 'running') return;
  const state = activity.reconnect;
  activity.compaction?.reconnect(state);
  const seconds = state.status === 'waiting' ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000)) : 0;
  setTaskActivityPhase('reconnecting', state.reason === 'format'
    ? `工具参数格式有误，正在重新生成 ${state.attempt}/${state.maxAttempts}`
    : `正在重连 ${state.attempt}/${state.maxAttempts}${seconds ? ` · ${seconds}秒后重试` : ''}`);
  activity.phaseNode.title = state.reason === 'format' ? '无效的工具调用未执行，正在请求模型重新生成。' : '模型连接中断，将重新请求当前回复。';
}

function handleReconnect(event) {
  const activity = activeTaskActivity;
  if (!running || !activity || activity.status !== 'running' || event.agentId
      || (event.runId && activity.runId && event.runId !== activity.runId)) return;
  if (event.status === 'waiting' || event.status === 'retrying') {
    if (event.resetText) {
      if (streamedMessage) {
        const removed = streamedMessage.message;
        removed.remove();
        if (activity.lastAssistant === removed) { activity.lastAssistant = null; activity.lastAssistantConfirmed = false; }
      }
      streamedMessage = null;
      streamedText = '';
    }
    const maxAttempts = Number.isInteger(event.maxAttempts) && event.maxAttempts > 0 ? Math.min(10, event.maxAttempts) : 5;
    activity.reconnect = {
      status: event.status,
      reason: event.reason === 'format' ? 'format' : undefined,
      attempt: Math.max(1, Math.min(maxAttempts, Number.isInteger(event.attempt) ? event.attempt : 1)), maxAttempts,
      retryAt: Number.isFinite(event.retryAt) ? event.retryAt : Date.now() + Math.max(0, Math.min(60_000, Number(event.delayMs) || 0)),
    };
    activity.block.dataset.reconnect = event.status;
    setSessionTokenRate(null);
    renderTaskReconnect(activity);
  } else if (event.status === 'recovered' || event.status === 'failed') {
    const formatRetry = activity.reconnect?.reason === 'format';
    clearTaskReconnect();
    if (event.status === 'failed' && contextCompacting) finishContextCompaction('failed');
    setTaskActivityPhase(event.status === 'failed' ? 'reconnect-failed' : contextCompacting ? 'compacting' : 'waiting',
      event.status === 'failed' ? formatRetry ? '工具参数重试失败' : '重连失败' : contextCompacting ? '正在压缩上下文…' : formatRetry ? '工具参数已重新生成' : '连接已恢复');
  }
}

function finishTaskActivity(record = {}) {
  if (record.runId && activeTaskActivity?.runId && record.runId !== activeTaskActivity.runId) return;
  clearInterval(taskActivityTimer);
  taskActivityTimer = null;
  const activity = activeTaskActivity;
  if (!activity || activity.status !== 'running') return;
  finishContextCompaction(['failed', 'stopped'].includes(record.status) ? record.status : 'ended');
  clearTaskReconnect();
  const duration = Number.isFinite(record.elapsedMs) ? record.elapsedMs : record.durationMs;
  activity.finishedElapsed = Number.isFinite(duration) && duration >= 0 ? duration : taskElapsed(activity);
  activity.status = ['completed', 'failed', 'stopped'].includes(record.status) ? record.status : 'completed';
  activity.block.dataset.status = activity.status;
  activity.block.classList.remove('running');
  activity.phaseLine.hidden = true;
  // Only the final assistant reply stays outside the folded operation history.
  // A later tool-start invalidates an earlier commentary candidate.
  const answer = activity.lastAssistant;
  if (activity.lastAssistantConfirmed && answer?.isConnected && activity.events.contains(answer) && answer.querySelector('.message-body')?.textContent.trim()) {
    activity.block.after(answer);
  }
  if (activity.generatedImages.size) {
    const target = activity.lastAssistantConfirmed && answer?.isConnected && !activity.events.contains(answer) ? answer : null;
    if (target) for (const attachments of activity.generatedImages.values()) appendGeneratedImages(target, attachments);
    else {
      const generated = addMessage('assistant', '图片已生成。', false, { historical: true });
      for (const attachments of activity.generatedImages.values()) appendGeneratedImages(generated.message, attachments);
    }
  }
  for (const tool of activity.events.querySelectorAll('details.tool-card')) tool.open = false;
  for (const card of activity.events.querySelectorAll('.subagent-card')) {
    window.ForgeSubagents?.finish(card);
    card.open = false;
  }
  activity.block.open = false;
  if (!activity.events.childElementCount) activity.events.append(element('p', 'task-history-empty', '本轮没有工具操作。'));
  const finalRate = record.telemetry || record.finalTelemetry;
  if (finalRate) activity.lastRate = hasTokenRate(finalRate) ? { ...finalRate, elapsedMs: activity.finishedElapsed } : null;
  else if (hasTokenRate(latestTelemetry)) activity.lastRate = { ...latestTelemetry };
  showTokenRate(activity.lastRate, activity);
  renderTaskActivityElapsed(activity);
}

function restoreTaskActivityFromState() {
  const active = appState?.activeTask;
  if (!active?.running || active.kind !== 'agent') return;
  beginTaskActivity(active);
  for (const agent of active.subagents || []) renderSubagentUpdate({ agent });
  for (const request of appState?.pendingApprovals || []) if (request.reviewStatus === 'reviewing') renderApprovalReview({ ...request, status: 'reviewing' });
  if (active.telemetry) updateTelemetry(active.telemetry);
  syncContextCompaction(active);
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

function renderQuestionAnswer(event, { target, historical = false, runId } = {}) {
  const answer = window.ForgeTaskHistory?.questionAnswer(event);
  if (!answer || historical && answer.runId !== runId) return null;
  if (!historical && (!running || activeTaskActivity?.status !== 'running' || answer.runId !== activeTaskActivity.runId
      || answer.sessionId !== sessionId || taskKind === 'undo')) return null;
  target ||= taskProcessTarget();
  const existing = [...target.querySelectorAll('.question-answer-card')].find(card => card.dataset.runId === answer.runId && card.dataset.questionId === answer.questionId);
  if (existing) return existing;
  const card = element('section', 'question-answer-card'); card.dataset.questionId = answer.questionId; card.dataset.runId = answer.runId;
  card.append(element('p', 'question-answer-title', 'AI 提问'), element('p', 'question-answer-question', answer.question));
  const response = element('div', 'question-answer-response'); response.dataset.kind = Number.isSafeInteger(answer.choiceIndex) ? 'choice' : 'custom';
  response.append(element('p', 'question-answer-label', Number.isSafeInteger(answer.choiceIndex) ? `用户回答 · 选项 ${answer.choiceIndex + 1}` : '用户回答 · 自定义'),
    element('p', 'question-answer-text', answer.answer));
  card.append(response); target.append(card); return card;
}

function renderHistoricalTaskActivity(record, items = []) {
  const activity = createTaskActivity(record);
  activity.status = ['completed', 'failed', 'stopped'].includes(record.status) ? record.status : 'completed';
  activity.block.dataset.status = activity.status;
  activity.block.dataset.historical = 'true';
  activity.phaseLine.hidden = true;
  activity.finishedElapsed = Number.isFinite(record.elapsedMs) ? record.elapsedMs : record.durationMs;
  const tools = [];
  let output = null;
  const generatedImages = [];
  for (const item of items) {
    if (item.type === 'message' && item.message.source === 'generated-image') generatedImages.push(item.message.attachments);
    else if (item.type === 'message' && (item.message.content || messageImageAttachments(item.message.attachments).length)) addMessage(item.message.role, item.message.content || '', false, { ...item.message, target: activity.events, historical: true });
    else if (item.type === 'event') {
      const event = item.event;
      if (event.type === 'tool-start') {
        output = null;
        const tool = createToolCard(event);
        appendGroupedToolCard(activity.events, tool, event); tools.push(tool);
      } else if (event.type === 'tool-result') {
        if (!tools.some(tool => event.toolCallId ? tool.toolCallId === event.toolCallId : tool.name === event.name)) {
          const tool = createToolCard({ name: event.name, args: {}, toolCallId: event.toolCallId, runId: event.runId });
          appendGroupedToolCard(activity.events, tool, event); tools.push(tool);
        }
        completeTool(event, { tools, updateActivity: false });
      } else if (event.type === 'subagent-update') renderSubagentUpdate(event, { target: activity.events, historical: true });
      else if (event.type === 'images-viewed') renderImageViewed(event, { target: activity.events, historical: true });
      else if (event.type === 'approval-review') renderApprovalReview(event, { target: activity.events, historical: true });
      else if (event.type === 'question-answer') renderQuestionAnswer(event, { target: activity.events, historical: true, runId: record.runId || record.id });
      else if (event.type === 'context-compacted') appendContextCompactionNotice(event, activity.events);
      else if (event.type === 'command-output') {
        output = commandOutputForEvent(event, tools, activity.events, output);
        if (event.replace) output.textContent = event.text || '';
        else output.append(document.createTextNode(event.text || ''));
      }
    }
  }
  tools.forEach(finishToolWithoutResult);
  if (!activity.events.childElementCount) activity.events.append(element('p', 'task-history-empty', '此记录未保留可展开的操作明细。'));
  activity.block.open = false;
  showTokenRate(record.telemetry || record.finalTelemetry, activity);
  if (!activeTaskActivity) setSessionTokenRate(record.telemetry || record.finalTelemetry);
  renderTaskActivityElapsed(activity);
  $('messages').append(activity.block);
  return generatedImages;
}

function toolActivity(name, args, completed = false) {
  const id = xmlFileTool(name, args) ? 'read_file' : String(name || '').replace(/（模拟）/g, '');
  const labels = {
    spawn_agent: completed ? '已分配子任务' : '正在分配子任务',
    wait_agents: completed ? '子任务结果已返回' : '正在等待子任务',
    send_agent_message: completed ? '已补充子任务说明' : '正在补充子任务说明',
    stop_agent: completed ? '子任务已停止' : '正在停止子任务',
    list_files: completed ? '已读取文件列表' : '正在浏览项目文件',
    read_file: completed ? '已读取文件' : '正在读取文件',
    view_image: completed ? '已读取图片' : '正在读取图片',
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
  const detail = typeof args?.path === 'string' ? args.path : id === 'run_command' ? null : args?.url;
  return typeof detail === 'string' && detail ? `${label} · ${detail.replace(/\s+/g, ' ').slice(0, 220)}` : label;
}

function xmlFileTool(name, args) {
  if (name === 'read_url') return true;
  if (name !== 'browser_navigate') return false;
  try { return /\.xml$/iu.test(new URL(args?.url).pathname); } catch { return false; }
}

function renderText(container, text) {
  window.ForgeMarkdown.renderMarkdown(container, text, {
    onLink: url => browserController?.open({ url }).catch(() => {}),
    onCopy: value => bridge.copyText({ text: value }),
  });
}

function addMessage(role, text, streaming = false, metadata = {}) {
  showConversation();
  const message = element('article', `message ${role === 'user' ? 'user' : 'assistant'}${streaming ? ' streaming' : ''}`);
  if (role === 'user') message.dataset.messageSource = metadata.source || 'user';
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
    header.append(element('span', 'message-avatar', '✳'), element('span', '', 'Cortex'));
    message.append(header, body);
    const images = messageImageAttachments(metadata.attachments);
    if (images.length) {
      const gallery = element('div', 'user-message-attachments');
      gallery.setAttribute('aria-label', '生成的图片');
      images.forEach(attachment => gallery.append(createMessageImage(attachment)));
      message.append(gallery);
    }
  }
  const liveSteering = role === 'user' && metadata.source === 'steering' && !metadata.historical
    && activeTaskActivity?.status === 'running' && metadata.runId === activeTaskActivity.runId;
  const target = metadata.target || (liveSteering ? activeTaskActivity.events : role !== 'user' && !metadata.historical ? taskProcessTarget() : $('messages'));
  window.ForgeToolOperationGroups?.breakGroup(target);
  target.append(message);
  if (!metadata.historical && activeTaskActivity?.status === 'running') {
    activeTaskActivity.lastAssistant = role !== 'user' ? message : null;
    activeTaskActivity.lastAssistantConfirmed = false;
  }
  if (!metadata.target && !liveSteering) moveTaskActivityToEnd();
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

function appendGeneratedImages(message, attachments) {
  const images = messageImageAttachments(attachments);
  if (!images.length) return;
  const gallery = element('div', 'user-message-attachments'); gallery.setAttribute('aria-label', '生成的图片');
  images.forEach(image => gallery.append(createMessageImage(image))); message.append(gallery);
}

let imagePreviewZoom;
function openImagePreview(attachment) {
  const image = messageImageAttachments([attachment])[0];
  if (!image) return;
  imagePreviewZoom?.reset();
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
  imagePreviewZoom = window.CortexImagePreviewZoom.create($('image-preview-dialog'), $('image-preview-content').parentElement, $('image-preview-content'));
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
  $('image-preview-content').addEventListener('contextmenu', event => {
    event.preventDefault();
    const dataUrl = $('image-preview-content').src;
    if (!dataUrl || typeof bridge.imagePreviewContext !== 'function') return;
    void bridge.imagePreviewContext({ dataUrl }).catch(error => notice(`图片操作失败：${errorText(error)}`, true));
  });
  $('image-preview-dialog').addEventListener('close', () => { imagePreviewZoom.reset(); $('image-preview-content').removeAttribute('src'); $('image-preview-title').textContent = '图片预览'; });
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
  let finished = streamedMessage;
  if (streamedMessage) {
    if (text !== undefined) renderText(streamedMessage.body, text);
    streamedMessage.message.classList.remove('streaming');
    streamedMessage = null;
    streamedText = '';
  } else if (text) finished = addMessage('assistant', text);
  return finished;
}

function setRunning(value, metadata = {}) {
  const starting = value && !running;
  running = value;
  if (!value) taskDemo = false;
  $('run-status').textContent = value ? '任务进行中' : '准备就绪';
  $('run-status').classList.toggle('running', value);
  if (starting) { if (metadata.kind !== 'undo' && taskKind !== 'undo') { resetTelemetry(); beginTaskActivity(metadata); } closeReasoningPopup(); }
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
  window.synoraRoleModels?.update(state);
  sideChatControls?.update(state);
  permissionControls?.update(state);
  if (state.browser) browserController?.apply(state.browser);
  syncWindowChrome();
  if (syncPendingQueue && state.promptQueue) syncPromptQueue(state.promptQueue);
  if (syncActiveTask && state.activeTask && !(promptSubmitting && !state.activeTask.running)) {
    const active = state.activeTask;
    taskKind = active.kind;
    taskDemo = active.demo === true;
    terminalRunning = active.running === true && active.kind === 'terminal';
    const agentRunning = active.running === true && ['agent', 'undo'].includes(active.kind);
    if (agentRunning !== running) setRunning(agentRunning, active);
    if (agentRunning && active.kind !== 'undo') restoreTaskActivityFromState();
    else syncContextCompaction(active);
    if (terminalRunning) { setTerminalOpen(true); $('terminal-status').textContent = '终端执行中'; }
  }
  if (syncActiveTask && Array.isArray(state.pendingApprovals)) syncComposerApprovals(state.pendingApprovals);
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
  const account = currentAuthMode(settings);
  $('provider-hint').textContent = account === 'chatgpt' ? `ChatGPT 账号 · ${model || '尚未选择模型'}`
    : account === 'deepseek-account' ? `DeepSeek 账号 · ${model || '尚未选择模型'}`
    : account === 'ark-account' ? `火山方舟账号 · ${model || '尚未选择模型'}`
    : account === 'gemini-account' ? `Google 账号 · ${model || '尚未选择模型'}`
      : ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(account) ? `${providerNames[provider] || provider} 账号 · ${model || '尚未选择模型'}` : model ? `${providerNames[provider] || provider} · ${model}` : '尚未配置模型';
  fillReasoningOptions($('reasoning-effort'), provider, settings.reasoningEffort || settings.providers?.[provider]?.reasoningEffort || 'default');
  setReasoningDisabled(modelControlBusy() || reasoningSaving);
  renderUsageStats(state.usageStats);
  renderSessionMetrics(state.sessionMetrics);
  renderSessions(state.sessions || []);
  renderChatGPTState();
  renderComposerModel();
  renderModelList();
  if (workspace?.root !== oldRoot) {
    clearExplorerDrag();
    explorerSelection?.clear();
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
    window.ForgeEditorHighlight?.refresh(null);
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
  explorerSelection?.cancelGesture();
  tree.replaceChildren(element('div', 'tree-loading', '正在读取项目…'));
  try {
    const files = await bridge.fileList({ path: '' });
    if (request !== filesRequest) return;
    explorerSelection?.reconcile('', files);
    tree.replaceChildren(createTree(files));
    explorerSelection?.refresh();
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
    if (explorerSelection?.has(file.path) || !explorerSelection && selectedEntry?.path === file.path) row.classList.add('selected');
    row.setAttribute('aria-selected', String(row.classList.contains('selected')));
    if (selectedEntry?.path === file.path) selectedRow = row;
    const arrow = element('span', 'file-arrow', file.type === 'directory' ? '›' : '');
    row.append(arrow, window.ForgeFileIcons.create(file.name, file.type), element('span', 'file-name', file.name));
    row.title = file.path;
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); showFileContextMenu(event.clientX, event.clientY); });
    bindFileDrag(row, file);
    item.append(row);
    if (file.type === 'directory') {
      row.setAttribute('aria-expanded', 'false');
      let child = null;
      let loading = false;
      row.addEventListener('click', async () => {
        const workspaceId = currentWorkspaceId();
        if (loading) return;
        if (child) {
          child.hidden = !child.hidden;
          arrow.textContent = child.hidden ? '›' : '⌄';
          row.setAttribute('aria-expanded', String(!child.hidden));
          if (child.hidden) expandedDirectories.delete(file.path); else expandedDirectories.add(file.path);
          if (child.hidden) explorerSelection?.collapse(file.path);
          return;
        }
        loading = true;
        arrow.textContent = '·';
        try {
          const entries = await bridge.fileList({ path: file.path });
          if (workspaceId !== currentWorkspaceId() || !row.isConnected) return;
          explorerSelection?.reconcile(file.path, entries);
          child = element('div', 'tree-children');
          child.append(entries.length ? createTree(entries) : element('div', 'tree-loading', '空文件夹'));
          item.append(child);
          explorerSelection?.refresh();
          arrow.textContent = '⌄';
          row.setAttribute('aria-expanded', 'true');
          expandedDirectories.add(file.path);
        } catch (error) { if (workspaceId === currentWorkspaceId() && row.isConnected) { arrow.textContent = '›'; notice(errorText(error), true); } }
        finally { loading = false; }
      });
      if (expandedDirectories.has(file.path)) queueMicrotask(() => { if (row.isConnected) { row.setAttribute('data-restoring-expansion', ''); row.click(); row.removeAttribute('data-restoring-expansion'); } });
    } else row.addEventListener('click', () => { previewFile(file.path, row); });
    list.append(item);
  });
  return list;
}

function clearExplorerDropTarget() {
  document.querySelectorAll('.file-drop-target').forEach((node) => node.classList.remove('file-drop-target'));
}

function clearExplorerDrag() {
  for (const row of explorerDrag?.rows || []) row.classList.remove('file-drag-source');
  explorerDrag?.row.classList.remove('file-drag-source');
  explorerDrag = null;
  clearExplorerDropTarget();
}

function canDropExplorerEntry(event, destination) {
  const drag = explorerDrag;
  if (!drag || drag.workspaceId !== currentWorkspaceId() || !appState?.workspace || explorerMovePending
    || fileOperationBusy({ allowSaving: true }) || !event.dataTransfer?.types.includes(EXPLORER_DRAG_TYPE)) return false;
  const entries = explorerSelectionRoots(drag.entries || [drag]);
  if (entries.some(entry => entry.type === 'directory' && (destination === entry.path || destination.startsWith(entry.path + '/')))) return false;
  return entries.some(entry => entry.path.split('/').slice(0, -1).join('/') !== destination);
}

function bindExplorerDropTarget(node, destination) {
  node.addEventListener('dragover', (event) => {
    if (!canDropExplorerEntry(event, destination)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    clearExplorerDropTarget();
    node.classList.add('file-drop-target');
  });
  node.addEventListener('dragleave', (event) => {
    if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) node.classList.remove('file-drop-target');
  });
  node.addEventListener('drop', (event) => {
    if (!canDropExplorerEntry(event, destination) || event.dataTransfer.getData(EXPLORER_DRAG_TYPE) !== explorerDrag.id) {
      clearExplorerDropTarget();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const drag = explorerDrag;
    clearExplorerDrag();
    void moveExplorerEntry(drag, destination);
  });
}

function bindFileDrag(row, file) {
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    clearExplorerDrag();
    if (!event.dataTransfer || !appState?.workspace || explorerMovePending || explorerSelection?.selecting || fileOperationBusy({ allowSaving: true })) {
      event.preventDefault();
      return;
    }
    closeFileContextMenu();
    if (!explorerSelection?.has(file.path)) selectFileEntry(file, row);
    const entries = selectedExplorerEntries();
    const rows = [...$('file-tree').querySelectorAll('.file-row')].filter(node => entries.some(entry => entry.path === node.dataset.path));
    explorerDrag = { workspaceId: currentWorkspaceId(), path: file.path, type: file.type, entries, rows, row, id: crypto.randomUUID() };
    event.dataTransfer.setData(EXPLORER_DRAG_TYPE, explorerDrag.id);
    event.dataTransfer.effectAllowed = 'move';
    for (const node of rows) node.classList.add('file-drag-source');
  });
  row.addEventListener('dragend', clearExplorerDrag);
  if (file.type === 'directory') bindExplorerDropTarget(row, file.path);
}

async function moveExplorerEntry(drag, destination) {
  if (explorerMovePending || drag.workspaceId !== currentWorkspaceId() || fileOperationBusy({ allowSaving: true })) return;
  explorerMovePending = true;
  let mutationOwned = false;
  try {
    if (!(await confirmEditorTransition())) return;
    if (drag.workspaceId !== currentWorkspaceId() || fileOperationBusy()) return;
    fileMutationBusy = true;
    mutationOwned = true;
    refreshControlLocks();
    ++editorReadRequest;
    const entries = explorerSelectionRoots(drag.entries || [drag]).filter(entry => entry.path.split('/').slice(0, -1).join('/') !== destination);
    const result = await bridge.fileMove({ ...(entries.length > 1 ? { paths: entries.map(entry => entry.path) } : { path: entries[0].path }), destination });
    if (drag.workspaceId !== currentWorkspaceId()) return;
    const results = result.results || [result];
    for (const item of results) applyExplorerMove(item);
    if (destination) expandedDirectories.add(destination);
    const next = (drag.entries || [drag]).map(entry => {
      const moved = results.find(item => entry.path === item.source || entry.path.startsWith(item.source + '/'));
      return moved ? { ...entry, path: moved.path + entry.path.slice(moved.source.length) } : entry;
    });
    explorerSelection?.set(next);
    selectedRow = null;
    await loadFiles();
    if (result.error) notice(result.error, true);
  } catch (error) {
    if (drag.workspaceId === currentWorkspaceId()) notice(errorText(error), true);
  } finally {
    if (mutationOwned) fileMutationBusy = false;
    explorerMovePending = false;
    refreshControlLocks();
  }
}

function applyExplorerMove(result) {
    if (!result?.source || !result.path) return;
    if (selectedPath && (selectedPath === result.source || selectedPath.startsWith(result.source + '/'))) {
      resetEditorAutosave();
      selectedPath = result.path + selectedPath.slice(result.source.length);
      $('preview-filename').textContent = baseName(selectedPath);
      $('preview-filename').title = selectedPath;
      window.ForgeEditorHighlight?.refresh(selectedPath);
      refreshSelectedFile();
    }
    if (fileClipboard) {
      const remap = path => path === result.source || path.startsWith(result.source + '/') ? result.path + path.slice(result.source.length) : path;
      if (fileClipboard.paths) fileClipboard.paths = fileClipboard.paths.map(remap);
      fileClipboard.path = remap(fileClipboard.path);
    }
    for (const directory of [...expandedDirectories]) {
      if (directory === result.source || directory.startsWith(result.source + '/')) {
        expandedDirectories.delete(directory);
        expandedDirectories.add(result.path + directory.slice(result.source.length));
      }
    }
}

const externalEditorPath = path => typeof path === 'string' && (/^[a-z]:[\\/]/i.test(path) || path.startsWith('/'));

async function openEditorFile() {
  if (editorPickerOpen || fileOperationBusy() || !appState?.workspace) return;
  const workspaceId = currentWorkspaceId();
  editorPickerOpen = true;
  try {
    const file = await bridge.chooseEditorFile();
    if (file?.path && currentWorkspaceId() === workspaceId) await previewFile(file.path);
  } catch (error) { notice(errorText(error), true); }
  finally { editorPickerOpen = false; }
}

async function previewFile(path, row, { allowNavigation = false } = {}) {
  if (fileOperationBusy({ allowNavigation })) return false;
  const workspaceId = currentWorkspaceId();
  const selectionRevision = explorerSelection?.revision;
  if (path === selectedPath) {
    if (!row && !externalEditorPath(path) && !explorerSelection?.has(path)) selectFileEntry({ path, type: 'file', name: baseName(path) }, null);
    if (!editorDirty) refreshSelectedFile(); setPreviewOpen(true); showPreviewTab('file'); return true;
  }
  if (!(await confirmEditorTransition())) return false;
  if (workspaceId !== currentWorkspaceId() || fileOperationBusy({ allowNavigation })) return false;
  const request = ++editorReadRequest;
  try {
    const file = await bridge.fileRead({ path });
    if (request !== editorReadRequest) return false;
    selectedPath = file.path || path;
    resetEditorAutosave();
    if (!row && !externalEditorPath(selectedPath) && explorerSelection?.revision === selectionRevision && !explorerSelection?.has(selectedPath))
      selectFileEntry({ path: selectedPath, name: baseName(selectedPath), type: 'file' }, null);
    $('preview-filename').textContent = externalEditorPath(selectedPath) ? selectedPath : baseName(selectedPath);
    $('preview-filename').title = selectedPath;
    editorVersion = file.version;
    editorOriginal = file.content;
    $('file-content').value = file.content;
    $('file-content').textContent = file.content;
    window.ForgeEditorHighlight?.refresh(selectedPath);
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
  const hiddenProjects = new Set((appState?.hiddenRecentProjects || []).map(workspaceIdentity));
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
    const row = element('div', 'recent-project-row'); row.setAttribute('role', 'none');
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
    row.append(button);
    if (!project.current) {
      const remove = element('button', 'history-delete-button recent-project-delete'); remove.type = 'button';
      remove.dataset.removeProjectPath = project.path; remove.setAttribute('role', 'menuitem');
      remove.setAttribute('aria-label', `从最近项目中移除：${project.name || baseName(project.path)}`); remove.title = '从最近项目中移除';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6'); icon.append(path); remove.append(icon);
      remove.disabled = recentProjectRemoving || projectTransitionBusy() || isChatGPTBusy() || typeof bridge?.removeRecentProject !== 'function';
      remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void removeRecentProject(project.path); });
      row.append(remove);
    }
    return row;
  };
  const values = [...projects.values()].filter(project => project.current || !hiddenProjects.has(workspaceIdentity(project.path)));
  for (const project of values) (project.current ? current : recent).append(projectButton(project));
  $('project-current-section').hidden = !root;
  if (!values.some((project) => !project.current)) recent.append(element('p', 'recent-project-empty', '打开过的项目和历史会话会显示在这里。'));
  $('project-open').disabled = projectTransitionBusy() || isChatGPTBusy();
  $('project-create').disabled = projectTransitionBusy() || isChatGPTBusy();
}

async function removeRecentProject(path) {
  if (recentProjectRemoving || projectTransitionBusy() || isChatGPTBusy()) return;
  recentProjectRemoving = true;
  const workspaceId = currentWorkspaceId();
  renderProjectDropdown(appState?.sessions || []);
  try {
    const state = await bridge.removeRecentProject({ path });
    if (workspaceId === currentWorkspaceId() && state && belongsToCurrentWorkspace(state)) updateState(state);
  } catch (error) { if (workspaceId === currentWorkspaceId()) notice(errorText(error), true); }
  finally {
    recentProjectRemoving = false;
    renderProjectDropdown(appState?.sessions || []);
    if (!$('project-dropdown').hidden) ($('session-list').querySelector('button.recent-project:not(:disabled)') || $('project-open')).focus({ preventScroll: true });
  }
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
  if (explorerSelection) {
    explorerSelection.set(entry ? [entry] : [], { activePath: entry?.path });
    selectedEntry = entry;
    selectedRow = row;
    return;
  }
  selectedRow?.classList.remove('selected');
  selectedEntry = entry;
  selectedRow = row;
  selectedRow?.classList.add('selected');
}

function selectedDirectory() {
  const entries = selectedExplorerEntries();
  if (entries.length > 1) {
    const parents = new Set(entries.map(entry => entry.path.split('/').slice(0, -1).join('/')));
    return parents.size === 1 ? [...parents][0] : '';
  }
  if (!selectedEntry) return '';
  if (selectedEntry.type === 'directory') return selectedEntry.path;
  const path = String(selectedEntry.path);
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator < 0 ? '' : path.slice(0, separator);
}

function selectedExplorerEntries() {
  return explorerSelection ? explorerSelection.entries() : selectedEntry ? [selectedEntry] : [];
}

function explorerSelectionRoots(entries) {
  return entries.filter(entry => !entries.some(parent => parent !== entry && parent.type === 'directory'
    && entry.path.toLowerCase().startsWith(parent.path.toLowerCase() + '/')));
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
    window.ForgeEditorHighlight?.refresh(selectedPath);
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
  const entries = selectedExplorerEntries();
  const sourceArgs = entries.length > 1 ? { paths: entries.map(entry => entry.path) } : { path: entry?.path };
  const directory = selectedDirectory();
  const workspaceId = currentWorkspaceId();
  closeFileContextMenu();
  if (!appState?.workspace || fileOperationBusy()) return;
  if (['open', 'rename', 'reveal'].includes(action) && entries.length > 1) return;
  if (action === 'open' && entry?.type === 'file') return previewFile(entry.path, selectedRow);
  let mutationOwned = false;
  const lock = () => { mutationOwned = true; fileMutationBusy = true; refreshControlLocks(); };
  const unlock = () => { if (mutationOwned) { mutationOwned = false; fileMutationBusy = false; } };
  try {
    if (action === 'reveal' || action === 'copy-path' || action === 'copy-relative-path') {
      if (!entry) return;
      lock();
      if (action === 'reveal') await bridge.fileReveal({ path: entry.path });
      else await bridge.fileCopyPath({ ...sourceArgs, relative: action === 'copy-relative-path' });
      return;
    }
    if (action === 'copy' || action === 'cut') {
      if (!entry) return;
      lock();
      const result = await bridge.fileClipboard({ ...sourceArgs, mode: action });
      if (workspaceId === currentWorkspaceId()) fileClipboard = result;
      return;
    }
    if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
    if (workspaceId !== currentWorkspaceId() || fileOperationBusy()) return;
    const cutting = action === 'paste' && fileClipboard?.mode === 'cut';
    const pasteClipboard = cutting ? structuredClone(fileClipboard) : null;
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
      method = 'fileDelete'; args = sourceArgs;
    } else if (action === 'paste') {
      if (!fileClipboard) return;
      method = 'filePaste'; args = { destination: directory };
    } else return;
    if (workspaceId !== currentWorkspaceId() || fileOperationBusy()) return;
    lock();
    ++editorReadRequest;
    const result = await bridge[method](args);
    if (workspaceId !== currentWorkspaceId() || result?.canceled) return;
    const results = result.results || [result];
    if (cutting) {
      for (const moved of results) applyExplorerMove(moved);
      const completed = results.map(item => item.source);
      const remaining = (pasteClipboard?.paths || [pasteClipboard?.path]).filter(path => path && !completed.some(source => path === source || path.startsWith(source + '/')));
      fileClipboard = remaining.length ? { ...pasteClipboard, path: remaining[0], ...(pasteClipboard?.paths ? { paths: remaining } : {}) } : null;
    }
    if (action === 'delete' && selectedPath && results.some(item => item.path === selectedPath || selectedPath.startsWith(item.path + '/'))) {
      resetEditorAutosave();
      selectedPath = null;
      editorVersion = null;
      editorOriginal = '';
      $('file-content').value = '';
      $('file-content').textContent = '';
      window.ForgeEditorHighlight?.refresh(null);
      setEditorDirty(false);
      showPreviewTab('file');
    } else if (action === 'rename') applyExplorerMove({ ...result, source: entry.path });
    if (action === 'delete') for (const item of results) {
      for (const directory of [...expandedDirectories]) if (directory === item.path || directory.startsWith(item.path + '/')) expandedDirectories.delete(directory);
    }
    explorerSelection?.clear();
    selectedEntry = null;
    selectedRow = null;
    await loadFiles();
    if (workspaceId !== currentWorkspaceId()) return;
    unlock();
    refreshControlLocks();
    if (result.error) notice(result.error, true);
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
  explorerSelection = window.ForgeExplorerSelection.create($('file-tree'), {
    onChange: ({ entries, activePath }) => {
      selectedEntry = entries.find(entry => entry.path === activePath) || entries.at(-1) || null;
      selectedRow = [...$('file-tree').querySelectorAll('.file-row')].find(row => row.dataset.path === selectedEntry?.path) || null;
    },
    onMarquee: () => { clearExplorerDrag(); closeFileContextMenu(); },
  });
  bindExplorerDropTarget($('project-name'), '');
  $('project-name').title = '拖动文件或文件夹到此处可移至项目根目录';
  document.addEventListener('dragend', clearExplorerDrag);
  document.addEventListener('drop', clearExplorerDrag);
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
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
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
  const multiple = selectedExplorerEntries().length > 1;
  for (const action of actions) {
    if (!action) { menu.append(element('div', 'app-menu-separator')); continue; }
    const button = element('button', 'app-menu-item');
    button.type = 'button';
    button.dataset.fileAction = action[0];
    button.setAttribute('role', 'menuitem');
    button.append(element('span', 'app-menu-label', action[1]), element('span', 'app-menu-shortcut', action[2] || ''));
    button.disabled = locked || multiple && ['open', 'reveal', 'rename'].includes(action[0]) || (action[0] === 'open' ? selectedEntry?.type !== 'file' : action[0] === 'reveal' || action[0].startsWith('copy-') ? !selectedEntry : (['cut', 'copy', 'rename', 'delete'].includes(action[0]) && !selectedEntry) || (action[0] === 'paste' && !fileClipboard));
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

function validTaskChangeEdit(edit) {
  return edit && edit.kind !== 'undo' && typeof edit.runId === 'string' && edit.runId && typeof edit.path === 'string' && edit.path
    && ['before', 'after'].every(key => edit[key] === null || typeof edit[key] === 'string');
}

function rememberTaskChange(event) {
  if (taskKind === 'undo' || event.kind === 'undo') return;
  const change = event.fileChange;
  const edit = { runId: event.runId || activeTaskActivity?.runId, toolCallId: event.toolCallId, sequence: event.sequence,
    path: change?.path, before: change?.before, after: change?.after };
  if (!validTaskChangeEdit(edit)) return;
  if (taskChangeEdits.some(value => value.runId === edit.runId && value.toolCallId && value.toolCallId === edit.toolCallId
      && value.path.replace(/\\/g, '/').toLowerCase() === edit.path.replace(/\\/g, '/').toLowerCase()
      && value.before === edit.before && value.after === edit.after)) return;
  taskChangeEdits.push(edit);
  let characters = taskChangeEdits.reduce((total, value) => total + (value.before?.length || 0) + (value.after?.length || 0), 0);
  while (taskChangeEdits.length > 64 || characters > 8 * 1024 * 1024) {
    const oldest = taskChangeEdits.shift(); characters -= (oldest.before?.length || 0) + (oldest.after?.length || 0);
  }
}

function taskChangeControls(entry) {
  const current = entry.sessionId === sessionId && appState?.sessionId === sessionId;
  return { canUndo: current && Array.isArray(appState?.undoableRunIds) && appState.undoableRunIds.includes(entry.runId)
      && typeof bridge?.undoRunChanges === 'function',
    canRedo: current && Array.isArray(appState?.redoableRunIds) && appState.redoableRunIds.includes(entry.runId)
      && typeof bridge?.redoRunChanges === 'function', busy: contextBusy() || editorSaving || isChatGPTBusy() };
}

function refreshTaskChangeControls() {
  if (!window.ForgeTaskChangeSummary) return;
  for (const entry of taskChangeCards.values()) window.ForgeTaskChangeSummary.updateControls(entry.card, taskChangeControls(entry));
}

async function undoTaskChangeSummary(entry, action = 'undo') {
  const redo = action === 'redo', allowed = redo ? 'canRedo' : 'canUndo';
  const label = redo ? '取消撤销' : '撤销';
  const controls = taskChangeControls(entry);
  if (!controls[allowed] || controls.busy) throw new Error(`此任务当前不可${label}。`);
  const workspaceId = currentWorkspaceId(), originalSession = sessionId;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return { status: 'denied', message: `已取消此次${label}操作。` };
  if (workspaceId !== currentWorkspaceId() || originalSession !== sessionId || !taskChangeControls(entry)[allowed] || contextBusy())
    throw new Error('会话状态已变化，请重新确认。');
  taskChangeUndoBusy = true; refreshControlLocks();
  try {
    const response = await bridge[redo ? 'redoRunChanges' : 'undoRunChanges']({ runId: entry.runId });
    let result;
    try { result = typeof response?.result === 'string' ? JSON.parse(response.result) : response?.result; } catch { /* A plain error remains readable. */ }
    const value = result && typeof result === 'object' ? result : { status: 'failed', message: String(response?.result || `${label}未完成。`) };
    const message = typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : value.status === 'completed' ? redo ? '已取消撤销，已恢复本轮修改。' : '已撤销本轮修改。' : `${label}未完成。`;
    if (workspaceId === currentWorkspaceId() && originalSession === sessionId) notice(message, value.status !== 'completed');
    return { status: value.status, message };
  } finally {
    try {
      const next = await bridge.getState();
      if (workspaceId === currentWorkspaceId() && originalSession === sessionId && next?.sessionId === originalSession) updateState(next);
    } catch {
      if (workspaceId === currentWorkspaceId() && originalSession === sessionId)
        appState = { ...appState, undoableRunIds: [], redoableRunIds: [] };
    }
    taskChangeUndoBusy = false; refreshControlLocks();
  }
}

function renderTaskChangeSummary(record, { historical = false } = {}) {
  if (!window.ForgeTaskChangeSummary || record.kind === 'undo' || typeof record.runId !== 'string') return;
  const existing = taskChangeCards.get(record.runId);
  if (existing?.card.isConnected) return existing.card;
  const summary = window.ForgeTaskChangeSummary.aggregate(taskChangeEdits, record.runId, { expectedCount: record.fileChangeCount });
  if (!summary.files.length && !(summary.expectedCount > summary.recordedCount)) return;
  const entry = { runId: record.runId, sessionId, historical, card: null };
  const controls = taskChangeControls(entry);
  entry.card = window.ForgeTaskChangeSummary.create(summary, { ...controls, historical,
    onExpand: node => revealFileDisclosure(node),
    onCopy: text => bridge.copyText({ text }), getControls: () => taskChangeControls(entry),
    onUndo: () => undoTaskChangeSummary(entry), onRedo: () => undoTaskChangeSummary(entry, 'redo') });
  taskChangeCards.set(record.runId, entry);
  $('messages').append(entry.card);
  return entry.card;
}

function renderRoundTokenUsage(record, { unanchored = false } = {}) {
  // Legacy records without trustworthy message boundaries must not attach a
  // usage total to a neighbouring conversation round.
  if (unanchored || !window.ForgeRoundTokenUsage) return;
  const description = window.ForgeRoundTokenUsage.describe(record);
  if (!description) return;
  const existing = [...$('messages').children].find(node => node.classList.contains('round-token-usage') && node.dataset.runId === description.runId);
  if (existing) return existing;
  const badge = window.ForgeRoundTokenUsage.create(record);
  if (badge) $('messages').append(badge);
  return badge;
}

function clearConversation() {
  promptCompletion?.cancel();
  chatSelectionMenu?.close();
  cancelFileDisclosureReveal();
  fileDisclosureScrollPaused = false;
  imageViewSources = [];
  renderedImageViews.clear();
  taskChangeEdits = [];
  taskChangeCards.clear();
  contextCompactionNotices.clear();
  $('messages').replaceChildren();
  renderedUserMessageIds.clear();
  $('welcome').hidden = false;
  $('conversation-title').textContent = conversationTitle();
  $('token-usage').textContent = '';
  renderSessionMetrics(null);
  resetTelemetry();
  streamedMessage = null;
  streamedText = '';
  pendingTools = [];
  commandOutput = null;
  changes = [];
  clearComposerApprovals({ restoreFocus: false });
  renderChanges();
}

async function newSession(options = {}) {
  if (contextBusy() || isChatGPTBusy()) return;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
  promptCompletion?.cancel();
  const workspaceId = currentWorkspaceId();
  try {
    const session = await bridge.newSession(options);
    if (workspaceId !== currentWorkspaceId()) return;
    sessionId = session.id;
    appState = { ...appState, sessionId: session.id, sessionTitle: session.title || '新会话', temporary: session.temporary === true,
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
  promptCompletion?.cancel();
  const request = ++sessionRequest;
  try {
    const session = await bridge.getSession({ id });
    if (request !== sessionRequest) return;
    renderSessionSnapshot(session);
    recordNavigation({ type: 'session', id: session.id, workspace: workspacePath(session.workspace) || workspacePath(appState?.workspace) });
  } catch (error) { notice(errorText(error), true); }
}

function applySessionDeletion(result) {
  const deletedId = result?.deletedId;
  if (!deletedId || !result.state || !belongsToCurrentWorkspace(result.state)) return;
  const selectedWasDeleted = sessionId === deletedId;
  if (selectedWasDeleted) ++sessionRequest;
  navigationEntries = navigationEntries.filter(entry => entry.id !== deletedId && entry.sessionId !== deletedId);
  navigationIndex = Math.min(navigationIndex, navigationEntries.length - 1);
  if (selectedWasDeleted && result.session?.id) sessionId = result.session.id;
  updateState(result.state);
  if (selectedWasDeleted && result.session?.id) renderSessionSnapshot(result.session);
  sessionControls?.remove(deletedId);
  notifyMenuState();
}

async function deleteSessionRecord(id) {
  if (contextBusy() || isChatGPTBusy()) return false;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return false;
  if (contextBusy() || isChatGPTBusy()) return false;
  const workspaceId = currentWorkspaceId();
  const result = await bridge.deleteSession({ id });
  if (workspaceId === currentWorkspaceId()) applySessionDeletion(result);
  return result;
}

function currentCompactionEvent(event = {}) {
  return !event.agentId && running && activeTaskActivity?.status === 'running'
    && (!event.runId || !activeTaskActivity.runId || event.runId === activeTaskActivity.runId);
}

function beginContextCompaction(event = {}) {
  if (!currentCompactionEvent(event)) return;
  contextCompacting = true;
  finishStream();
  const activity = activeTaskActivity;
  if (!activity.compaction) activity.compaction = window.ForgeContextCompaction.createProgress({
    target: activity.events, block: activity.block, runId: activity.runId,
  });
  if (activity.reconnect) renderTaskReconnect(activity);
  else setTaskActivityPhase('compacting', '正在压缩上下文…');
}

function finishContextCompaction(status = 'completed') {
  contextCompacting = false;
  const progress = activeTaskActivity?.compaction;
  if (!progress) return null;
  activeTaskActivity.compaction = null;
  return progress.finish(status);
}

function syncContextCompaction(active) {
  if (active?.running && active.kind === 'agent' && active.compacting === true) beginContextCompaction(active);
  else finishContextCompaction('ended');
}

function appendContextCompactionNotice(event, target = taskProcessTarget(), pendingNote = null) {
  const key = `${event.runId || ''}:${event.count || 0}:${event.throughIndex || 0}:${event.messageIndex || 0}`;
  if (contextCompactionNotices.has(key)) { pendingNote?.remove(); return; }
  contextCompactionNotices.add(key);
  const note = pendingNote || window.ForgeContextCompaction.createNotice();
  note.dataset.count = String(event.count || 1);
  if (event.imageHistoryExceeded === true) {
    note.title = '图片历史达到单次请求上限，旧截图记录已压缩；原始图片仍保留在本地会话。';
  } else if (event.budgetMode === 'model-capacity' && Number.isFinite(event.contextLimit) && Number.isFinite(event.triggerTokens)) {
    const usage = Number.isFinite(event.estimatedBeforeTokens) && Number.isFinite(event.estimatedAfterTokens)
      ? `预算估算：≈${event.estimatedBeforeTokens.toLocaleString()} → ≈${event.estimatedAfterTokens.toLocaleString()} Token。` : '';
    const basis = event.compressionTriggerBasis === 'reported-context-plus-estimated-growth' && Number.isFinite(event.reportedContextTokens)
      ? `服务端实测基准：${event.reportedContextTokens.toLocaleString()} Token；新增内容估计：≈${Number(event.estimatedGrowthTokens || 0).toLocaleString()} Token。`
      : '尚无匹配的实测基准，使用保守预算。';
    note.title = `模型${event.contextLimitKind === 'input' ? '输入上限' : '上下文容量'}：${event.contextLimit.toLocaleString()} Token；自动压缩阈值：${event.triggerTokens.toLocaleString()} Token。${usage}${basis}按当前请求预算触发，不按会话累计消耗触发；完整聊天记录保留。`;
  } else if (Number.isFinite(event.beforeChars) && Number.isFinite(event.afterChars)) {
    note.title = `${event.budgetMode === 'fallback-characters' ? '模型未提供有效容量，使用保守的本地字符阈值。' : ''}发送给模型的上下文：${event.beforeChars.toLocaleString()} → ${event.afterChars.toLocaleString()} 字符；完整聊天记录保留。`;
  }
  if (!pendingNote) target.append(note);
}

function renderSessionSnapshot(session) {
  const metrics = session.sessionMetrics || (appState?.sessionId === session.id ? appState.sessionMetrics : null);
  clearConversation();
  imageViewSources = archivedImageViewSources(session);
  const undoRunIds = new Set([...(Array.isArray(session.taskRuns) ? session.taskRuns : []), ...(Array.isArray(session.events) ? session.events : [])]
    .filter(record => record?.kind === 'undo').map(record => record.runId || record.id));
  taskChangeEdits = Array.isArray(session.fileEdits) ? session.fileEdits
    .filter(edit => validTaskChangeEdit(edit) && !undoRunIds.has(edit.runId)).map(edit => ({ ...edit })) : [];
  sessionId = session.id;
  appState = { ...appState, sessionId: session.id, sessionTitle: session.title || '新会话', sessionMetrics: metrics };
  renderSessionMetrics(metrics);
  sessionControls?.update({ ...appState, sessionId, busy: contextBusy(), authBusy: isChatGPTBusy() });
  if (typeof session.temporary === 'boolean') appState = { ...appState, temporary: session.temporary };
  $('temporary-indicator').hidden = appState?.temporary !== true;
  $('conversation-title').textContent = conversationTitle(session);
  const records = historicalTaskRecords(session);
  const compactions = (session.events || []).filter(event => event.type === 'context-compacted');
  const renderedCompactions = new Set();
  const blocks = window.ForgeTaskHistory.project(session, records);
  const summariesAfter = new Map(), generatedAfter = new Map(), activeGenerated = [];
  const active = appState?.sessionId === session.id && appState?.activeTask?.running ? appState.activeTask : null;
  const activeStart = Number.isInteger(active?.originalMessageStartIndex) ? active.originalMessageStartIndex : active?.messageStartIndex;
  blocks.forEach((block) => {
    const index = block.type === 'message' ? block.index : block.record.messageStartIndex;
    compactions.forEach((event) => {
      if (!renderedCompactions.has(event) && Number.isInteger(event.messageIndex) && event.messageIndex <= index) { appendContextCompactionNotice(event); renderedCompactions.add(event); }
    });
    if (block.type === 'run') {
      const generatedImages = renderHistoricalTaskActivity(block.record, block.items);
      if (generatedImages.length && block.finalIndex !== null && block.finalIndex !== undefined) generatedAfter.set(block.finalIndex, generatedImages);
      else if (generatedImages.length) {
        const generated = addMessage('assistant', '图片已生成。', false, { historical: true });
        generatedImages.forEach(attachments => appendGeneratedImages(generated.message, attachments));
      }
      if (block.finalIndex !== null && Number.isInteger(block.finalIndex)) {
        const waiting = summariesAfter.get(block.finalIndex) || []; waiting.push(block); summariesAfter.set(block.finalIndex, waiting);
      } else {
        renderTaskChangeSummary(block.record, { historical: true });
        renderRoundTokenUsage(block.record, { unanchored: block.unanchored });
      }
    }
    else {
      const message = block.message;
      if (active && Number.isInteger(activeStart) && block.index >= activeStart && message.source === 'generated-image') {
        activeGenerated.push(message); return;
      }
      if (['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && (message.content || messageImageAttachments(message.attachments).length || generatedAfter.has(block.index))) {
        const rendered = addMessage(message.role, message.content, false, { ...message, historical: true });
        for (const attachments of generatedAfter.get(block.index) || []) appendGeneratedImages(rendered.message, attachments);
      }
      for (const run of summariesAfter.get(block.index) || []) {
        renderTaskChangeSummary(run.record, { historical: true });
        renderRoundTokenUsage(run.record, { unanchored: run.unanchored });
      }
    }
  });
  compactions.forEach((event) => { if (!renderedCompactions.has(event)) appendContextCompactionNotice(event); });
  for (const runId of new Set(taskChangeEdits.map(edit => edit.runId))) {
    if (appState?.activeTask?.running && appState.activeTask.runId === runId) continue;
    if (!taskChangeCards.has(runId)) renderTaskChangeSummary(records.find(record => record.runId === runId) || { runId }, { historical: true });
  }
  restoreTaskActivityFromState();
  if (active && activeTaskActivity?.runId === active.runId)
    activeGenerated.forEach(message => rememberGeneratedImage({ runId: active.runId, id: message.id, attachments: message.attachments }));
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
  if (activeTaskActivity?.status === 'running') { activeTaskActivity.lastAssistant = null; activeTaskActivity.lastAssistantConfirmed = false; }
  const tool = createToolCard(event);
  appendGroupedToolCard(taskProcessTarget(), tool, event);
  pendingTools.push(tool);
  moveTaskActivityToEnd();
  scrollBottom();
}

function appendGroupedToolCard(target, tool, event) {
  if (!window.ForgeToolOperationGroups) { target.append(tool.card); return; }
  window.ForgeToolOperationGroups.appendTool(target, tool.card, xmlFileTool(event.name, event.args) ? { ...event, name: 'read_file' } : event, {
    onGroup: group => { bindFileDisclosureVisibility(group, group.querySelector(':scope > summary')); fitFileDisclosure(group, $('message-scroll')); },
  });
}

function refreshGroupedToolCard(tool) {
  window.ForgeToolOperationGroups?.refresh(tool.card);
}

function createToolCard(event) {
  const card = element('details', 'tool-card running');
  const summary = element('summary', 'tool-summary');
  const badge = element('span', 'tool-badge', '执行中');
  const title = element('span', 'tool-title', toolActivity(event.name, event.args));
  title.title = event.name || '工具调用';
  const id = xmlFileTool(event.name, event.args) ? 'read_file' : String(event.name || '').replace(/（模拟）/g, '');
  const mark = element('span', 'tool-mark');
  mark.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', id === 'run_command' ? 'M3 4h18v16H3V4Z M7 8l4 4-4 4 M14 16h3'
    : /^(write_file|replace_in_file|undo_last_change)$/.test(id) ? 'm4 16-1 5 5-1L21 7l-4-4L4 16Z M14 6l4 4'
    : /screenshot|image/.test(id) ? 'M5 3H2v15 M5 7h17v14H5V7Z M5 18l5-5 5 5 3-3 4 4 M17 10h1'
    : /^search_/.test(id) ? 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'
    : /^browser_/.test(id) ? 'M3 4h18v16H3V4Z M3 9h18 M6 6h1 M10 6h1'
    : 'M14 3H5v18h14V8l-5-5Z M14 3v5h5 M8 12h8 M8 16h6');
  svg.append(path); mark.append(svg);
  summary.append(mark, title, badge);
  const details = element('div', 'tool-details');
  const technical = element('div', 'tool-technical-details');
  const commandView = id === 'run_command' && window.ForgeCommandResult ? window.ForgeCommandResult.create(event.args) : null;
  technical.append(element('div', 'tool-label', '输入参数'), toolPayload(event.args));
  if (commandView) details.append(commandView);
  details.append(technical);
  card.append(summary, details);
  bindFileDisclosureVisibility(card, summary);
  return { name: event.name, args: event.args, toolCallId: event.toolCallId, runId: event.runId, card, details, technical, commandView, badge, title };
}

function completeTool(event, { tools = pendingTools, updateActivity = true } = {}) {
  const index = tools.findIndex(tool => event.toolCallId ? tool.toolCallId === event.toolCallId : tool.name === event.name);
  const tool = index >= 0 ? tools.splice(index, 1)[0] : null;
  if (!tool) return;
  let result = event.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Human-readable failures stay in the original tool detail. */ } }
  const denied = result?.denied === true || result?.canceled === true || (typeof result === 'string' && /^操作已停止，未执行/.test(result));
  // Loading pixels is not a view receipt. Hide only the successful local read
  // row; an images-viewed card is emitted separately after the model receives
  // the image, while failed/denied reads remain visible for diagnosis.
  if (String(event.name || '').replace(/（模拟）/g, '') === 'view_image' && result?.status === 'loaded' && !denied) {
    tool.card.remove();
    if (updateActivity) setTaskActivityPhase('waiting', '等待模型');
    return;
  }
  const command = String(event.name || '').replace(/（模拟）/g, '') === 'run_command';
  if (command && result?.outputTruncated === true && typeof result.output === 'string' && tool.commandOutput) {
    tool.commandOutput.textContent = result.output;
    tool.commandOutput.scrollTop = tool.commandOutput.scrollHeight;
  }
  const commandResult = command && window.ForgeCommandResult ? window.ForgeCommandResult.describe(tool.args, event.result) : null;
  const failed = result?.error || (typeof result === 'string' && /^(?:错误|工具执行失败|Error)/i.test(result))
    || (commandResult ? ['failed', 'timeout', 'output-limit'].includes(commandResult.status)
      : command && Number.isFinite(result?.exitCode) && result.exitCode !== 0 && !result?.terminated);
  tool.card.classList.remove('running');
  tool.card.dataset.status = denied ? 'denied' : failed ? 'failed' : 'completed';
  tool.badge.textContent = denied ? '未执行' : failed ? '未完成' : '已返回';
  tool.title.textContent = denied ? command ? '命令未执行' : '操作未执行'
    : failed ? command ? '命令执行失败' : '操作未完成'
    : toolActivity(event.name, tool.args, true);
  if (commandResult) {
    const view = window.ForgeCommandResult.create(tool.args, event.result);
    if (tool.commandView) tool.commandView.replaceWith(view);
    else tool.details.prepend(view);
    tool.commandView = view;
    if (['cancelled', 'stopped'].includes(commandResult.status)) {
      tool.card.dataset.status = 'stopped';
      tool.title.textContent = commandResult.label;
      tool.badge.textContent = '已停止';
    } else if (commandResult.status === 'unknown') {
      tool.title.textContent = '命令已返回';
      tool.badge.textContent = '待确认';
    } else if (['timeout', 'output-limit'].includes(commandResult.status)) tool.title.textContent = commandResult.label;
  }
  const edit = event.fileChange;
  const hasEdit = !denied && !failed && edit && typeof edit.path === 'string' && edit.path
    && ['before', 'after'].every(key => edit[key] === null || typeof edit[key] === 'string');
  if (hasEdit && window.ForgeCodeDiff) {
    tool.card.classList.add('file-edit-card');
    tool.title.textContent = '已编辑的文件';
    tool.badge.textContent = edit.after === null ? '已删除' : '已保存';
    tool.details.classList.add('file-edit-details');
    const diff = window.ForgeCodeDiff.create(edit, { onCopy: async text => {
      try { await bridge.copyText({ text }); }
      catch (error) { notice(errorText(error), true); throw error; }
    } });
    const brief = element('span', 'tool-edit-summary');
    const filename = element('span', 'tool-edit-filename', baseName(edit.path));
    filename.title = edit.path;
    brief.append(filename);
    for (const [className, selector] of [['tool-edit-added', '.code-diff-added'], ['tool-edit-removed', '.code-diff-removed']]) {
      const source = diff.querySelector(selector);
      const count = element('span', className, source.textContent);
      count.setAttribute('aria-label', source.getAttribute('aria-label'));
      brief.append(count);
    }
    if (diff.dataset.exact === 'false') brief.title = '改动较大或文件过大，展开查看统计说明。';
    tool.title.after(brief);
    const raw = tool.technical;
    raw.classList.add('code-diff-raw');
    raw.append(element('div', 'tool-label', '执行结果'), toolPayload(event.result, tool.args?.path));
    tool.details.replaceChildren(diff, raw);
    tool.card.open = false;
  } else tool.technical.append(element('div', 'tool-label', '执行结果'), toolPayload(event.result, tool.args?.path));
  const status = commandResult ? commandResult.label : denied ? command ? '命令未执行' : '操作未执行'
    : failed ? '工具未完成，继续处理'
    : command && result?.terminated ? '命令已停止'
    : command && Number.isFinite(result?.exitCode) && result.exitCode !== 0 ? `命令已结束 · 退出代码 ${result.exitCode}`
    : toolActivity(event.name, tool.args, true);
  if (updateActivity) { setTaskActivityPhase('tool', status); scrollBottom(); }
  refreshGroupedToolCard(tool);
}

function finishToolWithoutResult(tool) {
  tool.card.classList.remove('running');
  tool.card.dataset.status = 'unknown';
  tool.badge.textContent = '未返回结果';
  refreshGroupedToolCard(tool);
  if (tool.commandView) {
    tool.title.textContent = '命令结果未返回';
    tool.commandView.dataset.status = 'unknown';
    tool.commandView.querySelector('.command-result-status').textContent = '任务已结束，未收到命令结果';
  }
}

function renderComposerApproval({ focus = false, restoreFocus = true } = {}) {
  const slot = $('composer-approval');
  if (!slot) return;
  const pending = [...approvals.values()].filter(entry => entry.workspaceId === currentWorkspaceId());
  const current = pending[0];
  const wasVisible = !slot.hidden;
  $('task-form').hidden = !!current;
  $('task-form').inert = !!current;
  const controls = document.querySelector('.composer-context');
  const liveSlot = $('approval-live-controls');
  if (liveSlot && controls) {
    liveSlot.hidden = !current;
    if (current && controls.parentElement !== liveSlot) liveSlot.append(controls);
    else if (!current && controls.parentElement === liveSlot) document.querySelector('.composer-toolbar').prepend(controls);
  }
  slot.hidden = !current;
  if (current) {
    if (slot.firstElementChild !== current.card) slot.replaceChildren(current.card);
    current.count.textContent = pending.length > 1 ? `待批准 ${pending.length} 项` : '需要你的批准';
    current.stop.hidden = !(running || terminalRunning);
    if (focus && !restoringWorkspace && !approvalOverlayOpen()) current.card.focus({ preventScroll: true });
  } else {
    slot.replaceChildren();
    if (wasVisible && restoreFocus && composerApprovalFocus?.workspaceId === currentWorkspaceId()) {
      const saved = composerApprovalFocus;
      const target = saved.node?.isConnected && !saved.node.disabled && !saved.node.closest('[hidden]') ? saved.node : $('task-input');
      if (!target.disabled) {
        target.focus({ preventScroll: true });
        if (target === $('task-input') && Number.isInteger(saved.start)) target.setSelectionRange(saved.start, saved.end);
      }
    }
    composerApprovalFocus = null;
  }
}

function clearComposerApprovals({ restoreFocus = true } = {}) {
  ++composerApprovalEpoch;
  for (const entry of approvals.values()) {
    entry.reject.disabled = true; entry.accept.disabled = true;
    entry.stop.disabled = true;
  }
  approvals.clear();
  renderComposerApproval({ restoreFocus });
}

function resolveComposerApproval(id, approved, { expired = false } = {}) {
  const entry = approvals.get(id);
  if (!entry || entry.workspaceId !== currentWorkspaceId()) return;
  entry.reject.disabled = true; entry.accept.disabled = true; entry.stop.disabled = true;
  approvals.delete(id);
  const change = changes.find(value => value.id === id);
  if (change) { change.status = expired ? '请求已失效 · 未批准' : approved ? '已批准 · 请查看工具执行结果' : '已拒绝'; renderChanges(); }
  if (running) setTaskActivityPhase(approved && !expired ? 'tool' : 'waiting', expired ? '批准请求已失效' : approved ? entry.event.kind === 'command' ? '正在运行命令' : entry.event.kind === 'browser' ? '正在操作浏览器' : '正在写入文件' : '操作已拒绝，等待模型');
  renderComposerApproval({ focus: true });
  $('run-status').textContent = approvals.size ? '等待你的确认' : running ? '任务进行中' : terminalRunning ? '终端执行中' : '准备就绪';
}

function syncComposerApprovals(pending) {
  const entries = Array.isArray(pending) ? pending.filter(event => event && typeof event.id === 'string' && event.reviewStatus !== 'reviewing' && belongsToCurrentWorkspace(event)) : [];
  const retained = new Set(entries.map(event => event.id));
  for (const [id, entry] of approvals) if (entry.workspaceId !== currentWorkspaceId() || !retained.has(id)) {
    entry.accept.disabled = true; entry.reject.disabled = true; entry.stop.disabled = true; approvals.delete(id);
  }
  for (const event of entries) if (!approvals.has(event.id)) approvalRequest(event);
  renderComposerApproval();
}

function approvalOverlayOpen() {
  return !!document.querySelector('dialog[open]') || ['app-menu-popup', 'app-menu-submenu', 'file-context-menu', 'chat-selection-menu', 'permission-popup', 'reasoning-popup', 'project-dropdown', 'session-dropdown'].some(id => $(id) && !$(id).hidden);
}

function approvalRequest(event) {
  if (!event || typeof event.id !== 'string' || !event.id || !belongsToCurrentWorkspace(event) || approvals.has(event.id)) return;
  const workspaceId = currentWorkspaceId();
  const epoch = composerApprovalEpoch;
  if (!approvals.size) composerApprovalFocus = { workspaceId, node: document.activeElement, start: $('task-input').selectionStart, end: $('task-input').selectionEnd };
  finishStream();
  closeReasoningPopup();
  const card = element('article', 'approval-card composer-approval-card');
  card.tabIndex = -1;
  card.dataset.approvalId = event.id;
  const header = element('div', 'approval-header');
  const type = event.kind === 'command' ? '终端' : event.kind === 'browser' ? '浏览器' : '编辑文件';
  const count = element('span', 'composer-approval-count');
  const title = element('h2', 'composer-approval-title', event.title || (event.kind === 'command' ? '允许运行这条命令吗？' : event.kind === 'browser' ? '允许执行这次网页操作吗？' : '允许修改这个文件吗？'));
  header.append(element('span', 'approval-icon', '◇'), title, count);
  const body = element('div', 'approval-body');
  body.id = `composer-approval-body-${++composerApprovalSequence}`;
  body.tabIndex = 0;
  body.setAttribute('aria-label', '待批准的操作详情，可展开和滚动查看完整内容');
  body.append(element('div', 'approval-detail', event.detail || '请查看操作详情，再决定是否允许本次操作。'));
  if (event.path) body.append(element('div', 'approval-path', `${event.kind === 'command' ? '执行目录' : '文件路径'}：${event.path}`));
  if (event.kind === 'command' || event.kind === 'browser') body.append(element('pre', 'approval-command', event.kind === 'command' ? event.command || '（未提供命令）' : [event.url, event.selector, event.action].filter(Boolean).join('\n')));
  else {
    body.append(element('p', 'composer-approval-proposal', '待批准的修改 · 尚未写入文件'));
    if (window.ForgeCodeDiff?.create && (event.before === null || typeof event.before === 'string') && (event.after === null || typeof event.after === 'string')) body.append(window.ForgeCodeDiff.create(event));
    const full = element('details', 'composer-approval-full');
    full.append(element('summary', '', '查看完整修改前后内容'));
    const diff = element('div', 'approval-diff');
    diff.append(diffSide('修改前 · 完整内容', event.before, 'before'), diffSide('修改后 · 完整内容', event.after, 'after'));
    full.append(diff); body.append(full);
    changes.push({ ...event, status: '等待确认' });
    renderChanges();
  }
  const expand = element('button', 'composer-approval-expand', '展开');
  expand.type = 'button';
  expand.setAttribute('aria-controls', body.id);
  expand.setAttribute('aria-expanded', 'false');
  expand.addEventListener('click', () => {
    const expanded = card.classList.toggle('is-expanded');
    expand.textContent = expanded ? '收起' : '展开';
    expand.setAttribute('aria-expanded', String(expanded));
  });
  const preview = element('div', 'composer-approval-preview');
  preview.append(body, expand);
  const actions = element('div', 'approval-actions');
  const status = element('span', 'composer-approval-status', event.reviewReason || (appState?.permissionMode === 'assist'
    ? 'AI 无法自动批准此操作，请你决定是否继续。' : '由你决定是否继续'));
  status.setAttribute('role', 'status');
  const stop = element('button', 'button composer-approval-stop', '停止任务');
  const reject = element('button', 'button approval-reject');
  const accept = element('button', 'button approval-accept');
  for (const button of [stop, reject, accept]) button.type = 'button';
  reject.append(document.createTextNode('拒绝 '), element('kbd', '', 'Esc'));
  accept.append(document.createTextNode(event.kind === 'command' ? '允许执行 ' : event.kind === 'browser' ? '允许操作 ' : '允许写入 '), element('kbd', '', '↵'));
  accept.disabled = event.kind === 'command' && !event.command;
  const entry = { event, workspaceId, epoch, card, count, actions, status, stop, reject, accept, submitting: false };
  const current = () => workspaceId === currentWorkspaceId() && epoch === composerApprovalEpoch && approvals.get(event.id) === entry && $('composer-approval').firstElementChild === card;
  const respond = async approved => {
    if (!current() || entry.submitting || (approved && event.kind === 'command' && !event.command)) return;
    entry.submitting = true; reject.disabled = true; accept.disabled = true; stop.disabled = true;
    status.textContent = '正在提交…';
    status.classList.remove('error');
    try {
      const accepted = await bridge.respondApproval({ id: event.id, approved });
      if (!current()) return;
      resolveComposerApproval(event.id, approved, { expired: accepted === false });
    } catch (error) {
      if (!current()) return;
      entry.submitting = false; reject.disabled = false; accept.disabled = event.kind === 'command' && !event.command; stop.disabled = false;
      status.textContent = errorText(error);
      status.classList.add('error');
    }
  };
  reject.addEventListener('click', () => respond(false));
  accept.addEventListener('click', () => respond(true));
  stop.addEventListener('click', async () => {
    if (!current() || entry.submitting) return;
    entry.submitting = true; reject.disabled = true; accept.disabled = true; stop.disabled = true;
    status.textContent = '正在停止…';
    try {
      await (terminalRunning ? bridge.stopTerminal() : bridge.stopTask());
      if (current()) clearComposerApprovals();
    } catch (error) {
      if (!current()) return;
      entry.submitting = false; reject.disabled = false; accept.disabled = event.kind === 'command' && !event.command; stop.disabled = false;
      status.textContent = errorText(error); status.classList.add('error');
    }
  });
  card.addEventListener('keydown', keyboard => {
    if (!current() || !card.contains(document.activeElement) || keyboard.defaultPrevented || keyboard.repeat || keyboard.isComposing || keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey || keyboard.shiftKey || approvalOverlayOpen()) return;
    if (keyboard.key === 'Escape') { keyboard.preventDefault(); keyboard.stopPropagation(); respond(false); }
    else if (keyboard.key === 'Enter' && !keyboard.target.closest('button,summary,a,input,textarea,select,[contenteditable]')) { keyboard.preventDefault(); keyboard.stopPropagation(); respond(true); }
  });
  actions.append(status, stop, reject, accept);
  card.append(header, preview, actions);
  approvals.set(event.id, entry);
  renderComposerApproval({ focus: true });
  updateTelemetry({ phase: 'approval', tokensPerSecond: null });
  if (running) setTaskActivityPhase('approval', `等待确认：${type}`);
  else $('run-status').textContent = '等待你的确认';
}

async function runTask(demo = false, mode = 'queue') {
  promptCompletion?.cancel();
  if (approvals.size || !$('composer-approval').hidden) return;
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
  if (!demo && !account && !savedConnectionReady(provider, currentAuthMode(settings))) {
    notice(currentAuthMode(settings) === 'gemini-account' ? '请先连接 Gemini 的 Google 账号，再发送任务。'
      : ['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(currentAuthMode(settings)) ? '请先连接官方代理账号，再发送任务。' : '请先配置当前服务商的 API Key，再发送任务。');
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
    case 'side-chat':
      sideChatControls?.apply(event.sideChat, event.workspaceId);
      break;
    case 'context-compaction-start':
      beginContextCompaction(event);
      scrollBottom();
      break;
    case 'context-compacted':
      if (!currentCompactionEvent(event)) break;
      appendContextCompactionNotice(event, taskProcessTarget(), finishContextCompaction());
      moveTaskActivityToEnd();
      setTaskActivityPhase('waiting', '等待模型继续');
      scrollBottom();
      break;
    case 'context-compaction-end':
      if (!currentCompactionEvent(event)) break;
      finishContextCompaction(['failed', 'stopped', 'cancelled'].includes(event.status) ? event.status : 'ended');
      if (!activeTaskActivity?.reconnect) setTaskActivityPhase('waiting', '等待模型继续');
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
      if (typeof event.id === 'string' && !imageViewSources.some(message => message.id === event.id))
        imageViewSources.push({ role: 'user', id: event.id, attachments: event.attachments || [] });
      followOutput = true;
      commandOutput = null;
      if (typeof event.text === 'string' && (!event.id || !renderedUserMessageIds.has(event.id))) {
        finishStream();
        addMessage('user', event.text, false, { id: event.id, source: event.source, runId: event.runId, createdAt: event.createdAt, attachments: event.attachments });
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
    case 'session-deleted': applySessionDeletion(event); break;
    case 'session-metrics':
      if (!event.sessionId || event.sessionId === appState?.sessionId) {
        appState = { ...appState, sessionMetrics: event.metrics };
        renderSessionMetrics(event.metrics);
      }
      break;
    case 'session':
      if (event.session) imageViewSources = archivedImageViewSources(event.session);
      if (event.session?.id && event.session.id !== sessionId) renderSessionSnapshot(event.session);
      if (event.session?.id) sessionId = event.session.id;
      if (event.session) {
        appState = { ...appState, sessionId, sessionTitle: event.session.title || '新会话' };
        $('conversation-title').textContent = conversationTitle(event.session);
        sessionControls?.update({ ...appState, sessionId, busy: contextBusy(), authBusy: isChatGPTBusy() });
      }
      renderSessions(appState?.sessions || []);
      break;
    case 'run-start':
      if (!restoringWorkspace) promptCompletion?.startRound({ runId: event.runId, sessionId, workspaceId: currentWorkspaceId(), kind: event.kind || 'agent', demo: event.demo === true });
      contextCompacting = false;
      taskKind = event.kind || 'agent'; taskDemo = event.demo === true;
      setRunning(true, event);
      if (event.kind === 'undo') break;
      beginTaskActivity(event);
      setTaskActivityPhase(event.kind === 'undo' ? 'tool' : 'waiting', event.kind === 'undo' ? '正在撤销文件修改' : event.demo ? '正在演示任务流程' : '等待模型');
      scrollBottom();
      break;
    case 'telemetry': updateTelemetry(event); break;
    case 'reconnect': handleReconnect(event); break;
    case 'text-delta':
      clearTaskReconnect();
      setTaskActivityPhase('generating', '正在生成');
      if (!streamedMessage) { streamedText = ''; streamedMessage = addMessage('assistant', '', true); }
      streamedText = event.replace ? (event.text || '') : streamedText + (event.text || '');
      renderText(streamedMessage.body, streamedText);
      scrollBottom();
      break;
    case 'assistant-message': {
      const response = finishStream(event.text || '');
      if (activeTaskActivity?.status === 'running') {
        activeTaskActivity.lastAssistant = response?.message || null;
        activeTaskActivity.lastAssistantConfirmed = !!response && !(event.toolCallCount > 0);
      }
      moveTaskActivityToEnd(); scrollBottom(); break;
    }
    case 'tool-start': if (taskKind !== 'undo') addTool(event); break;
    case 'tool-result': rememberTaskChange(event); if (taskKind !== 'undo') completeTool(event); break;
    case 'file-change-recorded': rememberTaskChange(event); break;
    case 'images-viewed': renderImageViewed(event); break;
    case 'image-generated':
      rememberGeneratedImage(event);
      break;
    case 'question-answer':
      if (renderQuestionAnswer(event)) { moveTaskActivityToEnd(); scrollBottom(); }
      break;
    case 'subagent-update':
      renderSubagentUpdate(event);
      moveTaskActivityToEnd(); scrollBottom(); break;
    case 'approval-review':
      if (taskKind === 'undo') {
        if (event.status === 'reviewing' && approvals.has(event.id)) resolveComposerApproval(event.id, false, { expired: true });
        break;
      }
      renderApprovalReview(event);
      moveTaskActivityToEnd(); scrollBottom(); break;
    case 'approval-request': approvalRequest(event); break;
    case 'approval-resolved': {
      resolveComposerApproval(event.id, event.approved === true);
      break;
    }
    case 'command-output':
      commandOutput = commandOutputForEvent(event, pendingTools, taskProcessTarget(), commandOutput);
      if (event.replace) commandOutput.textContent = event.text || '';
      else commandOutput.append(document.createTextNode(event.text || ''));
      commandOutput.scrollTop = commandOutput.scrollHeight;
      moveTaskActivityToEnd();
      scrollBottom();
      break;
    case 'storage-error': notice(`本机保存失败：${event.error || '未知错误'}`, true); break;
    case 'extension-notice': notice(event.message || '插件消息'); break;
    case 'usage':
      $('token-usage').textContent = `本次输入 ${(event.inputTokens || 0).toLocaleString()} / 输出 ${(event.outputTokens || 0).toLocaleString()} Token`;
      break;
    case 'run-end': {
      contextCompacting = false;
      const changeOperation = event.kind === 'undo' || taskKind === 'undo';
      const usageRecord = { ...event, kind: event.kind || taskKind, demo: event.demo === true || taskDemo };
      if (!changeOperation) {
        finishStream();
        moveTaskActivityToEnd();
        finishTaskActivity(event);
      }
      setRunning(false);
      if (!changeOperation) {
        const failed = event.status === 'failed';
        const errorDetail = failed ? String(event.error || '发生错误') : '';
        const briefError = errorDetail.split(/\r?\n/, 1)[0].slice(0, 180);
        const text = failed ? `任务未完成：${briefError}` : event.status === 'stopped' ? '任务已停止' : '任务已完成';
        $('run-status').textContent = failed ? '任务失败' : event.status === 'stopped' ? '已停止' : '已完成';
        const result = element('div', `run-result${failed ? ' failed' : ''}`, `${failed ? '×' : '✓'} ${text}`);
        if (failed && errorDetail !== briefError) {
          const details = element('details', 'tool-technical-details run-error-details');
          details.append(element('summary', 'technical-details-summary', '查看错误详情'), element('pre', '', errorDetail));
          result.append(details);
        }
        $('messages').append(result);
        renderTaskChangeSummary(event);
        renderRoundTokenUsage(usageRecord);
      }
      clearComposerApprovals();
      pendingTools.forEach(finishToolWithoutResult);
      pendingTools = [];
      changes.forEach((change) => { if (change.status === '等待确认') change.status = '任务结束 · 未批准'; });
      renderChanges();
      scrollBottom();
      const version = taskStateVersion;
      const queueVersion = promptQueueVersion;
      if (!changeOperation && !restoringWorkspace) void promptCompletion?.suggestAfterRound({ runId: event.runId, sessionId,
        workspaceId: currentWorkspaceId(), status: event.status });
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
      window.ForgeEditorHighlight?.refresh(selectedPath);
      editorOriginal = file.content;
      editorVersion = file.version;
      $('editor-status').textContent = '自动保存已开启 · UTF-8';
    }
  }).catch(() => {});
}

function fillProvider(provider) {
  invalidateSettingsCatalog();
  const settings = modelSettingsConfig();
  const config = settings.providers?.[provider] || {};
  const current = settings.provider === provider;
  $('openai-auth-mode').value = provider === 'openai' && (config.authMode || (current ? settings.authMode : '')) === 'chatgpt' ? 'chatgpt' : 'apiKey';
  window.synoraDeepSeekLogin?.fill(provider === 'deepseek' && (config.authMode || (current ? settings.authMode : '')) === 'deepseek-account' ? 'deepseek-account' : 'apiKey');
  const geminiMode = provider === 'gemini' ? config.authMode || (current ? settings.authMode : '') : 'apiKey';
  window.synoraGeminiLogin?.fill(['gemini-account', 'antigravity-agent'].includes(geminiMode) ? geminiMode : 'apiKey');
  window.synoraAntigravityLogin?.clearError();
  window.synoraKimiAgentLogin?.fill(provider === 'kimi' ? config.authMode || (current ? settings.authMode : '') : 'apiKey', config.region);
  window.synoraGlmAgentLogin?.fill(provider === 'glm' ? config.authMode || (current ? settings.authMode : '') : 'apiKey', config.region);
  window.synoraClaudeAgentLogin?.fill(provider === 'anthropic' ? config.authMode || (current ? settings.authMode : '') : 'apiKey');
  window.synoraArkLogin?.fill(provider === 'doubao' ? config.authMode || (current ? settings.authMode : '') : 'apiKey');
  $('api-protocol-select').value = config.apiProtocol || (['relay','doubao'].includes(provider) ? 'chat-completions' : 'responses');
  $('base-url-input').value = config.baseUrl || (current ? settings.baseUrl : '') || (provider === 'ollama' ? 'http://localhost:11434'
    : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : provider === 'kimi' ? 'https://api.moonshot.cn/v1'
      : provider === 'glm' ? 'https://open.bigmodel.cn/api/paas/v4' : provider === 'doubao' ? 'https://ark.cn-beijing.volces.com/api/v3' : '');
  $('ollama-context-window-input').value = String(config.contextWindowTokens ?? 32768);
  $('api-key-input').value = '';
  $('api-key-input').disabled = false;
  $('api-key-input').placeholder = config.hasKey ? '已保存密钥，留空以保留' : provider === 'ollama' ? '本机服务留空，反向代理需要时填写' : '输入 API Key';
  $('key-status').textContent = config.hasKey ? '已在本机保存' : provider === 'ollama' ? '无需配置' : '未配置';
  $('key-status').classList.toggle('saved', !!config.hasKey);
  $('settings-error').hidden = true;
  chatgptLocalError = '';
  renderChatGPTState();
}

function openSettings(role = null) {
  if (contextBusy() || isChatGPTBusy()) return;
  settingsRole = window.ForgeRoleModels.roleInfo(role) ? role : null;
  $('settings-dialog').classList.toggle('role-model-settings', !!settingsRole);
  closeReasoningPopup();
  ++catalogRequest;
  catalogLoading = false;
  const provider = modelSettingsConfig().provider || 'openai';
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
    const role = settingsRole;
    const state = await modelSettingsAction('save', input);
    updateState(state);
    $('api-key-input').value = '';
    $('settings-dialog').close();
    notice(role ? `${window.ForgeRoleModels.roleInfo(role).name}独立模型配置已保存。` : '模型配置已保存。发送任务时将使用所选模型。');
  } catch (error) { $('settings-error').textContent = errorText(error); $('settings-error').hidden = false; }
  finally { settingsSaving = false; renderChatGPTState(); }
}

async function undoChange() {
  if (contextBusy() || isChatGPTBusy() || !appState?.workspace) return;
  if ((editorDirty || editorSavePromise) && !(await confirmEditorTransition())) return;
  const workspaceId = currentWorkspaceId();
  $('undo-change').disabled = true;
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
  $('model-open-settings').addEventListener('click', () => openSettings());
  $('reasoning-open-settings').addEventListener('click', () => openSettings());
  $('settings-model-refresh').addEventListener('click', () => fetchSettingsCatalog(true));
  $('settings-dialog').addEventListener('close', () => {
    if ($('settings-dialog').open) return;
    invalidateSettingsCatalog(); $('api-key-input').value = ''; settingsRole = null; chatgptLocalError = ''; window.synoraDeepSeekLogin?.clearError(); window.synoraGeminiLogin?.clearError(); window.synoraAntigravityLogin?.clearError(); window.synoraKimiAgentLogin?.clearError(); window.synoraGlmAgentLogin?.clearError(); window.synoraClaudeAgentLogin?.clearError(); window.synoraArkLogin?.clearError(); ++catalogRequest; catalogLoading = false;
  });
  $('settings-role-reset').addEventListener('click', async () => {
    const role = settingsRole;
    if (!role || contextBusy() || settingsSaving || isChatGPTBusy()) return;
    settingsSaving = true; refreshControlLocks();
    try { updateState(await bridge.resetRoleModel({ role })); $('api-key-input').value = ''; $('settings-dialog').close(); notice(`${window.ForgeRoleModels.roleInfo(role).name}已恢复跟随主模型。`); }
    catch (error) { $('settings-error').textContent = errorText(error); $('settings-error').hidden = false; }
    finally { settingsSaving = false; renderChatGPTState(); }
  });
  $('close-settings').addEventListener('click', () => { if (isChatGPTBusy() || settingsSaving) return; $('api-key-input').value = ''; $('settings-dialog').close(); });
  $('settings-dialog').addEventListener('cancel', (event) => { if (isChatGPTBusy() || settingsSaving) { event.preventDefault(); return; } $('api-key-input').value = ''; });
  $('provider-select').addEventListener('change', (event) => fillProvider(event.target.value));
  $('provider-account-open').addEventListener('click', openProviderAccount);
  $('api-protocol-select').addEventListener('change', () => { invalidateSettingsCatalog(); syncAuthModeVisibility(); renderSettingsCatalog(); $('settings-error').hidden = true; refreshControlLocks(); });
  $('openai-auth-mode').addEventListener('change', () => {
    invalidateSettingsCatalog();
    $('api-key-input').value = '';
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
    if (id) runChatGPTAction('profile', () => modelSettingsAction('profile', { id }));
  });
  $('chatgpt-disconnect').addEventListener('click', () => runChatGPTAction('disconnect', () => modelSettingsAction('disconnect')));
  $('chatgpt-refresh-models').addEventListener('click', refreshChatGPTModels);
  $('chatgpt-open-usage').addEventListener('click', () => runChatGPTAction('usage', () => modelSettingsAction('usage')));
  $('chatgpt-model-select').addEventListener('change', () => {
    $('settings-error').hidden = true;
    refreshControlLocks();
  });
  ['base-url-input', 'api-key-input', 'ollama-context-window-input'].forEach((id) => $(id).addEventListener('input', () => {
    invalidateSettingsCatalog();
    renderSettingsCatalog();
    refreshControlLocks();
  }));
  $('reasoning-effort').addEventListener('input', () => { if (!$('reasoning-effort').disabled && !modelControlBusy() && !reasoningSaving) updateReasoningControl($('reasoning-effort'), true); });
  $('reasoning-effort').addEventListener('change', () => {
    if ($('reasoning-effort').disabled || modelControlBusy() || reasoningSaving) return;
    updateReasoningControl($('reasoning-effort'), true);
    setReasoningEffort();
  });
  $('reasoning-default').addEventListener('click', () => {
    if ($('reasoning-default').disabled || modelControlBusy() || reasoningSaving) return;
    fillReasoningOptions($('reasoning-effort'), appState?.settings?.provider || 'openai', 'default');
    setReasoningEffort();
  });
  $('settings-form').addEventListener('submit', saveSettings);
  $('task-form').addEventListener('submit', (event) => { event.preventDefault(); runTask(); });
  $('resume-pending').addEventListener('click', resumePendingPrompts);
  $('pending-edit-form').addEventListener('submit', savePendingPromptEdit);
  $('pending-edit-input').addEventListener('input', () => { $('pending-edit-error').textContent = ''; renderPendingPromptEditState(); });
  for (const id of ['pending-edit-close', 'pending-edit-cancel']) $(id).addEventListener('click', () => { if (!pendingPromptEditSaving) $('pending-edit-dialog').close(); });
  $('pending-edit-dialog').addEventListener('cancel', event => { if (pendingPromptEditSaving) event.preventDefault(); });
  $('pending-edit-dialog').addEventListener('close', () => {
    if ($('pending-edit-dialog').open) return; // A queued close can arrive after a quick reopen.
    pendingPromptEdit = null; $('pending-edit-input').value = '';
  });
  $('stop-button').addEventListener('click', async () => {
    $('stop-button').disabled = true;
    try { await bridge.stopTask(); } catch (error) { notice(errorText(error), true); }
    finally { $('stop-button').disabled = false; }
  });
  $('task-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); runTask(); } });
  bindConversationDisclosureVisibility();
  document.addEventListener('forge:round-navigate', () => {
    cancelFileDisclosureReveal();
    fileDisclosureScrollPaused = true;
    followOutput = false;
  });
  $('message-scroll').addEventListener('scroll', () => {
    const node = $('message-scroll');
    if (node.classList.contains('usage-view-open') || fileDisclosureReveal) return;
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (fileDisclosureScrollPaused && remaining > 2) { followOutput = false; return; }
    fileDisclosureScrollPaused = false;
    followOutput = remaining < 100;
  });
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
  promptCompletion = window.ForgePromptCompletion.create({
    input: $('task-input'), hint: $('prompt-completion-hint'), ghost: $('prompt-completion-ghost'),
    canSuggest: () => !contextBusy() && !restoringWorkspace && !reasoningSaving && draftAttachments.length === 0,
    getContext: () => appState?.workspace && sessionId && appState?.settings?.model && !projectSwitching && !promptSubmitting
      && !modelSaving && !settingsSaving && !isChatGPTBusy() && !approvals.size
      && (!['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent'].includes(currentAuthMode()) || appState.roleModels?.completion?.enabled) ? {
        sessionId, workspaceId: currentWorkspaceId(), model: appState.settings.model, provider: appState.settings.provider,
        authMode: appState.settings.authMode, catalog: currentCatalogKey, reasoning: appState.settings.reasoningEffort,
        account: activeCatalogIdentity(appState),
        completionConnection: appState.roleModels?.completion?.enabled ? catalogIdentity(appState.roleModels.completion.settings?.provider,
          currentAuthMode(appState.roleModels.completion.settings), appState.roleModels.completion) : '',
        completionModel: appState.roleModels?.completion?.enabled ? appState.roleModels.completion.settings?.model || '' : '',
        completionReasoning: appState.roleModels?.completion?.enabled ? appState.roleModels.completion.settings?.reasoningEffort || '' : '',
      } : null,
    request: args => bridge.completePrompt(args), cancel: args => bridge.cancelPromptCompletion(args),
  });
  if (window.ForgeDeepSeekLogin && bridge) window.synoraDeepSeekLogin = window.ForgeDeepSeekLogin.create({ document, bridge,
    getScope: modelSettingsScope, getRole: () => settingsRole,
    isBusy: () => contextBusy() || settingsSaving || reasoningSaving || chatgptBusy || window.synoraGeminiLogin?.isBusy()
      || window.synoraAntigravityLogin?.isBusy() || window.synoraKimiAgentLogin?.isBusy() || window.synoraGlmAgentLogin?.isBusy() || window.synoraClaudeAgentLogin?.isBusy() || window.synoraArkLogin?.isBusy(),
    onState: updateState, onChange: renderChatGPTState,
    onInvalidate: role => { if (role) invalidateSettingsCatalog(); else invalidateCatalogs(); promptCompletion?.cancel(); },
    onModeChange: () => { invalidateSettingsCatalog(); $('api-key-input').value = ''; $('settings-error').hidden = true; renderChatGPTState(); },
    onRefreshModels: refreshChatGPTModels });
  if (window.ForgeGeminiLogin && bridge) window.synoraGeminiLogin = window.ForgeGeminiLogin.create({ document, bridge,
    getScope: modelSettingsScope, getRole: () => settingsRole,
    isBusy: () => contextBusy() || settingsSaving || reasoningSaving || chatgptBusy || window.synoraDeepSeekLogin?.isBusy() || window.synoraAntigravityLogin?.isBusy()
      || window.synoraKimiAgentLogin?.isBusy() || window.synoraGlmAgentLogin?.isBusy() || window.synoraClaudeAgentLogin?.isBusy() || window.synoraArkLogin?.isBusy(),
    onState: updateState, onChange: renderChatGPTState,
    onInvalidate: role => { if (role) invalidateSettingsCatalog(); else invalidateCatalogs(); promptCompletion?.cancel(); },
    onModeChange: () => { invalidateSettingsCatalog(); $('api-key-input').value = ''; $('settings-error').hidden = true; renderChatGPTState(); },
    onRefreshModels: refreshChatGPTModels });
  if (window.ForgeAntigravityLogin && bridge) window.synoraAntigravityLogin = window.ForgeAntigravityLogin.create({ document, bridge,
    getScope: () => appState || {}, getRole: () => settingsRole,
    isBusy: () => contextBusy() || settingsSaving || reasoningSaving || chatgptBusy || window.synoraDeepSeekLogin?.isBusy() || window.synoraGeminiLogin?.isBusy()
      || window.synoraKimiAgentLogin?.isBusy() || window.synoraGlmAgentLogin?.isBusy() || window.synoraClaudeAgentLogin?.isBusy() || window.synoraArkLogin?.isBusy(),
    onState: updateState, onChange: renderChatGPTState,
    onInvalidate: () => { invalidateCatalogs(); promptCompletion?.cancel(); }, onRefreshModels: refreshChatGPTModels });
  if (window.ForgeAntigravityLogin && bridge) for (const descriptor of [
    { provider: 'kimi', authMode: 'kimi-agent', stateKey: 'kimiAgent', prefix: 'kimi-agent', name: 'Kimi Code', modeId: 'kimi-auth-mode', bridgePrefix: 'kimiAgent', errorPrefix: 'KIMI_',
      regions: [['mainland-cn', '中国大陆'], ['global', '国际']], allowDeviceCode: true, verificationHosts: ['kimi.com', 'moonshot.cn', 'moonshot.ai'] },
    { provider: 'glm', authMode: 'glm-agent', stateKey: 'glmAgent', prefix: 'glm-agent', name: 'ZCode', modeId: 'glm-auth-mode', bridgePrefix: 'glmAgent', errorPrefix: 'ZCODE_',
      regions: [['bigmodel', '智谱 · 中国大陆'], ['zai', 'Z.AI · 国际']] },
    { provider: 'anthropic', authMode: 'claude-agent', stateKey: 'claudeAgent', prefix: 'claude-agent', name: 'Claude Code', modeId: 'anthropic-auth-mode', bridgePrefix: 'claudeAgent', errorPrefix: 'CLAUDE_', controllerKey: 'synoraClaudeAgentLogin',
      help: '通过本机官方 Claude Code 登录并执行主会话任务。可用模型与额度以官方账号实际权限为准。' },
    { provider: 'doubao', authMode: 'ark-account', stateKey: 'ark', prefix: 'ark', name: '火山方舟', modeId: 'doubao-auth-mode', bridgePrefix: 'ark', errorPrefix: 'ARK_', controllerKey: 'synoraArkLogin',
      help: '在官方页面登录火山方舟，使用当前账号的 API、Agent Plan 或 Coding Plan 配置。', installLabel: '准备登录组件' },
  ]) {
    const controller = window.ForgeAntigravityLogin.create({ document, bridge, descriptor, getScope: () => appState || {}, getRole: () => settingsRole,
      isBusy: () => contextBusy() || settingsSaving || reasoningSaving || chatgptBusy || window.synoraDeepSeekLogin?.isBusy() || window.synoraGeminiLogin?.isBusy()
        || window.synoraAntigravityLogin?.isBusy() || (descriptor.provider === 'kimi' ? window.synoraGlmAgentLogin?.isBusy() || window.synoraClaudeAgentLogin?.isBusy() || window.synoraArkLogin?.isBusy() : window.synoraKimiAgentLogin?.isBusy()),
      onState: updateState, onChange: renderChatGPTState,
      onInvalidate: () => { if (settingsRole) invalidateSettingsCatalog(); else invalidateCatalogs(); promptCompletion?.cancel(); },
      onModeChange: () => { $('api-key-input').value = ''; $('settings-error').hidden = true; renderChatGPTState(); }, onRefreshModels: refreshChatGPTModels });
    window[descriptor.controllerKey || (descriptor.provider === 'kimi' ? 'synoraKimiAgentLogin' : 'synoraGlmAgentLogin')] = controller;
  }
  bindUI();
  if (!bridge) {
    notice('桌面桥接未就绪，请通过 Cortex 桌面应用启动此界面。', true);
    document.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = true; });
    return;
  }
  appUpdateControls = window.ForgeAppUpdate.create({ bridge, button: $('app-update-button'), label: $('app-update-label'), progress: $('app-update-progress'), notice, isBusy: () => contextBusy() || editorSaving || isChatGPTBusy() });
  window.synoraAppUpdate = appUpdateControls;
  window.synoraPetOverlay = window.ForgePetOverlay.create({ document, bridge, notice,
    onConfigure: () => window.synoraPetSettings?.open() });
  window.synoraExtensions = window.ForgeExtensions.create({ document, bridge, notice });
  window.synoraPetSettings = window.ForgePetSettings.create({ document, bridge, pet: window.synoraPetOverlay, notice });
  window.synoraRoleModels = window.ForgeRoleModels.create({ document, bridge, onConfigure: openSettings,
    onState: updateState, notice, isBusy: () => contextBusy() || settingsSaving || isChatGPTBusy() });
  sideChatControls = window.ForgeSideChat.create({ bridge, getWorkspaceId: currentWorkspaceId, notice,
    onOpen: () => { if (!$('preview-panel').hidden) setPreviewOpen(false); },
    onLink: url => browserController?.open({ url }).catch(() => {}) });
  window.synoraSideChat = sideChatControls;
  browserController = window.ForgeBrowser.create({ bridge, getWorkspaceId: currentWorkspaceId, isCurrentWorkspace: belongsToCurrentWorkspace, showPanel: () => { if (!previewPinned) setPreviewPinned(true); setPreviewOpen(true); showPreviewTab('browser'); }, notice });
  chatSelectionMenu = window.ForgeChatSelectionMenu.create({ container: $('messages'), scrollContainer: $('message-scroll'), menu: $('chat-selection-menu'), copy: text => bridge.copyText({ text }), search: url => browserController.open({ url }), ask: text => sideChatControls.open(text), getContextKey: () => `${currentWorkspaceId() || ''}:${sessionId || ''}`, notice });
  permissionControls = window.ForgePermissions.create({ bridge, getWorkspaceId: currentWorkspaceId, isCurrentWorkspace: belongsToCurrentWorkspace, notice, onOpen: () => fetchCurrentCatalog() });
  sessionControls = window.ForgeSessions.create({ bridge, onSelect: loadSession, onNew: () => newSession(), onDelete: deleteSessionRecord, notice });
  bridge.onEvent(handleEvent);
  try {
    const version = taskStateVersion;
    const queueVersion = promptQueueVersion;
    updateState(await bridge.getState(), { syncActiveTask: version === taskStateVersion, syncPendingQueue: queueVersion === promptQueueVersion });
    window.synoraPetOverlay.updateState(appState);
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
    sideChatVisible: document.documentElement.classList.contains('side-chat-open'),
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
      case 'open-file': return openEditorFile();
      case 'close-window': return bridge.closeWindow();
      case 'logout': return runChatGPTAction('disconnect', () => bridge.chatgptDisconnect());
      case 'quit': return bridge.quitApp();
      case 'settings': return openSettings();
      case 'extensions': return window.synoraExtensions?.open();
      case 'pet-settings': return window.synoraPetSettings?.open();
      case 'mobile-remote': return window.CortexMobileRemote?.open();
      case 'role-settings': return window.synoraRoleModels?.openList();
      case 'role-subagent-settings': return window.synoraRoleModels?.open('subagent');
      case 'role-approval-settings': return window.synoraRoleModels?.open('approval');
      case 'role-completion-settings': return window.synoraRoleModels?.open('completion');
      case 'role-sidebar-settings': return window.synoraRoleModels?.open('sidebar');
      case 'role-pet-settings': return window.synoraRoleModels?.open('pet');
      case 'role-image-settings': return window.synoraRoleModels?.open('image');
      case 'import-background': return window.synoraAppearance?.importBackground();
      case 'appearance-settings': return window.synoraAppearance?.open();
      case 'toggle-sidebar': return toggleSidebar();
      case 'toggle-side-chat': return sideChatControls.toggle();
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
      case 'check-update': return appUpdateControls?.check();
      case 'about': return bridge.openHelp({ topic: 'about' });
      default: throw new Error('未识别的菜单操作。');
    }
  }
});

initialize();
