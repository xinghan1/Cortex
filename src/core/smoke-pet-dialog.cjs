// Actual local model/tool requests and native input, using only a disposable project.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokePetDialog({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), project = path.join(dataDir, 'pet-dialog-' + nonce);
  const apiKey = 'isolated-pet-dialog-' + nonce, model = 'pet-dialog-fixture';
  const draft = '原草稿保留，不要发送 MAIN_DRAFT_' + nonce;
  const customAnswer = '使用单独的测试配置，并保留现有文件。';
  const phases = ['choice', 'custom', 'cancel', 'stop'];
  const prompts = Object.fromEntries(phases.map(name => [name, 'PET_QUESTION_' + name.toUpperCase() + '_' + nonce]));
  const questions = Object.fromEntries(phases.map(name => [name, '请确认这次测试的处理方式：' + name]));
  const answers = {}, records = [], problems = [], screenshots = [];
  let child, original, appearance, pet, configured = false, stage = 'initialize', casualCount = 0;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const call = (name, value, target = child) => js(`window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`, target);
  const state = () => call('getState');
  const until = async (label, check) => {
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) { assert.deepEqual(problems, []); const value = await check(); if (value) return value; await wait(30); }
    throw new Error('Pet-dialog smoke timed out: ' + label);
  };
  const inspect = () => js(`(() => {
    const panel=$('pet-dialog'),r=panel?.getBoundingClientRect(),input=$('pet-dialog-input');
    return {hidden:panel?.hidden,mode:panel?.dataset.mode,blocking:panel?.dataset.blocking,collapsed:panel?.dataset.collapsed,
      question:$('pet-dialog-question')?.textContent,history:$('pet-dialog-messages')?.textContent,error:$('pet-dialog-error')?.textContent,
      input:input?.value,inputDisabled:input?.disabled,mainDraft:$('task-input').value,
      selection:[$('task-input').selectionStart,$('task-input').selectionEnd],
      replaced:document.documentElement.classList.contains('pet-dialog-replaces-composer'),
      mainDisplay:getComputedStyle($('task-form')).display,mainHidden:$('task-form').hidden,
      stopVisible:$('pet-dialog-stop')?.checkVisibility({visibilityProperty:true}),
      textColor:panel&&getComputedStyle(panel).color,background:panel&&getComputedStyle(panel).backgroundColor,
      geometry:r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth+1,
      nativeInputs:window.__petDialogInputs||[],sessionId:appState?.sessionId};
  })()`);
  const click = async selector => {
    const point = await until('native target ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true}))return null;
      node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return node.contains(document.elementFromPoint(p.x,p.y))?p:null;
    })()`));
    child.webContents.focus(); child.webContents.sendInputEvent({type:'mouseMove',...point});
    child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await wait(60);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    child.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers}); await wait(40);
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) try {
      child.webContents.invalidate(); await wait(attempt * 120);
      const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(),false);
      await fs.writeFile(path.join(output,name),image.toPNG()); screenshots.push(name); return;
    } catch (error) { if (attempt===4||!/UnknownVizError/.test(String(error))) throw error; }
  };
  const assertLayout = value => {
    assert.ok(value.geometry.width>0&&value.geometry.height>0);
    assert.ok(value.geometry.left>=0&&value.geometry.right<=value.viewport.width+1,'Question stays in viewport horizontally');
    assert.ok(value.geometry.top>=0&&value.geometry.bottom<=value.viewport.height+1,'Question stays in viewport vertically');
    assert.equal(value.overflow,false); assert.equal(value.mainDraft,draft); assert.equal(value.error,'');
  };
  const text = item => typeof item.content==='string'?item.content:(item.content||[]).map(part=>part.text||'').join('\n');
  const message = content => ({type:'message',role:'assistant',content:[{type:'output_text',text:content}]});
  const server = http.createServer(async (request,response) => {
    try {
      assert.equal(request.headers.authorization,'Bearer '+apiKey);
      if(request.method==='GET'&&request.url==='/v1/models') {
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:model,supportsTools:true}]}));return;
      }
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/responses');
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<1000000);}
      const body=JSON.parse(raw);assert.equal(body.model,model);assert.equal(body.stream,true);
      const system=body.input.filter(item=>item.role==='system').map(text).join('\n');
      const user=body.input.filter(item=>item.role==='user').map(text).at(-1)||'';
      let output,phase;
      if(!body.tools?.length) {
        if(system.includes('输入框提示词补全助手')) output=[message(JSON.stringify({continuation:'请继续检查。'}))];
        else {
          assert.match(system,/宠物聊天伙伴/);assert.ok(!raw.includes(draft),'Pet chat never receives unsent main draft');
          casualCount++;phase='casual';await wait(250);output=[message('这是独立的宠物回复 '+casualCount+'。')];
        }
      } else {
        phase=phases.find(name=>user.includes(prompts[name]));assert.ok(phase,'Unexpected primary question request');
        assert.ok(body.tools.some(tool=>tool.name==='ask_user_question'));
        const toolOutput=body.input.find(item=>item.type==='function_call_output'&&item.call_id==='question-'+phase);
        if(toolOutput) {
          answers[phase]=JSON.parse(toolOutput.output);output=[message('问题已处理 '+phase)];
        } else output=[{type:'function_call',call_id:'question-'+phase,name:'ask_user_question',arguments:JSON.stringify({question:questions[phase],options:['先检查','使用独立配置']})}];
      }
      records.push({phase:phase||'completion',toolResult:!!answers[phase]});
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:100,output_tokens:10}}})+'\n\n');
    } catch(error) {
      problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500);response.end('{}');}
    }
  });
  const ask = async phase => {
    await call('runTask',{text:prompts[phase]});
    await until('real blocking question '+phase,async()=>{
      const value=await call('getPetDialog');return value.question?.blocking&&value.question.question===questions[phase]&&value;
    });
    await until('question UI '+phase,async()=>!(await inspect()).hidden&&(await inspect()).question===questions[phase]);
  };
  const idle = () => until('primary idle',async()=>!(await state()).activeTask.running&&await js('!running&&!promptSubmitting'));
  try {
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});
    await fs.writeFile(path.join(project,'README.md'),'Disposable pet question fixture.\n');
    original=await call('getState',undefined,win);appearance=await call('getAppearance',undefined,win);pet=await call('petState',undefined,win);
    assert.equal(original.settings.providers.relay.hasKey,false,'Refusing to replace a configured relay key');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
    child=BrowserWindow.fromId((await call('newWindow',undefined,win)).id);assert.ok(child&&child.webContents.isOffscreen());
    child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.webContents.focus();
    await until('renderer ready',()=>js('Boolean(appState&&window.synoraPetDialog&&window.synoraPetOverlay&&!projectSwitching)'));
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('project selected',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    await call('saveSettings',{provider:'relay',authMode:'apiKey',apiProtocol:'responses',baseUrl,apiKey,model,reasoningEffort:'default'});configured=true;
    await call('listModels',{force:true});await call('setPet',{enabled:true,size:180,x:1,y:1});
    await js(`(()=>{const input=$('task-input');input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(2,8);
      window.__petDialogInputs=[];$('pet-dialog-input').addEventListener('input',event=>window.__petDialogInputs.push({trusted:event.isTrusted,value:event.target.value}));return true;})()`);

    stage='visible pet real tool question and native choice';await ask('choice');
    await until('pet bubble placement',async()=>(await inspect()).mode==='bubble');let value=await inspect();assertLayout(value);assert.equal(value.replaced,false);
    assert.equal(value.stopVisible,true);await capture('pet-dialog-bubble.png');
    await click('.pet-dialog-choice[data-choice-index="1"]');await idle();
    assert.equal(answers.choice.answer,'使用独立配置');assert.equal(answers.choice.choiceIndex,1);assert.equal(answers.choice.source,'user');
    assert.equal((await inspect()).mainDraft,draft);

    stage='hidden pet fallback preserves draft and custom answer';await call('setPet',{enabled:false});
    await js(`$('task-input').focus();$('task-input').setSelectionRange(2,8)`);await ask('custom');
    await until('composer replacement',async()=>(await inspect()).mode==='composer'&&(await inspect()).replaced);
    value=await inspect();assertLayout(value);assert.equal(value.mainDisplay,'none');assert.equal(value.mainHidden,false);assert.equal(value.stopVisible,true);
    await click('#pet-dialog-input');await child.webContents.insertText(customAnswer);
    await js(`$('pet-dialog-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))`);
    assert.equal(answers.custom,undefined);await key('Enter');await idle();
    assert.equal(answers.custom.answer,customAnswer);assert.equal(answers.custom.choiceIndex,undefined);assert.equal((await inspect()).mainDraft,draft);
    assert.deepEqual((await inspect()).selection,[2,8]);assert.equal((await inspect()).replaced,false);
    assert.ok((await inspect()).nativeInputs.some(item=>item.trusted&&item.value===customAnswer));

    stage='six styles and narrow window keep fallback controls usable';await ask('cancel');
    child.setContentSize(980,760);await wait(100);
    for(const uiStyle of ['glass','black','white','industrial','deepseek','codex']) {
      await call('setAppearance',{uiStyle});await until('material '+uiStyle,()=>js(`document.documentElement.dataset.uiStyle===${JSON.stringify(uiStyle)}`));
      await wait(70);value=await inspect();assertLayout(value);assert.notEqual(value.textColor,value.background);
      await capture('pet-dialog-'+uiStyle+'.png');
    }
    await click('#pet-dialog-cancel');await idle();
    assert.equal(answers.cancel.cancelled,true);assert.equal(answers.cancel.source,'user');
    assert.equal(Object.hasOwn(answers.cancel,'answer'),false);assert.equal(Object.hasOwn(answers.cancel,'approval'),false);

    stage='stop entry cancels blocked primary task';await ask('stop');await click('#pet-dialog-stop');await idle();
    await until('stopped question removed',async()=>!(await call('getPetDialog')).question&&!(await inspect()).replaced);
    assert.equal(answers.stop,undefined,'Stop must not invent a question answer');

    stage='active separate pet chat and nonblocking close';await click('#pet-dialog-launcher');
    await click('#pet-dialog-input');await child.webContents.insertText('你好，今天适合聊点什么？');await key('Enter');
    await until('casual completed',async()=>{const value=await call('getPetDialog');return !value.running&&value.messages.some(item=>item.role==='assistant'&&item.content.includes('独立的宠物回复'));});
    await until('casual answer visible',async()=>!(await inspect()).hidden&&(await inspect()).question.includes('独立的宠物回复'));
    value=await inspect();assertLayout(value);assert.equal(value.replaced,false);assert.notEqual(value.mainDisplay,'none');
    const chatBefore=await call('getPetDialog');assert.equal(chatBefore.messages.length,2);await capture('pet-dialog-active-chat.png');
    await click('#pet-dialog-close');await until('casual closed',async()=>(await inspect()).hidden);
    assert.equal((await call('getPetDialog')).messages.length,2,'Closing panel keeps temporary chat until session or application exit');
    await click('#pet-dialog-launcher');await click('#pet-dialog-input');await child.webContents.insertText('再聊一句。');await key('Enter');
    await until('pending casual',async()=>(await call('getPetDialog')).running);await click('#pet-dialog-close');
    await until('background casual completes',async()=>!(await call('getPetDialog')).running);
    await until('muted reply stays collapsed',async()=>(await inspect()).collapsed==='true');assert.equal((await inspect()).replaced,false);

    stage='scope switch deletes temporary chat and rejects stale payload';const previous=await call('getPetDialog');await call('newSession');
    await until('new session clears pet chat',async()=>{const next=await call('getPetDialog');return next.sessionId!==previous.sessionId&&!next.messages.length&&!next.question;});
    assert.equal(await js(`window.forge.sendPetChat(${JSON.stringify({workspaceId:previous.workspaceId,sessionId:previous.sessionId,text:'不得发送旧输入'})}).then(()=>false,()=>true)`),true);
    assert.equal(casualCount,2);assert.deepEqual(problems,[]);
    const result={status:'completed',realApi:false,realCommands:false,localFixtureModelOnly:true,realBlockingTool:true,nativeChoiceAnswer:true,
      nativeCustomAnswer:true,composingEnterDoesNotSend:true,hiddenPetComposerFallback:true,originalDraftAndSelectionPreserved:true,
      cancellationNotAuthorization:true,stopCancelsBlockedTask:true,separateActiveCasualChat:true,casualDoesNotBlockMainDraft:true,
      closeKeepsTemporaryHistory:true,mutedPendingReplyStaysCollapsed:true,sessionSwitchClearsTemporaryHistory:true,staleScopeRejected:true,
      sixStyles:true,narrowWindow:true,answers,requests:records,screenshots};
    await fs.writeFile(path.join(output,'pet-dialog-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  } catch(error) {
    const failure={status:'failed',stage,error:error.message,stack:error.stack,answers,records,problems};
    if(child&&!child.isDestroyed())try{failure.ui=await inspect();failure.petDialog=await call('getPetDialog');await capture('pet-dialog-failure.png');}catch(diagnostic){failure.diagnosticError=diagnostic.message;}
    await fs.writeFile(path.join(output,'pet-dialog-smoke-result.json'),JSON.stringify(failure,null,2)+'\n');throw new Error('Pet-dialog smoke failed at '+stage+': '+error.message,{cause:error});
  } finally {
    const target=child&&!child.isDestroyed()?child:win;
    if(!target.isDestroyed()){
      await call('stopTask',undefined,target).catch(()=>{});if(appearance)await call('setAppearance',{uiStyle:appearance.uiStyle},target).catch(()=>{});
      if(pet)await call('setPet',{enabled:pet.enabled,size:pet.size,x:pet.x,y:pet.y},target).catch(()=>{});
      if(configured){const previous=original.settings.providers.relay;await call('saveSettings',{provider:'relay',model:previous.model,baseUrl:previous.baseUrl||'https://example.invalid/v1',apiProtocol:previous.apiProtocol,reasoningEffort:previous.reasoningEffort,clearKey:true},target).catch(()=>{});}
    }
    if(child&&!child.isDestroyed()){child.close();await until('child closes',()=>child.isDestroyed()).catch(()=>child.destroy());}
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
};
