(() => {
  'use strict';
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const dateLabel = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  };
  window.ForgeSessions = Object.freeze({
    create({ bridge, onSelect, onNew, notice }) {
      const heading = document.getElementById('conversation-title');
      const title = el('span', 'session-current-title', heading.textContent);
      heading.removeAttribute('id'); title.id = 'conversation-title';
      heading.classList.add('session-heading'); heading.replaceChildren();
      const trigger = el('button', 'session-menu-button'); trigger.id = 'session-menu-button'; trigger.type = 'button';
      trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', 'session-dropdown');
      trigger.title = '历史会话与新建会话';
      const caret = el('span', 'session-menu-caret', '⌄'); caret.setAttribute('aria-hidden', 'true');
      trigger.append(title, caret); heading.append(trigger);
      const popup = el('section', 'session-dropdown'); popup.id = 'session-dropdown'; popup.hidden = true;
      popup.setAttribute('role', 'menu'); popup.setAttribute('aria-label', '当前项目会话');
      document.body.append(popup);
      let state = {}, request = 0, submitting = false, busy = false, rows = [];
      const workspace = value => typeof value === 'string' ? value : value?.root || '';
      const enabled = () => [...popup.querySelectorAll('button:not(:disabled)')];
      const close = (restore = false) => {
        ++request; popup.hidden = true; trigger.setAttribute('aria-expanded', 'false');
        if (restore) trigger.focus({ preventScroll: true });
      };
      let positionStyle;
      const position = () => {
        if (popup.hidden) return;
        if (!positionStyle) {
          for (const sheet of document.styleSheets) {
            try { const rule = [...sheet.cssRules].find(rule => rule.selectorText === '#session-dropdown'); if (rule) { positionStyle = rule.style; break; } } catch { /* Only local stylesheets are inspected. */ }
          }
        }
        if (!positionStyle) return;
        const r = trigger.getBoundingClientRect(), p = popup.getBoundingClientRect();
        const top = Math.max(8, Math.min(r.bottom + 6, innerHeight - 100));
        positionStyle.setProperty('left', `${Math.max(8, Math.min(r.left, innerWidth - p.width - 8))}px`);
        positionStyle.setProperty('top', `${top}px`);
        positionStyle.setProperty('max-height', `${Math.max(80, innerHeight - top - 12)}px`);
      };
      const action = async callback => {
        if (busy || submitting) return;
        submitting = true; close(); trigger.disabled = true;
        try { await callback(); }
        catch (error) { notice(error?.message || '会话切换失败。', true); }
        finally { submitting = false; trigger.disabled = busy; }
      };
      const sessionButton = (record, current = false) => {
        const button = el('button', 'session-history-item'); button.type = 'button'; button.dataset.sessionId = record.id;
        button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(current));
        const copy = el('span', 'session-history-copy');
        copy.append(el('span', 'session-history-preview', record.preview || '当前会话'));
        const label = dateLabel(record.updatedAt);
        if (label || current) copy.append(el('small', 'session-history-meta', `${current ? '当前会话' : '历史会话'}${label ? ' · ' + label : ''}`));
        button.append(copy, el('span', 'session-history-check', current ? '✓' : ''));
        button.title = record.preview || '当前会话';
        button.addEventListener('click', () => current ? close(true) : action(() => onSelect(record.id)));
        return button;
      };
      const render = ({ loading = false, failed = false } = {}) => {
        popup.replaceChildren();
        const create = el('button', 'session-new-button', '＋ 新建会话'); create.type = 'button'; create.dataset.action = 'new-session'; create.setAttribute('role', 'menuitem');
        create.addEventListener('click', () => action(onNew)); popup.append(create);
        popup.append(el('h2', 'session-list-heading', '当前项目的历史会话'));
        if (state.sessionId && !rows.some(row => row.id === state.sessionId)) {
          popup.append(sessionButton({ id: state.sessionId, preview: state.temporary === true ? '当前临时会话' : '当前会话' }, true));
        }
        if (loading) popup.append(el('p', 'session-list-status', '正在加载…'));
        else if (failed) popup.append(el('p', 'session-list-status', '历史会话加载失败，请重试。'));
        else if (!workspace(state.workspace)) popup.append(el('p', 'session-list-status', '打开项目后可查看该项目的历史会话。'));
        else if (!rows.length) popup.append(el('p', 'session-list-status', '此项目还没有历史会话。'));
        for (const row of rows) popup.append(sessionButton(row, row.id === state.sessionId));
        if (rows.length >= 100) popup.append(el('p', 'session-list-status', '显示最近 100 个会话'));
        position();
      };
      const open = async (focus = false) => {
        if (busy || submitting) return;
        const token = ++request, root = workspace(state.workspace);
        rows = []; popup.hidden = false; trigger.setAttribute('aria-expanded', 'true'); render({ loading: true });
        if (focus) enabled()[0]?.focus({ preventScroll: true });
        try {
          const result = await bridge.listProjectSessions();
          if (token !== request || popup.hidden || root !== workspace(state.workspace) || busy) return;
          rows = (Array.isArray(result) ? result : []).filter(row => row && typeof row.id === 'string' && typeof row.preview === 'string').slice(0, 100);
          const focusedId = document.activeElement?.dataset.sessionId;
          const focusNew = document.activeElement?.dataset.action === 'new-session';
          render();
          if (focusedId) [...popup.querySelectorAll('[data-session-id]')].find(button => button.dataset.sessionId === focusedId)?.focus({ preventScroll: true });
          else if (focusNew || focus) enabled()[0]?.focus({ preventScroll: true });
        } catch (error) {
          if (token !== request || popup.hidden) return;
          render({ failed: true }); notice(error?.message || '历史会话加载失败。', true);
        }
      };
      trigger.addEventListener('click', () => popup.hidden ? open() : close());
      trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); popup.hidden ? open(true) : enabled()[0]?.focus(); }
        if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); close(true); }
      });
      popup.addEventListener('keydown', event => {
        const buttons = enabled(), index = buttons.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
          next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); const button = event.key === 'Home' ? buttons[0] : buttons.at(-1); button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest' }); }
        else if (event.key === 'Tab') close();
      });
      document.addEventListener('pointerdown', event => { if (!trigger.contains(event.target) && !popup.contains(event.target)) close(); });
      window.addEventListener('resize', position);
      return {
        close,
        update(next) {
          const rootChanged = workspace(state.workspace) !== workspace(next?.workspace);
          const sessionChanged = state.sessionId !== next?.sessionId;
          state = next || {};
          const queue = state.promptQueue || state.queue;
          busy = state.busy === true || state.authBusy === true || state.activeTask?.running === true
            || (Array.isArray(queue) ? queue.length > 0 : (queue?.items?.length || queue?.pending?.length || 0) > 0);
          trigger.disabled = busy || submitting;
          if (busy || rootChanged || sessionChanged) close();
        }
      };
    }
  });
})();
