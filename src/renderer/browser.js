(() => {
  'use strict';
  window.ForgeBrowser = Object.freeze({
    create({ bridge, showPanel, notice, isCurrentWorkspace = () => true, getWorkspaceId = () => '' }) {
      const $ = id => document.getElementById(id);
      let state = {}, layoutFrame = 0, lastLayout = '';
      const sync = () => {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          const rect = $('browser-viewport').getBoundingClientRect();
          const visible = !$('preview-panel').hidden && !$('browser-preview').hidden && rect.width > 0 && rect.height > 0;
          const petOverlay = ['pet-overlay-menu', 'pet-dialog', 'pet-dialog-input-bubble'].some(id => {
            const node = $(id); if (!node || node.hidden) return false;
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.right > rect.left && box.left < rect.right && box.bottom > rect.top && box.top < rect.bottom;
          });
          const overlayHidden = petOverlay || !!document.querySelector('dialog[open]') || ['app-menu-popup', 'app-menu-submenu', 'file-context-menu', 'chat-selection-menu', 'project-dropdown', 'reasoning-popup', 'permission-popup', 'session-dropdown'].some(id => { const node = $(id); return node && !node.hidden; });
          const layout = { visible, overlayHidden, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) } };
          const encoded = JSON.stringify(layout);
          if (lastLayout === encoded) return;
          lastLayout = encoded;
          bridge.browserLayout(layout).catch(error => { lastLayout = ''; notice(error.message || '浏览器布局更新失败。', true); });
        });
      };
      const apply = next => {
        state = next || {};
        if (document.activeElement !== $('browser-address')) $('browser-address').value = state.url || '';
        $('browser-back').disabled = !state.canGoBack;
        $('browser-forward').disabled = !state.canGoForward;
        $('browser-reload').textContent = state.loading ? '×' : '↻';
        $('browser-reload').title = state.loading ? '停止加载' : '刷新';
        $('browser-status').textContent = state.error || (state.loading ? '正在加载…' : state.title || '内置浏览器 · 可由 AI 读取页面和操作');
        $('browser-status').classList.toggle('browser-error', !!state.error);
        $('browser-empty').hidden = state.exists === true;
        sync();
      };
      const open = async arg => {
        const workspaceId = getWorkspaceId();
        showPanel(); sync();
        try {
          const result = await bridge.browserOpen(arg);
          if (workspaceId !== getWorkspaceId()) return;
          apply(result); sync();
        }
        catch (error) { if (workspaceId === getWorkspaceId()) notice(error.message || '网页打开失败。', true); throw error; }
      };
      const command = async action => {
        const workspaceId = getWorkspaceId();
        try {
          const result = await bridge.browserCommand({ action });
          if (workspaceId === getWorkspaceId()) apply(result);
        }
        catch (error) { if (workspaceId === getWorkspaceId()) notice(error.message || '浏览器操作失败。', true); }
      };
      $('browser-toolbar').addEventListener('submit', event => {
        event.preventDefault();
        let url = $('browser-address').value.trim();
        if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = 'https://' + url;
        open({ url }).catch(() => {});
      });
      $('browser-back').addEventListener('click', () => command('back'));
      $('browser-forward').addEventListener('click', () => command('forward'));
      $('browser-reload').addEventListener('click', () => command(state.loading ? 'stop' : 'reload'));
      $('browser-preview-tab').addEventListener('click', () => { showPanel(); sync(); });
      new ResizeObserver(sync).observe($('browser-viewport'));
      new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
      window.addEventListener('resize', sync);
      bridge.onEvent(event => {
        if (!isCurrentWorkspace(event)) return;
        if (event.type === 'browser-state') apply(event.browser);
        if (event.type === 'browser-open') { showPanel(); sync(); }
        if (event.type === 'browser-capture') notice(`浏览器截图已保存：${event.capture?.path || event.capture?.filePath || ''}`);
      });
      apply({});
      return { open, sync, apply, reset: () => { lastLayout = ''; apply({}); }, show: () => { showPanel(); sync(); } };
    }
  });
})();
