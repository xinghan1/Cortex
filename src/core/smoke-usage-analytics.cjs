// Native usage-card navigation against the real IPC and an isolated ledger.
// Fixture records are local only; no model, network or user project is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeUsageAnalytics({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Usage smoke requires an isolated parent');
  assert.ok(store?.recordUsage && store?.saveSession, 'The smoke must seed the real isolated Store');
  const originalUsageError = store.usageError;
  const project = path.join(dataDir, 'usage-analytics-' + randomUUID());
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let child, stage = 'prepare fixtures';
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Usage analytics smoke timed out: ' + label);
  };
  const dateKey = instant => {
    const shifted = new Date(Date.parse(instant) + 8 * 3_600_000);
    return shifted.toISOString().slice(0, 10);
  };
  const click = async selector => {
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node||!node.checkVisibility())throw new Error('Missing visible target '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  const key = async keyCode => {
    child.webContents.focus();
    child.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter' || keyCode === 'Space') child.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ' });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const opened = () => until('dashboard data loaded', () => js(`!$('usage-dashboard').hidden&&$('usage-activity-grid').querySelectorAll('[data-date]').length===365&&$('usage-summary').querySelector('[data-usage-metric="totalTokens"]')?.dataset.value!==undefined`));
  const closed = () => until('conversation restored', () => js(`$('usage-dashboard').hidden&&$('messages').checkVisibility()`));
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(120 * attempt);
        const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, name), image.toPNG()); return;
      } catch (error) { if (attempt === 4 || !/UnknownVizError/u.test(String(error?.name) + error.message)) throw error; }
    }
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'notes.txt'), 'Usage smoke keeps the editor intact.\n');
    const now = Date.now(), today = dateKey(new Date(now).toISOString());
    const hkNoon = Date.parse(today + 'T12:00:00+08:00');
    // Today's fixture precedes now even when a test runs before noon.
    const stamp = offset => new Date(offset === 0 ? now - 5_000 : hkNoon + offset * 86_400_000).toISOString();
    const session = store.createSession(project);
    session.usageLedgerVersion = 1;
    session.messages = [{ role: 'user', content: '用量视图测试会话' }, ...Array.from({ length: 45 }, (_, index) => ({ role: 'assistant', content: `KEPT_CONVERSATION_${index}\n${'用于确认统计视图关闭后仍保留会话内容。'.repeat(8)}` }))];
    session.taskRuns = [{ runId: 'usage-duration-' + randomUUID(), kind: 'agent', status: 'completed', startedAt: now - 1_605_000, endedAt: now - 5_000, elapsedMs: 1_600_000 }];
    await store.saveSession(session);
    const records = [
      { offset: -400, input: 80_000, output: 3_000 },
      { offset: -364, input: 1_000, output: 200 },
      { offset: -7, input: 100_000_000, output: 0 },
      { offset: -2, input: 2_000, output: 300 },
      { offset: -1, input: 3_000, output: 400 },
      { offset: 0, input: 4_000, output: 500 },
      { offset: 0, input: 6_000, output: 700, partial: true },
      { offset: 0, input: null, output: null, unreported: true },
      { offset: 1, input: 999_999, output: 888_888 },
    ];
    for (const fixture of records) await store.recordUsage({ id: randomUUID(), timestamp: stamp(fixture.offset), provider: 'relay', model: 'isolated-usage-smoke', sessionId: session.id, runId: randomUUID(), reported: !fixture.unreported, inputTokens: fixture.input, outputTokens: fixture.output, partial: fixture.partial === true, status: fixture.partial ? 'stopped' : fixture.unreported ? 'failed' : 'completed' });
    const created = await win.webContents.executeJavaScript('window.forge.newWindow()');
    child = BrowserWindow.fromId(created.id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child renderer', () => js(`Boolean(appState&&!projectSwitching&&$('usage-stats-button')&&window.forge.getUsageAnalytics)`));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.focus(); child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('fixture conversation', () => js(`sessionId===${JSON.stringify(session.id)}&&!projectSwitching&&$('messages').textContent.includes('KEPT_CONVERSATION_44')`));

    stage = 'real ledger analytics';
    const analytics = await call('getUsageAnalytics');
    assert.equal(analytics.timeZone, 'Asia/Hong_Kong'); assert.equal(analytics.error, null);
    assert.equal(analytics.days.length, 365); assert.equal(new Set(analytics.days.map(day => day.date)).size, 365);
    assert.equal(analytics.days.at(-1).date, today);
    const included = store.usage.records.filter(record => Date.parse(record.timestamp) <= Date.parse(analytics.updatedAt));
    const sum = (items, field) => items.reduce((total, record) => total + (record.reported ? record[field] : 0), 0);
    assert.equal(analytics.summary.inputTokens, sum(included, 'inputTokens'));
    assert.equal(analytics.summary.outputTokens, sum(included, 'outputTokens'));
    assert.equal(analytics.summary.totalTokens, sum(included, 'inputTokens') + sum(included, 'outputTokens'));
    assert.equal(analytics.summary.requests, included.length);
    assert.equal(analytics.summary.unreportedRequests, included.filter(record => !record.reported || record.partial).length);
    assert.equal(analytics.summary.partialRequests, included.filter(record => record.partial).length);
    assert.ok(analytics.summary.longestTaskMs >= 1_600_000);
    assert.ok(analytics.summary.currentStreak >= 3);
    for (const day of analytics.days) {
      const matching = included.filter(record => dateKey(record.timestamp) === day.date);
      assert.equal(day.requests, matching.length, 'Calendar request count for ' + day.date);
      assert.equal(day.totalTokens, sum(matching, 'inputTokens') + sum(matching, 'outputTokens'), 'Calendar token count for ' + day.date);
    }
    assert.ok(analytics.summary.totalTokens > analytics.days.reduce((total, day) => total + day.totalTokens, 0), 'All-time totals must include records older than the visible year');

    stage = 'native whole-card navigation and preserved draft';
    const previous = await js(`(() => {window.__usageSmokeMessages=$('messages');window.__usageSmokeFirst=$('messages').firstElementChild;$('task-input').value='UNSENT_USAGE_DRAFT';$('task-input').dispatchEvent(new Event('input',{bubbles:true}));$('message-scroll').scrollTop=180;return {scroll:$('message-scroll').scrollTop,sessionId,messages:$('messages').textContent,editorValue:$('file-content').value,editorPath:selectedPath};})()`);
    await click('#usage-stats-button'); await opened();
    const openedState = await js(`(() => {const host=$('usage-stats-button'),dash=$('usage-dashboard');return {role:host.getAttribute('role'),tabIndex:host.tabIndex,expanded:host.getAttribute('aria-expanded'),visible:dash.checkVisibility(),messagesVisible:$('messages').checkVisibility(),preserved:$('messages')===window.__usageSmokeMessages&&$('messages').firstElementChild===window.__usageSmokeFirst,draft:$('task-input').value,composerVisible:$('task-form').checkVisibility(),unsafe:dash.querySelectorAll('script,iframe').length,metrics:Object.fromEntries([...$('usage-summary').querySelectorAll('[data-usage-metric]')].map(node=>[node.dataset.usageMetric,Number(node.dataset.value)]))};})()`);
    assert.equal(openedState.role, 'button'); assert.equal(openedState.tabIndex, 0); assert.equal(openedState.expanded, 'true');
    assert.equal(openedState.visible, true); assert.equal(openedState.messagesVisible, false); assert.equal(openedState.preserved, true);
    assert.equal(openedState.draft, 'UNSENT_USAGE_DRAFT'); assert.equal(openedState.composerVisible, true); assert.equal(openedState.unsafe, 0);
    const scrollGuard = await js(`(() => {const box=$('message-scroll'),previous=followOutput;followOutput=false;box.scrollTop=0;scrollBottom(true);const stayedAtTop=box.scrollTop===0;box.scrollTop=box.scrollHeight;box.dispatchEvent(new Event('scroll'));const keptFollowingPreference=followOutput===false;box.scrollTop=0;followOutput=previous;return {stayedAtTop,keptFollowingPreference};})()`);
    assert.deepEqual(scrollGuard, { stayedAtTop: true, keptFollowingPreference: true }, 'Conversation output helpers must not move the usage view or change its follow preference');
    for (const field of ['totalTokens', 'peakDailyTokens', 'longestTaskMs', 'longestStreak', 'currentStreak']) assert.equal(openedState.metrics[field], analytics.summary[field], 'Visible summary metric ' + field);
    const visibleDays = await js(`[...$('usage-activity-grid').querySelectorAll('[data-date]')].map(node=>({date:node.dataset.date,tokens:Number(node.dataset.tokens),requests:Number(node.dataset.requests),level:node.dataset.level,ariaLabel:node.getAttribute('aria-label')}))`);
    assert.equal(visibleDays.length, 365);
    assert.deepEqual(visibleDays.map(day => [day.date, day.tokens, day.requests]), analytics.days.map(day => [day.date, day.totalTokens, day.requests]));
    assert.ok(visibleDays.every(day => day.ariaLabel && day.ariaLabel.includes(day.date)));
    assert.ok(new Set(visibleDays.map(day => day.level)).size >= 2, 'Activity intensity should distinguish unused and used days');

    stage = 'native heatmap tooltip and period tabs';
    await js(`document.querySelector('#usage-activity-grid [data-date="${today}"]').focus()`);
    const tooltip = await until('activity focus tooltip', () => js(`!$('usage-activity-tooltip').hidden&&$('usage-activity-tooltip').textContent`));
    assert.ok(tooltip.includes(today)); assert.match(tooltip, /Token/iu);
    assert.equal(tooltip.split('\n').length, 2, 'Activity tooltip shows only date and token amount');
    assert.doesNotMatch(tooltip, /次请求|用量不完整|年\d+月/u);
    assert.match(tooltip, /1\.12 万 Token/u);
    const hoverPoint = await js(`(() => {const r=document.querySelector('#usage-activity-grid [data-date="${today}"]').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    child.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint });
    await until('native activity hover tooltip', () => js(`!$('usage-activity-tooltip').hidden&&$('usage-activity-tooltip').textContent.includes('${today}')`));
    await key('Left');
    const previousWeek = new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);
    await until('native activity arrow navigation tooltip', () => js(`document.activeElement?.dataset.date==='${previousWeek}'&&!$('usage-activity-tooltip').hidden&&$('usage-activity-tooltip').textContent.includes('${previousWeek}')`));
    assert.match(await js(`$('usage-activity-tooltip').textContent`), /1 亿 Token/u);
    for (const [period, count] of [['week', 53], ['cumulative', 365], ['day', 365]]) {
      await click(`[data-usage-period="${period}"]`);
      await until('period ' + period, () => js(`document.querySelector('[data-usage-period="${period}"]').getAttribute('aria-pressed')==='true'&&$('usage-activity-grid').querySelectorAll('[data-date]').length===${count}`));
      const selected = await js(`document.querySelectorAll('[data-usage-period][aria-pressed="true"]').length`);
      assert.equal(selected, 1);
      const values = await js(`[...$('usage-activity-grid').querySelectorAll('[data-date]')].map(node=>({date:node.dataset.date,tokens:Number(node.dataset.tokens),requests:Number(node.dataset.requests)}))`);
      if (period === 'week') {
        assert.equal(values.reduce((total, day) => total + day.tokens, 0), analytics.days.reduce((total, day) => total + day.totalTokens, 0));
        assert.equal(values.reduce((total, day) => total + day.requests, 0), analytics.days.reduce((total, day) => total + day.requests, 0));
      } else if (period === 'cumulative') {
        assert.deepEqual(values.map(day => [day.date, day.tokens]), analytics.days.map(day => [day.date, day.cumulativeTokens]));
        assert.equal(values.at(-1).tokens, analytics.summary.totalTokens);
      }
    }
    await capture('token-usage-analytics.png');
    await click('#usage-dashboard-close'); await closed();
    const restored = await js(`({scroll:$('message-scroll').scrollTop,sessionId,messages:$('messages').textContent,draft:$('task-input').value,preserved:$('messages')===window.__usageSmokeMessages&&$('messages').firstElementChild===window.__usageSmokeFirst,editorValue:$('file-content').value,editorPath:selectedPath,expanded:$('usage-stats-button').getAttribute('aria-expanded')})`);
    assert.equal(restored.scroll, previous.scroll); assert.equal(restored.sessionId, previous.sessionId); assert.equal(restored.messages, previous.messages);
    assert.equal(restored.draft, 'UNSENT_USAGE_DRAFT'); assert.equal(restored.preserved, true); assert.equal(restored.expanded, 'false');
    assert.equal(restored.editorValue, previous.editorValue); assert.equal(restored.editorPath, previous.editorPath);

    stage = 'native Enter and Space activation';
    for (const code of ['Enter', 'Space']) {
      await js(`$('usage-stats-button').focus()`); await key(code); await opened();
      await click('#usage-dashboard-close'); await closed();
    }

    stage = 'unavailable ledger and recovery';
    store.usageError = 'SMOKE_USAGE_UNAVAILABLE';
    const unavailable = await call('getUsageAnalytics');
    assert.equal(unavailable.error, 'SMOKE_USAGE_UNAVAILABLE'); assert.equal(unavailable.summary.totalTokens, null); assert.deepEqual(unavailable.days, []);
    await click('#usage-stats-button');
    await until('unavailable state visible', () => js(`!$('usage-dashboard').hidden&&$('usage-dashboard-status').textContent.includes('SMOKE_USAGE_UNAVAILABLE')`));
    const unknown = await js(`({value:$('usage-summary').querySelector('[data-usage-metric="totalTokens"]')?.textContent,cells:$('usage-activity-grid').querySelectorAll('[data-date]').length})`);
    assert.match(unknown.value || '', /[—−-]/u, 'Unreadable usage must not be presented as zero'); assert.equal(unknown.cells, 0);
    await click('#usage-dashboard-close'); await closed();
    store.usageError = originalUsageError;
    await click('#usage-stats-button'); await opened();
    assert.equal(await js(`$('usage-dashboard-status').textContent.includes('SMOKE_USAGE_UNAVAILABLE')`), false);
    await click('#usage-dashboard-close'); await closed();
    return { realLedgerIPC: true, futureRecordsExcluded: true, allTimeVs365Days: true, unknownAndPartialRequests: true, longestTask: true, nativeWholeCardClick: true, nativeEnterAndSpace: true, periodTabs: ['day', 'week', 'cumulative'], heatmapDays: 365, focusTooltip: true, nativeHoverAndArrowNavigation: true, unavailableLedgerAndRecovery: true, conversationNodesPreserved: true, draftPreserved: true, scrollRestored: true, screenshot: 'token-usage-analytics.png' };
  } catch (error) {
    const state = child && !child.isDestroyed() ? await js(`({sessionId,documentFocused:document.hasFocus(),dashboardHidden:$('usage-dashboard')?.hidden,status:$('usage-dashboard-status')?.textContent,cells:$('usage-activity-grid')?.querySelectorAll('[data-date]').length,summary:$('usage-summary')?.textContent,active:{id:document.activeElement?.id,tag:document.activeElement?.tagName,date:document.activeElement?.dataset.date},tooltip:{hidden:$('usage-activity-tooltip')?.hidden,text:$('usage-activity-tooltip')?.textContent},scroll:$('message-scroll')?.scrollTop,notice:$('notice-text')?.textContent})`).catch(() => null) : null;
    console.error('USAGE_ANALYTICS_SMOKE_FAILURE', stage, error?.stack || String(error), JSON.stringify(state)); throw error;
  } finally {
    store.usageError = originalUsageError;
    if (child && !child.isDestroyed()) child.destroy();
  }
};
