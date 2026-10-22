'use strict';

// Keep appearance separate from conversation and model settings. The imported
// image comes only from the native file picker and never enters a model request.
(() => {
  const $ = id => document.getElementById(id);
  const bridge = window.forge;
  const dialog = $('appearance-dialog');
  const colors = window.ForgeConversationColors;
  const presets = window.ForgeBackgroundPresets;
  const colorButtons = [...document.querySelectorAll('#conversation-text-colors [data-text-color]')];
  const presetButtons = [...document.querySelectorAll('#background-preset-options [data-background-preset]')];
  const styleButtons = [...document.querySelectorAll('#ui-style-options [data-ui-style]')];
  const selectionButtons = [...document.querySelectorAll('#selection-color-options [data-selection-color]')];
  const uiStyles = new Set(['glass', 'black', 'white', 'industrial']);
  const normalizeStyle = value => uiStyles.has(value) ? value : 'glass';
  const normalizeSelection = value => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : null;
  const luminance = value => {
    const linear = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const selectionInk = value => {
    const light = luminance(value);
    return (light + 0.05) / 0.05 >= 1.05 / (light + 0.05) ? '#000000' : '#ffffff';
  };
  const readableAccent = (value, style) => {
    // Filled controls keep the exact user color and use selectionInk. Small
    // transparent labels need a readable tint against the material itself.
    const background = { white: '#e8eaed', black: '#171717', industrial: '#2b3138', glass: '#28334b' }[style];
    const backgroundLight = luminance(background);
    const contrast = color => (Math.max(luminance(color), backgroundLight) + 0.05) / (Math.min(luminance(color), backgroundLight) + 0.05);
    if (contrast(value) >= 4.5) return value;
    const target = selectionInk(background) === '#000000' ? 0 : 255;
    const channels = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
    for (let percent = 1; percent <= 100; percent++) {
      const color = '#' + channels.map(channel => Math.round(channel + (target - channel) * percent / 100).toString(16).padStart(2, '0')).join('');
      if (contrast(color) >= 4.5) return color;
    }
    return target ? '#ffffff' : '#000000';
  };
  const settings = [
    { field: 'backgroundTransparency', id: 'background-transparency', initial: 28 },
    { field: 'panelFrost', id: 'panel-frost', initial: 70, filter: '--panel-frost-filter' },
    { field: 'panelTransparency', id: 'panel-transparency', initial: 30, opacity: '--panel-opacity' },
    { field: 'conversationTextColor', kind: 'color', initial: 'white' },
    { field: 'backgroundPreset', kind: 'preset', initial: 'aurora' },
    { field: 'uiStyle', kind: 'style', initial: 'glass' },
    { field: 'selectionColor', id: 'selection-color-input', kind: 'selection', initial: null },
  ].map(setting => ({ ...setting, control: setting.id ? $(setting.id) : null, value: setting.initial, dirty: false, revision: 0, queuedRevision: -1 }));
  const defaultImage = 'url("./aurora-background.svg")';
  const rules = new Map();
  let persisted = { backgroundImage: null, backgroundName: '', ...Object.fromEntries(settings.map(({ field, initial }) => [field, initial])) };
  let mutationBusy = false;
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
      ...Object.fromEntries(settings.map(({ field, initial, kind }) => [field,
        kind === 'color' ? colors.normalize(value?.[field]) : kind === 'preset' ? presets.normalize(value?.[field])
          : kind === 'style' ? normalizeStyle(value?.[field])
          : kind === 'selection' ? normalizeSelection(value?.[field])
          : Number.isInteger(value?.[field]) && value[field] >= 0 && value[field] <= 100 ? value[field] : initial])),
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
    const uiStyle = settings.find(setting => setting.kind === 'style').value;
    document.documentElement.dataset.uiStyle = uiStyle;
    $('glass-appearance-settings').hidden = uiStyle !== 'glass';
    for (const button of styleButtons) button.setAttribute('aria-pressed', String(button.dataset.uiStyle === uiStyle));
    const selectedPreset = settings.find(setting => setting.kind === 'preset');
    const preset = presets.get(selectedPreset.value);
    const imported = !!persisted.backgroundImage && !selectedPreset.dirty;
    document.documentElement.classList.toggle('custom-background', imported);
    const image = imported ? `url("${persisted.backgroundImage}")` : preset.image || defaultImage;
    const background = ruleFor('#app-background');
    background?.style.setProperty('background-image', image);
    background?.style.setProperty('--background-opacity', String((100 - settings[0].value) / 100));
    ruleFor('.appearance-preview')?.style.setProperty('background-image', image);
    const root = ruleFor(':root');
    for (const setting of settings) {
      if (setting.kind === 'style') continue;
      if (setting.kind === 'selection') {
        const color = setting.value || '#7aa7ff';
        document.documentElement.dataset.selectionColor = setting.value ? 'custom' : 'default';
        root?.style.setProperty('--custom-selection-color', color);
        root?.style.setProperty('--custom-selection-ink', selectionInk(color));
        root?.style.setProperty('--custom-accent-text', readableAccent(color, uiStyle));
        setting.control.value = color;
        $('selection-color-value').value = setting.value ? color.toUpperCase() : '默认';
        for (const button of selectionButtons) button.setAttribute('aria-pressed', String(button.dataset.selectionColor === setting.value));
        continue;
      }
      if (setting.kind === 'preset') {
        for (const button of presetButtons) button.setAttribute('aria-pressed', String(!imported && button.dataset.backgroundPreset === setting.value));
        continue;
      }
      if (setting.kind === 'color') {
        root?.style.setProperty('--conversation-text-color', colors.color(setting.value));
        for (const button of colorButtons) button.setAttribute('aria-pressed', String(button.dataset.textColor === setting.value));
        continue;
      }
      setting.control.value = String(setting.value);
      $(setting.id + '-value').value = `${setting.value}%`;
      setting.control.setAttribute('aria-valuetext', `${setting.value}% ${setting.filter ? '磨砂' : '透明'}`);
      if (setting.filter) {
        const blur = Number((setting.value * 0.4).toFixed(1));
        const saturation = Number((100 + setting.value * 4 / 7).toFixed(2));
        root?.style.setProperty(setting.filter, setting.value ? `blur(${blur}px) saturate(${saturation}%)` : 'none');
      }
      if (setting.opacity) root?.style.setProperty(setting.opacity, String((100 - setting.value) / 100));
    }
    $('background-name').textContent = imported ? persisted.backgroundName : preset.name;
    $('background-description').textContent = imported
      ? '已保存在本机，应用于左侧栏、会话区和右侧窗口。'
      : preset.description;
  }

  function apply(value) {
    persisted = normalize(value);
    for (const setting of settings) if (!setting.dirty) setting.value = persisted[setting.field];
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
    $('frost-reset').disabled = value;
    $('selection-color-reset').disabled = value;
    for (const setting of settings) if (setting.control) setting.control.disabled = value;
    for (const button of colorButtons) button.disabled = value;
    for (const button of presetButtons) button.disabled = value;
    for (const button of styleButtons) button.disabled = value;
    for (const button of selectionButtons) button.disabled = value;
    dialog.setAttribute('aria-busy', String(value));
  }

  function saveSettings() {
    clearTimeout(saveTimer);
    const pending = settings.filter(setting => setting.dirty && setting.revision !== setting.queuedRevision)
      .map(setting => ({ setting, value: setting.value, token: setting.revision }));
    if (!pending.length) return saveQueue;
    for (const { setting, token } of pending) setting.queuedRevision = token;
    const patch = Object.fromEntries(pending.map(({ setting, value }) => [setting.field, value]));
    saveQueue = saveQueue.then(async () => {
      try {
        if (!bridge?.setAppearance) throw new Error('请在 Synora code 桌面软件中保存外观设置。');
        const eventsAtRequest = appearanceEvents;
        const next = await bridge.setAppearance(patch);
        for (const { setting, token } of pending) if (token === setting.revision) setting.dirty = false;
        acceptReply(next, eventsAtRequest);
      } catch (error) {
        let reverted = false;
        for (const { setting, token } of pending) {
          if (token !== setting.revision) continue;
          setting.dirty = false;
          setting.value = persisted[setting.field];
          reverted = true;
        }
        if (reverted) {
          render();
          status(readableError(error, '外观保存失败，请重试。'), true);
        }
      }
    });
    return saveQueue;
  }

  async function settled() {
    await ready;
    // Edits made while an older save is in flight must be flushed as well.
    let pending;
    do {
      pending = saveSettings();
      await pending;
    } while (pending !== saveQueue || settings.some(setting => setting.dirty && setting.revision !== setting.queuedRevision));
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
      acceptReply(next, eventsAtRequest);
      if (before !== persisted.backgroundImage) status(persisted.uiStyle === 'glass'
        ? '背景图已导入，重启后仍会保留。' : '背景图已保存，切换为玻璃风后显示。');
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
      acceptReply(next, eventsAtRequest);
      status('已恢复默认背景和透明度。');
    } catch (error) { status(readableError(error, '恢复默认背景失败，请重试。'), true); }
    finally { setBusy(false); }
  }

  function edit(setting, value) {
    setting.value = setting.kind === 'color' ? colors.normalize(value) : setting.kind === 'preset' ? presets.normalize(value)
      : setting.kind === 'style' ? normalizeStyle(value)
      : setting.kind === 'selection' ? normalizeSelection(value)
      : Math.max(0, Math.min(100, Math.round(value)));
    setting.dirty = true;
    ++setting.revision;
    render();
    status();
  }

  async function resetFrost() {
    if (mutationBusy) return;
    setBusy(true);
    status();
    try {
      await settled();
      for (const setting of settings.filter(value => value.filter)) edit(setting, setting.initial);
      await saveSettings();
    } finally { setBusy(false); }
  }

  for (const button of colorButtons) button.addEventListener('click', () => {
    if (mutationBusy) return;
    edit(settings.find(setting => setting.kind === 'color'), button.dataset.textColor);
    saveSettings();
  });
  for (const button of presetButtons) button.addEventListener('click', () => {
    if (mutationBusy) return;
    edit(settings.find(setting => setting.kind === 'preset'), button.dataset.backgroundPreset);
    saveSettings();
  });
  for (const button of styleButtons) button.addEventListener('click', () => {
    if (mutationBusy) return;
    edit(settings.find(setting => setting.kind === 'style'), button.dataset.uiStyle);
    saveSettings();
  });
  for (const button of selectionButtons) button.addEventListener('click', () => {
    if (mutationBusy) return;
    edit(settings.find(setting => setting.kind === 'selection'), button.dataset.selectionColor);
    saveSettings();
  });
  $('selection-color-reset').addEventListener('click', () => {
    if (mutationBusy) return;
    edit(settings.find(setting => setting.kind === 'selection'), null);
    saveSettings();
  });
  for (const setting of settings.filter(value => value.control)) {
    setting.control.addEventListener('input', () => {
      if (mutationBusy) return;
      edit(setting, setting.kind === 'selection' ? setting.control.value : Number(setting.control.value));
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveSettings, 250);
    });
    setting.control.addEventListener('change', saveSettings);
  }
  $('frost-reset').addEventListener('click', resetFrost);
  $('background-import').addEventListener('click', importBackground);
  $('background-reset').addEventListener('click', resetBackground);
  $('appearance-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { saveSettings(); });
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
