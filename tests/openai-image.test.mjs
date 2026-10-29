import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOpenAIImage } from '../src/core/openai-image.mjs';

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(25)]).toString('base64');
const base = { apiKey:'fixture-private-key', model:'gpt-image-2.5-flare', prompt:'画一个小猫' };
test('OpenAI image generation sends only the chosen model and prompt to the official endpoint', async () => {
  let sent;
  const result = await generateOpenAIImage({ ...base, fetchImpl:async (url, options) => {
    sent = { url, options }; return new Response(JSON.stringify({ data:[{ b64_json:png }] }));
  } });
  assert.equal(sent.url,'https://api.openai.com/v1/images/generations'); assert.equal(sent.options.redirect,'error');
  assert.equal(sent.options.headers.Authorization,'Bearer fixture-private-key');
  assert.deepEqual(JSON.parse(sent.options.body),{ model:base.model, prompt:base.prompt, size:'auto', n:1, output_format:'png' });
  assert.equal(result.dataUrl,`data:image/png;base64,${png}`); assert.doesNotMatch(JSON.stringify(result),/fixture-private-key/);
});
test('HTTP failures and invalid data never expose server or credential details', async () => {
  await assert.rejects(generateOpenAIImage({...base,fetchImpl:async()=>new Response('fixture-private-key',{status:403})}),error=>/权限/.test(error.message)&&!error.message.includes('fixture-private-key'));
  await assert.rejects(generateOpenAIImage({...base,fetchImpl:async()=>new Response(JSON.stringify({data:[{b64_json:'bad'}]}))}),/有效/);
  await assert.rejects(generateOpenAIImage({...base,model:'text-model',fetchImpl:()=>assert.fail()}),/图像模型/);
});
test('a text model uses the official Responses image tool and reads its result', async () => {
  let sent; const result = await generateOpenAIImage({ ...base, textModel:'gpt-6.1-sol', fetchImpl:async (url, options) => {
    sent={url,options}; return new Response(JSON.stringify({output:[{type:'image_generation_call',result:png}]}));
  }});
  assert.equal(sent.url,'https://api.openai.com/v1/responses');
  assert.deepEqual(JSON.parse(sent.options.body),{model:'gpt-6.1-sol',input:base.prompt,tools:[{type:'image_generation',model:base.model,size:'auto',output_format:'png'}],tool_choice:{type:'image_generation'}});
  assert.equal(result.dataUrl,`data:image/png;base64,${png}`);
  await assert.rejects(generateOpenAIImage({...base,textModel:'gpt-image-2.5-flare'}),/文本模型/);
});
test('an aborted request propagates cancellation without sending a second request', async () => {
  const aborter=new AbortController(); aborter.abort(); let calls=0;
  await assert.rejects(generateOpenAIImage({...base,signal:aborter.signal,fetchImpl:async (_url,{signal})=>{calls++;signal.throwIfAborted();}}),{name:'AbortError'});
  assert.equal(calls,1);
});
