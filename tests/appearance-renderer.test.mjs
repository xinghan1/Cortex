import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/appearance.js', import.meta.url), 'utf8');
const colorsSource = await readFile(new URL('../src/renderer/conversation-colors.js', import.meta.url), 'utf8');
const defaults = { backgroundImage:null, backgroundName:'', backgroundTransparency:28, panelFrost:70, panelTransparency:30, conversationTextColor:'white', backgroundPreset:'aurora', uiStyle:'glass', selectionColor:null };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const nodes = new Map(), rules = new Map(), requests = [], timers = new Map();
  let listener, timer = 0, state = { ...defaults }, focused;
  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const events = new Map(), classes = new Set();
    const value = {
      id, dataset:{}, value:'', hidden:false, disabled:false, textContent:'', open:false,
      classList:{ toggle:(key, enabled) => enabled ? classes.add(key) : classes.delete(key), contains:key => classes.has(key) },
      addEventListener:(name, callback) => events.set(name, callback),
      emit:async (name, event = {}) => events.get(name)?.({ target:value, ...event }),
      setAttribute:(name, content) => { value[name] = content; },
      showModal:() => { value.open = true; },
      close:() => { value.open = false; events.get('close')?.(); },
      scrollIntoView:() => { value.scrolled = true; },
      focus:() => { focused = id; },
    };
    nodes.set(id, value);
    return value;
  };
  const cssRules = [':root', '#app-background', '#conversation-background', '.appearance-preview'].map(selectorText => ({ selectorText, style:{ setProperty:(key, value) => rules.set(selectorText + key, value) } }));
  const pending = (kind, patch) => new Promise((resolve, reject) => requests.push({ kind, patch:patch && { ...patch }, resolve, reject }));
  const window = { forge:{
    getAppearance:async () => state,
    onEvent:callback => { listener = callback; },
    setAppearance:patch => pending('set', patch),
    importBackground:() => pending('import'),
    resetBackground:() => pending('reset'),
  } };
  const colorContext = { module:{exports:{}} };
  vm.runInNewContext(colorsSource, colorContext);
  window.ForgeConversationColors = colorContext.module.exports;
  const presetIds = ['aurora','rose','amber','forest','ocean','snow','midnight'];
  window.ForgeBackgroundPresets = {
    normalize:value => presetIds.includes(value) ? value : 'aurora',
    get:value => ({id:value,name:value,description:value,image:value === 'aurora' ? 'url("./aurora-background.svg")' : `linear-gradient(${value})`}),
  };
  const buttons = Object.keys(window.ForgeConversationColors.choices).map(color => {
    const button = node('text-color-' + color); button.dataset.textColor = color; return button;
  });
  const presetButtons = presetIds.map(preset => {
    const button = node('preset-' + preset); button.dataset.backgroundPreset = preset; return button;
  });
  const styleButtons = ['glass', 'black', 'white', 'industrial', 'deepseek', 'codex'].map(style => {
    const button = node('style-' + style); button.dataset.uiStyle = style; return button;
  });
  const selectionButtons = ['#6b9eff','#4cbfc3','#63b77b','#dbb254','#e69a5c','#de737d','#a28ae7','#d382bd'].map(color => {
    const button = node('selection-' + color); button.dataset.selectionColor = color; return button;
  });
  vm.runInNewContext(source, { window,
    document:{ getElementById:node, querySelectorAll:selector => selector.startsWith('#conversation-text-colors') ? buttons
      : selector.startsWith('#background-preset-options') ? presetButtons : selector.startsWith('#ui-style-options') ? styleButtons
      : selector.startsWith('#selection-color-options') ? selectionButtons : [], documentElement:node('html'), styleSheets:[{cssRules}] },
    setTimeout:callback => { const id = ++timer; timers.set(id, callback); return id; }, clearTimeout:id => timers.delete(id) });
  await window.synoraAppearance.ready;
  const broadcast = patch => { state = { ...state, ...patch }; listener({type:'appearance',appearance:{...state}}); };
  const complete = (request, { emit = true } = {}) => {
    state = { ...state, ...(request.patch || {}) };
    if (request.patch?.backgroundPreset || request.kind === 'reset') state = {...state,backgroundImage:null,backgroundName:''};
    if (request.kind === 'reset') state = {...state,backgroundTransparency:28,backgroundPreset:'aurora'};
    if (emit) listener({type:'appearance',appearance:{...state}});
    request.resolve({ ...state });
  };
  const edit = async (id, value, flush = true) => {
    node(id).value = String(value);
    await node(id).emit('input');
    if (flush) { void node(id).emit('change'); await turn(); }
  };
  return { node, requests, rules, timers, window, edit, broadcast, complete, state:() => state, focus:() => focused };
}

test('global panel frost and transparency preview independently and save only changed fields', async () => {
  const f = await fixture();
  assert.equal(f.rules.get(':root--panel-frost-filter'), 'blur(28px) saturate(140%)');
  assert.equal(f.rules.get(':root--panel-opacity'), '0.7');
  await f.edit('panel-frost', 0, false);
  await f.edit('panel-transparency', 100, false);
  assert.equal(f.rules.get(':root--panel-frost-filter'), 'none');
  assert.equal(f.rules.get(':root--panel-opacity'), '0');
  const done = f.window.synoraAppearance.settled(); await turn();
  assert.deepEqual(f.requests[0].patch, {panelFrost:0,panelTransparency:100});
  f.complete(f.requests[0]); await done;
  assert.equal(f.node('appearance-status').hidden, true, 'Dragging must not create a save-success hint');
  assert.equal(f.node('panel-frost-value').value, '0%');
  assert.equal(f.node('panel-transparency-value').value, '100%');
  await f.edit('panel-frost', 100, false);
  await f.edit('panel-transparency', 0);
  assert.equal(f.rules.get(':root--panel-frost-filter'), 'blur(40px) saturate(157.14%)');
  assert.equal(f.rules.get(':root--panel-opacity'), '1');
  f.complete(f.requests[1]); await f.window.synoraAppearance.settled();
  assert.equal(f.window.synoraAppearance.openFrost, undefined);
});

test('appearance preserves newer local edits and accepts unrelated cross-window fields', async () => {
  const f = await fixture();
  await f.edit('panel-frost', 20);
  const first = f.requests[0];
  await f.edit('panel-frost', 35);
  await f.edit('panel-transparency', 90, false);
  f.broadcast({panelFrost:20,conversationTextColor:'blue',backgroundTransparency:42});
  assert.equal(f.node('panel-frost').value, '35');
  assert.equal(f.node('panel-transparency').value, '90');
  assert.equal(f.rules.get(':root--conversation-text-color'), '#86b9ff');
  assert.equal(f.node('background-transparency').value, '42');
  first.resolve({...defaults,panelFrost:20}); await turn();
  assert.equal(f.rules.get(':root--conversation-text-color'), '#86b9ff', 'Old reply replaced a newer committed event');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].patch, {panelFrost:35});
  f.complete(f.requests[1]);
  const done = f.window.synoraAppearance.settled(); await turn();
  assert.deepEqual(f.requests[2].patch, {panelTransparency:90});
  f.complete(f.requests[2]); await done;
  assert.equal(f.node('panel-frost').value, '35');
  assert.equal(f.rules.get(':root--conversation-text-color'), '#86b9ff');
  assert.equal(f.node('panel-transparency').value, '90');
  assert.equal(f.rules.get(':root--panel-opacity'), '0.1');
});

test('failed saves roll back only matching edits and leave later changes retryable', async () => {
  const f = await fixture();
  await f.edit('panel-frost', 20, false);
  await f.edit('panel-transparency', 25);
  await f.edit('panel-frost', 40);
  f.broadcast({panelTransparency:80,backgroundTransparency:60});
  f.requests[0].reject(new Error('磁盘不可写')); await turn();
  assert.equal(f.node('panel-frost').value, '40', 'Failure rolled back a newer local edit');
  assert.equal(f.node('panel-transparency').value, '80', 'Failure did not use the latest persisted value');
  assert.equal(f.node('background-transparency').value, '60');
  assert.equal(f.rules.get(':root--panel-opacity'), '0.2');
  assert.equal(f.node('appearance-status').textContent, '磁盘不可写');
  assert.deepEqual(f.requests[1].patch, {panelFrost:40});
  f.complete(f.requests[1]); await f.window.synoraAppearance.settled();
  await f.edit('panel-transparency', 30);
  assert.equal(f.node('appearance-status').hidden, true);
  f.complete(f.requests[2]); await f.window.synoraAppearance.settled();
  assert.equal(f.node('panel-transparency').value, '30');
});

test('frost reset flushes pending transparency and changes only global frost', async () => {
  const f = await fixture();
  await f.edit('background-transparency', 64, false);
  await f.edit('panel-transparency', 77, false);
  f.broadcast({panelFrost:10,conversationTextColor:'green'});
  const reset = f.node('frost-reset').emit('click'); await turn();
  assert.equal(f.node('background-import').disabled, true);
  assert.equal(f.node('panel-transparency').disabled, true);
  assert.deepEqual(f.requests[0].patch, {backgroundTransparency:64,panelTransparency:77});
  f.complete(f.requests[0]); await turn();
  assert.deepEqual(f.requests[1].patch, {panelFrost:70});
  f.complete(f.requests[1]); await reset;
  assert.equal(f.node('background-transparency').value, '64');
  assert.equal(f.node('background-import').disabled, false);
  assert.equal(f.node('panel-transparency').disabled, false);
  assert.equal(f.node('panel-transparency').value, '77');
  assert.equal(f.rules.get(':root--panel-opacity'), '0.23');
  assert.equal(f.rules.get(':root--conversation-text-color'), '#79e6a2');
});

test('color changes preview immediately and preserve newer intent across stale replies', async () => {
  const f = await fixture();
  await f.node('text-color-red').emit('click'); await turn();
  assert.equal(f.rules.get(':root--conversation-text-color'), '#ff6b6b');
  assert.equal(f.node('text-color-red')['aria-pressed'], 'true');
  assert.deepEqual(f.requests[0].patch, {conversationTextColor:'red'});
  await f.node('text-color-blue').emit('click');
  f.broadcast({conversationTextColor:'red',panelFrost:15,panelTransparency:55,backgroundTransparency:42});
  assert.equal(f.rules.get(':root--conversation-text-color'), '#86b9ff');
  assert.equal(f.node('panel-frost').value, '15');
  assert.equal(f.node('background-transparency').value, '42');
  f.requests[0].resolve({...defaults,conversationTextColor:'red'}); await turn();
  assert.deepEqual(f.requests[1].patch, {conversationTextColor:'blue'});
  f.complete(f.requests[1]); await f.window.synoraAppearance.settled();
  assert.equal(f.node('text-color-blue')['aria-pressed'], 'true');
  assert.equal(f.node('text-color-red')['aria-pressed'], 'false');
  assert.equal(f.node('panel-frost').value, '15');
  const reset = f.node('frost-reset').emit('click'); await turn();
  assert.equal(f.node('text-color-blue').disabled, true);
  assert.deepEqual(f.requests[2].patch, {panelFrost:70});
  f.complete(f.requests[2]); await reset;
  assert.equal(f.rules.get(':root--conversation-text-color'), '#86b9ff');
  assert.equal(f.node('text-color-blue').disabled, false);
  const resetBackground = f.node('background-reset').emit('click'); await turn();
  assert.equal(f.requests[3].kind, 'reset');
  f.complete(f.requests[3]); await resetBackground;
  assert.equal(f.rules.get(':root--conversation-text-color'), '#86b9ff');
  assert.equal(f.node('background-transparency').value, '28');
  assert.equal(f.node('panel-transparency').value, '55');
  assert.equal(f.rules.get(':root--panel-opacity'), '0.45');
});

test('selection palette previews instantly, survives stale commits and follows cross-window changes in every material', async () => {
  const f = await fixture();
  assert.equal(f.node('html').dataset.selectionColor, 'default');
  await f.node('selection-#dbb254').emit('click'); await turn();
  assert.equal(f.node('html').dataset.selectionColor, 'custom');
  assert.equal(f.rules.get(':root--custom-selection-color'), '#dbb254');
  assert.equal(f.rules.get(':root--custom-selection-ink'), '#000000');
  assert.equal(f.node('selection-#dbb254')['aria-pressed'], 'true');
  assert.deepEqual(f.requests[0].patch, { selectionColor: '#dbb254' });
  await f.edit('selection-color-input', '#010203');
  f.broadcast({ selectionColor: '#dbb254', uiStyle: 'white' });
  assert.equal(f.rules.get(':root--custom-selection-color'), '#010203');
  assert.equal(f.rules.get(':root--custom-selection-ink'), '#ffffff');
  assert.equal(f.node('html').dataset.uiStyle, 'white');
  f.requests[0].resolve({ ...defaults, selectionColor: '#dbb254' }); await turn();
  assert.deepEqual(f.requests[1].patch, { selectionColor: '#010203' });
  f.complete(f.requests[1]); await f.window.synoraAppearance.settled();
  for (const uiStyle of ['glass', 'black', 'white', 'industrial', 'deepseek', 'codex']) {
    f.broadcast({ uiStyle });
    assert.equal(f.node('selection-color-input').value, '#010203');
    assert.equal(f.rules.get(':root--custom-selection-color'), '#010203');
  }
  f.broadcast({ selectionColor: '#4cbfc3' });
  assert.equal(f.node('selection-#4cbfc3')['aria-pressed'], 'true');
  assert.equal(f.node('selection-color-value').value, '#4CBFC3');
});

test('selection color restores default independently and failed saves roll back to the latest persisted palette', async () => {
  const f = await fixture();
  f.broadcast({ selectionColor: '#de737d', uiStyle: 'industrial', panelFrost: 23 });
  await f.edit('selection-color-input', '#000000');
  f.broadcast({ selectionColor: '#63b77b' });
  f.requests[0].reject(new Error('磁盘不可写')); await turn();
  assert.equal(f.node('selection-color-input').value, '#63b77b');
  assert.equal(f.rules.get(':root--custom-selection-ink'), '#000000');
  assert.equal(f.node('appearance-status').textContent, '磁盘不可写');
  await f.node('selection-color-reset').emit('click'); await turn();
  assert.deepEqual(f.requests[1].patch, { selectionColor: null });
  f.complete(f.requests[1]); await f.window.synoraAppearance.settled();
  assert.equal(f.node('html').dataset.selectionColor, 'default');
  assert.equal(f.node('selection-color-value').value, '默认');
  assert.equal(f.node('html').dataset.uiStyle, 'industrial');
  assert.equal(f.node('panel-frost').value, '23');
});

test('custom accent labels remain readable after material changes without changing the selected color', async () => {
  const f = await fixture();
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const selectionColor of ['#010203', '#fefefe', '#de737d']) {
    for (const [uiStyle, background] of Object.entries({ glass: '#28334b', black: '#171717', white: '#e8eaed', industrial: '#2b3138', deepseek: '#202226', codex: '#292a2d' })) {
      f.broadcast({ selectionColor, uiStyle });
      assert.equal(f.rules.get(':root--custom-selection-color'), selectionColor);
      const foreground = f.rules.get(':root--custom-accent-text');
      assert.match(foreground, /^#[0-9a-f]{6}$/);
      const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
      assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, `${selectionColor} on ${uiStyle} needs readable accent text`);
    }
  }
});

test('the color style produces five distinct increasing usage shades for saturated colors and black or white', async () => {
  const f = await fixture();
  for (const selectionColor of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#dbb254', '#4cbfc3']) {
    f.broadcast({ selectionColor });
    const shades = Array.from({ length: 5 }, (_, index) => f.rules.get(`:root--custom-usage-level-${index + 1}`));
    assert.equal(new Set(shades).size, 5, `${selectionColor} needs distinguishable usage levels`);
    shades.forEach(shade => assert.match(shade, /^#[0-9a-f]{6}$/));
    for (let index = 1; index < shades.length; index++) {
      const channels = hex => hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
      const previous = channels(shades[index - 1]), next = channels(shades[index]);
      assert.ok(next.every((value, channel) => value > previous[channel]), `${selectionColor} must brighten at every level`);
    }
    const before = [...shades];
    f.broadcast({ uiStyle: 'white' });
    assert.deepEqual(Array.from({ length: 5 }, (_, index) => f.rules.get(`:root--custom-usage-level-${index + 1}`)), before);
  }
  f.broadcast({ selectionColor: '#dbb254' });
  const gold = f.rules.get(':root--custom-usage-level-3');
  f.broadcast({ selectionColor: '#4cbfc3' });
  assert.notEqual(f.rules.get(':root--custom-usage-level-3'), gold, 'Changing the accent updates dashboard colors immediately');
  f.broadcast({ selectionColor: null });
  assert.equal(f.node('html').dataset.selectionColor, 'default');
});

test('built-in backgrounds replace imported images immediately without changing other edits', async () => {
  const f = await fixture();
  f.broadcast({backgroundImage:'data:image/png;base64,V0hJVEU=',backgroundName:'white.png',conversationTextColor:'green',panelFrost:15,panelTransparency:45});
  await f.edit('background-transparency', 64, false);
  await f.node('preset-rose').emit('click'); await turn();
  assert.equal(f.rules.get('#app-backgroundbackground-image'), 'linear-gradient(rose)');
  assert.equal(f.node('background-name').textContent, 'rose');
  assert.equal(f.node('preset-rose')['aria-pressed'], 'true');
  assert.equal(f.node('html').classList.contains('custom-background'), false);
  assert.deepEqual(f.requests[0].patch, {backgroundTransparency:64,backgroundPreset:'rose'});
  await f.node('preset-ocean').emit('click');
  f.complete(f.requests[0]); await turn();
  assert.equal(f.rules.get('#app-backgroundbackground-image'), 'linear-gradient(ocean)');
  assert.deepEqual(f.requests[1].patch, {backgroundPreset:'ocean'});
  f.complete(f.requests[1]); await f.window.synoraAppearance.settled();
  assert.equal(f.node('preset-ocean')['aria-pressed'], 'true');
  assert.equal(f.node('preset-rose')['aria-pressed'], 'false');
  assert.equal(f.node('background-transparency').value, '64');
  assert.equal(f.node('panel-frost').value, '15');
  assert.equal(f.node('panel-transparency').value, '45');
  assert.equal(f.rules.get(':root--conversation-text-color'), '#79e6a2');
  f.broadcast({backgroundImage:'data:image/png;base64,V0hJVEU=',backgroundName:'new.png'});
  assert.equal(f.node('preset-ocean')['aria-pressed'], 'false');
  assert.equal(f.node('html').classList.contains('custom-background'), true);
});

test('all six style choices persist only their style while retaining imported image and independent settings', async () => {
  const f = await fixture();
  const image = 'data:image/png;base64,V0hJVEU=';
  f.broadcast({ backgroundImage: image, backgroundName: 'saved.png', backgroundTransparency: 61, panelFrost: 18, selectionColor: '#4cbfc3' });
  for (const uiStyle of ['deepseek', 'codex', 'black', 'white', 'industrial', 'glass']) {
    const before = f.requests.length;
    await f.node('style-' + uiStyle).emit('click'); await turn();
    assert.equal(f.node('html').dataset.uiStyle, uiStyle);
    assert.equal(f.node('style-' + uiStyle)['aria-pressed'], 'true');
    assert.equal(f.node('glass-appearance-settings').hidden, uiStyle !== 'glass');
    assert.deepEqual(f.requests[before].patch, { uiStyle });
    f.complete(f.requests[before]); await f.window.synoraAppearance.settled();
    assert.equal(f.state().backgroundImage, image);
    assert.equal(f.node('background-name').textContent, 'saved.png');
    assert.equal(f.node('background-transparency').value, '61');
    assert.equal(f.node('panel-frost').value, '18');
    assert.equal(f.node('selection-color-input').value, '#4cbfc3');
    for (const selector of ['#app-background', '#conversation-background']) {
      assert.equal(f.rules.get(selector + 'background-image'), `url("${image}")`);
      assert.equal(f.rules.get(selector + '--background-opacity'), '0.39');
    }
  }
});

test('each solid style can import and reset its conversation image without switching the chosen material', async () => {
  for (const uiStyle of ['black', 'white', 'industrial', 'deepseek', 'codex']) {
    const f = await fixture();
    f.broadcast({ uiStyle, panelFrost: 25, panelTransparency: 44 });
    const importing = f.window.synoraAppearance.importBackground(); await turn();
    assert.equal(f.requests[0].kind, 'import');
    const image = 'data:image/png;base64,V0hJVEU=';
    f.requests[0].resolve({ ...f.state(), backgroundImage: image, backgroundName: `${uiStyle}.png` });
    await importing;
    assert.equal(f.node('html').dataset.uiStyle, uiStyle);
    assert.equal(f.node('html').classList.contains('custom-background'), true);
    assert.equal(f.rules.get('#conversation-backgroundbackground-image'), `url("${image}")`);
    assert.doesNotMatch(f.node('appearance-status').textContent, /切换.*玻璃/u);
    const resetting = f.node('background-reset').emit('click'); await turn();
    assert.equal(f.requests[1].kind, 'reset');
    f.complete(f.requests[1]); await resetting;
    assert.equal(f.node('html').dataset.uiStyle, uiStyle);
    assert.equal(f.node('html').classList.contains('custom-background'), false);
    assert.equal(f.node('background-transparency').value, '28');
    assert.equal(f.node('panel-frost').value, '25');
    assert.equal(f.node('panel-transparency').value, '44');
  }
});

test('newer cross-window image and style events cannot be replaced by an older transparency response', async () => {
  const f = await fixture();
  f.broadcast({ uiStyle: 'deepseek', backgroundImage: 'data:image/png;base64,QUFBQQ==', backgroundName: 'old.png' });
  await f.edit('background-transparency', 75);
  f.broadcast({ uiStyle: 'codex', backgroundImage: 'data:image/png;base64,QkJCQg==', backgroundName: 'new.png', backgroundTransparency: 75 });
  f.requests[0].resolve({ ...defaults, uiStyle: 'deepseek', backgroundImage: 'data:image/png;base64,QUFBQQ==', backgroundName: 'old.png', backgroundTransparency: 75 });
  await f.window.synoraAppearance.settled();
  assert.equal(f.node('html').dataset.uiStyle, 'codex');
  assert.equal(f.node('background-name').textContent, 'new.png');
  for (const selector of ['#app-background', '#conversation-background']) {
    assert.equal(f.rules.get(selector + 'background-image'), 'url("data:image/png;base64,QkJCQg==")');
    assert.equal(f.rules.get(selector + '--background-opacity'), '0.25');
  }
});
