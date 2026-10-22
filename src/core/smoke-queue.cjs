// Queue/steering integration against a held loopback Responses fixture. No real account or clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, dialog } = require('electron');

module.exports = async function smokeQueue({ win, output, dataDir, readState }) {
  const js = async (code, target = win) => {
    let timer;
    try { return await Promise.race([target.webContents.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Queue renderer call timed out: ' + code.slice(0, 70))), 8000); })]); }
    finally { clearTimeout(timer); }
  };
  const call = (method, arg, target = win) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`, target);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Queue smoke timed out: ' + label);
  };
  const suffix = randomUUID();
  const marker = name => `QUEUE_SMOKE_${name}_${suffix}`;
  const markers = Object.fromEntries(['FIFO_START', 'FIFO_ONE', 'FIFO_TWO', 'REMOVED', 'STEER_START', 'STEERING', 'STOP_START', 'STOP_WAIT', 'FAIL_START', 'FAIL_WAIT'].map(name => [name, marker(name)]));
  const prompts = Object.fromEntries(Object.entries(markers).map(([name, value]) => [name, `${({ FIFO_START: '正在处理当前任务', FIFO_ONE: '排队任务一', FIFO_TWO: '排队任务二', REMOVED: '应删除且不发送的任务', STEER_START: '继续当前实现', STEERING: '补充要求：先检查边界条件', STOP_START: '等待停止的任务', STOP_WAIT: '停止后等待继续', FAIL_START: '模拟失败的当前任务', FAIL_WAIT: '失败后等待继续' })[name]} · ${value}`]));
  const editedSteering=prompts.STEERING+'（编辑后：补充异常、空值与退出行为。）';
  const records = [];
  const problems = [];
  const originalOpen = dialog.showOpenDialog;
  let other;
  let installed = false;
  let configured = false;
  const originalWindow={bounds:win.getBounds(),opacity:win.getOpacity(),visible:win.isVisible()};
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('\n') : '';
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer forgedesk-queue-smoke-key');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 1_000_000) throw new Error('Oversized queue fixture request');
      }
      const body = JSON.parse(raw);
      assert.equal(body.model, 'smoke-queue-model');
      const latestUser = (body.input || []).filter(item => item.role === 'user').at(-1);
      const text = textOf(latestUser?.content);
      const name = Object.keys(markers).find(key => text.includes(markers[key]));
      if (!name) throw new Error('Queue fixture received an unexpected user message');
      if(name==='STEERING')assert.equal(text,editedSteering,'Steering must send the edited pending text');
      const record = { name, body, response, released: false, aborted: false };
      records.push(record);
      // A held response proves queue/steer changes do not abort the current request.
      response.once('close', () => { if (!record.released && !response.writableFinished) record.aborted = true; });
    } catch (error) {
      problems.push(error.message);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message, code: 'queue_smoke_contract' } }));
    }
  });
  const release = (record, failed = false) => {
    assert.ok(record && !record.released && !record.aborted, 'Held request was unavailable or aborted');
    record.released = true;
    record.response.writeHead(failed ? 401 : 200, { 'Content-Type': 'application/json' });
    record.response.end(JSON.stringify(failed
      ? { error: { message: 'Queue smoke simulated provider failure', code: 'queue_smoke_failure' } }
      : { id: 'resp_' + randomUUID(), status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `本机测试回复：${record.name}` }] }], usage: { input_tokens: 3, output_tokens: 2 } }));
  };
  const requestFor = name => until('request ' + name, () => records.find(record => record.name === name));
  const state = () => call('getState');
  const log = () => js('window.__aiCodeQueueSmoke.events');
  const resetLog = () => js('window.__aiCodeQueueSmoke.events.length = 0');
  const sourceEvents = events => events.filter(event => event.type === 'user-message');
  const submitComposer = text => js(`(()=>{
    const input=document.getElementById('task-input');
    if(input.disabled)throw new Error('Composer input disabled');
    input.value=${JSON.stringify(text)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('task-form').requestSubmit();
  })()`);
  const completed = async count => until('completed runs ' + count, async () => {
    const observed = await state();
    const events = await log();
    return !observed.activeTask.running && !observed.promptQueue.items.length && events.filter(event => event.type === 'run-end').length >= count && observed;
  });
  const capture = async name => {
    win.webContents.invalidate();
    await wait(120);
    await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const assertAbsent = (value, name, message) => assert.ok(!JSON.stringify(value).includes(markers[name]), message || name + ' unexpectedly entered context');
  const nativeClick=async selector=>{
    const point=await until('revealed native queue action '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility())return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    win.focus();win.webContents.focus();win.webContents.sendInputEvent({type:'mouseMove',...point});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(40);
  };
  const typeEditor=async text=>{await nativeClick('#pending-edit-input');win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await until('native select-all reached pending editor',()=>js(`$('pending-edit-input').selectionStart===0&&$('pending-edit-input').selectionEnd===$('pending-edit-input').value.length`));await win.webContents.insertText(text);assert.equal(await js(`$('pending-edit-input').value`),text,'Native editor input must reach the actual textarea');};
  try {
    win.setContentSize(1440,1000);win.setOpacity(0);win.showInactive();win.focus();win.webContents.focus();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const fixture = path.join(dataDir, 'project');
    await fs.mkdir(fixture, { recursive: true });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    await call('chooseWorkspace');
    await call('newSession');
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: 'smoke-queue-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-queue-smoke-key', reasoningEffort: 'default', maxSteps: 8 });
    configured = true;
    const initial = await state();
    assert.ok(initial.promptQueue && Array.isArray(initial.promptQueue.items), 'Missing promptQueue state');
    assert.equal(initial.activeTask.running, false);
    await js(`(()=>{
      for(const method of ['submitPrompt','managePendingPrompt','resumePendingPrompts'])if(typeof window.forge[method]!=='function')throw new Error('Missing '+method+' bridge');
      window.__aiCodeQueueSmoke={events:[]};
      window.__aiCodeQueueSmoke.off=window.forge.onEvent(event=>window.__aiCodeQueueSmoke.events.push(event));
      if(!document.getElementById('terminal-panel').hidden)document.getElementById('terminal-close').click();
      if(!document.getElementById('preview-panel').hidden)document.getElementById('close-preview').click();
    })()`);
    installed = true;

    // Two queued tasks stay out of the current context and become separate FIFO runs.
    const beforeFIFO = initial.usageStats.day;
    await submitComposer(prompts.FIFO_START);
    const direct = await until('composer direct user-message', async () => sourceEvents(await log()).find(event => event.source === 'direct' && event.text === prompts.FIFO_START));
    const first = await requestFor('FIFO_START');
    assert.equal((await state()).activeTask.kind, 'agent');
    await submitComposer(prompts.FIFO_ONE);
    const firstQueued = await until('composer queued item', async () => (await state()).promptQueue.items.find(item => item.text === prompts.FIFO_ONE));
    const secondQueued = await call('submitPrompt', { text: prompts.FIFO_TWO, mode: 'queue' });
    const removed = await call('submitPrompt', { text: prompts.REMOVED, mode: 'queue' });
    assert.equal(firstQueued.mode, 'queue');
    assert.equal(secondQueued.disposition, 'queued');
    assert.equal(removed.disposition, 'queued');
    await until('remove action rendered', () => js(`!!document.querySelector('.pending-prompt[data-prompt-id=${JSON.stringify(removed.id)}] .pending-remove')`));
    await nativeClick('.pending-prompt[data-prompt-id='+JSON.stringify(removed.id)+'] .pending-remove');
    await until('card removed pending prompt', async () => !(await state()).promptQueue.items.some(item => item.id === removed.id));
    const waiting = await until('two queued items', async () => {
      const observed = await state();
      return observed.promptQueue.items.length === 2 && observed;
    });
    assert.deepEqual(waiting.promptQueue.items.map(item => item.id), [firstQueued.id, secondQueued.id]);
    assert.deepEqual(waiting.promptQueue.items.map(item => item.mode), ['queue', 'queue']);
    assert.equal(waiting.promptQueue.paused, false);
    assert.equal(waiting.activeTask.demo, false);
    assert.equal(waiting.usageStats.day.requests, beforeFIFO.requests, 'Pending/removed prompts were charged before any response');
    for (const name of ['FIFO_ONE', 'FIFO_TWO', 'REMOVED']) {
      assertAbsent(first.body, name);
      assertAbsent(await call('getCurrentSession'), name, 'Waiting prompt entered saved conversation before consumption');
    }
    const controls = await js(`(()=>{const visible=id=>{const node=document.getElementById(id);return !!node&&!node.hidden&&!!node.getClientRects().length;};return{inputEnabled:!document.getElementById('task-input').disabled,sendEnabled:!document.getElementById('send-button').disabled,sendVisible:visible('send-button'),stopVisible:visible('stop-button'),composerSteerRemoved:!document.getElementById('steer-button'),queueHintRemoved:!document.getElementById('send-mode-hint'),pendingVisible:visible('pending-prompts'),cards:document.querySelectorAll('#pending-items .pending-prompt').length};})()`);
    assert.ok(controls.inputEnabled && controls.sendEnabled && controls.sendVisible && controls.stopVisible && controls.composerSteerRemoved && controls.queueHintRemoved && controls.pendingVisible, 'Composer controls or hidden queue/steer affordances are incorrect: ' + JSON.stringify(controls));
    assert.equal(controls.cards, 2);
    assert.equal(await js(`document.querySelectorAll('#pending-count,#pending-status,.pending-prompt-mode').length`),0);
    await capture('queue.png');
    assert.equal(first.aborted, false, 'Queue submission aborted the active response');
    assert.equal(records.length, 1, 'Queued prompts started while the first response was held');
    assert.deepEqual(sourceEvents(await log()).map(event => [event.id, event.source]), [[direct.id, 'direct']]);

    const secondWindow = await call('newWindow');
    other = BrowserWindow.fromId(secondWindow.id);
    assert.ok(other && other !== win);
    const isolated = await call('getState', undefined, other);
    assert.equal(isolated.workspace, null);
    assert.equal(isolated.activeTask.running, false);
    assert.deepEqual(isolated.promptQueue.items, []);
    assert.equal(isolated.promptQueue.paused, false);
    assert.deepEqual((await state()).promptQueue.items.map(item => item.id), [firstQueued.id, secondQueued.id]);
    // Closing destroys this renderer; its JavaScript promise need not resolve.
    other.webContents.executeJavaScript('window.forge.closeWindow()').catch(() => {});
    await until('second window closed', () => other.isDestroyed());

    release(first);
    const one = await requestFor('FIFO_ONE');
    assertAbsent(one.body, 'FIFO_TWO');
    assertAbsent(one.body, 'REMOVED');
    release(one);
    const two = await requestFor('FIFO_TWO');
    assertAbsent(two.body, 'REMOVED');
    release(two);
    const afterFIFO = await completed(3);
    assert.deepEqual(records.map(record => record.name), ['FIFO_START', 'FIFO_ONE', 'FIFO_TWO']);
    assert.deepEqual(sourceEvents(await log()).map(event => [event.id, event.source]), [[direct.id, 'direct'], [firstQueued.id, 'queue'], [secondQueued.id, 'queue']]);
    assert.equal(afterFIFO.usageStats.day.requests - beforeFIFO.requests, 3);
    assert.equal(afterFIFO.usageStats.day.totalTokens - beforeFIFO.totalTokens, 15);
    assertAbsent(await call('getCurrentSession'), 'REMOVED');
    for (const file of (await fs.readdir(path.join(dataDir, 'sessions'))).filter(name => name.endsWith('.json'))) {
      assertAbsent(await fs.readFile(path.join(dataDir, 'sessions', file), 'utf8'), 'REMOVED', 'Removed prompt was persisted');
    }

    // Promotion to steering joins the next model request in the same run, without aborting in-flight work.
    await call('newSession');
    await resetLog();
    const steerStart = await call('submitPrompt', { text: prompts.STEER_START, mode: 'queue' });
    assert.equal(steerStart.disposition, 'started');
    const steerFirst = await requestFor('STEER_START');
    const steering = await call('submitPrompt', { text: prompts.STEERING, mode: 'queue' });
    assert.equal(steering.disposition, 'queued');
    const beforeEdit=(await state()).promptQueue.items.find(item=>item.id===steering.id);
    const steeringCard='.pending-prompt[data-prompt-id='+JSON.stringify(steering.id)+']';
    await nativeClick(steeringCard+' .pending-edit');await typeEditor('此编辑会被取消');await nativeClick('#pending-edit-cancel');
    assert.equal((await state()).promptQueue.items.find(item=>item.id===steering.id).text,prompts.STEERING);
    await nativeClick(steeringCard+' .pending-edit');await typeEditor(editedSteering);await nativeClick('#pending-edit-save');
    await until('edited pending prompt saved',async()=>{const item=(await state()).promptQueue.items.find(item=>item.id===steering.id);return item?.text===editedSteering&&await js(`!$('pending-edit-dialog').open`);});
    const afterEdit=(await state()).promptQueue.items.find(item=>item.id===steering.id);
    assert.equal(afterEdit.id,beforeEdit.id);assert.equal(afterEdit.mode,beforeEdit.mode);assert.deepEqual(afterEdit.attachments,beforeEdit.attachments);
    await until('steer action rendered', () => js(`!!document.querySelector('.pending-prompt[data-prompt-id=${JSON.stringify(steering.id)}] .pending-steer')`));
    await nativeClick(steeringCard+' .pending-steer');
    await until('queued item promoted to steering', async () => (await state()).promptQueue.items.some(item => item.id === steering.id && item.mode === 'steer'));
    assert.equal(steerFirst.aborted, false);
    assertAbsent(steerFirst.body, 'STEERING');
    assert.equal(sourceEvents(await log()).length, 1, 'Steering entered context before the safe model boundary');
    await capture('steering.png');
    release(steerFirst);
    const steerNext = await requestFor('STEERING');
    assert.ok(JSON.stringify(steerNext.body).includes(markers.STEER_START));
    assert.ok(JSON.stringify(steerNext.body).includes('本机测试回复：STEER_START'), 'Follow-up lost completed assistant response');
    const duringSteering = await log();
    assert.equal(duringSteering.filter(event => event.type === 'run-start').length, 1);
    assert.equal(duringSteering.filter(event => event.type === 'run-end').length, 0, 'Steering was deferred to a separate run');
    assert.deepEqual(sourceEvents(duringSteering).map(event => [event.id, event.source]), [[steerStart.id, 'direct'], [steering.id, 'steering']]);
    assert.equal(sourceEvents(duringSteering).at(-1).text,editedSteering);
    await assert.rejects(call('managePendingPrompt',{id:steering.id,action:'edit',text:'CONSUMED_ITEM_MUST_NOT_CHANGE'}),/已发送|移除/u);
    const steerRunId=duringSteering.find(event=>event.type==='run-start').runId,steerSessionId=(await state()).sessionId;
    const assertSteeringPlacement=async label=>{
      const placement=await js(`(()=>{const group=document.querySelector('.task-activity[data-run-id="${steerRunId}"]'),users=[...document.querySelectorAll('.message.user[data-message-id="${steering.id}"]')],user=users[0],before=[...group.querySelectorAll('.message.assistant')].find(n=>n.textContent.includes('本机测试回复：STEER_START'));const after=[...$('messages').querySelectorAll('.message.assistant')].find(n=>n.textContent.includes('本机测试回复：STEERING'));return {users:users.length,inside:!!user?.closest('.task-activity-events'),sameRun:user?.closest('.task-activity')===group,before:!!before&&!!user&&!!(before.compareDocumentPosition(user)&Node.DOCUMENT_POSITION_FOLLOWING),after:!!after&&!!user&&!!(user.compareDocumentPosition(after)&Node.DOCUMENT_POSITION_FOLLOWING),text:user?.querySelector('.message-body')?.textContent};})()`);
      assert.equal(placement.users,1,label);assert.ok(placement.inside&&placement.sameRun&&placement.before&&placement.after,label+': '+JSON.stringify(placement));assert.equal(placement.text,editedSteering);
    };
    release(steerNext);
    await completed(1);
    await assertSteeringPlacement('live steering belongs between completed progress and final response');
    await js(`loadSession(${JSON.stringify(steerSessionId)})`);await until('steering history restored',async()=>(await state()).sessionId===steerSessionId&&await js(`sessionId===${JSON.stringify(steerSessionId)}`));
    await assertSteeringPlacement('history keeps one steering message in the same sequence');

    // Both stop and provider failure pause remaining items until an explicit resume.
    const pauseChecks = [];
    for (const prefix of ['STOP', 'FAIL']) {
      await call('newSession');
      await resetLog();
      const before = (await state()).usageStats.day;
      await call('submitPrompt', { text: prompts[prefix + '_START'], mode: 'queue' });
      const held = await requestFor(prefix + '_START');
      const queued = await call('submitPrompt', { text: prompts[prefix + '_WAIT'], mode: 'queue' });
      assert.equal(queued.disposition, 'queued');
      if (prefix === 'STOP') await call('stopTask');
      else release(held, true);
      const paused = await until(prefix + ' pauses queue', async () => {
        const observed = await state();
        return !observed.activeTask.running && observed.promptQueue.paused && observed;
      });
      assert.deepEqual(paused.promptQueue.items.map(item => item.id), [queued.id]);
      assert.ok(typeof paused.promptQueue.reason === 'string' && paused.promptQueue.reason, 'Paused queue has no reason');
      await wait(150);
      assert.equal(records.filter(record => record.name === prefix + '_WAIT').length, 0, 'Paused queue auto-started');
      assertAbsent(await call('getCurrentSession'), prefix + '_WAIT');
      assert.equal(sourceEvents(await log()).length, 1);
      if (prefix === 'STOP') await until('stopped HTTP response aborted', () => held.aborted);
      await nativeClick('#resume-pending');
      const resumed = await requestFor(prefix + '_WAIT');
      release(resumed);
      const after = await completed(2);
      assert.equal(after.promptQueue.paused, false);
      assert.equal(after.usageStats.day.requests - before.requests, 2);
      assert.equal(after.usageStats.day.totalTokens - before.totalTokens, 5);
      assert.equal(after.usageStats.day.unreportedRequests - before.unreportedRequests, 1);
      assert.deepEqual(sourceEvents(await log()).map(event => event.source), ['direct', 'queue']);
      pauseChecks.push(prefix.toLowerCase());
    }
    assert.deepEqual(records.map(record => record.name), ['FIFO_START', 'FIFO_ONE', 'FIFO_TWO', 'STEER_START', 'STEERING', 'STOP_START', 'STOP_WAIT', 'FAIL_START', 'FAIL_WAIT']);
    assert.deepEqual(problems, []);
    return { status: 'completed', realApi: false, requests: records.length, fifo: true, composerSubmission: true, composerQueue: true, composerQueueAndSteerControlsRemoved: true, cardSteering: true, nativeRemoveViaCard: true, pendingEditCancelAndSave:true,editedTextReachesSteeringModel:true,consumedEditRejected:true,steeringProgressOrderLiveAndHistory:true,pendingExcludedFromContext: true, removedNotSavedOrCharged: true, composerUsableWhileRunning: true, steeringSameRun: true, steeringDidNotAbort: true, pausedOn: pauseChecks, nativeExplicitResume: true, independentWindow: true, screenshots: ['queue.png', 'steering.png'] };
  } catch (error) {
    const observed = readState ? await readState().catch(() => null) : !win.isDestroyed() ? await state().catch(() => null) : null;
    const renderer=!win.isDestroyed()?await js(`({dialog:$('pending-edit-dialog').open,input:$('pending-edit-input').value,editing:pendingPromptEdit,saving:pendingPromptEditSaving,saveDisabled:$('pending-edit-save').disabled,error:$('pending-edit-error').textContent,active:document.activeElement?.id})`).catch(()=>null):null;
    if(!win.isDestroyed())await capture('queue-failure.png').catch(()=>{});
    console.error('QUEUE_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, renderer,requests: records.map(record => ({ name: record.name, released: record.released, aborted: record.aborted })), queue: observed?.promptQueue, activeTask: observed?.activeTask, events: installed && !win.isDestroyed() ? (await log().catch(() => [])).map(event => ({ type: event.type, status: event.status, error: event.error })) : [] }));
    throw error;
  } finally {
    dialog.showOpenDialog = originalOpen;
    if (other && !other.isDestroyed()) other.close();
    if (!win.isDestroyed()) {
      try { await call('stopTask'); } catch {}
    }
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    if (!win.isDestroyed()) {
      try {
        await until('cleanup idle', async () => !(await state()).activeTask?.running, 3_000);
        const remaining = (await state()).promptQueue?.items || [];
        for (const item of remaining) await call('managePendingPrompt', { id: item.id, action: 'remove' });
        if (configured) await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: '', baseUrl: 'https://api.openai.com/v1', clearKey: true, reasoningEffort: 'default' });
      } catch {}
      if (installed) await js('window.__aiCodeQueueSmoke.off(); delete window.__aiCodeQueueSmoke').catch(() => {});
      win.setBounds(originalWindow.bounds);win.setOpacity(originalWindow.opacity);if(!originalWindow.visible)win.hide();
    }
  }
};
