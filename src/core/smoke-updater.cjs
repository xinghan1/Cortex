// Isolated shipped UI/IPC/updater exercise. Network responses and installer
// launching are injected; no GitHub request or executable is ever run.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AppUpdater } = require('./app-updater.cjs');

module.exports = async function smokeUpdater({ win, output, dataDir, configureUpdater }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Updater smoke timed out: ' + label);
  };
  const currentVersion = require('../../package.json').version;
  const pieces = currentVersion.split('.').map(Number), nextVersion = [pieces[0], pieces[1], pieces[2] + 1].join('.');
  const bytes = Buffer.alloc(1024, 0x41); bytes.write('MZ_SYNORA_TEST_BYTES_NOT_AN_EXECUTABLE');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const requests = [], launches = [], screenshots = [], paletteChecks = [], dialogThemes = [];
  const control = { version: currentVersion, failCheck: true, holdCheck: false, corruptDownload: true, holdDownload: false, failLaunch: true, quitCalls: 0 };
  let releaseCheck, releaseDownload, releaseLaunch, updater, originalAppearance, launchAttempts = 0;
  const fakeFetch = async (url, options) => {
    const location = String(url);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    requests.push(location);
    if (location === 'https://api.github.com/repos/xinghan1/Synora-code/releases/latest') {
      if (control.failCheck) throw new Error('Isolated offline fixture');
      if (control.holdCheck) await new Promise((resolve, reject) => {
        releaseCheck = resolve;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      const name = `Synora-code-Setup-${control.version}-x64.exe`;
      return new Response(JSON.stringify({ tag_name: 'v' + control.version, draft: false, prerelease: false,
        assets: [{ name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + digest,
          browser_download_url: `https://github.com/xinghan1/Synora-code/releases/download/v${control.version}/${name}` }] }),
      { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(location, `https://github.com/xinghan1/Synora-code/releases/download/v${nextVersion}/Synora-code-Setup-${nextVersion}-x64.exe`);
    const payload = Buffer.from(bytes);
    if (control.corruptDownload) payload[payload.length - 1] ^= 1;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(payload.subarray(0, 512));
      const complete = () => { controller.enqueue(payload.subarray(512)); controller.close(); };
      if (control.holdDownload) releaseDownload = complete;
      else complete();
      options.signal.addEventListener('abort', () => { try { controller.error(options.signal.reason); } catch {} }, { once: true });
    } }), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) } });
  };
  const inspect = () => js(`(() => {
    const button=document.getElementById('app-update-button'),label=document.getElementById('app-update-label'),progress=document.getElementById('app-update-progress');
    const box=button.getBoundingClientRect(),menus=document.getElementById('app-menu-bar').getBoundingClientRect();
    const help=document.getElementById('menu-help').getBoundingClientRect(),style=getComputedStyle(button),labelStyle=getComputedStyle(label),labelBox=label.getBoundingClientRect();
    const svg=button.querySelector('.app-update-icon'),svgBox=svg?.getBoundingClientRect(),svgStyle=svg&&getComputedStyle(svg);
    const ring=button.querySelector('.app-update-ring'),ringValue=button.querySelector('.app-update-ring-value');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
    const root=getComputedStyle(document.documentElement);
    const area=navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    const point={x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
    return {hidden:button.hidden,disabled:button.disabled,status:button.dataset.status,text:label.textContent,title:button.title,
      region:style.getPropertyValue('-webkit-app-region'),progressHidden:progress.hidden,progress:progress.value,
      ariaProgress:progress.getAttribute('aria-valuenow'),busy:button.getAttribute('aria-busy'),
      ariaLabel:button.getAttribute('aria-label'),labelHidden:label.hidden||labelStyle.display==='none'||labelStyle.visibility==='hidden'||Number(labelStyle.opacity)===0
        ||labelBox.width<=1&&labelBox.height<=1&&(labelStyle.clipPath!=='none'||labelStyle.clip!=='auto'),
      textOutsideLabel:[...button.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim(),
      svg:!!svg,svgVisible:!!svg&&svg.checkVisibility({visibilityProperty:true,opacityProperty:true}),svgShape:!!svg?.querySelector('path,polyline,line'),
      svgSize:svgBox?{width:svgBox.width,height:svgBox.height}:null,svgPointerEvents:svgStyle?.pointerEvents,
      ringVisible:!!ring&&ring.checkVisibility({visibilityProperty:true,opacityProperty:true}),ringOffset:ringValue?.getAttribute('stroke-dashoffset'),
      radius:style.borderTopLeftRadius,background:rgba(style.backgroundColor),ink:rgba(style.color),accent:rgba((root.getPropertyValue('--ui-accent')||root.getPropertyValue('--accent')).trim()),
      style:document.documentElement.dataset.uiStyle,palette:document.documentElement.dataset.selectionColor,
      box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},
      helpRight:help.right,helpCenterY:help.top+help.height/2,
      menuRight:menus.right,captionRight:area?.width?area.right:innerWidth,visible:button.checkVisibility({visibilityProperty:true,opacityProperty:true}),
      hit:button.contains(document.elementFromPoint(point.x,point.y)),...point};
  })()`);
  const inspectDialog = () => js(`(() => {
    const get=name=>document.getElementById('app-update-dialog'+(name?'-'+name:'')),dialog=get(''),progress=get('progress'),primary=get('primary');
    const box=dialog.getBoundingClientRect(),style=getComputedStyle(dialog),root=getComputedStyle(document.documentElement);
    const probe=document.createElement('span');probe.style.color=(root.getPropertyValue('--ui-accent')||root.getPropertyValue('--accent')).trim();dialog.append(probe);const accent=getComputedStyle(probe).color;probe.remove();
    return {open:dialog.open,status:dialog.dataset.status,title:get('title').textContent,description:get('status').textContent,descriptionHidden:get('status').hidden,
      percent:get('percent').textContent,percentLive:get('percent').getAttribute('aria-live'),bytes:get('bytes').textContent,error:get('error').textContent,errorHidden:get('error').hidden,
      progress:progress.value,progressHasValue:progress.hasAttribute('value'),ariaProgress:progress.getAttribute('aria-valuenow'),progressLabel:progress.getAttribute('aria-label'),
      primary:primary.textContent,primaryDisabled:primary.disabled,background:getComputedStyle(primary).backgroundColor,
      accent,progressAccent:getComputedStyle(progress).accentColor,region:style.getPropertyValue('-webkit-app-region'),
      ariaLabelledby:dialog.getAttribute('aria-labelledby'),ariaDescribedby:dialog.getAttribute('aria-describedby'),
      style:document.documentElement.dataset.uiStyle,width:innerWidth,height:innerHeight,
      box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height}};
  })()`);
  const assertDialog = rendered => {
    assert.equal(rendered.open, true); assert.equal(rendered.region, 'no-drag');
    assert.ok(Math.abs((rendered.box.left + rendered.box.right) / 2 - rendered.width / 2) <= 1, 'Update dialog must be horizontally centered');
    assert.ok(Math.abs((rendered.box.top + rendered.box.bottom) / 2 - rendered.height / 2) <= 1, 'Update dialog must be vertically centered');
    assert.ok(rendered.box.left >= 0 && rendered.box.right <= rendered.width && rendered.box.top >= 0 && rendered.box.bottom <= rendered.height);
    assert.equal(rendered.ariaLabelledby, 'app-update-dialog-title');
    assert.equal(rendered.ariaDescribedby, rendered.descriptionHidden ? null : 'app-update-dialog-status');
    assert.equal(rendered.percentLive, 'polite');
    assert.ok(rendered.progressLabel); assert.ok(!/NaN|Infinity|undefined/u.test(rendered.percent + rendered.bytes));
  };
  const assertIcon = rendered => {
    assert.equal(rendered.hidden, false); assert.equal(rendered.visible, true); assert.equal(rendered.region, 'no-drag');
    assert.equal(rendered.labelHidden, true, 'Update button must not display status text'); assert.equal(rendered.textOutsideLabel, '');
    assert.ok(rendered.ariaLabel && rendered.title, 'Icon-only updates need an accessible description and tooltip');
    assert.equal(rendered.svg, true); assert.equal(rendered.svgVisible, true); assert.equal(rendered.svgShape, true);
    assert.equal(rendered.ringVisible, rendered.status === 'downloading', 'The circular progress ring must only appear while downloading');
    assert.equal(rendered.svgPointerEvents, 'none', 'The decorative SVG must not intercept the button');
    assert.ok(rendered.svgSize.width >= 12 && rendered.svgSize.height >= 12);
    assert.ok(Math.abs(rendered.box.width - rendered.box.height) <= 0.5, 'Update control must be circular');
    assert.ok(rendered.box.width >= 24 && rendered.box.width <= 40, 'Update icon must fit the title bar');
    const radius = parseFloat(rendered.radius);
    assert.ok(rendered.radius.endsWith('%') ? radius >= 50 : radius >= rendered.box.width / 2, 'Update circle lost its rounded corners');
    assert.ok(rendered.box.top >= 0 && rendered.box.bottom <= 44.5);
    assert.ok(Math.abs(rendered.box.top + rendered.box.height / 2 - rendered.helpCenterY) <= 4, 'Update icon is not vertically aligned with Help');
    assert.ok(rendered.helpRight <= rendered.box.left && rendered.box.left - rendered.helpRight <= 24, 'Update icon must sit directly to the right of Help');
    assert.ok(rendered.menuRight <= rendered.box.left && rendered.box.right <= rendered.captionRight + 1, 'Update button overlaps menus or native caption controls');
  };
  const expectState = status => until('update ' + status, async () => {
    const snapshot = await call('getAppUpdate'), rendered = await inspect();
    return snapshot.status === status && rendered.status === status && { snapshot, rendered };
  });
  const appearance = async patch => {
    await call('setAppearance', patch); await js('window.synoraAppearance.settled()');
    // Settings persistence finishes before the shared 150ms button color
    // transition. Observe its final computed color instead of the first frame.
    return until('update background color transition', async () => {
      const rendered = await inspect();
      return rendered.background.every((channel, index) => channel === rendered.accent[index]) && rendered;
    });
  };
  const click = async () => {
    const point = await until('clickable update button', async () => {
      const value = await inspect(); return value.visible && value.hit && !value.disabled && value;
    });
    win.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
  };
  const clickDialog = async id => {
    const point = await until('clickable update dialog action ' + id, () => js(`(() => {
      const node=document.getElementById(${JSON.stringify('app-update-dialog-' + id)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      const box=node.getBoundingClientRect(),point={x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
      return node.contains(document.elementFromPoint(point.x,point.y))?point:null;})()`));
    win.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
  };
  const check = () => js('window.synoraAppUpdate.check(); true;');
  const capture = async name => {
    win.webContents.invalidate(); await wait(150);
    await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); screenshots.push(name);
  };
  const rejectInstall = async expression => {
    const error = await js("(async()=>{try{await window.forge.installAppUpdate();return null;}catch(error){return error.message;}})()");
    assert.match(error || '', expression);
    assert.equal(launches.length, 0, 'Blocked install reached the launcher');
    assert.equal(control.quitCalls, 0, 'Blocked install quit the application');
  };
  try {
    originalAppearance = await call('getAppearance');
    updater = await configureUpdater({
      createUpdater: onChange => new AppUpdater({ currentVersion, dataDir, enabled: true, fetchImpl: fakeFetch, onChange, checkCacheMs: 0 }),
      launchInstaller: async installer => {
        launchAttempts++;
        const target = path.resolve(installer), base = path.resolve(dataDir);
        assert.ok(target.startsWith(base + path.sep), 'Installer escaped the isolated fixture data');
        assert.equal(createHash('sha256').update(await fs.readFile(target)).digest('hex'), digest);
        if (control.failLaunch) {
          await new Promise(resolve => { releaseLaunch = resolve; });
          throw new Error('Isolated installer launch failure');
        }
        launches.push(target);
      },
      quitForUpdate: () => { control.quitCalls++; },
    });
    await expectState('idle');
    assert.equal((await inspect()).hidden, true, 'No update should occupy title-bar space');
    await check(); await expectState('error');
    assert.equal((await inspect()).hidden, true, 'Check failures must not show an update before a newer version is known');
    control.failCheck = false; control.holdCheck = true;
    await check(); await expectState('checking');
    await until('held metadata request', () => releaseCheck);
    control.holdCheck = false; releaseCheck(); releaseCheck = null;
    await expectState('current'); assert.equal((await inspect()).hidden, true);

    control.version = nextVersion; await check(); await expectState('available');
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      const rendered = await appearance({ uiStyle: style, selectionColor: null });
      assert.equal(rendered.text, '更新'); assert.equal(rendered.hidden, false); assert.equal(rendered.disabled, false);
      assertIcon(rendered); assert.equal(rendered.hit, true);
      assert.deepEqual(rendered.background, rendered.accent, 'Default update background must follow the theme accent');
      await capture('updater-' + style + '.png');
      for (const color of ['#6b9eff', '#e69a5c']) {
        const custom = await appearance({ selectionColor: color }); assertIcon(custom); assert.equal(custom.palette, 'custom');
        const expected = [...color.slice(1).match(/../g).map(hex => parseInt(hex, 16)), 255];
        assert.deepEqual(custom.background, expected, 'Update background did not follow the saved color style');
        assert.deepEqual(custom.background, custom.accent); assert.notDeepEqual(custom.background, custom.ink);
        assert.equal(custom.box.width, rendered.box.width); assert.equal(custom.box.height, rendered.box.height);
        paletteChecks.push({ style, color, background: custom.background });
        if (style === 'white' && color === '#e69a5c') await capture('updater-white-custom-color.png');
      }
      const reset = await appearance({ selectionColor: null });
      assert.deepEqual(reset.background, rendered.background, 'Reset must restore the theme background');
    }
    await click(); await expectState('error');
    assertIcon(await inspect());
    assert.equal(launches.length, 0); assert.equal(control.quitCalls, 0);
    assert.match((await inspect()).text, /重试/u);
    const failedDialog = await until('download failure shown in modal', async () => {const value=await inspectDialog();return value.open&&!value.errorHidden&&!value.primaryDisabled&&value;});
    assertDialog(failedDialog); assert.match(failedDialog.primary, /重试/u);
    await capture('updater-hash-error.png');
    control.corruptDownload = false; control.holdDownload = true;
    await clickDialog('primary'); await expectState('downloading');
    await until('half-download progress', async () => {
      const view = await inspect(); return view.progress === 50 && view.ariaProgress === '50' && view.ringOffset === '50';
    });
    assert.equal((await inspect()).disabled, false); assert.equal((await inspect()).progressHidden, false);
    assertIcon(await inspect());
    const half = await until('modal live percentage and byte counts', async () => {const value=await inspectDialog();return value.open&&value.percent==='50%'&&value.bytes.includes('0.5 KB')&&value;});
    assertDialog(half); assert.equal(half.progress, 50); assert.equal(half.ariaProgress, '50'); assert.match(half.bytes, /总大小 1 KB/u); assert.equal(half.primaryDisabled, true);
    assert.equal(half.description, ''); assert.equal(half.descriptionHidden, true);
    assert.equal(await js("document.getElementById('notice').hidden"), true, 'Retry must dismiss its own old download error without adding another status notice');
    await capture('updater-progress.png');
    const downloadRequests = requests.length;
    for (const dismiss of ['background','close','Escape']) {
      if (dismiss === 'Escape') {
        win.webContents.focus(); win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      } else await clickDialog(dismiss);
      await until('modal hidden without stopping download', async () => !(await inspectDialog()).open && (await call('getAppUpdate')).status==='downloading');
      assert.equal((await inspect()).disabled, false); await click();
      await until('download icon reopens modal', async () => (await inspectDialog()).open);
      assert.equal(requests.length, downloadRequests, 'Reopening a held download must not issue another request');
      assert.equal(launches.length, 0); assert.equal(control.quitCalls, 0);
    }
    for (const style of ['glass','black','white','industrial']) {
      await appearance({uiStyle:style,selectionColor:null});
      for (const color of [null,'#6b9eff']) {
        if (color) await appearance({selectionColor:color});
        const value=await until('modal palette and transition settled', async()=>{const value=await inspectDialog();return value.background===value.accent&&value.progressAccent===value.accent&&value;});
        assertDialog(value); assert.equal(value.percent,'50%'); assert.match(value.bytes,/0\.5 KB.*1 KB/u);
        dialogThemes.push({style,color,background:value.background,progressAccent:value.progressAccent,box:value.box});
        if (!color || style==='industrial') await capture('updater-dialog-'+style+(color?'-custom':'')+'.png');
      }
    }
    // The trusted updater requires an exact asset size. Exercise absent size
    // defensively through the public renderer snapshot, without weakening it.
    const actualDownload = await call('getAppUpdate');
    await js(`window.synoraAppUpdate.update({...${JSON.stringify(actualDownload)},progress:null,totalBytes:null,downloadedBytes:512});true;`);
    const unknown=await inspectDialog(); assertDialog(unknown); assert.equal(unknown.progressHasValue,false); assert.equal(unknown.ariaProgress,null);
    assert.match(unknown.percent,/等待/u); assert.match(unknown.bytes,/0\.5 KB.*总大小未知/u);
    await capture('updater-dialog-unknown-total.png');
    await js(`window.synoraAppUpdate.update(${JSON.stringify(actualDownload)});true;`);
    control.holdDownload = false; releaseDownload(); releaseDownload = null;
    await expectState('downloaded'); assert.match((await inspect()).text, /重启更新/u);
    assertIcon(await inspect());
    const completedDialog = await until('completed modal explicitly offers restart',async()=>{const value=await inspectDialog();return value.open&&value.primary==='重启更新'&&!value.primaryDisabled&&value;});
    assertDialog(completedDialog); assert.equal(completedDialog.percent,'100%'); assert.match(completedDialog.bytes,/1 KB.*1 KB/u);
    assert.equal(completedDialog.description, ''); assert.equal(completedDialog.descriptionHidden, true);
    await capture('updater-dialog-completed.png');
    assert.equal(launches.length, 0, 'Download triggered automatic installation');
    await call('setEditorDirty', { dirty: true }); await rejectInstall(/保存|修改/u);
    await call('setEditorDirty', { dirty: false });
    await call('runTask', { demo: true });
    await until('isolated demo run active', async () => (await call('getState')).activeTask.running);
    await until('modal restart disabled during task',async()=>(await inspectDialog()).primaryDisabled);
    await rejectInstall(/任务|操作|运行/u);
    await call('stopTask');
    await until('isolated demo stopped', async () => !(await call('getState')).activeTask.running);
    await clickDialog('primary');
    await until('held fake installer launcher', () => releaseLaunch);
    await expectState('installing');
    assertIcon(await inspect());
    assert.equal(win.isEnabled(), false, 'The update transaction did not lock its native window');
    assert.match(await js("(async()=>{try{await window.forge.runTask({demo:true});return '';}catch(error){return error.message;}})()"), /重启|更新/u);
    releaseLaunch(); releaseLaunch = null;
    await until('launch failure stays retryable', async () => launchAttempts === 1 && (await inspect()).status === 'downloaded' && !(await inspect()).disabled);
    assert.equal(win.isEnabled(), true, 'A failed launcher left the window locked');
    assert.equal(launches.length, 0); assert.equal(control.quitCalls, 0);
    await until('modal installer error retryable',async()=>{const value=await inspectDialog();return !value.errorHidden&&!value.primaryDisabled;});
    control.failLaunch = false; await clickDialog('primary');
    await until('fake installer and quit called once', () => launches.length === 1 && control.quitCalls === 1);
    assert.equal(win.isDestroyed(), false, 'Fixture must not actually close the test app');
    return { status: 'completed', actualGitHubRequests: 0, executableLaunched: false, networkCalls: requests.length,
      nativeTitlebarButton: true, circularDownloadSvg: true, nextToHelp: true, noVisibleButtonText: true,
      themes: ['glass','black','white','industrial'], customColorStyleAndReset: true, paletteChecks, currentHidden: true,
      checkFailureRetry: true, checksumFailureRetry: true, liveDownloadProgress: 50, explicitRestartOnly: true,
      centeredDownloadDialog: true, liveByteCounts: true, conciseDownloadDialog: true, staleDownloadErrorClearedOnRetry: true, backgroundCloseAndEscapeKeepDownloading: true,
      iconReopensWithoutDuplicateRequest: true, syntheticUnknownTotalUI: true, dialogThemes,
      unsavedInstallBlocked: true, activeTaskInstallBlocked: true, launchFailureRetry: true, fakeLaunches: launches.length,
      fakeQuitCalls: control.quitCalls, installTransactionLocked: true, screenshots };
  } catch (error) {
    const rendered = !win.isDestroyed() ? await inspect().catch(() => null) : null;
    console.error('UPDATER_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, stack: error.stack,
      rendered, snapshot: updater?.snapshot(), requestCount: requests.length, launchAttempts, launches: launches.length, quitCalls: control.quitCalls }));
    if (!win.isDestroyed()) await capture('updater-failure.png').catch(() => {});
    throw error;
  } finally {
    releaseCheck?.(); releaseDownload?.(); releaseLaunch?.();
    await updater?.dispose();
    if (!win.isDestroyed()) {
      await call('setEditorDirty', { dirty: false }).catch(() => {});
      await call('stopTask').catch(() => {});
      if (originalAppearance) await call('setAppearance', { uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor ?? null }).catch(() => {});
    }
  }
};
