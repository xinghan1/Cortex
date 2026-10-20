import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/appearance.js', import.meta.url), 'utf8');
const colorsSource = await readFile(new URL('../src/renderer/conversation-colors.js', import.meta.url), 'utf8');
const defaults = { backgroundImage:null, backgroundName:'', backgroundTransparency:28, panelFrost:70, panelTransparency:30, conversationTextColor:'white', backgroundPreset:'aurora' };
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
  const cssRules = [':root', '#app-background', '.appearance-preview'].map(selectorText => ({ selectorText, style:{ setProperty:(key, value) => rules.set(selectorText + key, value) } }));
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
  vm.runInNewContext(source, { window,
    document:{ getElementById:node, querySelectorAll:selector => selector.startsWith('#conversation-text-colors') ? buttons : presetButtons, documentElement:node('html'), styleSheets:[{cssRules}] },
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
