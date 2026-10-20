// Current-project history menu against isolated persisted fixtures. No model,
// real project, system clipboard, Explorer or user session is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeSessions({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Session smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(25); }
    throw new Error('Session smoke timed out: ' + label);
  };
  const click = async selector => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node?.checkVisibility())throw new Error('Missing visible session target');node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const original = await call('getState');
  const project = path.join(dataDir, 'sessions-fixture-' + randomUUID());
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'notes.txt'), 'Only a session menu fixture.\n');
  const create = async (preview, updatedAt, workspace = project) => {
    const session = { id: randomUUID(), title: path.basename(workspace), workspace, createdAt: updatedAt, updatedAt, usageLedgerVersion: 1,
      messages: [{ role: 'user', content: preview }, { role: 'assistant', content: 'HISTORY_RESPONSE ' + preview }], events: [] };
    await fs.writeFile(path.join(dataDir, 'sessions', session.id + '.json'), JSON.stringify(session));
    return session;
  };
  const older = await create('最初的任务 <img src=x onerror=alert(1)>', '2026-10-18T03:01:00.000Z');
  const latest = await create('后来的任务：调整页面样式', '2026-10-19T04:12:00.000Z');
  const other = await create('OTHER_PROJECT_PRIVATE_MESSAGE', '2026-10-19T05:00:00.000Z', project + '-different');
  const ready = async expected => until('selected session ' + expected, async () => {
    const main = await call('getState');
    return main.sessionId === expected && await js(`sessionId===${JSON.stringify(expected)}&&!projectSwitching&&!document.getElementById('session-menu-button').disabled`);
  });
  const openMenu = async () => {
    await js("document.getElementById('session-menu-button').click()");
    return until('history menu loaded', () => js("!document.getElementById('session-dropdown').hidden&&!document.querySelector('#session-dropdown .session-list-status')?.textContent.includes('正在加载')&&document.querySelectorAll('#session-dropdown [data-session-id]').length>=2"));
  };
  const pick = id => js(`document.querySelector('#session-dropdown [data-session-id="${id}"]').click()`);
  let installed = false, peer;
  try {
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await ready(latest.id);
    const records = await call('listProjectSessions');
    assert.deepEqual(records.map(record => record.id), [latest.id, older.id]);
    assert.ok(!JSON.stringify(records).includes(other.id));
    assert.ok(!JSON.stringify(records).includes('OTHER_PROJECT_PRIVATE_MESSAGE'));
    await openMenu();
    const menu = await js(`(()=>{const p=document.getElementById('session-dropdown'),t=document.getElementById('conversation-title'),r=p.getBoundingClientRect(),b=document.getElementById('session-menu-button').getBoundingClientRect();return {ids:[...p.querySelectorAll('[data-session-id]')].map(n=>n.dataset.sessionId),selected:p.querySelector('[aria-checked="true"]')?.dataset.sessionId,unsafeImages:p.querySelectorAll('img,script').length,firstPreview:p.querySelector('[data-session-id="${older.id}"] .session-history-preview').textContent,firstTime:p.querySelector('[data-session-id="${older.id}"] .session-history-meta').textContent,title:t.textContent,caret:t.nextElementSibling?.className,heading:t.closest('h1')?.className,inside:r.left>=0&&r.right<=innerWidth&&r.top>=b.bottom&&r.bottom<=innerHeight,belowTitlebar:r.top>=44};})()`);
    assert.deepEqual(menu.ids, [latest.id, older.id]); assert.equal(menu.selected, latest.id);
    assert.equal(menu.unsafeImages, 0); assert.equal(menu.firstPreview, older.messages[0].content);
    assert.match(menu.firstTime, /10.18.*11:01/u); assert.equal(menu.title, latest.messages[0].content);
    assert.equal(menu.caret, 'session-menu-caret'); assert.ok(menu.heading.includes('session-heading'));
    assert.equal(menu.inside, true); assert.equal(menu.belowTitlebar, true);
    await pick(older.id); await ready(older.id);
    assert.ok(await js(`document.getElementById('messages').textContent.includes(${JSON.stringify(older.messages[1].content)})`));
    assert.equal(await js("document.getElementById('conversation-title').textContent"), older.messages[0].content);

    // Rename through the actual menu, dialog, input and real IPC. HTML-like
    // characters are a title, never markup, and do not alter conversation text.
    const renamed = '我的测试会话 <img src=x onerror=alert(1)>';
    await openMenu();
    win.setOpacity(0); win.showInactive(); win.webContents.focus();
    await click('#session-dropdown [data-action="rename-session"]');
    await until('rename dialog opens', () => js("document.getElementById('session-rename-dialog').open"));
    assert.equal(await js("document.getElementById('session-rename-input').value"), older.messages[0].content);
    await js("document.getElementById('session-rename-input').focus();document.getElementById('session-rename-input').select()");
    win.webContents.focus(); await win.webContents.insertText(renamed);
    await click('#session-rename-save');
    await until('custom title reflected in state and header', async () => (await call('getState')).sessionTitle === renamed && await js(`document.getElementById('conversation-title').textContent===${JSON.stringify(renamed)}&&!document.getElementById('session-rename-dialog').open`));
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', older.id + '.json'), 'utf8'));
    assert.equal(persisted.customTitle, renamed); assert.equal(persisted.title, renamed);
    assert.deepEqual(persisted.messages, older.messages);
    assert.equal((await call('getSession', { id: older.id })).title, renamed);
    assert.equal(await js("document.getElementById('session-menu-button').querySelectorAll('img,script').length"), 0);
    await openMenu();
    assert.equal(await js(`document.querySelector('#session-dropdown [data-session-id="${older.id}"] .session-history-preview').textContent`), renamed);
    await click('#session-dropdown [data-action="rename-session"]');
    await until('rename can be cancelled', () => js("document.getElementById('session-rename-dialog').open"));
    await js("document.getElementById('session-rename-input').value='UNSAVED_RENAME'");
    await click('#session-rename-cancel');
    assert.equal((await call('getState')).sessionTitle, renamed);

    // Two real windows may view one session. A rename must not overwrite a
    // newer persisted transcript, and a task awaiting approval blocks it.
    const peerId = (await call('newWindow')).id;
    peer = BrowserWindow.fromId(peerId); assert.ok(peer && peer !== win && peer.webContents.isOffscreen());
    const peerJs = code => peer.webContents.executeJavaScript(code);
    const peerCall = (method, arg) => peerJs(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
    await until('peer renderer ready', () => peerJs('Boolean(appState&&!projectSwitching)'));
    await peerJs(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('same session in peer window', () => peerJs(`sessionId===${JSON.stringify(older.id)}&&!projectSwitching`));
    await peerCall('setPermissionMode', { mode: 'request' });
    await peerCall('runTerminal', { command: 'Write-Output SYNORA_RENAME_GUARD', timeoutMs: 1000 });
    await until('peer command awaiting approval', async () => { const state = await peerCall('getState'); return state.activeTask?.running && state.pendingApprovals.length === 1; });
    await assert.rejects(call('renameSession', { id: older.id, title: 'BUSY_PEER_RENAME_MUST_NOT_SAVE' }), /此会话正在另一个窗口处理任务/u);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', older.id + '.json'), 'utf8')).customTitle, renamed);
    await peerCall('stopTerminal');
    await until('peer approval cancelled without running command', async () => { const state = await peerCall('getState'); return !state.activeTask?.running && state.pendingApprovals.length === 0; });
    assert.equal((await peerCall('getState')).terminalEvents.some(event => event.type === 'terminal-output' && JSON.stringify(event).includes('SYNORA_RENAME_GUARD')), false);
    const latestOnDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', older.id + '.json'), 'utf8'));
    latestOnDisk.messages.push({ role: 'assistant', content: 'LATEST_DISK_MESSAGE_MUST_SURVIVE_RENAME' });
    latestOnDisk.smokePreservedMetadata = { revision: 'external-newer-copy' };
    await fs.writeFile(path.join(dataDir, 'sessions', older.id + '.json'), JSON.stringify(latestOnDisk));
    const synchronizedTitle = '两个窗口同步的会话标题';
    await call('renameSession', { id: older.id, title: synchronizedTitle });
    await until('idle peer title synchronized', () => peerJs(`appState.sessionTitle===${JSON.stringify(synchronizedTitle)}&&document.getElementById('conversation-title').textContent===${JSON.stringify(synchronizedTitle)}`));
    let kept = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', older.id + '.json'), 'utf8'));
    assert.deepEqual(kept.messages, latestOnDisk.messages); assert.deepEqual(kept.smokePreservedMetadata, latestOnDisk.smokePreservedMetadata);
    await peerCall('renameSession', { id: older.id, title: renamed });
    await until('parent title synchronized back from peer', () => js(`appState.sessionTitle===${JSON.stringify(renamed)}&&document.getElementById('conversation-title').textContent===${JSON.stringify(renamed)}`));
    kept = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', older.id + '.json'), 'utf8'));
    assert.deepEqual(kept.messages, latestOnDisk.messages); assert.deepEqual(kept.smokePreservedMetadata, latestOnDisk.smokePreservedMetadata);
    peer.destroy(); peer = null; win.focus(); win.webContents.focus();

    // The menu must delegate to loadSession, including its existing transition
    // guard. Simulate the user retaining an unsaved editor, without altering a file.
    await js("(()=>{window.__sessionSmoke={guard:confirmEditorTransition,calls:0};confirmEditorTransition=async()=>{window.__sessionSmoke.calls++;return false;};return true;})()"); installed = true;
    await openMenu(); await pick(latest.id);
    await until('editor guard consulted', () => js('window.__sessionSmoke.calls===1'));
    assert.equal((await call('getState')).sessionId, older.id);
    await js('(()=>{confirmEditorTransition=window.__sessionSmoke.guard;return true;})()');
    await openMenu();
    await js("document.querySelector('#session-dropdown [data-action=\"new-session\"]').click()");
    const created = await until('new empty chat', async () => { const state = await call('getState'); return ![latest.id, older.id].includes(state.sessionId) && state; });
    await ready(created.sessionId);
    assert.equal(await js("document.querySelectorAll('#messages .message').length"), 0);
    assert.equal(await js("document.getElementById('conversation-title').textContent"), '新会话');
    await openMenu();
    assert.equal(await js(`document.querySelector('#session-dropdown [aria-checked="true"]').dataset.sessionId`), created.sessionId);
    assert.equal(await js("document.querySelectorAll('#session-dropdown [data-session-id]').length"), 3);
    await js("document.getElementById('session-dropdown').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    assert.equal(await js("document.getElementById('session-dropdown').hidden&&document.activeElement.id==='session-menu-button'"), true);
    await js("document.getElementById('session-menu-button').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
    await until('keyboard menu opens', () => js("!document.getElementById('session-dropdown').hidden&&document.activeElement.dataset.action==='new-session'"));
    await js("sessionControls.update({...appState,sessionId,busy:true})");
    assert.equal(await js("document.getElementById('session-menu-button').disabled&&document.getElementById('session-dropdown').hidden"), true);
    await js("sessionControls.update({...appState,sessionId,busy:false,promptQueue:{items:[{id:'display-only'}]}})");
    assert.equal(await js("document.getElementById('session-menu-button').disabled"), true);
    await js("sessionControls.update({...appState,sessionId,busy:false,promptQueue:{items:[]}})");
    await openMenu(); await pick(latest.id); await ready(latest.id);
    assert.equal(await js("document.getElementById('conversation-title').textContent"), latest.messages[0].content);
    await assert.rejects(call('renameSession', { id: older.id, title: 'STALE_RENAME_MUST_NOT_SAVE' }), /当前会话已切换/u);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', older.id + '.json'), 'utf8')).customTitle, renamed);
    await openMenu(); await pick(older.id); await ready(older.id);
    assert.equal(await js("document.getElementById('conversation-title').textContent"), renamed);
    await js('delete window.__sessionSmoke'); installed = false;
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload(); await reloaded;
    await until('renderer reloaded', () => js("Boolean(appState&&sessionControls&&!projectSwitching)").catch(() => false));
    await ready(older.id);
    assert.equal(await js("document.getElementById('conversation-title').textContent"), renamed, 'Custom title survives a renderer reload');
    await openMenu();
    win.webContents.invalidate(); await wait(120);
    await fs.writeFile(path.join(output, 'project-session-menu.png'), (await win.webContents.capturePage()).toPNG());
    return { projectHistory: records.length, selectedHistory: true, promptTitles: true, nativeRenameDialog: true, customTitlePersistence: true, renameCancel: true, staleRenameRejected: true, busyPeerRenameRejected: true, idlePeerTitleSync: true, latestDiskTranscriptPreserved: true, pendingCommandCancelled: true, newSession: true, editorGuard: true, keyboard: true, busyLock: true, queueLock: true, plainTextPreviews: true, hongKongTime: true, screenshot: 'project-session-menu.png' };
  } catch (error) {
    const state = !win.isDestroyed() ? await js("(()=>{const p=document.getElementById('session-dropdown');return {sessionId,mainSessionId:appState?.sessionId,menuHidden:p?.hidden,menuText:p?.textContent,busy:contextBusy(),triggerDisabled:document.getElementById('session-menu-button')?.disabled,guardCalls:window.__sessionSmoke?.calls};})()").catch(() => null) : null;
    console.error('SESSION_SMOKE_FAILURE', error?.stack || error?.message, JSON.stringify(state));
    throw error;
  } finally {
    if (peer && !peer.isDestroyed()) { await peer.webContents.executeJavaScript('window.forge.stopTerminal()').catch(() => {}); peer.destroy(); }
    if (!win.isDestroyed()) {
      if (installed) await js('confirmEditorTransition=window.__sessionSmoke.guard;delete window.__sessionSmoke').catch(() => {});
      await js('sessionControls.close();sessionControls.update({...appState,sessionId,busy:false,promptQueue:{items:[]}})').catch(() => {});
      if (original.workspace?.root) await js(`openRecentProject({path:${JSON.stringify(original.workspace.root)}})`).catch(() => {});
    }
  }
};
