import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), {viewedImages}=require('../src/core/mobile-viewed-images.cjs');
test('only actual receipts with matching source and attachment project an image',()=>{
 const a={id:'a',name:'x.png',mediaType:'image/png',dataUrl:'data:image/png;base64,YWJj'};
 const s={id:'session',messages:[{id:'m',role:'user',attachments:[a]}],imageViews:[{type:'images-viewed',version:1,runId:'r',requestId:'q',messageIndex:0,images:[{messageId:'m',attachmentIndex:0,attachmentId:'a'}]}]};
 const rows=viewedImages(s);assert.equal(rows.length,1);assert.match(rows[0].id,/^[a-f0-9]{64}$/);assert.equal(rows[0].sessionId,'session');
 assert.equal(viewedImages({...s,imageViews:[]}).length,0);
 assert.equal(viewedImages({...s,messages:[{id:'m',role:'tool',attachments:[a]}]}).length,0);
 assert.equal(viewedImages({...s,imageViews:[{...s.imageViews[0],images:[{messageId:'m',attachmentIndex:0,attachmentId:'different'}]}]}).length,0);
});
