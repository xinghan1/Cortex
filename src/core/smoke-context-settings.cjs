// Native preference controls and real local persistence in disposable windows.
// Footer metrics below are public display fixtures; no model or command runs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { BrowserWindow } = require('electron');
const { UIPreferences } = require('./ui-preferences.cjs');
const { ModelCapacityPreferences, modelCapacityConnectionKey } = require('./model-capacity-preferences.cjs');

module.exports = async function smokeContextSettings({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const project = path.join(dataDir, 'context-settings-' + randomUUID());
  const preferenceFile = path.join(dataDir, 'model-capacities.json');
  const model = 'capacity-' + randomUUID(), knownModel = model + '-known', apiKey = 'capacity-fixture-key', problems = [], requests = [];
  let child, other, baseUrl, original, configured = false, stage = 'initialize capacity fixture';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const call = (method, value, target = child) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`, target);
  const state = (target = child) => call('getState', undefined, target);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Context-settings smoke timed out: ' + label);
  };
  const inspect = (target = child) => js(`(() => {
    const trigger=$('session-context-trigger'),popup=$('context-settings-popup'),input=$('context-trigger-input'),ring=$('session-context');
    const r=popup?.getBoundingClientRect();
    return {trigger:!!trigger,buttonTag:trigger?.tagName,expanded:trigger?.getAttribute('aria-expanded'),
      popupHidden:popup?.hidden,input:input?.value,min:input?.min,max:input?.max,step:input?.step,
      source:$('context-capacity-source')?.textContent,error:$('context-trigger-error')?.textContent,errorHidden:$('context-trigger-error')?.hidden,
      effectiveHintPresent:!!$('context-effective-hint'),presetElements:popup?.querySelectorAll('.context-trigger-presets,[data-context-trigger]').length||0,
      saveDisabled:$('context-trigger-save')?.disabled,
      ringInsideTrigger:!!trigger?.contains(ring),rings:document.querySelectorAll('#session-context').length,
      role:ring?.getAttribute('role'),percent:$('session-context-value')?.textContent,
      ariaNow:ring?.getAttribute('aria-valuenow'),ariaText:ring?.getAttribute('aria-valuetext'),
      dash:$('session-context-progress')?.getAttribute('stroke-dasharray'),title:ring?.title,
      rounds:$('session-rounds')?.textContent,total:$('session-total-value')?.textContent,
      cache:$('session-cache-value')?.textContent,speed:$('generation-speed')?.textContent,
      geometry:r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      nativeInputs:window.__contextSettingsInputs||[]};
  })()`, target);
  const click = async selector => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing native context control '+${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest',behavior:'instant'});if(!node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true}))throw new Error('Hidden native context control '+${JSON.stringify(selector)});
      const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered native context control '+${JSON.stringify(selector)});return p;})()`);
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(50);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') child.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(35);
  };
  const open = async () => {
    if ((await inspect()).popupHidden) await click('#session-context-trigger');
    await until('context popup opens', async () => !(await inspect()).popupHidden);
    await until('context popup enter transition settles', () => js(`Number(getComputedStyle($('context-settings-popup')).opacity)>=.99`));
  };
  const enter = async value => {
    await open(); await click('#context-trigger-input'); await key('a', ['control']);
    await child.webContents.insertText(String(value));
    await until('native input ' + value, async () => (await inspect()).input === String(value));
  };
  const set = async value => {
    await enter(value); await click('#context-trigger-save');
    await until('capacity saved ' + value, async () => (await state()).modelCapacity.manualTokens === value);
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { child.webContents.invalidate(); await wait(attempt * 200); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(output, filename), image.toPNG()); return; }
      catch (error) { if (attempt === 4 || !/UnknownVizError/.test(String(error))) throw error; }
    }
  };
  const assertPlacement = value => {
    assert.ok(value.geometry && value.geometry.width > 0 && value.geometry.height > 0);
    assert.ok(value.geometry.left >= 0 && value.geometry.right <= value.viewport.width + 1, 'Context popover must fit horizontally');
    assert.ok(value.geometry.top >= 0 && value.geometry.bottom <= value.viewport.height + 1, 'Context popover must fit vertically');
    assert.equal(value.horizontalOverflow, false);
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if(request.method==='GET' && request.url==='/v1/models') { response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:model},{id:knownModel,context_window:128000}]}));return; }
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/responses');
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<200000);}
      const body=JSON.parse(raw);assert.equal(body.model,model);const completion=!body.tools?.length;requests.push({completion});
      response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:completion?JSON.stringify({continuation:'请补充测试。'}):'CAPACITY_FIXTURE_COMPLETE'}]}],usage:{input_tokens:completion?0:12000,output_tokens:0}}})+'\n\n');
    }catch(error){problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500);response.end('{}');}}
  });
  const select=async(id,target=child)=>{
    await call('saveSettings',{provider:'relay',authMode:'apiKey',apiProtocol:'responses',baseUrl,apiKey,model:id,reasoningEffort:'default'},target);
    await call('listModels',{force:true},target);
    await until('model selected',async()=>(await state(target)).modelCapacity?.model===id&&await js(`appState?.modelCapacity?.model===${JSON.stringify(id)}`,target));
  };
  try {
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(project,'README.md'),'Disposable capacity fixture.\n');
    original=await state(win);assert.equal(original.settings.providers.relay.hasKey,false,'Refusing to overwrite a configured relay key');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
    child=BrowserWindow.fromId((await call('newWindow',undefined,win)).id);assert.ok(child&&child.webContents.isOffscreen());
    await until('capacity controls',()=>js(`Boolean(appState&&window.forge.setModelCapacity&&!projectSwitching)`));
    child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);await until('fixture project',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    configured=true;await select(model);const originalScale=(await state()).textScale;
    await js(`window.__contextSettingsInputs=[];$('context-trigger-input').addEventListener('input',event=>window.__contextSettingsInputs.push({trusted:event.isTrusted,value:event.target.value}));true`);
    stage='unknown capacity is blank';await open();let value=await inspect();assertPlacement(value);assert.equal(value.input,'');assert.equal(value.source,'来源：未提供');assert.equal(value.min,'1000');assert.equal(value.max,'16000000');
    assert.equal(value.rings,1);assert.equal(value.ringInsideTrigger,true);assert.equal(value.role,'progressbar');
    stage='manual persistence';await set(400000);const saved=await state(),scope=saved.modelCapacity.scope;
    assert.equal(saved.modelCapacity.capacityTokens,400000);assert.equal(saved.modelCapacity.compressionTriggerTokens,320000);assert.equal(saved.modelCapacity.source,'manual');
    const connection=modelCapacityConnectionKey({provider:'relay',authMode:'apiKey',config:saved.settings.providers.relay},apiKey);
    assert.equal((await new ModelCapacityPreferences(dataDir).init()).get(connection,model),400000);
    assert.ok(JSON.parse(await fs.readFile(preferenceFile,'utf8')).capacities.some(row=>row[0]===scope&&row[1]===400000));
    assert.equal((await new UIPreferences(dataDir).init()).textScale,originalScale);assert.ok((await inspect()).nativeInputs.some(item=>item.trusted&&item.value==='400000'));
    other=BrowserWindow.fromId((await call('newWindow')).id);await until('other window',()=>js('Boolean(appState&&window.forge.setModelCapacity)',other));await select(model,other);assert.equal((await state(other)).modelCapacity.manualTokens,400000);
    stage='actual backend context ring';await call('runTask',{text:'CAPACITY_LOCAL_FIXTURE'});
    await until('local fixture task',async()=>(await state()).sessionMetrics?.contextUsedTokens===12000&&!(await state()).activeTask.running);
    await until('400k ring',async()=>(await inspect()).percent==='3%');await set(64000);
    await until('64k ring',async()=>(await inspect()).percent==='18.8%'&&(await state(other)).modelCapacity.manualTokens===64000);
    value=await inspect();assert.equal(value.ariaNow,'18.8');assert.equal(value.dash,'18.8 100');assert.match(value.title,/64,000/);assert.equal(requests.filter(item=>!item.completion).length,1);
    await open();await capture('context-settings-custom-capacity.png');
    stage='invalid input and reload';const before=await fs.readFile(preferenceFile,'utf8');await enter(100);await click('#context-trigger-save');await until('range error',async()=>!(await inspect()).errorHidden);assert.equal(await fs.readFile(preferenceFile,'utf8'),before);
    child.webContents.reload();await wait(50);await until('reloaded controls',()=>js('Boolean(appState?.modelCapacity&&window.forge.setModelCapacity&&!projectSwitching)'));await open();assert.equal((await inspect()).input,'64000');assertPlacement(await inspect());
    assert.equal((await new ModelCapacityPreferences(dataDir).init()).get(connection,model),64000);
    stage='model switch and directory ceiling';await enter(65000);await select(knownModel);await until('dirty draft closed',async()=>(await inspect()).popupHidden);await open();value=await inspect();assert.equal(value.input,'128000');assert.equal(value.max,'128000');assert.equal(value.source,'来源：模型目录');
    await enter(128001);await click('#context-trigger-save');await until('directory ceiling error',async()=>!(await inspect()).errorHidden&&/128,000/.test((await inspect()).error));assert.equal((await state()).modelCapacity.manualTokens,null);
    await set(64000);await open();await click('#context-trigger-reset');await until('directory reset',async()=>(await state()).modelCapacity.manualTokens===null&&(await state()).modelCapacity.capacityTokens===128000);await open();assert.equal((await inspect()).input,'128000');await capture('context-settings-directory-restored.png');
    stage='unknown reset';await select(model);await open();assert.equal((await inspect()).input,'64000');await click('#context-trigger-reset');await until('unknown reset saved',async()=>(await state()).modelCapacity.capacityTokens===null&&(await state()).modelCapacity.manualTokens===null);await open();assert.equal((await inspect()).input,'');assert.equal((await inspect()).source,'来源：未提供');assert.equal((await new ModelCapacityPreferences(dataDir).init()).get(connection,model),null);await capture('context-settings-unknown-restored.png');
    stage='dismiss and compact viewport';await key('Escape');await until('Escape closes',async()=>(await inspect()).popupHidden);child.setContentSize(1100,760);await wait(100);await open();assertPlacement(await inspect());await click('#task-input');await until('outside closes',async()=>(await inspect()).popupHidden);assert.deepEqual(problems,[]);
    const result={status:'completed',realApi:false,realCommands:false,localFixtureModelOnly:true,nativeNumericInputAndSave:true,unknownCapacityBlank:true,persistentFreshStoreRoundTrip:true,rendererReloadRestoresSavedValue:true,crossWindowSameScopeSync:true,exactModelAndConnectionScope:true,switchDiscardsDirtyDraft:true,knownDirectoryMaximumEnforced:true,resetRestoresDirectoryOrUnknown:true,actualContextRingRecalculated:{usedTokens:12000,beforeCapacity:400000,beforePercent:3,afterCapacity:64000,afterPercent:18.8},existingTextScalePreserved:true,nativeEscapeAndOutsideDismiss:true,compactPopoverFitsViewport:true,screenshots:['context-settings-custom-capacity.png','context-settings-directory-restored.png','context-settings-unknown-restored.png']};
    await fs.writeFile(path.join(output,'context-settings-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  }catch(error){const failure={status:'failed',stage,error:error.message,stack:error.stack,requests,problems};if(child&&!child.isDestroyed()){try{failure.ui=await inspect();failure.state=await state();await capture('context-settings-failure.png');}catch(diagnostic){failure.diagnosticError=diagnostic.message;}}await fs.writeFile(path.join(output,'context-settings-smoke-result.json'),JSON.stringify(failure,null,2)+'\n');throw new Error('Context-settings smoke failed at '+stage+': '+error.message,{cause:error});
  }finally{
    const target=child&&!child.isDestroyed()?child:win;
    if(configured&&!target.isDestroyed()){
      for(const selectedModel of[model,knownModel]){await call('saveSettings',{provider:'relay',authMode:'apiKey',apiProtocol:'responses',baseUrl,apiKey,model:selectedModel,reasoningEffort:'default'},target).catch(()=>{});const current=await state(target).catch(()=>null);if(current?.modelCapacity?.scope)await call('setModelCapacity',{scope:current.modelCapacity.scope,capacityTokens:null},target).catch(()=>{});}
      const previous=original.settings.providers.relay;await call('saveSettings',{provider:'relay',model:previous.model,baseUrl:previous.baseUrl||baseUrl,apiProtocol:previous.apiProtocol,reasoningEffort:previous.reasoningEffort,clearKey:true},target).catch(()=>{});
      const selected=original.settings.providers[original.settings.provider];await call('saveSettings',{provider:original.settings.provider,model:original.settings.model,baseUrl:selected.baseUrl||(original.settings.provider==='relay'?baseUrl:undefined),authMode:selected.authMode,apiProtocol:selected.apiProtocol,reasoningEffort:original.settings.reasoningEffort},target).catch(()=>{});
    }
    for(const targetWindow of[child,other])if(targetWindow&&!targetWindow.isDestroyed()){targetWindow.close();await until('window closes',()=>targetWindow.isDestroyed()).catch(()=>targetWindow.destroy());}
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
};
