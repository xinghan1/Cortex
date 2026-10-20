'use strict';

// Keep appearance separate from conversation and model settings. The imported
// image comes only from the native file picker and never enters a model request.
(() => {
  const $ = id => document.getElementById(id);
  const bridge = window.forge;
  const dialog = $('appearance-dialog');
  const slider = $('background-transparency');
  const defaultImage = 'url("./aurora-background.svg")';
  const rules = new Map();
  let persisted = { backgroundImage: null, backgroundName: '', backgroundTransparency: 28 };
  let desiredTransparency = 28;
  let editing = false;
  let mutationBusy = false;
  let revision = 0;
  let queuedRevision = -1;
  let appearanceEvents = 0;
  let saveTimer;
  let saveQueue = Promise.resolve();

  function ruleFor(selector) {
    if (rules.has(selector)) return rules.get(selector);
    for (const sheet of document.styleSheets) {
      try {
        const rule = [...sheet.cssRules].find(value => value.selectorText === selector);
        if (rule) { rules.set(selector, rule); return rule; }
      } catch { /* Only bundled, readable stylesheets are used. */ }
    }
    return null;
  }

  function normalize(value) {
    const image = typeof value?.backgroundImage === 'string'
      && value.backgroundImage.length <= 18 * 1024 * 1024
      && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.backgroundImage)
      ? value.backgroundImage : null;
    return {
      backgroundImage: image,
      backgroundName: image && typeof value.backgroundName === 'string' ? value.backgroundName : '',
      backgroundTransparency: Number.isInteger(value?.backgroundTransparency)
        && value.backgroundTransparency >= 0 && value.backgroundTransparency <= 100
        ? value.backgroundTransparency : 28,
    };
  }

  function status(message = '', error = false) {
    $('appearance-status').textContent = message;
    $('appearance-status').hidden = !message;
    $('appearance-status').classList.toggle('error', error);
  }

  function readableError(error, fallback) {
    return (error?.message || fallback).replace(/^Error invoking remote method ['"]forge:[^'"]+['"]:\s*(?:Error:\s*)?/u, '');
  }

  function render() {
    document.documentElement.classList.toggle('custom-background', !!persisted.backgroundImage);
    const image = persisted.backgroundImage ? `url("${persisted.backgroundImage}")` : defaultImage;
    const background = ruleFor('#app-background');
    background?.style.setProperty('background-image', image);
    background?.style.setProperty('--background-opacity', String((100 - desiredTransparency) / 100));
    ruleFor('.appearance-preview')?.style.setProperty('background-image', image);
    slider.value = String(desiredTransparency);
    $('background-transparency-value').value = `${desiredTransparency}%`;
    slider.setAttribute('aria-valuetext', `${desiredTransparency}% 透明`);
    $('background-name').textContent = persisted.backgroundName || '极光 · 默认背景';
    $('background-description').textContent = persisted.backgroundImage
      ? '已保存在本机，应用于左侧栏、会话区和右侧窗口。'
      : '柔和蓝紫渐变，专注于眼前的创作。';
  }

  function apply(value) {
    persisted = normalize(value);
    if (!editing) desiredTransparency = persisted.backgroundTransparency;
    render();
  }

  // Another window may publish a newer value while an IPC reply is in flight.
  // Events arrive in commit order, so never replace one with an older reply.
  function acceptReply(value, eventsAtRequest) {
    apply(appearanceEvents === eventsAtRequest ? value : persisted);
  }

  function setBusy(value) {
    mutationBusy = value;
    $('background-import').disabled = value;
    $('background-reset').disabled = value;
    slider.disabled = value;
    dialog.setAttribute('aria-busy', String(value));
  }

  function saveTransparency() {
    clearTimeout(saveTimer);
    if (!editing) return saveQueue;
    const value = desiredTransparency;
    const token = revision;
    if (token === queuedRevision) return saveQueue;
    queuedRevision = token;
    saveQueue = saveQueue.then(async () => {
      try {
        if (!bridge?.setAppearance) throw new Error('请在 Synora code 桌面软件中保存外观设置。');
        const eventsAtRequest = appearanceEvents;
        const next = await bridge.setAppearance({ backgroundTransparency: value });
        if (token === revision) editing = false;
        acceptReply(next, eventsAtRequest);
        if (token === revision) status('外观已自动保存。');
      } catch (error) {
        if (token === revision) {
          editing = false;
          desiredTransparency = persisted.backgroundTransparency;
          render();
          status(readableError(error, '外观保存失败，请重试。'), true);
        }
      }
    });
    return saveQueue;
  }

  async function settled() {
    await ready;
    await saveTransparency();
    await saveQueue;
  }

  async function open() {
    await ready;
    if (!dialog.open) dialog.showModal();
  }

  async function importBackground() {
    if (mutationBusy) return;
    await open();
    if (mutationBusy) return;
    setBusy(true);
    status();
    try {
      await settled();
      if (!bridge?.importBackground) throw new Error('请在 Synora code 桌面软件中导入背景图。');
      const before = persisted.backgroundImage;
      const eventsAtRequest = appearanceEvents;
      const next = await bridge.importBackground();
      editing = false;
      acceptReply(next, eventsAtRequest);
      if (before !== persisted.backgroundImage) status('背景图已导入，重启后仍会保留。');
    } catch (error) { status(readableError(error, '背景图导入失败，请重试。'), true); }
    finally { setBusy(false); }
  }

  async function resetBackground() {
    if (mutationBusy) return;
    setBusy(true);
    status();
    try {
      await settled();
      if (!bridge?.resetBackground) throw new Error('请在 Synora code 桌面软件中修改背景。');
      const eventsAtRequest = appearanceEvents;
      const next = await bridge.resetBackground();
      editing = false;
      acceptReply(next, eventsAtRequest);
      status('已恢复默认背景和透明度。');
    } catch (error) { status(readableError(error, '恢复默认背景失败，请重试。'), true); }
    finally { setBusy(false); }
  }

  slider.addEventListener('input', () => {
    desiredTransparency = Number(slider.value);
    editing = true;
    ++revision;
    render();
    status();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveTransparency, 250);
  });
  slider.addEventListener('change', saveTransparency);
  $('background-import').addEventListener('click', importBackground);
  $('background-reset').addEventListener('click', resetBackground);
  $('appearance-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { saveTransparency(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  bridge?.onEvent?.(event => {
    if (event.type === 'appearance') { ++appearanceEvents; apply(event.appearance); }
  });
  render();
  const ready = (async () => {
    try {
      if (bridge?.getAppearance) {
        const eventsAtRequest = appearanceEvents;
        acceptReply(await bridge.getAppearance(), eventsAtRequest);
      }
    }
    catch { status('外观读取失败，当前使用默认背景。可重新导入背景图。', true); }
  })();
  window.synoraAppearance = Object.freeze({ open, importBackground, apply, ready, settled });
})();
