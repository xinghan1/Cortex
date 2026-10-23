// Display fixtures use the application's real tool-card/rendering functions.
// No model, command, approval, or project file is read or executed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeToolOperationGroups({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), runId = 'operation-groups-' + nonce, evidence = {};
  let child, attached = false, stage = 'isolated renderer setup';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(20); }
    throw new Error('Tool operation groups timed out: ' + label);
  };
  const js = code => child.webContents.executeJavaScript(code);
  const click = async selector => {
    await until('visible control ' + selector, () => js(`(() => {const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&n.checkVisibility({visibilityProperty:true,opacityProperty:true});})()`));
    const point = await until('uncovered stable control ' + selector, () => js(`(() => {if(fileDisclosureReveal)return null;const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+Math.min(100,r.width/2)),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(35);
  };
  const inspect = (id = 'long-operation-group') => js(`(() => {
    const n=$(${JSON.stringify(id)});if(!n)return null;const body=n.querySelector('.tool-operation-group-items'),viewport=$('message-scroll'),composer=document.querySelector('.composer-area');
    const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    return {open:n.open,text:n.querySelector('summary').textContent,group:rect(n),body:rect(body),viewport:rect(viewport),composer:rect(composer),
      scrollTop:viewport.scrollTop,bodyScrollTop:body.scrollTop,bodyScrollHeight:body.scrollHeight,bodyClientHeight:body.clientHeight,
      count:n.querySelectorAll('.tool-card').length,transition:getComputedStyle(n,'::details-content').transitionDuration,following:!!fileDisclosureReveal};})()`);
  const allGroups = () => js(`[...document.querySelectorAll('.tool-operation-group')].map(n=>({operation:n.dataset.operation,kind:n.dataset.kind,count:Number(n.dataset.count),countLabel:n.querySelector('.tool-operation-group-count').textContent,open:n.open,status:n.dataset.status,label:n.querySelector('.tool-operation-group-label').textContent,detail:n.querySelector('.tool-operation-group-status').textContent}))`);
  const setup = async spacer => {
    await js(`(() => {
      cancelFileDisclosureReveal();fileDisclosureScrollPaused=false;clearInterval(taskActivityTimer);taskActivityTimer=null;
      pendingTools=[];activeTaskActivity=null;running=false;taskKind='agent';commandOutput=null;
      $('messages').replaceChildren();renderedUserMessageIds.clear();$('welcome').hidden=true;$('notice').hidden=true;setPreviewOpen(false);$('terminal-panel').hidden=true;
      if(${Boolean(spacer)}){const filler=element('div');filler.style.height='1800px';filler.textContent='Display-only older content';$('messages').append(filler);}
      addMessage('user','仅用于验证连续工具折叠的显示样例',false,{id:'display-user-'+${JSON.stringify(nonce)}});
      setRunning(true,{kind:'agent',runId:${JSON.stringify(runId)}});
      window.__operationGroupsSmoke={sequence:0,trustedClicks:0,trustedWheels:0};
      window.__operationGroupsSmoke.tool=(name,status='completed',path='fixture.txt')=>{
        const toolCallId='operation-'+(++window.__operationGroupsSmoke.sequence),event={name,toolCallId,runId:${JSON.stringify(runId)},args:name==='run_command'?{command:'DISPLAY_ONLY_COMMAND',timeout_ms:600000}:['search_files','search_text'].includes(name)?{path,query:'Display fixture query'}:{path}};
        addTool(event);const original=pendingTools.find(t=>t.toolCallId===toolCallId),card=original.card;card.id=toolCallId;
        const stdout='DISPLAY_COMMAND_STDOUT_'+toolCallId+'\\n',stderr='DISPLAY_COMMAND_STDERR_'+toolCallId+'\\n';
        if(name==='run_command'&&status!=='denied'){
          handleEvent({type:'command-output',workspaceId:currentWorkspaceId(),runId:${JSON.stringify(runId)},stream:'stdout',text:stdout});
          handleEvent({type:'command-output',workspaceId:currentWorkspaceId(),runId:${JSON.stringify(runId)},stream:'stderr',text:stderr});
        }
        const edit=['write_file','replace_in_file','undo_last_change'].includes(name)?{path,before:'const before = 1;\\n',after:'const after = 2;\\n'}:null;
        const result=status==='failed'?(name==='run_command'?{command:event.args.command,stdout,stderr,exitCode:1,signal:null,terminated:null}:{error:'Display fixture missing file'}):status==='denied'?{denied:true,message:'Display fixture denied'}:status==='stopped'?{command:event.args.command,stdout,stderr,exitCode:null,signal:null,terminated:'cancelled'}:name==='run_command'?{command:event.args.command,stdout,stderr,exitCode:0,signal:null,terminated:null}:{path,content:'Display fixture result',files:[]};
        if(status==='unknown'){pendingTools.splice(pendingTools.indexOf(original),1);finishToolWithoutResult(original);}
        else if(status!=='running')completeTool({...event,result:JSON.stringify(result),...(edit?{fileChange:edit}:{})});
        return toolCallId;};
      followOutput=false;$('message-scroll').scrollTop=${spacer ? "$('message-scroll').scrollHeight" : '0'};return true;})()`);
    await wait(50);
  };
  const tool = (name, status = 'completed', filename = 'fixture.txt') => js(`window.__operationGroupsSmoke.tool(${JSON.stringify(name)},${JSON.stringify(status)},${JSON.stringify(filename)})`);
  const sample = async id => {
    await js(`(() => {const start=performance.now();window.__operationGroupsSmoke.samples=[];window.__operationGroupsSmoke.sampling=true;const frame=()=>{const n=$(${JSON.stringify(id)});window.__operationGroupsSmoke.samples.push({at:performance.now()-start,height:n.getBoundingClientRect().height,open:n.open});if(performance.now()-start<600)requestAnimationFrame(frame);else window.__operationGroupsSmoke.sampling=false;};frame();true;})()`);
  };
  const sampled = async () => { await until('animation collection', () => js('!window.__operationGroupsSmoke.sampling')); return js('window.__operationGroupsSmoke.samples'); };
  const visible = value => value.open && !value.following && value.group.top >= value.viewport.top - 2
    && value.group.bottom <= Math.min(value.viewport.bottom, value.composer.top) + 2;
  const capture = async name => { child.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  try {
    await fs.mkdir(output, { recursive: true });
    const created = await win.webContents.executeJavaScript('window.forge.newWindow()'); child = BrowserWindow.fromId(created.id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('group modules and application initialized', () => js('Boolean(appState&&window.ForgeToolOperationGroups&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    assert.equal(child.webContents.debugger.isAttached(), false); child.webContents.debugger.attach('1.3'); attached = true;
    await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    stage = 'live real tool cards group adjacent operations without hiding original detail';
    await setup(false);
    const readIds = [await tool('read_file', 'completed', 'same.txt'), await tool('read_file', 'completed', 'same.txt'), await tool('read_file', 'completed', 'other.txt')];
    await tool('list_files', 'completed', '.'); await tool('list_files', 'completed', 'src');
    let groups = await allGroups(); assert.equal(groups.length, 1);
    assert.deepEqual(groups.map(group => [group.kind, group.count, group.open]), [['read-list', 5, false]]);
    assert.equal(groups[0].label, '读取了文件和文件列表'); assert.equal(groups[0].countLabel, '5 次');
    await js(`document.querySelector('.tool-operation-group').id='first-read-group';true`);
    await click('#first-read-group > summary'); await until('native read group opens', () => js('$("first-read-group").open'));
    await click('#' + readIds[0] + ' > summary'); await click('#' + readIds[0] + ' .tool-technical-details > summary');
    assert.equal(await js(`$(${JSON.stringify(readIds[0])}).open`), true);
    assert.match(await js(`$(${JSON.stringify(readIds[0])}).textContent`), /Display fixture result/u);
    await click('#first-read-group > summary'); await until('native read group closes', () => js('!$("first-read-group").open'));

    stage = 'a real steering message separates consecutive operation blocks';
    await js(`handleEvent({type:'user-message',workspaceId:currentWorkspaceId(),runId:${JSON.stringify(runId)},id:'steer-'+${JSON.stringify(nonce)},text:'现在读取后续文件',source:'steering',createdAt:'2026-10-21T12:00:00Z'});true`);
    await tool('read_file', 'completed', 'after-steer-a'); await tool('read_file', 'completed', 'after-steer-b');
    groups = await allGroups(); assert.equal(groups.length, 2); assert.deepEqual(groups.map(group => group.count), [5, 2]);
    const order = await js(`(() => {const user=[...document.querySelectorAll('.message.user')].find(n=>n.textContent.includes('现在读取后续文件')),g=[...document.querySelectorAll('.tool-operation-group')];return {before:!!(g[0].compareDocumentPosition(user)&Node.DOCUMENT_POSITION_FOLLOWING),after:!!(user.compareDocumentPosition(g[1])&Node.DOCUMENT_POSITION_FOLLOWING)};})()`);
    assert.deepEqual(order, { before: true, after: true }, 'The steering message must remain between original groups');

    stage = 'one mixed read edit and command block retains actual diff and complete command details';
    const editId = await tool('write_file', 'completed', 'display-only.js'), commandId = await tool('run_command');
    groups = await allGroups(); assert.equal(groups.length, 2); assert.equal(groups[1].kind, 'edit-command');
    assert.equal(groups[1].count, 4); assert.equal(groups[1].label, '编辑了文件并运行了命令'); assert.equal(groups[1].countLabel, '4 项操作');
    assert.equal(groups[1].open, false);
    await js(`document.querySelectorAll('.tool-operation-group')[1].id='mixed-edit-command-group';true`);
    await click('#mixed-edit-command-group > summary'); await click('#' + editId + ' > summary');
    assert.equal(await js(`$(${JSON.stringify(editId)}).querySelectorAll('.code-diff-card').length`), 1);
    assert.match(await js(`$(${JSON.stringify(editId)}).querySelector('.code-diff-card').textContent`), /before/u);
    assert.match(await js(`$(${JSON.stringify(editId)}).querySelector('.code-diff-card').textContent`), /after/u);
    await click('#' + commandId + ' > summary');
    assert.match(await js(`$(${JSON.stringify(commandId)}).textContent`), /DISPLAY_COMMAND_STDOUT/u);
    assert.equal(await js(`$(${JSON.stringify(commandId)}).querySelectorAll('.command-result').length`), 1);
    await click('#mixed-edit-command-group > summary');
    await js(`addMessage('assistant','下面是独立的文件编辑段。');true`);
    await tool('write_file', 'completed', 'only-edit-a'); await tool('replace_in_file', 'completed', 'only-edit-b');
    await js(`addMessage('assistant','下面是独立的命令段。');true`);
    await tool('run_command'); await tool('run_command');
    groups = await allGroups(); assert.deepEqual(groups.slice(-2).map(group => group.label), ['编辑了文件', '运行了命令']);
    assert.ok(groups.slice(-2).every(group => !group.open && group.count === 2));
    await tool('browser_snapshot', 'completed', 'display-only-browser-boundary');
    const one = await tool('read_file', 'completed', 'only-one-after-browser');
    assert.equal(await js(`$(${JSON.stringify(one)}).parentElement.classList.contains('tool-operation-group-items')`), false);
    assert.equal((await allGroups()).length, 4, 'Unsupported browser operations break the block and remain original cards');

    stage = 'thirteen command operations keep failed details closed until a native user click';
    await js(`addMessage('assistant','准备展示失败状态。');true`);
    for (let index = 0; index < 12; index++) await tool('run_command');
    await tool('run_command', 'failed');
    const failed = (await allGroups()).at(-1);
    assert.equal(failed.status, 'failed'); assert.equal(failed.open, false); assert.equal(failed.label, '运行命令');
    assert.equal(failed.count, 13); assert.match(failed.detail, /12 已完成/u); assert.match(failed.detail, /1 未完成/u);
    await js(`[...document.querySelectorAll('.tool-operation-group')].at(-1).id='failed-command-group';true`);
    await capture('tool-operation-groups-failed-collapsed.png');
    await click('#failed-command-group > summary');
    await until('native failed group opens only after user input', () => js('$("failed-command-group").open'));
    await tool('run_command', 'failed');
    assert.equal((await allGroups()).at(-1).open, true, 'A later failed result must preserve the manual expansion');
    await click('#failed-command-group > summary');
    await until('native failed group manually closes', () => js('!$("failed-command-group").open'));
    await tool('run_command', 'failed');
    assert.equal((await allGroups()).at(-1).open, false, 'A later failed result must preserve the manual collapse');
    evidence.failedCommands = { initial: failed, afterManualChoice: (await allGroups()).at(-1) };

    stage = 'denied stopped missing-result and running summaries never open their operation details';
    evidence.otherStatuses = [];
    for (const [status, label] of [['denied', '未执行'], ['stopped', '已停止'], ['unknown', '未返回'], ['running', '进行中']]) {
      await js(`addMessage('assistant',${JSON.stringify('独立状态显示样例：')}+${JSON.stringify(status)});true`);
      await tool('run_command'); await tool('run_command', status);
      const group = (await allGroups()).at(-1);
      assert.equal(group.status, status); assert.equal(group.open, false);
      assert.match(group.detail, /1 已完成/u); assert.ok(group.detail.includes('1 ' + label));
      evidence.otherStatuses.push(group);
    }
    evidence.live = await allGroups();

    stage = 'consecutive search results have their own collapsed block and preserve native manual expansion';
    await js(`addMessage('assistant','独立搜索显示样例。');true`);
    const searchIds = [await tool('search_files', 'completed', 'src/main/java'), await tool('search_files', 'completed', 'src/main/java'), await tool('search_text', 'completed', 'src/config')];
    const search = (await allGroups()).at(-1);
    assert.equal(search.kind, 'search'); assert.equal(search.count, 3); assert.equal(search.open, false);
    assert.equal(search.label, '已完成搜索'); assert.equal(search.countLabel, '3 次');
    await js(`[...document.querySelectorAll('.tool-operation-group')].at(-1).id='search-operation-group';true`);
    await capture('tool-operation-groups-search-collapsed.png');
    await click('#search-operation-group > summary');
    await until('native search group expands only after click', () => js('$("search-operation-group").open'));
    assert.equal(await js('$("search-operation-group").querySelectorAll(".tool-card").length'), 3);
    await click('#' + searchIds[0] + ' > summary');
    assert.match(await js(`$(${JSON.stringify(searchIds[0])}).textContent`), /Display fixture result/u);
    await click('#search-operation-group > summary');
    await until('native search group closes', () => js('!$("search-operation-group").open'));
    await js(`handleEvent({type:'user-message',workspaceId:currentWorkspaceId(),runId:${JSON.stringify(runId)},id:'search-steer-'+${JSON.stringify(nonce)},text:'搜索引导分隔样例',source:'steering',createdAt:'2026-10-22T12:00:00Z'});true`);
    const followingSearch = await tool('search_files', 'completed', 'src/after-steer');
    assert.equal(await js(`$(${JSON.stringify(followingSearch)}).parentElement.classList.contains('tool-operation-group-items')`), false, 'A search after steering never joins the earlier group');
    await tool('search_files', 'completed', 'src/after-steer-again');
    assert.deepEqual((await allGroups()).slice(-2).map(group => [group.kind, group.count, group.open]), [['search', 3, false], ['search', 2, false]]);
    evidence.search = { original: search, afterSteering: (await allGroups()).slice(-2) };

    stage = 'six consecutive commands with live output form one collapsed group';
    await setup(false);
    const outputCommands = [];
    for (let index = 0; index < 6; index++) outputCommands.push(await tool('run_command'));
    groups = await allGroups();
    assert.deepEqual(groups.map(group => [group.kind, group.count, group.open]), [['command', 6, false]]);
    const outputs = await js(`(()=>{const cards=[...document.querySelectorAll('.tool-card')];return {loose:document.querySelectorAll('.task-activity-events > .command-output-disclosure').length,cards:cards.map(card=>({id:card.id,outputs:card.querySelectorAll('.command-output').length,insideDetails:!!card.querySelector('.tool-details > .command-output-disclosure'),open:card.open,text:card.querySelector('.command-output')?.textContent}))};})()`);
    assert.equal(outputs.loose, 0, 'Live command output must not be a sibling that splits adjacent tools');
    for (const item of outputs.cards) {
      assert.equal(item.outputs, 1); assert.equal(item.insideDetails, true); assert.equal(item.open, false);
      assert.equal(item.text, `DISPLAY_COMMAND_STDOUT_${item.id}\nDISPLAY_COMMAND_STDERR_${item.id}\n`, 'Each command owns only its own stdout/stderr');
    }
    await js(`document.querySelector('.tool-operation-group').id='live-command-output-group';true`);
    await capture('tool-operation-groups-command-output-collapsed.png');
    await click('#live-command-output-group > summary');
    await click('#' + outputCommands[0] + ' > summary');
    await click('#' + outputCommands[0] + ' .command-output-disclosure > summary');
    await until('native expansion exposes matching live command output', () => js(`$(${JSON.stringify(outputCommands[0])}).querySelector('.command-output').checkVisibility({visibilityProperty:true,opacityProperty:true})`));
    assert.equal(await js(`$(${JSON.stringify(outputCommands[0])}).querySelector('.command-output').innerText`), outputs.cards[0].text);
    await capture('tool-operation-groups-command-output-expanded.png');
    await click('#live-command-output-group > summary');
    await until('command output group closes on native user click', () => js('!$("live-command-output-group").open'));
    await tool('run_command'); await tool('run_command', 'failed');
    const appendedOutputGroup = (await allGroups())[0];
    assert.equal(appendedOutputGroup.count, 8); assert.equal(appendedOutputGroup.status, 'failed'); assert.equal(appendedOutputGroup.open, false);
    assert.match(appendedOutputGroup.detail, /7 已完成 · 1 未完成/u);
    await js(`addMessage('assistant','COMMAND_OUTPUT_PROSE_BOUNDARY');true`);
    await tool('run_command'); await tool('run_command');
    await js(`handleEvent({type:'user-message',workspaceId:currentWorkspaceId(),runId:${JSON.stringify(runId)},id:'output-steer-'+${JSON.stringify(nonce)},text:'COMMAND_OUTPUT_STEERING_BOUNDARY',source:'steering',createdAt:'2026-10-23T00:00:00Z'});true`);
    await tool('run_command'); await tool('run_command');
    const outputBoundaries = await allGroups();
    assert.deepEqual(outputBoundaries.map(group => [group.kind, group.count, group.open]), [['command', 8, false], ['command', 2, false], ['command', 2, false]]);
    const outputOrder = await js(`(()=>{const groups=[...document.querySelectorAll('.tool-operation-group')],prose=[...document.querySelectorAll('.message.assistant')].find(n=>n.textContent.includes('COMMAND_OUTPUT_PROSE_BOUNDARY')),steer=[...document.querySelectorAll('.message.user')].find(n=>n.textContent.includes('COMMAND_OUTPUT_STEERING_BOUNDARY'));const before=(a,b)=>!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);return {firstBeforeProse:before(groups[0],prose),proseBeforeSecond:before(prose,groups[1]),secondBeforeSteer:before(groups[1],steer),steerBeforeThird:before(steer,groups[2])};})()`);
    assert.deepEqual(outputOrder, { firstBeforeProse: true, proseBeforeSecond: true, secondBeforeSteer: true, steerBeforeThird: true });
    evidence.commandOutput = { original: groups[0], outputs, appended: appendedOutputGroup, boundaries: outputBoundaries, order: outputOrder };

    stage = 'history reconstructs the same grouping and steering separation from original message/tool records';
    const history = { id: randomUUID(), title: 'Display tool-group history', workspace: null, messages: [], events: [], taskRuns: [], fileEdits: [] };
    history.messages.push({ id: 'history-first', role: 'user', content: 'Read first files.' });
    const addHistoryCalls = (names, prefix, statuses = []) => {
      const toolCalls = names.map((name, index) => ({ id: prefix + index, name, arguments: name === 'run_command' ? { command: 'DISPLAY_ONLY_COMMAND' } : { path: prefix + index } }));
      history.messages.push({ role: 'assistant', content: '', toolCalls });
      const assistantIndex = history.messages.length - 1;
      for (const [index, call] of toolCalls.entries()) {
        history.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify(statuses[index] === 'failed' ? { error: 'Historical display fixture failure' } : call.name === 'run_command'
          ? { command: call.arguments.command, stdout: 'HISTORICAL_COMMAND_STDOUT_' + call.id + '\n', stderr: 'HISTORICAL_COMMAND_STDERR_' + call.id + '\n', exitCode: 0, signal: null, terminated: null }
          : { path: call.arguments.path, content: 'Historical original result' }) });
        if (call.name === 'run_command') history.events.push(
          { type: 'tool-start', runId: 'history-' + nonce, toolCallId: call.id, name: call.name, args: call.arguments, messageIndex: assistantIndex },
          { type: 'command-output', runId: 'history-' + nonce, stream: 'stdout', text: 'HISTORICAL_COMMAND_STDOUT_' + call.id + '\n', messageIndex: assistantIndex },
          { type: 'command-output', runId: 'history-' + nonce, stream: 'stderr', text: 'HISTORICAL_COMMAND_STDERR_' + call.id + '\n', messageIndex: assistantIndex },
          { type: 'tool-result', runId: 'history-' + nonce, toolCallId: call.id, name: call.name, result: history.messages.at(-1).content, messageIndex: history.messages.length - 1 });
        if (call.name === 'write_file') history.fileEdits.push({ runId: 'history-' + nonce, toolCallId: call.id, path: call.arguments.path, before: 'before\n', after: 'after\n' });
      }
    };
    addHistoryCalls(['read_file', 'read_file', 'read_file'], 'history-read-');
    addHistoryCalls(['list_files', 'list_files'], 'history-list-');
    history.messages.push({ id: 'history-steering', role: 'user', content: 'Historical steering boundary.', source: 'steering' });
    addHistoryCalls(['read_file', 'read_file', 'write_file', 'run_command'], 'history-after-');
    history.messages.push({ role: 'assistant', content: 'Historical failure boundary.', toolCalls: [] });
    addHistoryCalls(['read_file', 'read_file'], 'history-failure-', ['completed', 'failed']);
    history.messages.push({ role: 'assistant', content: 'Historical search boundary.', toolCalls: [] });
    addHistoryCalls(['search_files', 'search_files', 'search_text'], 'history-search-');
    history.messages.push({ role: 'assistant', content: 'Historical command output boundary.', toolCalls: [] });
    addHistoryCalls(Array(6).fill('run_command'), 'history-output-');
    history.messages.push({ role: 'assistant', content: 'History fixture finished.', toolCalls: [] });
    history.taskRuns.push({ runId: 'history-' + nonce, kind: 'agent', status: 'completed', elapsedMs: 1000, fileChangeCount: 1, messageStartIndex: 0, messageIndex: history.messages.length - 1 });
    await js(`finishTaskActivity({runId:${JSON.stringify(runId)},status:'completed',elapsedMs:1});setRunning(false);renderSessionSnapshot(${JSON.stringify(history)});true`);
    const historical = await allGroups(); assert.deepEqual(historical.map(group => [group.kind, group.count, group.open]), [['read-list', 5, false], ['edit-command', 4, false], ['read', 2, false], ['search', 3, false], ['command', 6, false]]);
    assert.equal(historical[2].status, 'failed'); assert.match(historical[2].detail, /1 已完成 · 1 未完成/u);
    assert.equal(historical[3].label, '已完成搜索');
    assert.equal(await js('document.querySelectorAll(".tool-card").length'), 20);
    assert.equal(await js('document.querySelectorAll(".tool-operation-group .code-diff-card").length'), 1);
    assert.equal(await js('document.querySelectorAll(".tool-operation-group .command-result").length'), 7);
    assert.equal(await js(`[...document.querySelectorAll('.message.user')].filter(n=>n.textContent.includes('Historical steering boundary.')).length`), 1);
    evidence.history = historical;
    const historicalOutput = await js(`(()=>{const cards=[...document.querySelectorAll('.tool-card')].filter(card=>card.querySelector('.command-output'));return {loose:document.querySelectorAll('.task-activity-events > .command-output-disclosure').length,cards:cards.map(card=>({text:card.querySelector('.command-output').textContent,disclosures:card.querySelectorAll('.command-output-disclosure').length,insideDetails:!!card.querySelector('.tool-details > .command-output-disclosure'),open:card.open}))};})()`);
    assert.equal(historicalOutput.loose, 0); assert.equal(historicalOutput.cards.length, 7);
    for (const [index, item] of historicalOutput.cards.entries()) {
      const id = index === 0 ? 'history-after-3' : 'history-output-' + (index - 1);
      assert.equal(item.text, `HISTORICAL_COMMAND_STDOUT_${id}\nHISTORICAL_COMMAND_STDERR_${id}\n`);
      assert.equal(item.disclosures, 1); assert.equal(item.insideDetails, true); assert.equal(item.open, false);
    }
    evidence.historicalCommandOutput = historicalOutput;
    await click('.task-activity > summary');
    await js(`[...document.querySelectorAll('.tool-operation-group')].at(-1).id='historical-command-output-group';document.querySelector('#historical-command-output-group .tool-card').id='historical-output-first-command';true`);
    await click('#historical-command-output-group > summary');
    await click('#historical-output-first-command > summary');
    await click('#historical-output-first-command .command-output-disclosure > summary');
    await until('native history output expansion shows original stdout', () => js(`$('historical-output-first-command').querySelector('.command-output').checkVisibility({visibilityProperty:true,opacityProperty:true})`));
    assert.match(await js(`$('historical-output-first-command').querySelector('.command-output').innerText`), /HISTORICAL_COMMAND_STDOUT_history-output-0/u);
    await capture('tool-operation-groups-command-output-history.png');

    stage = 'long bottom group reveals fully above the composer with bounded internal scrolling';
    await setup(true);
    await js(`for(let index=0;index<36;index++)window.__operationGroupsSmoke.tool('read_file','completed','long-'+index+'.txt');document.querySelector('.tool-operation-group').id='long-operation-group';followOutput=false;fileDisclosureScrollPaused=false;$('message-scroll').scrollTop=$('message-scroll').scrollHeight;true`);
    await wait(75); const closed = await inspect(); assert.equal(closed.open, false); assert.equal(closed.count, 36);
    await sample('long-operation-group'); await click('#long-operation-group > summary'); const frames = await sampled();
    const expanded = await until('complete group visible at conversation bottom', async () => { const value = await inspect(); return visible(value) && value; });
    assert.ok(expanded.bodyClientHeight > 80 && expanded.bodyScrollHeight > expanded.bodyClientHeight + 300);
    const intermediate = frames.filter(frame => frame.height > closed.group.height + 3 && frame.height < expanded.group.height - 3);
    assert.ok(intermediate.length >= 2, 'Native open must expose progressive height frames');
    assert.ok(Math.abs(intermediate[0].height - intermediate.at(-1).height) > 4);
    evidence.bottom = { closed, expanded, intermediateFrames: intermediate.length };
    await capture('tool-operation-groups.png');
    const point = await js(`(() => {const r=$('long-operation-group').querySelector('.tool-operation-group-items').getBoundingClientRect();return {x:Math.round(r.left+40),y:Math.round(r.top+50)};})()`);
    child.webContents.sendInputEvent({ type: 'mouseMove', ...point }); child.webContents.sendInputEvent({ type: 'mouseWheel', deltaX: 0, deltaY: -300, canScroll: true, ...point });
    await until('native wheel scrolls original cards inside group', async () => (await inspect()).bodyScrollTop > 50);
    const scrolled = await inspect(); assert.ok(Math.abs(scrolled.scrollTop - expanded.scrollTop) <= 2, 'Inner card scrolling must not move the conversation'); evidence.internalScroll = scrolled.bodyScrollTop;

    stage = 'short viewport fits the long group without hiding its bottom under the composer';
    await click('#long-operation-group > summary'); child.setContentSize(1100, 700); await wait(100);
    await js(`cancelFileDisclosureReveal();fileDisclosureScrollPaused=false;$('message-scroll').scrollTop=$('message-scroll').scrollHeight;true`);
    await click('#long-operation-group > summary');
    const compact = await until('short viewport complete group visible', async () => { const value = await inspect(); return visible(value) && value; });
    assert.ok(compact.bodyClientHeight < expanded.bodyClientHeight - 10, 'The short viewport must actually reduce the internal group height'); evidence.shortViewport = compact;
    await capture('tool-operation-groups-short.png');

    stage = 'reduced motion opens immediately while retaining full visibility and inner scrolling';
    await click('#long-operation-group > summary');
    await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until('reduced motion applied', () => js(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
    await click('#long-operation-group > summary');
    const reduced = await until('reduced motion visible group', async () => { const value = await inspect(); return visible(value) && value; });
    assert.ok(reduced.transition.split(',').every(value => Number.parseFloat(value) === 0)); evidence.reduced = reduced;
    const result = { status: 'completed', realApi: false, realCommands: false, realFileReads: false, actualApplicationToolCards: true,
      continuousMixedOperationsGrouped: true, singleAndUnsupportedOperationsPreserved: true, originalToolDetailsPreserved: true,
      mixedEditAndCommandLabel: true, editOnlyAndCommandOnlyLabels: true, originalDiffAndCommandViewsPreserved: true,
      nativeCollapseAndExpand: true, defaultCollapsed: true, steeringSeparatesGroups: true, failedStatusSurfaced: true,
      searchGroupsCollapsedByDefault: true, searchNativeDisclosure: true, searchSteeringBoundary: true, historicalSearchGrouping: true,
      liveCommandOutputStaysInOwnTool: true, commandOutputDoesNotSplitGroup: true, nativeCommandOutputDisclosure: true,
      commandOutputProseAndSteeringBoundaries: true, historicalCommandOutputOwnership: true,
      manualExpansionPreserved: true, manualCollapsePreserved: true, allStatusesStayCollapsedByDefault: true,
      historyRestoresSameGroups: true, historicalFailureCollapsed: true, progressiveHeightTransition: true, bottomFullyVisible: true, internalNativeWheel: true,
      shortViewportCap: true, reducedMotion: true, evidence, screenshots: ['tool-operation-groups-failed-collapsed.png', 'tool-operation-groups-search-collapsed.png', 'tool-operation-groups-command-output-collapsed.png', 'tool-operation-groups-command-output-expanded.png', 'tool-operation-groups-command-output-history.png', 'tool-operation-groups.png', 'tool-operation-groups-short.png'] };
    await fs.writeFile(path.join(output, 'tool-operation-groups-result.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    const failure = { stage, error: error.message, stack: error.stack, evidence };
    if (child && !child.isDestroyed()) { failure.groups = await allGroups().catch(() => null); failure.inspection = await inspect().catch(() => null); await capture('tool-operation-groups-failure.png').catch(() => {}); }
    await fs.writeFile(path.join(output, 'tool-operation-groups-result.json'), JSON.stringify(failure, null, 2)); throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      if (attached) { await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {}); child.webContents.debugger.detach(); }
      await js('clearInterval(taskActivityTimer);taskActivityTimer=null;cancelFileDisclosureReveal();true').catch(() => {});
      child.destroy();
    }
  }
};
