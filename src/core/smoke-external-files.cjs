// Disposable loopback fixture spanning three Electron processes. No user files,
// real model credentials, external API requests, or shell commands are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

module.exports = async function smokeExternalFiles({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const phase = process.env.FORGEDESK_EXTERNAL_FILES_SMOKE_PHASE || 'prepare';
  assert.ok(['prepare', 'verify', 'verify-again'].includes(phase));
  const marker = path.join(dataDir, 'external-files-smoke-fixture.json');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (name, value) => js(`window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(30); }
    throw new Error('External file smoke timed out: ' + label);
  };
  const state = () => call('getState');
  let fixture, server, original, configured = false, stage = 'initialize';
  const problems = [], requests = [];
  const events = () => js('window.__externalFilesSmoke.events');
  const subscribe = () => js('window.__externalFilesSmoke={events:[]};window.forge.onEvent(e=>window.__externalFilesSmoke.events.push(e));true');
  const card = () => `.task-change-summary[data-run-id=${JSON.stringify(fixture.runId)}]`;
  const click = async selector => {
    await until('visible enabled control ' + selector, () => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&n.checkVisibility({visibilityProperty:true,opacityProperty:true})&&n.getAnimations({subtree:true}).every(a=>a.playState!=='running');})()`));
    const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered external file control');return p;})()`);
    win.webContents.focus(); win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(60);
  };
  const disk = async values => {
    for (const [reference, expected] of Object.entries(values)) {
      const filename = path.isAbsolute(reference) ? reference : path.join(fixture.project, reference);
      const actual = await fs.readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      assert.equal(actual, expected, reference);
    }
    assert.equal((await state()).workspace?.root, fixture.project, 'External edits must not switch the active project');
  };
  const direction = action => until('historical ' + action + ' available', async () => {
    const current = await state(), allowed = current[action === 'redo' ? 'redoableRunIds' : 'undoableRunIds'];
    return allowed.includes(fixture.runId) && await js(`(()=>{const n=document.querySelector(${JSON.stringify(card() + ' .task-change-' + action)});return !!n&&!n.disabled&&!n.hidden&&!taskChangeUndoBusy;})()`);
  });
  const perform = async (action, expectedStatus = 'completed') => {
    await direction(action);
    const name = action === 'redo' ? 'redo_run_changes' : 'undo_run_changes';
    const before = (await events()).filter(e => e.type === 'tool-result' && e.name === name).length;
    await click(card() + ' .task-change-' + action);
    const result = await until(action + ' tool result', async () => {
      assert.equal((await state()).pendingApprovals.length, 0, 'Full mode must not request approval');
      const list = (await events()).filter(e => e.type === 'tool-result' && e.name === name);
      return list.length > before && JSON.parse(list.at(-1).result);
    });
    assert.equal(result.status, expectedStatus, result.error || result.message);
    assert.deepEqual(new Set(result.completed), new Set(expectedStatus === 'completed' ? Object.keys(fixture.after) : []));
    await until('undo UI settled', () => js('!taskChangeUndoBusy'));
    await direction(expectedStatus === 'completed' ? action === 'redo' ? 'undo' : 'redo' : action);
    return result;
  };
  const assertCard = async () => {
    const originalSelection = await js('selectedPath');
    const snapshot = await until('one card and all path rows', () => js(`(()=>{const list=document.querySelectorAll(${JSON.stringify(card())});if(list.length!==1)return false;const n=list[0],rows=[...n.querySelectorAll('.task-change-file')];return rows.length===3&&{count:n.querySelector('.task-change-count').textContent,paths:rows.map(r=>r.dataset.path),text:n.textContent};})()`));
    assert.match(snapshot.count, /3/u); assert.deepEqual(new Set(snapshot.paths), new Set(Object.keys(fixture.after)));
    assert.ok(snapshot.paths.includes('same.txt')); assert.ok(snapshot.paths.includes(fixture.externalEdit));
    await click(card() + ' .task-change-view');
    const preview = await until('three inline snapshot diffs', () => js(`(()=>{const n=document.querySelector(${JSON.stringify(card())});return n.querySelectorAll('.task-change-diff').length===3&&{paths:[...n.querySelectorAll('.task-change-diff')].map(d=>d.dataset.path),text:n.textContent};})()`));
    assert.deepEqual(new Set(preview.paths), new Set(Object.keys(fixture.after)));
    assert.ok(preview.text.includes(fixture.before[fixture.externalEdit].trim()));
    assert.ok(preview.text.includes(fixture.after[fixture.externalEdit].trim()));
    assert.equal(await js('selectedPath'), originalSelection, 'Reading inline diffs must not navigate the manual editor');
  };
  const manualEditor = async () => {
    const filename = path.join(fixture.sibling, 'manual.txt').replace(/\\/gu, '/');
    await fs.writeFile(filename, 'MANUAL_ORIGINAL\n');
    const originalFile = await call('fileRead', { path: filename });
    assert.equal(originalFile.path, filename); assert.equal(originalFile.content, 'MANUAL_ORIGINAL\n');
    await fs.writeFile(filename, 'MANUAL_USER_CHANGE\n');
    let conflict;
    try { await call('fileSave', { path: filename, content: 'MUST_NOT_OVERWRITE\n', expectedVersion: originalFile.version }); }
    catch (error) { conflict = error.message; }
    assert.ok(conflict, 'Stale external editor versions must fail'); assert.match(conflict, /变化|冲突|重新/u);
    assert.equal(await fs.readFile(filename, 'utf8'), 'MANUAL_USER_CHANGE\n');
    await js(`previewFile(${JSON.stringify(filename)})`);
    await until('external manual editor loaded', () => js(`selectedPath===${JSON.stringify(filename)}&&!$('file-content').readOnly&&!$('file-preview').hidden`));
    assert.equal(await js("$('preview-filename').textContent"), filename);
    await js(`window.__externalNativeInputs=[];$('file-content').addEventListener('input',e=>window.__externalNativeInputs.push(e.isTrusted));$('file-content').focus();$('file-content').setSelectionRange(0,0);true`);
    win.webContents.focus(); await win.webContents.insertText('NATIVE_MANUAL_EDIT\n');
    await until('native external editor autosave', async () => await fs.readFile(filename, 'utf8') === 'NATIVE_MANUAL_EDIT\nMANUAL_USER_CHANGE\n' && await js('!editorDirty&&!editorSaving'));
    assert.ok((await js('window.__externalNativeInputs')).includes(true));
    assert.equal((await state()).workspace?.root, fixture.project);
    await js('setPreviewOpen(false);true');
  };
  const reload = async () => {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload(); await loaded;
    await until('session restored after renderer reload', () => js(`Boolean(appState&&!projectSwitching&&sessionId===${JSON.stringify(fixture.sessionId)})`));
    await subscribe(); await call('setPermissionMode', { mode: 'full', confirmed: true });
  };
  try {
    await fs.mkdir(output, { recursive: true });
    await until('renderer initialized', () => js('Boolean(appState&&window.forge&&window.ForgeTaskChangeSummary&&!projectSwitching)'));
    win.setContentSize(1440, 1000); win.setOpacity(0); win.showInactive(); win.webContents.focus();
    await subscribe();
    if (phase === 'prepare') {
      assert.equal(await fs.stat(marker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
      const nonce = randomUUID(), base = path.join(dataDir, 'external-files-' + nonce), project = path.join(base, 'client'), sibling = path.join(base, 'server');
      const externalEdit = path.join(sibling, 'same.txt').replace(/\\/gu, '/'), externalNew = path.join(sibling, 'new.txt').replace(/\\/gu, '/');
      const prompt = `EXTERNAL_FILES_${nonce} 读取并更新服务端 ${externalEdit}；创建 ${externalNew}，同时更新当前项目 same.txt。`;
      fixture = { nonce, project, sibling, externalEdit, externalNew, prompt, pids: [process.pid],
        before: { 'same.txt': 'CLIENT_ORIGINAL_' + nonce + '\n', [externalEdit]: 'SERVER_ORIGINAL_' + nonce + '\n', [externalNew]: null },
        after: { 'same.txt': 'CLIENT_UPDATED_' + nonce + '\n', [externalEdit]: 'SERVER_UPDATED_' + nonce + '\n', [externalNew]: 'SERVER_NEW_' + nonce + '\n' } };
      await fs.mkdir(project, { recursive: true }); await fs.mkdir(sibling, { recursive: true });
      for (const [reference, content] of Object.entries(fixture.before)) if (content !== null) await fs.writeFile(path.isAbsolute(reference) ? reference : path.join(project, reference), content);
      original = await state(); assert.equal(original.settings.providers.openai.hasKey, false);
      const model = 'smoke-external-files', apiKey = 'external-files-fixture-key';
      const tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
      server = http.createServer(async (request, response) => {
        try {
          assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
          if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: model, supportsTools: true, reasoningEfforts: [], context_window: 128000 }] })); return; }
          assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
          let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 300000); }
          const body = JSON.parse(raw); requests.push(body); assert.equal(body.model, model); assert.ok(raw.includes('EXTERNAL_FILES_' + nonce));
          const turn = requests.length; assert.ok(turn <= 4);
          if (turn >= 2) {
            const read = body.input.findLast(item => item.type === 'function_call_output' && item.call_id === 'external-read');
            assert.ok(read); assert.equal(JSON.parse(read.output).content, fixture.before[externalEdit]);
          }
          if (turn >= 3) for (const [id, reference] of [['external-replace', externalEdit], ['internal-write', 'same.txt']]) {
            const result = body.input.findLast(item => item.type === 'function_call_output' && item.call_id === id);
            assert.equal(JSON.parse(result.output).path, reference);
          }
          if (turn === 4) assert.equal(JSON.parse(body.input.findLast(item => item.type === 'function_call_output' && item.call_id === 'external-create').output).path, externalNew);
          const items = turn === 1 ? [tool('external-read', 'read_file', { path: externalEdit })]
            : turn === 2 ? [tool('external-replace', 'replace_in_file', { path: externalEdit, old_text: fixture.before[externalEdit], new_text: fixture.after[externalEdit] }), tool('internal-write', 'write_file', { path: 'same.txt', content: fixture.after['same.txt'] })]
            : turn === 3 ? [tool('external-create', 'write_file', { path: externalNew, content: fixture.after[externalNew] })]
            : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已读取并编辑项目外服务端文件，当前项目保持不变。EXTERNAL_FILES_DONE' }] }];
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id: 'external-' + turn, status: 'completed', output: items, usage: { input_tokens: 7, output_tokens: 3 } }));
        } catch (error) { problems.push(error.message); if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); } }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      await js(`openRecentProject({path:${JSON.stringify(project)}})`);
      await until('client project active', async () => (await state()).workspace?.root === project && !await js('projectSwitching'));
      await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, reasoningEffort: 'default' }); configured = true;
      await call('listModels', { force: true }); await call('setPermissionMode', { mode: 'full', confirmed: true });
      stage = 'real read replace create tool loop'; await call('submitPrompt', { text: prompt, mode: 'queue' });
      fixture.runId = (await until('task user event', async () => (await events()).find(e => e.type === 'user-message' && e.text === prompt))).runId;
      await until('four-turn task complete', async () => { const end = (await events()).find(e => e.type === 'run-end' && e.runId === fixture.runId); if (end) assert.equal(end.status, 'completed', end.error); return end && !(await state()).activeTask.running; });
      fixture.sessionId = (await state()).sessionId;
      await disk(fixture.after); await direction('undo'); await assertCard();
      stage = 'external manual editor and stale version protection'; await manualEditor();
      assert.equal(requests.length, 4); assert.deepEqual(problems, []);
    } else {
      fixture = JSON.parse(await fs.readFile(marker, 'utf8')); assert.ok(!fixture.pids.includes(process.pid)); fixture.pids.push(process.pid);
      const initial = await state(); assert.equal(initial.workspace?.root, fixture.project); assert.equal(initial.sessionId, fixture.sessionId);
      await call('setPermissionMode', { mode: 'full', confirmed: true }); await assertCard();
      if (phase === 'verify') {
        stage = 'restart undo and reload redo'; await disk(fixture.after); await perform('undo'); await disk(fixture.before);
        await reload(); await perform('redo'); await disk(fixture.after);
        stage = 'history reopen and external user edit conflict'; await js(`loadSession(${JSON.stringify(fixture.sessionId)})`); await direction('undo');
        const userEdit = 'USER_EXTERNAL_EDIT_' + fixture.nonce + '\n'; await fs.writeFile(fixture.externalEdit, userEdit);
        const failed = await perform('undo', 'failed'); assert.match(failed.error, /same\.txt.*变化/u);
        await disk({ ...fixture.after, [fixture.externalEdit]: userEdit });
        await fs.writeFile(fixture.externalEdit, fixture.after[fixture.externalEdit]); await perform('undo'); await disk(fixture.before);
      } else {
        stage = 'redo after second real restart'; await disk(fixture.before); await perform('redo'); await disk(fixture.after);
      }
    }
    const envelope = await fs.readFile(path.join(dataDir, 'task-undo', fixture.sessionId + '.json'), 'utf8');
    assert.equal(typeof JSON.parse(envelope).encrypted, 'string');
    for (const content of Object.values(fixture.before).concat(Object.values(fixture.after)).filter(Boolean)) assert.equal(envelope.includes(content.trim()), false);
    assert.equal((await state()).usageStats.day.requests, 4, 'History and undo/redo must not make model requests');
    assert.equal(store.usage.records.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0), 40);
    assert.equal((await state()).terminalEvents.length, 0); await fs.writeFile(marker, JSON.stringify(fixture, null, 2));
    win.webContents.invalidate(); await wait(180); const screenshot = 'external-files-' + phase + '.png';
    await fs.writeFile(path.join(output, screenshot), (await win.webContents.capturePage()).toPNG());
    const result = { status: 'completed', phase, realExternalApi: false, realCommands: false, loopbackModelRequests: 4, externalReadReplaceCreate: true,
      originalProjectRetained: true, sameNameDistinctPaths: true, inlineDiffs: true, encryptedUndoJournal: true,
      nativeExternalEditorAutosave: phase === 'prepare', externalEditorVersionConflict: phase === 'prepare',
      restartUndo: phase === 'verify', restartRedo: phase === 'verify-again', externalConflictProtected: phase === 'verify', pids: fixture.pids, screenshot };
    await fs.writeFile(path.join(output, 'external-files-result.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    await fs.writeFile(path.join(output, 'external-files-failure.json'), JSON.stringify({ stage, phase, error: error.message, stack: error.stack, fixture, problems, state: await state().catch(() => null) }, null, 2)); throw error;
  } finally {
    if (server) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
    if (configured) {
      const previous = original.settings.providers.openai;
      await call('saveSettings', { provider: 'openai', model: previous.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol, authMode: previous.authMode, reasoningEffort: previous.reasoningEffort, clearKey: true });
      const selected = original.settings.providers[original.settings.provider];
      await call('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: selected.baseUrl, apiProtocol: selected.apiProtocol, authMode: selected.authMode, reasoningEffort: original.settings.reasoningEffort });
    }
  }
};
