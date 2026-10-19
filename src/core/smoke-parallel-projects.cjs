// Concurrent projects through actual IPC, isolated files and held loopback SSE.
// No real credentials, user project, clipboard, shell or external site is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeParallelProjects({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Parallel-project smoke requires an isolated offscreen parent');
  const suffix = randomUUID(), fixture = path.join(dataDir, 'parallel-projects-' + suffix);
  const roots = { A: path.join(fixture, 'project-A'), B: path.join(fixture, 'project-B') };
  const models = { A: 'smoke-parallel-a', B: 'smoke-parallel-b' };
  const marker = name => 'PARALLEL_' + name + '_' + suffix;
  const prompts = Object.fromEntries(['MAIN_A', 'MAIN_B', 'QUEUE_A', 'STOP_A', 'STOP_B', 'PAUSED_A', 'CLOSE_A', 'CLOSE_B'].map(name => [name, marker(name)]));
  const originals = { A: 'READ_ONLY_PROJECT_A_' + suffix, B: 'READ_ONLY_PROJECT_B_' + suffix };
  const writes = { A: 'APPROVED_WRITE_A_' + suffix, B: 'APPROVED_WRITE_B_' + suffix };
  const records = [], problems = [], workspaceIds = {};
  let child, configured = false, original, fixtureBaseUrl;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Parallel-project smoke timed out: ' + label);
  };
  const parentJs = code => win.webContents.executeJavaScript(code);
  const js = code => child.webContents.executeJavaScript(code);
  const invokeCode = (method, arg) => `window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`;
  const call = (method, arg) => js(invokeCode(method, arg));
  const parentCall = (method, arg) => parentJs(invokeCode(method, arg));
  const state = () => call('getState');
  const log = () => js('window.__parallelSmoke.events');
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text || '').join('\n') : '';
  const send = (record, value) => {
    assert.ok(record && !record.aborted && !record.released && !record.response.destroyed, 'Fixture response is no longer held');
    record.response.write('data: ' + JSON.stringify(value) + '\n\n');
  };
  const delta = (record, text) => {
    record.text += text;
    send(record, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text });
  };
  const finish = (record, tools = false) => {
    const outputItems = [];
    if (record.text) outputItems.push({ type: 'message', id: 'msg_parallel_' + records.indexOf(record), role: 'assistant', content: [{ type: 'output_text', text: record.text }] });
    if (tools) {
      outputItems.push({ type: 'function_call', id: 'fc_read_' + record.project, call_id: 'parallel-read-' + record.project, name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) });
      outputItems.push({ type: 'function_call', id: 'fc_write_' + record.project, call_id: 'parallel-write-' + record.project, name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: writes[record.project] }) });
    } else if (!record.text) {
      outputItems.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: marker('COMPLETED_' + record.name) }] });
    }
    send(record, { type: 'response.completed', response: { id: 'resp_parallel_' + records.indexOf(record), status: 'completed', output: outputItems, usage: { input_tokens: 7, output_tokens: 3 } } });
    record.released = true;
    clearInterval(record.heartbeat);
    record.response.end('data: [DONE]\n\n');
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer forgedesk-parallel-fixture-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: Object.values(models).map(id => ({ id, supports_tools: true, reasoning_efforts: [] })) })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1000000); }
      const body = JSON.parse(raw), latest = (body.input || []).filter(item => item.role === 'user').at(-1);
      const name = Object.keys(prompts).find(key => textOf(latest?.content).includes(prompts[key]));
      assert.ok(name, 'Unexpected parallel fixture prompt');
      const project = name.endsWith('_A') ? 'A' : 'B', other = project === 'A' ? 'B' : 'A';
      assert.equal(body.model, models[project], 'Project selected model leaked into another run');
      assert.equal(body.stream, true);
      assert.ok(!raw.includes(originals[other]), 'Another project file result entered the request');
      assert.ok(!raw.includes(writes[other]), 'Another project write entered the request');
      for (const [otherName, prompt] of Object.entries(prompts)) if (otherName.endsWith('_' + other)) assert.ok(!raw.includes(prompt), 'Another project prompt entered the request');
      const returned = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'parallel-read-' + project);
      const continuation = !!returned;
      if (continuation) {
        assert.equal(JSON.parse(returned.output).content, originals[project], 'Read tool used the wrong project root');
        const written = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'parallel-write-' + project);
        assert.equal(JSON.parse(written.output).path, 'note.txt');
        assert.equal(JSON.parse(written.output).denied, undefined);
      }
      const record = { name, project, continuation, body, response, released: false, aborted: false, text: '' };
      records.push(record);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(': parallel project fixture\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.released) response.write(': parallel project heartbeat\n\n'); }, 150);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.released && !response.writableFinished) record.aborted = true; });
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'parallel_smoke_contract', message: error.message } })); }
    }
  });
  const requestFor = (name, continuation = false) => until('request ' + name + (continuation ? ' continuation' : ''), () => records.find(record => record.name === name && record.continuation === continuation));
  const ready = project => until('foreground project ' + project, async () => {
    const current = await state();
    const renderer = await js('({workspaceId:appState?.workspaceId,root:appState?.workspace?.root,sessionId,busy:projectSwitching})');
    return current.workspace?.root === roots[project] && renderer.root === roots[project] && renderer.workspaceId === current.workspaceId && renderer.sessionId === current.sessionId && !renderer.busy && current;
  });
  const activate = async project => {
    // Exercise the renderer transition path and its dirty-editor guard.
    await js(`openRecentProject({path:${JSON.stringify(roots[project])}})`);
    return ready(project);
  };
  const completed = (project, name) => until('completed ' + name, async () => {
    const session = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', workspaceIds[project].sessionId + '.json'), 'utf8'));
    const user = session.messages.find(message => message.content === prompts[name]);
    const end = session.events.find(event => event.type === 'run-end' && event.messageStartIndex === session.messages.indexOf(user));
    // run-end does not need to repeat messageStartIndex; runId on user events is
    // deliberately not persisted, so use its ordered final status and content.
    const last = session.events.filter(event => event.type === 'run-end').at(-1);
    return user && (end?.status === 'completed' || last?.status === 'completed') && session;
  });
  const submit = async name => {
    const result = await call('submitPrompt', { text: prompts[name], mode: 'queue' });
    return result;
  };
  const capture = async name => { child.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  const idle = () => until('all project tasks idle', async () => !(await state()).openWorkspaces.some(item => item.running));
  const closeChild = async () => {
    if (!child || child.isDestroyed()) return;
    const closing = child;
    closing.close();
    await until('parallel child closes', () => closing.isDestroyed());
    child = null;
  };
  try {
    original = await parentCall('getState');
    for (const project of ['A', 'B']) { await fs.mkdir(roots[project], { recursive: true }); await fs.writeFile(path.join(roots[project], 'note.txt'), originals[project]); }
    await fs.mkdir(output, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fixtureBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    child = BrowserWindow.fromId((await parentCall('newWindow')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('new child initialized', () => js("!!window.forge&&!!appState&&!!document.getElementById('project-switcher')"));
    await js('(()=>{window.__parallelSmoke={events:[]};window.__parallelSmoke.off=window.forge.onEvent(event=>window.__parallelSmoke.events.push(event));return true;})()');
    await activate('A');
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', baseUrl: fixtureBaseUrl, apiKey: 'forgedesk-parallel-fixture-key', model: models.A, reasoningEffort: 'default' }); configured = true;
    await call('listModels', { force: true });
    await until('first model selected', async () => (await state()).settings.model === models.A);
    const before = (await state()).usageStats.day;
    const firstA = await state(); workspaceIds.A = { workspaceId: firstA.workspaceId, sessionId: firstA.sessionId };
    assert.equal((await submit('MAIN_A')).disposition, 'started');
    const a = await requestFor('MAIN_A'); delta(a, marker('A_STREAM'));
    const queued = await submit('QUEUE_A'); assert.equal(queued.disposition, 'queued');
    await until('A stream visible', () => js(`document.getElementById('messages').textContent.includes(${JSON.stringify(marker('A_STREAM'))})`));
    await js("document.getElementById('project-switcher').click()");
    assert.equal(await js("document.getElementById('project-open').disabled"), false, 'Project opener remains locked during a model run');
    await js('closeProjectDropdown()');
    const firstB = await activate('B'); workspaceIds.B = { workspaceId: firstB.workspaceId, sessionId: firstB.sessionId };
    assert.notEqual(firstA.workspaceId, firstB.workspaceId);
    await call('selectModel', { model: models.B });
    assert.equal((await submit('MAIN_B')).disposition, 'started');
    const b = await requestFor('MAIN_B'); delta(b, marker('B_STREAM'));
    const both = await until('both projects run concurrently', async () => { const current = await state(); return current.openWorkspaces.filter(item => item.running).length === 2 && current; });
    for (const project of ['A', 'B']) {
      const entry = both.openWorkspaces.find(item => item.workspaceId === workspaceIds[project].workspaceId);
      assert.equal(entry.model, models[project]); assert.equal(entry.provider, 'openai'); assert.equal(entry.root, roots[project]);
    }
    assert.equal(a.aborted, false); assert.equal(b.aborted, false);
    assert.equal((await state()).promptQueue.items.length, 0, 'A pending queue leaked into B');
    delta(a, marker('A_BACKGROUND'));
    await until('B stream visible', () => js(`document.getElementById('messages').textContent.includes(${JSON.stringify(marker('B_STREAM'))})`));
    assert.equal(await js(`document.getElementById('messages').textContent.includes(${JSON.stringify(marker('A_BACKGROUND'))})`), false, 'Background stream rendered inside the foreground chat');
    finish(a, true);
    await until('background A requests approval', async () => (await state()).openWorkspaces.find(item => item.workspaceId === workspaceIds.A.workspaceId)?.approvalCount === 1);
    assert.equal((await state()).pendingApprovals.length, 0, 'A approval was exposed as a foreground B approval');
    assert.equal(await fs.readFile(path.join(roots.A, 'note.txt'), 'utf8'), originals.A);
    const restoredA = await activate('A');
    assert.equal(restoredA.settings.model, models.A, 'B model choice replaced A configuration');
    assert.equal(restoredA.pendingApprovals.length, 1);
    assert.equal(restoredA.promptQueue.items[0].id, queued.id);
    const aApproval = restoredA.pendingApprovals[0];
    await until('restored A stream and approval card', () => js(`document.getElementById('messages').textContent.includes(${JSON.stringify(marker('A_BACKGROUND'))})&&[...document.querySelectorAll('.approval-accept')].some(button=>!button.disabled)`));
    await capture('parallel-project-approval.png');
    await activate('B');
    assert.equal(await call('respondApproval', { id: aApproval.id, approved: true }), false, 'B could approve A operation');
    assert.equal(await fs.readFile(path.join(roots.A, 'note.txt'), 'utf8'), originals.A);
    await activate('A');
    await js("(()=>{const button=[...document.querySelectorAll('.approval-accept')].find(button=>!button.disabled);if(!button)throw new Error('Restored A approval action unavailable');button.click();return true;})()");
    const aContinuation = await requestFor('MAIN_A', true);
    assert.equal(await fs.readFile(path.join(roots.A, 'note.txt'), 'utf8'), writes.A);
    assert.equal(await fs.readFile(path.join(roots.B, 'note.txt'), 'utf8'), originals.B);
    await activate('B'); finish(aContinuation);
    const aQueue = await requestFor('QUEUE_A', true);
    assert.equal(aQueue.body.model, models.A, 'Background FIFO task used the foreground model');
    assert.equal((await state()).workspaceId, workspaceIds.B.workspaceId);
    finish(aQueue);
    await until('background A queue completed', async () => { const entry = (await state()).openWorkspaces.find(item => item.workspaceId === workspaceIds.A.workspaceId); return !entry.running && entry.pendingCount === 0; });
    assert.equal(b.aborted, false, 'Finishing A affected B');
    finish(b, true);
    const pendingB = await until('B write approval', async () => (await state()).pendingApprovals.find(item => item.kind === 'write'));
    await call('respondApproval', { id: pendingB.id, approved: true });
    const bContinuation = await requestFor('MAIN_B', true); finish(bContinuation);
    await idle();
    assert.equal(await fs.readFile(path.join(roots.A, 'note.txt'), 'utf8'), writes.A);
    assert.equal(await fs.readFile(path.join(roots.B, 'note.txt'), 'utf8'), writes.B);
    const completedUsage = (await state()).usageStats.day;
    assert.equal(completedUsage.requests - before.requests, 5);
    assert.equal(completedUsage.totalTokens - before.totalTokens, 50);
    const savedA = await completed('A', 'QUEUE_A'), savedB = await completed('B', 'MAIN_B');
    assert.ok(!JSON.stringify(savedA).includes(prompts.MAIN_B)); assert.ok(!JSON.stringify(savedB).includes(prompts.MAIN_A));
    const ledger = JSON.parse(await fs.readFile(path.join(dataDir, 'usage.json'), 'utf8'));
    const charged = ledger.records.filter(record => Object.values(models).includes(record.model));
    assert.equal(charged.length, 5); assert.equal(new Set(charged.map(record => record.id)).size, 5);
    assert.equal(charged.filter(record => record.model === models.A).length, 3);
    assert.equal(charged.filter(record => record.model === models.B).length, 2);

    // The same editor transition guard remains authoritative while projects
    // are retained in memory; a rejected switch cannot select the target.
    await js('(()=>{window.__parallelSmoke.guard=confirmEditorTransition;window.__parallelSmoke.guardCalls=0;confirmEditorTransition=async()=>{window.__parallelSmoke.guardCalls++;return false;};return true;})()');
    await js(`openRecentProject({path:${JSON.stringify(roots.A)}})`);
    assert.equal(await js('window.__parallelSmoke.guardCalls'), 1);
    assert.equal((await state()).workspaceId, workspaceIds.B.workspaceId);
    await js('(()=>{confirmEditorTransition=window.__parallelSmoke.guard;return true;})()');
    await call('setEditorDirty', { dirty: true });
    const blocked = await js(`(async()=>{try{await window.forge.openProject({path:${JSON.stringify(roots.A)}});return false;}catch{return true;}})()`);
    assert.equal(blocked, true, 'Main-process dirty editor protection was bypassed');
    assert.equal((await state()).workspaceId, workspaceIds.B.workspaceId);
    await call('setEditorDirty', { dirty: false });

    // Stop only the selected context. Its pending prompts pause while the
    // other project's network request and eventual result remain intact.
    await activate('A'); await call('newSession'); await submit('STOP_A');
    const stopA = await requestFor('STOP_A'), paused = await submit('PAUSED_A');
    await activate('B'); await call('newSession'); await submit('STOP_B');
    const stopB = await requestFor('STOP_B');
    await activate('A'); await call('stopTask');
    await until('only A HTTP request aborted', () => stopA.aborted);
    const afterStop = await until('A stopped with paused queue', async () => { const current = await state(); return !current.activeTask.running && current.promptQueue.paused && current; });
    assert.equal(afterStop.promptQueue.items[0].id, paused.id); assert.equal(stopB.aborted, false);
    assert.equal(afterStop.openWorkspaces.find(item => item.workspaceId === workspaceIds.B.workspaceId).running, true);
    await call('managePendingPrompt', { id: paused.id, action: 'remove' });
    finish(stopB); await idle();
    assert.equal(records.some(record => record.name === 'PAUSED_A'), false);
    await activate('B');
    await capture('parallel-project-completed.png');

    // Closing the test window must cancel every retained context, including
    // the project that is currently hidden, without closing the parent.
    await activate('A'); await call('newSession'); await submit('CLOSE_A');
    const closeA = await requestFor('CLOSE_A');
    await activate('B'); await call('newSession'); await submit('CLOSE_B');
    const closeB = await requestFor('CLOSE_B');
    assert.equal((await state()).openWorkspaces.filter(item => item.running).length, 2);
    const allEvents = await log();
    assert.ok(allEvents.some(event => event.type === 'workspace-activated' && event.state?.workspaceId === workspaceIds.A.workspaceId));
    assert.ok(allEvents.some(event => event.type === 'workspace-update' && event.openWorkspaces?.some(item => item.workspaceId === workspaceIds.A.workspaceId)));
    assert.ok(allEvents.filter(event => ['run-start', 'text-delta', 'approval-request', 'run-end'].includes(event.type)).every(event => typeof event.workspaceId === 'string'));
    await closeChild();
    await until('closing aborts both project transports', () => closeA.aborted && closeB.aborted);
    const parentAfter = await parentCall('getState');
    assert.equal(parentAfter.sessionId, original.sessionId); assert.equal(parentAfter.workspace?.root, original.workspace?.root);
    assert.equal(win.isDestroyed(), false); assert.deepEqual(problems, []);
    const finalUsage = parentAfter.usageStats.day;
    assert.equal(finalUsage.requests - before.requests, 9);
    assert.equal(finalUsage.totalTokens - before.totalTokens, 60);
    assert.equal(finalUsage.unreportedRequests - before.unreportedRequests, 3);
    return { status: 'completed', realApi: false, isolatedChildWindow: true, simultaneousProjects: 2, distinctModels: true, heldSse: true, backgroundStreamIsolated: true, streamAndApprovalsRestored: true, projectFilesIsolated: true, backgroundQueueContinues: true, stopSelectedOnly: true, dirtyEditorGuard: true, closeAbortsAll: true, parentPreserved: true, independentUsage: true, requests: records.length, tokensRecorded: 60, screenshots: ['parallel-project-approval.png', 'parallel-project-completed.png'] };
  } catch (error) {
    const observed = child && !child.isDestroyed() ? await state().catch(() => null) : null;
    console.error('PARALLEL_PROJECT_SMOKE_FAILURE', JSON.stringify({ error: error.message, stack: error.stack, problems, requests: records.map(({ name, project, continuation, released, aborted }) => ({ name, project, continuation, released, aborted })), workspaceId: observed?.workspaceId, openWorkspaces: observed?.openWorkspaces, pendingApprovals: observed?.pendingApprovals, renderer: child && !child.isDestroyed() ? await js('({workspaceId:appState?.workspaceId,sessionId,running,projectSwitching,messages:document.getElementById("messages").innerText.slice(-1000)})').catch(() => null) : null }));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      await js('(()=>{if(window.__parallelSmoke?.guard)confirmEditorTransition=window.__parallelSmoke.guard;return true;})()').catch(() => {});
      await call('setEditorDirty', { dirty: false }).catch(() => {});
      await closeChild().catch(() => { if (child && !child.isDestroyed()) child.destroy(); });
    }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && original && !win.isDestroyed()) {
      const openai = original.settings.providers.openai;
      await parentCall('saveSettings', { provider: 'openai', model: openai.model, baseUrl: openai.baseUrl, apiProtocol: openai.apiProtocol, reasoningEffort: openai.reasoningEffort, authMode: openai.authMode, clearKey: true });
      const previous = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: previous.baseUrl || (original.settings.provider === 'relay' ? fixtureBaseUrl : undefined), apiProtocol: previous.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: previous.authMode });
      assert.equal((await parentCall('getState')).sessionId, original.sessionId, 'Parent session changed during cleanup');
    }
  }
};
