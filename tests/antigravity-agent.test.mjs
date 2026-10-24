import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityAgent, killAntigravityProcessTree } from '../src/core/antigravity-agent.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const initialized = { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.3' },
  authMethods: [{ id: 'oauth-personal' }, { id: 'oauth-business' }], agentCapabilities: { loadSession: true, auth: { logout: {} }, promptCapabilities: { image: true, audio: true } } };
function cli(handler = () => false) {
  const calls = [], children = []; let sessionNumber = 0;
  const spawn = (entry, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 40000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: 0, exitCode: null, entry, args, options });
    child.send = value => { if (!child.stdout.destroyed) child.stdout.write(JSON.stringify(value) + '\n'); };
    child.reply = (rpc, result) => child.send({ jsonrpc: '2.0', id: rpc.id, result });
    child.error = (rpc, error) => child.send({ jsonrpc: '2.0', id: rpc.id, error });
    child.update = (sessionId, update) => child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    child.reverse = (id, method, params) => child.send({ jsonrpc: '2.0', id, method, params });
    child.kill = () => { child.killed++; if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }); } return true; };
    let buffer = '';
    child.stdin.on('data', bytes => {
      buffer += bytes.toString(); let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
        const rpc = JSON.parse(line); calls.push({ child, rpc });
        Promise.resolve().then(async () => {
          if (!rpc.method || await handler({ child, rpc })) return;
          if (rpc.method === 'initialize') child.reply(rpc, initialized);
          if (rpc.method === 'authenticate') child.reply(rpc, {});
          if (rpc.method === 'session/new') child.reply(rpc, { sessionId: 'official-' + ++sessionNumber,
            models: { availableModels: [{ modelId: 'gemini-fixture', name: 'Google fixture' }], currentModelId: 'gemini-fixture' },
            modes: { availableModes: [{ id: 'agent', name: 'Agent' }], currentModeId: 'agent' } });
          if (['session/set_model', 'session/set_mode', 'session/set_config_option'].includes(rpc.method)) child.reply(rpc, {});
          if (rpc.method === 'session/prompt') { child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '原生完整代理回复' } }); child.reply(rpc, { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8 } }); }
        }).catch(error => { child.testFailure = error; child.error(rpc, { code: -32603, message: 'fixture handler failure' }); });
      }
    }); children.push(child); return child;
  };
  return { spawn, calls, children };
}
async function fixture(t, options = {}) {
  const base = path.resolve('artifacts', 'test-antigravity-agent'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const fake = cli(options.handler), events = [], killed = [];
  const runtime = { init: async () => {}, publicState: async () => ({ status: 'ready', version: '1.4.3', download: null }),
    ensure: async ({ signal } = {}) => { signal?.throwIfAborted(); return { entry: path.join(dir, 'official-runtime', 'agy_acp_server.exe'), version: '1.4.3' }; } };
  const config = { dataDir: dir, runtime, spawnImpl: fake.spawn, killTreeImpl: async child => { killed.push(child.pid); child.kill(); }, onEvent: event => events.push(event), startTimeoutMs: 200, stopGraceMs: 10, ...options }; delete config.handler;
  const agent = new AntigravityAgent(config);
  t.after(async () => { await agent.dispose(); assert.equal(path.dirname(dir), base); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, fake, agent, runtime, events, killed, config };
}
const task = (f, extra = {}) => ({ localSessionId: 'local-1', cwd: f.dir, prompt: '创建测试文件并验证', ...extra });
const permission = sessionId => ({ sessionId, toolCall: { toolCallId: 'operation-1', title: '运行检查', kind: 'execute', rawInput: { command: 'test command' } }, options: [
  { optionId: 'approve-once', kind: 'allow_once', name: '允许一次' }, { optionId: 'reject-once', kind: 'reject_once', name: '拒绝' },
] });

test('initialization uses original ACP identity and a dedicated GEMINI_HOME without assuming keyring isolation', async t => {
  const f = await fixture(t); await f.agent.init(); assert.equal(f.fake.children.length, 0);
  const state = await f.agent.publicState(); assert.equal(state.session.status, 'disconnected'); assert.equal(state.storage.credentialScope, 'official-shared'); assert.equal(state.storage.identityVerified, false);
  await Promise.all([f.agent.initialize(), f.agent.initialize()]); assert.equal(f.fake.children.length, 1);
  const child = f.fake.children[0]; assert.deepEqual(child.args, []); assert.equal(child.options.shell, false); assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.env.GEMINI_HOME, path.join(f.dir, 'antigravity-agent', 'home'));
  for (const name of ['GEMINI_CLI_SURFACE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(child.options.env[name], undefined);
  const init = f.fake.calls[0].rpc; assert.equal(init.params.clientInfo.name, 'Synora code'); assert.equal(init.params.clientCapabilities.terminal, false);
  assert.equal(f.fake.calls.some(call => call.rpc.method === 'authenticate'), false);
});
test('official authenticate ACK connects without creating sessions or inference; disconnect never logs out a shared keyring', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn(); assert.equal(signed.session.status, 'connected'); assert.ok(signed.session.profileId);
  assert.deepEqual(f.fake.calls.map(call => call.rpc.method), ['initialize', 'authenticate']);
  assert.deepEqual((await f.agent.listModels()).map(model => model.id), ['gemini-fixture']);
  assert.equal(f.fake.calls.some(call => call.rpc.method === 'session/prompt'), false);
  await f.agent.disconnect(); assert.equal((await f.agent.publicState()).session.profileId, null); assert.equal(f.killed.length, 1);
  assert.equal(f.fake.calls.some(call => call.rpc.method === 'logout'), false);
  const next = await f.agent.signIn(); assert.notEqual(next.session.profileId, signed.session.profileId);
});
test('full native updates and prompts stay in the official agent, with same-profile same-workspace continuation only', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.update(rpc.params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: '读取文件', kind: 'read', status: 'in_progress', rawInput: { path: 'example.txt' } });
    child.update(rpc.params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'file text' });
    child.reply(rpc, { stopReason: 'end_turn' }); return true;
  } }); await f.agent.signIn();
  const first = await f.agent.runTask(task(f, { modelId: 'gemini-fixture', modeId: 'agent' }));
  const second = await f.agent.runTask(task(f, { prompt: '继续下一步' })); assert.equal(first.sessionId, second.sessionId); assert.equal(second.usageReported, false); assert.equal(second.usage, null);
  assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/new').length, 1);
  assert.equal(f.events[0].update.kind, 'read'); assert.equal(f.events[1].update.rawOutput, 'file text'); assert.equal(f.events[0].localSessionId, 'local-1');
  const prompts = f.fake.calls.filter(call => call.rpc.method === 'session/prompt').map(call => call.rpc.params.prompt);
  assert.deepEqual(prompts[1], [{ type: 'text', text: '继续下一步' }]); assert.ok(!JSON.stringify(prompts[1]).includes('创建测试文件'));
  const moved = await f.agent.runTask(task(f, { cwd: path.dirname(f.dir) })); assert.notEqual(moved.sessionId, first.sessionId);
  await f.agent.signIn(); const accountChanged = await f.agent.runTask(task(f)); assert.notEqual(accountChanged.sessionId, moved.sessionId);
  const restarted = new AntigravityAgent(f.config); assert.equal((await restarted.publicState()).session.status, 'disconnected'); await restarted.dispose();
});

test('authorized visible history accompanies only fresh native sessions and never aliases a fork or replays on continuation', async t => {
  const f = await fixture(t); await f.agent.signIn();
  const contextMessages = [{ role: 'user', content: '最初任务：制作蓝色页面' }, { role: 'assistant', content: '已完成页面布局。' },
    { role: 'system', content: 'PRIVATE_SYSTEM_CONTEXT' }, { role: 'tool', content: 'PRIVATE_TOOL_RESULT' }];
  const first = await f.agent.runTask(task(f, { prompt: '继续完善页面', contextMessages }));
  const prompts = () => f.fake.calls.filter(call => call.rpc.method === 'session/prompt').map(call => call.rpc.params);
  assert.match(prompts()[0].prompt[0].text, /最初任务：制作蓝色页面/u); assert.match(prompts()[0].prompt[0].text, /已完成页面布局/u);
  assert.match(prompts()[0].prompt[0].text, /继续完善页面/u); assert.doesNotMatch(prompts()[0].prompt[0].text, /PRIVATE_/u);
  const continued = await f.agent.runTask(task(f, { prompt: '继续添加按钮', contextMessages })); assert.equal(continued.sessionId, first.sessionId);
  assert.deepEqual(prompts()[1].prompt, [{ type: 'text', text: '继续添加按钮' }]);
  const forked = await f.agent.runTask(task(f, { localSessionId: 'visible-fork', prompt: '继续完善页面', contextMessages }));
  assert.notEqual(forked.sessionId, first.sessionId); assert.match(prompts()[2].prompt[0].text, /最初任务：制作蓝色页面/u);
  const moved = await f.agent.runTask(task(f, { localSessionId: 'visible-fork', cwd: path.dirname(f.dir), prompt: '继续完善页面', contextMessages }));
  assert.notEqual(moved.sessionId, forked.sessionId); assert.match(prompts()[3].prompt[0].text, /最初任务：制作蓝色页面/u);
  f.fake.children.at(-1).emit('exit', 1); await tick();
  const restarted = await f.agent.runTask(task(f, { prompt: '重连后继续', contextMessages }));
  assert.notEqual(restarted.sessionId, first.sessionId); assert.match(prompts()[4].prompt[0].text, /最初任务：制作蓝色页面/u);
  await f.agent.signIn(); await f.agent.runTask(task(f, { prompt: '新账号的新任务' }));
  assert.deepEqual(prompts()[5].prompt, [{ type: 'text', text: '新账号的新任务' }]);
});

test('adding historical reference cannot invalidate an already valid maximum-size current prompt', async t => {
  const f = await fixture(t); await f.agent.signIn(); const prompt = 'a'.repeat(4 * 1024 * 1024);
  await f.agent.runTask(task(f, { prompt, contextMessages: [{ role: 'user', content: '此前可见内容' }] }));
  assert.equal(f.fake.calls.find(call => call.rpc.method === 'session/prompt').rpc.params.prompt[0].text, prompt);
});
test('permission request IDs cannot collide with response IDs, and selection must match an offered option', async t => {
  for (const decision of ['approve-once', true, 'invented-option', null]) {
    let promptRpc, child; const asked = deferred();
    const f = await fixture(t, { onPermission: info => { assert.equal(info.localSessionId, 'local-1'); assert.equal(info.options[0].kind, 'allow_once'); return decision; },
      handler: value => { if (value.rpc.method !== 'session/prompt') return false; ({ child, rpc: promptRpc } = value); child.reverse(1, 'session/request_permission', permission(promptRpc.params.sessionId)); asked.resolve(); return true; } });
    await f.agent.signIn(); const running = f.agent.runTask(task(f)); await asked.promise;
    for (let i = 0; i < 20 && !f.fake.calls.some(call => call.rpc.id === 1 && call.rpc.result); i++) await tick();
    const answer = f.fake.calls.find(call => call.rpc.id === 1 && call.rpc.result).rpc;
    assert.deepEqual(answer.result, { outcome: decision === 'approve-once' ? { outcome: 'selected', optionId: decision } : { outcome: 'cancelled' } });
    child.reply(promptRpc, { stopReason: 'end_turn' }); await running;
  }
});
test('unadvertised filesystem and terminal reverse calls are declined without executing any client capability', async t => {
  let child, promptRpc; const entered = deferred();
  const f = await fixture(t, { handler: value => { if (value.rpc.method !== 'session/prompt') return false; ({ child, rpc: promptRpc } = value); entered.resolve(); return true; } });
  await f.agent.signIn(); const running = f.agent.runTask(task(f)); await entered.promise;
  child.reverse(2, 'fs/write_text_file', { path: 'C:\\outside.txt', content: 'do not execute' }); child.reverse(3, 'terminal/create', { command: 'do not execute' });
  for (let index = 0; index < 20 && f.fake.calls.filter(call => call.rpc.error).length < 2; index++) await tick();
  assert.deepEqual(f.fake.calls.filter(call => call.rpc.error).map(call => call.rpc.error.code), [-32601, -32601]);
  child.reply(promptRpc, { stopReason: 'end_turn' }); await running;
});
test('Stop cancels pending permissions, force-kills nonresponsive process tree and never accepts a late approval or reply', async t => {
  const entered = deferred(), decision = deferred(); let child, promptRpc;
  const f = await fixture(t, { onPermission: () => decision.promise, handler: value => {
    if (value.rpc.method !== 'session/prompt') return false; ({ child, rpc: promptRpc } = value); child.reverse(9, 'session/request_permission', permission(promptRpc.params.sessionId)); entered.resolve(); return true;
  } }); await f.agent.signIn(); const running = f.agent.runTask(task(f)), rejected = assert.rejects(running, { name: 'AbortError' }); await entered.promise;
  const start = Date.now(); await f.agent.stop(); await rejected; assert.ok(Date.now() - start < 500); assert.equal(f.killed.length, 1);
  decision.resolve('approve-once'); child.update(promptRpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late text' } }); await tick();
  assert.equal(f.events.length, 0); assert.equal(f.fake.calls.some(call => call.rpc.id === 9 && call.rpc.result?.outcome?.outcome === 'selected'), false);
  assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/cancel').length, 1);
});
test('cooperative cancellation preserves the connection while a forced restart cannot reuse an old official session', async t => {
  let hold = false, held; const entered = deferred();
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (hold && rpc.method === 'session/prompt') { held = { child, rpc }; entered.resolve(); return true; }
    if (rpc.method === 'session/cancel') { held.child.reply(held.rpc, { stopReason: 'cancelled' }); return true; }
  } }); await f.agent.signIn(); const first = await f.agent.runTask(task(f)); hold = true;
  const running = f.agent.runTask(task(f)), rejected = assert.rejects(running, { name: 'AbortError' }); await entered.promise; await f.agent.stop(); await rejected;
  assert.equal(f.killed.length, 0); hold = false; const continued = await f.agent.runTask(task(f)); assert.equal(continued.sessionId, first.sessionId);
  f.fake.children[0].emit('exit', 1); await tick(); const fresh = await f.agent.runTask(task(f)); assert.notEqual(fresh.sessionId, first.sessionId); assert.equal(f.fake.children.length, 2);
});
test('real usage stays reported and image data is explicitly passed as ACP content instead of hidden path reads', async t => {
  const f = await fixture(t); await f.agent.signIn(); const result = await f.agent.runTask(task(f, { attachments: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }] }));
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8 }); assert.equal(result.usageReported, true);
  const blocks = f.fake.calls.find(call => call.rpc.method === 'session/prompt').rpc.params.prompt; assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  const before = f.fake.calls.length; await assert.rejects(f.agent.runTask(task(f, { attachments: [{ path: 'C:\\secret.png' }] })), { code: 'AGY_IMAGES_UNSUPPORTED' }); assert.equal(f.fake.calls.length, before);
  await assert.rejects(f.agent.runTask(task(f, { prompt: '' })), { code: 'AGY_INVALID_INPUT' });
});
test('authentication errors stay classified but never expose official diagnostics or credential-bearing stderr', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'authenticate') return false; child.stderr.write('PRIVATE_TOKEN https://accounts.google.com/?code=SECRET');
    child.error(rpc, { code: -32000, message: 'This client is no longer supported for PRIVATE_TOKEN https://private.example?code=SECRET' }); return true;
  } }); await assert.rejects(f.agent.signIn(), error => error.code === 'AGY_CLIENT_UNSUPPORTED' && !/PRIVATE|SECRET|https:/u.test(error.message));
  const state = await f.agent.publicState(); assert.equal(state.session.profileId, null); assert.doesNotMatch(JSON.stringify(state), /PRIVATE|SECRET|https:/);
});
test('cancelled login cannot commit a late ACK and invalid handshake cannot authenticate', async t => {
  let held; const entered = deferred(); const f = await fixture(t, { handler: ({ child, rpc }) => { if (rpc.method !== 'authenticate') return false; held = { child, rpc }; entered.resolve(); return true; } });
  const signing = f.agent.signIn(), rejected = assert.rejects(signing, { name: 'AbortError' }); await entered.promise; await f.agent.cancelSignIn(); await rejected;
  held.child.reply(held.rpc, {}); await tick(); assert.equal((await f.agent.publicState()).session.profileId, null); assert.equal(f.killed.length, 1);
  const g = await fixture(t, { handler: ({ child, rpc }) => { if (rpc.method !== 'initialize') return false; child.reply(rpc, { ...initialized, agentInfo: { name: 'different-agent', version: '1.4.3' } }); return true; } });
  await assert.rejects(g.agent.signIn(), { code: 'AGY_PROTOCOL_ERROR' }); assert.equal(g.fake.calls.some(call => call.rpc.method === 'authenticate'), false); assert.equal(g.killed.length, 1);
});
test('failed reconnect revokes the previous unverified shared-keyring identity before another task can start', async t => {
  let rejectAuth = false;
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (!rejectAuth || rpc.method !== 'authenticate') return false;
    child.error(rpc, { code: -32000, message: 'HTTP 503' }); return true;
  } });
  const first = await f.agent.signIn(); await f.agent.runTask(task(f)); rejectAuth = true;
  await assert.rejects(f.agent.signIn(), { code: 'AGY_SERVICE_UNAVAILABLE' });
  const state = await f.agent.publicState(); assert.equal(state.session.profileId, null); assert.equal(state.session.sharing, false);
  await assert.rejects(f.agent.runTask(task(f)), { code: 'AGY_AUTH_REQUIRED' });
  await assert.rejects(f.agent.listModels(), { code: 'AGY_AUTH_REQUIRED' });
  rejectAuth = false; const next = await f.agent.signIn(); assert.notEqual(next.session.profileId, first.session.profileId);
});
test('task timeout and consumer callback failure kill the full process tree without publishing raw errors', async t => {
  const f = await fixture(t, { requestTimeoutMs: 20, handler: ({ rpc }) => rpc.method === 'session/prompt' }); await f.agent.signIn();
  await assert.rejects(f.agent.runTask(task(f)), { code: 'AGY_TIMEOUT' }); await tick(); assert.equal(f.killed.length, 1);
  const g = await fixture(t); await g.agent.signIn(); await assert.rejects(g.agent.runTask(task(g, { onUpdate: () => { throw Error('PRIVATE_CALLBACK_TOKEN'); } })), { code: 'AGY_CALLBACK_FAILED' });
  assert.doesNotMatch(JSON.stringify(await g.agent.publicState()), /PRIVATE_CALLBACK_TOKEN/); assert.equal(g.killed.length, 1);
});
test('Windows process-tree termination uses the still-live root PID with fixed taskkill arguments', async () => {
  const calls = []; let rootKilled = false;
  await killAntigravityProcessTree({ pid: 43210, kill() { rootKilled = true; } }, { platform: 'win32', spawnImpl: (entry, args, options) => {
    calls.push({ entry, args, options }); assert.equal(rootKilled, false); const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit('close', 0)); return child;
  } }); assert.equal(rootKilled, true); assert.equal(path.basename(calls[0].entry), 'taskkill.exe'); assert.deepEqual(calls[0].args, ['/PID', '43210', '/T', '/F']); assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
});
test('whole-agent task deadlines can exceed ten minutes while configuration stays bounded', async t => {
  const f = await fixture(t, { requestTimeoutMs: 86400000 }); await f.agent.signIn(); assert.equal((await f.agent.runTask(task(f))).stopReason, 'end_turn');
  assert.throws(() => new AntigravityAgent({ ...f.config, requestTimeoutMs: 86400001 }), { code: 'AGY_INVALID_INPUT' });
  assert.throws(() => new AntigravityAgent({ ...f.config, startTimeoutMs: 600001 }), { code: 'AGY_INVALID_INPUT' });
});
