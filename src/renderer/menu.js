'use strict';

(() => {
  const ui = window.aiCodeCommands;
  if (!ui) return;
  const bar = document.getElementById('app-menu-bar');
  const popup = document.getElementById('app-menu-popup');
  const submenu = document.getElementById('app-menu-submenu');
  const triggers = [...bar.querySelectorAll('[data-menu]')];
  const locked = (state) => state.busy || state.authBusy;
  const menus = {
    file: [
      ['new-window', '新窗口'], ['new-chat', '新聊天', 'Ctrl+N', locked], ['temporary-chat', '临时聊天', 'Ctrl+Shift+N', locked], null,
      ['create-project', '新建项目…', '', state => state.projectBusy || state.authBusy], ['open-project', '打开项目…', 'Ctrl+O', state => state.projectBusy || state.authBusy], ['open-file', '打开文件…', 'Ctrl+Shift+O', state => !state.hasWorkspace || state.projectBusy], ['close-window', '关闭窗口', 'Ctrl+W', (state) => state.authBusy], null,
      ['logout', '退出账号登录', '', (state) => locked(state) || !state.hasChatGPTAccount], ['quit', '退出 Synora code', 'Ctrl+Q', (state) => state.authBusy]
    ],
    edit: [
      ['undo', '撤销', 'Ctrl+Z'], ['redo', '重做', 'Ctrl+Y'], null,
      ['cut', '剪切', 'Ctrl+X'], ['copy', '复制', 'Ctrl+C'], ['paste', '粘贴', 'Ctrl+V'], ['delete', '删除'], ['select-all', '全选', 'Ctrl+A'], null,
      ['settings', '设置…', 'Ctrl+,', locked]
    ],
    view: [
      ['toggle-side-chat', '侧边临时问答', '', null, 'sideChatVisible'],
      ['toggle-sidebar', '侧边栏', 'Ctrl+Shift+S', null, 'sidebarVisible'], ['toggle-terminal', '终端面板', 'Ctrl+J', null, 'terminalVisible'], ['pin-summary', '固定摘要到右侧', '', null, 'previewPinned'], null,
      ['open-terminal', '打开终端', 'Ctrl+`', (state) => state.busy || !state.hasWorkspace], ['toggle-navigation', '文件导航面板', 'Ctrl+Shift+E', null, 'previewVisible'], ['switch-focus', '切换对话与标签', 'Ctrl+Alt+B'], ['browser', '浏览器', '', null, null, [['open-browser', '打开内置浏览器'], ['open-link', '打开链接…']]], null,
      ['find', '查找…', 'Ctrl+F'], ['back', '返回', 'Ctrl+[', (state) => locked(state) || !state.canBack], ['forward', '前进', 'Ctrl+]', (state) => locked(state) || !state.canForward],
      ['previous-sidebar', '上一个侧边栏项目', 'Ctrl+Alt+[', locked], ['next-sidebar', '下一个侧边栏项目', 'Ctrl+Alt+]', locked], ['previous-tab', '上一个标签', 'Ctrl+Shift+['], ['next-tab', '下一个标签', 'Ctrl+Shift+]'], null,
      ['zoom-in', '放大文字', 'Ctrl+Shift+='], ['zoom-out', '缩小文字', 'Ctrl+-'], ['zoom-reset', '实际文字大小', 'Ctrl+0'], null,
      ['fullscreen', '全屏', 'F11', null, 'fullscreen']
    ],
    appearance: [
      ['import-background', '导入背景图…'], ['appearance-settings', '外观与背景…']
    ],
    settings: [
      ['extensions', '插件管理…'], ['pet-settings', '宠物设置…'], null,
      ['settings', '主模型设置…', 'Ctrl+,', locked], ['role-settings', '模型分工…', '', locked], null,
      ['role-subagent-settings', '子智能体模型…', '', locked], ['role-approval-settings', '帮我批准模型…', '', locked],
      ['role-completion-settings', 'TAB 提示词补齐模型…', '', locked], ['role-sidebar-settings', '侧边问答模型…', '', locked],
    ],
    help: [['guide', '使用说明'], ['check-update', '检查更新'], ['about', '关于 Synora code']]
  };
  let activeMenu = null;
  let savedFocus = null;
  let keyboardMode = false;
  let submenuParent = null;
  const positionRules = new Map();

  function state() { return ui.getState(); }

  function itemDisabled(item) {
    const current = state();
    return current.authBusy || (typeof item?.[3] === 'function' && item[3](current));
  }

  function findItem(action) {
    for (const entries of Object.values(menus)) {
      for (const entry of entries) {
        if (!entry) continue;
        if (entry[0] === action) return entry;
        const nested = entry[5]?.find((item) => item[0] === action);
        if (nested) return nested;
      }
    }
    return null;
  }

  function positionRule(id) {
    if (positionRules.has(id)) return positionRules.get(id);
    for (const sheet of document.styleSheets) {
      try {
        const rule = [...sheet.cssRules].find((candidate) => candidate.selectorText === `#${id}`);
        if (rule) { positionRules.set(id, rule); return rule; }
      } catch { /* Only the local application stylesheet is used. */ }
    }
    return null;
  }

  function position(container, anchor, nested = false) {
    const rect = anchor.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    let left = nested ? popup.getBoundingClientRect().right + 5 : rect.left;
    if (nested && left + bounds.width > innerWidth - 8) left = popup.getBoundingClientRect().left - bounds.width - 5;
    left = Math.max(8, Math.min(left, innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(nested ? rect.top : rect.bottom + 5, innerHeight - 85));
    const rule = positionRule(container.id);
    if (rule) {
      rule.style.setProperty('left', `${left}px`);
      rule.style.setProperty('top', `${top}px`);
      rule.style.setProperty('max-height', `${Math.max(70, innerHeight - top - 10)}px`);
    }
  }

  function enabledItems(container) { return [...container.querySelectorAll('button[data-action]')].filter((button) => !button.disabled); }

  function focusItem(button) {
    if (!button) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest' });
  }

  function closeSubmenu() {
    submenu.hidden = true;
    if (submenuParent) submenuParent.setAttribute('aria-expanded', 'false');
    submenuParent = null;
  }

  function closeMenus(restore = false) {
    const target = savedFocus;
    closeSubmenu();
    popup.hidden = true;
    activeMenu = null;
    keyboardMode = false;
    bar.classList.remove('keyboard-active');
    triggers.forEach((trigger) => { trigger.setAttribute('aria-expanded', 'false'); trigger.classList.remove('active'); });
    savedFocus = null;
    if (restore && target?.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  async function invoke(action) {
    const item = findItem(action);
    if (!item || itemDisabled(item)) return;
    closeMenus(true);
    try { await ui.execute(action); } catch (error) { ui.reportError(error); }
    refresh();
  }

  function render(entries, container) {
    container.replaceChildren();
    const current = state();
    entries.forEach((item) => {
      if (!item) {
        const separator = document.createElement('div');
        separator.className = 'app-menu-separator';
        separator.setAttribute('role', 'separator');
        container.append(separator);
        return;
      }
      const [action, title, shortcut, , checkedKey, children] = item;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-menu-item';
      button.dataset.action = action;
      button.tabIndex = -1;
      button.disabled = itemDisabled(item);
      button.setAttribute('role', checkedKey ? 'menuitemcheckbox' : 'menuitem');
      if (checkedKey) button.setAttribute('aria-checked', String(!!current[checkedKey]));
      if (children) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
      const mark = document.createElement('span');
      mark.className = 'app-menu-check';
      mark.textContent = checkedKey && current[checkedKey] ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'app-menu-label';
      label.textContent = title;
      const key = document.createElement('span');
      key.className = 'app-menu-shortcut';
      key.textContent = children ? '›' : shortcut || '';
      button.append(mark, label, key);
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('mouseenter', () => { if (children && !button.disabled) openSubmenu(button, children); else if (container === popup) closeSubmenu(); });
      button.addEventListener('click', () => { if (children) openSubmenu(button, children, true); else invoke(action); });
      container.append(button);
    });
  }

  function openSubmenu(button, entries, focus = false) {
    if (button.disabled) return;
    render(entries, submenu);
    submenu.hidden = false;
    submenuParent = button;
    button.setAttribute('aria-expanded', 'true');
    position(submenu, button, true);
    if (focus) focusItem(enabledItems(submenu)[0]);
  }

  function openMenu(name, focus = false, last = false) {
    const trigger = triggers.find((item) => item.dataset.menu === name);
    if (!trigger || trigger.disabled) return;
    if (!activeMenu && !bar.contains(document.activeElement)) savedFocus = document.activeElement;
    closeSubmenu();
    activeMenu = name;
    render(menus[name], popup);
    popup.hidden = false;
    triggers.forEach((item) => { const active = item === trigger; item.setAttribute('aria-expanded', String(active)); item.classList.toggle('active', active); item.tabIndex = active ? 0 : -1; });
    position(popup, trigger);
    if (focus) { const items = enabledItems(popup); focusItem(last ? items.at(-1) : items[0]); }
  }

  function shiftMenu(direction, focus = true) {
    const current = triggers.findIndex((trigger) => trigger.dataset.menu === activeMenu || trigger === document.activeElement);
    const trigger = triggers[(Math.max(0, current) + direction + triggers.length) % triggers.length];
    trigger.focus({ preventScroll: true });
    if (activeMenu) openMenu(trigger.dataset.menu, focus);
  }

  function refresh() {
    const current = state();
    triggers.forEach((trigger) => { trigger.disabled = current.authBusy; });
    if (current.authBusy) { closeMenus(); return; }
    if (!activeMenu) return;
    const focused = document.activeElement?.dataset?.action;
    const subFocused = submenu.contains(document.activeElement);
    const subOpen = !submenu.hidden;
    openMenu(activeMenu, false);
    if (subOpen) {
      const parent = popup.querySelector('[data-action="browser"]');
      const children = findItem('browser')?.[5];
      if (parent && children) openSubmenu(parent, children);
    }
    if (focused) focusItem((subFocused ? submenu : popup).querySelector(`[data-action="${focused}"]:not(:disabled)`));
  }

  triggers.forEach((trigger, index) => {
    trigger.tabIndex = index === 0 ? 0 : -1;
    trigger.addEventListener('pointerdown', (event) => { if (!activeMenu) savedFocus = document.activeElement; event.preventDefault(); });
    trigger.addEventListener('click', () => { if (activeMenu === trigger.dataset.menu) closeMenus(true); else openMenu(trigger.dataset.menu); });
    trigger.addEventListener('mouseenter', () => { if (activeMenu && activeMenu !== trigger.dataset.menu) openMenu(trigger.dataset.menu); });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); shiftMenu(event.key === 'ArrowRight' ? 1 : -1, false); }
      else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openMenu(trigger.dataset.menu, true, event.key === 'ArrowUp'); }
    });
  });

  document.addEventListener('pointerdown', (event) => { if (activeMenu && !bar.contains(event.target) && !popup.contains(event.target) && !submenu.contains(event.target)) closeMenus(false); });
  window.addEventListener('resize', () => closeMenus(false));
  window.addEventListener('aicode-ui-change', refresh);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if ((event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.repeat) || event.key === 'F10') {
      event.preventDefault();
      if (activeMenu || keyboardMode) closeMenus(true);
      else { savedFocus = document.activeElement; keyboardMode = true; bar.classList.add('keyboard-active'); triggers[0].focus({ preventScroll: true }); }
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.shiftKey) {
      const name = { f: 'file', e: 'edit', v: 'view', a: 'appearance', h: 'help' }[event.key.toLowerCase()];
      if (name) { event.preventDefault(); if (!activeMenu && !keyboardMode) savedFocus = document.activeElement; openMenu(name, true); return; }
    }
    if (event.key === 'Escape' && keyboardMode && !activeMenu) { event.preventDefault(); closeMenus(true); return; }
    if (activeMenu) {
      const nested = !submenu.hidden && submenu.contains(document.activeElement);
      const container = nested ? submenu : popup;
      const items = enabledItems(container);
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); if (nested) { const parent = submenuParent; closeSubmenu(); focusItem(parent); } else closeMenus(true); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        focusItem(items[next]); return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (document.activeElement?.dataset?.action === 'browser') openSubmenu(document.activeElement, findItem('browser')[5], true);
        else if (!nested) shiftMenu(1);
        return;
      }
      if (event.key === 'ArrowLeft') { event.preventDefault(); if (nested) { const parent = submenuParent; closeSubmenu(); focusItem(parent); } else shiftMenu(-1); return; }
      if (event.key === 'Tab') { closeMenus(true); return; }
    }
    const key = event.key.toLowerCase();
    const code = event.code;
    let action;
    if (event.key === 'F11') action = 'fullscreen';
    else if (event.ctrlKey && event.altKey && !event.shiftKey) {
      if (key === 'b') action = 'switch-focus';
      if (code === 'BracketLeft' || key === '[') action = 'previous-sidebar';
      if (code === 'BracketRight' || key === ']') action = 'next-sidebar';
    } else if (event.ctrlKey && !event.altKey && event.shiftKey) {
      action = { n: 'temporary-chat', o: 'open-file', s: 'toggle-sidebar', e: 'toggle-navigation', z: 'redo' }[key];
      if (code === 'BracketLeft' || key === '{') action = 'previous-tab';
      if (code === 'BracketRight' || key === '}') action = 'next-tab';
      if (code === 'Equal' || key === '+') action = 'zoom-in';
    } else if (event.ctrlKey && !event.altKey && !event.shiftKey) {
      action = { n: 'new-chat', o: 'open-project', w: 'close-window', q: 'quit', j: 'toggle-terminal', f: 'find', z: 'undo', y: 'redo', x: 'cut', c: 'copy', v: 'paste', a: 'select-all', ',': 'settings', '-': 'zoom-out' }[key];
      if (code === 'Backquote' || key === '`') action = 'open-terminal';
      if (code === 'BracketLeft' || key === '[') action = 'back';
      if (code === 'BracketRight' || key === ']') action = 'forward';
      if (code === 'Comma') action = 'settings';
      if (code === 'Minus') action = 'zoom-out';
    }
    if (action) { event.preventDefault(); invoke(action); }
  });
  refresh();
})();
