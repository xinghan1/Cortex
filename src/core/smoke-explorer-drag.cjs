// Synthetic HTML5 drag events using Chromium DataTransfer; real IPC and files.
// Everything stays in a disposable child/project. No model or OS clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeExplorerDrag({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(),true,'Explorer drag smoke requires an isolated parent');
  const fixture=path.join(dataDir,'explorer-drag-'+randomUUID()),project=path.join(fixture,'project');
  const original=await win.webContents.executeJavaScript('window.forge.getState()');
  let child,stage='prepare';
  const js=code=>child.webContents.executeJavaScript(code);
  const call=(method,value)=>js(`window.forge[${JSON.stringify(method)}](${value===undefined?'':JSON.stringify(value)})`);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,predicate)=>{
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){const value=await predicate();if(value)return value;await wait(25);}
    throw new Error('Explorer drag smoke timed out: '+label);
  };
  const exists=async absolute=>{try{await fs.stat(absolute);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const selector=relative=>'.file-row[data-path='+JSON.stringify(relative)+']';
  const row=async relative=>{
    const parts=relative.split('/');
    for(let index=1;index<parts.length;index++){
      const parent=parts.slice(0,index).join('/');
      await until('parent '+parent,()=>js(`!!document.querySelector(${JSON.stringify(selector(parent))})`));
      await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector(parent))});if(node.getAttribute('aria-expanded')==='false')node.click();})()`);
    }
    await until('row '+relative,()=>js(`!!document.querySelector(${JSON.stringify(selector(relative))})`));
  };
  const idle=()=>until('file UI settled',()=>js('!fileMutationBusy&&!explorerMovePending&&!editorSaving&&!projectSwitching'));
  const open=async relative=>{
    await idle();await row(relative);await js(`document.querySelector(${JSON.stringify(selector(relative))}).click()`);
    await until('editor '+relative,()=>js(`selectedPath===${JSON.stringify(relative)}&&!document.getElementById('file-content').readOnly&&!document.getElementById('file-preview').hidden`));
  };
  const edit=async text=>js(`(()=>{const node=document.getElementById('file-content');if(node.readOnly)throw new Error('Editor is locked');node.value=${JSON.stringify(text)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const begin=async relative=>{
    await idle();await row(relative);
    const value=await js(`(()=>{
      const source=document.querySelector(${JSON.stringify(selector(relative))});
      const transfer=new DataTransfer();const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer});
      source.dispatchEvent(event);window.__explorerDragSmoke={source,transfer};
      return {draggable:source.draggable,type:source.dataset.type,accepted:!event.defaultPrevented,types:[...transfer.types],active:explorerDrag?.path};
    })()`);
    assert.equal(value.draggable,true);assert.equal(value.accepted,true);assert.equal(value.active,relative);
    assert.ok(['file','directory'].includes(value.type));assert.ok(value.types.includes('application/x-synora-file'));
  };
  const targetSelector=destination=>destination===''?'#project-name':selector(destination);
  const over=async destination=>{
    if(destination)await row(destination);
    return js(`(()=>{
      const target=document.querySelector(${JSON.stringify(targetSelector(destination))});
      target.scrollIntoView({block:'nearest',behavior:'instant'});
      const event=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__explorerDragSmoke.transfer});target.dispatchEvent(event);
      return {accepted:event.defaultPrevented,highlighted:target.classList.contains('file-drop-target')};
    })()`);
  };
  const drop=async destination=>js(`(()=>{
    const target=document.querySelector(${JSON.stringify(targetSelector(destination))});
    const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__explorerDragSmoke.transfer});target.dispatchEvent(event);
    return {accepted:event.defaultPrevented,highlighted:target.classList.contains('file-drop-target')};
  })()`);
  const end=()=>js(`(()=>{const state=window.__explorerDragSmoke;if(state?.source)state.source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:state.transfer}));delete window.__explorerDragSmoke;})()`);
  const targetStyle=destination=>js(`(()=>{
    const target=document.querySelector(${JSON.stringify(targetSelector(destination))}),s=getComputedStyle(target),r=target.getBoundingClientRect();
    return {highlighted:target.classList.contains('file-drop-target'),background:s.backgroundColor,shadow:s.boxShadow,opacity:s.opacity,visible:target.checkVisibility(),transition:s.transition,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  })()`);
  const assertTargetHighlight=async destination=>{
    const value=await until('drop target material finishes transitioning',async()=>{
      const current=await targetStyle(destination);
      assert.equal(current.highlighted,true,'Drop highlight disappeared before paint');
      return current.background==='rgba(143, 190, 255, 0.24)'&&current.shadow.includes('rgba(184, 217, 255, 0.75)')&&current;
    });
    assert.equal(value.highlighted,true,'Drop highlight disappeared before paint');
    assert.equal(value.background,'rgba(143, 190, 255, 0.24)','Drop target did not receive the blue highlight material');
    assert.ok(value.shadow.includes('rgba(184, 217, 255, 0.75)'),'Drop target lost its visible inner highlight');
    assert.equal(value.opacity,'1');assert.equal(value.visible,true);return value;
  };
  const capture=async name=>{
    for(let attempt=1;attempt<=4;attempt++){
      try{
        await js(`new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),750);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true);}));})`);
        const painted=new Promise((resolve,reject)=>{
          const onPaint=()=>{clearTimeout(timer);resolve();};
          const timer=setTimeout(()=>{child.webContents.removeListener('paint',onPaint);reject(new Error('Offscreen frame did not paint before explorer preview'));},2000);
          child.webContents.once('paint',onPaint);
        });
        child.webContents.invalidate();await painted;await wait(120*attempt);
        const image=await child.webContents.capturePage();assert.equal(image.isEmpty(),false);await fs.writeFile(path.join(output,name),image.toPNG());return;
      }
      catch(error){if(attempt===4||!/UnknownVizError/u.test(String(error?.name)+' '+error.message))throw error;}
    }
  };
  const drag=async(source,destination)=>{await begin(source);assert.deepEqual(await over(destination),{accepted:true,highlighted:true});assert.equal((await drop(destination)).accepted,true);await end();await idle();};
  try{
    await fs.mkdir(path.join(project,'target'),{recursive:true});await fs.mkdir(path.join(project,'pack','inner'),{recursive:true});await fs.mkdir(output,{recursive:true});
    await Promise.all([
      fs.writeFile(path.join(project,'moving.txt'),'ORIGINAL_MOVING_BYTES\n'),fs.writeFile(path.join(project,'clipboard.txt'),'COPY_BUFFER_SENTINEL\n'),
      fs.writeFile(path.join(project,'collision.txt'),'SOURCE_MUST_REMAIN\n'),fs.writeFile(path.join(project,'target','collision.txt'),'TARGET_MUST_NOT_BE_OVERWRITTEN\n'),
      fs.writeFile(path.join(project,'pack','child.txt'),'DIRECTORY_CHILD_BYTES\n')
    ]);
    child=BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child&&child!==win&&child.webContents.isOffscreen());
    await until('child ready',()=>js('!!window.forge&&!!appState'));
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project active',()=>js(`appState?.workspace?.root===${JSON.stringify(project)}&&!projectSwitching`));
    const clipboard=await call('fileClipboard',{path:'clipboard.txt',mode:'copy'});
    await until('app clipboard ready',()=>js("fileClipboard?.path==='clipboard.txt'&&fileClipboard.mode==='copy'"));
    stage='dirty selected file moves into directory';await open('moving.txt');
    let dirty='DIRTY_BEFORE_DROP_'+randomUUID()+'\n';await edit(dirty);
    await begin('moving.txt');assert.deepEqual(await over('target'),{accepted:true,highlighted:true});
    await assertTargetHighlight('target');
    await capture('explorer-drag-target.png');
    const highlightedTarget=await assertTargetHighlight('target');
    // Capture can outlast the autosave debounce. Make another actual edit
    // immediately before drop so the flush check cannot pass on a clean file.
    dirty+='LATEST_UNSAVED_DROP\n';await edit(dirty);assert.equal(await js('editorDirty'),true);
    assert.equal((await drop('target')).accepted,true);await end();
    await until('dirty file moved and editor remapped',async()=>await exists(path.join(project,'target','moving.txt'))&&!(await exists(path.join(project,'moving.txt')))&&await js("selectedPath==='target/moving.txt'&&!fileMutationBusy&&!explorerMovePending&&!editorSaving"));
    assert.equal(await fs.readFile(path.join(project,'target','moving.txt'),'utf8'),dirty);
    assert.equal(await js("document.getElementById('preview-filename').title==='target/moving.txt'&&document.getElementById('file-content').value==="+JSON.stringify(dirty)),true);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector('target'))}).getAttribute('aria-expanded')`),'true');
    const afterMove='AUTOSAVE_AFTER_MOVE_'+randomUUID()+'\n';await edit(afterMove);
    await until('new path autosaves',async()=>await fs.readFile(path.join(project,'target','moving.txt'),'utf8')===afterMove&&await js('!editorDirty&&!editorSaving'));
    stage='root destination restores selected file path';await drag('target/moving.txt','');
    assert.equal(await fs.readFile(path.join(project,'moving.txt'),'utf8'),afterMove);assert.equal(await exists(path.join(project,'target','moving.txt')),false);
    assert.equal(await js("selectedPath==='moving.txt'&&document.getElementById('preview-filename').title==='moving.txt'"),true);
    assert.deepEqual((await call('getState')).fileClipboard,clipboard,'Drag move replaced the app file clipboard');
    assert.deepEqual(await js('fileClipboard'),clipboard,'Renderer file clipboard was replaced by drag');

    stage='directory move remaps selected descendant';await open('pack/child.txt');
    const descendant='DESCENDANT_DIRTY_'+randomUUID()+'\n';await edit(descendant);await drag('pack','target');
    await until('directory descendant editor remapped',()=>js("selectedPath==='target/pack/child.txt'&&document.getElementById('preview-filename').title==='target/pack/child.txt'"));
    assert.equal(await fs.readFile(path.join(project,'target','pack','child.txt'),'utf8'),descendant);assert.equal(await exists(path.join(project,'pack')),false);
    stage='directory cannot move into its descendant';await begin('target/pack');
    assert.deepEqual(await over('target/pack/inner'),{accepted:false,highlighted:false});assert.equal((await drop('target/pack/inner')).accepted,false);await end();
    await assert.rejects(()=>call('fileMove',{path:'target/pack',destination:'target/pack/inner'}));
    assert.equal(await fs.readFile(path.join(project,'target','pack','child.txt'),'utf8'),descendant);

    stage='collision preserves both files';await js("document.getElementById('notice').hidden=true");await drag('collision.txt','target');
    await until('collision notice',()=>js("!document.getElementById('notice').hidden&&/存在|覆盖/.test(document.getElementById('notice-text').textContent)"));
    assert.equal(await fs.readFile(path.join(project,'collision.txt'),'utf8'),'SOURCE_MUST_REMAIN\n');
    assert.equal(await fs.readFile(path.join(project,'target','collision.txt'),'utf8'),'TARGET_MUST_NOT_BE_OVERWRITTEN\n');
    stage='external forged MIME has no internal drag session';
    await js(`(()=>{clearExplorerDrag();const transfer=new DataTransfer();transfer.setData('application/x-synora-file',JSON.stringify({path:'moving.txt',workspaceId:currentWorkspaceId()}));window.__explorerDragSmoke={transfer};})()`);
    assert.deepEqual(await over('target'),{accepted:false,highlighted:false});assert.equal((await drop('target')).accepted,false);await end();
    stage='changed drag token is rejected';await begin('moving.txt');
    await js("window.__explorerDragSmoke.transfer.setData('application/x-synora-file','FORGED_TOKEN')");
    assert.equal((await over('target')).accepted,true);assert.deepEqual(await drop('target'),{accepted:false,highlighted:false});await end();
    stage='busy project transition rejects drops';await begin('moving.txt');
    await js('window.__explorerDragBusyOriginal=projectSwitching;projectSwitching=true');
    try{assert.deepEqual(await over('target'),{accepted:false,highlighted:false});assert.equal((await drop('target')).accepted,false);}
    finally{await js('projectSwitching=window.__explorerDragBusyOriginal;delete window.__explorerDragBusyOriginal');await end();}
    await wait(120);assert.equal(await exists(path.join(project,'target','moving.txt')),false);
    assert.equal(await fs.readFile(path.join(project,'moving.txt'),'utf8'),afterMove);
    assert.deepEqual((await call('getState')).fileClipboard,clipboard);
    assert.equal(await js("document.querySelectorAll('.file-drop-target,.file-drag-source').length"),0,'Drag decorations were not cleared');
    await capture('explorer-drag-completed.png');
    const after=await win.webContents.executeJavaScript('window.forge.getState()');
    assert.equal(after.workspace?.root,original.workspace?.root);assert.equal(after.sessionId,original.sessionId);
    const result={status:'completed',realApi:false,isolatedChildProject:true,syntheticHtml5DragEvents:true,chromiumDataTransfer:true,realIpcAndFilesystem:true,
      dirtyEditorFlushedBeforeMove:true,editorPathRemapped:true,autosaveAfterMove:true,rootDropTarget:true,directoryDescendantRemapped:true,
      descendantDestinationBlocked:true,noOverwriteOnCollision:true,appFileClipboardPreserved:true,osClipboardUntouched:true,
      forgedExternalMimeIgnored:true,changedInternalTokenRejected:true,syntheticProjectBusyGuard:true,parentWorkspacePreserved:true,
      targetHighlightComputedAndPainted:true,highlightedTarget,
      screenshots:['explorer-drag-target.png','explorer-drag-completed.png']};
    await fs.writeFile(path.join(output,'explorer-drag-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  }catch(error){
    await fs.writeFile(path.join(output,'explorer-drag-smoke-result.json'),JSON.stringify({status:'failed',stage,error:error.message},null,2)+'\n');
    throw new Error('Explorer drag smoke failed at '+stage+': '+error.message,{cause:error});
  }finally{
    if(child&&!child.isDestroyed()){
      await js('if(window.__explorerDragBusyOriginal!==undefined){projectSwitching=window.__explorerDragBusyOriginal;delete window.__explorerDragBusyOriginal;}clearExplorerDrag()').catch(()=>{});
      const closing=child;closing.close();await until('disposable child closes',()=>closing.isDestroyed()).catch(()=>{if(!closing.isDestroyed())closing.destroy();});
    }
  }
};
