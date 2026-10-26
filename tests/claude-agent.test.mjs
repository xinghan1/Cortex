import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ClaudeAgent } from '../src/core/claude-agent.mjs';
import { runExternalAgentTurn } from '../src/core/external-agent-turn.mjs';

const catalog = [{ value: 'official-sonnet', displayName: 'Official Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(t, options = {}) {
  const base = path.resolve('artifacts', 'test-claude-agent'); await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const commands = [], queries = [], events = [], authenticated = new Set(), agents = [], children = [], killed = [];
  const spawn = (entry, args, config) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 87000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
    child.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null); };
    child.kill = () => { child.killed = true; child.exit(0); return true; }; children.push(child); commands.push({ entry, args, config, child });
    if (args[0] === 'auth') queueMicrotask(() => {
      if (options.commandHandler?.({ entry, args, config, child, authenticated }) === true) return;
      if (args[1] === 'login') { authenticated.add(config.env.CLAUDE_CONFIG_DIR); child.stderr.write('PRIVATE_AUTH_DIAGNOSTIC=must-not-escape\n'); child.exit(); }
      else if (args[1] === 'status') { child.stdout.write(JSON.stringify({ loggedIn: authenticated.has(config.env.CLAUDE_CONFIG_DIR), authMethod: 'claude.ai', email: 'PRIVATE_EMAIL', accessToken: 'PRIVATE_TOKEN' })); child.exit(authenticated.has(config.env.CLAUDE_CONFIG_DIR) ? 0 : 1); }
    });
    return child;
  };
  const sdk = { query(config) {
    const child = config.options.spawnClaudeCodeProcess({ command: config.options.pathToClaudeCodeExecutable, args: ['--output-format', 'stream-json', '--input-format', 'stream-json'], cwd: config.options.cwd,
      env: { ...config.options.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.310' }, signal: new AbortController().signal });
    const call = { config, child, input: null, closed: 0, interrupted: 0 }; queries.push(call);
    const query = { async supportedModels() { if (options.supportedModels) return options.supportedModels(call); return structuredClone(catalog); },
      close() { call.closed++; config.prompt.close(); child.exit(); }, async interrupt() { call.interrupted++; },
      async *[Symbol.asyncIterator]() {
        for await (const input of config.prompt) {
          call.input = input; const sessionId = config.options.resume || randomUUID(); call.sessionId = sessionId;
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          if (options.queryHandler) { const rows = await options.queryHandler(call); if (rows) for (const message of rows) yield { session_id: sessionId, ...message }; else return; }
          else {
            yield { type: 'assistant', session_id: sessionId, message: { id: 'reply-1', content: [{ type: 'text', text: '官方代理回复' }] } };
            yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } };
          }
        }
      } }; return query;
  } };
  const runtime = { init: async () => {}, publicState: async () => ({ status: 'ready', version: '2.1.310' }), ensure: async ({ signal } = {}) => { signal?.throwIfAborted(); return { entry: path.join(dir, 'claude.exe'), version: '2.1.310' }; } };
  const config = { dataDir: dir, runtime, spawnImpl: spawn, sdkLoader: async () => sdk,
    killTreeImpl: async child => { killed.push(child.pid); child.kill(); }, onEvent: event => events.push(event), startTimeoutMs: 200, stopGraceMs: 5, ...options };
  for (const key of ['queryHandler', 'supportedModels', 'commandHandler']) delete config[key];
  const create = () => { const agent = new ClaudeAgent(config); agents.push(agent); return agent; }, agent = create();
  t.after(async () => { for (const item of agents) await item.dispose(); assert.equal(path.dirname(dir), base); await fs.rm(dir, { recursive: true, force: true }); });
  return { agent, dir, runtime, commands, queries, events, authenticated, children, killed, create };
}
const task = (f, extra = {}) => ({ localSessionId: 'local-one', cwd: f.dir, prompt: '处理当前用户任务', modelId: 'official-sonnet', ...extra });

test('official login and status own credentials in a new isolated profile and never publish their raw output', async t => {
  const states = []; let f;
  f = await fixture(t, { onChange: async () => { if (f) states.push(await f.agent.publicState()); }, getProxyEnv: () => ({ HTTPS_PROXY: 'http://127.0.0.1:9100', ANTHROPIC_API_KEY: 'PRIVATE', CLAUDE_CODE_OAUTH_TOKEN: 'PRIVATE', NODE_OPTIONS: '--require evil', CLAUDE_CODE_ENTRYPOINT: 'cli' }) });
  assert.equal((await f.agent.publicState()).session.status, 'disconnected'); assert.equal(f.commands.length, 0);
  const signed = await f.agent.signIn(); assert.equal(signed.session.status, 'connected'); assert.ok(signed.session.profileId);
  assert.deepEqual(f.commands.map(call => call.args), [['auth', 'login', '--claudeai'], ['auth', 'status']]); assert.equal(f.queries.length, 0);
  for (const { config } of f.commands) {
    assert.equal(config.env.CLAUDE_CONFIG_DIR, path.join(f.dir, 'claude-agent', 'profiles', signed.session.profileId)); assert.equal(config.env.HTTPS_PROXY, 'http://127.0.0.1:9100'); assert.equal(config.shell, false); assert.equal(config.windowsHide, true);
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'CLAUDE_CODE_ENTRYPOINT', 'ELECTRON_RUN_AS_NODE']) assert.equal(config.env[key], undefined);
  }
  assert.doesNotMatch(JSON.stringify(states), /PRIVATE_|accessToken|email/); const metadata = await fs.readFile(path.join(f.dir, 'claude-agent', 'profiles.json'), 'utf8'); assert.doesNotMatch(metadata, /token|secret|email|PRIVATE/i);
});

test('catalog uses an empty SDK input stream and official model/effort metadata without inference', async t => {
  const f = await fixture(t); await f.agent.signIn();
  const models = await f.agent.listModels(); assert.equal(f.queries.length, 1); assert.equal(f.queries[0].input, null); assert.ok(f.queries[0].closed > 0);
  assert.deepEqual(models.map(row => ({ id: row.id, efforts: row.reasoningEfforts })), [{ id: 'official-sonnet', efforts: ['low', 'medium', 'high'] }]);
  const options = f.queries[0].config.options; assert.equal(options.persistSession, false); assert.deepEqual(options.settingSources, []); assert.deepEqual(options.mcpServers, {}); assert.equal(options.strictMcpConfig, true); assert.equal(options.permissionMode, 'default');
  const spawn = f.commands.at(-1); assert.equal(spawn.config.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts'); assert.equal(spawn.config.env.CLAUDE_AGENT_SDK_VERSION, '0.3.310');
});

test('native sessions resume by official id across restart and receive visible history only on a fresh branch', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn();
  const contextMessages = [{ role: 'user', content: 'EARLY_VISIBLE_TASK' }, { role: 'assistant', content: 'VISIBLE_PROGRESS', providerState: { secret: 'PRIVATE_STATE' } }];
  const first = await f.agent.runTask(task(f, { contextMessages, reasoningEffort: 'high', attachments: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }] }));
  assert.deepEqual(first.usage, { inputTokens: 17, outputTokens: 4 }); assert.equal(first.usageReported, true); assert.equal(f.queries[0].config.options.effort, 'high');
  assert.match(f.queries[0].input.message.content[0].text, /EARLY_VISIBLE_TASK/); assert.doesNotMatch(JSON.stringify(f.queries[0].input), /PRIVATE_STATE/);
  assert.deepEqual(f.queries[0].input.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  const second = await f.agent.runTask(task(f, { prompt: '继续', contextMessages })); assert.equal(second.sessionId, first.sessionId); assert.equal(f.queries[1].config.options.resume, first.sessionId); assert.equal(f.queries[1].input.message.content[0].text, '继续');
  await f.agent.dispose(); const restored = f.create(); assert.equal((await restored.publicState()).session.profileId, signed.session.profileId);
  const third = await restored.runTask(task(f, { prompt: '重启后继续', contextMessages })); assert.equal(third.sessionId, first.sessionId); assert.equal(f.queries[2].config.options.resume, first.sessionId); assert.equal(f.queries[2].input.message.content[0].text, '重启后继续');
  await assert.rejects(restored.runTask(task(f, { cwd: path.dirname(f.dir) })), { code: 'CLAUDE_SESSION_CHANGED' });
  const branch = await restored.runTask(task(f, { localSessionId: 'new-branch', contextMessages })); assert.notEqual(branch.sessionId, first.sessionId); assert.match(f.queries[3].input.message.content[0].text, /EARLY_VISIBLE_TASK/);
});

test('unsupported models and reasoning efforts are rejected before sending a prompt', async t => {
  const f = await fixture(t); await f.agent.signIn();
  await assert.rejects(f.agent.runTask(task(f, { modelId: 'invented-model' })), { code: 'CLAUDE_MODEL_UNAVAILABLE' });
  await assert.rejects(f.agent.runTask(task(f, { reasoningEffort: 'max' })), { code: 'CLAUDE_EFFORT_UNSUPPORTED' });
  await assert.rejects(f.agent.runTask(task(f, { modeId: 'bypassPermissions' })), { code: 'CLAUDE_INVALID_INPUT' });
  assert.equal(f.queries.every(call => call.input === null), true);
});

test('permissions default to denial, accept only the exact allow choice, and never persist permission suggestions', async t => {
  for (const choice of [null, 'invented', 'deny', 'allow']) {
    let response;
    const f = await fixture(t, { onPermission: info => { assert.equal(info.localSessionId, 'local-one'); assert.deepEqual(info.options.map(row => row.optionId), ['allow', 'deny']); return choice; },
      queryHandler: async call => { response = await call.config.options.canUseTool('Bash', { command: 'echo test' }, { toolUseID: 'tool-one', suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash' }] }] }); return [{ type: 'result', subtype: 'success', is_error: false }]; } });
    await f.agent.signIn(); await f.agent.runTask(task(f)); assert.equal(response.behavior, choice === 'allow' ? 'allow' : 'deny'); assert.equal(response.updatedPermissions, undefined);
  }
});

test('official user questions are answered only through explicit user input', async t => {
  let response; const questions = [{ question: '请选择数据库', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }];
  const f = await fixture(t, { onUserInput: info => { assert.deepEqual(info.questions, questions); return { action: 'accept', content: { answers: { '请选择数据库': 'SQLite' } } }; },
    queryHandler: async call => { response = await call.config.options.canUseTool('AskUserQuestion', { questions }, { toolUseID: 'question-one' }); return [{ type: 'result', subtype: 'success', is_error: false }]; } });
  await f.agent.signIn(); await f.agent.runTask(task(f)); assert.deepEqual(response, { behavior: 'allow', updatedInput: { questions, answers: { '请选择数据库': 'SQLite' } } });
});

test('partial messages do not duplicate final text and native tool updates are forwarded', async t => {
  const f = await fixture(t, { queryHandler: async () => [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed-one' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '原生流' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } } },
    { type: 'assistant', message: { id: 'streamed-one', content: [{ type: 'text', text: '原生流' }, { type: 'tool_use', id: 'native-tool', name: 'Write', input: { file_path: 'test.txt' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: 'written' }] } },
    { type: 'result', subtype: 'success', is_error: false }
  ] });
  await f.agent.signIn(); const result = await f.agent.runTask(task(f)); assert.equal(result.usage, null); assert.equal(result.usageReported, false);
  assert.deepEqual(f.events.map(event => event.update.sessionUpdate), ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);
  assert.equal(f.events.filter(event => event.update.sessionUpdate === 'agent_message_chunk').map(event => event.update.content.text).join(''), '原生流');
});

test('Anthropic external turns preserve account-bound native continuation and record official image viewing sources', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
  const f = await fixture(t, { queryHandler: async () => [
    { type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'view-image', name: 'Read', input: { file_path: 'fixture.png' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'view-image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } },
    { type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: '已查看官方图片。' }] } },
    { type: 'result', subtype: 'success', is_error: false }
  ] });
  const signed = await f.agent.signIn(), events = [];
  const attachment = { name: 'current.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,' + png };
  const session = { id: 'anthropic-history', officialAgentMode: 'claude-agent', officialAgentProfileId: signed.session.profileId,
    messages: [{ role: 'user', content: 'PRIOR_VISIBLE_TASK', attachments: [{ data: 'PRIVATE_OLD_IMAGE' }] }, { role: 'assistant', content: 'PRIVATE_INCOMPLETE', localOnly: true }, { role: 'user', content: '查看当前图片' }] };
  const config = { agent: f.agent, provider: 'anthropic', session, cwd: f.dir, prompt: '查看当前图片', modelId: 'official-sonnet', reasoningEffort: 'medium',
    runId: 'anthropic-image-one', attachments: [attachment], emit: event => events.push(event), onPermission: async () => 'allow' };
  await runExternalAgentTurn(config);
  assert.equal(f.queries[0].config.options.effort, 'medium'); assert.match(f.queries[0].input.message.content[0].text, /PRIOR_VISIBLE_TASK/);
  assert.doesNotMatch(f.queries[0].input.message.content[0].text, /PRIVATE_OLD_IMAGE|PRIVATE_INCOMPLETE/);
  assert.deepEqual(f.queries[0].input.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
  const sources = session.imageToolSources, receipt = events.find(event => event.type === 'images-viewed');
  assert.equal(sources.length, 1); assert.equal(sources[0].source, 'image-tool'); assert.equal(sources[0].attachments[0].dataUrl, attachment.dataUrl);
  assert.equal(receipt.images[0].messageId, sources[0].id); assert.doesNotMatch(JSON.stringify(events), new RegExp(png));
  const nativeId = f.queries[0].sessionId; session.messages.push({ role: 'user', content: '原生继续' });
  await runExternalAgentTurn({ ...config, prompt: '原生继续', attachments: [], runId: 'anthropic-image-two' });
  assert.equal(f.queries[1].config.options.resume, nativeId); assert.deepEqual(f.queries[1].input.message.content, [{ type: 'text', text: '原生继续' }]);
});

test('stopping a blocked permission denies late approval and waits for the official process cleanup', async t => {
  const entered = deferred(), answer = deferred(); let response;
  const f = await fixture(t, { onPermission: () => { entered.resolve(); return answer.promise; }, queryHandler: async call => { response = await call.config.options.canUseTool('Bash', { command: 'wait' }, { toolUseID: 'pending-tool' }); return [{ type: 'result', subtype: 'success', is_error: false }]; } });
  await f.agent.signIn(); const running = f.agent.runTask(task(f)); const rejection = assert.rejects(running, { name: 'AbortError' }); await entered.promise;
  await f.agent.stop(); answer.resolve('allow'); await rejection; for (let count = 0; count < 10 && !response; count++) await tick();
  assert.equal(response.behavior, 'deny'); assert.ok(f.queries[0].closed > 0); assert.equal(f.children.every(child => child.exitCode !== null), true);
});

test('withdrawing one official permission request aborts its UI prompt and rejects a late answer', async t => {
  const asked = deferred(), answer = deferred(); let requestSignal, response;
  const f = await fixture(t, { onPermission: info => { requestSignal = info.signal; asked.resolve(); return answer.promise; }, queryHandler: async call => {
    const controller = new AbortController(); const pending = call.config.options.canUseTool('Bash', { command: 'withdrawn' }, { toolUseID: 'withdrawn-tool', signal: controller.signal });
    await asked.promise; controller.abort(); response = await pending; return [{ type: 'result', subtype: 'success', is_error: false }];
  } });
  await f.agent.signIn(); await f.agent.runTask(task(f)); answer.resolve('allow'); assert.equal(requestSignal.aborted, true); assert.equal(response.behavior, 'deny');
});

test('stop cancels a pending official catalog request and closes its subprocess', async t => {
  const entered = deferred(), pending = deferred(); const f = await fixture(t, { supportedModels: () => { entered.resolve(); return pending.promise; } });
  await f.agent.signIn(); const listing = f.agent.listModels(), rejection = assert.rejects(listing, { name: 'AbortError' }); await entered.promise;
  await f.agent.stop(); await rejection; assert.ok(f.queries[0].closed > 0); assert.equal(f.children.every(child => child.exitCode !== null), true); pending.resolve(catalog);
});

test('task timeout stops the official process and reports a timeout rather than success', async t => {
  const pending = deferred(), f = await fixture(t, { requestTimeoutMs: 10, queryHandler: () => pending.promise }); await f.agent.signIn();
  await assert.rejects(f.agent.runTask(task(f)), { code: 'CLAUDE_TIMEOUT' }); assert.equal((await f.agent.publicState()).error.code, 'CLAUDE_TIMEOUT');
  assert.equal(f.children.every(child => child.exitCode !== null), true); pending.resolve([]);
});

test('cancelled login kills its subprocess, removes the new isolated profile, and preserves the prior connection', async t => {
  const pending = deferred(); let hold = false;
  const f = await fixture(t, { commandHandler: ({ args, child }) => { if (args[1] === 'login' && hold) { pending.resolve(child); return true; } return false; } });
  const original = await f.agent.signIn(); hold = true; const signing = f.agent.signIn(); const rejection = assert.rejects(signing, { name: 'AbortError' }); const child = await pending.promise;
  await f.agent.cancelSignIn(); await rejection; assert.ok(child.killed); assert.equal((await f.agent.publicState()).session.profileId, original.session.profileId);
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'claude-agent', 'profiles')), [original.session.profileId]);
});

test('official API-key status cannot masquerade as a Claude account and remote errors remain private', async t => {
  const f = await fixture(t, { commandHandler: ({ args, child }) => { if (args[1] !== 'status') return false; child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKey: 'PRIVATE_TOKEN' })); child.exit(); return true; } });
  await assert.rejects(f.agent.signIn(), { code: 'CLAUDE_AUTH_REQUIRED' }); assert.equal((await f.agent.publicState()).session.profileId, null); assert.doesNotMatch(JSON.stringify(await f.agent.publicState()), /PRIVATE_TOKEN/);
  const other = await fixture(t, { queryHandler: async () => [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['429 usage credits PRIVATE_TOKEN PRIVATE_EMAIL'] }] });
  await other.agent.signIn(); await assert.rejects(other.agent.runTask(task(other)), { code: 'CLAUDE_USAGE_LIMIT' }); assert.doesNotMatch(JSON.stringify(await other.agent.publicState()), /PRIVATE_TOKEN|PRIVATE_EMAIL/);
});

test('corrupt connection metadata fails closed, recovers explicitly, and disconnect removes only its isolated profile', async t => {
  const f = await fixture(t); const signed = await f.agent.signIn(); await f.agent.dispose();
  const filename = path.join(f.dir, 'claude-agent', 'profiles.json'); await fs.writeFile(filename, '{corrupt'); const restored = f.create(); const state = await restored.publicState();
  assert.equal(state.storageRecovery, true); assert.equal(state.session.status, 'reauth_required'); await assert.rejects(restored.runTask(task(f)), { code: 'CLAUDE_AUTH_REQUIRED' });
  await fs.writeFile(filename, JSON.stringify({ version: 1, profileId: signed.session.profileId, sessions: [] })); const recovered = await restored.retryLocalRead(); assert.equal(recovered.session.status, 'connected');
  await restored.disconnect(); assert.equal((await restored.publicState()).session.status, 'disconnected'); assert.deepEqual(await fs.readdir(path.join(f.dir, 'claude-agent', 'profiles')), []);
});

test('the pinned real SDK initializes and streams through a fake CLI process without any network or credentials', { timeout: 15000 }, async t => {
  const wire = [], sessionId = randomUUID();
  const f = await fixture(t, { sdkLoader: () => import('@anthropic-ai/claude-agent-sdk'), commandHandler: ({ args, child }) => {
    if (args[0] === 'auth') return false;
    return false;
  } });
  // Use a second controller with the official SDK and a JSON-lines subprocess
  // fixture. No real executable is launched by this test.
  const official = new ClaudeAgent({ dataDir: f.dir, runtime: f.runtime, startTimeoutMs: 1000, stopGraceMs: 5,
    killTreeImpl: async child => child.kill(), onEvent: event => f.events.push(event),
    spawnImpl: (entry, args, options) => {
      const forbidden = /^(?:ANTHROPIC_.*|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|DISABLE_SANDBOX|DISABLE_ALL_HOOKS|SKIP_PERMISSION_CHECKS|DANGEROUSLY_SKIP_PERMISSIONS)|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/iu;
      assert.equal(Object.keys(options.env).some(key => forbidden.test(key)), false, 'Parent credentials, endpoints and permission overrides cannot reach either official process');
      assert.equal(options.env.CLAUDE_CONFIG_DIR.startsWith(path.join(f.dir, 'claude-agent', 'profiles') + path.sep), true);
      const child = new EventEmitter(); Object.assign(child, { pid: 99101, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
      const send = value => child.stdout.write(JSON.stringify(value) + '\n');
      child.kill = () => { if (child.exitCode !== null) return true; child.killed = true; child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); return true; };
      if (args[0] === 'auth') queueMicrotask(() => { if (args[1] === 'status') child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); child.kill(); });
      else {
        assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts'); assert.equal(options.env.CLAUDE_AGENT_SDK_VERSION, '0.3.310');
        assert.equal(options.shell, false); let buffer = '';
        child.stdin.on('data', chunk => {
          buffer += chunk.toString(); let split;
          while ((split = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
            const message = JSON.parse(line); wire.push(message);
            if (message.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
              response: message.request?.subtype === 'initialize' ? { commands: [], models: catalog, account: {} } : {} } });
            else if (message.type === 'user') {
              send({ type: 'system', subtype: 'init', session_id: sessionId });
              send({ type: 'assistant', session_id: sessionId, message: { id: 'native-sdk-message', content: [{ type: 'text', text: 'SDK原生回复' }] }, parent_tool_use_id: null });
              send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 2 } });
            }
          }
        });
      }
      return child;
    } });
  t.after(() => official.dispose()); await official.signIn(); const rows = await official.listModels(); assert.equal(rows[0].id, 'official-sonnet');
  assert.equal(wire.some(message => message.type === 'user'), false);
  const result = await official.runTask(task(f)); assert.equal(result.sessionId, sessionId); assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2 });
  assert.ok(wire.some(message => message.type === 'control_request' && message.request.subtype === 'initialize'));
  assert.equal(wire.filter(message => message.type === 'user').length, 1);
});

test('hostile parent credentials, endpoints and permission overrides do not enter real SDK subprocess environments', { timeout: 20000 }, () => {
  // Run the real-SDK/JSON-lines fixture in an isolated test host. Only synthetic
  // account variables are supplied; no existing account value is read or copied.
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  Object.assign(env, { ANTHROPIC_API_KEY: 'SYNTHETIC_API_KEY', ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_AUTH', ANTHROPIC_BASE_URL: 'https://synthetic.invalid',
    CLAUDE_CODE_OAUTH_TOKEN: 'SYNTHETIC_OAUTH', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: 'hostile-parent-version',
    CLAUDE_CONFIG_DIR: 'C:/synthetic-parent-account', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_DISABLE_SANDBOX: '1', CLAUDE_CODE_DISABLE_ALL_HOOKS: '1', CLAUDE_CODE_SKIP_PERMISSION_CHECKS: '1',
    CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS: '1', NODE_OPTIONS: '--no-warnings', ELECTRON_RUN_AS_NODE: '1' });
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^the pinned real SDK initializes', fileURLToPath(import.meta.url)],
    { env, cwd: process.cwd(), windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.code);
  assert.match(result.stdout, /# pass 1/u); assert.match(result.stdout, /# fail 0/u);
});
