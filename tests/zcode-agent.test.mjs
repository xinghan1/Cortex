import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ZCodeAgent } from '../src/core/zcode-agent.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function officialFake(handler = () => false) {
  const children = [], calls = [], sessions = new Map(); let next = 0;
  const launch = (entry, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 50000 + children.length, entry, args, options, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kills: 0 });
    child.send = value => { if (!child.stdout.destroyed) child.stdout.write(JSON.stringify(value) + '\n'); };
    child.reply = (rpc, result) => child.send({ id: rpc.id, result });
    child.event = (sessionId, type, payload, turnId = 'turn-' + sessionId) => {
      const state = sessions.get(sessionId); state.seq++;
      child.send({ method: 'session/event', params: { sessionId, type, payload, turnId, seq: state.seq, eventId: 'event-' + state.seq, timestamp: Date.now() } });
    };
    child.kill = () => { child.kills++; if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }); } return true; };
    child.finishLogin = (region = args.at(-2), user = 'fixture-user', providerId = region) => { child.stdout.write(JSON.stringify({ status: 'ready', provider: region, user: { user_id: user, email: 'PRIVATE_EMAIL' }, model: providerId + '/glm-fixture', credentialsPath: 'PRIVATE_PATH' }, null, 2)); child.kill(); };
    let buffer = '';
    child.stdin.on('data', bytes => {
      buffer += bytes.toString(); let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
        const rpc = JSON.parse(line); calls.push({ child, rpc });
        Promise.resolve().then(async () => {
          assert.equal(Object.hasOwn(rpc, 'jsonrpc'), false, 'official strict protocol must never receive ACP jsonrpc property');
          if (!rpc.method || await handler({ child, rpc })) return;
          if (rpc.method === 'runtime/capabilities') child.reply(rpc, { independentPlanState: true, historyFirst: true });
          if (rpc.method === 'session/create') {
            const sessionId = 'native-' + ++next; sessions.set(sessionId, { seq: 0 });
            child.reply(rpc, { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId, mode: rpc.params.mode, workspace: rpc.params.workspace }, settings: { model: { available: [
              { ref: { providerId: 'bigmodel', modelId: 'glm-fixture' }, label: 'GLM fixture', properties: { inputFormat: ['text'], outputFormat: ['text'] } },
              { ref: { providerId: 'zai', modelId: 'glm-fixture' }, label: 'GLM international', properties: { inputFormat: ['text'], outputFormat: ['text'] } },
              { ref: { providerId: 'unrelated', modelId: 'other' }, label: 'Do not route account here', properties: {} },
            ] } } });
          }
          if (rpc.method === 'session/subscribe') child.reply(rpc, { sessionId: rpc.params.sessionId, eventSeq: sessions.get(rpc.params.sessionId).seq, events: [] });
          if (rpc.method === 'session/setMode') child.reply(rpc, {});
          if (rpc.method === 'session/send') {
            child.reply(rpc, { accepted: true, sessionId: rpc.params.sessionId, stateRevision: 1 });
            child.event(rpc.params.sessionId, 'turn.started', { inputId: rpc.params.inputId, input: rpc.params.content, turnNumber: 1 });
            child.event(rpc.params.sessionId, 'part.delta', { messageId: 'message-1', partId: 'part-1', field: 'text', delta: '完成' });
            child.event(rpc.params.sessionId, 'turn.completed', { inputId: rpc.params.inputId, resultType: 'success', response: '完成', usage: { inputTokens: 13, outputTokens: 7 } });
          }
          if (rpc.method === 'session/stop') child.reply(rpc, {});
        }).catch(error => { child.testError = error; child.send({ id: rpc.id, error: { code: -32603, message: 'fixture failure' } }); });
      }
    }); children.push(child);
    if (args.includes('login')) Promise.resolve().then(async () => { if (!await handler({ child, login: true })) child.finishLogin(args[args.indexOf('login') + 1]); }).catch(error => { child.testError = error; child.kill(); });
    return child;
  };
  return { launch, children, calls, sessions };
}
async function fixture(t, options = {}) {
  const parent = path.resolve('artifacts', 'test-zcode-agent'); await fs.mkdir(parent, { recursive: true }); const dir = await fs.mkdtemp(path.join(parent, 'case-'));
  const fake = officialFake(options.handler), events = [], kills = [];
  const runtime = { init: async () => {}, publicState: async () => ({ status: 'ready', version: '0.17.0' }), ensure: async () => ({ entry: path.join(dir, 'zcode.exe'), args: [], version: '0.17.0' }) };
  const config = { dataDir: dir, runtime, spawnImpl: fake.launch, killTreeImpl: async child => { kills.push(child.pid); child.kill(); }, onEvent: event => events.push(event), startTimeoutMs: 200, stopGraceMs: 10, ...options }; delete config.handler;
  const agent = new ZCodeAgent(config);
  t.after(async () => { await agent.dispose(); assert.equal(path.dirname(dir), parent); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, fake, agent, events, kills, config };
}
const task = (f, extra = {}) => ({ localSessionId: 'local-1', cwd: f.dir, prompt: '完成用户任务', ...extra });
function startAndHold(child, rpc) {
  child.reply(rpc, { accepted: true, sessionId: rpc.params.sessionId, stateRevision: 1 });
  child.event(rpc.params.sessionId, 'turn.started', { inputId: rpc.params.inputId, input: rpc.params.content, turnNumber: 1 });
}
test('official login is its own process with isolated documented data root and no credential file reads', async t => {
  const f = await fixture(t); await f.agent.init(); assert.equal(f.fake.children.length, 0);
  const state = await f.agent.signIn({ region: 'bigmodel' }); assert.equal(state.session.status, 'connected'); assert.equal(state.region, 'bigmodel');
  const login = f.fake.children[0]; assert.deepEqual(login.args, ['login', 'bigmodel', '--json']); assert.equal(login.options.shell, false); assert.equal(login.options.windowsHide, true);
  assert.equal(login.options.env.ZCODE_DATA_BASE_DIR, login.options.env.HOME); assert.equal(login.options.env.USERPROFILE, login.options.env.HOME);
  assert.equal(login.options.env.ZCODE_RUNTIME_ENV, 'production'); assert.equal(await fs.readFile(path.join(login.options.cwd, '.env'), 'utf8'), '');
  assert.equal(login.options.env.GEMINI_API_KEY, undefined); assert.equal(login.options.env.ZCODE_CREDENTIAL_SECRET, undefined);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_EMAIL|PRIVATE_PATH|fixture-user/);
  const own = JSON.parse(await fs.readFile(path.join(f.dir, 'zcode-agent', 'connection.json'), 'utf8')); assert.deepEqual(Object.keys(own), ['version', 'profileId', 'region', 'providerId']);
});
test('catalog comes from strict original app-server snapshot and is restricted to the selected account family', async t => {
  const f = await fixture(t); await f.agent.signIn(); const models = await f.agent.listModels(); assert.deepEqual(models.map(row => row.id), ['bigmodel/glm-fixture']);
  const app = f.fake.children.find(child => child.args.includes('app-server')); assert.deepEqual(app.args, ['app-server']);
  assert.deepEqual(f.fake.calls.map(call => call.rpc.method), ['runtime/capabilities', 'session/create', 'session/subscribe']);
  assert.equal(f.fake.calls[1].rpc.params.mode, 'guarded'); assert.equal(f.fake.calls.some(call => call.rpc.method === 'session/send'), false);
  await f.agent.signIn({ region: 'zai' }); assert.deepEqual((await f.agent.listModels()).map(row => row.id), ['zai/glm-fixture']);
});
test('send acknowledgement is not task completion and native events translate into ACP display updates', async t => {
  const submitted = deferred(); let held;
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc?.method !== 'session/send') return false; held = { child, rpc }; startAndHold(child, rpc);
    child.event(rpc.params.sessionId, 'tool.updated', { kind: 'scheduled', toolCallId: 'tool-1', toolName: 'ReadFile', input: { path: 'example.txt' } });
    child.event(rpc.params.sessionId, 'tool.updated', { kind: 'result', toolCallId: 'tool-1', result: { content: 'tool result', success: true } }); submitted.resolve(); return true;
  } }); await f.agent.signIn(); const running = f.agent.runTask(task(f)); await submitted.promise;
  assert.equal(await Promise.race([running.then(() => 'ended'), new Promise(resolve => setTimeout(() => resolve('pending'), 15))]), 'pending');
  assert.equal(f.events[0].update.sessionUpdate, 'tool_call'); assert.equal(f.events[0].update.kind, 'read'); assert.equal(f.events[1].update.status, 'completed');
  held.child.event(held.rpc.params.sessionId, 'part.delta', { messageId: 'm', partId: 'p', field: 'reasoning', delta: '考虑一下' });
  held.child.event(held.rpc.params.sessionId, 'part.delta', { messageId: 'm', partId: 'p2', field: 'text', delta: '已' });
  held.child.event(held.rpc.params.sessionId, 'turn.completed', { inputId: held.rpc.params.inputId, response: '已完成', resultType: 'success', usage: { inputTokens: 2, outputTokens: 3 } });
  const result = await running; assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 }); assert.equal(result.usageReported, true);
  assert.deepEqual(f.events.filter(event => event.update.sessionUpdate === 'agent_message_chunk').map(event => event.update.content.text), ['已', '完成']);
});
test('continuation binds official session to local session, account profile and workspace without replaying Synora history', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn(); const first = await f.agent.runTask(task(f, { modelId: 'bigmodel/glm-fixture' }));
  const second = await f.agent.runTask(task(f, { prompt: '下一步' })); assert.equal(first.sessionId, second.sessionId);
  const send = f.fake.calls.filter(call => call.rpc.method === 'session/send'); assert.equal(send[1].rpc.params.content, '下一步'); assert.deepEqual(send[0].rpc.params.modelSelection, { providerId: 'bigmodel', modelId: 'glm-fixture' });
  const moved = await f.agent.runTask(task(f, { cwd: path.dirname(f.dir) })); assert.notEqual(moved.sessionId, first.sessionId);
  await f.agent.signIn({ region: 'zai' }); assert.notEqual((await f.agent.publicState()).session.profileId, signed.session.profileId);
  const changed = await f.agent.runTask(task(f)); assert.notEqual(changed.sessionId, moved.sessionId);
  const restored = new ZCodeAgent(f.config); assert.equal((await restored.publicState()).session.status, 'connected'); const fresh = await restored.runTask(task(f)); assert.notEqual(fresh.sessionId, changed.sessionId); await restored.dispose();
});

test('authorized visible history seeds only a fresh official session, while local forks and restarted processes keep distinct native bindings', async t => {
  const f = await fixture(t); await f.agent.signIn();
  const contextMessages = [{ role: 'user', content: '最初任务：制作蓝色页面' }, { role: 'assistant', content: '已完成页面布局。' },
    { role: 'system', content: 'PRIVATE_SYSTEM_CONTEXT' }, { role: 'tool', content: 'PRIVATE_TOOL_RESULT' }];
  const sent = () => f.fake.calls.filter(call => call.rpc.method === 'session/send').map(call => call.rpc.params);
  const first = await f.agent.runTask(task(f, { prompt: '继续完善页面', contextMessages }));
  assert.match(sent()[0].content, /最初任务：制作蓝色页面/u); assert.match(sent()[0].content, /已完成页面布局/u);
  assert.match(sent()[0].content, /继续完善页面/u); assert.doesNotMatch(sent()[0].content, /PRIVATE_/u);
  const continued = await f.agent.runTask(task(f, { prompt: '继续添加按钮', contextMessages }));
  assert.equal(continued.sessionId, first.sessionId); assert.equal(sent()[1].content, '继续添加按钮');
  const forked = await f.agent.runTask(task(f, { localSessionId: 'visible-fork', prompt: '继续完善页面', contextMessages }));
  assert.notEqual(forked.sessionId, first.sessionId); assert.match(sent()[2].content, /最初任务：制作蓝色页面/u);
  const moved = await f.agent.runTask(task(f, { localSessionId: 'visible-fork', cwd: path.dirname(f.dir), prompt: '继续完善页面', contextMessages }));
  assert.notEqual(moved.sessionId, forked.sessionId); assert.match(sent()[3].content, /最初任务：制作蓝色页面/u);
  f.fake.children.at(-1).emit('exit', 1); await tick();
  const restarted = await f.agent.runTask(task(f, { prompt: '重连后继续', contextMessages }));
  assert.notEqual(restarted.sessionId, first.sessionId); assert.match(sent()[4].content, /最初任务：制作蓝色页面/u);
  await f.agent.signIn({ region: 'zai' }); await f.agent.runTask(task(f, { prompt: '新账号的新任务' }));
  assert.equal(sent()[5].content, '新账号的新任务');
});

test('a maximum-size current prompt is preserved without overflowing the reference prefix budget', async t => {
  const f = await fixture(t); await f.agent.signIn(); const prompt = 'a'.repeat(4 * 1024 * 1024);
  await f.agent.runTask(task(f, { prompt, contextMessages: [{ role: 'user', content: '此前可见内容' }] }));
  assert.equal(f.fake.calls.find(call => call.rpc.method === 'session/send').rpc.params.content, prompt);
});
test('permission approval returns only a matching official response and never defaults to yolo or invented decisions', async t => {
  for (const decision of ['allow_once', true, 'invented']) {
    const entered = deferred(); let held;
    const f = await fixture(t, { onPermission: request => { assert.equal(request.options[0].kind, 'allow_once'); return decision; }, handler: ({ child, rpc }) => {
      if (rpc?.method !== 'session/send') return false; held = { child, rpc }; startAndHold(child, rpc);
      child.send({ id: 1, method: 'interaction/requestPermission', params: { requestId: 'r', sessionId: rpc.params.sessionId, turnId: 'turn-' + rpc.params.sessionId,
        toolCallId: 't', toolName: 'Bash', reason: 'run test', riskLevel: 'medium', input: { command: 'test' }, options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow', response: { decision: 'allow', reason: 'Approved once' } },
          { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } },
        ] } }); entered.resolve(); return true;
    } }); await f.agent.signIn(); const running = f.agent.runTask(task(f)); await entered.promise;
    for (let index = 0; index < 20 && !f.fake.calls.some(call => call.rpc.id === 1 && call.rpc.result); index++) await tick();
    const reply = f.fake.calls.find(call => call.rpc.id === 1 && call.rpc.result).rpc; assert.equal(reply.result.decision, decision === 'allow_once' ? 'allow' : 'deny');
    assert.equal(reply.result.permissionUpdates, undefined); assert.equal(f.fake.calls.find(call => call.rpc.method === 'session/create').rpc.params.mode, 'guarded');
    held.child.event(held.rpc.params.sessionId, 'turn.completed', { inputId: held.rpc.params.inputId, response: '', resultType: 'success' }); await running;
  }
});
test('user questions are answered separately from permissions and private credential-header reverse calls are rejected', async t => {
  const entered = deferred(); let held; let permissionCalls = 0;
  const f = await fixture(t, { onPermission: () => { permissionCalls++; return 'allow_once'; }, onUserInput: request => {
    assert.equal(request.questions[0].options[0].value, '方案一'); return { action: 'accept', content: { answers: { '选择方案？': '方案一' } } };
  }, handler: ({ child, rpc }) => {
    if (rpc?.method !== 'session/send') return false; held = { child, rpc }; startAndHold(child, rpc);
    child.send({ id: 10, method: 'interaction/requestUserInput', params: { requestId: 'question', sessionId: rpc.params.sessionId, turnId: 'turn-' + rpc.params.sessionId,
      questions: [{ question: '选择方案？', header: '方案', options: [{ value: '方案一', label: '方案一' }] }] } });
    child.send({ id: 11, method: 'interaction/requestProviderRuntimeHeaders', params: { requestId: 'do-not-fetch-private-auth' } }); entered.resolve(); return true;
  } }); await f.agent.signIn(); const running = f.agent.runTask(task(f)); await entered.promise;
  for (let index = 0; index < 20 && f.fake.calls.filter(call => call.rpc.result || call.rpc.error).length < 2; index++) await tick();
  assert.deepEqual(f.fake.calls.find(call => call.rpc.id === 10 && call.rpc.result).rpc.result, { action: 'accept', content: { answers: { '选择方案？': '方案一' } } });
  assert.equal(f.fake.calls.find(call => call.rpc.id === 11 && call.rpc.error).rpc.error.code, -32601); assert.equal(permissionCalls, 0);
  held.child.event(held.rpc.params.sessionId, 'turn.completed', { inputId: held.rpc.params.inputId, response: '', resultType: 'success' }); await running;
});
test('Stop uses session/stop and cancels late approvals; nonresponsive sessions are force-killed within the grace bound', async t => {
  const entered = deferred(), decision = deferred(); let held;
  const f = await fixture(t, { onPermission: () => decision.promise, handler: ({ child, rpc }) => {
    if (rpc?.method !== 'session/send') return false; held = { child, rpc }; startAndHold(child, rpc);
    child.send({ id: 12, method: 'interaction/requestPermission', params: { sessionId: rpc.params.sessionId, turnId: 'turn-' + rpc.params.sessionId, options: [{ optionId: 'a', kind: 'allow_once', name: 'Allow', response: { decision: 'allow' } }] } }); entered.resolve(); return true;
  } }); await f.agent.signIn(); const running = f.agent.runTask(task(f)), rejected = assert.rejects(running, { name: 'AbortError' }); await entered.promise;
  const started = Date.now(); await f.agent.stop(); await rejected; assert.ok(Date.now() - started < 500); assert.ok(f.kills.length >= 1);
  assert.ok(f.fake.calls.some(call => call.rpc.method === 'session/stop')); decision.resolve('a'); await tick();
  assert.equal(f.fake.calls.some(call => call.rpc.id === 12 && call.rpc.result?.decision === 'allow'), false);
});
test('cooperative cancellation does not kill the live app-server', async t => {
  const entered = deferred(); let held;
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc?.method === 'session/send') { held = { child, rpc }; startAndHold(child, rpc); entered.resolve(); return true; }
    if (rpc?.method === 'session/stop') { child.reply(rpc, {}); child.event(held.rpc.params.sessionId, 'turn.completed', { inputId: held.rpc.params.inputId, resultType: 'cancelled', response: '' }); return true; }
  } }); await f.agent.signIn(); const running = f.agent.runTask(task(f)), rejected = assert.rejects(running, { name: 'AbortError' }); await entered.promise; await f.agent.stop(); await rejected;
  assert.equal(f.kills.length, 0);
});
test('cancelled login cannot persist late credentials or reveal its stderr and public user metadata', async t => {
  const entered = deferred(); let child;
  const f = await fixture(t, { handler: value => { if (!value.login) return false; child = value.child; child.stderr.write('https://private.example?pollToken=SECRET PRIVATE_TOKEN'); entered.resolve(); return true; } });
  const login = f.agent.signIn(), rejected = assert.rejects(login, { name: 'AbortError' }); await entered.promise; await f.agent.cancelSignIn(); await rejected;
  child.finishLogin('bigmodel'); await tick(); const state = await f.agent.publicState(); assert.equal(state.session.profileId, null); assert.doesNotMatch(JSON.stringify(state), /PRIVATE|SECRET|https:/);
  await assert.rejects(fs.readFile(path.join(f.dir, 'zcode-agent', 'connection.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'zcode-agent', 'profiles')), []);
});
test('turn failures and unsupported inputs never expose official account errors or submit extra work', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => { if (rpc?.method !== 'session/send') return false; startAndHold(child, rpc); child.event(rpc.params.sessionId, 'turn.failed', { inputId: rpc.params.inputId, error: { message: 'PRIVATE_TOKEN https://oauth/?code=SECRET' } }); return true; } });
  await f.agent.signIn(); await assert.rejects(f.agent.runTask(task(f)), { code: 'ZCODE_TASK_FAILED' }); assert.doesNotMatch(JSON.stringify(await f.agent.publicState()), /PRIVATE|SECRET|https:/);
  const before = f.fake.calls.length; await assert.rejects(f.agent.runTask(task(f, { modeId: 'yolo' })), { code: 'ZCODE_INVALID_INPUT' }); await assert.rejects(f.agent.runTask(task(f, { attachments: [{ path: 'C:\\private.png' }] })), { code: 'ZCODE_INVALID_INPUT' }); assert.equal(f.fake.calls.length, before);
  await f.agent.disconnect(); assert.equal((await f.agent.publicState()).session.sharing, false); assert.equal(f.fake.children.some(child => child.args.includes('logout')), false);
});
test('a failed independent-profile login preserves only the unchanged previous account and cleans the new home', async t => {
  let deny = false;
  const f = await fixture(t, { handler: ({ child, login }) => { if (!login || !deny) return false; child.kill(); return true; } });
  const first = await f.agent.signIn(), firstHome = f.fake.children[0].options.env.HOME; deny = true;
  await assert.rejects(f.agent.signIn({ region: 'zai' }), { code: 'ZCODE_PROTOCOL_ERROR' });
  const failed = f.fake.children.at(-1), state = await f.agent.publicState(); assert.notEqual(failed.options.env.HOME, firstHome);
  assert.equal(state.session.profileId, first.session.profileId); assert.equal(state.region, 'bigmodel'); assert.equal(state.session.sharing, true);
  await assert.rejects(fs.stat(failed.options.env.HOME), { code: 'ENOENT' });
  assert.ok((await fs.stat(firstHome)).isDirectory());
});
test('cancelling during atomic metadata rename rolls back the persisted account pointer and respects pending region display', async t => {
  const f = await fixture(t); const old = await f.agent.signIn();
  const entered = deferred(), release = deferred(), rename = fs.rename; let hold = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (hold && to === path.join(f.dir, 'zcode-agent', 'connection.json')) { hold = false; entered.resolve(); await release.promise; }
    return rename(from, to);
  });
  const signing = f.agent.signIn({ region: 'zai' }), rejected = assert.rejects(signing, { name: 'AbortError' }); await entered.promise;
  assert.equal((await f.agent.publicState()).region, 'zai'); const cancel = f.agent.cancelSignIn(); release.resolve(); await cancel; await rejected;
  const stored = JSON.parse(await fs.readFile(path.join(f.dir, 'zcode-agent', 'connection.json'), 'utf8'));
  assert.equal(stored.profileId, old.session.profileId); assert.equal(stored.region, 'bigmodel'); assert.equal((await f.agent.publicState()).session.profileId, old.session.profileId);
});
test('returning to default guarded mode cannot inherit a previously selected looser mode', async t => {
  const f = await fixture(t); await f.agent.signIn(); await f.agent.runTask(task(f, { modeId: 'edit' })); await f.agent.runTask(task(f));
  assert.deepEqual(f.fake.calls.filter(call => call.rpc.method === 'session/setMode').map(call => call.rpc.params.mode), ['edit', 'guarded']);
});

test('official login model namespace is retained independently from the login region and restored without reading credentials', async t => {
  const f = await fixture(t, { handler: ({ child, login, rpc }) => {
    if (login) { child.finishLogin('bigmodel', 'fixture-user', 'official-coding-plan'); return true; }
    if (rpc?.method !== 'session/create') return false;
    const sessionId = 'namespaced-' + f.fake.sessions.size; f.fake.sessions.set(sessionId, { seq: 0 });
    child.reply(rpc, { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId, mode: 'guarded' }, settings: { model: { available: [
      { ref: { providerId: 'official-coding-plan', modelId: 'glm-fixture' }, label: 'Official GLM', properties: { inputFormat: ['text'] } },
      { ref: { providerId: 'bigmodel', modelId: 'wrong-family' }, label: 'Unrelated API model', properties: {} },
    ] } } }); return true;
  } });
  await f.agent.signIn(); assert.deepEqual((await f.agent.listModels()).map(row => row.id), ['official-coding-plan/glm-fixture']);
  const metadata = JSON.parse(await fs.readFile(path.join(f.dir, 'zcode-agent', 'connection.json'), 'utf8'));
  assert.equal(metadata.region, 'bigmodel'); assert.equal(metadata.providerId, 'official-coding-plan');
  const restored = new ZCodeAgent(f.config); t.after(() => restored.dispose());
  assert.deepEqual((await restored.listModels()).map(row => row.id), ['official-coding-plan/glm-fixture']);
  await restored.runTask(task(f, { modelId: 'official-coding-plan/glm-fixture' }));
  assert.deepEqual(f.fake.calls.findLast(call => call.rpc.method === 'session/send').rpc.params.modelSelection, { providerId: 'official-coding-plan', modelId: 'glm-fixture' });
});

test('system proxy callback maps to the official dedicated proxy contract after standard environment sanitization', async t => {
  const f = await fixture(t, { getProxyEnv: () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1', ZCODE_CREDENTIAL_SECRET: 'do-not-forward' }) });
  await f.agent.signIn(); await f.agent.listModels();
  for (const child of f.fake.children) {
    assert.equal(child.options.env.ZCODE_HTTP_PROXY, 'http://127.0.0.1:7890'); assert.equal(child.options.env.ZCODE_NO_PROXY, 'localhost,127.0.0.1');
    assert.equal(child.options.env.ZCODE_CREDENTIAL_SECRET, undefined);
  }
});
