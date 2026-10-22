// Shipped account UI with a mock bridge injected before its IIFE. No request,
// API key, external page or saved user settings is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow } = require('electron');

module.exports = async function smokeDeepseekAccount({ win, output }) {
  assert.equal(win.webContents.isOffscreen(),true);
  const source=await fs.readFile(path.join(__dirname,'../renderer/deepseek-account.js'),'utf8');
  const css=await fs.readFile(path.join(__dirname,'../renderer/deepseek-account.css'),'utf8');
  const result={is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.30',granted_balance:'1.00',topped_up_balance:'11.30'}]};
  const child=new BrowserWindow({width:850,height:720,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true}});
  const js=code=>child.webContents.executeJavaScript(code),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,check)=>{const end=Date.now()+12000;while(Date.now()<end){const value=await check();if(value)return value;await wait(25);}throw new Error('DeepSeek account smoke timed out: '+label);};
  const click=async selector=>{
    await until('visible enabled '+selector,()=>js(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility()&&!document.querySelector(${JSON.stringify(selector)}).disabled)`));
    const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered account control');return p;})()`);
    child.webContents.focus();child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(40);
  };
  const settle=async value=>js(`(()=>{const p=window.__balanceFixture.pending.shift();if(!p)throw new Error('No held fixture balance request');p.resolve(${JSON.stringify(value)});return true;})()`);
  const reset=async settings=>js(`(()=>{const f=window.__balanceFixture;Object.assign(f.state.settings.providers.deepseek,${JSON.stringify(settings || {})});for(const callback of f.listeners)callback({type:'state',state:structuredClone(f.state)});return true;})()`);
  let stage='load shipped UI with mock bridge';
  try{
    await fs.mkdir(output,{recursive:true});await child.loadURL('about:blank');
    await js(`(()=>{
      document.documentElement.innerHTML='<head><title>DeepSeek account fixture</title></head><body><button id="fixture-open">打开设置</button><dialog id="settings-dialog"><form id="settings-form"><h2>模型设置</h2><label>服务商<select id="provider-select"><option value="deepseek">DeepSeek</option><option value="ollama">Ollama</option></select></label><label>服务地址<input id="base-url-input" value="https://api.deepseek.com"></label><label>API Key<input id="api-key-input" type="password" value=""></label><p id="settings-error"></p><button id="fixture-close" type="button">关闭</button></form></dialog></body>';
      const style=document.createElement('style');style.textContent='body{background:#0f1728;color:#dbe7fa;font:14px sans-serif;padding:24px}dialog{background:#1b263d;color:#dbe7fa;border:1px solid #56627b;border-radius:16px;width:560px;padding:26px}label{display:block;margin:12px 0}input,select{display:block;width:100%;box-sizing:border-box;padding:8px;background:#101b30;color:#dbe7fa;border:1px solid #52617a;border-radius:6px}button{cursor:pointer;padding:8px 12px}'+${JSON.stringify(css)};document.head.append(style);
      const f=window.__balanceFixture={calls:[],pending:[],opens:0,listeners:[],trusted:[],state:{settings:{provider:'deepseek',providers:{deepseek:{hasKey:true,baseUrl:'https://api.deepseek.com'}}}}};
      window.forge={getState:()=>Promise.resolve(structuredClone(f.state)),onEvent:callback=>{f.listeners.push(callback);return ()=>{};},
        getDeepSeekBalance:function(){f.calls.push({argumentCount:arguments.length});return new Promise((resolve,reject)=>f.pending.push({resolve,reject}));},
        openDeepSeekAccount:function(){f.opens++;return Promise.resolve({opened:true});}};
      document.getElementById('fixture-open').addEventListener('click',()=>document.getElementById('settings-dialog').showModal());
      document.getElementById('fixture-close').addEventListener('click',()=>document.getElementById('settings-dialog').close());
      document.addEventListener('click',event=>{if(event.target.id)f.trusted.push({id:event.target.id,trusted:event.isTrusted});});return true;
    })()`);
    await js(source);child.setOpacity(0);child.showInactive();child.webContents.focus();
    await until('account section mounted',()=>js(`!!document.getElementById('deepseek-account')`));
    assert.equal(await js('window.__balanceFixture.calls.length'),0,'Loading the module must not query an account');
    await click('#fixture-open');await until('saved official connection ready',()=>js(`!document.getElementById('deepseek-balance-query').disabled`));
    assert.equal(await js('window.__balanceFixture.calls.length'),0,'Opening settings must not query an account');

    stage='native click queries and renders official response fields';
    await click('#deepseek-balance-query');assert.equal(await js('window.__balanceFixture.calls.length'),1);
    assert.equal(await js(`document.getElementById('deepseek-balance-query').disabled`),true);
    await settle(result);await until('official CNY decimal preserved',()=>js(`document.querySelector('.deepseek-balance-total')?.textContent==='CNY 12.30'`));
    assert.equal(await js(`document.querySelector('.deepseek-account-availability').dataset.available`),'true');
    assert.equal(await js(`document.querySelector('.deepseek-balance-details').open`),false);
    await click('.deepseek-balance-details summary');assert.equal(await js(`document.querySelector('.deepseek-balance-details').open`),true);
    assert.deepEqual(await js(`[...document.querySelectorAll('.deepseek-balance-details dd')].map(node=>node.textContent)`),['CNY 1.00','CNY 11.30']);
    assert.equal(await js(`document.getElementById('api-key-input').value`),'');
    await click('#deepseek-account-open');assert.equal(await js('window.__balanceFixture.opens'),1);

    stage='changed official Base URL must not query the old saved connection';
    await click('#base-url-input');
    child.webContents.sendInputEvent({type:'keyDown',keyCode:'a',modifiers:['control']});child.webContents.sendInputEvent({type:'keyUp',keyCode:'a',modifiers:['control']});
    await child.webContents.insertText('https://api.deepseek.com/v1');
    await until('official URL draft requires saving',()=>js(`document.getElementById('deepseek-balance-query').disabled&&document.getElementById('deepseek-balance-values').hidden&&document.getElementById('deepseek-balance-status').textContent.includes('先保存')`));
    assert.equal(await js('window.__balanceFixture.calls.length'),1);
    child.webContents.sendInputEvent({type:'keyDown',keyCode:'a',modifiers:['control']});child.webContents.sendInputEvent({type:'keyUp',keyCode:'a',modifiers:['control']});
    await child.webContents.insertText('https://api.deepseek.com');
    await until('restored exact saved URL ready',()=>js(`!document.getElementById('deepseek-balance-query').disabled`));

    stage='draft input invalidates held query and requires saving key';
    await click('#deepseek-balance-query');assert.equal(await js('window.__balanceFixture.calls.length'),2);
    await click('#api-key-input');await child.webContents.insertText('DRAFT_ONLY_NOT_A_KEY');
    await until('key draft disables account query',()=>js(`document.getElementById('deepseek-balance-query').disabled&&document.getElementById('deepseek-balance-values').hidden&&document.getElementById('deepseek-balance-status').textContent.includes('先保存')`));
    await settle({...result,balance_infos:[{...result.balance_infos[0],total_balance:'999.99'}]});await wait(60);
    assert.equal(await js(`document.getElementById('deepseek-balance-values').textContent.includes('999.99')`),false,'A stale key query must not repaint the account');
    await click('#fixture-close');await js(`document.getElementById('api-key-input').value='';true`);await click('#fixture-open');
    await until('saved key available after reopening',()=>js(`!document.getElementById('deepseek-balance-query').disabled`));
    assert.equal(await js('window.__balanceFixture.calls.length'),2);

    stage='provider and saved-state changes invalidate outstanding balances';
    await click('#deepseek-balance-query');
    await js(`(()=>{const p=document.getElementById('provider-select');p.focus();return true;})()`);
    child.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});child.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
    await until('non DeepSeek provider hides account',()=>js(`document.getElementById('provider-select').value==='ollama'&&document.getElementById('deepseek-account').hidden`));
    await settle(result);assert.equal(await js(`document.getElementById('deepseek-balance-values').hidden`),true);
    child.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});child.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'});
    await until('DeepSeek account returns',()=>js(`!document.getElementById('deepseek-account').hidden&&!document.getElementById('deepseek-balance-query').disabled`));
    await click('#deepseek-balance-query');await reset({hasKey:false});await settle(result);
    assert.equal(await js(`document.getElementById('deepseek-balance-values').hidden&&document.getElementById('deepseek-balance-query').disabled`),true);
    await reset({hasKey:true,baseUrl:'https://relay.invalid/v1'});
    assert.match(await js(`document.getElementById('deepseek-balance-status').textContent`),/自定义服务/u);
    await reset({hasKey:true,baseUrl:'https://api.deepseek.com'});
    await until('official saved state restores query',()=>js(`!document.getElementById('deepseek-balance-query').disabled`));
    await click('#deepseek-balance-query');await settle(result);
    await until('final official values',()=>js(`document.querySelector('.deepseek-balance-total')?.textContent==='CNY 12.30'`));
    assert.ok(await js(`window.__balanceFixture.trusted.some(event=>event.id==='deepseek-balance-query'&&event.trusted)`));
    assert.ok(await js('window.__balanceFixture.calls.every(call=>call.argumentCount===0)'));
    child.webContents.invalidate();await wait(120);await fs.writeFile(path.join(output,'deepseek-account.png'),(await child.webContents.capturePage()).toPNG());
    return{status:'completed',mockBridge:true,realNetwork:false,realApiKey:false,queryOnlyAfterNativeClick:true,
      officialDecimalFields:true,detailsInitiallyCollapsed:true,officialUrlDraftRequiresSave:true,draftInvalidatesPendingQuery:true,providerAndSavedStateIsolation:true,
      unofficialConnectionDisabled:true,noAutomaticQueryOnOpen:true,officialAccountButtonMocked:true,screenshot:'deepseek-account.png'};
  }catch(error){await fs.writeFile(path.join(output,'deepseek-account-failure.json'),JSON.stringify({stage,error:error.message,stack:error.stack,ui:await js(`({text:document.body.textContent,calls:window.__balanceFixture?.calls.length})`).catch(()=>null)},null,2));throw error;}
  finally{if(!child.isDestroyed())child.destroy();}
};
