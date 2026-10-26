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
  const questions = Object.fromEntries(phases.map(name => [name, name === 'cancel' ? '请逐项确认本次测试的处理方式。'.repeat(100) : '请确认这次测试的处理方式：' + name]));
  const answers = {}, records = [], problems = [], screenshots = [], timing = [], reactions = [], geometryChecks = [];
  let child, original, appearance, pet, configured = false, stage = 'initialize', casualCount = 0, heldCasual = null, failReaction = false;
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
    const panel=$('pet-dialog'),r=panel?.getBoundingClientRect(),input=$('pet-dialog-input'),inputBubble=$('pet-dialog-input-bubble'),ir=inputBubble?.getBoundingClientRect(),pr=$('pet-overlay')?.getBoundingClientRect();
    const scale=pr&&Math.min(pr.width/640,pr.height/360),offsetY=pr&&(pr.height-360*scale)/2;
    return {hidden:panel?.hidden,mode:panel?.dataset.mode,blocking:panel?.dataset.blocking,collapsed:panel?.dataset.collapsed,
      anchor:panel?.dataset.anchor,characterGeometry:pr&&{top:pr.top+offsetY+40*scale,bottom:pr.top+offsetY+340*scale},
      question:$('pet-dialog-question')?.textContent,historyExists:!!$('pet-dialog-messages'),titleExists:!!$('pet-dialog-toggle'),error:$('pet-dialog-error')?.textContent,
      launcherExists:!!$('pet-dialog-launcher'),closeExists:!!$('pet-dialog-close'),
      sendInsideInput:(()=>{const a=$('pet-dialog-send').getBoundingClientRect(),b=input.getBoundingClientRect();return a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom})(),
      phase:panel?.dataset.phase,duration:Number(panel?.dataset.duration),elapsed:performance.now()-Number(panel?.dataset.startedAt),
      animation:getComputedStyle(panel).animationDuration,animationName:getComputedStyle(panel).animationName,
      opacity:Number(getComputedStyle(panel).opacity),transform:getComputedStyle(panel).transform,
      inputBubbleHidden:inputBubble?.hidden,inputMode:inputBubble?.dataset.mode,inputPhase:inputBubble?.dataset.phase,
      inputGeometry:ir&&{top:ir.top,bottom:ir.bottom,left:ir.left,right:ir.right,height:ir.height},petGeometry:pr&&{left:pr.left,right:pr.right,top:pr.top,bottom:pr.bottom,width:pr.width,height:pr.height},
      contentContained:[$('pet-dialog-question'),$('pet-dialog-options'),$('pet-dialog-cancel'),$('pet-dialog-stop')].filter(n=>n&&n.checkVisibility()).every(n=>{const b=n.getBoundingClientRect();return b.top>=r.top-1&&b.bottom<=r.bottom+1}),
      input:input?.value,inputDisabled:input?.disabled,mainDraft:$('task-input').value,
      selection:[$('task-input').selectionStart,$('task-input').selectionEnd],
      replaced:document.documentElement.classList.contains('pet-dialog-replaces-composer'),
      mainDisplay:getComputedStyle($('task-form')).display,mainHidden:$('task-form').hidden,
      stopVisible:$('pet-dialog-stop')?.checkVisibility({visibilityProperty:true}),
      textColor:panel&&getComputedStyle(panel).color,background:panel&&getComputedStyle(panel).backgroundColor,
      geometry:r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth+1,
      questionAnswers:[...document.querySelectorAll('.question-answer-card')].map(card=>({runId:card.dataset.runId,questionId:card.dataset.questionId,
        question:card.querySelector('.question-answer-question')?.textContent,answer:card.querySelector('.question-answer-text')?.textContent})),
      nativeInputs:window.__petDialogInputs||[],sessionId:appState?.sessionId};
  })()`);
  const click = async (selector, button = 'left') => {
    const point = await until('native target ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true}))return null;
      node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return node.contains(document.elementFromPoint(p.x,p.y))?p:null;
    })()`));
    child.webContents.focus(); child.webContents.sendInputEvent({type:'mouseMove',...point});
    child.webContents.sendInputEvent({type:'mouseDown',button,clickCount:1,...point});
    child.webContents.sendInputEvent({type:'mouseUp',button,clickCount:1,...point}); await wait(60);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    child.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers}); await wait(40);
  };
  const capture = async name => {
    await js(`Promise.all(['pet-dialog','pet-dialog-input-bubble'].flatMap(id=>$(id)?.getAnimations()||[]).map(animation=>animation.finished.catch(()=>{}))).then(()=>true)`);
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
          const reaction=user.includes('摸了摸大肥鱼')?'clicks':user.includes('转了个身')?'turn':user.includes('表演敲键盘')?'actions':null;
          if(reaction){
            reactions.push({kind:reaction,failed:failReaction});phase='reaction-'+reaction;await wait(150);
            if(failReaction){response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'Isolated unavailable fixture'}}));return;}
            output=[message('MODEL_REACTION_'+reaction+'：大肥鱼收到啦！')];
          }else{
            casualCount++;phase='casual';
            if(user.includes('再聊一句'))await new Promise(resolve=>{heldCasual={resolve};});else await wait(250);
            output=[message('99 + 11 = **110**。这是独立的宠物回复 '+casualCount+'。')];
          }
        }
      } else {
        phase=phases.find(name=>user.includes(prompts[name]));assert.ok(phase,'Unexpected primary question request');
        assert.ok(body.tools.some(tool=>tool.name==='ask_user_question'));
        const toolOutput=body.input.find(item=>item.type==='function_call_output'&&item.call_id==='question-'+phase);
        if(toolOutput) {
          answers[phase]=JSON.parse(toolOutput.output);output=[message('问题已处理 '+phase)];
        } else output=[{type:'function_call',call_id:'question-'+phase,name:'ask_user_question',arguments:JSON.stringify({question:questions[phase],options:phase==='cancel'?Array.from({length:8},(_,index)=>'选项 '+index+'：'+'保留现有配置并进行独立验证。'.repeat(8)):['先检查','使用独立配置']})}];
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
  const settledPet = async () => {
    let previous='',unchanged=0;
    // A closed composer fallback remains in flow during its 500ms exit.
    // Geometry can look stable for several frames before that exit completes.
    await js(`Promise.all(['pet-dialog','pet-dialog-input-bubble'].flatMap(id=>$(id)?.getAnimations()||[]).map(animation=>animation.finished.catch(()=>{}))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))`);
    return until('pet placement settles after its visibility changes',async()=>{
      const value=await inspect(),geometry=value.petGeometry,current=JSON.stringify(geometry);
      if(!value.inputBubbleHidden&&value.inputPhase==='leaving'||!value.hidden&&value.phase==='leaving'){unchanged=0;previous='';return false;}
      unchanged=current===previous?unchanged+1:0;previous=current;
      return geometry.width>0&&unchanged>=3&&geometry;
    });
  };
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
    stage='one local welcome with real 5–10 second lifetime and 500ms transitions';
    await until('local welcome',async()=>(await inspect()).question==='Hello！我是大肥鱼，今天你要做些什么呢？');
    let welcome=await inspect();assert.equal(welcome.historyExists,false);assert.equal(welcome.titleExists,false);assert.ok(welcome.duration>=5000&&welcome.duration<=10000);
    assert.equal(welcome.animation,'0.5s');assert.equal(welcome.animationName,'pet-bubble-enter');
    await until('welcome settled',async()=>(await inspect()).phase==='visible');await wait(5000);
    welcome=await inspect();assert.equal(welcome.hidden,false);assert.ok(welcome.elapsed>=5000);timing.push({sample:'welcome-visible-after-5s',elapsed:welcome.elapsed,phase:welcome.phase,duration:welcome.duration});
    await until('welcome exits',async()=>(await inspect()).phase==='leaving');welcome=await inspect();assert.equal(welcome.animation,'0.5s');assert.equal(welcome.animationName,'pet-bubble-leave');
    timing.push({sample:'welcome-leaving',elapsed:welcome.elapsed,phase:welcome.phase,duration:welcome.duration});await until('welcome gone',async()=>(await inspect()).hidden);
    timing.push({sample:'welcome-hidden',elapsed:(await inspect()).elapsed});assert.equal(records.length,0,'Welcome must not call a model');
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('project selected',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    await call('saveSettings',{provider:'relay',authMode:'apiKey',apiProtocol:'responses',baseUrl,apiKey,model,reasoningEffort:'default'});configured=true;
    await call('listModels',{force:true});await call('setPet',{enabled:true,size:220,x:1,y:1});
    await js(`(()=>{const input=$('task-input');input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(2,8);
      window.__petDialogInputs=[];$('pet-dialog-input').addEventListener('input',event=>window.__petDialogInputs.push({trusted:event.isTrusted,value:event.target.value}));return true;})()`);

    stage='compact native hit region leaves transparent padding clickable and retains drag';
    const hitRegion=await js(`(()=>{
      const box=$('pet-overlay').getBoundingClientRect(),hit=$('pet-overlay-hit').getBoundingClientRect();
      window.__petPaddingClicks=0;const probe=document.createElement('button');probe.id='pet-smoke-padding-probe';probe.textContent='透过透明留白点击';
      Object.assign(probe.style,{position:'fixed',left:(box.left+2)+'px',top:(box.top+2)+'px',width:'32px',height:'28px',zIndex:'94'});
      probe.addEventListener('click',()=>window.__petPaddingClicks++);document.body.append(probe);
      return {visual:{width:box.width,height:box.height},hit:{width:hit.width,height:hit.height},
        paddingPassesThrough:document.elementFromPoint(box.left+18,box.top+16)===probe,videoPointerEvents:getComputedStyle($('pet-overlay-video')).pointerEvents};
    })()`);
    assert.ok(hitRegion.hit.width*hitRegion.hit.height<hitRegion.visual.width*hitRegion.visual.height*.5,'Pet hit region must exclude the large transparent video padding');
    assert.equal(hitRegion.videoPointerEvents,'none');assert.equal(hitRegion.paddingPassesThrough,true);
    await click('#pet-smoke-padding-probe');assert.equal(await js('window.__petPaddingClicks'),1,'Native pointer event reaches the control under transparent padding');
    assert.equal((await inspect()).inputBubbleHidden,true,'Transparent padding does not open pet chat');await js(`$('pet-smoke-padding-probe').remove()`);
    const beforeDrag=(await inspect()).petGeometry;
    const dragStart=await js(`(()=>{const r=$('pet-overlay-hit').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    child.webContents.sendInputEvent({type:'mouseMove',...dragStart});child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragStart});await wait(30);
    for(let step=1;step<=5;step++){
      child.webContents.sendInputEvent({type:'mouseMove',x:dragStart.x-step*16,y:dragStart.y-step*10,modifiers:['leftButtonDown']});await wait(18);
    }
    child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:dragStart.x-80,y:dragStart.y-50});
    await until('native pet drag moves',async()=>Math.abs((await inspect()).petGeometry.left-beforeDrag.left)>50);
    const afterDrag=(await inspect()).petGeometry;assert.ok(afterDrag.top<beforeDrag.top-25);assert.equal((await inspect()).inputBubbleHidden,true,'Dragging does not open chat');
    geometryChecks.push({sample:'native-drag',before:beforeDrag,after:afterDrag,hitRegion});
    await call('setPet',{x:1,y:1});
    const restingPet=await until('native drag reset restores position',async()=>{
      const geometry=(await inspect()).petGeometry;
      return Math.abs(geometry.left-beforeDrag.left)<1&&Math.abs(geometry.top-beforeDrag.top)<1&&geometry;
    });

    stage='visible pet real tool question and native choice';await ask('choice');
    await until('pet bubble placement',async()=>(await inspect()).mode==='bubble'&&(await inspect()).inputPhase==='visible');let value=await inspect();assertLayout(value);assert.equal(value.replaced,false);
    assert.deepEqual(value.petGeometry,restingPet,'Opening a question and answer bubble preserves the pet position and size');
    geometryChecks.push({sample:'question-open',before:restingPet,after:value.petGeometry,input:value.inputGeometry});
    assert.equal(value.geometry.width,600,'Blocking questions use the enlarged question window');
    assert.equal(value.historyExists,false);assert.equal(value.titleExists,false);assert.equal(value.launcherExists,false);assert.equal(value.closeExists,false);assert.equal(value.sendInsideInput,true);assert.equal(value.anchor,'character');
    assert.ok(Math.abs(value.inputGeometry.top-value.characterGeometry.bottom-8)<=1,'Chat input bubble stays just below the character feet');
    assert.ok(Math.abs(value.geometry.bottom-value.characterGeometry.top+10)<=1,'Speech bubble stays close to the character head');
    assert.equal(value.stopVisible,true);await capture('pet-dialog-bubble.png');
    await click('.pet-dialog-choice[data-choice-index="1"]');await idle();
    assert.equal(answers.choice.answer,'使用独立配置');assert.equal(answers.choice.choiceIndex,1);assert.equal(answers.choice.source,'user');
    assert.equal((await inspect()).mainDraft,draft);
    assert.deepEqual((await inspect()).questionAnswers.map(item=>[item.question,item.answer]),[[questions.choice,'使用独立配置']]);
    assert.equal((await call('getCurrentSession')).messages.filter(item=>item.role==='user').length,1,'Answering a choice must not add a main user turn');

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
    assert.deepEqual((await inspect()).questionAnswers.map(item=>[item.question,item.answer]),[[questions.choice,'使用独立配置'],[questions.custom,customAnswer]]);
    assert.equal((await call('getCurrentSession')).messages.filter(item=>item.role==='user').length,2,'Hidden-pet custom input stays an answer inside its existing task');

    stage='enlarged long blocking question keeps all controls within the viewport';await call('setPet',{enabled:true});
    const beforeLongQuestion=await settledPet();await ask('cancel');
    await until('long question entry settles',async()=>(await inspect()).phase==='visible');
    value=await inspect();assertLayout(value);assert.equal(value.geometry.width,600);
    assert.ok(value.geometry.height>350,'Long question and eight choices use the enlarged vertical space');
    assert.ok(value.geometry.height<=560,'Question keeps its bounded maximum height');
    assert.equal(value.contentContained,true,'Long question, choices and footer controls remain inside the enlarged panel');assert.equal(value.stopVisible,true);
    assert.deepEqual(value.petGeometry,beforeLongQuestion,'Enlarging a question does not move the pet');
    geometryChecks.push({sample:'enlarged-long-question',panel:value.geometry,pet:value.petGeometry,input:value.inputGeometry});
    await capture('pet-dialog-long-question-bubble.png');

    stage='six styles and narrow window keep fallback controls usable';await call('setPet',{enabled:false});
    await until('long question falls back only after pet is hidden',async()=>(await inspect()).mode==='composer'&&(await inspect()).replaced);
    child.setContentSize(980,760);await wait(100);
    for(const uiStyle of ['glass','black','white','industrial','deepseek','codex']) {
      await call('setAppearance',{uiStyle});await until('material '+uiStyle,()=>js(`document.documentElement.dataset.uiStyle===${JSON.stringify(uiStyle)}`));
      await wait(70);value=await inspect();assertLayout(value);assert.equal(value.contentContained,true,'Long question and eight options stay inside the speech bubble');assert.notEqual(value.textColor,value.background);
      await capture('pet-dialog-'+uiStyle+'.png');
    }
    await click('#pet-dialog-cancel');await idle();
    assert.equal(answers.cancel.cancelled,true);assert.equal(answers.cancel.source,'user');
    assert.equal(Object.hasOwn(answers.cancel,'answer'),false);assert.equal(Object.hasOwn(answers.cancel,'approval'),false);
    assert.equal((await inspect()).questionAnswers.length,2,'Cancelling a question does not invent an answer card');

    stage='stop entry cancels blocked primary task';await ask('stop');await click('#pet-dialog-stop');await idle();
    await until('stopped question removed',async()=>!(await call('getPetDialog')).question&&!(await inspect()).replaced);
    assert.equal(answers.stop,undefined,'Stop must not invent a question answer');
    assert.equal((await inspect()).questionAnswers.length,2);

    stage='left-click pet opens chat with internal send and outside collapse keeps drafts';await call('setPet',{enabled:true});
    const beforeChat=await settledPet();await click('#pet-overlay-hit');
    await until('pet left click opens input',async()=>!(await inspect()).inputBubbleHidden&&(await inspect()).inputPhase==='visible');
    const afterChat=await inspect();assert.deepEqual(afterChat.petGeometry,beforeChat,'Opening casual chat never lifts or shrinks the pet');
    assert.ok(afterChat.inputGeometry.top>=afterChat.characterGeometry.bottom,'Input remains below the character without shifting it');
    assert.ok(afterChat.inputGeometry.bottom<=afterChat.viewport.height+1,'Input stays within the available lower viewport');
    geometryChecks.push({sample:'casual-open',before:beforeChat,after:afterChat.petGeometry,input:afterChat.inputGeometry});
    assert.equal((await inspect()).sendInsideInput,true);await click('#pet-dialog-input');await child.webContents.insertText('你好，今天适合聊点什么？');await click('#pet-dialog-send');
    await until('casual completed',async()=>{const value=await call('getPetDialog');return !value.running&&value.messages.some(item=>item.role==='assistant'&&item.content.includes('独立的宠物回复'));});
    await until('casual answer visible',async()=>!(await inspect()).hidden&&(await inspect()).question.includes('独立的宠物回复'));
    value=await inspect();assertLayout(value);assert.equal(value.replaced,false);assert.notEqual(value.mainDisplay,'none');assert.equal(value.input,'','Accepted first chat draft is cleared');
    assert.equal(value.question.includes('**'),false,'Pet chat is normalized to plain text');
    const chatBefore=await call('getPetDialog');assert.equal(chatBefore.messages.length,2);await capture('pet-dialog-active-chat.png');
    await click('#task-input');await until('casual outside close',async()=>(await inspect()).hidden&&(await inspect()).inputBubbleHidden);
    assert.equal((await call('getPetDialog')).messages.length,2,'Closing panel keeps temporary chat until session or application exit');
    await click('#pet-overlay-hit');await click('#pet-dialog-input');await child.webContents.insertText('保留这段临时草稿');await click('#task-input');
    await until('unsent draft folded',async()=>(await inspect()).inputBubbleHidden);await click('#pet-overlay-hit');
    assert.equal((await inspect()).input,'保留这段临时草稿');await click('#pet-dialog-input');await key('a',['control']);await child.webContents.insertText('再聊一句。');await click('#pet-dialog-send');
    await until('pending held casual',async()=>heldCasual&&(await call('getPetDialog')).running);assert.equal((await inspect()).input,'','Accepted consecutive chat draft is cleared');
    await click('#task-input');assert.equal((await inspect()).inputBubbleHidden,false);assert.notEqual((await inspect()).inputPhase,'leaving');
    assert.equal(await js(`document.activeElement===$('task-input')`),true,'Outside click still performs its main interface action while reply remains open');
    heldCasual.resolve();heldCasual=null;await until('background casual completes',async()=>!(await call('getPetDialog')).running);
    await click('#task-input');await until('reply complete allows collapse',async()=>(await inspect()).hidden&&(await inspect()).inputBubbleHidden);assert.equal((await inspect()).replaced,false);

    stage='three actual pet menu actions request model responses and unavailable model uses backend fallback';
    for(const [kind,selector] of [['clicks','#pet-overlay-pat'],['turn','#pet-overlay-turn'],['actions','#pet-overlay-action']]){
      await click('#pet-overlay-hit','right');await click(selector);
      await until('model reaction '+kind,async()=>{const current=await call('getPetDialog');return !current.running&&current.question?.kind==='reaction'&&current.question.reactionKind===kind&&current.question.question.includes('MODEL_REACTION_'+kind);});
      await until('reaction bubble '+kind,async()=>(await inspect()).question.includes('MODEL_REACTION_'+kind));
      assert.equal((await call('getPetDialog')).question.fallback,false);await click('#pet-overlay-hit');await click('#task-input');await until('reaction folded',async()=>(await inspect()).inputBubbleHidden);
      await wait(2100);
    }
    failReaction=true;await click('#pet-overlay-hit','right');await click('#pet-overlay-pat');
    await until('unavailable reaction fallback',async()=>{const current=await call('getPetDialog');return !current.running&&current.question?.kind==='reaction'&&current.question.reactionKind==='clicks'&&current.question.fallback===true;});
    failReaction=false;
    assert.ok((await call('getPetDialog')).question.question.length>0);assert.equal((await inspect()).inputBubbleHidden,true);

    stage='bottom-edge chat stays in a fixed lower bubble without composer feedback';
    await js(`(()=>{window.__petSmokeEdgeStyles=[...document.querySelectorAll('.composer-area,#task-form,#composer-approval')].map(node=>({node,value:node.style.getPropertyValue('display'),priority:node.style.getPropertyPriority('display')}));for(const{node}of window.__petSmokeEdgeStyles)node.style.setProperty('display','none','important');window.dispatchEvent(new Event('resize'));return true})()`);
    const edgePet=await settledPet();await click('#pet-overlay-hit');
    await until('compact lower input visible',async()=>(await inspect()).inputPhase==='visible'&&!(await inspect()).inputBubbleHidden);
    assert.equal(await js(`getComputedStyle($('task-form')).display`),'none','The edge fixture must actually hide the composer');
    assert.ok(await js(`Number.parseFloat($('pet-dialog-input-bubble').style.maxHeight)<104`),'The edge fixture must enter the compact lower-space path');
    const edgeSamples=[];
    for(let sample=0;sample<6;sample++){
      const edge=await inspect();assert.deepEqual(edge.petGeometry,edgePet,'Bottom-edge chat never moves the pet through composer layout');
      assert.equal(edge.inputMode,'bubble');assert.ok(edge.inputGeometry.top>=edge.characterGeometry.bottom+7);
      assert.ok(edge.inputGeometry.bottom<=edge.viewport.height+1,'Compact lower bubble remains inside the viewport');
      edgeSamples.push({pet:edge.petGeometry,input:edge.inputGeometry});await wait(40);
    }
    geometryChecks.push({sample:'bottom-edge-stable',before:edgePet,frames:edgeSamples});await capture('pet-dialog-bottom-edge.png');
    await js(`(()=>{for(const{node,value,priority}of window.__petSmokeEdgeStyles||[])if(value)node.style.setProperty('display',value,priority);else node.style.removeProperty('display');delete window.__petSmokeEdgeStyles;window.dispatchEvent(new Event('resize'));return true})()`);await settledPet();
    await click('#task-input');await until('edge chat closes normally',async()=>(await inspect()).inputBubbleHidden);

    stage='answered task questions restore in history without casual chat or additional rounds';
    const answeredSession=await call('getCurrentSession'),liveAnswers=(await inspect()).questionAnswers;
    assert.equal(answeredSession.questionAnswers.length,2);assert.equal(liveAnswers.length,2,'Casual pet chat and reactions never create main-task answer cards');
    await js(`renderSessionSnapshot(${JSON.stringify(answeredSession)})`);
    assert.deepEqual((await inspect()).questionAnswers,liveAnswers);
    assert.equal(await js(`document.querySelectorAll('.message.user').length`),answeredSession.messages.filter(item=>item.role==='user').length);
    await js(`(()=>{for(const node of document.querySelectorAll('.task-activity'))node.open=true;document.querySelector('.question-answer-card')?.scrollIntoView({block:'center',behavior:'instant'});return true})()`);
    await capture('pet-dialog-question-answer-history.png');
    stage='scope switch deletes temporary chat and rejects stale payload';const previous=await call('getPetDialog');await call('newSession');
    await until('new session clears pet chat',async()=>{const next=await call('getPetDialog');return next.sessionId!==previous.sessionId&&!next.messages.length&&!next.question;});
    assert.equal(await js(`window.forge.sendPetChat(${JSON.stringify({workspaceId:previous.workspaceId,sessionId:previous.sessionId,text:'不得发送旧输入'})}).then(()=>false,()=>true)`),true);
    assert.equal(casualCount,2);assert.deepEqual(problems,[]);
    const result={status:'completed',realApi:false,realCommands:false,localFixtureModelOnly:true,realBlockingTool:true,nativeChoiceAnswer:true,
      nativeCustomAnswer:true,composingEnterDoesNotSend:true,hiddenPetComposerFallback:true,originalDraftAndSelectionPreserved:true,
      cancellationNotAuthorization:true,stopCancelsBlockedTask:true,separateActiveCasualChat:true,casualDoesNotBlockMainDraft:true,
      closeKeepsTemporaryHistory:true,outsideClosePreservesDraft:true,outsideDuringReplyKeepsInputOpen:true,outsideClickDoesNotConsumeMainAction:true,
      nativePetLeftClickOpensChat:true,transparentPaddingClickThrough:true,compactNativeHitRegion:true,nativePetDragPreserved:true,openingChatPreservesPetGeometry:true,geometryChecks,
      sendButtonInsideTextarea:true,noLaunchOrCloseButton:true,petChatPlainText:true,threeNativeMenuModelReactions:true,unavailableReactionBackendFallback:true,reactions,
      sessionSwitchClearsTemporaryHistory:true,staleScopeRejected:true,
      speechAndInputAreSeparateBubbles:true,noHistoryWindow:true,inputBelowPet:true,bundledCharacterAnchor:true,ordinarySpeechLifetimeIncludes500msTransitions:true,timing,
      acceptedConsecutiveChatDraftCleared:true,longQuestionEightChoicesContained:true,enlargedLongBlockingQuestion:true,bottomEdgeNoLayoutFeedback:true,
      sixStyles:true,narrowWindow:true,answers,requests:records,screenshots};
    result.taskQuestionAnswersVisible=true;result.taskQuestionAnswersHistoryRestored=true;result.answersDoNotAddUserTurns=true;result.casualChatExcludedFromMainHistory=true;
    await fs.writeFile(path.join(output,'pet-dialog-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  } catch(error) {
    const failure={status:'failed',stage,error:error.message,stack:error.stack,answers,records,problems,geometryChecks};
    if(child&&!child.isDestroyed())try{failure.ui=await inspect();failure.petDialog=await call('getPetDialog');await capture('pet-dialog-failure.png');}catch(diagnostic){failure.diagnosticError=diagnostic.message;}
    await fs.writeFile(path.join(output,'pet-dialog-smoke-result.json'),JSON.stringify(failure,null,2)+'\n');throw new Error('Pet-dialog smoke failed at '+stage+': '+error.message,{cause:error});
  } finally {
    heldCasual?.resolve();
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
