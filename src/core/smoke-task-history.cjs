// A real offscreen renderer with synthetic, already-redacted task events.
// This helper never calls a model, executes a command, or approves an operation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeTaskHistory({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Task history smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Task history smoke timed out: ' + label);
  };
  const runId = 'smoke-task-history-completed';
  const stoppedId = 'smoke-task-history-stopped';
  const failedId = 'smoke-task-history-failed';
  const commentaryId = 'smoke-task-history-commentary';
  const workspaceId = 'smoke-task-history-workspace';
  const sessionId = 'smoke-task-history-session';
  const elapsedMs = 21 * 60_000 + 48_000;
  const privateThought = 'PRIVATE_PROVIDER_THOUGHT_MUST_NEVER_APPEAR';
  const command = "Write-Output 'TASK_HISTORY_SMOKE_OK'";
  const unsafePath = 'src/<img src=x onerror=window.__taskHistoryUnsafe=1>.md';
  const finalText = '已完成界面调整，并验证文件与命令结果。';
  const commentary = '我会先查看项目文件，再修改样式并执行检查。';
  const readResult = { path: unsafePath, content: '# 示例文件\n正文。' };
  const writeResult = { path: 'src/renderer/task-history.css', written: true };
  const commandResult = { exitCode: 0, stdout: 'TASK_HISTORY_SMOKE_OK\n', stderr: '' };
  const screenshotResult = { path: 'artifacts/task-history.png', width: 1440, height: 1000 };
  const startedAt = Date.now() - elapsedMs;
  const toolCall = (id, name, args) => ({ id, name, arguments: args });
  const messages = [
    { role: 'user', id: 'history-user-1', content: '请修改界面并检查结果。', createdAt: new Date(startedAt).toISOString() },
    { role: 'assistant', content: commentary, toolCalls: [toolCall('history-read', 'read_file', { path: unsafePath })] },
    { role: 'tool', toolCallId: 'history-read', content: JSON.stringify(readResult) },
    { role: 'assistant', content: '文件已查看，现在更新样式。', toolCalls: [toolCall('history-write', 'write_file', { path: 'src/renderer/task-history.css', content: '.sample { color: white; }' })] },
    { role: 'tool', toolCallId: 'history-write', content: JSON.stringify(writeResult) },
    { role: 'assistant', content: '', toolCalls: [toolCall('history-command', 'run_command', { command, timeout_ms: 5000 })] },
    { role: 'tool', toolCallId: 'history-command', content: JSON.stringify(commandResult) },
    { role: 'assistant', content: '', toolCalls: [toolCall('history-image', 'browser_screenshot', {})] },
    { role: 'tool', toolCallId: 'history-image', content: JSON.stringify(screenshotResult) },
    { role: 'assistant', content: finalText, toolCalls: [] }
  ];
  const completedRecord = { runId, status: 'completed', startedAt, endedAt: startedAt + elapsedMs, elapsedMs, messageStartIndex: 0, messageIndex: 9, telemetry: { tokensPerSecond: 42.5, outputTokens: 850, elapsedMs, estimated: false } };
  const stoppedRecord = { runId: stoppedId, status: 'stopped', startedAt: startedAt + elapsedMs + 1000, endedAt: startedAt + elapsedMs + 6000, elapsedMs: 5000, messageStartIndex: 10, messageIndex: 11 };
  const failedRecord = { runId: failedId, status: 'failed', startedAt: startedAt + elapsedMs + 7000, endedAt: startedAt + elapsedMs + 14_000, elapsedMs: 7000, messageStartIndex: 12, messageIndex: 13, error: 'TASK_HISTORY_EXPECTED_FAILURE' };
  const events = [];
  const visibleSource = `node => {
    if (!node) return false;
    // Chromium may retain layout rectangles under a closed <details> using
    // content-visibility. Rectangles alone do not mean the content is painted.
    for (let parent=node.parentElement; parent; parent=parent.parentElement) {
      if (parent.tagName !== 'DETAILS' || parent.open) continue;
      const summary=parent.querySelector(':scope > summary');
      if (!summary?.contains(node)) return false;
    }
    if (typeof node.checkVisibility === 'function') return node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true});
    const style=getComputedStyle(node);
    return !!node.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }`;
  const emit = async event => {
    const value = { workspaceId, sessionId, runId, ...event };
    events.push(value);
    await js(`handleEvent(${JSON.stringify(value)})`);
  };
  const select = id => `.task-activity[data-run-id="${id}"]`;
  const inspect = id => js(`(() => {
    const visible = ${visibleSource};
    const group = document.querySelector(${JSON.stringify(select(id))});
    if (!group) return null;
    const summary = group.querySelector(':scope > summary');
    const body = group.querySelector(':scope > .task-activity-events');
    const text = group.textContent;
    const answer = [...document.querySelectorAll('#messages > .message.assistant')].find(node => node.querySelector('.message-body')?.textContent === ${JSON.stringify(finalText)});
    return {
      tag: group.tagName, status: group.dataset.status, open: group.open,
      summary: summary?.textContent || '', elapsed: group.querySelector('.task-activity-elapsed')?.textContent || '',
      phase: group.querySelector('.task-activity-phase')?.textContent || '',
      body: !!body, toolCount: body?.querySelectorAll('.tool-card .tool-title').length || 0,
      text, bodyVisible: visible(body),
      nestedAnswer: !!body?.querySelector('.message.assistant .message-body') && [...body.querySelectorAll('.message-body')].some(node => node.textContent === ${JSON.stringify(finalText)}),
      answerVisible: visible(answer),
      answerAfterGroup: !!answer && !!(group.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING),
      approvalVisible: visible(document.querySelector('#composer-approval .approval-accept:not(:disabled)')),
      approvalInComposer: !!document.querySelector('#composer-approval .approval-card') && !document.querySelector('#messages .approval-card'),
      approvalText: document.getElementById('composer-approval')?.textContent || '',
      composerReplaced: document.getElementById('task-form')?.hidden === true && document.getElementById('composer-approval')?.hidden === false,
      commandText: body?.querySelector('.command-output')?.textContent || '',
      unsafeElements: group.querySelectorAll('img[src="x"],script,svg[onload]').length,
      rawThoughtVisible: document.getElementById('messages').textContent.includes(${JSON.stringify(privateThought)})
    };
  })()`);
  const capture = async name => {
    win.webContents.invalidate();
    await wait(125);
    await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const keyboardToggle = async id => {
    const before = await inspect(id);
    win.webContents.focus();
    await js(`(() => {
      const summary = document.querySelector(${JSON.stringify(select(id) + ' > summary')});
      if (!summary) throw new Error('Task history summary missing');
      summary.scrollIntoView({ block: 'center' }); summary.focus();
      window.__taskHistoryNativeKeys=[];
      for(const name of ['keydown','keypress','keyup']) summary.addEventListener(name,event=>window.__taskHistoryNativeKeys.push({type:event.type,key:event.key,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented}),{once:true});
      if(document.activeElement!==summary)throw new Error('Task history summary could not receive keyboard focus');
    })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    // sendInputEvent does not synthesize the text/keypress part of a Windows
    // key sequence. Native <summary> activation on Enter needs that part too.
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(100);
    const after = await inspect(id);
    const keys = await js('window.__taskHistoryNativeKeys');
    assert.ok(keys.some(event => event.trusted && event.key === 'Enter'), 'Disclosure did not receive a trusted native Enter event: ' + JSON.stringify(keys));
    assert.equal(after?.open, !before?.open, 'Native Enter failed to toggle disclosure ' + id + ': ' + JSON.stringify({ before: before?.open, after: after?.open, keys }));
  };
  const originalSize = win.getContentSize();
  let installed = false, stage = 'renderer ready';
  try {
    await fs.mkdir(output, { recursive: true });
    await js('window.synoraAppearance.ready');
    await until('renderer initial state available', () => js('Boolean(appState && !projectSwitching)'));
    win.setContentSize(1440, 1000);
    stage = 'save isolated renderer state';
    await js(`(() => {
      if (running || terminalRunning || promptSubmitting || approvals.size) throw new Error('Task history smoke cannot interrupt an active task');
      window.__taskHistorySmokeOriginal = {
        appState, sessionId, restoringWorkspace, activeTaskActivity, latestTelemetry,
        nodes: [...document.getElementById('messages').childNodes],
        welcomeHidden: document.getElementById('welcome').hidden,
        title: document.getElementById('conversation-title').textContent,
        status: document.getElementById('run-status').textContent,
        metrics: appState?.sessionMetrics || null,
        followOutput, taskStateVersion, promptQueueVersion, taskKind, taskDemo
      };
      clearConversation();
      restoringWorkspace = true;
      appState = { ...appState, workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(sessionId)}, activeTask: { running: false, kind: null } };
      sessionId = ${JSON.stringify(sessionId)};
      document.getElementById('conversation-title').textContent = '操作过程预览';
      document.getElementById('notice').hidden = true;
    })()`);
    installed = true;
    stage = 'running operations';
    await emit({ type: 'user-message', id: 'history-user-1', text: messages[0].content, createdAt: messages[0].createdAt });
    await emit({ type: 'run-start', startedAt, messageStartIndex: 0, kind: 'agent' });
    const initial = await inspect(runId);
    assert.equal(initial?.tag, 'DETAILS');
    assert.equal(initial.status, 'running');
    assert.equal(initial.open, true, 'Running operation history must initially be expanded');
    assert.equal(initial.body, true);
    await emit({ type: 'telemetry', phase: 'thinking', elapsedMs: 1000, reasoning: privateThought, tokensPerSecond: 39.5, estimated: true, estimatedOutputTokens: 40 });
    assert.match((await inspect(runId)).phase, /思考|推理/u);
    await emit({ type: 'text-delta', text: commentary });
    await emit({ type: 'assistant-message', text: commentary });
    await emit({ type: 'tool-start', name: 'read_file', args: { path: unsafePath } });
    let live = await inspect(runId);
    assert.match(live.phase, /读取.*文件/u);
    assert.ok(live.text.includes(unsafePath), 'File operations should identify the file');
    assert.equal(live.unsafeElements, 0);
    assert.equal(await js('window.__taskHistoryUnsafe || null'), null);
    await emit({ type: 'tool-result', name: 'read_file', result: readResult });
    await emit({ type: 'assistant-message', text: messages[3].content });
    await emit({ type: 'tool-start', name: 'write_file', args: messages[3].toolCalls[0].arguments });
    await emit({ type: 'tool-result', name: 'write_file', result: writeResult });
    await emit({ type: 'tool-start', name: 'run_command', args: { command, timeout_ms: 5000 } });
    // A pending decision is always reachable in the composer, even when its
    // task process is collapsed and the reader is viewing earlier messages.
    stage = 'native keyboard collapse before approval';
    await keyboardToggle(runId);
    assert.equal((await inspect(runId)).open, false, 'Native keyboard collapse did not close the running history');
    stage = 'pending approval temporarily replaces composer';
    await emit({ type: 'approval-request', id: 'history-command-approval', kind: 'command', title: '运行检查命令', path: 'smoke-project', detail: '仅供界面测试，不会执行。', command });
    live = await until('pending approval remains reachable', async () => { const value = await inspect(runId); return value?.approvalVisible && value.approvalInComposer && value.composerReplaced && value; });
    assert.match(live.phase, /等待.*确认/u);
    assert.match(live.approvalText, /运行检查命令/u);
    await emit({ type: 'approval-resolved', id: 'history-command-approval', approved: true });
    assert.equal(await js("document.getElementById('composer-approval').hidden&&document.getElementById('composer-approval').childElementCount===0&&!document.getElementById('task-form').hidden"),true,'Resolved decision must restore the message composer');
    await js(`document.querySelector(${JSON.stringify(select(runId))}).open=true`);
    await emit({ type: 'command-output', text: 'TASK_HISTORY_SMOKE_OK\n<img src=x onerror=window.__taskHistoryUnsafe=1>\n' });
    await emit({ type: 'tool-result', name: 'run_command', result: commandResult });
    await emit({ type: 'tool-start', name: 'browser_screenshot', args: {} });
    await emit({ type: 'tool-result', name: 'browser_screenshot', result: screenshotResult });
    live = await inspect(runId);
    assert.equal(live.toolCount, 4);
    assert.ok(live.commandText.includes('TASK_HISTORY_SMOKE_OK'));
    assert.equal(live.unsafeElements, 0);
    assert.equal(live.rawThoughtVisible, false);
    // A stale workspace event may not alter the currently visible process.
    const previousText = live.text;
    await emit({ type: 'assistant-message', workspaceId: 'another-workspace', text: 'STALE_WORKSPACE_TEXT_MUST_NOT_APPEAR' });
    assert.equal((await inspect(runId)).text, previousText);
    await capture('task-history-running.png');
    stage = 'completion collapse and visible final answer';
    await emit({ type: 'text-delta', text: finalText });
    await emit({ type: 'assistant-message', text: finalText });
    await emit({ type: 'run-end', ...completedRecord });
    const completed = await inspect(runId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.open, false, 'Completed operations should collapse automatically');
    assert.match(completed.summary.replace(/\s/g, ''), /用时21(?:m|分(?:钟)?)48(?:s|秒)/u);
    assert.equal(completed.toolCount, 4, 'Collapsed operations must remain in the DOM');
    assert.equal(completed.bodyVisible, false);
    assert.equal(completed.answerVisible, true, 'Final answer should remain visible after operations collapse');
    assert.equal(completed.nestedAnswer, false, 'Final answer must remain outside the collapsed history');
    assert.equal(completed.answerAfterGroup, true);
    assert.equal(await js("document.querySelectorAll('#messages .approval-card,#composer-approval .approval-card').length"),0,'Completed task must not retain live approval controls');
    await capture('task-history-completed.png');
    stage = 'native keyboard expands completed operations';
    await keyboardToggle(runId);
    const expanded = await inspect(runId);
    assert.equal(expanded.open, true);
    assert.equal(expanded.bodyVisible, true);
    assert.ok(expanded.text.includes(commentary));
    assert.ok(expanded.text.includes('src/renderer/task-history.css'));
    assert.ok(expanded.text.includes(command));
    // Individual operations retain independent disclosure controls.
    stage = 'individual operation disclosure is painted';
    await js(`(() => { const card=document.querySelector(${JSON.stringify(select(runId) + ' .tool-card')}); if(!card)throw new Error('Tool operation missing'); card.querySelector('summary').click(); })()`);
    assert.equal(await js(`document.querySelector(${JSON.stringify(select(runId) + ' .tool-card')}).open`), true);
    await until('expanded native operation details painted', () => js(`(${visibleSource})(document.querySelector(${JSON.stringify(select(runId) + ' .tool-card .tool-details')}))`), 1000);
    await capture('task-history-expanded.png');

    // Each later run owns its duration and status, including interrupted work.
    stage = 'stopped and failed task separation';
    for (const record of [stoppedRecord, failedRecord]) {
      const partial = record.status === 'stopped' ? '停止前的操作说明。' : '失败前的操作说明。';
      await emit({ type: 'user-message', runId: record.runId, id: record.runId + '-user', text: record.status === 'stopped' ? '请测试停止操作。' : '请测试失败操作。' });
      await emit({ type: 'run-start', ...record, status: undefined, kind: 'agent' });
      // The provider never confirmed this text as a completed assistant message.
      // Stopping/failing must retain it as partial process text inside the run.
      await emit({ type: 'text-delta', runId: record.runId, text: partial });
      await emit({ type: 'approval-request', runId: record.runId, id: record.runId + '-pending', kind: 'command', title: '结束前等待确认', command: 'DISPLAY_ONLY_DO_NOT_EXECUTE', detail: '仅供显示测试，任务结束后此请求必须失效。' });
      assert.equal((await inspect(record.runId)).composerReplaced,true,'Pending decision must replace the composer before task termination');
      await emit({ type: 'run-end', ...record });
      const result = await inspect(record.runId);
      assert.equal(result.status, record.status);
      assert.equal(result.open, false);
      assert.ok(result.text.includes(partial), 'Interrupted stream text should remain in its operation history');
      assert.equal(await js(`[...document.querySelectorAll('#messages > .message.assistant .message-body')].some(node=>node.textContent===${JSON.stringify(partial)})`), false, 'Interrupted stream text must not be promoted into a final answer');
      assert.equal(await js("document.getElementById('composer-approval').hidden&&document.getElementById('composer-approval').childElementCount===0&&!document.getElementById('task-form').hidden&&approvals.size===0"),true,'Stopped or failed task must expire pending decisions and restore the composer');
      assert.equal((await inspect(runId)).elapsed, completed.elapsed, 'A later task must not restart an earlier task duration');
    }
    assert.equal(await js('document.querySelectorAll("#messages > .task-activity").length'), 3);

    stage = 'tool-bearing commentary is not a final answer';
    const toolCommentary = '下一步准备运行检查命令。';
    await emit({ type: 'user-message', runId: commentaryId, id: commentaryId + '-user', text: '验证调用工具前停止。' });
    await emit({ type: 'run-start', runId: commentaryId, startedAt: Date.now() - 12_000, kind: 'agent', messageStartIndex: 14 });
    await emit({ type: 'text-delta', runId: commentaryId, text: toolCommentary });
    await emit({ type: 'assistant-message', runId: commentaryId, text: toolCommentary, toolCallCount: 1 });
    await emit({ type: 'run-end', runId: commentaryId, status: 'stopped', elapsedMs: 12_000, messageStartIndex: 14, messageIndex: 15 });
    const stoppedCommentary = await inspect(commentaryId);
    assert.equal(stoppedCommentary.status, 'stopped');
    assert.equal(stoppedCommentary.open, false);
    assert.ok(stoppedCommentary.text.includes(toolCommentary), 'Tool-bearing commentary should remain inspectable');
    assert.equal(await js(`[...document.querySelectorAll('#messages > .message.assistant .message-body')].some(node=>node.textContent===${JSON.stringify(toolCommentary)})`), false, 'A confirmed assistant message containing tool calls is commentary rather than a final answer');

    // Recreate the same run history from the persisted public message model.
    stage = 'history reconstruction';
    const archivedMessages = [
      ...messages,
      { role: 'user', content: '请测试停止操作。' },
      { role: 'assistant', content: '停止前的操作说明。', localOnly: true, toolCalls: [] },
      { role: 'user', content: '请测试失败操作。' },
      { role: 'assistant', content: '失败前的操作说明。', localOnly: true, toolCalls: [] }
    ];
    const archivedEvents = [
      { type: 'approval-request', runId, id: 'history-command-approval', kind: 'command', title: '运行检查命令', path: 'smoke-project', command, messageIndex: 5 },
      { type: 'approval-resolved', runId, id: 'history-command-approval', approved: true, messageIndex: 5 },
      { type: 'command-output', runId, text: 'TASK_HISTORY_SMOKE_OK\n', messageIndex: 5 },
      { type: 'run-end', ...completedRecord }, { type: 'run-end', ...stoppedRecord }, { type: 'run-end', ...failedRecord }
    ];
    await js(`renderSessionSnapshot(${JSON.stringify({ id: sessionId, messages: archivedMessages, events: archivedEvents, taskRuns: [completedRecord, stoppedRecord, failedRecord], temporary: false })})`);
    const reloaded = await inspect(runId);
    assert.equal(reloaded.open, false);
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.elapsed, completed.elapsed);
    assert.equal(reloaded.toolCount, 4);
    assert.equal(reloaded.answerVisible, true);
    assert.equal(reloaded.nestedAnswer, false);
    assert.equal(reloaded.answerAfterGroup, true);
    assert.equal(reloaded.unsafeElements, 0);
    assert.equal(reloaded.rawThoughtVisible, false);
    assert.equal(await js("document.querySelectorAll('#messages .approval-card,#composer-approval .approval-card').length"),0,'Historical approvals must not restore interactive decision cards');
    for (const record of [stoppedRecord, failedRecord]) {
      const restored = await inspect(record.runId);
      assert.equal(restored.status, record.status);
      assert.equal(restored.open, false);
      assert.ok(restored.text.includes(record.status === 'stopped' ? '停止前的操作说明。' : '失败前的操作说明。'));
    }
    await keyboardToggle(runId);
    const reloadedExpanded = await inspect(runId);
    assert.ok(reloadedExpanded.text.includes(unsafePath));
    assert.ok(reloadedExpanded.text.includes(command));
    assert.match(reloadedExpanded.text, /(?:已读取|已查看).*文件|读取文件/u);
    assert.match(reloadedExpanded.text, /(?:已写入|已编辑|已修改|写入文件)/u);
    await capture('task-history-reloaded.png');
    const final = {
      status: 'completed', realApi: false, realCommands: false,
      completed: { status: completed.status, elapsed: completed.elapsed, tools: completed.toolCount, finalAnswerOutsideHistory: !completed.nestedAnswer, finalAnswerVisible: completed.answerVisible },
      stopped: (await inspect(stoppedId)).status, failed: (await inspect(failedId)).status,
      nativeKeyboardDisclosure: true, individualOperationDisclosure: true, pendingApprovalVisible: true,composerApproval:true,pendingApprovalExpiresOnEnd:true,
      interruptedStreamRemainsInsideHistory: true, toolBearingCommentaryRemainsInsideHistory: true,
      historyReconstruction: true, workspaceEventIsolation: true, unsafeHtmlRenderedAsText: true, privateReasoningHidden: true,
      syntheticEventCount: events.length,
      screenshots: ['task-history-running.png', 'task-history-completed.png', 'task-history-expanded.png', 'task-history-reloaded.png']
    };
    await fs.writeFile(path.join(output, 'task-history-smoke-result.json'), JSON.stringify(final, null, 2) + '\n');
    return final;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack };
    if (!win.isDestroyed()) {
      try {
        failure.groups = await Promise.all([runId, stoppedId, failedId, commentaryId].map(inspect));
        failure.nativeKeys = await js('window.__taskHistoryNativeKeys || []');
        failure.operationVisibility = await js(`(() => {
          const node=document.querySelector(${JSON.stringify(select(runId) + ' .tool-card .tool-details')});
          if(!node)return null;
          const style=getComputedStyle(node),rect=node.getBoundingClientRect();
          const ancestors=[];
          for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')ancestors.push({class:parent.className,open:parent.open,contentVisibility:getComputedStyle(parent).contentVisibility});
          return {nativeCheck:node.checkVisibility?.({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true}),display:style.display,visibility:style.visibility,opacity:style.opacity,rect:{top:rect.top,height:rect.height,width:rect.width},ancestors};
        })()`);
        await capture('task-history-failure.png');
      } catch (diagnosticError) { failure.diagnosticError = diagnosticError.message; }
    }
    await fs.writeFile(path.join(output, 'task-history-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Task history smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (installed && !win.isDestroyed()) {
      await js(`(() => {
        const original=window.__taskHistorySmokeOriginal;
        if(!original)return;
        finishStream(); clearComposerApprovals({restoreFocus:false}); clearConversation(); setRunning(false);
        appState=original.appState; sessionId=original.sessionId;
        restoringWorkspace=original.restoringWorkspace; followOutput=original.followOutput;
        activeTaskActivity=original.activeTaskActivity; latestTelemetry=original.latestTelemetry;
        taskStateVersion=original.taskStateVersion; promptQueueVersion=original.promptQueueVersion;
        taskKind=original.taskKind; taskDemo=original.taskDemo;
        document.getElementById('messages').replaceChildren(...original.nodes);
        document.getElementById('welcome').hidden=original.welcomeHidden;
        document.getElementById('conversation-title').textContent=original.title;
        document.getElementById('run-status').textContent=original.status;
        renderSessionMetrics(original.metrics); renderComposerApproval({restoreFocus:false}); refreshControlLocks();
        delete window.__taskHistorySmokeOriginal; delete window.__taskHistoryUnsafe; delete window.__taskHistoryNativeKeys;
      })()`);
      win.setContentSize(...originalSize);
    }
  }
};
