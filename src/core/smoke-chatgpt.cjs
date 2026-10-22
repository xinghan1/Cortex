// Invoked only by --smoke-test. All credentials and account states below are fake.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { shell } = require('electron');
module.exports = async function smokeChatGPT({ win, store, getConnection, setConnection, broadcastState, requestModel, fetchImpl, output, dataDir }) {
  if (!win.webContents.isOffscreen()) throw new Error('ChatGPT smoke requires an isolated offscreen window');
  if (dataDir && !(await win.webContents.executeJavaScript('window.forge.getState()')).workspace) {
    const fixture = path.join(dataDir, 'chatgpt-smoke-' + randomUUID());
    await fs.mkdir(fixture, { recursive: true }); await fs.writeFile(path.join(fixture, 'hello.js'), 'export const smokeAccount = true;\n');
    await win.webContents.executeJavaScript(`window.forge.openProject({path:${JSON.stringify(fixture)}})`);
  }
  const realConnection = getConnection();
  let profile = 'smoke-profile-a', status = 'disconnected', sharing = false, signIns = 0, storageErrorCode = null, localLogoutWarning = false, retryReads = 0, localBackups = 0;
  const fakeToken = 'forgedesk-smoke-account-token';
  const models = [{ slug: 'smoke-chatgpt', displayName: '模拟账号模型' }];
  let usage = { status: 'not_connected', source: 'unavailable', checkedAt: null, stale: false };
  const publicState = async () => ({
    session: { status: storageErrorCode ? 'reauth_required' : status, sharing: storageErrorCode ? false : sharing, ...(status === 'connected' ? { profileId: profile, identity: { name: '本机测试账号', email: 'smoke@example.invalid' } } : {}), ...(storageErrorCode ? { error: { code: storageErrorCode, message: 'Saved credentials could not be decrypted. Synthetic fixture only.', retryable: true } } : localLogoutWarning ? { error: { code: 'local_disconnect_only', message: 'Synthetic local backup completed; remote revocation not confirmed.', retryable: false } } : {}) },
    profiles: status === 'connected' ? ['smoke-profile-a','smoke-profile-b'].map(id=>({ id, label:id, status:'connected', sharing:true })) : [],
    models: sharing ? models : [],
    usage: { ...usage },
  });
  let rounds = 0;
  const bodies = [], failures = [];
  const runningPrompt = 'SMOKE_ACCOUNT_USAGE_RUNNING_' + randomUUID();
  let heldResponse;
  const originalExternal = shell.openExternal, opened = [];
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => { const end=Date.now()+10000;while(Date.now()<end){const value=await predicate();if(value)return value;await wait(25);}throw new Error('Account usage smoke timed out: '+label); };
  const usageVisible = () => js("Boolean(document.querySelector('#chatgpt-usage-control,#chatgpt-usage-button,#chatgpt-usage-popover'))");
  const accountUsage = async () => (await js('window.forge.getState()')).chatgpt.usage;
  const setUsage = async (next, stale=false) => { usage={status:next,source:['request_succeeded','limit_reached','unavailable','not_eligible'].includes(next)?'official_response':'unavailable',checkedAt:next==='unknown'?null:new Date().toISOString(),stale};await broadcastState(); };
  const assertUsageRemoved = async () => { if(await usageVisible())throw new Error('Removed composer account usage control or popup remains'); };
  const captureUsage = async () => { win.webContents.invalidate();await wait(100);await fs.writeFile(path.join(output,'chatgpt-account-composer.png'),(await win.webContents.capturePage()).toPNG()); };
  const server = http.createServer(async (request, response) => {
    try {
      let data = ''; for await (const chunk of request) data += chunk;
      const body = JSON.parse(data); bodies.push(body); rounds++;
      if (request.headers.authorization !== `Bearer ${fakeToken}`) throw new Error('Mock account credential not applied');
      if (!body.stream || body.store !== false || !body.instructions || body.max_output_tokens !== undefined || body.tools?.[0]?.type !== 'namespace') throw new Error('Account inference contract invalid');
      if (JSON.stringify(body.input).includes(runningPrompt)) { response.writeHead(200, {'Content-Type':'text/event-stream'}); response.write(': held account usage fixture\n\n'); heldResponse = response; return; }
      const items = rounds === 1 ? [
        { type:'reasoning', id:'rs-smoke', summary:[], encrypted_content:'smoke-private-native-state' },
        { type:'function_call', id:'fc-smoke', call_id:'call-smoke', name:'read_file', namespace:'forge', arguments:JSON.stringify({path:'hello.js'}) },
      ] : [{type:'message',role:'assistant',content:[{type:'output_text',text:'账号模式本机模拟验证完成。'}]}];
      response.writeHead(200, {'Content-Type':'text/event-stream'});
      response.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:items,usage:{input_tokens:5,output_tokens:3}}})+'\n\n');
    } catch(error) { failures.push(error.message); if(!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const fakeConnection = {
    publicState,
    redact:value=>String(value).split(fakeToken).join('[已隐藏 ChatGPT 凭据]'),
    signIn:async()=>{ signIns++; status='connected'; sharing=true; usage={status:'unknown',source:'unavailable',checkedAt:null,stale:false}; return publicState(); },
    cancelSignIn:()=>{},
    selectProfile:async id=>{ profile=id; usage={status:'unknown',source:'unavailable',checkedAt:null,stale:false}; return publicState(); },
    listModels:async()=>models,
    retryLocalRead:async()=>{retryReads++;storageErrorCode=null;localLogoutWarning=false;status='connected';sharing=true;usage={status:'unknown',source:'unavailable',checkedAt:null,stale:false};return publicState();},
    disconnect:async()=>{ if(storageErrorCode){localBackups++;storageErrorCode=null;localLogoutWarning=true;}status='disconnected';sharing=false;usage={status:'not_connected',source:'unavailable',checkedAt:null,stale:false};return publicState(); },
    requestModel:async options=>{ const result=await requestModel({...options,provider:'openai',authMode:'chatgpt',apiKey:fakeToken,baseUrl:'https://api.openai.com/v1',fetchImpl:(url,init)=>{
      if(url!=='https://api.openai.com/v1/responses') throw new Error('Account route changed');
      return fetchImpl(endpoint,init);
    }});usage={status:'request_succeeded',source:'official_response',checkedAt:new Date().toISOString(),stale:false};await broadcastState();return result;},
  };
  try {
    shell.openExternal = async url => { if(new URL(url).origin!=='https://chatgpt.com')throw new Error('Unexpected account usage URL');opened.push(url); };
    setConnection(fakeConnection);
    await win.webContents.executeJavaScript("window.forge.saveSettings({provider:'openai',authMode:'apiKey',model:'smoke-api-model',baseUrl:'https://proxy.example.invalid/v1',clearKey:true})");
    await broadcastState();
    if(await usageVisible())throw new Error('Account allowance was visible in API key mode');
    await win.webContents.executeJavaScript(`(async()=>{
      await window.aiCodeCommands.execute('settings');
      const mode=document.getElementById('openai-auth-mode');
      mode.value='chatgpt';mode.dispatchEvent(new Event('change',{bubbles:true}));
      if(!document.getElementById('api-key-field').hidden||!document.getElementById('base-url-field').hidden||!document.getElementById('api-key-input').disabled) throw new Error('Account mode exposed API fields');
      if(document.getElementById('model-input')||document.querySelector('[id^="settings-reasoning-"]'))throw new Error('Removed manual settings controls remain');
      if(!document.getElementById('save-settings').disabled)throw new Error('Account settings saved without a fetched catalog');
      document.getElementById('close-settings').click();
      await window.forge.saveSettings({provider:'openai',authMode:'chatgpt',model:'smoke-chatgpt'});
      const config=(await window.forge.getState()).settings;
      if(config.authMode!=='chatgpt'||config.hasKey||config.baseUrl!=='https://proxy.example.invalid/v1') throw new Error('Account settings not saved independently');
      let blocked=false;
      try{await window.forge.runTask({text:'must not run without login'});}catch(error){blocked=error.message.includes('登录 ChatGPT');}
      if(!blocked) throw new Error('Disconnected account was allowed to infer');
      await window.aiCodeCommands.execute('settings');
    })()`);
    win.webContents.invalidate();
    await new Promise(resolve=>setTimeout(resolve,100));
    await fs.writeFile(path.join(output,'chatgpt-login.png'),(await win.webContents.capturePage()).toPNG());
    status='connected';sharing=false;usage={status:'not_authorized',source:'unavailable',checkedAt:null,stale:false};await broadcastState();
    await win.webContents.executeJavaScript(`(async()=>{
      let blocked=false;
      try{await window.forge.runTask({text:'must not run without plan permission'});}catch(error){blocked=error.message.includes('套餐');}
      if(!blocked) throw new Error('Identity-only account was allowed to infer');
      await signInChatGPT();
      if(!document.getElementById('chatgpt-identity').textContent.includes('smoke@example.invalid')) throw new Error('Account identity not shown');
      document.getElementById('settings-model-refresh').click();
      for(let i=0;i<100&&document.getElementById('chatgpt-model-select').options.length!==2;i++)await new Promise(resolve=>setTimeout(resolve,25));
      if(document.getElementById('chatgpt-model-select').options.length!==2) throw new Error('Account model catalog not shown');
      document.getElementById('close-settings').click();
    })()`);
    if(signIns!==1) throw new Error('Sign-in must require one explicit user action');
    const run = text=>win.webContents.executeJavaScript(`(async()=>{
      const ended=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{off();reject(new Error('Account task timed out'));},10000);
        const off=window.forge.onEvent(event=>{if(event.type==='run-end'){clearTimeout(timer);off();resolve(event);}});
      });
      await window.forge.runTask({text:${JSON.stringify(text)}});
      const result=await ended;
      if(result.status!=='completed') throw new Error(result.error||'Account task failed');
      return await window.forge.getState();
    })()`);
    const before=(await store.usageStats()).day.totalTokens;
    const accountA = await run('SMOKE_ACCOUNT_A_CONTEXT');
    const returned=await win.webContents.executeJavaScript(`window.forge.getSession({id:${JSON.stringify(accountA.sessionId)}})`);
    if(JSON.stringify(returned).includes('providerState')||JSON.stringify(returned).includes('smoke-private-native-state')) throw new Error('Native reasoning state exposed to renderer');
    if(!bodies[1]?.input.some(item=>item.type==='reasoning'&&item.encrypted_content==='smoke-private-native-state')) throw new Error('Account reasoning state not replayed');
    await setUsage('limit_reached');await assertUsageRemoved();
    if((await accountUsage()).status!=='limit_reached')throw new Error('Account status was lost when removing the usage control');
    await win.webContents.executeJavaScript(`window.forge.chatgptSelectProfile({id:'smoke-profile-b'})`);
    await until('profile switch clears previous usage',async()=>(await accountUsage()).status==='unknown'&&!(await usageVisible()));
    if((await js('window.forge.getState()')).chatgpt.usage.checkedAt!==null)throw new Error('Profile switch retained the previous account check time');
    const accountB=await run('SMOKE_ACCOUNT_B_CONTEXT');
    if(accountB.sessionId===accountA.sessionId||JSON.stringify(bodies[2].input).includes('SMOKE_ACCOUNT_A_CONTEXT')) throw new Error('Account switch reused another account context');
    await win.webContents.executeJavaScript(`window.forge.getSession({id:${JSON.stringify(accountA.sessionId)}})`);
    const reopened=await run('SMOKE_ACCOUNT_B_REOPENED');
    if(reopened.sessionId===accountA.sessionId||JSON.stringify(bodies[3].input).includes('SMOKE_ACCOUNT_A_CONTEXT')) throw new Error('Loaded account history bypassed account isolation');
    if(rounds!==4||failures.length) throw new Error('Account mock rounds failed: '+failures.join(', '));
    for(const next of ['unknown','request_succeeded','limit_reached','unavailable','not_eligible']) {
      await setUsage(next);await assertUsageRemoved();
      if((await accountUsage()).status!==next)throw new Error('Internal account status changed unexpectedly');
    }
    await setUsage('request_succeeded',true);await assertUsageRemoved();
    if((await accountUsage()).stale!==true)throw new Error('Internal stale status was discarded');
    await js("window.aiCodeCommands.execute('settings')");
    await js("document.getElementById('chatgpt-open-usage').click()");await until('settings official page stub called',()=>opened.length===1);
    await until('settings usage action completed',()=>js('!chatgptBusy'));
    await js("document.getElementById('close-settings').click()");
    if(!opened[0].includes('/settings/usage'))throw new Error('Official settings usage entry changed');
    await setUsage('unknown');
    const pending = run(runningPrompt);await until('account inference held',()=>heldResponse);
    if(!(await js('window.forge.getState()')).activeTask.running)throw new Error('Running account fixture did not remain active');
    await assertUsageRemoved();await captureUsage();
    if(!(await js('window.forge.getState()')).activeTask.running||heldResponse.writableEnded)throw new Error('Checking the composer interrupted model inference');
    heldResponse.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Account usage interaction did not interrupt this request.'}]}],usage:{input_tokens:5,output_tokens:3}}})+'\n\n');
    await pending;heldResponse=null;
    if(rounds!==5||failures.length)throw new Error('Account usage triggered extra model/quota probes');
    const counted=store.usageStats().day.totalTokens-before;
    if(counted!==40) throw new Error('Account token ledger incorrect');
    await js("window.forge.saveSettings({provider:'openai',authMode:'apiKey',model:'smoke-api-model'})");
    await assertUsageRemoved();
    await js("window.forge.saveSettings({provider:'openai',authMode:'chatgpt',model:'smoke-chatgpt'})");
    await js("window.aiCodeCommands.execute('settings')");
    storageErrorCode='storage_decryption_failed';await broadcastState();
    await until('storage error UI',()=>js("document.getElementById('chatgpt-status').textContent==='本机登录信息读取失败'"));
    const storageControls=await js("(()=>{const get=id=>document.getElementById(id);return{sharing:get('chatgpt-sharing').textContent,retry:get('chatgpt-reconnect').textContent,signInHidden:get('chatgpt-sign-in').hidden,signInDisabled:get('chatgpt-sign-in').disabled,addDisabled:get('chatgpt-add-profile').disabled,profileDisabled:get('chatgpt-profile-select').disabled,logoutDisabled:get('chatgpt-disconnect').disabled,message:get('chatgpt-message').textContent};})()");
    if(storageControls.sharing!=='套餐用量：暂无法读取授权状态'||storageControls.retry!=='重试读取'||!storageControls.signInHidden||!storageControls.signInDisabled||!storageControls.addDisabled||!storageControls.profileDisabled||storageControls.logoutDisabled)throw new Error('Storage read error was treated as an OAuth permission error');
    if(!storageControls.message.includes('无法解密本机保存')||(storageControls.message.match(/storage_decryption_failed/gu)||[]).length!==1||storageControls.message.includes('Saved credentials'))throw new Error('Storage error was not translated and deduplicated');
    await js('signInChatGPT()');if(signIns!==1)throw new Error('Storage error triggered browser reauthorization');
    await js("document.getElementById('chatgpt-reconnect').click()");await until('local retry recovered',()=>retryReads===1);
    await until('retry UI recovered',()=>js("!chatgptBusy&&document.getElementById('chatgpt-status').textContent==='已登录'"));
    if(rounds!==5||signIns!==1)throw new Error('Retrying local storage started OAuth or inference');
    storageErrorCode='storage_decryption_failed';await broadcastState();await until('second storage error',()=>js("document.getElementById('chatgpt-reconnect').textContent==='重试读取'"));
    win.webContents.invalidate();await wait(100);await fs.writeFile(path.join(output,'chatgpt-storage-read-error.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.getElementById('chatgpt-disconnect').click()");await until('local storage logout',()=>localBackups===1);
    await until('local logout warning visible',()=>js("!chatgptBusy&&document.getElementById('chatgpt-status').textContent==='未连接'&&document.getElementById('chatgpt-message').textContent.includes('原登录文件已备份')"));
    const warning=await js("document.getElementById('chatgpt-message').textContent");if(!warning.includes('无法确认服务端撤销')||!warning.includes('local_disconnect_only'))throw new Error('Local logout falsely claimed remote revocation');
    if(await js("document.getElementById('chatgpt-sign-in').hidden||document.getElementById('chatgpt-sign-in').disabled"))throw new Error('Local logout did not restore normal sign-in');
    win.webContents.invalidate();await wait(100);await fs.writeFile(path.join(output,'chatgpt-local-storage-logout.png'),(await win.webContents.capturePage()).toPNG());
    await until('disconnect hides usage',async()=>!(await usageVisible()));
    if((await js('window.forge.getState()')).chatgpt.usage.status!=='not_connected')throw new Error('Disconnect retained an account usage status');
    return {status:'completed',modelRounds:rounds,tokensRecorded:counted,disconnectedBlocked:true,sharingRequired:true,accountHistoryIsolated:true,nativeStatePrivate:true,realLogin:false,actualQuotaNotClaimed:true,requestStatesKeptInternal:true,staleStatusPreserved:true,composerUsageRemoved:true,profileUsageIsolated:true,disconnectClearsUsage:true,modelInferenceUnaffected:true,settingsOfficialUsageLinkStubbed:opened.length,noQuotaProbe:true,storageErrorNotOAuth:true,localRetryWithoutOAuth:true,localLogoutBackupWarning:true,remoteRevocationNotClaimed:true,screenshots:['chatgpt-login.png','chatgpt-account-composer.png','chatgpt-storage-read-error.png','chatgpt-local-storage-logout.png']};
  } catch (error) {
    console.error('SMOKE_CHATGPT_DIAGNOSTIC', JSON.stringify({ rounds, failures, error: error.message }));
    throw error;
  } finally {
    shell.openExternal = originalExternal;
    setConnection(realConnection);
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
    await win.webContents.executeJavaScript("window.forge.saveSettings({provider:'openai',authMode:'apiKey',model:'',baseUrl:'https://api.openai.com/v1',clearKey:true})");
    await broadcastState();
  }
};
