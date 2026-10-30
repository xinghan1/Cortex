import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KimiAgent, kimiLoginPublicLine } from '../src/core/kimi-agent.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const initialized = { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '2.3.1' }, authMethods: [{ id: 'login', type: 'terminal', args: ['--login'] }],
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, promptCapabilities: { image: true } } };
const modelInfo = { configOptions: [{ id: 'model', category: 'model', type: 'select', options: [{ value: 'native-kimi', name: 'Official Kimi' }] }], modes: { availableModes: [{ id: 'default', name: 'Default' }] } };
function cli(handler = () => false, login = null) {
  const calls = [], children = [], authenticated = new Set(); let sessions = 0;
  const spawn = (entry, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 51000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: 0, exitCode: null, entry, args, options });
    child.send = value => { if (!child.stdout.destroyed) child.stdout.write(JSON.stringify(value) + '\n'); };
    child.reply = (rpc, result = {}) => child.send({ jsonrpc: '2.0', id: rpc.id, result }); child.error = (rpc, error) => child.send({ jsonrpc: '2.0', id: rpc.id, error });
    child.update = (sessionId, update) => child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    child.reverse = (id, method, params) => child.send({ jsonrpc: '2.0', id, method, params });
    child.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => { child.killed++; queueMicrotask(() => child.exit(0)); return true; };
    children.push(child);
    if (args.includes('--login')) { queueMicrotask(() => { if (login) return login(child, authenticated); authenticated.add(options.env.KIMI_CODE_HOME); child.stderr.write('Opening browser for Kimi device login: https://auth.kimi.com/device?user_code=ABCD-1234\nIf the browser did not open, paste the URL above and enter code: ABCD-1234\nPRIVATE_TOKEN=never-public\n'); child.exit(0); }); return child; }
    let buffer = '';
    child.stdin.on('data', bytes => {
      buffer += bytes.toString(); let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
        const rpc = JSON.parse(line); calls.push({ child, rpc });
        Promise.resolve().then(async () => {
          if (!rpc.method || await handler({ child, rpc })) return;
          if (rpc.method === 'initialize') child.reply(rpc, initialized);
          else if (rpc.method === 'authenticate') authenticated.has(options.env.KIMI_CODE_HOME) ? child.reply(rpc) : child.error(rpc, { code: -32000, message: 'auth required SECRET' });
          else if (rpc.method === 'session/new') child.reply(rpc, { sessionId: `native-${++sessions}`, ...modelInfo });
          else if (rpc.method === 'session/resume') child.reply(rpc, modelInfo);
          else if (rpc.method === 'session/prompt') { child.update(rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '原生代理回复' } }); child.reply(rpc, { stopReason: 'end_turn' }); }
          else if (rpc.method === 'logout') { authenticated.delete(options.env.KIMI_CODE_HOME); child.reply(rpc); }
          else if (rpc.id) child.reply(rpc);
        }).catch(error => { child.testFailure = error; child.error(rpc, { code: -32603, message: 'fixture failure' }); });
      }
    }); return child;
  }; return { spawn, children, calls, authenticated };
}
async function fixture(t, options = {}) {
  const base = path.resolve('artifacts', 'test-kimi-agent'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const fake = cli(options.handler, options.login), events = [], killed = [], agents = [];
  const runtime = { init: async () => {}, publicState: async () => ({ status: 'ready', version: '2.3.1' }), ensure: async ({ signal } = {}) => { signal?.throwIfAborted(); return { entry: path.join(dir, 'kimi.exe'), version: '2.3.1' }; } };
  const config = { dataDir: dir, runtime, spawnImpl: fake.spawn, killTreeImpl: async child => { if (child) { killed.push(child.pid); child.kill(); } }, onEvent: event => events.push(event), startTimeoutMs: 200, stopGraceMs: 10, ...options }; delete config.handler; delete config.login;
  const create = () => { const agent = new KimiAgent(config); agents.push(agent); return agent; }, agent = create();
  t.after(async () => { for (const item of agents) await item.dispose(); for (const child of fake.children) assert.equal(child.testFailure, undefined); assert.equal(path.dirname(dir), base); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, fake, agent, runtime, events, killed, create };
}
const task = (f, extra = {}) => ({ localSessionId: 'local-1', cwd: f.dir, prompt: '制作测试项目并验证', ...extra });
const permission = sessionId => ({ sessionId, toolCall: { toolCallId: 'operation-1', title: '运行检查', kind: 'execute' }, options: [
  { optionId: 'allow', kind: 'allow_once', name: '允许一次' }, { optionId: 'reject', kind: 'reject_once', name: '拒绝' } ] });

test('official reasoning labels and arbitrary values are scoped to the selected model and sent through ACP unchanged', async t => {
  const state = new Map(); let next = 0;
  const config = (model, effort = model === 'native-kimi' ? 'auto/8k' : 'off') => [
    { id: 'official.model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'native-kimi', name: 'Kimi' }, { value: 'other', name: 'Other' }] },
    { id: 'official.thinking-budget', category: 'thought_level', type: 'select', currentValue: effort, defaultValue: model === 'native-kimi' ? 'auto/8k' : 'off',
      options: model === 'native-kimi' ? [{ value: 'auto/8k', name: '自动 · 8K' }, { value: 'deep:32k', name: '深度 · 32K' }] : [{ value: 'off', name: '关闭' }] },
  ];
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method === 'session/new') { const id = 'reasoning-' + ++next; state.set(id, 'native-kimi'); child.reply(rpc, { sessionId: id, configOptions: config('native-kimi') }); return true; }
    if (rpc.method !== 'session/set_config_option') return false;
    const { sessionId, configId, value } = rpc.params;
    if (configId === 'official.model') { state.set(sessionId, value); child.reply(rpc, { configOptions: config(value) }); }
    else { assert.equal(configId, 'official.thinking-budget'); child.reply(rpc, { configOptions: config(state.get(sessionId), value) }); }
    return true;
  } });
  await f.agent.signIn(); const models = await f.agent.listModels();
  assert.deepEqual(models[0].reasoningOptions, [{ value: 'auto/8k', label: '自动 · 8K' }, { value: 'deep:32k', label: '深度 · 32K' }]);
  assert.equal(models[0].defaultReasoningEffort, 'auto/8k'); assert.equal(models[0].currentReasoningEffort, 'auto/8k'); assert.deepEqual(models[1].reasoningEfforts, []);
  const other = await f.agent.listModels({ modelId: 'other' }); assert.deepEqual(other.find(model => model.id === 'other').reasoningEfforts, ['off']);
  assert.equal(f.fake.calls.some(({ rpc }) => rpc.method === 'session/prompt'), false);
  const first = await f.agent.runTask(task(f, { modelId: 'native-kimi', reasoningEffort: 'deep:32k' }));
  const second = await f.agent.runTask(task(f, { modelId: 'native-kimi', reasoningEffort: 'default' })); assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(f.fake.calls.filter(({ rpc }) => rpc.params?.configId === 'official.thinking-budget').map(({ rpc }) => rpc.params.value), ['deep:32k', 'auto/8k']);
  await assert.rejects(f.agent.runTask(task(f, { modelId: 'other', reasoningEffort: 'deep:32k' })), { code: 'KIMI_REASONING_UNAVAILABLE' });
  assert.equal(f.fake.calls.filter(({ rpc }) => rpc.method === 'session/prompt').length, 2);
});

test('returning to official management without a declared default starts a fresh native session with visible context', async t => {
  let next = 0;
  const config = value => [{ ...modelInfo.configOptions[0], currentValue: 'native-kimi' }, { id: 'thinking', category: 'thought_level', type: 'select', currentValue: value,
    options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] }];
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method === 'session/new') { child.reply(rpc, { sessionId: 'managed-' + ++next, configOptions: config('off') }); return true; }
    if (rpc.method === 'session/set_config_option') { child.reply(rpc, { configOptions: config(rpc.params.value) }); return true; } return false;
  } }); await f.agent.signIn();
  const first = await f.agent.runTask(task(f, { reasoningEffort: 'on' }));
  const second = await f.agent.runTask(task(f, { reasoningEffort: 'default', contextMessages: [{ role: 'user', content: 'AUTHORIZED_VISIBLE_HISTORY' }] }));
  assert.notEqual(second.sessionId, first.sessionId);
  assert.match(f.fake.calls.filter(({ rpc }) => rpc.method === 'session/prompt').at(-1).rpc.params.prompt[0].text, /AUTHORIZED_VISIBLE_HISTORY/);
  assert.equal(f.fake.calls.filter(({ rpc }) => rpc.params?.configId === 'thinking').length, 1);
});

test('official terminal login runs in a fresh isolated profile and exposes only documented public URL and code', async t => {
  const states = []; let f; f = await fixture(t, { onChange: async () => { if (f) states.push(await f.agent.publicState()); }, getProxyEnv: () => ({ HTTPS_PROXY: 'http://127.0.0.1:9911', KIMI_CODE_OAUTH_HOST: 'https://evil.example', KIMI_API_KEY: 'PRIVATE' }) });
  assert.equal((await f.agent.publicState()).session.status, 'disconnected'); assert.equal(f.fake.children.length, 0);
  const state = await f.agent.signIn({ region: 'global' }); assert.equal(state.region, 'global'); assert.equal(state.session.status, 'connected'); assert.ok(state.session.profileId);
  assert.deepEqual(f.fake.children.map(child => child.args), [['acp'], ['acp', '--login', '--region', 'global'], ['acp']]);
  for (const child of f.fake.children) { assert.equal(child.options.env.KIMI_CODE_HOME, path.join(f.dir, 'kimi-agent', 'profiles', state.session.profileId)); assert.equal(child.options.env.KIMI_DISABLE_TELEMETRY, '1'); assert.equal(child.options.env.HTTPS_PROXY, 'http://127.0.0.1:9911'); assert.equal(child.options.shell, false); for (const key of ['KIMI_API_KEY', 'KIMI_CODE_OAUTH_HOST', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(child.options.env[key], undefined); }
  assert.equal(f.fake.calls[0].rpc.params.clientInfo.name, 'Cortex'); assert.equal(f.fake.calls[0].rpc.params.clientCapabilities.auth.terminal, true); assert.ok(states.some(value => value.attempt?.userCode === 'ABCD-1234'));
  assert.doesNotMatch(JSON.stringify(states), /PRIVATE_TOKEN|never-public/); assert.equal(f.fake.calls.some(call => call.rpc.method === 'session/prompt'), false);
  const saved = await fs.readFile(path.join(f.dir, 'kimi-agent', 'profiles.json'), 'utf8'); assert.doesNotMatch(saved, /token|ABCD|auth\.kimi/iu);
});
test('same profile and project resume the native session across restart without replaying main API history', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn();
  assert.deepEqual((await f.agent.listModels()).map(model => model.id), ['native-kimi']); assert.equal(f.fake.calls.some(call => call.rpc.method === 'session/close'), true);
  const first = await f.agent.runTask(task(f, { modelId: 'native-kimi', attachments: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }] })); assert.equal(first.usageReported, false); assert.equal(first.usage, null);
  const second = await f.agent.runTask(task(f, { prompt: '继续' })); assert.equal(second.sessionId, first.sessionId);
  await f.agent.dispose(); const restarted = f.create(); assert.equal((await restarted.publicState()).session.profileId, signed.session.profileId);
  const third = await restarted.runTask(task(f, { prompt: '重启后继续' })); assert.equal(third.sessionId, first.sessionId);
  assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/resume').length, 1);
  const prompts = f.fake.calls.filter(call => call.rpc.method === 'session/prompt').map(call => call.rpc.params);
  assert.deepEqual(prompts[2], { sessionId: first.sessionId, prompt: [{ type: 'text', text: '重启后继续' }] });
  assert.deepEqual(prompts[0].prompt[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.equal(Object.hasOwn(prompts[0], 'tools'), false); assert.equal(f.events.length, 3);
});
test('fresh native branches receive bounded visible context once, while live and restored native continuations receive only the new prompt', async t => {
  const f = await fixture(t); await f.agent.signIn(); const history = [{ role: 'user', content: 'FIRST_VISIBLE_TASK' }, { role: 'assistant', content: 'VISIBLE_PROGRESS', providerState: { private: 'NO_PRIVATE_STATE' } }];
  const first = await f.agent.runTask(task(f, { prompt: 'continue-1', contextMessages: history }));
  let prompts = f.fake.calls.filter(call => call.rpc.method === 'session/prompt'); assert.match(prompts.at(-1).rpc.params.prompt[0].text, /FIRST_VISIBLE_TASK/); assert.doesNotMatch(prompts.at(-1).rpc.params.prompt[0].text, /NO_PRIVATE_STATE/);
  await f.agent.runTask(task(f, { prompt: 'continue-2', contextMessages: [{ role: 'user', content: 'DO_NOT_REPLAY_TO_LIVE' }] }));
  prompts = f.fake.calls.filter(call => call.rpc.method === 'session/prompt'); assert.equal(prompts.at(-1).rpc.params.prompt[0].text, 'continue-2');
  await f.agent.dispose(); const restarted = f.create(); const resumed = await restarted.runTask(task(f, { prompt: 'continue-3', contextMessages: history })); assert.equal(resumed.sessionId, first.sessionId);
  prompts = f.fake.calls.filter(call => call.rpc.method === 'session/prompt'); assert.equal(prompts.at(-1).rpc.params.prompt[0].text, 'continue-3');
  const branch = await restarted.runTask(task(f, { localSessionId: 'new-local-branch', prompt: 'branch-request', contextMessages: history })); assert.notEqual(branch.sessionId, first.sessionId);
  prompts = f.fake.calls.filter(call => call.rpc.method === 'session/prompt'); assert.match(prompts.at(-1).rpc.params.prompt[0].text, /FIRST_VISIBLE_TASK/); assert.ok(prompts.at(-1).rpc.params.prompt[0].text.endsWith('branch-request'));
  await assert.rejects(restarted.runTask(task(f, { localSessionId: 'new-local-branch', cwd: path.dirname(f.dir), contextMessages: history })), { code: 'KIMI_SESSION_CHANGED' });
});
test('a confirmed missing native session starts a fresh referenced context, but auth failures cannot silently start another native conversation', async t => {
  for (const code of [-32602, -32000]) {
    const f = await fixture(t, { handler: ({ child, rpc }) => { if (rpc.method !== 'session/resume') return false; child.error(rpc, { code, message: 'native session unavailable' }); return true; } });
    const signed = await f.agent.signIn(), first = await f.agent.runTask(task(f)); await f.agent.dispose(); const restarted = f.create();
    const input = task(f, { prompt: 'continue-after-restart', contextMessages: [{ role: 'user', content: 'AUTHORIZED_SAME_ACCOUNT_TASK' }] });
    if (code === -32602) {
      const next = await restarted.runTask(input); assert.notEqual(next.sessionId, first.sessionId); assert.equal((await restarted.publicState()).session.profileId, signed.session.profileId);
      const prompt = f.fake.calls.filter(call => call.rpc.method === 'session/prompt').at(-1).rpc.params.prompt[0].text; assert.match(prompt, /AUTHORIZED_SAME_ACCOUNT_TASK/); assert.ok(prompt.endsWith(input.prompt));
    } else { await assert.rejects(restarted.runTask(input), { code: 'KIMI_AUTH_REQUIRED' }); assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/new').length, 1); }
  }
});
test('membership model directory and permissions come from native ACP and cannot select an invented approval', async t => {
  let held; const entered = deferred();
  const f = await fixture(t, { onPermission: info => { assert.equal(info.localSessionId, 'local-1'); return 'invented'; }, handler: value => { if (value.rpc.method !== 'session/prompt') return false; held = value; value.child.reverse(1, 'session/request_permission', permission(value.rpc.params.sessionId)); entered.resolve(); return true; } });
  await f.agent.signIn(); const running = f.agent.runTask(task(f)); await entered.promise;
  for (let index = 0; index < 20 && !f.fake.calls.some(call => call.rpc.result?.outcome); index++) await tick();
  assert.deepEqual(f.fake.calls.find(call => call.rpc.result?.outcome).rpc.result, { outcome: { outcome: 'cancelled' } });
  held.child.reply(held.rpc, { stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 4 } }); assert.deepEqual((await running).usage, { inputTokens: 15, outputTokens: 4 });
  await assert.rejects(f.agent.runTask(task(f, { modelId: 'not-in-account' })), { code: 'KIMI_MODEL_UNAVAILABLE' });
  await assert.rejects(f.agent.runTask(task(f, { cwd: path.dirname(f.dir) })), { code: 'KIMI_SESSION_CHANGED' });
});
test('stop cancels pending permission, kills an unresponsive tree and cannot accept late output', async t => {
  const entered = deferred(), decision = deferred(); let held;
  const f = await fixture(t, { onPermission: () => decision.promise, handler: value => { if (value.rpc.method !== 'session/prompt') return false; held = value; value.child.reverse(9, 'session/request_permission', permission(value.rpc.params.sessionId)); entered.resolve(); return true; } });
  await f.agent.signIn(); const before = f.killed.length, running = f.agent.runTask(task(f)), rejected = assert.rejects(running, { name: 'AbortError' }); await entered.promise;
  await f.agent.stop(); await rejected; assert.equal(f.killed.length, before + 1); decision.resolve('allow'); held.child.update(held.rpc.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late secret' } }); await tick();
  assert.equal(f.events.length, 0); assert.equal(f.fake.calls.some(call => call.rpc.result?.outcome?.outcome === 'selected'), false); assert.equal(f.fake.calls.some(call => call.rpc.method === 'session/cancel'), true);
});
test('cancelled official login and concurrent clicks cannot commit an old or duplicate identity', async t => {
  const entered = deferred(); let loginChild;
  const f = await fixture(t, { login: child => { loginChild = child; entered.resolve(); } });
  const signing = f.agent.signIn(), rejected = assert.rejects(signing, { name: 'AbortError' }); const duplicate = f.agent.signIn(), duplicateRejected = assert.rejects(duplicate, { name: 'AbortError' });
  await entered.promise; await f.agent.cancelSignIn(); await rejected; await duplicateRejected;
  assert.equal(f.fake.children.filter(child => child.args.includes('--login')).length, 1); loginChild.exit(0); assert.equal((await f.agent.publicState()).session.profileId, null);
  assert.equal((await fs.readdir(path.join(f.dir, 'kimi-agent'))).includes('profiles.json'), false);
  const immediate = await fixture(t); const early = immediate.agent.signIn(), earlyRejected = assert.rejects(early, { name: 'AbortError' }); await immediate.agent.cancelSignIn(); await earlyRejected; assert.equal(immediate.fake.children.length, 0);
});
test('reauthentication changes home and generation; disconnect purges only that app-owned profile and survives restart', async t => {
  const f = await fixture(t); const first = await f.agent.signIn(); await f.agent.runTask(task(f));
  const next = await f.agent.signIn({ region: 'global' }); assert.notEqual(next.session.profileId, first.session.profileId); const result = await f.agent.runTask(task(f));
  assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/prompt').at(-1).rpc.params.sessionId, result.sessionId);
  const currentHome = path.join(f.dir, 'kimi-agent', 'profiles', next.session.profileId); await fs.writeFile(path.join(currentHome, 'native-private-fixture'), 'opaque credential owned by CLI');
  await f.agent.disconnect(); assert.equal((await f.agent.publicState()).session.status, 'disconnected'); await assert.rejects(fs.stat(currentHome), { code: 'ENOENT' });
  assert.equal(f.fake.calls.some(call => call.rpc.method === 'logout'), true); assert.equal((await f.create().publicState()).session.profileId, null);
});
test('cancelled account replacement retains the previous persisted generation and native conversation', async t => {
  let count = 0; const entered = deferred();
  const f = await fixture(t, { login: (child, authenticated) => { if (++count > 1) { entered.resolve(); return; } authenticated.add(child.options.env.KIMI_CODE_HOME); child.exit(0); } });
  const signed = await f.agent.signIn(); const first = await f.agent.runTask(task(f)); const pending = f.agent.signIn({ region: 'global' }), rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; await f.agent.cancelSignIn(); await rejected;
  const state = await f.agent.publicState(); assert.equal(state.session.profileId, signed.session.profileId); assert.equal(state.region, 'mainland-cn');
  assert.equal((await f.agent.runTask(task(f, { prompt: '继续原会话' }))).sessionId, first.sessionId);
  assert.equal((await f.create().publicState()).session.profileId, signed.session.profileId);
});
test('cancellation during profile rename rolls the persisted pointer back before reporting a cancelled login', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn(), entered = deferred(), release = deferred(), originalRename = fs.rename;
  const filename = path.join(f.dir, 'kimi-agent', 'profiles.json'); let hold = true;
  fs.rename = async (from, to) => { if (to === filename && hold) { hold = false; entered.resolve(); await release.promise; } return originalRename(from, to); };
  try {
    const pending = f.agent.signIn({ region: 'global' }), rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise;
    const cancelling = f.agent.cancelSignIn(); release.resolve(); await rejected; await cancelling;
    assert.equal((await f.agent.publicState()).session.profileId, signed.session.profileId); assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).profileId, signed.session.profileId);
    assert.equal((await f.create().publicState()).session.profileId, signed.session.profileId);
  } finally { release.resolve(); fs.rename = originalRename; }
});
test('a replaced private profile ancestor cannot make disconnect recursively delete another directory', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn(), profiles = path.join(f.dir, 'kimi-agent', 'profiles'), backup = path.join(f.dir, 'saved-profiles'), outside = path.join(f.dir, 'unrelated');
  await fs.rename(profiles, backup); await fs.mkdir(path.join(outside, signed.session.profileId), { recursive: true }); const sentinel = path.join(outside, signed.session.profileId, 'keep'); await fs.writeFile(sentinel, 'keep');
  try { await fs.symlink(outside, profiles, 'junction'); }
  catch (error) { await fs.rename(backup, profiles); if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('filesystem denied junction creation'); return; } throw error; }
  try { await assert.rejects(f.agent.disconnect(), { code: 'KIMI_STORAGE_ERROR' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep'); }
  finally { await fs.unlink(profiles); await fs.rename(backup, profiles); }
});
test('corrupt local profile records fail visibly and can be explicitly reset without reading native credentials', async t => {
  const f = await fixture(t); await f.agent.init(); const filename = path.join(f.dir, 'kimi-agent', 'profiles.json'); await fs.writeFile(filename, '{broken');
  const restored = f.create(); assert.equal((await restored.publicState()).storageRecovery, true); await assert.rejects(restored.signIn(), { code: 'KIMI_STORAGE_UNREADABLE' }); assert.equal(f.fake.children.length, 0);
  assert.equal((await restored.retryLocalRead()).storageRecovery, true); await restored.disconnect(); assert.equal((await restored.publicState()).storageRecovery, false); await restored.signIn(); assert.equal((await restored.publicState()).session.status, 'connected');
});
test('auth and protocol failures never expose arbitrary official stderr, RPC messages or credential values', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => { if (rpc.method !== 'authenticate') return false; child.stderr.write('PRIVATE_TOKEN https://evil.example/?access_token=SECRET'); child.error(rpc, { code: -32000, message: 'PRIVATE_TOKEN SECRET' }); return true; } });
  await assert.rejects(f.agent.signIn(), error => error.code === 'KIMI_AUTH_REQUIRED' && !/PRIVATE|SECRET|https:/u.test(error.message));
  assert.doesNotMatch(JSON.stringify(await f.agent.publicState()), /PRIVATE|SECRET|evil/);
  const bad = await fixture(t, { handler: ({ child, rpc }) => { if (rpc.method !== 'initialize') return false; child.reply(rpc, { ...initialized, agentInfo: { name: 'impostor', version: '2.3.1' } }); return true; } });
  await assert.rejects(bad.agent.signIn(), { code: 'KIMI_PROTOCOL_ERROR' }); assert.equal(bad.fake.children.some(child => child.args.includes('--login')), false);
  for (const line of ['PRIVATE_TOKEN=abc', 'Opening browser for Kimi device login: https://evil.example/device', 'Opening browser for Kimi device login: https://auth.kimi.com/device?access_token=SECRET', 'If the browser did not open, paste the URL above and enter code: <script>']) assert.equal(kimiLoginPublicLine(line), null);
});
test('the confirmed official subscription denial preserves the logged-in profile instead of asking for reauthentication', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.error(rpc, { code: -32000, message: 'Authentication required: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://example.invalid/?secret=PRIVATE_TOKEN', data: null }); return true;
  } });
  const signed = await f.agent.signIn(); await f.agent.listModels();
  await assert.rejects(f.agent.runTask(task(f)), error => error.code === 'KIMI_SUBSCRIPTION_REQUIRED'
    && error.message === '[KIMI_SUBSCRIPTION_REQUIRED] 账号已登录，但当前订阅没有 Kimi Code 访问权限，请在官方账号中确认 Coding 套餐。');
  const state = await f.agent.publicState(); assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true); assert.equal(state.session.profileId, signed.session.profileId);
  assert.equal(state.error.code, 'KIMI_SUBSCRIPTION_REQUIRED'); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_TOKEN|example\.invalid|secret=/);
  const saved = JSON.parse(await fs.readFile(path.join(f.dir, 'kimi-agent', 'profiles.json'), 'utf8')); assert.equal(saved.profileId, signed.session.profileId);
  assert.equal((await fs.stat(path.join(f.dir, 'kimi-agent', 'profiles', signed.session.profileId))).isDirectory(), true); assert.equal(f.fake.calls.some(call => call.rpc.method === 'logout'), false);
  await f.agent.dispose(); assert.equal((await f.create().publicState()).session.profileId, signed.session.profileId);
});
test('other auth-required messages retain the official protocol behavior instead of guessing a subscription issue', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => { if (rpc.method !== 'session/prompt') return false; child.error(rpc, { code: -32000, message: 'Authentication required: token expired; subscription status unavailable' }); return true; } });
  const signed = await f.agent.signIn(); await assert.rejects(f.agent.runTask(task(f)), { code: 'KIMI_AUTH_REQUIRED' }); const state = await f.agent.publicState();
  assert.equal(state.session.status, 'reauth_required'); assert.equal(state.session.sharing, false); assert.equal(state.session.profileId, signed.session.profileId);
});
test('full-agent task timeout permits one hour by default and 24 hours explicitly while initialization stays bounded', async t => {
  const f = await fixture(t, { requestTimeoutMs: 86400000 }); await f.agent.signIn(); await f.agent.runTask(task(f));
  assert.throws(() => new KimiAgent({ dataDir: f.dir, runtime: f.runtime, requestTimeoutMs: 86400001 }), { code: 'KIMI_INVALID_INPUT' });
});
