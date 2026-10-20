// Native, isolated renderer and local image fixtures only. Never contacts a model
// service, modifies the system clipboard, or reads a user's saved appearance.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { dialog } = require('electron');

// A broad, smooth blue/violet fixture makes screenshots useful without bundling
// an external photograph or introducing a network dependency into the smoke.
function fixturePng() {
  const width = 960, height = 640;
  const chunk = (type, data) => {
    const tag = Buffer.from(type), payload = Buffer.concat([tag, data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const blue = Math.exp(-((u - 0.18) ** 2 / 0.22 + (v - 0.23) ** 2 / 0.2));
      const violet = Math.exp(-((u - 0.85) ** 2 / 0.2 + (v - 0.72) ** 2 / 0.3));
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      pixels[offset] = Math.round(12 + 88 * violet + 4 * blue);
      pixels[offset + 1] = Math.round(18 + 92 * blue + 18 * violet);
      pixels[offset + 2] = Math.round(52 + 150 * blue + 90 * violet);
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = async function smokeAppearance({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Appearance smoke requires an isolated offscreen test window');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Appearance smoke timed out: ' + label);
  };
  const capture = async name => {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        win.webContents.invalidate();
        // A reload replaces the offscreen compositor surface. Let two renderer
        // frames reach Viz before capture; the frame wait is itself bounded if
        // painting is temporarily suspended in a hidden smoke window.
        await js(`new Promise(resolve => {
          const timer=setTimeout(()=>resolve(false),500);
          requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true);}));
        })`);
        await wait(180 * attempt);
        const image = await win.webContents.capturePage();
        assert.equal(image.isEmpty(), false, 'capturePage returned an empty image');
        const size = image.getSize(), png = image.toPNG();
        assert.ok(size.width > 0 && size.height > 0 && png.length > 8, 'capturePage returned no usable pixels');
        assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'capturePage did not produce PNG data');
        await fs.writeFile(path.join(output, name), png);
        return;
      } catch (error) {
        // Only the observed transient Viz surface error is retryable. Empty
        // images, renderer failures, and filesystem errors must still fail.
        const message = String(error?.message || error);
        const transient = /\bUnknownVizError\b/.test(String(error?.name || '') + ' ' + message);
        if (!transient || attempt === attempts) throw new Error(`Appearance screenshot "${name}" failed on attempt ${attempt}/${attempts}: ${message}`, { cause: error });
        console.warn(`[appearance-smoke] Retrying ${name} after UnknownVizError (${attempt}/${attempts}).`);
      }
    }
  };
  const key = (code, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
  };
  const click = async selector => {
    const point = await js(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled || !node.getClientRects().length) throw new Error('Appearance control unavailable: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const menu = async action => {
    await click('#menu-appearance');
    await until('appearance menu open', () => js("!document.getElementById('app-menu-popup').hidden"));
    await click(`#app-menu-popup [data-action="${action}"]`);
  };
  const panelControls = [
    { id:'panel-frost', field:'panelFrost' },
    { id:'panel-transparency', field:'panelTransparency' },
  ];
  const snapshot = () => js(`(() => {
    const layer = document.getElementById('app-background'), style = getComputedStyle(layer);
    const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
    const surfaces = Object.fromEntries(['.sidebar', '.conversation', '.preview-panel', '.composer'].map(selector => {
      const node = document.querySelector(selector), s = getComputedStyle(node);
      return [selector, { ...rect(node), opacity:Number(s.opacity), blur:s.backdropFilter, filter:s.filter, background:s.backgroundColor, backgroundImage:s.backgroundImage, border:parseFloat(s.borderTopWidth), color:s.color }];
    }));
    return {
      viewport:{width:innerWidth,height:innerHeight}, horizontalOverflow:document.documentElement.scrollWidth > innerWidth + 1,
      layer:{...rect(layer),opacity:Number(style.opacity),pointerEvents:style.pointerEvents,custom:style.backgroundImage.includes('data:image/'),defaultImage:style.backgroundImage.includes('aurora-background.svg')},
      transparency:Number(document.getElementById('background-transparency').value),
      label:document.getElementById('background-transparency-value').value,
      panels:Object.fromEntries(${JSON.stringify(panelControls)}.map(({id,field})=>[field,{value:Number(document.getElementById(id).value),label:document.getElementById(id+'-value').value}])),
      panelOpacity:Number(getComputedStyle(document.documentElement).getPropertyValue('--panel-opacity')),
      dialog:{...rect(document.getElementById('appearance-dialog')),open:document.getElementById('appearance-dialog').open},
      composer:rect(document.getElementById('task-input')),surfaces
    };
  })()`);
  const geometry = async threePanes => {
    const value = await snapshot();
    assert.equal(value.horizontalOverflow, false, 'Glass layout overflows the window horizontally');
    assert.ok(value.composer.width >= 100 && value.composer.x >= -1 && value.composer.right <= value.viewport.width + 1, 'Composer is clipped');
    assert.ok(value.layer.x <= 0 && value.layer.y <= 0 && value.layer.right >= value.viewport.width && value.layer.bottom >= value.viewport.height, 'Background does not cover the complete workbench');
    assert.equal(value.layer.pointerEvents, 'none', 'Decorative background intercepts input');
    for (const [selector, surface] of Object.entries(value.surfaces)) {
      assert.equal(surface.opacity, 1, selector + ' faded its text together with the background');
      assert.equal(surface.filter, 'none', selector + ' blurred its text instead of the backdrop');
      assert.ok(surface.width > 0 && surface.height > 0, selector + ' has no usable area');
    }
    if (threePanes) {
      const left = value.surfaces['.sidebar'], center = value.surfaces['.conversation'], right = value.surfaces['.preview-panel'];
      assert.ok(left.right <= center.x + 2 && center.right <= right.x + 2, 'Three panes overlap at desktop width');
      assert.ok(center.width >= 350 && right.width >= 250 && right.right <= value.viewport.width + 1, 'Three-pane workbench is clipped');
    }
    if (value.dialog.open) assert.ok(value.dialog.x >= 0 && value.dialog.y >= 0 && value.dialog.right <= value.viewport.width + 1 && value.dialog.bottom <= value.viewport.height + 1, 'Appearance dialog is outside the viewport');
    return value;
  };
  const saved = () => fs.readFile(path.join(dataDir, 'appearance.json'), 'utf8').then(JSON.parse);
  const colorAlpha = color => { const values=color.match(/[\d.]+/g)||[];return values.length===4?Number(values[3]):1; };
  const assertPanels = async (values, label) => {
    const observed = await snapshot();
    for (const { field } of panelControls) {
      assert.equal(observed.panels[field].value, values[field], label + ': wrong slider value for ' + field);
      assert.equal(observed.panels[field].label, `${values[field]}%`, label + ': wrong visible value for ' + field);
    }
    assert.ok(Math.abs(observed.panelOpacity-(100-values.panelTransparency)/100)<0.005,label+': shared panel opacity variable is wrong');
    for (const selector of ['.sidebar','.conversation','.preview-panel']) {
      const value = values.panelFrost;
      const surface = observed.surfaces[selector];
      if (value === 0) assert.equal(surface.blur, 'none', label + ': zero must disable backdrop filtering for ' + selector);
      else {
        const blur = /\bblur\(([\d.]+)px\)/.exec(surface.blur);
        assert.ok(blur && Math.abs(Number(blur[1]) - value * 0.4) < 0.01, label + ': incorrect blur for ' + selector + ': ' + surface.blur);
      }
      assert.equal(surface.opacity, 1, label + ': content opacity changed for ' + selector);
      assert.equal(surface.filter, 'none', label + ': content itself was blurred for ' + selector);
      if (values.panelTransparency===0) assert.equal(colorAlpha(surface.background),1,label+': opaque panel must have an opaque material on '+selector);
      if (values.panelTransparency===100) {
        assert.equal(colorAlpha(surface.background),0,label+': clear panel retained its background on '+selector);
        const colors=surface.backgroundImage.match(/rgba?\([^)]*\)/g)||[];
        assert.ok(colors.every(color=>colorAlpha(color)===0),label+': clear panel retained visible gradient colors on '+selector+': '+surface.backgroundImage);
      }
    }
    return observed;
  };
  const panelsSaved = async values => {
    await js('window.synoraAppearance.settled()');
    await until('all independent panel settings durably saved', async () => {
      const state = await call('getAppearance'), disk = await saved();
      return Object.entries(values).every(([field,value]) => state[field] === value && disk[field] === value);
    });
  };
  const nativeSliderKey = async (id, keyCode, expected) => {
    await js(`(() => { const slider=document.getElementById(${JSON.stringify(id)});slider.scrollIntoView({block:'nearest'});slider.focus(); })()`);
    key(keyCode);
    await until('native frost key applied', () => js(`document.activeElement.id===${JSON.stringify(id)}&&Number(document.activeElement.value)===${expected}`));
  };
  const nativeSliderValue = async (id,value) => {
    await nativeSliderKey(id,'Home',0);
    for(let count=0;count<value;count++)key('Right');
    await until('native slider reaches '+value,()=>js(`Number(document.getElementById(${JSON.stringify(id)}).value)===${value}`));
  };
  const fixtureMessages = () => js(`(() => {
    if (window.__appearanceSmoke) return;
    const welcome=document.getElementById('welcome'),messages=document.getElementById('messages');
    const state={welcomeHidden:welcome.hidden,messagesHidden:messages.hidden,followOutput,nodes:[]};
    window.__appearanceSmoke=state;
    state.nodes.push(addMessage('user','把工作区调整成柔和的磨砂玻璃风格，并保留清晰的代码阅读体验。',false,{id:'appearance-local-user',createdAt:'2026-10-20T08:30:00.000Z'}).message);
    state.nodes.push(addMessage('assistant','## 让灵感，在此流动。\\n\\n已为工作区准备了统一的 **蓝紫极光** 视觉。\\n\\n- 半透明卡片，保留轻盈的层次。\\n- 清晰的代码与对话，让注意力回到创作。\\n- 导入你喜欢的背景，即时调整透明度。\\n\\n所有外观设置都会自动保存在本机。').message);
    followOutput=false;
    document.getElementById('message-scroll').scrollTop=0;
  })()`);
  const removeFixtureMessages = () => js(`(() => {
    const state=window.__appearanceSmoke;if(!state)return;
    state.nodes.forEach(node=>node.remove());
    document.getElementById('welcome').hidden=state.welcomeHidden;
    document.getElementById('messages').hidden=state.messagesHidden;
    followOutput=state.followOutput;
    delete window.__appearanceSmoke;
  })()`);
  const imageDigest = value => createHash('sha256').update(value || '').digest('hex');
  const sameAppearance = (actual, expected) => actual.backgroundTransparency === expected.backgroundTransparency
    && actual.backgroundName === expected.backgroundName && imageDigest(actual.backgroundImage) === imageDigest(expected.backgroundImage)
    && panelControls.every(({field}) => actual[field] === expected[field])
    && actual.backgroundPreset===expected.backgroundPreset && actual.conversationTextColor===expected.conversationTextColor;
  const suffix = randomUUID();
  const project = path.join(dataDir, 'appearance-project-' + suffix, '极光工作室');
  const fixture = path.join(dataDir, '磨砂背景 ' + suffix + '.png');
  const invalidFixture = path.join(dataDir, 'appearance-invalid-' + suffix + '.png');
  const originalChooser = dialog.showOpenDialog;
  const initialBounds = win.getBounds();
  let chooserCalls = 0, chooserReply = { canceled: true, filePaths: [] };
  const chooserOptions = [];
  try {
    await fs.mkdir(output, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'theme.css'), ':root {\n  --accent: #87aaff;\n  --glass: rgba(255, 255, 255, 0.1);\n}\n\n.card {\n  border-radius: 20px;\n  backdrop-filter: blur(24px);\n}\n');
    await fs.writeFile(fixture, fixturePng());
    await fs.writeFile(invalidFixture, 'An invalid PNG fixture, never an executable.\n');
    await js('window.synoraAppearance.ready');
    await call('resetBackground');
    await call('setAppearance', { panelFrost:70, panelTransparency:30 });
    const defaults = await call('getAppearance');
    assert.equal(defaults.backgroundImage, null); assert.equal(defaults.backgroundName, ''); assert.equal(defaults.backgroundTransparency, 28);
    assert.equal(defaults.panelFrost,70);assert.equal(defaults.panelTransparency,30);
    await call('openProject', { path: project });
    win.setSize(1440, 1000);
    await until('fixture file tree', () => js("!!document.querySelector('.file-row[data-path=\"theme.css\"]')"));
    await click('.file-row[data-path="theme.css"]');
    await until('right editor and viewport', () => js("!document.getElementById('preview-panel').hidden&&!document.getElementById('file-preview').hidden&&document.getElementById('file-content').value.includes('--glass')&&innerWidth>=1438&&innerHeight>=900"));
    await js("if(!window.aiCodeCommands.getState().previewPinned)window.aiCodeCommands.execute('pin-summary')");
    const defaultView = await geometry(true);
    assert.equal(defaultView.layer.defaultImage, true); assert.equal(defaultView.layer.custom, false);
    assert.ok(Math.abs(defaultView.layer.opacity - 0.72) < 0.005, 'Default transparency was not applied to the background layer');
    for (const selector of ['.sidebar', '.conversation', '.preview-panel']) {
      assert.ok(defaultView.surfaces[selector].blur.includes('blur('), selector + ' has no frosted glass material');
      assert.ok(defaultView.surfaces[selector].border >= 1, selector + ' lost its glass edge');
    }
    assert.ok(defaultView.surfaces['.composer'].border >= 1, 'Composer lost its glass edge');
    await capture('appearance-default-desktop.png');
    await fixtureMessages();
    await capture('appearance-default-conversation.png');

    const viewItems = await js(`(() => {
      document.getElementById('menu-view').click();
      const items = [...document.querySelectorAll('#app-menu-popup [data-action]')].map(node => ({ action:node.dataset.action, disabled:node.disabled }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
      return items;
    })()`);
    for (const action of ['import-background', 'appearance-settings', 'frost-settings']) assert.equal(viewItems.some(item => item.action === action), false, 'Appearance action remained in the View menu: ' + action);
    await click('#menu-appearance');
    await until('new appearance menu is visible', () => js("!document.getElementById('app-menu-popup').hidden"));
    const menuItems = await js("[...document.querySelectorAll('#app-menu-popup [data-action]')].map(node=>({action:node.dataset.action,disabled:node.disabled}))");
    assert.deepEqual(menuItems.map(item=>item.action),['import-background','appearance-settings'],'Appearance menu must contain only the two background/settings actions');
    assert.ok(menuItems.every(item=>!item.disabled),'Appearance actions should be enabled');
    await capture('appearance-menu.png');
    key('Escape');
    await until('appearance menu closes', () => js("document.getElementById('app-menu-popup').hidden"));
    await js("document.getElementById('task-input').focus()");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Alt'});
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['alt']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['alt']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Alt'});
    await until('Alt+A opens and focuses the appearance menu', () => js("!document.getElementById('app-menu-popup').hidden&&document.getElementById('menu-appearance').getAttribute('aria-expanded')==='true'&&document.activeElement.closest('#app-menu-popup')?.id==='app-menu-popup'"));
    key('Escape');
    await until('Escape closes keyboard appearance menu', () => js("document.getElementById('app-menu-popup').hidden"));
    const sendButton = await js(`(() => {
      const button=document.getElementById('send-button');
      return {icon:!!button.querySelector('svg.send-plane-icon path'),label:button.getAttribute('aria-label'),title:button.title,text:button.textContent.trim()};
    })()`);
    assert.equal(sendButton.icon, true, 'Send button is missing its paper-plane SVG icon');
    assert.equal(sendButton.label, '发送任务');
    assert.ok(sendButton.title.includes('Ctrl + Enter'), 'Send keyboard shortcut hint changed');
    assert.equal(sendButton.text, '', 'Old arrow text remains beside the paper-plane icon');
    // The actual keyboard event activates the focused menu trigger.
    await js("document.getElementById('menu-appearance').focus()"); key('Enter');
    await until('keyboard opens appearance menu', () => js("!document.getElementById('app-menu-popup').hidden"));
    await click('#app-menu-popup [data-action="appearance-settings"]');
    await until('appearance modal open', () => js("document.getElementById('appearance-dialog').open"));
    assert.equal(await js("!!document.getElementById('background-transparency-help')||document.getElementById('appearance-dialog').textContent.includes('拖动即时预览，自动保存到本机。')"), false, 'Removed transparency hint is still visible or referenced');
    assert.equal(await js("!!document.getElementById('background-transparency').getAttribute('aria-describedby')?.includes('background-transparency-help')"), false, 'Transparency range points to the removed hint');
    assert.equal(await js("!!document.querySelector('#sidebar-frost,#conversation-frost,#preview-frost')||typeof window.synoraAppearance.openFrost!=='undefined'"),false,'Old per-pane controls or redundant API remain');
    const sliderRanges = await js(`${JSON.stringify(panelControls)}.map(({id})=>{const slider=document.getElementById(id);return {id,min:slider.min,max:slider.max,step:slider.step,type:slider.type};})`);
    for (const range of sliderRanges) assert.deepEqual(range, {id:range.id,min:'0',max:'100',step:'1',type:'range'}, 'Frost strength is not an accessible integer range');
    await assertPanels({panelFrost:70,panelTransparency:30}, 'Initial global panel settings');
    await geometry(true);
    await capture('appearance-settings-default.png');

    const clearPanels = {panelFrost:0,panelTransparency:100};
    await nativeSliderKey('panel-frost','Home',0);await nativeSliderKey('panel-transparency','End',100);
    await assertPanels(clearPanels, 'Native sliders make all panels clear');
    await panelsSaved(clearPanels);
    await click('#appearance-close');
    await until('zero-frost modal closes', () => js("!document.getElementById('appearance-dialog').open"));
    await geometry(true); await capture('appearance-frost-clear.png');
    await js("window.aiCodeCommands.execute('pin-summary')");
    await until('clear right pane unpinned',()=>js("!window.aiCodeCommands.getState().previewPinned"));
    await assertPanels(clearPanels,'Floating right pane is also fully clear');
    await js("window.aiCodeCommands.execute('pin-summary')");
    await until('clear right pane repinned',()=>js("window.aiCodeCommands.getState().previewPinned"));
    await menu('appearance-settings');
    await until('panel settings reopen', () => js("document.getElementById('appearance-dialog').open"));
    const opaquePanels = {panelFrost:100,panelTransparency:0};
    await nativeSliderKey('panel-frost','End',100);await nativeSliderKey('panel-transparency','Home',0);
    await assertPanels(opaquePanels, 'Native sliders make all panel materials opaque and fully frosted');
    await panelsSaved(opaquePanels);
    await click('#appearance-close');
    await until('maximum-frost modal closes', () => js("!document.getElementById('appearance-dialog').open"));
    await geometry(true); await capture('appearance-frost-strong.png');
    // The detached right pane has its own CSS selector. Its material must use
    // the same stored right-pane strength in both pinned and floating layouts.
    await js("window.aiCodeCommands.execute('pin-summary')");
    await until('right pane unpinned', () => js("!window.aiCodeCommands.getState().previewPinned"));
    await assertPanels(opaquePanels, 'Floating right pane uses global panel settings');
    await js("window.aiCodeCommands.execute('pin-summary')");
    await until('right pane repinned', () => js("window.aiCodeCommands.getState().previewPinned"));
    await menu('appearance-settings');
    await until('frost controls reopen', () => js("document.getElementById('appearance-dialog').open"));
    await click('#frost-reset');
    await panelsSaved({panelFrost:70,panelTransparency:0});
    await assertPanels({panelFrost:70,panelTransparency:0}, 'Frost reset preserves panel transparency');
    assert.equal((await call('getAppearance')).backgroundTransparency, 28, 'Frost reset changed the independent image transparency');
    await nativeSliderValue('panel-transparency',30);await panelsSaved({panelFrost:70,panelTransparency:30});
    key('Escape');
    await until('native Escape closes modal', () => js("!document.getElementById('appearance-dialog').open"));

    dialog.showOpenDialog = async (...args) => {
      chooserCalls++;
      const options = args.at(-1);
      chooserOptions.push({ properties:options.properties, extensions:options.filters?.flatMap(item => item.extensions) || [] });
      return chooserReply;
    };
    await menu('import-background');
    await until('cancelled native chooser settled', () => chooserCalls === 1 && js("document.getElementById('appearance-dialog').open&&document.getElementById('appearance-dialog').getAttribute('aria-busy')==='false'"));
    assert.equal(chooserCalls, 1);
    assert.equal(sameAppearance(await call('getAppearance'), defaults), true, 'Cancelling image selection changed the existing theme');
    assert.ok(chooserOptions[0].properties.includes('openFile') && chooserOptions[0].extensions.includes('png'), 'Background import did not request a native image picker');

    chooserReply = { canceled: false, filePaths: [fixture] };
    await click('#background-import');
    const imported = await until('fixture imported and buttons enabled', async () => {
      const state = await call('getAppearance');
      return typeof state.backgroundImage === 'string' && state.backgroundName === path.basename(fixture)
        && await js("document.getElementById('appearance-dialog').getAttribute('aria-busy')==='false'&&getComputedStyle(document.getElementById('app-background')).backgroundImage.includes('data:image/png')") && state;
    });
    assert.equal(chooserCalls, 2); assert.equal(imported.backgroundTransparency, 28);
    assert.equal(sameAppearance(await saved(), imported), true, 'Imported appearance was not saved atomically');
    assert.equal(JSON.stringify(await call('getState')).includes(imported.backgroundImage), false, 'Decorative image entered conversation or model state');
    await click('#appearance-close');
    await until('import settings closed', () => js("!document.getElementById('appearance-dialog').open"));
    await geometry(true); await capture('appearance-imported-desktop.png');

    await menu('appearance-settings');
    await until('imported appearance settings open', () => js("document.getElementById('appearance-dialog').open"));
    // Input must repaint immediately, before a later change/blur flush saves it.
    const live = await js(`(() => {
      const slider = document.getElementById('background-transparency');
      slider.value = '58'; slider.dispatchEvent(new Event('input', { bubbles:true }));
      return { target:Number(getComputedStyle(document.getElementById('app-background')).getPropertyValue('--background-opacity')), label:document.getElementById('background-transparency-value').value };
    })()`);
    assert.ok(Math.abs(live.target - 0.42) < 0.005, 'Transparency did not set its live preview immediately'); assert.equal(live.label, '58%');
    await until('live preview animation settled', () => js("Math.abs(Number(getComputedStyle(document.getElementById('app-background')).opacity)-0.42)<0.005"));
    await js("document.getElementById('background-transparency').dispatchEvent(new Event('change',{bubbles:true}));window.synoraAppearance.settled()");
    await until('transparency durably saved', async () => (await call('getAppearance')).backgroundTransparency === 58 && (await saved()).backgroundTransparency === 58);
    await geometry(true); await capture('appearance-settings-imported.png');

    // The real keyboard modifies a focused slider and the new value autosaves.
    await js("document.getElementById('background-transparency').focus()"); key('Right');
    await until('keyboard transparency saved', async () => (await call('getAppearance')).backgroundTransparency === 59 && (await saved()).backgroundTransparency === 59);
    for (const [value, opacity] of [[100, 0], [0, 1], [58, 0.42]]) {
      const observed = await js(`(() => { const slider=document.getElementById('background-transparency');slider.value=${JSON.stringify(String(value))};slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));return Number(getComputedStyle(document.getElementById('app-background')).getPropertyValue('--background-opacity')); })()`);
      assert.ok(Math.abs(observed - opacity) < 0.005, 'Transparency endpoint did not update the image layer');
    }
    await js('window.synoraAppearance.settled()');
    await until('last slider intent wins', async () => (await call('getAppearance')).backgroundTransparency === 58 && (await saved()).backgroundTransparency === 58);
    // Frost and panel material transparency are independent global controls;
    // the background image keeps its own transparency setting.
    await nativeSliderValue('panel-frost',35);await nativeSliderValue('panel-transparency',61);
    const mixedPanels = {panelFrost:35,panelTransparency:61};
    await assertPanels(mixedPanels, 'Independent mixed global panel settings');
    await panelsSaved({...mixedPanels,backgroundTransparency:58});
    assert.equal((await call('getAppearance')).backgroundTransparency, 58, 'Panel controls changed the image transparency');
    // Multiple controls can queue commits before an earlier IPC reply returns.
    // The final intent for every field must survive the serialized replies.
    await js(`(() => {
      for (const [id,value] of [['panel-frost',61],['panel-transparency',24],['background-transparency',83],['panel-frost',35],['panel-transparency',61],['background-transparency',58]]) {
        const slider=document.getElementById(id);slider.value=String(value);
        slider.dispatchEvent(new Event('input',{bubbles:true}));
        slider.dispatchEvent(new Event('change',{bubbles:true}));
      }
    })()`);
    await assertPanels(mixedPanels, 'Immediate preview after interleaved slider changes');
    await panelsSaved({...mixedPanels,backgroundTransparency:58});
    assert.equal((await call('getAppearance')).backgroundTransparency, 58, 'Interleaved frost changes lost the previous transparency');
    // This IPC mutation bypasses the sliders, exercising the main-process
    // appearance notification also used to synchronize other open windows.
    await call('setAppearance', {panelFrost:90});
    await until('external appearance event updates the slider', () => js("Number(document.getElementById('panel-frost').value)===90"));
    await assertPanels({...mixedPanels,panelFrost:90}, 'External appearance notification');
    await call('setAppearance', {panelFrost:35});
    await until('external appearance event restores the slider', () => js("Number(document.getElementById('panel-frost').value)===35"));
    await assertPanels(mixedPanels, 'External appearance notification preserves panel transparency');
    await geometry(true); await capture('appearance-settings-frost-mixed.png');
    const beforeInvalid = await call('getAppearance');
    chooserReply = { canceled:false, filePaths:[invalidFixture] };
    await click('#background-import');
    await until('invalid local image reports error', () => js("document.getElementById('appearance-dialog').getAttribute('aria-busy')==='false'&&!document.getElementById('appearance-status').hidden&&document.getElementById('appearance-status').classList.contains('error')"));
    assert.equal(sameAppearance(await call('getAppearance'), beforeInvalid), true, 'Invalid image replaced the working background');

    // Only delete this test's own source fixture: the imported copy must survive.
    await fs.unlink(fixture);
    await js('window.synoraAppearance.settled()');
    await removeFixtureMessages();
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload(); await loaded; await js('window.synoraAppearance.ready');
    const restored = await call('getAppearance');
    assert.equal(sameAppearance(restored, beforeInvalid), true, 'Appearance changed after renderer reload');
    await assertPanels(mixedPanels, 'Global panel settings restored after renderer reload');
    const restoredView = await until('background restored without original image', async () => { const value=await snapshot();return value.layer.custom && Math.abs(value.layer.opacity-0.42)<0.005 && value; });
    await until('reloaded workbench ready', () => js("!!document.querySelector('.file-row[data-path=\"theme.css\"]')"));
    await click('.file-row[data-path="theme.css"]');
    await until('reloaded editor open', () => js("!document.getElementById('preview-panel').hidden&&!document.getElementById('file-preview').hidden"));
    await js("if(!window.aiCodeCommands.getState().previewPinned)window.aiCodeCommands.execute('pin-summary')");
    await assertPanels(mixedPanels, 'Restored global settings apply when right editor opens');
    await fixtureMessages();
    await geometry(true); await capture('appearance-restored-desktop.png');
    win.setSize(980, 740);
    await until('compact viewport settled', () => js('innerWidth>=978&&innerWidth<=982'));
    await menu('appearance-settings');
    await until('compact modal open', () => js("document.getElementById('appearance-dialog').open"));
    const compactView = await geometry(false);
    await capture('appearance-settings-compact.png');
    await click('#background-reset');
    await until('default theme restored', async () => {
      const state=await call('getAppearance');
      return state.backgroundImage===null&&state.backgroundName===''&&state.backgroundTransparency===28
        && await js("document.getElementById('appearance-dialog').getAttribute('aria-busy')==='false'&&getComputedStyle(document.getElementById('app-background')).backgroundImage.includes('aurora-background.svg')");
    });
    assert.equal(sameAppearance(await saved(), {...defaults,...mixedPanels}), true, 'Background reset did not preserve independent global panel settings');
    await assertPanels(mixedPanels, 'Background reset preserves panel settings');
    await click('#frost-reset');
    await panelsSaved({panelFrost:70,panelTransparency:61});
    await assertPanels({panelFrost:70,panelTransparency:61}, 'Final frost reset preserves panel transparency');
    await nativeSliderValue('panel-transparency',30);await panelsSaved({panelFrost:70,panelTransparency:30});
    assert.equal(sameAppearance(await saved(), defaults), true, 'Frost reset changed the default image or transparency');
    key('Escape');
    await until('compact modal closes', () => js("!document.getElementById('appearance-dialog').open"));
    return {
      status:'completed', realApi:false, nativeMenuKeyboard:true, nativeEscape:true,
      nativeImageChooser:true, cancellationPreservesTheme:true, invalidImagePreservesTheme:true,
      importedImageSavedLocally:true, independentOfOriginalFile:true, rendererReloadRestoresAppearance:true,
      immediateTransparencyPreview:true, keyboardTransparency:true, transparencyEndpoints:true,
      rapidFinalIntentSaved:true, resetRestoresDefault:true, decorativeImageExcludedFromModelState:true,
      separateAppearanceMenu:true, nativeAltAAppearanceMenu:true, appearanceRemovedFromView:true, paperPlaneSendIcon:true, removedTransparencyHint:true,
      nativeFrostSliderEndpoints:true,nativePanelTransparencyEndpoints:true,globalFrostAcrossAllPanes:true,independentPanelAndImageTransparency:true,rapidPanelEditsPreserved:true,
      externalAppearanceEventsApplied:true,
      rendererReloadRestoresPanelSettings:true,pinnedAndFloatingPanelsShareSettings:true,frostResetPreservesPanelTransparency:true,frostResetPreservesBackground:true,
      backgroundResetPreservesPanelSettings:true,clearFrostDisablesBackdropFilter:true,fullyTransparentPanelMaterials:true,opaquePanelMaterials:true,contentTextNeverFiltered:true,
      chooserCalls, desktop:{width:defaultView.viewport.width,height:defaultView.viewport.height},
      compact:{width:compactView.viewport.width,height:compactView.viewport.height},
      defaultOpacity:defaultView.layer.opacity, importedOpacity:restoredView.layer.opacity,
      surfaces:defaultView.surfaces,
    };
  } finally {
    dialog.showOpenDialog = originalChooser;
    if (!win.isDestroyed()) {
      await removeFixtureMessages().catch(() => {});
      await js("window.synoraAppearance?.settled().catch(()=>{});document.getElementById('appearance-dialog')?.close()").catch(() => {});
      win.setBounds(initialBounds);
    }
  }
};
