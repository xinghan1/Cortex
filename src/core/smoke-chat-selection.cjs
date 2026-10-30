// Native text drag and right-click actions in the shipped chat renderer.
// Clipboard is seeded before any read; search dispatch is intercepted before
// browserOpen, while the real internal-browser panel is shown. No network runs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, clipboard } = require('electron');

module.exports = async function smokeChatSelection({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Chat selection smoke needs a disposable offscreen parent');
  const nonce = randomUUID(), project = path.join(dataDir, 'chat-selection-' + nonce);
  const query = 'Synora code 中文 & /?+#', first = 'SELECT_START ' + query + ' SELECT_END', second = 'SECOND_CHAT_MESSAGE_' + nonce;
  const seed = 'CHAT_CLIPBOARD_SEED_' + nonce, composer = 'COMPOSER_MUST_NOT_BE_SELECTED_' + nonce;
  const screenshots = [], clipboardWrites = [];
  const originalClipboardWrite = clipboard.writeText;
  let child, seeded = false, clipboardReadbackAvailable = false, stage = 'isolated chat setup';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = async (promise, label, timeout = 15000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chat selection timed out: ' + label)), timeout); })]); }
    finally { clearTimeout(timer); }
  };
  const js = code => bounded(child.webContents.executeJavaScript(code), 'renderer operation');
  const invoke = (name, value) => `window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (name, value) => js(invoke(name, value));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now())); if (value) return value; await wait(25); }
    throw new Error('Chat selection timed out: ' + label);
  };
  const inspect = () => js(`(() => {const n=$('chat-selection-menu'),r=n.getBoundingClientRect();return {hidden:n.hidden,items:[...n.querySelectorAll('button[data-chat-action]')].map(b=>({action:b.dataset.chatAction,text:b.textContent.trim(),disabled:b.disabled})),bounds:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},selection:window.getSelection().toString(),notice:$('notice').textContent,inputs:window.__chatSelectionSmoke.inputs,searches:window.__chatSelectionSmoke.searches};})()`);
  const capture = async filename => {
    child.webContents.invalidate(); await wait(160);
    const image = await bounded(child.webContents.capturePage(), 'capture ' + filename, 10000); assert.equal(image.isEmpty(), false);
    await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename);
  };
  const at = async (selector, inside = false) => until('uncovered target ' + selector, () => js(`(() => {
    const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
    if(!n.closest('#chat-selection-menu'))n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+${inside ? 'Math.min(25,r.width/2)' : 'r.width/2'}),y:Math.round(r.top+r.height/2)};
    return r.width&&r.height&&n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
  const pointer = async (point, button = 'left') => {
    child.focus(); child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button, clickCount: 1 }) });
    await wait(60);
  };
  const click = async selector => pointer(await at(selector));
  const key = async keyCode => {
    child.focus(); child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') child.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait(80);
  };
  const select = async (target = 'first', text = query) => js(`(() => {
    const el=document.getElementById(${JSON.stringify(target === 'first' ? 'chat-selection-first' : 'chat-selection-second')});if($('chat-selection-menu').hidden)el.scrollIntoView({block:'center',behavior:'instant'});
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){const i=n.textContent.indexOf(${JSON.stringify(text)});if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+${text.length});const s=window.getSelection();s.removeAllRanges();s.addRange(r);const b=r.getBoundingClientRect();return {text:s.toString(),x:Math.round(b.left+Math.min(8,b.width/2)),y:Math.round(b.top+b.height/2)};}}
    throw new Error('Missing fixture text to select');})()`);
  const right = async point => {
    await pointer(point, 'right');
    await until('native chat menu opens', () => js(`!$('chat-selection-menu').hidden&&$('chat-selection-menu').getBoundingClientRect().height>90`));
    await wait(320);
    const value = await inspect(); assert.deepEqual(value.items.map(item => item.action), ['copy', 'select-all', 'search', 'ask']);
    assert.deepEqual(value.items.map(item => item.text), ['复制', '选择全部', '搜索浏览器', '在侧边栏中提问']);
    assert.ok(value.bounds.left >= 0 && value.bounds.top >= 0 && value.bounds.right <= value.viewport.width && value.bounds.bottom <= value.viewport.height, 'The complete menu stays inside the viewport');
    return value;
  };
  const selectedRight = async () => right(await select());
  const menuClosed = () => until('chat menu closes', () => js(`$('chat-selection-menu').hidden`));
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.focus(); child.webContents.focus();
    await until('renderer initialized', () => js('Boolean(appState&&window.forge&&window.ForgeChatSelectionMenu&&chatSelectionMenu&&!projectSwitching)'));
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated chat project selected', async () => (await call('getState')).workspace.root === project && await js('!projectSwitching'));
    await js(`(() => {
      clearConversation();const first=addMessage('assistant',${JSON.stringify(first)},false,{historical:true});first.body.id='chat-selection-first';
      const second=addMessage('user',${JSON.stringify(second)},false,{historical:true});second.body.id='chat-selection-second';
      $('task-input').value=${JSON.stringify(composer)};
      window.__chatSelectionSmoke={inputs:[],searches:[],originalOpen:browserController.open};
      document.addEventListener('contextmenu',e=>window.__chatSelectionSmoke.inputs.push({type:'contextmenu',trusted:e.isTrusted,inside:!!e.target.closest('#messages')}),true);
      document.addEventListener('pointerdown',e=>{if(e.isTrusted&&e.target.closest('#messages'))window.__chatSelectionSmoke.inputs.push({type:'pointerdown',trusted:e.isTrusted,button:e.button});},true);
      $('chat-selection-menu').addEventListener('click',e=>window.__chatSelectionSmoke.inputs.push({type:'menu-click',trusted:e.isTrusted,action:e.target.closest('button')?.dataset.chatAction}));
      browserController.open=async arg=>{window.__chatSelectionSmoke.searches.push(arg);browserController.show();browserController.apply({url:arg.url,title:'Search intercepted before network',exists:false});};true;
    })()`);
    clipboard.writeText = async function (...args) {
      clipboardWrites.push({ text: args[0], source: 'real-electron-clipboard-call' });
      return await originalClipboardWrite.apply(this, args);
    };
    await clipboard.writeText(seed); seeded = true;
    clipboardReadbackAvailable = await clipboard.readText() === seed;

    stage = 'native left-button drag selects exact conversation text';
    const drag = await js(`(() => {const el=$('chat-selection-first');el.scrollIntoView({block:'center',behavior:'instant'});const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const i=n.textContent.indexOf(${JSON.stringify(query)});if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+${query.length});const b=r.getBoundingClientRect();window.getSelection().removeAllRanges();return {x1:b.left+1,x2:b.right-1,y:b.top+b.height/2};}}throw new Error('Missing native drag fixture');})()`);
    child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(drag.x1), y: Math.round(drag.y) });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(drag.x1), y: Math.round(drag.y) });
    for (let step = 1; step <= 12; step++) {
      child.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(drag.x1 + (drag.x2 - drag.x1) * step / 12), y: Math.round(drag.y), modifiers: ['leftButtonDown'] }); await wait(12);
    }
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(drag.x2), y: Math.round(drag.y) });
    await until('exact selected text from native drag', () => js(`window.getSelection().toString()===${JSON.stringify(query)}`));
    const selectedPoint = { x: Math.round(drag.x1 + 8), y: Math.round(drag.y) };
    await pointer(selectedPoint, 'right');
    await until('point-anchored menu animation', () => js(`!$('chat-selection-menu').hidden && $('chat-selection-menu').getAnimations().some(a=>a.effect?.getKeyframes().length)`));
    const motion = await js(`(()=>{const n=$('chat-selection-menu'),r=n.getBoundingClientRect(),a=n.getAnimations().find(a=>a.effect?.getKeyframes().length);a.pause();a.currentTime=0;return {rect:{left:r.left,top:r.top,width:r.width,height:r.height},frame:a.effect.getKeyframes()[0].clipPath};})()`);
    const inset = motion.frame.match(/^inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px/u);
    assert.ok(inset, 'Context menu reveals from a point');
    const [, top, rightInset, bottom, left] = inset.map(Number);
    assert.ok(Math.abs(motion.rect.left + left - Math.max(motion.rect.left, Math.min(selectedPoint.x, motion.rect.left + motion.rect.width - 1))) <= 1);
    assert.ok(Math.abs(motion.rect.top + top - Math.max(motion.rect.top, Math.min(selectedPoint.y, motion.rect.top + motion.rect.height - 1))) <= 1);
    assert.ok(motion.rect.width - left - rightInset <= 1.1 && motion.rect.height - top - bottom <= 1.1);
    await js(`$('chat-selection-menu').getAnimations().forEach(a=>a.finish());true`);
    let value = await inspect(); assert.ok(value.items.every(item => !item.disabled));
    await capture('chat-selection-native-menu.png');

    stage = 'copy uses captured selected text even after focus or range changes';
    await js(`(()=>{const el=$('chat-selection-second'),walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),n=walker.nextNode(),r=document.createRange();r.selectNodeContents(n);const s=window.getSelection();s.removeAllRanges();s.addRange(r);})()`);
    await click('#chat-selection-menu [data-chat-action="copy"]'); await menuClosed();
    await until('copy IPC reaches real clipboard with captured native drag', () => clipboardWrites.some(record => record.text === query));
    if (clipboardReadbackAvailable) assert.equal(await clipboard.readText(), query);
    assert.equal(await js(`$('chat-selection-first').textContent`), first, 'Copy never edits the conversation');

    stage = 'select all is scoped to the conversation';
    await selectedRight(); await click('#chat-selection-menu [data-chat-action="select-all"]'); await menuClosed();
    value = await inspect(); assert.ok(value.selection.includes(first)); assert.ok(value.selection.includes(second));
    assert.equal(value.selection.includes(composer), false); assert.equal(value.selection.includes('搜索浏览器'), false);
    assert.equal(await js(`(()=>{const s=window.getSelection(),r=s.getRangeAt(0);return $('messages').contains(r.startContainer)&&$('messages').contains(r.endContainer);})()`), true);

    stage = 'search dispatches selected keywords to the internal browser with exact URL encoding';
    await selectedRight(); await click('#chat-selection-menu [data-chat-action="search"]'); await menuClosed();
    const expectedURL = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
    await until('one intercepted internal browser search', () => js('window.__chatSelectionSmoke.searches.length===1'));
    const browser = await js(`({searches:window.__chatSelectionSmoke.searches,panelVisible:!$('preview-panel').hidden,browserVisible:!$('browser-preview').hidden,address:$('browser-address').value})`);
    assert.deepEqual(browser.searches, [{ url: expectedURL }]); assert.equal(browser.panelVisible, true); assert.equal(browser.browserVisible, true);
    await capture('chat-selection-internal-search.png');
    await js('setPreviewOpen(false);true');

    stage = 'empty and foreign selections disable copy/search without reading other UI text';
    await js('window.getSelection().removeAllRanges();true');
    value = await right(await at('#chat-selection-first', true));
    assert.deepEqual(value.items.map(item => item.disabled), [true, false, true, true]); await key('Escape'); await menuClosed();
    await js(`(()=>{const r=document.createRange();r.selectNodeContents($('project-switcher'));const s=window.getSelection();s.removeAllRanges();s.addRange(r);})()`);
    value = await right(await at('#chat-selection-first', true));
    assert.deepEqual(value.items.map(item => item.disabled), [true, false, true, true]); await key('Escape');
    if (clipboardReadbackAvailable) assert.equal(await clipboard.readText(), query);
    assert.equal(clipboardWrites.at(-1).text, query);

    stage = 'composer is excluded and Escape, outside click, scroll and new session close the menu';
    await pointer(await at('#task-input', true), 'right'); await wait(120); assert.equal((await inspect()).hidden, true);
    await selectedRight(); await key('Escape'); await menuClosed();
    await selectedRight(); await click('#task-input'); await menuClosed();
    await selectedRight(); await js(`$('message-scroll').dispatchEvent(new Event('scroll'));true`); await menuClosed();

    stage = 'all four appearance styles preserve exactly four fully visible actions';
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      await call('setAppearance', { uiStyle: style }); await js('window.synoraAppearance.settled()'); await selectedRight();
      await capture('chat-selection-' + style + '.png'); await key('Escape');
    }
    stage = 'streaming replacement invalidates the captured old range';
    await clipboard.writeText(seed);
    const writesBeforeStaleCopy = clipboardWrites.length;
    await selectedRight(); await js(`$('chat-selection-first').replaceChildren(document.createTextNode('REPLACED_CHAT_TEXT'));true`);
    await click('#chat-selection-menu [data-chat-action="copy"]'); await menuClosed();
    assert.equal(clipboardWrites.length, writesBeforeStaleCopy, 'Removed text cannot be copied through a stale menu');
    if (clipboardReadbackAvailable) assert.equal(await clipboard.readText(), seed);
    await js(`renderText($('chat-selection-first'),${JSON.stringify(first)});true`);
    await selectedRight();
    await js('newSession()'); await menuClosed();
    assert.equal(clipboardWrites.length, writesBeforeStaleCopy); assert.equal((await inspect()).searches.length, 1);
    if (clipboardReadbackAvailable) assert.equal(await clipboard.readText(), seed);
    const input = (await inspect()).inputs;
    assert.ok(input.some(event => event.type === 'pointerdown' && event.button === 0 && event.trusted));
    assert.ok(input.filter(event => event.type === 'contextmenu' && event.inside).length >= 10);
    assert.ok(input.every(event => event.trusted), 'Menu opening and text drag use native input events');
    const result = { status: 'completed', version: require('../../package.json').version, realExternalApi: false, realNetwork: false, realCommands: false,
      nativeLeftDragSelectsExactText: true, nativeRightClickFourActions: true, capturedTextDispatchedThroughRealClipboardAPI: true,
      systemClipboardReadbackUnavailable: !clipboardReadbackAvailable, systemClipboardReadbackVerified: clipboardReadbackAvailable, clipboardWrites,
      selectAllOnlyConversation: true, internalBrowserPanelShown: true, selectedKeywordsURLEncoded: true, browserOpenInterceptedBeforeNetwork: true,
      emptyAndForeignSelectionDisabled: true, composerExcluded: true, escapeOutsideScrollAndSessionDismiss: true, staleStreamingSelectionRejected: true, fourMaterialsVisible: true,
      priorClipboardNeverRead: true, browser, trustedContextMenus: input.filter(event => event.type === 'contextmenu').length, screenshots };
    await fs.writeFile(path.join(output, 'chat-selection-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const result = { status: 'failed', stage, error: error.message, stack: error.stack };
    if (child && !child.isDestroyed()) try { result.ui = await inspect(); result.clipboardWrites = clipboardWrites; result.systemClipboardReadbackUnavailable = !clipboardReadbackAvailable; await capture('chat-selection-failure.png'); } catch (diagnostic) { result.diagnosticError = diagnostic.message; }
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'chat-selection-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      await js(`if(window.__chatSelectionSmoke?.originalOpen)browserController.open=window.__chatSelectionSmoke.originalOpen;chatSelectionMenu?.close();true`).catch(() => {});
      child.close(); await until('fixture window closed', () => child.isDestroyed()).catch(() => child.destroy());
    }
    clipboard.writeText = originalClipboardWrite;
    if (seeded) await clipboard.clear();
  }
};
