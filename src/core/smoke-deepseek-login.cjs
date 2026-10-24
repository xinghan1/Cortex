// Native account/settings exercise with synthetic authorization and inference.
// Only the actual HTTP callback is used; no browser or external server is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { safeStorage } = require('electron');

module.exports = async function smokeDeepSeekLogin({ win, output, dataDir, store, readConnection, writeConnection,
  broadcastState, requestModel, roleModels, roleRuntime, roleDeepseekAccounts }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'The packaged connection must use real OS encryption');
  const { DeepSeekConnection, DEEPSEEK_ACCOUNT_BASE } = await import('./deepseek-login.mjs');
  const original = readConnection(), originalRole = roleDeepseekAccounts.get('sidebar');
  const project = path.join(dataDir, 'deepseek-login-smoke-' + randomUUID());
  const apiKey = 'SYNORA_ISOLATED_DEEPSEEK_API_KEY', secrets = [apiKey], callbacks = [], connections = [], requests = [], browserOpens = [], inference = [], screenshots = [];
  const controls = { hold: true };
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(25); }
    throw new Error('DeepSeek login smoke timed out: ' + label);
  };
  const capture = async name => { win.webContents.invalidate(); await wait(150); await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); screenshots.push(name); };
  const click = async selector => {
    const point = await until('clickable ' + selector, () => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null})()`));
    win.webContents.focus();
    for (const type of ['mouseMove','mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
  };
  const loopback = address => new Promise((resolve, reject) => {
    const target = new URL(address); assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.pathname, '/oauth/callback');
    const request = http.get(target, response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode, location: response.headers.location })); });
    request.once('error', reject); request.setTimeout(10000, () => request.destroy(new Error('Fixture callback timed out')));
  });
  const envelope = data => Response.json({code:0,data:{biz_code:0,biz_data:data}});
  const build = async (directory, label) => {
    const token = 'SYNORA_ISOLATED_DEEPSEEK_ACCOUNT_' + label; secrets.push(token); let authorization;
    const connection = new DeepSeekConnection({ dataDir: directory, safeStorage, version: require('../../package.json').version,
      onChange: () => broadcastState(), fetchImpl: async (address, init) => {
        const url = new URL(address), body = init.body ? JSON.parse(init.body) : undefined;
        assert.equal(init.redirect, 'error'); requests.push({scope:label,path:url.pathname});
        if (url.origin === 'https://platform.deepseek.com' && url.pathname.endsWith('/auth_init')) {
          authorization = body; assert.equal(body.code_challenge_method, 'S256');
          return envelope({authorize_id:randomUUID(),authorize_url:'https://platform.deepseek.com/dsh/authorize?fixture='+label,expires_in:600});
        }
        if (url.origin === 'https://platform.deepseek.com' && url.pathname.endsWith('/auth_exchange')) {
          assert.equal(body.redirect_uri, authorization.redirect_uri); assert.ok(body.code_verifier);
          return envelope({token,authorized_url:'https://platform.deepseek.com/dsh/authorized',user:{email:label+'****@example.invalid',id_profile:{name:'隔离账号 '+label}}});
        }
        if (url.origin === 'https://api.deepseek.com' && url.pathname === '/models') {
          assert.equal(new Headers(init.headers).get('x-dsh-auth-token'), token);
          return Response.json({data:[{id:'deepseek-flash',name:'DeepSeek Flash',api_capabilities:{anthropic_messages:{}},input_modalities:['text'],output_modalities:['text'],context_window:1000000,max_output_tokens:256000}]});
        }
        assert.equal(url.origin, 'https://platform.deepseek.com'); assert.ok(/\/(?:auth_cancel|logout)$/u.test(url.pathname)); return envelope({});
      }, openExternal: async address => {
        const url = new URL(address); assert.equal(url.origin,'https://platform.deepseek.com'); assert.equal(url.pathname,'/dsh/authorize'); browserOpens.push({scope:label,path:url.pathname});
        if (!controls.hold) {
          const callback = new URL(authorization.redirect_uri); callback.searchParams.set('state',authorization.state); callback.searchParams.set('code','SYNORA_FAKE_CALLBACK_CODE_'+label);
          const pending = loopback(callback); void pending.catch(()=>{}); callbacks.push(pending);
        }
      } });
    await connection.init();
    const dispatch = connection.requestModel.bind(connection);
    connection.requestModel = options => dispatch({...options,requestModel:config => (options.requestModel || requestModel)({...config,fetchImpl:async (address, init) => {
      assert.equal(address,DEEPSEEK_ACCOUNT_BASE+'/messages'); const headers = new Headers(init.headers);
      assert.equal(headers.get('x-dsh-auth-token'),token); assert.equal(headers.has('authorization'),false); assert.equal(headers.has('x-api-key'),false);
      const body = JSON.parse(init.body); assert.equal(body.model,'deepseek-flash'); inference.push({scope:label,model:body.model});
      return Response.json({id:'isolated-'+randomUUID(),type:'message',role:'assistant',model:'deepseek-flash',content:[{type:'text',text:'DeepSeek 隔离账号调用验证完成。'}],stop_reason:'end_turn',usage:{input_tokens:8,output_tokens:4}});
    }})});
    connections.push(connection); return connection;
  };
  const noRendererSecrets = async () => {
    const encoded = JSON.stringify(await call('getState')) + await js('document.body.textContent') + await js("[...document.querySelectorAll('input')].map(n=>n.value).join(' ')");
    for (const secret of secrets) assert.equal(encoded.includes(secret),false,'A synthetic private credential entered public state/UI');
    assert.equal(encoded.includes('code_verifier'),false);
  };
  const chooseAccount = async () => {
    await js("(()=>{const p=document.getElementById('provider-select');p.value='deepseek';p.dispatchEvent(new Event('change',{bubbles:true}));const m=document.getElementById('deepseek-auth-mode');m.value='deepseek-account';m.dispatchEvent(new Event('change',{bubbles:true}));})()");
    assert.equal(await js("document.getElementById('api-key-field').hidden&&document.getElementById('base-url-field').hidden&&!document.getElementById('deepseek-login-panel').hidden"),true);
    assert.equal(await js("document.getElementById('deepseek-login-url').textContent"),DEEPSEEK_ACCOUNT_BASE);
  };
  const selectAndSave = async () => {
    await click('#deepseek-login-models');
    await until('official catalog ready', () => js("!document.getElementById('chatgpt-model-select').disabled&&[...document.getElementById('chatgpt-model-select').options].some(n=>n.value==='deepseek-flash')"));
    await js("(()=>{const n=document.getElementById('chatgpt-model-select');n.value='deepseek-flash';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click('#save-settings'); await until('settings save completed', () => js("!document.getElementById('settings-dialog').open"));
  };
  let mainConnection, roleConnection;
  try {
    await until('DeepSeek account renderer initialized',()=>js('Boolean(window.synoraDeepSeekLogin&&appState&&!projectSwitching)'));
    await fs.mkdir(project,{recursive:true}); await fs.writeFile(path.join(project,'sample.txt'),'isolated DeepSeek account fixture\n');
    await call('openProject',{path:project});
    mainConnection = await build(dataDir,'MAIN'); roleConnection = await build(path.join(dataDir,'role-accounts','sidebar'),'SIDEBAR');
    writeConnection(mainConnection); roleDeepseekAccounts.set('sidebar',roleConnection); await broadcastState();
    await call('saveSettings',{provider:'deepseek',authMode:'apiKey',model:'api-key-model',apiKey,baseUrl:'https://api.deepseek.com/v1'});
    await js("window.aiCodeCommands.execute('settings')"); await chooseAccount();
    assert.equal(await js("document.getElementById('save-settings').disabled"),true);
    await click('#deepseek-login-sign-in');
    await until('pending browser authorization',async()=>(await mainConnection.publicState()).attempt?.phase==='waiting-browser');
    await capture('deepseek-login-waiting-browser.png'); await click('#deepseek-login-cancel');
    await until('cancel restores usable sign-in',()=>js("!document.getElementById('deepseek-login-sign-in').hidden&&!document.getElementById('deepseek-login-sign-in').disabled"));
    assert.equal((await mainConnection.publicState()).session.status,'disconnected');
    controls.hold=false; await click('#deepseek-login-sign-in');
    await until('main login complete',()=>js("document.getElementById('deepseek-login-status').textContent==='已登录'&&!document.getElementById('deepseek-login-models').disabled"));
    const connected = await mainConnection.publicState(); assert.equal(connected.session.sharing,true);
    const encrypted = JSON.parse(await fs.readFile(path.join(dataDir,'deepseek-account.json'),'utf8'));
    assert.ok(encrypted.encryptedGrant); assert.equal(JSON.stringify(encrypted).includes(secrets[1]),false);
    assert.equal(JSON.parse(safeStorage.decryptString(Buffer.from(encrypted.encryptedGrant,'base64'))).token,secrets[1]);
    await capture('deepseek-login-connected.png'); await noRendererSecrets(); await selectAndSave();
    let state = await call('getState'); assert.equal(state.settings.authMode,'deepseek-account'); assert.equal(state.settings.model,'deepseek-flash'); assert.equal(store.key('deepseek'),apiKey);
    const restored = await build(dataDir,'MAIN'); assert.deepEqual((await restored.publicState()).session,connected.session); writeConnection(restored); await broadcastState();
    win.webContents.reload(); await until('renderer reload',()=>js('Boolean(window.synoraDeepSeekLogin&&appState&&!projectSwitching)'));
    state=await call('getState'); assert.equal(state.deepseek.session.profileId,connected.session.profileId); assert.equal(state.settings.authMode,'deepseek-account');
    await js("(async()=>{const end=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('DeepSeek run timed out'));},15000);const off=window.forge.onEvent(e=>{if(e.type==='run-end'){clearTimeout(timer);off();resolve(e);}})});await window.forge.runTask({text:'本机隔离登录回归，请直接回复一句完成。'});const result=await end;if(result.status!=='completed')throw new Error(result.error||'Isolated account request failed');})()");
    assert.ok(inference.some(value=>value.scope==='MAIN'));
    await js("window.synoraRoleModels.open('sidebar')"); await chooseAccount();
    assert.equal(await js("document.getElementById('deepseek-login-status').textContent"),'未连接');
    await click('#deepseek-login-sign-in'); await until('independent role login',()=>js("document.getElementById('deepseek-login-status').textContent==='已登录'&&!document.getElementById('deepseek-login-models').disabled"));
    await selectAndSave(); assert.equal(roleModels.isEnabled('sidebar'),true);
    const config=await roleRuntime.config('sidebar'); assert.equal(config.authMode,'deepseek-account'); assert.notEqual(config.deepseekProfileId,connected.session.profileId);
    await roleRuntime.dispatch({...config,messages:[{role:'user',content:'侧边问答隔离测试'}],tools:[]}); assert.ok(inference.some(value=>value.scope==='SIDEBAR'));
    await noRendererSecrets();
    await js("window.aiCodeCommands.execute('settings')"); await chooseAccount(); await click('#deepseek-login-disconnect');
    await until('main local logout',()=>js("document.getElementById('deepseek-login-status').textContent==='未连接'&&!document.getElementById('deepseek-login-sign-in').disabled"));
    assert.equal((await roleConnection.publicState()).session.status,'connected'); assert.equal(store.key('deepseek'),apiKey);
    await capture('deepseek-login-disconnected.png'); await noRendererSecrets();
    const callbackResults=await Promise.all(callbacks); assert.ok(callbackResults.every(value=>value.status===303&&new URL(value.location).origin==='https://platform.deepseek.com'));
    return {status:'completed',version:require('../../package.json').version,externalConnections:0,browserLaunched:false,realOsEncryptedGrant:true,pkceLoopbackCallback:true,nativeSignInCancelDisconnect:true,
      accountCatalogAndModelSave:true,rendererReloadRestoresAccount:true,apiKeyPreserved:true,officialMessagesAccountHeader:true,independentRoleAccount:true,rendererHasNoCredentials:true,
      callbacks:callbackResults.length,authorizationRequests:requests.length,stubbedBrowserOpens:browserOpens.length,inference,screenshots};
  } catch (failure) {
    if (!win.isDestroyed()) await capture('deepseek-login-failure.png').catch(()=>{});
    await fs.writeFile(path.join(output,'deepseek-login-failure.json'),JSON.stringify({error:failure.message,stack:failure.stack,requests,inference,screenshots},null,2));
    throw failure;
  } finally {
    await call('stopTask').catch(()=>{}); await js("document.getElementById('settings-dialog').close()").catch(()=>{});
    await roleRuntime.reset('sidebar').catch(()=>{}); writeConnection(original); roleDeepseekAccounts.set('sidebar',originalRole);
    for (const connection of connections) await connection.dispose().catch(()=>{});
    await Promise.allSettled(callbacks); await broadcastState().catch(()=>{});
  }
};
