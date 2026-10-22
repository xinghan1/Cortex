'use strict';
const { randomUUID } = require('node:crypto');

function buildEditingMenuTemplate(params, webContents, validate = async () => true) {
  const flags = params.editFlags || {};
  const editable = params.isEditable === true;
  const action = (id, label, accelerator, enabled) => ({ id, label, accelerator, enabled: Boolean(enabled), click: async () => {
    if (!enabled || webContents.isDestroyed()) return;
    try {
      if (!await validate() || webContents.isDestroyed()) return;
      webContents.focus(); webContents[id]();
    } catch { /* A stale/closing editor cannot redirect an edit into another field. */ }
  } });
  const selected = typeof params.selectionText === 'string' && params.selectionText.length > 0;
  const items = [];
  if (editable) items.push(
    action('undo', '撤销', 'Ctrl+Z', flags.canUndo), action('redo', '重做', 'Ctrl+Y', flags.canRedo), { type: 'separator' },
    action('cut', '剪切', 'Ctrl+X', flags.canCut),
  );
  items.push(action('copy', '复制', 'Ctrl+C', flags.canCopy && selected));
  if (editable) items.push(action('paste', '粘贴', 'Ctrl+V', flags.canPaste), action('delete', '删除', 'Delete', flags.canDelete), { type: 'separator' });
  items.push(action('selectAll', '全选', 'Ctrl+A', flags.canSelectAll));
  return items;
}

function installEditorContextMenu({ win, Menu }) {
  const contents = win.webContents;
  const guardKey = JSON.stringify(`__forgeEditorContext_${randomUUID()}`);
  let generation = 0;
  const onContextMenu = async (event, params) => {
    const current = ++generation;
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || contents.isDestroyed()) return;
    try {
      // A main-window text editor only. File-tree and browser menus keep their
      // own behavior; no renderer string is evaluated as a command or selector.
      const target = await contents.executeJavaScript(`/* forge-editor-context: capture */ (() => {
        window[${guardKey}]?.dispose();
        delete window[${guardKey}];
        const node=document.elementFromPoint(${JSON.stringify(params.x)},${JSON.stringify(params.y)});
        const editor=document.getElementById('file-content');
        const host=editor?.closest('.file-code-editor');
        if(!host||node?.closest('.file-code-editor')!==host||document.activeElement!==editor)return null;
        const path=typeof selectedPath==='undefined'?null:selectedPath;
        const epoch=typeof editorDocumentEpoch==='undefined'?null:editorDocumentEpoch;
        const version=typeof editorVersion==='undefined'?null:editorVersion;
        const value=editor.value,start=editor.selectionStart,end=editor.selectionEnd,direction=editor.selectionDirection;
        const readOnly=editor.readOnly,disabled=editor.disabled;
        let changed=false;
        const markChanged=()=>{changed=true;};
        editor.addEventListener('input',markChanged);
        window[${guardKey}]={
          valid:()=>!changed&&editor.isConnected&&document.getElementById('file-content')===editor
            &&document.activeElement===editor&&editor.closest('.file-code-editor')===host
            &&editor.value===value&&editor.selectionStart===start&&editor.selectionEnd===end&&editor.selectionDirection===direction
            &&editor.readOnly===readOnly&&editor.disabled===disabled
            &&(typeof selectedPath==='undefined'?null:selectedPath)===path
            &&(typeof editorDocumentEpoch==='undefined'?null:editorDocumentEpoch)===epoch
            &&(typeof editorVersion==='undefined'?null:editorVersion)===version,
          dispose:()=>{changed=true;editor.removeEventListener('input',markChanged);}
        };
        return {readOnly:readOnly||disabled};
      })()`);
      if (!target || current !== generation || contents.isDestroyed() || win.isDestroyed()) return;
      const validate = async () => {
        if (current !== generation || contents.isDestroyed() || win.isDestroyed()) return false;
        const valid = await contents.executeJavaScript(`/* forge-editor-context: validate */ Boolean(window[${guardKey}]?.valid())`);
        return valid === true && current === generation && !contents.isDestroyed() && !win.isDestroyed();
      };
      if (!await validate()) return;
      event.preventDefault();
      const menu = Menu.buildFromTemplate(buildEditingMenuTemplate({ ...params, isEditable: params.isEditable && !target.readOnly }, contents, validate));
      menu.popup({ window: win });
    } catch { /* A closing/navigating editor cannot open a stale native menu. */ }
  };
  contents.on('context-menu', onContextMenu);
  return () => {
    ++generation; contents.removeListener('context-menu', onContextMenu);
    if (!contents.isDestroyed()) void contents.executeJavaScript(`window[${guardKey}]?.dispose();delete window[${guardKey}];`).catch(() => {});
  };
}

module.exports = { buildEditingMenuTemplate, installEditorContextMenu };
