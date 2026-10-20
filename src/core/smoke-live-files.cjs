// File operations through real menus while a loopback model remains in flight.
// Explorer, clipboard and recycling are stubbed; all files stay in this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, shell, clipboard, dialog } = require('electron');

module.exports = async function smokeLiveFiles({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Live-files smoke requires an isolated offscreen parent');
  const fixture = path.join(dataDir, 'live-files-' + randomUUID());
  const project = path.join(fixture, 'project-A'), other = path.join(fixture, 'project-B'), recycle = path.join(fixture, 'test-recycle');
  const prompts = { main: 'LIVE_FILES_MAIN_' + randomUUID(), queue: 'LIVE_FILES_QUEUE_' + randomUUID(), close: 'LIVE_FILES_CLOSE_' + randomUUID() };
  const originalText = 'Original approval fixture\n', manualText = 'MANUAL_EDIT_MUST_SURVIVE_' + randomUUID();
  const model = 'smoke-live-files', apiKey = 'forgedesk-live-files-key', records = [], problems = [], copied = [], revealed = [], trashed = [], confirmations = [], gates = new Map();
  const saved = { open: fs.open, rename: fs.rename, reveal: shell.showItemInFolder, copy: clipboard.writeText, trash: shell.trashItem, dialog: dialog.showMessageBox };
  let child, configured = false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => { const end = Date.now() + 15000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await wait(25); } throw new Error('Live-files smoke timed out: ' + label); };
  const identity = value => path.resolve(value).toLowerCase();
  const inside = absolute => { const relative = path.relative(fixture, path.resolve(absolute)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Host operation escaped live-files fixture'); };
  const exists = async absolute => { try { await fs.stat(absolute); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const js = code => child.webContents.executeJavaScript(code);
  const invocation = (method, arg) => `window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`;
  const call = (method, arg) => js(invocation(method, arg));
  const parentCall = (method, arg) => win.webContents.executeJavaScript(invocation(method, arg));
  const original = await parentCall('getState');
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace a configured key');
  const state = () => call('getState');
  const events = () => js('window.__liveFilesSmoke.events');
  const idleFiles = () => until('file UI settled', () => js('!fileMutationBusy&&!editorSaving&&!projectSwitching'));
  const select = relative => '.file-row[data-path=' + JSON.stringify(relative) + ']';
  const row = async relative => {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      await until('parent row ' + parent, () => js(`!!document.querySelector(${JSON.stringify(select(parent))})`));
      await js(`(()=>{const row=document.querySelector(${JSON.stringify(select(parent))});if(row.getAttribute('aria-expanded')==='false')row.click();return true;})()`);
    }
    await until('row ' + relative, () => js(`!!document.querySelector(${JSON.stringify(select(relative))})`));
  };
  const menu = async relative => {
    await idleFiles(); if (relative !== null) await row(relative);
    await js(`(()=>{const node=${relative === null ? "document.getElementById('file-tree')" : `document.querySelector(${JSON.stringify(select(relative))})`};const rect=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+10,clientY:rect.top+10}));return true;})()`);
  };
  const action = async (relative, operation) => {
    const copiedBefore = copied.length, revealedBefore = revealed.length;
    await menu(relative);
    await js(`(()=>{const button=document.querySelector('#file-context-menu [data-file-action=${JSON.stringify(operation)}]');if(!button||button.disabled)throw new Error('Live file menu action disabled: '+${JSON.stringify(operation)});button.click();return true;})()`);
    if (!['new-file', 'new-folder', 'rename'].includes(operation)) await idleFiles();
    if (['copy', 'cut'].includes(operation)) await until('file clipboard ' + operation, () => js(`fileClipboard?.mode===${JSON.stringify(operation)}&&fileClipboard.path===${JSON.stringify(relative)}`));
    if (['copy-path', 'copy-relative-path'].includes(operation)) await until('path copied', () => copied.length === copiedBefore + 1);
    if (operation === 'reveal') await until('file revealed', () => revealed.length === revealedBefore + 1);
  };
  const name = async value => {
    await until('name dialog', () => js("document.getElementById('file-name-dialog').open"));
    await js(`(()=>{const input=document.getElementById('file-name-input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('file-name-form').requestSubmit();return true;})()`);
    await until('name accepted', () => js("!document.getElementById('file-name-dialog').open")); await idleFiles();
  };
  const open = async relative => {
    await action(relative, 'open');
    await until('editor ' + relative, () => js(`selectedPath===${JSON.stringify(relative)}&&!document.getElementById('file-preview').hidden&&!document.getElementById('file-content').readOnly`));
  };
  const edit = async (relative, text, root = project) => {
    await js(`(()=>{const input=document.getElementById('file-content');if(input.readOnly)throw new Error('Running model locked the editor');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await until('autosave ' + relative, async () => await fs.readFile(path.join(root, relative), 'utf8') === text && await js('!editorDirty&&!editorSaving'));
  };
  const activate = async root => {
    await js(`openRecentProject({path:${JSON.stringify(root)}})`);
    await until('project ' + path.basename(root), async () => (await state()).workspace?.root === root && await js(`appState?.workspace?.root===${JSON.stringify(root)}&&!projectSwitching`));
  };
  const gate = filename => {
    let release; const promise = new Promise(resolve => { release = resolve; });
    const result = { entered: false, promise, release }; gates.set(identity(path.join(project, filename)), result); return result;
  };
  const finish = (record, tool = false) => {
    assert.ok(record && !record.released && !record.aborted);
    const outputItems = tool ? [{ type: 'function_call', call_id: 'live-files-ai-write', name: 'write_file', arguments: JSON.stringify({ path: 'conflict.txt', content: 'AI_STALE_OVERWRITE_MUST_NOT_APPEAR' }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'LIVE_FILES_COMPLETED_' + record.name }] }];
    record.response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: outputItems, usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n\n');
    record.released = true; clearInterval(record.heartbeat); record.response.end('data: [DONE]\n\n');
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: model, supportsTools: true, reasoningEfforts: [] }] })); return; }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 200000); }
      const body = JSON.parse(raw), latest = body.input.filter(item => item.role === 'user').at(-1);
      const text = typeof latest.content === 'string' ? latest.content : latest.content.map(item => item.text || '').join('\n');
      const task = Object.keys(prompts).find(key => text === prompts[key]); assert.ok(task); assert.equal(body.model, model);
      const returned = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'live-files-ai-write');
      const record = { name: task, continuation: !!returned, response, released: false, aborted: false };
      if (task === 'main' && returned) assert.match(returned.output, /等待审批.*变化|文件.*变化/u, 'AI write did not detect the manual edit');
      records.push(record);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.write(': live files heartbeat\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.released) response.write(': live files heartbeat\n\n'); }, 150);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.released && !response.writableFinished) record.aborted = true; });
    } catch (error) { problems.push(error.message); if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'live_files_contract', message: error.message } })); } }
  });
  const requestFor = (task, continuation = false) => until('request ' + task, () => records.find(record => record.name === task && record.continuation === continuation));
  const capture = async filename => { child.webContents.invalidate(); await wait(120); await fs.writeFile(path.join(output, filename), (await child.webContents.capturePage()).toPNG()); };
  const closeChild = async () => { if (!child || child.isDestroyed()) return; const closing = child; closing.close(); await until('child closes', () => closing.isDestroyed()); child = null; };
  try {
    await fs.mkdir(path.join(project, 'target'), { recursive: true }); await fs.mkdir(other); await fs.mkdir(recycle); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), 'Live README\n'); await fs.writeFile(path.join(project, 'conflict.txt'), originalText); await fs.writeFile(path.join(other, 'sentinel.txt'), 'OTHER_PROJECT_PRESERVED');
    shell.showItemInFolder = absolute => { inside(absolute); revealed.push(absolute); };
    clipboard.writeText = text => { copied.push(text); };
    dialog.showMessageBox = async (...args) => { const options = args.at(-1); assert.match(options.title, /回收站/u); confirmations.push(options); return { response: 0 }; };
    shell.trashItem = async absolute => { inside(absolute); const destination = path.join(recycle, randomUUID() + '-' + path.basename(absolute)); await saved.rename(absolute, destination); trashed.push({ source: absolute, destination }); };
    fs.open = async (absolute, flags, ...rest) => { const current = typeof absolute === 'string' ? gates.get(identity(absolute)) : null; if (current && !current.entered && typeof flags === 'number' && (flags & constants.O_CREAT) && (flags & constants.O_EXCL)) { current.entered = true; await current.promise; } return saved.open(absolute, flags, ...rest); };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await parentCall('newWindow')).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child initialized', () => js('!!window.forge&&!!appState'));
    await js('(()=>{window.__liveFilesSmoke={events:[]};window.__liveFilesSmoke.off=window.forge.onEvent(event=>window.__liveFilesSmoke.events.push(event));return true;})()');
    await activate(project);
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, reasoningEffort: 'default' }); configured = true;
    const before = await state(), sessionId = before.sessionId;
    await call('submitPrompt', { text: prompts.main, mode: 'queue' }); const held = await requestFor('main');
    const queued = await call('submitPrompt', { text: prompts.queue, mode: 'queue' }); assert.equal(queued.disposition, 'queued');
    await action('README.md', 'copy'); await until('copy buffer', () => js("fileClipboard?.mode==='copy'"));
    await menu('README.md');
    const menuStates = await js("[...document.querySelectorAll('#file-context-menu [data-file-action]')].map(button=>({action:button.dataset.fileAction,disabled:button.disabled}))");
    for (const operation of ['open', 'reveal', 'new-file', 'new-folder', 'cut', 'copy', 'paste', 'copy-path', 'copy-relative-path', 'rename', 'delete']) assert.equal(menuStates.find(item => item.action === operation)?.disabled, false, 'Running model disabled ' + operation);
    await js('closeFileContextMenu()');
    assert.equal(await js("document.getElementById('new-file').disabled||document.getElementById('new-folder').disabled"), false);
    await open('README.md'); await edit('README.md', 'Edited while the model and queued prompt remain active\n');
    await action('README.md', 'reveal'); await action('README.md', 'copy-relative-path'); await action('README.md', 'copy-path');
    assert.equal(revealed.length, 1); assert.equal(copied[0], 'README.md'); assert.equal(identity(copied[1]), identity(path.join(project, 'README.md')));
    await activate(other); await action(null, 'new-file'); await name('b-only.txt');
    await until('created B editor ready', () => js("selectedPath==='b-only.txt'&&!document.getElementById('file-content').readOnly")); await edit('b-only.txt', 'ONLY_IN_B', other);
    assert.equal(await exists(path.join(project, 'b-only.txt')), false); await activate(project);
    assert.equal((await state()).sessionId, sessionId); assert.equal((await state()).activeTask.running, true); assert.equal((await state()).promptQueue.items[0].id, queued.id);
    await action(null, 'new-folder'); await name('work'); await action('work', 'new-file'); await name('live.txt');
    await until('created A editor ready', () => js("selectedPath==='work/live.txt'&&!document.getElementById('file-content').readOnly")); await edit('work/live.txt', 'LIVE_AUTOSAVED\n');
    await action('work/live.txt', 'rename'); await name('renamed.txt');
    await until('file rename updates editor', () => js("selectedPath==='work/renamed.txt'&&document.getElementById('preview-filename').title==='work/renamed.txt'"));
    await action('work', 'copy'); await action(null, 'paste'); await until('folder copied', () => exists(path.join(project, 'work - 副本', 'renamed.txt')));
    await action('work', 'cut'); await action('target', 'paste');
    await until('cut directory updates edited descendant', () => js("selectedPath==='target/work/renamed.txt'&&document.getElementById('preview-filename').title==='target/work/renamed.txt'"));
    await action('target/work', 'rename'); await name('moved');
    await until('directory rename updates edited descendant', () => js("selectedPath==='target/moved/renamed.txt'"));
    await edit('target/moved/renamed.txt', 'Saved after cut and directory rename\n');
    await action('target/moved', 'delete');
    await until('directory deletion clears edited descendant', () => js("selectedPath===null&&document.getElementById('file-preview').hidden"));
    assert.equal(await exists(path.join(project, 'target', 'moved')), false); assert.equal(trashed.length, 1); assert.equal(confirmations.length, 1);
    await action(null, 'new-file'); await name('delete-me.txt'); await action('delete-me.txt', 'delete');
    await until('file deleted', async () => !(await exists(path.join(project, 'delete-me.txt')))); assert.equal(trashed.length, 2);
    assert.equal(held.aborted, false); assert.equal(records.length, 1, 'File actions interrupted or retried the held model');
    assert.equal(await fs.readFile(path.join(other, 'sentinel.txt'), 'utf8'), 'OTHER_PROJECT_PRESERVED');
    await capture('live-files-running-editor.png');

    // Change the same file while an AI write is awaiting approval. The original
    // tool snapshot must reject the later approved stale write.
    finish(held, true);
    const approval = await until('AI write approval', async () => (await state()).pendingApprovals.find(item => item.kind === 'write' && item.path === 'conflict.txt'));
    await until('AI write decision visible in composer', () => js("!document.getElementById('composer-approval').hidden&&document.getElementById('task-form').hidden&&!!document.querySelector('#composer-approval .approval-accept:not(:disabled)')"));
    assert.equal(await js("document.querySelectorAll('#messages .approval-card').length"),0,'Pending stale-write approval should not be inserted into the conversation');
    await open('conflict.txt'); await edit('conflict.txt', manualText);
    assert.equal((await state()).activeTask.running, true); await capture('live-files-approval-manual-edit.png');
    await call('respondApproval', { id: approval.id, approved: true });
    const continuation = await requestFor('main', true);
    assert.equal(await js("document.getElementById('composer-approval').hidden&&document.getElementById('composer-approval').childElementCount===0&&!document.getElementById('task-form').hidden"),true,'Resolved stale-write approval did not restore the composer');
    assert.equal(await fs.readFile(path.join(project, 'conflict.txt'), 'utf8'), manualText);
    const queueGate = gate('queue-gate.txt');
    await js("(()=>{window.__liveFilesSmoke.pendingCreate=window.forge.fileCreate({parent:'',name:'queue-gate.txt',type:'file'}).then(()=>true,error=>{throw error});return true;})()");
    await until('manual operation held', () => queueGate.entered); finish(continuation);
    await until('main task ends during manual operation', async () => (await events()).some(event => event.type === 'run-end' && event.status === 'completed'));
    await wait(100); assert.equal(records.some(record => record.name === 'queue'), false, 'Queued task started during an unfinished manual operation');
    queueGate.release(); await until('manual create ends', () => exists(path.join(project, 'queue-gate.txt')));
    const queuedRequest = await requestFor('queue', true); finish(queuedRequest);
    await until('queue completed', async () => !(await state()).activeTask.running && !(await state()).promptQueue.items.length);
    assert.equal(await fs.readFile(path.join(project, 'conflict.txt'), 'utf8'), manualText);

    // A running task and a clean editor must not let close discard an already
    // accepted file operation. Only this disposable child window is closed.
    await call('submitPrompt', { text: prompts.close, mode: 'queue' }); const closingRequest = await requestFor('close', true);
    const closeGate = gate('close-gate.txt');
    await js("(()=>{window.__liveFilesSmoke.closeCreate=window.forge.fileCreate({parent:'',name:'close-gate.txt',type:'file'}).then(()=>true,error=>{throw error});return true;})()");
    await until('close operation held', () => closeGate.entered);
    const closing = child; closing.close(); await wait(100);
    assert.equal(closing.isDestroyed(), false, 'Window closed before its accepted file operation completed');
    await until('closing cancels model', () => closingRequest.aborted); closeGate.release();
    await until('close waits for file and then destroys window', async () => await exists(path.join(project, 'close-gate.txt')) && closing.isDestroyed()); child = null;
    const after = await parentCall('getState');
    assert.equal(after.sessionId, original.sessionId); assert.equal(after.workspace?.root, original.workspace?.root); assert.equal(win.isDestroyed(), false);
    assert.equal(after.usageStats.day.requests - before.usageStats.day.requests, 4); assert.equal(after.usageStats.day.totalTokens - before.usageStats.day.totalTokens, 30);
    assert.equal(after.usageStats.day.unreportedRequests - before.usageStats.day.unreportedRequests, 1); assert.deepEqual(problems, []);
    return { status: 'completed', realApi: false, isolatedChildWindow: true, allMenuActionsAvailable: true, queuedPromptRetained: true, openAndAutosaveDuringModel: true, createFileAndFolder: true, copyCutPaste: true, renameFileAndDirectory: true, editedDescendantPathUpdated: true, deleteFileAndDirectory: true, clipboardAndExplorerStubbed: true, fakeRecycleBin: trashed.length, pendingAiWriteConflictProtected: true, queueWaitsThenResumesAfterManualOperation: true, closeWaitsForManualOperation: true, closeAbortsModel: true, projectAndParentIsolated: true, requests: records.length, tokensRecorded: 30, screenshots: ['live-files-running-editor.png', 'live-files-approval-manual-edit.png'] };
  } catch (error) {
    console.error('LIVE_FILES_SMOKE_FAILURE', JSON.stringify({ error: error.message, stack: error.stack, problems, requests: records.map(({ name, continuation, released, aborted }) => ({ name, continuation, released, aborted })), renderer: child && !child.isDestroyed() ? await js('({running,selectedPath,fileMutationBusy,editorDirty,editorSaving,projectSwitching,notice:document.getElementById("notice-text").textContent})').catch(() => null) : null })); throw error;
  } finally {
    for (const current of gates.values()) current.release();
    await closeChild().catch(() => { if (child && !child.isDestroyed()) child.destroy(); });
    fs.open = saved.open; shell.showItemInFolder = saved.reveal; clipboard.writeText = saved.copy; shell.trashItem = saved.trash; dialog.showMessageBox = saved.dialog;
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previousOpenai = original.settings.providers.openai;
      await parentCall('saveSettings', { provider: 'openai', model: previousOpenai.model, baseUrl: previousOpenai.baseUrl, apiProtocol: previousOpenai.apiProtocol, reasoningEffort: previousOpenai.reasoningEffort, authMode: previousOpenai.authMode, clearKey: true });
      const previous = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: previous.authMode });
    }
  }
};
