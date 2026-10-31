'use strict';
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');

// Minimal DER encoder for an ephemeral, self-signed ECDSA certificate. The
// client pins this certificate's fingerprint instead of trusting a CA.
const len = n => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81,n]) : Buffer.from([0x82,n >> 8,n & 255]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30,...p);
const oid = hex => tlv(0x06,Buffer.from(hex,'hex'));
const algo = seq(oid('2a8648ce3d040302'));
function ephemeralCertificate() {
  const {privateKey,publicKey} = crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const subject = seq(tlv(0x31,seq(oid('550403'),tlv(0x0c,Buffer.from('Cortex Mobile Pairing')))));
  const utc = d => tlv(0x17,Buffer.from(d.toISOString().replace(/[-:T]/g,'').slice(2,14)+'Z'));
  const now=Date.now(), serial=crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) || 1;
  const tbs=seq(tlv(0xa0,tlv(2,Buffer.from([2]))),tlv(2,serial),algo,subject,seq(utc(new Date(now-60000)),utc(new Date(now+86400000))),subject,publicKey.export({type:'spki',format:'der'}));
  const sig=crypto.sign('sha256',tbs,privateKey);
  const der=seq(tbs,algo,tlv(3,Buffer.from([0]),sig));
  const cert='-----BEGIN CERTIFICATE-----\n'+der.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
  return {cert,key:privateKey.export({type:'pkcs8',format:'pem'}),fingerprint:new crypto.X509Certificate(cert).fingerprint256};
}
function createMobileRemote({ snapshot, submit, stopTask, approve, listModels, selectModel, setReasoning, listWorkspaces, selectWorkspace }) {
  let server=null, token=null, fingerprint=null, port=null, operation=Promise.resolve();
  const serialize = action => { const next=operation.then(action); operation=next.catch(()=>{}); return next; };
  const status=()=>({enabled:!!server,token,fingerprint,port,addresses:server ? Object.values(os.networkInterfaces()).flat().filter(x=>x && x.family==='IPv4' && !x.internal).map(x=>`https://${x.address}:${port}`) : []});
  const stop=()=>serialize(async()=>{ const old=server; server=null; token=null; fingerprint=null; port=null; if(old) { old.closeAllConnections(); await new Promise(resolve=>old.close(resolve)); } return status(); });
  const start=(options={})=>serialize(async()=>{
    if(!options || typeof options!=='object' || Array.isArray(options)) throw new Error('远程连接端口无效');
    const requestedPort=options.port===undefined ? 0 : options.port;
    if(!Number.isInteger(requestedPort) || requestedPort<0 || requestedPort>65535) throw new Error('远程连接端口必须为 1 到 65535 的整数，或使用自动分配');
    if(server) {
      if(requestedPort && requestedPort!==port) throw new Error('远程连接已开启，请先停止后再更改端口');
      return status();
    }
    const certificate=ephemeralCertificate(); token=crypto.randomBytes(32).toString('base64url'); fingerprint=certificate.fingerprint;
    const instance=https.createServer({key:certificate.key,cert:certificate.cert},async(req,res)=>{
      const reply=(code,obj)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj));};
      const supplied=String(req.headers.authorization||''); const expected=`Bearer ${token}`;
      const actualBytes=Buffer.from(supplied), expectedBytes=Buffer.from(expected);
      if(!token || actualBytes.length!==expectedBytes.length || !crypto.timingSafeEqual(actualBytes,expectedBytes)) return reply(401,{error:'未授权'});
      if(req.headers.origin) return reply(403,{error:'不允许网页跨域访问'});
      try {
        if(req.method==='GET' && req.url==='/v1/state') return reply(200,await snapshot());
        if(req.method==='GET' && req.url==='/v1/models') return reply(200,await listModels());
        if(req.method==='GET' && req.url==='/v1/workspaces') return reply(200,await listWorkspaces());
        if(req.method==='POST' && req.url==='/v1/stop') { await stopTask(); return reply(200,{stopped:true}); }
        if(req.method==='POST' && (req.url==='/v1/messages' || req.url==='/v1/approval' || req.url==='/v1/model' || req.url==='/v1/reasoning' || req.url==='/v1/workspace')) {
          const chunks=[]; let size=0; const limit=req.url==='/v1/messages'?1600000:50000;
          for await (const chunk of req) { size+=chunk.length; if(size>limit) return reply(413,{error:'消息过长'}); chunks.push(chunk); }
          const body=Buffer.concat(chunks).toString('utf8');
          const parsed=JSON.parse(body);
          if(req.url==='/v1/workspace') { if(!parsed || typeof parsed.id!=='string' || !parsed.id || parsed.id.length>200) return reply(400,{error:'工作空间标识无效'}); return reply(200,await selectWorkspace(parsed.id)); }
          if(req.url==='/v1/reasoning') { if(!parsed || typeof parsed.model!=='string' || !parsed.model || parsed.model.length>200 || typeof parsed.effort!=='string' || !/^(default|none|enabled|minimal|low|medium|high|xhigh|max|ultra)$/.test(parsed.effort)) return reply(400,{error:'思考强度无效'}); return reply(200,await setReasoning(parsed.model,parsed.effort)); }
          if(req.url==='/v1/model') { if(!parsed || typeof parsed.model!=='string' || !parsed.model || parsed.model.length>200) return reply(400,{error:'模型标识无效'}); return reply(200,await selectModel(parsed.model)); }
          if(req.url==='/v1/approval') { if(!parsed || typeof parsed.id!=='string' || typeof parsed.approved!=='boolean') return reply(400,{error:'审批参数无效'}); if(!await approve({id:parsed.id,approved:parsed.approved})) return reply(409,{error:'审批已失效或不允许手动处理'}); return reply(200,{accepted:true}); }
          if(!parsed || typeof parsed.text!=='string') return reply(400,{error:'消息无效'});
          if(parsed.attachments!==undefined && (!Array.isArray(parsed.attachments) || parsed.attachments.length>1)) return reply(400,{error:'附件无效'});
          return reply(200,await submit(parsed.text,parsed.attachments));
        }
        return reply(404,{error:'不存在'});
      } catch(error) { return reply(400,{error:String(error.message||'请求失败').slice(0,300)}); }
    });
    instance.requestTimeout=15000; instance.headersTimeout=10000;
    try { await new Promise((resolve,reject)=>{instance.once('error',reject);instance.listen(requestedPort,'0.0.0.0',resolve);}); server=instance; port=instance.address().port; return status(); }
    catch(error) { token=null;fingerprint=null;throw error; }
  });
  return {start,stop,status};
}
module.exports={createMobileRemote,ephemeralCertificate};
