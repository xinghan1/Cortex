// Exercises the real provider/agent/approval/usage path with a >8 MiB loopback SSE response.
// The large portion is protocol comments; actual reasoning, tool arguments and files stay small.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { dialog } = require('electron');

module.exports = async function smokeLargeResponse({ win, output, dataDir }) {
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const originalOpen = dialog.showOpenDialog;
  const fixture = path.join(dataDir, 'large-response-project-' + randomUUID());
  const nativeReasoning = 'PRIVATE_LARGE_SSE_NATIVE_REASONING_' + randomUUID();
  const finalText = '大流式响应本机测试完成：HTML 和 SVG 已保存，工具回传有效。';
  const files = {
    'generated/index.html': '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><title>Large SSE test</title><h1>本机大流测试</h1><img src="mark.svg" alt="test mark"></html>\n',
    'generated/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64"><rect x="8" y="8" width="80" height="48" rx="8" fill="#222"/><path d="M28 32h40" stroke="#fff" stroke-width="4"/></svg>\n',
  };
  const tools = Object.entries(files).map(([file, content], index) => ({ id: 'large-sse-write-' + index, name: 'write_file', arguments: JSON.stringify({ path: file, content }) }));
  const problems = [];
  const wireBytes = [];
  let rounds = 0;
  let installed = false;
  let configured = false;
  const write = async (response, text, round) => {
    wireBytes[round] = (wireBytes[round] || 0) + Buffer.byteLength(text);
    if (response.write(text)) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('Large SSE client disconnected before fixture completed')); };
      const failed = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Large SSE fixture backpressure timed out')); }, 10_000);
      response.once('drain', drained);
      response.once('close', closed);
      response.once('error', failed);
    });
  };
  const data = (response, value, round) => write(response, 'data: ' + JSON.stringify(value) + '\n\n', round);
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer forgedesk-large-sse-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'smoke-large-sse-model', supportsTools: true, effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] })); return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer forgedesk-large-sse-key');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(raw.length < 1_000_000, 'Unexpectedly large model request');
      }
      const body = JSON.parse(raw);
      assert.equal(body.model, 'smoke-large-sse-model');
      assert.equal(body.stream, true);
      assert.equal(body.reasoning_effort, 'high');
      assert.equal(body.thinking?.type, 'enabled');
      const round = rounds++;
      assert.ok(round < 2, 'Unexpected third model request');
      if (round === 1) {
        const native = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.length);
        assert.equal(native?.reasoning_content, nativeReasoning, 'DeepSeek native reasoning was lost');
        assert.deepEqual(native.tool_calls.map(tool => [tool.id, tool.function.name, JSON.parse(tool.function.arguments)]), tools.map(tool => [tool.id, tool.name, JSON.parse(tool.arguments)]));
        for (const tool of tools) {
          const returned = body.messages.find(message => message.role === 'tool' && message.tool_call_id === tool.id);
          assert.ok(returned, 'Missing native tool continuation: ' + tool.id);
          const result = JSON.parse(returned.content);
          assert.equal(result.path, JSON.parse(tool.arguments).path);
          assert.equal(result.bytes, Buffer.byteLength(JSON.parse(tool.arguments).content));
        }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      if (round === 0) {
        const comment = ': fixture-protocol-padding ' + 'x'.repeat(16 * 1024) + '\n\n';
        for (let index = 0; index < 576; index++) await write(response, comment, round);
        assert.ok(wireBytes[round] > 8 * 1024 * 1024, 'Fixture does not exceed the old response limit');
        await data(response, { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: nativeReasoning.slice(0, 24) } }] }, round);
        await data(response, { choices: [{ index: 0, delta: { reasoning_content: nativeReasoning.slice(24), tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments.slice(0, Math.floor(tool.arguments.length / 2)) } })) } }] }, round);
        await data(response, { choices: [{ index: 0, delta: { tool_calls: tools.map((tool, index) => ({ index, function: { arguments: tool.arguments.slice(Math.floor(tool.arguments.length / 2)) } })) }, finish_reason: 'tool_calls' }] }, round);
        await data(response, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }, round);
      } else {
        await data(response, { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'PRIVATE_LARGE_SSE_FINAL_REASONING' } }] }, round);
        await data(response, { choices: [{ index: 0, delta: { content: finalText }, finish_reason: 'stop' }] }, round);
        await data(response, { choices: [], usage: { prompt_tokens: 19, completion_tokens: 5 } }, round);
      }
      await write(response, 'data: [DONE]\n\n', round);
      response.end();
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message, code: 'large_sse_smoke_contract' } }));
      }
    }
  });
  try {
    await fs.mkdir(fixture, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    await call('chooseWorkspace');
    await call('newSession');
    await call('saveSettings', { provider: 'deepseek', model: 'smoke-large-sse-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-large-sse-key', reasoningEffort: 'high', maxSteps: 4 });
    configured = true;
    await call('listModels', { force: true });
    await call('setReasoningEffort', { reasoningEffort: 'high' });
    const before = (await call('getState')).usageStats.day;
    await js(`(()=>{
      window.__largeSSESmoke={events:[],approvals:[],errors:[]};
      const expected=${JSON.stringify(files)};
      window.__largeSSESmoke.off=window.forge.onEvent(event=>{
        window.__largeSSESmoke.events.push(event);
        if(event.type==='approval-request'){
          const allowed=event.kind==='write'&&Object.hasOwn(expected,event.path)&&event.after===expected[event.path]&&event.before===null;
          window.__largeSSESmoke.approvals.push({path:event.path,allowed});
          window.forge.respondApproval({id:event.id,approved:allowed}).catch(error=>window.__largeSSESmoke.errors.push(error.message));
        }
      });
    })()`);
    installed = true;
    const ended = await js(`(async()=>{
      const done=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{off();reject(new Error('Large SSE task timed out'));},30000);
        const off=window.forge.onEvent(event=>{if(event.type==='run-end'){clearTimeout(timer);off();resolve(event);}});
      });
      await window.forge.runTask({text:'在隔离测试项目生成 generated/index.html 和 generated/mark.svg；这只是本机大 SSE 回归，不访问外网。'});
      return await done;
    })()`);
    assert.equal(ended.status, 'completed', ended.error || 'Large SSE task did not complete');
    assert.equal(rounds, 2);
    assert.deepEqual(problems, []);
    for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(fixture, file), 'utf8'), content);
    const after = (await call('getState')).usageStats.day;
    assert.equal(after.requests - before.requests, 2);
    assert.equal(after.inputTokens - before.inputTokens, 30);
    assert.equal(after.outputTokens - before.outputTokens, 12);
    assert.equal(after.totalTokens - before.totalTokens, 42);
    assert.equal(after.unreportedRequests - before.unreportedRequests, 0);
    const observed = await js(`({events:window.__largeSSESmoke.events,approvals:window.__largeSSESmoke.approvals,errors:window.__largeSSESmoke.errors,text:document.body.innerText})`);
    assert.deepEqual(observed.errors, []);
    assert.equal(observed.approvals.length, 2);
    assert.ok(observed.approvals.every(approval => approval.allowed), 'Unexpected write approval');
    assert.equal(observed.events.filter(event => event.type === 'tool-result' && event.name === 'write_file').length, 2);
    assert.ok(observed.text.includes(finalText), 'Final response was not rendered');
    for (const privateText of [nativeReasoning, 'PRIVATE_LARGE_SSE_FINAL_REASONING']) {
      assert.ok(!JSON.stringify(observed).includes(privateText), 'Raw reasoning leaked to renderer');
      assert.ok(!JSON.stringify(await call('getCurrentSession')).includes(privateText), 'Native reasoning leaked in public session');
    }
    win.webContents.invalidate();
    await wait(120);
    await fs.writeFile(path.join(output, 'large-response.png'), (await win.webContents.capturePage()).toPNG());
    return { status: 'completed', realApi: false, modelRounds: rounds, wireBytes, firstResponseExceeds8MiB: wireBytes[0] > 8 * 1024 * 1024, smallGeneratedFiles: Object.keys(files), nativeReasoningContinuation: true, rawReasoningPrivate: true, requestsRecorded: 2, inputTokens: 30, outputTokens: 12, tokensRecorded: 42 };
  } catch (error) {
    console.error('LARGE_SSE_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, rounds, wireBytes, problems }));
    throw error;
  } finally {
    dialog.showOpenDialog = originalOpen;
    if (!win.isDestroyed()) { try { await call('stopTask'); } catch {} }
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    if (!win.isDestroyed()) {
      if (installed) await js('window.__largeSSESmoke.off(); delete window.__largeSSESmoke').catch(() => {});
      if (configured) await call('saveSettings', { provider: 'deepseek', model: '', baseUrl: 'https://api.deepseek.com', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
    }
  }
};
