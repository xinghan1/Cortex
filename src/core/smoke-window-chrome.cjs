// Native WCO/window-state integration. Only offscreen smoke windows and isolated local fixtures are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeWindowChrome({ win, output, dataDir }) {
  if (process.platform !== 'win32') return { status: 'skipped', reason: 'Windows native caption overlay' };
  assert.equal(win.webContents.isOffscreen(), true, 'Window chrome smoke requires its own offscreen test window');
  const js = (code, target = win) => target.webContents.executeJavaScript(code);
  const call = (method, arg, target = win) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`, target);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Window chrome smoke timed out: ' + label);
  };
  const setScaleWithCommands = async scale => {
    assert.ok(Number.isInteger(scale) && scale >= 80 && scale <= 160 && scale % 10 === 0);
    await js(`(async()=>{await window.aiCodeCommands.execute('zoom-reset');for(let step=0;step<${Math.abs(scale - 100) / 10};step++)await window.aiCodeCommands.execute(${JSON.stringify(scale >= 100 ? 'zoom-in' : 'zoom-out')});})()`);
    await until(scale + ' percent UI and saved intent settled', async () => {
      const settled = await js(`document.documentElement.dataset.textScale===${JSON.stringify(String(scale))}&&textScaleDesired===${scale}&&textScaleConfirmed===${scale}&&!textScalePending&&!textScaleSaveTimer&&textScaleSavedIntent>=textScaleIntent`);
      return settled && (await call('getState')).textScale === scale;
    });
  };
  const initialState = await call('getState');
  const initial = { bounds: win.getBounds(), opacity: win.getOpacity(), fullscreen: win.isFullScreen(), maximized: win.isMaximized(), scale: initialState.textScale, project: initialState.workspace?.root };
  const fixture = path.join(dataDir, 'window-chrome-很长的项目名称用于验证标题栏菜单及原生窗口按钮安全区域-' + randomUUID());
  let child, releaseSave;
  const popupObservations = [];
  const nativeRename = fs.rename;
  const geometry = () => js(`(()=>{
    const api=navigator.windowControlsOverlay,area=api?.getTitlebarAreaRect?.();
    const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const region=node=>getComputedStyle(node).getPropertyValue('-webkit-app-region');
    const header=document.querySelector('.topbar'),brand=document.querySelector('.brand'),project=document.getElementById('project-switcher'),wrap=document.querySelector('.project-switcher-wrap'),menus=document.getElementById('app-menu-bar');
    const brandRect=brand.getBoundingClientRect(),projectRect=wrap.getBoundingClientRect();
    const blank={x:(brandRect.right+projectRect.left)/2,y:header.getBoundingClientRect().height/2};
    const blankNode=document.elementFromPoint(blank.x,blank.y);
    return{api:!!api,visible:api?.visible,area:area?{x:area.x,y:area.y,width:area.width,height:area.height,right:area.right}:null,viewport:{width:innerWidth,height:innerHeight},header:rect(header),headerRegion:region(header),paddingRight:parseFloat(getComputedStyle(header).paddingRight),fullscreen:document.documentElement.classList.contains('window-fullscreen'),project:rect(project),projectRegion:region(project),wrapRegion:region(wrap),menus:rect(menus),menusRegion:region(menus),menuItems:[...menus.querySelectorAll('button')].map(node=>({...rect(node),region:region(node),label:node.textContent})),blank:{...blank,header:blankNode===header,region:blankNode?region(blankNode):''}};
  })()`);
  const validateNormal = observed => {
    assert.equal(observed.api, true, 'Window Controls Overlay API is unavailable');
    assert.ok(observed.area && observed.area.width > 0);
    assert.equal(observed.area.height, 44);
    assert.equal(observed.header.height, 44);
    assert.equal(observed.header.y, 0);
    assert.equal(observed.headerRegion, 'drag');
    assert.equal(observed.projectRegion, 'no-drag');
    assert.equal(observed.wrapRegion, 'no-drag');
    assert.equal(observed.menusRegion, 'no-drag');
    assert.ok(observed.menuItems.every(item => item.region === 'no-drag' && item.width > 0 && item.y >= 0 && item.bottom <= 44.5));
    assert.ok(observed.project.right <= observed.menus.x + 1, 'Project selector overlaps menus');
    assert.ok(observed.menus.right <= observed.area.right + 1, 'Menus overlap native caption controls');
    assert.ok(observed.paddingRight >= 148, 'Native caption safety region was not reserved');
    assert.ok(observed.blank.header && observed.blank.region === 'drag', 'No blank draggable titlebar area remains');
  };
  const click = async (id, target = win) => {
    const point = await js(`(()=>{const node=document.getElementById(${JSON.stringify(id)});if(!node||node.disabled)throw new Error('Window chrome click target unavailable');const r=node.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`, target);
    target.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    target.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    target.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const escape = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };
  const f11 = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
  };
  const capture = async name => { win.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  try {
    // Electron maximize/restore can show a hidden window; opacity zero prevents a test window flashing on screen.
    win.setOpacity(0); win.hide();
    if (win.isFullScreen()) { win.setFullScreen(false); await until('initial fullscreen cleared', () => !win.isFullScreen()); }
    if (win.isMinimized()) { win.restore(); win.hide(); }
    if (win.isMaximized()) { win.unmaximize(); await until('initial maximize cleared', () => !win.isMaximized()); }
    win.hide();
    assert.ok(win.isMinimizable() && win.isMaximizable() && win.isClosable());
    const normal = await until('normal native overlay geometry', async () => { const value = await geometry(); return value.area?.height === 44 && value.area.width > 0 && value; });
    validateNormal(normal);
    const bounds = win.getBounds(), content = win.getContentBounds();
    const insets = { top: content.y - bounds.y, left: content.x - bounds.x, height: bounds.height - content.height };
    assert.ok(insets.top <= insets.left + 8 && insets.height <= 24, 'A separate traditional caption frame still occupies content space');
    await click('menu-file');
    await until('native pointer opens menu', () => js("!document.getElementById('app-menu-popup').hidden"));
    const menu = await js(`(()=>{const node=document.getElementById('app-menu-popup'),r=node.getBoundingClientRect();return{region:getComputedStyle(node).getPropertyValue('-webkit-app-region'),top:r.top,right:r.right,bottom:r.bottom,anchorBottom:document.getElementById('menu-file').getBoundingClientRect().bottom,width:innerWidth,height:innerHeight,items:node.querySelectorAll('[data-action]').length};})()`);
    popupObservations.push({ name: 'file-menu', ...menu });
    assert.equal(menu.region, 'no-drag');
    assert.ok(menu.items > 0 && menu.top >= menu.anchorBottom - 1 && menu.right <= menu.width && menu.bottom <= menu.height, 'File menu must open below its trigger within the viewport');
    escape(); await until('menu dismissed', () => js("document.getElementById('app-menu-popup').hidden"));
    await click('project-switcher');
    await until('native pointer opens project menu', () => js("!document.getElementById('project-dropdown').hidden"));
    const projectMenu = await js(`(()=>{const node=document.getElementById('project-dropdown'),r=node.getBoundingClientRect();return{region:getComputedStyle(node).getPropertyValue('-webkit-app-region'),top:r.top,right:r.right,bottom:r.bottom,anchorBottom:document.getElementById('project-switcher').getBoundingClientRect().bottom,width:innerWidth,height:innerHeight};})()`);
    popupObservations.push({ name: 'project-menu', ...projectMenu });
    assert.equal(projectMenu.region, 'no-drag');
    assert.ok(projectMenu.top >= projectMenu.anchorBottom - 1 && projectMenu.right <= projectMenu.width && projectMenu.bottom <= projectMenu.height, 'Project menu must open below its trigger within the viewport');
    await click('project-switcher'); await until('project menu dismissed', () => js("document.getElementById('project-dropdown').hidden"));

    win.maximize(); await until('maximize state', () => win.isMaximized()); win.hide();
    const maximized = await until('maximized overlay resized', async () => { const value = await geometry(); return value.area?.height === 44 && value.area.width > normal.area.width && value; });
    validateNormal(maximized);
    win.unmaximize(); await until('normal state restored', () => !win.isMaximized()); win.hide();
    await until('normal geometry restored', async () => Math.abs((await geometry()).viewport.width - normal.viewport.width) <= 2);
    win.minimize(); await until('minimized state', () => win.isMinimized());
    const minimized = await geometry();
    win.restore(); await until('minimized window restored', () => !win.isMinimized()); win.hide();
    const restored = await until('restored overlay available', async () => { const value = await geometry(); return value.area?.height === 44 && value.area.width > 0 && value; });
    validateNormal(restored);
    f11(); await until('F11 native fullscreen and renderer class', async () => win.isFullScreen() && (await geometry()).fullscreen);
    win.hide();
    const fullscreen = await geometry();
    assert.equal(fullscreen.header.height, 44);
    assert.equal(fullscreen.headerRegion, 'no-drag');
    if (fullscreen.visible && fullscreen.area?.width > 0) {
      assert.ok(fullscreen.paddingRight >= Math.max(148, fullscreen.viewport.width - fullscreen.area.right), 'Fullscreen native caption controls lost their reserved space');
      assert.ok(fullscreen.menus.right <= fullscreen.area.right + 1, 'Fullscreen menus overlap visible native caption controls');
    } else assert.ok(fullscreen.paddingRight >= 13 && fullscreen.paddingRight <= 15);
    f11(); await until('F11 restores native and renderer state', async () => !win.isFullScreen() && !(await geometry()).fullscreen); win.hide();
    validateNormal(await until('overlay restored after F11', async () => { const value = await geometry(); return value.area?.height === 44 && value.area.width > 0 && value; }));

    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, 'chrome-close.txt'), 'Original caption-close fixture\n');
    await call('openProject', { path: fixture });
    win.setSize(980, 740);
    await setScaleWithCommands(160);
    const compact = await until('980px overlay layout settled', async () => { const value = await geometry(); return value.viewport.width >= 978 && value.viewport.width <= 982 && value; });
    validateNormal(compact);
    assert.equal(await js("document.getElementById('workspace-label').textContent"), path.basename(fixture));
    await click('menu-view'); await until('large-text native pointer menu', () => js("!document.getElementById('app-menu-popup').hidden"));
    await capture('window-chrome-large-text.png');
    const largeMenu = await js(`(()=>{const node=document.getElementById('app-menu-popup'),r=node.getBoundingClientRect();return{top:r.top,right:r.right,bottom:r.bottom,anchorBottom:document.getElementById('menu-view').getBoundingClientRect().bottom,width:innerWidth,height:innerHeight,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};})()`);
    popupObservations.push({ name: 'large-text-view-menu', ...largeMenu });
    assert.ok(largeMenu.top >= largeMenu.anchorBottom - 1 && largeMenu.right <= largeMenu.width && largeMenu.bottom <= largeMenu.height && largeMenu.scrollWidth <= largeMenu.clientWidth + 1, 'Large-text view menu must open below its trigger without viewport overflow');
    escape(); await until('large-text menu dismissed', () => js("document.getElementById('app-menu-popup').hidden"));
    await click('project-switcher'); await until('large-text project menu opens', () => js("!document.getElementById('project-dropdown').hidden"));
    const largeProject = await js(`(()=>{const node=document.getElementById('project-dropdown'),r=node.getBoundingClientRect();return{top:r.top,right:r.right,bottom:r.bottom,anchorBottom:document.getElementById('project-switcher').getBoundingClientRect().bottom,width:innerWidth,height:innerHeight,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};})()`);
    popupObservations.push({ name: 'large-text-project-menu', ...largeProject });
    assert.ok(largeProject.top >= largeProject.anchorBottom - 1 && largeProject.right <= largeProject.width && largeProject.bottom <= largeProject.height && largeProject.scrollWidth <= largeProject.clientWidth + 1, 'Large-text project menu must open below its trigger without viewport overflow');
    await capture('window-chrome-projects.png');
    await click('project-switcher'); await until('large-text project menu closed', () => js("document.getElementById('project-dropdown').hidden"));

    // Native caption close reaches the same existing autosave/close guard; never click a real user's window.
    const created = await call('newWindow'); child = BrowserWindow.fromId(created.id);
    assert.ok(child && child !== win);
    assert.equal(child.webContents.isOffscreen(), true);
    child.setOpacity(0); child.hide();
    await call('openProject', { path: fixture }, child);
    await until('child file row ready', () => js("!!document.querySelector('.file-row[data-path=\"chrome-close.txt\"]')", child));
    await js("document.querySelector('.file-row[data-path=\"chrome-close.txt\"]').click()", child);
    await until('child editor ready', () => js("document.getElementById('preview-filename').title==='chrome-close.txt'&&!document.getElementById('file-content').readOnly", child));
    let saveEntered = false;
    const gate = new Promise(resolve => { releaseSave = resolve; });
    fs.rename = async (source, destination) => {
      if (!saveEntered && typeof source === 'string' && path.basename(source).startsWith('.manual-save-') && path.resolve(destination).toLowerCase() === path.join(fixture, 'chrome-close.txt').toLowerCase()) { saveEntered = true; await gate; }
      return nativeRename(source, destination);
    };
    const savedText = 'Automatically saved before native caption close\n';
    await js(`(()=>{const node=document.getElementById('file-content');node.value=${JSON.stringify(savedText)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`, child);
    await until('main knows child has unsaved or saving input', async () => (await call('getState', undefined, child)).editorDirty === true);
    child.close();
    await until('native close requests final save', () => saveEntered);
    assert.equal(child.isDestroyed(), false);
    releaseSave();
    await until('child native close completes after save', () => child.isDestroyed());
    assert.equal(await fs.readFile(path.join(fixture, 'chrome-close.txt'), 'utf8'), savedText);
    fs.rename = nativeRename;
    return { status: 'completed', nativeOverlayApi: true, titlebarHeight: 44, normalOverlay: normal.area, compactOverlay: compact.area, traditionalFrameRemoved: true, frameInsets: insets, dragRegion: true, pointerMenus: true, captionSafetyRegion: true, maximizeRestore: true, minimizeRestore: true, minimizedOverlayVisible: minimized.visible, fullscreenRestore: true, fullscreenOverlayVisible: fullscreen.visible, compactLargeTextAndProject: true, nativeCloseFlushes: true, screenshots: ['window-chrome-large-text.png', 'window-chrome-projects.png'] };
  } catch (error) {
    const observed = win.isDestroyed() ? null : await geometry().catch(() => null);
    console.error('WINDOW_CHROME_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, observed, popupObservations, bounds: win.isDestroyed() ? null : win.getBounds(), contentBounds: win.isDestroyed() ? null : win.getContentBounds() }));
    throw error;
  } finally {
    releaseSave?.(); fs.rename = nativeRename;
    if (child && !child.isDestroyed()) child.destroy();
    if (!win.isDestroyed()) {
      win.setOpacity(0);
      if (win.isFullScreen()) { win.setFullScreen(false); await until('cleanup fullscreen', () => !win.isFullScreen()).catch(() => {}); }
      if (win.isMinimized()) win.restore();
      if (win.isMaximized()) win.unmaximize();
      win.hide(); win.setBounds(initial.bounds);
      await setScaleWithCommands(initial.scale || 100).catch(() => {});
      if (initial.project) await call('openProject', { path: initial.project }).catch(() => {});
      if (initial.maximized) win.maximize();
      if (initial.fullscreen) win.setFullScreen(true);
      win.hide(); win.setOpacity(initial.opacity);
    }
  }
};
