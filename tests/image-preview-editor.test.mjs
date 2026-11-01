import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/image-preview-editor.js', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map(), buttons = ['draw','erase','comment','resize','undo','background'].map(action => ({ dataset: { imageTool: action }, classList: { toggle(){}, remove(){} }, disabled: false }));
  const strokes=[]; const context = { globalCompositeOperation: 'source-over', drawImage() {}, save() {}, restore() { this.globalCompositeOperation='source-over'; }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes.push(this.globalCompositeOperation); }, strokeText() {}, fillText() {} };
  const make = () => ({ style:{}, dataset:{}, hidden:false, value:'', classList:{toggle(){},remove(){}}, listeners:{}, addEventListener(type,fn){this.listeners[type]=fn;}, getBoundingClientRect(){return {left:0,top:0,width:100,height:100};}, focus(){} });
  const node = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  const bar = make(); bar.querySelectorAll = () => buttons;
  const dialog = make(); dialog.open = true; dialog.querySelector = () => bar; dialog.querySelectorAll = selector => selector === '[data-image-tool]' ? buttons : []; dialog.close = () => { dialog.open=false; };
  const image = make(); image.naturalWidth=100; image.naturalHeight=100; image.src='data:image/png;base64,original'; image.decode=async()=>{}; image.parentElement=make();
  const canvas=node('image-preview-canvas'); canvas.width=100; canvas.height=100; canvas.getContext=()=>context; let serial=0; canvas.toDataURL=()=>`data:image/png;base64,copy${++serial}`; canvas.hasPointerCapture=()=>false; canvas.setPointerCapture=()=>{};
  let pendingResolve, signalStarted; const backgroundStarted = new Promise(resolve => { signalStarted=resolve; }); const saves=[]; const bridge={saveEditedImage:async value=>{saves.push(value);return {saved:true};},removeImageBackground:()=>new Promise(resolve=>{pendingResolve=resolve;signalStarted();})};
  class FakeImage { constructor(){this.width=100;this.height=100;} set src(value){this.value=value;queueMicrotask(()=>this.onload());} }
  const window={addEventListener(){}}; const document={getElementById:node,createElement:()=>{const c=make(); c.getContext=()=>context;return c;}};
  vm.runInNewContext(source,{window,document,Image:FakeImage,Promise,Number,Math});
  const api=window.CortexImagePreviewEditor; api.bind({dialog,image,zoom:{reset(){},zoom(){}},bridge,notice(){}}); api.open();
  const click = action => bar.listeners.click({target:{closest:()=>buttons.find(b=>b.dataset.imageTool===action)}});
  return {api,bar,canvas,image,node,click,saves,strokes,backgroundStarted,resolveBackground:value=>pendingResolve(value)};
}

test('editing saves a copy, leaves the original attachment alone, and undo restores a snapshot', async () => {
  const f=fixture(), original=f.image.src; await f.click('draw');
  f.canvas.listeners.pointerdown({button:0,pointerId:1,clientX:10,clientY:10,preventDefault(){}});
  f.canvas.listeners.pointerup({pointerId:1}); await f.node('image-preview-save').onclick();
  assert.match(f.saves[0].dataUrl,/copy/); assert.equal(f.image.src,original);
  await f.click('undo'); assert.equal(f.node('image-preview-status').textContent,'已撤销'); assert.match(f.image.src,/copy/);
});

test('erase uses transparent pixels and closing during a stroke ends editing', async () => {
  const f=fixture(); await f.click('erase');
  f.canvas.listeners.pointerdown({button:0,pointerId:1,clientX:10,clientY:10,preventDefault(){}});
  assert.equal(f.strokes.at(-1),'destination-out'); f.api.close();
  f.image.src='data:image/png;base64,next'; f.api.open(); await f.click('draw');
  f.canvas.listeners.pointerdown({button:0,pointerId:2,clientX:10,clientY:10,preventDefault(){}});
  assert.equal(f.strokes.at(-1),'source-over');
});

test('a background result from a previous image cannot replace the next preview', async () => {
  const f=fixture(); const pending=f.click('background'); await f.backgroundStarted;
  f.image.src='data:image/png;base64,new-image'; f.api.open(); f.resolveBackground({dataUrl:'data:image/png;base64,old-result'}); await pending;
  assert.equal(f.image.src,'data:image/png;base64,new-image');
  assert.equal(f.node('image-preview-status').textContent,'编辑只影响预览副本');
});
