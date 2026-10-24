import test from 'node:test';
import assert from 'node:assert/strict';
import { runExternalAgentTurn } from '../src/core/external-agent-turn.mjs';

function fixture(runTask, extra={}) {
  const events=[],usage=[],session={id:'local-session',messages:[]};
  const config={agent:{runTask},session,cwd:'C:/disposable-project',prompt:'完成本地测试',attachments:[],modelId:'official-model',runId:'run-1',
    emit:event=>events.push(event),onPermission:async()=>null,onUsage:async value=>usage.push(value),...extra};
  return{config,events,usage,session,run:()=>runExternalAgentTurn(config)};
}
const update=(options,value,localSessionId='local-session')=>options.onUpdate({localSessionId,sessionId:'official-session',update:value});
const text=(options,value)=>update(options,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}});
const content=value=>[{type:'content',content:{type:'text',text:value}}];
const tool=(options,value)=>update(options,{sessionUpdate:'tool_call',toolCallId:'cmd-1',kind:'execute',title:'运行检查',status:'in_progress',rawInput:{command:'fixture only'},...value});
const resultEvents=f=>f.events.filter(event=>event.type==='tool-result').map(event=>({...event,result:JSON.parse(event.result)}));
const displayed=(events,type)=>events.filter(event=>event.type===type).reduce((value,event)=>event.replace===true?event.text:value+event.text,'');

test('full-agent turns delegate prompt, model, attachments and permission selection without an application tool loop',async()=>{
  const permission={localSessionId:'local-session',sessionId:'official-session',options:[{optionId:'allow-native-once',kind:'allow_once'}]},asks=[];
  const handler=async value=>{asks.push(value);return 'allow-native-once';},questions=async()=>({action:'accept',content:{answers:{'选择方式':'local'}}}),attachments=[{name:'example.png',mediaType:'image/png',dataUrl:'data:image/png;base64,AA=='}];
  const f=fixture(async options=>{
    assert.equal(options.localSessionId,'local-session');assert.equal(options.cwd,'C:/disposable-project');assert.equal(options.prompt,'完成本地测试');assert.equal(options.modelId,'official-model');
    assert.equal(options.attachments,attachments);assert.equal(options.onPermission,handler);assert.equal(await options.onPermission(permission),'allow-native-once');
    assert.equal(options.onUserInput,questions);assert.equal((await options.onUserInput()).content.answers['选择方式'],'local');
    text(options,'由官方代理完成。');return{stopReason:'end_turn',usage:{inputTokens:40,outputTokens:7},usageReported:true};
  },{attachments,onPermission:handler,onUserInput:questions,provider:'kimi'});
  const result=await f.run();assert.equal(result.toolCount,0);assert.deepEqual(asks,[permission]);assert.equal(f.session.messages[0].source,'official-agent');
  assert.equal(f.usage.length,1);assert.equal(f.usage[0].provider,'kimi');assert.equal(f.usage[0].status,'completed');assert.equal(f.usage[0].inputTokens,40);
});

test('cumulative command snapshots replace displayed output and never duplicate completed tool results',async()=>{
  const f=fixture(async options=>{
    text(options,'开始检查。');tool(options,{content:content('line 1\n')});
    for(const value of ['line 1\n','line 1\nline 2\n','line 1\nline 2\n'])update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',content:content(value)});
    for(let index=0;index<2;index++)update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',status:'completed',content:content('line 1\nline 2\n')});
    text(options,'检查完成。');return{stopReason:'end_turn'};
  });
  const result=await f.run();assert.equal(result.toolCount,1);assert.equal(f.events.filter(event=>event.type==='tool-start').length,1);
  assert.equal(displayed(f.events,'command-output'),'line 1\nline 2\n');
  assert.ok(f.events.filter(event=>event.type==='command-output').every(event=>event.replace===true));
  assert.equal(resultEvents(f).length,1);assert.equal(resultEvents(f)[0].toolCallId,'run-1:cmd-1');assert.equal(resultEvents(f)[0].result.status,'completed');
  assert.deepEqual(f.session.messages.map(message=>message.content),['开始检查。','检查完成。']);
});

test('raw-output-only ACP tool updates retain the actual command output',async()=>{
  const f=fixture(async options=>{tool(options,{});update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',status:'completed',rawOutput:'native output\n'});return{stopReason:'end_turn'};});
  await f.run();assert.equal(resultEvents(f)[0].result.output,'native output\n');
  assert.equal(displayed(f.events,'command-output'),'native output\n');
});

test('successive native raw-output snapshots retain new progress and the final result without duplicates',async()=>{
  const f=fixture(async options=>{
    tool(options,{});
    for(const rawOutput of ['line 1\n','line 1\nline 2\n','line 1\nline 2\n'])update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',rawOutput});
    update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',status:'completed',rawOutput:'line 1\nline 2\ncomplete\n'});
    return{stopReason:'end_turn'};
  });
  await f.run();assert.equal(resultEvents(f)[0].result.output,'line 1\nline 2\ncomplete\n');
  assert.equal(displayed(f.events,'command-output'),'line 1\nline 2\ncomplete\n');
});

test('fresh native context contains only redacted prior visible text bound to the same connected profile and provider mode',async()=>{
  for(const [provider,mode]of [['gemini','antigravity-agent'],['kimi','kimi-agent'],['glm','glm-agent']]){
    let supplied;const f=fixture(async options=>{supplied=options;return{stopReason:'end_turn'};},{provider,redact:value=>value.replaceAll('SECRET','[redacted]')});
    Object.assign(f.session,{officialAgentProfileId:'same-profile',officialAgentMode:mode});
    f.config.agent.publicState=async()=>({session:{status:'connected',sharing:true,profileId:'same-profile'}});
    const history=[{role:'system',content:'PRIVATE_SYSTEM'},{role:'user',content:'visible SECRET request',attachments:[{data:'PRIVATE_IMAGE'}]},
      {role:'assistant',content:'visible SECRET answer',toolCalls:[{arguments:'PRIVATE_TOOL_ARGS'}]},
      {role:'tool',content:'PRIVATE_TOOL_RESULT'},{role:'assistant',content:'PRIVATE_INCOMPLETE',localOnly:true},
      {role:'assistant',content:'PRIVATE_HIDDEN',hidden:true},{role:'assistant',content:'PRIVATE_STATE',private:true},
      {role:'user',content:[{text:'PRIVATE_MULTIPART'}]},{role:'user',content:f.config.prompt}];
    f.session.messages.push(...history);await f.run();
    assert.deepEqual(supplied.contextMessages,[{role:'user',content:'visible [redacted] request'},{role:'assistant',content:'visible [redacted] answer'}]);
    assert.equal(supplied.prompt,f.config.prompt);assert.equal(supplied.attachments,f.config.attachments);
    assert.deepEqual(f.session.messages,history,'Preparing native context must not rewrite archived history');
    assert.doesNotMatch(JSON.stringify(supplied.contextMessages),/SECRET|PRIVATE|attachments|toolCalls/);
  }
});

test('missing, mismatched, disconnected or unshared account bindings never replay old text',async()=>{
  for(const patch of [{sessionProfile:null},{sessionProfile:'other'},{accountProfile:null},{accountProfile:'other'},
    {mode:'kimi-agent'},{provider:'relay'},{status:'connecting'},{status:'disconnected'},{sharing:false},{noState:true}]){
    let received;const f=fixture(async options=>{received=options.contextMessages;return{stopReason:'end_turn'};},{provider:patch.provider||'gemini'});
    Object.assign(f.session,{officialAgentProfileId:patch.sessionProfile===undefined?'same-profile':patch.sessionProfile,officialAgentMode:patch.mode||'antigravity-agent'});
    f.session.messages.push({role:'user',content:'OLD_PRIVATE_HISTORY'},{role:'user',content:f.config.prompt});
    if(!patch.noState)f.config.agent.publicState=async()=>({session:{status:patch.status||'connected',sharing:patch.sharing!==false,profileId:patch.accountProfile===undefined?'same-profile':patch.accountProfile}});
    await f.run();assert.deepEqual(received,[],JSON.stringify(patch));
  }
});

test('native context waits for the current account snapshot and cancellation during that check cannot send a task',async()=>{
  let resolveState,entered=false;const state=new Promise(resolve=>{resolveState=resolve;}),controller=new AbortController();
  const f=fixture(async()=>{entered=true;return{stopReason:'end_turn'};},{signal:controller.signal});
  f.config.agent.publicState=()=>state;const running=f.run();assert.equal(entered,false);
  controller.abort();resolveState({session:{status:'connected',sharing:true,profileId:'same-profile'}});
  await assert.rejects(running,{name:'AbortError'});assert.equal(entered,false);assert.equal(f.usage[0].status,'stopped');
});

test('split secrets never reappear in complete assistant or command display frames',async()=>{
  const f=fixture(async options=>{
    for(const chunk of ['prefix SEC','RET',' suffix'])text(options,chunk);
    tool(options,{rawOutput:'native SEC'});
    update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',rawOutput:'native SECRET'});
    update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',status:'completed',rawOutput:'native SECRET done'});
    return{stopReason:'end_turn'};
  },{redact:value=>value.replaceAll('SECRET','[redacted]')});
  await f.run();assert.doesNotMatch(JSON.stringify(f.events),/SECRET/);
  for(const type of ['text-delta','command-output']){
    let visible='';for(const event of f.events.filter(event=>event.type===type)){assert.equal(event.replace,true);visible=event.replace?event.text:visible+event.text;assert.doesNotMatch(visible,/SECRET/);}
  }
  assert.equal(displayed(f.events,'text-delta'),'prefix [redacted] suffix');
  assert.equal(displayed(f.events,'command-output'),'native [redacted] done');
  assert.equal(resultEvents(f)[0].result.output,'native [redacted] done');assert.equal(f.session.messages[0].content,'prefix [redacted] suffix');
});

test('an initially unknown Kimi operation upgrades to execute once and retains its earlier command snapshot',async()=>{
  const f=fixture(async options=>{
    tool(options,{kind:'other',rawInput:undefined,rawOutput:'line 1\n'});assert.equal(f.events.some(event=>event.type==='tool-start'),false);
    update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',kind:'execute',title:'实际命令',rawInput:{command:'fixture checked'}});
    update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',status:'completed',rawOutput:'line 1\nline 2\n'});return{stopReason:'end_turn'};
  });
  await f.run();const starts=f.events.filter(event=>event.type==='tool-start');assert.equal(starts.length,1);assert.equal(starts[0].name,'run_command');assert.deepEqual(starts[0].args,{command:'fixture checked'});
  assert.equal(resultEvents(f)[0].name,'run_command');assert.equal(displayed(f.events,'command-output'),'line 1\nline 2\n');
});

test('unknown native operations still receive one matching start and result on completion, failure or Stop',async()=>{
  for(const status of ['completed','failed','stopped']){
    const controller=new AbortController(),f=fixture(async options=>{
      tool(options,{kind:'other',rawOutput:'native detail'});
      if(status==='stopped'){controller.abort();options.signal.throwIfAborted();}
      update(options,{sessionUpdate:'tool_call_update',toolCallId:'cmd-1',status});return{stopReason:'end_turn'};
    },{signal:controller.signal});
    if(status==='stopped')await assert.rejects(f.run(),{name:'AbortError'});else await f.run();
    const starts=f.events.filter(event=>event.type==='tool-start'),results=resultEvents(f);assert.equal(starts.length,1);assert.equal(results.length,1);
    assert.equal(starts[0].name,'official_agent_tool');assert.equal(results[0].toolCallId,starts[0].toolCallId);assert.equal(results[0].result.status,status);
  }
});

test('thinking and plans preserve public progress while text and outputs pass through redaction',async()=>{
  const f=fixture(async options=>{
    update(options,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE_THOUGHT'}});
    update(options,{sessionUpdate:'plan',entries:[{content:'check SECRET',status:'in_progress'}]});text(options,'hello SECRET');
    tool(options,{title:'SECRET title',status:'completed',content:content('SECRET output')});return{stopReason:'end_turn'};
  },{redact:value=>value.replaceAll('SECRET','[redacted]')});
  await f.run();assert.ok(f.events.some(event=>event.type==='telemetry'&&event.phase==='thinking'));
  assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_THOUGHT|SECRET/);assert.equal(f.session.messages[0].content,'hello [redacted]');
  assert.equal(f.events.find(event=>event.type==='agent-plan').entries[0].content,'check [redacted]');
});

test('a different application session update fails before text or tool events can enter this transcript',async()=>{
  const f=fixture(async options=>{update(options,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OTHER_SESSION'}},'other-session');return{stopReason:'end_turn'};});
  await assert.rejects(f.run(),/其他会话/u);assert.equal(f.events.length,0);assert.equal(f.session.messages.length,0);assert.equal(f.usage[0].status,'failed');assert.equal(f.usage[0].reported,false);
});

test('abort marks pending operations stopped and retains partial text without claiming completion',async()=>{
  const controller=new AbortController(),f=fixture(async options=>{
    tool(options,{});text(options,'尚未完成的回复');controller.abort();options.signal.throwIfAborted();
  },{signal:controller.signal});
  await assert.rejects(f.run(),{name:'AbortError'});assert.equal(resultEvents(f)[0].result.status,'stopped');
  assert.equal(f.session.messages[0].localOnly,true);assert.equal(f.usage[0].status,'stopped');assert.equal(f.usage[0].partial,true);assert.equal(f.usage[0].inputTokens,null);
});

test('truncated or cancelled upstream turns cannot be reported as completed',async()=>{
  for(const stopReason of ['max_tokens','cancelled','error',undefined]){
    const f=fixture(async options=>{tool(options,{});text(options,'partial');return{stopReason,usage:{inputTokens:5,outputTokens:3},usageReported:true};});
    await assert.rejects(f.run(),/官方代理/u);assert.equal(f.usage[0].status,'failed');assert.equal(f.usage[0].partial,true);assert.equal(f.usage[0].reported,true);
    assert.equal(f.session.messages.at(-1).localOnly,true);assert.equal(resultEvents(f)[0].result.status,'incomplete');
  }
});

test('end_turn cannot complete a turn whose native tool is still running',async()=>{
  const f=fixture(async options=>{tool(options,{});text(options,'工具尚在运行');return{stopReason:'end_turn'};});
  await assert.rejects(f.run(),/官方代理/u);assert.equal(f.usage[0].status,'failed');assert.equal(f.session.messages.at(-1).localOnly,true);
  assert.equal(resultEvents(f)[0].result.status,'incomplete');
});

test('missing, declined or invalid usage stays unknown while explicit zero and bounded cache values remain valid',async()=>{
  for(const report of [{},{usage:{inputTokens:7,outputTokens:4},usageReported:false},{usage:{inputTokens:-1,outputTokens:0}},{usage:{inputTokens:10}}]){
    const f=fixture(async()=>({stopReason:'end_turn',...report}));await f.run();assert.equal(f.usage.length,1);assert.equal(f.usage[0].reported,false);assert.equal(f.usage[0].inputTokens,null);assert.equal(f.usage[0].outputTokens,null);
  }
  const zero=fixture(async()=>({stopReason:'end_turn',usage:{inputTokens:0,outputTokens:0},usageReported:true}));await zero.run();assert.equal(zero.usage[0].reported,true);assert.equal(zero.usage[0].inputTokens,0);
  for(const cached of [3,11,-1]){const f=fixture(async()=>({stopReason:'end_turn',usage:{inputTokens:10,outputTokens:4,cachedInputTokens:cached},usageReported:true}));await f.run();assert.equal(f.usage[0].inputTokens,10);assert.equal(f.usage[0].cachedInputTokens,cached===3?3:undefined);}
});

test('a rejected or invalid native tool is not relabeled as a successful operation',async()=>{
  const f=fixture(async options=>{tool(options,{status:'failed',content:content('permission denied')});return{stopReason:'end_turn'};});await f.run();
  assert.equal(resultEvents(f)[0].result.status,'failed');assert.equal(resultEvents(f)[0].result.output,'permission denied');
  const invalid=fixture(async options=>{tool(options,{toolCallId:''});return{stopReason:'end_turn'};});await assert.rejects(invalid.run(),/工具标识/u);assert.equal(invalid.events.some(event=>event.type==='tool-start'),false);
});
