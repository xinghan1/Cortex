// Actual committed WorkspaceTools writes against a disposable loopback model.
// Cards are exercised through native UI; no external model or user file is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeTaskChangeSummary({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce=randomUUID(),project=path.join(dataDir,'task-summary-'+nonce);
  const model='smoke-task-change-summary',apiKey='task-change-fixture-key';
  const prompts={success:'TASK_CHANGE_SUCCESS_'+nonce,conflict:'TASK_CHANGE_CONFLICT_'+nonce};
  const initial={'a.txt':'one\nbase\n','c.txt':'C0\n','conflict-a.txt':'ORIGINAL_A\n','conflict-b.txt':'ORIGINAL_B\n'};
  const final={'a.txt':'one\nfinal\n','b.txt':'B1\nB2\n','c.txt':'C1\nC2\n','d.txt':'D1\n'};
  const conflict={'conflict-a.txt':'AI_A\n','conflict-b.txt':'AI_B\n'},external='EXTERNAL_CONTENT_MUST_SURVIVE\n';
  const requests=[],problems=[],runIds=new Map();
  let child,configured=false,stage='isolated fixture setup';
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,check,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await wait(25);}throw new Error('Task change summary smoke timed out: '+label+(problems.length?'; '+problems.join(' | '):''));};
  const js=code=>child.webContents.executeJavaScript(code);
  const invoke=(name,value)=>`window.forge[${JSON.stringify(name)}](${value===undefined?'':JSON.stringify(value)})`;
  const call=(name,value)=>js(invoke(name,value));
  const parentCall=(name,value)=>win.webContents.executeJavaScript(invoke(name,value));
  const original=await parentCall('getState');
  assert.equal(original.settings.providers.openai.hasKey,false,'Refusing to replace a configured credential');
  const state=()=>call('getState'),events=()=>js('window.__taskSummarySmoke.events');
  const root=scene=>`.task-change-summary[data-run-id=${JSON.stringify(runIds.get(scene))}]`;
  const card=async scene=>js(`(()=>{const n=document.querySelector(${JSON.stringify(root(scene))});if(!n)return null;return {count:document.querySelectorAll(${JSON.stringify(root(scene))}).length,
    text:n.textContent,total:n.querySelector('.task-change-count')?.textContent,added:n.querySelector('.task-change-added')?.textContent,removed:n.querySelector('.task-change-removed')?.textContent,
    files:[...n.querySelectorAll('.task-change-file')].filter(row=>row.checkVisibility()&&!row.closest('[inert]')).map(row=>row.dataset.path),
    allFiles:[...n.querySelectorAll('.task-change-file')].map(row=>row.dataset.path),
    more:n.querySelector('.task-change-more')?.textContent,undoDisabled:n.querySelector('.task-change-undo')?.disabled,
    redoDisabled:n.querySelector('.task-change-redo')?.disabled,redoHidden:n.querySelector('.task-change-redo')?.hidden,
    status:n.querySelector('.task-change-status')?.textContent};})()`);
  const click=async selector=>{
    await until('visible enabled '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&n.checkVisibility({visibilityProperty:true,opacityProperty:true});})()`));
    const point=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered summary control');return p;})()`);
    child.webContents.focus();child.webContents.sendInputEvent({type:'mouseMove',...point});
    child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await wait(45);
  };
  const capture=async(name,selector)=>{
    await until('summary transitions settled for '+name,()=>js(`[...document.querySelectorAll('.task-change-summary')].every(n=>n.getAnimations({subtree:true}).every(a=>a.playState!=='running'))`));
    await until('summary visibility following settled for '+name,()=>js('!fileDisclosureReveal'));
    if(selector)await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});true`);
    child.webContents.invalidate();await wait(160);await fs.writeFile(path.join(output,name),(await child.webContents.capturePage()).toPNG());
  };
  const tool=(id,file,content)=>({type:'function_call',call_id:id,name:'write_file',arguments:JSON.stringify({path:file,content})});
  const reply=(record,items)=>{record.released=true;record.response.writeHead(200,{'Content-Type':'application/json'});record.response.end(JSON.stringify({id:'summary-'+requests.indexOf(record),status:'completed',output:items,usage:{input_tokens:7,output_tokens:3}}));};
  const server=http.createServer(async(request,response)=>{
    try{
      assert.equal(request.headers.authorization,'Bearer '+apiKey);
      if(request.method==='GET'&&request.url==='/v1/models'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:model,supportsTools:true,reasoningEfforts:[],context_window:128000}]}));return;}
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/responses');
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<300000);}
      const body=JSON.parse(raw),user=body.input.filter(item=>item.role==='user').at(-1);
      const text=typeof user.content==='string'?user.content:user.content.map(item=>item.text||'').join('\n');
      const scene=Object.keys(prompts).find(key=>text===prompts[key]);assert.ok(scene);assert.equal(body.model,model);
      const turn=requests.filter(item=>item.scene===scene).length+1,record={scene,turn,response,released:false};requests.push(record);
      if(turn===1){
        const calls=scene==='success'?[tool('success-a-first','a.txt','one\nTEMP\nextra-temp\n'),tool('success-b','b.txt',final['b.txt']),
          tool('success-c','c.txt',final['c.txt']),tool('success-d','d.txt',final['d.txt']),tool('success-denied','denied.txt','DENIED_MUST_NOT_BE_CREATED\n'),tool('success-a-final','a.txt',final['a.txt'])]
          :Object.entries(conflict).map(([file,content],index)=>tool('conflict-'+index,file,content));
        reply(record,calls);return;
      }
      assert.equal(turn,2,'Only one tool turn and one final answer are expected');
      const returned=body.input.filter(item=>item.type==='function_call_output');
      for(const [id,file] of (scene==='success'?[['success-a-first','a.txt'],['success-b','b.txt'],['success-c','c.txt'],['success-d','d.txt'],['success-a-final','a.txt']]:[['conflict-0','conflict-a.txt'],['conflict-1','conflict-b.txt']])){
        const result=returned.findLast(item=>item.call_id===id);assert.ok(result);assert.equal(JSON.parse(result.output).path,file);
      }
      if(scene==='success')assert.match(returned.find(item=>item.call_id==='success-denied')?.output||'',/拒绝|denied/u);
      reply(record,[{type:'message',role:'assistant',content:[{type:'output_text',text:'已完成本轮实际修改。TASK_SUMMARY_DONE_'+scene}]}]);
    }catch(error){problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}}
  });
  const submit=async scene=>{
    await call('submitPrompt',{text:prompts[scene],mode:'queue'});
    const event=await until('user run '+scene,async()=> (await events()).find(event=>event.type==='user-message'&&event.text===prompts[scene]));runIds.set(scene,event.runId);
  };
  const decide=async(expected,approved=true)=>{
    const request=await until('approval '+expected,async()=> (await state()).pendingApprovals.find(item=>item.path===expected));
    assert.equal(request.kind,'write');
    await click('#composer-approval .'+(approved?'approval-accept':'approval-reject'));
    await until('approval resolved '+request.id,async()=>!(await state()).pendingApprovals.some(item=>item.id===request.id));
  };
  const completed=scene=>until('run completed '+scene,async()=>{const end=(await events()).find(event=>event.type==='run-end'&&event.runId===runIds.get(scene));if(end)assert.equal(end.status,'completed',end.error||scene);return end&&!(await state()).activeTask.running&&end;});
  const chatActivity=()=>js(`({groups:$('messages').querySelectorAll('.task-activity').length,results:$('messages').querySelectorAll('.run-result').length})`);
  const settleChange=async(scene,direction,files)=>{
    const field=direction==='redo'?'redoableRunIds':'undoableRunIds',deadline=Date.now()+15000;
    while(Date.now()<deadline){
      const current=await state();
      if(!current[field].includes(runIds.get(scene))&&!current.activeTask.running)break;
      const pending=current.pendingApprovals[0];
      if(pending){assert.equal(pending.kind,'write');assert.ok(Object.hasOwn(files,pending.path));await click('#composer-approval .approval-accept');await until('change approval resolved',async()=>!(await state()).pendingApprovals.some(item=>item.id===pending.id));}
      else await wait(25);
    }
    await until('change direction settled '+direction,async()=>{const current=await state();return !current.activeTask.running&&!current[field].includes(runIds.get(scene));});
  };
  const assertFiles=async values=>{for(const [file,content] of Object.entries(values))assert.equal(await fs.readFile(path.join(project,file),'utf8'),content,file);};
  const unavailableUndo=async (runId,direction='undo')=>{
    let denied;
    try{const value=await call(direction==='redo'?'redoRunChanges':'undoRunChanges',{runId});const parsed=JSON.parse(value.result);denied=parsed.status!=='completed'&&!(parsed.completed||[]).length;}
    catch(error){denied=!!error.message;}
    assert.equal(denied,true,'An unavailable historical run must not mutate the project');
  };
  try{
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});
    for(const [file,content]of Object.entries(initial))await fs.writeFile(path.join(project,file),content);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    child=BrowserWindow.fromId((await parentCall('newWindow')).id);assert.ok(child&&child!==win&&child.webContents.isOffscreen());
    await until('child initialized',()=>js('Boolean(appState&&window.forge&&!projectSwitching&&window.ForgeTaskChangeSummary)'));
    child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.webContents.focus();
    await js(`window.__taskSummarySmoke={events:[]};window.__taskSummarySmoke.off=window.forge.onEvent(event=>window.__taskSummarySmoke.events.push(event));true`);
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);await until('isolated project',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    await call('saveSettings',{provider:'openai',authMode:'apiKey',apiProtocol:'responses',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey,model,reasoningEffort:'default'});configured=true;
    await call('listModels',{force:true});await call('setPermissionMode',{mode:'request'});
    const firstSession=(await state()).sessionId,ledgerStart=store.usage.records.length;

    stage='actual committed files, duplicate rewrites and rejected proposal';
    await submit('success');
    for(const file of ['a.txt','b.txt','c.txt','d.txt'])await decide(file);
    await decide('denied.txt',false);await decide('a.txt');await completed('success');await assertFiles(final);
    assert.equal(await fs.stat(path.join(project,'denied.txt')).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error)),false);
    let summary=await until('one completed net summary',async()=>{const value=await card('success');return value?.count===1&&value.undoDisabled===false&&value;});
    assert.match(summary.total,/4/u);assert.equal(Number(summary.added.replace(/[^\d]/gu,'')),6);assert.equal(Number(summary.removed.replace(/[^\d]/gu,'')),2);
    assert.equal(summary.files.length,3,'Only three file rows should be initially visible');assert.ok(!summary.text.includes('denied.txt'));assert.equal(summary.undoDisabled,false);
    assert.ok((await state()).undoableRunIds.includes(runIds.get('success')));
    await click(root('success')+' .task-change-more');summary=await card('success');assert.deepEqual(new Set(summary.files),new Set(Object.keys(final)));
    await click(root('success')+' .task-change-view');
    await until('multi-file inline diff previews',()=>js(`document.querySelectorAll(${JSON.stringify(root('success')+' .task-change-file-preview.open')}).length===4&&document.querySelectorAll(${JSON.stringify(root('success')+' .task-change-diff')}).length===4`));
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(root('success')+' .task-change-entry')}).length`),4);
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(root('success')+' .task-change-diff-heading')}).length`),0,'Preview must not create a second file directory');
    await click(root('success')+' .task-change-file[data-path="a.txt"]');
    assert.equal(await js(`document.querySelector(${JSON.stringify(root('success')+' .task-change-file[data-path="a.txt"]')}).getAttribute('aria-expanded')`),'false');
    await click(root('success')+' .task-change-file[data-path="a.txt"]');
    const diff=await js(`(()=>{const n=document.querySelector(${JSON.stringify(root('success')+' .task-change-diff[data-path="a.txt"]')}),entry=n.closest('.task-change-entry');return {open:entry.querySelector('.task-change-file').getAttribute('aria-expanded')==='true',inline:entry.dataset.path===n.dataset.path,text:n.textContent};})()`);
    assert.equal(diff.open,true);assert.match(diff.text,/base/u);assert.match(diff.text,/final/u);assert.doesNotMatch(diff.text,/TEMP|extra-temp/u,'Preview must show the original-to-final net diff');
    assert.equal(diff.inline,true);
    await capture('task-change-summary-expanded.png',root('success')+' .task-change-entry[data-path="a.txt"]');

    stage='single-file display fixture has one entry through repeated native show and hide';
    await js(`(()=>{const runId='single-display-'+${JSON.stringify(nonce)},summary=ForgeTaskChangeSummary.aggregate([{runId,path:'a.txt',before:${JSON.stringify(initial['a.txt'])},after:${JSON.stringify(final['a.txt'])}}],runId,{expectedCount:1});const card=ForgeTaskChangeSummary.create(summary,{canUndo:false,canRedo:false,onExpand:revealFileDisclosure});card.id='single-summary-display-fixture';$('messages').append(card);true;})()`);
    assert.equal(await js(`$('single-summary-display-fixture').querySelectorAll('.task-change-diff').length`),0,'Single-file preview should remain lazy before first opening');
    for(let index=0;index<2;index++){
      await click('#single-summary-display-fixture .task-change-view');
      await until('single-file inline preview opened '+index,()=>js(`$('single-summary-display-fixture').querySelector('.task-change-file-preview').classList.contains('open')`));
      const single=await js(`(()=>{const n=$('single-summary-display-fixture'),row=n.querySelector('.task-change-file'),diff=n.querySelector('.task-change-diff');return {entries:n.querySelectorAll('.task-change-entry').length,rows:n.querySelectorAll('.task-change-file').length,paths:[...n.querySelectorAll('.task-change-path')].map(p=>p.textContent),previews:n.querySelectorAll('.task-change-diff').length,code:n.querySelectorAll('.code-diff-card').length,separateDirectory:n.querySelectorAll('.task-change-diff-heading').length,inline:diff?.closest('.task-change-entry')===row?.parentElement,expanded:row?.getAttribute('aria-expanded')};})()`);
      assert.deepEqual(single,{entries:1,rows:1,paths:['a.txt'],previews:1,code:1,separateDirectory:0,inline:true,expanded:'true'});
      await until('single-file preview automatically visible above composer '+index,()=>js(`(()=>{const entry=$('single-summary-display-fixture').querySelector('.task-change-entry'),r=entry.getBoundingClientRect(),v=$('message-scroll').getBoundingClientRect(),c=document.querySelector('.composer-area').getBoundingClientRect();return !fileDisclosureReveal&&r.height>100&&r.top>=v.top-2&&r.bottom<=Math.min(v.bottom,c.top)+2;})()`));
      if(index===1)await capture('task-change-summary-single-inline.png');
      await click('#single-summary-display-fixture .task-change-view');
      assert.equal(await js(`$('single-summary-display-fixture').querySelector('.task-change-file').getAttribute('aria-expanded')`),'false');
      assert.equal(await js(`$('single-summary-display-fixture').querySelector('.task-change-file-preview .task-change-collapse-inner').inert`),true);
      assert.equal(await js(`$('single-summary-display-fixture').querySelectorAll('.task-change-diff').length`),1,'Closing and reopening must reuse the same preview');
    }
    await js(`$('single-summary-display-fixture').remove();true`);

    stage='native per-run undo restores original bytes and deletes created files';
    const activityBeforeUndo=await chatActivity();
    await click(root('success')+' .task-change-undo');
    await settleChange('success','undo',final);
    await assertFiles({'a.txt':initial['a.txt'],'c.txt':initial['c.txt']});
    for(const file of ['b.txt','d.txt'])assert.equal(await fs.stat(path.join(project,file)).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error)),false);
    await until('successful card undo disabled',async()=>(await card('success'))?.undoDisabled===true);
    await until('successful card can cancel undo',async()=>{const value=await card('success');return value&&!value.redoHidden&&!value.redoDisabled;});
    assert.ok((await state()).redoableRunIds.includes(runIds.get('success')));
    assert.deepEqual(await chatActivity(),activityBeforeUndo,'Undo must not add elapsed-time or completion rows');

    stage='native redo and repeated undo stay within the existing summary';
    await click(root('success')+' .task-change-redo');await settleChange('success','redo',final);await assertFiles(final);
    assert.deepEqual(await chatActivity(),activityBeforeUndo,'Redo must not add elapsed-time or completion rows');
    await until('redo restores undo availability',async()=>(await card('success'))?.undoDisabled===false);
    await click(root('success')+' .task-change-undo');await settleChange('success','undo',final);
    await assertFiles({'a.txt':initial['a.txt'],'c.txt':initial['c.txt']});
    for(const file of ['b.txt','d.txt'])assert.equal(await fs.stat(path.join(project,file)).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error)),false);
    assert.deepEqual(await chatActivity(),activityBeforeUndo,'Repeated undo must reuse the existing summary');
    await until('redo restored after repeated undo',async()=>{const value=await card('success');return value?.undoDisabled&&!value.redoHidden&&!value.redoDisabled;});

    stage='undo preflight conflicts preserve every current file';
    await submit('conflict');await decide('conflict-a.txt');await decide('conflict-b.txt');await completed('conflict');await assertFiles(conflict);
    await until('conflict run summary',async()=> (await card('conflict'))?.undoDisabled===false);
    await fs.writeFile(path.join(project,'conflict-a.txt'),external);
    const activityBeforeConflict=await chatActivity();
    const undoResultsBefore=(await events()).filter(event=>event.type==='tool-result'&&event.name==='undo_run_changes').length;
    await click(root('conflict')+' .task-change-undo');
    const conflictOutcome=await until('actual conflict undo tool result',async()=>{
      const results=(await events()).filter(event=>event.type==='tool-result'&&event.name==='undo_run_changes');
      return results.length>undoResultsBefore&&JSON.parse(results.at(-1).result);
    });
    assert.equal(conflictOutcome.status,'failed');assert.deepEqual(conflictOutcome.completed,[]);
    assert.deepEqual(new Set(conflictOutcome.remaining),new Set(Object.keys(conflict)));
    assert.match(conflictOutcome.error,/conflict-a\.txt.*变化/u);
    await until('conflict reported to user',()=>js(`!taskChangeUndoBusy&&/变化|冲突|保留|无法撤销/u.test(document.querySelector(${JSON.stringify(root('conflict')+' .task-change-status')})?.textContent||'')`));
    await until('failed undo settled',async()=>!(await state()).activeTask.running&&!(await state()).pendingApprovals.length);
    assert.deepEqual(await chatActivity(),activityBeforeConflict,'Failed undo must not add task rows');
    await assertFiles({'conflict-a.txt':external,'conflict-b.txt':conflict['conflict-b.txt']});
    await js(`document.querySelector(${JSON.stringify(root('conflict')+' .task-change-status')}).scrollIntoView({block:'center',behavior:'instant'});true`);
    await capture('task-change-summary-conflict.png');

    stage='history rerender, reload and cross-session undo safety';
    await js(`loadSession(${JSON.stringify(firstSession)})`);
    await until('history summary and persistent action directions restored',async()=>{const a=await card('success'),b=await card('conflict');return a?.count===1&&b?.count===1&&a.undoDisabled&&!a.redoHidden&&!a.redoDisabled&&!b.undoDisabled;});
    const historyActivity=await chatActivity();
    assert.equal(historyActivity.groups,activityBeforeConflict.groups,'History must omit undo and redo activity groups');
    assert.ok(historyActivity.results<=activityBeforeConflict.results,'History must not add undo or redo completion rows');
    assert.ok((await state()).undoableRunIds.includes(runIds.get('conflict')));
    assert.ok((await state()).redoableRunIds.includes(runIds.get('success')));
    const loaded=new Promise(resolve=>child.webContents.once('did-finish-load',resolve));child.webContents.reload();await loaded;
    await until('renderer history reload',()=>js(`Boolean(appState&&!projectSwitching&&sessionId===${JSON.stringify(firstSession)})`));
    for(const scene of ['success','conflict']){
      const value=await until('history card '+scene,async()=>{const n=await card(scene);return n&&(scene==='success'?n.undoDisabled&&!n.redoHidden&&!n.redoDisabled:!n.undoDisabled)&&n;});
      assert.equal(value.count,1);
    }
    assert.deepEqual(await chatActivity(),historyActivity,'Reloaded history must not add undo and redo activity rows');
    await js('newSession()');await until('new session active',async()=>(await state()).sessionId!==firstSession);
    assert.equal(await js(`document.querySelectorAll('.task-change-summary').length`),0);
    assert.deepEqual((await state()).undoableRunIds,[]);assert.deepEqual((await state()).redoableRunIds,[]);
    for(const direction of ['undo','redo']){await unavailableUndo(runIds.get('success'),direction);await unavailableUndo(runIds.get('conflict'),direction);}
    await assertFiles({'a.txt':initial['a.txt'],'c.txt':initial['c.txt'],'conflict-a.txt':external,'conflict-b.txt':conflict['conflict-b.txt']});
    assert.deepEqual(problems,[]);assert.equal(requests.length,4,'Undo and history must not call a model');
    const ledger=store.usage.records.slice(ledgerStart);assert.equal(ledger.length,4);assert.equal(ledger.reduce((sum,item)=>sum+item.inputTokens+item.outputTokens,0),40);
    const result={status:'completed',realExternalApi:false,realCommands:false,actualWorkspaceWrites:true,actualNativeApprovals:true,deniedProposalExcluded:true,
      uniqueFiles:4,netAdded:6,netRemoved:2,repeatedFileNetDiff:true,threeRowsAndExpand:true,multiFileDiffPreview:true,inlinePreviewsUseOriginalRows:true,singleFileOneEntryAcrossRepeatedToggle:true,singleFilePreviewAutomaticallyVisible:true,
      actualPerRunUndo:true,actualNativeRedo:true,undoRedoAddsNoTaskRows:true,conflictPreflightPreservesAllFiles:true,historyNoDuplicateCards:true,historicalUndoAndRedoAvailable:true,crossSessionSafe:true,
      modelRequests:requests.length,screenshots:['task-change-summary-expanded.png','task-change-summary-single-inline.png','task-change-summary-conflict.png']};
    await fs.writeFile(path.join(output,'task-change-summary-result.json'),JSON.stringify(result,null,2));return result;
  }catch(error){
    const failure={stage,error:error.message,stack:error.stack,problems,requests:requests.map(({scene,turn,released})=>({scene,turn,released})),runIds:Object.fromEntries(runIds)};
    if(child&&!child.isDestroyed()){try{failure.state=await state();failure.summaries=await js(`[...document.querySelectorAll('.task-change-summary')].map(n=>({runId:n.dataset.runId,text:n.textContent}))`);await capture('task-change-summary-failure.png');}catch{}}
    await fs.writeFile(path.join(output,'task-change-summary-result.json'),JSON.stringify(failure,null,2));throw error;
  }finally{
    if(child&&!child.isDestroyed()){await call('stopTask').catch(()=>{});child.close();await until('isolated summary window closed',()=>child.isDestroyed()).catch(()=>child.destroy());}
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
    if(configured&&!win.isDestroyed()){
      const previous=original.settings.providers.openai;
      await parentCall('saveSettings',{provider:'openai',model:previous.model,baseUrl:previous.baseUrl,apiProtocol:previous.apiProtocol,reasoningEffort:previous.reasoningEffort,authMode:previous.authMode,clearKey:true});
      const selected=original.settings.providers[original.settings.provider];
      await parentCall('saveSettings',{provider:original.settings.provider,model:original.settings.model,baseUrl:selected.baseUrl,apiProtocol:selected.apiProtocol,authMode:selected.authMode,reasoningEffort:original.settings.reasoningEffort});
    }
  }
};
