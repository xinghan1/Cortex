'use strict';
(function (root) {
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
      const node = el('button', id, className, label); node.type = 'button'; node.addEventListener('click', action); return node;
    };
    const dialog = el('dialog', 'pet-settings-dialog', 'settings-dialog pet-settings-dialog');
    dialog.setAttribute('aria-labelledby', 'pet-settings-title');
    const header = el('div', '', 'dialog-header');
    const close = button('pet-settings-close', '×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', '关闭宠物设置');
    header.append(el('h2', 'pet-settings-title', '', '宠物'), close);
    const error = el('p', 'pet-settings-error', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const status = el('p', 'pet-settings-status', 'pet-settings-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const enabled = el('input', 'pet-settings-enabled'); enabled.type = 'checkbox';
    const enabledLabel = el('label', '', 'pet-settings-check'); enabledLabel.append(enabled, el('span', '', '', '显示宠物'));
    const work = el('input', 'pet-settings-work'); work.type = 'checkbox';
    const workLabel = el('label', '', 'pet-settings-check'); workLabel.append(work, el('span', '', '', '跟随任务状态切换动作'));
    const follow = el('input', 'pet-settings-follow'); follow.type = 'checkbox';
    const followLabel = el('label', '', 'pet-settings-check'); followLabel.append(follow, el('span', '', '', '空闲时眼睛跟随鼠标'));
    const packLabel = el('label', '', 'pet-settings-field-label', '宠物'); packLabel.htmlFor = 'pet-settings-pack';
    const pack = el('select', 'pet-settings-pack', 'pet-settings-select');
    const sizeLabel = el('label', '', 'pet-settings-field-label', '大小'); sizeLabel.htmlFor = 'pet-settings-size';
    const sizeRow = el('div', '', 'pet-settings-size-row');
    const size = el('input', 'pet-settings-size'); size.type = 'range'; size.min = '80'; size.max = '600'; size.step = '10';
    const sizeValue = el('output', 'pet-settings-size-value'); sizeValue.htmlFor = 'pet-settings-size'; sizeRow.append(size, sizeValue);
    const credit = el('p', 'pet-settings-credit', 'pet-settings-credit');
    const actions = el('div', '', 'pet-settings-actions');
    const reset = button('pet-settings-reset', '重置位置', () => perform({ x: 1, y: 1 }));
    const importPet = button('pet-settings-import', '导入 DSH 宠物…', () => perform(null)); actions.append(reset, importPet);
    dialog.append(header, status, error, enabledLabel, workLabel, followLabel, packLabel, pack, sizeLabel, sizeRow, actions, credit); document.body.append(dialog);
    let snapshot = null, pending = false, loading = false, disposed = false, revision = 0, announcement = '', failure = '';
    const fields = [enabled, work, follow, pack, size, reset, importPet];
    function render() {
      if (disposed) return;
      status.textContent = loading ? '正在读取…' : pending ? '正在保存…' : announcement;
      dialog.setAttribute('aria-busy', String(pending || loading));
      error.textContent = failure; error.hidden = !failure;
      for (const field of fields) field.disabled = pending || loading || !snapshot;
      if (!snapshot) return;
      enabled.checked = snapshot.enabled === true; work.checked = snapshot.workStatus !== false; follow.checked = snapshot.followCursor !== false;
      pack.replaceChildren();
      for (const value of snapshot.packs) {
        const option = el('option', '', '', clean(value.name, 120) || clean(value.id, 120)); option.value = value.id; pack.append(option);
      }
      pack.value = snapshot.packId || snapshot.packs[0]?.id || '';
      size.value = String(snapshot.size || 220); sizeValue.textContent = `${snapshot.size || 220} px`;
      const selected = snapshot.packs.find(value => value.id === pack.value);
      credit.textContent = selected ? `${clean(selected.name, 120)}${selected.license ? ' · ' + clean(selected.license, 120) : ''}` : '';
      pack.disabled = reset.disabled = pending || loading || !snapshot.packs.length;
      follow.disabled = pending || loading || selected?.id !== 'dsh-pet';
      follow.title = selected?.id === 'dsh-pet' ? '' : '此宠物包未提供眼睛定位';
    }
    function update(value) {
      if (disposed || !value || !Array.isArray(value.packs)) return;
      snapshot = value; render();
    }
    function report(error) {
      failure = clean(error?.message || String(error)).replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/u, ''); render();
    }
    async function load() {
      loading = true; failure = ''; render(); const start = revision;
      try { const next = await bridge.petState(); if (!disposed && revision === start) update(next?.pet || next); }
      catch (error) { if (!disposed) report(error); }
      finally { loading = false; if (!disposed) render(); }
    }
    async function perform(patch) {
      if (disposed || pending || loading) return;
      pending = true; failure = ''; announcement = ''; render(); const start = revision;
      try {
        const next = patch === null ? await bridge.petImport() : pet ? await pet.set(patch) : await bridge.setPet(patch);
        if (disposed) return;
        if (revision === start) { update(next?.pet || next); pet?.update(next?.pet || next); }
        if (patch === null && next) announcement = '宠物已导入。';
      } catch (error) { if (!disposed) report(error); }
      finally { pending = false; if (!disposed) render(); }
    }
    enabled.addEventListener('change', () => perform({ enabled: enabled.checked }));
    work.addEventListener('change', () => perform({ workStatus: work.checked }));
    follow.addEventListener('change', () => perform({ followCursor: follow.checked }));
    pack.addEventListener('change', () => perform({ packId: pack.value }));
    size.addEventListener('input', () => { sizeValue.textContent = `${size.value} px`; });
    size.addEventListener('change', () => perform({ size: Number(size.value) }));
    const unlistenPet = pet?.subscribe(value => { ++revision; update(value); });
    const unsubscribe = bridge.onEvent?.(event => { if (event?.type === 'pet-state') { ++revision; update(event.pet); } });
    const ready = load();
    return Object.freeze({ ready, update,
      open() { if (disposed) return; failure = ''; render(); if (!dialog.open) dialog.showModal(); },
      destroy() { if (disposed) return; disposed = true; unsubscribe?.(); unlistenPet?.(); dialog.close(); dialog.remove(); },
    });
  }
  root.ForgePetSettings = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
