(() => {
  'use strict';
  const options = [
    ['request', '请求批准', '文件修改、命令和网页操作先由你确认。'],
    ['assist', '帮我批准', '自动批准低风险项目修改和少量只读命令，其余操作仍询问。'],
    ['full', '完全控制', '自动批准文件修改、终端命令和网页操作。']
  ];
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  window.ForgePermissions = Object.freeze({
    create({ bridge, notice, isCurrentWorkspace = () => true, getWorkspaceId = () => '' }) {
      const wrap = el('div', 'permission-control');
      const trigger = el('button', 'permission-trigger', '请求批准 ⌄');
      trigger.id = 'permission-trigger'; trigger.type = 'button';
      trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
      const popup = el('section', 'permission-popup'); popup.id = 'permission-popup'; popup.hidden = true;
      popup.setAttribute('role', 'menu'); popup.setAttribute('aria-label', '操作权限');
      popup.append(el('div', 'permission-heading', '如何批准 Synora code 操作？'));
      let mode = 'request', busy = false, saving = false;
      const close = () => { popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
      const dialog = el('dialog', 'permission-danger-dialog'); dialog.id = 'permission-danger-dialog';
      const heading = el('h2', '', '启用完全控制？'); heading.id = 'permission-danger-title';
      dialog.setAttribute('aria-labelledby', heading.id);
      dialog.append(el('div', 'permission-danger-icon', '⚠'), heading,
        el('p', '', 'AI 将无需逐项确认，直接修改项目文件、执行终端命令和操作网页。'),
        el('p', 'permission-danger-emphasis', '终端命令以你的 Windows 用户权限运行，可能修改或删除项目外文件，或通过网络发送数据。请仅在信任当前任务时启用。'),
        el('p', 'permission-danger-scope', '仅对当前窗口中的此项目有效，其他项目单独设置；重新启动后恢复“请求批准”。文件工具的项目范围和凭据保护仍然有效。'));
      const actions = el('div', 'permission-danger-actions');
      const cancel = el('button', 'button', '取消'); cancel.id = 'permission-danger-cancel'; cancel.type = 'button'; cancel.autofocus = true;
      const confirm = el('button', 'button permission-danger-confirm', '启用完全控制'); confirm.id = 'permission-danger-confirm'; confirm.type = 'button';
      actions.append(cancel, confirm); dialog.append(actions); document.body.append(dialog);
      const buttons = [];
      const render = () => {
        trigger.textContent = `${options.find(option => option[0] === mode)?.[1] || '请求批准'} ⌄`;
        trigger.dataset.mode = mode; trigger.disabled = busy || saving;
        for (const button of buttons) {
          const selected = button.dataset.mode === mode;
          button.setAttribute('aria-checked', String(selected));
          button.querySelector('.permission-check').textContent = selected ? '✓' : '';
          button.disabled = busy || saving;
        }
        confirm.disabled = busy || saving;
      };
      const save = async (next, confirmed = false) => {
        if (busy || saving) return;
        const workspaceId = getWorkspaceId();
        saving = true; render();
        try {
          const result = await bridge.setPermissionMode({ mode: next, ...(confirmed ? { confirmed: true } : {}) });
          if (workspaceId !== getWorkspaceId()) return;
          mode = result.mode; if (dialog.open) dialog.close(); close();
        } catch (error) { if (workspaceId === getWorkspaceId()) notice(error.message || '权限切换失败。', true); }
        finally { saving = false; render(); }
      };
      for (const [value, label, hint] of options) {
        const button = el('button', 'permission-option'); button.type = 'button'; button.dataset.mode = value;
        button.setAttribute('role', 'menuitemradio');
        const copy = el('span', 'permission-option-copy'); copy.append(el('strong', '', label), el('small', '', hint));
        button.append(copy, el('span', 'permission-check'));
        button.addEventListener('click', () => {
          close();
          if (value === mode) return;
          if (value === 'full') { dialog.showModal(); cancel.focus(); } else save(value);
        });
        buttons.push(button); popup.append(button);
      }
      wrap.append(trigger, popup); document.querySelector('.composer-context').append(wrap);
      trigger.addEventListener('click', () => {
        popup.hidden = !popup.hidden; trigger.setAttribute('aria-expanded', String(!popup.hidden));
        if (!popup.hidden) buttons.find(button => button.dataset.mode === mode)?.focus();
      });
      popup.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); const index = buttons.indexOf(document.activeElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      });
      document.addEventListener('pointerdown', event => { if (!wrap.contains(event.target)) close(); });
      cancel.addEventListener('click', () => dialog.close());
      confirm.addEventListener('click', () => save('full', true));
      bridge.onEvent(event => {
        if (!isCurrentWorkspace(event)) return;
        if (event.type === 'run-start' || event.type === 'terminal-start') { busy = true; close(); render(); }
        if (event.type === 'run-end' || event.type === 'terminal-end') { busy = false; render(); }
      });
      render();
      return { close, update(state) {
        mode = options.some(option => option[0] === state.permissionMode) ? state.permissionMode : 'request';
        busy = state.activeTask?.running === true || (state.promptQueue?.items?.length || 0) > 0;
        if (busy) close(); render();
      } };
    }
  });
})();
