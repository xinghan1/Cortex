// Real loopback Responses requests, real scoped tools and native UI decisions.
// Every project file belongs to this disposable fixture; no external API,
// terminal, operating-system clipboard or user project is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeSubagents({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.ok(store?.usage?.records, 'Subagent smoke needs the actual isolated token ledger');
  const nonce = randomUUID(), project = path.join(dataDir, 'subagents-' + nonce);
  const model = 'smoke-parallel-subagents', apiKey = 'isolated-subagent-key-' + nonce;
  const prompts = { parallel: 'PARENT_PARALLEL_' + nonce, individual: 'PARENT_INDIVIDUAL_STOP_' + nonce, approval: 'PARENT_APPROVAL_STOP_' + nonce, all: 'PARENT_ALL_STOP_' + nonce };
  const markers = Object.fromEntries(['writer', 'readonly', 'individual', 'approval', 'keeper', 'allA', 'allB'].map(name => [name, 'CHILD_' + name.toUpperCase() + '_' + nonce]));
  const summaries = { writer: 'WRITER_READ_AND_APPROVED_WRITE_OK_' + nonce, readonly: 'READONLY_READ_OK_WRITE_DENIED_' + nonce };
  const source = 'ISOLATED_READ_SOURCE_' + nonce + '\n', committed = 'APPROVED_SCOPED_CHILD_WRITE_' + nonce + '\n';
  const deltaMarker = 'CHILD_DELTA_NEVER_PARENT_TEXT_' + nonce;
  const records = [], problems = [], parentIds = new Map();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let child, configured = false, stage = 'create isolated project';
  const js = code => child.webContents.executeJavaScript(code);
  const invoke = (method, value) => `window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (method, value) => js(invoke(method, value));
  const parentCall = (method, value) => win.webContents.executeJavaScript(invoke(method, value));
  const original = await parentCall('getState');
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace an existing provider key');
  const until = async (label, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Subagent smoke timed out: ' + label + (problems.length ? '; server: ' + problems.join(' | ') : ''));
  };
  const exists = async relative => { try { await fs.stat(path.join(project, relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const state = () => call('getState');
  const events = () => js('window.__subagentSmoke.events');
  const session = () => call('getCurrentSession');
  const liveAgents = async () => (await state()).activeTask.subagents || [];
  const rowSelector = id => '.subagent-card[data-agent-id=' + JSON.stringify(id) + ']';
  const inspect = () => js(`(() => ({
    rows:[...document.querySelectorAll('.subagent-card')].map(card=>({id:card.dataset.agentId,status:card.dataset.status,open:card.open,
      tag:card.tagName,name:card.querySelector('.subagent-name')?.textContent,statusText:card.querySelector('.subagent-status')?.textContent,
      elapsed:card.querySelector('.subagent-meta')?.textContent,summary:card.querySelector(':scope > summary')?.textContent,
      text:card.textContent,stop:!!card.querySelector('.subagent-stop:not([hidden]):not(:disabled)'),
      rawCount:card.querySelectorAll('.subagent-raw').length,rawOpen:!!card.querySelector('.subagent-raw[open]')})),
    formHidden:$('task-form').hidden,approvalHidden:$('composer-approval').hidden,
    approvalCount:document.querySelectorAll('#composer-approval .approval-card').length,
    messageApprovals:document.querySelectorAll('#messages .approval-card').length,
    messageText:$('messages').textContent,rawParentText:(window.__subagentSmoke?.events||[]).filter(event=>event.type==='text-delta'||event.type==='assistant-message').map(event=>event.text||'').join('\\n')
  }))()`);
  const click = async selector => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing native target '+${JSON.stringify(selector)});
      node.scrollIntoView({block:'center',behavior:'instant'});if(!node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true}))throw new Error('Hidden native target '+${JSON.stringify(selector)});
      const r=node.getBoundingClientRect(),p={x:Math.round(r.left+Math.min(r.width/2,110)),y:Math.round(r.top+r.height/2)};
      if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered native target '+${JSON.stringify(selector)});return p;})()`);
    child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait(65);
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(attempt * 120);
        const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, filename), image.toPNG()); return;
      } catch (error) { if (attempt === 4 || !/UnknownVizError/.test(String(error))) throw error; }
    }
  };
  const tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
  const final = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const outputs = body => body.input.filter(item => item.type === 'function_call_output');
  const toolOutput = (body, id) => outputs(body).find(item => item.call_id === id)?.output;
  const textOf = item => typeof item?.content === 'string' ? item.content : (item?.content || []).map(part => part.text || '').join('\n');
  const finish = (record, outputItems) => {
    assert.ok(record && !record.released && !record.aborted);
    record.response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: outputItems,
      usage: { input_tokens: record.inputTokens, output_tokens: record.outputTokens } } }) + '\n\n');
    record.released = true; clearInterval(record.heartbeat); record.response.end('data: [DONE]\n\n');
  };
  const spawnCalls = phase => {
    if (phase === 'parallel') return [
      tool('spawn-writer', 'spawn_agent', { name: '写入检查', task: markers.writer + '：读取 input.txt，写入 allowed/report.txt 后总结。', write_paths: ['allowed/report.txt'] }),
      tool('spawn-readonly', 'spawn_agent', { name: '只读检查', task: markers.readonly + '：读取 input.txt，只读检查后总结。' }),
    ];
    if (phase === 'individual') return [tool('spawn-individual', 'spawn_agent', { name: '单独停止', task: markers.individual + '：等待只读检查。' })];
    if (phase === 'approval') return [tool('spawn-approval', 'spawn_agent', { name: '待审批停止', task: markers.approval + '：准备更新 allowed/pending.txt。', write_paths: ['allowed/pending.txt'] }),
      tool('spawn-keeper', 'spawn_agent', { name: '继续运行', task: markers.keeper + '：等待只读检查结果。' })];
    return [tool('spawn-all-A', 'spawn_agent', { name: '整体停止 A', task: markers.allA + '：准备检查，等待下一步。', write_paths: ['allowed/not-written-A.txt'] }),
      tool('spawn-all-B', 'spawn_agent', { name: '整体停止 B', task: markers.allB + '：准备检查，等待下一步。', write_paths: ['allowed/not-written-B.txt'] })];
  };
  const childFirst = worker => worker === 'writer' || worker === 'readonly'
    ? [tool('read-' + worker, 'read_file', { path: 'input.txt' })] : null;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: model, supportsTools: true, reasoningEfforts: [] }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length <= 2000000); }
      const body = JSON.parse(raw); assert.equal(body.model, model); assert.equal(body.stream, true);
      const users = body.input.filter(item => item.role === 'user').map(textOf);
      const assigned = users.find(text => text.startsWith('分配给你的独立子任务：'));
      const worker = assigned && Object.keys(markers).find(name => assigned.includes(markers[name]));
      const phase = worker === 'writer' || worker === 'readonly' ? 'parallel' : worker === 'individual' ? 'individual' : worker === 'approval' || worker === 'keeper' ? 'approval' : worker ? 'all'
        : Object.keys(prompts).find(name => users.at(-1)?.includes(prompts[name]));
      assert.ok(phase, 'Unexpected model task');
      const actor = worker || 'parent', turn = records.filter(record => record.phase === phase && record.actor === actor).length + 1;
      const record = { n: records.length + 1, phase, actor, turn, body, response, released: false, aborted: false, enteredAt: Date.now(), inputTokens: 100 + records.length, outputTokens: 7 };
      records.push(record);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.write(': subagent fixture heartbeat\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.released) response.write(': subagent fixture heartbeat\n\n'); }, 100);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.released && !response.writableFinished) record.aborted = true; });
      if (worker) {
        assert.equal((body.tools || []).some(definition => definition.name === 'spawn_agent'), false, 'Children must not receive recursive delegation tools');
        if (worker === 'readonly') assert.equal((body.tools || []).some(definition => definition.name === 'write_file'), false);
        if (turn === 1) {
          if (worker === 'approval') { finish(record, [tool('pending-write', 'write_file', { path: 'allowed/pending.txt', content: 'CANCELLED_CHILD_WRITE_MUST_NEVER_APPEAR' })]); return; }
          if (worker !== 'keeper') response.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: deltaMarker }) + '\n\n');
          return; // The smoke releases both readers only after the parallel barrier.
        }
        if (turn === 2 && (worker === 'writer' || worker === 'readonly')) {
          assert.match(toolOutput(body, 'read-' + worker) || '', new RegExp(source.trim()), 'A child must receive the actual fixture file');
          finish(record, [tool('write-' + worker, 'write_file', { path: worker === 'writer' ? 'allowed/report.txt' : 'escape.txt', content: worker === 'writer' ? committed : 'READONLY_WRITE_MUST_NEVER_APPEAR' })]); return;
        }
        if (turn === 3 && (worker === 'writer' || worker === 'readonly')) {
          const result = toolOutput(body, 'write-' + worker) || '';
          if (worker === 'writer') { const saved = JSON.parse(result); assert.equal(saved.path, 'allowed/report.txt'); assert.equal(saved.bytes, Buffer.byteLength(committed)); }
          else assert.match(result, /失败|只读|拒绝|权限|未授权|范围|不允许|read.?only|denied/i);
          finish(record, [final(summaries[worker])]); return;
        }
        assert.fail('A held/stopped child unexpectedly requested another turn: ' + worker + '/' + turn);
      }
      if (turn === 1) { finish(record, spawnCalls(phase)); return; }
      if (turn === 2) {
        const currentCalls = new Set(spawnCalls(phase).map(item => item.call_id));
        const ids = outputs(body).filter(item => currentCalls.has(item.call_id)).map(item => JSON.parse(item.output).id);
        assert.equal(ids.length, phase === 'individual' ? 1 : 2); assert.ok(ids.every(id => typeof id === 'string' && id));
        parentIds.set(phase, ids); finish(record, [tool('wait-' + phase, 'wait_agents', { ids })]); return;
      }
      if (turn === 3) {
        const result = JSON.parse(toolOutput(body, 'wait-' + phase));
        assert.equal(result.agents.length, phase === 'individual' ? 1 : 2);
        if (phase === 'parallel') { assert.ok(result.agents.every(agent => agent.status === 'completed')); for (const summary of Object.values(summaries)) assert.ok(result.agents.some(agent => agent.summary === summary)); }
        else if (phase === 'individual') assert.equal(result.agents[0].status, 'stopped');
        else { assert.equal(phase, 'approval'); assert.equal(result.agents.find(agent => agent.name === '待审批停止')?.status, 'stopped'); assert.equal(result.agents.find(agent => agent.name === '继续运行')?.status, 'completed'); }
        finish(record, [final(phase === 'parallel' ? 'PARENT_SYNTHESIZED_BOTH: ' + summaries.writer + '; ' + summaries.readonly : 'PARENT_CONTINUES_AFTER_CHILD_STOP')]); return;
      }
      assert.fail('Unexpected parent model turn: ' + phase + '/' + turn);
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message, code: 'SUBAGENT_SMOKE_CONTRACT' } })); }
    }
  });
  const recordFor = (phase, actor, turn = 1) => until('request ' + phase + '/' + actor + '/' + turn, () => records.find(record => record.phase === phase && record.actor === actor && record.turn === turn));
  const run = async phase => {
    await call('submitPrompt', { text: prompts[phase], mode: 'queue' });
    await until('parent run starts ' + phase, async () => (await state()).activeTask.running);
    const active = (await state()).activeTask; return active.runId;
  };
  const finished = runId => until('parent run completes ' + runId, async () => {
    const value = await state(), ended = (await events()).find(event => event.type === 'run-end' && event.runId === runId);
    return !value.activeTask.running && ended;
  });
  const openRow = async id => {
    const selector = rowSelector(id);
    await until('subagent row ' + id, () => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
    const closedGroup = await js(`(()=>{const card=document.querySelector(${JSON.stringify(selector)}),group=card.closest('.task-activity');return group&&!group.open?group.dataset.runId:null;})()`);
    if (closedGroup) await click('.task-activity[data-run-id=' + JSON.stringify(closedGroup) + '] > summary');
    if (!await js(`document.querySelector(${JSON.stringify(selector)}).open`)) await click(selector + ' > summary');
  };
  try {
    await fs.mkdir(path.join(project, 'allowed'), { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'input.txt'), source);
    await fs.writeFile(path.join(project, 'allowed', 'pending.txt'), 'UNCHANGED_PENDING_ORIGINAL');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await parentCall('newWindow')).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('isolated renderer ready', () => js('Boolean(appState&&window.forge.stopSubagent&&!projectSwitching)'));
    await js(`window.__subagentSmoke={events:[]};window.__subagentSmoke.off=window.forge.onEvent(event=>window.__subagentSmoke.events.push(event));true`);
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project active', async () => (await state()).workspace?.root === project && await js('!projectSwitching'));
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, reasoningEffort: 'default' }); configured = true;
    await call('setPermissionMode', { mode: 'request' });
    const sessionId = (await state()).sessionId, initialUsage = store.usage.records.length;

    stage = 'two child model requests enter concurrently';
    const parallelRun = await run('parallel');
    const a = await recordFor('parallel', 'writer'), b = await recordFor('parallel', 'readonly');
    assert.equal(a.released, false); assert.equal(b.released, false); assert.equal(a.aborted, false); assert.equal(b.aborted, false);
    assert.ok(a.enteredAt && b.enteredAt, 'Both child HTTP requests must enter before either response is released');
    await until('two live child rows', async () => (await inspect()).rows.filter(row => row.status === 'running').length === 2);
    const parallelAgents = await liveAgents(); assert.equal(parallelAgents.length, 2);
    const writer = parallelAgents.find(agent => agent.name === '写入检查'), readonly = parallelAgents.find(agent => agent.name === '只读检查');
    assert.ok(writer?.id && readonly?.id); await openRow(writer.id);
    assert.equal((await inspect()).rows.find(row => row.id === writer.id)?.open, true);
    assert.equal((await inspect()).rawParentText.includes(deltaMarker), false, 'Child deltas must never appear as the parent assistant stream');
    await capture('subagents-parallel-running.png');
    finish(a, childFirst('writer')); finish(b, childFirst('readonly'));

    stage = 'scoped child write uses the normal composer approval';
    const approval = await until('scoped child approval', async () => (await state()).pendingApprovals.find(item => item.path === 'allowed/report.txt' && item.kind === 'write'));
    assert.ok(approval.id); assert.equal(await exists('allowed/report.txt'), false); assert.equal(await exists('escape.txt'), false);
    await until('composer approval visible', async () => { const view = await inspect(); return view.formHidden && !view.approvalHidden && view.approvalCount === 1 && view.messageApprovals === 0; });
    await capture('subagents-scoped-approval.png'); await click('#composer-approval .approval-accept:not(:disabled)');
    const parallelEnd = await finished(parallelRun); assert.equal(parallelEnd.status, 'completed');
    assert.equal(await fs.readFile(path.join(project, 'allowed/report.txt'), 'utf8'), committed); assert.equal(await exists('escape.txt'), false);
    assert.equal((await state()).pendingApprovals.length, 0);
    let archived = await session();
    assert.equal(archived.subagents.filter(agent => agent.parentRunId === parallelRun && agent.status === 'completed').length, 2);
    assert.ok(archived.messages.some(message => message.role === 'assistant' && message.content.includes('PARENT_SYNTHESIZED_BOTH')));
    assert.equal(archived.messages.some(message => (message.content || '').includes(deltaMarker)), false);
    const parallelRecords = records.filter(record => record.phase === 'parallel'); assert.equal(parallelRecords.length, 9); assert.ok(parallelRecords.every(record => record.released && !record.aborted));
    const parallelLedger = store.usage.records.slice(initialUsage).filter(record => record.runId === parallelRun);
    assert.equal(parallelLedger.length, 9, 'All parent and child requests must be recorded exactly once');
    assert.equal(new Set(parallelLedger.map(record => record.id)).size, 9);
    assert.equal(parallelLedger.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0), parallelRecords.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0));

    stage = 'native individual child stop aborts its held request';
    const individualRun = await run('individual'); const held = await recordFor('individual', 'individual');
    const single = await until('single live child', async () => (await liveAgents()).find(agent => agent.name === '单独停止'));
    await openRow(single.id);
    await js(`document.querySelector(${JSON.stringify(rowSelector(single.id) + ' .subagent-stop')}).addEventListener('click',event=>{window.__subagentStopClick={trusted:event.isTrusted,prevented:event.defaultPrevented,open:event.currentTarget.closest('.subagent-card').open};},{once:true});true`);
    await click(rowSelector(single.id) + ' .subagent-stop');
    assert.deepEqual(await js('window.__subagentStopClick'), { trusted: true, prevented: true, open: true }, 'The native Stop click must prevent summary activation before any parent completion redraw');
    await until('held child HTTP aborted', () => held.aborted);
    const individualEnd = await finished(individualRun); assert.equal(individualEnd.status, 'completed', 'Stopping one child must allow its parent to continue');
    assert.equal((await session()).subagents.find(agent => agent.id === single.id)?.status, 'stopped');

    stage = 'stopping a child cancels only its pending composer approval';
    const approvalRun = await run('approval'), keeperRequest = await recordFor('approval', 'keeper');
    const pending = await until('pending child write approval', async () => (await state()).pendingApprovals.find(item => item.path === 'allowed/pending.txt'));
    assert.ok(pending.id); assert.equal(await fs.readFile(path.join(project, 'allowed', 'pending.txt'), 'utf8'), 'UNCHANGED_PENDING_ORIGINAL');
    const pendingAgent = await until('pending child agent', async () => (await liveAgents()).find(agent => agent.name === '待审批停止'));
    await openRow(pendingAgent.id); await capture('subagents-stop-pending-approval.png');
    await click(rowSelector(pendingAgent.id) + ' .subagent-stop');
    await until('pending child approval cleared', async () => !(await state()).pendingApprovals.length && (await inspect()).approvalHidden && !(await inspect()).formHidden);
    assert.equal(keeperRequest.aborted, false); assert.equal(keeperRequest.released, false);
    assert.equal((await state()).activeTask.running, true, 'Stopping one pending write must not stop another child or its parent');
    assert.equal(await fs.readFile(path.join(project, 'allowed', 'pending.txt'), 'utf8'), 'UNCHANGED_PENDING_ORIGINAL');
    finish(keeperRequest, [final('KEEPER_CONTINUES_AFTER_OTHER_CHILD_APPROVAL_CANCELLED')]);
    assert.equal((await finished(approvalRun)).status, 'completed');

    stage = 'native parent stop cancels every pending child';
    const allRun = await run('all'); const heldA = await recordFor('all', 'allA'), heldB = await recordFor('all', 'allB');
    assert.equal(heldA.released, false); assert.equal(heldB.released, false);
    await recordFor('all', 'parent', 2);
    await until('two held child rows', async () => (await liveAgents()).filter(agent => agent.status === 'running').length === 2);
    await click('#stop-button'); await until('all child HTTP aborted', () => heldA.aborted && heldB.aborted);
    const allEnd = await finished(allRun); assert.equal(allEnd.status, 'stopped');
    archived = await session();
    assert.equal(archived.subagents.filter(agent => agent.parentRunId === allRun && agent.status === 'stopped').length, 2);
    assert.equal(await exists('allowed/not-written-A.txt'), false); assert.equal(await exists('allowed/not-written-B.txt'), false);
    assert.equal((await state()).pendingApprovals.length, 0);
    const ledger = store.usage.records.slice(initialUsage).filter(record => record.sessionId === sessionId && record.model === model);
    assert.equal(ledger.length, records.length, 'Aborted requests also need exactly one ledger record');
    assert.equal(new Set(ledger.map(record => record.id)).size, records.length);
    assert.equal(ledger.filter(record => record.status === 'stopped').length, records.filter(record => record.aborted).length);
    assert.deepEqual(ledger.filter(record => record.reported).map(record => [record.inputTokens, record.outputTokens]).sort((a, b) => a[0] - b[0]),
      records.filter(record => record.released).map(record => [record.inputTokens, record.outputTokens]).sort((a, b) => a[0] - b[0]),
      'Unique per-request usage values must each appear once, including every child request');
    assert.equal(ledger.filter(record => record.reported).reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0), records.filter(record => record.released).reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0));
    assert.deepEqual(problems, []);

    stage = 'history reload retains terminal agent rows and summaries';
    const beforeArchive = archived.subagents.map(agent => ({ id: agent.id, parentRunId: agent.parentRunId, status: agent.status, summary: agent.summary, elapsedMs: agent.elapsedMs }));
    assert.equal(beforeArchive.length, 7); assert.ok(beforeArchive.every(agent => ['completed', 'stopped'].includes(agent.status)));
    for (const id of [parallelRun, individualRun, approvalRun, allRun]) assert.ok(archived.taskRuns?.some(record => record.runId === id), 'A subagent parent must retain independent task metadata');
    const withoutRunEnd = await js(`(() => {const saved=${JSON.stringify(archived)};saved.events=(saved.events||[]).filter(event=>event.type!=='run-end');const blocks=window.ForgeTaskHistory.project(saved);
      return blocks.flatMap(block=>block.type==='run'?block.items.filter(item=>item.type==='event'&&item.event.type==='subagent-update').map(item=>item.event.agent.id):[]);})()`);
    assert.equal(withoutRunEnd.length, 7, 'Independent task metadata must project every subagent when the bounded event log has lost run-end events');
    assert.deepEqual([...withoutRunEnd].sort(), beforeArchive.map(agent => agent.id).sort());
    child.webContents.reload(); await wait(50);
    await until('restored project and session', () => js(`Boolean(appState?.workspace?.root===${JSON.stringify(project)}&&sessionId===${JSON.stringify(sessionId)}&&!projectSwitching&&document.querySelectorAll('.subagent-card').length===7)`));
    assert.deepEqual((await session()).subagents.map(agent => ({ id: agent.id, parentRunId: agent.parentRunId, status: agent.status, summary: agent.summary, elapsedMs: agent.elapsedMs })), beforeArchive);
    await openRow(writer.id);
    const view = await inspect();
    assert.ok(view.rows.every(row => row.tag === 'DETAILS' && row.status !== 'running' && !row.stop));
    assert.ok(view.rows.find(row => row.id === writer.id)?.text.includes(summaries.writer));
    assert.ok(view.rows.find(row => row.id === writer.id)?.rawCount > 0, 'Child tool details should remain inspectable in history');
    assert.ok(view.rows.every(row => !row.rawOpen), 'Raw child inputs and results must remain collapsed by default');
    assert.equal(view.rawParentText.includes(deltaMarker), false);
    const stable = view.rows.map(row => [row.id, row.statusText, row.elapsed, row.summary]); await wait(1100);
    assert.deepEqual((await inspect()).rows.map(row => [row.id, row.statusText, row.elapsed, row.summary]), stable, 'Historical rows must not restart elapsed-time counters');
    await capture('subagents-completed-history.png');
    const result = { status: 'completed', realExternalApi: false, realLoopbackProviderRequests: true, realCommands: false, isolatedFilesOnly: true,
      parallelBarrier: { childrenEnteredBeforeEitherRelease: 2 }, actualWorkspaceReads: true, readonlyWriteBlocked: true,
      nativeScopedWriteApproval: true, childStreamSeparateFromParent: true, parentSynthesizesBothSummaries: true,
      nativeIndividualStop: true, individualStopAbortsHttpAndPreservesParent: true, nativeParentStopAbortsAllChildren: true,
      stoppingChildClearsItsPendingApprovalOnly: true,
      cancelledChildrenNeverWrite: true, exactOnceLedgerRequests: ledger.length, archivedSubagents: beforeArchive.length,
      nativeDetailsExpansion: true, historyReloadAndStableElapsed: true,
      independentTaskMetadataSurvivesEventEviction: true,
      screenshots: ['subagents-parallel-running.png', 'subagents-scoped-approval.png', 'subagents-stop-pending-approval.png', 'subagents-completed-history.png'] };
    await fs.writeFile(path.join(output, 'subagents-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, problems,
      requests: records.map(({ n, phase, actor, turn, released, aborted }) => ({ n, phase, actor, turn, released, aborted })) };
    if (child && !child.isDestroyed()) { try { failure.ui = await inspect(); failure.state = await state(); await capture('subagents-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; } }
    await fs.writeFile(path.join(output, 'subagents-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Subagent smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (child && !child.isDestroyed()) { try { await call('stopTask'); await until('cleanup parent stops', async () => !(await state()).activeTask.running); } catch {} child.close(); await until('isolated subagent window closes', () => child.isDestroyed()).catch(() => child.destroy()); }
    for (const record of records) clearInterval(record.heartbeat);
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previousOpenai = original.settings.providers.openai;
      await parentCall('saveSettings', { provider: 'openai', model: previousOpenai.model, baseUrl: previousOpenai.baseUrl, apiProtocol: previousOpenai.apiProtocol, reasoningEffort: previousOpenai.reasoningEffort, authMode: previousOpenai.authMode, clearKey: true });
      const previous = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: previous.authMode });
    }
  }
};
