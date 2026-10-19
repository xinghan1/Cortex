// Local integration fixtures only; never uses an account or contacts a model service.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
module.exports = async function smokeControls({ win, store, output, broadcastState }) {
  let catalogRequests = 0, modelRequests = 0;
  const problems = [];
  const server = http.createServer(async (request, response) => {
    try {
      if(request.headers.authorization!=='Bearer forgedesk-controls-key') throw new Error('Catalog credential missing');
      if(request.method==='GET' && request.url==='/v1/models') {
        catalogRequests++;
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({data:[
          {id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',effort:{supported_levels:['low','high','max'],default_level:'high'},input_modalities:['text'],output_modalities:['text']},
          {id:'smoke-basic',name:'仅默认强度的测试模型',reasoningEfforts:[],supportsTools:true},
        ]})); return;
      }
      let raw='';for await(const chunk of request) raw+=chunk;
      const body=JSON.parse(raw);modelRequests++;
      if(request.url!=='/v1/chat/completions'||body.model!=='deepseek-flash'||body.reasoning_effort!=='max'||body.thinking?.type!=='enabled') throw new Error('DeepSeek model ID or thinking effort incorrect');
      if(modelRequests===2 && !body.messages.some(message=>message.role==='assistant'&&message.reasoning_content==='smoke-private-deepseek-reasoning')) throw new Error('DeepSeek reasoning history lost');
      const message=modelRequests===1 ? {role:'assistant',content:'',reasoning_content:'smoke-private-deepseek-reasoning',tool_calls:[{id:'control-read',type:'function',function:{name:'read_file',arguments:'{"path":"hello.js"}'}}]}
        : {role:'assistant',content:'DeepSeek 目录、推理强度与工具回传验证完成。',reasoning_content:'smoke-private-final-reasoning'};
      response.writeHead(200,{'Content-Type':'application/json'});
      response.end(JSON.stringify({choices:[{index:0,message,finish_reason:modelRequests===1?'tool_calls':'stop'}],usage:{prompt_tokens:6,completion_tokens:4}}));
    } catch(error) {problems.push(error.message);response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message,code:'smoke_contract_error'}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
    await win.webContents.executeJavaScript(`window.forge.saveSettings(${JSON.stringify({provider:'deepseek',model:'DeepSeek-V4.1-Flash-1017',baseUrl,apiKey:'forgedesk-controls-key',reasoningEffort:'default'})})`);
    await broadcastState();
    await win.webContents.executeJavaScript(`(async()=>{
      await window.aiCodeCommands.execute('settings');
      if(document.getElementById('model-input')||document.querySelector('[id^="settings-reasoning-"]'))throw new Error('Settings retained manual model or reasoning controls');
      if(!document.getElementById('save-settings').disabled)throw new Error('Settings save enabled without a fetched model catalog');
      document.getElementById('settings-form').requestSubmit();
      await new Promise(resolve=>setTimeout(resolve,100));
      const unchanged=(await window.forge.getState()).settings;
      if(!document.getElementById('settings-dialog').open||unchanged.model!=='DeepSeek-V4.1-Flash-1017'||!unchanged.hasKey) throw new Error('Settings saved without selecting a fetched model');
      document.getElementById('close-settings').click();
      await window.forge.saveSettings({provider:'deepseek',model:'DeepSeek-V4.1-Flash-1017',reasoningEffort:'default',maxSteps:4});
      await window.forge.newSession();
      document.getElementById('model-reasoning-trigger').click();
      if(document.getElementById('reasoning-popup').hidden) throw new Error('Reasoning popup did not open');
      document.getElementById('popup-model-button').click();
      for(let i=0;i<80&&!document.querySelector('#model-list-panel .model-option');i++) await new Promise(resolve=>setTimeout(resolve,25));
      if(document.querySelectorAll('#model-list-panel .model-option').length!==2) throw new Error('Fetched model list not rendered');
      const search=document.getElementById('model-search');search.value='flash';search.dispatchEvent(new Event('input',{bubbles:true}));
      if(document.querySelectorAll('#model-list-panel .model-option').length!==1) throw new Error('Model search did not filter');
    })()`);
    win.webContents.invalidate();await new Promise(resolve=>setTimeout(resolve,180));
    await fs.writeFile(path.join(output,'model-picker.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(async()=>{
      const slider=document.getElementById('reasoning-effort');
      const ready=async(label,predicate)=>{
        let state;
        for(let i=0;i<100;i++){
          state=await window.forge.getState();
          if(predicate(state))return state;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error(label+': '+JSON.stringify({model:state?.settings?.model,effort:state?.settings?.reasoningEffort,renderedModel:appState?.settings?.model,renderedEffort:appState?.settings?.reasoningEffort,modelSaving,reasoningSaving,sliderDisabled:slider.disabled,sliderEffort:slider.dataset.effort,sliderMax:slider.max,isMax:slider.classList.contains('is-max')}));
      };
      document.querySelector('#model-list-panel .model-option').click();
      // Main state changes before selectCurrentModel's awaited IPC/finally has unlocked the renderer.
      // Send the slider events once, only after its actual user-visible interaction state is ready.
      await ready('Selected model did not become interactive',state=>state.settings.model==='deepseek-flash'&&appState?.settings?.model==='deepseek-flash'&&!modelSaving&&!reasoningSaving&&!slider.disabled);
      if(document.getElementById('reasoning-popup').hidden) document.getElementById('model-reasoning-trigger').click();
      if(slider.max!=='3') throw new Error('DeepSeek reasoning capabilities not applied');
      slider.value=slider.max;slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));
      await ready('Maximum effort did not finish persisting',state=>state.settings.reasoningEffort==='max'&&appState?.settings?.reasoningEffort==='max'&&!modelSaving&&!reasoningSaving&&!slider.disabled&&slider.dataset.effort==='max'&&slider.classList.contains('is-max'));
    })()`);
    win.webContents.invalidate();await new Promise(resolve=>setTimeout(resolve,200));
    await fs.writeFile(path.join(output,'reasoning-card.png'),(await win.webContents.capturePage()).toPNG());
    const card = await win.webContents.executeJavaScript(`(()=>{const rect=document.getElementById('reasoning-popup').getBoundingClientRect();return {x:Math.floor(rect.x)-8,y:Math.floor(rect.y)-8,width:Math.ceil(rect.width)+16,height:Math.ceil(rect.height)+62};})()`);
    await fs.writeFile(path.join(output,'reasoning-card-detail.png'),(await win.webContents.capturePage(card)).toPNG());
    const animation = await win.webContents.executeJavaScript(`(async()=>{
      const range=document.getElementById('reasoning-effort'),thumb=document.getElementById('reasoning-thumb');
      const start=thumb.getBoundingClientRect().x;
      const began=performance.now();
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
      range.value='0';range.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(resolve));
      await new Promise(resolve=>setTimeout(resolve,25));
      const middle=thumb.getBoundingClientRect().x;
      const elapsedMiddle=performance.now()-began;
      await new Promise(resolve=>setTimeout(resolve,180));
      const end=thumb.getBoundingClientRect().x;
      if(!reduced&&!(middle<start&&middle>end)) throw new Error('Reasoning thumb position did not transition: '+JSON.stringify({start,middle,end,elapsedMiddle,elapsedEnd:performance.now()-began,value:range.value,effort:range.dataset.effort,fill:range.dataset.fill,support:range.dataset.support,disabled:range.disabled,visualFill:range.closest('.reasoning-slider-visual').dataset.fill,dragging:range.closest('.reasoning-slider-visual').classList.contains('is-dragging'),transition:getComputedStyle(thumb).transitionDuration,left:getComputedStyle(thumb).left,savedEffort:appState?.settings?.reasoningEffort}));
      range.value=range.max;range.dispatchEvent(new Event('input',{bubbles:true}));
      return {reducedMotion:reduced,positionTransition:reduced?'system-disabled':true};
    })()`);
    const details=await win.webContents.executeJavaScript(`(async()=>{
      await window.forge.listModels();
      await window.forge.selectModel({model:'smoke-basic'});
      const basic=await window.forge.getState();
      if(basic.settings.reasoningEffort!=='default') throw new Error('Unsupported old reasoning effort retained');
      let blocked=false;try{await window.forge.setReasoningEffort({reasoningEffort:'max'});}catch{blocked=true;}
      if(!blocked) throw new Error('Known unsupported effort accepted');
      await window.forge.selectModel({model:'deepseek-flash'});
      await window.forge.setReasoningEffort({reasoningEffort:'max'});
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      if(!document.getElementById('reasoning-popup').hidden) throw new Error('Escape did not dismiss popup');
      const ended=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{off();reject(new Error('DeepSeek smoke task timed out'));},10000);
        const off=window.forge.onEvent(event=>{if(event.type==='run-end'){clearTimeout(timer);off();resolve(event);}});
      });
      await window.forge.runTask({text:'使用选中的 DeepSeek 模型读取 hello.js。'});
      const result=await ended;if(result.status!=='completed') throw new Error(result.error||'DeepSeek task failed');
      if(document.body.innerText.includes('smoke-private-deepseek-reasoning')) throw new Error('Raw reasoning exposed to UI');
      const handle=document.getElementById('sidebar-resizer');
      handle.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      const start=document.querySelector('.sidebar').getBoundingClientRect().width;
      handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      const keyboard=document.querySelector('.sidebar').getBoundingClientRect().width;
      if(keyboard<=start) throw new Error('Sidebar keyboard resize failed');
      handle.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      const rect=handle.getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2),start,keyboard};
    })()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:details.x,y:details.y});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:details.x,y:details.y});
    win.webContents.sendInputEvent({type:'mouseMove',x:details.x+100,y:details.y});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:details.x+100,y:details.y});
    await new Promise(resolve=>setTimeout(resolve,100));
    const resized=await win.webContents.executeJavaScript(`document.querySelector('.sidebar').getBoundingClientRect().width`);
    if(resized<details.start+75) throw new Error('Sidebar pointer resize failed: '+resized);
    win.webContents.invalidate();
    await fs.writeFile(path.join(output,'resized-sidebar.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.getElementById('sidebar-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    if(modelRequests!==2||problems.length) throw new Error('DeepSeek mock contract failed: '+problems.join(', '));
    if(catalogRequests!==1) throw new Error('Repeated cached model fetch contacted service '+catalogRequests+' times');
    return {status:'completed',catalogRequests,modelRequests,modelId:'deepseek-flash',dynamicEfforts:true,catalogRequiredBeforeSettingsSave:true,animation,sidebarStart:details.start,sidebarResized:resized,realApi:false};
  } finally {
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
    await win.webContents.executeJavaScript("window.forge.saveSettings({provider:'deepseek',model:'',baseUrl:'https://api.deepseek.com',clearKey:true,reasoningEffort:'default'})");
    await broadcastState();
  }
};
