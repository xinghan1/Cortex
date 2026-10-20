// A separate renderer with an in-memory preload bridge. Decisions below never
// reach application IPC, execute a command, write project files, or call a model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow } = require('electron');

module.exports = async function smokeComposerApproval({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Composer approval smoke requires an isolated smoke run');
  let child, stage = 'fixture preload';
  const errors = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => child.webContents.executeJavaScript(code);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(25); }
    throw new Error('Composer approval smoke timed out: ' + label);
  };
  const fixtureState = {
    workspaceId: 'composer-approval-project-a', sessionId: 'composer-approval-session-a', workspace: null,
    settings: { provider: 'openai', model: '', providers: { openai: { model: '', authMode: 'apiKey', hasKey: false } } },
    permissionMode: 'request', activeTask: { running: false, kind: null }, pendingApprovals: [],
    sessions: [], recentProjects: [], openWorkspaces: [], usageStats: null, textScale: 100,
    promptQueue: { items: [], paused: false }, chatgpt: null,
  };
  const inspect = () => js(`(() => {
    const slot=$('composer-approval'),card=slot.querySelector('.approval-card'),body=card?.querySelector('.approval-body');
    const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    return {formHidden:$('task-form').hidden,inert:$('task-form').inert,sameForm:$('task-form')===window.__approvalOriginalForm,
      hidden:slot.hidden,id:card?.dataset.approvalId,pending:approvals.size,cards:slot.children.length,
      messageApprovals:$('messages').querySelectorAll('.approval-card,.approval-accept,.approval-reject').length,
      draft:$('task-input').value,attachments:draftAttachments.map(value=>value.localId),
      status:card?.querySelector('.composer-approval-status')?.textContent,
      disabled:card&&[...card.querySelectorAll('.approval-actions button')].every(button=>button.disabled),
      body:body&&{...rect(body),client:body.clientHeight,scroll:body.scrollHeight,text:body.textContent},
      actions:rect(card?.querySelector('.approval-actions')),composer:rect(document.querySelector('.composer-area')),
      height:innerHeight,focus:document.activeElement?.id||document.activeElement?.className,
      selection:[$('task-input').selectionStart,$('task-input').selectionEnd],
      diff:!!card?.querySelector('.code-diff-card'),unsafe:!!slot.querySelector('img[src="x"],script,svg[onload]')};
  })()`);
  const emit = event => js(`handleEvent(${JSON.stringify({ workspaceId: fixtureState.workspaceId, runId: 'composer-approval-run-a', ...event })})`);
  const calls = () => js('window.__composerApprovalFixture.calls()');
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(attempt * 120);
        const png = (await child.webContents.capturePage()).toPNG();
        assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
        await fs.writeFile(path.join(output, name), png); return;
      } catch (error) {
        if (!/UnknownVizError/.test(String(error?.name) + ' ' + String(error?.message)) || attempt === 4) throw error;
      }
    }
  };
  const nativeKey = async keyCode => {
    child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') child.webContents.sendInputEvent({ type: 'char', keyCode });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await wait(60);
  };
  try {
    await fs.mkdir(output, { recursive: true });
    const originalPreload = await fs.readFile(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
    const originalCall = "const call = (name, arg) => ipcRenderer.invoke(`forge:${name}`, arg);";
    assert.ok(originalPreload.includes(originalCall), 'Preload fixture injection point changed');
    const mockCall = `const fixtureState=${JSON.stringify(fixtureState)};
      let mode='success';const calls=[],pending=new Map();
      const call=async(name,arg)=>{
        calls.push({name,arg});
        if(name==='getState')return fixtureState;
        if(name==='getCurrentSession')return null;
        if(name==='getAppearance')return {backgroundImage:null,backgroundTransparency:28};
        if(name==='listFiles')return [];
        if(name==='fileList')return {entries:[]};
        if(name==='respondApproval'){
          if(mode==='error')throw new Error('模拟连接失败，请重试');
          if(mode==='expired')return false;
          if(mode==='deferred')return new Promise((resolve,reject)=>pending.set(arg.id,{resolve,reject}));
          return true;
        }
        return null;
      };
      contextBridge.exposeInMainWorld('__composerApprovalFixture',Object.freeze({
        calls:()=>calls.map(value=>({...value})),setMode:value=>{mode=value;},
        complete:(id,value)=>{const reply=pending.get(id);if(!reply)return false;pending.delete(id);reply.resolve(value);return true;}
      }));`;
    const preload = path.join(output, 'composer-approval-fixture-preload.cjs');
    await fs.writeFile(preload, originalPreload.replace(originalCall, mockCall));
    child = new BrowserWindow({ width: 1240, height: 860, show: false, frame: false, backgroundColor: '#101725',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true } });
    child.webContents.on('console-message', (...args) => {
      const details = typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2] };
      if (details.level === 3 || details.level === 'error') errors.push(String(details.message));
    });
    await child.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await until('renderer initialized', () => js('Boolean(appState && window.synoraAppearance)'));
    await js('window.synoraAppearance.ready');
    child.setOpacity(0); child.showInactive(); child.webContents.focus();
    stage = 'draft preservation and composer replacement';
    await js(`(() => {
      restoringWorkspace=true;
      appState={...appState,workspace:{root:'C:/display-only-a',name:'审批预览'}};
      window.__approvalOriginalForm=$('task-form');
      $('task-input').value='请保留这段尚未发送的草稿';
      draftAttachments=[{localId:'kept-image',name:'草稿截图.png',mediaType:'image/png',size:68,loading:false,
        dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII='}];
      renderDraftAttachments();$('task-input').focus();$('task-input').setSelectionRange(2,7);
    })()`);
    await emit({ type: 'run-start', kind: 'agent', startedAt: Date.now() });
    const command = Array.from({ length: 70 }, (_, index) => `Write-Output '仅界面预览 ${index}'`).join('\n');
    await emit({ type: 'approval-request', id: 'approval-command-a', kind: 'command', title: '允许运行项目检查命令吗？', command,
      detail: '此处为界面测试。完整命令可展开查看，按钮始终留在输入框位置。' });
    const initial = await inspect();
    assert.equal(initial.formHidden, true); assert.equal(initial.inert, true); assert.equal(initial.sameForm, true);
    assert.equal(initial.messageApprovals, 0); assert.equal(initial.cards, 1); assert.equal(initial.id, 'approval-command-a');
    assert.equal(initial.body.text.includes(command), true); assert.ok(initial.body.scroll > initial.body.client);
    assert.ok(initial.actions.top >= initial.composer.top && initial.actions.bottom <= initial.height);
    assert.equal(initial.attachments[0], 'kept-image');
    await js(`$('task-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));$('task-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));`);
    assert.equal((await calls()).some(value => ['submitPrompt', 'runTask'].includes(value.name)), false, 'Hidden draft submitted while approval was pending');
    assert.equal((await inspect()).draft, initial.draft);
    await capture('composer-approval-command.png');
    await js(`$('composer-approval').querySelector('.composer-approval-expand').click()`);
    assert.equal(await js(`$('composer-approval').querySelector('.composer-approval-expand').getAttribute('aria-expanded')`), 'true');

    stage = 'error retry and keyboard scope';
    await js(`window.__composerApprovalFixture.setMode('error');document.body.tabIndex=-1;document.body.focus();$('composer-approval').firstElementChild.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
    assert.equal((await calls()).filter(value => value.name === 'respondApproval').length, 0, 'Out-of-card keyboard event approved an operation');
    await js(`restoringWorkspace=false;$('composer-approval').firstElementChild.focus()`);
    await nativeKey('Enter');
    await until('failed response stays retryable', async () => { const value = await inspect(); return /模拟连接失败/.test(value.status) && !value.disabled; });
    assert.equal((await inspect()).pending, 1);

    stage = 'queued file proposal and pending response';
    const before = 'const value = 1;\n', after = 'const value = 2;\nconst next = true;\n';
    await emit({ type: 'approval-request', id: 'approval-write-a', kind: 'write', title: '允许更新这份代码吗？', path: 'src/main.cjs', before, after, detail: '待批准；批准后才会写入。' });
    assert.equal((await inspect()).pending, 2); assert.equal((await inspect()).cards, 1);
    await js(`window.__composerApprovalFixture.setMode('deferred');$('composer-approval').querySelector('.approval-accept').click()`);
    await until('response processing locks controls', async () => (await inspect()).disabled);
    assert.equal((await inspect()).id, 'approval-command-a');
    await js(`window.__composerApprovalFixture.complete('approval-command-a',true)`);
    await until('next queued decision', async () => (await inspect()).id === 'approval-write-a');
    const proposal = await inspect();
    assert.equal(proposal.diff, true); assert.match(proposal.body.text, /尚未写入/); assert.equal(proposal.messageApprovals, 0);
    await capture('composer-approval-file.png');
    await js(`window.__composerApprovalFixture.setMode('success');$('composer-approval').firstElementChild.focus()`);
    await nativeKey('Escape');
    await until('draft restored after reject', async () => !(await inspect()).formHidden);
    const restored = await inspect();
    assert.equal(restored.hidden, true); assert.equal(restored.inert, false); assert.equal(restored.sameForm, true);
    assert.equal(restored.draft, initial.draft); assert.deepEqual(restored.attachments, ['kept-image']);
    assert.deepEqual(restored.selection, [2, 7]); assert.equal(restored.focus, 'task-input');
    assert.deepEqual((await calls()).filter(value => value.name === 'respondApproval').map(value => value.arg), [
      { id: 'approval-command-a', approved: true }, { id: 'approval-command-a', approved: true }, { id: 'approval-write-a', approved: false },
    ]);

    stage = 'modal blocks Escape and expired decision restores draft';
    await emit({ type: 'approval-request', id: 'modal-guard', kind: 'command', title: '测试快捷键范围', command: 'display-only' });
    const beforeModalCalls = (await calls()).filter(value => value.name === 'respondApproval').length;
    await js(`$('appearance-dialog').show();$('composer-approval').firstElementChild.focus()`);
    await nativeKey('Escape');
    assert.equal((await calls()).filter(value => value.name === 'respondApproval').length, beforeModalCalls);
    await js(`$('appearance-dialog').close();window.__composerApprovalFixture.setMode('expired');$('composer-approval').querySelector('.approval-accept').click()`);
    await until('expired reply cleared', async () => (await inspect()).hidden);

    stage = 'open project and session menus retain focus and block approval shortcuts';
    for (const popupId of ['project-dropdown', 'session-dropdown']) {
      const approvalId = 'menu-guard-' + popupId;
      const beforeMenuCalls = (await calls()).filter(value => value.name === 'respondApproval').length;
      await js(`(() => {
        restoringWorkspace=false;
        appState={...appState,permissionMode:'assist'};
        const popup=$(${JSON.stringify(popupId)});
        if(!popup)throw new Error('Missing menu fixture: '+${JSON.stringify(popupId)});
        popup.hidden=false;popup.tabIndex=-1;popup.focus();
        if(document.activeElement!==popup)throw new Error('Menu fixture could not receive focus');
      })()`);
      await emit({ type: 'approval-request', id: approvalId, kind: 'command', title: '等待本次命令确认', command: 'display-only' });
      assert.equal(await js(`document.activeElement===$(${JSON.stringify(popupId)})`), true,
        'An arriving approval stole keyboard focus from ' + popupId);
      assert.match((await inspect()).status, /不在自动批准范围/, 'Assist mode must explain why this operation still needs approval');
      await nativeKey('Enter');
      assert.equal((await calls()).filter(value => value.name === 'respondApproval').length, beforeMenuCalls,
        'Enter in the open ' + popupId + ' approved an operation');
      // Also exercise the overlay check independently of the card-focus check:
      // an already-focused card cannot consume Enter while either menu is open.
      await js(`$('composer-approval').firstElementChild.focus()`);
      await nativeKey('Enter');
      assert.equal((await calls()).filter(value => value.name === 'respondApproval').length, beforeMenuCalls,
        'Approval shortcut ignored the open ' + popupId);
      await js(`$(${JSON.stringify(popupId)}).hidden=true`);
      await emit({ type: 'approval-resolved', id: approvalId, approved: false });
      assert.equal((await inspect()).hidden, true);
    }
    await js(`appState={...appState,permissionMode:'request'}`);

    stage = 'completion, stop and state reconciliation clear pending decisions';
    await js('restoringWorkspace=true');
    for (const status of ['completed', 'stopped', 'failed']) {
      await emit({ type: 'run-start', kind: 'agent', runId: 'cleanup-' + status, startedAt: Date.now() });
      await emit({ type: 'approval-request', id: 'cleanup-' + status, kind: 'command', command: 'display-only' });
      await emit({ type: 'run-end', runId: 'cleanup-' + status, status, elapsedMs: 10 });
      assert.equal((await inspect()).hidden, true); assert.equal((await inspect()).pending, 0);
    }
    await js(`syncComposerApprovals([{id:'reconciled-request',kind:'command',command:'display-only'}]);syncComposerApprovals([])`);
    assert.equal((await inspect()).hidden, true);

    stage = 'workspace switch and late response isolation';
    await emit({ type: 'run-start', kind: 'agent', startedAt: Date.now() });
    await emit({ type: 'approval-request', id: 'late-old-project', kind: 'command', command: 'display-only' });
    await js(`window.__composerApprovalFixture.setMode('deferred');window.__oldApprovalAccept=$('composer-approval').querySelector('.approval-accept');window.__oldApprovalAccept.click()`);
    await until('old response pending', async () => (await inspect()).disabled);
    await js(`(() => {
      restoringWorkspace=true;
      activateWorkspace({...appState,workspaceId:'composer-approval-project-b',sessionId:'composer-approval-session-b',workspace:{root:'C:/display-only-b',name:'项目 B'},
        activeTask:{running:true,kind:'agent',runId:'composer-approval-run-b',startedAt:Date.now()},
        pendingApprovals:[{id:'new-project-request',workspaceId:'composer-approval-project-b',kind:'command',command:'new-project-display-only'}]},
        {id:'composer-approval-session-b',workspace:'C:/display-only-b',messages:[],events:[]});
      $('task-input').value='项目 B 草稿';window.__oldApprovalAccept.click();
      window.__composerApprovalFixture.complete('late-old-project',true);
    })()`);
    await wait(80);
    assert.equal((await inspect()).id, 'new-project-request');
    assert.equal((await inspect()).draft, '项目 B 草稿');
    assert.equal((await calls()).filter(value => value.name === 'respondApproval' && value.arg.id === 'late-old-project').length, 1);
    await emit({ type: 'approval-resolved', id: 'new-project-request', approved: true });
    assert.equal((await inspect()).id, 'new-project-request', 'An old workspace event resolved a new workspace request');
    await js(`handleEvent({type:'approval-resolved',workspaceId:'composer-approval-project-b',id:'new-project-request',approved:false})`);
    assert.equal((await inspect()).hidden, true);

    stage = 'history retains successful differences without approval controls';
    const runId = 'approval-history-run';
    await js(`(() => {
      restoringWorkspace=true;running=false;
      appState={...appState,activeTask:{running:false,kind:null},pendingApprovals:[]};
      renderSessionSnapshot({id:'composer-history',workspace:'C:/display-only-b',messages:[
        {role:'user',content:'更新文件'},
        {role:'assistant',content:'修改文件。',toolCalls:[{id:'history-write',name:'write_file',arguments:{path:'src/main.cjs',content:${JSON.stringify(after)}}}]},
        {role:'tool',toolCallId:'history-write',content:'{"path":"src/main.cjs","message":"文件已保存。"}'},
        {role:'assistant',content:'更新完成。',toolCalls:[]}],
        fileEdits:[{runId:${JSON.stringify(runId)},toolCallId:'history-write',path:'src/main.cjs',before:${JSON.stringify(before)},after:${JSON.stringify(after)}}],
        events:[{type:'approval-request',id:'historical-approval',runId:${JSON.stringify(runId)},kind:'write',path:'src/main.cjs',before:${JSON.stringify(before)},after:${JSON.stringify(after)}},
          {type:'approval-resolved',runId:${JSON.stringify(runId)},id:'historical-approval',approved:true},
          {type:'run-end',runId:${JSON.stringify(runId)},status:'completed',messageStartIndex:0,messageIndex:3,elapsedMs:2000}]});
    })()`);
    assert.equal(await js(`$('messages').querySelectorAll('.approval-accept,.approval-reject,.approval-card').length`), 0);
    assert.equal(await js(`$('messages').querySelectorAll('.code-diff-card').length`), 1);
    assert.equal((await inspect()).hidden, true);
    assert.equal((await inspect()).unsafe, false);
    assert.deepEqual(errors.filter(message => !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(message)), []);
    const result = { status: 'completed', replacementPreservesDraftAndAttachments: true, hiddenDraftCannotSubmit: true,
      commandAndFilePreviews: true, queueAndProcessingControls: true, retryableError: true,
      scopedKeyboard: true, modalBlocksRejection: true, openMenusRetainFocusAndBlockApproval: true,
      assistModeExplainsManualApproval: true, expiredRequestsCleared: true,
      taskEndCleanup: true, workspaceAndLateReplyIsolation: true, historicalDiffWithoutApprovalControls: true,
      realApprovals: false, realCommands: false, realApi: false };
    await fs.writeFile(path.join(output, 'composer-approval-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    if (child && !child.isDestroyed()) await capture('composer-approval-failure.png').catch(() => {});
    await fs.writeFile(path.join(output, 'composer-approval-result.json'), JSON.stringify({ status: 'failed', stage, error: error.message, errors }, null, 2) + '\n');
    throw new Error('Composer approval smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (child && !child.isDestroyed()) child.destroy();
  }
};
