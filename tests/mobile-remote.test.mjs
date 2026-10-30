import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createMobileRemote}=require('../src/core/mobile-remote.cjs');
function request(port,token,method,path,body) { return new Promise((resolve,reject)=>{ const req=https.request({host:'127.0.0.1',port,method,path,rejectUnauthorized:false,headers:{authorization:`Bearer ${token}`}},res=>{const fingerprint=res.socket.getPeerCertificate().fingerprint256;let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(data),fingerprint}));});req.on('error',reject);req.end(body);}); }
test('remote access requires pairing and serves requests over TLS; stop revokes credentials',async()=>{
 let stopped=0, decisions=[]; const service=createMobileRemote({snapshot:()=>({sessionId:'s',messages:[]}),submit:text=>({text}),stopTask:()=>{stopped++},approve:arg=>{decisions.push(arg);return arg.id==='pending'}});
 const pair=await service.start(); const port=Number(new URL(pair.addresses[0]).port);
 try {const denied=await request(port,'wrong','GET','/v1/state');assert.equal(denied.code,401);const state=await request(port,pair.token,'GET','/v1/state');assert.equal(state.body.sessionId,'s');assert.equal(state.fingerprint,pair.fingerprint);const sent=await request(port,pair.token,'POST','/v1/messages',JSON.stringify({text:'hello'}));assert.equal(sent.body.text,'hello');const forbidden=await request(port,'wrong','POST','/v1/stop','{}');assert.equal(forbidden.code,401);assert.equal(stopped,0);const stop=await request(port,pair.token,'POST','/v1/stop','{}');assert.equal(stop.body.stopped,true);assert.equal(stopped,1);const old=await request(port,pair.token,'POST','/v1/approval',JSON.stringify({id:'old',approved:true}));assert.equal(old.code,409);const approval=await request(port,pair.token,'POST','/v1/approval',JSON.stringify({id:'pending',approved:true}));assert.equal(approval.body.accepted,true);assert.deepEqual(decisions.at(-1),{id:'pending',approved:true});}finally{await service.stop();}
 assert.equal(service.status().enabled,false);const next=await service.start();try{assert.notEqual(next.token,pair.token);assert.notEqual(next.fingerprint,pair.fingerprint);}finally{await service.stop();}
});
