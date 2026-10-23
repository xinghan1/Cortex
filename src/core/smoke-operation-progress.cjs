// Display-only tool fixtures use the app's original rendering and completion paths.
// Real command/model and compaction lifecycles are exercised by smoke-activity and
// smoke-compaction. No fixture below invokes a model, command, or filesystem tool.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeOperationProgress({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Operation progress smoke requires isolated offscreen UI');
  const nonce = randomUUID(), evidence = { displayFixtures: true, executedTools: 0, cases: [] };
  let child, attached = false, originalAppearance, stage = 'initialize isolated renderer';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Operation progress smoke timed out: ' + label);
  };
  const js = code => child.webContents.executeJavaScript(code);
  const call = (name, arg) => js(`window.forge[${JSON.stringify(name)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const media = value => child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  const snapshot = selector => js(`(() => {
    const node=document.querySelector(${JSON.stringify(selector)});if(!node)return null;
    const style=getComputedStyle(node),rect=node.getBoundingClientRect(),animation=node.getAnimations().find(item=>item.animationName==='context-status-shimmer');
    return {text:node.textContent,name:style.animationName,position:style.backgroundPosition,duration:style.animationDuration,playState:style.animationPlayState,
      image:style.backgroundImage,fill:style.webkitTextFillColor,color:style.color,width:rect.width,height:rect.height,
      visible:node.checkVisibility({visibilityProperty:true,opacityProperty:true}),keyframes:animation?.effect?.getKeyframes().map(frame=>frame.backgroundPosition||[frame.backgroundPositionX,frame.backgroundPositionY].join(' ')),
      reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,style:document.documentElement.dataset.uiStyle};
  })()`);
  const active = async (selector, label) => {
    const initial = await until(label + ' visible active sweep', async () => { const value = await snapshot(selector); return value?.visible && value.name.includes('context-status-shimmer') && value.playState === 'running' && parseFloat(value.duration) > 0 && value; });
    assert.equal(initial.visible, true, label + ' animated text must be visible');
    assert.ok(initial.width > 0 && initial.height > 0);
    assert.equal(initial.keyframes?.length, 2, label + ' must animate the highlight position');
    assert.match(initial.keyframes[0], /^100%\s+0(?:px|%)?$/u, label + ' highlight starts at the left side of the text');
    assert.match(initial.keyframes[1], /^0%\s+0(?:px|%)?$/u, label + ' highlight ends at the right side of the text');
    await until(label + ' highlight position changes over time', async () => (await snapshot(selector))?.position !== initial.position);
    return initial;
  };
  const inactive = async (selector, label) => {
    const value = await until(label + ' sweep stops', async () => { const value = await snapshot(selector); return value && value.name === 'none' && value; });
    assert.notEqual(value.fill, 'rgba(0, 0, 0, 0)', label + ' completed label remains legible');
    return value;
  };
  const capture = async name => { child.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  const click = async selector => {
    const point = await until('uncovered visible control ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      if(fileDisclosureReveal)return null;node.scrollIntoView({block:'nearest',behavior:'instant'});
      const rect=node.getBoundingClientRect(),point={x:Math.round(rect.left+Math.min(100,rect.width/2)),y:Math.round(rect.top+rect.height/2)};
      return node.contains(document.elementFromPoint(point.x,point.y))?point:null;
    })()`));
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const setup = async name => js(`(() => {
    cancelFileDisclosureReveal();fileDisclosureScrollPaused=false;clearInterval(taskActivityTimer);taskActivityTimer=null;
    activeTaskActivity?.compaction?.remove();pendingTools=[];activeTaskActivity=null;running=false;contextCompacting=false;taskKind='agent';commandOutput=null;
    $('messages').replaceChildren();renderedUserMessageIds.clear();$('welcome').hidden=true;$('notice').hidden=true;setPreviewOpen(false);$('terminal-panel').hidden=true;
    const runId=${JSON.stringify(nonce)}+'-'+${JSON.stringify(name)};
    addMessage('user','操作进度显示样例：'+${JSON.stringify(name)},false,{id:'fixture-'+runId});
    setRunning(true,{kind:'agent',runId});window.__progressFixture={runId,sequence:0,events:new Map()};
    window.__progressFixture.add=name=>{
      const toolCallId='progress-tool-'+(++window.__progressFixture.sequence),event={name,toolCallId,runId,args:name==='run_command'?{command:'DISPLAY_ONLY_COMMAND'}:{path:'src/fixture.txt',query:'DISPLAY_ONLY_QUERY'}};
      addTool(event);const tool=pendingTools.find(tool=>tool.toolCallId===toolCallId);tool.card.id=toolCallId;window.__progressFixture.events.set(toolCallId,event);return toolCallId;
    };
    window.__progressFixture.finish=(id,status)=>{
      const event=window.__progressFixture.events.get(id),tool=pendingTools.find(tool=>tool.toolCallId===id);
      if(status==='unknown'){pendingTools.splice(pendingTools.indexOf(tool),1);finishToolWithoutResult(tool);return;}
      const result=status==='failed'?{error:'Display-only operation failure'}:status==='denied'?{denied:true,message:'Display-only denied'}:
        event.name==='run_command'?{command:event.args.command,stdout:'DISPLAY_ONLY_RESULT',stderr:'',exitCode:status==='stopped'?null:0,signal:null,terminated:status==='stopped'?'cancelled':null}:
        {path:event.args.path,content:'Display-only result',files:[]};
      completeTool({...event,result:JSON.stringify(result)});
    };
    followOutput=true;return runId;
  })()`);
  const add = name => js(`window.__progressFixture.add(${JSON.stringify(name)})`);
  const finish = (id, status) => js(`window.__progressFixture.finish(${JSON.stringify(id)},${JSON.stringify(status)});true`);
  const title = id => '#' + id + ' > .tool-summary .tool-title';
  const groupTitle = '.tool-operation-group > .tool-operation-group-summary .tool-operation-group-label';
  const timeOnly = async label => {
    const rows = await js(`Array.from(document.querySelectorAll('.task-activity-summary'),node=>({text:node.innerText.trim(),elapsed:node.querySelector('.task-activity-elapsed')?.innerText.trim(),phase:!!node.querySelector('.task-activity-phase'),chevron:node.querySelectorAll('.task-history-chevron').length}))`);
    assert.ok(rows.length, label + ' needs a duration summary');
    for (const row of rows) { assert.equal(row.text, row.elapsed, label + ' summary must contain only duration'); assert.match(row.text, /^用时\s/u); assert.equal(row.phase, false); assert.equal(row.chevron, 1); }
    return rows;
  };
  try {
    await fs.mkdir(output, { recursive: true });
    const created = await win.webContents.executeJavaScript('window.forge.newWindow()'); child = BrowserWindow.fromId(created.id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('renderer initialized', () => js('Boolean(appState&&window.ForgeToolOperationGroups&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    child.webContents.debugger.attach('1.3'); attached = true; await media('no-preference');
    originalAppearance = await call('getAppearance');
    await call('setAppearance', { uiStyle: 'black' }); await js('window.synoraAppearance.settled()');

    for (const name of ['read_file', 'list_files', 'run_command', 'search_files']) {
      stage = 'single ' + name + ' lifecycle'; await setup(name);
      const id = await add(name), running = await active(title(id), name);
      await timeOnly(name + ' running');
      assert.equal(await js(`document.querySelector('.task-activity > .task-activity-phase-line').hidden`), true, 'Tool card must carry the operation without a duplicate general status row');
      if (name === 'read_file') await capture('operation-progress-read-running.png');
      await finish(id, 'completed');
      const completed = await inactive(title(id), name + ' completed');
      evidence.cases.push({ name, running, completed });
    }

    for (const [name, status] of [['read_file', 'completed'], ['read_file', 'failed'], ['run_command', 'stopped'], ['run_command', 'unknown'], ['search_files', 'completed'], ['search_files', 'denied']]) {
      stage = 'group ' + name + ' ' + status; await setup(name + '-' + status);
      const first = await add(name); await finish(first, 'completed'); const second = await add(name);
      assert.equal(await js('document.querySelector(".tool-operation-group").open'), false, 'New operation group must start collapsed');
      await active(groupTitle, stage);
      await inactive(title(first), stage + ' completed member');
      await click('.tool-operation-group > summary');
      await until('native click expands running group', () => js('document.querySelector(".tool-operation-group").open'));
      await active(title(second), stage + ' running member'); await inactive(title(first), stage + ' expanded completed member');
      if (name === 'search_files' && status === 'completed') await capture('operation-progress-search-running.png');
      await finish(second, status); await inactive(groupTitle, stage + ' group ended'); await inactive(title(second), stage + ' member ended');
      const group = await js(`(()=>{const node=document.querySelector('.tool-operation-group');return {status:node.dataset.status,open:node.open,text:node.querySelector('summary').innerText};})()`);
      assert.equal(group.status, status); assert.equal(group.open, true, 'Completion preserves the user expansion');
      evidence.cases.push({ name, status, group });
    }

    stage = 'white material and reduced motion'; await setup('white-motion');
    const first = await add('search_files'); await finish(first, 'completed'); await add('search_files');
    await call('setAppearance', { uiStyle: 'white' }); await js('window.synoraAppearance.settled()');
    const white = await active(groupTitle, 'white search group'); assert.equal(white.style, 'white');
    assert.ok(white.image.includes('linear-gradient')); assert.notEqual(white.color, 'rgb(255, 255, 255)');
    await capture('operation-progress-white.png');
    await media('reduce');
    const reduced = await inactive(groupTitle, 'reduced motion group'); assert.equal(reduced.reduced, true); assert.equal(reduced.fill, reduced.color);
    await inactive(title(first), 'reduced motion completed member');
    await media('no-preference'); await active(groupTitle, 'motion re-enabled');
    evidence.white = white; evidence.reducedMotion = reduced;

    stage = 'thinking and steering flow follow original operation order'; await setup('flow');
    const read = await add('read_file'); await finish(read, 'completed');
    await js(`addMessage('assistant','FLOW_COMMENTARY');handleEvent({type:'user-message',workspaceId:currentWorkspaceId(),runId:window.__progressFixture.runId,id:'flow-steer-${nonce}',text:'FLOW_STEERING',source:'steering',createdAt:'2026-10-23T00:00:00Z'});true`);
    const search = await add('search_files'); await finish(search, 'completed');
    await js(`updateTelemetry({runId:window.__progressFixture.runId,phase:'thinking',elapsedMs:1600});true`);
    await active('.task-activity.running > .task-activity-phase-line .task-activity-phase', 'thinking at the flow end');
    await timeOnly('thinking');
    const flow = await js(`(()=>{const read=$(${JSON.stringify(read)}),search=$(${JSON.stringify(search)}),steering=[...document.querySelectorAll('.message.user')].find(n=>n.textContent.includes('FLOW_STEERING')),commentary=[...document.querySelectorAll('.message.assistant')].find(n=>n.textContent.includes('FLOW_COMMENTARY')),phase=document.querySelector('.task-activity.running > .task-activity-phase-line'),summary=document.querySelector('.task-activity-summary');const before=(a,b)=>!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);return {summaryBefore:before(summary,read),readBeforeCommentary:before(read,commentary),commentaryBeforeSteering:before(commentary,steering),steeringBeforeSearch:before(steering,search),searchBeforeThinking:before(search,phase),phaseInSummary:!!phase.closest('summary')};})()`);
    assert.deepEqual(flow, { summaryBefore: true, readBeforeCommentary: true, commentaryBeforeSteering: true, steeringBeforeSearch: true, searchBeforeThinking: true, phaseInSummary: false });
    await capture('operation-progress-flow.png'); evidence.flow = flow;
    await js(`finishTaskActivity({runId:window.__progressFixture.runId,status:'completed',elapsedMs:1800});setRunning(false);true`);
    await timeOnly('finished round');
    assert.equal(await js(`document.querySelectorAll('.task-activity-summary .task-activity-phase').length`), 0);

    stage = 'historical tool cards never animate';
    const history = { id: randomUUID(), title: 'Operation progress display history', workspace: null,
      messages: [{ id: 'progress-history-user', role: 'user', content: 'DISPLAY_ONLY_HISTORY' }], events: [], taskRuns: [], fileEdits: [] };
    for (const [index, name] of ['read_file', 'read_file', 'search_files', 'search_files', 'run_command'].entries()) {
      const id = 'history-progress-' + index, args = name === 'run_command' ? { command: 'DISPLAY_ONLY_COMMAND' } : { path: 'src/fixture.txt', query: 'DISPLAY_ONLY_QUERY' };
      history.messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] });
      history.messages.push({ role: 'tool', name, toolCallId: id, content: JSON.stringify(name === 'run_command' ? { command: args.command, stdout: 'DISPLAY_ONLY_RESULT', stderr: '', exitCode: 0, signal: null, terminated: null } : { path: args.path, content: 'Display-only history', files: [] }) });
    }
    history.messages.push({ role: 'assistant', content: '历史显示样例结束。', toolCalls: [] });
    history.taskRuns.push({ runId: 'history-progress-' + nonce, kind: 'agent', status: 'completed', startedAt: Date.now() - 3000, endedAt: Date.now(), elapsedMs: 3000, messageStartIndex: 0, messageIndex: history.messages.length - 1 });
    await js(`renderSessionSnapshot(${JSON.stringify(history)});true`); await timeOnly('restored history');
    const historical = await js(`Array.from(document.querySelectorAll('#messages .tool-title,#messages .tool-operation-group-label,#messages .task-activity-phase'),node=>({text:node.textContent,animation:getComputedStyle(node).animationName}))`);
    assert.ok(historical.length >= 7); assert.ok(historical.every(node => node.animation === 'none'), 'Historical operations must remain still');
    evidence.historical = historical; await capture('operation-progress-history.png');
    await fs.writeFile(path.join(output, 'operation-progress-evidence.json'), JSON.stringify(evidence, null, 2));
    return { status: 'completed', displayFixtures: true, executedTools: 0, liveToolSweeps: true, collapsedGroupSweeps: true,
      completedMembersStayStill: true, terminalStatesStopSweep: true, durationOnlySummaries: true, flowOrderAndSteering: true,
      historicalOperationsStill: true, whiteMaterialLegible: true, reducedMotion: true,
      screenshots: ['operation-progress-read-running.png','operation-progress-search-running.png','operation-progress-white.png','operation-progress-flow.png','operation-progress-history.png'] };
  } catch (error) {
    const renderer = child && !child.isDestroyed() ? await js(`({html:document.getElementById('messages').outerHTML.slice(0,24000),running,phase:activeTaskActivity?.phase})`).catch(() => null) : null;
    console.error('OPERATION_PROGRESS_SMOKE_DIAGNOSTIC', JSON.stringify({ stage, message: error.message, renderer }));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      await js('clearInterval(taskActivityTimer);taskActivityTimer=null;').catch(() => {});
      if (originalAppearance) await call('setAppearance', { uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor ?? null }).catch(() => {});
      if (attached) child.webContents.debugger.detach();
      child.close();
    }
  }
};
