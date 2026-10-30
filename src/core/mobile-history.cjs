'use strict';

// Bounded, display-only projection. Never return raw event objects, image
// payloads, provider state, credentials, or other internal session metadata.
function mobileTimeline({ messages = [], events = [], subagents = [], taskRuns = [], redact = x => x } = {}) {
  const LIMIT=6000, MAX_ITEMS=250, MAX_CHARS=140000;
  const text = value => {
    let raw;
    if (typeof value === 'string') { raw=value.slice(0,12000); if (/^\s*[\[{]/.test(raw)) { try { const parsed=JSON.parse(raw); if(parsed && typeof parsed==='object') raw=JSON.stringify(clean(parsed)); } catch { /* Plain text is preserved. */ } } }
    else { try { raw=JSON.stringify(clean(value)); } catch { raw='[无法显示]'; } }
    if (typeof raw !== 'string') return '';
    raw=raw.replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=_-]+/gi,'[图片数据已省略]')
      .replace(/("(?:token|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|secret)"\s*:\s*")[^"]*(")/gi,'$1[已隐藏]$2')
      .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|secret|token)\s*[=:]\s*)(?:bearer\s+)?[^\s,;"}]+/gi,'$1[已隐藏]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [已隐藏]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已隐藏]@');
    try { raw=String(redact(raw)); } catch { return '[无法显示]'; }
    return raw.length>LIMIT ? raw.slice(0,LIMIT)+'\n[内容已截断]' : raw;
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
  const rows=[], calls=new Set(), results=new Set(), agents=new Map();
  const add=(entry,index,order)=>rows.push({ entry, index, order, seq:rows.length });
  messages.forEach((m,i)=>{
    if(!m || typeof m!=='object')return;
    if((m.role==='user'||m.role==='assistant') && typeof m.content==='string' && m.content) add({type:'message',role:m.role,content:text(m.content)},i,0);
    if(m.role==='assistant' && Array.isArray(m.toolCalls)) for(const c of m.toolCalls) {
      if(!c || typeof c!=='object')continue;const id=text(c.id||'');if(id)calls.add(id);
      add({type:'tool_call',id,name:text(c.name||'工具'),content:text(c.arguments ?? {})},i,1);
    }
    if(m.role==='tool') { const id=text(m.toolCallId||'');if(id)results.add(id);add({type:'tool_result',id,name:text(m.name||''),content:text(m.content ?? '')},i,0); }
  });
  for(const a of subagents) if(a && typeof a.id==='string') agents.set(a.id,a);
  for(const e of events) if(e?.type==='subagent-update' && typeof e.agent?.id==='string') agents.set(e.agent.id,{...agents.get(e.agent.id),...e.agent,_index:e.messageIndex});
  for(const a of agents.values()) {
    const run=taskRuns.find(r=>r?.runId && r.runId===a.parentRunId), index=Number.isInteger(a._index)?a._index:Number.isInteger(run?.messageIndex)?run.messageIndex:messages.length;
    add({type:'subagent',id:text(a.id),name:text(a.name||'子任务'),status:text(a.status||''),task:text(a.task||''),summary:text(a.summary||a.error||''),activity:text(a.activity||[])},index,2);
  }
  for(const e of events) {
    if(!e || !['tool-start','tool-result'].includes(e.type))continue;const id=text(e.toolCallId||'');
    if(id && (e.type==='tool-start'?calls:results).has(id))continue;
    if(id) (e.type==='tool-start'?calls:results).add(id);
    add({type:e.type==='tool-start'?'tool_call':'tool_result',id,name:text(e.name||'工具'),content:text(e.type==='tool-start'?e.args??{}:e.result??'')},Number.isInteger(e.messageIndex)?e.messageIndex:messages.length,3);
  }
  rows.sort((a,b)=>a.index-b.index || a.order-b.order || a.seq-b.seq);
  const result=[];let size=0, omitted=rows.length>MAX_ITEMS;
  for(const {entry} of rows.slice(-MAX_ITEMS).reverse()) { const n=JSON.stringify(entry).length;if(size+n>MAX_CHARS){omitted=true;break;}size+=n;result.push(entry); }
  result.reverse();if(omitted)result.unshift({type:'notice',content:'较早的会话内容已省略'});return result;
}
module.exports={mobileTimeline};
