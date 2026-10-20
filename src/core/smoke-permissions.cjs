// Actual permission menus and approvals in fresh isolated windows, using only
// loopback model responses, fixture files and a stdout-only PowerShell command.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokePermissions({ win, output, dataDir }) {
  let child, other, installed = false, configured = false;
  const js = (code, target = child || win) => target.webContents.executeJavaScript(code);
  const call = (method, arg, target) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`, target);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Permissions smoke timed out: ' + label);
  };
  const fixture = path.join(dataDir, 'permissions-project-' + randomUUID());
  const nextProject = path.join(dataDir, 'permissions-next-' + randomUUID());
  const suffix = randomUUID();
  const scenarios = {
    request: { marker: 'PERMISSIONS_REQUEST_' + suffix, content: 'Explicitly approved fixture write\n' },
    assist: { marker: 'PERMISSIONS_ASSIST_' + suffix, content: 'Automatically approved fixture write\n' },
    full: { marker: 'PERMISSIONS_FULL_' + suffix, command: "Write-Output 'PERMISSIONS_COMMAND_OK'" },
  };
  const records = [], problems = [];
  const log = () => js('window.__permissionSmoke.events');
  const state = () => call('getState');
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text || '').join('\n') : '';
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'smoke-permissions-model', supports_images: false }] }));
        return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer forgedesk-permissions-fake-key');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 1_000_000); }
      const body = JSON.parse(raw);
      assert.equal(body.model, 'smoke-permissions-model');
      const latest = (body.input || []).filter(item => item.role === 'user').at(-1);
      const name = Object.keys(scenarios).find(key => textOf(latest?.content).includes(scenarios[key].marker));
      assert.ok(name, 'Unexpected permission fixture prompt');
      const scenario = scenarios[name], callId = 'permissions-' + name;
      const returned = (body.input || []).find(item => item.type === 'function_call_output' && item.call_id === callId);
      assert.equal(records.filter(record => record.name === name).length, returned ? 1 : 0, 'Unexpected duplicate permission model round');
      const result = returned ? JSON.parse(returned.output) : null;
      if (returned) {
        assert.equal(result.denied, undefined, 'Fixture operation was denied');
        if (name === 'full') { assert.equal(result.exitCode, 0); assert.ok(result.stdout.includes('PERMISSIONS_COMMAND_OK')); }
        else assert.equal(result.path, 'note.txt');
      }
      records.push({ name, continuation: !!returned });
      const outputItems = returned
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '权限测试已完成：' + name }] }]
        : [{ type: 'function_call', call_id: callId, name: name === 'full' ? 'run_command' : 'write_file', arguments: JSON.stringify(name === 'full' ? { command: scenario.command, timeout_ms: 5000 } : { path: 'note.txt', content: scenario.content }) }];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp_permission_' + randomUUID(), status: 'completed', output: outputItems, usage: { input_tokens: 3, output_tokens: 2 } }));
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message, code: 'permissions_smoke_contract' } }));
      }
    }
  });
  const modeReady = mode => until('mode ' + mode, async () => {
    const current = await state();
    const rendered = await js(`(()=>{const trigger=document.getElementById('permission-trigger');return trigger?{mode:trigger.dataset.mode,disabled:trigger.disabled}:null;})()`);
    return current.permissionMode === mode && rendered?.mode === mode && !rendered.disabled && current;
  });
  const choose = mode => js(`(()=>{
    const trigger=document.getElementById('permission-trigger');if(!trigger||trigger.disabled)throw new Error('Permission trigger unavailable');
    if(document.getElementById('permission-popup').hidden)trigger.click();
    const option=document.querySelector('#permission-popup button[data-mode=${JSON.stringify(mode)}]');
    if(!option||option.disabled)throw new Error('Permission option unavailable');option.click();
  })()`);
  const selectFull = async () => {
    await choose('full');
    await until('full control risk dialog', () => js("document.getElementById('permission-danger-dialog').open"));
    await js("document.getElementById('permission-danger-confirm').click()");
    await modeReady('full');
  };
  const rejected = async (method, arg) => assert.equal(await js(`(async()=>{try{await window.forge[${JSON.stringify(method)}](${JSON.stringify(arg)});return false;}catch{return true;}})()`), true, method + ' was not rejected');
  const capture = async name => { child.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG()); };
  const start = async name => {
    await js('window.__permissionSmoke.events.length=0');
    await call('runTask', { text: scenarios[name].marker });
  };
  const completed = async name => {
    const ended = await until('completed ' + name, async () => {
      const events = await log(), current = await state();
      return !current.activeTask.running && events.find(event => event.type === 'run-end');
    });
    assert.equal(ended.status, 'completed', ended.error || name + ' task failed');
    assert.equal(records.filter(record => record.name === name).length, 2);
    assert.deepEqual(problems, []);
    return log();
  };
  try {
    await fs.mkdir(fixture, { recursive: true }); await fs.mkdir(nextProject, { recursive: true });
    await fs.writeFile(path.join(fixture, 'note.txt'), 'Original permission fixture\n');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const parentMode = (await call('getState', undefined, win)).permissionMode;
    child = BrowserWindow.fromId((await call('newWindow', undefined, win)).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen(), 'Permission smoke requires a fresh isolated offscreen window');
    await until('permission controls attached', () => js("!!document.getElementById('permission-trigger')"));
    await call('openProject', { path: fixture });
    await modeReady('request');
    assert.equal((await state()).permissionMode, 'request');
    await js("document.getElementById('permission-trigger').click()");
    assert.deepEqual(await js("[...document.querySelectorAll('#permission-popup button')].map(button=>({mode:button.dataset.mode,label:button.querySelector('strong')?.textContent,role:button.getAttribute('role')}))"), [
      { mode: 'request', label: '请求批准', role: 'menuitemradio' }, { mode: 'assist', label: '帮我批准', role: 'menuitemradio' }, { mode: 'full', label: '完全控制', role: 'menuitemradio' },
    ]);
    await capture('permissions-menu.png');
    await choose('assist'); await modeReady('assist');
    await rejected('setPermissionMode', { mode: 'full' });
    assert.equal((await state()).permissionMode, 'assist');
    await choose('full');
    await until('risk dialog before changing mode', () => js("document.getElementById('permission-danger-dialog').open"));
    assert.equal((await state()).permissionMode, 'assist', 'Full control enabled before confirmation');
    const risk = await js(`(()=>{const dialog=document.getElementById('permission-danger-dialog'),rect=dialog.getBoundingClientRect();return{text:dialog.innerText,centerX:rect.x+rect.width/2,centerY:rect.y+rect.height/2,width:innerWidth,height:innerHeight,focused:document.activeElement.id};})()`);
    assert.match(risk.text, /Windows/u); assert.match(risk.text, /项目外/u); assert.match(risk.text, /当前窗口/u);
    assert.ok(Math.abs(risk.centerX - risk.width / 2) < 32 && Math.abs(risk.centerY - risk.height / 2) < 32, 'Risk dialog is not centered');
    assert.equal(risk.focused, 'permission-danger-cancel');
    await capture('permissions-risk.png');
    await js("document.getElementById('permission-danger-cancel').click()");
    await modeReady('assist'); assert.equal(await js("document.getElementById('permission-danger-dialog').open"), false);
    await selectFull();
    assert.equal((await call('getState', undefined, win)).permissionMode, parentMode, 'Child permission choice leaked to parent window');
    other = BrowserWindow.fromId((await call('newWindow')).id);
    assert.ok(other && other !== child);
    assert.equal((await call('getState', undefined, other)).permissionMode, 'request', 'New window inherited full control');
    other.webContents.executeJavaScript('window.forge.closeWindow()').catch(() => {});
    await until('fresh secondary window closes', () => other.isDestroyed());
    await choose('request'); await modeReady('request');

    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: 'smoke-permissions-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-permissions-fake-key', reasoningEffort: 'default', maxSteps: 4 });
    configured = true;
    await js("(()=>{window.__permissionSmoke={events:[]};window.__permissionSmoke.off=window.forge.onEvent(event=>window.__permissionSmoke.events.push(event));return true;})()");
    installed = true;
    await start('request');
    await until('explicit project write approval', async () => (await log()).find(event => event.type === 'approval-request' && event.kind === 'write'));
    assert.equal(await fs.readFile(path.join(fixture, 'note.txt'), 'utf8'), 'Original permission fixture\n');
    await wait(100);
    assert.equal(records.filter(record => record.name === 'request').length, 1, 'Unapproved write resumed the model');
    const approvalPlacement = await js(`(() => {
      const slot=document.getElementById('composer-approval'),form=document.getElementById('task-form'),card=slot?.querySelector('.approval-card');
      const actions=card?.querySelector('.approval-actions'),rect=actions?.getBoundingClientRect();
      return {slotVisible:!!slot&&!slot.hidden,formHidden:form?.hidden===true,cards:slot?.querySelectorAll('.approval-card').length||0,
        chatCards:document.querySelectorAll('#messages .approval-card').length,
        actionsVisible:!!rect&&rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight,
        pendingButtons:!!card?.querySelector('.approval-accept:not(:disabled)')&&!!card?.querySelector('.approval-reject:not(:disabled)')};
    })()`);
    assert.deepEqual(approvalPlacement, {slotVisible:true,formHidden:true,cards:1,chatCards:0,actionsVisible:true,pendingButtons:true}, 'Write approval must temporarily replace the composer without hiding the decision controls');
    assert.equal(await js("document.getElementById('permission-trigger').disabled"), true);
    await rejected('setPermissionMode', { mode: 'assist' });
    await rejected('setPermissionMode', { mode: 'full', confirmed: true });
    assert.equal((await state()).permissionMode, 'request');
    await js("(()=>{const button=document.querySelector('#composer-approval .approval-accept:not(:disabled)');if(!button)throw new Error('Composer approval button unavailable');button.click();})()");
    const requested = await completed('request');
    assert.equal(await fs.readFile(path.join(fixture, 'note.txt'), 'utf8'), scenarios.request.content);
    assert.equal(requested.filter(event => event.type === 'approval-auto').length, 0);
    assert.equal(await js("document.getElementById('composer-approval').hidden&&document.getElementById('composer-approval').childElementCount===0&&!document.getElementById('task-form').hidden"), true, 'Completed explicit approval must restore the composer without stale controls');

    await choose('assist'); await modeReady('assist');
    await start('assist');
    const assisted = await completed('assist');
    assert.equal(await fs.readFile(path.join(fixture, 'note.txt'), 'utf8'), scenarios.assist.content);
    assert.equal(assisted.filter(event => event.type === 'approval-request').length, 0);
    assert.equal(assisted.filter(event => event.type === 'approval-auto' && event.kind === 'write' && event.permissionMode === 'assist').length, 1);

    await selectFull(); await start('full');
    const controlled = await completed('full');
    assert.equal(controlled.filter(event => event.type === 'approval-request').length, 0);
    assert.equal(controlled.filter(event => event.type === 'approval-auto' && event.kind === 'command' && event.permissionMode === 'full').length, 1);
    await call('openProject', { path: nextProject }); await modeReady('request');
    assert.equal((await call('getState', undefined, win)).permissionMode, parentMode);
    assert.equal(win.isDestroyed(), false);
    assert.deepEqual(problems, []); assert.equal(records.length, 6);
    return { status: 'completed', realApi: false, defaultRequest: true, actualMenu: true, riskDialogCentered: true, cancelPreservesMode: true, confirmRequired: true, currentWindowOnly: true, newWindowDefaultsRequest: true, busyChangeRejected: true, explicitWriteWaited: true, composerApprovalVisible:true,composerRestored:true, assistWriteAutomatic: true, fullCommandAutomatic: true, projectSwitchResets: true, modelRequests: records.length, screenshots: ['permissions-menu.png', 'permissions-risk.png'] };
  } catch (error) {
    const current = child && !child.isDestroyed() ? await state().catch(() => null) : null;
    console.error('PERMISSIONS_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, stack: error.stack, records, problems, state: current ? { permissionMode: current.permissionMode, workspace: current.workspace, activeTask: current.activeTask, queueLength: current.promptQueue?.items?.length, model: current.settings?.model } : null }));
    throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      if (installed) await js('window.__permissionSmoke?.off?.()').catch(() => {});
      await call('stopTask').catch(() => {});
      await until('permission fixture task stopped', async () => !(await state()).activeTask.running).catch(() => {});
      if (configured) await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: '', baseUrl: 'https://api.openai.com/v1', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
      child.destroy();
    }
    if (other && !other.isDestroyed()) other.destroy();
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  }
};
