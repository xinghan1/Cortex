// Native right-click -> real Electron Menu -> real editing commands. Menu
// selection is automated through its actual MenuItem callback after closePopup.
// Clipboard is seeded with fixture text before any read; no prior data is read.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, Menu, clipboard } = require('electron');

module.exports = async function smokeEditorContextMenu({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), project = path.join(dataDir, 'editor-context-' + nonce);
  const source = 'ALPHA BETA\nGAMMA DELTA\n', seed = 'CONTEXT_MENU_FIXTURE_' + nonce;
  const originalBuild = Menu.buildFromTemplate, menus = [], nativeContexts = [];
  let child, stage = 'isolated editor setup', clipboardSeeded = false;
  const js = code => child.webContents.executeJavaScript(code);
  const call = (name, value) => js(`window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Editor context menu smoke timed out: ' + label);
  };
  const inspect = () => js(`(() => {const input=$('file-content');return {value:input.value,start:input.selectionStart,end:input.selectionEnd,
    readOnly:input.readOnly,active:document.activeElement===input,dirty:editorDirty,saving:editorSaving,
    mirror:$('file-highlight-code').textContent.replace(/\u200b$/,''),lines:Number($('file-line-numbers').dataset.totalLines),
    events:window.__editorContextSmoke.inputs};})()`);
  const saved = async expected => until('actual editor and saved file ' + JSON.stringify(expected), async () => {
    const value = await inspect(); return value.value === expected && !value.dirty && !value.saving
      && await fs.readFile(path.join(project, 'sample.txt'), 'utf8') === expected && value;
  });
  const click = async selector => {
    await until('visible control ' + selector, () => js(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`));
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered editor smoke target');return p;})()`);
    child.webContents.focus();
    child.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    child.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await wait(45);
  };
  const right = async (start, end) => {
    const before = menus.length, eventsBefore = nativeContexts.length;
    const point = await js(`(() => {const input=$('file-content');input.focus();input.setSelectionRange(${start},${end});input.scrollTop=0;input.scrollLeft=0;
      const r=input.getBoundingClientRect(),style=getComputedStyle(input),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;
      const prefix=input.value.slice(0,Math.min(${end},${start}+1)),x=r.left+parseFloat(style.paddingLeft)+context.measureText(prefix).width+1,
      y=r.top+parseFloat(style.paddingTop)+parseFloat(style.lineHeight)/2;
      if(document.elementFromPoint(x,y)!==input)throw new Error('Native right-click does not hit file-content');return {x:Math.round(x),y:Math.round(y)};})()`);
    child.webContents.focus();
    child.webContents.sendInputEvent({type:'mouseMove',...point});
    child.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...point});
    child.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...point});
    const record = await until('real Electron code menu', () => menus.length > before && menus.at(-1).closed && menus.at(-1));
    await wait(200);
    assert.ok(record.menu instanceof Menu); assert.ok(record.popupCalled);
    assert.ok(nativeContexts.length > eventsBefore, 'A native webContents context-menu event must cause the menu');
    return record;
  };
  const item = (record, id) => { const result=record.menu.items.find(value=>value.id === id); assert.ok(result, 'Missing real menu action ' + id); return result; };
  const act = async (record, id) => {
    const target = item(record, id); assert.equal(target.enabled, true, id + ' must be enabled');
    child.focus(); child.webContents.focus(); await js(`$('file-content').focus();true`);
    await until('native editing document focused', () => js(`document.hasFocus()&&document.activeElement===$('file-content')`));
    await target.click(target, child, {}); await wait(200);
  };
  const capture = async name => { child.webContents.invalidate(); await wait(150); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  try {
    await fs.mkdir(project, { recursive:true }); await fs.mkdir(output, { recursive:true });
    await fs.writeFile(path.join(project, 'sample.txt'), source);
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('new renderer ready', () => js('Boolean(appState&&window.forge&&!projectSwitching)'));
    child.setContentSize(1440,1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('project active', async () => (await call('getState')).workspace?.root === project && await js('!projectSwitching'));
    await js(`previewFile('sample.txt')`);
    await until('actual editable textarea', () => js(`selectedPath==='sample.txt'&&!$('file-content').readOnly&&!$('file-preview').hidden`));
    await js(`window.__editorContextSmoke={inputs:[]};$('file-content').addEventListener('input',event=>window.__editorContextSmoke.inputs.push({trusted:event.isTrusted,type:event.inputType}));true`);
    child.webContents.on('context-menu', (_event, params) => nativeContexts.push({selectionText:params.selectionText,isEditable:params.isEditable,editFlags:params.editFlags}));
    Menu.buildFromTemplate = function(template) {
      const menu = originalBuild.call(Menu, template);
      if (template.some(value => value.id === 'selectAll') && template.some(value => value.id === 'copy')) {
        const record = {menu,template:template.map(({id,label,enabled,type})=>({id,label,enabled,type})),popupCalled:false,closed:false}; menus.push(record);
        const popup = menu.popup;
        menu.popup = function(options) {
          record.popupCalled = true; const result = popup.call(this, options);
          setImmediate(() => { if (!child.isDestroyed()) menu.closePopup(child); record.closed = true; }); return result;
        };
      }
      return menu;
    };
    await clipboard.writeText(seed); clipboardSeeded = true;

    stage = 'native right-click copy and disabled editing states';
    let record = await right(0,5);
    assert.deepEqual(record.menu.items.filter(value=>value.type !== 'separator').map(value=>value.id), ['undo','redo','cut','copy','paste','delete','selectAll']);
    assert.equal(item(record,'undo').enabled,false); assert.equal(item(record,'redo').enabled,false);
    for (const id of ['cut','copy','paste','delete','selectAll']) assert.equal(item(record,id).enabled,true,id);
    assert.equal(nativeContexts.at(-1).selectionText,'ALPHA');
    await act(record,'copy');
    if (await clipboard.readText() !== 'ALPHA') {
      const diagnostic = {menuCopy:await clipboard.readText(),before:await inspect()};
      child.webContents.copy();await wait(200);diagnostic.directCopy=await clipboard.readText();
      child.webContents.sendInputEvent({type:'keyDown',keyCode:'c',modifiers:['control']});
      child.webContents.sendInputEvent({type:'keyUp',keyCode:'c',modifiers:['control']});
      await wait(200);diagnostic.nativeControlC=await clipboard.readText();diagnostic.after=await inspect();
      await fs.writeFile(path.join(output,'editor-context-menu-copy-diagnostic.json'),JSON.stringify(diagnostic,null,2));
      assert.equal(diagnostic.menuCopy,'ALPHA','The actual menu callback must copy; direct native comparisons are recorded separately');
    }
    assert.equal((await inspect()).value,source);
    record = await right(0,0); assert.equal(item(record,'copy').enabled,false); assert.equal(item(record,'cut').enabled,false);

    stage = 'real native cut, undo, redo, paste and autosave';
    record = await right(0,5); await act(record,'cut'); await saved(' BETA\nGAMMA DELTA\n');
    record = await right(0,0); assert.equal(item(record,'undo').enabled,true); await act(record,'undo'); await saved(source);
    record = await right(0,5); assert.equal(item(record,'redo').enabled,true); await act(record,'redo'); await saved(' BETA\nGAMMA DELTA\n');
    record = await right(0,0); await act(record,'paste'); await saved(source);
    record = await right(0,0); await act(record,'selectAll');
    const all = await inspect(); assert.equal(all.start,0); assert.equal(all.end,source.length);
    assert.ok(all.events.length >= 4 && all.events.every(value=>value.trusted),'Menu editing must produce native input events');
    assert.equal(all.lines,source.split('\n').length);

    stage = 'read-only source menu only copies or selects';
    await js(`$('file-content').readOnly=true;true`);
    record = await right(0,5);
    assert.deepEqual(record.menu.items.filter(value=>value.type !== 'separator').map(value=>value.id),['copy','selectAll']);
    assert.equal(item(record,'copy').enabled,true); await act(record,'copy'); assert.equal(await clipboard.readText(),'ALPHA');
    await act(record,'selectAll'); assert.equal((await inspect()).end,source.length);
    assert.equal(await fs.readFile(path.join(project,'sample.txt'),'utf8'),source);
    await js(`$('file-content').readOnly=false;true`);

    stage = 'unrelated explorer and composer do not use the code menu';
    const before = menus.length;
    const point = await js(`(() => {const r=$('task-input').getBoundingClientRect();return {x:Math.round(r.left+30),y:Math.round(r.top+20)};})()`);
    child.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...point});
    child.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...point}); await wait(150);
    assert.equal(menus.length,before,'The native code menu must not replace the composer menu');

    stage = 'simplified settings, context trigger and usage retain their controls';
    const removed = ['clear-key-input','api-key-clear-field','settings-intro','settings-privacy','key-help','base-url-help','reasoning-hint'];
    assert.deepEqual(await js(`${JSON.stringify(removed)}.filter(id=>document.getElementById(id)!==null)`),[]);
    const trigger = await js(`({text:$('session-context-trigger').textContent.trim(),label:$('session-context-trigger').getAttribute('aria-label'),chevron:!!$('session-context-trigger').querySelector('.context-settings-chevron'),ring:!!$('session-context-trigger').querySelector('#session-context-progress')})`);
    assert.equal(trigger.text.includes('上下文'),false); assert.equal(trigger.chevron,false); assert.equal(trigger.ring,true); assert.match(trigger.label,/上下文/u);
    await click('#session-context-trigger'); await until('context popup still opens',()=>js(`!$('context-settings-popup').hidden`));
    await click('#context-settings-close');
    await click('#model-reasoning-trigger'); await click('#popup-model-button'); await click('#model-open-settings');
    await until('settings dialog still opens',()=>js(`$('settings-dialog').open`));
    for (const id of ['provider-select','base-url-input','api-key-input','settings-model-refresh','chatgpt-model-select','save-settings']) assert.equal(await js(`!!document.getElementById(${JSON.stringify(id)})`),true);
    await click('#close-settings');
    await click('#usage-stats-button'); await until('usage dashboard still opens',()=>js(`!$('usage-dashboard').hidden&&$('usage-activity-grid').querySelectorAll('[data-date]').length===365`));
    assert.equal(await js(`document.getElementById('usage-dashboard-note')===null&&!!$('usage-dashboard-status')`),true);
    await click('#usage-dashboard-close'); await capture('editor-context-menu-completed.png');
    const result = {status:'completed',realApi:false,realCommands:false,isolatedFiles:true,nativeRightClick:true,realElectronMenu:true,
      actualMenuItemCallbacks:true,nativeCopyCutPasteSelectAll:true,nativeUndoRedo:true,autosave:true,trustedInputEvents:true,
      readonlyCopyAndSelectOnly:true,correctDisabledStates:true,nonCodeAreaExcluded:true,simplifiedSettingsAndUsage:true,
      contextPopupPreserved:true,priorClipboardNeverRead:true,menus:menus.map(record=>record.template),screenshot:'editor-context-menu-completed.png'};
    await fs.writeFile(path.join(output,'editor-context-menu-result.json'),JSON.stringify(result,null,2)); return result;
  } catch(error) {
    const failure={stage,error:error.message,stack:error.stack,nativeContexts,menus:menus.map(record=>record.template)};
    if(child&&!child.isDestroyed()){try{failure.editor=await inspect();await capture('editor-context-menu-failure.png');}catch{}}
    await fs.writeFile(path.join(output,'editor-context-menu-result.json'),JSON.stringify(failure,null,2));throw error;
  } finally {
    Menu.buildFromTemplate=originalBuild;
    for(const record of menus){try{record.menu.closePopup(child);}catch{}}
    if(child&&!child.isDestroyed()){await js(`$('file-content').readOnly=false;true`).catch(()=>{});child.close();await until('isolated editor window closed',()=>child.isDestroyed()).catch(()=>child.destroy());}
    if(clipboardSeeded)await clipboard.clear();
  }
};
