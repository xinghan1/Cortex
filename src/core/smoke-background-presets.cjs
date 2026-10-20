// Native appearance controls with one generated local image. No network/model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { dialog, nativeImage } = require('electron');

module.exports = async function smokeBackgroundPresets({win,output,dataDir}) {
  assert.equal(win.webContents.isOffscreen(),true,'Preset smoke requires an isolated window');
  const js=code=>win.webContents.executeJavaScript(code);
  const call=(method,value)=>js(`window.forge[${JSON.stringify(method)}](${value===undefined?'':JSON.stringify(value)})`);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(label,predicate)=>{
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline){const value=await predicate();if(value)return value;await wait(25);}
    throw new Error('Background preset smoke timed out: '+label);
  };
  const click=async selector=>{
    const point=await js(`(()=>{
      const node=document.querySelector(${JSON.stringify(selector)});
      if(!node||node.disabled||!node.checkVisibility())throw new Error('Preset control unavailable: '+${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=node.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
  };
  const capture=async name=>{
    for(let attempt=1;attempt<=4;attempt++){
      try{win.webContents.invalidate();await wait(150*attempt);const image=await win.webContents.capturePage();assert.equal(image.isEmpty(),false);await fs.writeFile(path.join(output,name),image.toPNG());return;}
      catch(error){if(attempt===4||!/UnknownVizError/u.test(String(error?.name)+' '+error.message))throw error;}
    }
  };
  const ids=['aurora','rose','amber','forest','ocean','snow','midnight','orange','purple','olive','pink','magenta','cyan'];
  const independent={backgroundTransparency:37,panelFrost:54,panelTransparency:61,conversationTextColor:'yellow'};
  const bounds=win.getBounds(),chooser=dialog.showOpenDialog;
  const fixture=path.join(dataDir,'background-preset-'+randomUUID()+'.png');
  let original,stage='prepare';
  const snapshot=()=>js(`(()=>{
    const layer=getComputedStyle(document.getElementById('app-background'));
    return {image:layer.backgroundImage,preview:getComputedStyle(document.querySelector('.appearance-preview')).backgroundImage,
      opacity:Number(layer.getPropertyValue('--background-opacity')),
      name:document.getElementById('background-name').textContent,description:document.getElementById('background-description').textContent,
      choices:[...document.querySelectorAll('#background-preset-options [data-background-preset]')].map(node=>({id:node.dataset.backgroundPreset,pressed:node.getAttribute('aria-pressed'),label:node.getAttribute('aria-label')||node.textContent.trim()})),
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  const verify=async(id,settings=independent)=>{
    const state=await call('getAppearance'),disk=JSON.parse(await fs.readFile(path.join(dataDir,'appearance.json'),'utf8'));
    assert.equal(state.backgroundPreset,id);assert.equal(disk.backgroundPreset,id);
    assert.equal(state.backgroundImage,null);assert.equal(state.backgroundName,'');
    for(const[field,value]of Object.entries(settings)){assert.equal(state[field],value,id+': changed '+field);assert.equal(disk[field],value,id+': lost '+field+' on disk');}
    const value=await snapshot(),definition=await js(`window.ForgeBackgroundPresets.get(${JSON.stringify(id)})`);
    assert.deepEqual(value.choices.filter(item=>item.pressed==='true').map(item=>item.id),[id]);
    assert.ok(value.choices.every(item=>item.label&&['true','false'].includes(item.pressed)),'Preset controls need readable labels and pressed states');
    assert.equal(value.name,definition.name);assert.equal(value.description,definition.description);
    assert.equal(value.image.includes('data:image/'),false,'Builtin retained imported pixels');
    assert.ok(id==='aurora'?value.image.includes('aurora-background.svg'):/gradient\(/u.test(value.image),'Selected builtin did not reach the workbench');
    assert.equal(value.preview,value.image,'Preview and actual workbench use different backgrounds');
    assert.ok(Math.abs(value.opacity-(100-settings.backgroundTransparency)/100)<0.005);
    assert.equal(value.horizontalOverflow,false);return value;
  };
  const select=async id=>{
    await click(`#background-preset-options [data-background-preset="${id}"]`);
    await until(id+' saves and clears an imported background',async()=>{const state=await call('getAppearance');return state.backgroundPreset===id&&state.backgroundImage===null;});
    await js('window.synoraAppearance.settled()');return verify(id);
  };
  try{
    await fs.mkdir(output,{recursive:true});await js('window.synoraAppearance.ready');original=await call('getAppearance');
    assert.equal(original.backgroundImage,null,'Preset smoke requires fresh/default isolated appearance data');
    win.setSize(1440,1000);await call('setAppearance',independent);await js('window.synoraAppearance.open()');
    assert.deepEqual((await snapshot()).choices.map(item=>item.id).sort(),[...ids].sort(),'Missing built-in backgrounds');
    const images=new Set();
    for(const id of ids){stage='native '+id+' selection';images.add((await select(id)).image);}
    assert.equal(images.size,ids.length,'The built-in styles do not have distinct actual backgrounds');
    await capture('background-presets-settings.png');
    stage='reload saved preset';await click('#appearance-close');
    const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await loaded;await js('window.synoraAppearance.ready');
    await verify('cyan');
    stage='import overrides built-in background';
    const bitmap=Buffer.alloc(8*8*4);
    for(let offset=0;offset<bitmap.length;offset+=4){bitmap[offset]=160;bitmap[offset+1]=80;bitmap[offset+2]=20;bitmap[offset+3]=255;}
    const image=nativeImage.createFromBitmap(bitmap,{width:8,height:8});assert.equal(image.isEmpty(),false);await fs.writeFile(fixture,image.toPNG());
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture]});await call('importBackground');await js('window.synoraAppearance.settled()');
    await until('import is painted',async()=>{const value=await snapshot();return value.image.includes('data:image/png')&&value;});
    const imported=await snapshot();assert.equal(imported.choices.some(item=>item.pressed==='true'),false,'Imported image left a builtin selected');
    assert.equal((await call('getAppearance')).conversationTextColor,'yellow');
    stage='builtin replaces imported image';await js('window.synoraAppearance.open()');await select('forest');
    await click('#appearance-close');await until('settings closes',()=>js("!document.getElementById('appearance-dialog').open"));
    await capture('background-forest-preview.png');
    stage='background reset is independent';await js('window.synoraAppearance.open()');await click('#background-reset');
    await until('background reset complete',async()=>{const state=await call('getAppearance');return state.backgroundPreset==='aurora'&&state.backgroundImage===null&&state.backgroundTransparency===28;});
    await js('window.synoraAppearance.settled()');await verify('aurora',{...independent,backgroundTransparency:28});
    const result={status:'completed',realApi:false,nativeThirteenPresetSelections:true,builtinPresetCount:ids.length,distinctWorkbenchBackgrounds:true,previewMatchesWorkbench:true,
      readableNamesAndPressedStates:true,independentOpacityFrostAndTextColor:true,persistedAndRestoredAfterReload:true,
      importedImageOverridesSelection:true,builtinReplacesImportedPixels:true,resetPreservesFrostAndTextColor:true,
      screenshots:['background-presets-settings.png','background-forest-preview.png']};
    await fs.writeFile(path.join(output,'background-presets-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  }catch(error){
    await fs.writeFile(path.join(output,'background-presets-smoke-result.json'),JSON.stringify({status:'failed',stage,error:error.message},null,2)+'\n');
    throw new Error('Background preset smoke failed at '+stage+': '+error.message,{cause:error});
  }finally{
    dialog.showOpenDialog=chooser;
    if(!win.isDestroyed()){
      await js("document.getElementById('appearance-dialog')?.close()").catch(()=>{});
      if(original?.backgroundImage===null){await call('resetBackground').catch(()=>{});await call('setAppearance',Object.fromEntries(['backgroundPreset',...Object.keys(independent)].map(field=>[field,original[field]]))).catch(()=>{});await js('window.synoraAppearance.settled()').catch(()=>{});}
      win.setBounds(bounds);
    }
    await fs.unlink(fixture).catch(()=>{});
  }
};
