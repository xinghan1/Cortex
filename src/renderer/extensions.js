'use strict';
(function (root) {
  const permissionNames = { 'project.read': '读取项目文件', 'project.write': '修改项目文件', notifications: '显示通知' };
  const clean = (value, limit = 600) => typeof value === 'string' ? value.slice(0, limit) : '';
  function create({ document = root.document, bridge, pet, notice = () => {} }) {
    const el = (tag, id, className, value) => {
      const node = document.createElement(tag);
      if (id) node.id = id;
      if (className) node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    };
    const button = (id, label, action, className = 'button') => {
      const node = el('button', id, className, label); node.type = 'button';
      node.addEventListener('click', action); return node;
    };
    const dialog = el('dialog', 'extensions-dialog', 'settings-dialog extensions-dialog');
    dialog.setAttribute('aria-labelledby', 'extensions-title');
    const header = el('div', '', 'dialog-header');
    header.append(el('h2', 'extensions-title', '', '插件与宠物'), button('extensions-close', '×', () => dialog.close(), 'icon-button'));
    header.children[1].setAttribute('aria-label', '关闭插件与宠物设置');
    const error = el('p', 'extensions-error', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const status = el('p', 'extensions-status', 'extensions-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const pluginSection = el('section', 'extensions-plugin-section', 'extensions-section');
    pluginSection.setAttribute('aria-labelledby', 'extensions-plugin-title');
    const pluginHeading = el('div', '', 'extensions-section-heading');
    const pluginActions = el('div', '', 'extensions-toolbar');
    const install = button('extensions-install', '安装本地插件…', () => perform('installExtension'));
    const refresh = button('extensions-refresh', '刷新', () => refreshState());
    const example = button('extensions-example', '创建示例插件…', () => perform('createExtensionExample'));
    const guide = button('extensions-guide', '开发文档', () => perform('openExtensionGuide'));
    pluginActions.append(install, refresh, example, guide); pluginHeading.append(el('h3', 'extensions-plugin-title', '', '插件'), pluginActions);
    const list = el('div', 'extensions-list', 'extensions-list');
    pluginSection.append(pluginHeading, list);
    const petSection = el('section', 'extensions-pet-section', 'extensions-section');
    petSection.setAttribute('aria-labelledby', 'extensions-pet-title');
    const petHeading = el('div', '', 'extensions-section-heading');
    const importPet = button('extensions-pet-import', '导入 DSH 宠物…', () => perform('petImport'));
    petHeading.append(el('h3', 'extensions-pet-title', '', '宠物'), importPet);
    const petEnabled = el('input', 'extensions-pet-enabled'); petEnabled.type = 'checkbox';
    const petEnabledLabel = el('label', '', 'extensions-check'); petEnabledLabel.append(petEnabled, el('span', '', '', '显示宠物'));
    const petWork = el('input', 'extensions-pet-work'); petWork.type = 'checkbox';
    const petWorkLabel = el('label', '', 'extensions-check'); petWorkLabel.append(petWork, el('span', '', '', '跟随任务状态切换动作'));
    const petPackLabel = el('label', '', 'extensions-field-label', '宠物'); petPackLabel.htmlFor = 'extensions-pet-pack';
    const petPack = el('select', 'extensions-pet-pack', 'extensions-select');
    const petSizeLabel = el('label', '', 'extensions-field-label', '大小'); petSizeLabel.htmlFor = 'extensions-pet-size';
    const petSizeRow = el('div', '', 'extensions-pet-size-row');
    const petSize = el('input', 'extensions-pet-size'); petSize.type = 'range'; petSize.min = '80'; petSize.max = '600'; petSize.step = '10';
    const petSizeValue = el('output', 'extensions-pet-size-value'); petSizeValue.htmlFor = 'extensions-pet-size';
    petSizeRow.append(petSize, petSizeValue);
    const petCredit = el('p', 'extensions-pet-credit', 'extensions-description');
    const petReset = button('extensions-pet-reset', '重置位置', () => changePet({ x: 1, y: 1 }));
    petSection.append(petHeading, petEnabledLabel, petWorkLabel, petPackLabel, petPack, petSizeLabel, petSizeRow, petReset, petCredit);
    dialog.append(header, status, error, pluginSection, petSection); document.body.append(dialog);
    let snapshot = { plugins: [], pet: null }, pending = false, disposed = false, revision = 0, petRevision = 0, confirming = null;
    let storageError = '', actionError = '';
    let loading = false, announcement = '';
    const fields = [install, refresh, example, guide, importPet, petEnabled, petWork, petPack, petSize, petReset];
    function updatePet(value) {
      if (!value || !Array.isArray(value.packs)) return;
      snapshot.pet = value; renderPet();
    }
    function renderPet() {
      const value = snapshot.pet;
      petSection.hidden = !value;
      if (!value) return;
      petEnabled.checked = value.enabled === true; petWork.checked = value.workStatus !== false;
      petPack.replaceChildren();
      for (const pack of value.packs) {
        const option = el('option', '', '', clean(pack.name, 120) || clean(pack.id, 120)); option.value = pack.id; petPack.append(option);
      }
      petPack.value = value.packId || value.packs[0]?.id || '';
      petSize.value = String(value.size || 220); petSizeValue.textContent = `${value.size || 220} px`;
      const pack = value.packs.find(item => item.id === petPack.value);
      petCredit.textContent = pack ? `${clean(pack.name, 120)}${pack.license ? ' · ' + clean(pack.license, 120) : ''}` : '';
      petPack.disabled = pending || loading || !value.packs.length;
      petReset.disabled = pending || loading || !value.packs.length;
    }
    function render() {
      if (disposed) return;
      renderError();
      status.textContent = pending ? '正在保存…' : loading ? '正在读取…' : announcement;
      dialog.setAttribute('aria-busy', String(pending || loading));
      for (const field of fields) field.disabled = pending || loading;
      list.replaceChildren();
      if (!snapshot.plugins.length) list.append(el('p', 'extensions-empty', 'extensions-empty', loading ? '正在读取插件…' : '尚未安装插件'));
      for (const plugin of snapshot.plugins) {
        const row = el('article', '', 'extension-entry'); row.dataset.extensionId = plugin.id;
        const copy = el('div', '', 'extension-copy'), title = el('div', '', 'extension-title');
        title.append(el('h4', '', '', clean(plugin.name, 120) || clean(plugin.id, 120)), el('span', '', 'extension-version', clean(plugin.version, 80)));
        const badge = el('span', '', 'extension-state', plugin.enabled ? '已启用' : '未启用'); badge.dataset.enabled = String(plugin.enabled === true); title.append(badge);
        copy.append(title);
        if (plugin.description) copy.append(el('p', '', 'extensions-description', clean(plugin.description)));
        const permissions = Array.isArray(plugin.permissions) ? plugin.permissions : [];
        copy.append(el('p', '', 'extension-permissions', permissions.length ? `权限：${permissions.map(value => permissionNames[value] || clean(value, 80)).join('、')}` : '权限：无'));
        const actions = el('div', '', 'extension-actions');
        const enable = button('', plugin.enabled ? '停用' : '启用', () => perform('setExtensionEnabled', { id: plugin.id, enabled: !plugin.enabled }));
        enable.dataset.action = 'enable'; enable.setAttribute('aria-label', `${plugin.enabled ? '停用' : '启用'}${clean(plugin.name, 120)}`);
        const open = button('', '打开', () => perform('openExtension', { id: plugin.id })); open.dataset.action = 'open';
        open.disabled = pending || loading || !plugin.enabled;
        const remove = button('', '移除', () => { confirming = plugin.id; render(); }); remove.dataset.action = 'remove';
        enable.disabled = remove.disabled = pending || loading; actions.append(enable, open, remove); row.append(copy, actions);
        if (Array.isArray(plugin.commands) && plugin.commands.length) {
          const commands = el('div', '', 'extension-commands');
          for (const command of plugin.commands) {
            const run = button('', clean(command.title, 120) || clean(command.id, 120), () => perform('runExtensionCommand', { id: plugin.id, command: command.id }));
            run.dataset.command = command.id; run.disabled = pending || loading || !plugin.enabled; commands.append(run);
          }
          row.append(commands);
        }
        if (confirming === plugin.id) {
          const confirmation = el('div', '', 'extension-remove-confirm');
          confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', `移除${clean(plugin.name, 120)}`);
          confirmation.append(el('p', '', '', '移除插件及已安装副本，原始文件夹不受影响。'));
          const confirm = button('', '确认移除', () => perform('removeExtension', { id: plugin.id })); confirm.dataset.action = 'confirm-remove';
          const cancel = button('', '取消', () => { confirming = null; render(); }); cancel.dataset.action = 'cancel-remove';
          confirm.disabled = cancel.disabled = pending || loading; confirmation.append(confirm, cancel); row.append(confirmation);
        }
        list.append(row);
      }
      renderPet();
    }
    function update(value, applyPet = true) {
      if (disposed || !value || !Array.isArray(value.plugins)) return;
      storageError = clean(value.pluginError);
      snapshot = { plugins: value.plugins, pet: applyPet && value.pet || snapshot.pet };
      if (applyPet && value.pet) pet?.update(value.pet);
      render();
    }
    function renderError() {
      error.textContent = actionError || storageError;
      error.hidden = !error.textContent;
    }
    function report(failure) {
      actionError = clean(failure?.message || String(failure), 600).replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/u, '');
      renderError();
    }
    async function refreshState() {
      if (disposed || pending || loading) return;
      loading = true; actionError = ''; render(); const start = revision, petStart = petRevision;
      try { const next = await bridge.getExtensions(); if (!disposed && revision === start) update(next, petRevision === petStart); }
      catch (failure) { if (!disposed) report(failure); }
      finally { loading = false; if (!disposed) render(); }
    }
    async function perform(method, input) {
      if (disposed || pending || loading) return;
      pending = true; actionError = ''; announcement = ''; render(); const start = revision, petStart = petRevision;
      try {
        if (typeof bridge[method] !== 'function') throw new Error('当前版本暂不支持此操作。');
        const next = input === undefined ? await bridge[method]() : await bridge[method](input);
        if (disposed) return;
        if (revision === start) {
          if (Array.isArray(next?.plugins)) update(next, petRevision === petStart);
          else if (Array.isArray(next?.packs) && petRevision === petStart) { updatePet(next); pet?.update(next); }
          else if (next?.pet && petRevision === petStart) { updatePet(next.pet); pet?.update(next.pet); }
        }
        if (method === 'removeExtension') { confirming = null; announcement = '插件已移除。'; }
        else if (method === 'setExtensionEnabled') announcement = input.enabled ? '插件已启用。' : '插件已停用。';
        else if (method === 'installExtension' && next) announcement = '插件已安装，可启用后使用。';
        else if (method === 'petImport' && next) announcement = '宠物已导入。';
        else if (method === 'createExtensionExample' && next?.path) {
          announcement = `示例插件已创建：${clean(next.path, 500)}`;
          notice(announcement);
        }
      } catch (failure) { if (!disposed) report(failure); }
      finally { pending = false; if (!disposed) render(); }
    }
    async function changePet(patch) {
      if (disposed || pending || loading) return;
      pending = true; actionError = ''; render(); const start = petRevision;
      try {
        const next = pet ? await pet.set(patch) : await bridge.setPet(patch);
        if (!disposed && start === petRevision) updatePet(next?.pet || next);
      } catch (failure) { if (!disposed) report(failure); }
      finally { pending = false; if (!disposed) render(); }
    }
    petEnabled.addEventListener('change', () => changePet({ enabled: petEnabled.checked }));
    petWork.addEventListener('change', () => changePet({ workStatus: petWork.checked }));
    petPack.addEventListener('change', () => changePet({ packId: petPack.value }));
    petSize.addEventListener('input', () => { petSizeValue.textContent = `${petSize.value} px`; });
    petSize.addEventListener('change', () => changePet({ size: Number(petSize.value) }));
    const unlistenPet = pet?.subscribe(value => { ++petRevision; updatePet(value); });
    const unsubscribe = bridge.onEvent?.(event => {
      if (event?.type === 'extensions' && event.extensions) { ++revision; update(event.extensions); }
      else if (event?.type === 'pet-state') { ++petRevision; updatePet(event.pet); }
    });
    const ready = refreshState();
    return Object.freeze({ ready, update, refresh: refreshState,
      open({ section } = {}) {
        if (disposed) return;
        actionError = ''; render(); if (!dialog.open) dialog.showModal();
        if (section === 'pet') petSection.scrollIntoView?.({ block: 'nearest' });
      },
      destroy() { if (disposed) return; disposed = true; unsubscribe?.(); unlistenPet?.(); dialog.close(); dialog.remove(); },
    });
  }
  root.ForgeExtensions = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
