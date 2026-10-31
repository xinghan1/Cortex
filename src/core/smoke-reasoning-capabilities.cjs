// Actual catalog revisions, generic reasoning controls and isolated requests.
// Every HTTP response is produced by this loopback fixture; no real model runs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeReasoningCapabilities({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Reasoning smoke requires an isolated offscreen parent');
  const suffix = randomUUID(), project = path.join(dataDir, 'reasoning-capabilities-' + suffix);
  const models = { unknown: 'gemini-3-flash', unsupported: 'gemini-3-flash-high', openaiUnknown: 'gemini-3-flash-openai' };
  const scenes = { unknownBefore: { model: models.unknown, effort: 'high' }, unknownAfter: { model: models.unknown, effort: 'high' }, three: { model: models.unknown, effort: 'medium' }, five: { model: models.unknown, effort: 'max' }, shrunk: { model: models.unknown }, unsupported: { model: models.unsupported }, openaiUnknown: { model: models.openaiUnknown, effort: 'high' } };
  const prompts = Object.fromEntries(Object.keys(scenes).map(name => [name, 'REASONING_' + name.toUpperCase() + '_' + suffix]));
  const fallback = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const three = ['low', 'medium', 'high'], five = ['none', 'low', 'medium', 'high', 'max'];
  const apiKey = 'forgedesk-reasoning-fixture-key', requests = [], problems = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Reasoning capabilities smoke timed out: ' + label);
  };
  let child, configured = false, openaiConfigured = false, catalogGets = 0, baseUrl, revision = 'plain', heldCatalog;
  const invocation = (method, arg) => `window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`;
  const parentJs = code => win.webContents.executeJavaScript(code);
  const parentCall = (method, arg) => parentJs(invocation(method, arg));
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, arg) => js(invocation(method, arg));
  const original = await parentCall('getState');
  assert.equal(original.settings.providers.relay.hasKey, false, 'Refusing to replace a configured relay key');
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace a configured OpenAI key');
  const log = () => js('window.__reasoningSmoke.events');
  const idle = () => until('main and renderer idle', async () => !(await call('getState')).activeTask.running && await js('!running&&!promptSubmitting&&!settingsSaving&&!reasoningSaving&&!modelSaving'));
  const capture = async name => { child.webContents.invalidate(); await wait(120); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  const replyCatalog = (response, version) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [
      { id: models.unknown, object: 'model', supports_tools: true, ...(version !== 'plain' ? { supported_reasoning_efforts: version === 'five' ? five : three, default_reasoning_effort: 'medium' } : {}) },
      { id: models.unsupported, object: 'model', supports_tools: true, supports_reasoning: false },
      { id: models.openaiUnknown, object: 'model', supports_tools: true },
    ] }));
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        catalogGets++;
        if (catalogGets === 1) { heldCatalog = response; return; }
        replyCatalog(response, revision); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 150000); }
      const body = JSON.parse(raw), latest = body.messages.filter(message => message.role === 'user').at(-1);
      const name = Object.keys(prompts).find(key => latest?.content === prompts[key]);
      assert.ok(name, 'Unexpected reasoning fixture prompt');
      requests.push({ name, body });
      assert.equal(body.model, scenes[name].model, 'A reasoning suffix must never be appended, removed or rewritten');
      assert.equal(body.stream, true);
      assert.equal(body.reasoning, undefined, 'Compatible relay Chat Completions must not receive Responses reasoning');
      assert.equal(body.thinking, undefined, 'Compatible relay Chat Completions must not receive DeepSeek thinking');
      assert.equal(body.reasoning_effort, scenes[name].effort, 'Explicit chosen reasoning or the service default was not serialized correctly');
      assert.equal(requests.filter(record => record.name === name).length, 1, 'Inference was automatically retried');
      if (name === 'unsupported') {
        response.writeHead(524, { 'Content-Type': 'application/json', 'Retry-After': '61' });
        response.end(JSON.stringify({ error: { code: 'server_error', message: 'Fixture upstream did not respond within the gateway deadline.' } })); return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'chatcmpl_reasoning_' + name, choices: [{ index: 0, message: { role: 'assistant', content: 'REASONING_COMPLETED_' + name }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'reasoning_smoke_contract', message: error.message } })); }
    }
  });
  const popup = async () => {
    await js("(()=>{if(document.getElementById('reasoning-popup').hidden)document.getElementById('model-reasoning-trigger').click();return true;})()");
    await until('reasoning popup/catalog ready', () => js("!document.getElementById('reasoning-popup').hidden&&!catalogLoading&&!reasoningSaving&&!modelSaving"));
  };
  const controls = settings => js(`(()=>{
    const prefix=${settings ? "'settings-reasoning'" : "'reasoning'"},range=document.getElementById(prefix+'-effort');
    return {support:range.dataset.support,effort:range.dataset.effort,disabled:range.disabled,max:range.max,options:range.dataset.options,
      label:document.getElementById(prefix+'-value').textContent,pill:document.getElementById('composer-reasoning-label').textContent,
      isMax:range.classList.contains('is-max'),resetDisabled:document.getElementById(prefix+'-default').disabled};
  })()`);
  const setEffort = async effort => {
    await js(`(()=>{const range=document.getElementById('reasoning-effort'),options=rangeOptions(range);if(range.disabled)throw new Error('Reasoning range is disabled');const index=options.indexOf(${JSON.stringify(effort)});if(index<0)throw new Error('Missing requested reasoning level');range.value=String(index);range.dispatchEvent(new Event('input',{bubbles:true}));range.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await until('chosen effort ' + effort, async () => (await call('getState')).settings.reasoningEffort === effort && await js(`!reasoningSaving&&document.getElementById('reasoning-effort').dataset.effort===${JSON.stringify(effort)}`));
  };
  const available = async (expected, support) => {
    const actual = await controls(false);
    assert.equal(actual.support, support); assert.equal(actual.disabled, false); assert.equal(actual.resetDisabled, false);
    assert.deepEqual(JSON.parse(actual.options), expected); assert.equal(Number(actual.max), expected.length - 1);
    assert.notEqual(actual.label, '不可用'); assert.notEqual(actual.pill, '不可用');
  };
  const settingsMatch = async (expected, support) => {
    await js("document.getElementById('popup-model-button').click();document.getElementById('model-open-settings').click()");
    await until('settings opened', () => js("document.getElementById('settings-dialog').open"));
    const actual = await js("({manual:!!document.getElementById('model-input'),ranges:document.querySelectorAll('[id^=\"settings-reasoning-\"]').length,catalog:document.getElementById('chatgpt-model-select')?.tagName,saveDisabled:document.getElementById('save-settings').disabled})");
    assert.equal(actual.manual,false);assert.equal(actual.ranges,0);assert.equal(actual.catalog,'SELECT');assert.equal(actual.saveDisabled,true);
    await js("document.getElementById('close-settings').click()");
  };
  const unavailable = async (name, support) => {
    await popup();
    const actual = await controls(false);
    assert.equal(actual.support, support); assert.equal(actual.disabled, true); assert.equal(actual.resetDisabled, true);
    assert.equal(actual.label, '不可用'); assert.equal(actual.pill, '不可用'); assert.equal(actual.effort, 'default');
    assert.equal(Number(actual.max), 0); assert.equal(actual.isMax, false);
    const before = (await call('getState')).settings.reasoningEffort;
    await js("(()=>{const range=document.getElementById('reasoning-effort');range.value=range.max;range.dispatchEvent(new Event('input',{bubbles:true}));range.dispatchEvent(new Event('change',{bubbles:true}));range.dispatchEvent(new PointerEvent('pointerdown',{clientX:20,bubbles:true}));range.dispatchEvent(new PointerEvent('pointermove',{clientX:200,bubbles:true}));range.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}));return true;})()");
    await wait(100);
    assert.equal((await call('getState')).settings.reasoningEffort, before, 'Synthetic dragging changed an unavailable effort');
    assert.equal((await controls(false)).label, '不可用');
    await capture('reasoning-' + name + '-unavailable.png');
    await settingsMatch([],support);
  };
  const run = async name => {
    await idle();
    const submitted = await call('submitPrompt', { text: prompts[name], mode: 'queue' });
    assert.equal(submitted.disposition, 'started');
    const end = await until('run-end ' + name, async () => {
      const events = await log(), user = events.find(event => event.type === 'user-message' && event.text === prompts[name]);
      return user && events.find(event => event.type === 'run-end' && event.runId === user.runId);
    });
    await idle(); return end;
  };
  const closeChild = async () => {
    if (!child || child.isDestroyed()) return;
    await call('stopTask').catch(() => {}); await idle().catch(() => {});
    const closing = child; closing.close(); await until('child closed', () => closing.isDestroyed()); child = null;
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    child = BrowserWindow.fromId((await parentCall('newWindow')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child initialized', () => js("!!window.forge&&!!appState&&!!document.getElementById('model-reasoning-trigger')"));
    await js('(()=>{window.__reasoningSmoke={events:[]};window.__reasoningSmoke.off=window.forge.onEvent(event=>window.__reasoningSmoke.events.push(event));return true;})()');
    await call('openProject', { path: project });
    await call('saveSettings', { provider: 'relay', model: models.unknown, apiProtocol: 'chat-completions', baseUrl, apiKey, reasoningEffort: 'default' }); configured = true;
    const before = (await call('getState')).usageStats.day;
    await available(fallback, 'unknown');
    assert.equal((await controls(false)).label, '默认');
    // Hold the first catalog response so the slider and real selected-high
    // inference are exercised before any model capability metadata arrives.
    await js("document.getElementById('model-reasoning-trigger').click()");
    await until('first catalog request held', () => heldCatalog);
    await available(fallback, 'unknown'); await setEffort('high');
    await capture('reasoning-before-catalog-generic.png');
    assert.equal((await run('unknownBefore')).status, 'completed');
    replyCatalog(heldCatalog, 'plain'); heldCatalog = null;
    await until('plain catalog loaded', () => js('!catalogLoading&&!!currentCatalog'));
    const catalog = (await call('getState')).modelCatalog;
    assert.equal(catalog.models.find(item => item.id === models.unknown).reasoningEfforts, undefined);
    assert.deepEqual(catalog.models.find(item => item.id === models.unsupported).reasoningEfforts, []);
    await popup(); await available(fallback, 'unknown');
    assert.equal(await js("document.getElementById('reasoning-hint')===null"), true);
    await setEffort('low'); await setEffort('high');
    await settingsMatch(fallback, 'unknown');
    assert.equal((await run('unknownAfter')).status, 'completed');

    revision = 'three'; await call('listModels', { force: true }); await popup(); await available(three, 'known');
    await setEffort('medium'); await settingsMatch(three, 'known');
    await popup(); await capture('reasoning-catalog-three-levels.png');
    assert.equal((await run('three')).status, 'completed');
    revision = 'five'; await call('listModels', { force: true }); await popup(); await available(five, 'known');
    await setEffort('max'); await settingsMatch(five, 'known');
    await popup(); await capture('reasoning-catalog-five-levels.png');
    assert.equal((await run('five')).status, 'completed');
    revision = 'three'; await call('listModels', { force: true }); await popup(); await available(three, 'known');
    await until('invalid maximum resets to default', async () => (await call('getState')).settings.reasoningEffort === 'default' && (await controls(false)).effort === 'default');
    assert.equal((await controls(false)).label, '默认');
    await settingsMatch(three, 'known');
    assert.equal((await run('shrunk')).status, 'completed');

    await call('selectModel', { model: models.unsupported });
    await unavailable('unsupported', 'none');
    const failed = await run('unsupported');
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /HTTP 524/u); assert.match(failed.error, /超时/u);
    assert.match(failed.error, /中转|网关|上游/u);
    assert.doesNotMatch(failed.error, /模型不存在|请求参数.*不受支持|API 地址或模型不存在/u);
    await wait(250); assert.equal(requests.filter(record => record.name === 'unsupported').length, 1, 'A gateway cooldown beyond the automatic retry window must not be shortened');
    assert.ok(await js("document.getElementById('messages').textContent.includes('HTTP 524')"));
    await capture('reasoning-http-524.png');

    // OpenAI + a custom relay base preserves an explicit generic high choice.
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: models.openaiUnknown, apiProtocol: 'chat-completions', baseUrl, apiKey, reasoningEffort: 'default' }); openaiConfigured = true;
    await call('listModels', { force: true });
    await popup(); await available(fallback, 'unknown'); await setEffort('high'); await settingsMatch(fallback, 'unknown');
    await popup(); await capture('reasoning-openai-unknown-generic.png');
    assert.equal((await run('openaiUnknown')).status, 'completed');
    const after = await call('getState');
    assert.equal(after.usageStats.day.requests - before.requests, 7); assert.equal(after.usageStats.day.totalTokens - before.totalTokens, 60);
    assert.equal(after.usageStats.day.unreportedRequests - before.unreportedRequests, 1);
    assert.equal(requests.length, 7); assert.ok(catalogGets >= 5); assert.deepEqual(problems, []);
    const untouched = await parentCall('getState');
    assert.equal(untouched.workspace?.root, original.workspace?.root); assert.equal(untouched.sessionId, original.sessionId);
    assert.equal(untouched.settings.provider, original.settings.provider); assert.equal(untouched.settings.model, original.settings.model);
    for (const provider of ['deepseek', 'anthropic']) assert.deepEqual(untouched.settings.providers[provider], original.settings.providers[provider]);
    return { status: 'completed', realApi: false, isolatedChildWindow: true, genericBeforeCatalog: true, genericAfterPlainCatalog: true, explicitUnknownEffortSent: true, catalogThreeLevels: true, catalogFiveLevels: true, catalogShrinkResetsInvalidEffort: true, settingsMatchCapabilities: true, explicitUnsupportedUnavailable: true, unavailableSyntheticDragIgnored: true, openaiCustomBaseGenericEffortSent: true, snakeCaseCatalogCapabilities: true, modelIdsUnchanged: true, http524GatewayDiagnostic: true, http524NotRetried: true, parentPreserved: true, requests: requests.length, tokensRecorded: 60, screenshots: ['reasoning-before-catalog-generic.png', 'reasoning-catalog-three-levels.png', 'reasoning-catalog-five-levels.png', 'reasoning-unsupported-unavailable.png', 'reasoning-http-524.png', 'reasoning-openai-unknown-generic.png'] };
  } catch (error) {
    const observed = child && !child.isDestroyed() ? await call('getState').catch(() => null) : null;
    console.error('REASONING_CAPABILITIES_SMOKE_FAILURE', JSON.stringify({ error: error.message, stack: error.stack, problems, requests: requests.map(({ name, body }) => ({ name, model: body.model, effort: body.reasoning_effort })), settings: observed?.settings, renderer: child && !child.isDestroyed() ? await js('({popup:document.getElementById("reasoning-popup").hidden,model:appState?.settings?.model,catalogLoading,reasoningSaving,range:document.getElementById("reasoning-effort").outerHTML})').catch(() => null) : null }));
    throw error;
  } finally {
    await closeChild().catch(() => { if (child && !child.isDestroyed()) child.destroy(); });
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      if (openaiConfigured) {
        const previousOpenai = original.settings.providers.openai;
        await parentCall('saveSettings', { provider: 'openai', model: previousOpenai.model, baseUrl: previousOpenai.baseUrl, apiProtocol: previousOpenai.apiProtocol, reasoningEffort: previousOpenai.reasoningEffort, authMode: previousOpenai.authMode, clearKey: true });
      }
      const previousRelay = original.settings.providers.relay;
      await parentCall('saveSettings', { provider: 'relay', model: previousRelay.model, baseUrl: previousRelay.baseUrl || baseUrl, apiProtocol: previousRelay.apiProtocol, reasoningEffort: previousRelay.reasoningEffort, clearKey: true });
      const previous = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: previous.baseUrl || (original.settings.provider === 'relay' ? baseUrl : undefined), apiProtocol: previous.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: previous.authMode });
      assert.equal((await parentCall('getState')).sessionId, original.sessionId, 'Parent session changed during cleanup');
    }
  }
};
