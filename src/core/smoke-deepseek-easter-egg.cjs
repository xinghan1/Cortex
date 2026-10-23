// Shipped renderer/IPC with an isolated loopback catalog. No model inference,
// account endpoint or real API credential is used by this visual regression.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { BrowserWindow } = require('electron');

module.exports = async function smokeDeepseekEasterEgg({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await wait(25); }
    throw new Error('DeepSeek effort smoke timed out: ' + label);
  };
  const invoke = (method, value) => `window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const parentCall = (method, value) => win.webContents.executeJavaScript(invoke(method, value));
  let child, baseUrl, configured = false, deepseekConfigured = false, stage = 'initialize';
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, value) => js(invoke(method, value));
  const original = await parentCall('getState'), originalAppearance = await parentCall('getAppearance');
  for (const provider of ['relay', 'deepseek']) assert.equal(original.settings.providers[provider].hasKey, false, 'Refusing a configured provider');
  const apiKey = 'deepseek-effort-loopback-fixture';
  const models = { relay: 'deepseek-ai/DeepSeek-V4-Pro', official: 'deepseek-v4-pro', gpt: 'gpt-6.1', fake: 'notdeepseek-v4-pro', unknown: 'deepseek-v4-unknown', medium: 'deepseek-v4-medium' };
  const levels = ['none', 'low', 'high', 'max'];
  const catalog = [
    ...['relay', 'official', 'gpt', 'fake'].map(name => ({ id: models[name], object: 'model', supports_tools: true,
      display_name: name === 'fake' ? 'DeepSeek V4 Pro' : models[name], supported_reasoning_efforts: levels, default_reasoning_effort: 'high' })),
    { id: models.unknown, object: 'model', supports_tools: true },
    { id: models.medium, object: 'model', supports_tools: true, supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'max'], default_reasoning_effort: 'medium' },
  ];
  const requests = [], problems = [], screenshots = [], checks = [];
  const server = http.createServer((request, response) => {
    try {
      requests.push({ method: request.method, path: request.url });
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      assert.equal(request.method, 'GET'); assert.equal(request.url, '/v1/models');
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: catalog }));
    } catch (error) { problems.push(error.message); response.writeHead(500); response.end('Unexpected fixture request'); }
  });
  const inspect = () => js(`(() => {
    const popup=document.getElementById('reasoning-popup'),range=document.getElementById('reasoning-effort'),box=popup.getBoundingClientRect();
    const before=getComputedStyle(popup,'::before'),after=getComputedStyle(popup,'::after');
    return {hidden:popup.hidden,level:popup.dataset.deepseekEffort||null,model:appState.settings.model,effort:range.dataset.effort,
      support:range.dataset.support,options:JSON.parse(range.dataset.options||'[]'),width:box.width,height:box.height,
      mainHidden:document.getElementById('reasoning-popup-main').hidden,label:document.getElementById('reasoning-value').textContent,
      background:before.backgroundImage,size:before.backgroundSize,position:before.backgroundPosition,display:before.display,
      content:before.content,opacity:before.opacity,pointerEvents:before.pointerEvents,overlayPointerEvents:after.pointerEvents};
  })()`);
  const mouse = point => {
    child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
  };
  const click = async selector => {
    const point = await until('clickable ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility())return null;
      node.scrollIntoView({block:'nearest'});const box=node.getBoundingClientRect(),x=Math.round(box.left+box.width/2),y=Math.round(box.top+box.height/2);
      return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
    })()`));
    mouse(point); await wait(35);
  };
  const popup = async () => {
    if (await js("document.getElementById('reasoning-popup').hidden")) await click('#model-reasoning-trigger');
    await until('popup ready', () => js("!document.getElementById('reasoning-popup').hidden&&!catalogLoading&&!reasoningSaving&&!modelSaving"));
  };
  const select = async model => {
    await popup(); await click('#popup-model-button');
    await until('model list', () => js("!document.getElementById('model-list-panel').hidden&&!catalogLoading"));
    const list = await inspect();
    assert.ok(list.background === 'none' || list.content === 'none' || list.display === 'none' || Number(list.opacity) === 0, 'Photo must be hidden behind the model list');
    await click('.model-option[data-model=' + JSON.stringify(model) + ']');
    await until('selected ' + model, async () => (await call('getState')).settings.model === model && await js("!modelSaving&&!document.getElementById('reasoning-popup-main').hidden"));
  };
  const setEffort = async effort => {
    const point = await js(`(() => {
      const range=document.getElementById('reasoning-effort'),values=JSON.parse(range.dataset.options),index=values.indexOf(${JSON.stringify(effort)});
      if(range.disabled||index<0)throw new Error('Requested effort unavailable');
      const box=range.getBoundingClientRect(),x=Math.round(box.left+15+(box.width-30)*index/(values.length-1)),y=Math.round(box.top+box.height/2);
      if(document.elementFromPoint(x,y)!==range)throw new Error('Background covers reasoning slider');return {x,y};
    })()`);
    mouse(point);
    await until('saved effort ' + effort, async () => (await call('getState')).settings.reasoningEffort === effort && await js(`!reasoningSaving&&document.getElementById('reasoning-effort').dataset.effort===${JSON.stringify(effort)}`));
  };
  const reset = async () => {
    await click('#reasoning-default');
    await until('default saved', async () => (await call('getState')).settings.reasoningEffort === 'default' && await js("!reasoningSaving&&document.getElementById('reasoning-effort').dataset.effort==='default'"));
  };
  const capture = async name => {
    child.webContents.invalidate(); await wait(160);
    const rect = await js("(()=>{const r=document.getElementById('reasoning-popup').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.left)-8),y:Math.max(0,Math.floor(r.top)-8),width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16};})()");
    await fs.writeFile(path.join(output, name), (await child.webContents.capturePage(rect)).toPNG()); screenshots.push(name);
  };
  const noImage = async () => {
    const state = await inspect(); assert.equal(state.level, null);
    assert.ok(state.background === 'none' || state.content === 'none' || state.display === 'none' || Number(state.opacity) === 0, 'Unexpected model photo');
    return state;
  };
  const image = async (level, baseline, style) => {
    const state = await until('photo ' + level, async () => { const value = await inspect(); return value.level === level && value; });
    assert.equal(state.hidden, false); assert.equal(state.mainHidden, false);
    assert.match(state.background, new RegExp('/assets/deepseek-effort/' + level + '\\.jpg(?:["\\)]|$)'));
    assert.match(state.size, /^100%(?: auto)?$/); assert.equal(state.position, '50% 50%');
    assert.equal(state.pointerEvents, 'none'); assert.equal(state.overlayPointerEvents, 'none');
    assert.ok(Math.abs(state.width - baseline.width) < 0.75, 'Photo changed popup width');
    assert.ok(Math.abs(state.height - baseline.height) < 0.75, 'Photo changed popup height');
    const decoded = await js(`(async()=>{const background=getComputedStyle(document.getElementById('reasoning-popup'),'::before').backgroundImage;
      const match=background.match(/^url\\(["']?(.*?)["']?\\)$/);if(!match)throw new Error('Missing photo URL');
      const image=new Image();image.src=match[1];await image.decode();return {width:image.naturalWidth,height:image.naturalHeight};})()`);
    assert.ok(decoded.width > 0 && decoded.height > 0); checks.push({ style, level, width: state.width, height: state.height, decoded });
  };
  try {
    await fs.mkdir(output, { recursive: true });
    const project = path.join(dataDir, 'deepseek-effort-fixture'); await fs.mkdir(project, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    child = BrowserWindow.fromId((await parentCall('newWindow')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child initialized', () => js("!!window.forge&&!!appState&&!!document.getElementById('model-reasoning-trigger')"));
    await call('openProject', { path: project });
    await call('saveSettings', { provider: 'relay', model: models.gpt, apiProtocol: 'chat-completions', baseUrl, apiKey, reasoningEffort: 'default' }); configured = true;
    await call('listModels', { force: true }); await popup();
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      stage = 'four levels in ' + style;
      await call('setAppearance', { uiStyle: style }); await js('window.synoraAppearance.settled()'); await popup();
      await select(models.gpt); await setEffort('high'); const baseline = await noImage();
      await select(models.relay);
      for (const effort of ['max', 'high', 'low', 'none']) {
        const level = effort === 'none' ? 'off' : effort;
        await setEffort(effort); await image(level, baseline, style);
        if (style === 'glass' || effort === 'max') await capture('deepseek-' + style + '-' + level + '.png');
      }
      await reset(); await image('high', baseline, style + '-default');
    }
    stage = 'other models and unmapped/default effort controls';
    await select(models.gpt); await setEffort('max'); await noImage(); await capture('deepseek-gpt-control.png');
    await select(models.fake); await noImage();
    await select(models.unknown); await reset(); await noImage();
    assert.equal((await inspect()).support, 'unknown');
    await select(models.medium); await reset();
    const medium = await inspect(); await image('high', medium, 'medium-default');
    // Default already places the thumb at medium; first move away so native
    // input dispatches a change when explicitly choosing the same numeric slot.
    await setEffort('low'); await setEffort('medium'); await image('high', medium, 'medium-explicit');
    assert.equal((await call('getState')).settings.reasoningEffort, 'medium', 'Decorative compatibility mapping must not change the stored effort');
    await select(models.relay); await setEffort('high');
    await click('#popup-model-button'); await capture('deepseek-model-list.png');
    const list = await inspect(); assert.equal(list.mainHidden, true);
    assert.ok(list.background === 'none' || list.content === 'none' || list.display === 'none' || Number(list.opacity) === 0);
    await click('#model-list-back'); await until('photo restored after model list', async () => (await inspect()).level === 'high');
    stage = 'official provider with the same loopback fixture';
    await call('saveSettings', { provider: 'deepseek', model: models.official, baseUrl, apiKey, reasoningEffort: 'default' }); deepseekConfigured = true;
    await call('listModels', { force: true }); await popup(); await reset();
    const official = await inspect(); await image('high', official, 'deepseek-provider');
    assert.deepEqual(problems, []); assert.ok(requests.length >= 2);
    const untouched = await parentCall('getState');
    assert.equal(untouched.sessionId, original.sessionId); assert.equal(untouched.workspace?.root, original.workspace?.root);
    return { status: 'completed', realApi: false, inferenceRequests: 0, isolatedChildWindow: true,
      themes: ['glass', 'black', 'white', 'industrial'], levels: ['max', 'high', 'low', 'off'], nativeSliderAndReset: true,
      cardDimensionsPreserved: true, width100PercentAndVerticallyCentered: true, decodedAssets: true,
      relayDeepseekId: true, officialDeepseekProvider: true, gptAndMisleadingDisplayNameExcluded: true,
      unknownDefaultExcluded: true, mediumUsesHighPhotoWithoutChangingEffort: true, modelListHidesPhoto: true, modelSwitchAndBackUsable: true,
      catalogRequests: requests.length, checks, screenshots };
  } catch (error) {
    console.error('DEEPSEEK_EFFORT_SMOKE_FAILURE', JSON.stringify({ stage, error: error.message, stack: error.stack, problems,
      renderer: child && !child.isDestroyed() ? await inspect().catch(() => null) : null })); throw error;
  } finally {
    if (child && !child.isDestroyed()) { const closing = child; closing.close(); await until('child closed', () => closing.isDestroyed()).catch(() => closing.destroy()); }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (!win.isDestroyed()) {
      await parentCall('setAppearance', { uiStyle: originalAppearance.uiStyle });
      if (deepseekConfigured) { const previous = original.settings.providers.deepseek; await parentCall('saveSettings', { provider: 'deepseek', model: previous.model, baseUrl: previous.baseUrl, reasoningEffort: previous.reasoningEffort, clearKey: true }); }
      if (configured) { const previous = original.settings.providers.relay; await parentCall('saveSettings', { provider: 'relay', model: previous.model, baseUrl: previous.baseUrl || baseUrl, apiProtocol: previous.apiProtocol, reasoningEffort: previous.reasoningEffort, clearKey: true }); }
      if (configured) { const previous = original.settings.providers[original.settings.provider]; await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: previous.baseUrl || (original.settings.provider === 'relay' ? baseUrl : undefined), apiProtocol: previous.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: previous.authMode }); }
    }
  }
};
