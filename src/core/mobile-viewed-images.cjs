'use strict';
const crypto=require('node:crypto');
// Project only image references present in an actual view receipt. Never accept a path.
function viewedImages(session) {
  if(!session || !Array.isArray(session.messages) || !Array.isArray(session.imageViews)) return [];
  const out=[];
  for(const receipt of session.imageViews) {
    if(receipt?.type!=='images-viewed'||receipt.version!==1||typeof receipt.runId!=='string'||typeof receipt.requestId!=='string'||!Array.isArray(receipt.images)||receipt.images.length>64) continue;
    const sources=[...session.messages,...(Array.isArray(session.imageToolSources)?session.imageToolSources:[]).filter(x=>x?.runId===receipt.runId && Number.isInteger(x.messageIndex) && x.messageIndex>=0 && x.messageIndex<session.messages.length)];
    for(const ref of receipt.images) {
      if(typeof ref?.messageId!=='string'||!Number.isInteger(ref.attachmentIndex)||ref.attachmentIndex<0||ref.attachmentIndex>3)continue;
      const matches=sources.filter(s=>s?.id===ref.messageId&&(s.role==='user'||s.role==='tool'&&s.source==='image-tool'));
      if(matches.length!==1)continue;
      const a=matches[0].attachments?.[ref.attachmentIndex];
      if(!a||ref.attachmentId!==undefined&&a.id!==ref.attachmentId||typeof a.dataUrl!=='string')continue;
      const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z\d+/]+={0,2})$/u.exec(a.dataUrl);
      if(!match||match[2].length%4||a.mediaType&&a.mediaType!==match[1])continue;
      const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>2*1024*1024||bytes.toString('base64')!==match[2])continue;
      const id=crypto.createHash('sha256').update(JSON.stringify([session.id,receipt.runId,receipt.requestId,ref.messageId,ref.attachmentIndex,ref.attachmentId??null])).digest('hex');
      const name=String(a.name||'图片').split(/[\\/]/u).pop().replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu,'').slice(0,80)||'图片';
      out.push({id,name,sessionId:session.id,mediaType:match[1],dataUrl:a.dataUrl,messageIndex:Number.isInteger(receipt.messageIndex)?receipt.messageIndex:session.messages.length});
    }
  }
  return out;
}
module.exports={viewedImages};
