// Isolated display fixtures: no API request, filesystem mutation, or approval.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeDisclosureMotion({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Disclosure smoke needs an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const originalWindow = { bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() };
  const id = 'disclosure-motion-file';
  const fileText = Array.from({ length: 65 }, (_, index) => `const readableItem${index + 1} = ${index + 1};`).join('\n');
  let installed = false, attachedDebugger = false, mediaEmulated = false, stage = 'renderer ready';
  const inspect = () => js(`(() => {
    const card=$('${id}'),summary=card.querySelector(':scope > summary'),style=getComputedStyle(card,'::details-content');
    const raw=card.querySelector('.tool-technical-details');
    return {open:card.open,height:card.getBoundingClientRect().height,summaryHeight:summary.getBoundingClientRect().height,
      blockSize:style.blockSize,opacity:style.opacity,contentVisibility:style.contentVisibility,
      transitionProperty:style.transitionProperty,transitionDuration:style.transitionDuration,
      focus:document.activeElement===summary,rawOpen:!!raw.open,rawText:raw.textContent,
      rawVisible:raw.querySelector('pre').checkVisibility({contentVisibilityAuto:true,opacityProperty:true,visibilityProperty:true}),
      scrollTop:$('message-scroll').scrollTop,groupOpen:card.closest('.task-activity').open};
  })()`);
  const nativeClick = async () => {
    const point = await js(`(() => {const summary=$('${id}').querySelector(':scope > summary'),r=summary.getBoundingClientRect();
      const point={x:Math.round(r.left+Math.min(100,r.width/2)),y:Math.round(r.top+r.height/2)};
      if(!summary.contains(document.elementFromPoint(point.x,point.y)))throw new Error('Disclosure summary is covered');return point;})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const startSamples = () => js(`(() => {const start=performance.now();window.__disclosureMotionSamples=[];
    const sample=()=>{const card=$('${id}'),style=getComputedStyle(card,'::details-content');
      window.__disclosureMotionSamples.push({at:performance.now()-start,open:card.open,height:card.getBoundingClientRect().height,
        blockSize:style.blockSize,opacity:style.opacity,contentVisibility:style.contentVisibility});
      if(performance.now()-start<480)requestAnimationFrame(sample);};sample();})()`);
  const readSamples = async () => { await wait(540); return js('window.__disclosureMotionSamples'); };
  const assertIntermediate = (samples, low, high, opening) => {
    const mid = samples.filter(value => value.height > low + 3 && value.height < high - 3);
    assert.ok(mid.length >= 2, `${opening ? 'Opening' : 'Closing'} needs visible intermediate heights: ${JSON.stringify(samples)}`);
    assert.ok(Math.abs(mid[0].height - mid.at(-1).height) > 5, 'The disclosure must move through distinct intermediate heights');
    for (let index = 1; index < mid.length; index++) {
      const delta = mid[index].height - mid[index - 1].height;
      assert.ok(opening ? delta >= -1 : delta <= 1, 'The same disclosure transition should move continuously in one direction');
    }
    return mid.length;
  };
  try {
    await fs.mkdir(output, { recursive: true });
    await js('window.synoraAppearance.ready');
    for (let attempt = 0; attempt < 100 && !await js('Boolean(appState && !projectSwitching && !restoringWorkspace)'); attempt++) await wait(25);
    if (!await js('Boolean(appState && !projectSwitching && !restoringWorkspace)')) throw new Error('应用状态未就绪。');
    const capabilities = await js(`({intrinsicSize:CSS.supports('interpolate-size','allow-keywords'),detailsContent:CSS.supports('selector(details::details-content)')})`);
    assert.equal(capabilities.intrinsicSize, true, 'The bundled Chromium must support intrinsic-size transitions');
    assert.equal(capabilities.detailsContent, true, 'The bundled Chromium must support the native details-content pseudo-element');
    assert.equal(win.webContents.debugger.isAttached(), false, 'The isolated smoke must own its media emulation session');
    win.webContents.debugger.attach('1.3'); attachedDebugger = true;
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    mediaEmulated = true;
    stage = 'install real file-edit fixture';
    await js(`(() => {
      if(running||terminalRunning||promptSubmitting||approvals.size)throw new Error('Disclosure smoke cannot interrupt an active task');
      window.__disclosureMotionOriginal={nodes:[...$('messages').childNodes],welcomeHidden:$('welcome').hidden,
        scrollTop:$('message-scroll').scrollTop,followOutput,previewHidden:$('preview-panel').hidden,
        terminalHidden:$('terminal-panel').hidden,title:$('conversation-title').textContent};
      followOutput=false;$('messages').replaceChildren();$('welcome').hidden=true;
      setPreviewOpen(false);$('terminal-panel').hidden=true;$('conversation-title').textContent='文件展开与收起';
      const group=element('details','task-activity');group.open=true;
      group.append(element('summary','task-activity-summary','用时 3s'));
      const events=element('div','task-activity-events');group.append(events);
      const edit={path:'src/readable-items.js',before:null,after:${JSON.stringify(fileText)}};
      const tool=createToolCard({name:'write_file',toolCallId:'motion-fixture-edit',args:{path:edit.path,content:edit.after}});
      tool.card.id='${id}';events.append(tool.card);$('messages').append(group);
      completeTool({name:'write_file',toolCallId:'motion-fixture-edit',result:{path:edit.path,written:true},fileChange:edit},{tools:[tool],updateActivity:false});
      $('message-scroll').scrollTop=0;
    })()`);
    installed = true;
    win.setContentSize(1440, 1000);win.setOpacity(0);win.showInactive();win.webContents.focus();
    await wait(380);
    const closed = await inspect();
    assert.equal(closed.open, false);assert.equal(closed.groupOpen, true);
    assert.equal(closed.rawOpen, false);assert.equal(closed.rawVisible, false);
    assert.ok(closed.rawText.includes(JSON.stringify(fileText).slice(1, -1)), 'The complete raw content must remain stored while collapsed');
    assert.match(closed.transitionProperty, /block-size/);
    assert.ok(closed.transitionDuration.split(',').some(value => Math.abs(Number.parseFloat(value) - 0.28) < 0.01), 'The file disclosure should use the intended short transition');

    stage = 'native pointer expansion';
    await startSamples();await nativeClick();
    const opening = await readSamples(), expanded = await inspect();
    assert.equal(expanded.open, true);assert.equal(expanded.groupOpen, true);
    assert.ok(expanded.height > closed.height + 200, 'A long real diff should expand substantially');
    const openingFrames = assertIntermediate(opening, closed.height, expanded.height, true);
    assert.equal(expanded.focus, true, 'Native activation should keep focus on the file summary');
    assert.equal(expanded.rawOpen, false);assert.equal(expanded.rawVisible, true);
    assert.equal(expanded.rawText, closed.rawText, 'Animation must not replace or truncate tool details');
    // The now-visible parameter/result payload can make this card taller than
    // the viewport; the existing fit logic may scroll to keep the preview in view.
    assert.ok(expanded.scrollTop >= 0 && expanded.scrollTop - closed.scrollTop <= expanded.height, 'Expansion scroll must stay bounded by the card size');

    stage = 'native pointer collapse';
    await startSamples();await nativeClick();
    const closing = await readSamples(), collapsedAgain = await inspect();
    assert.equal(collapsedAgain.open, false);
    const closingFrames = assertIntermediate(closing, closed.height, expanded.height, false);
    assert.ok(Math.abs(collapsedAgain.height - closed.height) <= 1, 'The collapsed file should return to summary-only height');
    assert.equal(collapsedAgain.contentVisibility, 'hidden');assert.equal(collapsedAgain.rawVisible, false);

    stage = 'rapid native reversals';
    await nativeClick();await wait(65);await nativeClick();await wait(55);await nativeClick();await wait(380);
    const reversed = await inspect();
    assert.equal(reversed.open, true);assert.ok(Math.abs(reversed.height - expanded.height) <= 1);
    assert.equal(reversed.focus, true);assert.equal(reversed.rawText, closed.rawText);

    stage = 'keyboard collapse and expansion';
    const enter = async () => {
      // Chromium's native summary activation follows the complete Enter input
      // sequence, including its character event (as does a physical key press).
      win.webContents.focus();
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      win.webContents.sendInputEvent({type:'char',keyCode:'Enter'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await wait(360);
    };
    await enter();assert.equal((await inspect()).open, false);
    assert.equal((await inspect()).focus, true, 'Keyboard collapse must preserve the summary focus');
    await enter();assert.equal((await inspect()).open, true);
    assert.equal((await inspect()).focus, true, 'Keyboard expansion must preserve the summary focus');
    const image = await win.webContents.capturePage();assert.equal(image.isEmpty(), false);
    await fs.writeFile(path.join(output,'file-disclosure-expanded.png'),image.toPNG());

    stage = 'system reduced-motion preference';
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await wait(50);
    const reduced = await inspect();
    assert.equal(await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    assert.ok(reduced.transitionDuration.split(',').every(value => Number.parseFloat(value) === 0), 'Reduced motion must remove the file-content animation');
    await nativeClick();await wait(50);
    const reducedClosed = await inspect();assert.equal(reducedClosed.open,false);
    assert.ok(Math.abs(reducedClosed.height-closed.height)<=1, 'Reduced-motion collapse should settle immediately');
    await nativeClick();await wait(50);assert.equal((await inspect()).open,true);

    const result={status:'completed',realApi:false,realCommands:false,realFileMutations:false,
      nativePointerExpansion:true,nativePointerCollapse:true,openingIntermediateFrames:openingFrames,closingIntermediateFrames:closingFrames,
      rapidToggleReversal:true,nativeKeyboard:true,focusPreserved:true,rawDetailsRemainCompleteAndCollapsed:true,
      boundedConversationScroll:true,reducedMotion:true,capabilities,screenshots:['file-disclosure-expanded.png']};
    await fs.writeFile(path.join(output,'disclosure-motion-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  } catch(error) {
    const result={status:'failed',stage,error:error.message,stack:error.stack};
    if(installed&&!win.isDestroyed())try{result.inspection=await inspect();result.samples=await js('window.__disclosureMotionSamples||[]');}catch{}
    await fs.writeFile(path.join(output,'disclosure-motion-smoke-result.json'),JSON.stringify(result,null,2)+'\n');
    throw new Error('Disclosure motion smoke failed at '+stage+': '+error.message,{cause:error});
  } finally {
    if(mediaEmulated&&!win.isDestroyed())await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}).catch(()=>{});
    if(attachedDebugger&&!win.isDestroyed()&&win.webContents.debugger.isAttached())win.webContents.debugger.detach();
    if(installed&&!win.isDestroyed()) {
      await js(`(() => {const original=window.__disclosureMotionOriginal;if(!original)return;
        $('messages').replaceChildren(...original.nodes);$('welcome').hidden=original.welcomeHidden;
        $('conversation-title').textContent=original.title;followOutput=original.followOutput;
        setPreviewOpen(!original.previewHidden);$('terminal-panel').hidden=original.terminalHidden;
        $('message-scroll').scrollTop=original.scrollTop;delete window.__disclosureMotionOriginal;delete window.__disclosureMotionSamples;})()`);
      win.setBounds(originalWindow.bounds);win.setOpacity(originalWindow.opacity);if(!originalWindow.visible)win.hide();
    }
  }
};
