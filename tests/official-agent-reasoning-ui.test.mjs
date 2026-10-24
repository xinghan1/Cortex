import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../src/renderer/app.js',import.meta.url),'utf8');
function appFunction(name){const match=new RegExp(`function ${name}\\(`,'u').exec(source);assert.ok(match,name);const tail=source.slice(match.index),end=tail.slice(1).search(/\n(?:async )?function /u);return end<0?tail:tail.slice(0,end+1);}
function fixture(authMode,{compatible=true,options=['low','high']}={}){
  const nodes=new Map(),node=id=>{
    if(!nodes.has(id)){const classes=new Set();nodes.set(id,{id,value:'0',dataset:{},title:'',classList:{toggle(name,force){force?classes.add(name):classes.delete(name);},contains:name=>classes.has(name),remove:name=>classes.delete(name)},setAttribute(name,value){this[name]=value;},closest:()=>null});}
    return nodes.get(id);
  };
  const range=node('reasoning-effort');range.dataset={provider:'gemini',effort:'high',support:'known',options:JSON.stringify(options)};
  const state={settings:{provider:'gemini',authMode,model:'official-model'}},metadata={id:'official-model',displayName:'Official model',compatible};
  const context=vm.createContext({appState:state,$:node,window:{},currentAuthMode:()=>state.settings.authMode,selectedModelMetadata:()=>metadata,
    reasoningLabels:{low:'低',high:'高',default:'默认'},reasoningOptions:{gemini:['low','high']},modelControlBusy:()=>false,reasoningSaving:false,modelSaving:false});
  for(const name of ['rangeOptions','officialAgentReasoning','reasoningAvailable','renderComposerModel','updateReasoningControl'])vm.runInContext(appFunction(name),context);
  return{context,node,range,state,metadata};
}

test('all three complete official agents show their own read-only reasoning label, including catalogs advertising levels',()=>{
  for(const mode of ['antigravity-agent','kimi-agent','glm-agent'])for(const options of [[],['low','high']]){
    const f=fixture(mode,{options});f.context.updateReasoningControl(f.range);
    assert.equal(f.context.reasoningAvailable(f.range),false);assert.equal(f.range.disabled,true);assert.equal(f.node('reasoning-default').disabled,true);
    assert.equal(f.node('composer-reasoning-label').textContent,'官方代理');assert.equal(f.node('reasoning-value').textContent,'官方代理');
    assert.equal(f.node('composer-reasoning-label').classList.contains('is-unavailable'),false);
    assert.match(f.range.title,/推理与工具由官方代理管理/u);assert.match(f.range['aria-valuetext'],/官方代理/u);
  }
});

test('an actually incompatible official model still shows unavailable instead of implying usable agent access',()=>{
  const f=fixture('glm-agent',{compatible:false});f.context.updateReasoningControl(f.range);
  assert.equal(f.node('composer-reasoning-label').textContent,'不可用');assert.equal(f.node('reasoning-value').textContent,'不可用');assert.equal(f.range.disabled,true);
});

test('switching back to API models restores advertised reasoning controls without leaving the agent tooltip behind',()=>{
  const f=fixture('antigravity-agent');f.context.updateReasoningControl(f.range);f.state.settings.authMode='apiKey';
  f.context.updateReasoningControl(f.range,true);assert.equal(f.range.disabled,false);assert.equal(f.node('reasoning-default').disabled,false);
  assert.equal(f.node('composer-reasoning-label').textContent,'低');assert.equal(f.node('composer-reasoning-label').title,'');assert.equal(f.node('reasoning-value').title,'');
  assert.equal(f.range.title,'推理强度：低');
});
