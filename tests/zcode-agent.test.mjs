import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ZCodeAgent } from '../src/core/zcode-agent.mjs';
import { nativeModelOption, resolveNativeModel } from './fixtures/zcode-native-model-contract.mjs';
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
    child.finishLogin = (region = args[args.indexOf('login') + 1], user = 'fixture-user', providerId = region) => { child.stdout.write(JSON.stringify({ status: 'ready', provider: region, user: { user_id: user, email: 'PRIVATE_EMAIL' }, model: providerId + '/glm-fixture', credentialsPath: 'PRIVATE_PATH' }, null, 2)); child.kill(); };
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
  assert.equal(login.options.env.SYNORA_ZCODE_STANDALONE_ACCOUNT, '1');
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

test('structured native provider failures distinguish balance, plan quotas, rate limits and transport errors without leaking details', async t => {
  const rows = [
    ['balance', { code: '1113', attribution: { statusCode: 429, providerErrorCode: '1113', exceptionKind: 'provider_business', retryable: false } }, 'ZCODE_QUOTA_UNAVAILABLE', /余额|资源包/u],
    ['plan window', { attribution: { statusCode: 429, providerErrorCode: '1308' } }, 'ZCODE_PLAN_LIMIT', /重置时间/u],
    ['plan expired', { attribution: { statusCode: 429, providerErrorCode: '1309' } }, 'ZCODE_PLAN_EXPIRED', /到期/u],
    ['model entitlement', { attribution: { statusCode: 429, providerErrorCode: '1311' } }, 'ZCODE_MODEL_ACCESS_REQUIRED', /权限/u],
    ['rate limit', { attribution: { statusCode: 429, providerErrorCode: '1302' } }, 'ZCODE_RATE_LIMITED', /频率/u],
    ['unknown 429', { attribution: { statusCode: 429 } }, 'ZCODE_REQUEST_LIMITED', /429/u],
    ['missing model', { code: '1211' }, 'ZCODE_MODEL_UNAVAILABLE', /模型/u],
    ['context', { type: 'model_context_exceeded' }, 'ZCODE_CONTEXT_EXCEEDED', /上下文/u],
    ['network', { attribution: { exceptionKind: 'transport', reason: 'network_error' } }, 'ZCODE_NETWORK_ERROR', /网络/u],
    ['timeout', { attribution: { exceptionKind: 'transport', reason: 'stream_idle_timeout' } }, 'ZCODE_TIMEOUT', /超时/u],
    ['service', { attribution: { statusCode: 503 } }, 'ZCODE_SERVICE_UNAVAILABLE', /暂时不可用/u],
    // Logs and free text must never be interpreted as provider status fields.
    ['unstructured', { attribution: { statusCode: '429', providerErrorCode: 'PRIVATE_SECRET_1113' } }, 'ZCODE_TASK_FAILED', /任务执行失败/u],
  ];
  for (const [label, detail, code, message] of rows) await t.test(label, async subtest => {
    const f = await fixture(subtest, { handler: ({ child, rpc }) => {
      if (rpc?.method !== 'session/send') return false;
      startAndHold(child, rpc);
      child.event(rpc.params.sessionId, 'turn.failed', { inputId: rpc.params.inputId, error: {
        type: 'unknown_error', message: 'PRIVATE_SECRET https://oauth/?code=SECRET', detail: 'PRIVATE_DETAIL',
        underlyingErrorMessage: 'PRIVATE_UNDERLYING', stack: 'private-file.ts:429:1113', ...detail,
      } }); return true;
    } });
    const connected = await f.agent.signIn();
    await assert.rejects(f.agent.runTask(task(f)), error => error.code === code && message.test(error.message) && !/PRIVATE|SECRET|https:|private-file/u.test(error.message));
    const state = await f.agent.publicState();
    assert.equal(state.error.code, code); assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true);
    assert.equal(state.session.profileId, connected.session.profileId);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE|SECRET|https:|private-file/u);
    assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/send').length, 1, 'A business failure must not automatically resubmit the task');
    assert.deepEqual((await f.agent.listModels()).map(model => model.id), ['bigmodel/glm-fixture']);
    assert.equal(f.fake.children.filter(child => child.args.includes('login')).length, 1, 'Quota and service failures preserve the existing login');
  });
});

test('native authentication failure alone asks to reconnect while quota RPC failures retain the account', async t => {
  for (const [label, detail, expectedCode, expectedStatus] of [
    ['auth event', { attribution: { statusCode: 401, providerErrorCode: '1003' } }, 'ZCODE_AUTH_REQUIRED', 'reauth_required'],
    ['quota RPC', { attribution: { statusCode: 429, providerErrorCode: '1113' } }, 'ZCODE_QUOTA_UNAVAILABLE', 'connected'],
  ]) await t.test(label, async subtest => {
    const f = await fixture(subtest, { handler: ({ child, rpc }) => {
      if (rpc?.method !== 'session/send') return false;
      if (label === 'quota RPC') child.send({ id: rpc.id, error: { code: -32603, message: 'PRIVATE_RPC_ERROR', data: detail } });
      else { startAndHold(child, rpc); child.event(rpc.params.sessionId, 'turn.failed', { inputId: rpc.params.inputId, error: { message: 'PRIVATE_EVENT_ERROR', ...detail } }); }
      return true;
    } });
    const connected = await f.agent.signIn();
    await assert.rejects(f.agent.runTask(task(f)), { code: expectedCode });
    const state = await f.agent.publicState();
    assert.equal(state.session.status, expectedStatus); assert.equal(state.session.profileId, connected.session.profileId);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/u);
  });
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

const authorize = region => region === 'zai'
  ? 'https://chat.z.ai/api/oauth/authorize?client_id=zcode&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback&state=fixture-nonce&response_type=code'
  : 'https://bigmodel.cn/login?appId=zcode&redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel&state=fixture-nonce';
function loginBanner(child, target) { child.stderr.write('Open this URL to sign in:\n' + target + '\n'); }

test('optional safe opener receives the complete original official URL across stderr chunks without cmd query splitting or duplicate launches', async t => {
  for (const region of ['bigmodel', 'zai']) {
    const opened = [], target = authorize(region);
    const f = await fixture(t, { openExternal: url => opened.push(url), handler: ({ child, login }) => {
      if (!login) return false;
      child.stderr.write('Unrelated original runtime notice\nOpen this URL to si');
      child.stderr.write('gn in:\r\n' + target.slice(0, 37)); child.stderr.write(target.slice(37) + '\r\n');
      loginBanner(child, target); child.finishLogin(region); return true;
    } });
    const state = await f.agent.signIn({ region });
    assert.equal(state.session.status, 'connected'); assert.deepEqual(opened, [target]);
    assert.deepEqual(f.fake.children[0].args, ['login', region, '--json', '--no-browser']);
    assert.doesNotMatch(JSON.stringify(state), /fixture-nonce|authorize\?|redirect_uri|appId=/u);
  }
});

test('unsafe authorization URL banners are rejected before any browser call, including a valid banner arriving after an invalid one', async t => {
  const candidates = ['http://bigmodel.cn/login?state=fixture', 'https://bigmodel.cn.evil.invalid/login', 'https://chat.z.ai/api/oauth/authorize',
    'https://bigmodel.cn/other', 'https://user:secret@bigmodel.cn/login', 'https://bigmodel.cn:8443/login', 'https://bigmodel.cn/login#fragment',
    'javascript:alert(1)', 'https://bigmodel.cn/login\t?state=fixture'];
  for (const target of candidates) {
    const opened = [];
    const f = await fixture(t, { openExternal: url => opened.push(url), handler: ({ child, login }) => {
      if (!login) return false; loginBanner(child, target); loginBanner(child, authorize('bigmodel')); child.finishLogin(); return true;
    } });
    await assert.rejects(f.agent.signIn(), { code: 'ZCODE_AUTH_URL_INVALID' }); assert.deepEqual(opened, []);
    assert.equal((await f.agent.publicState()).session.sharing, false);
  }
});

test('cancelled and stale login output cannot open a page or commit an account after a newer attempt begins', async t => {
  let held, hold = true; const entered = deferred(), opened = [];
  const f = await fixture(t, { openExternal: url => opened.push(url), handler: ({ child, login }) => {
    if (!login) return false;
    if (hold) { held = child; entered.resolve(); return true; }
    loginBanner(child, authorize('bigmodel')); child.finishLogin(); return true;
  } });
  const running = f.agent.signIn(), cancelled = assert.rejects(running, { name: 'AbortError' }); await entered.promise;
  await f.agent.cancelSignIn(); await cancelled;
  loginBanner(held, authorize('bigmodel')); held.finishLogin(); await tick(); assert.deepEqual(opened, []);
  hold = false; const next = await f.agent.signIn(); loginBanner(held, authorize('bigmodel')); await tick();
  assert.equal(next.session.status, 'connected'); assert.deepEqual(opened, [authorize('bigmodel')]);
});

test('a failed or cancelled safe browser opener preserves the previous isolated account without revealing its thrown message', async t => {
  let failOpen = false, holdOpen = false; const entered = deferred(), release = deferred();
  const f = await fixture(t, { openExternal: () => {
    if (failOpen) throw Error('PRIVATE_BROWSER_SECRET https://untrusted.invalid/?token=SECRET');
    if (holdOpen) { entered.resolve(); return release.promise; }
  }, handler: ({ child, login }) => { if (!login) return false; loginBanner(child, authorize('bigmodel')); child.finishLogin(); return true; } });
  const first = await f.agent.signIn(); failOpen = true;
  await assert.rejects(f.agent.signIn(), { code: 'ZCODE_BROWSER_OPEN_FAILED' });
  let state = await f.agent.publicState(); assert.equal(state.session.profileId, first.session.profileId); assert.equal(state.session.sharing, true);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|SECRET|https:/u);
  failOpen = false; holdOpen = true; const running = f.agent.signIn(), cancelled = assert.rejects(running, { name: 'AbortError' }); await entered.promise;
  await f.agent.cancelSignIn(); await cancelled; release.resolve(); await tick(); state = await f.agent.publicState();
  assert.equal(state.session.profileId, first.session.profileId);
  const metadata = JSON.parse(await fs.readFile(path.join(f.dir, 'zcode-agent', 'connection.json'), 'utf8')); assert.equal(metadata.profileId, first.session.profileId);
});

test('a successful CLI exit without the official no-browser authorization banner cannot bind a profile', async t => {
  const f = await fixture(t, { openExternal: () => { throw Error('must not run'); } });
  await assert.rejects(f.agent.signIn(), { code: 'ZCODE_AUTH_URL_INVALID' }); assert.equal((await f.agent.publicState()).session.sharing, false);
});

test('an empty official catalog remains an explicit connected-account error and never becomes a fabricated model selection', async t => {
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc?.method !== 'session/create') return false;
    child.reply(rpc, { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId: 'actual-empty-native' },
      settings: { model: { available: [] }, mode: { current: 'guarded' }, permission: { mode: 'guarded' }, thoughtLevel: { enabled: false, available: [] } } }); return true;
  } });
  const connected = await f.agent.signIn();
  await assert.rejects(f.agent.listModels(), { code: 'ZCODE_CATALOG_EMPTY' });
  let state = await f.agent.publicState(); assert.equal(state.session.profileId, connected.session.profileId); assert.equal(state.session.status, 'connected'); assert.deepEqual(state.models, []);
  await assert.rejects(f.agent.runTask(task(f)), { code: 'ZCODE_CATALOG_EMPTY' }); state = await f.agent.publicState();
  assert.equal(state.session.profileId, connected.session.profileId); assert.equal(state.session.sharing, true);
  assert.equal(f.fake.calls.some(call => call.rpc.method === 'session/send'), false);
});

test('native advertised reasoning defaults complete only private execution refs, preserving public IDs and rejecting unsupported or missing choices', async t => {
  const provider = { providerId: 'bigmodel', providerName: 'Official fixture' }, models = new Map();
  const row = (modelId, levels) => {
    const model = { modelId, config: { properties: { inputFormat: ['text'], outputFormat: ['text'], contextWindow: 100000 },
      optionSpecs: { reasoningLevel: { values: levels }, maxOutputTokens: { max: 8192 } } } };
    models.set(modelId, model); return nativeModelOption(provider, model);
  };
  const advertised = row('glm-advertised', ['low', 'high', 'medium']);
  const current = row('glm-current', ['off', 'low']); delete current.reasoning.defaultLevel;
  const explicit = row('glm-explicit', ['low', 'high']); explicit.ref.options = { reasoningLevel: 'low' };
  const unknown = row('glm-unknown', ['low', 'high']); unknown.ref.options = { reasoningLevel: 'unknown' };
  const missing = row('glm-missing', ['low', 'high']); delete missing.reasoning.defaultLevel;
  const badDefault = row('glm-bad-default', ['low', 'high']); badDefault.reasoning.defaultLevel = 'unknown';
  const rows = [advertised, current, explicit, unknown, missing, badDefault]; let created = 0;
  // This is the actual pinned upstream validator/resolver, not our adapter's rule.
  assert.equal(advertised.ref.options, undefined);
  assert.throws(() => resolveNativeModel(provider, models.get('glm-advertised'), advertised.ref), { code: 'reasoning-level-missing' });
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc?.method === 'session/create') {
      const sessionId = 'native-reasoning-' + ++created; f.fake.sessions.set(sessionId, { seq: 0 });
      child.reply(rpc, { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId }, settings: { model: {
        available: rows, current: { providerId: 'bigmodel', modelId: 'glm-current', options: { reasoningLevel: 'off' } },
      } } }); return true;
    }
    if (rpc?.method === 'session/send') {
      const requested = rpc.params.modelSelection;
      const resolved = resolveNativeModel(provider, models.get(requested.modelId), requested);
      assert.equal(resolved.selection.options.reasoningLevel, requested.options.reasoningLevel);
    }
    return false;
  } });
  await f.agent.signIn(); const catalog = await f.agent.listModels();
  assert.deepEqual(catalog.map(model => model.id), ['bigmodel/glm-advertised', 'bigmodel/glm-current', 'bigmodel/glm-explicit$low']);
  for (const model of catalog) await f.agent.runTask(task(f, { modelId: model.id }));
  const sent = f.fake.calls.filter(call => call.rpc.method === 'session/send').map(call => call.rpc.params.modelSelection);
  assert.deepEqual(sent.map(ref => ref.options.reasoningLevel), ['medium', 'off', 'low']);
  assert.equal(catalog[0].id, 'bigmodel/glm-advertised', 'inferred execution depth must not change a previously saved public model ID');
  for (const modelId of ['bigmodel/glm-unknown$unknown', 'bigmodel/glm-missing', 'bigmodel/glm-bad-default'])
    await assert.rejects(f.agent.runTask(task(f, { modelId })), { code: 'ZCODE_MODEL_UNAVAILABLE' });
  assert.equal(f.fake.calls.filter(call => call.rpc.method === 'session/send').length, 3);
});

test('official ZCode reasoning choices preserve arbitrary values and labels and default clears a previous override', async t => {
  let next = 0;
  const f = await fixture(t, { handler: ({ child, rpc }) => {
    if (rpc?.method !== 'session/create') return false;
    const sessionId = 'native-effort-' + ++next; f.fake.sessions.set(sessionId, { seq: 0 });
    child.reply(rpc, { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId }, settings: { model: {
      current: { providerId: 'bigmodel', modelId: 'glm-flexible', options: { reasoningLevel: 'native:auto' } },
      available: [{ ref: { providerId: 'bigmodel', modelId: 'glm-flexible' }, label: 'Official flexible model',
        reasoning: { defaultLevel: 'native:auto', levels: [{ value: 'native:auto', label: '官方自动' }, { value: 'native:deep', label: '官方深度' }] } }],
    } } }); return true;
  } }); await f.agent.signIn();
  const [model] = await f.agent.listModels(); assert.deepEqual(model.reasoningEfforts, ['native:auto', 'native:deep']);
  assert.deepEqual(model.reasoningOptions, [{ value: 'native:auto', label: '官方自动' }, { value: 'native:deep', label: '官方深度' }]);
  assert.equal(model.defaultReasoningEffort, 'native:auto'); assert.equal(model.currentReasoningEffort, 'native:auto');
  await f.agent.runTask(task(f, { modelId: model.id, reasoningEffort: 'native:deep' }));
  await f.agent.runTask(task(f, { modelId: model.id, reasoningEffort: 'default' }));
  await assert.rejects(f.agent.runTask(task(f, { modelId: model.id, reasoningEffort: 'invented' })), { code: 'ZCODE_REASONING_UNAVAILABLE' });
  const sends = f.fake.calls.filter(({ rpc }) => rpc.method === 'session/send'); assert.deepEqual(sends.map(({ rpc }) => rpc.params.modelSelection.options.reasoningLevel), ['native:deep', 'native:auto']);
});

test('startup automatically restores the updated bundled component for an existing account without starting a process or changing its binding', async t => {
  const f = await fixture(t), existing = await f.agent.signIn();
  const file = path.join(f.dir, 'zcode-agent', 'connection.json'), before = await fs.readFile(file, 'utf8');
  const launches = f.fake.children.length; let status = 'missing', ensures = 0;
  const runtime = { init: async () => {}, publicState: async () => ({ status, version: '0.17.0' }), ensure: async ({ signal }) => {
    ensures++; assert.equal(signal.aborted, false); status = 'ready'; return { entry: path.join(f.dir, 'new-bundled.exe'), version: '0.17.0' };
  } };
  const restored = new ZCodeAgent({ ...f.config, runtime }); t.after(() => restored.dispose());
  await restored.init(); const state = await restored.publicState();
  assert.equal(ensures, 1); assert.equal(state.runtime.status, 'ready'); assert.equal(state.session.profileId, existing.session.profileId);
  assert.equal(state.session.sharing, true); assert.equal(state.storageRecovery, false);
  assert.equal(f.fake.children.length, launches); assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('API-only startup without a saved GLM profile never prepares or starts the bundled agent', async t => {
  let ensures = 0;
  const f = await fixture(t, { runtime: { init: async () => {}, publicState: async () => ({ status: 'missing', version: '0.17.0' }), ensure: async () => { ensures++; throw Error('must not run'); } } });
  await f.agent.init(); const state = await f.agent.publicState();
  assert.equal(ensures, 0); assert.equal(state.session.sharing, false); assert.equal(state.runtime.status, 'missing'); assert.equal(f.fake.children.length, 0);
});

test('component or disk preparation failures preserve a readable account and do not turn API startup into credential recovery', async t => {
  for (const code of ['ZCODE_RUNTIME_MISSING', 'EACCES']) {
    const f = await fixture(t), existing = await f.agent.signIn(); const file = path.join(f.dir, 'zcode-agent', 'connection.json');
    const before = await fs.readFile(file, 'utf8'), launches = f.fake.children.length;
    const runtime = { init: async () => {}, publicState: async () => ({ status: 'missing', version: '0.17.0' }),
      ensure: async () => { throw Object.assign(Error('PRIVATE_PATH_OR_SECRET'), { code }); } };
    const restored = new ZCodeAgent({ ...f.config, runtime }); t.after(() => restored.dispose());
    await assert.doesNotReject(restored.init()); const state = await restored.publicState();
    assert.equal(state.session.profileId, existing.session.profileId); assert.equal(state.session.status, 'connected');
    assert.equal(state.session.sharing, true); assert.equal(state.storageRecovery, false); assert.equal(state.error.code, 'ZCODE_RUNTIME_MISSING');
    assert.equal(state.error.phase, 'runtime'); assert.match(state.error.message, /准备组件/u); assert.doesNotMatch(JSON.stringify(state), /PRIVATE/u);
    assert.equal(f.fake.children.length, launches); assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});
