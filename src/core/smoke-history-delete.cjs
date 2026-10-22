// Real native history controls and IPC in disposable offscreen windows.
// Fixture sessions, project files and encrypted undo snapshots are local only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { BrowserWindow, safeStorage } = require('electron');

module.exports = async function smokeHistoryDelete({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true, 'History deletion smoke requires an isolated parent');
  const fixture = path.join(dataDir, 'history-delete-' + randomUUID()), project = path.join(fixture, 'first'), second = path.join(fixture, 'second');
  const evidence = {}, screenshots = [], children = [];
  let child, peer, observer, stage = 'prepare isolated session records', originalAppearance, originalList, releaseList;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = async (promise, label, milliseconds = 15_000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('History deletion timed out: ' + label)), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const js = (code, target = child) => bounded(target.webContents.executeJavaScript(code), 'renderer operation');
  const call = (method, value, target = child) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`, target);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now())); if (value) return value; await wait(30); }
    throw new Error('History deletion timed out: ' + label);
  };
  const exists = async filename => { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const hash = value => createHash('sha256').update(value).digest('hex');
  const sessionFile = id => path.join(dataDir, 'sessions', id + '.json'), undoFile = id => path.join(dataDir, 'task-undo', id + '.json');
  const selector = id => '#session-dropdown [data-delete-session-id=' + JSON.stringify(id) + ']';
  const selectSelector = id => '#session-dropdown [data-session-id=' + JSON.stringify(id) + ']';
  const projectSelector = root => '#project-dropdown [data-remove-project-path=' + JSON.stringify(root) + ']';
  const selectProjectSelector = root => '#project-dropdown [data-workspace=' + JSON.stringify(root) + ']';
  const initialize = async target => {
    await until('child renderer initialized', () => js('Boolean(appState&&sessionControls&&window.synoraAppearance&&!projectSwitching)', target).catch(() => false));
    await js('window.synoraAppearance.ready', target);
    await js(`window.__historyDeleteInputs=[];window.__historyDeleteEvents=[];
      document.addEventListener('click',e=>{const n=e.target.closest('[data-delete-session-id],[data-remove-project-path],#session-delete-confirm,#session-delete-cancel');if(n)window.__historyDeleteInputs.push({trusted:e.isTrusted,id:n.id,session:n.dataset.deleteSessionId,project:n.dataset.removeProjectPath});},true);
      window.forge.onEvent(e=>{if(['session-deleted','run-start','terminal-output'].includes(e.type))window.__historyDeleteEvents.push(e);});true`, target);
  };
  const newChild = async () => {
    const target = BrowserWindow.fromId((await call('newWindow', undefined, win)).id);
    assert.ok(target && target !== win && target.webContents.isOffscreen()); children.push(target);
    target.setContentSize(1440, 1000); target.setOpacity(0); target.showInactive();
    await initialize(target); return target;
  };
  const click = async (targetSelector, target = child) => {
    const point = await until('uncovered native target ' + targetSelector, () => js(`(() => {
      const n=document.querySelector(${JSON.stringify(targetSelector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return r.width&&r.height&&n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`, target));
    target.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) target.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await wait(70);
  };
  const key = async (keyCode, modifiers = [], target = child) => {
    if (!target.webContents.isFocused()) target.webContents.focus();
    target.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') target.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    target.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(70);
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        child.webContents.invalidate(); await wait(120 * attempt);
        const image = await bounded(child.webContents.capturePage(), 'screenshot ' + filename, 8000); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename); return;
      } catch (error) { if (attempt === 3 || !/UnknownVizError|screenshot/u.test(String(error?.name) + ' ' + error.message)) throw error; }
    }
  };
  const reload = async target => {
    const loaded = new Promise((resolve, reject) => { target.webContents.once('did-finish-load', resolve); target.webContents.once('render-process-gone', (_, info) => reject(new Error('Renderer exited: ' + info.reason))); });
    target.webContents.reload(); await bounded(loaded, 'renderer reload'); await initialize(target);
  };
  const ready = async (id, target = child) => until('selected session ' + id, async () => {
    const value = await call('getState', undefined, target);
    return value.sessionId === id && await js(`sessionId===${JSON.stringify(id)}&&!projectSwitching`, target) && value;
  });
  const go = async (root, target = child) => {
    await js(`openRecentProject({path:${JSON.stringify(root)}})`, target);
    await until('project active ' + root, () => js(`appState?.workspace?.root===${JSON.stringify(root)}&&!projectSwitching`, target));
  };
  const openMenu = async (target = child) => {
    if (await js("$('session-dropdown').hidden", target)) await click('#session-menu-button', target);
    await until('session history loaded', () => js("!$('session-dropdown').hidden&&!$('session-dropdown').textContent.includes('正在加载')", target));
  };
  const deletePrompt = async id => {
    await openMenu(); await click(selector(id));
    await until('session delete confirmation', () => js("$('session-delete-dialog').open"));
  };
  const confirm = async id => {
    await click('#session-delete-confirm');
    await until('deleted session JSON removed', async () => !(await exists(sessionFile(id))));
    await until('delete dialog closed', () => js("!$('session-delete-dialog').open"));
  };
  const create = async (label, timestamp, root = project, undo = false) => {
    const session = { id: randomUUID(), workspace: root, title: label, customTitle: label, createdAt: timestamp, updatedAt: timestamp, usageLedgerVersion: 1,
      messages: [{ role: 'user', content: label }, { role: 'assistant', content: 'FIXTURE_RESPONSE_' + label }], events: [] };
    if (undo) {
      const runId = randomUUID();
      session.messages[0].attachments = [{ id: randomUUID(), name: 'proof.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }];
      session.taskRuns = [{ runId, status: 'completed', kind: 'agent', fileChangeCount: 1, messageStartIndex: 0, messageIndex: 1, elapsedMs: 5 }];
      session.fileEdits = [{ runId, toolCallId: 'fixture-' + runId, path: 'notes.txt', before: 'OLD_FIXTURE_BYTES\n', after: 'PROJECT_BYTES_MUST_REMAIN\n' }];
    }
    await fs.writeFile(sessionFile(session.id), JSON.stringify(session)); return session;
  };
  const parentBefore = await call('getState', undefined, win);
  try {
    await fs.mkdir(output, { recursive: true }); await fs.mkdir(project, { recursive: true }); await fs.mkdir(second, { recursive: true });
    await fs.writeFile(path.join(project, 'notes.txt'), 'PROJECT_BYTES_MUST_REMAIN\n'); await fs.writeFile(path.join(second, 'keep.txt'), 'RECENT_PROJECT_BYTES_MUST_REMAIN\n');
    const older = await create('可删除历史 <img src=x onerror=alert(1)>', '2026-10-20T01:00:00.000Z', project, true);
    const middle = await create('保留的较早会话', '2026-10-21T01:00:00.000Z');
    const latest = await create('当前待删除会话', '2026-10-22T01:00:00.000Z', project, true);
    const other = await create('另一个项目的会话', '2026-10-22T02:00:00.000Z', second);
    const otherSessionBytes = await fs.readFile(sessionFile(other.id)), secondFileBytes = await fs.readFile(path.join(second, 'keep.txt'));
    const usageBefore = await fs.readFile(path.join(dataDir, 'usage.json'));
    const { PersistentTaskUndo } = await import('./persistent-task-undo.mjs'), { legacyTaskUndoRuns } = await import('./legacy-task-undo.mjs');
    const archive = new PersistentTaskUndo({ dataDir, safeStorage, legacyTaskUndoRuns }); await archive.loadSession(older);
    assert.equal(await exists(undoFile(older.id)), true, 'Fixture needs a real encrypted historical undo archive');
    assert.equal((await fs.readFile(undoFile(older.id), 'utf8')).includes('OLD_FIXTURE_BYTES'), false);
    originalAppearance = await call('getAppearance', undefined, win);
    child = await newChild(); await go(project); await ready(latest.id);
    assert.equal(await exists(undoFile(latest.id)), true);

    stage = 'Delete controls are independent accessible native buttons in every material';
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      await call('setAppearance', { uiStyle: style, selectionColor: '#63b77b' }); await js('window.synoraAppearance.settled()');
      await openMenu();
      const controls = await js(`(() => {const p=$('session-dropdown'),all=[...p.querySelectorAll('[data-delete-session-id]')];return {ids:all.map(n=>n.dataset.deleteSessionId),independent:all.every(n=>n.tagName==='BUTTON'&&!n.parentElement.closest('button')&&n.getAttribute('aria-label')),
        selectIds:[...p.querySelectorAll('[data-session-id]')].map(n=>n.dataset.sessionId),unsafe:p.querySelectorAll('img,script').length};})()`);
      assert.deepEqual(new Set(controls.ids), new Set([latest.id, middle.id, older.id])); assert.equal(controls.independent, true); assert.equal(controls.unsafe, 0);
      assert.deepEqual(controls.selectIds, [latest.id, middle.id, older.id]);
      await capture('history-delete-' + style + '-menu.png'); await key('Escape');
    }
    evidence.fourMaterials = true;

    stage = 'Cancel and keyboard Escape keep the current session and archive';
    const beforeCancel = await fs.readFile(sessionFile(latest.id));
    await deletePrompt(latest.id); assert.equal((await call('getState')).sessionId, latest.id); await capture('history-delete-confirmation.png');
    assert.equal(await js("$('session-delete-dialog').querySelectorAll('img,script').length"), 0);
    await click('#session-delete-cancel'); await ready(latest.id); assert.deepEqual(await fs.readFile(sessionFile(latest.id)), beforeCancel);
    assert.equal(await exists(undoFile(latest.id)), true);
    await deletePrompt(latest.id); await key('Escape'); await until('Escape cancels deletion', () => js("!$('session-delete-dialog').open"));
    await ready(latest.id); evidence.cancelPreserved = true;

    stage = 'A historical row deletes exactly its transcript and encrypted undo archive';
    await openMenu(); await key('Down'); await key('End');
    assert.equal(await js('document.activeElement.dataset.deleteSessionId'), older.id, 'Native menu navigation must reach the historical delete button');
    await key('Enter');
    await until('keyboard opens confirmation', () => js("$('session-delete-dialog').open"));
    assert.equal((await call('getState')).sessionId, latest.id); await confirm(older.id); await ready(latest.id);
    assert.equal(await exists(undoFile(older.id)), false); assert.equal(await exists(sessionFile(middle.id)), true);
    assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'PROJECT_BYTES_MUST_REMAIN\n');
    await assert.rejects(call('getSession', { id: other.id }), /项目|会话/u);
    await assert.rejects(call('deleteSession', { id: other.id }), /项目|会话/u);
    assert.deepEqual(await fs.readFile(sessionFile(other.id)), otherSessionBytes);
    evidence.historicalDeleted = true;

    stage = 'A busy peer prevents deletion and an idle peer follows the replacement';
    peer = await newChild(); await go(project, peer); await ready(latest.id, peer);
    await call('setPermissionMode', { mode: 'request' }, peer);
    await call('runTerminal', { command: 'Write-Output SYNORA_DELETE_GUARD_MUST_NOT_RUN', timeoutMs: 1000 }, peer);
    await until('guarded terminal awaiting approval', async () => { const state = await call('getState', undefined, peer); return state.activeTask?.running && state.pendingApprovals.length === 1; });
    const duringBusy = await fs.readFile(sessionFile(latest.id));
    await assert.rejects(call('deleteSession', { id: latest.id }), /会话|任务|处理|结束/u);
    assert.deepEqual(await fs.readFile(sessionFile(latest.id)), duringBusy);
    await call('stopTerminal', undefined, peer);
    await until('guarded task cancelled without a command', async () => { const state = await call('getState', undefined, peer); return !state.activeTask?.running && !state.pendingApprovals.length; });
    assert.equal((await call('getState', undefined, peer)).terminalEvents.some(event => event.type === 'terminal-output'), false);
    observer = await newChild(); await go(project, observer); await openMenu(observer); await click(selectSelector(middle.id), observer); await ready(middle.id, observer);
    let holdNextList = true, capturedList;
    const heldList = new Promise(resolve => { releaseList = resolve; });
    originalList = store.listProjectSessions;
    store.listProjectSessions = async function (workspace) {
      const result = await originalList.call(store, workspace);
      if (holdNextList && workspace === project) { holdNextList = false; capturedList = result; await heldList; }
      return result;
    };
    await click('#session-menu-button', observer);
    await until('one genuine pending history list captured before deletion', () => capturedList);
    assert.ok(capturedList.some(row => row.id === latest.id));
    await deletePrompt(latest.id); await confirm(latest.id); await ready(middle.id); await ready(middle.id, peer);
    releaseList(); releaseList = null;
    await until('late history response cannot reinsert deleted row in another selection', () => js(`!$('session-dropdown').hidden&&!$('session-dropdown').textContent.includes('正在加载')
      &&!document.querySelector(${JSON.stringify(selectSelector(latest.id))})&&!document.querySelector(${JSON.stringify(selector(latest.id))})`, observer));
    assert.equal((await call('getState', undefined, observer)).sessionId, middle.id);
    assert.equal(await js(`window.__historyDeleteEvents.some(e=>e.type==='session-deleted'&&e.deletedId===${JSON.stringify(latest.id)})`, observer), true);
    store.listProjectSessions = originalList; originalList = null;
    await key('Escape', [], observer);
    assert.equal(await exists(undoFile(latest.id)), false);
    assert.equal(await js(`$('messages').textContent.includes(${JSON.stringify(middle.messages[1].content)})`, peer), true);
    assert.equal(await js(`$('messages').textContent.includes(${JSON.stringify(latest.messages[1].content)})`, peer), false);
    evidence.busyPeerRejected = true; evidence.idlePeerSynchronized = true; evidence.lateHistoryResponseFiltered = true;

    stage = 'Deleting the final history record creates a fresh persistent session';
    await deletePrompt(middle.id); await confirm(middle.id);
    const fresh = await until('fresh current session', async () => { const value = await call('getCurrentSession'); return value.id !== middle.id && value.messages.length === 0 && value; });
    await ready(fresh.id); await ready(fresh.id, peer); await ready(fresh.id, observer); assert.equal(fresh.temporary === true, false);
    assert.equal(await js("$('messages').textContent.includes('FIXTURE_RESPONSE_')"), false);
    const deleted = [older.id, middle.id, latest.id];
    for (const id of deleted) { assert.equal(await exists(sessionFile(id)), false); assert.equal(await exists(undoFile(id)), false); }
    const restoreBytes = await fs.readFile(path.join(dataDir, 'startup-session.json'), 'utf8');
    for (const id of deleted) assert.equal(restoreBytes.includes(id), false);
    const { SessionRestore } = require('./session-restore.cjs');
    const restored = await new SessionRestore(dataDir).resolveProject(project, {
      readSession: async id => JSON.parse(await fs.readFile(sessionFile(id), 'utf8')), listProjectSessions: root => store.listProjectSessions(root),
    });
    assert.ok(restored?.session && !deleted.includes(restored.session.id), 'Fresh persisted restoration cannot choose a deleted record');
    peer.destroy(); peer = null; await wait(120); await reload(child); await ready(fresh.id);
    for (const id of deleted) assert.equal(await exists(sessionFile(id)), false);
    evidence.lastRecordCreatesFresh = true; evidence.noRestartResurrection = true;

    stage = 'Recent-project removal persists while project files and history remain';
    await go(second); await ready(other.id); await go(project); await ready(fresh.id);
    await click('#project-switcher'); await until('recent project has remove control', () => js(`!!document.querySelector(${JSON.stringify(projectSelector(second))})`));
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(projectSelector(project))})`), false, 'The current project is not a recent removal target');
    await capture('history-delete-recent-projects.png'); await click(projectSelector(second));
    await until('removed recent project disappears', () => js(`!document.querySelector(${JSON.stringify(projectSelector(second))})&&!document.querySelector(${JSON.stringify(selectProjectSelector(second))})`));
    assert.equal((await call('getState')).workspace.root, project);
    const { RecentProjects } = require('./recent-projects.cjs');
    const recentAfterRestart = await new RecentProjects(dataDir).init();
    assert.equal(recentAfterRestart.isHidden(second), true, 'A fresh recent-project store must retain the removal');
    assert.deepEqual(await fs.readFile(sessionFile(other.id)), otherSessionBytes); assert.deepEqual(await fs.readFile(path.join(second, 'keep.txt')), secondFileBytes);
    await reload(child); await ready(fresh.id); await click('#project-switcher');
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(selectProjectSelector(second))})`), false);
    await key('Escape'); await go(second); await ready(other.id); await go(project); await ready(fresh.id); await click('#project-switcher');
    await until('explicitly reopened project returns to recent list', () => js(`!!document.querySelector(${JSON.stringify(selectProjectSelector(second))})`));
    await click(projectSelector(second)); await until('reopened project can be removed again', () => js(`!document.querySelector(${JSON.stringify(selectProjectSelector(second))})`));
    evidence.recentRemovalPersistent = true; evidence.reopenRestoresRecent = true; evidence.projectFilesPreserved = true;

    stage = 'Removed usage control and independent usage ledger';
    assert.equal(await js("Boolean($('chatgpt-usage-button')||$('chatgpt-usage-popover'))"), false);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'usage.json')), usageBefore);
    const parentAfter = await call('getState', undefined, win); assert.equal(parentAfter.workspace?.root, parentBefore.workspace?.root); assert.equal(parentAfter.sessionId, parentBefore.sessionId);
    await key('Escape'); await capture('history-delete-completed.png');
    const result = { status: 'completed', version: require('../../package.json').version, realApi: false, realCommands: false, terminalApprovalCancelledBeforeExecution: true,
      nativeAccessibleSessionButtons: true, nativeConfirmationAndCancellation: true, keyboardDeletionEntry: true, fourMaterialMenus: true,
      historicalAndCurrentDeletion: true, encryptedUndoDeleted: true, projectFilesUntouched: true, crossProjectDeletionRejected: true,
      busyPeerRejected: true, idlePeerReplacementSynchronized: true, lastHistoryCreatesNewSession: true, freshRestoreDoesNotResurrect: true,
      lateCrossWindowHistoryDoesNotReinsert: true,
      recentProjectRemovalPersists: true, explicitOpenRestoresRecent: true, usageButtonRemoved: true, usageLedgerUnchanged: true,
      parentWorkspacePreserved: true, usageLedgerHash: hash(usageBefore), deletedIds: deleted, replacementId: fresh.id, evidence, screenshots };
    await fs.writeFile(path.join(output, 'history-delete-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const result = { status: 'failed', stage, error: error.message, stack: error.stack, evidence, screenshots };
    if (child && !child.isDestroyed()) {
      result.ui = await js(`({sessionId,workspace:appState?.workspace,notice:$('notice')?.textContent,deleteOpen:document.querySelector('#session-delete-dialog')?.open,menu:document.querySelector('#session-dropdown')?.textContent})`).catch(() => null);
      await capture('history-delete-failure.png').catch(() => {});
    }
    await fs.writeFile(path.join(output, 'history-delete-result.json'), JSON.stringify(result, null, 2) + '\n'); throw new Error('History deletion failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    releaseList?.(); if (originalList) store.listProjectSessions = originalList;
    if (peer && !peer.isDestroyed()) await call('stopTerminal', undefined, peer).catch(() => {});
    if (originalAppearance && !win.isDestroyed()) await call('setAppearance', { uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor ?? null }, win).catch(() => {});
    for (const target of children) if (!target.isDestroyed()) target.destroy();
  }
};
