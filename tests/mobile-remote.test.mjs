import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createMobileRemote}=require('../src/core/mobile-remote.cjs');
function request(port,token,method,path,body) { return new Promise((resolve,reject)=>{ const req=https.request({host:'127.0.0.1',port,method,path,rejectUnauthorized:false,headers:{authorization:`Bearer ${token}`}},res=>{const fingerprint=res.socket.getPeerCertificate().fingerprint256;let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(data),fingerprint}));});req.on('error',reject);req.end(body);}); }
test('fixed port validates input, reports conflicts, and can be reused after stopping',async()=>{
 const service=createMobileRemote({snapshot:()=>({ok:true})});
 for(const port of [-1,65536,1.5,'123',null]) await assert.rejects(service.start({port}),/端口/);
 const reserved=net.createServer();await new Promise((resolve,reject)=>{reserved.once('error',reject);reserved.listen(0,'0.0.0.0',resolve);});const port=reserved.address().port;
 try {
  await assert.rejects(service.start({port}),{code:'EADDRINUSE'});
  assert.equal(service.status().enabled,false);assert.equal(service.status().token,null);assert.equal(service.status().fingerprint,null);
 } finally {await service.stop();await new Promise(resolve=>reserved.close(resolve));}
 try {
  const pair=await service.start({port});assert.equal(pair.port,port);
  assert.equal((await request(port,pair.token,'GET','/v1/state')).body.ok,true);
  await assert.rejects(service.start({port:port===65535?port-1:port+1}),/先停止/);
  await service.stop();assert.equal(service.status().port,null);
  const restarted=await service.start({port});assert.equal(restarted.port,port);assert.notEqual(restarted.token,pair.token);
 } finally {await service.stop();}
});
test('a TCP tunnel preserves the desktop certificate and pairing authorization',async()=>{
 const service=createMobileRemote({snapshot:()=>({ok:true})});
 const pair=await service.start();
 const sockets=new Set();
 const proxy=net.createServer(client=>{const upstream=net.connect(pair.port,'127.0.0.1');sockets.add(client);sockets.add(upstream);client.on('close',()=>{sockets.delete(client);upstream.destroy();});upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});client.on('error',()=>{});upstream.on('error',()=>client.destroy());client.pipe(upstream).pipe(client);});
 try {
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  const port=proxy.address().port;
  const valid=await request(port,pair.token,'GET','/v1/state');
  assert.equal(valid.body.ok,true);assert.equal(valid.fingerprint,pair.fingerprint);
  assert.equal((await request(port,'wrong','GET','/v1/state')).code,401);
 } finally {for(const socket of sockets) socket.destroy();await service.stop();await new Promise(resolve=>proxy.close(resolve));}
});
test('remote access requires pairing and serves requests over TLS; stop revokes credentials',async()=>{
 let stopped=0, decisions=[]; const service=createMobileRemote({snapshot:()=>({sessionId:'s',messages:[]}),submit:text=>({text}),stopTask:()=>{stopped++},approve:arg=>{decisions.push(arg);return arg.id==='pending'}});
 const pair=await service.start(); const port=Number(new URL(pair.addresses[0]).port);
 try {const denied=await request(port,'wrong','GET','/v1/state');assert.equal(denied.code,401);const state=await request(port,pair.token,'GET','/v1/state');assert.equal(state.body.sessionId,'s');assert.equal(state.fingerprint,pair.fingerprint);const sent=await request(port,pair.token,'POST','/v1/messages',JSON.stringify({text:'hello'}));assert.equal(sent.body.text,'hello');const forbidden=await request(port,'wrong','POST','/v1/stop','{}');assert.equal(forbidden.code,401);assert.equal(stopped,0);const stop=await request(port,pair.token,'POST','/v1/stop','{}');assert.equal(stop.body.stopped,true);assert.equal(stopped,1);const old=await request(port,pair.token,'POST','/v1/approval',JSON.stringify({id:'old',approved:true}));assert.equal(old.code,409);const approval=await request(port,pair.token,'POST','/v1/approval',JSON.stringify({id:'pending',approved:true}));assert.equal(approval.body.accepted,true);assert.deepEqual(decisions.at(-1),{id:'pending',approved:true});}finally{await service.stop();}
 assert.equal(service.status().enabled,false);const next=await service.start();try{assert.notEqual(next.token,pair.token);assert.notEqual(next.fingerprint,pair.fingerprint);}finally{await service.stop();}
});
test('model listing and selection require pairing, validate input, and delegate to host',async()=>{
 let selected=[]; const service=createMobileRemote({snapshot:()=>({}),submit:()=>({}),stopTask:()=>{},approve:()=>false,listModels:()=>({model:'a',models:[{id:'a',name:'A'}]}),selectModel:id=>{selected.push(id);return {model:id}}});
 const pair=await service.start(),port=Number(new URL(pair.addresses[0]).port);
 try {
  assert.equal((await request(port,'wrong','GET','/v1/models')).code,401);
  assert.equal((await request(port,'wrong','POST','/v1/model',JSON.stringify({model:'a'}))).code,401);
  assert.deepEqual(selected,[]);
  assert.equal((await request(port,pair.token,'GET','/v1/models')).body.models[0].id,'a');
  assert.equal((await request(port,pair.token,'POST','/v1/model',JSON.stringify({model:''}))).code,400);
  assert.equal((await request(port,pair.token,'POST','/v1/model',JSON.stringify({model:'a'}))).body.model,'a');
  assert.deepEqual(selected,['a']);
 } finally { await service.stop(); }
});
test('workspace selection requires pairing and a valid open workspace identifier',async()=>{
 const selected=[];const service=createMobileRemote({snapshot:()=>({}),submit:()=>({}),stopTask:()=>{},approve:()=>false,
  listWorkspaces:()=>({workspaces:[{id:'open',name:'Project',active:true}]}),
  selectWorkspace:id=>{if(id!=='open')throw new Error('未打开的工作空间');selected.push(id);return {id,name:'Project'};}});
 const pair=await service.start(),port=Number(new URL(pair.addresses[0]).port);
 try {
  assert.equal((await request(port,'wrong','GET','/v1/workspaces')).code,401);
  assert.equal((await request(port,'wrong','POST','/v1/workspace',JSON.stringify({id:'open'}))).code,401);
  assert.equal((await request(port,pair.token,'GET','/v1/workspaces')).body.workspaces[0].name,'Project');
  assert.equal((await request(port,pair.token,'POST','/v1/workspace',JSON.stringify({id:''}))).code,400);
  assert.equal((await request(port,pair.token,'POST','/v1/workspace',JSON.stringify({id:'not-open'}))).code,400);
  assert.equal((await request(port,pair.token,'POST','/v1/workspace',JSON.stringify({id:'open'}))).body.id,'open');
  assert.deepEqual(selected,['open']);
 } finally {await service.stop();}
});
test('attachment submission requires authentication and enforces byte limits',async()=>{
 const received=[];const service=createMobileRemote({snapshot:()=>({}),submit:(text,images)=>{received.push({text,images});return {ok:true}},stopTask:()=>{},approve:()=>false});
 const pair=await service.start(),port=Number(new URL(pair.addresses[0]).port);
 try {
  const image={name:'a.jpg',mediaType:'image/jpeg',dataUrl:'data:image/jpeg;base64,YQ=='};
  assert.equal((await request(port,'wrong','POST','/v1/messages',JSON.stringify({text:'look',attachments:[image]}))).code,401);
  assert.deepEqual(received,[]);
  assert.equal((await request(port,pair.token,'POST','/v1/messages',JSON.stringify({text:'look',attachments:[image]}))).code,200);
  assert.deepEqual(received[0],{text:'look',images:[image]});
  assert.equal((await request(port,pair.token,'POST','/v1/messages',JSON.stringify({text:'look',attachments:[image,image]}))).code,400);
  assert.equal((await request(port,pair.token,'POST','/v1/messages',JSON.stringify({text:'中'.repeat(540000)}))).code,413);
 } finally { await service.stop(); }
});
test('remote reasoning requires authorization and a valid model and effort',async()=>{
 const selected=[]; const service=createMobileRemote({snapshot:()=>({}),submit:()=>({}),stopTask:()=>{},approve:()=>false,setReasoning:(model,effort)=>{selected.push({model,effort});return {reasoningEffort:effort}}});
 const pair=await service.start(),port=Number(new URL(pair.addresses[0]).port);
 try {
  assert.equal((await request(port,'wrong','POST','/v1/reasoning',JSON.stringify({model:'a',effort:'high'}))).code,401);
  assert.equal((await request(port,pair.token,'POST','/v1/reasoning',JSON.stringify({model:'a',effort:'invalid'}))).code,400);
  assert.equal((await request(port,pair.token,'POST','/v1/reasoning',JSON.stringify({effort:'high'}))).code,400);
  assert.equal((await request(port,pair.token,'POST','/v1/reasoning',JSON.stringify({model:'a',effort:'high'}))).body.reasoningEffort,'high');
  assert.deepEqual(selected,[{model:'a',effort:'high'}]);
 } finally {await service.stop();}
});
import { deflateSync, crc32 } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeImageAttachments } from '../src/core/message-images.mjs';

test('a full-size PNG crosses the remote TLS service without changing bytes',async()=>{
 const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(1024,0);head.writeUInt32BE(1024,4);head[8]=8;head[9]=2;
 const rows=[];for(let y=0;y<1024;y++)rows.push(Buffer.concat([Buffer.from([0]),randomBytes(3072)]));
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
 assert.ok(png.length>2*1024*1024);let received;
 const service=createMobileRemote({submit:(_text,items)=>{received=normalizeImageAttachments(items)[0];return {ok:true};}}),pair=await service.start();
 try{const image={name:'full.png',mediaType:'image/png',dataUrl:'data:image/png;base64,'+png.toString('base64')};const response=await request(pair.port,pair.token,'POST','/v1/messages',JSON.stringify({text:'test',attachments:[image]}));assert.equal(response.code,200);assert.equal(received.mediaType,'image/png');assert.equal(createHash('sha256').update(Buffer.from(received.dataUrl.split(',')[1],'base64')).digest('hex'),createHash('sha256').update(png).digest('hex'));}finally{await service.stop();}
});
