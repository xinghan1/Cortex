// Real renderer messages/history and native navigation input. No model,
// command, project mutation, or replay of a user task is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeRoundNavigator({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), evidence = {}, screenshots = [];
  let child, attached = false, stage = 'isolated renderer setup';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Round navigator timed out: ' + label);
  };
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const tick = round => `.round-navigator-tick[data-round="${round}"]`;
  const pointFor = async selector => until('uncovered native control ' + selector, () => js(`(() => {
    const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
    n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    return r.width&&r.height&&n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
  const hover = async selector => { const point = await pointFor(selector); child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await wait(45); };
  const click = async selector => {
    const point = await pointFor(selector); child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await wait(45);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(45);
  };
  const snapshot = () => js(`(() => {
    const rail=$('round-navigator'),list=rail.querySelector('.round-navigator-list'),viewport=$('message-scroll'),tip=$('round-navigator-tooltip');
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const selected=rail.querySelector('[aria-current="step"]'),s=selected?getComputedStyle(selected):null;
    return {hidden:rail.hidden,count:rail.querySelectorAll('.round-navigator-tick').length,current:Number(selected?.dataset.round)||null,
      tabStops:[...rail.querySelectorAll('.round-navigator-tick')].filter(n=>n.tabIndex===0).length,
      labels:[...rail.querySelectorAll('.round-navigator-tick')].map(n=>n.getAttribute('aria-label')),
      rail:rect(rail),viewport:rect(viewport),composer:rect(document.querySelector('.composer-area')),
      list:{scrollTop:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight},scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight,
      tip:{hidden:tip.hidden,text:tip.textContent,box:rect(tip),images:tip.querySelectorAll('img').length,colour:getComputedStyle(tip).color,background:getComputedStyle(tip).backgroundColor},
      focused:document.activeElement?.dataset?.round||null,activeColour:s?.color,style:document.documentElement.dataset.uiStyle,
      followOutput,paused:fileDisclosureScrollPaused,events:window.__roundNavigatorSmoke?.navigations||[],
      nativeClicks:window.__roundNavigatorSmoke?.clicks||0,nativeWheels:window.__roundNavigatorSmoke?.wheels||0};})()`);
  const roundVisible = (round, prefix) => js(`(() => {
    const target=document.querySelector('.message.user[data-message-id='+JSON.stringify(${JSON.stringify(prefix + '-' + round)})+']');if(!target)return false;
    const r=target.getBoundingClientRect(),v=$('message-scroll').getBoundingClientRect(),current=$('round-navigator').querySelector('[aria-current="step"]');
    return current?.dataset.round===${JSON.stringify(String(round))}&&r.top>=v.top-2&&r.top<=v.top+25;})()`);
  const fixture = async (count, prefix = 'live-round', steering = true) => {
    await js(`(() => {
      cancelFileDisclosureReveal();clearInterval(taskActivityTimer);taskActivityTimer=null;pendingTools=[];activeTaskActivity=null;running=false;taskKind='agent';followOutput=false;fileDisclosureScrollPaused=false;
      window.ForgeUsageDashboard?.close(false,false);$('messages').replaceChildren();renderedUserMessageIds.clear();$('welcome').hidden=true;$('notice').hidden=true;setPreviewOpen(false);$('terminal-panel').hidden=true;
      for(let index=1;index<=${count};index++){
        const text=index===4?'第4轮：<img src=x onerror=window.__roundNavigatorXss=1> '+ '😀'.repeat(120):'第'+index+'轮：验证左侧轮次导航 '+${JSON.stringify(prefix)};
        addMessage('user',text,false,{id:${JSON.stringify(prefix)}+'-'+index,createdAt:'2026-10-22T01:00:00Z',source:index%2?'direct':'queue'});
        addMessage('assistant',Array.from({length:${count > 30 ? 3 : 12}},(_,line)=>'第'+index+'轮答复 · 第'+(line+1)+'行：滚动定位测试内容。').join('\\n\\n'));
        if(${Boolean(steering)}&&index%3===0)addMessage('user','仅引导，不应生成独立轮次',false,{id:'steering-'+index,source:'steering'});
      }
      $('message-scroll').scrollTop=0;true;})()`);
    return until('observed ' + count + ' real user rounds', async () => { const value = await snapshot(); return value.count === count && !value.hidden && value; });
  };
  const capture = async filename => {
    child.webContents.invalidate(); await wait(120); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
    await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename);
  };
  const bounded = value => {
    assert.ok(value.rail.top >= value.viewport.top - 2 && value.rail.bottom <= Math.min(value.viewport.bottom, value.composer.top) + 2, 'Navigation must stay inside the message viewport');
    assert.ok(value.rail.width <= 30 && value.rail.left >= value.viewport.left - 2, 'Navigation must remain a narrow rail');
  };
  try {
    await fs.mkdir(output, { recursive: true });
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('navigator and application ready', () => js('Boolean(appState&&window.synoraAppearance&&$("round-navigator")?.querySelector(".round-navigator-list")&&!projectSwitching)'));
    await js('window.synoraAppearance.ready');
    const appearance = await call('getAppearance');
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    child.webContents.debugger.attach('1.3'); attached = true;
    await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await js(`window.__roundNavigatorXss=0;window.__roundNavigatorSmoke={navigations:[],clicks:0,wheels:0};
      document.addEventListener('forge:round-navigate',event=>window.__roundNavigatorSmoke.navigations.push({...event.detail,followOutput,paused:fileDisclosureScrollPaused}));
      document.addEventListener('click',event=>{if(event.isTrusted&&event.target.closest('.round-navigator-tick'))window.__roundNavigatorSmoke.clicks++;},true);
      document.addEventListener('wheel',event=>{if(event.isTrusted)window.__roundNavigatorSmoke.wheels++;},true);true`);

    stage = 'live rounds exclude steering and expose native hover previews';
    let value = await fixture(8); bounded(value); assert.equal(value.current, 1); assert.equal(value.tabStops, 1);
    assert.ok(value.labels.every(label => !label.includes('仅引导')));
    await hover(tick(4));
    value = await until('native hover round 4 preview', async () => { const item = await snapshot(); return !item.tip.hidden && item.tip.text.startsWith('第 4 轮') && item; });
    assert.ok(value.tip.text.includes('<img')); assert.equal(value.tip.images, 0); assert.equal(await js('window.__roundNavigatorXss'), 0);
    assert.ok(await js('Array.from($("round-navigator-tooltip").querySelector("span").textContent).length<=101'));
    evidence.live = value;

    stage = 'native tick click navigates to its original prompt and disables output following synchronously';
    await js('followOutput=true;fileDisclosureScrollPaused=false;true');
    await click(tick(3)); await until('clicked round 3 original prompt aligned', () => roundVisible(3, 'live-round'));
    value = await snapshot(); assert.equal(value.followOutput, false); assert.equal(value.paused, true);
    const receipt = value.events.at(-1); assert.equal(receipt.round, 3); assert.equal(receipt.messageId, 'live-round-3');
    assert.equal(receipt.followOutput, false); assert.equal(receipt.paused, true); evidence.click = receipt;

    stage = 'native chat wheel updates the active tick without triggering navigation or replay';
    await wait(180);
    const beforeWheel = await snapshot(), wheelTarget = await js(`(() => {const r=$('message-scroll').getBoundingClientRect(),next=document.querySelector('.message.user[data-message-id="live-round-4"]').getBoundingClientRect();return {x:Math.round(r.left+r.width*.7),y:Math.round(r.top+r.height*.5),distance:Math.max(150,Math.ceil(next.top-r.top+60))};})()`);
    child.webContents.sendInputEvent({ type: 'mouseMove', x: wheelTarget.x, y: wheelTarget.y }); child.webContents.sendInputEvent({ type: 'mouseWheel', deltaX: 0, deltaY: -wheelTarget.distance, canScroll: true, x: wheelTarget.x, y: wheelTarget.y });
    value = await until('chat wheel scroll and active highlight', async () => { const item = await snapshot(); return item.scrollTop > beforeWheel.scrollTop + 100 && item.current > 3 && item; });
    assert.equal(value.events.length, beforeWheel.events.length); evidence.wheel = { from: beforeWheel.current, to: value.current, delta: value.scrollTop - beforeWheel.scrollTop };

    stage = 'native keyboard arrows, Home and End retain accessible focus and original anchors';
    await click(tick(3)); await until('round 3 ready for keyboard', () => roundVisible(3, 'live-round'));
    await key('Down'); await until('keyboard selects round 4', () => roundVisible(4, 'live-round'));
    assert.equal((await snapshot()).focused, '4');
    await key('Home'); await until('keyboard first round', async () => (await snapshot()).current === 1);
    await key('End'); await until('keyboard last round', async () => (await snapshot()).current === 8);
    value = await snapshot(); assert.equal(value.events.at(-1).round, 8); assert.equal(value.tabStops, 1); evidence.keyboard = value.current;

    stage = 'history and session replacement rebuild anchors without retaining old prompt references';
    const history = { id: randomUUID(), title: '轮次导航历史', workspace: null, messages: [], events: [], taskRuns: [] };
    for (let index = 1; index <= 5; index++) {
      history.messages.push({ id: 'history-round-' + index, role: 'user', content: '历史第 ' + index + ' 轮', source: index === 2 ? 'queue' : 'direct' });
      history.messages.push({ role: 'assistant', content: ('历史答复 ' + index + '\n\n').repeat(15), toolCalls: [] });
      if (index === 2) history.messages.push({ id: 'history-steering', role: 'user', content: '历史引导，不是新轮次', source: 'steering' });
    }
    await js(`renderSessionSnapshot(${JSON.stringify(history)});followOutput=false;$('message-scroll').scrollTop=0;true`);
    value = await until('history has exactly five independent rounds', async () => { const item = await snapshot(); return item.count === 5 && item; });
    assert.ok(value.labels.every(label => !label.includes('live-round') && !label.includes('历史引导')));
    await click(tick(2)); await until('historical round 2 navigates original user', () => roundVisible(2, 'history-round'));
    assert.equal((await snapshot()).events.at(-1).messageId, 'history-round-2'); evidence.history = { count: value.count, labels: value.labels };

    stage = 'usage view, empty sessions and a single round have the correct visibility';
    await js('window.ForgeUsageDashboard.open();true');
    await until('usage view hides round navigation', async () => (await snapshot()).hidden);
    await js('window.ForgeUsageDashboard.close(false);true');
    await until('chat view restores navigation', async () => !(await snapshot()).hidden);
    await js(`renderSessionSnapshot({id:${JSON.stringify(randomUUID())},title:'空会话',workspace:null,messages:[],events:[]});true`);
    await until('empty session clears all ticks and tooltip', async () => { const item = await snapshot(); return item.hidden && item.count === 0 && item.tip.hidden; });
    value = await fixture(1, 'single-round', false); assert.equal(value.count, 1); bounded(value); evidence.single = { visible: !value.hidden, count: value.count };

    stage = 'many rounds scroll in their own bounded rail and leave the chat wheel available';
    value = await fixture(120, 'many-round', false); bounded(value);
    assert.ok(value.list.scrollHeight > value.list.clientHeight + 1000);
    await click(tick(1)); await key('End');
    value = await until('last of many ticks is keyboard reachable and smooth navigation settled', async () => { const item = await snapshot(); return item.current === 120 && item.focused === '120' && item.list.scrollTop > 100 && item.scrollHeight-item.scrollTop-item.clientHeight<=3 && item; });
    bounded(value); evidence.many = { count: value.count, list: value.list, rail: value.rail };
    const manyChatTop = value.scrollTop, railPoint = await pointFor(tick(120));
    child.webContents.sendInputEvent({ type: 'mouseMove', ...railPoint }); child.webContents.sendInputEvent({ type: 'mouseWheel', deltaX: 0, deltaY: 220, canScroll: true, ...railPoint });
    await wait(150); value = await snapshot(); assert.ok(Math.abs(value.scrollTop - manyChatTop) <= 3, 'Wheel over the overflow rail must not scroll the chat');

    stage = 'four materials and a narrow viewport retain navigation, readable previews and safe bounds';
    child.setContentSize(980, 700); await wait(80);
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      await js(`window.synoraAppearance.apply(${JSON.stringify({ ...appearance, uiStyle: style })});true`);
      await until('material ' + style, () => js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`));
      await click(tick(1)); await until('first round in narrow material ' + style, async () => (await snapshot()).current === 1);
      await hover(tick(4)); value = await until('preview in material ' + style, async () => { const item = await snapshot(); return !item.tip.hidden && item.tip.text.startsWith('第 4 轮') && item; });
      bounded(value); assert.ok(value.tip.box.left >= value.viewport.left && value.tip.box.right <= value.viewport.right + 1);
      assert.ok(value.tip.box.top >= value.viewport.top - 1 && value.tip.box.bottom <= value.composer.top + 1);
      assert.equal(await js('document.documentElement.scrollWidth>innerWidth+1'), false);
      evidence[style] = { activeColour: value.activeColour, tooltipColour: value.tip.colour, tooltipBackground: value.tip.background, rail: value.rail };
      await capture('round-navigator-' + style + '.png');
    }

    stage = 'reduced motion preserves navigation without a tick transition';
    await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until('reduced motion applied', () => js(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
    await click(tick(3)); await until('reduced navigation aligns round 3', () => roundVisible(3, 'many-round'));
    assert.ok(await js(`[...document.querySelectorAll('.round-navigator-tick > span')].every(n=>getComputedStyle(n).transitionDuration.split(',').every(value=>parseFloat(value)===0))`));
    value = await snapshot(); assert.ok(value.nativeClicks >= 9 && value.nativeWheels >= 2);
    const result = { status: 'completed', realApi: false, realCommands: false, actualApplicationMessages: true, steeringExcluded: true,
      nativeHoverPreview: true, safeTooltipText: true, nativeTickNavigation: true, synchronousFollowCancellation: true,
      nativeWheelUpdatesHighlight: true, nativeKeyboardNavigation: true, historyAndSessionIsolation: true,
      usageAndEmptyHidden: true, singleRoundVisible: true, manyRoundsInternallyScroll: true, narrowViewportAndFourStyles: true,
      reducedMotion: true, evidence, screenshots };
    await fs.writeFile(path.join(output, 'round-navigator-result.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    const failure = { stage, error: error.message, stack: error.stack, evidence };
    if (child && !child.isDestroyed()) { failure.snapshot = await snapshot().catch(() => null); await capture('round-navigator-failure.png').catch(() => {}); }
    await fs.writeFile(path.join(output, 'round-navigator-result.json'), JSON.stringify(failure, null, 2)); throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      if (attached) { await child.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {}); child.webContents.debugger.detach(); }
      await js('clearInterval(taskActivityTimer);taskActivityTimer=null;cancelFileDisclosureReveal();true').catch(() => {});
      child.destroy();
    }
  }
};
