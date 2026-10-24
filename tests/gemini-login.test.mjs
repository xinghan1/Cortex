import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GeminiConnection, GEMINI_CLI_VERSION } from '../src/core/gemini-login.mjs';

const root = path.resolve('tests/.tmp');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const model = 'gemini-fixture';
const initialized = { protocolVersion: 1, agentInfo: { name: 'gemini-cli', version: GEMINI_CLI_VERSION }, authMethods: [{ id: 'oauth-personal' }] };
const session = id => ({ sessionId: id, models: { currentModelId: model, availableModels: [{ modelId: model, name: 'Gemini fixture' }] } });
const output = { content: '完成', toolCalls: [] };
function fakeCli(handler = () => undefined) {
  const children = [], calls = [];
  function launch(executable, args, options) {
    const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: 0 });
    child.reply = (request, result) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    child.errorReply = (request, error = { code: -32000, message: 'sensitive upstream token DO_NOT_SHOW' }) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error }) + '\n');
    child.update = (id, text, type = 'agent_message_chunk') => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: id, update: { sessionUpdate: type, content: { type: 'text', text } },
    } }) + '\n');
    child.kill = () => { child.killed++; if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); } return true; };
    let buffer = '';
    child.stdin.on('data', bytes => {
      buffer += bytes.toString(); let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
        const request = JSON.parse(line); calls.push({ request, child, executable, args, options });
        if (!request.method) continue;
        Promise.resolve().then(async () => {
          if (await handler({ request, child, args, options, executable })) return;
          if (request.method === 'initialize') child.reply(request, initialized);
          if (request.method === 'authenticate') child.reply(request, {});
          if (request.method === 'session/new') child.reply(request, session('session-' + children.length));
          if (request.method === 'session/prompt') {
            child.update(request.params.sessionId, JSON.stringify(output));
            child.reply(request, { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5, thoughtTokens: 7, cachedReadTokens: 4 } });
          }
        }).catch(caught => { child.testFailure = caught; child.errorReply(request); });
      }
    });
    children.push(child); return child;
  }
  return { launch, calls, children };
}
async function fixture(t, options = {}) {
  await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'gemini-login-'));
  const entry = path.join(dir, 'fake-official-cli.cjs'); await fs.writeFile(entry, '// fake CLI; never executed\n');
  const fake = fakeCli(options.handler); const events = [];
  const create = extra => new GeminiConnection({ dataDir: path.join(dir, 'account'), cliEntry: entry, spawnImpl: fake.launch,
    onChange: () => events.push('state'), version: '0.22.0', ...extra });
  const connection = create(options.config); await connection.init();
  t.after(async () => {
    await connection.dispose();
    assert.equal(path.dirname(dir).toLowerCase(), root.toLowerCase()); assert.ok(path.basename(dir).startsWith('gemini-login-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, entry, fake, connection, create, events, file: path.join(dir, 'account', 'gemini-connection.json') };
}
const request = (state, extra = {}) => ({ provider: 'gemini', authMode: 'gemini-account', model, geminiProfileId: state.session.profileId,
  messages: [{ role: 'user', content: '你好' }], tools: [], ...extra });

test('explicit official CLI login persists only an independent local UUID and restores without reading credentials or starting a process', async t => {
  const f = await fixture(t); assert.equal((await f.connection.publicState()).session.status, 'disconnected');
  assert.deepEqual((await f.connection.publicState()).cli, { available: true, version: '0.65.0' });
  const state = await f.connection.signIn(); assert.equal(state.session.status, 'connected'); assert.equal(state.session.sharing, true);
  assert.match(state.session.profileId, /^[a-f\d-]{36}$/iu); assert.equal(state.attempt, null);
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.deepEqual(saved, { version: 1, profileId: state.session.profileId });
  assert.equal(f.fake.calls.filter(call => call.request.method === 'authenticate')[0].request.params.methodId, 'oauth-personal');
  assert.equal(f.fake.calls.some(call => call.request.method === 'session/prompt'), false, 'Login does not make inference requests');
  const before = f.fake.children.length, restored = f.create(); t.after(() => restored.dispose()); await restored.init();
  assert.equal((await restored.publicState()).session.profileId, state.session.profileId); assert.equal(f.fake.children.length, before);
  assert.equal((await f.connection.listModels())[0].supportsImages, false);
  assert.ok(!JSON.stringify(state).includes('oauth_creds')); assert.equal(f.fake.children.every(child => child.killed > 0), true);
});

test('every CLI launch uses isolated home, no built-ins/hooks/MCP/extensions or ambient credential lane, and no relaunch', async t => {
  const f = await fixture(t, { config: { env: { GEMINI_API_KEY: 'do-not-use', GOOGLE_APPLICATION_CREDENTIALS: 'no-read', NODE_OPTIONS: '--import=evil',
    NO_BROWSER: 'true', HTTPS_PROXY: 'http://127.0.0.1:7890' } } });
  const state = await f.connection.signIn(); await f.connection.requestModel(request(state));
  for (const child of f.fake.children) {
    const call = f.fake.calls.find(value => value.child === child), env = call.options.env;
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.args.slice(1, 6), ['--acp', '-e', 'none', '--approval-mode', 'default']);
    assert.equal(env.GEMINI_CLI_NO_RELAUNCH, '1'); assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890'); assert.ok(env.GEMINI_CLI_HOME.startsWith(path.join(f.dir, 'account') + path.sep));
    await assert.rejects(fs.stat(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH), { code: 'ENOENT' });
    await assert.rejects(fs.stat(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH), { code: 'ENOENT' });
    const settings = JSON.parse(await fs.readFile(path.join(env.GEMINI_CLI_HOME, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.tools.core, []); assert.equal(settings.hooksConfig.enabled, false); assert.equal(settings.admin.mcp.enabled, false);
    assert.equal(settings.admin.extensions.enabled, false); assert.equal(settings.skills.enabled, false); assert.equal(settings.billing.overageStrategy, 'never');
    assert.equal(settings.advanced.autoConfigureMemory, false); assert.deepEqual(settings.context.fileName, []);
    assert.equal(settings.security.auth.selectedType, undefined, 'Only ACP authenticate chooses auth after the RPC transport is ready');
    assert.equal(settings.security.auth.enforcedType, 'oauth-personal');
    assert.equal(env.NO_BROWSER, call.args.includes('--model') ? 'true' : undefined);
  }
});

test('a valid tool JSON returns only declared structured calls and complete text, with real candidate+thought usage', async t => {
  const input = { path: 'index.html', content: '<svg>中文\\n</svg>' }, wire = { content: '已准备操作。', toolCalls: [{ name: 'write_file', arguments: input }] };
  let prompt; const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (rpc.method !== 'session/prompt') return false;
    prompt = rpc.params.prompt; child.update(rpc.params.sessionId, 'PRIVATE_THINKING', 'agent_thought_chunk');
    const encoded = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: rpc.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(wire) } } } }) + '\n');
    for (let i = 0; i < encoded.length; i++) child.stdout.write(encoded.subarray(i, i + 1));
    child.reply(rpc, { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5, thoughtTokens: 7, cachedReadTokens: 4 } }); return true;
  } });
  const state = await f.connection.signIn(), progress = [], textFrames = [];
  const tools = [{ name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } }];
  const result = await f.connection.requestModel(request(state, { tools, onProgress: item => progress.push(item), onTextDelta: text => textFrames.push(text),
    messages: [{ role: 'system', content: 'Keep my rules' }, { role: 'user', content: '/init $command @C:/sensitive.txt' },
      { role: 'assistant', content: 'old incomplete', localOnly: true, providerState: { secret: 'never forwarded' } }] }));
  assert.equal(prompt.length, 1); assert.equal(prompt[0].type, 'text'); assert.ok(prompt[0].text.startsWith('SYNORA_MODEL_REQUEST\n'));
  assert.ok(prompt[0].text.includes('@C:/sensitive.txt')); assert.ok(!prompt[0].text.includes('never forwarded')); assert.ok(!prompt[0].text.includes('old incomplete'));
  assert.equal(result.message.toolCalls[0].name, 'write_file'); assert.deepEqual(result.message.toolCalls[0].arguments, input);
  assert.match(result.message.toolCalls[0].id, /^[a-f\d-]{36}$/iu); assert.deepEqual(textFrames, ['已准备操作。']);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 12, cachedInputTokens: 4 }); assert.equal(result.usageReported, true);
  assert.ok(progress.some(value => value.phase === 'thinking')); assert.ok(!JSON.stringify(progress).includes('PRIVATE_THINKING'));
  assert.equal(f.fake.calls.filter(call => call.request.method === 'session/prompt').length, 1);
});

test('each model request gets a fresh CLI session without replaying another request history', async t => {
  const f = await fixture(t), state = await f.connection.signIn();
  await f.connection.requestModel(request(state)); await f.connection.requestModel(request(state, { messages: [{ role: 'user', content: 'SECOND-ONLY' }] }));
  const turns = f.fake.calls.filter(call => call.request.method === 'session/prompt'); assert.equal(turns.length, 2);
  assert.notEqual(turns[0].request.params.sessionId, turns[1].request.params.sessionId); assert.notEqual(turns[0].child, turns[1].child);
  assert.equal(f.fake.calls.some(call => call.request.method === 'session/load'), false);
});

test('truncated responses, malformed/extra JSON, unknown calls, duplicate IDs and invalid arguments never publish tools or JSON text', async t => {
  for (const kind of ['truncated', 'malformed', 'extra', 'unknown', 'duplicate', 'arguments', 'empty', 'proto']) {
    const f = await fixture(t, { handler: ({ request: rpc, child }) => {
      if (rpc.method !== 'session/prompt') return false;
      const call = { id: 'one', name: 'write_file', arguments: { path: 'x' } };
      const payload = kind === 'malformed' ? '{"content":"unfinished"' : kind === 'proto' ? '{"content":"","toolCalls":[{"name":"write_file","arguments":{"__proto__":{}}}]}'
        : JSON.stringify({ content: kind === 'empty' ? '' : 'ready', toolCalls: kind === 'empty' ? [] : kind === 'duplicate' ? [call, call]
          : [{ ...call, ...(kind === 'unknown' ? { name: 'run_unprovided_shell' } : {}), ...(kind === 'arguments' ? { arguments: 'not-object' } : {}) }],
        ...(kind === 'extra' ? { executable: true } : {}) });
      child.update(rpc.params.sessionId, payload); child.reply(rpc, { stopReason: kind === 'truncated' ? 'max_tokens' : 'end_turn', usage: { inputTokens: 2, outputTokens: 8 } }); return true;
    } });
    const state = await f.connection.signIn(), frames = [], progress = [];
    await assert.rejects(f.connection.requestModel(request(state, { tools: [{ name: 'write_file', description: '', parameters: {} }],
      onTextDelta: text => frames.push(text), onProgress: value => progress.push(value) })), { code: kind === 'truncated' ? 'PROVIDER_TRUNCATED' : 'GEMINI_INVALID_RESPONSE' });
    assert.deepEqual(frames, []); assert.ok(progress.some(item => item.usage?.outputTokens === 8));
  }
});

test('reverse permission/filesystem/terminal requests and unexpected native tool events are denied and stop the process', async t => {
  for (const method of ['session/request_permission', 'fs/read_text_file', 'terminal/create', 'tool-update']) {
    const f = await fixture(t, { handler: ({ request: rpc, child }) => {
      if (rpc.method !== 'session/prompt') return false;
      if (method === 'tool-update') child.update(rpc.params.sessionId, 'anything', 'tool_call');
      else child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'reverse-request', method, params: { path: 'C:/private' } }) + '\n');
      return true;
    } }); const state = await f.connection.signIn();
    await assert.rejects(f.connection.requestModel(request(state)), { code: 'GEMINI_UNEXPECTED_TOOL' });
    if (method !== 'tool-update') {
      const denied = f.fake.calls.find(call => call.request.id === 'reverse-request').request;
      if (method === 'session/request_permission') assert.equal(denied.result.outcome.outcome, 'cancelled'); else assert.equal(denied.error.code, -32601);
    }
    assert.ok(f.fake.children.at(-1).killed);
  }
});

test('unknown usage remains unreported rather than estimated and callbacks cannot leak hidden reasoning', async t => {
  const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (rpc.method !== 'session/prompt') return false;
    child.update(rpc.params.sessionId, JSON.stringify(output)); child.reply(rpc, { stopReason: 'end_turn' }); return true;
  } }); const state = await f.connection.signIn(), result = await f.connection.requestModel(request(state));
  assert.equal(result.usageReported, false);
});

test('sign-in cancellation and request timeout kill their process and cannot commit a late identity or result', async t => {
  const entered = deferred(); let held;
  const f = await fixture(t, { handler: ({ request: rpc, child }) => { if (rpc.method === 'authenticate') { held = { rpc, child }; entered.resolve(); return true; } } });
  const signing = f.connection.signIn(), rejected = assert.rejects(signing, { name: 'AbortError' }); await entered.promise;
  assert.equal((await f.connection.publicState()).session.status, 'connecting'); await f.connection.cancelSignIn(); await rejected;
  held.child.reply(held.rpc, {}); await tick(); assert.equal((await f.connection.publicState()).session.profileId, null);
  assert.ok(held.child.killed); await assert.rejects(fs.readFile(f.file), { code: 'ENOENT' });
  const g = await fixture(t, { handler: ({ request: rpc }) => rpc.method === 'session/prompt' }); const state = await g.connection.signIn();
  await assert.rejects(g.connection.requestModel(request(state, { timeoutMs: 10 })), { code: 'GEMINI_TIMEOUT' }); assert.ok(g.fake.children.at(-1).killed);
});

test('account replacement aborts older requests and old profile IDs cannot start generation', async t => {
  const entered = deferred(); let held;
  const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (rpc.method === 'session/prompt') { held = { rpc, child }; entered.resolve(); return true; }
  } }); const old = await f.connection.signIn();
  const pending = f.connection.requestModel(request(old)), rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise;
  const next = await f.connection.signIn(); await rejected;
  assert.notEqual(old.session.profileId, next.session.profileId);
  held.child.update(held.rpc.params.sessionId, JSON.stringify(output)); held.child.reply(held.rpc, { stopReason: 'end_turn' });
  await assert.rejects(f.connection.requestModel(request(old)), { code: 'GEMINI_ACCOUNT_CHANGED' });
  assert.equal((await f.connection.publicState()).session.profileId, next.session.profileId);
});

test('failed refresh never exposes upstream diagnostics and disconnected credentials are isolated and removed', async t => {
  let rejectAuth = false;
  const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (rejectAuth && rpc.method === 'authenticate') { child.errorReply(rpc); child.stderr.write('SECRET oauth URL token'); return true; }
  } }); const state = await f.connection.signIn(); rejectAuth = true;
  await assert.rejects(f.connection.listModels({ force: true }), { code: 'GEMINI_SIGN_IN_REQUIRED' });
  const unavailable = await f.connection.publicState(); assert.equal(unavailable.session.status, 'reauth_required'); assert.equal(unavailable.session.sharing, false);
  assert.ok(!JSON.stringify(unavailable).includes('DO_NOT_SHOW')); assert.ok(!JSON.stringify(unavailable).includes('SECRET'));
  await f.connection.disconnect(); assert.equal((await f.connection.publicState()).session.status, 'disconnected');
  await assert.rejects(fs.stat(path.join(f.dir, 'account', 'gemini-cli-profiles', state.session.profileId)), { code: 'ENOENT' });
});

test('corrupt own profile metadata is preserved for recovery and cannot silently create a new connection', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.writeFile(f.file, '{bad metadata');
  const restored = f.create(); t.after(() => restored.dispose()); await restored.init();
  assert.equal((await restored.publicState()).storageRecovery, true);
  await assert.rejects(restored.signIn(), { code: 'GEMINI_STORAGE_UNREADABLE' }); assert.equal(await fs.readFile(f.file, 'utf8'), '{bad metadata');
  await fs.writeFile(f.file, JSON.stringify({ version: 1, profileId: null })); await restored.retryLocalRead();
  assert.equal((await restored.publicState()).storageRecovery, false); assert.equal(f.fake.children.length, 0);
});

test('unsupported image, wrong provider and reasoning controls are rejected before sending any model prompt', async t => {
  const f = await fixture(t), state = await f.connection.signIn();
  for (const extra of [{ provider: 'openai' }, { reasoningEffort: 'max' }, { messages: [{ role: 'user', content: '', attachments: [{ dataUrl: 'image' }] }] }])
    await assert.rejects(f.connection.requestModel(request(state, extra)));
  assert.equal(f.fake.calls.some(call => call.request.method === 'session/prompt'), false);
});

test('system proxy resolves for every launch, cannot inject authentication environment, and cancellation wins before spawning', async t => {
  let proxy = 'http://127.0.0.1:7890', reads = 0, held = null;
  const f = await fixture(t, { config: { getProxyEnv: async () => {
    reads++; if (held) await held.promise;
    return { HTTPS_PROXY: proxy, GEMINI_API_KEY: 'must-not-forward', GOOGLE_GENAI_USE_VERTEXAI: 'true', NODE_OPTIONS: 'malicious' };
  } } });
  const state = await f.connection.signIn(); assert.equal(reads, 1);
  proxy = 'http://127.0.0.1:7891'; await f.connection.requestModel(request(state));
  assert.equal(reads, 2); assert.equal(f.fake.calls.at(-1).options.env.HTTPS_PROXY, proxy);
  assert.equal(f.fake.calls.at(-1).options.env.GEMINI_API_KEY, undefined);
  assert.equal(f.fake.calls.at(-1).options.env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  held = deferred(); const controller = new AbortController(), before = f.fake.children.length;
  const pending = f.connection.requestModel(request(state, { signal: controller.signal }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  while (reads < 3) await tick(); controller.abort(); await rejected;
  held.resolve(); await tick(); assert.equal(f.fake.children.length, before);
});

test('an unsupported CLI handshake never authenticates or commits a profile', async t => {
  const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (rpc.method !== 'initialize') return false;
    child.reply(rpc, { ...initialized, agentInfo: { ...initialized.agentInfo, version: '0.1.0' } }); return true;
  } });
  await assert.rejects(f.connection.signIn(), { code: 'GEMINI_CLI_INCOMPATIBLE' });
  assert.equal(f.fake.calls.some(call => call.request.method === 'authenticate'), false);
  assert.equal((await f.connection.publicState()).session.profileId, null); assert.ok(f.fake.children[0].killed);
});

test('expired cached authentication that falls into the CLI manual-code UI fails promptly without leaking its URL or hanging for input', async t => {
  let expired = false;
  const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (!expired || rpc.method !== 'authenticate') return false;
    child.stdout.write('\u001b[2JPlease visit https://accounts.google.com/o/oauth2/auth?PRIVATE_STATE\n'); return true;
  } }); const state = await f.connection.signIn(); expired = true;
  await assert.rejects(f.connection.requestModel(request(state)), { code: 'GEMINI_SIGN_IN_REQUIRED' });
  const current = await f.connection.publicState(); assert.equal(current.session.status, 'reauth_required');
  assert.ok(!JSON.stringify(current).includes('PRIVATE_STATE')); assert.equal(f.fake.calls.some(call => call.request.method === 'session/prompt'), false);
});

test('bootstrap is serialized but generation is independent, and cancelling a queued startup cannot release an earlier startup lock', async t => {
  let hold = false, first; const entered = deferred();
  const f = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (!hold || rpc.method !== 'session/new') return false;
    hold = false; first = { rpc, child }; entered.resolve(); return true;
  } }); const state = await f.connection.signIn(); hold = true;
  const a = f.connection.requestModel(request(state)); await entered.promise;
  const controller = new AbortController(), b = f.connection.requestModel(request(state, { signal: controller.signal }));
  const rejected = assert.rejects(b, { name: 'AbortError' }); const c = f.connection.requestModel(request(state));
  await tick(); controller.abort(); await rejected; await tick();
  assert.equal(f.fake.children.length, 2, 'Login plus A only: C must still wait for A session initialization');
  first.child.reply(first.rpc, session('first-parallel-session')); await Promise.all([a, c]);
  assert.equal(f.fake.children.length, 3); assert.equal(f.fake.calls.filter(call => call.request.method === 'session/prompt').length, 2);
});

test('callback errors and malformed stdout stop safely without publishing arbitrary upstream diagnostics', async t => {
  const f = await fixture(t), state = await f.connection.signIn();
  await assert.rejects(f.connection.requestModel(request(state, { onTextDelta: () => { throw Error('private callback payload'); } })),
    caught => caught.code === 'PROVIDER_CALLBACK_ERROR' && !caught.message.includes('private callback'));
  const g = await fixture(t, { handler: ({ request: rpc, child }) => {
    if (rpc.method !== 'session/prompt') return false; child.stdout.write('NOT_JSON_SECRET\n'); return true;
  } }); const signed = await g.connection.signIn();
  await assert.rejects(g.connection.requestModel(request(signed)), caught => caught.code === 'GEMINI_INVALID_RESPONSE' && !caught.message.includes('NOT_JSON_SECRET'));
  assert.ok(g.fake.children.at(-1).killed);
});
