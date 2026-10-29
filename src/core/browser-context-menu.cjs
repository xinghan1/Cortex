'use strict';
const { randomUUID } = require('node:crypto');

// A short-lived isolated-world snapshot prevents a menu opened on one field
// from editing a different field after focus, selection, content, or page changes.
function installBrowserContextMenu({ contents, window, Menu, isCurrent, getPageVersion = () => 0 }) {
  const token = JSON.stringify('__synoraBrowserMenu_' + randomUUID());
  let generation = 0;
  const current = serial => serial === generation && !contents.isDestroyed() && !window.isDestroyed() && isCurrent();
  const onMenu = async (event, params) => {
    const serial = ++generation, pageVersion = getPageVersion();
    const validPage = () => current(serial) && getPageVersion() === pageVersion;
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || !validPage()) return;
    if (params.inputFieldType === 'password') return;
    const flags = params.editFlags || {}, editable = params.isEditable === true;
    const choices = editable ? [['undo','撤销','canUndo'],['redo','重做','canRedo'],['cut','剪切','canCut'],['copy','复制','canCopy'],['paste','粘贴','canPaste'],['delete','删除','canDelete'],['selectAll','全选','canSelectAll']]
      : [['copy','复制','canCopy'],['selectAll','全选','canSelectAll']];
    if (!choices.some(([, , flag]) => flags[flag])) return;
    const script = `(()=>{globalThis[${token}]?.dispose();const n=document.elementFromPoint(${JSON.stringify(params.x)},${JSON.stringify(params.y)}),a=document.activeElement,e=${editable};if(!n||n.closest('input[type=password],input[type=file]'))return false;if(e&&(!a||!(a===n||a.contains(n))||a.matches('input[type=password],input[type=file]')))return false;const v=e&&typeof a.value==='string'?a.value:null,s=e&&typeof a.selectionStart==='number'?a.selectionStart:null,t=e&&typeof a.selectionEnd==='number'?a.selectionEnd:null,selected=String(window.getSelection());let changed=false;const onInput=()=>{changed=true};if(e)a.addEventListener('input',onInput);globalThis[${token}]={valid:()=>!changed&&document.activeElement===a&&a?.isConnected&&(!e||((typeof a.value!=='string'||a.value===v)&&(s===null||a.selectionStart===s&&a.selectionEnd===t)))&&String(window.getSelection())===selected,dispose:()=>{changed=true;if(e)a.removeEventListener('input',onInput)}};return true})()`;
    try {
      if (!await contents.executeJavaScriptInIsolatedWorld(1902, [{ code: script }]) || !validPage()) return;
      event.preventDefault();
      const menu = Menu.buildFromTemplate(choices.map(([id,label,flag]) => ({ label, enabled: Boolean(flags[flag]), click: async () => {
        if (!validPage()) return;
        try {
          const valid = await contents.executeJavaScriptInIsolatedWorld(1902, [{ code: `Boolean(globalThis[${token}]?.valid())` }]);
          if (!valid || !validPage()) return;
          contents.focus(); contents[id]();
        } catch { /* Page navigated or closed. */ }
      } })));
      menu.popup({ window });
    } catch { /* Do not open a menu against a stale or inaccessible page. */ }
  };
  contents.on('context-menu', onMenu);
  return () => { generation++; contents.removeListener('context-menu', onMenu); };
}
module.exports = { installBrowserContextMenu };
