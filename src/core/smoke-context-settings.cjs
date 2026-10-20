// Native preference controls and real local persistence in disposable windows.
// Footer metrics below are public display fixtures; no model or command runs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');
const { UIPreferences } = require('./ui-preferences.cjs');

module.exports = async function smokeContextSettings({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const project = path.join(dataDir, 'context-settings-' + randomUUID());
  const preferenceFile = path.join(dataDir, 'preferences.json');
  let child, other, stage = 'create isolated context preference fixture', originalTrigger;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const call = (method, value, target = child) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`, target);
  const state = (target = child) => call('getState', undefined, target);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Context-settings smoke timed out: ' + label);
  };
  const inspect = (target = child) => js(`(() => {
    const trigger=$('session-context-trigger'),popup=$('context-settings-popup'),input=$('context-trigger-input'),ring=$('session-context');
    const r=popup?.getBoundingClientRect();
    return {trigger:!!trigger,buttonTag:trigger?.tagName,expanded:trigger?.getAttribute('aria-expanded'),
      popupHidden:popup?.hidden,input:input?.value,min:input?.min,max:input?.max,step:input?.step,
      error:$('context-trigger-error')?.textContent,errorHidden:$('context-trigger-error')?.hidden,
      effectiveHintPresent:!!$('context-effective-hint'),presetElements:popup?.querySelectorAll('.context-trigger-presets,[data-context-trigger]').length||0,
      saveDisabled:$('context-trigger-save')?.disabled,
      ringInsideTrigger:!!trigger?.contains(ring),rings:document.querySelectorAll('#session-context').length,
      role:ring?.getAttribute('role'),percent:$('session-context-value')?.textContent,
      ariaNow:ring?.getAttribute('aria-valuenow'),ariaText:ring?.getAttribute('aria-valuetext'),
      dash:$('session-context-progress')?.getAttribute('stroke-dasharray'),title:ring?.title,
      rounds:$('session-rounds')?.textContent,total:$('session-total-value')?.textContent,
      cache:$('session-cache-value')?.textContent,speed:$('generation-speed')?.textContent,
      geometry:r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      nativeInputs:window.__contextSettingsInputs||[]};
  })()`, target);
  const click = async selector => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing native context control '+${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest',behavior:'instant'});if(!node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true}))throw new Error('Hidden native context control '+${JSON.stringify(selector)});
      const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered native context control '+${JSON.stringify(selector)});return p;})()`);
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(50);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') child.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(35);
  };
  const open = async () => {
    if ((await inspect()).popupHidden) await click('#session-context-trigger');
    await until('context popup opens', async () => !(await inspect()).popupHidden);
    await until('context popup enter transition settles', () => js(`Number(getComputedStyle($('context-settings-popup')).opacity)>=.99`));
  };
  const enter = async value => {
    await open(); await click('#context-trigger-input'); await key('a', ['control']);
    await child.webContents.insertText(String(value));
    await until('native input ' + value, async () => (await inspect()).input === String(value));
  };
  const set = async value => {
    await enter(value); await click('#context-trigger-save');
    await until('threshold saved ' + value, async () => (await state()).contextCompressionTriggerTokens === value);
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { child.webContents.invalidate(); await wait(attempt * 200); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(output, filename), image.toPNG()); return; }
      catch (error) { if (attempt === 4 || !/UnknownVizError/.test(String(error))) throw error; }
    }
  };
  const assertPlacement = value => {
    assert.ok(value.geometry && value.geometry.width > 0 && value.geometry.height > 0);
    assert.ok(value.geometry.left >= 0 && value.geometry.right <= value.viewport.width + 1, 'Context popover must fit horizontally');
    assert.ok(value.geometry.top >= 0 && value.geometry.bottom <= value.viewport.height + 1, 'Context popover must fit vertically');
    assert.equal(value.horizontalOverflow, false);
  };
  const displayMetrics = {
    rounds: 11, inputTokens: 123450, outputTokens: 67, totalTokens: 123517, usageStatus: 'reported',
    cacheStatus: 'reported', cacheHitPercent: 80, cachedInputTokens: 98760,
    contextStatus: 'reported', contextPercent: 37.5, contextUsedTokens: 12000, contextLimit: 32000,
    contextDescription: 'DISPLAY_FIXTURE_ONLY：本次请求 12000 / 32000 Token。',
  };
  const assertFooter = value => {
    assert.equal(value.ringInsideTrigger, true); assert.equal(value.rings, 1); assert.equal(value.role, 'progressbar');
    assert.equal(value.percent, '37.5%'); assert.equal(value.ariaNow, '37.5'); assert.equal(value.dash, '37.5 100');
    assert.match(value.ariaText, /12,000/); assert.match(value.title, /32,000/);
    assert.equal(value.rounds, '第 11 轮对话'); assert.equal(value.total, '123,517'); assert.equal(value.cache, '80%');
  };
  const injectDisplayMetrics = () => js(`renderSessionMetrics(${JSON.stringify(displayMetrics)});true`);
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), 'Disposable context-settings UI fixture.\n');
    child = BrowserWindow.fromId((await call('newWindow', undefined, win)).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('context controls initialized', () => js(`Boolean(appState&&window.forge.setContextCompression&&$('session-context-trigger')&&!projectSwitching)`));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('context fixture project active', async () => (await state()).workspace?.root === project && await js('!projectSwitching'));
    originalTrigger = (await state()).contextCompressionTriggerTokens;
    assert.equal(originalTrigger, 850000, 'Fresh context preferences should default to 850000 Token');
    const originalScale = (await state()).textScale;
    other = BrowserWindow.fromId((await call('newWindow')).id); assert.ok(other && other !== child && other.webContents.isOffscreen());
    await until('second window initialized', () => js(`Boolean(appState&&$('session-context-trigger'))`, other));
    await js(`window.__contextSettingsInputs=[];$('context-trigger-input').addEventListener('input',event=>window.__contextSettingsInputs.push({trusted:event.isTrusted,value:event.target.value}));true`);

    stage = 'native footer popover and default threshold';
    let value = await inspect(); assert.equal(value.buttonTag, 'BUTTON'); assert.equal(value.popupHidden, true);
    await injectDisplayMetrics(); assertFooter(await inspect());
    await open(); value = await inspect(); assertPlacement(value); assertFooter(value);
    assert.equal(value.expanded, 'true'); assert.equal(value.input, '850000'); assert.equal(value.min, '1000'); assert.equal(value.max, '16000000');
    assert.equal(value.effectiveHintPresent, false, 'The removed budget explanation must not remain in the popover');
    assert.equal(value.presetElements, 0, 'The removed quick-value buttons and container must not remain in the popover');

    stage = 'native threshold save reaches global state and atomic storage';
    await set(400000);
    await until('second window receives global preference', async () => (await state(other)).contextCompressionTriggerTokens === 400000 && await js('appState?.contextCompressionTriggerTokens===400000', other));
    const stored = JSON.parse(await fs.readFile(preferenceFile, 'utf8'));
    assert.equal(stored.contextCompressionTriggerTokens, 400000); assert.equal(stored.textScale, originalScale);
    const fresh = await new UIPreferences(dataDir).init(); assert.equal(fresh.contextCompressionTriggerTokens, 400000);
    assert.equal(fresh.textScale, originalScale, 'Context settings must preserve the existing text-scale preference');
    assert.ok((await inspect()).nativeInputs.some(event => event.trusted && event.value === '400000'));
    await open(); await injectDisplayMetrics(); assertFooter(await inspect()); await capture('context-settings-custom-threshold.png');

    stage = 'invalid native input leaves stored preferences unchanged';
    const beforeInvalid = await fs.readFile(preferenceFile, 'utf8');
    await enter(100); await click('#context-trigger-save');
    await until('Chinese range validation', async () => { const current = await inspect(); return !current.popupHidden && !current.errorHidden && /[\u4e00-\u9fff]/u.test(current.error || '') && /1[,.，]?000|1000/.test(current.error || ''); });
    assert.equal((await state()).contextCompressionTriggerTokens, 400000); assert.equal((await state(other)).contextCompressionTriggerTokens, 400000);
    assert.equal(await fs.readFile(preferenceFile, 'utf8'), beforeInvalid);
    await injectDisplayMetrics(); assertFooter(await inspect()); await capture('context-settings-invalid-value.png');

    stage = 'reload restores the saved value rather than the unsaved invalid draft';
    child.webContents.reload(); await wait(50);
    await until('reloaded context controls', () => js(`Boolean(appState&&$('session-context-trigger')&&window.forge.setContextCompression&&!projectSwitching)`));
    await open(); value = await inspect(); assert.equal(value.input, '400000'); assertPlacement(value);
    assert.equal((await state()).contextCompressionTriggerTokens, 400000);
    await injectDisplayMetrics(); assertFooter(await inspect());

    stage = 'native reset restores 850000 and synchronizes all windows';
    await click('#context-trigger-reset');
    await until('default threshold reset', async () => (await state()).contextCompressionTriggerTokens === 850000 && (await state(other)).contextCompressionTriggerTokens === 850000);
    assert.equal((await new UIPreferences(dataDir).init()).contextCompressionTriggerTokens, 850000);
    await open(); value = await inspect(); assert.equal(value.input, '850000');
    await injectDisplayMetrics(); assertFooter(await inspect());
    assert.equal(value.effectiveHintPresent, false); assert.equal(value.presetElements, 0);
    await capture('context-settings-default-restored.png');

    stage = 'keyboard dismiss and compact viewport layout';
    await key('Escape'); await until('Escape closes context popup', async () => (await inspect()).popupHidden);
    child.setContentSize(1100, 760); await wait(100); await open(); assertPlacement(await inspect());
    await click('#task-input'); await until('outside click closes context popup', async () => (await inspect()).popupHidden);
    const result = { status: 'completed', realApi: false, realCommands: false, isolatedPreferencesOnly: true,
      nativeFooterDropdown: true, nativeNumericInputAndSave: true, defaultThreshold: 850000, customThreshold: 400000,
      invalidValueShowsChineseErrorWithoutSaving: true,
      persistentFreshStoreRoundTrip: true, rendererReloadRestoresSavedValue: true, crossWindowGlobalSync: true,
      nativeResetToDefault: true, existingTextScalePreserved: true, contextRingAndFooterMetricsPreserved: true,
      nativeEscapeAndOutsideDismiss: true, compactPopoverFitsViewport: true,
      quickValueButtonsAndBudgetExplanationRemoved: true,
      screenshots: ['context-settings-custom-threshold.png', 'context-settings-invalid-value.png', 'context-settings-default-restored.png'] };
    await fs.writeFile(path.join(output, 'context-settings-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack };
    if (child && !child.isDestroyed()) { try { failure.ui = await inspect(); failure.state = await state(); await capture('context-settings-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; } }
    await fs.writeFile(path.join(output, 'context-settings-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Context-settings smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (originalTrigger !== undefined && !win.isDestroyed()) await call('setContextCompression', { triggerTokens: originalTrigger }, win).catch(() => {});
    for (const target of [child, other]) if (target && !target.isDestroyed()) { target.close(); await until('isolated context window closes', () => target.isDestroyed()).catch(() => target.destroy()); }
  }
};
