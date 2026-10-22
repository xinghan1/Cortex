// Actual Responses -> BrowserPanel XML source reads on one loopback fixture.
// No XML parser, external site, account, command, or user project is involved.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const {BrowserWindow}=require('electron');

module.exports=async function smokeXmlReading({win,output,dataDir,store}){
  assert.equal(win.webContents.isOffscreen(),true);
  const nonce=randomUUID(),project=path.join(dataDir,'xml-reading-'+nonce),model='xml-reading-fixture',key='xml-fixture-key-'+nonce;
  const prompt='XML_SOURCE_READING_'+nonce,requests=[],httpRequests=[],problems=[];
  let child,configured=false,xml='',xmlURL='',stage='isolated XML fixture setup';
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,check)=>{const end=Date.now()+15000;while(Date.now()<end){const value=await check();if(value)return value;await wait(20);}throw new Error('XML smoke timed out: '+label+(problems.length?'; '+problems.join(' | '):''));};
  const js=code=>child.webContents.executeJavaScript(code),invoke=(name,value)=>`window.forge[${JSON.stringify(name)}](${value===undefined?'':JSON.stringify(value)})`;
  const call=(name,value)=>js(invoke(name,value)),parentCall=(name,value)=>win.webContents.executeJavaScript(invoke(name,value));
  const original=await parentCall('getState');assert.equal(original.settings.providers.openai.hasKey,false,'Refusing to replace a configured credential');
  const state=()=>call('getState'),events=()=>js('window.__xmlSmoke.events');
  const browserSnapshot=async()=>{const s=await state();return {exists:s.browser.exists,visible:s.browser.visible,url:s.browser.url,title:s.browser.title,previewHidden:await js(`$('preview-panel').hidden`),browserTabActive:await js(`$('browser-preview-tab').classList.contains('active')`)};};
  const click=async selector=>{
    const p=await until('native XML control '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility())return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+Math.min(100,r.width/2)),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    child.focus();child.webContents.focus();child.webContents.sendInputEvent({type:'mouseMove',...p});child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(35);
  };
  const reply=(response,output)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({id:'xml-response-'+requests.length,status:'completed',output,usage:{input_tokens:7,output_tokens:3}}));};
  const tool=(id,name,args)=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
  const outputFor=(body,id)=>JSON.parse(body.input.find(item=>item.type==='function_call_output'&&item.call_id===id)?.output||'null');
  const server=http.createServer(async(request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');httpRequests.push({path:url.pathname,method:request.method});
    try{
      if(url.pathname==='/metadata.xml'){
        assert.equal(request.method,'GET');assert.equal(request.headers.authorization,undefined);assert.equal(request.headers.cookie,undefined);
        response.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Content-Length':Buffer.byteLength(xml)});response.end(xml);return;
      }
      if(['/script-hit','/external-entity','/stylesheet-hit'].includes(url.pathname)){response.writeHead(200,{'Content-Type':'text/plain'});response.end('MUST_NOT_BE_REQUESTED');return;}
      assert.equal(request.headers.authorization,'Bearer '+key);
      if(url.pathname==='/v1/models'){assert.equal(request.method,'GET');response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:model,supportsTools:true,reasoningEfforts:[],context_window:128000}]}));return;}
      assert.equal(request.method,'POST');assert.equal(url.pathname,'/v1/responses');
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<500000);}
      const body=JSON.parse(raw);assert.equal(body.model,model);assert.ok(JSON.stringify(body.input.filter(item=>item.role==='user')).includes(prompt));
      const turn=requests.length+1;requests.push({turn,body});
      assert.ok((body.tools||[]).some(item=>item.name==='read_url'),'The real model must receive the XML paging tool');
      if(turn===1){reply(response,[tool('xml-first','browser_navigate',{url:xmlURL})]);return;}
      const first=outputFor(body,'xml-first');
      assert.equal(first.format,'xml');assert.equal(first.browserOpened,false);assert.equal(first.url,xmlURL);assert.equal(first.filename,'metadata.xml');
      assert.equal(first.offset,0);assert.equal(first.nextOffset,24000);assert.equal(first.totalCharacters,xml.length);assert.equal(first.bytes,Buffer.byteLength(xml));assert.equal(first.truncated,true);
      assert.equal(first.content,xml.slice(0,24000),'The first model replay must preserve the raw source text');
      assert.ok(first.content.includes('<!ENTITY external SYSTEM')&&first.content.includes('<script')&&first.content.includes('&external;'),'Script/entity syntax must remain literal text');
      if(turn===2){reply(response,[tool('xml-page','read_url',{url:xmlURL,offset:first.nextOffset,limit:317})]);return;}
      assert.equal(turn,3,'Only navigation, one XML page, and a final answer are expected');
      const second=outputFor(body,'xml-page');assert.equal(second.format,'xml');assert.equal(second.browserOpened,false);assert.equal(second.offset,24000);assert.equal(second.nextOffset,24317);assert.equal(second.truncated,true);assert.equal(second.content,xml.slice(24000,24317));
      reply(response,[{type:'message',role:'assistant',content:[{type:'output_text',text:'XML_READING_COMPLETED_'+nonce}]}]);
    }catch(error){problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}}
  });
  const approveRead=async()=>{
    const request=await until('XML read approval',async()=>(await state()).pendingApprovals.find(item=>item.kind==='browser'&&item.url===xmlURL));
    assert.equal(request.title,'读取 XML 文件');await click('#composer-approval .approval-accept');
    await until('XML approval resolved',async()=>!(await state()).pendingApprovals.some(item=>item.id===request.id));
  };
  try{
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(project,'README.txt'),'Isolated XML read fixture.\n');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin='http://127.0.0.1:'+server.address().port;xmlURL=origin+'/metadata.xml';
    xml=`<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="${origin}/stylesheet-hit"?>\n<!DOCTYPE metadata [<!ENTITY external SYSTEM "${origin}/external-entity">]>\n<metadata><script xmlns="http://www.w3.org/1999/xhtml">window.__xmlFixtureExecuted=true;fetch('${origin}/script-hit')</script><literal>&external;</literal>\n`+
      Array.from({length:950},(_,i)=>`<version index="${i}">XML_SOURCE_${String(i).padStart(4,'0')}_保留原始文本而不执行</version>`).join('\n')+'\n</metadata>\n';
    assert.ok(xml.length>25000&&Buffer.byteLength(xml)<1024*1024);
    child=BrowserWindow.fromId((await parentCall('newWindow')).id);assert.ok(child&&child!==win&&child.webContents.isOffscreen());
    child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.focus();child.webContents.focus();
    await until('XML renderer initialized',()=>js('Boolean(appState&&window.ForgeToolOperationGroups&&!projectSwitching)'));
    await js(`window.__xmlSmoke={events:[],trustedApprovals:0};window.__xmlSmoke.off=window.forge.onEvent(event=>window.__xmlSmoke.events.push(event));document.addEventListener('click',event=>{if(event.isTrusted&&event.target.closest('#composer-approval .approval-accept'))window.__xmlSmoke.trustedApprovals++;},true);true`);
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);await until('XML project active',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    await call('saveSettings',{provider:'openai',authMode:'apiKey',apiProtocol:'responses',baseUrl:origin+'/v1',apiKey:key,model,reasoningEffort:'default'});configured=true;
    await call('setPermissionMode',{mode:'request'});const baseline=await browserSnapshot(),sessionId=(await state()).sessionId,ledgerStart=store.usage.records.length;
    assert.equal(baseline.exists,false);assert.equal(baseline.visible,false);assert.equal(baseline.url,'');
    stage='real browser_navigate XML source then explicit read_url page';
    await call('submitPrompt',{text:prompt,mode:'queue'});await approveRead();await until('first XML result replayed',()=>requests.length>=2);await approveRead();
    const ended=await until('XML task completed',async()=>{const end=(await events()).find(event=>event.type==='run-end');return end&&!(await state()).activeTask.running&&end;});assert.equal(ended.status,'completed',ended.error);
    assert.equal(requests.length,3);assert.deepEqual(problems,[]);assert.equal(await js('window.__xmlSmoke.trustedApprovals'),2);
    assert.deepEqual(await browserSnapshot(),baseline,'Reading XML must not create, navigate, show, or activate the browser');
    assert.equal((await events()).filter(event=>event.type==='browser-open').length,0);assert.equal(await js('typeof window.__xmlFixtureExecuted'),'undefined');
    assert.equal(httpRequests.filter(item=>item.path==='/metadata.xml').length,2);assert.equal(httpRequests.filter(item=>['/script-hit','/external-entity','/stylesheet-hit'].includes(item.path)).length,0);
    const results=(await events()).filter(event=>event.type==='tool-result');assert.deepEqual(results.map(event=>event.name),['browser_navigate','read_url']);assert.equal(JSON.parse(results[0].result).content,xml.slice(0,24000));assert.equal(JSON.parse(results[1].result).content,xml.slice(24000,24317));

    stage='native file-read grouping and source details';
    const runSelector='.task-activity[data-run-id='+JSON.stringify(ended.runId)+']';
    await click(runSelector+' > summary');await until('activity fully opened',()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(runSelector)});return n.open&&!n.getAnimations({subtree:true}).some(a=>a.playState==='running');})()`));
    const groupSelector=runSelector+' .tool-operation-group';
    const group=await until('consecutive XML reads grouped',()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(groupSelector)});return n&&{open:n.open,count:n.dataset.count,operation:n.dataset.operation,cards:n.querySelectorAll('.tool-card').length};})()`));
    assert.deepEqual(group,{open:false,count:'2',operation:'read_file',cards:2});
    await click(groupSelector+' > summary');await until('XML group fully opened',()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(groupSelector)});return n.open&&!n.getAnimations({subtree:true}).some(a=>a.playState==='running');})()`));
    const cards=await js(`[...document.querySelectorAll(${JSON.stringify(groupSelector+' .tool-card')})].map(n=>({title:n.querySelector('.tool-title').textContent,icon:n.querySelector('.tool-mark path')?.getAttribute('d')}))`);
    assert.equal(cards.length,2);for(const card of cards){assert.match(card.title,/^已读取文件/u);assert.match(card.icon,/^M14 3H5/u);}
    await click(groupSelector+' .tool-card > summary');
    assert.ok(await js(`document.querySelector(${JSON.stringify(groupSelector+' .tool-card')}).textContent.includes('XML_SOURCE_0000')`));
    child.webContents.invalidate();await wait(180);await fs.writeFile(path.join(output,'xml-source-read-group.png'),(await child.webContents.capturePage()).toPNG());
    await until('XML request ledger committed',()=>store.usage.records.slice(ledgerStart).filter(item=>item.sessionId===sessionId).length===3);
    const ledger=store.usage.records.slice(ledgerStart).filter(item=>item.sessionId===sessionId);assert.equal(new Set(ledger.map(item=>item.id)).size,3);assert.equal(ledger.reduce((sum,item)=>sum+item.inputTokens+item.outputTokens,0),30);
    assert.deepEqual(await browserSnapshot(),baseline);assert.deepEqual(problems,[]);
    return{status:'completed',realExternalApi:false,realCommands:false,modelRequests:3,xmlSourceRequests:2,rawXmlPreserved:true,explicitXmlPaging:true,scriptEntityAndStylesheetRequests:0,noBrowserOpenEvents:true,browserStateUnchanged:true,nativeReadApprovals:true,nativeReadGroup:true,fileIconsAndTitles:true,exactUsage:true,screenshot:'xml-source-read-group.png'};
  }catch(error){await fs.writeFile(path.join(output,'xml-reading-failure.json'),JSON.stringify({stage,error:error.message,stack:error.stack,problems,httpRequests,requests:requests.map(({turn})=>({turn})),state:child&&!child.isDestroyed()?await state().catch(()=>null):null},null,2));throw error;}
  finally{
    if(child&&!child.isDestroyed()){await call('stopTask').catch(()=>{});child.close();await until('XML child closed',()=>child.isDestroyed()).catch(()=>child.destroy());}
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
    if(configured&&!win.isDestroyed()){const previous=original.settings.providers.openai;await parentCall('saveSettings',{provider:'openai',model:previous.model,baseUrl:previous.baseUrl,authMode:previous.authMode,apiProtocol:previous.apiProtocol,reasoningEffort:previous.reasoningEffort,clearKey:true});const selected=original.settings.providers[original.settings.provider];await parentCall('saveSettings',{provider:original.settings.provider,model:original.settings.model,baseUrl:selected.baseUrl,authMode:selected.authMode,apiProtocol:selected.apiProtocol,reasoningEffort:original.settings.reasoningEffort});}
  }
};
