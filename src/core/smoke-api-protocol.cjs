// Exercise compatible relay settings and a real read-only agent tool loop in an
// isolated offscreen app window. All HTTP requests go to this loopback fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeApiProtocol({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'API protocol smoke requires an isolated offscreen parent');
  const suffix = randomUUID();
  const project = path.join(dataDir, 'api-protocol-project-' + suffix);
  const filename = 'compatible-fixture.txt';
  const fixture = 'READ_ONLY_COMPATIBLE_FACT_' + suffix + '\n';
  const prompt = '读取 compatible-fixture.txt，并简要说明其中的标记。PROTOCOL_TASK_' + suffix;
  const finalText = '兼容协议已完成读取和回复。PROTOCOL_FINISHED_' + suffix;
  const apiKey = 'forgedesk-compatible-fixture-key';
  const model = 'compatible-model';
  const diagnosticModel = 'gemini-4-argon-high';
  const diagnosticPrompts = Object.fromEntries(['group', 'route', 'timeout'].map(name => [name, 'PROTOCOL_DIAGNOSTIC_' + name.toUpperCase() + '_' + suffix]));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('API protocol smoke timed out: ' + label);
  };
  const original = await win.webContents.executeJavaScript('window.forge.getState()');
  assert.equal(original.activeTask.running, false);
  assert.ok(original.settings.providers.relay, 'Independent relay provider is missing');
  // No renderer bridge ever exposes saved secrets. This helper only replaces a
  // blank relay credential in the disposable smoke data directory.
  assert.equal(original.settings.providers.relay.hasKey, false, 'Refusing to replace an existing relay credential');
  let child, configured = false, modelGets = 0, reasoningCardChecked = false, fixtureBaseUrl = '';
  const requests = [], problems = [];
  const parentJs = code => win.webContents.executeJavaScript(code);
  const parentCall = (method, arg) => parentJs(`window.forge[${JSON.stringify(method)}](${JSON.stringify(arg)})`);
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const events = () => js('window.__apiProtocolSmoke.events');
  const idle = () => until('main and renderer idle', async () => !(await call('getState')).activeTask.running && await js('!running&&!promptSubmitting&&!settingsSaving'));
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        modelGets++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model, object: 'model', supportsTools: true, reasoningEfforts: ['low', 'high'] }] }));
        return;
      }
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 150_000); }
      const body = JSON.parse(raw);
      const input = body.messages || body.input || [];
      const latestUser = input.filter(item => item.role === 'user').at(-1);
      const latestText = typeof latestUser?.content === 'string' ? latestUser.content : Array.isArray(latestUser?.content) ? latestUser.content.map(item => item?.text || '').join('\n') : '';
      const diagnostic = Object.keys(diagnosticPrompts).find(name => latestText === diagnosticPrompts[name]);
      requests.push({ url: request.url, body, ...(diagnostic ? { diagnostic } : {}) });
      if (diagnostic) {
        assert.equal(body.model, diagnosticModel, 'Diagnostic model ID was rewritten');
        assert.equal(body.reasoning, undefined); assert.equal(body.reasoning_effort, undefined); assert.equal(body.thinking, undefined);
        assert.equal(request.url, diagnostic === 'group' ? '/v1/responses' : '/v1/chat/completions');
        assert.equal(requests.filter(record => record.diagnostic === diagnostic).length, 1, 'Failed inference was automatically retried');
        const message = diagnostic === 'group' ? `Model ${diagnosticModel} is not supported by any configured account in this group`
          : diagnostic === 'route' ? 'Resource not found' : 'Fixture upstream did not respond within the gateway deadline.';
        response.writeHead(diagnostic === 'timeout' ? 524 : 404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message, code: 'server_error' } })); return;
      }
      assert.equal(request.url, '/v1/chat/completions', 'Model listing must not silently select Responses');
      assert.equal(body.model, model);
      assert.equal(body.stream, true);
      assert.equal(body.stream_options?.include_usage, true);
      assert.equal(body.thinking, undefined, 'Relay requests must not contain DeepSeek-specific thinking parameters');
      assert.equal(body.reasoning, undefined);
      assert.equal(body.reasoning_effort, undefined, 'Default reasoning must preserve the service default');
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === prompt));
      assert.ok(body.tools?.some(tool => tool.type === 'function' && tool.function?.name === 'read_file'));
      if (requests.length === 1) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'chatcmpl_compatible_read', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: '先读取这个文件。', tool_calls: [{
            id: 'compatible_read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: filename }) },
          }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }));
        return;
      }
      assert.equal(requests.length, 2, 'The task was retried or the tool loop failed to terminate');
      const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.some(tool => tool.id === 'compatible_read'));
      assert.ok(assistant, 'The assistant tool call was not replayed');
      assert.equal(assistant.tool_calls[0].function.arguments, JSON.stringify({ path: filename }));
      const tool = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'compatible_read');
      assert.ok(tool, 'The actual tool result was not returned to the model');
      assert.equal(JSON.parse(tool.content).content, fixture);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = ['兼容协议已完成', '读取和回复。PROTOCOL_FINISHED_' + suffix];
      for (const content of chunks) {
        response.write('data: ' + JSON.stringify({ id: 'chatcmpl_compatible_final', model, choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
        await wait(45);
      }
      response.write('data: ' + JSON.stringify({ id: 'chatcmpl_compatible_final', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ id: 'chatcmpl_compatible_final', model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      problems.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      if (!response.destroyed) response.end(JSON.stringify({ error: { code: 'protocol_smoke_contract', message: error.message } }));
    }
  });
  const createChild = async () => {
    const created = await parentJs('window.forge.newWindow()');
    child = BrowserWindow.fromId(created.id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('new app window initialized', () => js("!!window.forge&&!!appState&&!!document.getElementById('api-protocol-select')"));
    await js('(()=>{window.__apiProtocolSmoke={events:[]};window.__apiProtocolSmoke.off=window.forge.onEvent(event=>window.__apiProtocolSmoke.events.push(event));return true;})()');
  };
  const closeChild = async () => {
    if (!child || child.isDestroyed()) return;
    await call('stopTask').catch(() => {});
    await idle().catch(() => {});
    const closing = child;
    closing.close();
    await until('own app window closed', () => closing.isDestroyed());
    child = null;
  };
  const openFromReasoning = async () => {
    await js("document.getElementById('model-reasoning-trigger').click()");
    await until('model popup visible', () => js("!document.getElementById('reasoning-popup').hidden"));
    await until('model popup catalog settled', () => js('!catalogLoading'));
    if (!reasoningCardChecked && await js("!document.getElementById('reasoning-effort').disabled")) {
      const card = await js(`(()=>{
        const range=document.getElementById('reasoning-effort'),thumb=document.getElementById('reasoning-thumb');
        const visual=range.closest('.reasoning-slider-visual');
        const normal=Number.parseFloat(getComputedStyle(thumb).transitionDuration);
        range.dispatchEvent(new PointerEvent('pointerdown',{clientX:10,bubbles:true}));
        range.dispatchEvent(new PointerEvent('pointermove',{clientX:30,bubbles:true}));
        const dragging=visual.classList.contains('is-dragging');
        const drag=Number.parseFloat(getComputedStyle(thumb).transitionDuration);
        range.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}));
        range.value=range.min;range.dispatchEvent(new Event('input',{bubbles:true}));
        return {normal,drag,dragging,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,max:Number(range.max),scale:Number(appState.textScale)||100};
      })()`);
      assert.ok(card.max > 0, 'Reasoning animation fixture requires more than one range position');
      assert.equal(card.dragging, true, 'Pointer movement did not enable the dragging animation');
      if (!card.reduced) {
        assert.ok(Math.abs(card.normal - 0.22) < 0.015, 'Normal slider transition must be approximately 220 ms');
        assert.ok(Math.abs(card.drag - 0.11) < 0.015, 'Dragging slider transition must be approximately 110 ms');
      }
      await wait(280);
      const motion = await js(`(async()=>{
        const range=document.getElementById('reasoning-effort'),thumb=document.getElementById('reasoning-thumb');
        const start=thumb.getBoundingClientRect().left,positions=[];
        range.value=range.max;range.dispatchEvent(new Event('input',{bubbles:true}));
        for(let index=0;index<4;index++){await new Promise(requestAnimationFrame);positions.push(thumb.getBoundingClientRect().left);}
        await new Promise(resolve=>setTimeout(resolve,280));
        return {start,end:thumb.getBoundingClientRect().left,positions,fontSize:Number.parseFloat(getComputedStyle(document.getElementById('reasoning-value')).fontSize)};
      })()`);
      assert.ok(motion.end > motion.start + 20, 'Reasoning thumb did not move between range endpoints');
      if (!card.reduced) assert.ok(motion.positions.some(left => left > motion.start + 0.5 && left < motion.end - 0.5), 'The slider jumped instead of moving through intermediate frames');
      assert.ok(motion.fontSize <= 20 * card.scale / 100 + 0.1, 'Reasoning heading is larger than the requested compact size');
      await capture('reasoning-settings-card.png');
      reasoningCardChecked = true;
    }
    await js("document.getElementById('reasoning-open-settings').click()");
    await until('model settings opened from popup', () => js("document.getElementById('settings-dialog').open&&document.getElementById('reasoning-popup').hidden"));
  };
  const chooseProvider = value => js(`(()=>{const select=document.getElementById('provider-select');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  const capture = async name => {
    child.webContents.invalidate();
    await wait(120);
    await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG());
  };
  try {
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, filename), fixture);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    fixtureBaseUrl = baseUrl;
    await createChild();
    await call('openProject', { path: project });
    await js('newSession()');
    await openFromReasoning();
    assert.equal(await js("!!document.querySelector('#provider-select option[value=relay]')"), true);
    await chooseProvider('openai');
    await js("(()=>{const select=document.getElementById('openai-auth-mode');select.value='apiKey';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    assert.equal(await js("!document.getElementById('api-protocol-field').hidden"), true);
    assert.deepEqual(await js("[...document.getElementById('api-protocol-select').options].map(option=>option.value).sort()"), ['chat-completions', 'responses']);
    await js("(()=>{const select=document.getElementById('api-protocol-select');select.value='chat-completions';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    assert.equal(await js("document.getElementById('api-protocol-select').value"), 'chat-completions');
    await js("(()=>{const select=document.getElementById('openai-auth-mode');select.value='chatgpt';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    assert.equal(await js("document.getElementById('api-protocol-field').hidden"), true);
    for (const provider of ['deepseek', 'anthropic']) {
      await chooseProvider(provider);
      assert.equal(await js("document.getElementById('api-protocol-field').hidden"), true);
    }
    await chooseProvider('relay');
    assert.equal(await js("document.getElementById('api-protocol-select').value"), 'chat-completions');
    assert.equal(await js("!document.getElementById('api-protocol-field').hidden&&document.getElementById('openai-auth-mode-field').hidden&&document.getElementById('chatgpt-panel').hidden"), true);
    configured = true;
    const beforeDraft = (await call('getState')).settings;
    assert.equal(await js("!!document.getElementById('model-input')||!!document.querySelector('[id^=\"settings-reasoning-\"]')"),false);
    await js(`(()=>{for(const [id,value] of [['base-url-input',${JSON.stringify(baseUrl)}],['api-key-input',${JSON.stringify(apiKey)}]]){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.getElementById('clear-key-input').checked=false;return true;})()`);
    assert.equal(await js("document.getElementById('save-settings').disabled"),true,'Settings saved before fetching a catalog');
    await js("document.getElementById('settings-form').requestSubmit()");await wait(100);
    assert.deepEqual((await call('getState')).settings,beforeDraft,'Forced form submission stored an unfetched draft');
    const draft = {provider:'relay',authMode:'apiKey',apiProtocol:'chat-completions',baseUrl,apiKey};
    const preview = await call('previewModelCatalog',draft);
    assert.ok(preview.models.some(item=>item.id===model));assert.ok(preview.selectionToken);
    assert.equal((await call('getState')).settings.providers.relay.hasKey,false,'Preview stored a new key before Save');
    const rejectSave = async arg => assert.equal(await js(`(async()=>{try{await window.forge.saveModelSettings(${JSON.stringify(arg)});return false;}catch{return true;}})()`),true,'Unverified model settings were accepted');
    await rejectSave({...draft,model:'not-returned-by-fixture',selectionToken:preview.selectionToken});
    await rejectSave({...draft,baseUrl:baseUrl+'/changed',model,selectionToken:preview.selectionToken});
    assert.deepEqual((await call('getState')).settings,beforeDraft,'Rejected catalog selection mutated saved settings');
    await js("document.getElementById('settings-model-refresh').click()");
    await until('draft catalog fetched with unsaved key',()=>js(`!settingsCatalogLoading&&[...document.getElementById('chatgpt-model-select').options].some(option=>option.value===${JSON.stringify(model)})`));
    await js(`(()=>{const select=document.getElementById('chatgpt-model-select');select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    assert.equal(await js("document.getElementById('save-settings').disabled"),false);
    await js(`(()=>{const input=document.getElementById('base-url-input');input.value=${JSON.stringify(baseUrl+'/changed')};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    assert.equal(await js("document.getElementById('save-settings').disabled"),true,'Changing a draft kept a stale catalog selection valid');
    await js("document.getElementById('settings-form').requestSubmit()");await wait(80);
    assert.deepEqual((await call('getState')).settings,beforeDraft,'Changed draft was saved with an old catalog');
    await js(`(()=>{const input=document.getElementById('base-url-input');input.value=${JSON.stringify(baseUrl)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('settings-model-refresh').click();return true;})()`);
    await until('fresh catalog after draft change',()=>js(`!settingsCatalogLoading&&[...document.getElementById('chatgpt-model-select').options].some(option=>option.value===${JSON.stringify(model)})`));
    await js(`(()=>{const select=document.getElementById('chatgpt-model-select');select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('settings-form').requestSubmit();return true;})()`);
    await until('relay settings saved', async () => {
      const state = await call('getState');
      return state.settings.provider === 'relay' && state.settings.model === model && state.settings.apiProtocol === 'chat-completions' && await js("!settingsSaving&&!document.getElementById('settings-dialog').open");
    });
    await call('listModels', { force: true });
    await until('model catalog ready', () => js("appState?.settings?.provider==='relay'&&appState.settings.model==='compatible-model'&&!modelSaving&&!settingsSaving&&!document.getElementById('send-button').disabled"));
    const persistedSettings = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(persistedSettings.providers.relay.apiProtocol, 'chat-completions');
    assert.equal(persistedSettings.providers.relay.model, model);
    assert.ok(persistedSettings.providers.relay.encryptedKey);
    assert.equal(JSON.stringify(persistedSettings).includes(apiKey), false);
    assert.equal(JSON.stringify((await call('getState')).settings).includes(apiKey), false);

    // A separate app window must restore this choice from saved settings. The
    // original smoke window and its project/session are never changed.
    await closeChild();
    await createChild();
    await call('openProject', { path: project });
    await openFromReasoning();
    assert.equal(await js("document.getElementById('provider-select').value"), 'relay');
    assert.equal(await js("document.getElementById('api-protocol-select').value"), 'chat-completions');
    assert.equal(await js("document.getElementById('save-settings').disabled"),true);
    await js("document.getElementById('settings-model-refresh').click()");
    await until('saved credential catalog fetched',()=>js(`!settingsCatalogLoading&&[...document.getElementById('chatgpt-model-select').options].some(option=>option.value===${JSON.stringify(model)})`));
    await js(`(()=>{const select=document.getElementById('chatgpt-model-select');select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    assert.equal(await js("document.getElementById('chatgpt-model-select').value"), model);
    assert.equal(await js("document.getElementById('api-key-input').value"), '');
    await js("document.getElementById('api-protocol-select').scrollIntoView({block:'center'})");
    await capture('settings-api-protocol.png');
    await js("document.getElementById('close-settings').click()");
    await idle();
    const before = await call('getState');
    await js(`(()=>{const input=document.getElementById('task-input');input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('task-form').requestSubmit();return true;})()`);
    const end = await until('completed compatible task', async () => {
      const list = await events();
      const user = list.find(event => event.type === 'user-message' && event.text === prompt);
      if (!user) return false;
      return list.find(event => event.type === 'run-end' && event.runId === user.runId);
    });
    assert.equal(end.status, 'completed', end.error || 'Compatible task failed');
    await idle();
    assert.deepEqual(problems, []);
    assert.equal(requests.length, 2);
    assert.ok(modelGets > 0);
    const list = await events();
    assert.equal(list.filter(event => event.type === 'tool-start' && event.name === 'read_file').length, 1);
    assert.equal(list.filter(event => event.type === 'tool-result' && event.name === 'read_file').length, 1);
    assert.ok(list.some(event => event.type === 'assistant-message' && event.text === finalText));
    assert.equal(list.some(event => ['approval-request', 'approval-auto'].includes(event.type)), false);
    assert.equal(JSON.stringify(list).includes('providerState'), false);
    const publicSession = await call('getCurrentSession');
    assert.equal(publicSession.messages.some(message => Object.hasOwn(message, 'providerState')), false);
    const stored = await until('completed session persisted', async () => {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', publicSession.id + '.json'), 'utf8'));
      return saved.messages.some(message => message.role === 'assistant' && message.content === finalText) && saved;
    });
    assert.ok(stored.messages.some(message => message.role === 'tool' && JSON.parse(message.content).content === fixture));
    const after = await call('getState');
    assert.equal(after.usageStats.day.requests - before.usageStats.day.requests, 2);
    assert.equal(after.usageStats.day.totalTokens - before.usageStats.day.totalTokens, 30);
    assert.equal(after.usageStats.day.unreportedRequests, before.usageStats.day.unreportedRequests);
    assert.equal(reasoningCardChecked, true, 'Known-capability fixture never exercised the slider animation');
    assert.equal(await fs.readFile(path.join(project, filename), 'utf8'), fixture);
    assert.equal(await js(`document.getElementById('messages').textContent.includes(${JSON.stringify(finalText)})`), true);
    await capture('chat-compatible.png');
    // Listing a relay model is separate from the selected group's upstream
    // availability. Distinguish its explicit error from a generic route 404.
    const diagnostics = {};
    for (const diagnostic of ['group', 'route', 'timeout']) {
      await call('saveSettings', { provider: 'relay', apiProtocol: diagnostic === 'group' ? 'responses' : 'chat-completions', model: diagnosticModel, reasoningEffort: 'default' });
      await idle();
      await call('submitPrompt', { text: diagnosticPrompts[diagnostic], mode: 'queue' });
      const failed = await until('diagnostic ' + diagnostic, async () => {
        const list = await events(), user = list.find(event => event.type === 'user-message' && event.text === diagnosticPrompts[diagnostic]);
        return user && list.find(event => event.type === 'run-end' && event.runId === user.runId);
      });
      await idle(); assert.equal(failed.status, 'failed');
      assert.match(failed.error, diagnostic === 'timeout' ? /HTTP 524/u : /HTTP 404/u);
      if (diagnostic === 'group') {
        assert.match(failed.error, /分组/u); assert.match(failed.error, /账号|账户|上游/u);
        assert.doesNotMatch(failed.error, /API 地址或模型不存在/u);
      } else if (diagnostic === 'route') {
        assert.doesNotMatch(failed.error, /当前分组.*(?:未配置|没有|无).*账号|分组.*上游账号/u, 'Generic route 404 was over-classified as group availability');
      } else {
        assert.match(failed.error, /超时/u); assert.doesNotMatch(failed.error, /模型不存在|分组.*账号.*未配置/u);
      }
      assert.ok(await js(`document.getElementById('messages').textContent.includes(${JSON.stringify(failed.error)})`), 'Diagnostic did not reach the visible conversation');
      await wait(150); assert.equal(requests.filter(record => record.diagnostic === diagnostic).length, 1, 'Failed request was retried');
      diagnostics[diagnostic] = failed.error;
      await capture('protocol-' + diagnostic + '-diagnostic.png');
    }
    const afterDiagnostics = await call('getState');
    assert.equal(afterDiagnostics.usageStats.day.requests - before.usageStats.day.requests, 5);
    assert.equal(afterDiagnostics.usageStats.day.totalTokens - before.usageStats.day.totalTokens, 30);
    assert.equal(afterDiagnostics.usageStats.day.unreportedRequests - before.usageStats.day.unreportedRequests, 3);
    assert.deepEqual(problems, []);
    return {
      status: 'completed', realApi: false, isolatedAppWindow: true, relayProvider: true,
      popupSettingsEntry: true, compactReasoningHeading: true, smoothSliderAnimation: true, openaiProtocolChoice: true, hiddenForNativeProviders: true,
      savedSettingsRestored: true, actualReadOnlyTool: true, jsonAndSse: true,
      catalogOnlySettings: true, unsavedCredentialPreview: true, unfetchedDraftNotSaved: true, draftChangeInvalidatesSelection: true, foreignModelAndChangedDraftRejected: true,
      nativeStatePrivate: true, modelRequests: requests.length, modelCatalogRequests: modelGets,
      explicitGroup404Classified: true, genericRoute404NotOverclassified: true, gateway524Distinct: true, failuresNotRetried: true, diagnosticModelUnchanged: true,
      tokensRecorded: 30, screenshots: ['reasoning-settings-card.png', 'settings-api-protocol.png', 'chat-compatible.png', 'protocol-group-diagnostic.png', 'protocol-route-diagnostic.png', 'protocol-timeout-diagnostic.png'],
    };
  } catch (error) {
    const renderer = child && !child.isDestroyed() ? await js("({running,promptSubmitting,settingsSaving,provider:appState?.settings?.provider,protocol:appState?.settings?.apiProtocol,settingsError:document.getElementById('settings-error').textContent,notice:document.getElementById('notice-text').textContent,events:window.__apiProtocolSmoke?.events?.filter(event=>['run-end','tool-start'].includes(event.type))})").catch(() => null) : null;
    console.error('API_PROTOCOL_SMOKE_FAILURE', JSON.stringify({ error: error.message, stack: error.stack, problems, urls: requests.map(record => record.url), renderer }));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      await call('stopTask').catch(() => {});
      await idle().catch(() => {});
    }
    const closing = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closing;
    try {
      if (configured) {
        const previousRelay = original.settings.providers.relay;
        // The empty, unconfigured relay default cannot be submitted through the
        // validated settings form. Preserve its other values and clear the fake
        // key with the fixture's legal loopback URL; never swallow that failure.
        await parentCall('saveSettings', { provider: 'relay', model: previousRelay.model, baseUrl: previousRelay.baseUrl || fixtureBaseUrl, reasoningEffort: previousRelay.reasoningEffort, apiProtocol: previousRelay.apiProtocol, clearKey: true });
        assert.equal((await parentJs('window.forge.getState()')).settings.providers.relay.hasKey, false, 'The fixture relay key was not cleared');
        const previous = original.settings.providers[original.settings.provider];
        await parentCall('saveSettings', { provider: original.settings.provider, model: previous.model, baseUrl: previous.baseUrl || (original.settings.provider === 'relay' ? fixtureBaseUrl : undefined), reasoningEffort: previous.reasoningEffort, authMode: previous.authMode, ...(previous.apiProtocol ? { apiProtocol: previous.apiProtocol } : {}) });
      }
    } finally {
      await closeChild().catch(() => { if (child && !child.isDestroyed()) child.destroy(); });
    }
    const restored = await parentJs('window.forge.getState()');
    assert.equal(restored.settings.provider, original.settings.provider, 'The active provider was not restored');
    assert.equal(restored.settings.model, original.settings.model, 'The active model was not restored');
    assert.equal(restored.sessionId, original.sessionId, 'The parent session changed during protocol smoke');
  }
};
