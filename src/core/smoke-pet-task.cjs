// Native pet-to-primary handoff, with two isolated keys and loopback-only models.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokePetTask({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), project = path.join(dataDir, 'pet-task-' + nonce);
  const models = { main: 'smoke-pet-primary', pet: 'smoke-pet-refiner' };
  const keys = { main: 'pet-task-primary-' + nonce, pet: 'pet-task-independent-' + nonce };
  const first = '帮我制作一个本地记账程序，不要上传数据。';
  const second = '帮我制作一个离线番茄钟程序，不要联网。';
  const polished = { [first]: '制作一个本地使用的记账程序，账目仅保存在本机，不上传数据。细节不足时先向用户确认。',
    [second]: '制作一个离线运行的番茄钟程序，不连接网络；未明确的功能与技术选择交给主会话确认。' };
  const mainDraft = '原有中央草稿保留 MAIN_DRAFT_' + nonce, hold = 'HOLD_PRIMARY_' + nonce;
  const records = [], problems = [], screenshots = [];
  let child, stage = 'initialize', baseUrl, configured = false, original, originalAppearance, originalPet, held;
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const call = (method, arg, target = child) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`, target);
  const state = () => call('getState');
  const until = async (label, check) => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) { assert.deepEqual(problems, []); const result = await check(); if (result) return result; await wait(30); }
    throw new Error('Pet-task smoke timed out: ' + label);
  };
  const click = async selector => {
    const point = await until('native click ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true}))return null;
      node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return node.contains(document.elementFromPoint(p.x,p.y))?p:null;
    })()`));
    child.webContents.focus(); child.webContents.sendInputEvent({type:'mouseMove',...point});
    child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await wait(70);
  };
  const capture = async filename => {
    await js(`Promise.all(['pet-dialog','pet-dialog-input-bubble'].flatMap(id=>$(id)?.getAnimations()||[]).map(animation=>animation.finished.catch(()=>{}))).then(()=>true)`);
    for(let attempt=1;attempt<=4;attempt++)try{
      child.webContents.invalidate();await wait(attempt*140);const image=await child.webContents.capturePage();assert.equal(image.isEmpty(),false);
      await fs.writeFile(path.join(output,filename),image.toPNG());screenshots.push(filename);return;
    }catch(error){if(attempt===4||!/UnknownVizError/.test(String(error)))throw error;}
  };
  const finish = (record, content) => {
    assert.ok(!record.finished && !record.aborted);record.finished=true;clearInterval(record.heartbeat);
    record.response.write('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}]})+'\n\n');
    record.response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\n');
    record.response.end('data: [DONE]\n\n');
  };
  const server=http.createServer(async(request,response)=>{
    try{
      const source=Object.keys(keys).find(role=>request.headers.authorization==='Bearer '+keys[role]);assert.ok(source,'Only isolated fixture keys may be used');
      if(request.method==='GET'&&request.url==='/v1/models'){
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:Object.entries(models).map(([role,id])=>({id,supportsTools:role==='main',textCompatible:true}))}));return;
      }
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/chat/completions');
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<1000000);}
      const body=JSON.parse(raw);assert.equal(body.model,models[source]);assert.equal(body.stream,true);
      const system=body.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n');
      const user=body.messages.filter(message=>message.role==='user').at(-1)?.content;
      let kind=source==='main'&&body.tools?.length?'primary':system.includes('需求润色助手')?'refinement':system.includes('输入框提示词补全助手')?'completion':'chat';
      const record={source,kind,user,body,response,finished:false,aborted:false};records.push(record);
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});response.write(': isolated pet-task heartbeat\n\n');
      record.heartbeat=setInterval(()=>{if(!response.destroyed&&!record.finished)response.write(': isolated pet-task heartbeat\n\n');},150);
      response.once('close',()=>{clearInterval(record.heartbeat);if(!record.finished&&!response.writableFinished)record.aborted=true;});
      if(kind==='primary'){
        assert.equal(source,'main');
        if(user===hold){held=record;return;}
        const original=[first,second].find(value=>user?.includes(value));assert.ok(original,'Primary may receive only explicit pet tasks or the held main fixture');
        assert.ok(user.includes(polished[original]));assert.match(user,/不扩展授权.*原始需求为准/);
        assert.ok(!raw.includes(mainDraft),'Unsent central draft must never become a model request');
        finish(record,'已收到该需求，本测试只返回文字，不调用文件或命令。');return;
      }
      assert.equal(body.tools?.length||0,0,'Pet model and prompt completion never receive coding tools');
      if(kind==='completion'){finish(record,JSON.stringify({continuation:'请继续验证。'}));return;}
      assert.equal(source,'pet');assert.ok(!raw.includes(mainDraft)&&!raw.includes(hold),'Pet model must not receive primary private history or draft');
      if(kind==='refinement'){
        assert.ok(Object.hasOwn(polished,user));assert.equal(body.messages.length,2,'Refinement contains only its own system and current request');
        await wait(160);finish(record,JSON.stringify({prompt:polished[user]}));return;
      }
      assert.ok(['你好，聊聊今天的天气。','如何制作一个本地记账项目？'].includes(user));
      await wait(120);finish(record,'这次只聊一聊制作方法，不会创建项目或发送中央任务。');
    }catch(error){
      problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}
    }
  });
  const petSend=async text=>{
    const before=records.length;
    if(await js(`$('pet-dialog-input-bubble').hidden`))await click('#pet-overlay-hit');
    await until('pet editor available',()=>js(`!$('pet-dialog-input-bubble').hidden&&!$('pet-dialog-input').disabled`));
    await click('#pet-dialog-input');await child.webContents.insertText(text);await click('#pet-dialog-send');
    return until('one pet request accepted',()=>records.length>before&&records.slice(before).find(record=>record.source==='pet'));
  };
  const mainIdle=()=>until('primary idle',async()=>!(await state()).activeTask.running&&await js('!running&&!promptSubmitting'));
  const petIdle=()=>until('pet idle',async()=>!(await call('getPetDialog')).running);
  try{
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(project,'README.md'),'Disposable native pet task fixture.\n');
    original=await call('getState',undefined,win);originalAppearance=await call('getAppearance',undefined,win);originalPet=await call('petState',undefined,win);
    assert.equal(original.settings.providers.relay.hasKey,false,'Refusing to replace a configured provider key');assert.equal(original.roleModels.pet.enabled,false);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
    child=BrowserWindow.fromId((await call('newWindow',undefined,win)).id);assert.ok(child&&child.webContents.isOffscreen());
    child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.webContents.focus();
    await until('renderer initialized',()=>js('Boolean(appState&&window.synoraPetDialog&&window.synoraPetOverlay&&window.synoraRoleModels&&!projectSwitching)'));
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);await until('project active',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    configured=true;await call('saveSettings',{provider:'relay',apiProtocol:'chat-completions',authMode:'apiKey',baseUrl,apiKey:keys.main,model:models.main,reasoningEffort:'default'});
    await call('listModels',{force:true});await call('setPet',{enabled:true,size:220,x:1,y:1});
    stage='configure independent pet role through the shared validated model selector';
    await js(`window.aiCodeCommands.execute('role-pet-settings')`);await until('pet settings form',()=>js(`$('settings-dialog').open&&settingsRole==='pet'`));
    await js(`(()=>{$('provider-select').value='relay';$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));$('api-protocol-select').value='chat-completions';$('api-protocol-select').dispatchEvent(new Event('change',{bubbles:true}));$('base-url-input').value=${JSON.stringify(baseUrl)};$('api-key-input').value=${JSON.stringify(keys.pet)};for(const id of ['base-url-input','api-key-input'])$(id).dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await click('#settings-model-refresh');await until('pet text-only catalog model',()=>js(`Boolean(settingsCatalog?.models.some(model=>model.id===${JSON.stringify(models.pet)})&&!settingsCatalogLoading)`));
    assert.equal(await js(`Array.from($('chatgpt-model-select').options).find(option=>option.value===${JSON.stringify(models.pet)}).disabled`),false);
    await js(`$('chatgpt-model-select').value=${JSON.stringify(models.pet)};$('chatgpt-model-select').dispatchEvent(new Event('change',{bubbles:true}));true`);
    await click('#save-settings');await until('independent pet saved',async()=>(await state()).roleModels.pet.enabled&&await js(`!$('settings-dialog').open&&!settingsSaving`));
    const configuration=await state();assert.equal(configuration.settings.model,models.main);assert.equal(configuration.roleModels.pet.settings.model,models.pet);
    assert.ok(!JSON.stringify(configuration).includes(keys.main)&&!JSON.stringify(configuration).includes(keys.pet));
    await js(`(()=>{const input=$('task-input');input.value=${JSON.stringify(mainDraft)};input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(2,7);return true})()`);
    const sessionBefore=(await state()).sessionId;

    stage='explicit creation is refined once then automatically sent to primary';
    const firstRequest=await petSend(first);assert.equal(firstRequest.kind,'refinement');await mainIdle();await petIdle();
    await until('first primary task received',()=>records.some(record=>record.kind==='primary'&&record.user.includes(first)&&record.finished));
    let session=await call('getCurrentSession');const firstMessage=session.messages.filter(message=>message.role==='user'&&message.content.includes(first));
    assert.equal(firstMessage.length,1);assert.equal(firstMessage[0].source,'pet');assert.ok(firstMessage[0].content.includes(polished[first]));
    assert.match(firstMessage[0].content,/不要上传数据/);assert.match(firstMessage[0].content,/不扩展授权/);
    assert.equal(await js(`$('task-input').value`),mainDraft);assert.equal((await state()).promptQueue.items.length,0);
    assert.equal(records.filter(record=>record.kind==='refinement'&&record.user===first).length,1);await capture('pet-task-started.png');

    stage='a busy primary queues one independently refined pet task';
    await call('submitPrompt',{text:hold,mode:'queue'});await until('primary held',()=>held&&!held.finished);assert.equal((await state()).activeTask.running,true);
    const secondRequest=await petSend(second);assert.equal(secondRequest.kind,'refinement');
    await until('pet task queued',async()=>{const value=await state();return value.promptQueue.items.length===1&&value.promptQueue.items[0].text.includes(second);});
    await petIdle();assert.equal(records.filter(record=>record.kind==='primary'&&record.user.includes(second)).length,0);
    assert.match((await call('getPetDialog')).messages.at(-1).content,/排队/);
    await until('queued acknowledgement speech visible',()=>js(`!$('pet-dialog').hidden&&$('pet-dialog-question').textContent.includes('排队')`));
    assert.equal(await js(`$('task-input').value`),mainDraft);await capture('pet-task-queued.png');
    finish(held,'主任务已完成，允许队列继续。');held=null;
    await until('queued pet task executes',()=>records.some(record=>record.kind==='primary'&&record.user.includes(second)&&record.finished));await mainIdle();
    assert.equal((await state()).promptQueue.items.length,0);assert.equal(records.filter(record=>record.kind==='primary'&&record.user.includes(second)).length,1);
    assert.equal(records.filter(record=>record.kind==='refinement'&&record.user===second).length,1);

    stage='casual conversation and how-to questions never enter the coding queue';
    const primaryCount=records.filter(record=>record.kind==='primary').length;
    for(const text of ['你好，聊聊今天的天气。','如何制作一个本地记账项目？']){
      const request=await petSend(text);assert.equal(request.kind,'chat');await petIdle();
      assert.equal((await state()).activeTask.running,false);assert.equal((await state()).promptQueue.items.length,0);
      assert.equal(records.filter(record=>record.kind==='primary').length,primaryCount);
    }
    session=await call('getCurrentSession');const secondMessages=session.messages.filter(message=>message.role==='user'&&message.content.includes(second));
    assert.equal(secondMessages.length,1);assert.equal(secondMessages[0].source,'pet');
    assert.equal(session.messages.some(message=>message.role==='user'&&message.content.includes('如何制作一个本地记账项目？')),false);
    assert.equal(await js(`$('task-input').value`),mainDraft);assert.deepEqual(problems,[]);
    const result={status:'completed',realApi:false,realCommands:false,realFileTools:false,localFixtureModelOnly:true,
      independentPetRoleUsesOwnModelAndKey:true,textOnlyValidatedCatalogSelection:true,nativePetLeftClickAndEmbeddedSend:true,
      uniqueRefinementBeforePrimary:true,originalRequestAndNoUploadConstraintPreserved:true,polishingDoesNotExpandAuthorization:true,
      primaryReceivesUserSourcePet:true,busyPrimaryQueuesExactlyOnce:true,queueRunsAfterPrimaryCompletes:true,
      casualAndHowToDoNotStartCoding:true,centralUnsentDraftPreserved:true,initialSessionId:sessionBefore,finalSessionId:(await state()).sessionId,
      calls:records.map(({source,kind,user,finished})=>({source,kind,user,finished})),
      usagePurposes:store?.usage?.records?.map(record=>({purpose:record.purpose,model:record.model,status:record.status}))||[],screenshots};
    await fs.writeFile(path.join(output,'pet-task-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  }catch(error){
    const failure={status:'failed',stage,error:error.message,stack:error.stack,calls:records.map(({source,kind,user,finished,aborted})=>({source,kind,user,finished,aborted})),problems};
    if(child&&!child.isDestroyed())try{failure.state=await state();failure.petDialog=await call('getPetDialog');await capture('pet-task-failure.png');}catch(diagnostic){failure.diagnosticError=diagnostic.message;}
    await fs.writeFile(path.join(output,'pet-task-smoke-result.json'),JSON.stringify(failure,null,2)+'\n');throw new Error('Pet-task smoke failed at '+stage+': '+error.message,{cause:error});
  }finally{
    if(held&&!held.finished&&!held.aborted)finish(held,'测试结束。');
    if(child&&!child.isDestroyed()){
      await call('stopTask').catch(()=>{});await mainIdle().catch(()=>{});
      if(configured){await call('resetRoleModel',{role:'pet'}).catch(()=>{});const previous=original.settings.providers.relay;await call('saveSettings',{provider:'relay',model:previous.model,apiProtocol:previous.apiProtocol,baseUrl:previous.baseUrl||baseUrl,reasoningEffort:previous.reasoningEffort,clearKey:true}).catch(()=>{});}
      if(originalAppearance)await call('setAppearance',{uiStyle:originalAppearance.uiStyle}).catch(()=>{});
      if(originalPet)await call('setPet',{enabled:originalPet.enabled,size:originalPet.size,x:originalPet.x,y:originalPet.y}).catch(()=>{});
      child.close();await until('child closes',()=>child.isDestroyed()).catch(()=>child.destroy());
    }
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
};
