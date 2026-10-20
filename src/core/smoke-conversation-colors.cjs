// Actual renderer controls and generated local images; never calls a model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog, nativeImage } = require('electron');

module.exports = async function smokeConversationColors({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Conversation colors smoke requires an isolated window');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Conversation colors smoke timed out: ' + label);
  };
  const click = async selector => {
    const point = await js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});
      if(!node||node.disabled||!node.checkVisibility())throw new Error('Color control unavailable: '+${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=node.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    for (const type of ['mouseMove','mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
  };
  const capture = async name => {
    for (let attempt=1;attempt<=4;attempt++) {
      try { win.webContents.invalidate();await wait(150*attempt);const image=await win.webContents.capturePage();assert.equal(image.isEmpty(),false);await fs.writeFile(path.join(output,name),image.toPNG());return; }
      catch(error) { if(attempt===4||!/UnknownVizError/u.test(String(error?.name)+' '+error.message))throw error; }
    }
  };
  const colors={red:'rgb(255, 107, 107)',yellow:'rgb(255, 216, 107)',green:'rgb(121, 230, 162)',blue:'rgb(134, 185, 255)',white:'rgb(255, 255, 255)',black:'rgb(0, 0, 0)'};
  const text='我正在检查项目结构，接下来会调整样式并验证显示效果。';
  const code='const accent = "blue";\nif (accent) console.log(accent, 42);\n// <img src=x onerror=window.__colorUnsafe=1>\n';
  const content=`${text}\n\n\`\`\`js\n${code}\`\`\``;
  const originalBounds=win.getBounds(), originalChooser=dialog.showOpenDialog;
  let originalAppearance, installed=false, stage='prepare';
  const files=[];
  const install = async () => {
    await js(`(() => {
      if(running||terminalRunning||promptSubmitting||approvals.size)throw new Error('Cannot replace an active conversation');
      const messages=document.getElementById('messages');
      window.__colorSmokeOriginal={nodes:[...messages.childNodes],welcomeHidden:document.getElementById('welcome').hidden,messagesHidden:messages.hidden,followOutput,sessionTokenRate};
      messages.replaceChildren();followOutput=false;
      addMessage('user','请检查当前代码样式。',false,{historical:true,target:messages});
      const activity=createTaskActivity({runId:'conversation-colors-live'});
      activity.block.classList.add('running');activity.block.dataset.status='running';activity.phaseNode.textContent='正在检查样式';messages.append(activity.block);
      addMessage('assistant',${JSON.stringify(content)},false,{historical:true,target:activity.events});
      renderHistoricalTaskActivity({runId:'conversation-colors-history',status:'completed',elapsedMs:3000},[{type:'message',message:{role:'assistant',content:${JSON.stringify(text)}}}]);
      document.querySelector('[data-run-id="conversation-colors-history"]').open=true;
      addMessage('assistant','已完成检查，最终回复也使用你选定的颜色。',false,{historical:true,target:messages});
      document.getElementById('message-scroll').scrollTop=0;
    })()`);installed=true;
  };
  const restore = async () => {
    if(!installed)return;
    await js(`(() => {
      const original=window.__colorSmokeOriginal;if(!original)return;
      document.getElementById('messages').replaceChildren(...original.nodes);
      document.getElementById('welcome').hidden=original.welcomeHidden;document.getElementById('messages').hidden=original.messagesHidden;
      followOutput=original.followOutput;sessionTokenRate=original.sessionTokenRate;renderSessionTokenRate();
      delete window.__colorSmokeOriginal;delete window.__colorUnsafe;
    })()`);installed=false;
  };
  const inspect=()=>js(`(() => {
    const box=node=>{const s=getComputedStyle(node);return {background:s.backgroundColor,image:s.backgroundImage,padding:s.padding,borderWidth:s.borderWidth,borderStyle:s.borderStyle,borderRadius:s.borderRadius};};
    const live=document.querySelector('[data-run-id="conversation-colors-live"] .message-body');
    const historical=document.querySelector('[data-run-id="conversation-colors-history"] .message-body');
    const final=document.querySelector('#messages > .message.assistant .message-body');
    return {
      texts:[live,historical,final,document.querySelector('.message.user .message-body')].map(node=>{const s=getComputedStyle(node),p=node.querySelector('.message-paragraph');return {color:s.color,paragraph:getComputedStyle(p).color,size:s.fontSize,weight:s.fontWeight,filter:s.filter,opacity:s.opacity,box:box(node)};}),
      code:live.querySelector('.message-code pre code').textContent,
      tokenColors:[...new Set([...live.querySelectorAll('.syntax-token')].map(node=>getComputedStyle(node).color))],
      swatches:[...document.querySelectorAll('#conversation-text-colors [data-text-color]')].map(node=>({name:node.dataset.textColor,pressed:node.getAttribute('aria-pressed'),label:node.getAttribute('aria-label')||node.textContent.trim()})),
      unsafe:document.querySelectorAll('#messages img[src="x"],#messages [onerror]').length,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1
    };
  })()`);
  const verify = async (name, baseline) => {
    const value=await inspect();
    for(const [index,message] of value.texts.entries()) {
      assert.equal(message.color,colors[name],name+': body color '+index);assert.equal(message.paragraph,colors[name],name+': paragraph color '+index);
      assert.deepEqual(message.box,baseline[index].box,name+': a card/background/padding/border was added');
      assert.equal(message.filter,'none');assert.equal(message.opacity,'1');
    }
    for(const index of [0,1]) {assert.equal(value.texts[index].size,'14px');assert.equal(value.texts[index].weight,'400');}
    assert.deepEqual(value.texts.slice(2).map(({size,weight})=>({size,weight})),baseline.slice(2).map(({size,weight})=>({size,weight})),'Normal conversation font sizing changed');
    assert.deepEqual(value.swatches.filter(item=>item.pressed==='true').map(item=>item.name),[name],'Exactly the selected swatch must be pressed');
    assert.ok(value.swatches.every(item=>item.label&&['true','false'].includes(item.pressed)),'Color swatches need readable labels and pressed states');
    assert.equal(value.code,code);assert.ok(value.tokenColors.length>=3,'Manual color flattened code syntax colors');
    assert.equal(value.unsafe,0);assert.equal(await js('window.__colorUnsafe||null'),null);assert.equal(value.horizontalOverflow,false);
    return value;
  };
  const durablySaved = async name => {
    await js('window.synoraAppearance.settled()');
    assert.equal((await call('getAppearance')).conversationTextColor,name);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'appearance.json'),'utf8')).conversationTextColor,name);
  };
  try {
    await fs.mkdir(output,{recursive:true});await js('window.synoraAppearance.ready');
    originalAppearance=await call('getAppearance');
    assert.equal(originalAppearance.backgroundImage,null,'Color smoke requires fresh/default isolated appearance data');
    await until('renderer idle',()=>js('Boolean(appState&&!projectSwitching&&!running&&!terminalRunning&&!promptSubmitting&&!approvals.size)'));
    win.setSize(1440,1000);await install();
    const baseline=(await inspect()).texts;
    for(const message of baseline.slice(0,2))assert.equal(message.box.background,'rgba(0, 0, 0, 0)','Process commentary must not introduce a backing card');
    await js('window.synoraAppearance.open()');
    const swatches=(await inspect()).swatches;
    assert.deepEqual(swatches.map(item=>item.name).sort(),Object.keys(colors).sort(),'The six requested manual colors are missing');
    for(const name of Object.keys(colors)) {
      stage='native '+name+' swatch';
      await click(`#conversation-text-colors [data-text-color="${name}"]`);
      await until(name+' live preview',()=>js(`getComputedStyle(document.querySelector('[data-run-id="conversation-colors-live"] .message-body')).color===${JSON.stringify(colors[name])}`));
      await verify(name,baseline);await durablySaved(name);
      if(name==='red') {
        await capture('conversation-colors-setting.png');await click('#appearance-close');
        await until('settings closes',()=>js("!document.getElementById('appearance-dialog').open"));
        await capture('conversation-red-preview.png');await js('window.synoraAppearance.open()');
      }
    }
    stage='renderer reload';await click('#appearance-close');await restore();
    const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await loaded;await js('window.synoraAppearance.ready');
    await until('reloaded renderer idle',()=>js('Boolean(appState&&!projectSwitching&&!running&&!terminalRunning&&!promptSubmitting&&!approvals.size)'));
    await install();await verify('black',baseline);await durablySaved('black');
    stage='external appearance notification';await call('setAppearance',{conversationTextColor:'green'});
    await until('external color notification',()=>js(`getComputedStyle(document.querySelector('[data-run-id="conversation-colors-live"] .message-body')).color===${JSON.stringify(colors.green)}`));
    await verify('green',baseline);
    for(const color of [255,0]) {
      stage='import image '+color;const bitmap=Buffer.alloc(8*8*4);
      for(let offset=0;offset<bitmap.length;offset+=4){bitmap[offset]=bitmap[offset+1]=bitmap[offset+2]=color;bitmap[offset+3]=255;}
      const file=path.join(dataDir,`conversation-color-${color}-${randomUUID()}.png`);files.push(file);
      const image=nativeImage.createFromBitmap(bitmap,{width:8,height:8});assert.equal(image.isEmpty(),false);await fs.writeFile(file,image.toPNG());
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});await call('importBackground');await js('window.synoraAppearance.settled()');
      await wait(200);await verify('green',baseline);await durablySaved('green');
    }
    stage='independent resets';await call('resetBackground');await verify('green',baseline);
    await js('window.synoraAppearance.open()');await click('#frost-reset');await js('window.synoraAppearance.settled()');await verify('green',baseline);await durablySaved('green');
    const result={status:'completed',realApi:false,nativeSwatchClicks:true,sixManualColors:true,processHistoryUserAndFinalColored:true,
      noBackingCardsAdded:true,processTextLargerRegular:true,normalFontSizesPreserved:true,codeSyntaxColorsPreserved:true,unsafeCodeStaysText:true,
      persistedAfterEachSelection:true,rendererReloadRestoresColor:true,externalColorEventsApplied:true,backgroundDoesNotOverrideManualChoice:true,
      backgroundAndFrostResetsPreserveColor:true,screenshots:['conversation-colors-setting.png','conversation-red-preview.png']};
    await fs.writeFile(path.join(output,'conversation-colors-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  } catch(error) {
    await fs.writeFile(path.join(output,'conversation-colors-smoke-result.json'),JSON.stringify({status:'failed',stage,error:error.message},null,2)+'\n');
    throw new Error('Conversation colors smoke failed at '+stage+': '+error.message,{cause:error});
  } finally {
    dialog.showOpenDialog=originalChooser;
    if(!win.isDestroyed()) {
      await js("document.getElementById('appearance-dialog')?.close()").catch(()=>{});
      if(originalAppearance?.backgroundImage===null) {
        await call('resetBackground').catch(()=>{});
        await call('setAppearance',Object.fromEntries(['backgroundTransparency','panelFrost','panelTransparency','conversationTextColor','backgroundPreset'].map(field=>[field,originalAppearance[field]]))).catch(()=>{});
        await js('window.synoraAppearance.settled()').catch(()=>{});
      }
      await restore().catch(()=>{});win.setBounds(originalBounds);
    }
    await Promise.all(files.map(file=>fs.unlink(file).catch(()=>{})));
  }
};
