import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mobileTimeline }=createRequire(import.meta.url)('../src/core/mobile-history.cjs');

test('delegation bookkeeping is hidden, while failures and actual child cards remain visible', () => {
  const calls=[{id:'s',name:'spawn_agent',arguments:{}},{id:'w',name:'wait_agents',arguments:{}},{id:'bad',name:'spawn_agent',arguments:{}},{id:'other',name:'send_agent_message',arguments:{}}];
  const rows=mobileTimeline({messages:[{role:'assistant',toolCalls:calls},{role:'tool',toolCallId:'s',content:'{"id":"agent-1"}'},{role:'tool',toolCallId:'w',content:'[]'},{role:'tool',toolCallId:'bad',content:'工具执行失败：范围无效'},{role:'tool',toolCallId:'other',content:'ok'}],subagents:[{id:'agent-1',name:'Child',status:'running'}]});
  assert.equal(rows.some(row=>row.id==='s'||row.id==='w'),false);
  assert.equal(rows.filter(row=>row.id==='bad').length,0);
  assert.equal(rows.filter(row=>row.type==='notice' && row.content.includes('子任务操作未完成')).length,1);
  assert.ok(rows.some(row=>row.id==='other'));
  assert.ok(rows.some(row=>row.type==='subagent'&&row.id==='agent-1'));
});

test('mobile timeline preserves conversation order and deduplicates live tool events',()=>{
  const history=mobileTimeline({messages:[{role:'user',content:'任务'}, {role:'assistant',content:'开始',toolCalls:[{id:'c1',name:'read_file',arguments:{path:'a.txt'}}]}, {role:'tool',toolCallId:'c1',content:'文件内容'}, {role:'assistant',content:'完成'}],events:[{type:'tool-start',toolCallId:'c1',name:'read_file',args:{path:'a.txt'}},{type:'tool-result',toolCallId:'c1',result:'文件内容'},{type:'tool-start',toolCallId:'c2',name:'write_file',args:{path:'b.txt'}}]});
  assert.deepEqual(history.map(x=>x.type),['message','message','tool_call','tool_result','message','tool_call']);
  assert.equal(history.find(x=>x.type==='tool_call').content,'{"path":"a.txt"}');
  assert.equal(history.find(x=>x.type==='tool_result').content,'文件内容');
});
test('mobile timeline includes the latest child progress near its task and strips secrets and images',()=>{
  const rows=mobileTimeline({messages:[{role:'assistant',content:'Using SUPERSECRET',toolCalls:[{id:'c',name:'write_file',arguments:{password:'bad',text:'data:image/png;base64,AAAA'}}]},{role:'tool',toolCallId:'c',content:'{"access_token":"danger","result":"ok"}'}],taskRuns:[{runId:'run',messageIndex:1}],subagents:[{id:'child',parentRunId:'run',name:'检查',task:'检查文件',status:'running',summary:'',activity:[]}],events:[{type:'subagent-update',messageIndex:1,agent:{id:'child',name:'检查',status:'completed',summary:'完成',activity:[{text:'结果'}]}}],redact:value=>value.replaceAll('SUPERSECRET','[hidden]')});
  const output=JSON.stringify(rows);assert(!output.includes('SUPERSECRET'));assert(!output.includes('danger'));assert(!output.includes('bad'));assert(!output.includes('base64,AAAA'));assert(output.includes('[已隐藏]'));
  const agent=rows.find(x=>x.type==='subagent');assert.equal(agent.status,'completed');assert.equal(agent.summary,'完成');assert.match(agent.activity,/结果/);
});
test('child card stays at its spawn while later updates replace its status',()=>{
  const messages=[{role:'user',content:'任务'},
    {role:'assistant',content:'开始子任务',toolCalls:[{id:'spawn',name:'spawn_agent',arguments:{}}]},
    {role:'tool',toolCallId:'spawn',content:'{"id":"agent-1"}'},
    {role:'assistant',toolCalls:[{id:'read',name:'read_file',arguments:{path:'a'}}]},
    {role:'tool',toolCallId:'read',content:'结果'}, {role:'assistant',content:'结束'}];
  const rows=mobileTimeline({messages,events:[
    {type:'subagent-update',messageIndex:1,agent:{id:'agent-1',status:'running'}},
    {type:'subagent-update',messageIndex:5,agent:{id:'agent-1',status:'completed',summary:'已完成'}}]});
  const child=rows.findIndex(row=>row.type==='subagent');
  assert(child>rows.findIndex(row=>row.content==='开始子任务'));
  assert(child<rows.findIndex(row=>row.id==='read'));
  assert.equal(rows[child].status,'completed'); assert.equal(rows[child].summary,'已完成');
});
test('per-run activity survives session event rollover without duplicating calls or leaking extra fields',()=>{
  const messages=[{role:'user',content:'任务'},
    {role:'assistant',toolCalls:[{id:'read',name:'read_file',arguments:{path:'a'}}]},
    {role:'tool',toolCallId:'read',content:'文件'}, {role:'assistant',content:'完成'}];
  const start={type:'tool-start',runId:'r',toolCallId:'read',name:'read_file',args:{path:'a'},private:'SECRET_PRIVATE'};
  const result={type:'tool-result',runId:'r',toolCallId:'read',name:'read_file',result:'文件'};
  const extra={type:'tool-start',runId:'r',toolCallId:'event-only',name:'search_files',args:{query:'text'}};
  const rows=mobileTimeline({messages,taskRuns:[{runId:'r',messageStartIndex:0,messageIndex:3,activityEvents:[start,result,extra]}],events:[start,result,extra]});
  assert.equal(rows.filter(row=>row.id==='read'&&row.type==='tool_call').length,1);
  assert.equal(rows.filter(row=>row.id==='event-only').length,1);
  assert(rows.findIndex(row=>row.id==='event-only')<rows.findIndex(row=>row.content==='完成'));
  assert(!JSON.stringify(rows).includes('SECRET_PRIVATE'));
});
test('live events after a partial run archive remain visible and refresh child state',()=>{
  const messages=[{role:'user',content:'任务'}, {role:'assistant',content:'继续'}];
  const prior={type:'subagent-update',runId:'r',agent:{id:'agent',name:'检查',status:'running'}};
  const current={...prior,messageIndex:1,agent:{id:'agent',name:'检查',status:'completed',summary:'完成'}};
  const next={type:'tool-start',runId:'r',messageIndex:1,toolCallId:'new',name:'search_files',args:{query:'new'}};
  const rows=mobileTimeline({messages,taskRuns:[{runId:'r',messageStartIndex:0,activityEvents:[prior]}],events:[current,next]});
  assert.equal(rows.filter(row=>row.type==='subagent').length,1);
  assert.equal(rows.find(row=>row.type==='subagent').status,'completed');
  assert(rows.some(row=>row.id==='new'&&row.type==='tool_call'));
});
test('mobile timeline bounds individual fields and announces omitted history',()=>{
  const rows=mobileTimeline({messages:Array.from({length:300},(_,i)=>({role:'user',content:`${i}:`+'x'.repeat(60000)}))});
  assert.equal(rows[0].type,'notice');assert.match(rows[0].content,/省略/);assert(rows.at(-1).content.endsWith('[内容已截断]'));assert(JSON.stringify(rows).length<210000);
});
test('a reasonably long streamed answer remains intact when it becomes a saved message',()=>{
  const content='answer '.repeat(3000);
  const [row]=mobileTimeline({messages:[{role:'assistant',content}]});
  assert.equal(row.content,content);
});
