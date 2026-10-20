/* Read-only local usage view; conversation nodes and composer drafts stay live. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const bridge = window.forge, card = $('usage-stats-button'), scroller = $('message-scroll');
  if (!bridge || !card || !scroller) return;
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const panel = node('section', 'usage-dashboard'); panel.id = 'usage-dashboard'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'usage-dashboard-title');
  const top = node('div', 'usage-dashboard-heading'), heading = node('div');
  heading.append(node('p', 'usage-dashboard-eyebrow', 'YOUR TOKEN ACTIVITY'));
  const title = node('h2', '', 'Token 用量'); title.id = 'usage-dashboard-title'; title.tabIndex = -1;
  heading.append(title, node('p', 'usage-dashboard-intro', '本机所有项目的用量与活动'));
  const actions = node('div', 'usage-dashboard-actions');
  const refresh = node('button', 'button subtle', '刷新'); refresh.id = 'usage-dashboard-refresh'; refresh.type = 'button';
  const back = node('button', 'button subtle', '返回会话'); back.id = 'usage-dashboard-close'; back.type = 'button';
  actions.append(refresh, back); top.append(heading, actions);
  const status = node('p', 'usage-dashboard-status'); status.id = 'usage-dashboard-status'; status.setAttribute('role', 'status');
  const summary = node('div', 'usage-summary'); summary.id = 'usage-summary';
  const metrics = [
    ['totalTokens', '累计 Token 数'], ['peakDailyTokens', '单日 Token 峰值'],
    ['longestTaskMs', '最长任务用时'], ['longestStreak', '最长连续天数'], ['currentStreak', '当前连续天数'],
  ];
  for (const [key, label] of metrics) {
    const metric = node('div', 'usage-summary-metric'), value = node('strong', '', '—');
    value.dataset.usageMetric = key; metric.append(value, node('span', '', label)); summary.append(metric);
  }
  const detail = node('p', 'usage-dashboard-detail'); detail.id = 'usage-dashboard-detail';
  const activity = node('section', 'usage-activity');
  const activityTop = node('div', 'usage-activity-heading');
  activityTop.append(node('h3', '', 'Token 活动'));
  const tabs = node('div', 'usage-periods'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Token 活动显示方式');
  let period = 'day', data = null, request = 0, refreshTimer = null, returnScroll = 0, activeSession = null;
  for (const [value, label] of [['day', '每日'], ['week', '每周'], ['cumulative', '累计']]) {
    const button = node('button', 'usage-period', label); button.type = 'button'; button.dataset.usagePeriod = value;
    button.setAttribute('aria-pressed', String(period === value));
    button.addEventListener('click', () => { period = value; renderActivity(); }); tabs.append(button);
  }
  activityTop.append(tabs);
  const description = node('p', 'usage-activity-description'); description.id = 'usage-activity-description';
  const scroll = node('div', 'usage-activity-scroll');
  const months = node('div', 'usage-activity-months'); months.setAttribute('aria-hidden', 'true');
  const grid = node('div', 'usage-activity-grid'); grid.id = 'usage-activity-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', '最近 365 天的 Token 活动');
  scroll.append(grid, months);
  activity.append(activityTop, description, scroll);
  const note = node('p', 'usage-dashboard-note'); note.id = 'usage-dashboard-note';
  panel.append(top, status, summary, detail, activity, note); scroller.prepend(panel);
  const tooltip = node('div', 'usage-activity-tooltip'); tooltip.id = 'usage-activity-tooltip'; tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip'); document.body.append(tooltip);
  card.setAttribute('aria-controls', panel.id); card.setAttribute('aria-expanded', 'false');
  const number = value => Number.isFinite(value) && value >= 0 ? Math.trunc(value).toLocaleString('en-US') : '—';
  const compact = value => !Number.isFinite(value) || value < 0 ? '—' : value >= 1e8 ? (value / 1e8).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 亿'
    : value >= 1e4 ? (value / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 万' : number(value);
  const duration = value => {
    if (!Number.isFinite(value) || value < 0) return '—';
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return seconds + ' 秒';
    const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    return hours ? hours + ' 小时 ' + minutes % 60 + ' 分' : minutes + ' 分 ' + seconds % 60 + ' 秒';
  };
  const utc = key => Date.parse(key + 'T00:00:00Z');
  const keyAt = value => new Date(value).toISOString().slice(0, 10);
  function hideTooltip() { if (!tooltip.hidden) tooltip.hidden = true; }
  function afterScroll() {
    hideTooltip();
    const cell = document.activeElement;
    if (panel.hidden || !grid.contains(cell) || !cell.classList.contains('usage-activity-cell')) return;
    requestAnimationFrame(() => {
      if (panel.hidden || document.activeElement !== cell) return;
      const rect = cell.getBoundingClientRect(), bounds = scroll.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
      if (rect.right > bounds.left && rect.left < bounds.right && rect.bottom > viewport.top && rect.top < viewport.bottom) showTooltip(cell, cell.title);
    });
  }
  function showTooltip(cell, text) {
    tooltip.textContent = text; tooltip.hidden = false;
    const rect = cell.getBoundingClientRect(), width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    tooltip.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.left - width / 2 + rect.width / 2)) + 'px';
    tooltip.style.top = (rect.top > height + 12 ? rect.top - height - 8 : Math.min(innerHeight - height - 8, rect.bottom + 8)) + 'px';
  }
  function renderActivity() {
    const oldPeriod = grid.dataset.period, previousLeft = scroll.scrollLeft;
    const preserveScroll = oldPeriod === period && grid.childElementCount > 0;
    const focusedDate = oldPeriod === period && grid.contains(document.activeElement) ? document.activeElement.dataset.date : null;
    hideTooltip();
    tabs.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.usagePeriod === period)));
    grid.replaceChildren(); months.replaceChildren(); grid.dataset.period = period;
    const days = data?.days || [];
    if (!days.length) { description.textContent = data?.error ? '用量账本暂不可用。' : '尚无可显示的用量记录。'; return; }
    let cells, leading = 0;
    const firstTime = utc(days[0].date);
    const firstWeekday = (new Date(firstTime).getUTCDay() + 6) % 7;
    if (period === 'week') {
      const weeks = new Map();
      for (const day of days) {
        const start = utc(day.date) - ((new Date(utc(day.date)).getUTCDay() + 6) % 7) * 86400000;
        const key = keyAt(start), item = weeks.get(key) || { date: key, end: day.date, totalTokens: 0, requests: 0, unreportedRequests: 0 };
        item.end = day.date;
        item.totalTokens = Number.isSafeInteger(item.totalTokens) && Number.isSafeInteger(day.totalTokens)
          && Number.isSafeInteger(item.totalTokens + day.totalTokens) ? item.totalTokens + day.totalTokens : null;
        item.requests += day.requests; item.unreportedRequests += day.unreportedRequests;
        weeks.set(key, item);
      }
      cells = [...weeks.values()];
      description.textContent = '每个色块是一周，从周一开始；首尾周只计入显示范围内的日期。';
    } else {
      cells = days.map(day => ({ ...day, shownTokens: period === 'cumulative' ? day.cumulativeTokens : day.totalTokens }));
      leading = firstWeekday;
      description.textContent = period === 'cumulative' ? '每个色块显示截至该日的累计 Token，包含显示范围以前的记录。' : '';
    }
    const columns = period === 'week' ? cells.length : Math.ceil((leading + cells.length) / 7);
    const cellSize = Math.max(12, Math.min(20, Math.floor((scroll.clientWidth - (columns - 1) * 4) / columns)));
    scroll.style.setProperty('--usage-columns', String(columns)); scroll.style.setProperty('--usage-cell-size', cellSize + 'px');
    const peak = Math.max(1, ...cells.map(day => period === 'cumulative' ? day.shownTokens : day.totalTokens).filter(Number.isFinite));
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < leading; index++) fragment.append(node('span', 'usage-activity-blank'));
    cells.forEach((day, index) => {
      const amount = period === 'cumulative' ? day.shownTokens : day.totalTokens;
      const cell = node('button', 'usage-activity-cell'); cell.type = 'button';
      cell.dataset.date = day.date; cell.dataset.tokens = Number.isFinite(amount) ? String(amount) : ''; cell.dataset.requests = String(day.requests);
      if (day.end) cell.dataset.end = day.end;
      const level = amount > 0 ? Math.min(5, Math.max(1, Math.ceil(Math.log1p(amount) / Math.log1p(peak) * 5))) : day.requests > 0 ? 1 : 0;
      cell.dataset.level = String(level); cell.tabIndex = index === cells.length - 1 ? 0 : -1;
      const text = `${day.date}${day.end ? ' — ' + day.end : ''}\n${compact(amount)} Token${period === 'cumulative' ? '（截至当日累计）' : ''}`;
      cell.title = text; cell.setAttribute('aria-label', text.replace(/\n/g, '，')); cell.setAttribute('aria-describedby', tooltip.id);
      cell.addEventListener('pointerenter', () => showTooltip(cell, text));
      cell.addEventListener('pointerleave', hideTooltip);
      cell.addEventListener('focus', () => {
        grid.querySelectorAll('.usage-activity-cell').forEach(other => { other.tabIndex = other === cell ? 0 : -1; });
        showTooltip(cell, text);
      });
      cell.addEventListener('blur', hideTooltip);
      cell.addEventListener('keydown', event => {
        const step = period === 'week' ? { ArrowLeft: -1, ArrowRight: 1 }[event.key] : { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
        if (step !== undefined || ['Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : Math.max(0, Math.min(cells.length - 1, index + step));
          grid.querySelectorAll('.usage-activity-cell')[next]?.focus({ preventScroll: true });
          grid.querySelectorAll('.usage-activity-cell')[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
      fragment.append(cell);
    });
    grid.append(fragment);
    let previousMonth = '';
    const monthLabels = [];
    cells.forEach((day, index) => {
      const month = day.date.slice(0, 7);
      if (month === previousMonth) return;
      previousMonth = month;
      monthLabels.push({ column: period === 'week' ? index + 1 : Math.floor((index + leading) / 7) + 1, month: Number(day.date.slice(5, 7)) });
    });
    monthLabels.forEach((item, index) => {
      // A short leading month can share a week with the next month. Omit that
      // partial label instead of overlapping two labels in one small column.
      if (index === 0 && monthLabels[1]?.column - item.column < 2 || item.column > columns - 1) return;
      const label = node('span', '', item.month + '月');
      label.style.gridColumn = String(item.column);
      months.append(label);
    });
    requestAnimationFrame(() => {
      if (panel.hidden) return;
      scroll.scrollLeft = preserveScroll ? previousLeft : scroll.scrollWidth;
      if (focusedDate) {
        [...grid.querySelectorAll('.usage-activity-cell')].find(cell => cell.dataset.date === focusedDate)?.focus({ preventScroll: true });
      }
    });
  }
  function render() {
    const stats = data?.summary || {};
    for (const [key, label] of metrics) {
      const value = summary.querySelector(`[data-usage-metric='${key}']`), raw = stats[key];
      value.dataset.value = Number.isFinite(raw) ? String(raw) : '';
      value.textContent = key === 'longestTaskMs' ? duration(raw) : /Streak$/.test(key) && Number.isFinite(raw) ? number(raw) + ' 天' : compact(raw);
      value.title = `${label}：${key === 'longestTaskMs' ? duration(raw) : number(raw)}${key.includes('Tokens') ? ' Token' : ''}`;
    }
    status.classList.toggle('error', !!data?.error); status.textContent = data?.error || (data?.overflow ? '部分累计值超过精确显示范围，暂以 — 显示。' : '');
    detail.textContent = data?.error ? '账本未重置，缺失数字暂不显示。' : `输入 ${compact(stats.inputTokens)} · 输出 ${compact(stats.outputTokens)} Token · ${number(stats.requests)} 次请求 · ${number(stats.activeDays)} 个活跃日`;
    const since = data?.since ? new Date(data.since).toLocaleDateString('zh-CN', { timeZone: 'Asia/Hong_Kong' }) : '';
    note.textContent = [
      '仅累计本应用 API 已回报的输入和输出 Token，缓存 Token 不重复计入。日期按香港时间划分；有请求即为活跃日。单日峰值基于全部记录，活动图展示最近 365 天。',
      stats.unreportedRequests ? `${number(stats.unreportedRequests)} 次请求用量不完整，缺失部分未计入。` : '',
      data?.historicalApproximate ? '包含旧版历史近似用量。' : '',
      data?.durationWarning || '', data?.historyWarning || '',
      '最长任务用时来自已结束任务的记录；当前连续天数允许最后活跃日为今天或昨天。',
      since ? `统计起始：${since}。` : '',
    ].filter(Boolean).join(' ');
    renderActivity();
  }
  async function load() {
    const token = ++request;
    refresh.disabled = true;
    if (!data) status.textContent = '正在读取本机用量…';
    try {
      const result = await bridge.getUsageAnalytics();
      if (token !== request || panel.hidden) return;
      data = result; render();
    } catch (error) {
      if (token !== request || panel.hidden) return;
      status.classList.add('error'); status.textContent = (data ? '更新失败，保留上次统计：' : '统计读取失败：') + (error?.message || '请重试');
    } finally { if (token === request) refresh.disabled = false; }
  }
  function close(restoreFocus = true, restorePosition = true) {
    if (panel.hidden) return;
    ++request; clearTimeout(refreshTimer); hideTooltip();
    panel.hidden = true; scroller.classList.remove('usage-view-open'); card.setAttribute('aria-expanded', 'false');
    if (restorePosition) scroller.scrollTop = returnScroll;
    if (restoreFocus) card.focus({ preventScroll: true });
  }
  function open() {
    if (!panel.hidden) { title.focus({ preventScroll: true }); return; }
    returnScroll = scroller.scrollTop;
    panel.hidden = false; scroller.classList.add('usage-view-open'); card.setAttribute('aria-expanded', 'true');
    scroller.scrollTop = 0; title.focus({ preventScroll: true });
    if (data) render();
    void load();
  }
  card.addEventListener('click', open);
  card.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); } });
  back.addEventListener('click', () => close()); refresh.addEventListener('click', () => load());
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  document.addEventListener('submit', event => { if (event.target.id === 'task-form') close(false); }, true);
  bridge.onEvent(event => {
    if (event.type === 'workspace-activated') { close(false, false); activeSession = event.state?.sessionId || null; }
    if (event.type === 'state' && event.state?.sessionId) {
      if (activeSession && activeSession !== event.state.sessionId) close(false, false);
      activeSession = event.state.sessionId;
    }
    if (!panel.hidden && ['state', 'workspace-update', 'session', 'run-end'].includes(event.type)) {
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => load(), 600);
    }
  });
  window.addEventListener('resize', () => { hideTooltip(); if (!panel.hidden && data) renderActivity(); });
  scroll.addEventListener('scroll', afterScroll, { passive: true }); scroller.addEventListener('scroll', afterScroll, { passive: true });
  window.ForgeUsageDashboard = Object.freeze({ open, close, refresh: load });
})();
