// Native display-only file disclosures in a disposable renderer. No model,
// command, approval, or project file is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeDisclosureVisibility({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(20); }
    throw new Error('Disclosure visibility timed out: ' + label);
  };
  const id = 'visibility-file-edit';
  const fileText = Array.from({ length: 180 }, (_, index) => `const visibleLine${index + 1} = ${index + 1};`).join('\n');
  const original = { bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() };
  let installed = false, attached = false, stage = 'renderer initialization';
  const evidence = {};
  const inspect = () => js(`(() => {
    const card=$('${id}'),summary=card.querySelector(':scope > summary'),diff=card.querySelector('.code-diff-card'),code=card.querySelector('.code-diff-scroll'),viewport=$('message-scroll');
    const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width};};
    return {open:card.open,card:rect(card),summary:rect(summary),diff:rect(diff),code:rect(code),viewport:rect(viewport),composer:rect(document.querySelector('.composer-area')),
      scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight,codeScrollTop:code.scrollTop,codeScrollHeight:code.scrollHeight,codeClientHeight:code.clientHeight,
      transition:getComputedStyle(card,'::details-content').transitionDuration,followOutput,rawOpen:card.querySelector('.tool-technical-details').open,
      nativeClicks:window.__disclosureVisibility.clicks,nativeWheels:window.__disclosureVisibility.wheels};
  })()`);
  const click = async () => {
    const point = await js(`(() => {const n=$('${id}').querySelector(':scope > summary'),r=n.getBoundingClientRect(),p={x:Math.round(r.left+Math.min(110,r.width/2)),y:Math.round(r.top+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw new Error('File disclosure summary is covered');return p;})()`);
    win.focus(); win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const samples = () => js(`(() => {const started=performance.now();window.__disclosureVisibility.samples=[];window.__disclosureVisibility.sampling=true;
    const frame=()=>{const card=$('${id}'),viewport=$('message-scroll'),r=card.getBoundingClientRect();window.__disclosureVisibility.samples.push({at:performance.now()-started,height:r.height,top:r.top,bottom:r.bottom,scrollTop:viewport.scrollTop,open:card.open});
      if(performance.now()-started<650)requestAnimationFrame(frame);else window.__disclosureVisibility.sampling=false;};frame();true;})()`);
  const sampled = async () => {
    await until('animation frame collection complete', () => js('!window.__disclosureVisibility.sampling'));
    return js('window.__disclosureVisibility.samples');
  };
  const intermediate = (values, low, high, opening) => {
    const middle = values.filter(value => value.height > low + 3 && value.height < high - 3);
    assert.ok(middle.length >= 2, 'A disclosure must expose multiple real intermediate heights: ' + JSON.stringify(values));
    assert.ok(Math.abs(middle[0].height - middle.at(-1).height) > 4, 'Intermediate disclosure heights must move');
    for (let index = 1; index < middle.length; index++) assert.ok(opening ? middle[index].height >= middle[index - 1].height - 1 : middle[index].height <= middle[index - 1].height + 1, 'Disclosure height must progress continuously');
    return middle.length;
  };
  const assertVisible = (value, label) => {
    assert.ok(value.card.top >= value.viewport.top - 2 && value.card.bottom <= value.viewport.bottom + 2, label + ': the complete expanded card must fit the conversation: ' + JSON.stringify(value));
    assert.ok(value.diff.top >= value.viewport.top - 2, label + ': diff header must be inside conversation: ' + JSON.stringify(value));
    assert.ok(value.diff.bottom <= Math.min(value.viewport.bottom, value.composer.top) + 2, label + ': complete preview must stay above the composer: ' + JSON.stringify(value));
    assert.ok(value.codeClientHeight > 70 && value.codeScrollHeight > value.codeClientHeight + 100, label + ': long code must scroll inside the visible preview');
    assert.equal(value.rawOpen, false);
  };
  const wheel = async (deltaY, code = false) => {
    const point = await js(`(() => {const r=${code ? `$('${id}').querySelector('.code-diff-scroll')` : `$('message-scroll')`}.getBoundingClientRect();return {x:Math.round(r.left+${code ? '45' : '8'}),y:Math.round(r.top+Math.min(70,r.height/2))};})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseWheel', deltaX: 0, deltaY, canScroll: true, ...point });
  };
  const install = async position => {
    await js(`(() => {
      cancelFileDisclosureReveal();fileDisclosureScrollPaused=false;
      $('messages').replaceChildren();
      const filler=element('div','disclosure-visibility-spacer');filler.style.height='1800px';filler.textContent='仅用于验证滚动位置的历史内容';
      const group=element('details','task-activity');group.open=true;group.append(element('summary','task-activity-summary','用时 1s'));
      const events=element('div','task-activity-events');group.append(events);
      const edit={path:'src/visible-lines.js',before:null,after:${JSON.stringify(fileText)}};
      const tool=createToolCard({name:'write_file',toolCallId:'visibility-fixture',args:{path:edit.path,content:edit.after}});tool.card.id='${id}';events.append(tool.card);
      completeTool({name:'write_file',toolCallId:'visibility-fixture',result:{path:edit.path,written:true},fileChange:edit},{tools:[tool],updateActivity:false});
      if(${JSON.stringify(position)}==='bottom')$('messages').append(filler,group);else $('messages').append(group,filler);
      followOutput=false;$('message-scroll').scrollTop=${position === 'bottom' ? "$('message-scroll').scrollHeight" : '0'};
      true;
    })()`);
    await wait(100);
    const value = await inspect(); assert.equal(value.open, false); return value;
  };
  const capture = async name => { win.webContents.invalidate(); await wait(90); await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  try {
    await fs.mkdir(output, { recursive: true });
    await js('window.synoraAppearance.ready');
    win.setContentSize(1440, 1000); win.setOpacity(0); win.showInactive(); win.focus(); win.webContents.focus();
    assert.equal(win.webContents.debugger.isAttached(), false);
    win.webContents.debugger.attach('1.3'); attached = true;
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await js(`(() => {
      if(running||terminalRunning||promptSubmitting||approvals.size)throw new Error('Display smoke cannot interrupt a task');
      window.__disclosureVisibility={nodes:[...$('messages').childNodes],welcome:$('welcome').hidden,notice:$('notice').hidden,scrollTop:$('message-scroll').scrollTop,follow:followOutput,disclosurePaused:fileDisclosureScrollPaused,preview:$('preview-panel').hidden,terminal:$('terminal-panel').hidden,clicks:0,wheels:0};
      window.__disclosureVisibility.clickListener=event=>{if(event.target.closest('#${id} > summary')&&event.isTrusted)window.__disclosureVisibility.clicks++;};
      window.__disclosureVisibility.wheelListener=event=>{if($('message-scroll').contains(event.target)&&event.isTrusted)window.__disclosureVisibility.wheels++;};
      document.addEventListener('click',window.__disclosureVisibility.clickListener,true);document.addEventListener('wheel',window.__disclosureVisibility.wheelListener,true);
      $('welcome').hidden=true;$('notice').hidden=true;setPreviewOpen(false);$('terminal-panel').hidden=true;true;
    })()`); installed = true;

    stage = 'bottom file disclosure fits without additional conversation scroll';
    const bottomClosed = await install('bottom');
    await samples(); await click(); const bottomOpening = await sampled(); const bottomOpen = await inspect();
    assert.equal(bottomOpen.open, true); assertVisible(bottomOpen, 'Bottom expansion');
    evidence.bottom = { before: bottomClosed, after: bottomOpen, intermediateFrames: intermediate(bottomOpening, bottomClosed.card.height, bottomOpen.card.height, true) };
    assert.ok(bottomOpen.scrollTop > bottomClosed.scrollTop + 100, 'Bottom expansion must automatically reveal the expanded content');
    await capture('disclosure-bottom-visible.png');

    stage = 'long preview scrolls internally';
    await wait(400); await wheel(-250, true);
    await until('native wheel moves code internally', async () => (await inspect()).codeScrollTop > 30);
    const inside = await inspect(); assert.ok(Math.abs(inside.scrollTop - bottomOpen.scrollTop) <= 2, 'Scrolling long code must preserve the conversation position');
    evidence.internalScroll = inside.codeScrollTop;

    stage = 'collapse keeps the summary in a reasonable visible position';
    await samples(); await click(); const closing = await sampled(), collapsed = await inspect();
    assert.equal(collapsed.open, false); intermediate(closing, bottomClosed.card.height, bottomOpen.card.height, false);
    assert.ok(collapsed.summary.top >= collapsed.viewport.top - 2 && collapsed.summary.bottom <= collapsed.viewport.bottom + 2, 'Collapsing must keep its summary in the conversation');
    assert.ok(collapsed.scrollHeight - collapsed.clientHeight - collapsed.scrollTop <= 3, 'Bottom collapse should not leave a large empty tail');
    evidence.collapse = collapsed;

    stage = 'manual native upward scroll cancels disclosure following';
    await install('bottom'); await samples(); await click(); await wait(65); await wheel(350);
    await until('trusted wheel received', () => js('window.__disclosureVisibility.wheels>=2'));
    await wait(90); const manual = await inspect(); await sampled(); const afterManual = await inspect();
    assert.ok(manual.scrollTop < afterManual.scrollHeight - afterManual.clientHeight - 100, 'A native upward wheel must move away from the tail');
    assert.ok(afterManual.scrollTop <= manual.scrollTop + 3, 'The disclosure must not pull a reader down after an upward wheel');
    assert.equal(afterManual.followOutput, false); evidence.manualUp = { manual, after: afterManual };

    stage = 'expansion near the top preserves the reading position';
    const topClosed = await install('top'); await samples(); await click(); await sampled(); const topOpen = await inspect();
    assert.equal(topOpen.open, true); assert.ok(Math.abs(topOpen.scrollTop - topClosed.scrollTop) <= 2, 'Expanding old content at the top must not jump to the conversation bottom');
    assertVisible(topOpen, 'Top expansion'); evidence.top = { before: topClosed, after: topOpen };
    await capture('disclosure-top-preserved.png');

    stage = 'short conversation viewport reduces the internal preview height';
    win.setContentSize(1100, 700);await wait(100);await install('bottom');await samples();await click();await sampled();
    const compact = await inspect();assertVisible(compact, 'Short-window expansion');
    assert.ok(compact.codeClientHeight < bottomOpen.codeClientHeight - 50, 'A shorter viewport must actually reduce the code preview height');
    evidence.shortViewport = compact;await capture('disclosure-short-window.png');
    win.setContentSize(1440, 1000);await wait(100);

    stage = 'reduced-motion expansion remains fully visible';
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until('reduced motion applied', () => js(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
    await install('bottom'); await click(); await until('reduced disclosure fully visible', async () => { const value = await inspect(); return value.open && value.diff.bottom <= Math.min(value.viewport.bottom, value.composer.top) + 2 && value; });
    const reduced = await inspect(); assertVisible(reduced, 'Reduced-motion expansion');
    assert.ok(reduced.transition.split(',').every(value => Number.parseFloat(value) === 0), 'Reduced motion must settle without a height transition');
    assert.ok(reduced.nativeClicks >= 6 && reduced.nativeWheels >= 2); evidence.reduced = reduced;
    return { status: 'completed', realApi: false, realCommands: false, realFileMutations: false, nativePointer: true, nativeWheel: true,
      progressiveDisclosureHeight: true, tailExpansionFullyVisible: true, longCodeInternalScroll: true, upwardWheelCancelsFollowing: true,
      topReadingPositionPreserved: true, collapsePositionPreserved: true, adaptiveShortViewport: true, reducedMotion: true, evidence,
      screenshots: ['disclosure-bottom-visible.png', 'disclosure-top-preserved.png', 'disclosure-short-window.png'] };
  } catch (error) {
    await fs.writeFile(path.join(output, 'disclosure-visibility-failure.json'), JSON.stringify({ stage, error: error.message, stack: error.stack, evidence, inspection: installed ? await inspect().catch(() => null) : null, samples: installed ? await js('window.__disclosureVisibility.samples').catch(() => null) : null }, null, 2));
    throw error;
  } finally {
    if (attached && !win.isDestroyed()) { await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {}); win.webContents.debugger.detach(); }
    if (installed && !win.isDestroyed()) await js(`(() => {const saved=window.__disclosureVisibility;cancelFileDisclosureReveal();document.removeEventListener('click',saved.clickListener,true);document.removeEventListener('wheel',saved.wheelListener,true);$('messages').replaceChildren(...saved.nodes);$('welcome').hidden=saved.welcome;$('notice').hidden=saved.notice;setPreviewOpen(!saved.preview);$('terminal-panel').hidden=saved.terminal;followOutput=saved.follow;fileDisclosureScrollPaused=saved.disclosurePaused;$('message-scroll').scrollTop=saved.scrollTop;delete window.__disclosureVisibility;true;})()`).catch(() => {});
    if (!win.isDestroyed()) { win.setBounds(original.bounds); win.setOpacity(original.opacity); if (!original.visible) win.hide(); }
  }
};
