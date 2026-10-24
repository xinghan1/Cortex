'use strict';
(function (root) {
  const roles = Object.freeze([
    Object.freeze({ id: 'subagent', name: '子智能体', description: '执行委派的编程任务' }),
    Object.freeze({ id: 'approval', name: '帮我批准', description: '判断操作是否符合任务范围' }),
    Object.freeze({ id: 'completion', name: 'TAB 提示词补齐', description: '生成输入框中的 Tab 补全建议' }),
    Object.freeze({ id: 'sidebar', name: '侧边问答', description: '在侧栏进行独立问答' }),
    Object.freeze({ id: 'pet', name: '宠物模型', description: '与大肥鱼聊天和生成动作台词' }),
  ]);
  const names = { openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini', anthropic: 'Claude', relay: '中转站', ollama: 'Ollama' };
  const roleInfo = role => roles.find(item => item.id === role);
  function scope(state, role) {
    if (role == null) return state || {};
    if (!roleInfo(role)) throw new Error('未识别的模型分工。');
    return state?.roleModels?.[role] || { enabled: false, settings: {}, chatgpt: {} };
  }
  const requiresTools = role => role == null || role === 'subagent';
  const selectable = (role, model) => !!model && (requiresTools(role)
    ? model.compatible !== false && model.supportsTools !== false
    : model.textCompatible !== false && (model.compatible !== false || model.textCompatible === true));
  function invoke(bridge, role, action, input = {}) {
    if (role != null && !roleInfo(role)) return Promise.reject(new Error('未识别的模型分工。'));
    const methods = {
      preview: ['previewModelCatalog', 'previewRoleModelCatalog'], save: ['saveModelSettings', 'saveRoleModelSettings'],
      signin: ['chatgptSignIn', 'roleChatgptSignIn'], profile: ['chatgptSelectProfile', 'roleChatgptSelectProfile'],
      cancel: ['chatgptCancelSignIn', 'roleChatgptCancelSignIn'], disconnect: ['chatgptDisconnect', 'roleChatgptDisconnect'],
      retry: ['chatgptRetryStorage', 'roleChatgptRetryStorage'], usage: ['chatgptOpenUsage', 'roleChatgptOpenUsage'],
    };
    const method = methods[action]?.[role == null ? 0 : 1];
    if (!method || typeof bridge?.[method] !== 'function') return Promise.reject(new Error('当前版本不支持此模型设置操作。'));
    return Promise.resolve().then(() => bridge[method](role == null ? input : { ...input, role }));
  }
  function create({ document, bridge, onConfigure, onState, notice, isBusy = () => false }) {
    const dialog = document.getElementById('role-models-dialog'), list = document.getElementById('role-models-list');
    let state = {}, pending = false;
    const node = (tag, className, text) => {
      const element = document.createElement(tag); element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    function render() {
      list.replaceChildren();
      for (const role of roles) {
        const entry = scope(state, role.id), settings = entry.enabled ? entry.settings || {} : state.settings || {};
        const effective = entry.effective || settings;
        const legacy = role.id === 'approval' && !entry.enabled && state.approvalReviewer?.model;
        const model = legacy || effective.model || effective.providers?.[effective.provider]?.model || '尚未配置';
        const row = node('section', 'role-model-row'), copy = node('div', 'role-model-copy');
        row.dataset.role = role.id;
        copy.append(node('h3', '', role.name), node('p', 'role-model-description', role.description),
          node('p', 'role-model-summary', `${entry.enabled ? '独立配置' : legacy ? '当前连接' : '跟随主模型'} · ${names[effective.provider] || effective.provider || ''}${effective.provider ? ' · ' : ''}${model}`));
        const actions = node('div', 'role-model-actions'), configure = node('button', 'button', '配置'), reset = node('button', 'text-button', '恢复跟随');
        configure.type = reset.type = 'button'; configure.disabled = pending || isBusy(); reset.disabled = pending || isBusy() || !(entry.enabled || legacy);
        configure.setAttribute('aria-label', `配置${role.name}模型`); reset.setAttribute('aria-label', `${role.name}恢复跟随主模型`);
        configure.addEventListener('click', () => open(role.id)); reset.addEventListener('click', () => resetRole(role.id));
        actions.append(configure, reset); row.append(copy, actions); list.append(row);
      }
      document.getElementById('role-models-close').disabled = pending;
    }
    async function resetRole(role) {
      if (!roleInfo(role) || pending || isBusy()) return;
      pending = true; render();
      try {
        const next = await bridge.resetRoleModel({ role }); state = next || state; onState?.(next);
        notice?.(`${roleInfo(role).name}已恢复跟随主模型。`);
      } catch (error) { notice?.(String(error?.message || error).replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/u, ''), true); }
      finally { pending = false; render(); }
    }
    function open(role) {
      if (!roleInfo(role) || pending || isBusy()) return;
      dialog.close(); onConfigure(role);
    }
    document.getElementById('role-models-close').addEventListener('click', () => { if (!pending) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
    return Object.freeze({ open, reset: resetRole,
      openList() { if (pending || isBusy()) return; render(); if (!dialog.open) dialog.showModal(); },
      update(value) { state = value || {}; if (dialog.open) render(); },
    });
  }
  root.ForgeRoleModels = Object.freeze({ roles, roleInfo, scope, requiresTools, selectable, invoke, create });
})(typeof globalThis === 'object' ? globalThis : this);
