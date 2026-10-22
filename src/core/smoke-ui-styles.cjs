// Real native material selection and isolated file editing. No model requests,
// commands, credentials, user projects or external services are accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, nativeTheme } = require('electron');

module.exports = async function smokeUiStyles({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const project = path.join(dataDir, 'ui-styles-' + randomUUID());
  const appearanceFile = path.join(dataDir, 'appearance.json');
  const source = ['<!doctype html>', '<html lang="zh-CN">', '<head><style>',
    '.panel { color: #24743c; padding: 12px; }', '</style></head>', '<body>',
    '<h1 class="panel">界面风格预览</h1>', '<script>', '// Highlighted text stays separate from editable text.',
    'const label = "Synora code";', 'function greet(value) {', '  if (value) return label + 42;',
    '  console.log("Ready");', '}', '</script>', '</body></html>', ''].join('\n');
  const independentFields = ['backgroundImage', 'backgroundName', 'backgroundPreset', 'backgroundTransparency',
    'panelFrost', 'panelTransparency', 'conversationTextColor'];
  let child, other, originalAppearance, stage = 'create isolated material fixture';
  const samples = {}, screenshots = [], layoutCases = {}, paletteSamples = {};
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const call = (method, value, target = child) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`, target);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('UI styles smoke timed out: ' + label);
  };
  const click = async (selector, target = child) => {
    const point = await until('native control is uncovered: ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});
      if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return r.width&&r.height&&node.contains(document.elementFromPoint(p.x,p.y))?p:null;
    })()`, target));
    target.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) target.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await wait(40);
  };
  const key = async (keyCode, modifiers = [], target = child) => {
    target.webContents.focus();
    target.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    target.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(35);
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(150 * attempt);
        const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename); return;
      } catch (error) { if (attempt === 4 || !/UnknownVizError/.test(String(error))) throw error; }
    }
  };
  const inspect = (target = child) => js(`(() => {
    const material = selector => {
      const node=document.querySelector(selector);if(!node)return null;
      const s=getComputedStyle(node),r=node.getBoundingClientRect();
      return {background:s.backgroundColor,color:s.color,image:s.backgroundImage,blur:s.backdropFilter,
        webkitBlur:s.webkitBackdropFilter||s.backdropFilter,borderRadius:s.borderRadius,fill:s.webkitTextFillColor,
        caret:s.caretColor,display:s.display,visible:node.checkVisibility(),position:s.position,
        margin:{left:parseFloat(s.marginLeft),right:parseFloat(s.marginRight),top:parseFloat(s.marginTop),bottom:parseFloat(s.marginBottom)},
        borders:{left:parseFloat(s.borderLeftWidth),right:parseFloat(s.borderRightWidth),top:parseFloat(s.borderTopWidth),bottom:parseFloat(s.borderBottomWidth)},
        box:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    };
    const editor=$('file-content'),code=$('file-highlight-code');
    return {style:document.documentElement.dataset.uiStyle,glassSettingsHidden:$('glass-appearance-settings').hidden,
      buttons:[...document.querySelectorAll('#ui-style-options [data-ui-style]')].map(n=>({style:n.dataset.uiStyle,pressed:n.getAttribute('aria-pressed')})),
      surfaces:Object.fromEntries(['body','.workspace-layout','.sidebar','.conversation','#preview-panel','#sidebar-resizer','#editor-resizer','.composer','#settings-dialog','#appearance-dialog',
        '#app-menu-popup','#permission-popup','#reasoning-popup','.file-code-editor','#file-highlight','#file-content',
        '#file-line-numbers','#app-background','.message.assistant .message-body','.message.assistant .message-paragraph',
        '.message.assistant .message-code','.message.assistant .message-code-label','.message.assistant .message-code pre code',
        '#session-rounds','#generation-speed','#session-cache','#session-cache-value','#session-total','#session-total-value',
        '#session-context-value'].map(s=>[s,material(s)])),
      editor:{ready:editor.closest('.file-code-editor').classList.contains('syntax-ready'),value:editor.value,
        mirror:code.textContent.replace(/\u200b$/,''),readOnly:editor.readOnly,
        colours:[...new Set([...code.querySelectorAll('.syntax-token')].map(n=>getComputedStyle(n).color))],
        kinds:[...new Set([...code.querySelectorAll('.syntax-token')].map(n=>n.className))],
        mirrorVisibility:getComputedStyle($('file-highlight')).visibility,
        totalLines:Number($('file-line-numbers').dataset.totalLines)},
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,viewport:{width:innerWidth,height:innerHeight},
      layout:{sidebarHidden:document.documentElement.classList.contains('sidebar-hidden'),previewPinned,
        previewHidden:$('preview-panel').hidden,sidebarWidth,editorWidth},
      nativeSelections:window.__materialSelections||[],unexpectedEvents:window.__materialUnexpectedEvents||[],
      appearanceEvents:window.__materialEvents||[],initialized:!!appState,
      unreadableStyleSheets:[...document.styleSheets].flatMap(sheet=>{try{void sheet.cssRules;return [];}catch{return [sheet.href];}})};
  })()`, target);
  const rgb = colour => {
    const numbers = colour.match(/[\d.]+/g)?.map(Number); assert.ok(numbers?.length >= 3, 'Expected computed rgb colour: ' + colour);
    return { r: numbers[0], g: numbers[1], b: numbers[2], a: numbers[3] ?? 1 };
  };
  const luminance = colour => {
    const { r, g, b } = rgb(colour), linear = [r, g, b].map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  };
  const contrast = (foreground, background) => {
    const light = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    return (light[1] + .05) / (light[0] + .05);
  };
  const assertSpacing = (value, style) => {
    const workspace = value.surfaces['.workspace-layout'], sidebar = value.surfaces['.sidebar'];
    const conversation = value.surfaces['.conversation'], preview = value.surfaces['#preview-panel'];
    const tolerance = .15;
    const expected = style === 'glass' ? 9 : style === 'industrial' ? 0 : 3;
    const actual = { sidebarGap: value.layout.sidebarHidden ? null : conversation.box.left - sidebar.box.right,
      previewGap: !value.layout.previewHidden && preview.position !== 'absolute' ? preview.box.left - conversation.box.right : null,
      outerMargins: workspace.margin, previewPosition: preview.position, sidebarHidden: value.layout.sidebarHidden,
      previewPinned: value.layout.previewPinned, previewHidden: value.layout.previewHidden };
    for (const gap of [actual.sidebarGap, actual.previewGap].filter(gap => gap !== null)) {
      assert.ok(gap >= -tolerance, style + ' panes must not overlap in the pinned layout: ' + JSON.stringify(actual));
      if (style === 'black' || style === 'white') assert.ok(gap <= 3 + tolerance, style + ' pane spacing must be at most 3px');
      else assert.ok(Math.abs(gap - expected) <= tolerance, style + ' pane spacing must be ' + expected + 'px');
    }
    if (style === 'black' || style === 'white') {
      for (const margin of Object.values(workspace.margin)) assert.equal(margin, 4, 'Black/white outer margins should be compact');
    } else if (style === 'industrial') {
      assert.deepEqual(workspace.margin, { left: 0, right: 0, top: 0, bottom: 0 });
      assert.equal(conversation.borderRadius, '0px'); assert.equal(preview.borderRadius, '0px');
      assert.equal(conversation.borders.left, 0); assert.equal(conversation.borders.right, 0);
      if (!value.layout.sidebarHidden) { assert.equal(sidebar.borderRadius, '0px'); assert.equal(sidebar.borders.right, 1); assert.equal(sidebar.borders.left, 0); }
      if (!value.layout.previewHidden) assert.equal(preview.borders.left, 1, 'Industrial editor needs its single left separator');
      if (value.layout.sidebarHidden) assert.ok(Math.abs(conversation.box.left - workspace.box.left) <= tolerance, 'Hiding the sidebar must not leave an industrial gutter');
      if (!value.layout.previewHidden && preview.position === 'absolute') {
        assert.ok(Math.abs(preview.box.right - workspace.box.right) <= tolerance, 'Floating industrial preview must align with the workspace edge');
        assert.ok(preview.box.left >= workspace.box.left - tolerance && preview.box.bottom <= workspace.box.bottom + tolerance);
      }
    }
    value.paneSpacing = actual; return actual;
  };
  const assertMaterial = (value, style) => {
    assert.equal(value.style, style); assert.equal(value.glassSettingsHidden, style !== 'glass');
    assert.deepEqual(value.buttons.filter(button => button.pressed === 'true').map(button => button.style), [style]);
    assert.equal(value.editor.ready, true); assert.equal(value.editor.mirror, value.editor.value);
    assert.equal(value.editor.readOnly, false); assert.equal(value.editor.mirrorVisibility, 'visible');
    assert.ok(value.editor.colours.length >= 6, 'The editor needs multiple distinct syntax colours in every material');
    assert.equal(value.editor.totalLines, value.editor.value.split('\n').length);
    assert.equal(rgb(value.surfaces['#file-content'].color).a, 0, 'Textarea glyphs must remain transparent over the syntax mirror');
    assert.equal(rgb(value.surfaces['#file-content'].fill).a, 0, 'Text fill must not draw a second copy over syntax tokens');
    assert.equal(rgb(value.surfaces['#file-content'].background).a, 0);
    assert.equal(value.horizontalOverflow, false);
    assertSpacing(value, style);
    if (style === 'glass') return;
    for (const selector of ['.sidebar', '.conversation', '#preview-panel', '.composer', '#settings-dialog', '#appearance-dialog', '#app-menu-popup', '#permission-popup', '#reasoning-popup']) {
      const surface = value.surfaces[selector]; assert.ok(surface, selector);
      assert.equal(surface.blur, 'none', style + ' must remove blur from ' + selector);
      assert.equal(surface.webkitBlur, 'none', style + ' must remove WebKit blur from ' + selector);
      assert.equal(rgb(surface.background).a, 1, style + ' must use an opaque ' + selector);
      assert.ok(contrast(surface.color, surface.background) >= 4.5, style + ' ordinary text must contrast with ' + selector);
    }
    const panel = value.surfaces['.conversation'], code = value.surfaces['.file-code-editor'];
    assert.equal(value.surfaces['#app-background'].display, 'none', 'Saved photo must not bleed through a solid material');
    for (const selector of ['.message.assistant .message-body', '.message.assistant .message-paragraph']) {
      assert.ok(contrast(value.surfaces[selector].color, panel.background) >= 4.5, style + ' conversation text contrast');
    }
    for (const selector of ['.message.assistant .message-code', '.message.assistant .message-code pre code']) {
      assert.ok(contrast(value.surfaces[selector].color, value.surfaces['.message.assistant .message-code'].background) >= 4.5,
        style + ' plain code glyphs must remain readable alongside syntax tokens');
    }
    const codeLabel = value.surfaces['.message.assistant .message-code-label'];
    assert.ok(contrast(codeLabel.color, codeLabel.background) >= 4.5, style + ' code language label contrast');
    for (const selector of ['#session-rounds', '#generation-speed', '#session-cache', '#session-cache-value', '#session-total', '#session-total-value', '#session-context-value']) {
      assert.ok(contrast(value.surfaces[selector].color, panel.background) >= 4.5, style + ' footer text contrast: ' + selector);
    }
    assert.ok(contrast(value.surfaces['#file-content'].caret, code.background) >= 4.5, 'Native caret must contrast with its editor');
    assert.ok(value.editor.colours.every(colour => contrast(colour, code.background) >= 3), style + ' syntax tokens must stay readable');
    if (style === 'white') { assert.equal(panel.background, 'rgb(242, 243, 245)'); assert.ok(luminance(panel.color) < .1);
      assert.equal(value.surfaces.body.background, 'rgb(233, 235, 238)'); }
    if (style === 'black') { assert.equal(panel.background, 'rgb(0, 0, 0)'); assert.ok(luminance(panel.color) > .6); }
    if (style === 'industrial') { assert.equal(panel.borderRadius, '0px'); assert.ok(luminance(panel.background) < .05); }
  };
  const settle = async (target = child) => {
    await js('window.synoraAppearance.settled()', target);
    await until('material transitions settled', () => js(`!document.getAnimations().some(animation=>animation.playState==='running')`, target));
  };
  const openAppearance = async (target = child, nativeEntry = false) => {
    if (nativeEntry) { await click('#menu-appearance', target); await click('#app-menu-popup [data-action="appearance-settings"]', target); }
    else await js('window.synoraAppearance.open()', target);
    await until('appearance dialog opens', () => js(`$('appearance-dialog').open`, target)); await settle(target);
  };
  const chooseStyle = async (style, target = child) => {
    await click('#ui-style-options [data-ui-style="' + style + '"]', target); await settle(target);
    await until('global material saved and broadcast ' + style, async () =>
      (await call('getAppearance')).uiStyle === style && (await call('getAppearance', undefined, other)).uiStyle === style
      && await js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`)
      && await js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`, other));
    const stored = JSON.parse(await fs.readFile(appearanceFile, 'utf8'));
    assert.equal(stored.version, 7); assert.equal(stored.uiStyle, style);
    const current = await call('getAppearance');
    for (const field of independentFields) assert.deepEqual(current[field], originalAppearance[field], 'Changing material must preserve ' + field);
    assert.equal(nativeTheme.themeSource, style === 'white' ? 'light' : 'dark');
    const nativeBackground = { glass: '#101010', black: '#000000', white: '#e9ebee', industrial: '#16191d' }[style];
    for (const targetWindow of [win, child, other]) assert.equal(targetWindow.getBackgroundColor().toLowerCase().replace(/^#ff(?=[0-9a-f]{6}$)/, '#'), nativeBackground,
      'Native window background must follow the global material');
  };
  const injectConversation = () => js(`(() => {
    followOutput=false; $('messages').replaceChildren(); $('welcome').hidden=true; $('messages').hidden=false;
    addMessage('user','请检查这份代码的显示效果。',false,{historical:true,target:$('messages')});
    addMessage('assistant',${JSON.stringify('我正在检查项目结构，接下来会调整样式并验证显示效果。\n\n```js\nconst theme = "preview";\nif (theme) console.log(theme, 42);\n```')},false,{historical:true,target:$('messages')});
    $('message-scroll').scrollTop=0;true;
  })()`);
  const initialize = async target => {
    await until('appearance renderer initialized', () => js('Boolean(appState&&window.synoraAppearance&&window.ForgeEditorHighlight&&!projectSwitching)', target));
    await js('window.synoraAppearance.ready', target);
    await js(`window.__materialSelections=[];window.__materialEvents=[];window.__materialUnexpectedEvents=[];
      window.__paletteSelections=[];
      document.querySelectorAll('#ui-style-options [data-ui-style]').forEach(node=>node.addEventListener('click',event=>window.__materialSelections.push({style:node.dataset.uiStyle,trusted:event.isTrusted})));
      document.querySelectorAll('#selection-color-options [data-selection-color]').forEach(node=>node.addEventListener('click',event=>window.__paletteSelections.push({color:node.dataset.selectionColor,trusted:event.isTrusted})));
      window.forge.onEvent(event=>{if(event.type==='appearance')window.__materialEvents.push(event.appearance.uiStyle);if(['run-start','usage','approval-request'].includes(event.type))window.__materialUnexpectedEvents.push(event.type);});true`, target);
  };
  const openEditor = async () => {
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('fixture project active', () => js(`appState?.workspace?.root===${JSON.stringify(project)}&&!projectSwitching`));
    await js('previewFile("sample.html")');
    await until('fixture editor highlighted', () => js(`selectedPath==='sample.html'&&!$('file-content').readOnly&&$('file-content').closest('.file-code-editor').classList.contains('syntax-ready')&&$('file-highlight-code').textContent.replace(/\u200b$/,'')===$('file-content').value`));
    await injectConversation();
  };
  const verifyDialogBounds = value => {
    const rect = value.surfaces['#appearance-dialog'].box;
    assert.ok(rect.left >= 0 && rect.right <= value.viewport.width + 1 && rect.top >= 0 && rect.bottom <= value.viewport.height + 1,
      'Appearance dialog must remain inside the viewport');
  };
  const nativeSidebarToggle = async () => {
    const hidden = await js(`document.documentElement.classList.contains('sidebar-hidden')`);
    await click('#menu-view'); await click('#app-menu-popup [data-action="toggle-sidebar"]');
    await until('sidebar visibility changes', () => js(`document.documentElement.classList.contains('sidebar-hidden')!==${hidden}`));
    await settle();
  };
  const nativeDrag = async (selector, delta) => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();
      const p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Resize hitbox is covered');return p;})()`);
    child.focus(); child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: point.x + delta, y: point.y });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + delta, y: point.y }); await settle();
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'sample.html'), source);
    originalAppearance = await call('getAppearance', undefined, win);
    child = BrowserWindow.fromId((await call('newWindow', undefined, win)).id);
    other = BrowserWindow.fromId((await call('newWindow', undefined, win)).id);
    assert.ok(child && other && child !== other && child.webContents.isOffscreen() && other.webContents.isOffscreen());
    await initialize(child); await initialize(other);
    for (const target of [child, other]) { target.setContentSize(1440, 1000); target.setOpacity(0); target.showInactive(); }
    await openEditor();
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      stage = 'native ' + style + ' material, persistence and global sync';
      await openAppearance(child, true); await chooseStyle(style);
      const value = await inspect(); assertMaterial(value, style); verifyDialogBounds(value);
      await capture('ui-style-' + style + '-appearance.png');
      await click('#appearance-close'); await settle(); assertMaterial(await inspect(), style);
      await capture('ui-style-' + style + '-editor.png');
      await click('#menu-file'); await settle();
      assert.equal(await js(`$('app-menu-popup').hidden`), false); assertMaterial(await inspect(), style);
      await capture('ui-style-' + style + '-menu.png'); await key('Escape');
      await click('#menu-edit'); await click('#app-menu-popup [data-action="settings"]'); await settle();
      assert.equal(await js(`$('settings-dialog').open`), true); assertMaterial(await inspect(), style);
      await capture('ui-style-' + style + '-settings.png'); await click('#close-settings'); await settle();
      samples[style] = await inspect();
      assertSpacing(samples[style], style);
      if (style === 'white') {
        stage = 'white native caret, syntax overlay and autosave';
        await click('#file-content'); await key('End', ['control']);
        const addition = '<!-- Native white-material edit -->\n';
        await child.webContents.insertText(addition);
        await until('white material edit saved and highlighted', async () => {
          const current = await inspect(); return current.editor.value === source + addition && current.editor.mirror === source + addition
            && !await js('editorDirty||editorSaving') && await fs.readFile(path.join(project, 'sample.html'), 'utf8') === source + addition;
        });
        assertMaterial(await inspect(), 'white');
        await capture('ui-style-white-native-edit.png');
      }
      if (style === 'industrial') {
        stage = 'industrial zero gaps, sidebar visibility and floating preview';
        await nativeSidebarToggle();
        layoutCases.industrialSidebarHidden = await inspect(); assertSpacing(layoutCases.industrialSidebarHidden, style);
        await capture('ui-style-industrial-sidebar-hidden.png');
        await click('#preview-pin'); await settle();
        layoutCases.industrialSidebarHiddenFloating = await inspect();
        assert.equal(layoutCases.industrialSidebarHiddenFloating.layout.previewPinned, false);
        assertSpacing(layoutCases.industrialSidebarHiddenFloating, style);
        await nativeSidebarToggle();
        layoutCases.industrialFloating = await inspect(); assertSpacing(layoutCases.industrialFloating, style);
        await capture('ui-style-industrial-floating.png');
        await click('#close-preview'); await settle();
        layoutCases.industrialPreviewHidden = await inspect(); assert.equal(layoutCases.industrialPreviewHidden.layout.previewHidden, true);
        assertSpacing(layoutCases.industrialPreviewHidden, style);
        await js('previewFile("sample.html")'); await settle();
        await click('#preview-pin'); await click('#file-preview-tab'); await settle();
        assert.equal((await inspect()).layout.previewPinned, true);
        stage = 'industrial invisible resize handle remains natively draggable';
        const before = await inspect();
        assert.ok(before.surfaces['#sidebar-resizer'].box.width >= 5);
        await nativeDrag('#sidebar-resizer', 8);
        await until('native industrial sidebar grows', () => js(`Math.abs(sidebarWidth-${before.layout.sidebarWidth + 8})<1`));
        layoutCases.industrialResized = await inspect(); assertSpacing(layoutCases.industrialResized, style);
        await nativeDrag('#sidebar-resizer', -8);
        await until('original sidebar width restored', () => js(`Math.abs(sidebarWidth-${before.layout.sidebarWidth})<1`));
        assertSpacing(await inspect(), style);
      }
    }
    stage = 'native selection palette updates selected files in all materials';
    await openAppearance();
    await click('#selection-color-options [data-selection-color="#dbb254"]'); await settle();
    await until('selection palette saved and synchronized', async () => (await call('getAppearance')).selectionColor === '#dbb254'
      && (await call('getAppearance', undefined, other)).selectionColor === '#dbb254'
      && await js(`document.documentElement.dataset.selectionColor==='custom'`, other));
    assert.ok(await js(`window.__paletteSelections.some(event=>event.color==='#dbb254'&&event.trusted)`));
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      await chooseStyle(style);
      const selected = await js(`(() => {const node=document.querySelector('.file-row.selected');if(!node)throw new Error('Selected file missing');const s=getComputedStyle(node);
        return {background:s.backgroundColor,color:s.color,icon:getComputedStyle(node.querySelector('.file-icon')).color,
          palette:$('selection-color-input').value,pressed:document.querySelector('#selection-color-options [data-selection-color="#dbb254"]').getAttribute('aria-pressed')};})()`);
      assert.equal(selected.background, 'rgb(219, 178, 84)');
      assert.equal(selected.palette, '#dbb254'); assert.equal(selected.pressed, 'true');
      assert.ok(contrast(selected.color, selected.background) >= 4.5); assert.equal(selected.icon, selected.color);
      paletteSamples[style] = selected;
      await capture('ui-style-' + style + '-selection-palette.png');
    }
    stage = 'custom color input persists and remains readable after renderer reload';
    await js(`$('selection-color-input').value='#112233';$('selection-color-input').dispatchEvent(new Event('input',{bubbles:true}));$('selection-color-input').dispatchEvent(new Event('change',{bubbles:true}));`);
    await settle();
    assert.equal((await call('getAppearance')).selectionColor, '#112233');
    assert.equal(JSON.parse(await fs.readFile(appearanceFile, 'utf8')).selectionColor, '#112233');
    child.webContents.reload(); await wait(50); await initialize(child); await openEditor();
    await until('custom palette restored on reload', () => js(`document.documentElement.dataset.selectionColor==='custom'&&getComputedStyle(document.querySelector('.file-row.selected')).backgroundColor==='rgb(17, 34, 51)'`));
    assert.equal(await js(`getComputedStyle(document.querySelector('.file-row.selected')).color`), 'rgb(255, 255, 255)');
    stage = 'native reset restores theme default without changing material';
    await openAppearance(); await click('#selection-color-reset'); await settle();
    assert.equal((await call('getAppearance')).selectionColor, null);
    assert.equal((await call('getAppearance')).uiStyle, 'industrial');
    assert.equal(await js(`document.documentElement.dataset.selectionColor`), 'default');
    await click('#appearance-close'); await settle();
    stage = 'reload restores the persisted material';
    child.webContents.reload(); await wait(50); await initialize(child);
    assert.equal(await js('document.documentElement.dataset.uiStyle'), 'industrial');
    assert.equal((await call('getAppearance')).uiStyle, 'industrial');
    await openEditor(); assertMaterial(await inspect(), 'industrial');
    stage = 'second-window native selection synchronizes the first window';
    await openAppearance(other); await chooseStyle('white', other); assertMaterial(await inspect(), 'white');
    assert.ok((await inspect(other)).nativeSelections.some(event => event.style === 'white' && event.trusted));
    await click('#appearance-close', other);
    stage = 'compact white and industrial layouts remain usable';
    child.setContentSize(980, 680); await wait(100);
    for (const style of ['white', 'industrial']) {
      await openAppearance(); await chooseStyle(style);
      const value = await inspect(); assertMaterial(value, style); verifyDialogBounds(value);
      await capture('ui-style-' + style + '-compact-appearance.png'); await click('#appearance-close'); await settle();
      assertMaterial(await inspect(), style); await capture('ui-style-' + style + '-compact-editor.png');
    }
    assert.deepEqual((await inspect()).unexpectedEvents, []); assert.deepEqual((await inspect(other)).unexpectedEvents, []);
    const initialNativeSelections = Object.values(samples).at(-1).nativeSelections;
    for (const style of ['glass', 'black', 'white', 'industrial']) assert.ok(initialNativeSelections.some(event => event.style === style && event.trusted), style + ' must be selected by real native click');
    const result = { status: 'completed', version: require('../../package.json').version, realApi: false, realCommands: false,
      nativeFourMaterialSelection: true, independentGlassPreferencesPreserved: true, version7DiskPersistence: true,
      softenedWhiteGrayLayers: true, nativePaletteSelectionAcrossFourMaterials: true, selectionTextAndIconsContrast: true,
      customColorInputPersistsAcrossReload: true, crossWindowPaletteSync: true, nativePaletteReset: true, paletteSamples,
      rendererReloadRestoresIndustrial: true, crossWindowNativeSelectionAndEvents: true,
      solidPanelsMenusDialogsHaveNoBlur: true, whiteAndDarkTextContrast: true, sixOrMoreSyntaxColours: true,
      fencedPlainCodeAndLanguageLabelContrast: true, footerMetricsContrast: true,
      transparentTextareaNoDoubledGlyphs: true, nativeWhiteEditorAutosaves: true, compactLayoutsFitViewport: true,
      nativeWindowBackgroundAndThemeSync: true,
      glassNinePixelPaneGapsPreserved: true, blackWhitePaneGapsAtMostThreePixels: true,
      industrialZeroGapsWithSingleSeparators: true, industrialSidebarAndFloatingPreviewLayouts: true,
      nativeIndustrialSidebarResizeHitboxPreserved: true, samples, layoutCases, screenshots };
    await fs.writeFile(path.join(output, 'ui-styles-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, screenshots };
    if (child && !child.isDestroyed()) try { failure.ui = await inspect(); await capture('ui-styles-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; }
    await fs.writeFile(path.join(output, 'ui-styles-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('UI styles smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (originalAppearance && !win.isDestroyed()) {
      await call('setAppearance', { uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor ?? null }, win).catch(() => {});
      await js('window.synoraAppearance.settled()', win).catch(() => {});
    }
    for (const target of [child, other]) if (target && !target.isDestroyed()) {
      target.close(); await until('isolated material window closes', () => target.isDestroyed()).catch(() => target.destroy());
    }
  }
};
