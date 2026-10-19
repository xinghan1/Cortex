// Current-project history menu against isolated persisted fixtures. No model,
// real project, system clipboard, Explorer or user session is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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
  let installed = false;
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
    assert.match(menu.firstTime, /10.18.*11:01/u); assert.equal(menu.title, path.basename(project));
    assert.equal(menu.caret, 'session-menu-caret'); assert.ok(menu.heading.includes('session-heading'));
    assert.equal(menu.inside, true); assert.equal(menu.belowTitlebar, true);
    await pick(older.id); await ready(older.id);
    assert.ok(await js(`document.getElementById('messages').textContent.includes(${JSON.stringify(older.messages[1].content)})`));

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
    await openMenu();
    win.webContents.invalidate(); await wait(120);
    await fs.writeFile(path.join(output, 'project-session-menu.png'), (await win.webContents.capturePage()).toPNG());
    return { projectHistory: records.length, selectedHistory: true, newSession: true, editorGuard: true, keyboard: true, busyLock: true, queueLock: true, plainTextPreviews: true, hongKongTime: true, screenshot: 'project-session-menu.png' };
  } catch (error) {
    const state = !win.isDestroyed() ? await js("(()=>{const p=document.getElementById('session-dropdown');return {sessionId,mainSessionId:appState?.sessionId,menuHidden:p?.hidden,menuText:p?.textContent,busy:contextBusy(),triggerDisabled:document.getElementById('session-menu-button')?.disabled,guardCalls:window.__sessionSmoke?.calls};})()").catch(() => null) : null;
    console.error('SESSION_SMOKE_FAILURE', error?.stack || error?.message, JSON.stringify(state));
    throw error;
  } finally {
    if (!win.isDestroyed()) {
      if (installed) await js('confirmEditorTransition=window.__sessionSmoke.guard;delete window.__sessionSmoke').catch(() => {});
      await js('sessionControls.close();sessionControls.update({...appState,sessionId,busy:false,promptQueue:{items:[]}})').catch(() => {});
      if (original.workspace?.root) await js(`openRecentProject({path:${JSON.stringify(original.workspace.root)}})`).catch(() => {});
    }
  }
};
