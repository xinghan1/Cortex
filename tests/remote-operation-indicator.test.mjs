import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRemoteOperationIndicator } from '../src/core/remote-operation-indicator.cjs';

test('screen indicator passes clicks through borders and AI cursor; exit requests operation stop and cleanup', async () => {
  const windows=[]; let tick, stopped=0, cleared=0;
  class Mock extends EventEmitter {
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;windows.push(this);}
    setAlwaysOnTop(){} setIgnoreMouseEvents(value){this.passthrough=value;} loadURL(){return Promise.resolve();}
    showInactive(){} hide(){} isDestroyed(){return this.dead;} destroy(){this.dead=true;this.emit('closed');} setPosition(x,y){this.position=[x,y];}
  }
  const screen={getDisplayMatching:()=>({bounds:{x:100,y:0,width:1200,height:800}}),getCursorScreenPoint:()=>({x:400,y:300})};
  const owner={isDestroyed:()=>false,getBounds:()=>({x:100,y:0,width:100,height:100})};
  const indicator=createRemoteOperationIndicator({BrowserWindow:Mock,screen,onExit:()=>{stopped++;},setIntervalImpl:fn=>(tick=fn,1),clearIntervalImpl:()=>cleared++});
  indicator.show(owner); assert.equal(indicator.active,true); assert.equal(windows.length,3);
  assert.equal(windows[0].passthrough,true); assert.equal(windows[1].passthrough,undefined); assert.equal(windows[2].passthrough,true);
  assert.deepEqual(windows[2].position,[412,312]); tick();
  let prevented=false; windows[1].webContents.emit('will-navigate',{preventDefault(){prevented=true;}},'https://synora.invalid/exit');
  assert.equal(prevented,true); assert.equal(stopped,1);
  indicator.hide(); assert.equal(cleared,1); assert.ok(windows.every(w=>w.dead)); assert.equal(stopped,1);
});

test('owner close requests cancellation and removes all overlays', () => {
  let dead=false, stopped=0, tick;
  class Mock extends EventEmitter { constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;}
    setAlwaysOnTop(){} setIgnoreMouseEvents(){} loadURL(){return Promise.resolve();} showInactive(){} hide(){} isDestroyed(){return this.dead;} destroy(){this.dead=true;this.emit('closed');} setPosition(){} }
  const indicator=createRemoteOperationIndicator({BrowserWindow:Mock,screen:{getDisplayMatching:()=>({bounds:{x:0,y:0,width:400,height:400}}),getCursorScreenPoint:()=>({x:0,y:0})},onExit:()=>stopped++,setIntervalImpl:fn=>(tick=fn,1),clearIntervalImpl:()=>{}});
  indicator.show({getBounds:()=>({}),isDestroyed:()=>dead}); dead=true; tick(); assert.equal(stopped,1); assert.equal(indicator.active,false);
});

test('late load errors from a replaced overlay do not cancel the current operation', async () => {
  const windows=[]; let stopped=0;
  class Mock extends EventEmitter { constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.dead=false;windows.push(this);}
    setAlwaysOnTop(){} setIgnoreMouseEvents(){} loadURL(){return new Promise((_,reject)=>{this.reject=reject;});} showInactive(){} hide(){} isDestroyed(){return this.dead;} destroy(){this.dead=true;this.emit('closed');} setPosition(){} }
  const indicator=createRemoteOperationIndicator({BrowserWindow:Mock,screen:{getDisplayMatching:()=>({bounds:{x:0,y:0,width:400,height:400}}),getCursorScreenPoint:()=>({x:0,y:0})},onExit:()=>stopped++,setIntervalImpl:()=>1,clearIntervalImpl:()=>{}});
  const owner={getBounds:()=>({}),isDestroyed:()=>false}; indicator.show(owner); indicator.hide(); indicator.show(owner);
  windows[0].reject(new Error('old load cancelled')); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(indicator.active,true); assert.equal(stopped,0); indicator.hide();
});
