// Real provider attempts and persisted per-round badges, confined to loopback
// and disposable offscreen windows. No external model or user data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeRoundUsage({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.ok(Array.isArray(store?.usage?.records), 'Round usage requires the isolated real ledger');
  const nonce = randomUUID(), project = path.join(dataDir, 'round-usage-' + nonce), second = path.join(dataDir, 'round-other-' + nonce);
  const model = 'round-usage-fixture', apiKey = 'isolated-round-usage-' + nonce;
  const scenes = ['reported', 'zero', 'partial', 'missing', 'failed', 'fork'];
  const prompts = Object.fromEntries(scenes.map(scene => [scene, 'ROUND_USAGE_' + scene.toUpperCase() + '_' + nonce]));
  const expected = {
    reported: { label: '用量 350 tok', status: 'reported', inputTokens: 300, outputTokens: 50, totalTokens: 350, requests: 2, reportedRequests: 2, unreportedRequests: 0, partialRequests: 0 },
    zero: { label: '用量 0 tok', status: 'reported', inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 1, reportedRequests: 1, unreportedRequests: 0, partialRequests: 0 },
    partial: { label: '用量 55 tok*', status: 'partial', inputTokens: 50, outputTokens: 5, totalTokens: 55, requests: 2, reportedRequests: 1, unreportedRequests: 1, partialRequests: 0 },
    missing: { label: '用量 未回报', status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null, requests: 1, reportedRequests: 0, unreportedRequests: 1, partialRequests: 0 },
    failed: { label: '用量 未回报', status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null, requests: 1, reportedRequests: 0, unreportedRequests: 1, partialRequests: 1 },
    fork: { label: '用量 5 tok', status: 'reported', inputTokens: 3, outputTokens: 2, totalTokens: 5, requests: 1, reportedRequests: 1, unreportedRequests: 0, partialRequests: 0 },
  };
  const requests = [], errors = [], runs = new Map(), screenshots = [];
  let child, configured = false, originalSession, forkSession, stage = 'isolated round usage setup';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bounded = async (promise, label, timeout = 20000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Round usage timed out: ' + label)), timeout); })]); }
    finally { clearTimeout(timer); }
  };
  const js = code => bounded(child.webContents.executeJavaScript(code), 'renderer operation');
  const invoke = (name, value) => `window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (name, value) => js(invoke(name, value));
  const parentCall = (name, value) => bounded(win.webContents.executeJavaScript(invoke(name, value)), 'parent IPC');
  const original = await parentCall('getState');
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace an existing credential');
  const until = async (label, predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const value = await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now())); if (value) return value; await wait(25); }
    throw new Error('Round usage timed out: ' + label + (errors.length ? '; fixture: ' + errors.join(' | ') : ''));
  };
  const badges = () => js(`Array.from(document.querySelectorAll('#messages > .round-token-usage')).map(n=>({runId:n.dataset.runId,status:n.dataset.status,text:n.querySelector('.round-token-usage-text')?.textContent,title:n.title,insideActivity:!!n.closest('.task-activity')}))`);
  const events = () => js('window.__roundUsageSmoke.events');
  const capture = async filename => {
    child.webContents.invalidate(); await wait(160);
    const image = await bounded(child.webContents.capturePage(), 'capture ' + filename, 10000); assert.equal(image.isEmpty(), false);
    await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename);
  };
  const initialize = async () => {
    await until('renderer initialized', () => js('Boolean(appState&&window.forge&&!projectSwitching)'));
    await js('window.__roundUsageSmoke={events:[]};window.forge.onEvent(e=>window.__roundUsageSmoke.events.push(e));true');
  };
  const textOf = item => typeof item?.content === 'string' ? item.content : (item?.content || []).filter(part => part.type === 'input_text').map(part => part.text).join('\n');
  const answer = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model, supportsTools: true, reasoningEfforts: [], context_window: 128000 }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1000000); }
      const body = JSON.parse(raw), scene = scenes.find(key => textOf(body.input.findLast(item => item.role === 'user')) === prompts[key]);
      assert.ok(scene, 'Unknown round usage prompt'); assert.equal(body.model, model);
      const ordinal = requests.filter(item => item.scene === scene).length + 1;
      requests.push({ scene, ordinal });
      if (scene === 'failed') {
        assert.equal(ordinal, 1, 'Authentication errors are not retried');
        response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Round fixture authentication failure', code: 'invalid_api_key' } })); return;
      }
      let outputItems = [answer('ROUND_FINAL_' + scene)], usage;
      if (scene === 'reported' && ordinal === 1) {
        outputItems = [answer('读取本机测试文件。'), { type: 'function_call', call_id: 'round-read-once', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) }];
        usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 7 } };
      } else if (scene === 'reported') {
        assert.equal(ordinal, 2); assert.ok(body.input.some(item => item.type === 'function_call_output' && item.call_id === 'round-read-once'));
        usage = { input_tokens: 200, output_tokens: 30, input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 11 } };
      } else if (scene === 'partial' && ordinal === 1) {
        outputItems = [{ type: 'function_call', call_id: 'round-unreported-read', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) }];
      } else if (scene === 'partial') { assert.equal(ordinal, 2); usage = { input_tokens: 50, output_tokens: 5 }; }
      else if (scene === 'zero') { assert.equal(ordinal, 1); usage = { input_tokens: 0, output_tokens: 0 }; }
      else if (scene === 'fork') { assert.equal(ordinal, 1); usage = { input_tokens: 3, output_tokens: 2 }; }
      else assert.equal(ordinal, 1);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'round-response-' + requests.length, status: 'completed', output: outputItems, ...(usage ? { usage } : {}) }));
    } catch (error) {
      errors.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Round usage fixture failed' } })); }
    }
  });
  const verifySummary = (usage, scene) => {
    assert.ok(usage, scene + ' must retain an exact usage summary'); assert.equal(usage.version, 1);
    for (const [key, value] of Object.entries(expected[scene])) if (key !== 'label') assert.equal(usage[key], value, scene + ' ' + key);
  };
  const verifyBadges = async sceneList => {
    const result = await until('all completed round badges', async () => {
      const value = await badges(); return value.length === sceneList.length && value;
    });
    assert.equal(new Set(result.map(item => item.runId)).size, result.length, 'No duplicate badges');
    assert.deepEqual(result.map(item => item.runId), sceneList.map(scene => runs.get(scene)), 'Badges follow their round boundaries');
    for (const scene of sceneList) {
      const badge = result.find(item => item.runId === runs.get(scene));
      assert.equal(badge.text, expected[scene].label, scene); assert.equal(badge.status, expected[scene].status, scene);
      assert.equal(badge.insideActivity, false, 'Usage remains visible when activity is collapsed');
    }
    assert.match(result.find(item => item.runId === runs.get('reported'))?.title || '', /300/u);
    return result;
  };
  const submit = async scene => {
    await call('submitPrompt', { text: prompts[scene], mode: 'queue' });
    const boundary = await until('run boundary ' + scene, async () => (await events()).find(event => event.type === 'user-message' && event.text === prompts[scene]));
    runs.set(scene, boundary.runId);
    const ended = await until('completed round ' + scene, async () => {
      const event = (await events()).find(item => item.type === 'run-end' && item.runId === boundary.runId);
      return event && !(await call('getState')).activeTask.running && event;
    });
    assert.equal(ended.status, scene === 'failed' ? 'failed' : 'completed', ended.error || scene); verifySummary(ended.usage, scene);
    const session = await call('getCurrentSession'); verifySummary(session.taskRuns.find(item => item.runId === boundary.runId)?.usage, scene); return session;
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(second, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'fixture.txt'), 'ISOLATED_ROUND_FIXTURE\n');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await parentCall('newWindow')).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); await initialize();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project selected', async () => (await call('getState')).workspace.root === project && await js('!projectSwitching'));
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, reasoningEffort: 'default' }); configured = true;
    await call('listModels', { force: true });

    stage = 'separate real task totals including tool-loop requests, zero, partial, missing and failed';
    for (const scene of scenes.filter(scene => scene !== 'fork')) originalSession = await submit(scene);
    const originalScenes = scenes.filter(scene => scene !== 'fork');
    await verifyBadges(originalScenes); await capture('round-usage-live.png');
    const originalId = originalSession.id, originalRuns = originalSession.taskRuns;
    const ledger = store.usage.records.filter(record => record.sessionId === originalId && [...runs.values()].includes(record.runId));
    assert.equal(ledger.length, 7); assert.equal(new Set(ledger.map(record => record.id)).size, 7);
    assert.equal(ledger.filter(record => record.runId === runs.get('reported')).reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0), 350, 'Cached and thinking subsets are not counted again');
    assert.deepEqual(errors, []);

    stage = 'same run-end redraw deduplication and exclusion of demo or manual undo';
    const duplicate = (await events()).find(event => event.type === 'run-end' && event.runId === runs.get('reported'));
    await js(`renderRoundTokenUsage(${JSON.stringify(duplicate)});renderRoundTokenUsage({...${JSON.stringify(duplicate)},runId:'smoke-demo-ignored',demo:true});renderRoundTokenUsage({...${JSON.stringify(duplicate)},runId:'smoke-undo-ignored',kind:'undo'});true`);
    await verifyBadges(originalScenes);

    stage = 'reload and history selection preserve exact per-round stats without requests';
    const postsBeforeReload = requests.length;
    const loaded = new Promise((resolve, reject) => { child.webContents.once('did-finish-load', resolve); child.webContents.once('render-process-gone', (_, info) => reject(new Error('Renderer exited: ' + info.reason))); });
    child.webContents.reload(); await bounded(loaded, 'reload'); await initialize();
    await until('previous session restored', async () => (await call('getState')).sessionId === originalId);
    await verifyBadges(originalScenes);
    await js(`loadSession(${JSON.stringify(originalId)})`); await until('history no longer loading', () => js('!projectSwitching'));
    await verifyBadges(originalScenes); assert.equal(requests.length, postsBeforeReload);
    const restored = await call('getCurrentSession');
    for (const scene of originalScenes) verifySummary(restored.taskRuns.find(item => item.runId === runs.get(scene))?.usage, scene);

    stage = 'project boundaries do not leak badges and selected history forks retain prior round totals';
    await js(`openRecentProject({path:${JSON.stringify(second)}})`);
    await until('other project has no previous usage', async () => (await call('getState')).workspace.root === second && await js('!projectSwitching'));
    assert.deepEqual(await badges(), []);
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('original project returns', async () => (await call('getState')).workspace.root === project && await js('!projectSwitching'));
    await js(`loadSession(${JSON.stringify(originalId)})`); await verifyBadges(originalScenes);
    forkSession = await submit('fork'); assert.notEqual(forkSession.id, originalId, 'Sending from loaded history creates an independent session');
    await verifyBadges(scenes);
    for (const scene of originalScenes) verifySummary(forkSession.taskRuns.find(item => item.runId === runs.get(scene))?.usage, scene);
    const retained = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', originalId + '.json'), 'utf8'));
    assert.deepEqual(retained.taskRuns, originalRuns, 'Continuing history must not rewrite the original rounds');
    assert.equal(await fs.readFile(path.join(project, 'fixture.txt'), 'utf8'), 'ISOLATED_ROUND_FIXTURE\n');

    stage = 'four appearance materials retain visible compact usage';
    for (const style of ['glass', 'black', 'white', 'industrial']) {
      await call('setAppearance', { uiStyle: style }); await js('window.synoraAppearance.settled()'); await verifyBadges(scenes);
      const appearance = await js(`Array.from(document.querySelectorAll('#messages > .round-token-usage')).every(n=>{const s=getComputedStyle(n);return s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0&&s.fontSize!=='0px';})`);
      assert.equal(appearance, true, style); if (style === 'white' || style === 'industrial') await capture('round-usage-' + style + '.png');
    }
    const result = { status: 'completed', version: require('../../package.json').version, realExternalApi: false, realCommands: false,
      actualLoopbackPosts: requests.length, exactIndependentRoundTotals: true, toolLoopIncluded: true, cacheAndThinkingNotDoubleCounted: true,
      zeroIsRealReportedZero: true, partialAndUnavailableDistinguished: true, failedRoundHasUnavailableBadge: true,
      reloadAndHistoryPreserved: true, noDuplicateBadge: true, demoAndManualUndoExcluded: true, crossProjectIsolation: true,
      forkRetainsHistoricalTotals: true, originalHistoryUnchanged: true, fourMaterialsVisible: true,
      originalSessionId: originalId, forkSessionId: forkSession.id, runs: Object.fromEntries(runs), requests, badges: await badges(), screenshots };
    await fs.writeFile(path.join(output, 'round-usage-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const result = { status: 'failed', stage, error: error.message, stack: error.stack, errors, requests, runs: Object.fromEntries(runs) };
    if (child && !child.isDestroyed()) try { result.badges = await badges(); result.events = await events(); result.session = await call('getCurrentSession'); await capture('round-usage-failure.png'); } catch (diagnostic) { result.diagnosticError = diagnostic.message; }
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'round-usage-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); throw error;
  } finally {
    if (child && !child.isDestroyed()) { await call('stopTask').catch(() => {}); child.close(); await until('fixture window closed', () => child.isDestroyed()).catch(() => child.destroy()); }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previous = original.settings.providers.openai;
      await parentCall('saveSettings', { provider: 'openai', model: previous.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol, reasoningEffort: previous.reasoningEffort, authMode: previous.authMode, clearKey: true });
      const selected = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: selected.baseUrl, apiProtocol: selected.apiProtocol, authMode: selected.authMode, reasoningEffort: original.settings.reasoningEffort });
    }
  }
};
