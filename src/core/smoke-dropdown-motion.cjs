// Native interaction with shipped dropdowns. Only model catalog GETs reach a
// disposable loopback fixture; no inference, account or command is used.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const {BrowserWindow}=require('electron');

module.exports=async function smokeDropdownMotion({win,output,dataDir}){
  assert.equal(win.webContents.isOffscreen(),true);
  const nonce=randomUUID(),project=path.join(dataDir,'dropdown-'+nonce),models=['a-dropdown','b-dropdown'],apiKey='dropdown-fixture-key';
  let child,configured=false,debuggerAttached=false,stage='isolated dropdown fixture';
  const problems=[],catalogRequests=[],motionEvidence=[];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,check)=>{const end=Date.now()+15000;while(Date.now()<end){const value=await check();if(value)return value;await wait(20);}throw new Error('Dropdown smoke timed out: '+label+(problems.length?'; '+problems.join(' | '):''));};
  const js=code=>child.webContents.executeJavaScript(code),invoke=(name,value)=>`window.forge[${JSON.stringify(name)}](${value===undefined?'':JSON.stringify(value)})`;
  const call=(name,value)=>js(invoke(name,value)),parentCall=(name,value)=>win.webContents.executeJavaScript(invoke(name,value));
  const original=await parentCall('getState');assert.equal(original.settings.providers.openai.hasKey,false);
  const popup=id=>'.dropdown-select-popup[data-select-id='+JSON.stringify(id)+']';
  const point=async selector=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`);
  const click=async(selector,settle=35)=>{
    await until('visible enabled '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&n.checkVisibility({visibilityProperty:true,opacityProperty:true});})()`));
    const p=await until('revealed pointer target '+selector,()=>point(selector));child.focus();child.webContents.focus();child.webContents.sendInputEvent({type:'mouseMove',...p});
    child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(settle);
  };
  const key=async(keyCode,modifiers=[])=>{child.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});child.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await wait(30);};
  const type=async(id,value)=>{await click('#'+id);await key('a',['control']);await child.webContents.insertText(value);};
  const outside=async()=>{const p={x:1400,y:300};child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(35);};
  const revealSampler=`n=>{const rect=n.getBoundingClientRect(),style=getComputedStyle(n),clip=style.clipPath;let top=0,bottom=0;if(clip.startsWith('inset(')){const parts=clip.slice(6).split('round')[0].replace(/\\)/g,'').trim().split(/\\s+/).map(parseFloat);top=parts[0]||0;bottom=parts[2]??top;}return {height:rect.height,revealed:Math.max(0,rect.height-top-bottom),clip,opacity:style.opacity,direction:n.dataset.dropdownDirection,transform:style.transform};}`;
  const motion=async(selector,label)=>{
    const value=await until('actual animated surface '+label,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.hidden||!n.checkVisibility())return null;const animations=n.getAnimations().map(a=>({duration:a.effect.getTiming().duration,state:a.playState,frames:a.effect.getKeyframes().map(f=>({clipPath:f.clipPath,transform:f.transform}))}));return animations.some(a=>a.duration>0)?{animations,direction:n.dataset.dropdownDirection}:null;})()`));
    assert.ok(value.animations.some(a=>a.frames.some(f=>f.clipPath?.startsWith('inset('))),'The dropdown must animate its revealed height using clipPath');
    assert.ok(['up','down'].includes(value.direction),'Dropdown reveal direction must be explicit');
    const samples=await js(`new Promise(resolve=>{const n=document.querySelector(${JSON.stringify(selector)}),sample=${revealSampler},values=[],started=performance.now();const frame=()=>{values.push(sample(n));if(n.getAnimations().some(a=>a.playState==='running')&&performance.now()-started<700)setTimeout(frame,12);else resolve(values);};frame();})`);
    const middle=samples.filter(s=>s.revealed>1.25&&s.revealed<s.height-.25);
    assert.ok(middle.length>=2,'Dropdown '+label+' must pass through multiple partially revealed heights: '+JSON.stringify(samples));
    assert.ok(middle.at(-1).revealed>middle[0].revealed+3,'Opening dropdown '+label+' must visibly lengthen');
    for(let i=1;i<samples.length;i++)assert.ok(samples[i].revealed>=samples[i-1].revealed-1,'Opening reveal must progress in one direction');
    const last=samples.at(-1);assert.ok(last.revealed>=last.height-1);assert.equal(last.opacity,'1');
    assert.ok(samples.every(s=>s.transform==='none'),'Reveal must preserve text size and avoid translated whole-surface motion');
    motionEvidence.push({label,...value,intermediateHeightFrames:middle.length,startRevealed:samples[0].revealed,endRevealed:last.revealed,height:last.height});
  };
  const ghosts=async()=>{
    const value=await js(`[...document.querySelectorAll('[data-dropdown-ghost="true"]')].map(n=>({inert:n.inert,hidden:n.getAttribute('aria-hidden'),pointer:getComputedStyle(n).pointerEvents,ids:n.querySelectorAll('[id]').length+(n.id?1:0),names:n.querySelectorAll('[name]').length}))`);
    assert.ok(value.length,'An exit ghost must keep the closing transition visible');
    for(const item of value){assert.equal(item.inert,true);assert.equal(item.hidden,'true');assert.equal(item.pointer,'none');assert.equal(item.ids,0);assert.equal(item.names,0);}
    const closing=await js(`new Promise(resolve=>{const sample=${revealSampler},tracks=new Map(),started=performance.now();const frame=()=>{for(const n of document.querySelectorAll('[data-dropdown-ghost="true"]')){if(!tracks.has(n))tracks.set(n,[]);tracks.get(n).push(sample(n));}if(document.querySelector('[data-dropdown-ghost="true"]')&&performance.now()-started<700)setTimeout(frame,12);else resolve([...tracks.values()]);};frame();})`);
    const progressive=closing.filter(samples=>{const middle=samples.filter(s=>s.revealed>1.25&&s.revealed<s.height-.25);return middle.length>=2&&middle[0].revealed>middle.at(-1).revealed+3;});
    assert.ok(progressive.length,'Closing dropdown must progressively shorten its revealed height: '+JSON.stringify(closing));
    for(const samples of progressive)for(let i=1;i<samples.length;i++)assert.ok(samples[i].revealed<=samples[i-1].revealed+1,'Closing reveal must progress in one direction: '+JSON.stringify(samples));
    assert.equal(await js(`document.querySelectorAll('[data-dropdown-ghost="true"]').length`),0);
  };
  const openSelect=async id=>{await click('#'+id);await motion(popup(id),id);assert.equal(await js(`document.activeElement===$(${JSON.stringify(id)})`),true);};
  const choose=async(id,value)=>{await openSelect(id);await click(popup(id)+' .dropdown-select-option[data-value='+JSON.stringify(value)+']:not([aria-disabled="true"])');await until('committed '+id,()=>js(`$(${JSON.stringify(id)}).value===${JSON.stringify(value)}&&!document.querySelector(${JSON.stringify(popup(id))})`));};
  const server=http.createServer((request,response)=>{
    try{assert.equal(request.method,'GET');assert.equal(request.url,'/v1/models');assert.equal(request.headers.authorization,'Bearer '+apiKey);catalogRequests.push(request.url);
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:models.map(id=>({id,supportsTools:true,reasoningEfforts:[],context_window:128000}))}));
    }catch(error){problems.push(error.message);response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}
  });
  try{
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(project,'fixture.txt'),'Dropdown local fixture\n');
    const dates=['2026-10-18T00:00:00.000Z','2026-10-20T00:00:00.000Z'],sessions=dates.map((date,index)=>({id:randomUUID(),title:'Dropdown history '+index,customTitle:'Dropdown history '+index,workspace:project,createdAt:date,updatedAt:date,usageLedgerVersion:1,messages:[{role:'user',content:'HISTORY_'+index+'_'+nonce},{role:'assistant',content:'ONLY_LOCAL_HISTORY_'+index}],events:[]}));
    for(const session of sessions)await fs.writeFile(path.join(dataDir,'sessions',session.id+'.json'),JSON.stringify(session));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    child=BrowserWindow.fromId((await parentCall('newWindow')).id);assert.ok(child&&child!==win&&child.webContents.isOffscreen());
    await until('enhancement module initialized',()=>js('Boolean(appState&&window.ForgeDropdownMotion&&!projectSwitching)'));
    child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.focus();child.webContents.focus();
    await js(`window.__dropdownSmoke={events:[]};document.addEventListener('input',e=>{if(e.target.tagName==='SELECT')window.__dropdownSmoke.events.push({id:e.target.id,type:'input',value:e.target.value});});document.addEventListener('change',e=>{if(e.target.tagName==='SELECT')window.__dropdownSmoke.events.push({id:e.target.id,type:'change',value:e.target.value});});true`);
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);await until('project and latest session ready',async()=>(await call('getState')).sessionId===sessions[1].id&&await js('!projectSwitching'));

    stage='native provider/auth selects inside a modal dialog';
    await click('#model-reasoning-trigger');await click('#reasoning-open-settings');await until('settings open',()=>js(`$('settings-dialog').open`));
    await choose('provider-select','deepseek');await openSelect('provider-select');
    assert.equal(await js(`document.querySelector(${JSON.stringify(popup('provider-select'))}).closest('dialog').id`),'settings-dialog');
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(popup('provider-select'))}).closest('[inert]')`),false);
    await js(`$('message-scroll').dispatchEvent(new Event('scroll'));true`);
    await wait(30);
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(popup('provider-select'))})&&$('provider-select').getAttribute('aria-expanded')==='true'`),true,'Background conversation scrolling must preserve the unrelated select popup');
    await key('Home');assert.equal(await js(`$('provider-select').value`),'deepseek','Highlighting must not commit until Enter');await key('Enter');
    await until('keyboard committed provider',()=>js(`$('provider-select').value==='openai'`));
    await choose('openai-auth-mode','chatgpt');assert.equal(await js(`$('chatgpt-panel').hidden`),false);
    await choose('openai-auth-mode','apiKey');assert.equal(await js(`$('chatgpt-panel').hidden`),true);
    await openSelect('provider-select');const before=await js(`$('provider-select').value`);await key('End');await key('Escape');
    assert.equal(await js(`$('provider-select').value`),before);await ghosts();
    for(const [code,modifiers,label]of [['Space',[],'Space opens select'],['Down',['alt'],'Alt+ArrowDown opens select']]){
      await js(`$('provider-select').focus();true`);await key(code,modifiers);await motion(popup('provider-select'),label);
      assert.equal(await js(`$('provider-select').value`),before);await key('Escape');
      await until('keyboard cancellation '+label,()=>js(`!document.querySelector(${JSON.stringify(popup('provider-select'))})&&document.activeElement===$('provider-select')`));
      assert.equal(await js(`$('provider-select').value`),before);await ghosts();
    }
    await openSelect('provider-select');await key('d');await key('Enter');await until('typeahead committed DeepSeek',()=>js(`$('provider-select').value==='deepseek'`));
    await choose('provider-select','openai');

    stage='model options, dynamic disabled state and optgroup filtering';
    await type('base-url-input',`http://127.0.0.1:${server.address().port}/v1`);await type('api-key-input',apiKey);
    await click('#settings-model-refresh');await until('draft catalog loaded',()=>js(`!settingsCatalogLoading&&[...$('chatgpt-model-select').options].some(o=>o.value==='b-dropdown')`));
    await choose('chatgpt-model-select',models[0]);
    await openSelect('chatgpt-model-select');
    await js(`$('chatgpt-model-select').options[2].disabled=true;true`);
    await until('disabled option reflected',()=>js(`document.querySelector(${JSON.stringify(popup('chatgpt-model-select')+' [data-value="b-dropdown"]')})?.getAttribute('aria-disabled')==='true'`));
    await key('End');assert.equal(await js(`document.querySelector(${JSON.stringify(popup('chatgpt-model-select')+' [data-active="true"]')}).dataset.value`),models[0]);
    await key('Escape');await js(`$('chatgpt-model-select').options[2].disabled=false;true`);
    await openSelect('chatgpt-model-select');
    await js(`const group=document.createElement('optgroup');group.id='dropdown-smoke-group';group.disabled=true;group.label='Disabled fixture';const option=document.createElement('option');option.value='disabled-fixture';option.textContent='Disabled fixture';group.append(option);$('chatgpt-model-select').append(group);true`);
    await until('dynamic disabled optgroup reflected',()=>js(`document.querySelector(${JSON.stringify(popup('chatgpt-model-select')+' [data-value="disabled-fixture"]')})?.getAttribute('aria-disabled')==='true'`));
    await key('Escape');await js(`$('dropdown-smoke-group')?.remove();true`);
    await openSelect('provider-select');await js(`$('provider-select').disabled=true;true`);
    await until('disabling select closes its popup',()=>js(`!document.querySelector(${JSON.stringify(popup('provider-select'))})`));
    await js(`$('provider-select').disabled=false;true`);
    await choose('chatgpt-model-select',models[1]);await click('#save-settings');configured=true;
    await until('saved model configuration',async()=>(await call('getState')).settings.model===models[1]&&await js(`!$('settings-dialog').open&&!settingsSaving`));

    stage='project/session/model/permission/app menu transitions';
    for(const [trigger,surface]of [['#project-switcher','#project-dropdown'],['#session-menu-button','#session-dropdown'],['#permission-trigger','#permission-popup']]){
      await click(trigger);await motion(surface,surface);await outside();await ghosts();assert.equal(await js(`document.querySelector(${JSON.stringify(surface)}).hidden`),true);
    }
    await click('#session-menu-button');await motion('#session-dropdown','session history again');await click(`#session-dropdown [data-session-id="${sessions[0].id}"]`);
    await until('native history selection retained',async()=>(await call('getState')).sessionId===sessions[0].id);
    await click('#model-reasoning-trigger');await motion('#reasoning-popup','model/reasoning popup');await click('#popup-model-button');await motion('#model-list-panel','model list');

    stage='asynchronous model list growth and shrink while opening';
    await js(`window.__dropdownResizeCatalog=currentCatalog;true`);await click('#model-list-back');await ghosts();
    for(const mode of ['grow','shrink']){
      await js(`(()=>{const source=window.__dropdownResizeCatalog,big={...source,models:[...source.models,...Array.from({length:14},(_,i)=>({...source.models[0],id:'resize-fixture-'+i,displayName:'Resize fixture '+i}))]};window.__dropdownResizeLarge=big;currentCatalog=${mode==='grow'?'source':'big'};true;})()`);
      await click('#popup-model-button',0);
      const resize=await js(`new Promise(resolve=>{const panel=$('model-list-panel'),sample=${revealSampler},frames=[],started=performance.now();let mutation=null;
        setTimeout(()=>{mutation={height:panel.getBoundingClientRect().height,running:panel.getAnimations().some(a=>a.playState==='running')};currentCatalog=${mode==='grow'?'window.__dropdownResizeLarge':'window.__dropdownResizeCatalog'};renderModelList();},25);
        const frame=()=>{frames.push({...sample(panel),changed:!!mutation,shown:!panel.hidden});const running=panel.getAnimations().some(a=>a.playState==='running');if((!mutation||running||performance.now()-started<330)&&performance.now()-started<1200)setTimeout(frame,12);else resolve({mutation,frames,declaredHeight:Number(panel.dataset.dropdownRevealHeight)});};frame();})`);
      assert.equal(resize.mutation.running,true,'Async '+mode+' must happen during a real opening animation');
      assert.ok(resize.frames.every(frame=>frame.shown&&frame.revealed>=.5),'Changing model list height must never clip the entire open surface: '+JSON.stringify(resize));
      const final=resize.frames.at(-1);
      assert.ok(mode==='grow'?final.height>resize.mutation.height+80:final.height<resize.mutation.height-80,'The fixture must really '+mode+' the dropdown height');
      assert.ok(Math.abs(resize.declaredHeight-final.height)<1,'Animation must retarget to the new complete height');
      assert.ok(final.revealed>=final.height-1);assert.equal(final.opacity,'1');
      assert.ok(resize.frames.some(frame=>frame.changed&&frame.revealed<frame.height-2),'Resized dropdown must keep progressively revealing its new height');
      motionEvidence.push({label:'async model list '+mode,direction:final.direction,beforeHeight:resize.mutation.height,finalHeight:final.height,minimumRevealed:Math.min(...resize.frames.map(frame=>frame.revealed)),frames:resize.frames.length});
      await click('#model-list-back');await ghosts();
    }
    await js(`currentCatalog=window.__dropdownResizeCatalog;delete window.__dropdownResizeCatalog;delete window.__dropdownResizeLarge;true`);
    await click('#popup-model-button');await motion('#model-list-panel','model list restored after async resizing');
    await click('#model-list .model-option[data-model="a-dropdown"]');await until('model picker still commits',async()=>(await call('getState')).settings.model===models[0]);await outside();await wait(200);
    await click('#menu-file');await motion('#app-menu-popup','app file menu');
    const hover=await point('#menu-edit');child.webContents.sendInputEvent({type:'mouseMove',...hover});await until('native menu hover switches menu',()=>js(`$('menu-edit').getAttribute('aria-expanded')==='true'`));
    assert.equal(await js(`!$('app-menu-popup').hidden&&$('app-menu-popup').checkVisibility()`),true);await outside();await ghosts();

    stage='reduced motion disables enter and exit animation';
    child.webContents.debugger.attach('1.3');debuggerAttached=true;
    await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await until('reduced motion media applied',()=>js(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
    await click('#project-switcher');await until('project menu visible reduced',()=>js(`!$('project-dropdown').hidden`));
    assert.equal(await js(`$('project-dropdown').getAnimations().length`),0);await outside();assert.equal(await js(`document.querySelectorAll('[data-dropdown-ghost="true"]').length`),0);
    await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await click('#model-reasoning-trigger');await click('#reasoning-open-settings');await openSelect('provider-select');
    assert.ok(await js(`window.__dropdownSmoke.events.some((e,i,all)=>e.type==='input'&&all[i+1]?.type==='change'&&all[i+1].id===e.id&&all[i+1].value===e.value)`));
    assert.equal((await call('getState')).usageStats.day.requests,0);assert.ok(catalogRequests.length>0);assert.deepEqual(problems,[]);
    assert.ok(motionEvidence.some(item=>item.direction==='up')&&motionEvidence.some(item=>item.direction==='down'),'Native dropdown fixtures must cover upward and downward height reveals');
    child.webContents.invalidate();await wait(120);await fs.writeFile(path.join(output,'dropdown-modal-options.png'),(await child.webContents.capturePage()).toPNG());
    return{status:'completed',realInference:false,realAccount:false,nativeProviderAuthAndModelChoices:true,originalSelectValueAndEvents:true,
      modalPopoverInteractive:true,unrelatedConversationScrollPreservesPopup:true,keyboardCommitAndEscape:true,spaceAndAltDownOpenWithEscape:true,typeahead:true,dynamicDisabledAndOptgroup:true,
      projectSessionModelPermissionMenus:true,nativeMenuHover:true,progressiveHeightReveal:true,upwardAndDownwardReveal:true,asyncContentHeightRetargeted:true,enterAndExitAnimations:true,inertIdFreeExitGhost:true,reducedMotion:true,
      motionEvidence,screenshot:'dropdown-modal-options.png'};
  }catch(error){await fs.writeFile(path.join(output,'dropdown-motion-failure.json'),JSON.stringify({stage,error:error.message,stack:error.stack,problems,motionEvidence,ui:child&&!child.isDestroyed()?await js(`({active:document.activeElement?.id,popups:[...document.querySelectorAll('.dropdown-select-popup')].map(n=>({id:n.dataset.selectId,text:n.textContent})),notice:$('notice-text')?.textContent})`).catch(()=>null):null},null,2));throw error;}
  finally{
    if(child&&!child.isDestroyed()){if(debuggerAttached)child.webContents.debugger.detach();child.close();await until('dropdown child closed',()=>child.isDestroyed()).catch(()=>child.destroy());}
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
    if(configured){const previous=original.settings.providers.openai;await parentCall('saveSettings',{provider:'openai',model:previous.model,baseUrl:previous.baseUrl,apiProtocol:previous.apiProtocol,authMode:previous.authMode,reasoningEffort:previous.reasoningEffort,clearKey:true});const selected=original.settings.providers[original.settings.provider];await parentCall('saveSettings',{provider:original.settings.provider,model:original.settings.model,baseUrl:selected.baseUrl,apiProtocol:selected.apiProtocol,authMode:selected.authMode,reasoningEffort:original.settings.reasoningEffort});}
  }
};
