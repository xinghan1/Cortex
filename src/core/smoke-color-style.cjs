// Native color-style regression against the actual isolated usage ledger and
// appearance IPC. No external API, command, user project or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeColorStyle({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.ok(store?.recordUsage && store?.saveSession);
  const project = path.join(dataDir, 'color-style-' + randomUUID()), orange = '#e69a5c';
  const styles = ['glass', 'black', 'white', 'industrial'], samples = {}, defaults = {}, screenshots = [];
  let child, originalAppearance, stage = 'prepare isolated ledger';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const until = async (label, check) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Color style timed out: ' + label);
  };
  const settle = async () => {
    await js('window.synoraAppearance.settled()');
    await until('transitions settled', () => js(`!document.getAnimations().some(animation=>animation.playState==='running')`));
  };
  const click = async selector => {
    const point = await until('native target ' + selector, () => js(`(() => {
      const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return r.width&&r.height&&n.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await wait(45);
  };
  const configure = async (style, color) => {
    if (await js(`!$('usage-dashboard').hidden`)) await click('#usage-dashboard-close');
    await js('window.synoraAppearance.open()'); await until('appearance opens', () => js(`$('appearance-dialog').open`));
    assert.equal(await js(`$('selection-color-title').textContent`), '颜色风格');
    await click(`#ui-style-options [data-ui-style="${style}"]`); await settle();
    await click(color ? `#selection-color-options [data-selection-color="${color}"]` : '#selection-color-reset'); await settle();
    await click('#appearance-close'); await settle();
    const saved = await call('getAppearance'); assert.equal(saved.uiStyle, style); assert.equal(saved.selectionColor, color);
  };
  const open = async () => {
    await click('#usage-stats-button');
    await until('real daily heatmap', () => js(`!$('usage-dashboard').hidden&&$('usage-activity-grid').querySelectorAll('[data-date]').length===365&&[1,2,3,4,5].every(level=>$('usage-activity-grid').querySelector('[data-level="'+level+'"]'))`));
    await click('.usage-period[data-usage-period="day"]'); await settle();
    await click('#usage-activity-grid .usage-activity-cell[data-level="5"]');
    await until('real focused tooltip', () => js(`!$('usage-activity-tooltip').hidden`)); await settle();
  };
  const inspect = () => js(`(() => {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
    const style=(selector,pseudo)=>{const n=document.querySelector(selector),s=getComputedStyle(n,pseudo);return {color:rgba(s.color),fill:rgba(s.webkitTextFillColor),background:rgba(s.backgroundColor),border:rgba(s.borderTopColor),shadow:s.boxShadow};};
    const root=getComputedStyle(document.documentElement);
    return {style:document.documentElement.dataset.uiStyle,palette:document.documentElement.dataset.selectionColor,
      accent:rgba(root.getPropertyValue('--custom-selection-color').trim()),
      shades:[1,2,3,4,5].map(level=>style('#usage-activity-grid .usage-activity-cell[data-level="'+level+'"]')),
      expectedShades:[1,2,3,4,5].map(level=>rgba(root.getPropertyValue('--custom-usage-level-'+level).trim())),
      selected:style('.usage-period[aria-pressed="true"]'),tooltip:style('#usage-activity-tooltip'),
      composer:style('.composer'),composerText:style('.composer textarea'),composerPlaceholder:style('.composer textarea','::placeholder'),
      tooltipVisible:!$('usage-activity-tooltip').hidden,title:$('selection-color-title').textContent,
      requests:document.querySelectorAll('#usage-activity-grid [data-requests="1"]').length,
      unexpected:window.__colorStyleUnexpected||[],trusted:window.__colorStyleTrusted||[]};})()`);
  const luminance = rgba => rgba.slice(0, 3).map(channel => channel / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1] + .05) / (values[0] + .05); };
  const assertCustom = value => {
    assert.equal(value.palette, 'custom'); assert.equal(value.title, '颜色风格'); assert.equal(value.tooltipVisible, true);
    assert.deepEqual(value.selected.background, [230, 154, 92, 255], value.style + ' daily button must use the exact saved accent');
    assert.ok(contrast(value.selected.color, value.selected.background) >= 4.5, 'Daily button text must remain readable');
    value.shades.forEach((shade, index) => assert.deepEqual(shade.background, value.expectedShades[index], value.style + ' actual heatmap follows color style'));
    for (let index = 1; index < value.shades.length; index++) assert.ok(luminance(value.shades[index].background) > luminance(value.shades[index - 1].background));
    assert.notDeepEqual(value.tooltip.background, defaults[value.style].tooltip.background, 'Tooltip surface must follow custom accent');
    assert.notDeepEqual(value.tooltip.border, defaults[value.style].tooltip.border, 'Tooltip edge must follow custom accent');
    assert.ok(contrast(value.tooltip.color, value.tooltip.background) >= 4.5, value.style + ' tooltip text contrast');
    if (value.style !== 'glass') {
      for (const foreground of [value.composerText.color, value.composerText.fill, value.composerPlaceholder.color])
        assert.ok(contrast(foreground, value.composer.background) >= 4.5, value.style + ' real composer text and placeholder must remain readable');
    }
    assert.deepEqual(value.unexpected, []);
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) try {
      child.webContents.invalidate(); await wait(110 * attempt); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
      await fs.writeFile(path.join(output, name), image.toPNG()); screenshots.push(name); return;
    } catch (error) { if (attempt === 4 || !/UnknownVizError/u.test(String(error))) throw error; }
  };
  const initialize = async () => {
    await until('renderer ready', () => js('Boolean(appState&&window.synoraAppearance&&window.ForgeUsageDashboard&&!projectSwitching)'));
    await js(`window.synoraAppearance.ready`);
    await js(`window.__colorStyleUnexpected=[];window.__colorStyleTrusted=[];
      window.forge.onEvent(e=>{if(['run-start','usage','approval-request'].includes(e.type))window.__colorStyleUnexpected.push(e.type);});
      document.querySelectorAll('#selection-color-options [data-selection-color],#selection-color-reset,.usage-period').forEach(n=>n.addEventListener('click',e=>window.__colorStyleTrusted.push({id:n.id,color:n.dataset.selectionColor,trusted:e.isTrusted})));true;`);
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(project, 'fixture.txt'), 'Color style fixture\n');
    const session = store.createSession(project); session.usageLedgerVersion = 1; session.messages = [{ role: 'user', content: '颜色风格原生验证' }, { role: 'assistant', content: '查看本机用量统计。' }];
    await store.saveSession(session);
    const now = Date.now();
    for (const [index, inputTokens] of [1, 100, 10000, 1000000, 100000000].entries()) await store.recordUsage({ id: randomUUID(),
      timestamp: new Date(now - (4 - index) * 86400000 - 5000).toISOString(), provider: 'relay', model: 'isolated-color-style', sessionId: session.id,
      runId: randomUUID(), inputTokens, outputTokens: 0, reported: true, status: 'completed' });
    originalAppearance = await win.webContents.executeJavaScript('window.forge.getAppearance()');
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child.webContents.isOffscreen()); child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive();
    await initialize(); await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('fixture project', () => js(`sessionId===${JSON.stringify(session.id)}&&!projectSwitching`));
    for (const style of styles) {
      stage = style + ' default baseline'; await configure(style, null); await open(); defaults[style] = await inspect();
      stage = style + ' saved orange color style'; await configure(style, orange); await open(); const value = await inspect(); assertCustom(value); samples[style] = value;
      if (style === 'white' || style === 'industrial') await capture('color-style-' + style + '-orange.png');
      stage = style + ' restore default'; await configure(style, null); await open(); const reset = await inspect();
      assert.deepEqual(reset.shades, defaults[style].shades, 'Reset restores original ' + style + ' heatmap');
      assert.deepEqual(reset.selected, defaults[style].selected, 'Reset restores original selected daily button');
      assert.deepEqual(reset.tooltip, defaults[style].tooltip, 'Reset restores original ' + style + ' tooltip');
    }
    stage = 'saved orange survives renderer reload'; await configure('white', orange); await open();
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'appearance.json'), 'utf8')).selectionColor, orange);
    const trusted = (await inspect()).trusted; assert.ok(trusted.some(value => value.trusted && value.color === orange));
    child.webContents.reload(); await wait(60); await initialize(); await open(); const reloaded = await inspect(); assertCustom(reloaded);
    const result = { status: 'completed', version: require('../../package.json').version, realApi: false, realCommands: false,
      isolatedLedgerRecords: 5, nativeOrangePaletteClick: true, allFourMaterials: true, actualFiveHeatmapShades: true,
      levelsBrightenWithUsage: true, dailyButtonFollowsAccent: true, tooltipFollowsAccent: true,
      tooltipAndButtonContrast: true, saveAndReload: true, defaultReset: true, samples, defaults, reloaded, screenshots };
    await fs.writeFile(path.join(output, 'color-style-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, screenshots };
    if (child && !child.isDestroyed()) { failure.ui = await inspect().catch(() => null); await capture('color-style-failure.png').catch(() => {}); }
    await fs.writeFile(path.join(output, 'color-style-result.json'), JSON.stringify(failure, null, 2) + '\n'); throw new Error('Color style failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (originalAppearance && !win.isDestroyed()) await win.webContents.executeJavaScript(`window.forge.setAppearance(${JSON.stringify({ uiStyle: originalAppearance.uiStyle, selectionColor: originalAppearance.selectionColor ?? null })})`).catch(() => {});
    if (child && !child.isDestroyed()) { child.close(); await until('isolated window closes', () => child.isDestroyed()).catch(() => child.destroy()); }
  }
};
