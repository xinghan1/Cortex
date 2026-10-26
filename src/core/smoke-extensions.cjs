// Isolated native verification: real Chromium video decoding and sandboxed
// plugin windows, with local fixtures and injected picker/approval decisions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, screen } = require('electron');
const { DshPetStore } = require('./dsh-pet.cjs');
const { PluginManager } = require('./plugin-manager.cjs');

module.exports = async function smokeExtensions({ win, output, dataDir, pluginManager, pluginRuntime, dshPet, dialog }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const fixtureRoot = path.join(dataDir, 'extensions-smoke-' + randomUUID());
  const project = path.join(fixtureRoot, 'project'), otherProject = path.join(fixtureRoot, 'other-project');
  const screenshots = [], themes = [], statusAnimations = [], decisions = [], pickerRequests = [], composerLayouts = [], operationColors = [];
  let child, panel, stage = 'initialize', nextPick = null, nextWrite = 'allow', originalAppearance;
  const originalOpenDialog = dialog.showOpenDialog, originalMessageBox = dialog.showMessageBox;
  const originalCursorPoint = screen.getCursorScreenPoint;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const step = async value => { stage = value; await fs.writeFile(path.join(output, 'extensions-progress.json'), JSON.stringify({ stage, at: new Date().toISOString() })); };
  const bounded = async (promise, label, milliseconds = 18000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Extensions smoke timed out: ' + label)), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const js = code => bounded(child.webContents.executeJavaScript(code), 'main renderer');
  const call = (method, input) => js(`window.forge[${JSON.stringify(method)}](${input === undefined ? '' : JSON.stringify(input)})`);
  const panelJs = code => bounded(panel.webContents.executeJavaScript(code), 'plugin renderer');
  const until = async (label, predicate) => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) { const value = await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now())); if (value) return value; await wait(30); }
    throw new Error('Extensions smoke timed out: ' + label);
  };
  const point = selector => until('click target ' + selector, () => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:${selector !== '#pet-overlay-hit'}}))return null;n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null})()`));
  const pointer = async (location, button = 'left') => {
    child.focus(); child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...location, ...(type === 'mouseMove' ? {} : { button, clickCount: 1 }) });
    await wait(90);
  };
  const click = async selector => pointer(await point(selector));
  const capture = async filename => {
    child.webContents.invalidate(); await wait(160);
    const image = await child.webContents.capturePage(); assert.ok(!image.isEmpty());
    await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename);
  };
  const verifyOperationColors = async style => {
    const colors = await js(`(()=>{
      document.getElementById('native-operation-colors')?.remove();
      const target=document.createElement('section');target.id='native-operation-colors';document.getElementById('messages').append(target);
      for(const status of ['running','completed','failed','denied']){
        const card=document.createElement('details');card.className='tool-card'+(status==='running'?' running':'');card.dataset.status=status;
        const summary=document.createElement('summary');summary.textContent=status;card.append(summary);
        window.ForgeToolOperationGroups.appendTool(target,card,{name:'run_command',runId:'native-status-colors'});
      }
      target.scrollIntoView({block:'nearest',behavior:'instant'});
      return [...target.querySelectorAll('.tool-operation-status-count')].map(n=>({status:n.dataset.status,text:n.textContent,color:getComputedStyle(n).color}));
    })()`);
    assert.deepEqual(colors.map(value => value.status), ['running', 'completed', 'failed', 'denied']);
    const rgb = value => value.match(/[\d.]+/gu).slice(0, 3).map(Number);
    const [blue, green, red, gray] = colors.map(value => rgb(value.color));
    assert.ok(blue[2] > blue[0] + 15 && blue[2] > blue[1], 'Running count must be blue in ' + style + ': ' + colors[0].color);
    assert.ok(green[1] > green[0] + 10 && green[1] > green[2], 'Completed count must be green in ' + style + ': ' + colors[1].color);
    assert.ok(red[0] > red[1] + 15 && red[0] > red[2], 'Failed count must be red in ' + style + ': ' + colors[2].color);
    assert.ok(Math.max(...gray) - Math.min(...gray) <= 35, 'Not-executed count must be gray in ' + style + ': ' + colors[3].color);
    operationColors.push({ style, colors }); await capture('operation-status-colors-' + style + '.png');
    await js("document.getElementById('native-operation-colors').remove();true");
  };
  const ready = () => until('extensions renderer ready', () => js('Boolean(window.synoraPetOverlay&&window.synoraExtensions&&window.synoraPetSettings&&appState&&!projectSwitching)'));
  const inspectPet = () => js(`(()=>{const o=document.getElementById('pet-overlay'),v=document.getElementById('pet-overlay-video'),r=o.getBoundingClientRect();return {hidden:o.hidden,animation:o.dataset.animation,readyState:v.readyState,width:v.videoWidth,height:v.videoHeight,error:v.error?.code||null,paused:v.paused,src:v.currentSrc||v.src,box:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},state:window.synoraPetOverlay.snapshot()}})()`);
  const decoded = async kind => until('real WebM decode ' + (kind || ''), async () => { const value = await inspectPet(); return !value.hidden && (!kind || value.animation === kind) && value.readyState >= 2 && value.width > 0 && value.height > 0 && !value.error && value; });
  const assertComposerTargets = async label => {
    const layout = await until('pet leaves composer and controls clickable: ' + label, () => js(`(()=>{
      const o=document.getElementById('pet-overlay'),r=o.getBoundingClientRect(),form=document.getElementById('task-form').getBoundingClientRect();
      const approval=document.getElementById('composer-approval'),approvalBox=approval.getBoundingClientRect();
      const controls=['task-input','send-button','stop-button','model-reasoning-trigger','native-pet-approval-target'].map(id=>{
        const n=document.getElementById(id);if(!n||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
        const b=n.getBoundingClientRect(),p={x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};
        return {id,hit:n.contains(document.elementFromPoint(p.x,p.y))};}).filter(Boolean);
      const overlaps=(r.right>form.left&&r.left<form.right&&r.bottom>form.top&&r.top<form.bottom)
        ||(!approval.hidden&&r.right>approvalBox.left&&r.left<approvalBox.right&&r.bottom>approvalBox.top&&r.top<approvalBox.bottom);
      return (!o.hidden&&!overlaps&&controls.every(c=>c.hit))?{pet:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},form:{top:form.top,bottom:form.bottom},width:innerWidth,height:innerHeight,controls}:null;
    })()`));
    composerLayouts.push({ label, ...layout }); return layout;
  };
  const visibleDialog = (id = 'extensions-dialog') => until(id, () => js(`document.getElementById(${JSON.stringify(id)}).open&&!document.getElementById(${JSON.stringify(id)}).getAttribute('aria-busy')?.includes('true')`));
  const openSettings = async kind => {
    const isPet = kind === 'pet';
    await click('#menu-settings');
    const actions = await js("[...document.querySelectorAll('#app-menu-popup [data-action]')].map(node=>({id:node.dataset.action,label:node.textContent}))");
    assert.ok(actions.some(value => value.id === 'extensions' && /插件管理/u.test(value.label)));
    assert.ok(actions.some(value => value.id === 'pet-settings' && /宠物设置/u.test(value.label)));
    await click(`#app-menu-popup [data-action="${isPet ? 'pet-settings' : 'extensions'}"]`);
    await visibleDialog(isPet ? 'pet-settings-dialog' : 'extensions-dialog');
    const independent = await js("({plugin:document.getElementById('extensions-dialog').open,pet:document.getElementById('pet-settings-dialog').open,pluginTitle:document.getElementById('extensions-title').textContent,petTitle:document.getElementById('pet-settings-title').textContent,pluginHasPet:!!document.querySelector('#extensions-dialog #pet-settings-enabled')})");
    assert.equal(independent.plugin, !isPet); assert.equal(independent.pet, isPet);
    assert.equal(independent.pluginTitle, '插件'); assert.equal(independent.petTitle, '宠物'); assert.equal(independent.pluginHasPet, false);
  };
  const pluginRow = id => `[data-extension-id=${JSON.stringify(id)}]`;
  const resultError = expression => panelJs(`(async()=>{try{await (${expression});return null;}catch(error){return String(error.message)}})()`);
  const windowForPlugin = id => until('native plugin window', () => {
    const record = pluginRuntime.windows().find(value => value.id === id && value.ownerWindow === child);
    if (!record) return null;
    panel = record.window; return panel;
  });
  const updatePet = async patch => { const value = await call('setPet', patch); await until('pet settings IPC applied', async () => Object.entries(patch).every(([key, expected]) => value[key] === expected && dshPet.snapshot()[key] === expected) && await js(`Object.entries(${JSON.stringify(patch)}).every(([key,value])=>window.synoraPetOverlay.snapshot()[key]===value)`)); return value; };
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1); pickerRequests.push({ title: options.title, properties: options.properties });
    assert.ok(nextPick, 'An isolated picker path must be explicitly queued');
    const chosen = nextPick; nextPick = null;
    assert.ok(path.resolve(chosen).startsWith(path.resolve(fixtureRoot) + path.sep));
    return { canceled: false, filePaths: [chosen] };
  };
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1), text = [options.title, options.message, options.detail].join('\n');
    const buttons = options.buttons || ['确定'];
    const positive = Math.max(0, buttons.findIndex(label => /允许|安装|启用|确认|继续/u.test(label) && !/取消|不|拒绝/u.test(label)));
    const cancel = options.cancelId ?? Math.max(0, buttons.findIndex(label => /取消|拒绝/u.test(label)));
    const isWrite = /修改|写入/u.test(options.title || '') || /插件.*(?:修改|写入)/u.test(text);
    const response = isWrite && nextWrite === 'cancel' ? cancel : positive;
    decisions.push({ title: options.title || '', message: options.message || '', detail: options.detail || '', buttons, response, isWrite });
    return { response, checkboxChecked: false };
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(otherProject, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'sample.txt'), 'original fixture text\n');
    await fs.writeFile(path.join(project, '.env'), 'PRIVATE_FIXTURE_KEY=do-not-expose');
    await fs.writeFile(path.join(otherProject, 'other.txt'), 'other project\n');
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    child.setContentSize(1280, 960); child.setOpacity(0); child.showInactive(); await ready();
    await js('Promise.all([window.synoraPetOverlay.ready,window.synoraExtensions.ready,window.synoraPetSettings.ready])');
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project activated', async () => (await call('getState')).workspace.root === project && await js('!projectSwitching'));
    originalAppearance = await call('getAppearance');

    await step('original video decoding and transparency');
    let pet = await decoded('idle');
    assert.equal(pet.state.enabled, true); assert.equal(pet.state.size, 220); assert.equal(pet.state.followCursor, true); assert.equal(pet.width / pet.height, 16 / 9);
    const transparency = await js(`(async()=>{const v=document.getElementById('pet-overlay-video');v.currentTime=Math.min(1,Math.max(0,v.duration/2));await new Promise(resolve=>{if(!v.seeking)resolve();else v.addEventListener('seeked',resolve,{once:true})});const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(v,0,0);const data=x.getImageData(0,0,c.width,c.height).data;let transparent=0,opaque=0,minAlpha=255,maxAlpha=0;for(let i=3;i<data.length;i+=4){if(data[i]<=8)transparent++;if(data[i]>200)opaque++;minAlpha=Math.min(minAlpha,data[i]);maxAlpha=Math.max(maxAlpha,data[i]);}return {transparent,opaque,minAlpha,maxAlpha,pixels:c.width*c.height}})()`);
    assert.ok(transparency.transparent > transparency.pixels / 3, 'The genuine upstream frame must retain its alpha background: ' + JSON.stringify(transparency));
    assert.ok(transparency.opaque > 1000, 'A decoded pet must have visible character pixels');
    await assertComposerTargets('default pet');
    await capture('extensions-pet-initial.png');

    await step('native dragging and persisted pet settings');
    const start = await point('#pet-overlay-hit'), end = { x: start.x - 180, y: start.y - 100 };
    child.focus(); child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'mouseMove', ...start });
    child.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step++) {
      child.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(start.x + (end.x - start.x) * step / 8), y: Math.round(start.y + (end.y - start.y) * step / 8), button: 'left' });
      await wait(20); if (step === 4) await decoded('drag');
    }
    child.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'left', clickCount: 1 });
    const dragged = await until('native drag persisted', async () => { const value = await call('petState'); return value.x < .98 && value.y < .98 && value; });
    pet = await decoded('idle'); assert.ok(pet.box.left < start.x - 110 && pet.box.top < start.y - 80);
    const freshPet = await new DshPetStore({ dataDir }).init(); assert.deepEqual(freshPet.snapshot(), dragged);
    await pointer(await point('#pet-overlay-hit'), 'right');
    await until('native pet context menu', () => js("!document.getElementById('pet-overlay-menu').hidden"));
    await click('#pet-overlay-pat'); await decoded('clicks');
    await js("document.getElementById('pet-overlay-video').dispatchEvent(new Event('ended'))"); await decoded('idle');
    for (const [action, kind] of [['turn', 'turn'], ['action', 'actions']]) {
      await pointer(await point('#pet-overlay-hit'), 'right'); await click('#pet-overlay-' + action); await decoded(kind);
      await js("document.getElementById('pet-overlay-video').dispatchEvent(new Event('ended'))"); await decoded('idle');
    }

    await step('native pointer drives genuine eye-only frame changes');
    await updatePet({ size: 220, x: 1, y: 1 });
    await until('production gaze is active while idle', () => js("document.getElementById('pet-overlay-gaze')?.dataset.gaze==='tracking'&&!document.getElementById('pet-overlay-gaze').hidden"));
    // Freeze the genuine idle frame but use the actual visible production
    // canvas, overlay controller and 50 ms main-process pointer IPC. Desktop
    // coordinates are injected into screen only inside this isolated fixture;
    // native renderer mouse moves must agree with those same coordinates.
    await js(`(async()=>{
      const video=document.getElementById('pet-overlay-video'),canvas=document.getElementById('pet-overlay-gaze');
      video.pause();video.currentTime=.5;await new Promise(resolve=>{if(!video.seeking)resolve();else video.addEventListener('seeked',resolve,{once:true})});
      const fixture=window.nativePetGaze={video,canvas,moves:0,pointerEvents:[],actions:[],left:null};
      fixture.pointer=event=>{if(event.isTrusted)fixture.moves++};document.addEventListener('pointermove',fixture.pointer);
      fixture.action=event=>fixture.actions.push(event.detail);window.addEventListener('synora:pet-action',fixture.action);
      fixture.off=window.forge.onEvent(event=>{if(event.type==='pet-pointer')fixture.pointerEvents.push({x:event.x,y:event.y,inside:event.inside})});return true;
    })()`);
    let desktopCursor = originalCursorPoint();
    screen.getCursorScreenPoint = () => desktopCursor;
    const desktopMove = (x, y = 300) => { const box = child.getContentBounds(), zoom = child.webContents.getZoomFactor(); desktopCursor = { x: Math.round(box.x + x * zoom), y: Math.round(box.y + y * zoom) }; };
    const mouseMove = async (x, y = 300) => { desktopMove(x, y); child.focus(); child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); };
    const petBounds = (await inspectPet()).box;
    const eyeCenter = { x: petBounds.left + petBounds.width * .485,
      y: petBounds.top + (petBounds.height - petBounds.width * 360 / 640) / 2 + petBounds.width * 360 / 640 * .525 };
    await mouseMove(eyeCenter.x, eyeCenter.y);
    await wait(600);
    await capture('pet-production-gaze-front.png');
    await fs.writeFile(path.join(output, 'pet-head-front.png'), Buffer.from(await js("window.nativePetGaze.canvas.toDataURL('image/png').split(',')[1]"), 'base64'));
    screenshots.push('pet-head-front.png');
    const poseSamples = [];
    for (let sample = 0; sample < 30; sample++) {
      await wait(500);
      const pose = await js("({time:window.nativePetGaze.video.currentTime,paused:window.nativePetGaze.video.paused,kind:document.getElementById('pet-overlay').dataset.animation,pose:window.nativePetGaze.canvas.dataset.pose,turns:window.nativePetGaze.actions.filter(e=>e.kind==='turn').length})");
      assert.equal(pose.paused, true); assert.equal(pose.kind, 'idle'); assert.equal(pose.pose, 'front');
      assert.ok(Math.abs(pose.time - .5) <= .01); assert.equal(pose.turns, 0); poseSamples.push(pose);
    }
    await mouseMove(10);
    await until('real left mouse motion moves visible production irises left', () => js("window.nativePetGaze.moves>0&&window.nativePetGaze.canvas.dataset.gaze==='tracking'&&Number(window.nativePetGaze.canvas.dataset.gazeX)<-4"));
    await js("window.nativePetGaze.left=new Uint8ClampedArray(window.nativePetGaze.canvas.getContext('2d').getImageData(0,0,640,360).data);window.nativePetGaze.leftPNG=window.nativePetGaze.canvas.toDataURL('image/png');true");
    await capture('pet-production-gaze-left.png');
    await mouseMove(1270);
    await until('right-edge mouse motion moves visible production irises right', () => js("window.nativePetGaze.moves>1&&window.nativePetGaze.canvas.dataset.gaze==='tracking'&&Number(window.nativePetGaze.canvas.dataset.gazeX)>4"));
    await capture('pet-production-gaze-right.png');
    const gazeEvidence = await js(`(()=>{
      const f=window.nativePetGaze,right=f.canvas.getContext('2d').getImageData(0,0,640,360).data;
      let changed=0,outsideHeadROI=0,alphaChanged=0,bodyChanged=0;for(let i=0;i<right.length;i+=4){
        if(f.left[i]===right[i]&&f.left[i+1]===right[i+1]&&f.left[i+2]===right[i+2]&&f.left[i+3]===right[i+3])continue;
        changed++;const pixel=i/4,x=pixel%640,y=Math.floor(pixel/640);if(x<204||x>=424||y<50||y>=240)outsideHeadROI++;
        if(y>=240)bodyChanged++;
        if(f.left[i+3]!==right[i+3])alphaChanged++;
      }
      return {changed,outsideHeadROI,bodyChanged,alphaChanged,nativePointerMoves:f.moves,productionCanvas:true,petSize:window.synoraPetOverlay.snapshot().size,
        injectedDesktopCoordinates:true,leftPNG:f.leftPNG,rightPNG:f.canvas.toDataURL('image/png')};
    })()`);
    assert.ok(gazeEvidence.changed > 1000); assert.equal(gazeEvidence.outsideHeadROI, 0); assert.equal(gazeEvidence.bodyChanged, 0); assert.ok(gazeEvidence.nativePointerMoves >= 2);
    for (const [key, filename] of [['leftPNG', 'pet-eyes-left.png'], ['rightPNG', 'pet-eyes-right.png']]) { await fs.writeFile(path.join(output, filename), Buffer.from(gazeEvidence[key].split(',')[1], 'base64')); screenshots.push(filename); delete gazeEvidence[key]; }
    assert.equal(gazeEvidence.petSize, 220);
    gazeEvidence.stableFrontSeconds = 15; gazeEvidence.poseSamples = poseSamples;
    for (const [direction, y] of [['up', 20], ['down', 940]]) {
      await mouseMove(eyeCenter.x, y);
      await until('production head follows ' + direction, () => js(`window.nativePetGaze.canvas.dataset.gaze==='tracking'&&Number(window.nativePetGaze.canvas.dataset.gazeY)${direction === 'up' ? '<-2.8' : '>2.8'}`));
      await wait(300); await capture('pet-production-gaze-' + direction + '.png');
      const filename = 'pet-head-' + direction + '.png';
      await fs.writeFile(path.join(output, filename), Buffer.from(await js("window.nativePetGaze.canvas.toDataURL('image/png').split(',')[1]"), 'base64')); screenshots.push(filename);
    }
    const beforeBlur = await js('window.nativePetGaze.pointerEvents.length');
    child.blur(); win.focus(); desktopMove(-200, -100);
    await until('a visible unfocused pet follows desktop pointer IPC outside the window', async () => !child.isFocused() && await js(`window.nativePetGaze.pointerEvents.length>${beforeBlur}&&!document.hidden&&!document.getElementById('pet-overlay-gaze').hidden&&Number(window.nativePetGaze.canvas.dataset.gazeX)<-4`));
    gazeEvidence.visibleWhileUnfocused = true; gazeEvidence.desktopOutsideWindow = true;
    await js("(()=>{const f=window.nativePetGaze;document.removeEventListener('pointermove',f.pointer);window.removeEventListener('synora:pet-action',f.action);f.off();delete window.nativePetGaze;return true})()");
    screen.getCursorScreenPoint = originalCursorPoint;
    child.focus(); child.webContents.focus();
    await updatePet({ x: dragged.x, y: dragged.y });

    await step('native work-status animation mapping and parallel tools');
    const event = async input => { await js(`window.synoraPetOverlay.handleEvent(${JSON.stringify(input)});true`); };
    const expectAnimation = async animation => { const value = await decoded(animation); statusAnimations.push({ animation, width: value.width, height: value.height }); };
    await event({ type: 'run-start' }); await expectAnimation('thinking');
    assert.equal(await js("document.getElementById('pet-overlay-gaze').hidden&&document.getElementById('pet-overlay-gaze').dataset.gaze==='off'"), true, 'Task animation disables eye warping immediately');
    await event({ type: 'tool-start', toolCallId: 'native-tool-1' }); await expectAnimation('working');
    await event({ type: 'tool-start', toolCallId: 'native-tool-2' });
    await event({ type: 'tool-result', toolCallId: 'native-tool-1' }); await expectAnimation('working');
    await event({ type: 'tool-result', toolCallId: 'native-tool-2' }); await expectAnimation('thinking');
    await event({ type: 'approval-request', id: 'native-approval' }); await expectAnimation('waiting');
    await event({ type: 'approval-resolved', id: 'native-approval' }); await expectAnimation('thinking');
    await event({ type: 'text-delta', text: 'fixture text' }); await expectAnimation('result');
    await event({ type: 'run-end', status: 'completed' }); await expectAnimation('success');
    await event({ type: 'run-start' }); await event({ type: 'run-end', status: 'failed' }); await expectAnimation('error');
    await event({ type: 'run-end', status: 'stopped' }); await decoded('idle');

    if (process.env.FORGEDESK_SMOKE_PET_GAZE_ONLY === '1') {
      const evidence = { status: 'completed', network: false, modelRequests: 0, actualUpstreamVideo: true,
        genuineEyeWarp: gazeEvidence, productionGazeDisabledDuringTasks: true, statusAnimations, screenshots };
      await fs.writeFile(path.join(output, 'pet-gaze-evidence.json'), JSON.stringify(evidence, null, 2));
      return evidence;
    }

    await step('independent pet and plugin settings across all appearance styles');
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      await call('setAppearance', { uiStyle: style, selectionColor: '#63b77b' }); await js('window.synoraAppearance.settled()');
      await openSettings('plugins');
      const pluginLayout = await js("(()=>{const d=document.getElementById('extensions-dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,error:document.getElementById('extensions-error').textContent}})()");
      assert.ok(pluginLayout.left >= 0 && pluginLayout.right <= pluginLayout.width + 1 && pluginLayout.top >= 0 && pluginLayout.bottom <= pluginLayout.height + 1); assert.equal(pluginLayout.error, '');
      await capture('extensions-settings-' + style + '.png'); await click('#extensions-close');
      await openSettings('pet');
      const layout = await js(`(()=>{const d=document.getElementById('pet-settings-dialog'),r=d.getBoundingClientRect(),c=document.getElementById('pet-settings-enabled'),f=document.getElementById('pet-settings-follow');return {style:document.documentElement.dataset.uiStyle,open:d.open,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,checked:c.checked,followChecked:f.checked,followDisabled:f.disabled,accent:getComputedStyle(c).accentColor,error:document.getElementById('pet-settings-error').textContent}})()`);
      assert.equal(layout.style, style); assert.equal(layout.checked, true); assert.ok(layout.left >= 0 && layout.right <= layout.width + 1 && layout.top >= 0 && layout.bottom <= layout.height + 1); assert.equal(layout.error, '');
      assert.equal(layout.followChecked, true); assert.equal(layout.followDisabled, false);
      themes.push({ ...layout, plugin: pluginLayout }); await capture('pet-settings-' + style + '.png');
      if (style === 'industrial') {
        await click('#pet-settings-enabled'); await until('pet disabled via independent settings', async () => !(await call('petState')).enabled && (await inspectPet()).hidden);
        await click('#pet-settings-enabled'); await decoded('idle');
        await click('#pet-settings-follow'); await until('follow setting persisted independently', async () => (await call('petState')).followCursor === false && dshPet.snapshot().followCursor === false);
        const restoredFollow = await new DshPetStore({ dataDir }).init(); assert.equal(restoredFollow.snapshot().followCursor, false);
      }
      await click('#pet-settings-close');
      await verifyOperationColors(style);
    }
    await step('large pet preserves composer, stop and approval hit targets after resizing');
    await updatePet({ size: 600, x: 1, y: 1 });
    child.setContentSize(980, 760); await assertComposerTargets('large pet in narrow window');
    await js("(()=>{const send=document.getElementById('send-button'),stop=document.getElementById('stop-button');window.nativePetControls={send:send.hidden,stop:stop.hidden};send.hidden=true;stop.hidden=false;const approval=document.getElementById('composer-approval');approval.hidden=false;const button=document.createElement('button');button.type='button';button.id='native-pet-approval-target';button.textContent='原生布局测试：允许';approval.append(button);return true})()");
    await assertComposerTargets('large pet with stop and approval controls');
    await capture('extensions-pet-narrow-controls.png');
    await js("(()=>{document.getElementById('send-button').hidden=window.nativePetControls.send;document.getElementById('stop-button').hidden=window.nativePetControls.stop;document.getElementById('native-pet-approval-target').remove();document.getElementById('composer-approval').hidden=true;delete window.nativePetControls;return true})()");
    child.setContentSize(1280, 960);
    await updatePet({ size: 220, x: dragged.x, y: dragged.y });
    await updatePet({ size: 280, workStatus: false });
    await event({ type: 'run-start' }); await decoded('idle'); await event({ type: 'run-end', status: 'stopped' });
    await updatePet({ workStatus: true });
    const reloaded = new Promise(resolve => child.webContents.once('did-finish-load', resolve));
    child.webContents.reloadIgnoringCache(); await bounded(reloaded, 'renderer reload'); await ready(); await js('Promise.all([window.synoraPetOverlay.ready,window.synoraExtensions.ready,window.synoraPetSettings.ready])');
    pet = await decoded('idle'); assert.equal(pet.state.size, 280); assert.equal(pet.state.x, dragged.x); assert.equal(pet.state.y, dragged.y);
    assert.equal(pet.state.followCursor, false);
    await openSettings('pet'); assert.equal(await js("document.getElementById('pet-settings-follow').checked"), false); await click('#pet-settings-close');
    await pointer(await point('#pet-overlay-hit'), 'right'); await click('#pet-overlay-settings'); await visibleDialog('pet-settings-dialog');
    assert.equal(await js("document.getElementById('extensions-dialog').open"), false, 'The pet context menu opens only independent pet settings');
    await click('#pet-settings-close');

    await step('genuine DSH pack import via native picker bridge');
    const sourcePet = path.join(fixtureRoot, 'source-pet');
    const builtinPet = path.join(__dirname, '..', 'vendor', 'dsh-pet');
    // Electron's readFile understands ASAR paths; Node's recursive cp does not
    // consistently normalize their internal paths on Windows. Copy only the
    // pinned fixture configuration and its declared local videos explicitly.
    await fs.mkdir(path.join(sourcePet, 'webm'), { recursive: true });
    await fs.writeFile(path.join(sourcePet, 'config.json'), await fs.readFile(path.join(builtinPet, 'config.json')));
    const provenance = JSON.parse(await fs.readFile(path.join(builtinPet, 'provenance.json'), 'utf8'));
    assert.equal(provenance.assets.length, 11);
    for (const asset of provenance.assets) {
      assert.match(asset.path, /^webm\/[^/\\]+\.webm$/u);
      const pieces = asset.path.split('/');
      await fs.writeFile(path.join(sourcePet, ...pieces), await fs.readFile(path.join(builtinPet, ...pieces)));
    }
    nextPick = path.join(sourcePet, 'config.json');
    await openSettings('pet'); await click('#pet-settings-import');
    const importedPet = await until('DSH pack copied and selected', async () => { const value = await call('petState'); return value.packs.length === 2 && value.packId.startsWith('local-') && value; });
    await until('custom packs leave follow control disabled', () => js("document.getElementById('pet-settings-follow').disabled&&document.getElementById('pet-settings-follow').title==='此宠物包未提供眼睛定位'"));
    await click('#pet-settings-close'); await decoded('idle');
    assert.ok(importedPet.packs.at(-1).animations.idle[0].url.includes('pet-packs'));
    await fs.rm(sourcePet, { recursive: true, force: true });
    const reloadedPet = await new DshPetStore({ dataDir }).init(); assert.deepEqual(reloadedPet.snapshot(), importedPet);

    await step('create and install the developer template through shipped UI and IPC');
    const templates = path.join(fixtureRoot, 'developer-output'); await fs.mkdir(templates);
    nextPick = templates;
    const example = await call('createExtensionExample');
    assert.ok(example && typeof example.path === 'string' && path.resolve(example.path).startsWith(templates + path.sep));
    const manifestFile = path.join(example.path, 'synora-plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.id = 'smoke.native-extension'; manifest.name = '本地原生测试插件';
    manifest.permissions = ['project.read', 'project.write', 'notifications'];
    manifest.commands = [{ id: 'inspect', title: '查看原生测试项目' }];
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    nextPick = example.path;
    await openSettings('plugins'); await click('#extensions-install');
    await until('new plugin defaults disabled', async () => { const plugins = (await call('getExtensions')).plugins; return plugins.some(value => value.id === manifest.id && !value.enabled); });
    const row = pluginRow(manifest.id);
    assert.equal(await js(`document.querySelector(${JSON.stringify(row + ' [data-action="open"]')}).disabled`), true);
    await click(row + ' [data-action="enable"]');
    await until('plugin enabled and persisted', async () => (await call('getExtensions')).plugins.some(value => value.id === manifest.id && value.enabled));
    const reopenedManager = await new PluginManager({ dataDir }).init();
    assert.equal(reopenedManager.list().find(value => value.id === manifest.id).enabled, true); await reopenedManager.dispose();
    await click(row + ' [data-action="open"]'); await windowForPlugin(manifest.id);
    assert.ok(panel.webContents.isOffscreen());
    await until('plugin renderer SDK', () => panelJs('Boolean(window.synoraPlugin)'));
    const globals = await panelJs("({forge:typeof window.forge,node:typeof require,process:typeof process,api:Object.keys(window.synoraPlugin).sort(),projectApi:Object.keys(window.synoraPlugin.project).sort()})");
    assert.equal(globals.forge, 'undefined'); assert.equal(globals.node, 'undefined'); assert.equal(globals.process, 'undefined');
    assert.deepEqual(globals.api, ['info', 'notify', 'onCommand', 'project']);
    assert.deepEqual(globals.projectApi, ['info', 'listFiles', 'readText', 'writeText']);
    assert.deepEqual(await panelJs('window.synoraPlugin.info()'), { name: 'Synora code', version: require('../../package.json').version, apiVersion: 1 });
    const projectInfo = await panelJs('window.synoraPlugin.project.info()'); assert.equal(projectInfo.root, project);
    const files = await panelJs('window.synoraPlugin.project.listFiles()'); assert.ok(files.some(value => value.path === 'sample.txt')); assert.equal(files.some(value => value.path === '.env'), false);
    assert.ok(await resultError("window.synoraPlugin.project.readText({path:'.env'})"));
    assert.ok(await resultError("window.synoraPlugin.project.readText({path:'../outside.txt'})"));
    const originalFile = await panelJs("window.synoraPlugin.project.readText({path:'sample.txt'})");
    assert.equal(originalFile.content, 'original fixture text\n'); assert.match(originalFile.version, /^[a-f0-9]{64}$/u);

    await step('genuine plugin write IPC honors explicit native approval and file versions');
    const writeInput = { path: 'sample.txt', content: 'changed by isolated plugin\n', expectedVersion: originalFile.version };
    nextWrite = 'cancel'; const beforeCancel = decisions.length;
    assert.ok(await resultError(`window.synoraPlugin.project.writeText(${JSON.stringify(writeInput)})`));
    assert.equal(await fs.readFile(path.join(project, 'sample.txt'), 'utf8'), originalFile.content);
    assert.ok(decisions.length > beforeCancel && decisions.at(-1).isWrite);
    nextWrite = 'allow';
    const written = await panelJs(`window.synoraPlugin.project.writeText(${JSON.stringify(writeInput)})`);
    assert.equal(written.content, writeInput.content); assert.notEqual(written.version, originalFile.version);
    assert.equal(await fs.readFile(path.join(project, 'sample.txt'), 'utf8'), writeInput.content);
    const beforeStale = decisions.length;
    assert.ok(await resultError(`window.synoraPlugin.project.writeText(${JSON.stringify(writeInput)})`));
    assert.equal(decisions.length, beforeStale, 'Stale writes cannot ask for approval or overwrite data');
    await panelJs('window.nativeCommands=[];window.synoraPlugin.onCommand(command=>window.nativeCommands.push(command.id));true;');
    await click(row + ' [data-command="inspect"]');
    await until('declared command delivered through private plugin preload', () => panelJs("window.nativeCommands.includes('inspect')"));
    await fs.writeFile(path.join(output, 'extensions-plugin-window.png'), (await panel.webContents.capturePage()).toPNG()); screenshots.push('extensions-plugin-window.png');

    await step('workspace changes reject stale plugin access, disabling closes panels');
    await click('#extensions-close'); await js(`openRecentProject({path:${JSON.stringify(otherProject)}})`);
    await until('project switched', async () => (await call('getState')).workspace.root === otherProject && await js('!projectSwitching'));
    await step('project changed; reject old plugin read');
    if (!panel.isDestroyed()) assert.match(await resultError("window.synoraPlugin.project.readText({path:'sample.txt'})") || '', /项目|关闭/u);
    assert.equal(await fs.readFile(path.join(project, 'sample.txt'), 'utf8'), writeInput.content);
    const stalePanel = panel;
    await step('open settings in new project');
    await openSettings('plugins');
    await step('click reopen plugin in new project');
    await click(row + ' [data-action="open"]'); await windowForPlugin(manifest.id);
    await step('verify new project plugin instance');
    assert.notEqual(panel, stalePanel, 'Reopening in another project must replace the stale plugin panel');
    assert.equal(stalePanel.isDestroyed(), true);
    await until('reopened plugin SDK', () => panelJs('Boolean(window.synoraPlugin)'));
    assert.equal((await panelJs('window.synoraPlugin.project.info()')).root, otherProject);
    assert.equal((await panelJs("window.synoraPlugin.project.readText({path:'other.txt'})")).content, 'other project\n');
    await step('disable plugin');
    await click(row + ' [data-action="enable"]');
    await until('disabled plugin closes native windows', () => !pluginRuntime.windows().some(value => value.id === manifest.id));
    assert.equal(panel.isDestroyed(), true);
    const finalManager = await new PluginManager({ dataDir }).init();
    assert.equal(finalManager.list().find(value => value.id === manifest.id).enabled, false); await finalManager.dispose();
    assert.equal(pluginManager.list().find(value => value.id === manifest.id).enabled, false);
    await step('remove plugin');
    await click(row + ' [data-action="remove"]'); await click(row + ' [data-action="confirm-remove"]');
    await until('plugin removed via UI', async () => !(await call('getExtensions')).plugins.some(value => value.id === manifest.id));
    await until('installed plugin copy removed', async () => { try { await fs.stat(path.join(dataDir, 'plugins', manifest.id)); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } });
    assert.equal(JSON.parse(await fs.readFile(manifestFile, 'utf8')).id, manifest.id, 'Removing an installed plugin must preserve its developer source');
    assert.equal(nextPick, null); assert.ok(decisions.some(value => value.isWrite && /sample\.txt/u.test(value.message + value.detail)));
    assert.equal((await call('getState')).activeTask?.running === true, false);
    const evidence = { status: 'completed', isolatedRegisteredChild: true, network: false, modelRequests: 0,
      actualUpstreamVideo: true, transparency, nativeDragPersists: true, restartRestoresPetSettings: true, fourThemes: themes,
      composerControlsUnobstructed: true, composerLayouts,
      separatePluginAndPetMenus: true, separatePluginAndPetDialogs: true, petContextOpensPetOnly: true,
      mouseFollowDefaultsEnabled: true, mouseFollowChoicePersists: true, unsupportedPackFollowDisabled: true,
      genuineEyeWarp: gazeEvidence, productionGazeDisabledDuringTasks: true, operationSummaryColors: operationColors,
      statusAnimations, localDshPackCopiedAndReopened: true, createdDeveloperTemplate: true, installedDisabled: true,
      enablementPersists: true, actualSandboxedPluginWindow: true, privatePreloadOnly: true, projectReadBoundaries: true,
      nativeWriteCancelAndAllow: true, staleWriteRejected: true, declaredCommandDispatch: true,
      changedProjectGuard: true, reopeningUsesCurrentProject: true, disablingClosesPluginWindows: true,
      nativeRemovalPreservesDeveloperSource: true, decisions, pickerRequests, screenshots };
    await fs.writeFile(path.join(output, 'extensions-evidence.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  } catch (error) {
    if (child && !child.isDestroyed()) await capture('extensions-failure.png').catch(() => {});
    const diagnostic = { stage, message: error.message, decisions, pickerRequests,
      pet: child && !child.isDestroyed() ? await inspectPet().catch(() => null) : null,
      ui: child && !child.isDestroyed() ? await js("({error:document.getElementById('extensions-error')?.textContent,status:document.getElementById('extensions-status')?.textContent,petError:document.getElementById('pet-settings-error')?.textContent,petStatus:document.getElementById('pet-settings-status')?.textContent,notice:document.getElementById('notice')?.textContent})").catch(() => null) : null };
    await fs.writeFile(path.join(output, 'extensions-failure.json'), JSON.stringify(diagnostic, null, 2));
    console.error('EXTENSIONS_SMOKE_DIAGNOSTIC', JSON.stringify(diagnostic));
    throw error;
  } finally {
    screen.getCursorScreenPoint = originalCursorPoint;
    dialog.showOpenDialog = originalOpenDialog; dialog.showMessageBox = originalMessageBox;
    if (panel && !panel.isDestroyed()) panel.destroy();
    if (child && !child.isDestroyed()) {
      await js("(()=>{const f=window.nativePetGaze;if(!f)return;document.removeEventListener('pointermove',f.pointer);window.removeEventListener('synora:pet-action',f.action);f.off?.();delete window.nativePetGaze})()").catch(() => {});
      if (originalAppearance) await call('setAppearance', { uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor }).catch(() => {});
      child.destroy();
    }
  }
};
