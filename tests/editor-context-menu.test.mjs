import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';

const { buildEditingMenuTemplate, installEditorContextMenu } = createRequire(import.meta.url)('../src/core/editor-context-menu.cjs');
const flags = { canUndo:true,canRedo:false,canCut:true,canCopy:true,canPaste:true,canDelete:true,canSelectAll:true };
const actions = items => items.filter(item => item.type !== 'separator');

test('native menu respects editable selection and disabled operations', async () => {
  const calls = [], contents = { isDestroyed:() => false, focus:() => calls.push('focus'), cut:() => calls.push('cut') };
  const items = actions(buildEditingMenuTemplate({ isEditable:true, selectionText:'code', editFlags:flags }, contents));
  assert.deepEqual(items.map(item => item.id), ['undo','redo','cut','copy','paste','delete','selectAll']);
  assert.equal(items.find(item => item.id === 'redo').enabled, false);
  await items.find(item => item.id === 'redo').click(); assert.deepEqual(calls, []);
  await items.find(item => item.id === 'cut').click(); assert.deepEqual(calls, ['focus','cut']);
  assert.equal(actions(buildEditingMenuTemplate({ isEditable:true, selectionText:'', editFlags:flags }, contents)).find(item => item.id === 'copy').enabled, false);
});

test('read-only source exposes copy and select all without mutation commands', async () => {
  const contents = { isDestroyed:() => true, focus:() => assert.fail('destroyed contents must not focus') };
  const items = actions(buildEditingMenuTemplate({ isEditable:false, selectionText:'read only', editFlags:flags }, contents));
  assert.deepEqual(items.map(item => item.id), ['copy','selectAll']);
  assert.equal(items[0].enabled, true); await items[0].click();
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ holdCapture = false } = {}) {
  const contents = new EventEmitter(), checks = [], templates = [], popups = [], calls = [];
  const host = {};
  const editor = Object.assign(new EventTarget(), { value:'PRIVATE_FILE_SOURCE',selectionStart:0,selectionEnd:7,selectionDirection:'forward',
    readOnly:false,disabled:false,isConnected:true,closest:() => host });
  const document = { activeElement:editor, getElementById:() => editor, elementFromPoint:() => editor };
  const context = createContext({ window:{},document,selectedPath:'sample.txt',editorDocumentEpoch:1,editorVersion:'version-one' });
  contents.isDestroyed = () => false;
  contents.executeJavaScript = code => {
    const result = runInContext(code,context);
    if (holdCapture && code.startsWith('/* forge-editor-context: capture */'))
      return new Promise(resolve => checks.push(() => resolve(result)));
    return Promise.resolve(result);
  };
  contents.focus = () => calls.push('focus');
  for (const id of ['copy','cut','paste','delete','undo','redo','selectAll']) contents[id] = () => calls.push(id);
  const win = { webContents:contents,isDestroyed:() => false };
  const Menu = { buildFromTemplate:template => { templates.push(template); return { popup:options => popups.push(options) }; } };
  const dispose = installEditorContextMenu({ win,Menu });
  let prevented = 0;
  const event = { preventDefault:() => prevented++ }, params = { x:10,y:10,isEditable:true,selectionText:'code',editFlags:flags };
  return { contents,editor,document,context,checks,templates,popups,calls,win,dispose,
    open:() => contents.emit('context-menu',event,params), prevented:() => prevented };
}

test('native listener ignores unrelated DOM and invalidates older asynchronous target checks', async () => {
  const f=fixture({holdCapture:true});
  f.open(); f.editor.readOnly=true; f.open();
  f.checks[1](); await tick(); f.checks[0](); await tick();
  assert.equal(f.prevented(),1); assert.equal(f.popups.length,1); assert.equal(f.popups[0].window,f.win);
  assert.deepEqual(actions(f.templates[0]).map(item => item.id),['copy','selectAll']);
  f.document.elementFromPoint=() => null;
  f.open(); f.checks[2](); await tick(); assert.equal(f.popups.length,1);
  f.document.elementFromPoint=() => f.editor;
  f.open(); f.dispose(); f.checks[3](); await tick();
  assert.equal(f.popups.length,1); assert.equal(f.contents.listenerCount('context-menu'),0);
});

test('a focus change during asynchronous target confirmation prevents the popup', async () => {
  const f=fixture({holdCapture:true});
  f.open(); f.document.activeElement={id:'task-input'};
  f.checks[0](); await tick();
  assert.equal(f.popups.length,0); assert.equal(f.prevented(),0); f.dispose();
});

test('menu callbacks recheck focus, selection, content, current file, epoch, version and readonly before any native command', async () => {
  const changes = [
    f=>{f.document.activeElement={id:'task-input'};}, f=>{f.editor.selectionEnd=8;}, f=>{f.editor.value+=' changed';},
    f=>{f.context.selectedPath='another.txt';}, f=>{f.context.editorDocumentEpoch++;}, f=>{f.context.editorVersion='version-two';},
    f=>{f.editor.readOnly=true;}, f=>{f.editor.disabled=true;}, f=>{f.document.getElementById=()=>({...f.editor});},
    f=>{f.editor.dispatchEvent(new Event('input'));},
  ];
  for (const change of changes) {
    const f=fixture(); f.open(); await tick(); assert.equal(f.popups.length,1);
    const paste=f.templates[0].find(item=>item.id==='paste'); assert.equal(paste.enabled,true);
    change(f); await paste.click(); assert.deepEqual(f.calls,[]); f.dispose();
  }
});

test('a valid readonly selection uses native copy without focusing another field or altering selection', async () => {
  const f=fixture(); f.editor.readOnly=true;
  f.open(); await tick();
  assert.deepEqual(actions(f.templates[0]).map(item=>item.id),['copy','selectAll']);
  await f.templates[0].find(item=>item.id==='copy').click();
  assert.deepEqual(f.calls,['focus','copy']);
  assert.equal(f.document.activeElement,f.editor); assert.equal(f.editor.selectionStart,0); assert.equal(f.editor.selectionEnd,7);
  assert.equal(f.editor.value,'PRIVATE_FILE_SOURCE');
  f.dispose(); await f.templates[0].find(item=>item.id==='copy').click(); assert.deepEqual(f.calls,['focus','copy']);
});
