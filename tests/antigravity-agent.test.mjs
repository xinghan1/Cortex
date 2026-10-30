import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityAgent, killAntigravityProcessTree } from '../src/core/antigravity-agent.mjs';
import { runExternalAgentTurn } from '../src/core/external-agent-turn.mjs';
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

const modelOptions = ids => [{ id: 'model', name: 'Model', type: 'select', currentValue: ids[0],
  options: [{ group: 'official', name: 'Official', options: ids.map(value => ({ value, name: value })) }] }];

test('ACP reasoning uses official option ids, values and labels and discards stale model capabilities', async t => {
  let next = 0;
  const config = (model, value = 'budget/8192') => [{ ...modelOptions(['first', 'second'])[0], currentValue: model },
    ...(model === 'first' ? [{ id: 'agy.native-budget', category: 'thought_level', type: 'select', currentValue: value,
      options: [{ group: 'native', name: 'Official', options: [{ value: 'budget/8192', name: 'Balanced · 8K' }, { value: 'budget/65536', name: 'Deep · 64K' }] }] }] : [])];
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method === 'session/new') { child.reply(rpc, { sessionId: 'reasoning-' + ++next, configOptions: config('first') }); return true; }
    if (rpc.method !== 'session/set_config_option') return false;
    if (rpc.params.configId === 'model') {
      child.update('foreign-session', { sessionUpdate: 'config_option_update', configOptions: config('first') });
      child.update(rpc.params.sessionId, { sessionUpdate: 'config_option_update', configOptions: config(rpc.params.value) }); child.reply(rpc, {});
    } else { assert.equal(rpc.params.configId, 'agy.native-budget'); child.reply(rpc, { configOptions: config('first', rpc.params.value) }); }
    return true;
  } }); await f.agent.signIn();
  const models = await f.agent.listModels(); assert.deepEqual(models[0].reasoningOptions, [{ value: 'budget/8192', label: 'Balanced · 8K' }, { value: 'budget/65536', label: 'Deep · 64K' }]);
  assert.deepEqual(models[1].reasoningEfforts, []); assert.equal(models[0].defaultReasoningEffort, undefined);
  const selected = await f.agent.listModels({ modelId: 'second' }); assert.ok(selected.every(model => !model.reasoningEfforts.length));
  assert.equal(f.fake.calls.some(({ rpc }) => rpc.method === 'session/prompt'), false);
  const first = await f.agent.runTask(task(f, { modelId: 'first', reasoningEffort: 'budget/65536' }));
  const managed = await f.agent.runTask(task(f, { modelId: 'first', reasoningEffort: 'default', contextMessages: [{ role: 'user', content: 'VISIBLE_CONTEXT' }] }));
  assert.notEqual(managed.sessionId, first.sessionId);
  assert.match(f.fake.calls.filter(({ rpc }) => rpc.method === 'session/prompt').at(-1).rpc.params.prompt[0].text, /VISIBLE_CONTEXT/);
  await assert.rejects(f.agent.runTask(task(f, { modelId: 'second', reasoningEffort: 'budget/65536' })), { code: 'AGY_REASONING_UNAVAILABLE' });
  assert.equal(f.fake.calls.filter(({ rpc }) => rpc.method === 'session/prompt').length, 2);
});

test('a model change without fresh configuration cannot reuse the previous model reasoning menu', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/new') return false;
    child.reply(rpc, { sessionId: 'legacy-reasoning', configOptions: [...modelOptions(['first', 'second']), { id: 'budget', category: 'thought_level', type: 'select', currentValue: 'huge', options: [{ value: 'huge', name: 'Huge' }] }] }); return true;
  } }); await f.agent.signIn();
  await assert.rejects(f.agent.runTask(task(f, { modelId: 'second', reasoningEffort: 'huge' })), { code: 'AGY_REASONING_UNAVAILABLE' });
  assert.equal(f.fake.calls.some(({ rpc }) => rpc.method === 'session/prompt'), false);
});

test('a current-turn plain Google region denial cannot finish as a completed task and does not revoke login', async t => {
  let denied = true;
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    for (const value of denied ? ['  User location is not ', 'supported for the API use.', '\n'] : ['正常完成。'])
      child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
    child.reply(rpc, { stopReason: 'end_turn' }); return true;
  } });
  await f.agent.signIn(); const profile = (await f.agent.publicState()).session.profileId;
  const events = [], usage = [], session = { id: 'local-1', messages: [{ role: 'user', content: '介绍你能做什么' }] };
  await assert.rejects(runExternalAgentTurn({ agent: f.agent, session, cwd: f.dir, prompt: '介绍你能做什么', runId: 'denied-run',
    emit: value => events.push(value), onPermission: async () => null, onUsage: async value => usage.push(value) }), { code: 'AGY_REGION_UNAVAILABLE' });
  assert.equal(usage[0].status, 'failed'); assert.equal(usage[0].reported, false);
  assert.equal(session.messages.at(-1).localOnly, true);
  const state = await f.agent.publicState();
  assert.equal(state.error.code, 'AGY_REGION_UNAVAILABLE'); assert.equal(state.error.phase, 'task');
  assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true); assert.equal(state.session.profileId, profile);
  assert.equal(f.fake.calls.filter(({ rpc }) => rpc.method === 'authenticate').length, 1);
  denied = false;
  assert.equal((await f.agent.runTask(task(f))).stopReason, 'end_turn');
  assert.equal((await f.agent.publicState()).error, null);
  assert.equal(f.fake.calls.filter(({ rpc }) => rpc.method === 'session/new').length, 1);
});

test('quoting, explaining or explicitly echoing a region error stays ordinary assistant content', async t => {
  const phrase = 'User location is not supported for the API use.';
  for (const [prompt, content] of [
    ['说明错误', `“${phrase}” 是服务端的地区限制提示。`],
    ['展示日志', `\`\`\`text\n${phrase}\n\`\`\``],
    ['介绍你的工作', `我可以修改和验证项目。\n${phrase}`],
    ['解释原因', `Google 报错：${phrase}`],
    [`请原样复述：${phrase}`, phrase],
    ['较长的说明', '正常内容'.repeat(200) + phrase],
  ]) {
    const f = await fixture(t, { handler: ({ child, rpc }) => {
      if (rpc.method !== 'session/prompt') return false;
      child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content } });
      child.reply(rpc, { stopReason: 'end_turn' }); return true;
    } });
    await f.agent.signIn(); assert.equal((await f.agent.runTask(task(f, { prompt }))).stopReason, 'end_turn');
    assert.equal((await f.agent.publicState()).error, null);
  }
});

test('a text-form region denial retains only the native numeric usage actually reported for that failed turn', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'User location is not supported for the API use.' } });
    child.reply(rpc, { stopReason: 'end_turn', usage: { inputTokens: 14, outputTokens: 3, secret: 'PRIVATE_REPORT_FIELD' } }); return true;
  } });
  await f.agent.signIn(); await assert.rejects(f.agent.runTask(task(f)), error => {
    assert.equal(error.code, 'AGY_REGION_UNAVAILABLE'); assert.equal(error.usageReported, true);
    assert.deepEqual(error.usage, { inputTokens: 14, outputTokens: 3 }); assert.doesNotMatch(JSON.stringify(error), /PRIVATE_REPORT_FIELD/); return true;
  });
});

test('mentioning an earlier region failure while asking for a fix cannot turn another denial into success', async t => {
  const phrase = 'User location is not supported for the API use.';
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: phrase } });
    child.reply(rpc, { stopReason: 'end_turn' }); return true;
  } });
  await f.agent.signIn();
  await assert.rejects(f.agent.runTask(task(f, { prompt: `报错：${phrase}，请修复并继续执行任务。` })), { code: 'AGY_REGION_UNAVAILABLE' });
  assert.equal((await f.agent.publicState()).session.status, 'connected');
});

test('historical and foreign-session region text never reclassifies a successful current reply', async t => {
  const phrase = 'User location is not supported for the API use.';
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.update('other-native-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: phrase } });
    child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '当前任务正常完成。' } });
    child.reply(rpc, { stopReason: 'end_turn' }); return true;
  } });
  await f.agent.signIn();
  assert.equal((await f.agent.runTask(task(f, { contextMessages: [{ role: 'assistant', content: phrase }] }))).stopReason, 'end_turn');
  assert.equal((await f.agent.publicState()).error, null);
});

test('an explicit native RPC region error uses the same fixed classification without losing the account', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.error(rpc, { code: -32603, message: 'User location is not supported for the API use.', data: { private: 'DO_NOT_PUBLISH' } }); return true;
  } });
  await f.agent.signIn(); await assert.rejects(f.agent.runTask(task(f)), { code: 'AGY_REGION_UNAVAILABLE' });
  const state = await f.agent.publicState(); assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true);
  assert.doesNotMatch(JSON.stringify(state), /DO_NOT_PUBLISH/);
});
test('ACP model config without optional category overrides an empty or stale legacy model list', async t => {
  for (const legacy of [[], [{ modelId: 'stale-model', name: 'Stale' }]]) {
    const f = await fixture(t, { handler: ({ child, rpc }) => {
      if (rpc.method !== 'session/new') return false;
      child.reply(rpc, { sessionId: 'config-native', models: { availableModels: legacy }, configOptions: modelOptions(['native-a', 'native-b']) }); return true;
    } });
    await f.agent.signIn(); assert.deepEqual((await f.agent.listModels()).map(row => row.id), ['native-a', 'native-b']);
    await f.agent.runTask(task(f, { modelId: 'native-b' }));
    const selection = f.fake.calls.find(({ rpc }) => rpc.method === 'session/set_config_option').rpc;
    assert.equal(selection.params.configId, 'model'); assert.equal(selection.params.value, 'native-b');
    assert.equal(f.fake.calls.some(({ rpc }) => rpc.method === 'session/set_model'), false);
  }
});
test('native config notifications arriving before session/new reply are bound to the returned session only', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/new') return false;
    child.update('other-native-session', { sessionUpdate: 'config_option_update', configOptions: modelOptions(['other-account-model']) });
    child.update('discovery-native', { sessionUpdate: 'config_option_update', configOptions: modelOptions(['advertised-model']) });
    child.reply(rpc, { sessionId: 'discovery-native', models: { availableModels: [] } }); return true;
  } });
  await f.agent.signIn(); assert.deepEqual((await f.agent.listModels()).map(row => row.id), ['advertised-model']);
  assert.equal(JSON.stringify(await f.agent.publicState()).includes('other-account-model'), false);
});
test('late config_option_update completes discovery without starting inference', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/new') return false;
    child.reply(rpc, { sessionId: 'late-native', models: { availableModels: [] } });
    setTimeout(() => child.update('late-native', { sessionUpdate: 'config_option_update', configOptions: modelOptions(['late-model']) }), 5); return true;
  } });
  await f.agent.signIn(); assert.deepEqual((await f.agent.listModels()).map(row => row.id), ['late-model']);
  assert.equal(f.fake.calls.some(({ rpc }) => rpc.method === 'session/prompt'), false);
});
test('truly empty official directories keep login connected and report an actionable agent error', async t => {
  const f = await fixture(t, { startTimeoutMs: 25, handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/new') return false;
    child.reply(rpc, { sessionId: 'empty-native', models: { availableModels: [] }, configOptions: [] }); return true;
  } });
  await f.agent.signIn(); const profile = (await f.agent.publicState()).session.profileId;
  await assert.rejects(f.agent.listModels(), { code: 'AGY_CATALOG_EMPTY' });
  const state = await f.agent.publicState(); assert.equal(state.session.status, 'connected'); assert.equal(state.session.profileId, profile);
  assert.deepEqual(state.models, []);
});
test('stopping directory discovery cancels the wait and ignores subsequent stale updates', async t => {
  const controller = new AbortController(); let native;
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/new') return false;
    native = child; child.reply(rpc, { sessionId: 'cancel-native', models: { availableModels: [] } }); setImmediate(() => controller.abort()); return true;
  } });
  await f.agent.signIn(); await assert.rejects(f.agent.listModels({ signal: controller.signal }), { name: 'AbortError' });
  native.update('cancel-native', { sessionUpdate: 'config_option_update', configOptions: modelOptions(['stale-after-cancel']) }); await tick();
  assert.deepEqual((await f.agent.publicState()).models, []);
});

test('initialization uses original ACP identity and a dedicated GEMINI_HOME without assuming keyring isolation', async t => {
  const f = await fixture(t); await f.agent.init(); assert.equal(f.fake.children.length, 0);
  const state = await f.agent.publicState(); assert.equal(state.session.status, 'disconnected'); assert.equal(state.storage.credentialScope, 'official-shared'); assert.equal(state.storage.identityVerified, false);
  await Promise.all([f.agent.initialize(), f.agent.initialize()]); assert.equal(f.fake.children.length, 1);
  const child = f.fake.children[0]; assert.deepEqual(child.args, []); assert.equal(child.options.shell, false); assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.env.GEMINI_HOME, path.join(f.dir, 'antigravity-agent', 'home'));
  for (const name of ['GEMINI_CLI_SURFACE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(child.options.env[name], undefined);
  const init = f.fake.calls[0].rpc; assert.equal(init.params.clientInfo.name, 'Cortex'); assert.equal(init.params.clientCapabilities.terminal, false);
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
