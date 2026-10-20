// Runs only in the smoke harness's offscreen renderer. Fixtures are display-only:
// no approval is answered, no command is executed, and no real model is called.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeScroll({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Scroll smoke requires an isolated offscreen window');
  const initial = { bounds: win.getBounds(), opacity: win.getOpacity() };
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const observations = [];
  let installed = false;
  const rectFunction = `node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}`;
  const geometry = () => js(`(()=>{const s=$('message-scroll'),c=document.querySelector('#composer-approval .approval-card'),rect=${rectFunction};return {scale:textScale,scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,viewport:rect(s),composer:rect(document.querySelector('.composer-area')),approvalSlotHidden:$('composer-approval').hidden,formHidden:$('task-form').hidden,chatApprovalCount:$('messages').querySelectorAll('.approval-card').length,visibleApprovalCount:$('composer-approval').querySelectorAll('.approval-card').length,actions:c&&rect(c.querySelector('.approval-actions')),body:c&&rect(c.querySelector('.approval-body')),bodyScrollHeight:c?.querySelector('.approval-body')?.scrollHeight,bodyClientHeight:c?.querySelector('.approval-body')?.clientHeight,innerHeight,followOutput}})()`);
  const point = async selector => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return {x:Math.floor(Math.min(r.right-15,r.left+30)),y:Math.floor(Math.max(12,Math.min(innerHeight-12,r.top+Math.min(r.height/2,30))))}})()`);
  const wheel = async (position, deltaY) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', ...position });
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...position, deltaX: 0, deltaY, canScroll: true });
    await wait(260); await frames();
  };
  const nativeOuterBottom = async () => {
    // Allow Chromium's prior wheel gesture/scroll latch (possibly in the
    // approval body) to end before moving to the outer conversation.
    await wait(400);
    const position = await js(`(()=>{const r=$('message-scroll').getBoundingClientRect();return {x:Math.floor(r.left+40),y:Math.floor(r.top+20)}})()`);
    for (let i = 0; i < 40; i++) {
      const g = await geometry();
      if (g.scrollHeight - g.clientHeight - g.scrollTop <= 2) return g;
      await wheel(position, -10000);
    }
    throw new Error('Native wheel could not reach the end of the chat: ' + JSON.stringify(await geometry()));
  };
  const assertActions = (g, label) => {
    assert.ok(g.clientHeight >= 80, label + ': message viewport collapsed: ' + JSON.stringify(g));
    assert.equal(g.approvalSlotHidden,false,label+': pending approval slot is hidden');
    assert.equal(g.formHidden,true,label+': message form must be temporarily replaced by the decision');
    assert.equal(g.chatApprovalCount,0,label+': pending decisions must not be inserted in the chat');
    assert.equal(g.visibleApprovalCount,1,label+': only the current decision should be mounted');
    assert.ok(g.actions.top >= g.composer.top - 1 && g.actions.bottom <= g.composer.bottom + 1, label + ': approval actions are outside the composer: ' + JSON.stringify(g));
    assert.ok(g.actions.top >= 0 && g.actions.bottom <= g.innerHeight + 1 && g.composer.bottom <= g.innerHeight + 1, label + ': approval actions are clipped by the window: ' + JSON.stringify(g));
    assert.ok(g.bodyClientHeight > 0 && g.bodyScrollHeight > g.bodyClientHeight, label + ': full details must be scrollable');
  };
  const screenshot = async name => {
    await frames(); win.webContents.invalidate(); await wait(100);
    await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  try {
    // Chromium drops native wheel events for a fully hidden offscreen window.
    // Showing only this opacity-zero fixture enables real wheel/scrollbar input.
    win.setOpacity(0); win.showInactive(); win.webContents.focus();
    await js(`(()=>{
      if(running||terminalRunning)throw new Error('Scroll smoke must start after real fixture tasks finish');
      window.__scrollSmoke={nodes:[...$('messages').childNodes],scrollTop:$('message-scroll').scrollTop,welcome:$('welcome').hidden,notice:$('notice').hidden,scale:textScale,follow:followOutput,state:appState,queue:promptQueue,changes,pendingTools,approvals:[...approvals],activity:activeTaskActivity,telemetry:latestTelemetry,previewHidden:$('preview-panel').hidden,previewTab:$('browser-preview-tab').classList.contains('active')?'browser':$('changes-preview-tab').classList.contains('active')?'changes':'file',terminalHidden:$('terminal-panel').hidden,status:$('run-status').textContent,statusClass:$('run-status').className};
      finishStream();resetTelemetry();clearComposerApprovals({restoreFocus:false});$('messages').replaceChildren();$('notice').hidden=true;$('welcome').hidden=true;setPreviewOpen(false);$('terminal-panel').hidden=true;changes=[];pendingTools=[];syncPromptQueue({items:[],paused:false});followOutput=true;
    })()`);
    installed = true;
    const command = Array.from({ length: 160 }, (_, i) => `Write-Output "DISPLAY ONLY line ${i} 中文命令详情"`).join('\n');
    const longText = Array.from({ length: 160 }, (_, i) => `line ${i}: unchanged content in a display-only diff`).join('\n');
    for (const scale of [120, 160]) {
      win.setBounds({ ...initial.bounds, width: 980, height: 680 });
      await frames();
      await js(`(()=>{applyTextScale(${scale});clearComposerApprovals({restoreFocus:false});$('messages').replaceChildren();changes=[];for(let i=0;i<10;i++)addMessage('assistant','历史对话 '+i+'。'.repeat(100));approvalRequest({id:'scroll-command-${scale}',kind:'command',title:'运行 PowerShell 命令',command:${JSON.stringify(command)},detail:'工作目录：隔离测试目录\\n最长运行：20 秒\\n输出编码：UTF-8\\n完整命令如下。此测试仅展示命令，不会执行。'});})()`);
      await frames();
      let g = await geometry(); assertActions(g, scale + '% command');
      assert.ok(g.body.height <= Math.min(g.innerHeight * .44, 400) + 1);
      await js(`document.querySelector('#composer-approval .approval-body').scrollTop=0`);
      await wait(400);
      await wheel(await point('#composer-approval .approval-body'), -350);
      const bodyMoved = await js(`document.querySelector('#composer-approval .approval-body').scrollTop`);
      assert.ok(bodyMoved > 0, 'Native wheel must scroll command details');
      await js(`$('message-scroll').scrollTop=0`); await frames();
      g = await nativeOuterBottom(); assertActions(g, scale + '% wheel to command actions');
      observations.push({ kind: 'command', scale, viewport: g.clientHeight, actionsBottom: g.actions.bottom, composerBottom: g.composer.bottom, nativeBodyWheel: bodyMoved });
      if (scale === 160) await screenshot('scroll-command-approval.png');
      await js(`(()=>{handleEvent({type:'approval-resolved',id:'scroll-command-${scale}',approved:false});if(!$('composer-approval').hidden||$('task-form').hidden)throw new Error('Resolved command did not restore composer');approvalRequest({id:'scroll-write-${scale}',kind:'write',title:'确认写入文件',path:'display-only.txt',detail:'仅检查长文件差异，不写入文件。',before:${JSON.stringify(longText)},after:${JSON.stringify(longText + '\nchanged')}});setPreviewOpen(false);})()`);
      await frames(); g = await geometry(); assertActions(g, scale + '% diff');
      await wait(400);
      await wheel(await point('#composer-approval .approval-body'), -350);
      const diffMoved = await js(`document.querySelector('#composer-approval .approval-body').scrollTop`);
      assert.ok(diffMoved > 0, 'Native wheel must scroll the full diff');
      // Drag the actual vertical scrollbar thumb from its top to its bottom.
      await js(`$('message-scroll').scrollTop=0`); await frames();
      const track = await js(`(()=>{const s=$('message-scroll'),r=s.getBoundingClientRect();return {x:Math.floor(r.right-3),top:Math.floor(r.top+Math.max(9,s.clientHeight*s.clientHeight/s.scrollHeight/2)),bottom:Math.floor(r.bottom-4)}})()`);
      win.webContents.sendInputEvent({type:'mouseMove',x:track.x,y:track.top});
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:track.x,y:track.top});
      win.webContents.sendInputEvent({type:'mouseMove',x:track.x,y:track.bottom,movementX:0,movementY:track.bottom-track.top});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:track.x,y:track.bottom});
      await wait(150); g = await geometry();
      assert.ok(g.scrollHeight-g.clientHeight-g.scrollTop<=2,'Native scrollbar drag must reach the end of chat while the decision stays visible: '+JSON.stringify({track,g}));
      assertActions(g, scale + '% scrollbar to diff actions');
      observations.push({kind:'write',scale,viewport:g.clientHeight,nativeDiffWheel:diffMoved,nativeScrollbar:true});
    }
    // An expanded queue must retain its own scrollbar and leave room for chat.
    await js(`(()=>{clearComposerApprovals({restoreFocus:false});if(!$('composer-approval').hidden||$('task-form').hidden)throw new Error('Cleared decisions did not restore composer');$('messages').replaceChildren();for(let i=0;i<8;i++)addMessage('assistant','队列之前的消息。'.repeat(100));syncPromptQueue({items:Array.from({length:20},(_,i)=>({id:'scroll-pending-'+i,text:'待发送 '+i+' '+ '更多文字。'.repeat(100),mode:'queue'}))});for(const details of $('pending-items').querySelectorAll('details'))details.open=true;scrollBottom(true);})()`);
    await frames();
    const pending = await js(`(()=>{const s=$('message-scroll'),p=$('pending-items'),c=document.querySelector('.composer-area').getBoundingClientRect();return {viewport:s.clientHeight,pendingHeight:p.clientHeight,pendingScrollHeight:p.scrollHeight,composerBottom:c.bottom,innerHeight}})()`);
    assert.ok(pending.viewport >= 80, 'Long expanded queue must not collapse chat: ' + JSON.stringify(pending));
    assert.ok(pending.pendingScrollHeight > pending.pendingHeight, 'Long queue must scroll independently');
    assert.ok(pending.composerBottom <= pending.innerHeight + 1);
    await screenshot('scroll-long-pending-queue.png');
    // Streaming follows only when the reader is at the end. Reading earlier
    // output remains stable, then returning to the end resumes following.
    await js(`(()=>{syncPromptQueue({items:[]});$('messages').replaceChildren();for(let i=0;i<12;i++)addMessage('assistant','前文 '+i+' '+ '历史内容。'.repeat(100));handleEvent({type:'run-start',runId:'scroll-stream-fixture',kind:'agent',startedAt:Date.now()});handleEvent({type:'text-delta',text:'首段流式内容\\n'.repeat(30)});scrollBottom(true);})()`);
    await frames();
    const streamPoint = await js(`(()=>{const r=$('message-scroll').getBoundingClientRect();return{x:Math.floor(r.left+40),y:Math.floor(r.top+20)}})()`);
    await wait(400);
    await wheel(streamPoint, 400);
    const earlier = await js(`({top:$('message-scroll').scrollTop,followOutput})`);
    assert.equal(earlier.followOutput, false, 'Wheel up must pause automatic following: '+JSON.stringify({earlier,streamPoint,g:await geometry()}));
    await js(`handleEvent({type:'text-delta',text:'继续生成而不打断阅读\\n'.repeat(30)})`); await frames();
    const during = await js(`({top:$('message-scroll').scrollTop,followOutput})`);
    assert.equal(during.followOutput, false); assert.ok(Math.abs(during.top-earlier.top)<=2, 'Streaming must not pull the reader back to the end');
    await nativeOuterBottom(); await frames();
    assert.equal(await js('followOutput'), true);
    await js(`handleEvent({type:'text-delta',text:'回到底部后继续跟随\\n'.repeat(20)})`); await frames();
    const resumed = await geometry();
    assert.ok(resumed.scrollHeight-resumed.clientHeight-resumed.scrollTop<=2,'Automatic following must resume after reaching the end');
    await js(`finishStream();finishTaskActivity({runId:'scroll-stream-fixture',status:'completed'});setRunning(false);scrollBottom()`); await frames();
    const completed = await geometry(); assert.ok(completed.scrollHeight-completed.clientHeight-completed.scrollTop<=2);
    await screenshot('scroll-stream-follow.png');
    const result = {status:'completed',cases:observations,pending,streaming:{manualWheelPauses:true,readingPositionPreserved:true,returnToEndResumes:true,completionAtEnd:true},noCommandsExecuted:true};
    await fs.writeFile(path.join(output,'scroll-result.json'),JSON.stringify(result,null,2));
    return result;
  } finally {
    if (installed && !win.isDestroyed()) await js(`(()=>{const s=window.__scrollSmoke;if(!s)return;finishStream();resetTelemetry();clearComposerApprovals({restoreFocus:false});changes=s.changes;pendingTools=s.pendingTools;for(const entry of s.approvals)approvals.set(...entry);appState=s.state;setRunning(false);syncPromptQueue(s.queue);$('messages').replaceChildren(...s.nodes);$('welcome').hidden=s.welcome;$('notice').hidden=s.notice;activeTaskActivity=s.activity;latestTelemetry=s.telemetry;followOutput=s.follow;applyTextScale(s.scale);renderChanges();renderComposerApproval({restoreFocus:false});showPreviewTab(s.previewTab);setPreviewOpen(!s.previewHidden);$('terminal-panel').hidden=s.terminalHidden;$('run-status').textContent=s.status;$('run-status').className=s.statusClass;$('message-scroll').scrollTop=s.scrollTop;delete window.__scrollSmoke;})()`).catch(()=>{});
    if (!win.isDestroyed()) {win.hide();win.setBounds(initial.bounds);win.setOpacity(initial.opacity);}
  }
};
