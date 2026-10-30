import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mobileTimeline }=createRequire(import.meta.url)('../src/core/mobile-history.cjs');

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
test('mobile timeline bounds individual fields and announces omitted history',()=>{
  const rows=mobileTimeline({messages:Array.from({length:300},(_,i)=>({role:'user',content:`${i}:`+'x'.repeat(60000)}))});
  assert.equal(rows[0].type,'notice');assert.match(rows[0].content,/省略/);assert(rows.at(-1).content.endsWith('[内容已截断]'));assert(JSON.stringify(rows).length<210000);
});
test('a reasonably long streamed answer remains intact when it becomes a saved message',()=>{
  const content='answer '.repeat(3000);
  const [row]=mobileTimeline({messages:[{role:'assistant',content}]});
  assert.equal(row.content,content);
});
