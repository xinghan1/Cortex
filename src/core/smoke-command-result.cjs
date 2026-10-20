// Synthetic renderer fixtures only: no model requests, commands, or approvals.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeCommandResult({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Command result smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(25); }
    throw new Error('Command result smoke timed out: ' + label);
  };
  const workspaceId = 'smoke-command-result-workspace', session = 'smoke-command-result-session', runId = 'smoke-command-result-run';
  const command = 'Write-Output "中文结果 <img src=x onerror=window.__commandResultUnsafe=1>"\nGet-Location';
  const args = { command, timeout_ms: 120000 };
  const stdout = '检查完成。\r\n保留真实换行、中文、引号 "value" 与路径 C:\\project\\src。\n<img src=x onerror=window.__commandResultUnsafe=1>\n';
  const stderr = '提示：此行由程序写入 stderr，不代表命令失败。\n';
  const success = { command, exitCode: 0, signal: null, terminated: null, stdout, stderr };
  const fixtures = [
    { id: 'success', result: JSON.stringify(success), status: /成功|正常|完成/u, success: true },
    { id: 'failed', result: { command, exitCode: 2, stdout: '', stderr: '找不到指定文件。\n    at ORIGINAL_STACK_DETAIL\n' }, status: /失败|未完成/u },
    { id: 'timeout', result: { command, exitCode: null, terminated: 'timeout', stdout: '部分结果\n', stderr: '' }, status: /超时/u },
    { id: 'output-limit', result: { command, exitCode: null, terminated: 'output_limit', stdout: '已保留的输出\n', stderr: '' }, status: /输出.*上限|输出.*限制|截断/u },
    { id: 'cancelled', result: { command, exitCode: null, terminated: 'cancelled', stdout: '', stderr: '' }, status: /取消|停止/u },
    { id: 'denied', result: { denied: true, message: '用户拒绝了命令执行，未启动进程。' }, status: /拒绝|未执行/u },
    { id: 'error', result: '错误：无法启动 PowerShell：ENOENT', status: /失败|未完成|错误/u },
    { id: 'unknown', result: { note: 'unknown result shape', checks: { passed: true } }, status: /未知|返回|未提供|无法确认/u },
    { id: 'signal', result: { command, exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' }, status: /信号|停止|结束/u }
  ];
  const visible = `node => {
    if (!node) return false;
    for(let parent=node.parentElement;parent;parent=parent.parentElement) {
      if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(node)) return false;
    }
    return node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true});
  }`;
  const emit = event => js(`handleEvent(${JSON.stringify({ workspaceId, sessionId: session, runId, ...event })})`);
  const cardSelector = id => `.tool-card[data-command-smoke-id="${id}"]`;
  const inspect = id => js(`(() => {
    const card=document.querySelector(${JSON.stringify(cardSelector(id))}), result=card?.querySelector('.command-result');
    const raw=card?.querySelector('.tool-technical-details'), pre=raw?.querySelector('pre:last-of-type');
    const extract=selector=>{const node=result?.querySelector(selector);return (node?.matches('pre,code')?node:node?.querySelector('pre,code'))?.textContent??null;};
    return {open:card?.open,status:result?.querySelector('.command-result-status')?.textContent||'',
      cardState:card?.dataset.status,running:card?.classList.contains('running'),title:card?.querySelector('.tool-title')?.textContent||'',badge:card?.querySelector('.tool-badge')?.textContent||'',
      state:result?.dataset.status||'',command:extract('.command-result-command'),stdout:extract('.command-result-stdout'),stderr:extract('.command-result-stderr'),
      rawOpen:raw?.open,rawSummary:raw?.querySelector(':scope > summary')?.textContent||'',rawVisible:(${visible})(pre),raw:pre?.textContent||'',
      resultVisible:(${visible})(result),unsafe:card?.querySelectorAll('img[src="x"],script,svg[onload]').length||0};
  })()`);
  const capture = async name => {
    win.webContents.invalidate(); await wait(150);
    await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const originalSize = win.getContentSize();
  let installed = false, stage = 'renderer ready';
  try {
    await fs.mkdir(output, { recursive: true });
    await js('window.synoraAppearance.ready');
    await until('renderer initial state', () => js('Boolean(appState&&!projectSwitching)'));
    win.setContentSize(1440, 1000);
    await js(`(() => {
      if(running||terminalRunning||promptSubmitting||approvals.size) throw new Error('Cannot interrupt an active task');
      window.__commandResultOriginal={appState,sessionId,restoringWorkspace,activeTaskActivity,latestTelemetry,followOutput,taskStateVersion,promptQueueVersion,taskKind,taskDemo,
        nodes:[...document.getElementById('messages').childNodes],welcomeHidden:document.getElementById('welcome').hidden,
        title:document.getElementById('conversation-title').textContent,status:document.getElementById('run-status').textContent};
      clearConversation();restoringWorkspace=true;sessionId=${JSON.stringify(session)};
      appState={...appState,workspaceId:${JSON.stringify(workspaceId)},sessionId,activeTask:{running:false,kind:null}};
      document.getElementById('conversation-title').textContent='命令结果预览';document.getElementById('notice').hidden=true;
    })()`);
    installed = true;
    await emit({ type: 'user-message', id: 'command-result-user', text: '请检查命令输出，以便查看结果。' });
    await emit({ type: 'run-start', startedAt: Date.now() - 1000, kind: 'agent', messageStartIndex: 0 });
    for (const fixture of fixtures) {
      stage = 'live ' + fixture.id;
      await emit({ type: 'tool-start', name: 'run_command', toolCallId: fixture.id, args });
      await emit({ type: 'tool-result', name: 'run_command', toolCallId: fixture.id, result: fixture.result });
      await js(`document.querySelector('.tool-card:last-of-type').dataset.commandSmokeId=${JSON.stringify(fixture.id)}`);
      const initial = await inspect(fixture.id);
      assert.equal(initial.open, false, 'A completed command must stay collapsed until requested');
      await js(`document.querySelector(${JSON.stringify(cardSelector(fixture.id) + ' > summary')}).click()`);
      await until(fixture.id + ' readable result', async () => (await inspect(fixture.id)).resultVisible);
      const current = await inspect(fixture.id);
      assert.match(current.status, fixture.status, fixture.id + ': accurate human-readable status');
      if (fixture.success) assert.equal(current.state, 'success', 'An exit-zero command must be presented as successful');
      else assert.notEqual(current.state, 'success', 'Unknown/interrupted/error output must never be green success');
      assert.equal(current.rawOpen, false, 'Raw JSON must remain separately collapsed');
      assert.equal(current.rawVisible, false);
      assert.match(current.rawSummary, /原始数据/u);
      assert.equal(current.command, command, 'Multiline commands must not be shown as JSON escapes');
      assert.equal(current.unsafe, 0, 'Command/result text must never be interpreted as HTML');
      if (fixture.id === 'success') {
        assert.equal(current.stdout, stdout, 'Readable stdout must preserve all original characters');
        assert.equal(current.stderr, stderr, 'stderr must remain readable without declaring exit zero a failure');
        await capture('human-readable-command.png');
        await js(`document.querySelector(${JSON.stringify(cardSelector(fixture.id) + ' .tool-technical-details > summary')}).click()`);
        await until('raw JSON explicitly expanded', async () => (await inspect(fixture.id)).rawVisible);
        const raw = (await inspect(fixture.id)).raw;
        assert.deepEqual(JSON.parse(raw), success, 'Full original result must remain available for troubleshooting');
        await js(`document.querySelector(${JSON.stringify(cardSelector(fixture.id) + ' .tool-technical-details > summary')}).click()`);
      } else if (fixture.id === 'failed') {
        assert.equal(current.stderr, fixture.result.stderr);
        await capture('human-readable-command-failed.png');
      } else if (typeof fixture.result === 'object' && fixture.result.stderr === '') assert.equal(current.stderr, null, 'Empty stderr should not create a redundant output pane');
      await js(`document.querySelector(${JSON.stringify(cardSelector(fixture.id))}).open=false`);
    }
    assert.equal(await js('window.__commandResultUnsafe||null'), null);
    stage = 'pending command when task ends without a result';
    await emit({ type: 'tool-start', name: 'run_command', toolCallId: 'missing-live', args });
    await js("document.querySelector('.tool-card:last-of-type').dataset.commandSmokeId='missing-live'");
    assert.equal((await inspect('missing-live')).state, 'running', 'An unresolved command is in progress before task termination');
    await emit({ type: 'run-end', status: 'completed', elapsedMs: 1000, startedAt: Date.now() - 1000, endedAt: Date.now(), messageStartIndex: 0, messageIndex: 3 });
    const pending = await inspect('missing-live');
    assert.equal(pending.state, 'unknown');assert.equal(pending.cardState, 'unknown');assert.equal(pending.running, false);
    assert.match(pending.status, /任务已结束.*未收到.*结果/u);assert.equal(pending.title, '命令结果未返回');assert.equal(pending.badge, '未返回结果');
    assert.equal(pending.command, command);assert.equal(pending.open, false);assert.equal(pending.rawOpen, false);
    stage = 'historical readable result reconstruction';
    const record = { runId, status: 'completed', startedAt: Date.now() - 1000, endedAt: Date.now(), elapsedMs: 1000, messageStartIndex: 0, messageIndex: 3 };
    const history = { id: session, temporary: false, taskRuns: [record], events: [{ type: 'run-end', ...record }], messages: [
      { role: 'user', content: '请检查命令输出。' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'history-command', name: 'run_command', arguments: args }] },
      { role: 'tool', toolCallId: 'history-command', content: JSON.stringify(success) },
      { role: 'assistant', content: '命令已正常结束，详细输出可展开查看。', toolCalls: [] }
    ] };
    await js(`renderSessionSnapshot(${JSON.stringify(history)})`);
    assert.equal(await js("document.querySelector('.task-activity').open"), false, 'History must reopen with completed operations collapsed');
    await js("document.querySelector('.task-activity').open=true;document.querySelector('.tool-card').dataset.commandSmokeId='history'");
    assert.equal((await inspect('history')).open, false);
    await js("document.querySelector('.tool-card > summary').click()");
    await until('history readable result painted', async () => (await inspect('history')).resultVisible);
    const historical = await inspect('history');
    assert.match(historical.status, fixtures[0].status);assert.equal(historical.stdout, stdout);assert.equal(historical.stderr, stderr);assert.equal(historical.command, command);
    assert.equal(historical.rawOpen, false);assert.equal(historical.rawVisible, false);assert.equal(historical.unsafe, 0);
    await capture('human-readable-command-history.png');
    stage = 'historical command missing its result';
    const missingRecord = { ...record, status: 'stopped', messageIndex: 2 };
    const missingHistory = { ...history, taskRuns: [missingRecord], events: [{ type: 'run-end', ...missingRecord }], messages: [history.messages[0],
      { role: 'assistant', content: '', toolCalls: [{ id: 'missing-history', name: 'run_command', arguments: args }] },
      { role: 'assistant', content: '任务已停止。', localOnly: true, toolCalls: [] }] };
    await js(`renderSessionSnapshot(${JSON.stringify(missingHistory)})`);
    await js("document.querySelector('.tool-card').dataset.commandSmokeId='missing-history'");
    const missing = await inspect('missing-history');
    assert.equal(missing.open, false);assert.equal(missing.state, 'unknown');assert.equal(missing.cardState, 'unknown');assert.equal(missing.running, false);
    assert.match(missing.status, /任务已结束.*未收到.*结果/u);assert.equal(missing.title, '命令结果未返回');assert.equal(missing.badge, '未返回结果');
    assert.equal(missing.rawOpen, false);assert.equal(missing.command, command);
    await js("document.querySelector('.task-activity').open=true;document.querySelector('.tool-card > summary').click()");
    await until('missing historical result remains readable', async () => (await inspect('missing-history')).resultVisible);
    const result = { status: 'completed', realApi: false, realCommands: false, statuses: fixtures.map(item => item.id), humanReadableMultilineOutput: true,
      originalDataExpandable: true, collapsedByDefault: true, unsafeHtmlRenderedAsText: true, historicalReconstruction: true, unresolvedCommandEndsAsUnknown: true, historicalMissingResultEndsAsUnknown: true,
      screenshots: ['human-readable-command.png', 'human-readable-command-failed.png', 'human-readable-command-history.png'] };
    await fs.writeFile(path.join(output, 'command-result-smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    try { await capture('command-result-failure.png'); } catch { /* Preserve the original assertion failure. */ }
    await fs.writeFile(path.join(output, 'command-result-smoke-result.json'), JSON.stringify({ status: 'failed', stage, error: error.message, stack: error.stack }, null, 2) + '\n');
    throw new Error('Command result smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (installed && !win.isDestroyed()) {
      await js(`(() => {
        const original=window.__commandResultOriginal;if(!original)return;
        finishStream();clearComposerApprovals({restoreFocus:false});clearConversation();setRunning(false);
        appState=original.appState;sessionId=original.sessionId;restoringWorkspace=original.restoringWorkspace;activeTaskActivity=original.activeTaskActivity;
        latestTelemetry=original.latestTelemetry;followOutput=original.followOutput;taskStateVersion=original.taskStateVersion;promptQueueVersion=original.promptQueueVersion;taskKind=original.taskKind;taskDemo=original.taskDemo;
        document.getElementById('messages').replaceChildren(...original.nodes);document.getElementById('welcome').hidden=original.welcomeHidden;
        document.getElementById('conversation-title').textContent=original.title;document.getElementById('run-status').textContent=original.status;
        renderSessionMetrics(appState?.sessionMetrics||null);renderComposerApproval({restoreFocus:false});refreshControlLocks();
        delete window.__commandResultOriginal;delete window.__commandResultUnsafe;
      })()`);
      win.setContentSize(...originalSize);
    }
  }
};
