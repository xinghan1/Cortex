// Three real Electron main processes share only this disposable data directory.
// Model requests exist only in prepare and use an isolated loopback fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

module.exports = async function smokePersistentUndo({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(),true);
  const phase=process.env.FORGEDESK_PERSISTENT_UNDO_SMOKE_PHASE;
  assert.ok(['prepare','verify','verify-again'].includes(phase),'Set FORGEDESK_PERSISTENT_UNDO_SMOKE_PHASE');
  const marker=path.join(dataDir,'persistent-undo-smoke-fixture.json');
  const js=code=>win.webContents.executeJavaScript(code);
  const call=(name,value)=>js(`window.forge[${JSON.stringify(name)}](${value===undefined?'':JSON.stringify(value)})`);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,check)=>{const end=Date.now()+15000;while(Date.now()<end){const value=await check();if(value)return value;await wait(25);}throw new Error('Persistent undo smoke timed out: '+label);};
  const state=()=>call('getState'),events=()=>js('window.__persistentUndoSmoke.events');
  let fixture,server,configured=false,original,stage='read initial restored snapshot';
  const problems=[],requests=[];
  const card=()=>`.task-change-summary[data-run-id=${JSON.stringify(fixture.runId)}]`;
  const click=async selector=>{
    await until('native enabled '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&n.checkVisibility({visibilityProperty:true,opacityProperty:true});})()`));
    const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered persistent undo control');return p;})()`);
    win.webContents.focus();win.webContents.sendInputEvent({type:'mouseMove',...p});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(40);
  };
  const disk=async expected=>{
    for(const [file,content]of Object.entries(expected)){
      const actual=await fs.readFile(path.join(fixture.project,file),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      assert.equal(actual,content,file);
    }
  };
  const direction=async expected=>until('persisted direction '+expected,async()=>{
    const value=await state(),yes=expected==='redo'?value.redoableRunIds:value.undoableRunIds,no=expected==='redo'?value.undoableRunIds:value.redoableRunIds;
    const ui=await js(`(()=>{const card=document.querySelector(${JSON.stringify(card())});if(!card)return false;const button=card.querySelector(${JSON.stringify('.task-change-'+expected)});return !!button&&!button.hidden&&!button.disabled;})()`);
    return yes.includes(fixture.runId)&&!no.includes(fixture.runId)&&ui&&!await js('taskChangeUndoBusy')&&value;
  });
  const perform=async(action,expectedStatus='completed')=>{
    const tool=action==='redo'?'redo_run_changes':'undo_run_changes';
    const before=(await events()).filter(event=>event.type==='tool-result'&&event.name===tool).length;
    await click(card()+' .task-change-'+action);
    const end=Date.now()+15000;let result;
    while(Date.now()<end){
      const results=(await events()).filter(event=>event.type==='tool-result'&&event.name===tool);
      if(results.length>before){result=JSON.parse(results.at(-1).result);break;}
      const value=await state();
      if(value.pendingApprovals.length){
        assert.equal(expectedStatus,'completed','Conflicts must fail preflight before asking to mutate any file');
        const request=value.pendingApprovals[0];assert.equal(request.kind,'write');assert.ok(Object.hasOwn(fixture.after,request.path));
        await click('#composer-approval .approval-accept');
        await until('approved file '+request.id,async()=>!(await state()).pendingApprovals.some(item=>item.id===request.id));
      }else await wait(25);
    }
    assert.ok(result,'The native button must invoke an actual '+tool+' operation');assert.equal(result.status,expectedStatus,result.message);
    await until('operation and UI settled',async()=>!(await state()).activeTask.running&&!await js('taskChangeUndoBusy'));
    if(expectedStatus==='completed'){
      assert.deepEqual(new Set(result.completed),new Set(Object.keys(fixture.after)));assert.deepEqual(result.remaining,[]);
      await direction(action==='redo'?'undo':'redo');
    }else{
      assert.deepEqual(result.completed,[]);assert.deepEqual(new Set(result.remaining),new Set(Object.keys(fixture.after)));
      assert.match(result.error,/edit\.txt.*变化/u);await direction(action);
    }
    return result;
  };
  const protectedLedger=async()=>{
    const file=path.join(dataDir,'task-undo',fixture.sessionId+'.json');
    const raw=await fs.readFile(file,'utf8'),record=JSON.parse(raw);
    assert.equal(record.sessionId,fixture.sessionId);assert.equal(typeof record.encrypted,'string');assert.ok(record.encrypted.length>40);
    for(const value of [...Object.values(fixture.before),...Object.values(fixture.after)].filter(value=>value))assert.equal(raw.includes(value),false,'Original file contents must not appear in the encrypted ledger envelope');
    return true;
  };
  try{
    await fs.mkdir(output,{recursive:true});
    await until('renderer initialized',()=>js('Boolean(appState&&window.forge&&window.ForgeTaskChangeSummary&&!projectSwitching)'));
    win.setOpacity(0);win.showInactive();win.webContents.focus();
    const entry=await state(),entrySession=await call('getCurrentSession');
    await js('window.__persistentUndoSmoke={events:[]};window.__persistentUndoSmoke.off=window.forge.onEvent(event=>window.__persistentUndoSmoke.events.push(event));true');
    if(phase==='prepare'){
      assert.equal(await fs.stat(marker).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error)),false,'Prepare needs a fresh data directory');
      const nonce=randomUUID(),project=path.join(dataDir,'persistent-undo-'+nonce),prompt='PERSISTENT_UNDO_'+nonce;
      fixture={nonce,project,prompt,pids:[process.pid],before:{'edit.txt':'ORIGINAL_'+nonce+'\n','new.txt':null,'empty.txt':''},
        after:{'edit.txt':'UPDATED_'+nonce+'\n','new.txt':'NEW_'+nonce+'\n','empty.txt':'FILLED_'+nonce+'\n'}};
      await fs.mkdir(project,{recursive:true});for(const[file,content]of Object.entries(fixture.before))if(content!==null)await fs.writeFile(path.join(project,file),content);
      original=entry;assert.equal(original.settings.providers.openai.hasKey,false);
      const model='smoke-persistent-undo',apiKey='persistent-undo-fixture-key';
      server=http.createServer(async(request,response)=>{
        try{
          assert.equal(request.headers.authorization,'Bearer '+apiKey);
          if(request.method==='GET'&&request.url==='/v1/models'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:model,supportsTools:true,reasoningEfforts:[],context_window:128000}]}));return;}
          assert.equal(request.method,'POST');assert.equal(request.url,'/v1/responses');let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<150000);}
          const body=JSON.parse(raw);assert.equal(body.model,model);assert.ok(raw.includes(prompt));requests.push(body);
          const items=requests.length===1?Object.entries(fixture.after).map(([file,content],index)=>({type:'function_call',call_id:'persist-'+index,name:'write_file',arguments:JSON.stringify({path:file,content})}))
            :[{type:'message',role:'assistant',content:[{type:'output_text',text:'已完成持久撤销测试文件。'}]}];
          assert.ok(requests.length<=2);if(requests.length===2)for(let index=0;index<3;index++)assert.ok(body.input.some(item=>item.type==='function_call_output'&&item.call_id==='persist-'+index));
          response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({id:'persist-'+requests.length,status:'completed',output:items,usage:{input_tokens:7,output_tokens:3}}));
        }catch(error){problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}}
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      await js(`openRecentProject({path:${JSON.stringify(project)}})`);await until('fixture project active',async()=>(await state()).workspace?.root===project&&!await js('projectSwitching'));
      await call('saveSettings',{provider:'openai',authMode:'apiKey',apiProtocol:'responses',model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey,reasoningEffort:'default'});configured=true;
      await call('listModels',{force:true});await call('setPermissionMode',{mode:'request'});
      await call('submitPrompt',{text:prompt,mode:'queue'});
      const user=await until('actual task user event',async()=>(await events()).find(event=>event.type==='user-message'&&event.text===prompt));fixture.runId=user.runId;
      for(const file of Object.keys(fixture.after)){
        const request=await until('write approval '+file,async()=>(await state()).pendingApprovals.find(item=>item.path===file));
        await click('#composer-approval .approval-accept');await until('write approval resolved',async()=>!(await state()).pendingApprovals.some(item=>item.id===request.id));
      }
      await until('actual write task completed',async()=>{const end=(await events()).find(event=>event.type==='run-end'&&event.runId===fixture.runId);if(end)assert.equal(end.status,'completed',end.error);return end&&!(await state()).activeTask.running;});
      fixture.sessionId=(await state()).sessionId;fixture.title=(await state()).sessionTitle;
      await disk(fixture.after);await direction('undo');await perform('undo');await disk(fixture.before);
      assert.equal(requests.length,2);assert.deepEqual(problems,[]);
      await protectedLedger();await fs.writeFile(marker,JSON.stringify(fixture,null,2));
    }else{
      fixture=JSON.parse(await fs.readFile(marker,'utf8'));assert.ok(!fixture.pids.includes(process.pid),'Use distinct Electron main processes for every phase');fixture.pids.push(process.pid);
      assert.equal(entry.workspace?.root,fixture.project);assert.equal(entry.sessionId,fixture.sessionId);assert.equal(entrySession.id,fixture.sessionId);
      assert.equal(entry.sessionTitle,fixture.title);assert.ok(entry.redoableRunIds.includes(fixture.runId),'Startup must restore redo without runTask or selecting history');
      assert.equal(entry.activeTask.running,false);assert.equal(entry.pendingApprovals.length,0);assert.equal(entry.usageStats.day.requests,2);
      await disk(fixture.before);await direction('redo');await perform('redo');await disk(fixture.after);
      if(phase==='verify'){
        stage='redo and undo after restart, then conflicting redo';
        await perform('undo');await disk(fixture.before);
        const external='EXTERNAL_CONFLICT_'+fixture.nonce+'\n';await fs.writeFile(path.join(fixture.project,'edit.txt'),external);
        await perform('redo','failed');await disk({...fixture.before,'edit.txt':external});
        // Model an explicit user repair after proving that no file was touched.
        await fs.writeFile(path.join(fixture.project,'edit.txt'),fixture.before['edit.txt']);await direction('redo');
      }else assert.ok((await state()).undoableRunIds.includes(fixture.runId));
      await protectedLedger();await fs.writeFile(marker,JSON.stringify(fixture,null,2));
    }
    assert.equal((await state()).usageStats.day.requests,2,'Undo/redo/restart must not invoke a model');
    assert.equal((await state()).terminalEvents.length,0);
    assert.equal(store.usage.records.reduce((sum,record)=>sum+record.inputTokens+record.outputTokens,0),20);
    win.webContents.invalidate();await wait(150);const screenshot='persistent-undo-'+phase+'.png';await fs.writeFile(path.join(output,screenshot),(await win.webContents.capturePage()).toPNG());
    return{status:'completed',phase,realExternalApi:false,realCommands:false,actualWorkspaceWrites:true,nativeUndoAndRedo:true,
      restoredSessionWithoutModelRequest:phase!=='prepare',newFileDeleteAndRestore:true,emptyFilePreserved:true,
      encryptedLedger:true,conflictPreflight:phase==='verify',threeProcessPids:fixture.pids,
      redoDirectionSurvivesRestart:phase==='verify-again',modelRequests:2,screenshot};
  }catch(error){
    await fs.writeFile(path.join(output,'persistent-undo-failure.json'),JSON.stringify({stage,phase,error:error.message,stack:error.stack,fixture,problems,state:await state().catch(()=>null)},null,2));throw error;
  }finally{
    if(server){const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
    if(configured){
      const previous=original.settings.providers.openai;await call('saveSettings',{provider:'openai',model:previous.model,baseUrl:previous.baseUrl,apiProtocol:previous.apiProtocol,authMode:previous.authMode,reasoningEffort:previous.reasoningEffort,clearKey:true});
      const selected=original.settings.providers[original.settings.provider];await call('saveSettings',{provider:original.settings.provider,model:original.settings.model,baseUrl:selected.baseUrl,apiProtocol:selected.apiProtocol,authMode:selected.authMode,reasoningEffort:original.settings.reasoningEffort});
    }
  }
};
