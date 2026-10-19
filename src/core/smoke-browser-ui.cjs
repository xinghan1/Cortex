const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

module.exports = async function smokeBrowserUI({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Browser UI smoke requires isolated offscreen app');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (name, argument) => js(`window.forge[${JSON.stringify(name)}](${argument === undefined ? '' : JSON.stringify(argument)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => { for (let count = 0; count < 240; count++) { const result = await predicate(); if (result) return result; await wait(25); } throw new Error('Browser UI smoke timeout: ' + label); };
  const original = await call('getState'), originalBounds = win.getBounds();
  const project = path.join(dataDir, 'browser-ui-project-' + randomUUID());
  await fs.mkdir(project, { recursive: true });
  const html = '<!doctype html><title>Saved project page</title><h1>Saved project page</h1>';
  await fs.writeFile(path.join(project, 'preview.html'), html);
  const problems = [], rounds = [];
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/fixture') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Integrated browser fixture</title><style>body{background:#17191d;color:white;font:20px sans-serif;padding:20px}input,button{padding:10px;margin:5px}</style><h1>Integrated browser fixture</h1><input id="name"><button id="action" onclick="document.getElementById(\'result\').textContent=\'Action: \'+document.getElementById(\'name\').value">Apply</button><p id="result">Waiting</p>'); return;
      }
      assert.equal(request.headers.authorization, 'Bearer forgedesk-browser-ui-key');
      if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'smoke-browser-ui', supportsTools: true, reasoningEfforts: [] }] })); return; }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1_000_000); }
      const body = JSON.parse(raw), round = rounds.length;
      rounds.push(body); assert.ok(round < 4);
      for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_screenshot']) assert.ok(body.tools.some(tool => tool.function.name === name), 'Missing live agent browser tool ' + name);
      const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      let message;
      if (round === 0) message = { role: 'assistant', content: '', tool_calls: [tool('browser-ui-nav', 'browser_navigate', { url: origin + '/fixture' })] };
      if (round === 1) {
        const returned = body.messages.find(item => item.role === 'tool' && item.tool_call_id === 'browser-ui-nav');
        assert.equal(JSON.parse(returned.content).title, 'Integrated browser fixture');
        message = { role: 'assistant', content: '', tool_calls: [tool('browser-ui-read', 'browser_snapshot', {})] };
      }
      if (round === 2) {
        const returned = JSON.parse(body.messages.find(item => item.role === 'tool' && item.tool_call_id === 'browser-ui-read').content);
        assert.match(returned.text, /Integrated browser fixture/); assert.ok(returned.elements.some(item => item.selector === '#name'));
        message = { role: 'assistant', content: '', tool_calls: [tool('browser-ui-type', 'browser_type', { selector: '#name', text: 'Live agent tool' }), tool('browser-ui-click', 'browser_click', { selector: '#action' })] };
      }
      if (round === 3) {
        assert.equal(JSON.parse(body.messages.find(item => item.role === 'tool' && item.tool_call_id === 'browser-ui-type').content).typed, true);
        assert.equal(JSON.parse(body.messages.find(item => item.role === 'tool' && item.tool_call_id === 'browser-ui-click').content).clicked, true);
        message = { role: 'assistant', content: 'BROWSER_UI_AGENT_COMPLETE' };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    } catch (error) { problems.push(error.stack || error.message); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  const guest = () => win.contentView.children.find(view => view.webContents && view.webContents !== win.webContents && !view.webContents.isDestroyed());
  const openMenu = async action => {
    await js(`(()=>{document.querySelector('[data-menu="view"]').click();document.querySelector('#app-menu-popup [data-action="browser"]').click();document.querySelector('#app-menu-submenu [data-action=${JSON.stringify(action)}]').click()})()`);
  };
  const assertLayout = async label => until(label, async () => {
    const view = guest(); if (!view || !view.getVisible()) return false;
    const rect = await js(`(()=>{const r=document.getElementById('browser-viewport').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`);
    const actual = view.getBounds();
    const [width, height] = win.getContentSize();
    return rect.width > 100 && rect.height > 100 && Object.keys(rect).every(key => Math.abs(actual[key] - rect[key]) <= 1)
      && actual.y >= 44 && actual.x + actual.width <= width && actual.y + actual.height <= height && actual;
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
    await call('openProject', { path: project });
    await until('renderer project', () => js(`appState?.workspace?.root===${JSON.stringify(project)}&&!projectSwitching&&!editorSaving`));
    await call('newSession');
    await openMenu('open-browser');
    await until('browser pane opened through menu', () => js("!document.getElementById('preview-panel').hidden&&!document.getElementById('browser-preview').hidden"));
    await openMenu('open-link');
    assert.equal(await js("document.getElementById('link-dialog').open"), true);
    await js(`document.getElementById('link-input').value=${JSON.stringify(origin + '/fixture')};document.getElementById('link-form').requestSubmit()`);
    await until('URL loaded in native guest', () => guest()?.webContents.getTitle() === 'Integrated browser fixture');
    await until('link dialog closed', () => js("!document.getElementById('link-dialog').open"));
    const normal = await assertLayout('native view matches right pane');
    await js("document.querySelector('[data-menu=\"view\"]').click()");
    await until('menu overlay hides native page', async () => (await call('getState')).browser.overlayHidden && !guest().getVisible());
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until('closing menu restores native page', () => guest().getVisible());
    await js("window.aiCodeCommands.execute('open-link')");
    await until('modal hides native page', async () => (await call('getState')).browser.overlayHidden && !guest().getVisible());
    await js("document.getElementById('link-close').click()"); await assertLayout('modal close restores native page');
    await js("document.getElementById('preview-pin').click()");
    await assertLayout('unpin browser native bounds');
    assert.equal(await js("document.getElementById('browser-preview').hidden"), false);
    await js("document.getElementById('preview-pin').click()"); await assertLayout('pin browser native bounds');
    win.setBounds({ width: 980, height: 700 }); await assertLayout('980 browser native bounds');
    win.setBounds({ width: 1340, height: 900 }); await assertLayout('1340 browser native bounds');
    await until('HTML tree row', () => js("!!document.querySelector('.file-row[data-path=\"preview.html\"]')"));
    await js("document.querySelector('.file-row[data-path=\"preview.html\"]').click()");
    await until('editor loads HTML', () => js(`selectedPath==='preview.html'&&document.getElementById('file-content').value===${JSON.stringify(html)}&&!editorSaving`));
    await js("(()=>{const input=document.getElementById('file-content');input.value=input.value.replaceAll('Saved project page','Autosaved browser page');input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('browser-preview-file').click()})()");
    await until('autosaved HTML preview', () => guest()?.webContents.getTitle() === 'Autosaved browser page');
    assert.match(await fs.readFile(path.join(project, 'preview.html'), 'utf8'), /Autosaved browser page/);
    await assertLayout('project preview native bounds');
    await call('saveSettings', { provider: 'deepseek', model: 'smoke-browser-ui', baseUrl: origin + '/v1', apiKey: 'forgedesk-browser-ui-key', reasoningEffort: 'default', maxSteps: 5 });
    await call('newSession'); await call('setPermissionMode', { mode: 'assist' });
    await js(`(()=>{window.__browserUISmoke={events:[]};window.__browserUISmoke.off=window.forge.onEvent(event=>{window.__browserUISmoke.events.push(event);if(event.type==='approval-request'&&event.kind==='browser')queueMicrotask(()=>window.forge.respondApproval({id:event.id,approved:true}))})})()`);
    await call('submitPrompt', { text: 'Verify the isolated browser fixture using the browser tools.', mode: 'queue' });
    await until('live agent finished', async () => rounds.length === 4 && !(await call('getState')).activeTask.running);
    assert.deepEqual(problems, []);
    assert.equal(await guest().webContents.executeJavaScript("document.getElementById('result').textContent"), 'Action: Live agent tool');
    const events = await js('window.__browserUISmoke.events');
    assert.ok(events.some(event => event.type === 'approval-auto' && event.kind === 'browser' && event.action === 'navigate'));
    for (const action of ['type', 'click']) assert.ok(events.some(event => event.type === 'approval-request' && event.kind === 'browser' && event.action === action));
    assert.ok(events.some(event => event.type === 'run-end' && event.status === 'completed'));
    await assertLayout('AI browser pane remains visible');
    win.webContents.invalidate(); await wait(100);
    await fs.writeFile(path.join(output, 'embedded-browser-app.png'), (await win.webContents.capturePage()).toPNG());
    const oldView = guest(), oldGuest = oldView.webContents;
    await call('openProject', { path: original.workspace?.root || project });
    if (original.workspace?.root && original.workspace.root !== project) {
      await until('project switch hides background native guest', () => !oldView.getVisible());
      assert.equal(oldGuest.isDestroyed(), false, 'Switching projects destroyed its retained browser');
    }
    return { status: 'completed', menuAndLink: true, actualNativeLayout: normal, smallAndLargeWindow: true, overlays: true, autosavePreview: true, liveAgentRounds: rounds.length, liveAgentActions: ['navigate', 'snapshot', 'type', 'click'] };
  } finally {
    await call('stopTask').catch(() => {});
    await until('cleanup idle', async () => !(await call('getState')).activeTask.running).catch(() => {});
    await js("window.__browserUISmoke?.off?.();document.getElementById('link-dialog').close()").catch(() => {});
    await call('openProject', { path: project }).catch(() => {});
    await call('browserCommand', { action: 'close' }).catch(() => {});
    await call('setPermissionMode', { mode: 'request' }).catch(() => {});
    if (original.workspace?.root) await call('openProject', { path: original.workspace.root }).catch(() => {});
    win.setBounds(originalBounds);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
};
