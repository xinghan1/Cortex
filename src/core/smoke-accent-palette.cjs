// Native palette changes in isolated offscreen windows. No model, command,
// credential, external request or user project is used by this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeAccentPalette({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const project = path.join(dataDir, 'accent-palette-' + randomUUID());
  const styles = ['glass', 'black', 'white', 'industrial'];
  const samples = {}, defaults = {}, screenshots = [], overlays = new Map(), restores = [];
  let child, other, originalAppearance, trustedBeforeReload = [], stage = 'prepare isolated fixture';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const call = (method, value, target = child) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`, target);
  const until = async (label, check) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Accent palette timed out: ' + label);
  };
  const click = async (selector, target = child) => {
    const point = await until('native control uncovered: ' + selector, () => js(`(() => {
      const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return r.width&&r.height&&n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`, target));
    target.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) target.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await wait(45);
  };
  const settle = async (target = child) => {
    await js('window.synoraAppearance.settled()', target);
    await until('visual transitions settle', () => js(`!document.getAnimations().some(animation=>animation.playState==='running')`, target));
  };
  const openAppearance = async (target = child) => {
    await js('closeReasoningPopup();window.synoraAppearance.open()', target);
    await until('appearance dialog open', () => js(`$('appearance-dialog').open`, target)); await settle(target);
  };
  const chooseStyle = async style => {
    await openAppearance(); await click(`#ui-style-options [data-ui-style="${style}"]`); await settle();
    await until('material sync ' + style, async () => (await call('getAppearance')).uiStyle === style
      && await js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`, other));
    await click('#appearance-close'); await settle();
  };
  const chooseColor = async color => {
    await openAppearance();
    if (color === null) await click('#selection-color-reset');
    else if (['#6b9eff', '#63b77b'].includes(color)) await click(`#selection-color-options [data-selection-color="${color}"]`);
    else await js(`$('selection-color-input').value=${JSON.stringify(color)};$('selection-color-input').dispatchEvent(new Event('input',{bubbles:true}));$('selection-color-input').dispatchEvent(new Event('change',{bubbles:true}));`);
    await settle();
    await until('color sync ' + color, async () => (await call('getAppearance')).selectionColor === color
      && (await call('getAppearance', undefined, other)).selectionColor === color);
    await click('#appearance-close'); await settle();
  };
  const initialize = async target => {
    await until('renderer ready', () => js('Boolean(appState&&window.synoraAppearance&&!projectSwitching)', target));
    await js('window.synoraAppearance.ready', target);
    await js(`window.__accentUnexpected=[];window.__accentTrusted=[];
      document.querySelectorAll('#selection-color-options [data-selection-color],#ui-style-options [data-ui-style],#selection-color-reset').forEach(n=>n.addEventListener('click',e=>window.__accentTrusted.push({id:n.id,color:n.dataset.selectionColor,style:n.dataset.uiStyle,trusted:e.isTrusted})));
      window.forge.onEvent(e=>{if(['run-start','usage','approval-request'].includes(e.type))window.__accentUnexpected.push(e.type);});true`, target);
  };
  const fixture = async () => {
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project active', () => js(`appState?.workspace?.root===${JSON.stringify(project)}&&!projectSwitching`));
    await until('isolated project file rendered', () => js(`Boolean(document.querySelector('.file-row[data-path="sample.txt"]'))`));
    await js(`(() => {
      appState.settings={...appState.settings,provider:'openai',authMode:'apiKey',model:'accent-fixture',reasoningEffort:'max',providers:{...appState.settings.providers,openai:{...appState.settings.providers?.openai,hasKey:false,model:'accent-fixture',authMode:'apiKey'}}};
      currentCatalog={provider:'openai',authMode:'apiKey',models:[{id:'accent-fixture',displayName:'Accent fixture',reasoningEfforts:['low','medium','max'],defaultReasoningEffort:'medium',supportsTools:true}]};currentCatalogKey=activeCatalogIdentity();
      fillReasoningOptions($('reasoning-effort'),'openai','max');renderComposerModel();
      setPreviewOpen(false);followOutput=false;$('messages').replaceChildren();$('welcome').hidden=true;$('messages').hidden=false;
      addMessage('user','请检查自定义强调色。',false,{id:'accent-first',source:'direct'});
      addMessage('assistant','Synora code 正在检查项目标识、发送按钮、推理强度以及轮次标记。');
      addMessage('user','所有主题使用同一色板。',false,{id:'accent-second',source:'direct'});
      addMessage('assistant','选中颜色设置将在重启和窗口之间保持同步。');
      const row=document.querySelector('.file-row[data-path="sample.txt"]');selectFileEntry({path:'sample.txt',name:'sample.txt',type:'file'},row);
      $('message-scroll').scrollTop=0;$('task-input').value='';$('notice').hidden=true;true;
    })()`);
    await until('real navigator renders active tick', () => js(`!!$('round-navigator').querySelector('[aria-current="step"]')`));
    await click('#task-input'); await settle();
  };
  const inspect = () => js(`(() => {
    const style=(selector,pseudo)=>{const n=document.querySelector(selector);if(!n)return null;const s=getComputedStyle(n,pseudo);return {color:s.color,background:s.backgroundColor,image:s.backgroundImage,border:s.borderTopColor,shadow:s.boxShadow,opacity:s.opacity,fill:s.webkitTextFillColor,accent:s.accentColor};};
    return {style:document.documentElement.dataset.uiStyle,palette:document.documentElement.dataset.selectionColor,
      accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      accentText:getComputedStyle(document.documentElement).getPropertyValue('--custom-accent-text').trim(),
      nodes:Object.fromEntries(['#project-avatar','.composer','#send-button','#send-button svg','#composer-reasoning-label','#reasoning-value','.reasoning-visual-track','.reasoning-visual-fill','.reasoning-visual-thumb','.file-row.selected','#round-navigator [aria-current="step"]','#round-navigator [aria-current="step"] > span'].map(s=>[s,style(s)])),
      fillAfter:style('.reasoning-visual-fill','::after'),thumbAfter:style('.reasoning-visual-thumb','::after'),
      composerFocused:document.querySelector('.composer').matches(':focus-within'),max:$('reasoning-value').classList.contains('is-max'),popupHidden:$('reasoning-popup').hidden,
      trusted:window.__accentTrusted,unexpected:window.__accentUnexpected};})()`);
  const rgb = color => {
    if (/^#[0-9a-f]{6}$/iu.test(color)) return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    const values = color.match(/[\d.]+/gu)?.map(Number); assert.ok(values?.length >= 3, 'Expected computed color: ' + color); return values.slice(0, 3);
  };
  const sameColor = (actual, expected, label) => assert.deepEqual(rgb(actual), rgb(expected), label);
  const luminance = color => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, index) => sum + n * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1] + .05) / (values[0] + .05); };
  const assertCustom = (value, color) => {
    assert.equal(value.palette, 'custom'); assert.equal(value.composerFocused, true); assert.equal(value.max, true);
    for (const selector of ['#project-avatar', '#send-button', '.reasoning-visual-fill', '.reasoning-visual-thumb', '.file-row.selected']) {
      sameColor(value.nodes[selector].background, color, value.style + ' custom background: ' + selector);
      assert.equal(value.nodes[selector].image, 'none', 'Custom accent must replace decorative gradient: ' + selector);
    }
    sameColor(value.nodes['.composer'].border, color, 'Composer focus border must use selected color');
    for (const selector of ['#project-avatar', '#send-button', '.file-row.selected']) assert.ok(contrast(value.nodes[selector].color, color) >= 4.5, 'Accent fill needs readable ink: ' + selector);
    assert.ok(Number(value.fillAfter.opacity) === 0 || value.fillAfter.image === 'none', 'Max slider cannot retain original colored gradient');
    assert.ok(Number(value.thumbAfter.opacity) === 0 || value.thumbAfter.image === 'none', 'Max thumb cannot retain original colored gradient');
    assert.equal(value.nodes['#composer-reasoning-label'].image, 'none'); assert.equal(value.nodes['#reasoning-value'].image, 'none');
    for (const selector of ['#composer-reasoning-label', '#reasoning-value', '#round-navigator [aria-current="step"]']) {
      sameColor(value.nodes[selector].color, value.accentText, 'Accent text must use readable current palette: ' + selector);
      assert.notEqual(value.nodes[selector].color, defaults[value.style].nodes[selector].color, 'Previously fixed theme accent must change: ' + selector);
    }
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) try {
      child.webContents.invalidate(); await wait(110 * attempt); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
      await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename); return;
    } catch (error) { if (attempt === 4 || !/UnknownVizError/u.test(String(error))) throw error; }
  };
  function spyOverlay(target) {
    const original = target.setTitleBarOverlay, values = []; overlays.set(target.id, values);
    target.setTitleBarOverlay = function (value) { values.push(structuredClone(value)); return original.call(this, value); };
    restores.push(() => { if (!target.isDestroyed()) target.setTitleBarOverlay = original; });
  }
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(project, 'sample.txt'), 'Accent palette fixture\n');
    originalAppearance = await call('getAppearance', undefined, win);
    child = BrowserWindow.fromId((await call('newWindow', undefined, win)).id); other = BrowserWindow.fromId((await call('newWindow', undefined, win)).id);
    assert.ok(child && other && child.webContents.isOffscreen() && other.webContents.isOffscreen());
    for (const target of [child, other]) { await initialize(target); target.setContentSize(1440, 1000); target.setOpacity(0); target.showInactive(); spyOverlay(target); }
    await fixture();
    for (const style of styles) {
      stage = style + ' baseline theme accent'; await chooseStyle(style); await chooseColor(null); await fixture(); defaults[style] = await inspect();
    }
    for (const style of styles) for (const color of ['#6b9eff', '#63b77b', '#112233']) {
      stage = style + ' custom accent ' + color; await chooseStyle(style); await chooseColor(color); await fixture();
      const value = await inspect(); assertCustom(value, color);
      await click('#model-reasoning-trigger'); await settle(); assert.equal(await js(`$('reasoning-popup').hidden`), false);
      const popup = await inspect(); sameColor(popup.nodes['.reasoning-visual-fill'].background, color, 'Visible popup fill');
      sameColor(popup.nodes['.reasoning-visual-thumb'].background, color, 'Visible popup thumb');
      await js(`fillReasoningOptions($('reasoning-effort'),'openai','medium')`); const normal = await inspect();
      assert.equal(normal.max, false); sameColor(normal.nodes['#reasoning-value'].color, normal.accentText, 'Normal reasoning title must use current readable palette');
      sameColor(normal.nodes['#composer-reasoning-label'].color, normal.accentText, 'Normal reasoning pill must use current readable palette');
      await js(`fillReasoningOptions($('reasoning-effort'),'openai','max')`); await settle();
      const { nativeAppearance, contrastRatio } = require('./native-appearance.cjs'); const palette = nativeAppearance(await call('getAppearance'));
      for (const target of [child, other]) { const overlay = overlays.get(target.id).at(-1); assert.ok(overlay, 'Native overlay update must be called');
        assert.equal(overlay.symbolColor, palette.symbol); assert.equal(overlay.color, palette.caption); assert.ok(contrastRatio(palette.symbol, palette.caption) >= 3); }
      if (style === 'industrial' && color === '#63b77b' || style === 'glass' && color === '#6b9eff' || style === 'white' && color === '#63b77b') await capture('accent-' + style + '-' + color.slice(1) + '.png');
      await js('closeReasoningPopup()'); samples[style + ':' + color] = { composer: value, popup, normal, native: palette };
    }
    stage = 'custom accent persists on disk and reload';
    trustedBeforeReload = (await inspect()).trusted;
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'appearance.json'), 'utf8')).selectionColor, '#112233');
    child.webContents.reload(); await wait(50); await initialize(child); await fixture(); assertCustom(await inspect(), '#112233');
    stage = 'default reset restores each material original accent';
    for (const style of styles) {
      await chooseStyle(style); await chooseColor(null); await fixture(); const current = await inspect();
      for (const selector of ['#project-avatar', '#send-button', '#composer-reasoning-label', '#reasoning-value', '.reasoning-visual-fill', '.reasoning-visual-thumb', '#round-navigator [aria-current="step"]'])
        assert.deepEqual(current.nodes[selector], defaults[style].nodes[selector], 'Reset must restore exact original ' + style + ' accent: ' + selector);
      assert.equal(current.palette, 'default');
      const palette = require('./native-appearance.cjs').nativeAppearance(await call('getAppearance'));
      for (const target of [child, other]) assert.equal(overlays.get(target.id).at(-1).symbolColor, palette.symbol, 'Reset must restore real native caption symbol color');
    }
    assert.deepEqual((await inspect()).unexpected, []); assert.deepEqual(await js('window.__accentUnexpected', other), []);
    assert.ok(trustedBeforeReload.some(value => value.trusted && value.color === '#63b77b'));
    const result = { status: 'completed', version: require('../../package.json').version, realApi: false, realCommands: false,
      allFiveReportedAccentAreas: true, nativeColorAndStyleClicks: true, allFourMaterials: true, threeCustomColors: true,
      filledControlContrast: true, maximumSliderGradientReplaced: true, nativeCaptionUpdates: true,
      nativeCaptionMinimumContrast: true, crossWindowGlobalUpdates: true, reloadAndDiskPersistence: true,
      defaultResetRestoresMaterialColors: true, samples, defaults, screenshots };
    await fs.writeFile(path.join(output, 'accent-palette-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, screenshots };
    if (child && !child.isDestroyed()) { failure.ui = await inspect().catch(() => null); await capture('accent-palette-failure.png').catch(() => {}); }
    await fs.writeFile(path.join(output, 'accent-palette-result.json'), JSON.stringify(failure, null, 2) + '\n'); throw new Error('Accent palette failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (originalAppearance && !win.isDestroyed()) await call('setAppearance', { uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor ?? null }, win).catch(() => {});
    for (const restore of restores) restore();
    for (const target of [child, other]) if (target && !target.isDestroyed()) { target.close(); await until('isolated accent window closes', () => target.isDestroyed()).catch(() => target.destroy()); }
  }
};
