// Exercises the shipped renderer with synthetic state, without a model request.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeSessionMetrics({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Session metrics smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const metrics = {
    rounds: 3, steps: 7, totalTokens: 128900, inputTokens: 120000, outputTokens: 8900,
    cachedInputTokens: 99000, cacheHitPercent: 82.5, cacheStatus: 'partial', usageStatus: 'partial',
    contextUsedTokens: 32000, contextLimit: 128000, contextPercent: 25,
    contextStatus: 'estimated', contextDescription: '文字和工具定义估算；模型返回实际输入用量后校正。',
  };
  let installed = false;
  try {
    const reported = await js(`(() => {
      window.__sessionMetricsSmoke = { state: appState, sessionId, tokenText: $('token-usage').textContent };
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
    assert.equal(reported.context, '≈25%');
    assert.match(reported.contextTitle, /估算/);
    assert.equal(reported.progress, '25 100');
    assert.equal(reported.ariaValue, '25');
    assert.equal(reported.providerVisible, true);
    assert.equal(reported.tokenText, await js('window.__sessionMetricsSmoke.tokenText'));

    const isolation = await js(`(() => {
      const before = $('session-rounds').textContent;
      handleEvent({ type: 'session-metrics', workspaceId: 'different-synthetic-workspace', metrics: { rounds: 999 } });
      const after = $('session-rounds').textContent;
      updateState({ ...appState, sessionId: 'synthetic-other-session', sessionMetrics: {
        rounds: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        cacheHitPercent: null, cacheStatus: 'unavailable', usageStatus: 'unavailable',
        contextPercent: null, contextStatus: 'unknown', contextDescription: '模型目录未提供上下文容量。'
      } });
      return {
        before, after, rounds: $('session-rounds').textContent,
        cache: $('session-cache-value').textContent, total: $('session-total-value').textContent,
        context: $('session-context-value').textContent,
        ariaValue: $('session-context').getAttribute('aria-valuenow'),
        unknownRing: $('session-context').classList.contains('unknown'),
        contextTitle: $('session-context').title,
      };
    })()`);
    assert.equal(isolation.before, isolation.after, 'Other workspace events must not change current metrics');
    assert.equal(isolation.rounds, '0 轮对话');
    assert.equal(isolation.cache, '—');
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
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 110));
    await fs.writeFile(path.join(output, 'session-metrics.png'), (await win.webContents.capturePage()).toPNG());
    return { status: 'completed', rounds: true, partialCache: true, cumulativeUsage: true, estimatedContext: true, unknownContext: true, workspaceIsolation: true, narrowLayout: true, footerRightAligned:true, oldReviewHintRemoved:true };
  } finally {
    if (installed && !win.isDestroyed()) await js(`(() => {
      const saved = window.__sessionMetricsSmoke;
      if (!saved) return;
      if (saved.layoutRule) saved.layoutRule.sheet.deleteRule(saved.layoutRule.index);
      sessionId = saved.sessionId;
      updateState(saved.state);
      $('token-usage').textContent = saved.tokenText;
      delete window.__sessionMetricsSmoke;
    })()`).catch(() => {});
  }
};
