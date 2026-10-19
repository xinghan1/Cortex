// Real run/tool/history UI with a controlled loopback DeepSeek SSE stream and one approved local command.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { dialog } = require('electron');

module.exports = async function smokeActivity({ win, output, dataDir }) {
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const observed = await predicate();
      if (observed) return observed;
      await wait(25);
    }
    throw new Error('Activity smoke timed out: ' + label);
  };
  const fixture = path.join(dataDir, 'activity-project-' + randomUUID());
  const privateReasoning = 'PRIVATE_ACTIVITY_THINKING_' + randomUUID();
  const completedPrompt = 'ACTIVITY_COMPLETED_' + randomUUID();
  const stoppedPrompt = 'ACTIVITY_STOPPED_' + randomUUID();
  const command = "Start-Sleep -Milliseconds 1400; Write-Output 'ACTIVITY_COMMAND_OK'";
  const finalText = '活动状态测试完成：命令执行成功，时长与速度已记录。';
  const originalOpen = dialog.showOpenDialog;
  const records = [], problems = [];
  let installed = false, configured = false;
  const log = () => js('window.__activitySmoke.events');
  const seconds = text => {
    assert.match(text, /已处理/u);
    let value = 0, matched = false;
    for (const part of text.matchAll(/(\d+(?:\.\d+)?)\s*(小时|分钟|分|秒)/gu)) {
      matched = true;
      value += Number(part[1]) * (part[2] === '小时' ? 3600 : ['分钟', '分'].includes(part[2]) ? 60 : 1);
    }
    assert.ok(matched, 'Activity duration has no readable value: ' + text);
    return value;
  };
  const snapshot = runId => js(`(()=>{
    const block=document.querySelector('.task-activity[data-run-id=${JSON.stringify(runId)}]');
    if(!block)return null;
    const elapsed=block.querySelector('.task-activity-elapsed'),speed=block.querySelector('.task-activity-speed');
    return{status:block.dataset.status,phase:block.querySelector('.task-activity-phase')?.textContent||'',elapsed:elapsed?.textContent||'',speed:speed?.textContent||'',speedHidden:!speed||speed.hidden||!speed.getClientRects().length,speedAfterElapsed:!!elapsed&&!!speed&&!!(elapsed.compareDocumentPosition(speed)&Node.DOCUMENT_POSITION_FOLLOWING),central:!!block.closest('#messages'),currentSpeedInBlock:block.contains(document.getElementById('generation-speed')),headerSpeed:!!document.querySelector('.conversation-header #generation-speed')};
  })()`);
  const phase = (runId, pattern, label) => until(label, async () => {
    const observed = await snapshot(runId);
    return observed?.status === 'running' && pattern.test(observed.phase) && observed;
  });
  const capture = async name => { win.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const send = (record, value) => {
    assert.ok(record && !record.response.destroyed && !record.completed, 'Fixture response closed before the expected activity phase');
    record.response.write('data: ' + JSON.stringify(value) + '\n\n');
  };
  const finish = (record, usage) => {
    send(record, { choices: [], usage });
    record.completed = true;
    clearInterval(record.heartbeat);
    record.response.end('data: [DONE]\n\n');
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer forgedesk-activity-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'smoke-activity-model', supportsTools: true, effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] })); return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer forgedesk-activity-key');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1_000_000); }
      const body = JSON.parse(raw);
      assert.equal(body.model, 'smoke-activity-model');
      assert.equal(body.stream, true);
      const round = records.length;
      assert.ok(round < 3, 'Unexpected additional activity model request');
      const latestUser = [...body.messages].reverse().find(message => message.role === 'user');
      assert.equal(latestUser.content, round === 2 ? stoppedPrompt : completedPrompt);
      if (round === 1) {
        const native = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.some(tool => tool.id === 'activity-command'));
        assert.equal(native?.reasoning_content, privateReasoning);
        const returned = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'activity-command');
        const result = JSON.parse(returned.content);
        assert.equal(result.exitCode, 0);
        assert.ok(result.stdout.includes('ACTIVITY_COMMAND_OK'));
      }
      const record = { response, body, completed: false, aborted: false };
      records.push(record);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(': activity fixture heartbeat\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.completed) response.write(': activity fixture heartbeat\n\n'); }, 150);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.completed) record.aborted = true; });
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message, code: 'activity_smoke_contract' } }));
      }
    }
  });
  try {
    await fs.mkdir(fixture, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    await call('chooseWorkspace'); await call('newSession');
    await call('saveSettings', { provider: 'deepseek', model: 'smoke-activity-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-activity-key', reasoningEffort: 'high', maxSteps: 4 });
    configured = true;
    await call('listModels', { force: true });
    await call('setReasoningEffort', { reasoningEffort: 'high' });
    const initial = await call('getState');
    const sessionId = initial.sessionId;
    await js(`(()=>{
      if(document.getElementById('steer-button')||document.getElementById('send-mode-hint'))throw new Error('Removed composer queue/steer controls still exist');
      window.__activitySmoke={events:[]};
      window.__activitySmoke.off=window.forge.onEvent(event=>{
        window.__activitySmoke.events.push(event);
        if(event.type==='approval-request'&&event.kind==='command'&&event.command===${JSON.stringify(command)})queueMicrotask(()=>{
          const card=[...document.querySelectorAll('.approval-card')].reverse().find(card=>card.querySelector('.approval-command')?.textContent===${JSON.stringify(command)});
          const button=card?.querySelector('.approval-accept');if(button&&!button.disabled)button.click();
        });
      });
    })()`);
    installed = true;
    const firstSubmission = await call('submitPrompt', { text: completedPrompt, mode: 'queue' });
    assert.equal(firstSubmission.disposition, 'started');
    const start = await until('first run-start', async () => (await log()).find(event => event.type === 'run-start'));
    assert.ok(typeof start.runId === 'string' && Number.isFinite(start.startedAt) && Number.isInteger(start.messageStartIndex));
    await until('first local request held', () => records[0]);
    const waiting = await phase(start.runId, /等待.*模型|等待响应/u, 'waiting model central activity');
    assert.equal(waiting.central, true);
    assert.equal(waiting.headerSpeed, false);
    assert.equal(waiting.speedHidden, true, 'A task with no output displayed a token rate');
    const initialSeconds = seconds(waiting.elapsed);
    await until('elapsed increases while waiting for a model', async () => {
      const observed = await snapshot(start.runId);
      return observed?.status === 'running' && seconds(observed.elapsed) > initialSeconds;
    });
    send(records[0], { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: privateReasoning } }] });
    const thinking = await phase(start.runId, /思考|推理/u, 'thinking central activity');
    const liveRate = await until('thinking rate follows processed time', async () => {
      const observed = await snapshot(start.runId);
      return observed && !observed.speedHidden && /tok\/s/u.test(observed.speed) && observed;
    });
    assert.ok(liveRate.speedAfterElapsed && liveRate.currentSpeedInBlock && !liveRate.headerSpeed);
    assert.match(liveRate.speed, /≈|估算/u);
    assert.ok(seconds(thinking.elapsed) >= initialSeconds);
    assert.ok(!(await js('document.body.innerText')).includes(privateReasoning));
    await capture('activity-thinking.png');
    send(records[0], { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'activity-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command, timeout_ms: 5000 }) } }] }, finish_reason: 'tool_calls' }] });
    finish(records[0], { prompt_tokens: 7, completion_tokens: 5 });
    const executing = await phase(start.runId, /运行.*命令|执行.*命令|PowerShell/u, 'running command central activity');
    assert.ok(seconds(executing.elapsed) >= initialSeconds);
    await capture('activity-command.png');
    await until('second model request follows real command', () => records[1]);
    await phase(start.runId, /等待.*模型|等待响应/u, 'waiting for second model response');
    send(records[1], { choices: [{ index: 0, delta: { role: 'assistant', content: finalText }, finish_reason: 'stop' }] });
    finish(records[1], { prompt_tokens: 11, completion_tokens: 3 });
    const firstEnd = await until('completed run-end', async () => (await log()).find(event => event.type === 'run-end' && event.runId === start.runId));
    assert.equal(firstEnd.status, 'completed');
    assert.ok(Number.isFinite(firstEnd.elapsedMs) && firstEnd.elapsedMs >= 1400);
    assert.ok(Number.isFinite(firstEnd.endedAt) && firstEnd.endedAt >= firstEnd.startedAt);
    assert.ok(Number.isInteger(firstEnd.messageIndex) && firstEnd.messageIndex >= firstEnd.messageStartIndex);
    const completed = await until('completed activity retained', async () => { const observed = await snapshot(start.runId); return observed?.status === 'completed' && !observed.speedHidden && observed; });
    assert.match(completed.speed, /tok\/s/u);
    assert.ok(completed.speedAfterElapsed && !completed.headerSpeed);
    assert.ok(Math.abs(seconds(completed.elapsed) - Math.floor(firstEnd.elapsedMs / 1000)) <= 1);

    // A fresh task has no valid rate yet; stop it while heartbeats keep the model connection alive.
    await until('completed task released main state', async () => !(await call('getState')).activeTask.running);
    const stoppedSubmission = await call('submitPrompt', { text: stoppedPrompt, mode: 'queue' });
    assert.equal(stoppedSubmission.disposition, 'started');
    const stopStart = await until('second task run-start', async () => (await log()).find(event => event.type === 'run-start' && event.runId !== start.runId));
    await until('stoppable model response held', () => records[2]);
    const stopWaiting = await phase(stopStart.runId, /等待.*模型|等待响应/u, 'new task waiting activity');
    assert.equal(stopWaiting.speedHidden, true, 'New task inherited a prior task rate');
    const stoppedInitial = seconds(stopWaiting.elapsed);
    await until('second task elapsed grows independently', async () => { const observed = await snapshot(stopStart.runId); return observed?.status === 'running' && seconds(observed.elapsed) > stoppedInitial; });
    assert.equal((await snapshot(start.runId)).elapsed, completed.elapsed, 'Completed task duration continued ticking');
    await call('stopTask');
    const stopEnd = await until('stopped run-end', async () => (await log()).find(event => event.type === 'run-end' && event.runId === stopStart.runId));
    assert.equal(stopEnd.status, 'stopped');
    await until('model connection cancelled', () => records[2].aborted);
    const stopped = await until('stopped activity retained', async () => { const observed = await snapshot(stopStart.runId); return observed?.status === 'stopped' && observed; });
    assert.ok((await js('document.getElementById("messages").innerText')).includes('任务已停止'));
    assert.equal(stopped.speedHidden, true, 'Stopped no-output task displayed a token rate');
    await wait(1100);
    assert.equal((await snapshot(stopStart.runId)).elapsed, stopped.elapsed, 'Stopped task duration continued ticking');
    assert.equal((await snapshot(start.runId)).elapsed, completed.elapsed);
    const safeEvents = await log();
    assert.ok(!JSON.stringify(safeEvents).includes(privateReasoning), 'Raw private reasoning was emitted to renderer');
    assert.ok(safeEvents.some(event => event.type === 'approval-request' && event.runId === start.runId));
    assert.ok(safeEvents.some(event => event.type === 'tool-start' && event.runId === start.runId && event.name === 'run_command'));
    assert.ok(safeEvents.filter(event => event.type === 'telemetry').every(event => typeof event.runId === 'string'));
    const after = await call('getState');
    assert.equal(after.usageStats.day.requests - initial.usageStats.day.requests, 3);
    assert.equal(after.usageStats.day.totalTokens - initial.usageStats.day.totalTokens, 26);
    assert.equal(after.usageStats.day.unreportedRequests - initial.usageStats.day.unreportedRequests, 1);

    // Persisted run summaries recreate both frozen footers in the project history.
    await until('run-end summaries persisted', async () => {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', sessionId + '.json'), 'utf8'));
      return [start.runId, stopStart.runId].every(runId => saved.events.some(event => event.type === 'run-end' && event.runId === runId));
    });
    await call('newSession');
    await call('openProject', { path: fixture });
    // An already-open project now retains its selected conversation. Choose
    // the saved history explicitly instead of treating reopen as a reset.
    await js(`loadSession(${JSON.stringify(sessionId)})`);
    await until('history session restored', async () => (await call('getState')).sessionId === sessionId);
    const historicalCompleted = await until('completed activity restored from history', async () => { const observed = await snapshot(start.runId); return observed?.status === 'completed' && observed; });
    const historicalStopped = await until('stopped activity restored from history', async () => { const observed = await snapshot(stopStart.runId); return observed?.status === 'stopped' && observed; });
    assert.equal(historicalCompleted.elapsed, completed.elapsed);
    assert.equal(historicalCompleted.speed, completed.speed);
    assert.equal(historicalCompleted.speedHidden, false);
    assert.equal(historicalStopped.elapsed, stopped.elapsed);
    assert.equal(historicalStopped.speedHidden, true);
    assert.ok(!(await js('document.body.innerText')).includes(privateReasoning));
    assert.equal(await js('document.querySelectorAll(".task-activity[data-status=running]").length'), 0);
    await capture('activity-history.png');
    assert.equal(records.length, 3);
    assert.deepEqual(problems, []);
    return { status: 'completed', realApi: false, modelRequests: records.length, waitingModel: true, privateThinking: true, realApprovedCommand: true, elapsedIncreases: true, speedFollowsElapsed: true, noRateWithoutOutput: true, completedAndStoppedFreeze: true, historicalFooters: true, tokensRecorded: 26, unreportedRequests: 1, screenshots: ['activity-thinking.png', 'activity-command.png', 'activity-history.png'] };
  } catch (error) {
    const cards = win.isDestroyed() ? [] : await js('[...document.querySelectorAll(".task-activity")].map(node=>({id:node.dataset.runId,status:node.dataset.status,text:node.textContent}))').catch(() => []);
    console.error('ACTIVITY_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, requests: records.length, problems, cards }));
    throw error;
  } finally {
    dialog.showOpenDialog = originalOpen;
    if (!win.isDestroyed()) { try { await call('stopTask'); } catch {} }
    for (const record of records) clearInterval(record.heartbeat);
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    if (!win.isDestroyed()) {
      if (installed) await js('window.__activitySmoke.off(); delete window.__activitySmoke').catch(() => {});
      if (configured) await call('saveSettings', { provider: 'deepseek', model: '', baseUrl: 'https://api.deepseek.com', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
    }
  }
};
