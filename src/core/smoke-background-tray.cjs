const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

module.exports = async function smokeBackgroundTray({ win, output, dataDir, backgroundTray }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.equal(backgroundTray.snapshot().available, true, 'The real native tray must exist');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (name, arg) => js(`window.forge[${JSON.stringify(name)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(30); }
    throw new Error('Background tray smoke timed out: ' + label);
  };
  let held = null, normalRequests = 0, configured = false;
  const problems = [], project = path.join(dataDir, 'background-tray-project');
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer isolated-tray-fixture');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'tray-fixture-model', supportsTools: true, context_window: 128000 }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      let encoded = ''; for await (const chunk of request) encoded += chunk;
      assert.ok(encoded.length < 300000);
      const body = JSON.parse(encoded);
      const reply = text => {
        response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + '\n\n');
        response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 25 } }) + '\n\n');
        response.end('data: [DONE]\n\n');
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': isolated tray smoke\n\n');
      if (!body.tools?.length) { reply(JSON.stringify({ continuation: '继续检查当前项目。' })); return; }
      normalRequests++;
      assert.equal(normalRequests, 1, 'Hiding/restoring must not start or retry a second task');
      held = { aborted: false, released: false, response, reply };
      const timer = setInterval(() => { if (!response.destroyed) response.write(': pending model heartbeat\n\n'); }, 100);
      response.once('close', () => { clearInterval(timer); if (!held.released) held.aborted = true; });
    } catch (error) {
      problems.push(error.message);
      if (!response.headersSent) response.writeHead(500);
      if (!response.destroyed) response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  let closePrevented = false;
  const onClose = event => { closePrevented = event.defaultPrevented; };
  try {
    await fs.mkdir(project, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await until('renderer ready', () => js('Boolean(window.forge&&appState&&!projectSwitching)'));
    await call('openProject', { path: project });
    await call('saveSettings', { provider: 'relay', authMode: 'apiKey', apiProtocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-tray-fixture', model: 'tray-fixture-model' });
    configured = true; await call('listModels', { force: true });
    await until('composer ready', () => js("!projectSwitching&&!promptSubmitting&&!document.getElementById('send-button').disabled"));
    win.show();
    const contentsId = win.webContents.id;
    await js(`(()=>{const input=document.getElementById('task-input');input.value='BACKGROUND_TRAY_TASK';input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('task-form').requestSubmit();return true;})()`);
    await until('real loopback model is running', () => held);
    assert.equal((await call('getState')).activeTask.running, true);
    win.on('close', onClose); win.close();
    assert.equal(closePrevented, true); assert.equal(win.isDestroyed(), false); assert.equal(win.isVisible(), false);
    await wait(300);
    assert.equal(held.aborted, false); assert.equal((await call('getState')).activeTask.running, true);
    held.released = true; held.reply('BACKGROUND_TRAY_COMPLETED_WHILE_HIDDEN');
    await until('task completes while the window is hidden', async () => !(await call('getState')).activeTask.running);
    assert.equal(win.isVisible(), false);
    const current = await call('getCurrentSession');
    assert.ok(current.messages.some(message => message.role === 'assistant' && message.content.includes('BACKGROUND_TRAY_COMPLETED_WHILE_HIDDEN')));
    await backgroundTray.show();
    assert.equal(win.isVisible(), true); assert.equal(win.webContents.id, contentsId);
    assert.equal(normalRequests, 1); assert.deepEqual(problems, []);
    await fs.writeFile(path.join(output, 'background-tray-restored.png'), (await win.webContents.capturePage()).toPNG());
    return { status: 'completed', realApi: false, localFixtureModelOnly: true, nativeTrayCreated: true,
      nativeClosePrevented: true, hiddenWindowPreserved: true, liveModelNotCancelledByClose: true,
      modelCompletedWhileHidden: true, restoreReusesSameWindowAndSession: true, originalTaskRequests: normalRequests,
      screenshots: ['background-tray-restored.png'] };
  } finally {
    win.removeListener('close', onClose);
    if (!win.isDestroyed()) {
      await call('stopTask').catch(() => {});
      await until('model idle before cleanup', async () => !(await call('getState')).activeTask.running).catch(() => {});
      if (configured) await call('saveSettings', { provider: 'relay', authMode: 'apiKey', model: '', baseUrl: 'https://example.invalid/v1', clearKey: true }).catch(() => {});
    }
    const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing;
  }
};
