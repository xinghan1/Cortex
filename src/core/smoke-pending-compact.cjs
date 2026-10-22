// Display-only pending prompts with native controls. Backend edit/steer/resume
// behavior is covered by smoke-queue against its disposable loopback provider.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');

module.exports = async function smokePendingCompact({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const js = code => win.webContents.executeJavaScript(code), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => { const end = Date.now()+12000; while(Date.now()<end){const value=await check();if(value)return value;await wait(20);}throw new Error('Compact pending smoke timed out: '+label); };
  const original = { bounds:win.getBounds(),opacity:win.getOpacity(),visible:win.isVisible() };
  const pixels=Buffer.alloc(160*96*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=200;pixels[i+1]=100;pixels[i+2]=30;pixels[i+3]=255;}
  const dataUrl=nativeImage.createFromBitmap(pixels,{width:160,height:96}).toDataURL();
  const long='保留完整原文，不自动发送。\n'+Array.from({length:35},(_,i)=>`第${i+1}行：检查边界与异常处理，保留所有内容。`).join('\n');
  const attachment={name:'compact-fixture.png',mediaType:'image/png',dataUrl};
  const items=[{id:'compact-short',text:'先检查项目结构，然后调整界面与交互，保持单行。',mode:'queue'},
    {id:'compact-long',text:long,mode:'queue',attachments:[attachment]},
    {id:'compact-steered',text:'这条内容已经设置为引导，仍保持一行。',mode:'steer'},
    {id:'compact-image-only',text:'',mode:'queue',attachments:[attachment]}];
  let installed=false,stage='display fixture initialization';const observations=[];
  const selector=id=>`.pending-prompt[data-prompt-id=${JSON.stringify(id)}]`;
  const click=async selector=>{
    const p=await until('native target '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility())return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    win.focus();win.webContents.focus();win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(35);
  };
  const capture=async name=>{win.webContents.invalidate();await wait(120);await fs.writeFile(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const geometry=()=>js(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};return {window:{width:innerWidth,height:innerHeight},composer:rect(document.querySelector('.composer-area')),viewport:rect($('message-scroll')),bodyWidth:document.documentElement.scrollWidth,
    rows:[...$('pending-items').querySelectorAll('.pending-prompt')].map(n=>{const row=n.querySelector('.pending-prompt-row'),text=n.querySelector('.pending-preview-text'),style=getComputedStyle(n);return {id:n.dataset.promptId,card:rect(n),chrome:['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((sum,key)=>sum+(parseFloat(style[key])||0),0),row:rect(row),text:rect(text),whiteSpace:getComputedStyle(text).whiteSpace,lineHeight:parseFloat(getComputedStyle(text).lineHeight),actions:[...n.querySelectorAll('.pending-prompt-actions button,.pending-more')].map(a=>({className:a.className,...rect(a)})),images:[...n.querySelectorAll('.pending-attachment-image')].map(image=>({width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height,natural:image.naturalWidth})),steerDisabled:n.querySelector('.pending-steer').disabled};})};})()`);
  try{
    await fs.mkdir(output,{recursive:true});await js('window.synoraAppearance.ready');
    await js(`(()=>{if(running||terminalRunning||promptSubmitting||approvals.size)throw new Error('Pending display smoke requires idle state');window.__pendingCompact={queue:promptQueue,state:appState,nodes:[...$('messages').childNodes],welcome:$('welcome').hidden,notice:$('notice').hidden,follow:followOutput,scroll:$('message-scroll').scrollTop,preview:$('preview-panel').hidden,terminal:$('terminal-panel').hidden,nativeClicks:0};window.__pendingCompact.onClick=e=>{if(e.isTrusted&&e.target.closest('#pending-prompts,#pending-edit-dialog,#image-preview-dialog'))window.__pendingCompact.nativeClicks++;};document.addEventListener('click',window.__pendingCompact.onClick,true);$('welcome').hidden=true;$('notice').hidden=true;$('messages').replaceChildren();setPreviewOpen(false);$('terminal-panel').hidden=true;syncPromptQueue({items:${JSON.stringify(items)},paused:false,reason:null});true;})()`);installed=true;
    win.setOpacity(0);win.showInactive();win.focus();win.webContents.focus();
    await until('fixture PNG decoded',()=>js(`[...document.querySelectorAll('#pending-items .pending-attachment-image')].every(n=>n.naturalWidth===160)`));
    assert.equal(await js(`document.querySelectorAll('#pending-count,#pending-status,.pending-prompt-mode').length`),0);
    for(const [width,height]of [[1440,1000],[980,680]]){
      stage='single-line layout at '+width;win.setContentSize(width,height);await wait(100);const g=await geometry();
      assert.equal(g.rows.length,4);assert.ok(g.composer.bottom<=g.window.height+2);assert.ok(g.viewport.height>=80);assert.ok(g.bodyWidth<=g.window.width+2);
      for(const row of g.rows){
        assert.equal(row.whiteSpace,'nowrap');assert.ok(row.text.height<=row.lineHeight+2,'Pending text must fit one actual line');
        assert.ok(row.card.height<=row.row.height+row.chrome+1&&row.row.height<=46,'Collapsed prompt must remain a compact single row');
        for(const action of row.actions)assert.ok(action.left>=row.card.left-1&&action.right<=row.card.right+1&&action.top>=row.row.top-1&&action.bottom<=row.row.bottom+1,'Pending actions must remain inside the same row: '+JSON.stringify({row,action}));
        for(const image of row.images){assert.ok(Math.abs(image.width-24)<=1&&Math.abs(image.height-24)<=1);assert.equal(image.natural,160);}
      }
      assert.equal(g.rows.find(row=>row.id==='compact-steered').steerDisabled,true);observations.push(g);await capture('pending-compact-'+width+'.png');
    }
    stage='native more button reveals the exact complete text';
    await click(selector('compact-long')+' .pending-more');
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector('compact-long')+' .pending-content')}).open`),true);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector('compact-long')+' .pending-text')}).textContent`),long);
    await capture('pending-compact-full-text.png');
    await click(selector('compact-long')+' .pending-more');assert.equal(await js(`document.querySelector(${JSON.stringify(selector('compact-long')+' .pending-content')}).open`),false);

    stage='native thumbnail opens the existing full-image preview';
    await click(selector('compact-long')+' .user-message-image-button');
    await until('full image modal decoded',()=>js(`$('image-preview-dialog').open&&$('image-preview-content').src===${JSON.stringify(dataUrl)}&&$('image-preview-content').naturalWidth===160`));
    assert.equal(await js(`$('image-preview-title').textContent`),'compact-fixture.png');await click('#image-preview-close');
    await until('image preview closed',()=>js(`!$('image-preview-dialog').open`));

    stage='native pending editor cancellation keeps the complete original text';
    await click(selector('compact-long')+' .pending-edit');assert.equal(await js(`$('pending-edit-dialog').open`),true);assert.equal(await js(`$('pending-edit-input').value`),long);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await until('native select-all reached editor',()=>js(`$('pending-edit-input').selectionStart===0&&$('pending-edit-input').selectionEnd===$('pending-edit-input').value.length`));await win.webContents.insertText('此修改将取消。');assert.equal(await js(`$('pending-edit-input').value`),'此修改将取消。');
    await click('#pending-edit-cancel');assert.equal(await js(`promptQueue.items.find(n=>n.id==='compact-long').text`),long);

    stage='an item removed while editing cannot be saved';
    await click(selector('compact-short')+' .pending-edit');
    await js(`syncPromptQueue({...promptQueue,items:promptQueue.items.filter(n=>n.id!=='compact-short')});true`);
    assert.equal(await js(`$('pending-edit-save').disabled`),true);assert.match(await js(`$('pending-edit-error').textContent`),/已发送|移除/u);await click('#pending-edit-cancel');
    await js(`syncPromptQueue({...promptQueue,paused:true,reason:'仅显示暂停状态的fixture'});true`);
    assert.equal(await js(`!$('pending-pause-controls').hidden&&!$('resume-pending').hidden&&!$('resume-pending').disabled`),true);
    assert.ok(await js(`window.__pendingCompact.nativeClicks>=8`));
    return{status:'completed',realApi:false,realCommands:false,realFileMutations:false,displayFixture:true,singleLineRows:true,noQueueCountOrModeDescription:true,narrowLayout:true,inlineImage24px:true,nativeFullText:true,nativeImagePreview:true,nativeEditCancel:true,expiredEditorDisabled:true,pausedResumeVisible:true,backendActionsCoveredBy:'smoke-queue',observations,screenshots:['pending-compact-1440.png','pending-compact-980.png','pending-compact-full-text.png']};
  }catch(error){await fs.writeFile(path.join(output,'pending-compact-failure.json'),JSON.stringify({stage,error:error.message,stack:error.stack,observations,ui:installed?await geometry().catch(()=>null):null},null,2));throw error;}
  finally{
    if(installed&&!win.isDestroyed())await js(`(()=>{const saved=window.__pendingCompact;if($('pending-edit-dialog').open)$('pending-edit-dialog').close();pendingPromptEdit=null;if($('image-preview-dialog').open)$('image-preview-dialog').close();document.removeEventListener('click',saved.onClick,true);appState=saved.state;syncPromptQueue(saved.queue);$('messages').replaceChildren(...saved.nodes);$('welcome').hidden=saved.welcome;$('notice').hidden=saved.notice;setPreviewOpen(!saved.preview);$('terminal-panel').hidden=saved.terminal;followOutput=saved.follow;$('message-scroll').scrollTop=saved.scroll;delete window.__pendingCompact;true;})()`).catch(()=>{});
    if(!win.isDestroyed()){win.setBounds(original.bounds);win.setOpacity(original.opacity);if(!original.visible)win.hide();}
  }
};
