// Exercises actual local menu/window paths with fake dialogs and a loopback model.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, dialog, shell } = require('electron');
module.exports = async function smokeMenus({ win, output, dataDir }) {
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const click = (menu, action) => js(`(()=>{document.getElementById('menu-${menu}').click();const item=document.querySelector('#app-menu-popup [data-action="${action}"]');if(!item||item.disabled)throw new Error('Menu action unavailable: ${action}');item.click();})()`);
  const capture = async name => {win.webContents.invalidate();await wait(100);await fs.writeFile(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const original = {save:dialog.showSaveDialog,open:dialog.showOpenDialog,message:dialog.showMessageBox,external:shell.openExternal,path:shell.openPath};
  const links=[],help=[];
  let other,server;
  try {
    shell.openExternal=async url=>{links.push(url);};
    shell.openPath=async value=>{help.push(value);return '';};
    dialog.showMessageBox=async (...args)=>{help.push(args.at(-1));return {response:0};};
    const items=await js(`(()=>{const result={};for(const name of ['file','edit','view','appearance','help']){document.getElementById('menu-'+name).click();result[name]=[...document.querySelectorAll('#app-menu-popup [data-action]')].map(item=>item.dataset.action);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));}return result;})()`);
    for(const [group,required] of Object.entries({file:['new-window','new-chat','temporary-chat','create-project','open-project','close-window','logout','quit'],edit:['undo','redo','cut','copy','paste','delete','select-all','settings'],view:['toggle-sidebar','toggle-terminal','pin-summary','open-terminal','toggle-navigation','switch-focus','browser','find','back','forward','previous-sidebar','next-sidebar','previous-tab','next-tab','zoom-in','zoom-out','zoom-reset','fullscreen'],appearance:['import-background','appearance-settings'],help:['guide','about']})) {
      if(!required.every(action=>items[group].includes(action))) throw new Error('Missing '+group+' menu actions');
    }
    if(JSON.stringify(items.appearance)!==JSON.stringify(['import-background','appearance-settings'])||Object.values(items).some(actions=>actions.includes('frost-settings')))throw new Error('Redundant frost menu action remains');
    await js(`document.getElementById('menu-file').click()`);await capture('menu-file.png');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await js(`document.getElementById('menu-view').click()`);await capture('menu-view.png');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    win.setSize(980,740);
    await js(`for(let index=0;index<6;index++)window.aiCodeCommands.execute('zoom-in')`);await wait(250);
    await js(`document.getElementById('menu-view').click()`);await capture('menu-view-large-text.png');
    const menuBounds=await js(`(()=>{const popup=document.getElementById('app-menu-popup'),rect=popup.getBoundingClientRect();return{right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight,scrollWidth:popup.scrollWidth,clientWidth:popup.clientWidth,scale:document.documentElement.dataset.textScale};})()`);
    if(menuBounds.scale!=='160'||menuBounds.right>menuBounds.width||menuBounds.bottom>menuBounds.height||menuBounds.scrollWidth>menuBounds.clientWidth+1)throw new Error('Large-text menu overflow: '+JSON.stringify(menuBounds));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));window.aiCodeCommands.execute('zoom-reset')`);await wait(200);win.setSize(1340,900);await wait(80);
    for(let index=0;index<2;index++){
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['control','shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'S',modifiers:['control','shift']});await wait(40);
      if(await js(`document.documentElement.classList.contains('sidebar-hidden')`)!==(index===0))throw new Error('Sidebar shortcut did not toggle');
    }
    const before=await js(`({hidden:document.documentElement.classList.contains('sidebar-hidden'),sidebar:document.querySelector('.sidebar').getBoundingClientRect().width})`);
    await click('view','toggle-sidebar');
    if(!await js(`document.documentElement.classList.contains('sidebar-hidden')`)) throw new Error('Sidebar menu did not hide sidebar');
    await click('view','toggle-sidebar');
    if(await js(`document.documentElement.classList.contains('sidebar-hidden')`)) throw new Error('Sidebar menu did not restore sidebar');
    await click('view','open-terminal');
    if(await js(`document.getElementById('terminal-panel').hidden`)) throw new Error('Terminal panel did not open');
    await click('view','toggle-navigation');
    if(await js(`document.getElementById('preview-panel').hidden`)) throw new Error('Navigation panel did not open');
    await click('view','pin-summary');
    if(!await js(`document.documentElement.classList.contains('preview-pinned')`)) throw new Error('Summary panel did not pin');
    await click('view','pin-summary');
    await js(`document.getElementById('close-preview').click()`);
    // Use the native undo/redo stack, without modifying the user's clipboard.
    await js(`(()=>{const input=document.getElementById('task-input');input.value='';input.focus();})()`);
    await win.webContents.insertText('Synora code edit verification');
    await click('edit','undo');await wait(30);
    if(await js(`document.getElementById('task-input').value`)) throw new Error('Edit undo did not affect focused input');
    await click('edit','redo');await wait(30);
    if(await js(`document.getElementById('task-input').value`)!=='Synora code edit verification') throw new Error('Edit redo did not restore input');
    await click('edit','select-all');await click('edit','delete');
    if(await js(`document.getElementById('task-input').value`)) throw new Error('Edit select-all/delete failed');
    await js(`document.getElementById('task-input').focus()`);
    await win.webContents.insertText('ALT_EDIT_FOCUS');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Alt'});
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['alt']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['alt']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Alt'});
    await wait(50);
    await js(`document.querySelector('#app-menu-popup [data-action="undo"]').click()`);await wait(40);
    if(await js(`document.getElementById('task-input').value`)) throw new Error('Alt+E edit menu lost input focus');
    await click('view','find');
    const found=await js(`(async()=>{
      const seen=[];
      const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('Find timed out: '+JSON.stringify(seen)));},4000);const off=window.forge.onEvent(event=>{if(event.type==='find-result'){seen.push(event);if(event.matches>0){clearTimeout(timer);off();resolve(event);}}});});
      const input=document.getElementById('find-input');input.value='探索未至之境';input.dispatchEvent(new Event('input',{bubbles:true}));return await result;
    })()`);
    await js(`document.getElementById('find-close').click()`);
    if(!found.matches) throw new Error('Find did not locate visible app text');
    const findNavigation=await js(`(async()=>{
      const search=action=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('Find navigation timed out'));},4000);const off=window.forge.onEvent(event=>{if(event.type==='find-result'&&event.finalUpdate&&event.matches>0){clearTimeout(timer);off();resolve(event);}});action();});
      await window.aiCodeCommands.execute('find');
      const first=await search(()=>{const input=document.getElementById('find-input');input.value='项目';input.dispatchEvent(new Event('input',{bubbles:true}));});
      const next=await search(()=>document.getElementById('find-next').click());
      const previous=await search(()=>document.getElementById('find-previous').click());
      await window.forge.stopFind();
      const reopened=await search(()=>document.getElementById('find-next').click());
      document.getElementById('find-close').click();
      if(first.matches<2||next.activeMatchOrdinal===first.activeMatchOrdinal||previous.activeMatchOrdinal!==first.activeMatchOrdinal||!reopened.matches)throw new Error('Find next/previous/reopen failed');
      return true;
    })()`);
    await win.webContents.executeJavaScript(`(async()=>{let refused=false;try{await window.forge.openLink({url:'javascript:alert(1)'});}catch{refused=true;}if(!refused)throw new Error('Invalid browser protocol accepted');await window.forge.openLink({url:'https://example.com/ai-code-test'});await window.forge.openHelp({topic:'guide'});await window.forge.openHelp({topic:'about'});})()`);
    if(links.length!==1||help.length!==2) throw new Error('Browser/help actions were not routed');
    const project=path.join(dataDir,'menu-project-'+randomUUID());
    dialog.showSaveDialog=async()=>({canceled:false,filePath:project});
    const created=await win.webContents.executeJavaScript('window.forge.createProject()');
    if(created.workspace?.root!==project||!(await fs.stat(project)).isDirectory()) throw new Error('New project did not create selected folder');
    const newWindow=await win.webContents.executeJavaScript('window.forge.newWindow()');
    other=BrowserWindow.fromId(newWindow.id);
    if(!other||other===win) throw new Error('New window was not created');
    const second=await other.webContents.executeJavaScript('window.forge.getState()');
    if(second.workspace||second.sessionId===created.sessionId) throw new Error('New window reused project/conversation state');
    const workspace=path.join(dataDir,'project');
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});
    await other.webContents.executeJavaScript('window.forge.chooseWorkspace()');
    if((await js('window.forge.getState()')).workspace.root!==project) throw new Error('Second window changed first workspace');
    // The destroyed frame cannot reliably return an executeJavaScript result.
    other.webContents.executeJavaScript('window.forge.closeWindow()').catch(()=>{});
    for(let attempt=0;attempt<100&&!other.isDestroyed();attempt++)await wait(25);
    if(!other.isDestroyed()||win.isDestroyed()) throw new Error('Closing a window closed the wrong context');
    // A temporary model call must count usage without ever saving its content.
    const marker='TEMPORARY_MENU_'+randomUUID();
    server=http.createServer(async(request,response)=>{
      for await(const _chunk of request) { /* Consume the local fixture body. */ }
      response.writeHead(200,{'Content-Type':'application/json'});
      response.end(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:marker}]}],usage:{input_tokens:3,output_tokens:2}}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
    await js(`window.forge.saveSettings({provider:'openai',authMode:'apiKey',model:'smoke-menu-model',baseUrl:${JSON.stringify(baseUrl)},apiKey:'smoke-menu-key',reasoningEffort:'default',maxSteps:2})`);
    await click('file','temporary-chat');await wait(80);
    if(!(await js('window.forge.getState()')).temporary) throw new Error('Temporary chat was not selected');
    const initialUsage=(await js('window.forge.getState()')).usageStats.day.totalTokens;
    await js(`(async()=>{
      const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('Temporary task timed out'));},10000);const off=window.forge.onEvent(event=>{if(event.type==='run-end'){clearTimeout(timer);off();resolve(event);}});});
      await window.forge.runTask({text:${JSON.stringify(marker)}});const result=await done;if(result.status!=='completed')throw new Error(result.error||'Temporary task failed');
    })()`);
    const temporary=await js('window.forge.getState()');
    if(!temporary.temporary||temporary.usageStats.day.totalTokens-initialUsage!==5) throw new Error('Temporary usage or mode incorrect');
    const sessionFiles=await fs.readdir(path.join(dataDir,'sessions'));
    for(const file of sessionFiles.filter(name=>name.endsWith('.json'))) if((await fs.readFile(path.join(dataDir,'sessions',file),'utf8')).includes(marker)) throw new Error('Temporary content was written to history');
    await click('file','new-chat');await wait(60);
    if((await js('window.forge.getState()')).temporary) throw new Error('Normal chat did not exit temporary mode');
    const terminal=await js(`(async()=>{
      const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('Terminal timed out'));},10000);const off=window.forge.onEvent(event=>{if(event.type==='approval-request')queueMicrotask(()=>{const entry=approvals.get(event.id),slot=document.getElementById('composer-approval');if(!entry||!slot.contains(entry.card)||slot.hidden||!document.getElementById('task-form').hidden){clearTimeout(timer);off();reject(new Error('Terminal decision is missing from the composer'));return;}entry.accept?.click();});if(event.type==='terminal-end'){clearTimeout(timer);off();resolve(event);}});});
      await window.forge.runTerminal({command:'Write-Output "AI_CODE_TERMINAL_OK"',timeoutMs:5000});return await done;
    })()`);
    if(terminal.status!=='completed'||!JSON.stringify(terminal).includes('AI_CODE_TERMINAL_OK')) throw new Error('Real terminal command failed');
    await capture('menus-terminal.png');
    await js(`window.forge.saveSettings({provider:'openai',authMode:'apiKey',model:'',baseUrl:'https://api.openai.com/v1',clearKey:true})`);
    return {status:'completed',menus:Object.keys(items),editing:true,altEditFocus:true,nativeSidebarShortcut:true,largeTextMenu:true,findMatches:found.matches,findNavigation,views:true,newProject:true,independentWindow:true,temporaryNotSaved:true,temporaryTokens:5,terminal:true,browserLink:true,help:true,sidebarWidth:before.sidebar};
  } finally {
    dialog.showSaveDialog=original.save;dialog.showOpenDialog=original.open;dialog.showMessageBox=original.message;shell.openExternal=original.external;shell.openPath=original.path;
    if(other&&!other.isDestroyed()) other.close();
    if(server){const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
  }
};
