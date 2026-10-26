import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { testTempRoot } from './helpers/temp-root.mjs';
import { runAgent } from '../src/core/agent.mjs';
import { WorkspaceTools, TOOL_DEFINITIONS } from '../src/core/workspace.mjs';
import { requestModel } from '../src/core/providers.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const bytes = Buffer.from(png, 'base64');
const image = { id: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), name: 'preview.png',
  mediaType: 'image/png', dataUrl: 'data:image/png;base64,' + png };
const config = { provider: 'openai', model: 'local-image-fixture', apiKey: 'test-placeholder',
  modelCapabilities: { supportsImages: true, contextWindow: 128000 } };
const reply = (content = '', toolCalls = []) => ({ message: { role: 'assistant', content, toolCalls }, usageReported: false });
const view = id => ({ id, name: 'view_image', arguments: { path: 'preview.png' } });
const loaded = () => JSON.stringify({ path: 'preview.png', bytes: bytes.length, name: image.name, mediaType: image.mediaType, status: 'loaded' });
const options = extra => ({ config, messages: [{ id: 'current-user', role: 'user', content: '核对调整后的界面截图。' }],
  signal: new AbortController().signal, toolDefinitions: TOOL_DEFINITIONS, emit: () => {}, ...extra });

test('a real local image read reaches the next Responses request before a view receipt without making a new user turn', async t => {
  const directory = await fs.mkdtemp(path.join(testTempRoot, 'agent-view-image-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(testTempRoot)); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(path.join(directory, 'preview.png'), bytes);
  const workspace = new WorkspaceTools(directory), messages = options({}).messages, events = [], bodies = [];
  await runAgent(options({ messages, workspace, emit: event => events.push(event),
    requestModel: request => requestModel({ ...request, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      assert.equal(events.filter(event => event.type === 'images-viewed').length, 0);
      if (bodies.length === 1) return Response.json({ status: 'completed', output: [
        { type: 'function_call', call_id: 'local-image', name: 'view_image', arguments: JSON.stringify({ path: 'preview.png' }) },
      ] });
      const output = bodies[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'local-image');
      assert.equal(output.output.find(item => item.type === 'input_image').image_url, image.dataUrl);
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '界面已核对。' }] }] });
    } }) }));
  assert.equal(bodies.length, 2); assert.equal(messages.filter(message => message.role === 'user').length, 1);
  const tool = messages.find(message => message.role === 'tool');
  assert.equal(tool.source, 'image-tool'); assert.equal(tool.attachments[0].dataUrl, image.dataUrl);
  assert.equal(tool.content.includes(png), false); assert.equal(messages.at(-1).content, '界面已核对。');
  const receipts = events.filter(event => event.type === 'images-viewed'); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].images[0].messageId, tool.id);
  assert.equal(JSON.stringify(events).includes(png), false, 'Image bytes belong in the archive, never generic tool/event logs.');
});

test('reading an image followed by a failed model request never produces a viewed receipt', async () => {
  const events = [], messages = options({}).messages; let calls = 0;
  await assert.rejects(runAgent(options({ messages, emit: event => events.push(event),
    workspace: { root: 'C:/fixture', execute: async (_name, _args, { onImage }) => { await onImage({ path: 'preview.png', bytes: bytes.length, attachment: image }); return loaded(); } },
    requestModel: async () => { if (!calls++) return reply('', [view('read-image')]); throw Object.assign(new Error('Denied by fixture'), { retryable: false }); },
  })), /Denied by fixture/u);
  assert.equal(events.some(event => event.type === 'images-viewed'), false);
  assert.equal(messages.find(message => message.role === 'tool').attachments.length, 1, 'The local read remains archived without a view claim.');
});

test('multiple image tool results use bounded preview batches belonging to one real model request', async () => {
  const events = [], messages = options({}).messages; let calls = 0, read = 0;
  const images = Array.from({length:5},(_,index)=>{
    const note=Buffer.from(`fixture\0${index}`),chunk=Buffer.alloc(note.length+12);
    chunk.writeUInt32BE(note.length);chunk.write('tEXt',4,'ascii');note.copy(chunk,8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4,8+note.length)),8+note.length);
    const data=Buffer.concat([bytes.subarray(0,-12),chunk,bytes.subarray(-12)]);
    return {bytes:data.length,attachment:{...image,id:'sha256:'+createHash('sha256').update(data).digest('hex'),dataUrl:'data:image/png;base64,'+data.toString('base64')}};
  });
  await runAgent(options({messages,emit:event=>events.push(event),workspace:{root:'C:/fixture',execute:async(_name,_args,{onImage})=>{
    const value={path:'preview.png',...images[read++]};await onImage(value);
    return JSON.stringify({path:value.path,bytes:value.bytes,status:'loaded'});
  }},requestModel:async()=>!calls++?reply('',images.map((_,index)=>view('image-'+index))):reply('核对完成。')}));
  const receipts=events.filter(event=>event.type==='images-viewed');
  assert.deepEqual(receipts.map(event=>event.images.length),[4,1]);
  assert.equal(receipts[1].requestId,receipts[0].requestId+':1');
  assert.equal(new Set(receipts.flatMap(event=>event.images.map(ref=>ref.messageId))).size,5);
  assert.equal(messages.filter(message=>message.role==='user').length,1);
});

test('an explicitly text-only model gets a tool failure without reading or attaching any local image', async () => {
  let executions = 0, calls = 0; const events = [], messages = options({}).messages;
  await runAgent(options({ messages, config: { ...config, modelCapabilities: { ...config.modelCapabilities, supportsImages: false } },
    emit: event => events.push(event), workspace: { root: 'C:/fixture', execute: async () => { executions++; return loaded(); } },
    requestModel: async request => {
      if (!calls++) return reply('', [view('unsupported')]);
      assert.match(request.messages.at(-1).content, /不支持图片/u); return reply('需要支持图片的模型才能核对截图。');
    } }));
  assert.equal(executions, 0); assert.equal(messages.some(message => message.attachments?.length), false);
  assert.equal(events.some(event => event.type === 'images-viewed'), false);
});

test('invalid callback results and false loaded metadata cannot masquerade as a model-viewed image', async () => {
  for (const execute of [
    async () => loaded(),
    async (_name, _args, { onImage }) => { await onImage({ path: 'preview.png', bytes: bytes.length + 1, attachment: image }); return loaded(); },
    async (_name, _args, { onImage }) => { await onImage({ path: 'preview.png', bytes: bytes.length, attachment: image }); return '错误：读取后被取消'; },
    async (_name, _args, { onImage }) => { await onImage({ path: 'preview.png', bytes: bytes.length, attachment: image }); await onImage({ path: 'preview.png', bytes: bytes.length, attachment: image }); return loaded(); },
  ]) {
    let calls = 0; const events = [], messages = options({}).messages;
    await runAgent(options({ messages, emit: event => events.push(event), workspace: { root: 'C:/fixture', execute },
      requestModel: async () => !calls++ ? reply('', [view('invalid')]) : reply('无法核对这张截图。') }));
    assert.equal(messages.some(message => message.attachments?.length), false);
    assert.equal(events.some(event => event.type === 'images-viewed'), false);
    assert.match(messages.find(message => message.role === 'tool').content, /失败|未返回|未完成/u);
  }
});

test('cancelling after a local read cannot send the image or create a view claim', async () => {
  const controller = new AbortController(), events = [], messages = options({}).messages; let calls = 0;
  await assert.rejects(runAgent(options({ messages, signal: controller.signal, emit: event => events.push(event),
    workspace: { root: 'C:/fixture', execute: async (_name, _args, { onImage }) => {
      await onImage({ path: 'preview.png', bytes: bytes.length, attachment: image }); controller.abort(); return loaded();
    } }, requestModel: async () => { calls++; return reply('', [view('cancelled')]); } })), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(messages.some(message => message.attachments?.length), false);
  assert.equal(events.some(event => event.type === 'images-viewed'), false);
});
