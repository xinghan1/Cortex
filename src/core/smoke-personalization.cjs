// Real renderer input and local preferences only; no account or network access.
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function smokePersonalization({ win, output, dataDir }) {
  const metrics = () => win.webContents.executeJavaScript(`({
    scale:Number(document.documentElement.dataset.textScale),
    font:parseFloat(getComputedStyle(document.querySelector('.message-body')||document.getElementById('task-input')).fontSize),
    sidebar:document.querySelector('.sidebar').getBoundingClientRect().width,
    brand:document.querySelector('.brand').getAttribute('aria-label')||document.querySelector('.brand').textContent,title:document.title,
    logo:!!document.querySelector('.brand .brand-logo')?.complete&&document.querySelector('.brand .brand-logo').naturalWidth>0
  })`);
  const waitScale = async value => {
    for(let attempt=0;attempt<100;attempt++) {
      const observed=await win.webContents.executeJavaScript(`(async()=>({scale:Number(document.documentElement.dataset.textScale),saved:(await window.forge.getState()).textScale,pending:textScalePending}))()`);
      if(observed.scale===value&&observed.saved===value&&!observed.pending) return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error('Text scale failed to settle at '+value);
  };
  const initial = await metrics();
  if(initial.brand!=='Synora code'||!initial.title.startsWith('Synora code')||!initial.logo) throw new Error('Software brand or logo was not updated');
  const minimalChrome = () => win.webContents.executeJavaScript(`(()=>{
    const removed=['#model-button','#model-label','#open-workspace','.top-actions','#text-scale-label','#composer-project'];
    const remaining=removed.filter(selector=>document.querySelector(selector));
    if(remaining.length)throw new Error('Removed toolbar controls still exist: '+remaining.join(', '));
    if(/文字(?:大小|缩放)?\\s*\\d+\\s*%/u.test(document.body.innerText))throw new Error('Text scale percentage hint is still visible');
    return true;
  })()`);
  await minimalChrome();
  const history = await win.webContents.executeJavaScript(`(async()=>{
    const state=await window.forge.getState();
    const identity=value=>String(value||'').replace(/[\\\\/]+$/u,'').replace(/\\//gu,'\\\\').toLowerCase();
    const history=state.sessions.filter(item=>identity(item.workspace)===identity(state.workspace.root));
    if(history.length!==1||history[0].title!==state.workspace.name) throw new Error('History is not grouped by project folder');
    const id=history[0].id;
    await window.forge.newSession();
    const updated=await window.forge.getState();
    const retained=updated.sessions.filter(item=>identity(item.workspace)===identity(state.workspace.root));
    if(retained.length!==1||retained[0].id!==id) throw new Error('Empty conversation hid the last project conversation');
    document.getElementById('project-switcher').click();
    if(document.getElementById('project-dropdown').hidden)throw new Error('Project dropdown did not open');
    const current=[...document.querySelectorAll('#project-current-list .recent-project')].filter(item=>identity(item.dataset.workspace)===identity(state.workspace.root));
    if(current.length!==1||!current[0].classList.contains('active')||!current[0].querySelector('.project-history-badge'))throw new Error('Project history item or active state incorrect');
    if(current[0].querySelector('strong').textContent!==state.workspace.name) throw new Error('History title is not folder name');
    if(document.getElementById('files-tab')||document.getElementById('sessions-tab')||document.getElementById('sessions-panel'))throw new Error('Old sidebar tabs remain');
    document.getElementById('project-switcher').click();
    window.__smokeCtrlWheel=null;
    document.addEventListener('wheel',event=>{if(event.ctrlKey)window.__smokeCtrlWheel=event.deltaY;},{capture:true});
    return {items:retained.length,folderTitle:retained[0].title,projectDropdown:true};
  })()`);
  win.webContents.sendInputEvent({type:'mouseMove',x:700,y:280});
  win.webContents.sendInputEvent({type:'mouseWheel',modifiers:['control'],x:700,y:280,deltaY:120,deltaX:0});
  await new Promise(resolve=>setTimeout(resolve,40));
  const nativeDelta = await win.webContents.executeJavaScript('window.__smokeCtrlWheel');
  if(typeof nativeDelta!=='number'||!nativeDelta) throw new Error('Native Ctrl+wheel did not reach renderer');
  const expected = initial.scale+(nativeDelta<0?10:-10);
  await waitScale(expected);
  const changed = await metrics();
  await minimalChrome();
  if(Math.abs(changed.font/initial.font-expected/initial.scale)>0.005) throw new Error('Ctrl+wheel did not change text font size proportionally');
  if(changed.sidebar!==initial.sidebar||win.webContents.getZoomFactor()!==1) throw new Error('Text scale changed layout or browser zoom');
  // Rapid events must accumulate against the latest intent and persist once idle.
  await win.webContents.executeJavaScript(`for(let i=0;i<3;i++)document.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-120,bubbles:true,cancelable:true}))`);
  const rapid = Math.min(160, expected+30);
  await waitScale(rapid);
  await minimalChrome();
  const saved = JSON.parse(await fs.readFile(path.join(dataDir,'preferences.json'),'utf8'));
  if(saved.textScale!==rapid) throw new Error('Text preference was not persisted');
  win.webContents.invalidate();await new Promise(resolve=>setTimeout(resolve,100));
  await fs.writeFile(path.join(output,'ai-code-text-scale.png'),(await win.webContents.capturePage()).toPNG());
  win.webContents.reload();
  await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  await waitScale(rapid);
  await minimalChrome();
  if((await metrics()).sidebar!==initial.sidebar) throw new Error('Reload did not preserve layout preference');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'0',modifiers:['control']});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'0',modifiers:['control']});
  await waitScale(100);
  // Normal wheel scrolling must leave the text preference alone.
  win.webContents.sendInputEvent({type:'mouseWheel',x:700,y:280,deltaY:120,deltaX:0});
  await new Promise(resolve=>setTimeout(resolve,120));
  if((await metrics()).scale!==100) throw new Error('Ordinary scrolling changed text size');
  return {status:'completed',brand:'Synora code',history,minimalChrome:true,noTextScalePercentage:true,nativeCtrlWheel:true,textScaleBefore:initial.scale,textScaleAfter:expected,rapidScale:rapid,restoredAfterReload:true,resetWithCtrl0:true,layoutUnchanged:true};
};
