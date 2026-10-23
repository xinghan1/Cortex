// UI/IPC/agent regressions with loopback replies and virtual child processes.
// A renamed disposable directory models an unavailable project; no drive is
// disconnected and no system process is started or killed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');

module.exports = async function smokeCommandStop({ win, output, dataDir, configureWorkspaceTools }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Command-stop smoke timed out: ' + label);
  };
  const nonce = randomUUID(), fixture = path.join(dataDir, 'command-stop-' + nonce), offline = fixture + '-offline';
  const fakeChildren = [], killers = [], problems = [], requests = [], cases = [];
  const recoveries = new Map();
  let currentCase = '', configured = false, moved = false, restoreWorkspaceTools;
  const log = () => js('window.__commandStopSmoke.events');
  const makeChild = () => {
    const child = new EventEmitter();
    child.pid = 1_500_000_000 + fakeChildren.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.killCalls = 0;
    child.kill = () => { child.killCalls++; return false; };
    child.unref = () => {};
    return child;
  };
  const commandRuntime = { platform: 'win32', stopGraceMs: 100, exitDrainMs: 1000, killFallbackMs: 20,
    killProcess: () => { throw new Error('The virtual child has no operating-system PID'); },
    spawnImpl: (executable, args) => {
      const child = makeChild();
      if (/taskkill(?:\.exe)?$/iu.test(executable)) { killers.push(child); return child; }
      assert.match(path.basename(executable), /^(?:powershell|pwsh)(?:\.exe)?$/iu);
      assert.ok(args.at(-1).includes('COMMAND_STOP_' + nonce), 'Unexpected command entered the virtual process adapter');
      child.scenario = currentCase; fakeChildren.push(child);
      queueMicrotask(() => child.stdout.write('COMMAND_STOP_STARTED ' + currentCase + '\n'));
      return child;
    },
  };
  const answer = (response, outputItems) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'command-stop-response-' + randomUUID(), status: 'completed', output: outputItems,
      usage: { input_tokens: 3, output_tokens: 2 } }));
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer command-stop-fake-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'command-stop-model', supportsTools: true }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 500000); }
      const body = JSON.parse(raw), content = body.input.filter(item => item.role === 'user').at(-1)?.content;
      const prompt = typeof content === 'string' ? content : content.map(part => part.text || '').join('');
      requests.push(prompt);
      assert.equal(body.model, 'command-stop-model');
      if (prompt.startsWith('RECOVER_')) {
        recoveries.set(prompt, () => answer(response, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'COMMAND_STOP_RECOVERED ' + prompt }] }]));
      } else {
        assert.equal(prompt, 'RUN_' + currentCase + '_' + nonce);
        const returned = body.input.find(item => item.type === 'function_call_output');
        if (returned) {
          assert.equal(currentCase, 'auto-exit-open-pipes', 'Stopped command resumed the model');
          const result = JSON.parse(returned.output);
          assert.equal(result.exitCode, 0); assert.equal(result.terminated, null);
          answer(response, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'COMMAND_STOP_EXIT_DRAINED' }] }]);
        } else answer(response, [{ type: 'function_call', call_id: 'call-' + currentCase, name: 'run_command',
          arguments: JSON.stringify({ command: "Write-Output 'COMMAND_STOP_" + nonce + "'", timeout_ms: 60000 }) }]);
      }
    } catch (error) {
      problems.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const clickStop = async () => {
    const point = await until('native stop button', () => js(`(() => {
      const button=document.getElementById('stop-button');
      if(!button||button.hidden||button.disabled)return null;
      const box=button.getBoundingClientRect(),point={x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
      return button.contains(document.elementFromPoint(point.x,point.y))?point:null;
    })()`));
    win.webContents.focus();
    for (const type of ['mouseMove','mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
  };
  const restoredControls = () => until('composer controls restored', () => js(`(() => {
    const input=document.getElementById('task-input'),send=document.getElementById('send-button'),stop=document.getElementById('stop-button');
    return !input.disabled&&!send.hidden&&stop.hidden;
  })()`));
  try {
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, 'fixture.txt'), 'Disposable command-stop fixture.\n');
    restoreWorkspaceTools = await configureWorkspaceTools(Base => class SmokeWorkspaceTools extends Base {
      constructor(root, options) { super(root, { ...options, commandRuntime }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await call('openProject', { path: fixture });
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: 'command-stop-model',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'command-stop-fake-key', reasoningEffort: 'default' });
    configured = true;
    await call('setPermissionMode', { mode: 'full', confirmed: true });
    await js('window.__commandStopSmoke={events:[]};window.__commandStopSmoke.off=window.forge.onEvent(event=>window.__commandStopSmoke.events.push(event));true');
    for (const scenario of ['unresponsive-kill', 'exit-open-pipes', 'unavailable-project']) {
      currentCase = scenario;
      await call('newSession');
      const start = await call('runTask', { text: 'RUN_' + scenario + '_' + nonce });
      const child = await until('virtual command begins ' + scenario, () => fakeChildren.find(value => value.scenario === scenario));
      await until('command output reaches UI', async () => (await log()).some(event => event.type === 'command-output' && event.text.includes('COMMAND_STOP_STARTED')));
      if (scenario === 'exit-open-pipes') { child.exitCode = 0; child.emit('exit', 0, null); }
      if (scenario === 'unavailable-project') { await fs.rename(fixture, offline); moved = true; }
      const stoppedAt = Date.now(); await clickStop();
      const ended = await until('run stopped ' + scenario, async () => {
        const state = await call('getState');
        return !state.activeTask.running && (await log()).find(event => event.type === 'run-end' && event.runId === start.runId);
      });
      assert.equal(ended.status, 'stopped');
      const elapsedMs = Date.now() - stoppedAt;
      assert.ok(elapsedMs < 6000, 'Stop depended on the original command timeout');
      await restoredControls();
      const oldSession = (await call('getState')).sessionId;
      await call('newSession');
      assert.notEqual((await call('getState')).sessionId, oldSession, 'Stopped command blocked a new session');
      if (moved) { await fs.rename(offline, fixture); moved = false; }
      const prompt = 'RECOVER_' + scenario + '_' + nonce;
      const next = await call('runTask', { text: prompt });
      await until('fresh task request', () => recoveries.has(prompt));
      child.stdout.emit('data', Buffer.from('LATE_OLD_COMMAND_' + scenario));
      child.stderr.emit('data', Buffer.from('LATE_OLD_COMMAND_STDERR'));
      child.emit('close', 0, null);
      await wait(100);
      assert.equal((await call('getState')).activeTask.running, true, 'Late old close ended the new task');
      assert.equal(await js("document.getElementById('messages').textContent.includes('LATE_OLD_COMMAND')"), false);
      assert.equal((await log()).some(event => event.type === 'command-output' && event.text.includes('LATE_OLD_COMMAND')), false);
      assert.equal((await log()).filter(event => event.type === 'run-end' && event.runId === start.runId).length, 1);
      recoveries.get(prompt)(); recoveries.delete(prompt);
      const recovered = await until('fresh task completes', async () => !(await call('getState')).activeTask.running
        && (await log()).find(event => event.type === 'run-end' && event.runId === next.runId));
      assert.equal(recovered.status, 'completed'); await restoredControls();
      cases.push({ scenario, stopMilliseconds: elapsedMs, newSession: true, newTaskCompleted: true, lateOutputIgnored: true });
    }
    currentCase = 'auto-exit-open-pipes';
    await call('newSession');
    const autoRun = await call('runTask', { text: 'RUN_' + currentCase + '_' + nonce });
    const autoChild = await until('virtual command auto-exit', () => fakeChildren.find(child => child.scenario === currentCase));
    const exitedAt = Date.now(); autoChild.exitCode = 0; autoChild.emit('exit', 0, null);
    const automatic = await until('exit finishes without stop or close', async () => !(await call('getState')).activeTask.running
      && (await log()).find(event => event.type === 'run-end' && event.runId === autoRun.runId));
    assert.equal(automatic.status, 'completed');
    assert.ok(Date.now() - exitedAt < 6000);
    await restoredControls();
    cases.push({ scenario: currentCase, automaticallyCompleted: true, exitCode: 0 });

    currentCase = 'terminal-stop';
    const stoppedTerminal = await call('runTerminal', { command: "Write-Output 'COMMAND_STOP_" + nonce + "'", timeoutMs: 60000 });
    const terminalChild = await until('virtual terminal begins', () => fakeChildren.find(child => child.scenario === currentCase));
    await until('terminal running', async () => (await call('getState')).activeTask.running);
    const terminalStoppedAt = Date.now(); await call('stopTerminal');
    const terminalEnd = await until('unresponsive terminal stopped', async () => !(await call('getState')).activeTask.running
      && (await log()).find(event => event.type === 'terminal-end' && event.id === stoppedTerminal.id));
    assert.equal(terminalEnd.status, 'stopped'); assert.ok(Date.now() - terminalStoppedAt < 6000);
    await call('newSession');
    currentCase = 'terminal-recovered';
    const nextTerminal = await call('runTerminal', { command: "Write-Output 'COMMAND_STOP_" + nonce + "'", timeoutMs: 60000 });
    const nextChild = await until('fresh terminal begins', () => fakeChildren.find(child => child.scenario === currentCase));
    terminalChild.stdout.emit('data', Buffer.from('LATE_OLD_TERMINAL'));
    terminalChild.emit('close', 0, null);
    await wait(100);
    assert.equal((await call('getState')).activeTask.running, true);
    assert.equal((await log()).some(event => event.type === 'terminal-output' && event.text.includes('LATE_OLD_TERMINAL')), false);
    nextChild.stdout.end('TERMINAL_RECOVERED\n'); nextChild.stderr.end();
    nextChild.exitCode = 0; nextChild.emit('exit', 0, null); nextChild.emit('close', 0, null);
    const terminalRecovered = await until('fresh terminal completes', async () => !(await call('getState')).activeTask.running
      && (await log()).find(event => event.type === 'terminal-end' && event.id === nextTerminal.id));
    assert.equal(terminalRecovered.status, 'completed');
    cases.push({ scenario: 'terminal-stop', stopped: true, newSession: true, nextCommandCompleted: true, lateOutputIgnored: true });
    assert.deepEqual(problems, []);
    win.webContents.invalidate(); await wait(150);
    await fs.writeFile(path.join(output, 'command-stop-recovered.png'), (await win.webContents.capturePage()).toPNG());
    return { status: 'completed', actualProcessSpawns: 0, actualProcessKills: 0, realApi: false,
      realDriveDisconnects: 0, virtualCommands: fakeChildren.length, virtualKillers: killers.length, modelRequests: requests.length, cases };
  } catch (error) {
    console.error('COMMAND_STOP_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, stack: error.stack,
      currentCase, commands: fakeChildren.map(child => ({ scenario: child.scenario, killCalls: child.killCalls })), problems, requests: requests.length }));
    throw error;
  } finally {
    if (moved) await fs.rename(offline, fixture).catch(() => {});
    for (const release of recoveries.values()) release();
    if (!win.isDestroyed()) {
      await call('stopTask').catch(() => {});
      if (configured) await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: '', baseUrl: 'https://api.openai.com/v1', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
      await js('window.__commandStopSmoke?.off?.()').catch(() => {});
    }
    for (const child of [...fakeChildren, ...killers]) { child.stdout.destroy(); child.stderr.destroy(); }
    await restoreWorkspaceTools?.();
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  }
};
