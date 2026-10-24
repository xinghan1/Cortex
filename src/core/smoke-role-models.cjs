// Registered, offscreen child window; all model/catalog traffic stays on loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeRoleModels({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), project = path.join(dataDir, 'role-models-project-' + nonce);
  const keys = { main: 'fixture-role-main-' + nonce, sidebar: 'fixture-role-sidebar-' + nonce, completion: 'fixture-role-completion-' + nonce };
  const models = { main: 'smoke-main-coder', sidebar: 'smoke-sidebar-text', completion: 'smoke-completion-text' };
  const mainPrompt = '请解释测试入口。MAIN_PRIVATE_HISTORY_' + nonce;
  const quote = '仅引用这段文字 QUOTED_SELECTION_' + nonce;
  const answer = '测试说明：' + quote + '。其余历史不应发送给侧栏。MAIN_PRIVATE_ANSWER_' + nonce;
  const records = [], problems = [], screenshots = [], layouts = [], palettes = [];
  let child, stage = 'setup', baseUrl, mainSettings;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = async (promise, label, ms = 15000) => {
    let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Role smoke timed out: ' + label)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const js = code => bounded(child.webContents.executeJavaScript(code), 'renderer operation');
  const call = (method, input) => js(`window.forge[${JSON.stringify(method)}](${input === undefined ? '' : JSON.stringify(input)})`);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { assert.deepEqual(problems, []); const value = await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now())); if (value) return value; await wait(30); }
    throw new Error('Role smoke timed out: ' + label);
  };
  const point = selector => until('click target ' + selector, () => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null})()`));
  const pointer = async (p, button = 'left') => {
    child.focus(); child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...p, ...(type === 'mouseMove' ? {} : { button, clickCount: 1 }) });
    await wait(90);
  };
  const click = async selector => pointer(await point(selector));
  const key = async keyCode => {
    child.focus(); child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait(60);
  };
  const capture = async filename => { child.webContents.invalidate(); await wait(160); const image = await child.webContents.capturePage(); assert.ok(!image.isEmpty()); await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename); };
  const delta = (record, text) => { if (!record.response.destroyed) record.response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n'); };
  const finish = (record, text = '') => {
    if (text) delta(record, text); record.finished = true; clearInterval(record.heartbeat);
    if (!record.response.destroyed) {
      record.response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      record.response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 14 } }) + '\n\n');
      record.response.end('data: [DONE]\n\n');
    }
  };
  const server = http.createServer(async (request, response) => {
    try {
      const source = Object.keys(keys).find(name => request.headers.authorization === 'Bearer ' + keys[name]);
      assert.ok(source, 'Only the three isolated fixture credentials may reach the server');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: Object.entries(models).map(([role, id]) => ({ id, supportsTools: role === 'main', textCompatible: true })) })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 500000); }
      const body = JSON.parse(raw); assert.equal(body.stream, true); assert.equal(body.model, models[source]);
      const user = body.messages.filter(message => message.role === 'user').at(-1);
      let payload; try { payload = JSON.parse(user?.content); } catch {}
      const kind = body.tools?.length ? 'main' : payload && Object.hasOwn(payload, 'draft') ? 'completion' : 'sidebar';
      const record = { source, kind, body, payload, response, finished: false, aborted: false }; records.push(record);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.write(': role fixture heartbeat\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.finished) response.write(': role fixture heartbeat\n\n'); }, 150);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.finished) record.aborted = true; });
      if (kind === 'main' && user?.content.includes(mainPrompt)) finish(record, answer);
      else if (kind === 'main') { assert.ok(user?.content.includes('HOLD_MAIN')); delta(record, '主任务处理中。'); }
      else if (kind === 'completion') finish(record, JSON.stringify({ continuation: source === 'completion' ? '，这是独立补全。' : '，这是主模型补全。' }));
      else {
        assert.equal(body.tools?.length || 0, 0); const question = payload?.question ?? user?.content; assert.equal(typeof question, 'string');
        assert.ok(!raw.includes(mainPrompt) && !raw.includes('MAIN_PRIVATE_ANSWER_'), 'Side chat cannot receive main conversation history');
        if (/STOP_SIDE|HIDE_SIDE/u.test(question)) delta(record, '这段回复正在输出，等待后续内容。');
        else {
          delta(record, '独立问答：');
          const timer = setTimeout(() => finish(record, '已根据引用解释，未执行任何项目操作。'), 240); record.replyTimer = timer;
        }
      }
    } catch (error) { problems.push(error.message); if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); if (!response.destroyed) response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  const configure = async role => {
    await js(`window.aiCodeCommands.execute(${JSON.stringify('role-' + role + '-settings')})`);
    await until('role form opens', () => js(`$('settings-dialog').open&&settingsRole===${JSON.stringify(role)}`));
    await js(`(()=>{$('provider-select').value='relay';$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));$('api-protocol-select').value='chat-completions';$('api-protocol-select').dispatchEvent(new Event('change',{bubbles:true}));$('base-url-input').value=${JSON.stringify(baseUrl)};$('api-key-input').value=${JSON.stringify(keys[role])};for(const id of ['base-url-input','api-key-input'])$(id).dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await click('#settings-model-refresh');
    await until('role catalog includes text-only model', () => js(`Boolean(settingsCatalog?.models.some(m=>m.id===${JSON.stringify(models[role])})&&!settingsCatalogLoading)`));
    const selectable = await js(`(()=>{const n=[...$('chatgpt-model-select').options].find(n=>n.value===${JSON.stringify(models[role])});return {disabled:n?.disabled,text:n?.textContent}})()`);
    assert.equal(selectable.disabled, false);
    await js(`$('chatgpt-model-select').value=${JSON.stringify(models[role])};$('chatgpt-model-select').dispatchEvent(new Event('change',{bubbles:true}));true;`);
    await click('#save-settings');
    await until('role saved', async () => (await call('getState')).roleModels[role].enabled && await js(`!$('settings-dialog').open&&!settingsSaving`));
    const saved = await call('getState'); assert.equal(saved.roleModels[role].settings.model, models[role]); assert.deepEqual(saved.settings, mainSettings);
    assert.ok(!JSON.stringify(saved).includes(keys[role]));
  };
  const sendSide = async text => {
    const count = records.length;
    await js(`$('side-chat-input').value=${JSON.stringify(text)};$('side-chat-input').dispatchEvent(new Event('input',{bubbles:true}));true;`);
    await click('#side-chat-send');
    return until('sidebar request arrives', () => records.length > count && records.at(-1).kind === 'sidebar' && records.at(-1));
  };
  const sideIdle = () => until('side answer completed', async () => { const value = (await call('getState')).sideChat; return !value.running && value.messages.at(-1)?.status === 'completed'; });
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen()); child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive();
    await until('renderer initialized', () => js('Boolean(appState&&window.synoraRoleModels&&sideChatControls&&!projectSwitching)'));
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('project opened', async () => (await call('getState')).workspace.root === project && await js('!projectSwitching'));
    const original = await call('getState');
    for (const role of ['subagent', 'approval', 'completion', 'sidebar', 'pet']) assert.equal(original.roleModels[role].enabled, false);
    await call('saveSettings', { provider: 'deepseek', model: models.main, baseUrl, apiKey: keys.main, reasoningEffort: 'default', maxSteps: 4 });
    await call('listModels', { force: true }); mainSettings = (await call('getState')).settings;

    stage = 'settings menu and four default following roles';
    await click('#menu-settings'); await click('#app-menu-popup [data-action="role-settings"]');
    const list = await js(`[...document.querySelectorAll('#role-models-list .role-model-row')].map(n=>({role:n.dataset.role,text:n.textContent}))`);
    assert.deepEqual(list.map(item => item.role), ['subagent', 'approval', 'completion', 'sidebar', 'pet']); assert.ok(list.every(item => item.text.includes('跟随主模型')));
    assert.equal(await js(`Boolean(document.querySelector('#role-models-dialog .role-models-intro'))`), false);
    await capture('role-defaults.png'); await click('#role-models-close');
    await configure('sidebar');
    await click('#toggle-side-chat');
    await until('empty side panel opened', () => js(`!$('side-chat-panel').hidden`));
    assert.equal(await js(`$('side-chat-messages').textContent`), '', 'The empty sidebar has no instructional placeholder');
    assert.equal(await js(`Boolean(document.querySelector('.side-chat-empty'))`), false);
    await capture('role-sidebar-empty.png'); await click('#side-chat-close');

    stage = 'main history then native selected-text sidebar quote';
    await call('submitPrompt', { text: mainPrompt, mode: 'queue' });
    await until('main answer completed', async () => !(await call('getState')).activeTask.running && await js(`$('messages').textContent.includes(${JSON.stringify(quote)})`));
    await js(`window.__roleSmokeInputs=[];document.addEventListener('contextmenu',e=>window.__roleSmokeInputs.push({type:'contextmenu',trusted:e.isTrusted}),true);true;`);
    const selected = await js(`(()=>{const node=[...document.querySelectorAll('#messages .message.assistant .message-body')].find(n=>n.textContent.includes(${JSON.stringify(quote)}));node.scrollIntoView({block:'center',behavior:'instant'});const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){const i=n.textContent.indexOf(${JSON.stringify(quote)});if(i>=0){const range=document.createRange();range.setStart(n,i);range.setEnd(n,i+${quote.length});const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);const r=range.getBoundingClientRect();return {x:Math.round(r.left+5),y:Math.round(r.top+r.height/2),text:selection.toString()}}}throw new Error('Missing quote')})()`);
    assert.equal(selected.text, quote); await pointer({ x: selected.x, y: selected.y }, 'right');
    await until('native quote menu', () => js(`!$('chat-selection-menu').hidden&&!document.querySelector('[data-chat-action="ask"]').disabled`));
    await click('[data-chat-action="ask"]');
    await until('quote filled in side panel', () => js(`!$('side-chat-panel').hidden&&document.querySelector('.side-chat-quote-draft blockquote').textContent===${JSON.stringify(quote)}`));
    const quoted = await sendSide('请解释选中的文字'); assert.equal(quoted.source, 'sidebar'); assert.equal(quoted.payload.quotedText, quote); await sideIdle();
    assert.ok((await js('window.__roleSmokeInputs')).some(value => value.trusted));

    stage = 'main task and sidebar can run concurrently';
    await call('submitPrompt', { text: 'HOLD_MAIN_' + nonce, mode: 'queue' });
    const held = await until('main held request', () => records.find(record => record.kind === 'main' && !record.finished));
    assert.equal((await call('getState')).activeTask.running, true);
    const concurrent = await sendSide('主任务进行时只做文字问答'); assert.equal(concurrent.source, 'sidebar'); await sideIdle();
    assert.equal((await call('getState')).activeTask.running, true); finish(held, '主任务完成。');
    await until('main idle again', async () => !(await call('getState')).activeTask.running && await js('!running'));

    stage = 'stop cancels but closing only hides and preserves side streams';
    const stopped = await sendSide('STOP_SIDE');
    await until('side partial streamed', () => js(`$('side-chat-messages').textContent.includes('这段回复正在输出')`)); await click('#side-chat-stop');
    await until('side request cancelled', () => stopped.aborted);
    assert.equal((await call('getState')).sideChat.messages.at(-1).status, 'stopped');
    const hiddenStream = await sendSide('HIDE_SIDE'); const stale = (await call('getState')).sideChat;
    await click('#side-chat-close');
    await until('side panel hidden without cancelling', async () => !(await call('getState')).sideChat.open && await js(`$('side-chat-panel').hidden`));
    const hidden = (await call('getState')).sideChat;
    assert.equal(hidden.running, true); assert.equal(hiddenStream.aborted, false);
    assert.deepEqual(hidden.messages, stale.messages);
    await js(`sideChatControls.apply(${JSON.stringify(stale)},appState.workspaceId);true;`);
    assert.equal(await js(`$('side-chat-panel').hidden`), true, 'A delayed pre-hide snapshot cannot reopen the panel');
    delta(hiddenStream, '隐藏期间仍继续输出 HIDDEN_STREAM_DELTA。');
    await until('hidden stream continues', async () => (await call('getState')).sideChat.messages.at(-1)?.content.includes('HIDDEN_STREAM_DELTA'));
    assert.equal(await js(`$('side-chat-panel').hidden`), true); assert.equal(hiddenStream.aborted, false);
    finish(hiddenStream, '后台回复已完成 HIDDEN_STREAM_FINISHED。'); await sideIdle();
    const retained = (await call('getState')).sideChat;
    assert.equal(retained.open, false); assert.equal(await js(`$('side-chat-panel').hidden`), true);
    assert.equal(retained.messages.length, stale.messages.length); assert.ok(retained.messages.at(-1).content.includes('HIDDEN_STREAM_FINISHED'));

    stage = 'renderer reload and reopening retain in-memory side history';
    await bounded(new Promise(resolve => { child.webContents.once('did-finish-load', resolve); child.webContents.reload(); }), 'renderer reload');
    await until('reloaded renderer initialized', () => js('Boolean(appState&&window.synoraRoleModels&&sideChatControls&&!projectSwitching)'));
    assert.equal((await call('getState')).workspace.root, project);
    assert.deepEqual((await call('getState')).sideChat.messages, retained.messages);
    assert.equal(await js(`$('side-chat-panel').hidden`), true);
    await click('#toggle-side-chat');
    await until('reopened with retained messages', () => js(`!$('side-chat-panel').hidden&&$('side-chat-messages').textContent.includes('HIDDEN_STREAM_FINISHED')`));
    assert.equal(await js(`document.querySelectorAll('#side-chat-messages .side-chat-message').length`), retained.messages.length);
    await sendSide('这是一段用于检查主题和布局的临时问答'); await sideIdle();

    stage = 'white and industrial themes at minimum 980px layout'; child.setContentSize(980, 900);
    for (const style of ['white', 'industrial']) {
      await call('setAppearance', { uiStyle: style, selectionColor: null }); await js('window.synoraAppearance.settled()');
      await until('theme applied', () => js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`));
      const layout = await js(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {style:document.documentElement.dataset.uiStyle,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,panel:rect($('side-chat-panel')),input:rect($('side-chat-input')),send:rect($('side-chat-send')),help:rect($('menu-help')),conversation:rect(document.querySelector('.conversation'))}})()`);
      assert.equal(layout.width, 980); assert.equal(layout.overflow, false); assert.ok(layout.panel.right <= 981 && layout.panel.left >= 0); assert.ok(layout.input.width > 200); assert.ok(layout.send.right <= layout.panel.right); assert.ok(layout.conversation.width > 250); layouts.push(layout);
      await capture(`role-sidebar-${style}-980.png`);
      await js(`window.synoraRoleModels.open('sidebar')`); await until('scoped settings shown', () => js(`$('settings-dialog').open&&settingsRole==='sidebar'`));
      const form = await js(`(()=>{const r=$('settings-dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,title:$('settings-title').textContent,hint:$('settings-scope-hint').textContent}})()`);
      assert.ok(form.left >= 0 && form.right <= 981 && form.top >= 0 && form.bottom <= 901); assert.match(form.hint, /独立配置/u);
      await capture(`role-settings-${style}-980.png`); await click('#close-settings');
      await call('setAppearance', { selectionColor: '#63b77b' }); await js('window.synoraAppearance.settled()');
      await js(`$('side-chat-input').value='仅检查颜色，不发送';$('side-chat-input').dispatchEvent(new Event('input',{bubbles:true}));$('side-chat-input').focus();true;`);
      await until('custom palette transitions settled', () => js(`document.documentElement.dataset.selectionColor==='custom'&&![$('side-chat-send'),$('side-chat-input')].flatMap(node=>node.getAnimations()).some(animation=>animation.playState==='running'&&Number.isFinite(animation.effect?.getComputedTiming().endTime))`));
      const palette = await js(`(()=>{const s=getComputedStyle($('side-chat-send')),i=getComputedStyle($('side-chat-input'));return {style:document.documentElement.dataset.uiStyle,custom:document.documentElement.dataset.selectionColor,sendBackground:s.backgroundColor,inputOutline:i.outlineColor,sendDisabled:$('side-chat-send').disabled}})()`);
      assert.equal(palette.custom, 'custom'); assert.equal(palette.sendDisabled, false);
      assert.equal(palette.sendBackground, 'rgb(99, 183, 123)'); assert.equal(palette.inputOutline, 'rgb(99, 183, 123)'); palettes.push(palette);
      if (style === 'industrial') await capture('role-sidebar-industrial-custom-980.png');
      await js(`$('side-chat-input').value='';$('side-chat-input').dispatchEvent(new Event('input',{bubbles:true}));true;`);
    }
    child.setContentSize(1440, 1000);

    stage = 'independent Tab completion and restoring main model';
    await click('#side-chat-close'); await configure('completion');
    const complete = async (draft, expectedSource) => {
      const count = records.length;
      await js(`(()=>{const n=$('task-input');n.value=${JSON.stringify(draft)};n.dispatchEvent(new Event('input',{bubbles:true}));n.focus();n.setSelectionRange(n.value.length,n.value.length);return true})()`);
      await key('Tab');
      const record = await until('completion fixture request', () => records.length > count && records.at(-1).kind === 'completion' && records.at(-1));
      assert.equal(record.source, expectedSource); await until('Tab result inserted', () => js(`$('task-input').value.includes(${JSON.stringify(expectedSource === 'completion' ? '独立补全' : '主模型补全')})`));
    };
    await complete('补充检查', 'completion');
    await js(`window.synoraRoleModels.openList()`); await click('[data-role="completion"] .role-model-actions .text-button');
    await until('completion follows again', async () => !(await call('getState')).roleModels.completion.enabled); await click('#role-models-close');
    await complete('继续检查', 'main');
    await js(`window.synoraRoleModels.openList()`); await click('[data-role="sidebar"] .role-model-actions .text-button');
    await until('sidebar follows again', async () => !(await call('getState')).roleModels.sidebar.enabled); await click('#role-models-close');
    await click('#toggle-side-chat'); const followed = await sendSide('恢复跟随后的临时问答'); assert.equal(followed.source, 'main'); await sideIdle();
    assert.deepEqual((await call('getState')).settings, mainSettings);
    const session = await call('getCurrentSession');
    assert.equal(session.messages.filter(message => message.role === 'user').length, 2, 'Side questions and completions never enter the main conversation');
    stage = 'temporary side text never persists in session or metadata';
    const sideUsage = await until('side usage metadata saved', async () => {
      const ledger = JSON.parse(await fs.readFile(path.join(dataDir, 'usage.json'), 'utf8'));
      const selected = ledger.records.filter(record => record.purpose === 'side-chat');
      return selected.length === records.filter(record => record.kind === 'sidebar').length && selected;
    });
    const sessionFiles = (await fs.readdir(path.join(dataDir, 'sessions'))).filter(name => name.endsWith('.json'));
    assert.ok(sideUsage.every(record => record.sessionId !== session.id && !sessionFiles.includes(record.sessionId + '.json')),
      'Side usage has independent session identifiers without persistent side sessions');
    const persistedFiles = ['role-models.json', 'settings.json', 'usage.json', ...sessionFiles.map(name => path.join('sessions', name))];
    const persisted = await Promise.all(persistedFiles.map(name => fs.readFile(path.join(dataDir, name), 'utf8')));
    const privateSideText = records.filter(record => record.kind === 'sidebar').map(record => record.payload?.question ?? record.body.messages.filter(message => message.role === 'user').at(-1).content);
    privateSideText.push('独立问答：', '这段回复正在输出，等待后续内容。', 'HIDDEN_STREAM_DELTA', 'HIDDEN_STREAM_FINISHED', ...Object.values(keys));
    for (const [index, text] of persisted.entries()) for (const forbidden of privateSideText)
      assert.ok(!text.includes(forbidden), 'Temporary side content or plaintext key persisted in ' + persistedFiles[index]);
    const storedRoles = JSON.parse(persisted[0]);
    for (const role of ['sidebar', 'completion']) {
      assert.equal(storedRoles.roles[role].enabled, false);
      assert.ok(storedRoles.roles[role].settings.providers.relay.encryptedKey, 'Reset retains only the saved encrypted key');
    }
    assert.deepEqual(problems, []);
    const evidence = { status: 'completed', realApi: false, isolatedRegisteredChild: true, fourDefaultRoles: true,
      sharedScopedForm: true, textOnlyModels: true, mainConfigurationUnchanged: true, separateRequestKeysAndModels: true,
      nativeContextMenu: true, exactQuoteOnly: true, noMainHistoryInSideChat: true, concurrentWithMainTask: true,
      streamedResponses: true, stopAborts: true, closeOnlyHides: true, hiddenStreamContinues: true,
      hiddenCompletionStaysHidden: true, reloadRetainsHistory: true, reopenRetainsHistory: true, staleStateRejected: true,
      emptySidebarHasNoHint: true, roleIntroRemoved: true,
      independentTabCompletion: true, resetFollowsMain: true, temporaryTextNotPersisted: true,
      sideUsageIsolatedFromMainSession: true, customAccentVerifiedThemes: ['white', 'industrial'], modelRequests: records.length, layouts, palettes, screenshots };
    await fs.writeFile(path.join(output, 'role-models-evidence.json'), JSON.stringify(evidence, null, 2)); return evidence;
  } catch (error) {
    if (child && !child.isDestroyed()) await capture('role-models-failure.png').catch(() => {});
    const diagnostic = { stage, message: error.message, problems,
      requests: records.map(({ source, kind, finished, aborted }) => ({ source, kind, finished, aborted })),
      renderer: child && !child.isDestroyed() ? await js(`({notice:$('notice').textContent,settingsError:$('settings-error').textContent,settingsRole,settingsSaving,running,sideError:$('side-chat-error')?.textContent})`).catch(() => null) : null };
    await fs.writeFile(path.join(output, 'role-models-failure.json'), JSON.stringify(diagnostic, null, 2));
    console.error('ROLE_MODELS_SMOKE_DIAGNOSTIC', JSON.stringify(diagnostic));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) { await call('stopTask').catch(() => {}); await call('sideChatClose').catch(() => {}); child.close(); }
    for (const record of records) { clearInterval(record.heartbeat); clearTimeout(record.replyTimer); }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  }
};
