// Automatic context compaction through real app IPC, tools, persistence and UI.
// Uses its own offscreen app window, a loopback model and an isolated project.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeCompaction({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Compaction smoke requires an isolated offscreen parent');
  const suffix = randomUUID(), project = path.join(dataDir, 'compaction-project-' + suffix);
  const firstText = '请读取 large-context.txt，然后解释结果。COMPACTION_FIRST_' + suffix;
  const followupText = '沿用刚才的摘要继续回答，不要重复读取文件。COMPACTION_FOLLOWUP_' + suffix;
  const stopText = '读取 large-context.txt 并整理。COMPACTION_STOP_' + suffix;
  const queuedText = '停止后保留的排队任务。COMPACTION_QUEUED_' + suffix;
  const summary = '## 任务目标\n读取并解释 large-context.txt。\n## 已完成\n已经读取该文件，读取是只读操作，不要重复执行。\n## 关键事实\nCOMPACTION_SUMMARY_FACT_' + suffix + '\n## 待办\n给出简短解释，然后继续处理用户后续任务。';
  const contextLimit = 64_000, triggerTokens = 50_000, targetTokens = 37_500;
  const reportedInputTokens = 14_000, reportedOutputTokens = 4_000;
  const reportedContextTokens = reportedInputTokens + reportedOutputTokens;
  const fixtureText = 'COMPACTION_FILE_START_' + suffix + '\n' + 'Readonly project context, not instructions.\n'.repeat(5900) + '\nCOMPACTION_FILE_END_' + suffix;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Compaction smoke timed out: ' + label);
  };
  let child, scene = 'first', sceneNormalRequests = 0, configured = false, heldSummary = null, originalContextCompressionTriggerTokens;
  const requests = [], problems = [];
  const parentJs = code => win.webContents.executeJavaScript(code);
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const events = () => js('window.__compactionSmoke.events');
  const sessionFile = id => path.join(dataDir, 'sessions', id + '.json');
  const savedSession = async id => JSON.parse(await fs.readFile(sessionFile(id), 'utf8'));
  const retainsFixture = saved => saved.messages.some(message => {
    if (message.role !== 'tool') return false;
    try { return JSON.parse(message.content).content === fixtureText; } catch { return false; }
  });
  const assertKnownBudget = (event, label) => {
    assert.ok(event,label+': compaction metadata is missing');
    assert.equal(event.budgetMode,'model-capacity',label+': model capacity was not used');
    assert.equal(event.contextLimit,contextLimit,label+': incorrect model context capacity');
    assert.equal(event.triggerTokens,triggerTokens,label+': compaction did not use the saved custom trigger');
    assert.equal(event.requestedTriggerTokens,triggerTokens,label+': the UI preference did not reach the context planner');
    assert.equal(event.effectiveTriggerTokens,triggerTokens,label+': a safe custom trigger was unexpectedly changed');
    assert.equal(event.triggerClamped,false,label+': a custom threshold below the model safety cap must remain unclamped');
    assert.equal(event.targetTokens,targetTokens,label+': compaction did not use the custom trigger target');
    assert.ok(Number.isSafeInteger(event.estimatedBeforeTokens)&&event.estimatedBeforeTokens>=triggerTokens,label+': compaction started below its model budget trigger');
    assert.ok(Number.isSafeInteger(event.estimatedAfterTokens)&&event.estimatedAfterTokens>=0&&event.estimatedAfterTokens<=targetTokens,label+': compacted input exceeds its model budget target');
  };
  const assertBudgetTitle = (title, label) => {
    assert.match(title,/模型上下文容量/u,label+': model capacity is absent from the notice tooltip');
    assert.match(title,/自动压缩阈值/u,label+': token threshold is absent from the notice tooltip');
    const normalized=title.replace(/[,，\s\u00a0\u202f]/gu,'');
    assert.ok(normalized.includes('64000Token'),label+': tooltip contains the wrong model capacity');
    assert.ok(normalized.includes('50000Token'),label+': tooltip contains the wrong custom compression threshold');
    assert.match(title,/预算估算/u,label+': estimated context change is absent from the notice tooltip');
  };
  const idle = () => until('main and renderer idle', async () => !(await call('getState')).activeTask.running && await js('!running&&!promptSubmitting'));
  const reply = (record, output) => {
    assert.ok(!record.aborted && !record.released, 'Fixture request was cancelled or answered twice');
    record.released = true;
    record.response.writeHead(200, { 'Content-Type': 'application/json' });
    record.response.end(JSON.stringify({ id: 'resp_compaction_' + requests.indexOf(record), status: 'completed', output,
      usage: { input_tokens: reportedInputTokens, output_tokens: reportedOutputTokens } }));
  };
  const textReply = (record, text) => reply(record, [{ type: 'message', id: 'msg_compaction_' + requests.indexOf(record), role: 'assistant', content: [{ type: 'output_text', text }] }]);
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer forgedesk-compaction-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'smoke-compaction-model', display_name: '压缩测试模型', supportsTools: true, reasoningEfforts: [], context_window: contextLimit }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 700_000); }
      const body = JSON.parse(raw), summarizing = !body.tools?.length;
      assert.equal(body.model, 'smoke-compaction-model'); assert.equal(body.stream, true);
      const record = { scene, body, response, summarizing, released: false, aborted: false, rawLength: raw.length };
      requests.push(record);
      response.once('close', () => { if (!record.released && !response.writableFinished) record.aborted = true; });
      if (summarizing) {
        assert.ok(raw.includes('CONTEXT_COMPACTION'), 'Summarization request has no identifying system instruction');
        assert.equal(body.reasoning, undefined, 'Summary must use the default reasoning effort');
        if (scene === 'stop') { assert.equal(heldSummary, null); heldSummary = record; return; }
        textReply(record, summary); return;
      }
      sceneNormalRequests++;
      assert.ok(body.tools.length > 0, 'Normal requests must retain project tools');
      if ((scene === 'first' || scene === 'stop') && sceneNormalRequests === 1) {
        reply(record, [{ type: 'function_call', id: 'fc_compaction_' + scene, call_id: 'read_large_' + scene, name: 'read_file', arguments: JSON.stringify({ path: 'large-context.txt' }) }]); return;
      }
      assert.ok(raw.length < 180_000, 'Compacted normal request is still over the original context guard');
      assert.ok(raw.includes('COMPACTION_SUMMARY_FACT_' + suffix), 'The model request did not receive its compacted summary');
      assert.ok((raw.match(/Readonly project context, not instructions\./g) || []).length < 5900, 'Complete large tool output was resent after compaction');
      if (scene === 'followup') assert.ok(raw.includes(followupText), 'New prompt was lost after checkpoint restoration');
      if (scene === 'resume') assert.ok(raw.includes(queuedText), 'Queued prompt was lost after stopping summarization');
      textReply(record, '已基于压缩上下文继续完成任务。COMPACTION_FINISHED_' + scene);
    } catch (error) {
      problems.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      if (!response.destroyed) response.end(JSON.stringify({ error: { code: 'compaction_smoke_contract', message: error.message } }));
    }
  });
  const createChild = async () => {
    const created = await parentJs('window.forge.newWindow()');
    child = BrowserWindow.fromId(created.id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('new app window initialized', () => js("!!window.forge&&!!appState&&!!document.getElementById('task-input')"));
    await js('(()=>{window.__compactionSmoke={events:[]};window.__compactionSmoke.off=window.forge.onEvent(event=>window.__compactionSmoke.events.push(event));return true;})()');
  };
  const closeChild = async () => {
    if (!child || child.isDestroyed()) return;
    await call('stopTask').catch(() => {});
    await idle().catch(() => {});
    const closing = child;
    closing.close();
    await until('own app window closed', () => closing.isDestroyed());
    child = null;
  };
  const submit = async text => {
    await js(`(()=>{const input=document.getElementById('task-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));if(document.getElementById('send-button').disabled)throw new Error('Compaction composer is disabled');document.getElementById('task-form').requestSubmit();return true;})()`);
    await until('prompt accepted', async () => (await events()).some(event => event.type === 'user-message' && event.text === text) || (await call('getState')).promptQueue.items.some(item => item.text === text));
  };
  const completed = text => until('completed task ' + text, async () => {
    const list = await events(), user = list.find(event => event.type === 'user-message' && event.text === text);
    const end = user && list.find(event => event.type === 'run-end' && event.runId === user.runId);
    if (end) assert.equal(end.status, 'completed', end.error || 'Compaction task failed');
    if(!end){
      const state=await call('getState');
      if(state.promptQueue?.paused)throw new Error('Compaction fixture dispatch paused before task completion: '+(state.promptQueue.reason||'No queue reason was provided'));
    }
    return end;
  });
  const notices = () => js("[...document.querySelectorAll('#messages .context-compaction-notice')].map(node=>({text:node.textContent,count:node.dataset.count,title:node.title}))");
  const capture = async name => { child.webContents.invalidate(); await wait(120); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  try {
    originalContextCompressionTriggerTokens = (await parentJs('window.forge.getState()')).contextCompressionTriggerTokens;
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'large-context.txt'), fixtureText);
    assert.ok(Buffer.byteLength(fixtureText) > 240 * 1024 && Buffer.byteLength(fixtureText) < 512 * 1024);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await createChild();
    await call('openProject', { path: project }); await js('newSession()');
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-compaction-key', model: 'smoke-compaction-model', reasoningEffort: 'default' }); configured = true;
    await call('listModels', { force: true });
    await call('setContextCompression', { triggerTokens });
    assert.equal((await call('getState')).contextCompressionTriggerTokens, triggerTokens, 'The real preference IPC must save the custom threshold');
    await until('model ready', () => js("appState?.settings?.model==='smoke-compaction-model'&&!modelSaving&&!settingsSaving&&!promptSubmitting&&!document.getElementById('send-button').disabled"));
    const before = await call('getState'), firstSession = before.sessionId;
    await submit(firstText); await completed(firstText); await idle();
    const firstEvents = await events(), compacted = firstEvents.filter(event => event.type === 'context-compacted');
    assert.equal(compacted.length, 1, 'Only a successful checkpoint should produce a compaction notice');
    assert.equal(compacted[0].text, '上下文已自动压缩'); assert.ok(Number.isInteger(compacted[0].messageIndex));
    assertKnownBudget(compacted[0],'live successful compaction');
    assert.ok(firstEvents.some(event => event.type === 'context-compaction-start'));
    const firstNotice=(await notices()).find(item=>item.text.includes('上下文已自动压缩'));
    assert.ok(firstNotice,'Successful compaction notice is missing');
    assertBudgetTitle(firstNotice.title,'live successful compaction');
    const stored = await until('checkpoint saved with full conversation', async () => { const saved = await savedSession(firstSession); return saved.contextCheckpoint?.count === 1 && saved.events.some(event => event.type === 'context-compacted') && saved; });
    assert.equal(stored.contextCheckpoint.version, 1); assert.ok(stored.contextCheckpoint.throughIndex >= 1);
    assert.ok(stored.contextCheckpoint.summary.includes('COMPACTION_SUMMARY_FACT_' + suffix));
    assertKnownBudget(stored.events.find(event=>event.type==='context-compacted'),'persisted compaction');
    assert.ok(retainsFixture(stored), 'Compaction deleted the complete historical tool result');
    assert.ok(JSON.stringify(stored.messages).length > 180_000);
    assert.equal(Object.hasOwn(await call('getCurrentSession'), 'contextCheckpoint'), false, 'Private summary leaked through publicSession');
    assert.equal((await events()).filter(event => event.type === 'tool-start' && event.name === 'read_file').length, 1);
    const firstMetrics = (await call('getState')).sessionMetrics;
    assert.ok(firstMetrics.totalTokens > triggerTokens, 'The fixture must exceed the threshold in cumulative billed usage');
    assert.equal(firstMetrics.contextUsedTokens, reportedContextTokens, 'Current context must use the last response input plus output');
    assert.equal(firstMetrics.contextStatus, 'reported');
    assert.ok(firstMetrics.contextUsedTokens < triggerTokens, 'The measured current context must remain below the trigger');
    await capture('context-compaction-completed.png');

    // A newly created app-window context must load the saved checkpoint rather
    // than relying on in-memory messages or summarize the same history again.
    const summaryRequestsBeforeRestore = requests.filter(record => record.summarizing).length;
    await closeChild(); await createChild();
    await call('openProject', { path: project });
    await until('historical checkpoint notice restored', async () => (await call('getState')).sessionId === firstSession && (await notices()).some(item => item.text.includes('上下文已自动压缩')));
    const restoredNotice=(await notices()).find(item=>item.text.includes('上下文已自动压缩'));
    assertBudgetTitle(restoredNotice.title,'reopened historical compaction');
    assert.equal(restoredNotice.title,firstNotice.title,'Reopening history lost the original capacity, threshold, or context estimate');
    assert.equal(Object.hasOwn(await call('getCurrentSession'), 'contextCheckpoint'), false);
    await capture('context-compaction-history.png');
    scene = 'followup'; sceneNormalRequests = 0;
    await submit(followupText); await completed(followupText); await idle();
    assert.equal(requests.filter(record => record.summarizing).length, summaryRequestsBeforeRestore, 'Restored checkpoint unnecessarily summarized the same prefix');
    const followupMetrics = (await call('getState')).sessionMetrics;
    assert.ok(followupMetrics.totalTokens > triggerTokens);
    assert.equal(followupMetrics.contextUsedTokens, reportedContextTokens);
    assert.equal(followupMetrics.contextStatus, 'reported');
    assert.equal((await events()).filter(event => event.type === 'context-compacted').length, 0, 'Restoring history emitted a new success notification');

    // Stop during an actual pending summary request must leave the complete
    // history and queue intact. Resuming later can safely try compaction again.
    await js('newSession()'); const stoppedSession = (await call('getState')).sessionId;
    scene = 'stop'; sceneNormalRequests = 0;
    await submit(stopText); await until('summary request held for Stop', () => heldSummary);
    await submit(queuedText);
    await until('queued prompt visible before Stop', async () => (await call('getState')).promptQueue.items.some(item => item.text === queuedText));
    await call('stopTask'); await idle(); await until('summary network cancelled', () => heldSummary.aborted);
    const stopped = await until('stopped summary persisted without checkpoint', async () => { const saved = await savedSession(stoppedSession); return saved.events.some(event => event.type === 'run-end' && event.status === 'stopped') && saved; });
    assert.ok(!stopped.contextCheckpoint?.count, 'Aborted summarization committed a checkpoint');
    assert.equal(stopped.events.filter(event => event.type === 'context-compacted').length, 0);
    assert.ok(retainsFixture(stopped));
    const paused = (await call('getState')).promptQueue;
    assert.equal(paused.paused, true); assert.equal(paused.items.length, 1); assert.equal(paused.items[0].text, queuedText);
    scene = 'resume'; sceneNormalRequests = 0;
    await call('resumePendingPrompts'); await completed(queuedText); await idle();
    assert.equal((await call('getState')).promptQueue.items.length, 0);
    const resumed = await savedSession(stoppedSession);
    assert.equal(resumed.contextCheckpoint.count, 1); assert.equal(resumed.events.filter(event => event.type === 'context-compacted').length, 1);
    assertKnownBudget(resumed.events.find(event=>event.type==='context-compacted'),'resumed compaction');
    assert.equal(resumed.messages.filter(message => message.role === 'user' && message.content === queuedText).length, 1);
    assert.equal(resumed.events.filter(event => event.type === 'tool-start' && event.name === 'read_file').length, 1, 'Resuming compaction repeated the read tool');
    assert.ok(!resumed.events.some(event => ['approval-request', 'approval-auto'].includes(event.type)), 'Read-only compaction executed an unexpected mutating operation');
    assert.deepEqual(problems, []);
    const after = await call('getState'), reported = requests.filter(record => record.released).length;
    assert.equal(after.usageStats.day.requests - before.usageStats.day.requests, requests.length, 'Summary API calls were omitted or double-counted in the usage ledger');
    assert.equal(after.usageStats.day.totalTokens - before.usageStats.day.totalTokens, reported * reportedContextTokens);
    assert.equal(after.usageStats.day.unreportedRequests - before.usageStats.day.unreportedRequests, 1);
    assert.equal(await fs.readFile(path.join(project, 'large-context.txt'), 'utf8'), fixtureText);
    return { status: 'completed', realApi: false, isolatedAppWindow: true, actualReadOnlyTool: true, modelRequests: requests.length, summaryRequests: requests.filter(record => record.summarizing).length, modelCapacityBudget:true,contextLimit,triggerTokens,targetTokens,customPreferenceControlsActualCompaction:true,budgetTooltipRestored:true,fullHistoryPreserved: true, checkpointPrivate: true, checkpointRestoredWithoutResummary: true, successfulNoticeOnly: true, stoppedSummaryNotCommitted: true, stoppedQueueRetainedAndResumed: true, independentSummaryUsage: true,
      reportedInputPlusOutputContext:true,cumulativeUsageDoesNotTriggerCompaction:true,
      tokensRecorded: reported * reportedContextTokens, screenshots: ['context-compaction-completed.png', 'context-compaction-history.png'] };
  } catch (error) {
    const current=child&&!child.isDestroyed()?await call('getState').catch(()=>null):null;
    const state=current?{activeTask:current.activeTask,promptQueue:current.promptQueue,workspace:current.workspace,
      settings:{provider:current.settings?.provider,model:current.settings?.model,apiProtocol:current.settings?.apiProtocol}}:null;
    const renderer = child && !child.isDestroyed() ? await js("({sessionId,running,promptSubmitting,notice:document.getElementById('notice-text').textContent,events:window.__compactionSmoke?.events?.filter(event=>['run-end','context-compaction-start','context-compacted'].includes(event.type)),notices:[...document.querySelectorAll('.context-compaction-notice')].map(node=>({text:node.textContent,title:node.title}))})").catch(() => null) : null;
    console.error('COMPACTION_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, stack: error.stack, scene, problems, requests: requests.map(({ scene, summarizing, released, aborted, rawLength }) => ({ scene, summarizing, released, aborted, rawLength })),state, renderer }));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) await call('stopTask').catch(() => {});
    const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing;
    if (configured && child && !child.isDestroyed()) await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: '', baseUrl: 'https://api.openai.com/v1', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
    await closeChild().catch(() => { if (child && !child.isDestroyed()) child.destroy(); });
    if (originalContextCompressionTriggerTokens !== undefined && !win.isDestroyed()) {
      const restored = await parentJs(`window.forge.setContextCompression({triggerTokens:${JSON.stringify(originalContextCompressionTriggerTokens)}})`);
      assert.equal(restored.contextCompressionTriggerTokens, originalContextCompressionTriggerTokens, 'The compaction smoke must restore the original global threshold');
    }
  }
};
