// Exercises the shipped renderer with synthetic state, without a model request.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { aggregateSessionUsage, createSessionMetrics, makePendingContextUsage } = require('./session-metrics.cjs');

module.exports = async function smokeSessionMetrics({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Session metrics smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const metrics = {
    rounds: 3, steps: 7, totalTokens: 128900, inputTokens: 120000, outputTokens: 8900,
    cachedInputTokens: 99000, cacheHitPercent: 82.5, cacheStatus: 'partial', usageStatus: 'partial',
    contextUsedTokens: 32000, contextInputTokens: 28000, contextOutputTokens: 4000,
    contextLimit: 128000, contextPercent: 25, contextLimitKind: 'total',
    contextStatus: 'reported', contextPhase: 'complete',
    contextDisplay: { source: 'current', pending: false, inputTokens: 28000, outputTokens: 4000, usedTokens: 32000,
      limit: 128000, percent: 25, limitKind: 'total', model: 'metrics-fixture', measuredAt: '2026-10-21T01:00:00Z' },
    contextDescription: '最近完成请求实际回报：输入 28,000 + 输出 4,000 = 32,000 Token；缓存输入已包含在输入中。',
  };
  let installed = false;
  try {
    const reported = await js(`(() => {
      window.__sessionMetricsSmoke = { state: appState, sessionId, tokenText: $('token-usage').textContent,
        rate: sessionTokenRate, telemetry: latestTelemetry, activity: activeTaskActivity, running,
        runStatus: $('run-status').textContent };
      updateState({ ...appState, workspaceId: appState?.workspaceId || 'synthetic-metrics-workspace', sessionMetrics: ${JSON.stringify(metrics)} });
      return {
        rounds: $('session-rounds').textContent,
        cache: $('session-cache-value').textContent,
        cacheTitle: $('session-cache').title,
        total: $('session-total-value').textContent,
        totalPartial: $('session-total').classList.contains('partial'),
        totalTitle: $('session-total').title,
        context: $('session-context-value').textContent,
        contextTitle: $('session-context').title,
        progress: $('session-context-progress').getAttribute('stroke-dasharray'),
        ariaValue: $('session-context').getAttribute('aria-valuenow'),
        tokenText: $('token-usage').textContent,
        providerVisible: !$('provider-hint').hidden && !!$('provider-hint').textContent,
      };
    })()`);
    installed = true;
    assert.equal(reported.rounds, '第 3 轮对话');
    assert.equal(reported.cache, '82.5%*');
    assert.match(reported.cacheTitle, /部分请求未提供缓存用量/);
    assert.equal(reported.total, '128,900');
    assert.equal(reported.totalPartial, true);
    assert.match(reported.totalTitle, /仅累计已知用量/);
    assert.equal(reported.context, '25%');
    assert.match(reported.contextTitle, /输入\s*28,000.*输出\s*4,000/u);
    assert.doesNotMatch(reported.contextTitle, /字符估算|不含输出|≈/u);
    assert.equal(reported.progress, '25 100');
    assert.equal(reported.ariaValue, '25');
    assert.equal(reported.providerVisible, true);
    assert.equal(reported.tokenText, await js('window.__sessionMetricsSmoke.tokenText'));

    const unmeasured = await js(`(() => {
      const values = {};
      for (const status of ['pending', 'partial', 'unknown', 'estimated']) {
        const partial = status === 'partial';
        updateState({ ...appState, sessionMetrics: { ...${JSON.stringify(metrics)},
          contextStatus: status, contextPhase: status === 'pending' ? 'requesting' : 'changed',
          contextInputTokens: partial ? 28000 : null, contextOutputTokens: null, contextPercent: null, contextUsedTokens: null,
          contextLastReported: null, contextDisplay: { source: 'none', pending: true, percent: null, usedTokens: null },
          contextDescription: '当前请求尚未完整回报，等待服务端实测。'
        } });
        values[status] = { text:$('session-context-value').textContent,title:$('session-context').title,
          aria:$('session-context').getAttribute('aria-valuenow'),
          progress:$('session-context-progress').getAttribute('stroke-dasharray'),
          unknown:$('session-context').classList.contains('unknown') };
      }
      updateState({ ...appState, sessionMetrics: ${JSON.stringify(metrics)} });
      return values;
    })()`);
    for (const [status, value] of Object.entries(unmeasured)) {
      assert.equal(value.text, '—', status + ' must distinguish unknown usage from a measured zero');
      assert.equal(value.aria, null); assert.equal(value.progress, '0 100'); assert.equal(value.unknown, true);
      assert.match(value.title, /尚未完整回报/u); assert.doesNotMatch(value.title, /最近完整请求实测/u);
      assert.doesNotMatch(value.title, /当前请求[：:]\s*32,000/u, 'A previous measurement must not be called the current request');
    }

    // Exercise the actual core projection and the shipped renderer in account
    // mode. All counts and profile identities are synthetic; no SDK/auth calls.
    const officialBinding = { provider: 'openai', model: 'official-display-fixture', connectionKey: 'synthetic-chatgpt-profile-a' };
    const officialReport = { ...officialBinding, version: 2, status: 'reported', phase: 'complete',
      inputTokens: 35662, outputTokens: 208, limit: 128000, limitKind: 'total', measuredAt: '2026-10-21T01:00:00Z' };
    const officialPending = makePendingContextUsage(officialReport);
    const projected = (contextUsage, expectedContext = officialBinding) => createSessionMetrics({ contextUsage }, aggregateSessionUsage([]), { expectedContext });
    const officialFixtures = {
      pending: projected(officialPending),
      partial: projected({ ...officialPending, status: 'partial', phase: 'requesting', inputTokens: 36000, outputTokens: 2 }),
      stopped: projected({ ...officialPending, status: 'unknown', phase: 'stopped' }),
      otherModel: projected(officialPending, { ...officialBinding, model: 'different-official-model' }),
      otherConnection: projected(officialPending, { ...officialBinding, connectionKey: 'synthetic-chatgpt-profile-b' }),
      complete: projected({ ...officialReport, inputTokens: 36000, outputTokens: 300, measuredAt: '2026-10-21T01:01:00Z' }),
    };
    const official = await js(`(() => {
      const saved = window.__sessionMetricsSmoke, settings = appState.settings;
      const accountSettings = { ...settings, provider:'openai', authMode:'chatgpt', model:${JSON.stringify(officialBinding.model)},
        providers:{ ...settings.providers, openai:{ ...settings.providers.openai, authMode:'chatgpt', model:${JSON.stringify(officialBinding.model)} } } };
      const result = {};
      for (const [name, fixture] of Object.entries(${JSON.stringify(officialFixtures)})) {
        updateState({ ...appState, settings: accountSettings, sessionMetrics:fixture });
        result[name] = { text:$('session-context-value').textContent,title:$('session-context').title,
          aria:$('session-context').getAttribute('aria-valuenow'),progress:$('session-context-progress').getAttribute('stroke-dasharray'),
          pending:$('session-context').classList.contains('pending'),unknown:$('session-context').classList.contains('unknown'),
          accountMode:$('provider-hint').textContent.startsWith('ChatGPT 账号') };
      }
      updateState({ ...appState, settings:accountSettings, sessionMetrics:${JSON.stringify(officialFixtures.pending)} });
      return result;
    })()`);
    for (const name of ['pending', 'partial', 'stopped']) {
      const value = official[name];
      assert.equal(value.accountMode, true); assert.equal(value.text, '28%'); assert.equal(value.aria, '28');
      assert.equal(value.progress, '28 100'); assert.equal(value.pending, true); assert.equal(value.unknown, false);
      assert.match(value.title, /最近完整请求实测：35,870/u); assert.match(value.title, /输入 35,662 \/ 输出 208/u);
      assert.match(value.title, /当前新增内容待回报/u); assert.doesNotMatch(value.title, /暂无完整实测数据/u);
    }
    for (const name of ['otherModel', 'otherConnection']) {
      assert.equal(official[name].text, '—'); assert.equal(official[name].aria, null);
      assert.equal(official[name].unknown, true); assert.equal(official[name].pending, false);
      assert.doesNotMatch(official[name].title, /35,662|35,870/u, 'Another model/account cannot inherit this report');
    }
    assert.equal(official.complete.text, '28.4%'); assert.equal(official.complete.pending, false);
    assert.match(official.complete.title, /输入 36,000 \/ 输出 300/u);
    win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 110));
    await fs.writeFile(path.join(output, 'session-metrics-chatgpt-pending.png'), (await win.webContents.capturePage()).toPNG());
    await js(`updateState({ ...window.__sessionMetricsSmoke.state, sessionMetrics:${JSON.stringify(metrics)} }, { syncActiveTask:false,allowWorkspaceChange:true });true`);

    const rates = await js(`(() => {
      const read = () => ({ text: $('generation-speed').textContent, unknown: $('session-speed').classList.contains('unknown'), title: $('session-speed').title });
      running = true;
      activeTaskActivity = createTaskActivity({ runId: 'footer-rate-smoke' });
      updateTelemetry({ runId: 'footer-rate-smoke', phase: 'waiting', tokensPerSecond: null });
      const waiting = read();
      updateTelemetry({ runId: 'footer-rate-smoke', phase: 'thinking', tokensPerSecond: 251.3, estimated: true, estimatedOutputTokens: 251, elapsedMs: 1000 });
      const estimated = read();
      handleEvent({ type: 'telemetry', workspaceId: 'different-rate-workspace', runId: 'footer-rate-smoke', phase: 'generating', tokensPerSecond: 999 });
      const foreign = read();
      const blocked = {};
      for (const phase of ['tool', 'approval', 'waiting']) {
        updateTelemetry({ runId: 'footer-rate-smoke', phase, tokensPerSecond: 251.3 });
        blocked[phase] = read();
      }
      for (const invalid of [0, -1, NaN, Infinity, null]) {
        updateTelemetry({ runId: 'footer-rate-smoke', phase: 'generating', tokensPerSecond: invalid });
        if (!read().unknown) throw new Error('Invalid output rate displayed');
      }
      updateTelemetry({ runId: 'footer-rate-smoke', phase: 'generating', tokensPerSecond: 97.6, estimated: false, outputTokens: 976, elapsedMs: 10000 });
      finishTaskActivity({ runId: 'footer-rate-smoke', status: 'completed', elapsedMs: 12000,
        telemetry: { tokensPerSecond: 88.2, estimated: false, outputTokens: 1058 } });
      const completed = read();
      const oldLocationHidden = activeTaskActivity.speed.hidden && activeTaskActivity.separator.hidden;
      running = false; activeTaskActivity = null;
      renderHistoricalTaskActivity({ runId: 'footer-history-smoke', status: 'completed', elapsedMs: 2000,
        telemetry: { tokensPerSecond: 48.1, estimated: false, outputTokens: 96 } });
      const historical = read();
      document.querySelector('.task-activity[data-run-id="footer-history-smoke"]').remove();
      renderHistoricalTaskActivity({ runId: 'footer-unreported-smoke', status: 'stopped', elapsedMs: 1000 });
      const unreported = read();
      document.querySelector('.task-activity[data-run-id="footer-unreported-smoke"]').remove();
      setSessionTokenRate({ tokensPerSecond: 41.2, outputTokens: 412 });
      updateState({ ...appState, sessionId: 'footer-isolation-session' }, { syncActiveTask: false });
      const otherSession = read();
      setSessionTokenRate({ tokensPerSecond: 52.3, outputTokens: 523 });
      updateState({ ...appState, workspaceId: 'footer-isolation-workspace' }, { syncActiveTask: false, allowWorkspaceChange: true });
      const otherWorkspace = read();
      updateState({ ...window.__sessionMetricsSmoke.state, sessionMetrics: ${JSON.stringify(metrics)} }, { syncActiveTask: false, allowWorkspaceChange: true });
      setSessionTokenRate({ tokensPerSecond: 251.3, estimated: true, estimatedOutputTokens: 251, elapsedMs: 1000 });
      return { waiting, estimated, foreign, blocked, completed, oldLocationHidden, historical, unreported, otherSession, otherWorkspace,
        inMetrics: $('session-metrics').contains($('generation-speed')), uniqueSpeedId: document.querySelectorAll('#generation-speed').length === 1 };
    })()`);
    assert.equal(rates.waiting.text, '0 tok/s');
    assert.equal(rates.estimated.text, '≈251.3 tok/s');
    assert.match(rates.estimated.title, /排除工具执行与审批等待/);
    assert.match(rates.estimated.title, /估算速度不计入用量统计/);
    assert.equal(rates.foreign.text, rates.estimated.text);
    assert.ok(Object.values(rates.blocked).every(value => value.unknown && value.text === '0 tok/s'));
    assert.equal(rates.completed.text, '88.2 tok/s');
    assert.equal(rates.oldLocationHidden, true);
    assert.equal(rates.historical.text, '48.1 tok/s');
    assert.equal(rates.unreported.unknown, true);
    assert.equal(rates.otherSession.unknown, true);
    assert.equal(rates.otherWorkspace.unknown, true);
    assert.equal(rates.inMetrics, true);
    assert.equal(rates.uniqueSpeedId, true);

    const isolation = await js(`(() => {
      const before = $('session-rounds').textContent, beforeContext = $('session-context-value').textContent;
      handleEvent({ type: 'session-metrics', workspaceId: 'different-synthetic-workspace', metrics: { rounds: 999 } });
      const after = $('session-rounds').textContent;
      handleEvent({ type: 'session-metrics', workspaceId: appState.workspaceId, sessionId: 'different-synthetic-session',
        metrics: { ...${JSON.stringify(metrics)}, contextUsedTokens: 128000, contextPercent: 100,
          contextDisplay:{source:'current',pending:false,usedTokens:128000,inputTokens:124000,outputTokens:4000,limit:128000,percent:100} } });
      const afterForeignSession = $('session-context-value').textContent;
      updateState({ ...appState, sessionId: 'synthetic-other-session', sessionMetrics: {
        rounds: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        cacheHitPercent: null, cacheStatus: 'unavailable', usageStatus: 'unavailable',
        contextPercent: null, contextStatus: 'unknown', contextDisplay:{source:'none',pending:false,percent:null,usedTokens:null},
        contextDescription: '模型目录未提供上下文容量。'
      } });
      return {
        before, after, beforeContext, afterForeignSession, rounds: $('session-rounds').textContent,
        cache: $('session-cache-value').textContent, total: $('session-total-value').textContent,
        context: $('session-context-value').textContent,
        ariaValue: $('session-context').getAttribute('aria-valuenow'),
        unknownRing: $('session-context').classList.contains('unknown'),
        contextTitle: $('session-context').title,
      };
    })()`);
    assert.equal(isolation.before, isolation.after, 'Other workspace events must not change current metrics');
    assert.equal(isolation.beforeContext, isolation.afterForeignSession, 'Other session events must not change current context');
    assert.equal(isolation.rounds, '0 轮对话');
    assert.equal(isolation.cache, '0');
    assert.equal(isolation.total, '0');
    assert.equal(isolation.context, '—');
    assert.equal(isolation.ariaValue, null);
    assert.equal(isolation.unknownRing, true);
    assert.match(isolation.contextTitle, /未提供上下文容量/);

    const desktopLayout = await js(`(() => {
      const metrics=$('session-metrics'),footer=document.querySelector('.composer-footer');
      const rect=metrics.getBoundingClientRect(),bounds=footer.getBoundingClientRect();
      return { inFooter:footer.contains(metrics),rightAligned:Math.abs(rect.right-bounds.right)<=1,
        oldHintVisible:document.body.innerText.includes('请检查生成的代码与命令'),
        oldUsageHidden:$('token-usage').hidden };
    })()`);
    assert.equal(desktopLayout.inFooter, true, 'Session metrics must replace the old footer hint');
    assert.equal(desktopLayout.rightAligned, true, 'Session metrics must align to the footer right');
    assert.equal(desktopLayout.oldHintVisible, false);
    assert.equal(desktopLayout.oldUsageHidden, true);

    const layout = await js(`(async () => {
      updateState({ ...appState, sessionMetrics: ${JSON.stringify(metrics)} });
      const sheet = [...document.styleSheets].find(value => value.href?.endsWith('/workbench.css'));
      if (!sheet) throw new Error('Missing workbench styles');
      const index = sheet.insertRule('.composer-area { width: 300px; padding-left: 8px; padding-right: 8px; }', sheet.cssRules.length);
      window.__sessionMetricsSmoke.layoutRule = { sheet, index };
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = $('session-metrics').getBoundingClientRect();
      const items = [...$('session-metrics').querySelectorAll('.session-metric, .session-context')].map(node => {
        const item = node.getBoundingClientRect();
        return item.left >= rect.left && item.right <= rect.right + 1 && item.top >= rect.top && item.bottom <= rect.bottom + 1;
      });
      const footer = document.querySelector('.composer-footer').getBoundingClientRect();
      return { items, inFooter: $('session-metrics').parentElement === document.querySelector('.composer-footer'),
        contained:rect.top>=footer.top-1&&rect.bottom<=footer.bottom+1,
        rightAligned:Math.abs(rect.right-footer.right)<=1,width:rect.width,height:rect.height };
    })()`);
    assert.ok(layout.width <= 300);
    assert.ok(layout.items.every(Boolean), 'Narrow session metrics must wrap without overflow');
    assert.equal(layout.inFooter, true);
    assert.equal(layout.contained, true);
    assert.equal(layout.rightAligned, true);
    await js(`(() => {
      const saved = window.__sessionMetricsSmoke;
      saved.layoutRule.sheet.deleteRule(saved.layoutRule.index);
      delete saved.layoutRule;
      updateState({ ...saved.state, sessionMetrics: ${JSON.stringify(metrics)} });
      setSessionTokenRate({ tokensPerSecond: 251.3, estimated: true, estimatedOutputTokens: 754, elapsedMs: 3000 });
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 110));
    await fs.writeFile(path.join(output, 'session-metrics.png'), (await win.webContents.capturePage()).toPNG());
    return { status: 'completed', rounds: true, partialCache: true, cumulativeUsage: true,
      reportedInputPlusOutputContext: true, unmeasuredContextHidden: true, legacyEstimatesNotPresentedAsMeasured: true,
      lastCompleteContextVisibleWhilePending:true, syntheticChatGPTModeWithoutAuthentication:true,
      contextModelAndConnectionIsolation:true, stoppedRequestPreservesLastReport:true,
      unknownContext: true, workspaceIsolation: true, contextSessionIsolation: true, narrowLayout: true,
      footerRightAligned:true, oldReviewHintRemoved:true, outputSpeedInMetrics:true, ratePhaseGating:true,
      completedAndHistoricalRates:true, rateSessionIsolation:true };
  } finally {
    if (installed && !win.isDestroyed()) await js(`(() => {
      const saved = window.__sessionMetricsSmoke;
      if (!saved) return;
      if (saved.layoutRule) saved.layoutRule.sheet.deleteRule(saved.layoutRule.index);
      sessionId = saved.sessionId;
      updateState(saved.state);
      running = saved.running; activeTaskActivity = saved.activity; latestTelemetry = saved.telemetry;
      sessionTokenRate = saved.rate; renderSessionTokenRate();
      $('run-status').textContent = saved.runStatus;
      $('token-usage').textContent = saved.tokenText;
      delete window.__sessionMetricsSmoke;
    })()`).catch(() => {});
  }
};
