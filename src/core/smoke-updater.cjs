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
  const requests = [], launches = [], screenshots = [];
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
    const area=navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    const point={x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
    return {hidden:button.hidden,disabled:button.disabled,status:button.dataset.status,text:label.textContent,title:button.title,
      region:getComputedStyle(button).getPropertyValue('-webkit-app-region'),progressHidden:progress.hidden,progress:progress.value,
      ariaProgress:progress.getAttribute('aria-valuenow'),busy:button.getAttribute('aria-busy'),
      box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},
      menuRight:menus.right,captionRight:area?.width?area.right:innerWidth,visible:button.checkVisibility({visibilityProperty:true,opacityProperty:true}),
      hit:button.contains(document.elementFromPoint(point.x,point.y)),...point};
  })()`);
  const expectState = status => until('update ' + status, async () => {
    const snapshot = await call('getAppUpdate'), rendered = await inspect();
    return snapshot.status === status && rendered.status === status && { snapshot, rendered };
  });
  const click = async () => {
    const point = await until('clickable update button', async () => {
      const value = await inspect(); return value.visible && value.hit && !value.disabled && value;
    });
    win.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
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
      createUpdater: onChange => new AppUpdater({ currentVersion, dataDir, enabled: true, fetchImpl: fakeFetch, onChange }),
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
      await call('setAppearance', { uiStyle: style }); await js('window.synoraAppearance.settled()');
      const rendered = await inspect();
      assert.equal(rendered.text, '更新'); assert.equal(rendered.hidden, false); assert.equal(rendered.disabled, false);
      assert.equal(rendered.visible, true); assert.equal(rendered.hit, true); assert.equal(rendered.region, 'no-drag');
      assert.ok(rendered.box.top >= 0 && rendered.box.bottom <= 44.5 && rendered.box.height > 0);
      assert.ok(rendered.menuRight <= rendered.box.left && rendered.box.right <= rendered.captionRight + 1, 'Update button overlaps menus or native caption controls');
      await capture('updater-' + style + '.png');
    }
    await click(); await expectState('error');
    assert.equal(launches.length, 0); assert.equal(control.quitCalls, 0);
    assert.match((await inspect()).text, /重试/u);
    await capture('updater-hash-error.png');
    control.corruptDownload = false; control.holdDownload = true;
    await click(); await expectState('downloading');
    await until('half-download progress', async () => {
      const view = await inspect(); return view.progress === 50 && view.ariaProgress === '50';
    });
    assert.equal((await inspect()).disabled, true); assert.equal((await inspect()).progressHidden, false);
    await capture('updater-progress.png');
    control.holdDownload = false; releaseDownload(); releaseDownload = null;
    await expectState('downloaded'); assert.match((await inspect()).text, /重启更新/u);
    assert.equal(launches.length, 0, 'Download triggered automatic installation');
    await call('setEditorDirty', { dirty: true }); await rejectInstall(/保存|修改/u);
    await call('setEditorDirty', { dirty: false });
    await call('runTask', { demo: true });
    await until('isolated demo run active', async () => (await call('getState')).activeTask.running);
    await rejectInstall(/任务|操作|运行/u);
    await call('stopTask');
    await until('isolated demo stopped', async () => !(await call('getState')).activeTask.running);
    await click();
    await until('held fake installer launcher', () => releaseLaunch);
    await expectState('installing');
    assert.equal(win.isEnabled(), false, 'The update transaction did not lock its native window');
    assert.match(await js("(async()=>{try{await window.forge.runTask({demo:true});return '';}catch(error){return error.message;}})()"), /重启|更新/u);
    releaseLaunch(); releaseLaunch = null;
    await until('launch failure stays retryable', async () => launchAttempts === 1 && (await inspect()).status === 'downloaded' && !(await inspect()).disabled);
    assert.equal(win.isEnabled(), true, 'A failed launcher left the window locked');
    assert.equal(launches.length, 0); assert.equal(control.quitCalls, 0);
    control.failLaunch = false; await click();
    await until('fake installer and quit called once', () => launches.length === 1 && control.quitCalls === 1);
    assert.equal(win.isDestroyed(), false, 'Fixture must not actually close the test app');
    return { status: 'completed', actualGitHubRequests: 0, executableLaunched: false, networkCalls: requests.length,
      nativeTitlebarButton: true, themes: ['glass','black','white','industrial'], currentHidden: true,
      checkFailureRetry: true, checksumFailureRetry: true, liveDownloadProgress: 50, explicitRestartOnly: true,
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
      if (originalAppearance) await call('setAppearance', { uiStyle: originalAppearance.uiStyle }).catch(() => {});
    }
  }
};
