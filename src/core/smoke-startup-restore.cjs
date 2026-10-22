// Run prepare and verify in two fresh Electron processes sharing only this
// disposable data directory. No models, commands or actual user files are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = async function smokeStartupRestore({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const phase = process.env.FORGEDESK_STARTUP_SMOKE_PHASE;
  assert.ok(['prepare', 'verify'].includes(phase), 'Set FORGEDESK_STARTUP_SMOKE_PHASE to prepare or verify');
  const fixtureFile = path.join(dataDir, 'startup-restore-smoke-fixture.json');
  const startupFile = path.join(dataDir, 'startup-session.json');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (name, arg) => js(`window.forge[${JSON.stringify(name)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Startup restore smoke timed out: ' + label);
  };
  const click = async selector => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node?.checkVisibility()||node.disabled)throw new Error('Unavailable startup control');node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered startup control');return p;})()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({ type:'mouseDown',button:'left',clickCount:1,...point });
    win.webContents.sendInputEvent({ type:'mouseUp',button:'left',clickCount:1,...point });
    await wait(40);
  };
  const ready = async () => until('renderer initial state', () => js('Boolean(appState&&window.forge&&!projectSwitching)'));
  await fs.mkdir(output, { recursive:true });
  await ready(); win.setOpacity(0); win.showInactive(); win.webContents.focus();
  const entryState = await call('getState'), entrySession = await call('getCurrentSession');
  assert.equal(entryState.activeTask.running, false); assert.equal(entryState.pendingApprovals.length, 0);
  let fixture;
  try {
    if (phase === 'prepare') {
      assert.equal(await fs.stat(fixtureFile).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false, 'Prepare requires a fresh isolated directory');
      const nonce = randomUUID(), project = path.join(dataDir, 'startup-project-' + nonce);
      await fs.mkdir(project, { recursive:true }); await fs.writeFile(path.join(project, 'notes.txt'), 'STARTUP_LOCAL_FIXTURE_' + nonce + '\n');
      const make = (label, date) => ({ id:randomUUID(),workspace:project,title:label,customTitle:label,
        createdAt:date,updatedAt:date,usageLedgerVersion:1,
        messages:[{role:'user',content:label + '_USER_' + nonce},{role:'assistant',content:label + '_HISTORY_' + nonce}],events:[] });
      const older = make('恢复选中的旧会话', '2026-10-18T00:00:00.000Z');
      const newest = make('较新但未选中的会话', '2026-10-20T00:00:00.000Z');
      fixture = { nonce,project,older,newest,preparePid:process.pid };
      await fs.writeFile(path.join(dataDir, 'sessions', older.id + '.json'), JSON.stringify(older));
      await fs.writeFile(path.join(dataDir, 'sessions', newest.id + '.json'), JSON.stringify(newest));
      await js(`openRecentProject({path:${JSON.stringify(project)}})`);
      await until('project opens its newest history initially', async () => (await call('getState')).sessionId === newest.id && await js(`sessionId===${JSON.stringify(newest.id)}&&!projectSwitching`));
      await click('#session-menu-button');
      await until('older history option', () => js(`Boolean(document.querySelector('#session-dropdown [data-session-id="${older.id}"]'))`));
      await click(`#session-dropdown [data-session-id="${older.id}"]`);
      await until('native selected older session', async () => (await call('getState')).sessionId === older.id && await js(`sessionId===${JSON.stringify(older.id)}&&$('messages').textContent.includes(${JSON.stringify(older.messages[1].content)})`));
      const persisted = await until('selected old id persisted as startup anchor', async () => {
        const value = await fs.readFile(startupFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        return value?.current?.sessionId === older.id && value;
      });
      assert.equal(persisted.current.workspace, project);
      assert.ok(persisted.projects.some(item => item.workspace === project && item.sessionId === older.id));
      const records = await call('listProjectSessions');
      assert.deepEqual(records.map(item => item.id), [newest.id, older.id], 'Selecting old history must not make its updatedAt newest');
      await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
    } else {
      fixture = JSON.parse(await fs.readFile(fixtureFile, 'utf8'));
      assert.notEqual(process.pid, fixture.preparePid, 'Verification must be a second Electron main process');
      assert.equal(entryState.workspace?.root, fixture.project, 'Startup must restore before the smoke can open anything');
      assert.equal(entryState.sessionId, fixture.older.id); assert.equal(entrySession.id, fixture.older.id);
      assert.equal(entryState.sessionTitle, fixture.older.customTitle);
      assert.deepEqual(entrySession.messages, fixture.older.messages);
      await until('first renderer snapshot restores selected title and history', () => js(`appState?.workspace?.root===${JSON.stringify(fixture.project)}&&sessionId===${JSON.stringify(fixture.older.id)}&&$('conversation-title').textContent===${JSON.stringify(fixture.older.customTitle)}&&$('messages').textContent.includes(${JSON.stringify(fixture.older.messages[1].content)})`));
      assert.equal(await js(`$('messages').textContent.includes(${JSON.stringify(fixture.newest.messages[1].content)})`), false);
      const persisted = JSON.parse(await fs.readFile(startupFile, 'utf8'));
      assert.equal(persisted.current.sessionId, fixture.older.id);
      assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', fixture.newest.id + '.json'), 'utf8')).updatedAt, fixture.newest.updatedAt);
    }
    assert.equal((await call('getState')).usageStats.day.requests, 0, 'Startup restore must never make a model request');
    assert.equal((await call('getState')).terminalEvents.length, 0);
    win.webContents.invalidate(); await wait(150);
    const screenshot = 'startup-restore-' + phase + '.png';
    await fs.writeFile(path.join(output, screenshot), (await win.webContents.capturePage()).toPNG());
    return { status:'completed',phase,realApi:false,realCommands:false,isolatedData:true,
      mainProcessPid:process.pid,selectedNotNewestSession:true,exactProjectAndHistory:true,
      selectedCustomTitle:true,anchorPersisted:true,twoProcessStartup:phase === 'verify',screenshot };
  } catch (error) {
    await fs.writeFile(path.join(output, 'startup-restore-failure.json'), JSON.stringify({ phase,error:error.message,stack:error.stack,entryState,entrySession,fixture }, null, 2));
    throw error;
  }
};
