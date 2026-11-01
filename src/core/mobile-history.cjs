'use strict';

// Bounded, display-only projection. Never return raw event objects, image
// payloads, provider state, credentials, or other internal session metadata.
function mobileTimeline({ messages = [], events = [], subagents = [], taskRuns = [], viewedImages = [], redact = x => x } = {}) {
  const LIMIT=6000, MESSAGE_LIMIT=50000, MAX_ITEMS=250, MAX_CHARS=200000;
  const text = (value, limit=LIMIT) => {
    let raw;
    if (typeof value === 'string') { raw=value.slice(0,Math.max(12000,limit+1)); if (limit===LIMIT && /^\s*[\[{]/.test(raw)) { try { const parsed=JSON.parse(raw); if(parsed && typeof parsed==='object') raw=JSON.stringify(clean(parsed)); } catch { /* Plain text is preserved. */ } } }
    else { try { raw=JSON.stringify(clean(value)); } catch { raw='[无法显示]'; } }
    if (typeof raw !== 'string') return '';
    raw=raw.replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=_-]+/gi,'[图片数据已省略]')
      .replace(/("(?:token|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|secret)"\s*:\s*")[^"]*(")/gi,'$1[已隐藏]$2')
      .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|secret|token)\s*[=:]\s*)(?:bearer\s+)?[^\s,;"}]+/gi,'$1[已隐藏]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [已隐藏]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已隐藏]@');
    try { raw=String(redact(raw)); } catch { return '[无法显示]'; }
    return raw.length>limit ? raw.slice(0,limit)+'\n[内容已截断]' : raw;
  };
  function clean(value, depth=0) {
    if(depth>7) return '[嵌套内容已省略]';
    if(typeof value==='string') return value.slice(0,12000).replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=_-]+/gi,'[图片数据已省略]');
    if(!value || typeof value!=='object') return value;
    if(Array.isArray(value)) return value.slice(0,40).map(x=>clean(x,depth+1));
    const out={}; for(const [key,item] of Object.entries(value).slice(0,60)) {
      if(/^(?:attachments?|images?|imageData|dataUrl|providerState)$/i.test(key)) continue;
      out[key]=/^(?:token|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|secret)$/i.test(key) ? '[已隐藏]' : clean(item,depth+1);
    } return out;
  }
  // Prefer each run's own activity log, as the desktop does, when available.
  // Keep only matching public event kinds and anchor old events without a
  // messageIndex to the latest matching tool result in that run.
  const archivedEvents=[], archivedPositions=new Map();
  const resultIndices=new Map();
  messages.forEach((m,i)=>{if(m?.role==='tool'&&m.toolCallId)resultIndices.set(String(m.toolCallId),i);});
  for(const run of taskRuns) {
    const id=run?.runId||run?.id;
    if(typeof id!=='string'||!id||!Array.isArray(run.activityEvents))continue;
    let anchor=Number.isInteger(run.messageStartIndex)?run.messageStartIndex:0;
    for(const original of run.activityEvents) {
      if(!original||typeof original!=='object'||original.runId&&original.runId!==id)continue;
      if(!['tool-start','tool-result','subagent-update'].includes(original.type))continue;
      const e={...original,runId:id};
      if(e.type==='tool-result'&&resultIndices.has(String(e.toolCallId||'')))anchor=resultIndices.get(String(e.toolCallId));
      const position=Number.isInteger(e.messageIndex)?e.messageIndex:anchor;
      archivedPositions.set(e,position);archivedEvents.push(e);
    }
  }
  // A live run can have a partial archived log. Merge its newer events rather
  // than dropping the rest of the run; update matching snapshots in place.
  const eventKey=e=>{
    if(!e?.runId)return '';
    const id=e.type==='subagent-update'?e.agent?.id:e.toolCallId;
    return typeof id==='string'&&id ? JSON.stringify([e.runId,e.type,id]) : '';
  };
  const archivedKeys=new Map();
  archivedEvents.forEach((e,i)=>{const key=eventKey(e);if(key&&!archivedKeys.has(key))archivedKeys.set(key,i);});
  const remaining=[];
  for(const e of events) {
    const key=eventKey(e), index=key?archivedKeys.get(key):undefined;
    if(index===undefined){remaining.push(e);continue;}
    const old=archivedEvents[index], merged={...old,...e};
    archivedPositions.set(merged,archivedPositions.get(old));archivedEvents[index]=merged;
  }
  events=[...archivedEvents,...remaining];
  // Suppress delegation bookkeeping rows; report failures as plain notices.
  // The model's original messages are never changed.
  const quietNames=new Set(['spawn_agent','wait_agents']), quietCalls=new Set(), failedCalls=new Set();
  const failed=value=>{ if(typeof value==='string'){if(/^(?:错误|工具执行失败|Error|操作已停止)/i.test(value))return true;try{value=JSON.parse(value);}catch{return false;}} return !!(value&&typeof value==='object'&&(value.error||value.denied||value.canceled||value.cancelled||value.success===false)); };
  for(const m of messages) if(m?.role==='assistant' && Array.isArray(m.toolCalls)) for(const call of m.toolCalls) if(quietNames.has(call?.name)&&call.id) quietCalls.add(String(call.id));
  for(const e of events) if(e?.type==='tool-start'&&quietNames.has(e.name)&&e.toolCallId) quietCalls.add(String(e.toolCallId));
  for(const m of messages) if(m?.role==='tool'&&m.toolCallId&&failed(m.content)) failedCalls.add(String(m.toolCallId));
  for(const e of events) if(e?.type==='tool-result'&&e.toolCallId&&failed(e.result)) failedCalls.add(String(e.toolCallId));
  const hide=(name,id)=> quietNames.has(name)||quietCalls.has(String(id||''));
  const rows=[], calls=new Set(), results=new Set(), agents=new Map(), quietNotices=new Set();
  const add=(entry,index,order)=>rows.push({ entry, index, order, seq:rows.length });
  for(const image of viewedImages) if(image && /^[a-f0-9]{64}$/.test(image.id||'')&&typeof image.sessionId==='string') add({type:'viewed_image',id:image.id,sessionId:image.sessionId,name:text(image.name||'图片',120)},Number.isInteger(image.messageIndex)?image.messageIndex:messages.length,2);
  messages.forEach((m,i)=>{
    if(!m || typeof m!=='object')return;
    if((m.role==='user'||m.role==='assistant') && typeof m.content==='string' && m.content) add({type:'message',role:m.role,content:text(m.content,MESSAGE_LIMIT)},i,0);
    if(m.role==='assistant' && Array.isArray(m.toolCalls)) for(const c of m.toolCalls) {
      if(!c || typeof c!=='object')continue;const id=text(c.id||'');if(hide(c.name,id))continue;if(id)calls.add(id);
      add({type:'tool_call',id,name:text(c.name||'工具'),content:text(c.arguments ?? {})},i,1);
    }
    if(m.role==='tool') { const id=text(m.toolCallId||'');if(hide(m.name,id)){if(failedCalls.has(id)&&!quietNotices.has(id)){quietNotices.add(id);add({type:'notice',content:'子任务操作未完成：'+text(m.content ?? '')},i,0);}return;}if(id)results.add(id);add({type:'tool_result',id,name:text(m.name||''),content:text(m.content ?? '')},i,0); }
  });
  // A child's status changes over time, but its card belongs at the original
  // spawn operation. Archived snapshots can carry a later messageIndex.
  const spawnCalls=new Set(), spawnPositions=new Map();
  for(const m of messages) if(m?.role==='assistant'&&Array.isArray(m.toolCalls)) for(const c of m.toolCalls)
    if(c?.name==='spawn_agent'&&c.id) spawnCalls.add(String(c.id));
  messages.forEach((m,i)=>{
    if(m?.role!=='tool'||!spawnCalls.has(String(m.toolCallId||'')))return;
    try { const value=typeof m.content==='string'?JSON.parse(m.content):m.content;
      if(typeof value?.id==='string'&&!spawnPositions.has(value.id))spawnPositions.set(value.id,i);
    } catch { /* Failed or incomplete spawn has no child card. */ }
  });
  for(const a of subagents) if(a && typeof a.id==='string') agents.set(a.id,a);
  for(const e of events) if(e?.type==='subagent-update' && typeof e.agent?.id==='string') {
    const previous=agents.get(e.agent.id);
    agents.set(e.agent.id,{...previous,...e.agent,_index:Number.isInteger(previous?._index)?previous._index:(archivedPositions.get(e)??e.messageIndex)});
  }
  for(const a of agents.values()) {
    const run=taskRuns.find(r=>r?.runId && r.runId===a.parentRunId), spawned=spawnPositions.get(a.id), index=Number.isInteger(spawned)?spawned:Number.isInteger(a._index)?a._index:Number.isInteger(run?.messageIndex)?run.messageIndex:messages.length;
    add({type:'subagent',id:text(a.id),name:text(a.name||'子任务'),status:text(a.status||''),task:text(a.task||''),summary:text(a.summary||a.error||''),activity:text(a.activity||[])},index,2);
  }
  for(const e of events) {
    if(!e || !['tool-start','tool-result'].includes(e.type))continue;const id=text(e.toolCallId||'');if(hide(e.name,id)){if(e.type==='tool-result'&&failed(e.result)&&!quietNotices.has(id)){quietNotices.add(id);add({type:'notice',content:'子任务操作未完成：'+text(e.result)},Number.isInteger(e.messageIndex)?e.messageIndex:messages.length,3);}continue;}
    if(id && (e.type==='tool-start'?calls:results).has(id))continue;
    if(id) (e.type==='tool-start'?calls:results).add(id);
    const position=archivedPositions.get(e)??e.messageIndex;
    add({type:e.type==='tool-start'?'tool_call':'tool_result',id,name:text(e.name||'工具'),content:text(e.type==='tool-start'?e.args??{}:e.result??'')},Number.isInteger(position)?position:messages.length,3);
  }
  rows.sort((a,b)=>a.index-b.index || a.order-b.order || a.seq-b.seq);
  const result=[];let size=0, omitted=rows.length>MAX_ITEMS;
  for(const {entry} of rows.slice(-MAX_ITEMS).reverse()) { const n=JSON.stringify(entry).length;if(size+n>MAX_CHARS){omitted=true;break;}size+=n;result.push(entry); }
  result.reverse();if(omitted)result.unshift({type:'notice',content:'较早的会话内容已省略'});return result;
}
module.exports={mobileTimeline};
