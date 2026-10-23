// Native composer Tab/Ctrl+Z/Shift+Tab/Escape with a loopback-only model.
// The IME guard is an explicitly synthetic composing keyboard event fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokePromptCompletion({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Prompt completion smoke requires isolated offscreen UI');
  const nonce = randomUUID(), project = path.join(dataDir, 'prompt-completion-project-' + nonce);
  const firstPrompt = '请解释这个项目的测试方式。FIRST_PROMPT_' + nonce;
  const firstAnswer = '可以先检查边界条件，再运行测试。FIRST_ANSWER_' + nonce;
  const draft = '继续检查', continuation = '边界条件，并补充测试覆盖。';
  const records = [], problems = [], screenshots = [];
  let child, configured = false, stage = 'isolated app setup', sessionId;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Prompt completion smoke timed out: ' + label);
  };
  const js = code => child.webContents.executeJavaScript(code);
  const call = (name, arg) => js(`window.forge[${JSON.stringify(name)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const snapshot = () => js(`({draft:$('task-input').value,focused:document.activeElement===$('task-input'),sessionId:appState?.sessionId||sessionId,running,promptSubmitting,userMessages:document.querySelectorAll('#messages .message.user').length,tools:document.querySelectorAll('#messages .tool-card').length,keys:window.__completionSmoke.keys,events:window.__completionSmoke.events})`);
  const setDraft = text => js(`(()=>{const input=$('task-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(input.value.length,input.value.length);return true;})()`);
  const key = async (keyCode, modifiers = []) => {
    child.focus(); child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(50);
  };
  const capture = async name => { child.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); screenshots.push(name); };
  const reply = (record, content) => {
    assert.ok(!record.released && !record.aborted, 'Held fixture request must be active before reply');
    record.released = true; clearInterval(record.heartbeat);
    record.response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] }) + '\n\n');
    record.response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }) + '\n\n');
    record.response.end('data: [DONE]\n\n');
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer forgedesk-prompt-completion-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'smoke-prompt-completion-model', supportsTools: true }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 300_000); }
      const body = JSON.parse(raw); assert.equal(body.model, 'smoke-prompt-completion-model'); assert.equal(body.stream, true);
      const isCompletion = !body.tools?.length;
      const record = { body, response, isCompletion, released: false, aborted: false }; records.push(record);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.write(': prompt completion fixture heartbeat\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.released) response.write(': prompt completion fixture heartbeat\n\n'); }, 150);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.released && !response.writableFinished) record.aborted = true; });
      if (!isCompletion) {
        assert.equal(records.length, 1, 'Completion must never send the filled prompt as a normal task');
        assert.ok(raw.includes(firstPrompt)); reply(record, firstAnswer); return;
      }
      assert.equal(body.messages.filter(message => message.role === 'system').length, 1);
      assert.equal(body.messages.filter(message => message.role === 'user').length, 1);
      record.payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
      assert.ok(Array.isArray(record.payload.conversation));
      assert.ok(record.payload.conversation.some(message => message.role === 'user' && message.content.includes(firstPrompt)));
      assert.ok(record.payload.conversation.some(message => message.role === 'assistant' && message.content.includes(firstAnswer)));
      assert.ok(record.payload.conversation.every(message => ['user', 'assistant'].includes(message.role) && !message.toolCalls && !message.attachments));
      assert.equal(typeof record.payload.draft, 'string');
    } catch (error) {
      problems.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      if (!response.destroyed) response.end(JSON.stringify({ error: { code: 'prompt_completion_smoke_contract', message: error.message } }));
    }
  });
  const nextCompletion = async previous => {
    await key('Tab');
    return until('native Tab starts one completion request', () => { assert.deepEqual(problems, []); return records.length === previous + 1 && records.at(-1).isCompletion && records.at(-1); });
  };
  const noTask = async label => {
    const state = await call('getState'), value = await snapshot();
    assert.equal(state.activeTask.running, false, label + ': completion does not run a task');
    assert.equal(state.promptQueue.items.length, 0, label + ': completion does not queue a task');
    assert.equal(value.tools, 0, label + ': completion cannot invoke tools');
    assert.equal(value.events.filter(event => ['user-message', 'run-start', 'tool-start'].includes(event.type)).length, 2, label + ': only the original user prompt/run may exist');
    return value;
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.focus(); child.webContents.focus();
    await until('renderer initialized', () => js('Boolean(appState&&window.forge&&!projectSwitching)'));
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('project selected', async () => (await call('getState')).workspace.root === project && await js('!projectSwitching'));
    await call('saveSettings', { provider: 'deepseek', model: 'smoke-prompt-completion-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-prompt-completion-key', reasoningEffort: 'default', maxSteps: 4 }); configured = true;
    await call('listModels', { force: true });
    await js(`(()=>{window.__completionSmoke={events:[],keys:[]};window.__completionSmoke.off=window.forge.onEvent(event=>window.__completionSmoke.events.push(event));$('task-input').addEventListener('keydown',event=>window.__completionSmoke.keys.push({key:event.key,trusted:event.isTrusted,shift:event.shiftKey,composing:event.isComposing}));return true;})()`);

    stage = 'real completed turn supplies conversation context';
    assert.equal((await call('submitPrompt', { text: firstPrompt, mode: 'queue' })).disposition, 'started');
    await until('original run completed', async () => (await snapshot()).events.some(event => event.type === 'run-end' && event.status === 'completed'));
    await until('app idle', async () => !(await call('getState')).activeTask.running && await js('!running&&!promptSubmitting'));
    sessionId = (await call('getState')).sessionId;
    await setDraft(draft); await wait(400);
    assert.equal(records.length, 1, 'Typing must not silently call the model before Tab');
    await noTask('before completion');

    stage = 'native Tab fills a contextual continuation without sending';
    const first = await nextCompletion(1); assert.equal(first.payload.draft, draft);
    await until('loading hint visible', () => js(`$('prompt-completion-hint')?.dataset.status==='loading'&&$('prompt-completion-hint').checkVisibility({visibilityProperty:true,opacityProperty:true})`));
    await key('Tab'); await wait(100); assert.equal(records.length, 2, 'Repeated Tab while pending must not duplicate requests');
    await noTask('pending completion'); await capture('prompt-completion-pending.png');
    reply(first, JSON.stringify({ continuation }));
    await until('completion inserted into composer', async () => (await snapshot()).draft === draft + continuation);
    assert.equal(await js(`$('prompt-completion-hint').dataset.status`), 'completed');
    const completed = await noTask('completed suggestion'); assert.equal(completed.userMessages, 1);
    await capture('prompt-completion-filled.png');
    await key('z', ['control']);
    await until('native Ctrl+Z restores the exact original draft', async () => (await snapshot()).draft === draft);

    stage = 'Shift+Tab keeps ordinary focus traversal';
    await setDraft(draft); const beforeShift = records.length; await key('Tab', ['shift']); await wait(120);
    assert.equal(records.length, beforeShift); assert.equal((await snapshot()).focused, false); assert.equal((await snapshot()).draft, draft);

    stage = 'synthetic IME composing Tab guard';
    await setDraft(draft);
    const composing = await js(`(()=>{const event=new KeyboardEvent('keydown',{key:'Tab',code:'Tab',isComposing:true,bubbles:true,cancelable:true});$('task-input').dispatchEvent(event);return {prevented:event.defaultPrevented,composing:event.isComposing,trusted:event.isTrusted};})()`);
    assert.deepEqual(composing, { prevented: false, composing: true, trusted: false }); await wait(120); assert.equal(records.length, beforeShift);

    stage = 'editing an in-flight draft cancels the request';
    await setDraft('编辑期间'); const editing = await nextCompletion(records.length);
    await child.webContents.insertText('新内容');
    await until('draft edit aborts outstanding request', () => editing.aborted);
    assert.equal((await snapshot()).draft, '编辑期间新内容'); await noTask('edit cancels suggestion');

    stage = 'Escape cancels and preserves the current draft';
    await setDraft('保留这个草稿'); const escaped = await nextCompletion(records.length); await key('Escape');
    await until('Escape aborts outstanding completion', () => escaped.aborted);
    assert.equal((await snapshot()).draft, '保留这个草稿'); await noTask('Escape cancels suggestion');

    stage = 'switching sessions prevents late completion from filling another chat';
    await setDraft('切换前草稿'); const switched = await nextCompletion(records.length);
    await js('newSession()');
    await until('new session selected', async () => (await call('getState')).sessionId !== sessionId);
    await setDraft('新会话草稿');
    await until('session switch aborts outstanding completion', () => switched.aborted);
    assert.equal((await snapshot()).draft, '新会话草稿'); await noTask('new session remains untouched');

    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', sessionId + '.json'), 'utf8'));
    assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(saved.messages.filter(message => message.role === 'assistant').length, 1);
    assert.ok(!saved.messages.some(message => message.role === 'tool'));
    const keys = (await snapshot()).keys; assert.ok(keys.some(event => event.trusted && event.key === 'Tab' && !event.shift));
    assert.ok(keys.some(event => event.trusted && event.key === 'Tab' && event.shift));
    assert.ok(keys.some(event => event.trusted && event.key === 'Escape'));
    assert.deepEqual(problems, []);
    const evidence = { status: 'completed', realApi: false, modelRequests: records.length, originalCompletedTurn: true, contextualDraft: true,
      nativeTabAndUndo: true, neverAutoSubmitted: true, noBackgroundRequests: true, noToolsOrQueuedTasks: true, editingCancels: true,
      escapeCancels: true, sessionSwitchCancels: true, shiftTabTraversal: true, syntheticIMEGuard: composing, screenshots };
    await fs.writeFile(path.join(output, 'prompt-completion-evidence.json'), JSON.stringify(evidence, null, 2)); return evidence;
  } catch (error) {
    const renderer = child && !child.isDestroyed() ? await snapshot().catch(() => null) : null;
    console.error('PROMPT_COMPLETION_SMOKE_DIAGNOSTIC', JSON.stringify({ stage, message: error.message, problems, requests: records.map(record => ({ isCompletion: record.isCompletion, draft: record.payload?.draft, released: record.released, aborted: record.aborted })), renderer }));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      await call('stopTask').catch(() => {});
      if (configured) await call('saveSettings', { provider: 'deepseek', model: '', baseUrl: 'https://api.deepseek.com', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
      await js('window.__completionSmoke?.off?.();').catch(() => {}); child.close();
    }
    for (const record of records) clearInterval(record.heartbeat);
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  }
};
