// Actual provider HTTP attempts, workspace reads and native cancellation,
// confined to a disposable project and loopback server. No external API runs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeReconnect({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.ok(Array.isArray(store?.usage?.records), 'Reconnect smoke requires the actual isolated usage ledger');
  const nonce = randomUUID(), project = path.join(dataDir, 'reconnect-' + nonce);
  const model = 'smoke-reconnect-model', apiKey = 'isolated-reconnect-key-' + nonce;
  const prompts = Object.fromEntries(['recover', 'unauthorized', 'exhausted', 'stop'].map(scene => [scene, 'RECONNECT_' + scene.toUpperCase() + '_' + nonce]));
  const fixture = 'Real isolated workspace contents ' + nonce + '\n';
  const toolNotice = '连接恢复，正在读取本地文件。', partial = '这段未完成的临时输出会被新请求替换。';
  const final = '重连成功，文件只读取一次。';
  const requests = [], problems = [], runIds = new Map(), sessionIds = new Map(), screenshots = [];
  let child, configured = false, stage = 'isolated reconnect setup';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => child.webContents.executeJavaScript(code);
  const invoke = (name, value) => `window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (name, value) => js(invoke(name, value));
  const parentCall = (name, value) => win.webContents.executeJavaScript(invoke(name, value));
  const original = await parentCall('getState');
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace an existing provider credential');
  const initialLedger = store.usage.records.length;
  const until = async (label, predicate, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(20); }
    throw new Error('Reconnect smoke timed out: ' + label + (problems.length ? '; server: ' + problems.join(' | ') : ''));
  };
  const state = () => call('getState');
  const events = () => js('window.__reconnectSmoke.events');
  const sceneEvents = async scene => (await events()).filter(event => event.runId === runIds.get(scene));
  const forScene = scene => requests.filter(record => record.scene === scene);
  const ui = () => js(`(() => ({
    runStatus:$('run-status').textContent,stopHidden:$('stop-button').hidden,stopDisabled:$('stop-button').disabled,
    phases:[...document.querySelectorAll('.task-activity')].map(node=>({runId:node.dataset.runId,phase:node.dataset.phase,reconnect:node.dataset.reconnect||null,
      text:node.querySelector('.task-activity-phase')?.textContent,title:node.querySelector('.task-activity-phase')?.title})),
    assistant:[...document.querySelectorAll('.message.assistant .message-body')].map(node=>node.textContent),
    toolCards:document.querySelectorAll('.tool-card').length,
    nativeStopClicks:window.__reconnectSmoke.nativeStopClicks,
    liveEvents:appState?.activeTask?.liveEvents||[]
  }))()`);
  const click = async selector => {
    const point = await until('uncovered native ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
      node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return node.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    child.focus(); child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await wait(35);
  };
  const capture = async name => {
    child.webContents.invalidate(); await wait(150); const image = await child.webContents.capturePage();
    assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(output, name), image.toPNG()); screenshots.push(name);
  };
  const textOf = message => typeof message?.content === 'string' ? message.content
    : (message?.content || []).filter(part => part.type === 'input_text').map(part => part.text).join('\n');
  const answer = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const finish = (record, items, inputTokens = 7, outputTokens = 3) => {
    assert.ok(record && !record.released && !record.response.destroyed);
    record.released = true; record.inputTokens = inputTokens; record.outputTokens = outputTokens;
    record.response.writeHead(200, { 'Content-Type': 'application/json' });
    record.response.end(JSON.stringify({ id: 'reconnect-response-' + requests.indexOf(record), status: 'completed', output: items,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens } }));
  };
  const reject = (record, status, retryAfter) => {
    record.httpStatus = status; record.released = true;
    record.response.writeHead(status, { 'Content-Type': 'application/json', ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }) });
    record.response.end(JSON.stringify({ error: { message: status === 401 ? 'Fixture authentication rejected' : 'Fixture temporarily unavailable',
      code: status === 401 ? 'invalid_api_key' : 'fixture_unavailable' } }));
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model, supportsTools: true, reasoningEfforts: [], context_window: 128000 }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1000000); }
      const body = JSON.parse(raw), user = body.input.findLast(item => item.role === 'user');
      const scene = Object.keys(prompts).find(key => textOf(user) === prompts[key]); assert.ok(scene, 'Unknown reconnect scenario');
      assert.equal(body.model, model);
      const ordinal = forScene(scene).length + 1;
      const record = { scene, ordinal, body, raw, response, released: false, connectionReset: false, receivedAt: Date.now() };
      requests.push(record);
      response.once('close', () => { record.closed = true; });
      if (scene === 'unauthorized') { assert.equal(ordinal, 1, '401 must not be retried'); reject(record, 401); return; }
      if (scene === 'exhausted') { assert.ok(ordinal <= 6, 'Reconnect must stop after five retries'); reject(record, 503, 0); return; }
      if (scene === 'stop') { assert.equal(ordinal, 1, 'Stop must cancel the waiting timer before another POST'); reject(record, 503, 30); return; }
      if (ordinal === 1) { reject(record, 503, 1); return; }
      if (ordinal === 2) {
        // Chromium may silently resend a POST when a reused socket resets
        // before response headers. Flush headers first so this real reset is
        // observable by the adapter, rather than a hidden transport resend.
        record.connectionReset = true;
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.flushHeaders(); setTimeout(() => response.destroy(), 80); return;
      }
      if (ordinal === 3) {
        finish(record, [answer(toolNotice), { type: 'function_call', call_id: 'reconnect-read-once', name: 'read_file', arguments: JSON.stringify({ path: 'input.txt' }) }]); return;
      }
      assert.ok(ordinal === 4 || ordinal === 5, 'Unexpected duplicated continuation');
      const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'reconnect-read-once');
      assert.ok(result); assert.equal(JSON.parse(result.output).content, fixture);
      assert.equal(body.input.filter(item => item.type === 'function_call_output' && item.call_id === 'reconnect-read-once').length, 1);
      if (ordinal === 4) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: partial, output_index: 0 }) + '\n\n'); return;
      }
      // The smoke holds the final attempt until it inspects the reset UI.
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Reconnect fixture failed' } })); }
    }
  });
  const submit = async scene => {
    const previous = (await state()).sessionId;
    await js('newSession()'); await until('fresh reconnect session', async () => (await state()).sessionId !== previous && !(await state()).activeTask.running);
    sessionIds.set(scene, (await state()).sessionId);
    await call('submitPrompt', { text: prompts[scene], mode: 'queue' });
    const boundary = await until('run boundary ' + scene, async () => (await events()).find(event => event.type === 'user-message' && event.text === prompts[scene]));
    runIds.set(scene, boundary.runId);
    await until('first real POST ' + scene, () => forScene(scene)[0]);
  };
  const ended = (scene, expected) => until('run end ' + scene, async () => {
    const end = (await sceneEvents(scene)).find(event => event.type === 'run-end');
    if (end) assert.equal(end.status, expected, end.error || scene);
    return end && !(await state()).activeTask.running && end;
  });
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'input.txt'), fixture);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await parentCall('newWindow')).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('reconnect child initialized', () => js('Boolean(appState&&window.forge&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`window.__reconnectSmoke={events:[],nativeStopClicks:0};window.forge.onEvent(event=>window.__reconnectSmoke.events.push(event));
      $('stop-button').addEventListener('click',event=>{if(event.isTrusted)window.__reconnectSmoke.nativeStopClicks++;});true`);
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated reconnect project active', async () => (await state()).workspace?.root === project && await js('!projectSwitching'));
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', model,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, reasoningEffort: 'default' }); configured = true;
    await call('listModels', { force: true });

    stage = '503 and connection reset recover without repeating the real tool';
    await submit('recover');
    const waiting = await until('visible reconnect countdown', async () => {
      const value = await ui(); return value.phases.some(phase => phase.runId === runIds.get('recover') && phase.phase === 'reconnecting' && phase.reconnect === 'waiting' && /正在重连 1\/5/.test(phase.text)) && value;
    });
    assert.match(waiting.runStatus, /正在重连/); assert.equal(waiting.stopDisabled, false);
    await capture('reconnect-waiting.png');
    const partialAttempt = await until('tool continuation streams partial text', () => forScene('recover').find(record => record.ordinal === 4));
    await until('failed attempt partial really painted', async () => (await ui()).assistant.some(text => text.includes(partial)));
    assert.equal((await sceneEvents('recover')).filter(event => event.type === 'tool-start').length, 1);
    partialAttempt.connectionReset = true; partialAttempt.response.destroy();
    await until('partial attempt clears before re-request', async () => {
      const value = await ui(); return !value.assistant.some(text => text.includes(partial))
        && value.assistant.filter(text => text === toolNotice).length === 1
        && (await sceneEvents('recover')).some(event => event.type === 'reconnect' && event.status === 'waiting' && event.resetText === true && event.reason === 'connection');
    });
    const finalAttempt = await until('fresh final transport request', () => forScene('recover').find(record => record.ordinal === 5));
    assert.equal((await ui()).toolCards, 1); assert.equal((await sceneEvents('recover')).filter(event => event.type === 'tool-start').length, 1);
    assert.equal(forScene('recover')[0].raw, forScene('recover')[1].raw); assert.equal(forScene('recover')[1].raw, forScene('recover')[2].raw);
    assert.equal(partialAttempt.raw, finalAttempt.raw, 'Interrupted reply must restart its unchanged request, without phantom local history');
    finish(finalAttempt, [answer(final)]); await ended('recover', 'completed');
    const recoveredEvents = await sceneEvents('recover'), recoveredSession = await call('getCurrentSession');
    assert.equal(recoveredEvents.filter(event => event.type === 'reconnect' && event.status === 'recovered').length, 2);
    assert.equal(recoveredEvents.filter(event => event.type === 'tool-start').length, 1);
    assert.equal(recoveredEvents.filter(event => event.type === 'tool-result').length, 1);
    assert.deepEqual(recoveredSession.messages.filter(message => message.role === 'assistant').map(message => message.content), [toolNotice, final]);
    assert.equal(JSON.stringify(recoveredSession.messages).includes(partial), false);
    assert.equal((await ui()).assistant.filter(text => text === toolNotice).length, 1);
    assert.equal((await ui()).assistant.filter(text => text === final).length, 1);
    assert.equal(await fs.readFile(path.join(project, 'input.txt'), 'utf8'), fixture);
    await capture('reconnect-recovered.png');
    await js(`loadSession(${JSON.stringify(recoveredSession.id)})`);
    await until('recovered history restores one final answer', async () => (await ui()).assistant.filter(text => text === final).length === 1);
    assert.equal(JSON.stringify((await call('getCurrentSession')).messages).includes(partial), false);
    assert.equal(forScene('recover').length, 5, 'History redraw must not re-run requests');

    stage = 'authentication failure is terminal without reconnecting';
    await submit('unauthorized'); await ended('unauthorized', 'failed');
    assert.equal(forScene('unauthorized').length, 1);
    assert.equal((await sceneEvents('unauthorized')).filter(event => event.type === 'reconnect').length, 0);

    stage = 'five retries exhaust at six real POSTs';
    await submit('exhausted'); await ended('exhausted', 'failed');
    const exhaustedEvents = await sceneEvents('exhausted');
    assert.equal(forScene('exhausted').length, 6);
    assert.deepEqual(exhaustedEvents.filter(event => event.type === 'reconnect' && event.status === 'waiting').map(event => event.attempt), [1, 2, 3, 4, 5]);
    assert.equal(exhaustedEvents.filter(event => event.type === 'reconnect' && event.status === 'failed').length, 1);
    assert.equal((await ui()).phases.some(phase => phase.reconnect), false);
    await capture('reconnect-exhausted.png');

    stage = 'native Stop cancels a long Retry-After wait immediately';
    await submit('stop');
    const stopping = await until('visible thirty-second reconnect wait', async () => {
      const value = await ui(); return value.phases.some(phase => phase.reconnect === 'waiting' && /正在重连 1\/5/.test(phase.text)) && value;
    });
    assert.equal((await sceneEvents('stop')).find(event => event.type === 'reconnect' && event.status === 'waiting').delayMs, 30000);
    assert.equal(stopping.stopDisabled, false); await capture('reconnect-stop-wait.png');
    const stoppedAt = Date.now(); await click('#stop-button'); await ended('stop', 'stopped');
    assert.ok(Date.now() - stoppedAt < 2000, 'Stop must cancel the thirty-second backoff promptly');
    assert.equal((await ui()).nativeStopClicks, 1); assert.equal((await ui()).phases.some(phase => phase.reconnect), false);
    await wait(150); assert.equal(forScene('stop').length, 1); assert.equal((await state()).pendingApprovals.length, 0);

    stage = 'actual transport attempts have exactly one ledger entry each';
    assert.equal(requests.length, 13); assert.deepEqual(problems, []);
    const ownedRuns = new Set(runIds.values());
    await until('all attempt ledgers committed', () => store.usage.records.slice(initialLedger).filter(record => ownedRuns.has(record.runId)).length === requests.length);
    const ledger = store.usage.records.slice(initialLedger).filter(record => ownedRuns.has(record.runId));
    assert.equal(new Set(ledger.map(record => record.id)).size, 13);
    assert.equal(ledger.filter(record => record.reported).length, 2);
    assert.equal(ledger.filter(record => record.status === 'completed').length, 2);
    assert.equal(ledger.filter(record => record.status === 'failed').length, 11);
    assert.equal(ledger.filter(record => record.status === 'stopped').length, 0, 'Cancelling between attempts must not invent an untransmitted attempt');
    for (const record of ledger) {
      assert.equal(record.provider, 'openai'); assert.equal(record.model, model);
      const scene = Object.keys(prompts).find(name => runIds.get(name) === record.runId);
      assert.equal(record.sessionId, sessionIds.get(scene), 'Each attempt belongs to its actual session and task');
      if (record.reported) { assert.equal(record.inputTokens, 7); assert.equal(record.outputTokens, 3); }
      else { assert.equal(record.inputTokens, null); assert.equal(record.outputTokens, null); }
    }
    for (const scene of Object.keys(prompts)) assert.equal(ledger.filter(record => record.runId === runIds.get(scene)).length, forScene(scene).length);
    const reconnectEvents = (await events()).filter(event => event.type === 'reconnect');
    assert.equal(JSON.stringify(reconnectEvents).includes(apiKey), false);
    assert.ok(reconnectEvents.every(event => !event.reason || ['connection', 'timeout', 'service', 'not-retryable', 'retry-limit', 'retry-after'].includes(event.reason)));
    assert.ok(reconnectEvents.filter(event => event.status === 'waiting').every(event => event.resetText === true && Number.isFinite(event.retryAt)));
    const result = { status: 'completed', version: require('../../package.json').version, realExternalApi: false, realCommands: false,
      actualLoopbackPosts: requests.length, recovered503AndConnectionReset: true, streamedPartialRestartsWithoutDuplication: true,
      previouslyCompletedAssistantAndToolPreserved: true, oneActualWorkspaceRead: true, recoveredHistoryDoesNotReplay: true,
      visibleReconnectProgressAndCountdown: true, authenticationFailureNotRetried: true, fiveRetriesBoundedToSixAttempts: true,
      nativeStopCancelsRetryAfter: true, everyTransportAttemptRecordedExactlyOnce: true, realReportedTokens: 20,
      failedAttemptTokenCountsRemainUnknown: true, stopBetweenRequestsHasNoPhantomLedger: true,
      requests: requests.map(({ scene, ordinal, httpStatus, connectionReset, inputTokens, outputTokens }) => ({ scene, ordinal, httpStatus, connectionReset, inputTokens, outputTokens })),
      reconnectEvents, ledger, screenshots };
    await fs.writeFile(path.join(output, 'reconnect-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, problems,
      requests: requests.map(({ scene, ordinal, httpStatus, connectionReset, released, closed }) => ({ scene, ordinal, httpStatus, connectionReset, released, closed })),
      ledger: store.usage.records.slice(initialLedger).filter(record => [...runIds.values()].includes(record.runId)) };
    if (child && !child.isDestroyed()) try { failure.ui = await ui(); failure.events = await events(); await capture('reconnect-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; }
    await fs.writeFile(path.join(output, 'reconnect-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n'); throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      await call('stopTask').catch(() => {}); child.close(); await until('reconnect fixture window closes', () => child.isDestroyed()).catch(() => child.destroy());
    }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previous = original.settings.providers.openai;
      await parentCall('saveSettings', { provider: 'openai', model: previous.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol,
        reasoningEffort: previous.reasoningEffort, authMode: previous.authMode, clearKey: true });
      const selected = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: selected.baseUrl,
        apiProtocol: selected.apiProtocol, authMode: selected.authMode, reasoningEffort: original.settings.reasoningEffort });
    }
  }
};
